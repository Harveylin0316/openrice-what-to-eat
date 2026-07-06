// P0 spike runner：Playwright Chromium + 4x CPU 節流（近似中階 Android）
// 用法：node run-spike.mjs [--no-throttle]
import { chromium } from 'playwright';
import http from 'http';
import { readFile } from 'fs/promises';
import { join, extname, resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '../..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  try {
    const path = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('nf');
  }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const throttle = !process.argv.includes('--no-throttle');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 390, height: 780 } }); // iPhone 14 尺寸

const cdp = await page.context().newCDPSession(page);
if (throttle) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

const t0 = Date.now();
await page.goto(`http://localhost:${port}/_redesign/spike/map-spike.html`);
await page.waitForFunction(() => window.__SPIKE_RESULTS?.done, null, { timeout: 60000 });
const results = await page.evaluate(() => window.__SPIKE_RESULTS);
results.wallClock = Date.now() - t0;
results.cpuThrottle = throttle ? '4x' : 'none';

await page.screenshot({ path: join(import.meta.dirname, `spike-result${throttle ? '' : '-nothrottle'}.png`) });
console.log(JSON.stringify(results, null, 2));

await browser.close();
server.close();
