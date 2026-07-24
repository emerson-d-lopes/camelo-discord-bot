import type { PassThrough } from 'node:stream';
import {
  type AudioPlayer,
  AudioPlayerStatus,
  type AudioResource,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import type { Client, VoiceBasedChannel } from 'discord.js';
import { youtubeDl } from 'youtube-dl-exec';
import { recordPlay } from '../../db.js';
import { cappedText, isAllowedMediaUrl, isHttpUrl, safeFetch } from '../../security.js';
import { type LoopMode, type Track, TrackQueue } from './queue.js';
import { spawnTrackStream } from './stream.js';

export type { LoopMode, Track } from './queue.js';

const sessions = new Map<string, MusicSession>();

const IDLE_LEAVE_MINUTES = 5;
const RECENT_AUTOPLAY_MEMORY = 50;
// Radio: top the queue up to TARGET related tracks whenever it drops below MIN,
// so playback never runs dry while people are listening.
const AUTOPLAY_MIN = 2;
const AUTOPLAY_TARGET = 5;

// Cap concurrent yt-dlp resolve/metadata spawns across all guilds so a /play
// flood can't fork unbounded processes.
const MAX_YTDLP = 6;
let ytdlpInFlight = 0;
async function withYtdlpSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (ytdlpInFlight >= MAX_YTDLP)
    throw new Error('The bot is busy resolving other tracks — try again in a moment.');
  ytdlpInFlight++;
  try {
    return await fn();
  } finally {
    ytdlpInFlight--;
  }
}

export class MusicSession {
  /** Queue state + persistence live in TrackQueue; the session wires it to voice. */
  private readonly q: TrackQueue;
  volume = 1;
  private lastTrack: Track | null = null;
  skipVotes = new Set<string>();
  private skipRequested = false;
  private advancing = false;
  private readonly player: AudioPlayer;
  private proc: ReturnType<typeof youtubeDl.exec> | null = null;
  private resource: AudioResource | null = null;
  private buffer: PassThrough | null = null;
  private idleMinutes = 0;
  private readonly housekeeper: NodeJS.Timeout;
  private readonly recentUrls: string[] = [];
  private resolvingAutoplay = false;

  constructor(
    private readonly connection: VoiceConnection,
    readonly guildId: string,
    private readonly channelId: string,
    private readonly client: Client,
  ) {
    // Tolerate ~5s of missed frames before auto-pausing — brief hiccups
    // shouldn't kill playback (default is 5 frames = 100ms).
    this.player = createAudioPlayer({ behaviors: { maxMissedFrames: 250 } });
    connection.subscribe(this.player);

    // TrackQueue restores the persisted queue/settings from a previous run.
    this.q = new TrackQueue(guildId);

    this.player.on(AudioPlayerStatus.Idle, () => void this.playNext());
    this.player.on('error', (err) => {
      console.error(`[music] player error in guild ${guildId}:`, err.message);
      void this.playNext();
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      // Might be a region move/reconnect — give it 5s before tearing down.
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy();
      }
    });

    this.housekeeper = setInterval(() => void this.housekeep(), 60_000);
  }

  // --- public queue surface (delegates to TrackQueue, same shapes as before) ---

  get queue(): Track[] {
    return this.q.tracks;
  }

  get current(): Track | null {
    return this.q.current;
  }

  get loopMode(): LoopMode {
    return this.q.loopMode;
  }

  set loopMode(mode: LoopMode) {
    this.q.loopMode = mode;
  }

  get autoplay(): boolean {
    return this.q.autoplay;
  }

  set autoplay(on: boolean) {
    this.q.autoplay = on;
  }

  /** Auto-leave when idle with an empty queue, or alone in the channel, for IDLE_LEAVE_MINUTES. */
  private async housekeep(): Promise<void> {
    try {
      await this.housekeepInner();
    } catch (err) {
      console.warn(`[music] housekeep failed in guild ${this.guildId}:`, err);
    }
  }

  private async housekeepInner(): Promise<void> {
    let alone = true; // if we can't tell, assume no one is listening
    try {
      const channel = await this.client.channels.fetch(this.channelId);
      if (channel?.isVoiceBased()) {
        alone = channel.members.filter((m) => !m.user.bot).size === 0;
      }
    } catch {
      // channel fetch failed — treat as alone so we don't camp forever
    }

    // Leave only when the channel is empty. While people are present, keep the
    // music going — never sit idle.
    if (alone) {
      this.idleMinutes++;
      if (this.idleMinutes >= IDLE_LEAVE_MINUTES) {
        console.log(`[music] auto-leaving empty channel in guild ${this.guildId}`);
        this.destroy();
      }
      return;
    }
    this.idleMinutes = 0;
    if (this.current === null) {
      if (this.queue.length > 0) void this.playNext();
      else void this.topUp(); // radio ran dry with people here — revive it
    }
  }

  enqueue(track: Track): void {
    this.q.push(track);
    if (this.current === null) void this.playNext();
  }

  /** Kick off playback of the restored queue without adding anything. */
  resumeIfIdle(): boolean {
    if (this.current === null && this.queue.length > 0) {
      void this.playNext();
      return true;
    }
    return false;
  }

  /**
   * Advance the queue. Guarded against concurrent invocation — the Idle event,
   * player errors, and enqueue can all fire this while an earlier run is still
   * awaiting the autoplay fetch; without the guard two yt-dlp processes spawn
   * and one leaks.
   */
  private async playNext(): Promise<void> {
    if (this.advancing) return;
    this.advancing = true;
    try {
      await this.advance();
    } catch (err) {
      console.error(`[music] advance failed in guild ${this.guildId}:`, err);
    } finally {
      this.advancing = false;
      // A track enqueued while we were mid-advance (e.g. during the autoplay
      // fetch) would otherwise sit unplayed until the next trigger.
      if (this.current === null && this.queue.length > 0) void this.playNext();
    }
  }

  private async advance(): Promise<void> {
    this.killProc();
    this.skipVotes.clear();

    const { track: picked, repeated } = this.q.pickNext(this.skipRequested);
    this.skipRequested = false;

    let next = picked;
    if (!next && this.autoplay && this.current) {
      next = await this.fetchAutoplayTrack(this.current);
    }

    if (!next) {
      this.q.current = null;
      this.q.persist();
      return;
    }
    this.q.current = next;
    this.lastTrack = next;
    this.rememberUrl(next.url);
    this.q.persist();
    if (!repeated) {
      try {
        recordPlay(this.guildId, next.requestedBy, next.title);
      } catch (err) {
        console.warn('[music] history record failed:', err);
      }
    }
    // Fill the radio buffer ahead of time so the queue never runs dry mid-song.
    void this.topUp();

    // Playlist entries carry whatever webpage_url yt-dlp reported for them —
    // re-check the allowlist at spawn time so only approved hosts are played.
    // (`ytsearch1:` placeholders are not URLs and skip this check.)
    if (isHttpUrl(next.url) && !isAllowedMediaUrl(next.url)) {
      console.warn(`[music] dropping track with non-allowlisted url: ${next.url}`);
      this.q.current = null;
      this.q.persist();
      // Don't stall — the playNext() finally-guard advances to the next track.
      return;
    }

    const stream = spawnTrackStream(next.url, this.volume);
    if (!stream) {
      console.error('[music] yt-dlp spawned without stdout — skipping track');
      this.q.current = null;
      this.q.persist();
      // Don't stall — the playNext() finally-guard advances to the next track.
      return;
    }
    this.proc = stream.proc;
    this.buffer = stream.buffer;
    this.resource = stream.resource;
    this.player.play(stream.resource);
  }

  private rememberUrl(url: string): void {
    this.recentUrls.push(url);
    if (this.recentUrls.length > RECENT_AUTOPLAY_MEMORY) this.recentUrls.shift();
  }

  /** Related tracks from the YouTube mix of a seed song, skipping recently-played ones. */
  private async fetchAutoplayTracks(seed: Track, want: number): Promise<Track[]> {
    const videoId = seed.url.match(/[?&]v=([\w-]{5,})/)?.[1] ?? seed.url.match(/youtu\.be\/([\w-]{5,})/)?.[1];
    if (!videoId) return [];
    const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
    const tracks = await resolveTracks(mixUrl, seed.requestedBy);
    const queued = new Set(this.queue.map((t) => t.url));
    return tracks.filter((t) => !this.recentUrls.includes(t.url) && !queued.has(t.url)).slice(0, want);
  }

  private async fetchAutoplayTrack(seed: Track): Promise<Track | undefined> {
    return (await this.fetchAutoplayTracks(seed, 1))[0];
  }

  /**
   * Radio top-up: when autoplay is on and the queue is running low, append
   * related tracks so playback stays continuous. Seeds from the current (or
   * last-played) song.
   */
  private async topUp(): Promise<void> {
    if (!this.autoplay || this.resolvingAutoplay) return;
    if (this.queue.length >= AUTOPLAY_MIN) return;
    const seed = this.current ?? this.lastTrack;
    if (!seed) return;
    this.resolvingAutoplay = true;
    try {
      const picks = await this.fetchAutoplayTracks(seed, AUTOPLAY_TARGET - this.queue.length);
      if (picks.length) {
        this.q.tracks.push(...picks);
        this.q.persist();
        // If nothing is playing (radio had gone quiet), start it.
        if (this.current === null) void this.playNext();
      }
    } catch (err) {
      console.warn('[music] radio top-up failed:', err instanceof Error ? err.message : err);
    } finally {
      this.resolvingAutoplay = false;
    }
  }

  /** Elapsed playback of the current track in ms. */
  elapsedMs(): number {
    return this.resource?.playbackDuration ?? 0;
  }

  /** Clamp to 0–200%, apply, and return the percent actually set. */
  setVolume(percent: number): number {
    const clamped = Math.min(200, Math.max(0, percent));
    this.volume = clamped / 100;
    this.resource?.volume?.setVolume(this.volume);
    return clamped;
  }

  skip(): void {
    this.skipRequested = true;
    this.player.stop(true);
  }

  shuffle(): void {
    this.q.shuffle();
  }

  removeAt(position: number): Track | null {
    return this.q.removeAt(position);
  }

  move(from: number, to: number): Track | null {
    return this.q.move(from, to);
  }

  clear(): number {
    return this.q.clear();
  }

  pause(): boolean {
    return this.player.pause();
  }

  resume(): boolean {
    return this.player.unpause();
  }

  /** Full stop: wipe queue, current track, and persisted state, then leave. */
  stop(): void {
    this.q.tracks.length = 0;
    this.q.current = null;
    this.q.persist();
    this.destroy();
  }

  destroy(): void {
    clearInterval(this.housekeeper);
    this.q.persist();
    this.killProc();
    this.q.tracks.length = 0;
    this.q.current = null;
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    sessions.delete(this.guildId);
  }

  private killProc(): void {
    if (this.proc && !this.proc.killed) this.proc.kill();
    this.proc = null;
    this.buffer?.destroy();
    this.buffer = null;
    this.resource = null;
  }
}

export function getSession(guildId: string): MusicSession | undefined {
  return sessions.get(guildId);
}

/**
 * Tear down every live session — persists queues, kills yt-dlp children, and
 * leaves voice. Called from the process shutdown handler; without it a restart
 * leaves voice connections dangling until Discord times them out.
 */
export function destroyAllSessions(): void {
  for (const s of [...sessions.values()]) s.destroy();
}

/** Live music metrics for monitoring. Each playing session runs a yt-dlp + ffmpeg pair. */
export function musicStats(): { sessions: number; playing: number; queued: number; ytdlpInFlight: number } {
  let queued = 0;
  let playing = 0;
  for (const s of sessions.values()) {
    queued += s.queue.length;
    if (s.current) playing++;
  }
  return { sessions: sessions.size, playing, queued, ytdlpInFlight };
}

export async function getOrCreateSession(channel: VoiceBasedChannel): Promise<MusicSession> {
  const existing = sessions.get(channel.guild.id);
  if (existing) return existing;

  const me = channel.guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  if (perms && !perms.has('Connect')) {
    throw new Error(`I lack the Connect permission in **${channel.name}**.`);
  }
  if (perms && !perms.has('Speak')) {
    throw new Error(`I lack the Speak permission in **${channel.name}**.`);
  }
  if (
    channel.userLimit > 0 &&
    channel.members.size >= channel.userLimit &&
    perms &&
    !perms.has('MoveMembers')
  ) {
    throw new Error(`**${channel.name}** is full (${channel.userLimit} user limit).`);
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
  });
  connection.on('stateChange', (oldState, newState) => {
    if (oldState.status !== newState.status) console.log(`[voice] ${oldState.status} -> ${newState.status}`);
  });
  connection.on('error', (err) => console.error('[voice] error:', err.message));

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch {
    connection.destroy();
    throw new Error(
      'Voice connection timed out — could not complete the handshake with Discord voice servers.',
    );
  }

  const session = new MusicSession(connection, channel.guild.id, channel.id, channel.client);
  sessions.set(channel.guild.id, session);
  return session;
}

export interface YtEntry {
  id?: string;
  title?: string;
  webpage_url?: string;
  url?: string;
  duration?: number;
}

const PLAYLIST_MAX = 25;

export function entryUrl(entry: YtEntry): string | null {
  // Only accept http(s) URLs from yt-dlp's output — never let a non-URL string
  // (which could be read as a yt-dlp flag) reach the play spawn unvalidated.
  if (entry.webpage_url && isHttpUrl(entry.webpage_url)) return entry.webpage_url;
  if (entry.url && isHttpUrl(entry.url)) return entry.url;
  if (entry.id) return `https://www.youtube.com/watch?v=${entry.id}`;
  return null;
}

/** Resolve a Spotify track link into a YouTube search query via the public oEmbed endpoint. */
async function spotifyToQuery(url: string): Promise<string> {
  const res = await safeFetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error('Could not read that Spotify link.');
  const data = JSON.parse(await cappedText(res, 256 * 1024)) as { title?: string };
  if (!data.title) throw new Error('Could not read that Spotify link.');
  return data.title;
}

interface SpotifyEmbedEntry {
  title?: string;
  subtitle?: string;
  duration?: number; // ms
}

function findTrackList(node: unknown): SpotifyEmbedEntry[] | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findTrackList(n);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.trackList)) return obj.trackList as SpotifyEmbedEntry[];
    for (const v of Object.values(obj)) {
      const found = findTrackList(v);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Spotify playlists/albums without API credentials: the public embed page
 * carries the tracklist as JSON. Each track becomes a lazy `ytsearch1:` query
 * that yt-dlp resolves at play time — no upfront YouTube lookups.
 */
async function spotifyPlaylistTracks(url: string, requestedBy: string): Promise<Track[]> {
  const m = url.match(/open\.spotify\.com\/(playlist|album)\/([A-Za-z0-9]+)/i);
  if (!m) throw new Error('Could not parse that Spotify link.');
  const res = await safeFetch(`https://open.spotify.com/embed/${m[1].toLowerCase()}/${m[2]}`, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Spotify returned HTTP ${res.status}.`);
  const html = await cappedText(res);
  const json = html.match(
    /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/,
  )?.[1];
  if (!json) throw new Error('Could not read the Spotify page — layout may have changed.');

  const entries = findTrackList(JSON.parse(json)) ?? [];
  const tracks = entries.slice(0, PLAYLIST_MAX).flatMap((e) => {
    if (!e.title) return [];
    return [
      {
        title: e.subtitle ? `${e.title} — ${e.subtitle}` : e.title,
        url: `ytsearch1:${e.title} ${e.subtitle ?? ''}`.trim(),
        duration: formatDuration(e.duration ? Math.round(e.duration / 1000) : undefined),
        requestedBy,
      },
    ];
  });
  if (tracks.length === 0) {
    throw new Error('No tracks found — the playlist may be private or region-locked.');
  }
  return tracks;
}

/** Resolve a search query, video URL, playlist/mix URL, or Spotify track link into tracks. */
export async function resolveTracks(query: string, requestedBy: string): Promise<Track[]> {
  let effective = query;
  const q = query.toLowerCase();
  if (q.startsWith('https://open.spotify.com/') || q.startsWith('http://open.spotify.com/')) {
    if (q.includes('/playlist/') || q.includes('/album/')) {
      return spotifyPlaylistTracks(query, requestedBy);
    }
    effective = await spotifyToQuery(query);
  }
  const isUrl = isHttpUrl(effective);
  if (isUrl && !isAllowedMediaUrl(effective)) {
    throw new Error('Only YouTube, Spotify, and SoundCloud links are allowed — or just type a song name.');
  }
  const isPlaylist = isUrl && (effective.includes('?list=') || effective.includes('&list='));
  const raw = await withYtdlpSlot(() =>
    youtubeDl(isUrl ? effective : `ytsearch1:${effective.slice(0, 200)}`, {
      dumpSingleJson: true,
      flatPlaylist: true,
      skipDownload: true,
      quiet: true,
      noWarnings: true,
      ignoreConfig: true,
      ...(isPlaylist ? { yesPlaylist: true, playlistEnd: PLAYLIST_MAX } : { noPlaylist: true }),
    }),
  );
  const info = (typeof raw === 'string' ? JSON.parse(raw) : raw) as YtEntry & {
    _type?: string;
    entries?: YtEntry[];
  };

  const entries =
    info._type === 'playlist' ? (info.entries ?? []).slice(0, isPlaylist ? PLAYLIST_MAX : 1) : [info];

  const tracks = entries.flatMap((entry) => {
    const url = entryUrl(entry);
    if (!url) return [];
    return [
      {
        title: entry.title ?? url,
        url,
        duration: formatDuration(entry.duration),
        requestedBy,
      },
    ];
  });
  if (tracks.length === 0) throw new Error('No results found.');
  return tracks;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return '?';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}
