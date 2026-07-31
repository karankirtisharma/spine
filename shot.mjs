import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = process.argv[2] || 'shots';
// "wp:N" resolves to the scroll progress that parks the camera on waypoint N,
// inverting smoothstep(0.06, 0.94, progress) the rail uses.
function invSmoothstep(v) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2, s = m * m * (3 - 2 * m);
    if (s < v) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}
const STOPS = (process.argv[3] || '0.08,0.25,0.45,0.65,0.85').split(',').map(s => {
  const m = /^wp:(\d+)\/(\d+)$/.exec(s.trim());
  if (!m) return Number(s);
  return 0.06 + invSmoothstep(Number(m[1]) / Number(m[2])) * 0.88;
});
const URL = process.argv[4] || 'http://localhost:5188/';

fs.mkdirSync(OUT, { recursive: true });

// Headed Chromium so the real GPU renders the 1.87M-triangle spine.
const browser = await chromium.launch({
  headless: false,
  args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit',
         '--hide-scrollbars', '--window-position=0,0'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const cdp = await page.context().newCDPSession(page);

const errors = [], logs = [];
page.on('console', m => { (m.type() === 'error' ? errors : logs).push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

page.setDefaultTimeout(180000);
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(20000);   // 70MB GLB decode

console.log('DIAG', JSON.stringify(await page.evaluate(() => {
  const c = document.getElementById('gl');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  const d = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return { canvas: { w: c.width, h: c.height },
           renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a',
           scrollH: document.getElementById('scroll').scrollHeight };
})));

// measure steady-state frame time
const fps = await page.evaluate(() => new Promise(res => {
  const t = []; let last = performance.now(), n = 0;
  const tick = now => { t.push(now - last); last = now; if (++n < 120) requestAnimationFrame(tick);
    else { t.sort((a, b) => a - b); res({ p50: +t[60].toFixed(2), p95: +t[114].toFixed(2) }); } };
  requestAnimationFrame(tick);
}));
console.log('FRAME', JSON.stringify(fps));

for (const p of STOPS) {
  await page.evaluate(prog => {
    const s = document.getElementById('scroll');
    const y = (s.scrollHeight - s.clientHeight) * prog;
    // Lenis owns scrollTop; jump through it or it eases straight back
    if (window.__lenis) window.__lenis.scrollTo(y, { immediate: true });
    else s.scrollTop = y;
  }, p);
  // the fluid backdrop is pointer-driven; sweep so it has something to show
  for (let k = 0; k < 22; k++) {
    const a = (k / 22) * Math.PI * 2;
    await page.mouse.move(720 + Math.cos(a) * 460, 450 + Math.sin(a) * 290);
    await page.waitForTimeout(40);
  }
  // physarum needs a few seconds for the transport network to emerge
  await page.waitForTimeout(6000);
  // park on the focused card so the liquid hover engages (uHover eases at 0.08)
  if (process.env.HOVER === '1') {
    await page.mouse.move(720, 450);
    await page.waitForTimeout(1500);
    // drag across the card so the wake and ripple have real velocity to show
    for (let k = 0; k <= 18; k++) {
      await page.mouse.move(560 + k * 12, 470 - k * 4);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(120);
  }
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const name = `${OUT}/p${String(Math.round(p * 100)).padStart(3, '0')}.png`;
  fs.writeFileSync(name, Buffer.from(data, 'base64'));
  console.log('shot', name);
}

if (logs.length) console.log('LOGS:\n' + logs.slice(0, 10).join('\n'));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close();
