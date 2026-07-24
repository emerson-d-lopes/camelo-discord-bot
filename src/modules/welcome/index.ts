import {
  ChannelType,
  type Client,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { Command } from '../../commands.js';
import { getGuildSettings, setWelcome } from '../../db.js';

export function startWelcome(client: Client): void {
  client.on(Events.GuildMemberAdd, async (member) => {
    const settings = getGuildSettings(member.guild.id);
    if (!settings?.welcome_channel_id || !settings.welcome_message) return;
    try {
      const channel = await member.guild.channels.fetch(settings.welcome_channel_id);
      if (channel?.isSendable()) {
        await channel.send(
          settings.welcome_message
            .replaceAll('{user}', `<@${member.id}>`)
            .replaceAll('{server}', member.guild.name),
        );
      }
    } catch (err) {
      console.warn('[welcome] failed to send welcome message:', err);
    }
  });
}

const welcome: Command = {
  data: new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('Configure welcome messages for new members (needs Manage Server)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Enable welcome messages')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Channel to post in')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName('message')
            .setDescription('Message; {user} mentions the member, {server} is the server name')
            .setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('off').setDescription('Disable welcome messages')),
  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'Server-only command.', flags: MessageFlags.Ephemeral });
      return;
    }
    // Defense in depth: setDefaultMemberPermissions is a client-side default an
    // admin can override per guild, so re-check server-side.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: 'You need the Manage Server permission to do that.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.options.getSubcommand() === 'off') {
      setWelcome(interaction.guildId, null, null);
      await interaction.reply({ content: 'Welcome messages off.', flags: MessageFlags.Ephemeral });
      return;
    }
    const channel = interaction.options.getChannel('channel', true);
    const message = interaction.options.getString('message', true);
    setWelcome(interaction.guildId, channel.id, message);
    await interaction.reply({
      content: `👋 Welcome messages on in <#${channel.id}>:\n> ${message}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const welcomeCommands: Command[] = [welcome];
