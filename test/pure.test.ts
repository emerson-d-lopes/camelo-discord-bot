import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ruleIntent } from '../src/modules/music/intent.js';
import { formatDuration } from '../src/modules/music/player.js';
import { parseDuration } from '../src/modules/reminders/index.js';
import { parsePriceText } from '../src/modules/watcher/scraper.js';

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
