import {
  ChannelType,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { Command } from '../../commands.js';
import { setMusicChannel } from '../../db.js';
import { ephemeral } from '../../interactions.js';
import { cappedText, safeFetch } from '../../security.js';
import {
  type ActionReply,
  listenersIn,
  nowPlayingEmbed,
  pauseAction,
  playAction,
  queueEmbed,
  resumeAction,
  resumeOrRestoreAction,
  shuffleAction,
  skipAction,
  stopAction,
  voiceChannelOf,
  volumeAction,
} from './actions.js';
import { getSession, type LoopMode } from './player.js';

function memberVoiceChannel(interaction: ChatInputCommandInteraction) {
  return voiceChannelOf(interaction.member);
}

function sessionFor(interaction: ChatInputCommandInteraction) {
  return interaction.guildId ? getSession(interaction.guildId) : undefined;
}

/** Render an ActionReply as an interaction reply (ephemeral hint honoured, never pings). */
function send(interaction: ChatInputCommandInteraction, r: ActionReply): Promise<unknown> {
  return interaction.reply({
    content: r.text,
    allowedMentions: { parse: [] },
    ...(r.ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  });
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
      await ephemeral(interaction, 'Join a voice channel first.');
      return;
    }
    await interaction.deferReply();
    const result = await playAction(
      channel,
      interaction.options.getString('query', true),
      interaction.user.id,
    );
    await interaction.editReply({ content: result.text, allowedMentions: { parse: [] } });
  },
};

const nowplaying: Command = {
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current song'),
  async execute(interaction) {
    const embed = nowPlayingEmbed(sessionFor(interaction));
    if (!embed) {
      await ephemeral(interaction, 'Nothing is playing.');
      return;
    }
    await interaction.reply({ embeds: [embed] });
  },
};

const skip: Command = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Vote to skip the current song (requester skips instantly)'),
  async execute(interaction) {
    const listeners = listenersIn(memberVoiceChannel(interaction));
    await send(interaction, skipAction(sessionFor(interaction), interaction.user.id, listeners));
  },
};

const pause: Command = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  async execute(interaction) {
    await send(interaction, pauseAction(sessionFor(interaction)));
  },
};

const resume: Command = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  async execute(interaction) {
    const session = sessionFor(interaction);
    if (session) {
      await send(interaction, resumeAction(session));
      return;
    }
    // After a restart no session exists — join the caller's channel, which
    // also restores the persisted queue.
    const channel = memberVoiceChannel(interaction);
    if (!channel) {
      await ephemeral(interaction, 'Nothing to resume.');
      return;
    }
    await interaction.deferReply();
    const result = await resumeOrRestoreAction(undefined, channel);
    await interaction.editReply({ content: result.text, allowedMentions: { parse: [] } });
  },
};

const stop: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback, clear the queue, and leave the voice channel'),
  async execute(interaction) {
    await send(interaction, stopAction(sessionFor(interaction)));
  },
};

const queue: Command = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
  async execute(interaction) {
    const embed = queueEmbed(sessionFor(interaction));
    if (!embed) {
      await ephemeral(interaction, 'Queue is empty.');
      return;
    }
    await interaction.reply({ embeds: [embed] });
  },
};

const shuffle: Command = {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue'),
  async execute(interaction) {
    await send(interaction, shuffleAction(sessionFor(interaction)));
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
    const session = sessionFor(interaction);
    if (!session) {
      await ephemeral(interaction, 'Nothing is playing.');
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
    const session = sessionFor(interaction);
    if (!session) {
      await ephemeral(interaction, 'Nothing is playing.');
      return;
    }
    session.autoplay = interaction.options.getString('mode', true) === 'on';
    await interaction.reply(
      session.autoplay ? '♾️ Autoplay on — related tracks when queue empties.' : 'Autoplay off.',
    );
  },
};

const volume: Command = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set playback volume')
    .addIntegerOption((o) =>
      o
        .setName('percent')
        .setDescription('0-200 (100 = normal)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(200),
    ),
  async execute(interaction) {
    await send(
      interaction,
      volumeAction(sessionFor(interaction), interaction.options.getInteger('percent', true)),
    );
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
    const pos = interaction.options.getInteger('position', true);
    const removed = sessionFor(interaction)?.removeAt(pos);
    if (!removed) {
      await ephemeral(interaction, `No song at position ${pos}.`);
      return;
    }
    await interaction.reply({
      content: `🗑️ Removed **${removed.title}** from the queue.`,
      allowedMentions: { parse: [] },
    });
  },
};

const move: Command = {
  data: new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move a song to another position in the queue')
    .addIntegerOption((o) =>
      o.setName('from').setDescription('Current position').setRequired(true).setMinValue(1),
    )
    .addIntegerOption((o) => o.setName('to').setDescription('New position').setRequired(true).setMinValue(1)),
  async execute(interaction) {
    const to = interaction.options.getInteger('to', true);
    const moved = sessionFor(interaction)?.move(interaction.options.getInteger('from', true), to);
    if (!moved) {
      await ephemeral(interaction, 'Invalid positions.');
      return;
    }
    await interaction.reply({
      content: `↕️ Moved **${moved.title}** to position ${to}.`,
      allowedMentions: { parse: [] },
    });
  },
};

const clear: Command = {
  data: new SlashCommandBuilder().setName('clear').setDescription('Clear the queue (keeps current song)'),
  async execute(interaction) {
    const session = sessionFor(interaction);
    if (!session || session.queue.length === 0) {
      await ephemeral(interaction, 'Queue is already empty.');
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
    const session = sessionFor(interaction);
    const query = interaction.options.getString('song') ?? session?.current?.title;
    if (!query) {
      await ephemeral(interaction, 'Nothing playing — pass the `song` option.');
      return;
    }
    await interaction.deferReply();

    // Strip common YouTube title noise before searching.
    const cleaned = query
      .replace(/\(.*?(official|video|audio|remaster|lyric|hd|4k).*?\)/gi, '')
      .replace(/\[.*?\]/g, '')
      .trim();
    try {
      const res = await safeFetch(`https://lrclib.net/api/search?q=${encodeURIComponent(cleaned)}`, {
        headers: { 'user-agent': 'camelo-discord-bot' },
        signal: AbortSignal.timeout(10_000),
      });
      const results = JSON.parse(await cappedText(res)) as LrcResult[];
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
          o
            .setName('channel')
            .setDescription('The music channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('off').setDescription('Disable the music channel')),
  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'Server-only command.', flags: MessageFlags.Ephemeral });
      return;
    }
    // Defense in depth: setDefaultMemberPermissions is a client-side default an
    // admin can override per guild, so re-check server-side.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: 'You need the Manage Server permission to do that.',
        flags: MessageFlags.Ephemeral,
      });
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
  play,
  nowplaying,
  skip,
  pause,
  resume,
  stop,
  queue,
  shuffle,
  loop,
  autoplay,
  volume,
  remove,
  move,
  clear,
  lyrics,
  musicchannel,
];
