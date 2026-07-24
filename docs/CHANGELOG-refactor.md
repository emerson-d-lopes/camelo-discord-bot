# Refactor changelog — 2026-07-23

Audit → refactor → docs pass over the whole repo. Every step kept the bot
runnable and green on `typecheck && lint && test`; one commit per concern. The
full findings list is in [AUDIT.md](AUDIT.md).

## Phase 1 — Audit

- `docs/AUDIT.md`: honest architecture summary, verified findings
  (severity-tagged, `file:line`), prioritized plan. Confirmed no committed
  secrets and that most "best practices" were already in place — the plan
  targeted the real gaps only.

## Phase 2 — Fixes & refactors

Security fixes (behavior changes, both approved):

- **Welcome messages can no longer mass-ping** — the admin-configured template
  is sent with `allowedMentions: { parse: [], users: [member.id] }`, so `{user}`
  still pings the newcomer but `@everyone`/roles/other users typed into the
  template never resolve.
- **Stats server refuses a public bind without a token** — `STATS_HOST` set to
  a non-loopback address with no `STATS_TOKEN` now disables the dashboard
  loudly instead of serving metrics to the network.

Hardening:

- All four hardcoded-host fetches (Spotify oEmbed + embed page, lrclib lyrics,
  Mercado Livre API) now go through `safeFetch` (redirect-hop re-validation,
  pinned-IP dispatcher) with 256 KB caps on the previously uncapped JSON reads.
- `advance()` re-checks `isAllowedMediaUrl` before every yt-dlp play spawn, so
  playlist entries can't smuggle a non-allowlisted host.
- All 8 blocking Semgrep findings resolved: the bot-mention check no longer
  builds a RegExp at runtime, flagged URL regexes became string prefix checks
  (`isHttpUrl`), and the true false positives (game-dice/shuffle
  `Math.random`, browser User-Agent string) got scoped, justified `nosemgrep`
  suppressions. Local scan with CI's exact configs: 0 findings.

Reliability:

- **Graceful shutdown** on SIGINT/SIGTERM: persists and destroys music
  sessions (killing yt-dlp/ffmpeg children), stops the watcher/reminder loops
  and stats server, destroys the Discord client, closes SQLite. Runs on every
  `docker compose stop`.
- `/ask`/`/summarize` no longer burn the 15 s cooldown when Ollama is down;
  the cooldown map is pruned hourly.

Structure:

- **`MusicSession` split**: `TrackQueue` (`music/queue.ts`) owns queue state,
  loop-mode selection, and write-through persistence; `spawnTrackStream`
  (`music/stream.ts`) owns the yt-dlp → lookahead-buffer → audio-resource
  pipeline plus the Windows whitespace-path fail-fast. The session keeps voice
  lifecycle/autoplay/housekeeping behind an unchanged public surface.
- **Config centralized**: every `process.env` read now lives in
  `src/config.ts` (Ollama URL/models, `OWNER_ID`, `STATS_*`,
  `PUPPETEER_EXECUTABLE_PATH`); an invalid `STATS_PORT` fails at boot.
- **Dedupe**: one `fmt()` price formatter, shared
  `voiceChannelOf`/`listenersIn`/`joinErrorText` helpers, `/resume`'s restore
  path folded into `resumeOrRestoreAction`, volume clamp single-sourced in
  `setVolume`, `requireOwnWatch` collapses the watch-ownership reply, one
  `cpuPct` formula in stats, dice parsing extracted to pure `parseDiceSpec`.

Tests: 12 → 26, covering the security seams (`isAllowedMediaUrl`, `isHttpUrl`,
`entryUrl`, `normalize`, `mdLinkText`) and the pure logic behind commands
(`chunkMessage`, `isClearPhrase`, `parseDiceSpec`, `sparkline`,
`findJsonLdPrice`, `isDue`, `fmt`, `humanDuration`, `prometheusText`,
`skipAction` vote thresholds).

## Phase 3 — Documentation

- `docs/CONTRIBUTING.md` (new): commands/events how-to with template, layout,
  style, test conventions, security checklist for new commands.
- `README.md`: env table gained Required/Default columns and the previously
  undocumented `OWNER_ID`/`STATS_*` vars; architecture prose/table updated for
  the music-module split (README intentionally stays the single deep-dive doc).
- `CLAUDE.md`: new module layout, config-centralization rule, shutdown
  convention, nosemgrep policy, sharpened security invariants.
- `docs/AUDIT.md`, this changelog.

## Phase 4 — Verification

- `pnpm typecheck` / `lint` / `test` (26/26) green; `pnpm build` compiles.
- Semgrep (CI configs) locally: 0 findings.
- Docker image builds; container start/stop exercises the SIGTERM shutdown
  path. CI (lint/typecheck/tests, audit, CodeQL, Semgrep, gitleaks) green on
  push.

## Post-refactor ops (same day)

- `docker-compose.yml` moved to `restart: always` and Docker Desktop's
  sign-in autostart was enabled, so the bot survives crashes, engine
  restarts, and reboots unattended (verified live: SIGTERM'd PID 1 →
  container auto-restarted and re-logged in). On Windows/WSL2 the engine
  needs a signed-in session — documented in the README.

## Deliberately left out (future candidates)

- **Structured logger** — house style is tagged `console.*`; fine at this
  scale, revisit if log volume grows.
- **`docs/` split of the README** — owner preference is the monolith.
- **LICENSE file** — private repo; add one if it ever goes public.
- **`/poll` partial-reaction handling** — a failed `react()` mid-loop leaves a
  half-reacted poll; cosmetic.
- **Voice `rejoin()` attempt** on unexpected disconnect before tearing down.
- **Unifying the AI cooldown onto `rateAllow`** — would lose the per-second
  countdown message for little gain.
- **`isAllowedMediaUrl` for yt-dlp search results** — search output is already
  constrained by `ytsearch1:`; revisit if more resolvers are added.
