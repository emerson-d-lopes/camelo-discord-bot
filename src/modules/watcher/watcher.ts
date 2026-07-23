import { AttachmentBuilder, Client, EmbedBuilder } from 'discord.js';
import { config } from '../../config.js';
import {
  allWatches,
  markFailNotified,
  recordWatchFailure,
  touchWatch,
  updateWatchPrice,
  type Watch,
} from '../../db.js';
import { scrapePrice } from './scraper.js';
import { screenshotPage } from './screenshot.js';

const DELAY_BETWEEN_REQUESTS_MS = 2_000;
const FAILS_BEFORE_ALERT = 5;

export function fmt(price: number, currency: string | null): string {
  return `${currency ? `${currency} ` : ''}${price.toFixed(2)}`;
}

export function startWatcher(client: Client): void {
  console.log(
    `[watcher] loop every 1 min; default per-watch interval ${config.checkIntervalMinutes} min`,
  );
  // Guard against overlapping passes: one slow pass (many due watches × delay
  // × screenshots) must not race a second one into duplicate alerts.
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    checkAll(client)
      .catch((err) => console.error('[watcher] pass failed:', err))
      .finally(() => {
        running = false;
      });
  };
  run();
  setInterval(run, 60_000);
}

function isDue(watch: Watch): boolean {
  if (!watch.last_checked) return true;
  const interval = watch.interval_minutes ?? config.checkIntervalMinutes;
  const last = Date.parse(`${watch.last_checked.replace(' ', 'T')}Z`);
  return Date.now() - last >= interval * 60_000;
}

async function checkAll(client: Client): Promise<void> {
  for (const watch of allWatches()) {
    if (!isDue(watch)) continue;
    try {
      await checkOne(client, watch);
    } catch (err) {
      console.warn(
        `[watcher] check failed for #${watch.id} (${watch.url}): ${err instanceof Error ? err.message : err}`,
      );
      const fails = recordWatchFailure(watch.id);
      if (fails >= FAILS_BEFORE_ALERT && !watch.fail_notified) {
        markFailNotified(watch.id);
        await notifyFailure(client, watch, fails, err instanceof Error ? err.message : String(err));
      }
    }
    await new Promise((r) => setTimeout(r, DELAY_BETWEEN_REQUESTS_MS));
  }
}

async function checkOne(client: Client, watch: Watch): Promise<void> {
  const result = await scrapePrice(watch.url, watch.selector);

  if (watch.last_price !== null && result.price === watch.last_price) {
    touchWatch(watch.id);
    return;
  }

  const previous = watch.last_price;
  updateWatchPrice(watch.id, result.price, result.currency);

  // First successful check just seeds the baseline — no alert.
  if (previous === null) return;

  // Drop-threshold filter: when set, only alert on drops of at least that percentage.
  if (watch.min_drop_pct !== null) {
    const dropPct = ((previous - result.price) / previous) * 100;
    if (dropPct < watch.min_drop_pct) return;
  }

  await sendAlert(client, watch, previous, result.price, result.currency ?? watch.currency);
}

async function sendAlert(
  client: Client,
  watch: Watch,
  oldPrice: number,
  newPrice: number,
  currency: string | null,
): Promise<void> {
  const dropped = newPrice < oldPrice;
  const hitTarget = watch.target_price !== null && newPrice <= watch.target_price;

  const embed = new EmbedBuilder()
    .setTitle(`${dropped ? '📉' : '📈'} Price ${dropped ? 'drop' : 'increase'}: ${watch.title}`)
    .setURL(watch.url)
    .setColor(dropped ? 0x2ecc71 : 0xe74c3c)
    .addFields(
      { name: 'Before', value: fmt(oldPrice, currency), inline: true },
      { name: 'Now', value: fmt(newPrice, currency), inline: true },
      {
        name: 'Change',
        value: `${(((newPrice - oldPrice) / oldPrice) * 100).toFixed(1)}%`,
        inline: true,
      },
    )
    .setFooter({ text: `Watch #${watch.id}` })
    .setTimestamp();

  if (hitTarget) {
    embed.setDescription(`🎯 **Target price of ${fmt(watch.target_price!, currency)} reached!**`);
  }

  const shot = await screenshotPage(watch.url);
  const files = shot ? [new AttachmentBuilder(shot, { name: `watch-${watch.id}.jpg` })] : [];
  if (shot) embed.setImage(`attachment://watch-${watch.id}.jpg`);

  const mention = `<@${watch.user_id}>`;

  try {
    const channel = await client.channels.fetch(watch.channel_id);
    if (channel?.isSendable()) {
      await channel.send({ content: hitTarget ? mention : undefined, embeds: [embed], files });
    }
  } catch (err) {
    console.warn(`[watcher] channel alert failed for #${watch.id}:`, err);
  }

  try {
    const user = await client.users.fetch(watch.user_id);
    await user.send({ embeds: [embed], files });
  } catch (err) {
    console.warn(`[watcher] DM alert failed for #${watch.id} (DMs may be closed):`, err);
  }
}

async function notifyFailure(
  client: Client,
  watch: Watch,
  fails: number,
  lastError: string,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle(`⚠️ Watch #${watch.id} keeps failing`)
    .setDescription(
      `**${watch.title}** failed ${fails} checks in a row.\nLast error: ${lastError.slice(0, 200)}\n\n` +
        `The site may have changed. Try \`/unwatch id:${watch.id}\` and re-add it, possibly with a \`selector\`.`,
    )
    .setURL(watch.url)
    .setColor(0xf39c12);
  try {
    const user = await client.users.fetch(watch.user_id);
    await user.send({ embeds: [embed] });
  } catch {
    try {
      const channel = await client.channels.fetch(watch.channel_id);
      if (channel?.isSendable()) await channel.send({ content: `<@${watch.user_id}>`, embeds: [embed] });
    } catch {
      // both routes closed — nothing else to do
    }
  }
}
