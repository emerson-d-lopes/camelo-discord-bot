import { type Client, Events, GuildMember, type Message } from 'discord.js';
import { getGuildSettings } from '../../db.js';
import { rateAllow } from '../../security.js';
import { converse, forgetChannel, isClearPhrase } from '../ai/converse.js';
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
 * classification. Music intents play/control; anything else becomes a
 * conversation (per-channel memory), so you can chat and discuss music with the
 * bot, not only issue requests. Clear it with `/forget` or "forget it".
 */

// Discord hard-caps a message at 2000 characters. Leave headroom for safety.
const DISCORD_LIMIT = 1990;
// Never fan out more than this many messages from one answer (spam guard).
const MAX_CHUNKS = 6;

/**
 * Split text into Discord-sized chunks, breaking on paragraph/line/word
 * boundaries where possible so a long answer isn't cut mid-sentence.
 */
export function chunkMessage(text: string, limit = DISCORD_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit && chunks.length < MAX_CHUNKS - 1) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest.slice(0, limit));
  return chunks;
}

/**
 * Reply that never rejects and never pings anyone — track titles are untrusted
 * (a song literally titled `<@id>` would otherwise ping that user), and the
 * music handler has no reason to mention anybody. Long answers are split across
 * multiple messages so nothing is truncated at Discord's 2000-char limit.
 */
async function reply(message: Message, content: string): Promise<void> {
  const chunks = chunkMessage(content);
  try {
    await message.reply({ content: chunks[0], allowedMentions: { parse: [] } });
    for (let i = 1; i < chunks.length; i++) {
      if (!('send' in message.channel)) break;
      await message.channel.send({ content: chunks[i], allowedMentions: { parse: [] } });
    }
  } catch (err) {
    console.warn('[music] reply failed:', err instanceof Error ? err.message : err);
  }
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

/** True if this message is a reply to one of the bot's own messages. */
async function isReplyToBot(client: Client, message: Message): Promise<boolean> {
  if (!message.reference?.messageId) return false;
  try {
    const replied = await message.fetchReference();
    return replied.author.id === client.user?.id;
  } catch {
    return false;
  }
}

async function handle(client: Client, message: Message): Promise<void> {
  if (message.author.bot || !message.guild || !client.user) return;

  const settings = getGuildSettings(message.guild.id);
  const isMusicChannel = settings?.music_channel_id === message.channelId;
  const isChatChannel = settings?.chat_channel_id === message.channelId;
  const tagged = new RegExp(`<@!?${client.user.id}>`).test(message.content);

  // Answer freely in the music/chat channels; elsewhere only when tagged or
  // when the user replies to one of the bot's messages.
  const repliedToBot = isMusicChannel || isChatChannel ? false : await isReplyToBot(client, message);
  if (!tagged && !repliedToBot && !isMusicChannel && !isChatChannel) return;

  // Spam guard: per-user + per-guild ceiling.
  if (
    !rateAllow(`chat:${message.author.id}`, 10, 5) ||
    !rateAllow(`chat-guild:${message.guild.id}`, 30, 15)
  ) {
    return;
  }

  const text = message.content
    .replace(/<@!?\d+>/g, '')
    .trim()
    .slice(0, 500);
  if (!text) {
    if (tagged)
      await reply(message, 'Tag me with a question, a song, or a command like `skip` / `toca raul`.');
    return;
  }

  if (isClearPhrase(text)) {
    forgetChannel(message.channelId);
    await reply(message, '🧹 Okay — I forgot our conversation in this channel.');
    return;
  }

  // Dedicated chat channel = pure conversation (no music intent parsing).
  if (isChatChannel) {
    if ('sendTyping' in message.channel) await message.channel.sendTyping().catch(() => {});
    const name = message.member?.displayName ?? message.author.displayName;
    const answer = await converse(message.channelId, name, text);
    await reply(message, answer ?? 'My brain (Ollama) is offline right now.');
    return;
  }

  // Music channel, a tag, or a reply-to-bot → classify: music action or chat.
  const engaged = tagged || repliedToBot;
  let intent = ruleIntent(text);
  if (!intent) intent = await aiIntent(text);
  if (!intent) intent = engaged ? { action: 'play', query: text } : { action: 'chat' };

  await execute(message, intent, engaged, text);
}

async function execute(message: Message, intent: Intent, tagged: boolean, text: string): Promise<void> {
  if (!message.guild) return;
  const session = getSession(message.guild.id);
  const userId = message.author.id;

  switch (intent.action) {
    case 'chat': {
      // Not a music command → hold an actual conversation, with per-channel memory.
      if ('sendTyping' in message.channel) await message.channel.sendTyping().catch(() => {});
      const name = message.member?.displayName ?? message.author.displayName;
      const answer = await converse(message.channelId, name, text);
      if (answer) await reply(message, answer);
      else if (tagged) await reply(message, 'My brain (Ollama) is offline right now.');
      return;
    }
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
