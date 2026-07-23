import { REST, Routes } from 'discord.js';
import { config, requireEnv } from './config.js';
import { allCommands } from './registry.js';

requireEnv('token', 'clientId');

const body = allCommands.map((c) => c.data.toJSON());
const rest = new REST().setToken(config.token);

const route = config.guildId
  ? Routes.applicationGuildCommands(config.clientId, config.guildId)
  : Routes.applicationCommands(config.clientId);

const scope = config.guildId ? `guild ${config.guildId}` : 'global (may take up to 1h)';
console.log(`Deploying ${body.length} slash commands to ${scope}...`);

await rest.put(route, { body });
console.log('Done.');
