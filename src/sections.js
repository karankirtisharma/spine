/* Scroll sections.
 *
 * One scalar of scroll progress is remapped into per-section local progress. That
 * is the whole mechanism -- there is no section framework, no per-section scene,
 * no camera ownership transfer. Five numbers in, five numbers out.
 *
 * WHY THIS IS SAFE FOR THE WORK SECTION
 *
 * With lengths [Land 105, Drift 140, Gather 140, Burst 140, Work 1050] the track
 * is 1575vh. A 100vh viewport leaves 1475vh of travel, and Work starts at 525vh,
 * so Work's span is 1475 - 525 = 950vh. That is EXACTLY the span of the previous
 * three-section table ([Home 420, About 105, Work 1050] -- same 1575vh track, same
 * 525vh lead-in) and EXACTLY the travel of the original single-section site (a
 * 1050vh track minus the 100vh viewport). Work's local progress is therefore
 * bit-identical to the numerically-proven baseline, only shifted in origin.
 *
 * The remap is affine, and lerp commutes with affine maps:
 *
 *     W(x) = (x - b) / (1 - b)
 *     W(lerp(p, q, k)) === lerp(W(p), W(q), k)
 *
 * so easing the global scalar and then remapping gives the same answer as
 * remapping and then easing. The existing triple-eased chain (Lenis, then 0.28,
 * then 0.12) and the 0.06 dead zone need no adjustment at all.
 *
 * test/ranges.mjs proves both claims numerically -- worst error 3.3e-16 over 951
 * samples. Run it before changing any length here.
 *
 * ----------------------------------------------------------------------------
 * THREE INVARIANTS FOR ANYTHING PUT INSIDE A TOGGLED SECTION ROOT
 *
 * All three were verified against vendor/three/build/three.module.js. Breaking any
 * of them produces a bug that is invisible in a screenshot.
 *
 *   1. NO LIGHTS inside a toggled subtree.
 *      projectObject early-returns on `object.visible === false`, so hiding a root
 *      removes its lights from the light list. Light counts are part of the
 *      program cache key, so the count changing forces a compile of a new program
 *      for every lit material -- on the 840k-triangle spine that is a visible
 *      stall. Create lights at scene level and drive their intensity instead.
 *      (This is why loadEmblem takes `rimLights: false`: it parents two
 *      PointLights into its own group by default.)
 *
 *   2. NEVER assign `scene.fog = null` or `scene.environment = null`.
 *      `fog: !!fog` is in the cache key and drives `#define USE_FOG`. Animate
 *      `fog.density` and `scene.environmentIntensity` toward 0 instead.
 *
 *   3. SECTION ROOTS STAY AT renderOrder 0.
 *      For a Group, `groupOrder = object.renderOrder` propagates to every
 *      descendant, and groupOrder is the FIRST key in both render sort comparators.
 *      A nonzero value on a root would silently override the card depth sort.
 *
 * A fourth, not a three.js rule but a rule here: set section visibility BEFORE the
 * refraction pass, so the snapshot the glass samples matches the frame on screen.
 */

/** Section order on the track. Index order is scroll order. */
export const SECTION_ORDER = ['land', 'drift', 'gather', 'burst', 'water', 'work'];

/**
 * Four reference keyframes recreated as four scroll sections, then the work spine:
 *   Land   105vh
 *   Drift  140vh
 *   Gather 140vh
 *   Burst  240vh
 *   Work  1050vh
 *
 * BURST WAS 140 AND IS NOW 240, and that is the only change to this table.
 *
 * The mark's beat in the deep -- settle centred, hold face-on, rise FULLY out
 * of frame -- is scroll-driven, so its duration IS its scroll length. At 140vh
 * the whole of burst after the blast clears was ~63vh, and a hold long enough
 * to read plus a rise slow enough to read plus enough travel to carry the
 * mark's tails past the top edge do not fit in it. Every vh of hold came
 * straight off the rise, which is why the rise sped up each time the hold grew
 * and why the tails were still hanging at the top of frame when the wipe
 * arrived. 240vh fits all three (see THE HOLD in main.js).
 *
 * DRIFT AND GATHER ARE UNAFFECTED, which was NOT true of a 320vh attempt and
 * is the reason for the pinning in main.js. hpF -- the camera's descent, deepF,
 * the grade floor, the mark's rotation, the blast -- is normalised over a FIXED
 * 420vh rather than over the volume's current length, so it advances at its
 * original rate through drift, gather and the blast, reaches 1 at the same
 * scroll position it always did, and pins there. Burst's extra 100vh is purely
 * a tail in which the environment has already come to rest and only the coin
 * moves. Lengthening burst again extends that tail and nothing else, which is
 * exactly what makes it a safe knob now -- see THE DESCENT in main.js.
 *
 * WORK IS UNAFFECTED TOO, which is the property this file exists to protect.
 * buildRanges clamps the last section's end to `travel`, and travel grows by
 * exactly what burst grew by, so:
 *
 *     work.start = 525 + extra     travel = 1475 + extra
 *     work.span  = travel - start  = 950, for any extra
 *
 * Work's local progress is therefore still bit-identical to the numerically
 * proven baseline, only shifted in origin -- the same argument as the original
 * table, now load-bearing rather than incidental. test/ranges.mjs asserts it
 * and passes; re-run it after any further change here.
 */
/* 380, up from 240: the filmed epilogue became scroll-SCRUBBED at the user's
 * call, and 13s of footage needs ~140vh of wheel to scrub at a natural pace.
 * Pure tail extension -- the descent is pinned to 420vh and the beat windows in
 * main.js are expressed in vh-from-burst-start, so nothing else moves. */
/* WATER, 140vh, between burst and work: the client's swamp still continued
 * below the deep's foliage (docs/water-section-plan.md). The work.span = 950
 * argument above survives ANY inserted length W: only the last section clamps,
 * travel grows by exactly W, so span = (1715+W) - (765+W) = 950. The descent
 * is equally untouched -- hpF pins at 525vh, far before water starts. */
export const SECTION_VH = { land: 105, drift: 140, gather: 140, burst: 380, water: 140, work: 1050 };

/**
 * Build the range table for a viewport height in vh (always 100 in practice --
 * it is a parameter so the test can drive it).
 *
 * The clamp on `end` is load-bearing: using the raw length for the final section
 * would give it 1050vh of span instead of 950vh, stretching the camera rail so it
 * never reaches the last waypoint. Easy to miss, hard to see.
 */
export function buildRanges(lengths = SECTION_VH, viewportVh = 100) {
  const total = SECTION_ORDER.reduce((s, k) => s + lengths[k], 0);
  const travel = total - viewportVh;
  const ranges = {};
  let cursor = 0;
  for (const name of SECTION_ORDER) {
    const startVh = cursor;
    const endVh = Math.min(startVh + lengths[name], travel);
    ranges[name] = {
      startVh, endVh, spanVh: endVh - startVh,
      start: startVh / travel,
      end: endVh / travel,
    };
    cursor += lengths[name];
  }
  return { totalVh: total, travelVh: travel, ranges };
}

/**
 * Per-section state for one global progress value.
 *
 * Returns, for every section:
 *   progress  0..1 across the section, clamped. Before the section this is 0,
 *             after it 1 -- so a section reading it while inactive sees a settled
 *             value rather than something wild.
 *   active    is the playhead inside this section's range
 *   visible   Active Theory's `visibleV`: how far the section has entered frame.
 *             Their Home camera z, its entrance rotation and both column
 *             `uVisible` uniforms all read this, not `progress`.
 *
 *             INTERPRETATION, flagged as such: their engine derives visibleV from
 *             an FXScene's on-screen coverage, which has no analogue in a
 *             single-scene setup. Here it ramps 0..1 across the leading `enterVh`
 *             of the section and holds at 1 for the remainder. That reproduces the
 *             observable behaviour -- entrance eases in, then stops mattering --
 *             without inventing a second scroll model.
 */
export function sectionState(progress, table = buildRanges(), enterVh = 100) {
  const { travelVh, ranges } = table;
  const out = {};
  for (const name of SECTION_ORDER) {
    const r = ranges[name];
    const span = Math.max(1e-9, r.end - r.start);
    const local = Math.min(1, Math.max(0, (progress - r.start) / span));
    const enter = Math.min(1, Math.max(0, ((progress - r.start) * travelVh) / enterVh));
    out[name] = {
      progress: local,
      active: progress >= r.start && progress < r.end,
      visible: enter,
      range: r,
    };
  }
  /* The last section stays active at the very end of the track, otherwise the
   * final frame has no active section and everything hides. */
  const last = ranges[SECTION_ORDER[SECTION_ORDER.length - 1]];
  if (progress >= last.end) out[SECTION_ORDER[SECTION_ORDER.length - 1]].active = true;
  return out;
}

/* Boundary handling lives in src/transition.js, not here.
 *
 * An earlier version of this file exported a `boundaryFade` that dipped the frame
 * toward black through a narrow band at each seam, so the camera could cut between
 * rigs inside the dark. That was a substitute for what Active Theory actually
 * does, and it has been replaced by the real thing: FXScrollTransition.glsl, an
 * inclined anti-aliased seam sweeping between two scenes rendered in the same
 * frame, with the edge warped by a scrolling normal map. See transitionState()
 * there for the band arithmetic. */
