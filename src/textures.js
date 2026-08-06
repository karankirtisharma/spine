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
      const val = Math.min(1, 0.16 + diff * 0.55 + rim * 0.35 + spec);
      const g = Math.round(val * 255);
      img.data[i] = g; img.data[i + 1] = g; img.data[i + 2] = g; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

/**
 * Mineral-glitter surface for the spine, as a basecolor + normal pair.
 *
 * Their SpineShader.glsl has no procedural sparkle in it at all -- it samples
 * tBaseColor and tNormal and runs them through getFBR. So the speckle on their
 * column is authored INTO the texture, which is why it holds still on the
 * surface and catches light per-fleck rather than crawling. This reproduces that
 * as a texture rather than a shader trick, in our green instead of their
 * violet/cyan.
 *
 * Three layers, all sharing one height field so the normal map agrees with the
 * colour:
 *   1. mottled rock base    -- low-frequency fbm, dark olive to mid green
 *   2. vein / patina wash   -- warped fbm, lighter and slightly cooler
 *   3. flecks               -- sparse high-contrast points, pale chartreuse to
 *                              teal, each one a little dome in the height field
 */
export function makeSpineGlitterTextures(opts = {}) {
  /* 512, not 1024. This bake runs synchronously on the main thread while the
   * spine loads, and at 1024 it is ~1M pixels x a 5-octave fbm, which stalled
   * the frame loop for several seconds -- long enough that the loader timed out
   * and the canvas sat black. 512 is ample for a tiling rock surface. */
  const S = opts.size ?? 512;
  const n = makeNoise(opts.seed ?? 91);

  const colorCanvas = canvas(S, S);
  const cctx = colorCanvas.getContext('2d');
  const cimg = cctx.createImageData(S, S);

  // height field, kept so the normal map can be derived from the same data
  const height = new Float32Array(S * S);
  const tmp = new THREE.Color();

  // fleck centres: sparse, random radius, random hue along the green ramp
  const FLECKS = opts.flecks ?? 2600;
  let seed = (opts.seed ?? 91) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const flecks = Array.from({ length: FLECKS }, () => ({
    x: rnd() * S, y: rnd() * S,
    // smaller than before -- the reference grain is sand-fine, not pebbly
    r: 0.8 + Math.pow(rnd(), 2.6) * 2.6,
    hue: rnd(),          // 0 = deep green, 1 = pale chartreuse / teal
    bright: 0.55 + rnd() * 0.45,
  }));

  /* Fleck coverage, stamped rather than searched.
   *
   * The first version tested every pixel against the flecks in a 3x3 bucket
   * neighbourhood -- O(pixels x flecks nearby), tens of millions of hypot calls.
   * Instead, walk the flecks once and write only the pixels each one covers:
   * O(flecks x r^2), a few tens of thousands of ops. Two parallel buffers hold
   * the strongest fleck at each pixel and its hue. */
  const sparkBuf = new Float32Array(S * S);
  const hueBuf = new Float32Array(S * S);
  for (const f of flecks) {
    const r = f.r, r2 = r * r;
    const x0 = Math.max(0, Math.floor(f.x - r)), x1 = Math.min(S - 1, Math.ceil(f.x + r));
    const y0 = Math.max(0, Math.floor(f.y - r)), y1 = Math.min(S - 1, Math.ceil(f.y + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y - f.y, dy2 = dy * dy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - f.x, d2 = dx * dx + dy2;
        if (d2 > r2) continue;
        // dome falloff; squared distance only, no sqrt in the inner loop
        const k = Math.pow(1 - d2 / r2, 0.8) * f.bright;
        const i = y * S + x;
        if (k > sparkBuf[i]) { sparkBuf[i] = k; hueBuf[i] = f.hue; }
      }
    }
  }

  /* Mid-tones, not near-black. The column emits nothing of its own now, so the
   * albedo is all the lighting has to work with -- the first pass used
   * #0a1a0c/#24401d and the whole spine read as a black silhouette with the
   * flecks invisible on top of it. */
  /* Mid-tone base.
   *
   * I went too dark chasing the reference (#0e1c12 / #2a4a22) and the column
   * read as a black silhouette with a few glints. Albedo is the right lever for
   * this rather than light intensity: diffuse response is bounded by the light,
   * so raising albedo brightens the surface without creating the specular spikes
   * that clear the bloom threshold -- which is exactly what flooded the frame
   * green when I turned the lights up instead. */
  const deepA = new THREE.Color(opts.deepA ?? '#3d6b45');   // shadowed rock
  const deepB = new THREE.Color(opts.deepB ?? '#82bd5e');   // lit rock
  const vein  = new THREE.Color(opts.vein  ?? '#abda75');   // patina wash
  const hotA  = new THREE.Color(opts.hotA  ?? '#a8e838');   // fleck, green
  const hotB  = new THREE.Color(opts.hotB  ?? '#f4ffd2');   // fleck, pale

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;

      // 1. rock base (3 octaves, not 5 -- the flecks carry the fine detail)
      const base = n(u * 6.5, v * 6.5, 3) * 0.5 + 0.5;
      // 2. vein wash, domain-warped so it wanders rather than tiling obviously
      const wx = u * 3.1 + n(u * 2.2 + 4, v * 2.2, 2) * 0.35;
      const wy = v * 3.1 + n(u * 2.2, v * 2.2 + 7, 2) * 0.35;
      const veinAmt = Math.pow(Math.max(0, n(wx, wy, 2) * 0.5 + 0.5), 2.4);

      tmp.copy(deepA).lerp(deepB, Math.pow(base, 1.25));
      tmp.lerp(vein, veinAmt * 0.55);

      let h = base * 0.6 + veinAmt * 0.25;

      // 3. flecks -- already rasterised into sparkBuf above
      const spark = sparkBuf[y * S + x];
      const sparkHue = hueBuf[y * S + x];
      if (spark > 0) {
        const fc = hotA.clone().lerp(hotB, sparkHue * sparkHue);
        tmp.lerp(fc, Math.min(1, spark * 1.15));
        h += spark * 0.9;
      }

      height[y * S + x] = h;
      const i = (y * S + x) * 4;
      cimg.data[i] = Math.min(255, tmp.r * 255);
      cimg.data[i + 1] = Math.min(255, tmp.g * 255);
      cimg.data[i + 2] = Math.min(255, tmp.b * 255);
      cimg.data[i + 3] = 255;
    }
  }
  cctx.putImageData(cimg, 0, 0);

  // normal map from the shared height field, wrapping at the edges so it tiles
  const normalCanvas = canvas(S, S);
  const nctx = normalCanvas.getContext('2d');
  const nimg = nctx.createImageData(S, S);
  const at = (x, y) => height[((y + S) % S) * S + ((x + S) % S)];
  /* 2.5, down from 7.0. The height field is fleck-dominated, so a strong relief
   * produced near-vertical normals one texel wide. Under a sharp clearcoat those
   * become specular spikes far brighter than the bloom threshold, and bloom's
   * coarsest mip renders each one as a hard block -- the pale squares over the
   * column. The flecks still read, because their colour comes from the basecolor
   * map; the normal only needs to tilt them, not cliff them. */
  const relief = opts.relief ?? 2.5;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * relief;
      const dy = (at(x, y + 1) - at(x, y - 1)) * relief;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * S + x) * 4;
      nimg.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 3] = 255;
    }
  }
  nctx.putImageData(nimg, 0, 0);

  const map = new THREE.CanvasTexture(colorCanvas);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;

  const normalMap = new THREE.CanvasTexture(normalCanvas);
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.anisotropy = 8;

  /* Roughness from the same height field: flecks sit smooth and shiny, the rock
   * around them stays rough, so the specular breaks up per-fleck. */
  const roughCanvas = canvas(S, S);
  const rctx = roughCanvas.getContext('2d');
  const rimg = rctx.createImageData(S, S);
  for (let i = 0, p = 0; i < height.length; i++, p += 4) {
    const g = Math.round(255 * (1.0 - Math.min(1, height[i] * 0.85)));
    rimg.data[p] = rimg.data[p + 1] = rimg.data[p + 2] = g;
    rimg.data[p + 3] = 255;
  }
  rctx.putImageData(rimg, 0, 0);
  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;

  /* Iridescence thickness map -- the reason their column shifts cyan/teal/violet
   * across its surface.
   *
   * That look is thin-film interference, not coloured speckle: the hue depends
   * on film thickness and view angle, which is why it slides as the column
   * turns. MeshPhysicalMaterial samples this map's GREEN channel and remaps it
   * across iridescenceThicknessRange, so a smooth low-frequency field here gives
   * broad wandering hue bands, and the finer octave breaks them up so they read
   * as oil-on-water rather than airbrushed gradients.
   *
   * Deliberately separate from the height field above: the flecks are physical
   * relief, the film is a coating over the whole surface. Driving one from the
   * other would tie the hue to the bumps and read as stained rock. */
  const thickCanvas = canvas(S, S);
  const tctx = thickCanvas.getContext('2d');
  const timg = tctx.createImageData(S, S);
  const tn = makeNoise((opts.seed ?? 91) + 404);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const broad = tn(u * 2.4, v * 2.4, 3) * 0.5 + 0.5;      // wandering bands
      const fine = tn(u * 9.0 + 5, v * 9.0 - 3, 2) * 0.5 + 0.5; // break-up
      const t = Math.min(1, Math.max(0, broad * 0.78 + fine * 0.22));
      const g = Math.round(t * 255);
      const i = (y * S + x) * 4;
      timg.data[i] = g; timg.data[i + 1] = g; timg.data[i + 2] = g;
      timg.data[i + 3] = 255;
    }
  }
  tctx.putImageData(timg, 0, 0);
  const thicknessMap = new THREE.CanvasTexture(thickCanvas);
  thicknessMap.wrapS = thicknessMap.wrapT = THREE.RepeatWrapping;

  return { map, normalMap, roughnessMap, thicknessMap };
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
