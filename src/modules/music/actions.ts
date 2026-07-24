import { EmbedBuilder, type VoiceBasedChannel } from 'discord.js';
import { mdLinkText } from '../../interactions.js';
import { getOrCreateSession, type MusicSession, resolveTracks } from './player.js';

/**
 * Music actions shared by the slash commands and the natural-language message
 * handler, so the two entry points can't drift. Each returns a plain result;
 * the caller renders it (interaction reply vs message reply). `ephemeral` is a
 * hint the slash side honours and the message side ignores.
 */
export interface ActionReply {
  text: string;
  ephemeral?: boolean;
}

const NOT_PLAYING: ActionReply = { text: 'Nothing is playing.', ephemeral: true };

export function skipAction(
  session: MusicSession | undefined,
  userId: string,
  listeners: number,
): ActionReply {
  if (!session?.current) return NOT_PLAYING;
  const track = session.current;
  // The requester, or any member of a 1–2 person channel, skips instantly.
  if (track.requestedBy === userId || listeners <= 2) {
    session.skip();
    return { text: `⏭️ Skipped **${track.title}**.` };
  }
  session.skipVotes.add(userId);
  const needed = Math.ceil(listeners / 2);
  if (session.skipVotes.size >= needed) {
    session.skip();
    return { text: `⏭️ Vote passed (${session.skipVotes.size}/${needed}) — skipped **${track.title}**.` };
  }
  return { text: `🗳️ Skip vote: **${session.skipVotes.size}/${needed}** for **${track.title}**.` };
}

export function stopAction(session: MusicSession | undefined): ActionReply {
  if (!session) return { text: 'Not in a voice channel.', ephemeral: true };
  session.stop();
  return { text: '⏹️ Stopped, cleared the queue, and left the channel.' };
}

export function pauseAction(session: MusicSession | undefined): ActionReply {
  if (!session?.current || !session.pause()) return { text: 'Nothing to pause.', ephemeral: true };
  return { text: '⏸️ Paused.' };
}

export function resumeAction(session: MusicSession | undefined): ActionReply {
  if (session?.resume()) return { text: '▶️ Resumed.' };
  if (session?.resumeIfIdle()) return { text: '▶️ Resuming the restored queue.' };
  return { text: 'Nothing to resume.', ephemeral: true };
}

export function shuffleAction(session: MusicSession | undefined): ActionReply {
  if (!session || session.queue.length < 2) {
    return { text: 'Need at least 2 queued songs to shuffle.', ephemeral: true };
  }
  session.shuffle();
  return { text: `🔀 Shuffled ${session.queue.length} songs.` };
}

export function volumeAction(session: MusicSession | undefined, target: number): ActionReply {
  if (!session) return NOT_PLAYING;
  session.setVolume(target);
  return { text: `🔊 Volume: ${Math.min(200, Math.max(0, target))}%` };
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function nowPlayingEmbed(session: MusicSession | undefined): EmbedBuilder | null {
  if (!session?.current) return null;
  const t = session.current;
  return new EmbedBuilder()
    .setTitle('🎵 Now playing')
    .setDescription(t.url.startsWith('http') ? `**[${mdLinkText(t.title)}](${t.url})**` : `**${t.title}**`)
    .addFields(
      { name: 'Elapsed', value: `${formatMs(session.elapsedMs())} / ${t.duration}`, inline: true },
      { name: 'Requested by', value: `<@${t.requestedBy}>`, inline: true },
      {
        name: 'Mode',
        value: `loop: ${session.loopMode} · autoplay: ${session.autoplay ? 'on' : 'off'} · vol: ${Math.round(session.volume * 100)}%`,
        inline: true,
      },
    );
}

export function queueEmbed(session: MusicSession | undefined, limit = 10): EmbedBuilder | null {
  if (!session || (!session.current && session.queue.length === 0)) return null;
  const lines = [
    session.current
      ? `**Now playing:** ${session.current.title} (${session.current.duration})`
      : '**Nothing playing** — `/resume` to start the restored queue.',
    ...session.queue.slice(0, limit).map((t, i) => `${i + 1}. ${t.title} (${t.duration})`),
  ];
  if (session.queue.length > limit) lines.push(`…and ${session.queue.length - limit} more`);
  return new EmbedBuilder().setTitle('🎵 Queue').setDescription(lines.join('\n'));
}

/**
 * Resolve a query, join the caller's channel, and enqueue. Returns the reply
 * text or an error string — never throws. `channel` is the caller's current
 * voice channel (null → not in voice).
 */
export async function playAction(
  channel: VoiceBasedChannel | null,
  query: string,
  userId: string,
): Promise<ActionReply> {
  if (!channel) return { text: 'Join a voice channel first.', ephemeral: true };

  let tracks;
  try {
    tracks = await resolveTracks(query, userId);
  } catch (err) {
    return {
      text: `Could not find anything for that. ${err instanceof Error ? err.message : ''}`,
      ephemeral: true,
    };
  }

  let session: MusicSession;
  try {
    session = await getOrCreateSession(channel);
  } catch (err) {
    return { text: `❌ ${err instanceof Error ? err.message : 'Could not join voice.'}`, ephemeral: true };
  }

  const restoredCount = session.queue.length;
  const wasIdle = session.current === null;
  for (const track of tracks) session.enqueue(track);

  const first = tracks[0];
  const restoredNote =
    wasIdle && restoredCount > 0 ? ` (restored ${restoredCount} queued from last run)` : '';
  if (tracks.length > 1) {
    return {
      text: `➕ Queued **${tracks.length}** tracks from playlist/mix — ${
        wasIdle ? 'starting with' : 'first up'
      }: **${first.title}** (${first.duration})${restoredNote}`,
    };
  }
  // Single track + radio: the queue auto-fills with similar songs.
  const radioNote = session.autoplay ? ' · 🔀 radio on — I’ll keep similar songs coming' : '';
  return {
    text: wasIdle
      ? `▶️ Now playing: **${first.title}** (${first.duration})${restoredNote}${radioNote}`
      : `➕ Queued: **${first.title}** (${first.duration}) — position ${session.queue.length}`,
  };
}
