# Contributing

Working notes for changing this bot — conventions, how to add things, and what
must never regress. (Personal project; "contributor" mostly means future-you.)

## Setup & everyday commands

Prereqs and first-run steps are in the [README](../README.md#setup). Day to day:

```powershell
pnpm dev         # run with auto-reload (tsx watch)
pnpm start       # run once
pnpm register    # (re)register slash commands — required after adding/renaming one
pnpm typecheck   # tsc --noEmit
pnpm test        # node:test over test/*.test.ts
pnpm lint        # biome check
pnpm format      # biome check --write (auto-fix imports/formatting)
pnpm build       # compile to dist/ (what the Docker image runs)
```

Before committing: `pnpm typecheck && pnpm lint && pnpm test`. CI runs those
plus `pnpm audit`, CodeQL, Semgrep, and gitleaks on every push.

## Layout

```
src/
  index.ts          entry: client, intents, rate-limit gate, dispatch, shutdown
  registry.ts       the one list of commands (dispatcher + deploy both read it)
  commands.ts       the Command interface
  config.ts         ALL environment reads — nothing else touches process.env
  security.ts       SSRF guard, media allowlist, token buckets, safeFetch
  ollama.ts         local LLM client (concurrency cap, schema output)
  db.ts             SQLite: schema, additive migrations, typed helpers
  interactions.ts   shared reply helpers (ephemeral, replyNoPing, mdLinkText)
  modules/<name>/   one folder per feature, commands + logic together
test/
  pure.test.ts      pure functions (parsers, formatters, queue/vote logic)
  security.test.ts  SSRF guard, allowlist, injection, ReDoS regressions
```

## Adding a slash command

One object implementing `Command` (`{ data, execute }`), exported from its
module and appended to the module's `xxxCommands` array — `src/registry.ts`
aggregates those, so both the runtime dispatcher and `pnpm register` see it
automatically.

```ts
// src/modules/example/index.ts
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../commands.js';

const hello: Command = {
  data: new SlashCommandBuilder()
    .setName('hello')
    .setDescription('Say hello')
    .addStringOption((o) => o.setName('name').setDescription('Who to greet').setRequired(true)),
  async execute(interaction) {
    // defer first if this will take >3s (network, LLM, subprocess)
    await interaction.reply({
      content: `👋 ${interaction.options.getString('name', true)}`,
      allowedMentions: { parse: [] }, // echoing user input? never let it ping
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const exampleCommands: Command[] = [hello];
```

Then: register the array in `src/registry.ts`, run `pnpm register`, restart the
bot. Checklist for any new command:

- **Slow work** (fetch, yt-dlp, Ollama, Chrome) → `await interaction.deferReply()`
  first; Discord kills un-acked interactions after 3 s.
- **Untrusted text in the reply** (user input, titles, LLM output) →
  `allowedMentions: { parse: [] }` (or the `replyNoPing`/`ephemeral` helpers),
  and `mdLinkText()` around link labels.
- **Privileged action** → `setDefaultMemberPermissions` on the builder AND a
  server-side `interaction.memberPermissions` re-check (admins can override the
  client-side default per guild — see `/welcome` for the pattern).
- **Expensive command** → add its name to the `EXPENSIVE` set in `src/index.ts`
  and/or a module cooldown; every command already passes the global per-user
  token bucket.
- **New env var** → read it in `src/config.ts` only, document it in
  `.env.example` and the README table.

## Adding an event handler

Follow the `startWelcome` pattern: a `startX(client)` function that subscribes
in `src/index.ts` (before login for message events, in `ClientReady` for loops),
plus a matching `stopX()` if it owns a timer/server — and call that from the
`shutdown()` handler in `src/index.ts`.

## Music: extend the action core

Play/skip/stop/volume logic lives once in `src/modules/music/actions.ts`; the
slash commands (`commands.ts`) and the natural-language handler (`mentions.ts`)
both render its `ActionReply` results. Add capability there, not in one entry
point — the two surfaces must not drift. Queue/persistence changes go in
`queue.ts`, stream-pipeline changes in `stream.ts`.

## Code style

Enforced by Biome (`biome.json`): 2-space indent, 110-col lines, single quotes,
ESM with **`.js` extensions on relative imports** (NodeNext). `pnpm format`
fixes import order. House logging style: `console.warn` for expected/non-fatal,
`console.error` for real failures, `[module]`-tagged prefixes. Comments explain
*why*, not *what*.

## Tests

`node:test` + `node:assert/strict`, no framework. Keep logic testable by
writing it as pure functions (parse/format/decide) and exporting them; the
Discord objects stay at the edges. Security-sensitive helpers (URL guards,
sanitizers, schema validation of LLM output) get tests in `security.test.ts` —
including regression cases for anything that was once exploitable.

## Security invariants (do not regress)

The full list lives in [CLAUDE.md](../CLAUDE.md#security-invariants-do-not-regress)
and `SECURITY.md`. Short form: every outbound fetch goes through `safeFetch`;
`/play` URLs pass `isAllowedMediaUrl` (again at spawn time); LLM output is
schema-constrained and re-validated; untrusted text never pings; secrets exist
only in `.env`/config. Semgrep false positives are suppressed inline with a
scoped `// nosemgrep: <rule-id>` plus a justification comment — never blanket.

## Commits

Conventional-commit style subjects (`fix:`, `feat:`, `refactor:`, `harden:`,
`test:`, `docs:`), body explaining why. Work on `main` (solo repo); CI must be
green before considering a change done.
