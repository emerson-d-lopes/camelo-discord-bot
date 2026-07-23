import * as cheerio from 'cheerio';
import { assertPublicHttpUrl, cappedText, safeFetch } from '../../security.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CURRENCY_RE = /(R\$|US\$|CA\$|A\$|\$|€|£|¥|USD|BRL|EUR|GBP|JPY)/i;

export class ScrapeError extends Error {}

export interface ScrapeResult {
  price: number;
  currency: string | null;
  title: string | null;
  /** which strategy found the price — useful for debugging flaky sites */
  source: 'selector' | 'json-ld' | 'meta' | 'heuristic' | 'mercadolivre-api';
}

/**
 * Parse a human price string into a number, handling both `1,234.56` and
 * `1.234,56` style separators.
 */
export function parsePriceText(text: string): number | null {
  const compact = text.replace(/[\s ]/g, '');
  const m = compact.match(/\d+(?:[.,]\d{3})*(?:[.,]\d{1,2})?/);
  if (!m) return null;
  let s = m[0];

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: the later one is the decimal separator.
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    s = s.split(thou).join('');
    if (dec === ',') s = s.replace(',', '.');
  } else if (lastComma !== -1) {
    const parts = s.split(',');
    // "1,234" or "1,234,567" → thousands; "12,34" → decimal
    if (parts.length === 2 && parts[1].length !== 3) s = s.replace(',', '.');
    else s = parts.join('');
  } else if (lastDot !== -1) {
    const parts = s.split('.');
    // "1.234" alone is ambiguous; treat 3-digit groups with short head as thousands
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3)) {
      s = parts.join('');
    }
  }

  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function findCurrency(text: string): string | null {
  return text.match(CURRENCY_RE)?.[0] ?? null;
}

interface JsonLdPrice {
  price: number;
  currency: string | null;
}

function findJsonLdPrice(node: unknown): JsonLdPrice | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJsonLdPrice(item);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  const type = obj['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes('Product')) {
    const offers = obj.offers;
    const offerList = Array.isArray(offers) ? offers : [offers];
    for (const offer of offerList) {
      if (!offer || typeof offer !== 'object') continue;
      const o = offer as Record<string, unknown>;
      const rawPrice = o.price ?? o.lowPrice;
      const price =
        typeof rawPrice === 'number' ? rawPrice : parsePriceText(String(rawPrice ?? ''));
      if (price !== null && price > 0) {
        return {
          price,
          currency: typeof o.priceCurrency === 'string' ? o.priceCurrency : null,
        };
      }
    }
  }

  for (const key of ['@graph', 'mainEntity', 'itemListElement', 'item']) {
    if (key in obj) {
      const found = findJsonLdPrice(obj[key]);
      if (found) return found;
    }
  }
  return null;
}

interface MlItem {
  title?: string;
  price?: number;
  currency_id?: string;
}

/** Mercado Livre items have a real API — try it before scraping. */
async function tryMercadoLivre(url: string): Promise<ScrapeResult | null> {
  if (!/mercadoli[bv]re\.com/i.test(url)) return null;
  const id = url.match(/(ML[A-Z])-?(\d{6,})/i);
  if (!id) return null;
  try {
    const res = await fetch(`https://api.mercadolibre.com/items/${id[1].toUpperCase()}${id[2]}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const item = (await res.json()) as MlItem;
    if (typeof item.price !== 'number' || item.price <= 0) return null;
    return {
      price: item.price,
      currency: item.currency_id ?? null,
      title: item.title ?? null,
      source: 'mercadolivre-api' as ScrapeResult['source'],
    };
  } catch {
    return null;
  }
}

export async function scrapePrice(url: string, selector?: string | null): Promise<ScrapeResult> {
  try {
    await assertPublicHttpUrl(url);
  } catch (err) {
    throw new ScrapeError(err instanceof Error ? err.message : 'URL not allowed.');
  }
  const ml = await tryMercadoLivre(url);
  if (ml) return ml;

  let res: Response;
  try {
    res = await safeFetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9,pt-BR;q=0.8',
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    // Don't echo raw fetch errors — they can leak resolved hosts/IPs. Log full,
    // return the guard's own (already-generic) message or a fixed fallback.
    const isGuard = err instanceof Error && /allowed|private|redirect|resolve|Invalid URL/i.test(err.message);
    if (!isGuard) console.warn('[watcher] fetch error:', err);
    throw new ScrapeError(isGuard ? (err as Error).message : 'Could not fetch that page.');
  }
  if (!res.ok) throw new ScrapeError(`Site returned HTTP ${res.status}.`);

  let html: string;
  try {
    html = await cappedText(res);
  } catch {
    throw new ScrapeError('That page is too large to scan.');
  }
  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr('content')?.trim() || $('title').first().text().trim() || null;

  // 1. Explicit selector from the user always wins.
  if (selector) {
    const text = $(selector).first().text().trim();
    const price = parsePriceText(text);
    if (price === null) {
      throw new ScrapeError(
        text
          ? `Selector matched "${text.slice(0, 60)}" but no price could be parsed from it.`
          : 'Selector matched nothing on the page.',
      );
    }
    return { price, currency: findCurrency(text), title, source: 'selector' };
  }

  // 2. JSON-LD structured data (most reliable when present).
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    const rawJson = $(el).text();
    try {
      const found = findJsonLdPrice(JSON.parse(rawJson));
      if (found) return { ...found, title, source: 'json-ld' };
    } catch {
      // malformed JSON-LD is common — skip it
    }
  }

  // 3. Price meta tags.
  const metaContent =
    $('meta[property="og:price:amount"]').attr('content') ??
    $('meta[property="product:price:amount"]').attr('content') ??
    $('meta[itemprop="price"]').attr('content') ??
    $('[itemprop="price"]').attr('content');
  if (metaContent) {
    const price = parsePriceText(metaContent);
    if (price !== null) {
      const currency =
        $('meta[property="og:price:currency"]').attr('content') ??
        $('meta[property="product:price:currency"]').attr('content') ??
        $('meta[itemprop="priceCurrency"]').attr('content') ??
        null;
      return { price, currency, title, source: 'meta' };
    }
  }

  // 4. Heuristic: short text nodes in price-ish classes/ids containing a currency symbol.
  const candidates = $('[class*="price"], [class*="Price"], [id*="price"], [itemprop="price"]');
  let fallback: ScrapeResult | null = null;
  for (const el of candidates.toArray()) {
    const text = $(el).text().trim();
    if (!text || text.length > 40) continue;
    const price = parsePriceText(text);
    if (price === null) continue;
    const currency = findCurrency(text);
    const result: ScrapeResult = { price, currency, title, source: 'heuristic' };
    if (currency) return result; // symbol present → high confidence
    fallback ??= result;
  }
  if (fallback) return fallback;

  throw new ScrapeError(
    'Could not detect a price on this page. Re-run /watch with the `selector` option (a CSS selector for the price element).',
  );
}
