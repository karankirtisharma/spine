import * as THREE from 'three';
import { rand } from './rng.js';

/* Procedural stand-ins for the original's bound assets:
 *   tEnv    -> assets/images/work/env1.jpg          (equirect environment)
 *   tNormal -> assets/images/tree_room/waternormals.jpg
 *   tMap    -> the project thumbnail from the CMS
 *   tVideo  -> the project showreel
 * Generated here so the recreation ships no third-party media. */

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// value-noise + fbm on the CPU, used by the generators below
function makeNoise(seed = 1) {
  const p = new Uint8Array(512);
  let s = seed;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const perm = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = (rand() * (i + 1)) | 0; [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + t * (b - a);
  const grad = (h, x, y) => ((h & 1) ? -x : x) + ((h & 2) ? -y : y);
  const noise2 = (x, y) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const A = p[X] + Y, B = p[X + 1] + Y;
    return lerp(
      lerp(grad(p[A], x, y), grad(p[B], x - 1, y), u),
      lerp(grad(p[A + 1], x, y - 1), grad(p[B + 1], x - 1, y - 1), u), v);
  };
  return (x, y, oct = 4) => {
    let f = 0, a = 0.5, fr = 1;
    for (let i = 0; i < oct; i++) { f += a * noise2(x * fr, y * fr); fr *= 2.03; a *= 0.5; }
    return f;
  };
}

/* Active Theory's own textures, as bound in uil.json:
 *   tEnv    WorkItemShader/.../_txtEnv    -> assets/images/work/env1.jpg
 *   tNormal WorkItemShader/.../_txtNormal -> assets/images/tree_room/waternormals.jpg
 *   tMap    WorkItemShader/.../_txtMap    -> assets/images/_scenelayout/black.jpg
 * The procedural generators below are kept only as offline fallbacks. */
const loader = new THREE.TextureLoader();

/* assets/at/ is not committed (those files are Active Theory's), so on a fresh
 * clone or a deploy they 404 until `npm run fetch:assets` is run. Swap in the
 * procedural generator in that case rather than binding an empty texture. */
export function loadEnvTexture() {
  const t = loader.load('assets/at/env1.jpg', undefined, undefined, () => {
    const fb = makeEnvTexture();
    t.image = fb.image;
    t.needsUpdate = true;
    console.info('assets/at/env1.jpg missing — procedural fallback (npm run fetch:assets)');
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function loadNormalTexture() {
  // Utils3D.getRepeatTexture on the original
  const t = loader.load('assets/at/waternormals.jpg', undefined, undefined, () => {
    const fb = makeNormalTexture();
    t.image = fb.image;
    t.needsUpdate = true;
    console.info('assets/at/waternormals.jpg missing — procedural fallback (npm run fetch:assets)');
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * Active Theory's own jellyfish matcap.
 *
 * uil.json binds `assets/images/room/matcap-test.jpg` as both tMap and tMatcap on
 * every JellyShader instance -- a photographed faceted crystal ball with prismatic
 * edge dispersion. It is the whole reason their jellyfish reads as three-dimensional
 * glass: a matcap is indexed by surface normal, so form comes out of the shading
 * rather than having to be lit.
 *
 * Falls back to makeBubbleMatcap()'s procedural sphere, which has the same
 * luminance structure (lit pole, dark limb, bright ring) at far lower fidelity --
 * enough that the jelly still reads as a body if the asset is missing.
 */
export function loadJellyMatcap() {
  const t = loader.load('assets/at/matcap-test.jpg', undefined, undefined, () => {
    const fb = makeBubbleMatcap();
    t.image = fb.image;
    t.needsUpdate = true;
    console.info('assets/at/matcap-test.jpg missing — procedural matcap fallback (npm run fetch:assets)');
  });
  t.colorSpace = THREE.SRGBColorSpace;
  /* Clamp, never repeat: the lookup is a disc in [0,1] and wrapping would fold the
   * far limb back over the lit pole at grazing angles. */
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/**
 * Active Theory's jellyfish surface normal map.
 *
 * uil.json binds `assets/images/pbr/alien_cracked_2_normal.png` as tNormal on every
 * JellyShader instance -- a cracked, rippled organic membrane. It is what keeps their
 * bell from reading as a smooth CG dome: perturbing the matcap lookup with it turns
 * flat crystal facets into a veined biological surface.
 *
 * Falls back to the procedural water normal, which has the wrong character (smooth
 * rolling waves rather than cracks) but the right encoding, so the material still
 * shades correctly rather than breaking.
 */
export function loadJellyNormal() {
  const t = loader.load('assets/at/alien_cracked_2_normal.png', undefined, undefined, () => {
    const fb = makeNormalTexture();
    t.image = fb.image;
    t.needsUpdate = true;
    console.info('assets/at/alien_cracked_2_normal.png missing — procedural normal fallback (npm run fetch:assets)');
  });
  /* Repeat, because the shader tiles it several times across the bell. NEVER give a
   * normal map an sRGB colour space -- its channels are a vector, not a colour, and
   * the transfer curve would bend them. */
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * Active Theory's logo-glass normal map.
 *
 * The versioned uil binds `assets/images/jungle_soil_normal.png` as tNormal on
 * AboutLogoShader with uNormalStrength 0.24 -- an organic soil-crack relief. Their
 * logo shader samples it in SCREEN space (scaled around centre, pushed by the surface
 * normal and the view direction), which is what smears the matcap and the refraction
 * into the wavy liquid-glass look their coin has. Same fallback contract as the
 * jelly's normal: wrong character, right encoding.
 */
export function loadLogoNormal() {
  const t = loader.load('assets/at/jungle_soil_normal.png', undefined, undefined, () => {
    const fb = makeNormalTexture();
    t.image = fb.image;
    t.needsUpdate = true;
    console.info('assets/at/jungle_soil_normal.png missing — procedural normal fallback (npm run fetch:assets)');
  });
  /* Repeat is REQUIRED here, not a nicety: their normalUV is screen UV scaled 5x
   * about the centre, so the lookup spans roughly [-2, 3] and clamping would streak
   * the last texel row across most of the coin. No sRGB, as above. */
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Equirectangular environment fallback: dark teal void with a bright horizon band. */
export function makeEnvTexture() {
  const W = 512, H = 256;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const n = makeNoise(7);
  for (let y = 0; y < H; y++) {
    const v = y / H;
    // horizon glow around the equator, deep blue above, near-black below
    const band = Math.exp(-Math.pow((v - 0.52) * 6.5, 2));
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const cloud = n(u * 5, v * 5, 4) * 0.5 + 0.5;
      const sun = Math.exp(-Math.pow((u - 0.28) * 9, 2)) * Math.exp(-Math.pow((v - 0.46) * 12, 2));
      let r = 0.035 + band * 0.30 * cloud + sun * 0.75;
      let g = 0.055 + band * 0.46 * cloud + sun * 0.85;
      let b = 0.090 + band * 0.62 * cloud + sun * 0.95;
      if (v < 0.4) { const k = 1 - (0.4 - v) * 1.6; r *= k; g *= k; b *= k; }
      const i = (y * W + x) * 4;
      img.data[i] = Math.min(255, r * 255);
      img.data[i + 1] = Math.min(255, g * 255);
      img.data[i + 2] = Math.min(255, b * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * Tiling surface for HomeColumnShader's tMap — the crossing tails.
 *
 * Their shader scrolls this in y (`texUV.y += time * 0.1 - cameraPosition.y * 0.03`),
 * RGB-shifts it and adds it at 0.5 strength, so it is half the strand's colour.
 * Which is exactly why waternormals.jpg cannot stand in for it: a normal map is
 * (0.5, 0.5, 1.0) at rest, so half of every strand came out violet.
 *
 * Vertical filaments rather than clouds, because the term is scrolled along the
 * strand's own axis — streaks read as flow, blobs read as a texture sliding past.
 */
export function makeStrandTexture(opts = {}) {
  const W = 64, H = 512;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const n = makeNoise(opts.seed ?? 41);
  const tint = new THREE.Color(opts.tint ?? '#7dd63a');
  const hot = new THREE.Color(opts.hot ?? '#e6ffc0');

  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      /* Stretched 8:1 in y so the fbm elongates into filaments. Wrapped in x by
       * blending the seam against the same noise sampled a period away. */
      const a = n(u * 3, v * 24, 4);
      const b = n((u - 1) * 3, v * 24, 4);
      const streak = (a * (u) + b * (1 - u)) * 0.5 + 0.5;
      /* The floor is load-bearing, not padding.
       *
       * Their column shader opens with `color = texture2D(tRefraction, screenuv)`
       * and adds this at 0.5 -- so where the scene behind the strand is void, this
       * term IS the strand. A first version ran streaks down to black and the
       * tails vanished at the top of the page, where nothing sits behind them yet;
       * theirs never does, because their tMap is a real image with a mid-tone
       * body. 0.35 is the point where the strand carries its own luminance and
       * the streaks still read as flow rather than noise. */
      const k = 0.35 + 0.65 * Math.pow(Math.max(0, streak), 1.3);
      const i = (y * W + x) * 4;
      img.data[i] = (tint.r * k + hot.r * k * k * 0.6) * 255;
      img.data[i + 1] = (tint.g * k + hot.g * k * k * 0.6) * 255;
      img.data[i + 2] = (tint.b * k + hot.b * k * k * 0.6) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Tiling water-style normal map, standing in for waternormals.jpg. */
export function makeNormalTexture() {
  const S = 256;
  const c = canvas(S, S);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const n = makeNoise(23);
  const height = (x, y) => n((x / S) * 4, (y / S) * 4, 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const hL = height((x - 1 + S) % S, y), hR = height((x + 1) % S, y);
      const hD = height(x, (y - 1 + S) % S), hU = height(x, (y + 1) % S);
      const dx = (hR - hL) * 2.2, dy = (hU - hD) * 2.2;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * S + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * Grayscale sphere-shading matcap, standing in for FlowerParticleShader's tMap
 * (a glass-bubble matcap bound in uil.json — proprietary, not redistributed).
 * Soft-light/overlay-blended onto each particle's colour, this is what turns a
 * flat tinted disc into a tiny shaded bubble.
 */
export function makeBubbleMatcap() {
  const S = 128;
  const c = canvas(S, S);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const lx = -0.5, ly = 0.6, lz = 0.7;
  const llen = Math.hypot(lx, ly, lz);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = ((x + 0.5) / S) * 2 - 1, v = 1 - ((y + 0.5) / S) * 2;
      const r = Math.hypot(u, v);
      const i = (y * S + x) * 4;
      if (r > 1) { img.data[i] = img.data[i + 1] = img.data[i + 2] = 0; img.data[i + 3] = 255; continue; }
      const z = Math.sqrt(1 - r * r);
      const diff = Math.max(0, (u * lx + v * ly + z * lz) / llen);
      const rim = Math.pow(1 - z, 2.5);
      const hx = u - lx * 0.6, hy = v - ly * 0.6;
      const spec = Math.exp(-(hx * hx + hy * hy) * 40) * 0.9;
      /* The bright RING near the silhouette edge, and it is what flips the read
       * from "lit ball" to "bubble". The reference frames' larger grains are
       * unmistakably bubbles/bokeh: a luminous edge band, a darker interior, one
       * hot glint. The previous mix of diffuse+rim shaded them like tiny matte
       * spheres, which is why the field read as flat confetti next to theirs.
       * Gaussian band centred at r 0.88; interior weights come DOWN to pay for it
       * so the sprite's average energy stays roughly what bloom was tuned for. */
      const ring = Math.exp(-Math.pow((r - 0.88) * 9, 2)) * 0.85;
      const val = Math.min(1, 0.07 + diff * 0.22 + rim * 0.12 + ring + spec);
      const g = Math.round(val * 255);
      img.data[i] = g; img.data[i + 1] = g; img.data[i + 2] = g; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}



/** Per-project still, standing in for the CMS thumbnail. */
export function makeThumbTexture(hex, seed) {
  const W = 320, H = 180;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  const base = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);
  const n = makeNoise(seed);
  const tmp = new THREE.Color();
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / H;
      const f1 = n(u * 3.2, v * 3.2, 5) * 0.5 + 0.5;
      const f2 = n(u * 7 + 3, v * 7 + 3, 4) * 0.5 + 0.5;
      const f3 = n(u * 1.7 + 9, v * 1.7 + 9, 3);
      // Real footage is never one flat hue: drift around the project accent so
      // the panel reads like imagery rather than a colour wash.
      tmp.setHSL(
        (hsl.h + f3 * 0.22 + f2 * 0.07 + 1) % 1,
        Math.min(1, hsl.s * (0.55 + f1 * 0.75)),
        Math.min(0.94, 0.09 + Math.pow(f1, 1.35) * 0.66 + Math.pow(f2, 3.0) * 0.46)
      );
      const i = (y * W + x) * 4;
      img.data[i] = tmp.r * 255;
      img.data[i + 1] = tmp.g * 255;
      img.data[i + 2] = tmp.b * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * One animated canvas shared by every card, standing in for the per-project
 * showreel. Cheap: 256x144, a handful of drifting radial gradients.
 * Cards tint it through uColor, exactly as the original does.
 */
export function makeSharedVideoTexture() {
  const W = 256, H = 144;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;

  const blobs = Array.from({ length: 7 }, (_, i) => ({
    x: rand(), y: rand(),
    r: 0.18 + rand() * 0.3,
    sx: (rand() - 0.5) * 0.05,
    sy: (rand() - 0.5) * 0.04,
    hue: 180 + i * 22,
  }));

  function update(t) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    for (const b of blobs) {
      const x = (b.x + Math.sin(t * b.sx * 6 + b.hue) * 0.25) * W;
      const y = (b.y + Math.cos(t * b.sy * 6 + b.hue) * 0.25) * H;
      const r = b.r * W * (0.8 + Math.sin(t * 0.6 + b.hue) * 0.2);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `hsla(${b.hue + Math.sin(t * 0.3) * 25}, 92%, 66%, 0.95)`);
      g.addColorStop(1, 'hsla(0,0%,0%,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    tex.needsUpdate = true;
  }

  return { texture: tex, update };
}

/* The water ceiling's crack web -- stands in for Active Theory's
 * cracked_ice_basecolor.png (their WaterCeilingShader samples it through
 * scaleUV(vUv, 0.1), i.e. tiled 10x across the sheet, so this MUST tile).
 * A toroidal voronoi: bright cell edges (the F2-F1 crack lines of ice) over
 * deep ice blue, wrapped in both axes so the 10x repeat is seamless. The
 * shader hue-shifts and vignettes it, so what matters here is the STRUCTURE:
 * thin bright web, broad dark cells, mild per-cell value variation. */
export function makeCrackedIceTexture(size = 512, seeds = 44) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const pts = [];
  let s = 1234567;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < seeds; i++) pts.push([rnd(), rnd(), 0.55 + rnd() * 0.45]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let f1 = 9, f2 = 9, cell = 1;
      for (let i = 0; i < seeds; i++) {
        /* toroidal distance: nearest image of the seed in the wrapped tile */
        let dx = Math.abs(u - pts[i][0]); if (dx > 0.5) dx = 1 - dx;
        let dy = Math.abs(v - pts[i][1]); if (dy > 0.5) dy = 1 - dy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) { f2 = f1; f1 = d; cell = pts[i][2]; }
        else if (d < f2) f2 = d;
      }
      /* crack line where the two nearest cells are equidistant. Wide falloff
       * and a low exponent: their cracked-ice web is refracted light, soft
       * bands metres thick, not a wireframe -- the first cut of this texture
       * used (f2-f1)*34 with pow 3.2 and the ceiling read as a neon hex grid.
       * A touch of position noise wobbles the bands so no edge is straight. */
      const wob = Math.sin(u * 41 + v * 23) * 0.012 + Math.sin(v * 57 - u * 31) * 0.009;
      /* two webs, like a real caustic photo: a broad soft primary band and a
       * finer bright core riding its centre -- the AT reference reads as
       * blue-white filaments with wide glow skirts, not single lines */
      const d21 = f2 - f1 + wob;
      const skirt = Math.pow(Math.max(0, 1 - d21 * 9), 1.6) * 0.34;
      const core = Math.pow(Math.max(0, 1 - d21 * 24), 2.4) * 0.66;
      const web = Math.min(1.1, skirt + core);
      /* cells carry their own slow value clouds instead of sitting flat */
      const cloud = 0.5 + 0.5 * Math.sin(u * 19 + cell * 40) * Math.sin(v * 17 - cell * 30);
      /* DARKER AND TEAL, retuned against the client's underwater recording
       * of the reference site: their surface-from-below is a DIM fine web
       * over near-black cells -- the earlier blue-white weights here came
       * out as glowing ribbons once the sheet hung right over the eye and
       * the bloom got hold of them ("abstract neon lines", their words).
       * Web peaks ~0.66 green now, whites nowhere, and the ceiling shader's
       * pow 2.2 pulls the cells the rest of the way down. */
      const base = 0.07 + 0.09 * cell + 0.04 * cloud;
      const rC = base * 0.50 + web * 0.26;
      const gC = base * 0.95 + web * 0.60;
      const bC = base * 1.10 + web * 0.52;
      const o = (y * size + x) * 4;
      img.data[o] = Math.min(255, rC * 255);
      img.data[o + 1] = Math.min(255, gC * 255);
      img.data[o + 2] = Math.min(255, bC * 255);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
