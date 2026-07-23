import { Client, Events, GuildMember, Message } from 'discord.js';
import { rateAllow } from '../../security.js';
import { getGuildSettings } from '../../db.js';
import { aiIntent, ruleIntent, type Intent } from './intent.js';
import { getOrCreateSession, getSession, resolveTracks, type MusicSession, type Track } from './player.js';
import { recommendTracks } from './recommend.js';

/**
 * Message interface: "@Camelô <anything>" anywhere, or ANY plain message in the
 * guild's designated music channel (/musicchannel set). Natural language works
 * — rule-based synonyms (EN + PT) first, then local Ollama intent
 * classification. Unclassifiable chat in the music channel is ignored.
 */

/** Reply that never rejects — a failed reply (deleted msg, missing perms) must not crash the process. */
function reply(message: Message, content: string): Promise<unknown> {
  return message.reply(content).catch((err) => {
    console.warn('[music] reply failed:', err instanceof Error ? err.message : err);
  });
}

export function startMentionCommands(client: Client): void {
  client.on(Events.MessageCreate, async (message) => {
    try {
      await handle(client, message);
    } catch (err) {
      console.error('[music] mention handler failed:', err);
    }
  });
}

async function handle(client: Client, message: Message): Promise<void> {
  if (message.author.bot || !message.guild || !client.user) return;

  const tagged = new RegExp(`<@!?${client.user.id}>`).test(message.content);
  const isMusicChannel =
    getGuildSettings(message.guild.id)?.music_channel_id === message.channelId;
  if (!tagged && !isMusicChannel) return;

  // Spam guard: 10 actions/min per user, plus a per-guild ceiling.
  if (!rateAllow(`music:${message.author.id}`, 10, 5) || !rateAllow(`music-guild:${message.guild.id}`, 30, 15)) {
    return;
  }

  const text = message.content.replace(/<@!?\d+>/g, '').trim().slice(0, 300);
  if (!text) {
    if (tagged) {
      await reply(message, 
        'Tag me with a song, a link, or plain words like `skip`, `stop the music`, `toca raul`, `volume 50`.',
      );
    }
    return;
  }

  let intent = ruleIntent(text);
  if (!intent) {
    intent = await aiIntent(text);
  }
  if (!intent) {
    // No AI available: tagged messages default to a play request; bare music
    // channel chatter is left alone unless it plausibly names a song.
    intent = tagged ? { action: 'play', query: text } : { action: 'play', query: text };
  }

  await execute(message, intent, tagged);
}

async function execute(message: Message, intent: Intent, tagged: boolean): Promise<void> {
  if (!message.guild) return;
  const session = getSession(message.guild.id);

  switch (intent.action) {
    case 'chat':
      // Not a music request — stay silent unless directly tagged.
      if (tagged) await reply(message, "That doesn't look like a music request — try a song name or `skip`/`stop`.");
      return;
    case 'skip':
      if (!session?.current) return void reply(message,'Nothing is playing.');
      session.skip();
      return void reply(message,'⏭️ Skipped.');
    case 'stop':
      if (!session) return void reply(message,'Not in a voice channel.');
      session.stop();
      return void reply(message,'⏹️ Stopped, cleared the queue, and left.');
    case 'pause':
      if (!session?.pause()) return void reply(message,'Nothing to pause.');
      return void reply(message,'⏸️ Paused.');
    case 'resume':
      if (session?.resume() || session?.resumeIfIdle()) return void reply(message,'▶️ Resumed.');
      return void reply(message,'Nothing to resume.');
    case 'shuffle':
      if (!session || session.queue.length < 2) return void reply(message,'Need at least 2 queued songs.');
      session.shuffle();
      return void reply(message,`🔀 Shuffled ${session.queue.length} songs.`);
    case 'volume_set':
    case 'volume_up':
    case 'volume_down': {
      if (!session) return void reply(message,'Nothing is playing.');
      const current = Math.round(session.volume * 100);
      const target =
        intent.action === 'volume_set'
          ? intent.volume
          : intent.action === 'volume_up'
            ? Math.min(200, current + 25)
            : Math.max(0, current - 25);
      session.setVolume(target);
      return void reply(message,`🔊 Volume: ${Math.min(200, Math.max(0, target))}%`);
    }
    case 'queue':
    case 'nowplaying': {
      if (!session?.current) return void reply(message,'Queue is empty.');
      const lines = [
        `**Now playing:** ${session.current.title}`,
        ...session.queue.slice(0, 5).map((t, i) => `${i + 1}. ${t.title}`),
      ];
      if (session.queue.length > 5) lines.push(`…and ${session.queue.length - 5} more`);
      return void reply(message,lines.join('\n'));
    }
    case 'play':
      return playRequest(message, intent.query);
    case 'recommend':
      return recommendRequest(message, intent.query);
  }
}

async function recommendRequest(message: Message, mood: string): Promise<void> {
  if (!message.guild) return;
  const channel = message.member instanceof GuildMember ? message.member.voice.channel : null;
  if (!channel) {
    await reply(message, 'Join a voice channel first.');
    return;
  }
  if ('sendTyping' in message.channel) await message.channel.sendTyping().catch(() => {});

  const session = getSession(message.guild.id);
  const rec = await recommendTracks({
    guildId: message.guild.id,
    userId: message.author.id,
    userName: message.member?.displayName ?? message.author.displayName,
    mood,
    currentTitle: session?.current?.title,
  });
  if (!rec) {
    await reply(message, 'Could not come up with recommendations — is the Ollama server running?');
    return;
  }
  if (rec.tracks.length === 0) {
    await reply(message, rec.reason === 'BUSY' ? 'DJ is busy right now — try again in a few seconds.' : 'Could not think of anything — try naming a mood.');
    return;
  }

  let playSession: MusicSession;
  try {
    playSession = await getOrCreateSession(channel);
  } catch (err) {
    await reply(message, `❌ ${err instanceof Error ? err.message : 'Could not join voice.'}`);
    return;
  }
  for (const track of rec.tracks) playSession.enqueue(track);

  const list = rec.tracks.map((t: Track, i: number) => `${i + 1}. ${t.title}`).join('\n');
  await reply(message, `🎧 ${rec.reason}\n${list}`);
}

async function playRequest(message: Message, query: string): Promise<void> {
  const channel = message.member instanceof GuildMember ? message.member.voice.channel : null;
  if (!channel) {
    await reply(message, 'Join a voice channel first.');
    return;
  }

  if ('sendTyping' in message.channel) await message.channel.sendTyping().catch(() => {});
  let tracks;
  try {
    tracks = await resolveTracks(query, message.author.id);
  } catch (err) {
    await reply(message, `Could not find anything for that. ${err instanceof Error ? err.message : ''}`);
    return;
  }

  let playSession: MusicSession;
  try {
    playSession = await getOrCreateSession(channel);
  } catch (err) {
    await reply(message, `❌ ${err instanceof Error ? err.message : 'Could not join voice.'}`);
    return;
  }
  const wasIdle = playSession.current === null;
  for (const track of tracks) playSession.enqueue(track);

  const first = tracks[0];
  if (tracks.length > 1) {
    await reply(message, `➕ Queued **${tracks.length}** tracks — first: **${first.title}**`);
  } else {
    await reply(message, 
      wasIdle
        ? `▶️ Now playing: **${first.title}** (${first.duration})`
        : `➕ Queued: **${first.title}** — position ${playSession.queue.length}`,
    );
  }
}
