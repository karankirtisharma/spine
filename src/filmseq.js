import * as THREE from 'three';

/* The deep's filmed epilogue as a SCROLL-SCRUBBED IMAGE SEQUENCE.
 *
 * This replaces a <video> + currentTime scrub, and the reason is measured, not
 * stylistic. On this machine, seeking a 1440p60 H.264 file costs:
 *
 *     19.6ms median forward, 16-30ms reverse   (keyframe every 3 frames)
 *     18.0ms median forward, 29.7ms reverse    (keyframe every 6)
 *
 * Tripling the keyframe density cost 25MB and bought almost nothing forward,
 * which is the tell: the cost is not keyframe distance, it is the browser's
 * seek pipeline itself -- demux, flush, decode, dispatch 'seeked'. A 60fps
 * frame is 16.7ms, so a seek-driven scrub simply cannot hold 60fps; it tops
 * out near 50 and stutters on reversal, which is what "not as smooth as the
 * rest of the site" was.
 *
 * A frame sequence has no seek step at all. Measured on the same machine:
 *
 *     11.2ms   cold decode of a 1920x1080 WebP  (createImageBitmap)
 *     ~0ms     swap of an ALREADY-decoded frame (a texture rebind)
 *
 * So the cache below is the whole design: keep a window of decoded frames
 * around the playhead, prefetch in the direction of travel, and the common
 * case is a zero-cost rebind. Even a total cache miss (11ms) still lands
 * inside the frame budget the video seek was blowing.
 *
 * IT IS ALSO HIGHER QUALITY. These are the Topaz upscale's own 24fps frames.
 * The video build had to be motion-interpolated to 60fps to give the scrub
 * enough distinct frames to land on -- inventing 468 frames that were never
 * shot. A scrub does not need temporal fps, it needs frames per unit of
 * SCROLL: 315 frames across 140vh is 0.44vh per frame, finer than one wheel
 * notch, so every frame the eye sees is a real Topaz frame.
 *
 * SIZE: 315 x ~122KB = ~38MB, against 40.8MB for the 1440p60 video it
 * replaces. Cheaper on the wire and strictly better on screen.
 *
 * MEMORY is the one real cost and why this is a windowed cache rather than a
 * preloaded array: a decoded 1920x1080 frame is 8.3MB, so all 315 at once
 * would be 2.6GB. The blobs stay compressed (38MB, all of them, forever) and
 * only CACHE_MAX frames are ever decoded -- 48 x 8.3MB = ~400MB peak, with
 * the LRU tail explicitly .close()d so the memory actually comes back rather
 * than waiting on GC.
 */

const FRAME_COUNT = 315;
const PATH = i => `assets/deep-bg/f_${String(i + 1).padStart(4, '0')}.webp`;
/* Decoded-frame ceiling. 48 frames is ~21vh of scroll at 0.44vh/frame -- more
 * lookahead than a single wheel gesture covers, so the window keeps up. */
/* 64 decoded frames: the live scrub window PLUS the sparse skeleton below.
 * Deliberately modest all the same, and the reason is measured: a 96-frame
 * window of full-size bitmaps was ~800MB resident and the browser stalled
 * for whole seconds under that pressure. At display size (below), 64 is
 * ~230MB, which stays smooth. */
const CACHE_MAX = 64;
/* THE SKELETON: every 8th frame pre-decoded as soon as the bytes land, so
 * every point of the 315-frame span has a cached frame within 4 of it
 * before the section is ever entered. With the nearest-cached fallback in
 * setProgress this makes the two visible glitches structurally impossible:
 * the cold entry (the placeholder showing until the first decode lands)
 * and the freeze-then-jump when a gesture outruns the decoder. */
const SKELETON_STRIDE = 8;
/* how far the fallback searches for a substitute -- covers the skeleton
 * spacing with margin; 10 frames is 4.4vh of scroll, beneath notice */
const FALLBACK_RANGE = 10;
/* How many steps ahead to keep warm. Combined with the stride below this
 * covers roughly the next 8 rAFs at whatever speed the wheel is running,
 * which is lookahead measured in TIME rather than in frames -- the thing
 * that actually has to stay ahead of the eye. */
const LOOKAHEAD_FRAMES = 8;
/* Concurrent createImageBitmap calls. Three keeps the decoder busy without
 * letting a flick queue hundreds of jobs and block the main thread. */
const MAX_INFLIGHT = 3;

export function buildFilmSequence() {
  const blobs = new Array(FRAME_COUNT).fill(null);
  const cache = new Map();          // index -> ImageBitmap (insertion order = LRU)
  const decoding = new Set();       // in-flight, so we never double-decode
  let loaded = 0;
  let lastDir = 1;
  /* eased frames-per-rAF, drives the prefetch window -- see setProgress */
  let speed = 0;
  const stats = { calls: 0, hits: 0, misses: 0, decodes: 0, maxGap: 0, fallbacks: 0,
    get missRate() { return this.calls ? +(this.misses / this.calls).toFixed(3) : 0; },
    reset() { this.calls = this.hits = this.misses = this.maxGap = 0;
              this.decodes = this.fallbacks = 0; } };

  /* A 1x1 placeholder so the material is valid before frame 0 arrives -- a
   * null map would compile a different program and swap it later, which is a
   * shader recompile mid-scroll. */
  const texture = new THREE.Texture(
    new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  /* flipY OFF, and the flip happens at DECODE instead (imageOrientation in
   * createImageBitmap below). WebGL's UNPACK_FLIP_Y_WEBGL is ignored for
   * ImageBitmap sources by spec -- three.js documents that flipY does nothing
   * for them -- so leaving the default true renders every frame upside down,
   * which is exactly how this shipped the first time. The VideoTexture this
   * replaced flipped implicitly, which is why the bug only appeared with the
   * sequence. */
  texture.flipY = false;
  texture.needsUpdate = true;

  /* Fetch every frame's COMPRESSED bytes once. 38MB total, and it is the
   * cheap half -- blobs are not decoded, so this costs bandwidth and almost
   * no memory pressure. Kicked off at construction: the deep is ~525vh of
   * scroll away, which is far more time than this needs. */
  let preloadDone = null;
  function preload() {
    if (preloadDone) return preloadDone;
    preloadDone = Promise.all(
      Array.from({ length: FRAME_COUNT }, (_, i) =>
        fetch(PATH(i))
          .then(r => r.blob())
          .then(b => { blobs[i] = b; loaded++; })
          .catch(() => { /* a missing frame just holds the previous one */ })))
      .then(() => {
        /* the skeleton -- see SKELETON_STRIDE. Queued through the bounded
         * decoder, and the queue survives untouched until the section is
         * entered (setProgress owns it only while the film is live), so
         * this drains in the background at 3-at-a-time long before the
         * playhead arrives. */
        for (let i = 0; i < FRAME_COUNT; i += SKELETON_STRIDE) want(i);
        want(FRAME_COUNT - 1);            // the parked frame under the seam
        pump();
      });
    return preloadDone;
  }

  function evict() {
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      const bmp = cache.get(oldest);
      cache.delete(oldest);
      /* explicit release -- ImageBitmap is not reclaimed promptly otherwise,
       * and at 8.3MB a frame the drift is measured in hundreds of MB */
      if (bmp && bmp.close) bmp.close();
    }
  }

  /* Decode size, resolved once against the real canvas. The plane is
   * cover-fit to the viewport, so decoding the full 1920x1080 when the
   * canvas is ~1270 CSS px wide pays for pixels no one can see -- twice
   * over, in decode time and in the per-swap GPU upload. Sizing to the
   * display cuts both by the area ratio (~2.3x here) and is the single
   * biggest reason the scrub got smooth. Capped at the source so a 4K
   * display just gets the native frame. */
  let decW = 0, decH = 0;
  function decodeSize() {
    if (decW) return;
    const want = Math.round(Math.min(1920,
      Math.max(960, (window.innerWidth || 1280) * (window.devicePixelRatio || 1))));
    decW = want;
    decH = Math.round(want * 1080 / 1920);
  }

  /* THE DECODE QUEUE. Bounded concurrency, nearest-frame-first.
   *
   * Firing every wanted frame at createImageBitmap the moment it is wanted
   * looks fine at a slow scrub and collapses on a flick: a velocity-scaled
   * window queued ~380 decodes across 45 frames, the decoder saturated, and
   * frames took TWO SECONDS. Measured, not guessed. The queue fixes the
   * shape of the problem rather than the size of the window -- work is
   * capped per moment, and because the queue is rebuilt in priority order
   * every call, the frames the eye is about to need are always at its head
   * while stale requests from a gesture that already moved on are dropped. */
  let queue = [];
  let inflight = 0;

  function startDecode(i) {
    if (cache.has(i) || decoding.has(i) || !blobs[i]) return;
    decodeSize();
    decoding.add(i);
    inflight++;
    stats.decodes++;
    /* the flip lives here -- see texture.flipY above */
    createImageBitmap(blobs[i], {
      imageOrientation: 'flipY',
      resizeWidth: decW, resizeHeight: decH, resizeQuality: 'medium',
    }).then(bmp => {
      decoding.delete(i); inflight--;
      /* re-check: a slow decode may land after its frame was evicted-by-scroll */
      if (cache.has(i)) { bmp.close && bmp.close(); return; }
      cache.set(i, bmp);
      evict();
      pump();
    }).catch(() => { decoding.delete(i); inflight--; pump(); });
  }

  function pump() {
    while (inflight < MAX_INFLIGHT && queue.length) startDecode(queue.shift());
  }

  /** Queue `i` if it is worth having. Order of calls IS the priority. */
  function want(i) {
    if (i < 0 || i >= FRAME_COUNT) return;
    if (cache.has(i) || decoding.has(i) || !blobs[i]) return;
    queue.push(i);
  }

  /* Touch = mark as most-recently-used, so the window slides with the
   * playhead instead of evicting the frame we are actually showing. */
  function touch(i) {
    const bmp = cache.get(i);
    if (bmp) { cache.delete(i); cache.set(i, bmp); }
    return bmp;
  }

  /**
   * Show the frame at normalized position t (0..1). Called once per frame from
   * the render loop. Returns true if a real frame is on screen.
   */
  function setProgress(t) {
    const idx = Math.max(0, Math.min(FRAME_COUNT - 1,
      Math.round(t * (FRAME_COUNT - 1))));
    let gap = 0;
    if (idx !== setProgress._last) {
      gap = Math.abs(idx - setProgress._last);
      lastDir = idx >= setProgress._last ? 1 : -1;
      setProgress._last = idx;
      /* Eased estimate of how many frames a wheel gesture is covering per
       * rAF. The prefetch window is sized from THIS rather than from a
       * constant: a slow scrub needs a couple of frames of lookahead, a
       * flick needs dozens, and a fixed 6 meant every fast gesture ran off
       * the end of the cache and stalled on cold decodes -- which is what
       * "laggy and jittery" was. Eased so one big jump does not blow the
       * window open permanently. */
      speed = speed * 0.75 + gap * 0.25;
    } else {
      speed *= 0.96;                     // parked: let the window relax
    }
    const bmp = touch(idx);
    /* THE FALLBACK: never freeze waiting for the exact frame. At 0.44vh of
     * scroll per frame a neighbour within FALLBACK_RANGE is visually the
     * same moment, so a miss shows the nearest cached frame -- searched
     * BEHIND the travel direction first, because a frame just passed is
     * both likelier to be warm and motion-continuous -- while the real one
     * decodes. Freeze-then-jump was the client's "glitch": the film held a
     * stale frame for the whole decode, then leapt. Substitution makes the
     * miss invisible instead of making the viewer wait it out. */
    let show = bmp;
    if (!show) {
      for (let k = 1; k <= FALLBACK_RANGE && !show; k++) {
        show = cache.get(idx - k * lastDir) || cache.get(idx + k * lastDir);
      }
      if (show) stats.fallbacks++;
    }
    if (show && texture.image !== show) {
      texture.image = show;
      texture.needsUpdate = true;
    }
    stats.calls++;
    if (bmp) stats.hits++; else stats.misses++;
    if (gap > stats.maxGap) stats.maxGap = gap;

    /* Rebuild the wanted list in priority order, every call. Cheap (a few
     * dozen integer pushes) and it means a gesture that reversed or sped up
     * never spends decode slots on frames it has already left behind. */
    queue.length = 0;
    /* THE VISIBLE FRAME JUMPS THE QUEUE, and ignores the concurrency cap.
     * A miss here is the only miss the eye can see, and making it wait for
     * a prefetch slot is what turns the start of a flick into a visible
     * stall: the playhead lands somewhere cold, and the frame that would
     * fix it sits behind three speculative decodes. One extra in-flight
     * decode per frame is bounded (the `decoding` set dedups it) and it is
     * always the most valuable work in the queue. */
    if (!bmp) startDecode(idx);
    /* Then the direction of travel, spaced by the measured speed: at a
     * flick, landing every frame is pointless because the playhead skips
     * most of them, so sample the path AHEAD at the stride the eye will
     * actually see. This is what keeps the window covering real time
     * (~8 rAFs) without queueing hundreds of frames. */
    const stride = Math.max(1, Math.round(speed));
    for (let k = 1; k <= LOOKAHEAD_FRAMES; k++) want(idx + k * stride * lastDir);
    /* a couple behind, so a small reversal is already warm */
    want(idx - stride * lastDir);
    want(idx - 2 * stride * lastDir);
    pump();
    return !!bmp;
  }
  setProgress._last = -1;

  return {
    texture,
    preload,
    setProgress,
    stats,                            // debug: hit rate, gaps, decode count
    get cached() { return cache.size; },
    get ready() { return loaded === FRAME_COUNT; },
    get loadedCount() { return loaded; },
    frameCount: FRAME_COUNT,
  };
}
