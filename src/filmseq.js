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
/* deep-bg-960, not deep-bg. THE SOURCE FRAMES NOW MATCH THE SIZE WE DECODE TO,
 * and this is the fix the earlier decode-size work could not deliver.
 *
 * The originals are 1920x1080. createImageBitmap's resizeWidth does NOT let
 * you skip decoding the source -- the full 1920x1080 image is decoded first
 * and then scaled. So capping the decode output cut resident memory and
 * upload bytes but left the CPU decode cost completely untouched, which is
 * the part that stalls a scrub. Re-encoding the plate at the size actually
 * used means a quarter of the pixels are decoded per frame.
 *
 * 315 frames, 32.3MB -> 10.7MB on the wire (~35KB each), q82 lanczos. The
 * plate is a fogged backdrop behind foliage, glass and bloom, so the detail
 * given up is detail nothing could read.
 *
 * resizeWidth/Height are deliberately KEPT in the decode call even though the
 * source already matches: the destination texture is a fixed allocation and
 * texSubImage2D requires exact dimensions, so normalising there is what makes
 * an odd-sized frame impossible rather than merely unlikely. */
const PATH = i => `assets/deep-bg-960/f_${String(i + 1).padStart(4, '0')}.webp`;
/* Decoded-frame ceiling. 48 frames is ~21vh of scroll at 0.44vh/frame -- more
 * lookahead than a single wheel gesture covers, so the window keeps up. */
/* 64 decoded frames: the live scrub window PLUS the sparse skeleton below.
 * Deliberately modest all the same, and the reason is measured: a 96-frame
 * window of full-size bitmaps was ~800MB resident and the browser stalled
 * for whole seconds under that pressure. At display size (below), 64 is
 * ~230MB, which stays smooth. */
/* 40, from 64. With 960-wide frames the live scrub window plus the sparse
 * skeleton fits comfortably, and fewer resident bitmaps means less for the
 * allocator to move around during a fast flick -- the moment the section is
 * least able to afford it. ~84MB resident, against ~530MB before any of
 * this. */
/* CACHE_MAX counts the LIVE window only, because the arithmetic above never
 * held: the skeleton is ceil(315/8) = 40 frames PLUS the parked last frame
 * = 41 entries, one more than the whole cap. The skeleton was inserted
 * first, so it was also the LRU tail -- the first real gesture evicted it
 * frame by frame, and after ~40 scrubbed frames the guarantee it exists to
 * provide ("a cached frame within 4 of any point") was gone entirely.
 * Freeze-then-jump returned on every fast flick. Skeleton frames are now
 * exempt from eviction (isSkeleton below); total resident worst case is
 * 41 + 40 = 81 frames, ~168MB at 2.1MB each -- still 3x under the 530MB
 * this file was rescued from. */
const CACHE_MAX = 40;
const isSkeleton = (i) => i % SKELETON_STRIDE === 0 || i === FRAME_COUNT - 1;
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

/* FIXED decode dimensions. They have to be a constant rather than derived at
 * first use, because the destination texture is now ALLOCATED ONCE at exactly
 * this size and every later frame is written into that allocation -- see the
 * blit in setProgress. */
const DEC_W = 960, DEC_H = 540;

export function buildFilmSequence(renderer) {
  const blobs = new Array(FRAME_COUNT).fill(null);
  const cache = new Map();          // index -> ImageBitmap (insertion order = LRU)
  const decoding = new Set();       // in-flight, so we never double-decode
  let loaded = 0;
  let lastDir = 1;
  /* eased frames-per-rAF, drives the prefetch window -- see setProgress */
  let speed = 0;
  /* which frame is actually ON SCREEN, so a substitute can never rewind
   * against the travel -- see the monotonic block in setProgress */
  let shownIdx = -1;
  const stats = { calls: 0, hits: 0, misses: 0, decodes: 0, maxGap: 0, fallbacks: 0,
    get missRate() { return this.calls ? +(this.misses / this.calls).toFixed(3) : 0; },
    reset() { this.calls = this.hits = this.misses = this.maxGap = 0;
              this.decodes = this.fallbacks = 0; } };

  /* A 1x1 placeholder so the material is valid before frame 0 arrives -- a
   * null map would compile a different program and swap it later, which is a
   * shader recompile mid-scroll. */
  /* ALLOCATED AT FRAME SIZE, not 1x1, and this is the whole point of the
   * texSubImage2D path below: the GPU storage is created once, here, and
   * every subsequent frame is written INTO it. A 1x1 placeholder would force
   * a reallocation on the first real frame. Black, so it reads as the plate
   * being unlit rather than as garbage before frame 0 lands. */
  const texture = new THREE.Texture(new ImageData(DEC_W, DEC_H));
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
  /* BOUNDED, unlike the decode queue's unbounded predecessor here. All 315
   * fetches used to go out in one Promise.all, and on HTTP/1.1 (~6 requests
   * per origin) they formed a wall in front of everything queued after --
   * which is the emblem and spine GLBs that revealWhenReady waits on. On a
   * cold load the 5s cap could fire with the scene half-assembled, and the
   * prewarm then warmed a scene missing its heaviest materials. Eight lanes
   * keeps the film saturating spare connections without owning all of them;
   * the deep is still ~525vh away, which is more time than this needs. */
  let preloadDone = null;
  function preload() {
    if (preloadDone) return preloadDone;
    const LANES = 8;
    let next = 0;
    const lane = () => {
      const i = next++;
      if (i >= FRAME_COUNT) return Promise.resolve();
      return fetch(PATH(i))
        .then(r => r.blob())
        .then(b => { blobs[i] = b; loaded++; })
        .catch(() => { /* a missing frame just holds the previous one */ })
        .then(lane);
    };
    preloadDone = Promise.all(Array.from({ length: LANES }, lane))
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
    /* the cap governs the LIVE window; skeleton frames are permanent
     * residents (see the CACHE_MAX note) and are skipped, not just spared --
     * counting them against the cap would evict the whole live window
     * instead */
    let live = 0;
    for (const k of cache.keys()) if (!isSkeleton(k)) live++;
    if (live <= CACHE_MAX) return;
    for (const oldest of cache.keys()) {
      if (isSkeleton(oldest)) continue;
      const bmp = cache.get(oldest);
      cache.delete(oldest);
      /* explicit release -- ImageBitmap is not reclaimed promptly otherwise,
       * and at 8.3MB a frame the drift is measured in hundreds of MB */
      if (bmp && bmp.close) bmp.close();
      if (--live <= CACHE_MAX) return;
    }
  }

  /* Decode size, resolved once against the real canvas. The plane is
   * cover-fit to the viewport, so decoding the full 1920x1080 when the
   * canvas is ~1270 CSS px wide pays for pixels no one can see -- twice
   * over, in decode time and in the per-swap GPU upload. Sizing to the
   * display cuts both by the area ratio (~2.3x here) and is the single
   * biggest reason the scrub got smooth. Capped at the source so a 4K
   * display just gets the native frame. */
  /* Decode size is now the fixed DEC_W/DEC_H constants, because the
   * destination texture is allocated once at exactly that size and every
   * frame is written into that allocation (see the blit). It used to be
   * derived from innerWidth * devicePixelRatio capped at 1920, which on any
   * HiDPI display simply pinned to the cap -- so the "decode to display size"
   * optimisation quietly did nothing on the machines that needed it most, and
   * every frame decoded full size: 1920x1080x4 = 8.3MB each.
   *
   * 960x540 is 2.1MB a frame. Against a 40-frame window that is ~84MB
   * resident, where the original was ~530MB. The plate is a fogged backdrop
   * behind foliage, glass and bloom and is never a subject -- this is
   * resolution nothing was reading. */
  const decW = DEC_W, decH = DEC_H;

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
  /* THE BLIT -- texSubImage2D instead of texImage2D, and the reason the
   * scrub was expensive out of all proportion to its pixel count.
   *
   * The old swap was `texture.image = bmp; texture.needsUpdate = true`. In
   * three.js that re-enters uploadTexture and issues a fresh texImage2D,
   * which does not just transfer the bytes -- it REALLOCATES the texture's
   * GPU storage. Every frame index change, so very nearly every frame of a
   * scrub: allocate, upload, orphan the old allocation, and let the driver
   * clean up behind you. That allocation churn is what the section felt like,
   * far more than the 2.1MB transfer itself.
   *
   * copyTextureToTexture hands srcTexture.image straight to texSubImage2D
   * against a destination that was allocated once at DEC_W x DEC_H above. The
   * bytes still move; nothing is reallocated, and nothing is orphaned.
   *
   * The scratch source is never uploaded as a texture in its own right -- it
   * exists only to carry the ImageBitmap into that call.
   *
   * Falls back to the old assignment if the copy throws (renderer missing, or
   * a three.js signature change): a slow film is much better than no film,
   * and this is not a path worth being clever about without being able to see
   * it run. */
  const srcTex = new THREE.Texture();
  srcTex.flipY = false;
  srcTex.colorSpace = THREE.SRGBColorSpace;
  let blitOk = !!(renderer && renderer.copyTextureToTexture);

  function blit(bmp) {
    if (blitOk) {
      try {
        srcTex.image = bmp;
        renderer.copyTextureToTexture(srcTex, texture);
        return;
      } catch (e) {
        blitOk = false;
        console.warn('[film] texSubImage2D blit unavailable, ' +
                     'falling back to full upload:', e && e.message);
      }
    }
    texture.image = bmp;
    texture.needsUpdate = true;
  }

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
    let show = bmp, showIdx = bmp ? idx : -1;
    if (!show) {
      /* MONOTONIC substitution. Searching outward from the target finds the
       * nearest cached frame, but taken literally it can show N-5 on one
       * tick and N+1 on the next -- the footage lurching backwards and then
       * springing forward, which is what the client saw as the film
       * "accelerating" instead of running steady. So a substitute is only
       * accepted if it does not move against the direction of travel: while
       * scrolling forward the displayed frame may stall, never rewind. */
      for (let k = 1; k <= FALLBACK_RANGE && !show; k++) {
        for (const cand of [idx - k * lastDir, idx + k * lastDir]) {
          if (cand < 0 || cand >= FRAME_COUNT) continue;
          if (shownIdx >= 0 && (cand - shownIdx) * lastDir < 0) continue;
          const c = cache.get(cand);
          if (c) { show = c; showIdx = cand; break; }
        }
      }
      if (show) stats.fallbacks++;
    }
    if (show && shownIdx !== showIdx) {
      blit(show);
      shownIdx = showIdx;
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
