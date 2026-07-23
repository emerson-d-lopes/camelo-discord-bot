# Security

## Reporting a vulnerability

Open a private security advisory on the GitHub repo (Security → Advisories → Report
a vulnerability), or email the maintainer. Please do not file public issues for
undisclosed vulnerabilities. Expect an acknowledgement within a few days.

## Threat model

Camelô is a single-process, local-first Discord bot. The trust boundaries are:

- **Untrusted Discord input** — slash-command options, message content, and
  natural-language music requests from any server member.
- **Untrusted remote content** — arbitrary product pages fetched by the price
  watcher, YouTube/Spotify/SoundCloud metadata, and lyrics.
- **Local privileged resources** — the host filesystem, the LAN, the local
  Ollama server, and the Discord bot token.

The design keeps untrusted input from reaching privileged resources. The
invariants below are enforced in code and must not regress.

## Security invariants (do not regress)

- **Every user-supplied URL that is fetched** goes through `safeFetch` /
  `assertPublicHttpUrl` (`src/security.ts`): blocks non-http(s) schemes,
  non-80/443 ports, credentials, localhost-style names, and any host resolving
  to a private / loopback / link-local / metadata address (IPv4, IPv6, ULA,
  link-local, v4-mapped, NAT64). The resolved IP is **pinned** at connect time
  and every redirect hop is re-validated, closing the DNS-rebinding TOCTOU.
- **Screenshots** run headless Chrome with JavaScript disabled and route *all*
  browser traffic through a loopback guarded proxy (`guardedProxy.ts`) that
  pins every connection — navigation, redirects, and sub-resources — to a
  validated public IP. `--proxy-bypass-list=<-loopback>` prevents the page from
  sidestepping the proxy to reach localhost.
- **`/play` URLs** are restricted to the media host allowlist (`isAllowedMediaUrl`).
- **yt-dlp** is invoked via `youtube-dl-exec` (execFile, no shell), every search
  is `ytsearch1:`-prefixed so an argument can never be parsed as a flag, and
  `--ignore-config` prevents on-disk config from altering behaviour.
- **SQL** uses only parameterized statements for user data; the sole
  string-interpolated identifiers are hardcoded literals.
- **Mentions**: the client sets `allowedMentions: { parse: ['users'] }`; any
  reply echoing untrusted text uses `{ parse: [] }`. No `@everyone` / role-ping
  path exists.
- **Rate limiting** goes through `rateAllow` token buckets; expensive commands
  have tighter per-user caps, plus per-guild and process-wide ceilings.
- **LLM outputs** are JSON-schema-constrained and the parsed action is validated
  before use; prompts mark user text as data, and output cannot mass-mention.
- **Secrets**: `.env` and `data/` are gitignored and must never be committed or
  logged. CI runs gitleaks to enforce this.

Response bodies use `cappedText` (8 MiB cap). SSRF refusals are counted and
surfaced in `/stats`, `/metrics`, and `/prometheus` (`camelo_ssrf_blocks`) — a
rising count is an attacker probing internal addresses.

## Deployment hardening

- **Run as a dedicated low-privilege account** — never an administrator, and not
  your interactive user. The process needs write access only to its working
  directory and `data/`.
- **Cap child processes** (yt-dlp, ffmpeg, Chrome) with OS resource limits — a
  Windows Job Object or a Linux cgroup with memory/CPU/pids limits — so a hostile
  media file or page cannot exhaust the host.
- **Keep the media/browser toolchain patched**: yt-dlp, ffmpeg, and Chrome are
  the most exposed dependencies. Update on a schedule; Dependabot handles the npm
  side, but the Chrome binary and yt-dlp updater are out of band.
- **Never pass `--no-sandbox` to Chrome.** Keep the OS sandbox intact.
- The stats dashboard binds `127.0.0.1` by default. If `STATS_HOST=0.0.0.0`,
  `STATS_TOKEN` is mandatory; comparison is constant-time.

## Discord & token hygiene

- Invite the bot with the **least privilege** its commands require — do not grant
  Administrator on the OAuth invite. Gateway intents are already scoped to what
  the features use.
- Enable **2FA / team ownership** on the Discord application.
- Store the token in a secrets manager for production; `.env` is for local dev.
- **Rotate the token immediately** if it is ever logged, committed, pasted, or
  included in a backup. Rotation: Discord Developer Portal → Bot → Reset Token,
  update the secret, restart the process.
- `deploy-commands` (`pnpm register`) is a manual step, not something the running
  bot can trigger.

## Supply chain

- `pnpm-lock.yaml` is committed; CI installs with `--frozen-lockfile`.
- `.npmrc` sets `minimum-release-age` so brand-new (potentially compromised)
  releases are not pulled into a build immediately.
- CI gates: `pnpm audit --audit-level=high`, CodeQL (security-extended),
  Semgrep (security-audit / typescript / nodejsscan), and gitleaks.
