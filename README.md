# discord-bot

One bot, two modules:

- **Music** — plays YouTube audio in a voice channel via yt-dlp. `/play`, `/skip`, `/pause`, `/resume`, `/stop`, `/queue`
- **Price watcher** — scrapes product pages on an interval, alerts on price changes (channel post + DM). `/watch`, `/watchlist`, `/unwatch`

Stack: TypeScript, discord.js v14, @discordjs/voice, yt-dlp (via youtube-dl-exec), cheerio, better-sqlite3. Data lives in `data/bot.db`.

## Setup

1. **Create the Discord app**
   - Go to https://discord.com/developers/applications → *New Application*.
   - **Bot** tab → *Reset Token* → copy it. No privileged intents needed.
   - **General Information** → copy the *Application ID*.

2. **Invite the bot to your server**

   Replace `CLIENT_ID` and open in a browser:

   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=3212288
   ```

   (Permissions: Send Messages, Embed Links, Connect, Speak.)

3. **Configure**

   ```powershell
   Copy-Item .env.example .env
   # fill in DISCORD_TOKEN, CLIENT_ID, and GUILD_ID (your server id, for instant command deploys)
   ```

4. **Install & run**

   ```powershell
   pnpm install
   pnpm register  # registers slash commands
   pnpm dev       # runs the bot with auto-reload
   ```

## Notes

- **YouTube playback breaks sometimes.** yt-dlp keeps up with YouTube changes; when playback stops working, update it: `pnpm update youtube-dl-exec`.
- **Price auto-detect** tries JSON-LD, then price meta tags, then price-ish CSS classes. When it fails, pass the `selector` option to `/watch` with a CSS selector for the price element (find it via DevTools → right-click price → Inspect).
- Some retailers (notably Amazon) block scrapers aggressively; expect failures there.
- Check interval defaults to 30 min (`CHECK_INTERVAL_MINUTES` in `.env`).
