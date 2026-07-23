import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// --- rate limiting (token bucket per key) ---

const buckets = new Map<string, { tokens: number; last: number }>();

/** True = allowed. `ratePerMin` refill, `burst` bucket size. */
export function rateAllow(key: string, ratePerMin: number, burst = ratePerMin): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: burst, last: now };
  b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 60_000) * ratePerMin);
  b.last = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

// Prune stale buckets hourly so the map can't grow forever.
setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [k, b] of buckets) if (b.last < cutoff) buckets.delete(k);
}, 3_600_000).unref();

// --- media URL allowlist (/play links) ---

const MEDIA_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be',
  'open.spotify.com',
  'soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com',
]);

/** Only well-known media hosts may be handed to yt-dlp as URLs. */
export function isAllowedMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return MEDIA_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// --- SSRF guard (scraper + screenshots) ---

function isPrivateIp(addr: string): boolean {
  if (isIP(addr) === 4) {
    const [a, b] = addr.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a >= 224) return true; // multicast/reserved
    return false;
  }
  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local
  if (lower.startsWith('fec') || lower.startsWith('fed') || lower.startsWith('fee') || lower.startsWith('fef')) return true; // deprecated site-local
  if (lower.startsWith('64:ff9b:')) return true; // NAT64
  if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7)); // v4-mapped
  return false;
}

/** True if a hostname is localhost-style or resolves to a private address. */
export async function hostIsPrivate(host: string): Promise<boolean> {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') ||
    h.endsWith('.internal') || h.endsWith('.home.arpa')
  ) {
    return true;
  }
  if (isIP(h)) return isPrivateIp(h);
  try {
    const addrs = await lookup(h, { all: true });
    return addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address));
  } catch {
    return true; // unresolvable → treat as unsafe
  }
}

/**
 * Reject URLs that could reach this machine or the local network: non-http
 * protocols, unusual ports, localhost-style hostnames, and any hostname that
 * resolves to a private/loopback/link-local address.
 */
export async function assertPublicHttpUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid URL.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) URLs are allowed.');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('Non-standard ports are not allowed.');
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed.');

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    throw new Error('Local addresses are not allowed.');
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Private addresses are not allowed.');
    return;
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error('Could not resolve that hostname.');
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('That URL resolves to a private address.');
  }
}

/**
 * fetch() that re-validates every redirect hop against the SSRF guard, so a
 * public URL cannot bounce to an internal address. Caps hops and rejects
 * non-standard protocols/ports on each step.
 */
export async function safeFetch(url: string, init: RequestInit = {}, maxHops = 5): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertPublicHttpUrl(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    current = new URL(location, current).toString();
  }
  throw new Error('Too many redirects.');
}
