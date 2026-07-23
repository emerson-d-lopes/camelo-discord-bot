import { existsSync } from 'node:fs';
import { assertPublicHttpUrl, hostIsPrivate } from '../../security.js';

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
];

/**
 * Screenshot a product page with the locally installed Chrome (headless).
 * Returns null on any failure — alerts still go out without the image.
 */
export async function screenshotPage(url: string): Promise<Buffer | null> {
  try {
    await assertPublicHttpUrl(url);
  } catch {
    return null;
  }
  const executablePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!executablePath) return null;

  let browser;
  try {
    const { launch } = await import('puppeteer-core');
    browser = await launch({
      executablePath,
      headless: true,
      args: ['--no-first-run', '--disable-extensions', '--mute-audio'],
    });
    const page = await browser.newPage();
    // Disable JS so a hostile page can't script LAN requests from the renderer,
    // and intercept every request to block any that resolve to a private host
    // (covers redirects and sub-resources the Node-side guard never sees).
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      void (async () => {
        try {
          const host = new URL(req.url()).hostname;
          if (await hostIsPrivate(host)) await req.abort();
          else await req.continue();
        } catch {
          await req.abort().catch(() => {});
        }
      })();
    });
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await new Promise((r) => setTimeout(r, 1_000));
    const buf = await page.screenshot({ type: 'jpeg', quality: 80 });
    return Buffer.from(buf);
  } catch (err) {
    console.warn('[watcher] screenshot failed:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}
