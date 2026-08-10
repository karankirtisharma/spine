/* Scroll-range arithmetic for the five-section split.
 *
 * This runs with no browser and no three.js, and it is the gate for the whole
 * restructure. The claim it proves is the reason the restructure is safe at all:
 *
 *   With sections [Land 105, Drift 140, Gather 140, Burst 140, Work 1050] the
 *   track is 1575vh. A 100vh viewport leaves 1475vh of travel. Work starts at
 *   525vh, so its span is 1475 - 525 = 950vh -- which is EXACTLY the span of the
 *   previous three-section table ([Home 420, About 105, Work 1050], same 1575vh
 *   track, same 525vh lead-in) and EXACTLY the original single-section travel
 *   (1050vh track - 100vh viewport). Work's local progress is therefore
 *   bit-identical to the numerically-proven baseline, just shifted in origin.
 *
 * Because the remap is affine and lerp commutes with affine maps, the existing
 * triple-eased chain (Lenis -> smoothProgress 0.28 -> scrollDelta 0.12) produces
 * the same numbers either side of the change. Nothing about section 5 needs to be
 * re-tuned.
 *
 * The off-by-one this is really guarding against is using `len` instead of
 * `min(start + len, travel) - start` for the last section's span. That silently
 * compresses the camera rail and would be very hard to spot in a screenshot.
 *
 *   node test/ranges.mjs
 */

const VIEWPORT = 100;                    // vh
const LENGTHS = { land: 105, drift: 140, gather: 140, burst: 140, work: 1050 };

let failures = 0;
function check(name, actual, expected, tol = 0) {
  const ok = tol === 0 ? actual === expected : Math.abs(actual - expected) <= tol;
  if (!ok) { failures++; console.error(`FAIL  ${name}\n        got ${actual}\n        want ${expected}${tol ? ` (+-${tol})` : ''}`); }
  else console.log(`ok    ${name}  = ${actual}`);
}

/* The range table, exactly as src/sections.js must compute it. Kept duplicated
 * here on purpose: if the two ever disagree, this test is the specification. */
function buildRanges(lengths, viewport) {
  const total = lengths.land + lengths.drift + lengths.gather + lengths.burst + lengths.work;
  const travel = total - viewport;
  const order = ['land', 'drift', 'gather', 'burst', 'work'];
  const out = {};
  let cursor = 0;
  for (const name of order) {
    const start = cursor;
    // clamp to travel so the last section cannot run past the end of the scroll
    const end = Math.min(start + lengths[name], travel);
    out[name] = { startVh: start, endVh: end, spanVh: end - start };
    cursor += lengths[name];
  }
  return { total, travel, ranges: out };
}

const { total, travel, ranges } = buildRanges(LENGTHS, VIEWPORT);

console.log('--- track geometry');
check('track total (vh)', total, 1575);
check('scrollable travel (vh)', travel, 1475);

console.log('\n--- section spans (vh)');
check('land.startVh', ranges.land.startVh, 0);
check('land.spanVh', ranges.land.spanVh, 105);
check('drift.startVh', ranges.drift.startVh, 105);
check('drift.spanVh', ranges.drift.spanVh, 140);
check('gather.startVh', ranges.gather.startVh, 245);
check('gather.spanVh', ranges.gather.spanVh, 140);
check('burst.startVh', ranges.burst.startVh, 385);
check('burst.spanVh', ranges.burst.spanVh, 140);
check('work.startVh', ranges.work.startVh, 525);
/* THE load-bearing assertion. 950 is the baseline travel, so Work is unchanged. */
check('work.spanVh === baseline travel', ranges.work.spanVh, 950);
check('baseline travel for reference', LENGTHS.work - VIEWPORT, 950);

console.log('\n--- Work local progress is bit-identical to the baseline global progress');
const B4 = ranges.work.startVh / travel;
check('B4 (work start as fraction)', B4, 525 / 1475, 0);

let worstErr = 0;
for (let k = 0; k <= 950; k++) {
  // new: absolute scroll of (525 + k)vh, remapped into Work-local
  const p = (ranges.work.startVh + k) / travel;
  const local = (p - B4) / (1 - B4);
  // old: the same k vh into a 950vh travel
  const old = k / 950;
  worstErr = Math.max(worstErr, Math.abs(local - old));
}
check('max |work_local - old_progress| over 951 samples', worstErr <= 4e-16, true);
console.log(`      worst error = ${worstErr.toExponential(3)} (float64 epsilon territory)`);

console.log('\n--- remap is affine, so it commutes with the easing chain');
/* If W(x) = (x - b)/(1 - b) then W(lerp(p, q, k)) === lerp(W(p), W(q), k).
 * That is why easing the global scalar and then remapping gives the same answer
 * as remapping and then easing -- and therefore why the 0.28 / 0.12 filters and
 * the 0.06 dead zone need no adjustment. */
const W = x => (x - B4) / (1 - B4);
const lerp = (a, b, k) => a + (b - a) * k;
let commuteErr = 0;
for (let i = 0; i <= 40; i++) {
  const p = 0.36 + (i / 40) * 0.64, q = p * 0.9 + 0.05, k = (i % 7) / 7;
  commuteErr = Math.max(commuteErr, Math.abs(W(lerp(p, q, k)) - lerp(W(p), W(q), k)));
}
check('max affine-commute error', commuteErr <= 1e-15, true);
console.log(`      worst error = ${commuteErr.toExponential(3)}`);

console.log('\n--- boundaries partition the range with no gap or overlap');
check('land.end === drift.start', ranges.land.endVh, ranges.drift.startVh);
check('drift.end === gather.start', ranges.drift.endVh, ranges.gather.startVh);
check('gather.end === burst.start', ranges.gather.endVh, ranges.burst.startVh);
check('burst.end === work.start', ranges.burst.endVh, ranges.work.startVh);
check('work.end === travel', ranges.work.endVh, travel);

console.log('\n--- the off-by-one this exists to catch');
/* Using the raw length for the last section instead of clamping to travel gives
 * 1050 rather than 950 -- a 10.5% longer rail, i.e. the camera would never reach
 * the final waypoint. Assert the naive version really is wrong, so the guard is
 * not silently removed later. */
check('naive (unclamped) work span would be wrong', LENGTHS.work !== ranges.work.spanVh, true);

console.log(failures === 0
  ? '\nPASS  all range assertions hold\n'
  : `\nFAIL  ${failures} assertion(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
