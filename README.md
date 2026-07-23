# Camelô

A self-hosted Discord bot: a music player, a natural-language DJ, a price
watcher, and small utilities. All AI runs **locally through Ollama** — no cloud
API keys, nothing leaves the machine.

Stack: TypeScript, discord.js v14, `@discordjs/voice`, yt-dlp (via
`youtube-dl-exec`), cheerio, `better-sqlite3`, puppeteer-core, and a local
Ollama server. State lives in `data/bot.db` (SQLite).

## Features

### Music

Streams from YouTube (URL, playlist, mix, or search), Spotify links (track,
playlist, album — resolved to YouTube searches, no Spotify account needed), and
SoundCloud. A lookahead buffer keeps playback smooth.

`/play`, `/skip` (vote-skip; instant for the requester or small channels),
`/pause`, `/resume`, `/stop`, `/queue`, `/nowplaying`, `/shuffle`,
`/loop off|track|queue`, `/autoplay on|off`, `/volume 0-200`, `/remove`,
`/move`, `/clear`, `/lyrics`.

### Natural-language control

Tag the bot (`@Camelô toca raul`) anywhere, or designate a channel with
`/musicchannel set` where **every** message is understood as a request — no
slash command needed. Understands English and Brazilian Portuguese, by rules
first and a local Ollama model for the rest ("skip", "pula", "abaixa um
pouco", "põe no 60", "que música é essa"). Ordinary chatter is classified and
ignored rather than queued.

### DJ recommendations

Ask for a vibe instead of a song — "toca algo pra sexta à noite", "put on some
jazz", "surprise me". The local model blends the requester's play history,
the requested mood, and the current day/time into a queued set with a one-line
rationale.

### Price watcher

`/watch <url> [target] [selector] [interval] [min_drop]`, `/watchlist`,
`/unwatch`, `/price <id>` (check now), `/history <id>` (sparkline). Scrapes on
an interval (JSON-LD → price meta tags → price-ish CSS classes, or a supplied
CSS selector), uses the Mercado Livre API where available, and posts a
screenshot with each alert (channel + DM).

### Utilities

`/remind`, `/reminders`, `/unremind`, `/poll`, `/roll`, `/welcome`,
`/ask`, `/summarize` (the last two via local Ollama).

## Setup

1. **Discord app** — https://discord.com/developers/applications → *New
   Application*. **Bot** tab → *Reset Token*. Enable the **Server Members** and
   **Message Content** privileged intents (needed for welcome messages and the
   natural-language channel). Copy the *Application ID* from *General
   Information*.

2. **Invite** — replace `CLIENT_ID` and open:

   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=3212288
   ```

3. **Ollama** (for natural-language control, the DJ, and `/ask`) — install from
   https://ollama.com, then `ollama pull llama3.2:3b`. Skip this and the bot
   still runs; only the AI features are disabled.

4. **Configure & run** (PowerShell):

   ```powershell
   Copy-Item .env.example .env   # fill in DISCORD_TOKEN, CLIENT_ID, GUILD_ID
   pnpm install
   pnpm register                 # register slash commands
   pnpm dev                      # run with auto-reload
   ```

## Configuration (`.env`)

| Variable | Purpose |
|----------|---------|
| `DISCORD_TOKEN` | Bot token (required) |
| `CLIENT_ID` | Application ID (required to register commands) |
| `GUILD_ID` | Server id — registers commands instantly to one server; empty = global (~1h) |
| `CHECK_INTERVAL_MINUTES` | Default price-check interval (30) |
| `OLLAMA_URL` | Ollama server (`http://127.0.0.1:11434`) |
| `OLLAMA_MODEL` | Model for intent, DJ, and `/ask` (`llama3.2:3b`) |

## Security

Runs on a personal machine and treats all Discord input as untrusted:

- **SSRF guard** on every user-supplied URL (scraper, screenshots) — blocks
  loopback / private / link-local / cloud-metadata addresses and re-validates
  every redirect hop.
- **Media-URL allowlist** — `/play` links restricted to YouTube / Spotify /
  SoundCloud; searches otherwise.
- **Screenshots** run in a JS-disabled, sandboxed headless Chrome with
  per-request host filtering.
- **Rate limits** — token buckets per user and per guild, tighter for
  process/network/LLM-heavy commands; global caps on concurrent yt-dlp and
  Ollama work.
- **Resource caps** — per-user watch/reminder limits; SQLite history is pruned.
- **Prompt-injection** — LLM outputs are schema-constrained; a client-wide
  mention allowlist makes `@everyone` abuse impossible.

## Notes

- **YouTube playback breaks sometimes.** yt-dlp tracks YouTube changes; when
  playback stops, update it: `pnpm update youtube-dl-exec`.
- Recommendations and search use a small local model — great for well-known
  tracks, weaker on deep cuts. Set `OLLAMA_MODEL` to a larger model for smarter
  (slower) results.
- Some retailers (notably Amazon) block scrapers; expect occasional failures.

## Development

```powershell
pnpm typecheck   # tsc --noEmit
pnpm dev         # tsx watch
```
