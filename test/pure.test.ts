import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db, type Watch } from '../src/db.js';
import { isClearPhrase } from '../src/modules/ai/converse.js';
import { parseDiceSpec } from '../src/modules/fun/index.js';
import { skipAction } from '../src/modules/music/actions.js';
import { ruleIntent } from '../src/modules/music/intent.js';
import { chunkMessage } from '../src/modules/music/mentions.js';
import { formatDuration, type MusicSession } from '../src/modules/music/player.js';
import { type Track, TrackQueue } from '../src/modules/music/queue.js';
import { parseDuration } from '../src/modules/reminders/index.js';
import { humanDuration, type MetricsSnapshot, prometheusText } from '../src/modules/stats/index.js';
import { sparkline } from '../src/modules/watcher/commands.js';
import { findJsonLdPrice, parsePriceText } from '../src/modules/watcher/scraper.js';
import { fmt, isDue } from '../src/modules/watcher/watcher.js';

test('parsePriceText — separator disambiguation', () => {
  const cases: [string, number | null][] = [
    ['R$ 1.234,56', 1234.56], // pt-BR: dot thousands, comma decimal
    ['$1,234.56', 1234.56], // en: comma thousands, dot decimal
    ['€99', 99],
    ['12,34', 12.34], // bare comma decimal
    ['1234.5', 1234.5],
    ['Price: 2.999,00', 2999],
    ['1,234', 1234], // comma thousands, no decimal
    ['US$ 49.90', 49.9],
    ['nonsense', null],
    ['', null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parsePriceText(input), expected, input);
  }
});

test('parseDuration — durations to ms', () => {
  assert.equal(parseDuration('45m'), 45 * 60_000);
  assert.equal(parseDuration('2h30m'), (2 * 60 + 30) * 60_000);
  assert.equal(parseDuration('1d'), 86_400_000);
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('10'), 10 * 60_000); // bare number = minutes
  assert.equal(parseDuration('nope'), null);
  assert.equal(parseDuration('0'), null);
});

test('ruleIntent — control synonyms (EN + PT)', () => {
  assert.deepEqual(ruleIntent('skip'), { action: 'skip' });
  assert.deepEqual(ruleIntent('pula'), { action: 'skip' });
  assert.deepEqual(ruleIntent('para'), { action: 'stop' });
  assert.deepEqual(ruleIntent('pausa'), { action: 'pause' });
  assert.deepEqual(ruleIntent('volume 60'), { action: 'volume_set', volume: 60 });
  assert.deepEqual(ruleIntent('põe no 80'), { action: 'volume_set', volume: 80 });
  assert.deepEqual(ruleIntent('abaixa um pouco'), { action: 'volume_down' });
});

test('ruleIntent — play vs recommend vs unknown', () => {
  assert.deepEqual(ruleIntent('toca linkin park'), { action: 'play', query: 'linkin park' });
  assert.deepEqual(ruleIntent('https://youtu.be/abc'), { action: 'play', query: 'https://youtu.be/abc' });
  assert.deepEqual(ruleIntent('toca algo animado'), { action: 'recommend', query: 'animado' });
  assert.deepEqual(ruleIntent('surprise me'), { action: 'recommend', query: '' });
  assert.equal(ruleIntent('random chatter with no verb'), null); // → falls through to LLM
});

test('formatDuration — seconds to m:ss / h:mm:ss', () => {
  assert.equal(formatDuration(0), '?');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(formatDuration(undefined), '?');
});

test('chunkMessage — splits on boundaries, respects the chunk cap', () => {
  assert.deepEqual(chunkMessage('short'), ['short']);
  assert.deepEqual(chunkMessage('  padded  '), ['padded']);

  // Splits at a newline near the limit, not mid-word.
  const para = `${'a'.repeat(1000)}\n${'b'.repeat(1500)}`;
  const chunks = chunkMessage(para, 1990);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], 'a'.repeat(1000));
  assert.equal(chunks[1], 'b'.repeat(1500));

  // Word-boundary fallback when there is no newline.
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
  for (const c of chunkMessage(words, 500)) {
    assert.ok(c.length <= 500);
    assert.ok(!c.startsWith(' ') && !c.endsWith(' '));
  }

  // Never more than MAX_CHUNKS (6) messages, however long the input.
  const huge = 'x'.repeat(2000 * 20);
  const capped = chunkMessage(huge, 1990);
  assert.equal(capped.length, 6);
  for (const c of capped) assert.ok(c.length <= 1990);
});

test('isClearPhrase — bilingual memory-wipe phrases', () => {
  for (const t of [
    'forget it',
    'forget everything',
    'Forget the conversation',
    'clear the context',
    'reset',
    'start over',
    'new conversation',
    'esquece tudo',
    'esquecer',
    'limpa a conversa',
    'limpar o histórico',
    'nova conversa',
    'apaga tudo',
    'forget it!!',
  ]) {
    assert.equal(isClearPhrase(t), true, t);
  }
  for (const t of [
    'do you ever forget things?',
    'forget me not is a flower',
    'toca raul',
    'can you clear this up for me',
    'reseta o roteador da minha casa por favor',
  ]) {
    assert.equal(isClearPhrase(t), false, t);
  }
});

test('parseDiceSpec — specs parse, caps apply, garbage rejected', () => {
  assert.deepEqual(parseDiceSpec('d20'), { count: 1, sides: 20, mod: 0 });
  assert.deepEqual(parseDiceSpec('2d6+3'), { count: 2, sides: 6, mod: 3 });
  assert.deepEqual(parseDiceSpec('3d8-2'), { count: 3, sides: 8, mod: -2 });
  assert.deepEqual(parseDiceSpec(' 2 d 6 '), { count: 2, sides: 6, mod: 0 }); // whitespace tolerated
  assert.deepEqual(parseDiceSpec('9999d99999'), { count: 100, sides: 10_000, mod: 0 }); // caps
  assert.equal(parseDiceSpec('banana'), null);
  assert.equal(parseDiceSpec('0d6'), null);
  assert.equal(parseDiceSpec('d1'), null);
  assert.equal(parseDiceSpec(''), null);
});

test('sparkline — maps values to block characters', () => {
  assert.equal(sparkline([1, 1, 1]), '▄▄▄'); // flat series → mid block
  const line = sparkline([0, 50, 100]);
  assert.equal(line.length, 3);
  assert.equal(line[0], '▁');
  assert.equal(line[2], '█');
});

test('findJsonLdPrice — Product offers found through nesting, junk ignored', () => {
  assert.deepEqual(findJsonLdPrice({ '@type': 'Product', offers: { price: 99.9, priceCurrency: 'BRL' } }), {
    price: 99.9,
    currency: 'BRL',
  });
  // String prices go through the locale-aware parser.
  assert.deepEqual(findJsonLdPrice({ '@type': 'Product', offers: { price: 'R$ 1.234,56' } }), {
    price: 1234.56,
    currency: null,
  });
  // lowPrice fallback and @graph nesting.
  assert.deepEqual(
    findJsonLdPrice({
      '@graph': [{ '@type': 'WebPage' }, { '@type': 'Product', offers: [{ lowPrice: 10 }] }],
    }),
    { price: 10, currency: null },
  );
  assert.equal(findJsonLdPrice({ '@type': 'Article' }), null);
  assert.equal(findJsonLdPrice(null), null);
  assert.equal(findJsonLdPrice([{}, 42, 'x']), null);
});

function watchWith(over: Partial<Watch>): Watch {
  return {
    id: 1,
    user_id: 'u',
    channel_id: 'c',
    url: 'https://example.com',
    selector: null,
    title: 't',
    currency: null,
    last_price: null,
    target_price: null,
    created_at: '2026-01-01 00:00:00',
    last_checked: null,
    interval_minutes: null,
    min_drop_pct: null,
    fail_count: 0,
    fail_notified: 0,
    ...over,
  };
}

/** SQLite-style UTC timestamp ("YYYY-MM-DD HH:MM:SS") some ms in the past. */
function sqliteTs(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
}

test('isDue — never-checked is due; interval honoured against SQLite timestamps', () => {
  assert.equal(isDue(watchWith({ last_checked: null })), true);
  // Checked 1 min ago with a 10-min interval → not due.
  assert.equal(isDue(watchWith({ last_checked: sqliteTs(60_000), interval_minutes: 10 })), false);
  // Checked 11 min ago with a 10-min interval → due.
  assert.equal(isDue(watchWith({ last_checked: sqliteTs(11 * 60_000), interval_minutes: 10 })), true);
});

test('fmt — price display handles missing price/currency', () => {
  assert.equal(fmt(null, 'R$'), '?');
  assert.equal(fmt(12.5, 'R$'), 'R$ 12.50');
  assert.equal(fmt(12.5, null), '12.50');
});

test('humanDuration / prometheusText — formatters', () => {
  assert.equal(humanDuration(65), '1m');
  assert.equal(humanDuration(3_660), '1h 1m');
  assert.equal(humanDuration(90_061), '1d 1h 1m');

  const snap: MetricsSnapshot = {
    uptimeSec: 60,
    cpuPercent: 12.3,
    guilds: 2,
    ssrfBlocks: 1,
    memory: { rss: 100, heapUsed: 50, heapTotal: 80, buffers: 10 },
    music: { sessions: 1, playing: 1, queued: 3, ytdlpInFlight: 0 },
    ollama: { inFlight: 0, max: 2 },
    db: { watches: 4, reminders: 5, playHistory: 6, sizeBytes: 7 },
  };
  const text = prometheusText(snap);
  assert.ok(text.includes('camelo_uptime_seconds 60\n'));
  assert.ok(text.includes('camelo_guilds 2\n'));
  assert.ok(text.includes('camelo_ssrf_blocks 1\n'));
  assert.ok(text.endsWith('\n'));
});

const TEST_GUILD = 'test-queue-guild';

function track(title: string): Track {
  return { title, url: `https://youtu.be/${title}`, duration: '3:00', requestedBy: 'u' };
}

test('TrackQueue — pickNext honours loop modes and skip', () => {
  try {
    const q = new TrackQueue(TEST_GUILD);
    const [a, b] = [track('a'), track('b')];
    q.tracks.push(a, b);

    // off: plain shift
    assert.deepEqual(q.pickNext(false), { track: a, repeated: false });
    q.current = a;

    // track loop repeats the current song…
    q.loopMode = 'track';
    assert.deepEqual(q.pickNext(false), { track: a, repeated: true });
    // …but an explicit skip advances past it
    assert.deepEqual(q.pickNext(true), { track: b, repeated: false });
    q.current = b;

    // queue loop cycles the finished song to the back
    q.loopMode = 'queue';
    q.tracks.push(track('c'));
    const pick = q.pickNext(false);
    assert.equal(pick.track?.title, 'c');
    assert.deepEqual(
      q.tracks.map((t) => t.title),
      ['b'],
    ); // b re-queued at the back
  } finally {
    db.prepare('DELETE FROM music_state WHERE guild_id = ?').run(TEST_GUILD);
  }
});

test('TrackQueue — queue survives a restart (persistence round-trip)', () => {
  try {
    const q1 = new TrackQueue(TEST_GUILD);
    q1.push(track('one'));
    q1.push(track('two'));
    q1.loopMode = 'queue';
    q1.persist();

    const q2 = new TrackQueue(TEST_GUILD);
    assert.deepEqual(
      q2.tracks.map((t) => t.title),
      ['one', 'two'],
    );
    assert.equal(q2.loopMode, 'queue');
    assert.equal(q2.autoplay, true); // autoplay deliberately not restored

    // The current track goes back to the front so a restart resumes with it.
    q2.current = q2.tracks.shift() ?? null;
    q2.persist();
    const q3 = new TrackQueue(TEST_GUILD);
    assert.deepEqual(
      q3.tracks.map((t) => t.title),
      ['one', 'two'],
    );
  } finally {
    db.prepare('DELETE FROM music_state WHERE guild_id = ?').run(TEST_GUILD);
  }
});

function fakeSession(requestedBy: string) {
  let skipped = false;
  const session = {
    current: { title: 'Song', url: 'https://youtu.be/a', duration: '3:00', requestedBy },
    skipVotes: new Set<string>(),
    skip() {
      skipped = true;
    },
  };
  return { session: session as unknown as MusicSession, wasSkipped: () => skipped };
}

test('skipAction — requester and small channels skip instantly, others vote', () => {
  assert.equal(skipAction(undefined, 'u1', 5).text, 'Nothing is playing.');

  // Requester skips instantly regardless of listeners.
  const own = fakeSession('u1');
  assert.match(skipAction(own.session, 'u1', 10).text, /Skipped/);
  assert.equal(own.wasSkipped(), true);

  // 1–2 person channel: anyone skips instantly.
  const duo = fakeSession('someone-else');
  assert.match(skipAction(duo.session, 'u2', 2).text, /Skipped/);

  // Bigger channel: votes accumulate to ceil(listeners/2).
  const crowd = fakeSession('someone-else');
  assert.match(skipAction(crowd.session, 'u2', 4).text, /1\/2/);
  assert.equal(crowd.wasSkipped(), false);
  assert.match(skipAction(crowd.session, 'u3', 4).text, /Vote passed/);
  assert.equal(crowd.wasSkipped(), true);
});
