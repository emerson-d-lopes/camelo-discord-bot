import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../commands.js';
import {
  deleteWatch,
  getWatch,
  insertWatch,
  listWatches,
  priceHistory,
  totalWatches,
  touchWatch,
  updateWatchPrice,
} from '../../db.js';
import { mdLinkText } from '../../interactions.js';
import { ScrapeError, scrapePrice } from './scraper.js';

function fmt(price: number | null, currency: string | null): string {
  if (price === null) return '?';
  return `${currency ? `${currency} ` : ''}${price.toFixed(2)}`;
}

const SPARK = '▁▂▃▄▅▆▇█';

function sparkline(values: number[]): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return SPARK[3].repeat(values.length);
  return values.map((v) => SPARK[Math.round(((v - min) / (max - min)) * (SPARK.length - 1))]).join('');
}

function ownWatch(interaction: Parameters<Command['execute']>[0], id: number) {
  const w = getWatch(id);
  if (!w || w.user_id !== interaction.user.id) return null;
  return w;
}

const watch: Command = {
  data: new SlashCommandBuilder()
    .setName('watch')
    .setDescription('Watch a product page for price changes')
    .addStringOption((o) => o.setName('url').setDescription('Product page URL').setRequired(true))
    .addNumberOption((o) =>
      o
        .setName('target')
        .setDescription('Alert with a ping when price drops to this or below')
        .setMinValue(0),
    )
    .addStringOption((o) =>
      o.setName('selector').setDescription('CSS selector for the price element (only if auto-detect fails)'),
    )
    .addIntegerOption((o) =>
      o
        .setName('interval')
        .setDescription('Check interval in minutes (default from config, min 5)')
        .setMinValue(5)
        .setMaxValue(10080),
    )
    .addNumberOption((o) =>
      o
        .setName('min_drop')
        .setDescription('Only alert on drops of at least this % (silences rises and tiny dips)')
        .setMinValue(0.1)
        .setMaxValue(99),
    ),
  async execute(interaction) {
    const url = interaction.options.getString('url', true);
    const target = interaction.options.getNumber('target');
    const selector = interaction.options.getString('selector');
    const interval = interaction.options.getInteger('interval');
    const minDrop = interaction.options.getNumber('min_drop');

    let parsed: URL;
    try {
      parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error();
    } catch {
      await interaction.reply({
        content: 'That is not a valid http(s) URL.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (listWatches(interaction.user.id).length >= 10) {
      await interaction.reply({
        content: 'Watch limit reached (10 per user) — remove one with `/unwatch` first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Process-wide ceiling: each watch is recurring fetch + scrape + screenshot
    // work, so cap the total regardless of how many users spread it across.
    if (totalWatches() >= 2000) {
      await interaction.reply({
        content: 'The bot is at its global watch capacity right now — try again later.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();

    let result;
    try {
      result = await scrapePrice(url, selector);
    } catch (err) {
      await interaction.editReply(
        err instanceof ScrapeError ? `❌ ${err.message}` : '❌ Unexpected error while checking that page.',
      );
      return;
    }

    const title = result.title ?? parsed.hostname;
    const id = insertWatch({
      user_id: interaction.user.id,
      channel_id: interaction.channelId,
      url,
      selector: selector ?? null,
      title,
      currency: result.currency,
      last_price: result.price,
      target_price: target ?? null,
      interval_minutes: interval ?? null,
      min_drop_pct: minDrop ?? null,
    });

    const embed = new EmbedBuilder()
      .setTitle(`👀 Watching: ${title}`)
      .setURL(url)
      .setColor(0x3498db)
      .addFields(
        { name: 'Current price', value: fmt(result.price, result.currency), inline: true },
        { name: 'Target', value: target != null ? fmt(target, result.currency) : 'any change', inline: true },
        { name: 'Detected via', value: result.source, inline: true },
        ...(interval ? [{ name: 'Interval', value: `${interval} min`, inline: true }] : []),
        ...(minDrop ? [{ name: 'Min drop', value: `${minDrop}%`, inline: true }] : []),
      )
      .setFooter({ text: `Watch #${id} — alerts post here + DM` });

    await interaction.editReply({ embeds: [embed] });
  },
};

const price: Command = {
  data: new SlashCommandBuilder()
    .setName('price')
    .setDescription('Check the current price of a watch right now')
    .addIntegerOption((o) => o.setName('id').setDescription('Watch id (see /watchlist)').setRequired(true)),
  async execute(interaction) {
    const id = interaction.options.getInteger('id', true);
    const w = ownWatch(interaction, id);
    if (!w) {
      await interaction.reply({
        content: `No watch #${id} belongs to you. Check \`/watchlist\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply();
    try {
      const result = await scrapePrice(w.url, w.selector);
      const prev = w.last_price;
      if (prev === null || result.price !== prev) {
        updateWatchPrice(w.id, result.price, result.currency);
      } else {
        touchWatch(w.id);
      }
      const delta =
        prev !== null && prev !== result.price
          ? ` (was ${fmt(prev, w.currency)}, ${(((result.price - prev) / prev) * 100).toFixed(1)}%)`
          : '';
      await interaction.editReply(
        `💰 **${w.title}** — ${fmt(result.price, result.currency ?? w.currency)}${delta}`,
      );
    } catch (err) {
      await interaction.editReply(
        `❌ Check failed: ${err instanceof ScrapeError ? err.message : 'unexpected error.'}`,
      );
    }
  },
};

const history: Command = {
  data: new SlashCommandBuilder()
    .setName('history')
    .setDescription('Price history of a watch')
    .addIntegerOption((o) => o.setName('id').setDescription('Watch id (see /watchlist)').setRequired(true)),
  async execute(interaction) {
    const id = interaction.options.getInteger('id', true);
    const w = ownWatch(interaction, id);
    if (!w) {
      await interaction.reply({
        content: `No watch #${id} belongs to you. Check \`/watchlist\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const points = priceHistory(id);
    if (points.length === 0) {
      await interaction.reply({ content: 'No history recorded yet.', flags: MessageFlags.Ephemeral });
      return;
    }
    const values = points.map((p) => p.price);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const first = points[0];
    const last = points[points.length - 1];
    const embed = new EmbedBuilder()
      .setTitle(`📊 History: ${w.title}`)
      .setURL(w.url)
      .setDescription(`\`${sparkline(values)}\``)
      .addFields(
        { name: 'Current', value: fmt(last.price, w.currency), inline: true },
        { name: 'Min', value: fmt(min, w.currency), inline: true },
        { name: 'Max', value: fmt(max, w.currency), inline: true },
        {
          name: 'Range',
          value: `${points.length} points, ${first.checked_at} → ${last.checked_at} (UTC)`,
        },
      );
    await interaction.reply({ embeds: [embed] });
  },
};

const watchlist: Command = {
  data: new SlashCommandBuilder().setName('watchlist').setDescription('List your price watches'),
  async execute(interaction) {
    const watches = listWatches(interaction.user.id);
    if (watches.length === 0) {
      await interaction.reply({
        content: 'You are not watching anything. Add one with `/watch`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const lines = watches.map((w) => {
      const targetPart = w.target_price !== null ? ` (target ${fmt(w.target_price, w.currency)})` : '';
      const failPart = w.fail_count > 0 ? ` ⚠️${w.fail_count} fails` : '';
      return `**#${w.id}** [${mdLinkText(w.title.slice(0, 60))}](${w.url}) — ${fmt(w.last_price, w.currency)}${targetPart}${failPart}`;
    });

    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle('👀 Your watches').setDescription(lines.join('\n'))],
      flags: MessageFlags.Ephemeral,
    });
  },
};

const unwatch: Command = {
  data: new SlashCommandBuilder()
    .setName('unwatch')
    .setDescription('Stop watching a product')
    .addIntegerOption((o) => o.setName('id').setDescription('Watch id (see /watchlist)').setRequired(true)),
  async execute(interaction) {
    const id = interaction.options.getInteger('id', true);
    const w = ownWatch(interaction, id);
    if (!w) {
      await interaction.reply({
        content: `No watch #${id} belongs to you. Check \`/watchlist\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    deleteWatch(id);
    await interaction.reply({ content: `🗑️ Stopped watching **${w.title}**.`, flags: MessageFlags.Ephemeral });
  },
};

export const watcherCommands: Command[] = [watch, price, history, watchlist, unwatch];
