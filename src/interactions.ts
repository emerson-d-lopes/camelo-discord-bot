import { type ChatInputCommandInteraction, MessageFlags } from 'discord.js';

/** Reply privately (only the caller sees it) — the shape repeated across every command's error paths. */
export function ephemeral(interaction: ChatInputCommandInteraction, content: string): Promise<unknown> {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/** Reply with text that must never resolve a mention (untrusted titles, echoed input). */
export function replyNoPing(interaction: ChatInputCommandInteraction, content: string): Promise<unknown> {
  return interaction.reply({ content, allowedMentions: { parse: [] } });
}
