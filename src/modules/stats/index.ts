import {
  type Client,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { Command } from '../../commands.js';
import { dbStats } from '../../db.js';
import { ollamaStats } from '../../ollama.js';
import { ssrfBlockCount } from '../../security.js';
import { musicStats } from '../music/player.js';

const OWNER_ID = process.env.OWNER_ID;

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function humanDuration(sec: number): string {
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

/** Sample process CPU over a short window and return whole-process % (can exceed 100 across cores). */
async function cpuPercent(sampleMs = 400): Promise<number> {
  const start = process.cpuUsage();
  const startTime = process.hrtime.bigint();
  await new Promise((r) => setTimeout(r, sampleMs));
  const delta = process.cpuUsage(start); // microseconds
  const elapsedUs = Number(process.hrtime.bigint() - startTime) / 1000;
  return ((delta.user + delta.system) / elapsedUs) * 100;
}

export function collectStats(): {
  mem: NodeJS.MemoryUsage;
  music: ReturnType<typeof musicStats>;
  ollama: ReturnType<typeof ollamaStats>;
  db: ReturnType<typeof dbStats>;
} {
  return { mem: process.memoryUsage(), music: musicStats(), ollama: ollamaStats(), db: dbStats() };
}

// CPU% between successive metrics polls (the web dashboard polls on an interval).
let lastCpu = process.cpuUsage();
let lastCpuAt = process.hrtime.bigint();

export interface MetricsSnapshot {
  uptimeSec: number;
  cpuPercent: number;
  guilds: number;
  ssrfBlocks: number;
  memory: { rss: number; heapUsed: number; heapTotal: number; buffers: number };
  music: ReturnType<typeof musicStats>;
  ollama: ReturnType<typeof ollamaStats>;
  db: ReturnType<typeof dbStats>;
}

/** Full snapshot for the web dashboard / API. CPU% is measured since the previous call. */
export function metricsSnapshot(guilds: number): MetricsSnapshot {
  const now = process.hrtime.bigint();
  const delta = process.cpuUsage(lastCpu);
  const elapsedUs = Number(now - lastCpuAt) / 1000;
  lastCpu = process.cpuUsage();
  lastCpuAt = now;
  const cpuPercent = elapsedUs > 0 ? ((delta.user + delta.system) / elapsedUs) * 100 : 0;
  const s = collectStats();
  return {
    uptimeSec: Math.round(process.uptime()),
    cpuPercent: Number(cpuPercent.toFixed(1)),
    guilds,
    ssrfBlocks: ssrfBlockCount(),
    memory: {
      rss: s.mem.rss,
      heapUsed: s.mem.heapUsed,
      heapTotal: s.mem.heapTotal,
      buffers: s.mem.external + s.mem.arrayBuffers,
    },
    music: s.music,
    ollama: s.ollama,
    db: s.db,
  };
}

/** Prometheus exposition format — point a scraper at /prometheus if you add Grafana. */
export function prometheusText(m: MetricsSnapshot): string {
  const lines = [
    `camelo_uptime_seconds ${m.uptimeSec}`,
    `camelo_cpu_percent ${m.cpuPercent}`,
    `camelo_guilds ${m.guilds}`,
    `camelo_memory_rss_bytes ${m.memory.rss}`,
    `camelo_memory_heap_used_bytes ${m.memory.heapUsed}`,
    `camelo_memory_buffers_bytes ${m.memory.buffers}`,
    `camelo_voice_sessions ${m.music.sessions}`,
    `camelo_voice_playing ${m.music.playing}`,
    `camelo_queued_tracks ${m.music.queued}`,
    `camelo_ytdlp_inflight ${m.music.ytdlpInFlight}`,
    `camelo_ollama_inflight ${m.ollama.inFlight}`,
    `camelo_db_bytes ${m.db.sizeBytes}`,
    `camelo_watches ${m.db.watches}`,
    `camelo_reminders ${m.db.reminders}`,
    `camelo_play_history_rows ${m.db.playHistory}`,
    `camelo_ssrf_blocks ${m.ssrfBlocks}`,
  ];
  return `${lines.join('\n')}\n`;
}

const stats: Command = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show the bot’s resource usage (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction) {
    // Defense in depth: the admin-only default (setDefaultMemberPermissions) can
    // be overridden per guild, so authorize server-side here too. OWNER_ID, when
    // set, is the hard lock; otherwise require Administrator.
    if (OWNER_ID) {
      if (interaction.user.id !== OWNER_ID) {
        await interaction.reply({ content: 'Owner only.', flags: MessageFlags.Ephemeral });
        return;
      }
    } else if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'Administrator only.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply();
    const cpu = await cpuPercent();
    const s = collectStats();
    const cores = (await import('node:os')).cpus().length;

    const embed = new EmbedBuilder()
      .setTitle('📊 Camelô resource usage')
      .setColor(0x8b5cf6)
      .addFields(
        {
          name: 'Process',
          value: [
            `Uptime: ${humanDuration(process.uptime())}`,
            `CPU: ${cpu.toFixed(0)}% of 1 core (${cores} cores total)`,
            `WS ping: ${Math.max(0, Math.round(interaction.client.ws.ping))} ms`,
          ].join('\n'),
          inline: false,
        },
        {
          name: 'Memory',
          value: [
            `RSS: **${mib(s.mem.rss)}**`,
            `Heap: ${mib(s.mem.heapUsed)} / ${mib(s.mem.heapTotal)}`,
            `Buffers (external): ${mib(s.mem.external + s.mem.arrayBuffers)}`,
          ].join('\n'),
          inline: true,
        },
        {
          name: 'Music (heaviest load)',
          value: [
            `Voice sessions: **${s.music.sessions}** (${s.music.playing} playing)`,
            `Queued tracks: ${s.music.queued}`,
            `yt-dlp resolves: ${s.music.ytdlpInFlight}/6`,
            `≈ ${s.music.playing * 2} stream procs (yt-dlp + ffmpeg)`,
          ].join('\n'),
          inline: true,
        },
        {
          name: 'AI (local Ollama)',
          value: `In flight: ${s.ollama.inFlight}/${s.ollama.max}`,
          inline: true,
        },
        {
          name: 'Data',
          value: [
            `DB size: ${mib(s.db.sizeBytes)}`,
            `Watches: ${s.db.watches} · Reminders: ${s.db.reminders}`,
            `Play history: ${s.db.playHistory} rows`,
          ].join('\n'),
          inline: true,
        },
        {
          name: 'Servers',
          value: `${interaction.client.guilds.cache.size} guild(s)`,
          inline: true,
        },
        {
          name: 'Security',
          value: `SSRF blocks: ${ssrfBlockCount()}`,
          inline: true,
        },
      )
      .setFooter({ text: `Node ${process.version} · pid ${process.pid}` });

    await interaction.editReply({ embeds: [embed] });
  },
};

/** Log a one-line resource summary on an interval — for headless monitoring. */
export function startStatsMonitor(_client: Client, everyMinutes = 15): void {
  const log = () => {
    const s = collectStats();
    console.log(
      `[stats] rss=${mib(s.mem.rss)} sessions=${s.music.sessions}(playing ${s.music.playing}) ` +
        `queued=${s.music.queued} ytdlp=${s.music.ytdlpInFlight} ollama=${s.ollama.inFlight} ` +
        `db=${mib(s.db.sizeBytes)}`,
    );
  };
  log();
  setInterval(log, everyMinutes * 60_000).unref();
}

export const statsCommands: Command[] = [stats];
