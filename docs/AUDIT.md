# Architecture & Code Audit — Camelô Discord bot

> **Historical snapshot.** These findings describe the code at commit
> `bac6e1f`; the actionable ones have since been addressed — see
> [CHANGELOG-refactor.md](CHANGELOG-refactor.md) for what was done.

Date: 2026-07-23. Read-only audit of the full repository (all of `src/`, tests,
CI, Docker, docs) ahead of a design/documentation improvement pass. Findings are
verified against the actual code, not the docs' claims. File references are
`path:line` at the audited commit (`bac6e1f`).

**Honest headline:** this repo is already far above the typical Discord-bot
baseline. Layered structure, a command registry feeding both dispatcher and
deploy script, a central error boundary, parameterized SQL, a serious SSRF
guard with connect-time IP pinning, token-bucket rate limits, schema-constrained
LLM output, security tests, and a five-job CI (lint, typecheck, tests,
`pnpm audit`, CodeQL, Semgrep, gitleaks) with a hardened non-root Docker image.
The audit therefore focuses on the genuine remaining gaps, not on re-imposing
generic "best practices" the repo already meets or deliberately rejected.

---

## 1. Current architecture (what exists today)

Single Node 24 process, TypeScript ESM, `tsx` in dev / compiled `dist/` in
Docker. One gateway client in `src/index.ts`; two input paths:

- **Slash commands** — `InteractionCreate` → rate-limit gate → command map
  built from `src/registry.ts` (each module exports `Command[]` of
  `{ data, execute }` from `src/commands.ts`).
- **Plain messages** — `MessageCreate` → `modules/music/mentions.ts`
  (mention or designated music/chat channel) → rules-first intent, local
  Ollama LLM fallback.

Modules (`music`, `watcher`, `reminders`, `stats`, `fun`, `welcome`, `ai`) sit
on a shared infrastructure layer: `security.ts` (SSRF guard, allowlist, token
buckets), `ollama.ts` (local LLM client with concurrency cap), `db.ts`
(better-sqlite3, prepared statements, additive migrations), `config.ts` (env).
Dependencies point downward only; modules do not import each other. The README
documents this accurately, with Mermaid diagrams.

Persistence: SQLite at `data/bot.db` (WAL), write-through music state, capped
history tables. Deployment: hardened Docker (pinned digest, multi-stage,
non-root, cap_drop ALL, mem/cpu/pids limits) or bare `pnpm start`.

Working-tree note: 6 files show as modified but the diff is empty — CRLF
line-ending noise only, nothing uncommitted.

## 2. Code smells & design issues

### High-impact

- **No graceful shutdown.** `src/index.ts` installs `unhandledRejection` /
  `uncaughtException` handlers only. No `SIGINT`/`SIGTERM` handler exists, so on
  stop/restart: live `MusicSession`s are never `destroy()`ed (voice connections
  linger until Discord times out; spawned yt-dlp/ffmpeg children can orphan),
  the Discord client is not destroyed, the SQLite handle is not closed, the
  watcher/reminder intervals (`watcher/watcher.ts:36`,
  `reminders/index.ts:35`) are not cleared, and the stats HTTP server is not
  closed. `MusicSession.destroy()` (`music/player.ts:402`) is thorough and
  idempotent — it is simply never invoked at exit. Docker sends SIGTERM on
  `compose down`, so this path runs on every container stop.

- **`MusicSession` god class** (`music/player.ts:70-421`, ~350 lines): mixes
  connection lifecycle, queue state, persistence, yt-dlp spawning,
  stream/buffer plumbing, autoplay logic, and housekeeping. `advance()`
  (`:213-294`) alone does loop-mode selection, autoplay fetch, DB record,
  buffer wiring, and process spawn. Works, but hard to test or modify safely.

### Duplication

- "Could not join voice" error branch appears verbatim in three places
  (`music/actions.ts:130`, `music/commands.ts:120`, `music/mentions.ts:238`).
- Voice-channel extraction: `memberVoiceChannel` helper in
  `music/commands.ts:28` vs the same expression inlined three times in
  `mentions.ts` (`:162`, `:194`, `:205`); listener-count expression duplicated
  (`commands.ts:88`, `mentions.ts:163`).
- `fmt()` price formatter defined twice with divergent null handling
  (`watcher/commands.ts:16` vs `watcher/watcher.ts:17`) — copies can drift.
- CPU-sampling implemented twice in `stats/index.ts` (`cpuPercent()` `:32` vs
  `metricsSnapshot()` `:66`).
- Resume logic split: `resumeAction` (`music/actions.ts:50`) vs an inline
  restart-restore reimplementation in `music/commands.ts:100-127` — partial
  violation of the repo's own "extend the action core" rule.
- Volume clamp derived independently in `player.ts:347` and `actions.ts:67`.
- "No watch #id belongs to you" reply block copy-pasted 4× in
  `watcher/commands.ts`.

### Smaller issues

- **Cooldown map never pruned** — `ai/index.ts:21` `lastUse` grows per userId
  for process lifetime; also burns the 15 s cooldown even when Ollama is down
  (`:41-49`), and `/ask` and `/summarize` share one map (undocumented
  cross-coupling).
- **Misleading comment** — `ai/index.ts:14` says "Discord embeds cap at 4096
  chars" above `MAX_TOKENS = 1024`, a token budget.
- **Magic numbers inline** — watch/reminder per-user and global caps, cooldown
  ms, skip threshold, truncation lengths, volume step, hardcoded Chrome UA for
  Spotify scraping (`player.ts:548`). All work; none are named or centralized.
- **Env reads scattered** — `config.ts` holds only 4 vars; `OLLAMA_URL`/models
  (`ollama.ts:1-5`), `OWNER_ID`, `STATS_*`, `PUPPETEER_EXECUTABLE_PATH` are
  read at point of use. No single validated config surface.
- **Sync work on hot async paths** — better-sqlite3 calls on
  enqueue/advance/shuffle, and up to 8 MB `JSON.parse` of Spotify HTML
  (`player.ts:560`). Accepted trade-off per README (single guild, local-first);
  noted, not flagged for change.
- Dice-spec parsing inline in the `/roll` handler (`fun/index.ts:47-61`) —
  cannot be unit-tested without extraction.
- Sequential `message.react()` loop in `/poll` with no partial-failure
  handling (`fun/index.ts:33`).

### Deliberate choices this audit does **not** flag as issues

- `console.*` with `[module]` prefixes instead of a logger — documented house
  style; adequate at this scale (a structured logger is listed as
  nice-to-have only).
- Static command registry instead of filesystem auto-loading — with ~30
  commands in 7 modules, the explicit list is type-safe, feeds both dispatcher
  and deploy script, and cannot drift. Dynamic loading would add failure modes
  and remove type safety for zero gain at this size.
- better-sqlite3 synchronous queries, tsx runtime, interval polling — all
  documented trade-offs in the README that fit the deployment reality.

## 3. Documentation gaps

The README is genuinely good (features, accurate architecture + three Mermaid
diagrams, setup, Docker, env table, security model). Remaining gaps:

- **No `docs/` split** — architecture, setup, and security live in one 13 KB
  README. Fine to keep, but deep-dive content (diagrams, patterns tables,
  trade-offs) could move to `docs/ARCHITECTURE.md` with the README keeping the
  overview. Decision point for the maintainer.
- **No CONTRIBUTING guide** — no documented "how to add a command/event",
  code-style conventions, or test-running instructions outside CLAUDE.md
  (which is AI-facing, not contributor-facing).
- **Env-var table lacks required/optional column and examples** — README table
  has purpose only; `OWNER_ID`, `STATS_HOST`, `STATS_TOKEN`,
  `CHECK_INTERVAL_MINUTES` defaults are in `.env.example` comments but not the
  README table.
- **Command list is prose, not a table** — no per-command
  permissions/cooldown column.
- **No LICENSE file** — private repo so arguably fine, but worth an explicit
  decision.
- **Setup guide omits OAuth scopes rationale** — the invite URL encodes
  `permissions=3212288` with no explanation of which permissions that is.
- JSDoc coverage is already good on `security.ts` / `interactions.ts`; thinner
  on `player.ts` internals and `stats/`.

## 4. Security concerns

No committed secrets: `.env` is gitignored, never appears in history, and CI
runs gitleaks. Verified findings, worst first:

- **[MED] Welcome message can mass-ping** — `welcome/index.ts:19-24` sends the
  admin-configured `welcome_message` (after `{user}`/`{server}` substitution)
  with no `allowedMentions` restriction. A user with Manage Server but without
  Mention Everyone can store `@everyone` in the template and have the bot ping
  it. Fix: send with `allowedMentions: { parse: [], users: [member.id] }` so
  `{user}` still pings the newcomer and nothing else resolves. (The
  client-level default `parse: ['users']` already blocks `@everyone` — this
  fix removes reliance on that single layer and stops arbitrary user pings.)
- **[MED] Stats server: public bind without token is allowed** —
  `stats/server.ts` binds `127.0.0.1` by default and compares tokens in
  constant time, but if an operator sets `STATS_HOST=0.0.0.0` and forgets
  `STATS_TOKEN`, `authorized()` returns true for everyone; only a comment
  warns. Fix: refuse to bind a non-loopback host without a token (fail fast at
  startup).
- **[LOW] Four hardcoded-host fetches bypass `safeFetch`** — Spotify oEmbed
  (`player.ts:504`), Spotify embed scrape (`player.ts:546`), lrclib lyrics
  (`music/commands.ts:311`), Mercado Livre API (`watcher/scraper.ts:114`).
  Hosts are hardcoded and inputs are encoded, so these are not user-URL SSRF
  holes — but they use global `fetch` (auto-follows redirects, no hop
  re-validation, no guarded dispatcher), an exception to the repo's own stated
  invariant. `spotifyToQuery` also reads `res.json()` with no byte cap.
- **[LOW] Playlist entry URLs not re-checked at play time** — `advance()`
  re-spawns yt-dlp on whatever `webpage_url` yt-dlp returned for a playlist
  entry (`player.ts:251`) without re-running `isAllowedMediaUrl`. In practice
  these originate from allowlisted hosts; a one-line re-check closes it.
- Everything else checked out: SSRF guard + redirect re-validation + IP
  pinning (incl. the Chromium loopback proxy) verified correct; yt-dlp
  command-injection surface well defended (`ignoreConfig`, array args,
  `entryUrl` http(s)-only, `ytsearch1:` prefixes, Windows whitespace-path
  fail-fast); SQL fully parameterized (with a test proving it);
  `allowedMentions: { parse: [] }` discipline consistent on untrusted content;
  Chromium child env stripped of secrets; ownership checks prevent IDOR on
  watches/reminders; stats dashboard HTML injection-free.

## 5. Test coverage gaps

Existing: `pure.test.ts` (price parsing, durations, rule intents) and
`security.test.ts` (SSRF guard, proxy, ReDoS, SQL binding) — well-aimed.
Untested pure logic worth covering (no Discord connection needed):

| Function | Where | Why it matters |
|---|---|---|
| `isAllowedMediaUrl` | `security.ts:46` | The `/play` allowlist gate — only unguarded security function |
| `mdLinkText` | `interactions.ts:18` | Link-injection neutralizer on untrusted titles |
| `normalize` | `music/intent.ts:131` | LLM-output schema defense (unknown action → chat) |
| `entryUrl` | `music/player.ts:493` | yt-dlp flag-injection guard |
| `chunkMessage` | `music/mentions.ts:37` | Subtle 2000-char boundary logic |
| `isClearPhrase` / `CLEAR_RE` | `ai/converse.ts:22` | Large bilingual regex, high regression risk |
| `sparkline`, `findJsonLdPrice` | `watcher/` | Pure, non-trivial |
| `isDue` | `watcher/watcher.ts:39` | Timestamp reconstruction (` `→`T…Z`) is subtle |
| `prometheusText`, `humanDuration` | `stats/index.ts` | Pure formatters |
| skip-vote threshold, volume clamp | `music/actions.ts` | Pure decision logic behind mocks |
| dice parsing | `fun/index.ts:47` | Needs extraction first |

## 6. Prioritized improvements

### Quick wins (small, safe, high value)

1. **Graceful shutdown** — one SIGINT/SIGTERM handler: destroy music sessions,
   destroy client, clear intervals, close stats server, close DB.
2. **Welcome `allowedMentions` fix** (security, MED).
3. **Stats server fail-fast** on non-loopback bind without token (security, MED).
4. **Route the four hardcoded-host fetches through `safeFetch`**; cap the
   Spotify oEmbed JSON read; re-check `isAllowedMediaUrl` at play time.
5. **Dedupe**: `fmt()`, voice-channel/listener helpers, join-error reply,
   watch-ownership reply, volume clamp; point resume restore at `resumeAction`.
6. **Cooldown hygiene**: prune `lastUse`, don't burn cooldown when Ollama is
   down (or replace map with existing `rateAllow`); fix the misleading
   embed-cap comment.
7. **Unit tests for the table above** (~10 small test groups on existing seams).

### Structural refactors (bigger, do incrementally)

1. **Split `MusicSession`**: extract queue+persistence and the yt-dlp
   stream-pipeline from session lifecycle. Highest-risk change in the repo —
   do last, behind the new tests.
2. **Centralize config**: move all env reads (`OLLAMA_URL`, models, `OWNER_ID`,
   `STATS_*`, `PUPPETEER_EXECUTABLE_PATH`) into `config.ts` with validation
   and defaults; keep `requireEnv` fail-fast pattern.
3. **Extract dice parsing** to a pure function (then test it).
4. **Consolidate stats CPU sampling** into one snapshot path.

### Nice-to-haves (explicitly optional)

- `docs/` split (ARCHITECTURE / SETUP / CONTRIBUTING) with README as overview.
- Named-constants module for the inline caps/limits.
- Structured logger (house style says console+tags is deliberate — only if
  wanted).
- LICENSE decision.
- `/poll` partial-reaction failure handling.
- Reconnect attempt (`rejoin()`) on voice `Disconnected` before tearing down.

Out of scope by constraint: user-facing behavior changes (except the two
security fixes above), library/major-version changes, replacing the static
registry with dynamic loading, replacing better-sqlite3/tsx/polling.
