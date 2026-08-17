/* FEEDBACK-LOOP BISECTOR
 * ----------------------
 * Finds the mesh that is being drawn while sampling the render target it is
 * being drawn INTO -- the GL_INVALID_OPERATION "Feedback loop formed between
 * Framebuffer and active Texture" that is collapsing the scene.
 *
 * HOW TO RUN
 *   1. Load the site, let it finish loading, scroll to ~880vh (the deep
 *      section, where the warnings appear).
 *   2. Open DevTools -> Console.
 *   3. Paste this whole file in and press Enter.
 *   4. Wait ~30-60s. It prints a report and restores everything it touched.
 *
 * It only toggles `.visible` and always restores it, so it cannot damage
 * anything; refreshing the page undoes it regardless.
 *
 * WHAT IT DOES
 *   - Wraps the real WebGL draw calls and checks gl.getError() after each,
 *     so it can COUNT feedback errors per frame rather than relying on the
 *     console's rate-limited warnings (WebGL stops reporting after ~32).
 *   - Measures a baseline, then hides one candidate object at a time and
 *     re-measures. Whichever object takes the count to zero is the culprit.
 *   - Checks top-level scene children first (coarse), then walks into the
 *     winning branch to name the exact mesh (fine).
 */
(async function diagnoseFeedback() {
  const log = (...a) => console.log('%c[fb]', 'color:#5f5', ...a);

  // ---- handles -------------------------------------------------------
  const canvas = document.querySelector('#gl');
  if (!canvas) return console.error('[fb] no #gl canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) return console.error('[fb] no GL context');

  // the root Scene, reached through a known object rather than a global
  const probe = (window.__water && window.__water.topside)
             || (window.__scene && window.__scene.workRoot);
  if (!probe) return console.error('[fb] need window.__water or window.__scene');
  let scene = probe;
  while (scene.parent) scene = scene.parent;
  log('scene root:', scene.type, 'children:', scene.children.length);

  // ---- instrument the draw calls -------------------------------------
  const INVALID_OP = 1282;
  let errs = 0, instrumented = [];
  for (const name of ['drawElements', 'drawArrays',
                      'drawElementsInstanced', 'drawArraysInstanced']) {
    if (typeof gl[name] !== 'function') continue;
    const orig = gl[name].bind(gl);
    gl[name] = function (...args) {
      orig(...args);
      if (gl.getError() === INVALID_OP) errs++;
    };
    instrumented.push([name, orig]);
  }
  const restoreGL = () => { for (const [n, f] of instrumented) gl[n] = f; };

  const FRAMES = 12;
  function measure() {
    return new Promise(res => {
      errs = 0; let n = 0;
      const tick = () => (++n >= FRAMES) ? res(errs) : requestAnimationFrame(tick);
      requestAnimationFrame(tick);
    });
  }

  const label = o =>
    `${o.name || '(unnamed)'} <${o.type}>` +
    (o.material && o.material.type ? ` mat=${o.material.type}` : '');

  // does this object's material sample a texture that is a render-target
  // attachment? those are the only objects that CAN form a feedback loop.
  function samplesRT(o) {
    const mats = !o.material ? [] : (Array.isArray(o.material) ? o.material : [o.material]);
    for (const m of mats) {
      const u = m && m.uniforms;
      if (!u) continue;
      for (const k in u) {
        const v = u[k] && u[k].value;
        if (v && v.isTexture && v.__isRT) return k;
      }
    }
    return null;
  }
  // tag every texture that belongs to a WebGLRenderTarget we can find
  for (const key of ['__water']) {
    const w = window[key];
    if (w && w.mirror && w.mirror.rt) w.mirror.rt.texture.__isRT = 'mirror.rt';
  }

  // ---- baseline ------------------------------------------------------
  const base = await measure();
  log(`baseline feedback errors over ${FRAMES} frames:`, base);
  if (base === 0) {
    restoreGL();
    return log('No feedback errors here. Scroll to where the warnings appear '
             + '(~880vh) and run again.');
  }

  // ---- coarse pass: top-level children -------------------------------
  const results = [];
  const kids = scene.children.slice();
  log(`testing ${kids.length} top-level children...`);
  for (const o of kids) {
    if (!o.visible) continue;
    o.visible = false;
    const n = await measure();
    o.visible = true;
    results.push({ obj: o, errs: n });
    if (n < base * 0.5) log(`  ${label(o)} -> ${n}  <-- big drop`);
  }
  results.sort((a, b) => a.errs - b.errs);

  log('--- COARSE RESULT (lowest = most likely culprit) ---');
  for (const r of results.slice(0, 6)) log(`  ${r.errs}\t${label(r.obj)}`);

  const winner = results[0];
  if (!winner || winner.errs >= base) {
    restoreGL();
    return log('No single top-level child accounts for it. It is likely an '
             + 'auxiliary render (mirror / refraction / volumetric) rather '
             + 'than one object -- report this output.');
  }

  // ---- fine pass: walk into the winning branch -----------------------
  log(`--- DRILLING INTO ${label(winner.obj)} ---`);
  const inner = [];
  winner.obj.traverse(o => { if (o.isMesh || o.isPoints) inner.push(o); });
  log(`  ${inner.length} drawables inside`);

  const hits = [];
  for (const o of inner.slice(0, 60)) {
    if (!o.visible) continue;
    o.visible = false;
    const n = await measure();
    o.visible = true;
    if (n < base * 0.5) {
      const rt = samplesRT(o);
      hits.push({ o, n, rt });
      log(`  CULPRIT? ${label(o)} -> ${n}` + (rt ? `  samples RT via "${rt}"` : ''));
    }
  }

  log('=== SUMMARY ===');
  log('baseline:', base);
  log('top-level culprit:', label(winner.obj), '->', winner.errs);
  if (hits.length) {
    for (const h of hits) log('  mesh:', label(h.o), '->', h.n,
                              h.rt ? `(samples ${h.rt})` : '');
  } else {
    log('  no single inner mesh isolated it -- the branch as a whole is '
      + 'implicated, or it only loops in combination.');
  }
  log('Objects sampling the mirror target (these are the ones that can loop '
    + 'if drawn during mirror.render):');
  scene.traverse(o => { const k = samplesRT(o); if (k) log('   ', label(o), k); });

  restoreGL();
  log('done -- GL restored, all visibility restored.');
})();
