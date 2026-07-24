import { existsSync } from 'node:fs';
import { assertPublicHttpUrl } from '../../security.js';
import { startGuardedProxy } from './guardedProxy.js';

// An explicit override (set by the Docker image) wins; otherwise probe the
// usual Chrome/Chromium locations on Windows and Linux.
const CHROME_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter((p): p is string => typeof p === 'string' && p.length > 0);

// One screenshot at a time across the whole process. The watcher loop is
// already serial, but this hard-caps concurrency even if that changes, so a
// burst of due watches can't launch a swarm of Chrome processes.
let inFlight = 0;
const MAX_CONCURRENT = 1;

/**
 * Screenshot a product page with the locally installed Chrome (headless).
 * Returns null on any failure — alerts still go out without the image.
 *
 * SSRF: the entry URL is validated up front, then all browser traffic is forced
 * through a loopback proxy that pins every connection (navigation, redirects,
 * sub-resources) to a validated public IP. Chrome does its own DNS resolution,
 * so pinning at the proxy is what actually closes the rebinding TOCTOU that a
 * re-resolving request interceptor cannot. `<-loopback>` denies the implicit
 * localhost bypass so a hostile page can't sidestep the proxy.
 */
export async function screenshotPage(url: string): Promise<Buffer | null> {
  try {
    await assertPublicHttpUrl(url);
  } catch {
    return null;
  }
  const executablePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!executablePath) return null;
  if (inFlight >= MAX_CONCURRENT) return null;
  inFlight++;

  let browser;
  let proxy;
  try {
    proxy = await startGuardedProxy();
    const { launch } = await import('puppeteer-core');
    browser = await launch({
      executablePath,
      headless: true,
      args: [
        '--no-first-run',
        '--disable-extensions',
        '--mute-audio',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        // Chromium's own sandbox needs user namespaces that a hardened container
        // usually blocks; JS is off and all traffic goes through the guarded
        // proxy, so drop it on Linux (containers) but keep it on the desktop.
        ...(process.platform === 'win32' ? [] : ['--no-sandbox', '--disable-setuid-sandbox']),
        `--proxy-server=http://127.0.0.1:${proxy.port}`,
        '--proxy-bypass-list=<-loopback>',
      ],
    });
    const page = await browser.newPage();
    // JS off: a hostile page can't script requests, and the guarded proxy vets
    // every network call the renderer still makes.
    await page.setJavaScriptEnabled(false);
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
    await proxy?.close().catch(() => {});
    inFlight--;
  }
}
