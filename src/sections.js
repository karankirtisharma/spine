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
export const SECTION_ORDER = ['land', 'drift', 'gather', 'burst',
                              'astro', 'nova', 'dust', 'grid',
                              'morph', 'deck', 'work'];

/**
 * Twelve reference keyframes recreated as eight scroll sections, then the spine:
 *
 *   Land   105vh   frame 1     the settled landing
 *   Drift  140vh   frame 2     the hero volume, sparse
 *   Gather 140vh   frame 3     the field gathering on the mark
 *   Burst  140vh   frame 4     the mark's flash
 *   Astro  340vh   frames 5-8  one continuous push-in on the Cyphernaut, the
 *                              coin as a halo behind the head -- four keyframes,
 *                              ONE camera move, exactly as drift/gather/burst are
 *                              one move across three sections
 *   Nova   150vh   frame 9     the detonation behind the figure
 *   Dust   220vh   frames 10-11  the drift through golden turbulence
 *   Grid   180vh   frame 12    the orbital-grid HUD lock-in
 *   Morph  340vh   frames 13-16  THE METAMORPHOSIS -- the spine consumes the
 *                              figure from the boots up while glass panels slide
 *                              in from both frame edges; four keyframes, one
 *                              continuous camera hold
 *   Deck   180vh   frame 17    the spine complete, six service cards settled
 *   Work  1050vh   the spine
 *
 * THE WORK INVARIANT SURVIVES THE INSERTION, and this is the arithmetic to check
 * before touching any number here. Lead-in is now 1415 + 520 = 1935vh, the track
 * 2985vh, travel 2885vh -- and Work's clamped span is 2885 - 1935 = 950vh, the
 * SAME 950 as the five-section table, the three-section table before it, and the
 * original single-section site. Work's local progress stays bit-identical to the
 * proven baseline; only its origin shifts, and the remap is affine so the easing
 * chain needs no re-tuning. test/ranges.mjs proves it numerically -- run it.
 */
export const SECTION_VH = { land: 105, drift: 140, gather: 140, burst: 140,
                            astro: 340, nova: 150, dust: 220, grid: 180,
                            morph: 340, deck: 180, work: 1050 };

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
