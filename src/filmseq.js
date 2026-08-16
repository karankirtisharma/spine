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
const CACHE_MAX = 48;
/* How far ahead to decode in the direction of travel. Six frames is ~2.6vh:
 * enough to stay in front of a normal scroll without spending decode budget
 * on frames the user may never reach. */
const PREFETCH = 6;

export function buildFilmSequence() {
  const blobs = new Array(FRAME_COUNT).fill(null);
  const cache = new Map();          // index -> ImageBitmap (insertion order = LRU)
  const decoding = new Set();       // in-flight, so we never double-decode
  let loaded = 0;
  let lastDir = 1;

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
          .catch(() => { /* a missing frame just holds the previous one */ })));
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

  function decode(i) {
    if (i < 0 || i >= FRAME_COUNT) return;
    if (cache.has(i) || decoding.has(i) || !blobs[i]) return;
    decoding.add(i);
    /* the flip lives here -- see texture.flipY above */
    createImageBitmap(blobs[i], { imageOrientation: 'flipY' }).then(bmp => {
      decoding.delete(i);
      /* re-check: a slow decode may land after its frame was evicted-by-scroll */
      if (cache.has(i)) { bmp.close && bmp.close(); return; }
      cache.set(i, bmp);
      evict();
    }).catch(() => { decoding.delete(i); });
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
    if (idx !== setProgress._last) {
      lastDir = idx >= setProgress._last ? 1 : -1;
      setProgress._last = idx;
    }
    const bmp = touch(idx);
    if (bmp && texture.image !== bmp) {
      texture.image = bmp;
      texture.needsUpdate = true;
    }
    /* current frame first, then the direction of travel -- a miss on the
     * current frame is the only one the eye can see */
    if (!bmp) decode(idx);
    for (let k = 1; k <= PREFETCH; k++) decode(idx + k * lastDir);
    /* one behind, so a small reversal is already warm */
    decode(idx - lastDir);
    return !!bmp;
  }
  setProgress._last = -1;

  return {
    texture,
    preload,
    setProgress,
    get ready() { return loaded === FRAME_COUNT; },
    get loadedCount() { return loaded; },
    frameCount: FRAME_COUNT,
  };
}
