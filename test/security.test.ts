import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { test } from 'node:test';
import { deleteReminder, insertReminder, listReminders, totalReminders } from '../src/db.js';
import { mdLinkText } from '../src/interactions.js';
import { normalize } from '../src/modules/music/intent.js';
import { entryUrl } from '../src/modules/music/player.js';
import { parseDuration } from '../src/modules/reminders/index.js';
import { startGuardedProxy } from '../src/modules/watcher/guardedProxy.js';
import { parsePriceText } from '../src/modules/watcher/scraper.js';
import {
  assertPublicHttpUrl,
  cappedText,
  hostIsPrivate,
  isAllowedMediaUrl,
  isHttpUrl,
  pinPublicHost,
  rateAllow,
  ssrfBlockCount,
} from '../src/security.js';

test('hostIsPrivate — literal private / localhost blocked, public allowed', async () => {
  for (const h of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1']) {
    assert.equal(await hostIsPrivate(h), true, h);
  }
  for (const h of ['localhost', 'foo.local', 'db.internal']) {
    assert.equal(await hostIsPrivate(h), true, h);
  }
  // v4-mapped and IP literals that are clearly public.
  assert.equal(await hostIsPrivate('8.8.8.8'), false);
  assert.equal(await hostIsPrivate('::ffff:127.0.0.1'), true);
});

test('assertPublicHttpUrl — rejects unsafe URLs, counts blocks', async () => {
  const before = ssrfBlockCount();
  const bad = [
    'ftp://8.8.8.8/', // non-http scheme
    'http://8.8.8.8:8080/', // non-standard port
    'http://user:pass@8.8.8.8/', // credentials
    'http://127.0.0.1/', // loopback
    'http://10.1.2.3/', // private
    'http://localhost/', // localhost name
    'http://[::1]/', // ipv6 loopback
  ];
  for (const url of bad) {
    await assert.rejects(assertPublicHttpUrl(url), url);
  }
  // A public IP literal is allowed (no DNS needed).
  await assert.doesNotReject(assertPublicHttpUrl('http://8.8.8.8/'));
  // The private/localhost rejections bump the monitored counter.
  assert.ok(ssrfBlockCount() > before);
});

test('assertPublicHttpUrl — IPv4-mapped / 6to4 / special-use are blocked (SSRF)', async () => {
  // These go through new URL(), which normalizes v4-mapped IPv6 to its hex form
  // (::ffff:127.0.0.1 -> ::ffff:7f00:1) — the notation that previously slipped
  // past the guard and reached loopback / cloud-metadata / LAN.
  const bad = [
    'http://[::ffff:127.0.0.1]/', // v4-mapped loopback
    'http://[::ffff:169.254.169.254]/', // v4-mapped cloud metadata
    'http://[::ffff:10.0.0.1]/', // v4-mapped private
    'http://[2002:7f00:1::]/', // 6to4 embedding 127.0.0.1
    'http://100.64.0.1/', // CGNAT (RFC 6598)
    'http://100.127.255.254/', // CGNAT upper bound
  ];
  for (const url of bad) {
    await assert.rejects(assertPublicHttpUrl(url), url);
  }
  // A genuinely public v4-mapped address must still be allowed.
  await assert.doesNotReject(assertPublicHttpUrl('http://[::ffff:8.8.8.8]/'));
});

test('pinPublicHost — pins public IP, rejects private + odd ports', async () => {
  const pin = await pinPublicHost('8.8.8.8', 443);
  assert.equal(pin.address, '8.8.8.8');
  await assert.rejects(pinPublicHost('127.0.0.1', 443));
  await assert.rejects(pinPublicHost('169.254.169.254', 80));
  await assert.rejects(pinPublicHost('8.8.8.8', 22)); // non-http port
});

test('guarded proxy — CONNECT to private / non-http port is refused', async () => {
  const proxy = await startGuardedProxy();
  try {
    for (const authority of ['127.0.0.1:443', '169.254.169.254:443', '8.8.8.8:22']) {
      const status = await connectStatus(proxy.port, authority);
      assert.match(status, /^HTTP\/1\.1 403/, authority);
    }
  } finally {
    await proxy.close();
  }
});

test('parsePriceText / parseDuration — no catastrophic backtracking', () => {
  const start = Date.now();
  parsePriceText(`${'1'.repeat(5000)}.${'2'.repeat(5000)},99`);
  parsePriceText(`R$ ${'1.'.repeat(5000)}234,56`);
  parseDuration('9'.repeat(5000));
  parseDuration('1d2h3m4s'.repeat(2000));
  assert.ok(Date.now() - start < 1000, 'pathological input parsed in <1s');
});

test('SQL injection — reminder message is bound, not executed', () => {
  const evil = "'); DROP TABLE reminders;--";
  const id = insertReminder({
    user_id: 'sqli-test-user',
    channel_id: 'c',
    message: evil,
    due_at: Date.now() + 3_600_000,
  });
  try {
    const rows = listReminders('sqli-test-user');
    assert.equal(rows[0]?.message, evil, 'stored verbatim');
    assert.ok(totalReminders() >= 1, 'table intact (not dropped)');
  } finally {
    deleteReminder(id);
  }
});

test('rateAllow — burst consumed, then denied; keys independent', () => {
  // Burst of 2: two calls pass, the third is denied (refill is 2/min — far
  // slower than this test runs).
  assert.equal(rateAllow('test-ra-a', 2, 2), true);
  assert.equal(rateAllow('test-ra-a', 2, 2), true);
  assert.equal(rateAllow('test-ra-a', 2, 2), false);
  // A different key has its own bucket.
  assert.equal(rateAllow('test-ra-b', 2, 2), true);
});

test('cappedText — reads small bodies, rejects oversized ones', async () => {
  assert.equal(await cappedText(new Response('hello')), 'hello');
  assert.equal(await cappedText(new Response(null)), '');
  await assert.rejects(cappedText(new Response('x'.repeat(100)), 10), /too large/i);
});

test('isAllowedMediaUrl — /play allowlist gate', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=abc',
    'https://youtu.be/abc',
    'https://music.youtube.com/watch?v=abc',
    'https://open.spotify.com/track/xyz',
    'https://soundcloud.com/artist/track',
    'https://on.soundcloud.com/xyz',
    'https://YOUTUBE.COM/watch?v=abc', // hostname case-insensitive
  ]) {
    assert.equal(isAllowedMediaUrl(url), true, url);
  }
  for (const url of [
    'https://evil.com/watch?v=abc',
    'https://youtube.com.evil.com/x', // suffix spoof
    'https://notyoutube.com/x',
    'ftp://youtube.com/x', // non-http scheme
    'file:///etc/passwd',
    'youtube.com/watch', // not a URL at all
    '--dump-json', // yt-dlp flag masquerading as input
    '',
  ]) {
    assert.equal(isAllowedMediaUrl(url), false, url);
  }
});

test('isHttpUrl — http(s) prefix only, case-insensitive', () => {
  assert.equal(isHttpUrl('https://x.com'), true);
  assert.equal(isHttpUrl('HTTP://x.com'), true);
  assert.equal(isHttpUrl('ytsearch1:song name'), false);
  assert.equal(isHttpUrl('file:///etc/passwd'), false);
  assert.equal(isHttpUrl('--flag'), false);
});

test('entryUrl — only http(s) strings from yt-dlp output reach the play spawn', () => {
  assert.equal(entryUrl({ webpage_url: 'https://youtube.com/watch?v=a' }), 'https://youtube.com/watch?v=a');
  assert.equal(entryUrl({ url: 'https://soundcloud.com/a/b' }), 'https://soundcloud.com/a/b');
  // A non-URL string (could be read as a yt-dlp flag) is skipped, not passed through.
  assert.equal(entryUrl({ webpage_url: '--exec=calc', url: 'https://youtu.be/a' }), 'https://youtu.be/a');
  assert.equal(entryUrl({ id: 'abc123' }), 'https://www.youtube.com/watch?v=abc123');
  assert.equal(entryUrl({ webpage_url: 'ftp://evil/x' }), null);
  assert.equal(entryUrl({}), null);
});

test('normalize — LLM intent output is schema-defended', () => {
  // play with no query would enqueue garbage → downgraded to chat
  assert.deepEqual(normalize({ action: 'play' }), { action: 'chat' });
  assert.deepEqual(normalize({ action: 'play', query: 'raul' }), { action: 'play', query: 'raul' });
  // an action outside the known set (model ignored the schema) does nothing
  assert.deepEqual(normalize({ action: 'rm -rf /' as never }), { action: 'chat' });
  assert.deepEqual(normalize({ action: 'volume_set' }), { action: 'volume_set', volume: 100 });
  assert.deepEqual(normalize({ action: 'recommend' }), { action: 'recommend', query: '' });
  assert.deepEqual(normalize({ action: 'skip' }), { action: 'skip' });
});

test('mdLinkText — untrusted titles cannot break out of [label](url) links', () => {
  assert.equal(mdLinkText('x](https://evil)'), 'x\\]\\(https://evil\\)');
  assert.equal(mdLinkText('[click me]'), '\\[click me\\]');
  assert.equal(mdLinkText('plain title'), 'plain title');
});

/** Open a raw socket to the proxy, issue a CONNECT, return the first status line. */
function connectStatus(port: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    sock.setTimeout(5_000, () => {
      sock.destroy();
      reject(new Error('proxy CONNECT timed out'));
    });
    sock.once('data', (buf) => {
      sock.destroy();
      resolve(buf.toString('utf8').split('\r\n')[0]);
    });
    sock.once('error', reject);
  });
}
