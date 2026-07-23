import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../commands.js';

const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

const poll: Command = {
  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create a reaction poll')
    .addStringOption((o) => o.setName('question').setDescription('The question').setRequired(true))
    .addStringOption((o) => o.setName('option1').setDescription('Option 1').setRequired(true))
    .addStringOption((o) => o.setName('option2').setDescription('Option 2').setRequired(true))
    .addStringOption((o) => o.setName('option3').setDescription('Option 3'))
    .addStringOption((o) => o.setName('option4').setDescription('Option 4')),
  async execute(interaction) {
    const question = interaction.options.getString('question', true);
    const options = [
      interaction.options.getString('option1', true),
      interaction.options.getString('option2', true),
      interaction.options.getString('option3'),
      interaction.options.getString('option4'),
    ].filter((o): o is string => o !== null);

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${question}`)
      .setDescription(options.map((o, i) => `${NUMBER_EMOJI[i]} ${o}`).join('\n'))
      .setFooter({ text: `Poll by ${interaction.user.displayName}` })
      .setColor(0x9b59b6);

    const msg = await interaction.reply({ embeds: [embed], withResponse: true });
    const message = msg.resource?.message;
    if (message) {
      for (let i = 0; i < options.length; i++) {
        await message.react(NUMBER_EMOJI[i]);
      }
    }
  },
};

const roll: Command = {
  data: new SlashCommandBuilder()
    .setName('roll')
    .setDescription('Roll dice')
    .addStringOption((o) => o.setName('dice').setDescription('e.g. d20, 2d6+3 (default d20)')),
  async execute(interaction) {
    const spec = interaction.options.getString('dice') ?? 'd20';
    const m = spec.replace(/\s/g, '').match(/^(\d*)d(\d+)([+-]\d+)?$/i);
    if (!m) {
      await interaction.reply({
        content: 'Bad dice spec. Try `d20`, `2d6`, `3d8+2`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const count = Math.min(Number(m[1] || 1), 100);
    const sides = Math.min(Number(m[2]), 10_000);
    const mod = Number(m[3] ?? 0);
    if (count < 1 || sides < 2) {
      await interaction.reply({ content: 'Bad dice spec.', flags: MessageFlags.Ephemeral });
      return;
    }
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
    const total = rolls.reduce((a, b) => a + b, 0) + mod;
    const detail =
      count > 1 || mod !== 0
        ? ` (${rolls.join(' + ')}${mod ? ` ${mod > 0 ? '+' : '-'} ${Math.abs(mod)}` : ''})`
        : '';
    await interaction.reply(`🎲 **${total}**${detail}`);
  },
};

export const funCommands: Command[] = [poll, roll];
