import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Client } from 'discord.js';
import { metricsSnapshot, prometheusText } from './index.js';

/**
 * Optional local stats dashboard. Off unless STATS_PORT is set. Binds to
 * 127.0.0.1 by default (local-only — view remotely via an SSH tunnel). Setting
 * STATS_HOST to 0.0.0.0 exposes it on the network; use STATS_TOKEN then.
 *
 *   GET /            → auto-refreshing HTML dashboard
 *   GET /metrics     → JSON snapshot
 *   GET /prometheus  → Prometheus exposition format
 */
export function startStatsServer(client: Client): void {
  const port = Number(process.env.STATS_PORT);
  if (!port) return; // opt-in
  const host = process.env.STATS_HOST || '127.0.0.1';
  const token = process.env.STATS_TOKEN;

  const authorized = (url: URL, header: string | undefined): boolean => {
    if (!token) return true;
    const given = header?.replace(/^Bearer\s+/i, '') ?? url.searchParams.get('token') ?? '';
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    if (!authorized(url, req.headers.authorization)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('unauthorized');
      return;
    }
    const snap = metricsSnapshot(client.guilds.cache.size);
    if (url.pathname === '/metrics') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(snap, null, 2));
    } else if (url.pathname === '/prometheus') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(prometheusText(snap));
    } else if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });

  server.on('error', (err) => console.error('[stats] dashboard server error:', err));
  server.listen(port, host, () => {
    console.log(`[stats] dashboard on http://${host}:${port}${token ? ' (token required)' : ''}`);
  });
}

// Self-contained page; polls /metrics and re-renders. Passes the token through
// if the page itself was opened with ?token=.
const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Camelô · stats</title>
<style>
  :root { --bg:#131019; --panel:#1b1626; --rule:#2e2640; --ink:#ece7f4; --ink2:#b6acc7; --violet:#a78bfa; --amber:#fbbf24; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; padding:2rem 1.2rem; }
  .wrap { max-width:46rem; margin:0 auto; }
  h1 { font-size:1.3rem; letter-spacing:-.02em; margin:0 0 .2rem; }
  .sub { color:var(--ink2); font-size:.82rem; margin:0 0 1.4rem; }
  .sub b { color:var(--amber); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(11rem,1fr)); gap:.7rem; }
  .card { background:var(--panel); border:1px solid var(--rule); border-radius:11px; padding:.85rem 1rem; }
  .label { font-size:.68rem; text-transform:uppercase; letter-spacing:.1em; color:var(--ink2); margin:0 0 .35rem; }
  .val { font-size:1.5rem; font-weight:700; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
  .val small { font-size:.85rem; color:var(--ink2); font-weight:400; }
  .bar { height:5px; background:var(--rule); border-radius:3px; margin-top:.55rem; overflow:hidden; }
  .bar > i { display:block; height:100%; background:linear-gradient(90deg,var(--violet),var(--amber)); width:0; transition:width .4s; }
  .foot { color:var(--ink2); font-size:.75rem; margin-top:1.3rem; font-variant-numeric:tabular-nums; }
  code { color:var(--violet); }
</style></head>
<body><div class="wrap">
  <h1>📊 Camelô · resources</h1>
  <p class="sub">Live from the host — refreshes every 3s. <b id="live">●</b></p>
  <div class="grid" id="grid"></div>
  <p class="foot" id="foot">connecting…</p>
</div>
<script>
  const q = new URLSearchParams(location.search).get('token');
  const auth = q ? '?token=' + encodeURIComponent(q) : '';
  const mib = b => (b/1048576).toFixed(1) + ' MiB';
  const dur = s => { const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
    return (d?d+'d ':'')+(h?h+'h ':'')+m+'m'; };
  const cell = (label, val, barPct) => \`<div class="card"><p class="label">\${label}</p>
    <div class="val">\${val}</div>\${barPct!=null?\`<div class="bar"><i style="width:\${Math.min(100,barPct)}%"></i></div>\`:''}</div>\`;
  async function tick() {
    try {
      const m = await (await fetch('/metrics'+auth)).json();
      document.getElementById('grid').innerHTML = [
        cell('CPU', m.cpuPercent.toFixed(0)+'<small>% of 1 core</small>', m.cpuPercent),
        cell('Memory (RSS)', mib(m.memory.rss), m.memory.rss/(512*1048576)*100),
        cell('Voice sessions', m.music.sessions+'<small> · '+m.music.playing+' playing</small>'),
        cell('Queued tracks', m.music.queued),
        cell('Stream procs', (m.music.playing*2)+'<small> yt-dlp+ffmpeg</small>'),
        cell('Ollama', m.ollama.inFlight+'<small>/'+m.ollama.max+' in flight</small>', m.ollama.inFlight/m.ollama.max*100),
        cell('Database', mib(m.db.sizeBytes)+'<small> · '+m.db.playHistory+' rows</small>'),
        cell('Watches', m.db.watches+'<small> · '+m.db.reminders+' reminders</small>'),
        cell('Guilds', m.guilds),
      ].join('');
      document.getElementById('foot').textContent =
        'uptime ' + dur(m.uptimeSec) + ' · heap ' + mib(m.memory.heapUsed) + ' · buffers ' + mib(m.memory.buffers);
      document.getElementById('live').style.opacity = '1';
    } catch (e) {
      document.getElementById('foot').textContent = 'lost connection to the bot';
      document.getElementById('live').style.opacity = '.2';
    }
  }
  tick(); setInterval(tick, 3000);
</script>
</body></html>`;
