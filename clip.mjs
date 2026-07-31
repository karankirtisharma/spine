import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = 'clip';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--hide-scrollbars'],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
});

page.setDefaultTimeout(180000);
await page.goto('http://localhost:5188/', { waitUntil: 'load' });
await page.waitForTimeout(18000);   // GLB decode

// ease the scroll through the middle of the track so transitions are visible
await page.evaluate(() => new Promise(res => {
  const s = document.getElementById('scroll');
  const max = s.scrollHeight - s.clientHeight;
  const from = 0.16, to = 0.78, dur = 17000;
  const t0 = performance.now();
  (function step(now) {
    const t = Math.min(1, (now - t0) / dur);
    s.scrollTop = max * (from + (to - from) * t);
    t < 1 ? requestAnimationFrame(step) : setTimeout(res, 1200);
  })(t0);
}));

await page.close();
await browser.close();

const file = fs.readdirSync(OUT).find(f => f.endsWith('.webm'));
console.log('video:', OUT + '/' + file);
