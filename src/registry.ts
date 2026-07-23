import type { Command } from './commands.js';
import { aiCommands } from './modules/ai/index.js';
import { funCommands } from './modules/fun/index.js';
import { musicCommands } from './modules/music/commands.js';
import { reminderCommands } from './modules/reminders/index.js';
import { statsCommands } from './modules/stats/index.js';
import { watcherCommands } from './modules/watcher/commands.js';
import { welcomeCommands } from './modules/welcome/index.js';

export const allCommands: Command[] = [
  ...musicCommands,
  ...watcherCommands,
  ...reminderCommands,
  ...funCommands,
  ...welcomeCommands,
  ...aiCommands,
  ...statsCommands,
];
