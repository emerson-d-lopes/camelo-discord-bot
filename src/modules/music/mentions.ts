import { type Client, Events, GuildMember, type Message } from 'discord.js';
import { getGuildSettings } from '../../db.js';
import { rateAllow } from '../../security.js';
import {
  pauseAction,
  playAction,
  queueEmbed,
  resumeAction,
  shuffleAction,
  skipAction,
  stopAction,
  volumeAction,
} from './actions.js';
import { aiIntent, type Intent, ruleIntent } from './intent.js';
import { getOrCreateSession, getSession, type MusicSession } from './player.js';
import { recommendTracks } from './recommend.js';

/**
 * Message interface: "@Camelô <anything>" anywhere, or ANY plain message in the
 * guild's designated music channel (/musicchannel set). Natural language works
 * — rule-based synonyms (EN + PT) first, then local Ollama intent
 * classification. Unclassifiable chat in the music channel is ignored.
 */

/**
 * Reply that never rejects and never pings anyone — track titles are untrusted
 * (a song literally titled `<@id>` would otherwise ping that user), and the
 * music handler has no reason to mention anybody.
 */
function reply(message: Message, content: string): Promise<unknown> {
  return message.reply({ content, allowedMentions: { parse: [] } }).catch((err) => {
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
  const isMusicChannel = getGuildSettings(message.guild.id)?.music_channel_id === message.channelId;
  if (!tagged && !isMusicChannel) return;

  // Spam guard: 10 actions/min per user, plus a per-guild ceiling.
  if (
    !rateAllow(`music:${message.author.id}`, 10, 5) ||
    !rateAllow(`music-guild:${message.guild.id}`, 30, 15)
  ) {
    return;
  }

  const text = message.content
    .replace(/<@!?\d+>/g, '')
    .trim()
    .slice(0, 300);
  if (!text) {
    if (tagged) {
      await reply(
        message,
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
    // No classifier available: a direct tag is a play request; unclassifiable
    // chatter in the music channel is left alone rather than fed to yt-dlp.
    intent = tagged ? { action: 'play', query: text } : { action: 'chat' };
  }

  await execute(message, intent, tagged);
}

async function execute(message: Message, intent: Intent, tagged: boolean): Promise<void> {
  if (!message.guild) return;
  const session = getSession(message.guild.id);
  const userId = message.author.id;

  switch (intent.action) {
    case 'chat':
      // Not a music request — stay silent unless directly tagged.
      if (tagged)
        await reply(message, "That doesn't look like a music request — try a song name or `skip`/`stop`.");
      return;
    case 'skip': {
      const channel = message.member instanceof GuildMember ? message.member.voice.channel : null;
      const listeners = channel ? channel.members.filter((m) => !m.user.bot).size : 1;
      return void reply(message, skipAction(session, userId, listeners).text);
    }
    case 'stop':
      return void reply(message, stopAction(session).text);
    case 'pause':
      return void reply(message, pauseAction(session).text);
    case 'resume':
      return void reply(message, resumeAction(session).text);
    case 'shuffle':
      return void reply(message, shuffleAction(session).text);
    case 'volume_set':
    case 'volume_up':
    case 'volume_down': {
      if (!session) return void reply(message, 'Nothing is playing.');
      const current = Math.round(session.volume * 100);
      const target =
        intent.action === 'volume_set'
          ? intent.volume
          : intent.action === 'volume_up'
            ? current + 25
            : current - 25;
      return void reply(message, volumeAction(session, target).text);
    }
    case 'queue':
    case 'nowplaying': {
      const embed = queueEmbed(session, 5);
      if (!embed) return void reply(message, 'Queue is empty.');
      return void message.reply({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
    }
    case 'play': {
      const channel = message.member instanceof GuildMember ? message.member.voice.channel : null;
      if ('sendTyping' in message.channel) await message.channel.sendTyping().catch(() => {});
      return void reply(message, (await playAction(channel, intent.query, userId)).text);
    }
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
    await reply(
      message,
      rec.reason === 'BUSY'
        ? 'DJ is busy right now — try again in a few seconds.'
        : 'Could not think of anything — try naming a mood.',
    );
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

  const list = rec.tracks.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
  await reply(message, `🎧 ${rec.reason}\n${list}`);
}
