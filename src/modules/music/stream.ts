import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { type AudioResource, createAudioResource, StreamType } from '@discordjs/voice';
import { youtubeDl } from 'youtube-dl-exec';

// Fail-fast against a latent command-injection primitive in youtube-dl-exec:
// on Windows, when the yt-dlp binary path contains whitespace it forces
// `shell: true`, so cmd.exe metacharacters in a /play value would execute. The
// path is normally space-free (under node_modules), but a install under e.g.
// "C:\Program Files\" or a "C:\Users\First Last\" profile flips it. Refuse to
// start rather than run vulnerable.
const ytdlpBinaryPath: string =
  (createRequire(import.meta.url)('youtube-dl-exec') as { constants?: { YOUTUBE_DL_PATH?: string } })
    .constants?.YOUTUBE_DL_PATH ?? '';
if (process.platform === 'win32' && /\s/.test(ytdlpBinaryPath)) {
  throw new Error(
    `[security] yt-dlp binary path contains whitespace (${ytdlpBinaryPath}). On Windows this makes ` +
      'youtube-dl-exec run in shell mode, exposing /play to OS command injection. Reinstall under a ' +
      'path with no spaces, or set YOUTUBE_DL_DIR to a space-free directory, then restart.',
  );
}

export interface TrackStream {
  proc: ReturnType<typeof youtubeDl.exec>;
  buffer: PassThrough;
  resource: AudioResource;
}

/**
 * Spawn yt-dlp for one track and wire its stdout through a lookahead buffer
 * into a playable audio resource. Returns null when the process comes up
 * without stdout (the caller skips the track). The caller owns the pieces and
 * must kill/destroy them when playback ends.
 */
export function spawnTrackStream(url: string, volume: number): TrackStream | null {
  const proc = youtubeDl.exec(
    url,
    {
      output: '-',
      format: 'bestaudio[acodec=opus]/bestaudio/best',
      quiet: true,
      noPlaylist: true,
      noWarnings: true,
      // Ignore any on-disk yt-dlp config so behaviour can't be altered by a
      // file dropped in the home dir / cwd.
      ignoreConfig: true,
    },
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  proc.catch((err: unknown) => {
    if (proc.killed) return;
    console.error(`[music] yt-dlp failed for ${url}:`, err instanceof Error ? err.message : err);
  });

  if (!proc.stdout) {
    if (!proc.killed) proc.kill();
    return null;
  }
  // Lookahead buffer: without it, backpressure throttles the download to
  // realtime playback speed, so any network jitter immediately starves the
  // encoder and audio stutters. 32MB lets yt-dlp download far ahead.
  const buffer = new PassThrough({ highWaterMark: 1 << 25 });
  proc.stdout.on('error', () => {});
  buffer.on('error', () => {});
  proc.stdout.pipe(buffer);

  const resource = createAudioResource(buffer, {
    inputType: StreamType.Arbitrary,
    inlineVolume: true,
  });
  resource.volume?.setVolume(volume);
  return { proc, buffer, resource };
}
