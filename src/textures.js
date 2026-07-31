import * as THREE from 'three';

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
 * clone or a deploy they 404 until `npm run fetch:assets` is run. Fall back to
 * the procedural generators in that case rather than binding an empty texture —
 * the scene should always come up, just with stand-in maps. */
function withFallback(url, makeFallback, configure) {
  const t = loader.load(url, undefined, undefined, () => {
    const fb = makeFallback();
    t.image = fb.image;
    t.needsUpdate = true;
    console.info(`${url} unavailable — using procedural fallback (npm run fetch:assets)`);
  });
  configure(t);
  return t;
}

export function loadEnvTexture() {
  return withFallback('assets/at/env1.jpg', makeEnvTexture, t => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
  });
}

export function loadNormalTexture() {
  // Utils3D.getRepeatTexture on the original
  return withFallback('assets/at/waternormals.jpg', makeNormalTexture, t => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
  });
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
    x: Math.random(), y: Math.random(),
    r: 0.18 + Math.random() * 0.3,
    sx: (Math.random() - 0.5) * 0.05,
    sy: (Math.random() - 0.5) * 0.04,
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
