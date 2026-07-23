import { Client, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../commands.js';
import { deleteReminder, dueReminders, getReminder, insertReminder, listReminders } from '../../db.js';

/** Parse "2h30m", "45m", "1d2h", "90s" into ms. */
export function parseDuration(input: string): number | null {
  const re = /(\d+)\s*(d|h|m|s)/gi;
  let ms = 0;
  let matched = false;
  for (const m of input.matchAll(re)) {
    matched = true;
    const n = Number(m[1]);
    ms += n * { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }[m[2].toLowerCase() as 'd' | 'h' | 'm' | 's'];
  }
  if (!matched) {
    const bare = Number(input);
    if (Number.isFinite(bare) && bare > 0) return bare * 60_000; // bare number = minutes
    return null;
  }
  return ms > 0 ? ms : null;
}

export function startReminders(client: Client): void {
  // Overlap guard: a slow pass (many closed-DM fetches) must not let the next
  // tick start and double-deliver.
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await deliverDue(client);
    } catch (err) {
      console.error('[reminders] pass failed:', err);
    } finally {
      running = false;
    }
  }, 30_000);
}

async function deliverDue(client: Client): Promise<void> {
  for (const r of dueReminders(Date.now())) {
      deleteReminder(r.id);
      const embed = new EmbedBuilder()
        .setTitle('⏰ Reminder')
        .setDescription(r.message)
        .setColor(0x3498db);
      try {
        const user = await client.users.fetch(r.user_id);
        await user.send({ embeds: [embed] });
      } catch {
        // DMs closed — channel fallback below
      }
      try {
        const channel = await client.channels.fetch(r.channel_id);
        if (channel?.isSendable()) {
          await channel.send({ content: `<@${r.user_id}>`, embeds: [embed] });
        }
      } catch {
        // channel gone — nothing else to do
      }
  }
}

const remind: Command = {
  data: new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Set a reminder')
    .addStringOption((o) =>
      o.setName('in').setDescription('When: 2h30m, 45m, 1d, or bare minutes').setRequired(true),
    )
    .addStringOption((o) => o.setName('about').setDescription('What to remind you of').setRequired(true)),
  async execute(interaction) {
    const when = interaction.options.getString('in', true);
    const about = interaction.options.getString('about', true);
    const ms = parseDuration(when);
    if (ms === null || ms < 10_000 || ms > 90 * 86_400_000) {
      await interaction.reply({
        content: 'Bad duration. Use forms like `45m`, `2h30m`, `1d` (10s min, 90d max).',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (listReminders(interaction.user.id).length >= 25) {
      await interaction.reply({
        content: 'Reminder limit reached (25 per user) — cancel one with `/unremind` first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const dueAt = Date.now() + ms;
    const id = insertReminder({
      user_id: interaction.user.id,
      channel_id: interaction.channelId,
      message: about,
      due_at: dueAt,
    });
    await interaction.reply({
      content: `⏰ Reminder #${id} set — <t:${Math.floor(dueAt / 1000)}:R>: ${about}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

const reminders: Command = {
  data: new SlashCommandBuilder().setName('reminders').setDescription('List your reminders'),
  async execute(interaction) {
    const rows = listReminders(interaction.user.id);
    if (rows.length === 0) {
      await interaction.reply({ content: 'No reminders set.', flags: MessageFlags.Ephemeral });
      return;
    }
    const lines = rows.map(
      (r) => `**#${r.id}** <t:${Math.floor(r.due_at / 1000)}:R> — ${r.message.slice(0, 80)}`,
    );
    await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
  },
};

const unremind: Command = {
  data: new SlashCommandBuilder()
    .setName('unremind')
    .setDescription('Cancel a reminder')
    .addIntegerOption((o) => o.setName('id').setDescription('Reminder id (see /reminders)').setRequired(true)),
  async execute(interaction) {
    const id = interaction.options.getInteger('id', true);
    const r = getReminder(id);
    if (!r || r.user_id !== interaction.user.id) {
      await interaction.reply({ content: `No reminder #${id} belongs to you.`, flags: MessageFlags.Ephemeral });
      return;
    }
    deleteReminder(id);
    await interaction.reply({ content: `🗑️ Reminder #${id} cancelled.`, flags: MessageFlags.Ephemeral });
  },
};

export const reminderCommands: Command[] = [remind, reminders, unremind];
