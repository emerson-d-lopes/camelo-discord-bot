try {
  process.loadEnvFile('.env');
} catch {
  // no .env yet — fine for tooling, required vars are checked below at use time
}

export const config = {
  token: process.env.DISCORD_TOKEN ?? '',
  clientId: process.env.CLIENT_ID ?? '',
  guildId: process.env.GUILD_ID || undefined,
  checkIntervalMinutes: Math.max(1, Number(process.env.CHECK_INTERVAL_MINUTES ?? 30) || 30),
};

export function requireEnv(...keys: ('token' | 'clientId')[]): void {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length > 0) {
    const names = missing.map((k) => (k === 'token' ? 'DISCORD_TOKEN' : 'CLIENT_ID'));
    throw new Error(`Missing ${names.join(', ')} — copy .env.example to .env and fill it in.`);
  }
}
