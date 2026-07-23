import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import type { Command } from './commands.js';
import { config, requireEnv } from './config.js';
import { startMentionCommands } from './modules/music/mentions.js';
import { startReminders } from './modules/reminders/index.js';
import { startWatcher } from './modules/watcher/watcher.js';
import { startWelcome } from './modules/welcome/index.js';
import { allCommands } from './registry.js';
import { rateAllow } from './security.js';

requireEnv('token');

// A rejected reply/API call from user input must never take the process down.
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

const commands = new Map<string, Command>(allCommands.map((c) => [c.data.name, c]));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  // Never let echoed user/LLM content ping @everyone/@here/roles.
  allowedMentions: { parse: ['users'], repliedUser: false },
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  startWatcher(client);
  startReminders(client);
});

startWelcome(client);
startMentionCommands(client);

// Commands that spawn processes or hit the network/LLM get a tighter per-user
// cap on top of any command-specific cooldown.
const EXPENSIVE = new Set(['play', 'watch', 'price', 'history', 'ask', 'summarize', 'lyrics']);

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commands.get(interaction.commandName);
  if (!command) return;

  const uid = interaction.user.id;
  const overall = rateAllow(`cmd:${uid}`, 30, 15);
  const expensiveOk = !EXPENSIVE.has(interaction.commandName) || rateAllow(`cmd-exp:${uid}`, 8, 4);
  if (!overall || !expensiveOk) {
    await interaction
      .reply({ content: 'You are doing that too fast — slow down a moment.', flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[command] /${interaction.commandName} failed:`, err);
    const msg = { content: 'Something went wrong running that command.' };
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp(msg);
      else await interaction.reply({ ...msg, flags: MessageFlags.Ephemeral });
    } catch {
      // interaction expired — nothing to do
    }
  }
});

client.login(config.token);
