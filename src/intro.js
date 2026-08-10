/* The hero intro — five phases, one continuous timeline.
 *
 *   1  Idle          0.0 – 2.0s   near-black, sparse drift, mark centred, no bloom
 *   2  Gathering     2.0 – 3.5s   particles start moving inward, soft fog, faint halo
 *   3  Compression   3.5 – 4.5s   density collapses toward centre, camera pushes in
 *   4  Burst         4.5 – 5.0s   white-blue core flash, shockwave, particles thrown out
 *   5  Reveal        5.0s +       the flash fades into the interface
 *
 * The brief this implements is explicit that the phases must be DISTINGUISHABLE and
 * that the burst must feel earned rather than continuous. Two consequences shape the
 * whole file:
 *
 *   - Every curve is flat during phase 1. Not "small" -- flat. A slow ramp from t=0
 *     is what makes an intro read as a constant particle show with no beginning, and
 *     it is specifically what this replaces.
 *   - Peak brightness is a 300ms window inside phase 4, with an asymmetric envelope:
 *     roughly 120ms of rise and 180ms of fall. A symmetric flash reads as a pulse; a
 *     fast attack with a slower decay reads as a detonation.
 *
 * WALL CLOCK, not accumulated dt. The frame loop clamps dt to 0.05, so on a slow
 * first paint -- which is exactly when this plays -- accumulation runs at half real
 * time or worse and the timing collapses. Same reason the entrance ramp this replaces
 * was moved off dt.
 *
 * Deliberately independent of scroll. The intro is a fixed-duration film that plays
 * once on load; Home's scroll progress drives the camera rail on top of it. They
 * compose rather than compete, so scrolling during the intro does not fight it.
 */

const P1_END = 2.0;
const P2_END = 3.5;
const P3_END = 4.5;
const P4_END = 5.0;

const clamp01 = x => Math.min(1, Math.max(0, x));
const smooth = x => { const t = clamp01(x); return t * t * (3 - 2 * t); };
// ease-out cubic: fast departure, long settle — for anything expanding outward
const easeOut = x => 1 - Math.pow(1 - clamp01(x), 3);
// ease-in quart: almost nothing, then a rush — for the compression squeeze
const easeIn = x => Math.pow(clamp01(x), 4);

/**
 * Sample the timeline.
 *
 * @param elapsed seconds since the intro started (loader dismissal), or null before
 * @returns all of the intro's drive values for this instant
 */
export function introState(elapsed) {
  // before the loader clears: hold phase 1's opening frame, do not run
  const e = elapsed == null ? 0 : elapsed;

  const p1 = clamp01(e / P1_END);
  const p2 = clamp01((e - P1_END) / (P2_END - P1_END));
  const p3 = clamp01((e - P2_END) / (P3_END - P2_END));
  const p4 = clamp01((e - P3_END) / (P4_END - P3_END));
  const post = Math.max(0, e - P4_END);

  const phase = e < P1_END ? 1 : e < P2_END ? 2 : e < P3_END ? 3 : e < P4_END ? 4 : 5;

  /* The flash. 300ms of peak inside phase 4's 500ms, asymmetric: rise over the
   * first 24% of the phase, hold, then fall away over the last 36%. */
  const flash = p4 <= 0 ? 0
    : p4 < 0.24 ? easeOut(p4 / 0.24)
    : p4 < 0.64 ? 1
    : 1 - smooth((p4 - 0.64) / 0.36);

  /* The shockwave radius, in world units from the mark. Starts at the instant of
   * the flash and keeps expanding through phase 5 -- the ring outlives the light,
   * which is what sells it as a wave rather than a glow. */
  const shock = p4 <= 0 ? 0 : easeOut(Math.min(1, (p4 * 0.5 + post * 0.55) / 1.0));

  return {
    phase,
    /* Inward pull on the particle field. Zero through phase 1, eased in across
     * phase 2, hard squeeze in phase 3, then released -- the release is what lets
     * the burst throw the field outward instead of fighting the attractor. */
    attract: p2 * 0.45 * (1 - p4) + easeIn(p3) * 0.55 * (1 - p4),

    /* Field opacity. Sparse in phase 1 by design ("very sparse floating green
     * particles", "large negative space"), gathering through 2 and 3, and briefly
     * pushed above its resting level by the burst. */
    density: 0.16 + smooth(p2) * 0.24 + easeIn(p3) * 0.3 + flash * 0.3,

    /* Volumetric fog and god rays. "Avoid excessive fog before Phase 3" -- so this
     * is flat through phase 1, barely present in 2, and only becomes a real
     * presence as the compression starts. */
    fog: smooth(p2) * 0.18 + easeIn(p3) * 0.5 + flash * 0.9,

    /* Bloom. "Almost no bloom" in phase 1, and the phase-4 term is what makes the
     * burst read as light rather than as more particles. */
    bloom: 0.1 + smooth(p2) * 0.22 + easeIn(p3) * 0.35 + flash * 1.5,

    /* Camera push, in world units toward the mark. Phase 1 is "almost perfectly
     * still", so this does nothing until phase 3, then eases in. The burst adds a
     * small kick back -- the recoil is what makes the explosion feel physical. */
    push: easeIn(p3) * 3.2 - flash * 1.1,

    /* Halo on the mark itself: a faint ring in phase 2 ("very subtle halo"), rising
     * into the core flash. */
    halo: smooth(p2) * 0.25 + easeIn(p3) * 0.45 + flash * 1.0,

    flash,
    shock,

    /* Interface reveal, driven off the flash's decay so the UI arrives inside the
     * light rather than after it. Reaches 1 about 700ms past the burst. */
    reveal: smooth(post / 0.7),

    /* Stands in for the old `homeVisible`: how much of the scene exists at all --
     * the camera's dolly in from z -30, the mark's 210-degree unwind, the tails
     * rising from below.
     *
     * 0.8s, NOT the full 2s of phase 1. Spread across the whole phase it is still
     * mid-unwind at t=1.0 and the mark is edge-on, so phase 1 never actually shows
     * the settled idle frame the brief asks for. Landing it early means the rest of
     * phase 1 IS that frame: still camera, sparse drift, mark centred and readable. */
    visible: smooth(clamp01(e / 0.8)),
  };
}

export const INTRO_DURATION = P4_END;

/**
 * SCROLL-DRIVEN drives for the hero volume — the current model.
 *
 * The four reference keyframes became four scroll SECTIONS (land, drift, gather,
 * burst), so the story this file used to play on a 5-second timer now plays on the
 * scroll bar: image 2 is the drift section's resting look, image 3 is gather's,
 * image 4 is burst's. The curves are the time-based ones above re-expressed in the
 * three sections' local progress; the timed introState is kept for reference and no
 * longer drives anything.
 *
 * The one structural difference from the timer: a scroll section is a PLACE the
 * user can park in, not a moment that passes. So burst's flash cannot be a spike
 * pinned at full — it rises across the first third of the section, holds, and has
 * decayed to nothing by 85%, which leaves the section's tail calm for the wipe
 * into the work spine. Parking mid-burst parks you inside the explosion, which is
 * exactly what reference image 4 is.
 */
export function heroDrives(driftP, gatherP, burstP) {
  /* The flash is a PULSE crossed on the way in, not the section's resting state.
   * It used to hold at 1 through 55-85% -- authored when burst WAS the explosion
   * frame. The section now parks in the vegetated room around the coin, and the
   * reference for that frame has a readable ring, dark foliage masses and
   * restrained bloom; a held white ball is incompatible with all three. Peak at
   * 12-22%, gone by 45%, so the room reveals out of the light's decay. */
  /* 0.42 peak, not 1.0. The full-strength pulse was authored when this section
   * WAS the explosion; it now arrives in a calm deep forest, and a white-out
   * across that frame reads as a glitch between two scenes rather than as a
   * beat inside one shot. At 0.42 it is light breaking through the canopy as
   * the eye drops past it -- present, but the environment stays legible
   * through it, which is what makes the descent continuous. */
  const flash = (burstP <= 0 ? 0
    : burstP < 0.12 ? easeOut(burstP / 0.12)
    : burstP < 0.22 ? 1
    : Math.max(0, 1 - smooth((burstP - 0.22) / 0.23))) * 0.42;
  const shock = burstP <= 0 ? 0 : easeOut(Math.min(1, burstP / 0.9));

  return {
    /* Inward pull: begins late in drift, full through gather, released by the
     * flash -- and KEPT released by the shockwave. (1 - flash) alone re-engaged
     * the attractor once the flash decayed, which re-knotted the whole field
     * into a bright ball at the mark for the rest of the section. */
    attract: (0.2 * smooth(clamp01((driftP - 0.6) / 0.4))
            + 0.5 * smooth(gatherP)) * (1 - Math.max(flash, shock)),
    density: 0.16 + 0.24 * smooth(gatherP) + 0.3 * flash,
    fog: 0.15 * smooth(clamp01((driftP - 0.5) * 2)) + 0.5 * smooth(gatherP) + 0.9 * flash,
    /* Bloom floor 0.35: image 2 is near-black with almost no glow. */
    bloom: 0.35 + 0.4 * smooth(gatherP) + 1.5 * flash,
    push: 3.2 * easeIn(gatherP) - 1.1 * flash,
    halo: 0.25 * smooth(gatherP) + flash,
    /* The nebula formation (image 3). Faint in the flash so the explosion reads
     * over it rather than through it. */
    nebula: smooth(gatherP) * (1 - 0.4 * flash),
    flash,
    shock,
  };
}

/**
 * The pre-intro steady state, for `?intro=off`.
 *
 * Every drive held at the value it had before this file existed, so the flag really
 * is a bypass rather than a different look: density 0.16 makes the plume alpha
 * multiplier exactly 1, fog and bloom at 1 leave their authored strengths alone, and
 * push 0 leaves the camera on Active Theory's own numbers. `visible` keeps the 1.8s
 * entrance ramp it replaced.
 *
 * This exists because phases 3 to 5 currently render the frame black and the cause is
 * not yet found. Shipping the timeline on by default would mean shipping a black
 * screen; deleting it would throw away work that is nearly right. Off by default,
 * `?intro=1` to work on it.
 */
export function introBypass(elapsed) {
  return {
    phase: 5,
    attract: 0, shock: 0,
    density: 0.16, fog: 1, bloom: 1, push: 0, halo: 0,
    flash: 0, reveal: 1,
    visible: smooth(clamp01((elapsed ?? 0) / 1.8)),
  };
}
