# CLAUDE.md — Camelô Discord bot

Project context for AI assistants working in this repo. Workspace-root and
global `CLAUDE.md` rules still apply and take precedence.

## What this is

A single-process, **local-first** Discord bot (discord.js v14): music player
with natural-language control, price watcher, reminders, and small utilities.
Every AI call runs on a **local Ollama server** — there is no cloud AI, no API
keys. Do not reintroduce a cloud LLM SDK; that was deliberately removed.

Full design, diagrams, and trade-offs are in the **README** (Architecture
section) — read it before large changes.

## Environment

Windows 11, **PowerShell 7 (`pwsh`)** is the shell — PowerShell syntax, not
bash. Package manager is **pnpm** (via corepack). Node 24 (pinned in
`.node-version`). ESM / NodeNext throughout.

## Commands

```powershell
pnpm dev         # run with auto-reload (tsx watch)
pnpm start       # run once
pnpm register    # (re)register slash commands — run after adding/renaming a command
pnpm typecheck   # tsc --noEmit
pnpm test        # node:test on the pure functions
pnpm lint        # biome check
pnpm format      # biome check --write
```

Before committing, run `pnpm typecheck && pnpm lint && pnpm test`. CI runs all
three on push.

## Conventions

- **ESM imports use `.js` extensions** on relative paths (NodeNext), even though
  the files are `.ts`.
- **Commands** implement the `Command` interface (`{ data, execute }`) in
  `src/commands.ts` and are aggregated in `src/registry.ts` — add new commands
  there; both the runtime dispatcher and the deploy script read that one list.
- **Music logic is shared.** Play/skip/stop/etc. live once in
  `src/modules/music/actions.ts`; the slash commands (`music/commands.ts`) and
  the natural-language handler (`music/mentions.ts`) both call it. Don't
  reimplement an action in one place — extend the action core.
- Use the `ephemeral()` / `replyNoPing()` helpers in `src/interactions.ts` for
  the common reply shapes.
- Logging house style: `console.warn` for expected/non-fatal, `console.error`
  for real failures, tagged prefixes like `[music]` / `[watcher]`.

## Security invariants (do not regress)

- **Every user-supplied URL** that gets fetched goes through `safeFetch` /
  `assertPublicHttpUrl` in `src/security.ts` (SSRF guard: blocks private /
  loopback / metadata, re-validates each redirect hop, pins the resolved IP at
  connect via the guarded undici dispatcher). Response bodies use `cappedText`.
- `/play` URLs are restricted to the media allowlist (`isAllowedMediaUrl`).
- All user-facing rate limiting goes through `rateAllow` (token buckets).
- Never echo an untrusted string (track title, user input) into message
  **content** without `allowedMentions: { parse: [] }`.
- LLM outputs are JSON-schema-constrained; validate the parsed action before
  acting on it.

## Workflow notes

- **The bot must be restarted to pick up changes** when run via `pnpm start`
  (not `dev`). After editing, restart and confirm `Logged in as Camelô#…` in the
  output before testing.
- Adding/renaming a slash command requires `pnpm register` to update Discord.
- SQLite lives at `data/bot.db` (gitignored). Schema changes use the additive
  `PRAGMA table_info` + `ALTER TABLE` guards in `src/db.ts`.
- `.env` holds the token and is gitignored — never commit it, never log the
  token.

## Git

This is a **personal** repo (`emerson-d-lopes/camelo-discord-bot`). The global
org-block rule applies; only push here.
