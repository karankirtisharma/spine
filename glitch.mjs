import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs';

/* Reproduction harness for the refresh glitch.
 *
 * Two things the earlier attempt got wrong:
 *   1. shot.mjs waits 20s before capturing; the artifact appears DURING load and
 *      is long gone by then.
 *   2. sampling the canvas via drawImage only sees what WebGL produced. If the
 *      artifact is the page compositor showing partially-updated tiles, the
 *      canvas reads clean. So detect on the real composited screenshot instead.
 *
 * The artifact is axis-aligned black rectangles, so a bad frame has scanlines
 * that are almost entirely black immediately adjacent to scanlines that are not.
 * A healthy frame is uniformly dark (loader) or uniformly busy -- not both.
 *
 *   node glitch.mjs [reloads] [scale] [url]
 */
const RELOADS = Number(process.argv[2] || 6);
const SCALE = Number(process.argv[3] || 1.5);   // your 150% zoom
const URL = process.argv[4] || 'http://localhost:5188/';
const OUT = 'glitchshots';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--window-position=0,0'],
});
const page = await browser.newPage({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: SCALE,
});

const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

async function state() {
  return page.evaluate(() => {
    const c = document.getElementById('gl');
    const o = document.getElementById('loading');
    return {
      canvas: c ? [c.width, c.height] : null,
      css: c ? [c.clientWidth, c.clientHeight] : null,
      inner: [innerWidth, innerHeight],
      dpr: devicePixelRatio,
      loaderOpacity: o ? getComputedStyle(o).opacity : null,
    };
  }).catch(() => null);
}

/* Row profile of the composited frame. Downscale to 200x140 first so one stray
 * dark pixel cannot swing a row. */
async function profile(buf) {
  const W = 200, H = 140;
  const { data } = await sharp(buf).removeAlpha().resize(W, H, { fit: 'fill' })
    .raw().toBuffer({ resolveWithObject: true });
  const rows = [];
  for (let y = 0; y < H; y++) {
    let lit = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (data[i] + data[i + 1] + data[i + 2] > 30) lit++;
    }
    rows.push(lit / W);
  }
  // count hard transitions between near-empty and populated bands
  let edges = 0;
  for (let y = 1; y < H; y++) {
    const a = rows[y - 1] < 0.03, b = rows[y] < 0.03;
    if (a !== b) edges++;
  }
  const empty = rows.filter(r => r < 0.03).length;
  const full = rows.filter(r => r > 0.25).length;
  return { empty, full, edges };
}

let bad = 0, frames = 0;
for (let r = 1; r <= RELOADS; r++) {
  await page.goto(URL + '?cb=' + Date.now(), { waitUntil: 'commit' });
  for (let k = 0; k < 12; k++) {
    await page.waitForTimeout(280);
    let buf;
    try { buf = await page.screenshot({ type: 'png' }); } catch { continue; }
    const p = await profile(buf);
    frames++;
    // both an empty band and a populated band, with a crisp boundary => artifact
    if (p.empty >= 10 && p.full >= 10 && p.edges >= 2) {
      bad++;
      const s = await state();
      const name = `${OUT}/bad_r${r}_k${k}.png`;
      fs.writeFileSync(name, buf);
      console.log(`BAD r${r} k${k} empty=${p.empty} full=${p.full} edges=${p.edges} ` +
        `canvas=${s?.canvas} css=${s?.css} inner=${s?.inner} dpr=${s?.dpr} loader=${s?.loaderOpacity}`);
    }
  }
  console.log(`reload ${r} done`);
}

console.log(`\n${bad} bad / ${frames} frames over ${RELOADS} reloads at scale ${SCALE}`);
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
