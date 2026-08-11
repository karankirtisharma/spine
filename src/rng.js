/* Seeded RNG — the prerequisite for any visual regression test on this scene.
 *
 * The scene calls into this ~83 times across 10 modules at build time: bed
 * scatter, per-instance randoms, comet strand jitter, texture painting. With
 * Math.random() the vegetation laid out differently on every load, so two
 * screenshots of the same commit never matched and "did this change the
 * picture?" was unanswerable. Everything downstream of that question — the
 * pixel-identical guarantee the organisation pass is built on — needs this.
 *
 * CALL ORDER IS PART OF THE OUTPUT. A PRNG is a stream: reordering two rand()
 * calls, or adding one, shifts every subsequent value and relays the whole
 * scene. That is why the substitution across the codebase was mechanical and
 * why no range, distribution or rejection loop was touched along with it.
 *
 * mulberry32: 32-bit state, one multiply-xorshift round. Fast enough to be
 * invisible at 100k+ calls during load, and its quality is far beyond what
 * scattering leaves requires.
 */

let _s = 0;

/** Reseed the stream. Any 32-bit integer. */
export function reseed(n) {
  _s = (n >>> 0) || 1;
}

/**
 * rand()      -> [0, 1)
 * rand(b)     -> [0, b)
 * rand(a, b)  -> [a, b)
 *
 * The zero-argument form is the drop-in for Math.random().
 */
export function rand(a, b) {
  _s |= 0; _s = (_s + 0x6D2B79F5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  if (a === undefined) return u;
  if (b === undefined) return u * a;
  return a + u * (b - a);
}

/**
 * An INDEPENDENT stream with its own state.
 *
 * Needed because the global stream is only deterministic for consumers that
 * run in a fixed order, and this scene has two async build chains — the cloud
 * chain (flower bake -> tree -> foliage) and the alcove decode (room meshes ->
 * growth -> canopy) — that race. Whichever resolves first takes the earlier
 * slice of the stream, so their layouts swapped between loads even at a fixed
 * seed while every COUNT stayed identical: the tell that the generator was
 * fine and the ordering was not.
 *
 * A subsystem that builds asynchronously takes one of these instead, keyed to
 * a constant, and is then reproducible no matter who finishes first.
 */
export function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function r(a, b) {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    if (a === undefined) return u;
    if (b === undefined) return u * a;
    return a + u * (b - a);
  };
}

/* The default seed, and the ?seed= override. A fixed default means a plain
 * page load is reproducible; the flag exists so a layout that reads badly can
 * be re-rolled deliberately rather than by refreshing until it looks right. */
const DEFAULT_SEED = 20260811;
const q = typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('seed') : null;
reseed(q !== null && q !== '' && Number.isFinite(+q) ? +q : DEFAULT_SEED);

export const SEED = q !== null && q !== '' && Number.isFinite(+q) ? +q : DEFAULT_SEED;
