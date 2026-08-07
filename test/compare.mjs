/* Compares a scroll sweep against test/baseline.json.
 *
 *     node test/compare.mjs test/after.json
 *
 * The baseline was captured on the single-section track (1050vh) before the split.
 * Both files are keyed by vh-from-the-start-of-Work, so a section added ahead of
 * Work shifts the absolute scroll but must not move any of these numbers.
 *
 * `progress` is NOT compared: the baseline's is global-on-a-1050vh-track, the new
 * one is global-on-a-1575vh-track. Work-local progress is what has to match, and
 * test/ranges.mjs already proves that algebraically to 3.3e-16. What this file
 * checks is the part algebra cannot: that the camera rail, the cull pattern and the
 * shader uniforms all land where they used to.
 */
import fs from 'node:fs';

const AFTER = process.argv[2] || 'test/after.json';
const BASE = 'test/baseline.json';

for (const f of [AFTER, BASE]) {
  if (!fs.existsSync(f)) { console.error(`missing ${f}`); process.exit(1); }
}
const after = JSON.parse(fs.readFileSync(AFTER, 'utf8'));
const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));

console.log(`baseline track ${base.trackVh}vh  ->  now ${after.trackVh}vh` +
            `  (Work at +${after.offsetVh ?? '?'}vh)\n`);

/* The camera is triple-eased, so exact equality is not the bar. Drift past these
 * means the rail itself moved, which is the regression this exists to catch. */
const TOL = { pos: 0.02, quat: 0.002, scalar: 0.002 };
const near = (a, b, t) => Math.abs(a - b) <= t;
let failures = 0, compared = 0;

for (const s of after.samples) {
  const b = base.samples.find(x => x.workVh === s.workVh);
  if (!b) { console.warn(`skip ${s.workVh}vh -- no baseline`); continue; }
  compared++;
  const bad = [];
  s.camPos.forEach((v, i) => { if (!near(v, b.camPos[i], TOL.pos)) bad.push(`camPos[${i}] ${b.camPos[i]} -> ${v}`); });
  s.camQuat.forEach((v, i) => { if (!near(v, b.camQuat[i], TOL.quat)) bad.push(`camQuat[${i}] ${b.camQuat[i]} -> ${v}`); });
  if (s.cull !== b.cull) bad.push(`cull ${b.cull} -> ${s.cull}`);
  if (s.fov !== b.fov) bad.push(`fov ${b.fov} -> ${s.fov}`);
  if (!near(s.camLocalZ, b.camLocalZ, TOL.scalar)) bad.push(`camLocalZ ${b.camLocalZ} -> ${s.camLocalZ}`);
  if (!near(s.fogDensity, b.fogDensity, TOL.scalar)) bad.push(`fogDensity ${b.fogDensity} -> ${s.fogDensity}`);
  if (!near(s.uScrollComposite, b.uScrollComposite, TOL.scalar)) bad.push(`uScrollComposite ${b.uScrollComposite} -> ${s.uScrollComposite}`);
  if (!near(s.uScrollFlowers, b.uScrollFlowers, TOL.scalar)) bad.push(`uScrollFlowers ${b.uScrollFlowers} -> ${s.uScrollFlowers}`);

  if (bad.length) { failures++; console.error(`FAIL ${String(s.workVh).padStart(4)}vh\n       ` + bad.join('\n       ')); }
  else console.log(`ok   ${String(s.workVh).padStart(4)}vh`);
}

/* Program count is reported, not asserted. It legitimately differs from the
 * baseline (the emblem no longer loads by default). What matters is that it is
 * CONSTANT across the sweep -- a rising count means a material is compiling
 * mid-scroll, which is the stall the section-root invariants exist to prevent. */
const progs = [...new Set(after.samples.slice(1).map(s => s.programs))];
console.log(`\nprograms across sweep: ${progs.join(', ')}` +
            (progs.length === 1 ? '  (constant -- no mid-scroll compiles)'
                                : '  <-- CHANGES MID-SCROLL, investigate'));
if (progs.length !== 1) failures++;

console.log(failures === 0
  ? `\nPASS  Work section unchanged across ${compared} sample points\n`
  : `\nFAIL  ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
