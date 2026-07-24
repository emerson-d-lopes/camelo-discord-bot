try {
  process.loadEnvFile('.env');
} catch {
  // no .env yet — fine for tooling, required vars are checked below at use time
}

/** Throws at boot on a set-but-garbage port — better than silently disabling the feature. */
function optionalPort(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name}=${raw} is not a valid port (1-65535).`);
  }
  return n;
}

/**
 * The one place environment variables are read. Required vars (token/clientId)
 * are enforced by {@link requireEnv} at each entry point; everything else has a
 * default or is optional, so the bot degrades instead of refusing to start.
 */
export const config = {
  token: process.env.DISCORD_TOKEN ?? '',
  clientId: process.env.CLIENT_ID ?? '',
  guildId: process.env.GUILD_ID || undefined,
  checkIntervalMinutes: Math.max(1, Number(process.env.CHECK_INTERVAL_MINUTES ?? 30) || 30),
  /** When set, /stats is hard-locked to this user id (on top of admin-only). */
  ownerId: process.env.OWNER_ID || undefined,
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  /** Small fast model for intent classification, /ask, and the DJ. */
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2:3b',
  /** Bigger model for open conversation (better recall, less flaky). */
  assistantModel: process.env.ASSISTANT_MODEL || 'gemma4:12b',
  stats: {
    /** Dashboard is off unless a port is set. */
    port: optionalPort('STATS_PORT'),
    host: process.env.STATS_HOST || '127.0.0.1',
    token: process.env.STATS_TOKEN || undefined,
  },
  /** Chrome/Chromium override for screenshots; auto-probed when empty. */
  puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
};

export function requireEnv(...keys: ('token' | 'clientId')[]): void {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length > 0) {
    const names = missing.map((k) => (k === 'token' ? 'DISCORD_TOKEN' : 'CLIENT_ID'));
    throw new Error(`Missing ${names.join(', ')} — copy .env.example to .env and fill it in.`);
  }
}
