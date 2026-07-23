import {
  ChannelType,
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { Command } from '../../commands.js';
import { setMusicChannel } from '../../db.js';
import { getOrCreateSession, getSession, resolveTracks, type LoopMode } from './player.js';

function memberVoiceChannel(interaction: Parameters<Command['execute']>[0]) {
  const member = interaction.member;
  if (member instanceof GuildMember) return member.voice.channel;
  return null;
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

const play: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play from YouTube (URL, playlist/mix, search) or a Spotify track link')
    .addStringOption((o) =>
      o.setName('query').setDescription('URL, Spotify track link, or search terms').setRequired(true),
    ),
  async execute(interaction) {
    const channel = memberVoiceChannel(interaction);
    if (!channel) {
      await interaction.reply({
        content: 'Join a voice channel first.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();
    const query = interaction.options.getString('query', true);

    let tracks;
    try {
      tracks = await resolveTracks(query, interaction.user.id);
    } catch (err) {
      await interaction.editReply(
        `Could not find anything for that. ${err instanceof Error ? err.message : ''}`,
      );
      return;
    }

    let session;
    try {
      session = await getOrCreateSession(channel);
    } catch (err) {
      await interaction.editReply(`❌ ${err instanceof Error ? err.message : 'Could not join voice.'}`);
      return;
    }
    const restoredCount = session.queue.length;
    const wasIdle = session.current === null;
    for (const track of tracks) session.enqueue(track);

    const first = tracks[0];
    const restoredNote =
      wasIdle && restoredCount > 0 ? ` (restored ${restoredCount} queued from last run)` : '';
    // parse:[] — an untrusted track title must never resolve into a ping.
    const noPing = { allowedMentions: { parse: [] as const } };
    if (tracks.length > 1) {
      await interaction.editReply({
        content: `➕ Queued **${tracks.length}** tracks from playlist/mix — ${
          wasIdle ? 'starting with' : 'first up'
        }: **${first.title}** (${first.duration})${restoredNote}`,
        ...noPing,
      });
    } else {
      await interaction.editReply({
        content: wasIdle
          ? `▶️ Now playing: **${first.title}** (${first.duration})${restoredNote}`
          : `➕ Queued: **${first.title}** (${first.duration}) — position ${session.queue.length}`,
        ...noPing,
      });
    }
  },
};

const nowplaying: Command = {
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current song'),
  async execute(interaction) {
    const session = interaction.guildId ? getSession(interaction.guildId) : undefined;
    if (!session?.current) {
      await interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
      return;
    }
    const t = session.current;
    const embed = new EmbedBuilder()
      .setTitle('🎵 Now playing')
      .setDescription(t.url.startsWith('http') ? `**[${t.title}](${t.url})**` : `**${t.title}**`)
      .addFields(
        { name: 'Elapsed', value: `${formatMs(session.elapsedMs())} / ${t.duration}`, inline: true },
        { name: 'Requested by', value: `<@${t.requestedBy}>`, inline: true },
        {
          name: 'Mode',
          value: `loop: ${session.loopMode} · autoplay: ${session.autoplay ? 'on' : 'off'} · vol: ${Math.round(session.volume * 100)}%`,
          inline: true,
        },
      );
    await interaction.reply({ embeds: [embed] });
  },
};

const skip: Command = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Vote to skip the current song (requester skips instantly)'),
  async execute(interaction) {
    const session = interaction.guildId ? getSession(interaction.guildId) : undefined;
    if (!session?.current) {
      await interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
      return;
    }
    const track = session.current;
    const channel = memberVoiceChannel(interaction);
    const listeners = channel ? channel.members.filter((m) => !m.user.bot).size : 1;

    if (track.requestedBy === interaction.user.id || listeners <= 2) {
      session.skip();
      await interaction.reply(`⏭️ Skipped **${track.title}**.`);
      return;
    }

    session.skipVotes.add(interaction.user.id);
    const needed = Math.ceil(listeners / 2);
    if (session.skipVotes.size >= needed) {
      session.skip();
      await interaction.reply(`⏭️ Vote passed (${session.skipVotes.size}/${needed}) — skipped **${track.title}**.`);
    } else {
      await interaction.reply(
        `🗳️ Skip vote: **${session.skipVotes.size}/${needed}** for **${track.title}**.`,
      );
    }
  },
};

const pause: Command = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  async execute(interaction) {
    const session = interaction.guildId ? getSession(interaction.guildId) : undefined;
    if (!session?.current || !session.pause()) {
      await interaction.reply({ content: 'Nothing to pause.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply('⏸️ Paused.');
  },
};

const resume: Command = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  async execute(interaction) {
    let session = interaction.guildId ? getSession(interaction.guildId) : undefined;
    if (!session) {
      // After a restart no session exists yet — join the caller's channel,
      // which also restores the persisted queue.
      const channel = memberVoiceChannel(interaction);
      if (!channel) {
        await interaction.reply({ content: 'Nothing to resume.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply();
      try {
        session = await getOrCreateSession(channel);
      } catch (err) {
        await interaction.editReply(`❌ ${err instanceof Error ? err.message : 'Could not join voice.'}`);
        return;
      }
      if (session.resumeIfIdle()) {
        await interaction.editReply('▶️ Resuming the restored queue.');
      } else {
        await interaction.editReply('Nothing to resume — queue is empty.');
      }
      return;
    }
    if (session.resume()) {
      await interaction.reply('▶️ Resumed.');
      return;
    }
    // Also resumes a queue restored from a previous run.
    if (session.resumeIfIdle()) {
      await interaction.reply('▶️ Resuming the restored queue.');
      return;
    }
    await interaction.reply({ content: 'Nothing to resume.', flags: MessageFlags.Ephemeral });
  },
};

const stop: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback, clear the queue, and leave the voice channel'),
  async execute(interaction) {
    const session = interaction.guildId ? getSession(interaction.guildId) : undefined;
    if (!session) {
      await interaction.reply({ content: 'Not in a voice channel.', flags: MessageFlags.Ephemeral });
      return;
    }
    session.stop();
    await interaction.reply('⏹️ Stopped, cleared the queue, and left the channel.');
  },
};

const queue: Command = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
  async execute(interaction) {
    const session = interaction.guildId ? getSession(interaction.guildId) : undefined;
    if (!session || (!session.current && session.queue.length === 0)) {
      await interaction.reply({ content: 'Queue is empty.', flags: MessageFlags.Ephemeral });
      return;
    }
    const lines = [
      session.current
        ? `**Now playing:** ${session.current.title} (${session.current.duration})`
        : '**Nothing playing** — `/resume` to start the restored queue.',
      ...session.queue.slice(0, 10).map((t, i) => `${i + 1}. ${t.title} (${t.duration})`),
    ];
    if (session.queue.length > 10) lines.push(`…and ${session.queue.length - 10} more`);

    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle('🎵 Queue').setDescription(lines.join('\n'))],
    });
  },
};

const shuffle: Command = {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue'),
  async execute(interaction) {
    const session = interaction.guildId ? getSession(interaction.guildId) : undefined;
    if (!session || session.queue.length < 2) {
      await interaction.reply({
        content: 'Need at least 2 queued songs to shuffle.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    session.shuffle();
    await interaction.reply(`🔀 Shuffled ${session.queue.length} songs.`);
  },
};

const loop: Command = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set loop mode')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('What to loop')
        .setRequired(true)
        .addChoices(
          { name: 'off', value: 'off' },
          { name: 'track — repeat current song', value: 'track' },
          { name: 'queue — cycle the whole queue', value: 'queue' },
        ),
    ),
  async execute(interaction) {
    const session = interaction.guildId ? getSession(interaction.guildId) : undefined;
    if (!session) {
      await interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
      return;
    }
    const mode = interaction.options.getString('mode', true) as LoopMode;
    session.loopMode = mode;
    const labels = { off: '➡️ Loop off.', track: '🔂 Looping current track.', queue: '🔁 Looping queue.' };
    await interaction.reply(labels[mode]);
  },
};

const autoplay: Command = {
  data: new SlashCommandBuilder()
    .setName('autoplay')
    .setDescription('When the queue runs dry, keep going with related tracks')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('on or off')
        .setRequired(true)
        .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
    ),
  async execute(interaction) {
    const session = interaction.guildId ? getSession(interaction.guildId) : undefined;
    if (!session) {
      await interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
      return;
    }
    session.autoplay = interaction.options.getString('mode', true) === 'on';
    await interaction.reply(session.autoplay ? '♾️ Autoplay on — related tracks when queue empties.' : 'Autoplay off.');
  },
};

const volume: Command = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set playback volume')
    .addIntegerOption((o) =>
      o.setName('percent').setDescription('0-200 (100 = normal)').setRequired(true).setMinValue(0).setMaxValue(200),
    ),
  async execute(interaction) {
    const session = interaction.guildId ? getSession(interaction.guildId) : undefined;
    if (!session) {
      await interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
      return;
    }
    const pct = interaction.options.getInteger('percent', true);
    session.setVolume(pct);
    await interaction.reply(`🔊 Volume: ${pct}%`);
  },
};

const remove: Command = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a song from the queue')
    .addIntegerOption((o) =>
      o.setName('position').setDescription('Queue position (see /queue)').setRequired(true).setMinValue(1),
    ),
  async execute(interaction) {
    const session = interaction.guildId ? getSession(interaction.guildId) : undefined;
    const pos = interaction.options.getInteger('position', true);
    const removed = session?.removeAt(pos);
    if (!removed) {
      await interaction.reply({ content: `No song at position ${pos}.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply(`🗑️ Removed **${removed.title}** from the queue.`);
  },
};

const move: Command = {
  data: new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move a song to another position in the queue')
    .addIntegerOption((o) => o.setName('from').setDescription('Current position').setRequired(true).setMinValue(1))
    .addIntegerOption((o) => o.setName('to').setDescription('New position').setRequired(true).setMinValue(1)),
  async execute(interaction) {
    const session = interaction.guildId ? getSession(interaction.guildId) : undefined;
    const from = interaction.options.getInteger('from', true);
    const to = interaction.options.getInteger('to', true);
    const moved = session?.move(from, to);
    if (!moved) {
      await interaction.reply({ content: 'Invalid positions.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply(`↕️ Moved **${moved.title}** to position ${to}.`);
  },
};

const clear: Command = {
  data: new SlashCommandBuilder().setName('clear').setDescription('Clear the queue (keeps current song)'),
  async execute(interaction) {
    const session = interaction.guildId ? getSession(interaction.guildId) : undefined;
    if (!session || session.queue.length === 0) {
      await interaction.reply({ content: 'Queue is already empty.', flags: MessageFlags.Ephemeral });
      return;
    }
    const n = session.clear();
    await interaction.reply(`🧹 Cleared ${n} songs from the queue.`);
  },
};

interface LrcResult {
  trackName?: string;
  artistName?: string;
  plainLyrics?: string | null;
}

const lyrics: Command = {
  data: new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Lyrics for the current song (or a search)')
    .addStringOption((o) => o.setName('song').setDescription('Song to search (default: now playing)')),
  async execute(interaction) {
    const session = interaction.guildId ? getSession(interaction.guildId) : undefined;
    const query = interaction.options.getString('song') ?? session?.current?.title;
    if (!query) {
      await interaction.reply({
        content: 'Nothing playing — pass the `song` option.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply();

    // Strip common YouTube title noise before searching.
    const cleaned = query
      .replace(/\(.*?(official|video|audio|remaster|lyric|hd|4k).*?\)/gi, '')
      .replace(/\[.*?\]/g, '')
      .trim();
    try {
      const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(cleaned)}`, {
        headers: { 'user-agent': 'camelo-discord-bot' },
        signal: AbortSignal.timeout(10_000),
      });
      const results = (await res.json()) as LrcResult[];
      const hit = results.find((r) => r.plainLyrics);
      if (!hit?.plainLyrics) {
        await interaction.editReply(`No lyrics found for "${cleaned}".`);
        return;
      }
      const text = hit.plainLyrics.length > 3900 ? `${hit.plainLyrics.slice(0, 3900)}…` : hit.plainLyrics;
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`🎤 ${hit.trackName ?? cleaned}${hit.artistName ? ` — ${hit.artistName}` : ''}`)
            .setDescription(text)
            .setFooter({ text: 'lyrics: lrclib.net' }),
        ],
      });
    } catch {
      await interaction.editReply('Lyrics service unavailable right now.');
    }
  },
};

const musicchannel: Command = {
  data: new SlashCommandBuilder()
    .setName('musicchannel')
    .setDescription('Designate a channel where every message is a music request (needs Manage Server)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Enable for a channel')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('The music channel').addChannelTypes(ChannelType.GuildText).setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('off').setDescription('Disable the music channel')),
  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'Server-only command.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.options.getSubcommand() === 'off') {
      setMusicChannel(interaction.guildId, null);
      await interaction.reply({ content: 'Music channel disabled.', flags: MessageFlags.Ephemeral });
      return;
    }
    const channel = interaction.options.getChannel('channel', true);
    setMusicChannel(interaction.guildId, channel.id);
    await interaction.reply(
      `🎶 <#${channel.id}> is now the music channel — any message there plays or controls music (no tag needed).`,
    );
  },
};

export const musicCommands: Command[] = [
  play, nowplaying, skip, pause, resume, stop, queue,
  shuffle, loop, autoplay, volume, remove, move, clear, lyrics, musicchannel,
];
