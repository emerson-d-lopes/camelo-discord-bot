import { type ChatInputCommandInteraction, MessageFlags } from 'discord.js';

/** Reply privately (only the caller sees it) — the shape repeated across every command's error paths. */
export function ephemeral(interaction: ChatInputCommandInteraction, content: string): Promise<unknown> {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/** Reply with text that must never resolve a mention (untrusted titles, echoed input). */
export function replyNoPing(interaction: ChatInputCommandInteraction, content: string): Promise<unknown> {
  return interaction.reply({ content, allowedMentions: { parse: [] } });
}

/**
 * Neutralize markdown link syntax in untrusted text used as the label of a
 * `[label](url)` link (track titles, scraped page titles). Without this a title
 * like `x](https://evil)` breaks out of the intended link and forges its own.
 */
export function mdLinkText(text: string): string {
  return text.replace(/[[\]()]/g, '\\$&');
}
