/* Headless verification harness for the audit fixes.
 *
 * The Chrome instances connected to the agent live on a different machine
 * from the dev server, so browser-driven checking was unavailable and several
 * changes shipped on reasoning alone (and one of them -- four water shading
 * steps -- had to be reverted because it could not be seen). This restores
 * the loop locally: it drives the real page in real Chromium, parks the
 * scroll at named stops, and reports both pixel statistics and the page's
 * own __dbg() state, so a fix can be judged before it is committed.
 *
 *   node test/verify.mjs [outDir] [stops] [url]
 *   node test/verify.mjs test/out 700,860,905,1010
 *
 * Stops are TRACK VH (the unit the whole project reasons in), not progress:
 * scrollTo(vh * innerHeight / 100) is exactly what the debugging sessions
 * used, so numbers here match the ones in the audit and the plan docs.
 *
 * Headed, like shot.mjs, and for the same reason: a real GPU is needed for
 * the 1.87M-triangle spine and for the float render targets the post chain
 * depends on. --headless=new renders it, but swiftshader's precision differs
 * enough that colour statistics stop being comparable run to run.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import sharp from 'sharp';

/* PNG -> luma stats via sharp (already a devDependency for compress.mjs).
 *
 * Measured from the SCREENSHOT, never from the live canvas: the renderer
 * runs preserveDrawingBuffer:false, so drawImage(glCanvas) from a task
 * outside the render's own frame reads a CLEARED buffer and every stat comes
 * back 0 luma / 100% black -- which is indistinguishable from a real
 * blank-frame regression, i.e. the most dangerous possible false positive.
 * The first version of this file made exactly that mistake. */
async function decodeStats(file) {
  try {
    const { data, info } = await sharp(file).resize(240).raw().toBuffer({ resolveWithObject: true });
    let sum = 0, dark = 0, blown = 0, n = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += l; if (l < 8) dark++; if (l > 250) blown++; n++;
    }
    return { meanLuma: +(sum / n).toFixed(2), darkPct: +(100 * dark / n).toFixed(1), blownPct: +(100 * blown / n).toFixed(2) };
  } catch (e) {
    return { meanLuma: null, darkPct: null, blownPct: null, statsError: String(e.message).slice(0, 120) };
  }
}

const OUT = process.argv[2] || 'test/out';
const STOPS = (process.argv[3] || '700,860,905,1010').split(',').map(Number);
const URL = process.argv[4] || 'http://127.0.0.1:3000/';
/* Device pixel ratio to emulate. Defaults to 1, but anything touching render
 * TARGET sizing has to be checked above 1: main.js caps DPR at
 * min(devicePixelRatio, 1.5), so at deviceScaleFactor 1 the composer and the
 * transition buffers happen to agree and a resolution mismatch between them
 * is invisible. Pass 1.5 to reproduce what a retina viewer actually gets. */
const DSF = Number(process.argv[5] || 1);

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: false,
  args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit',
         '--hide-scrollbars', '--window-position=0,0'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: DSF });

const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

page.setDefaultTimeout(180000);
await page.goto(URL, { waitUntil: 'load' });

/* Wait on the app's own readiness rather than a fixed sleep: __dbg appears
 * with the frame loop, and the loader clears only after the prewarm. */
await page.waitForFunction(() => !!window.__dbg && !!window.__lenis, null, { timeout: 120000 });
await page.waitForTimeout(12000);          // GLB decode + prewarm + film blobs

const report = { url: URL, dpr: DSF, stops: [], errors: [] };

for (const vh of STOPS) {
  /* Park and let the filtered scroll converge. smoothProgress eases toward
   * scrollProgress every frame, so a single scrollTo is not enough -- hold
   * the target until __dbg().progress stops moving, exactly as the manual
   * pin-and-screenshot loop did. */
  const state = await page.evaluate(async (targetVh) => {
    const y = targetVh * innerHeight / 100;
    let last = -1, stable = 0;
    for (let i = 0; i < 240; i++) {
      window.__lenis.scrollTo(y, { immediate: true });
      await new Promise(r => requestAnimationFrame(r));
      const p = window.__dbg().progress;
      if (Math.abs(p - last) < 1e-6) { if (++stable > 8) break; } else stable = 0;
      last = p;
    }
    const d = window.__dbg();
    return {
      vh: Math.round(window.__lenis.scroll / innerHeight * 100),
      front: d.front, tr: d.tr, progress: +d.progress.toFixed(5),
      camPos: d.camPos.map(v => +v.toFixed(3)), fov: d.fov,
      tris: d.sceneTris, calls: d.sceneCalls, programs: d.programs,
      fog: d.fogDensity,
    };
  }, vh);

  const file = `${OUT}/vh${vh}.png`;
  await page.screenshot({ path: file });

  /* Frame statistics so a regression is catchable without eyes: mean luma,
   * the share that is essentially black, and the share that is blown out. A
   * frame that goes dark, white, or empty moves these hard -- which is what
   * the water shading regressions did. */
  const stats = await decodeStats(file);

  report.stops.push({ ...state, ...stats, file });
  console.log(`vh ${String(vh).padStart(5)}  front=${String(state.front).padEnd(6)} ` +
    `luma=${String(stats.meanLuma).padStart(6)} dark=${String(stats.darkPct).padStart(5)}% ` +
    `blown=${String(stats.blownPct).padStart(5)}% tris=${state.tris} prog=${state.programs}`);
}

report.errors = errors;
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
console.log(errors.length ? `\nCONSOLE ERRORS (${errors.length}):\n` + errors.slice(0, 10).join('\n') : '\nno console errors');
await browser.close();
