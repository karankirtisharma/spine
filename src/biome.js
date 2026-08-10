import * as THREE from 'three';
import { NOISE } from './shaders.js';

/* THE BIOME — structured foliage masses with particle breakup.
 *
 * The failed frame this replaces rendered the bake as one camera-enveloping
 * ribbon: radially symmetric around the eye, so every screen region carried the
 * same dot statistics — unstructured particle fog. The reference frame is the
 * opposite: a handful of PLACED masses framing the mark, black voids between
 * them, and particles only where a mass is dissolving.
 *
 * Architecture, per the brief:
 *
 *   foliage geometry (their scanned bake — real vegetation clumps)
 *        ↓ dense-seed detection        (a mass grows where the SCAN is dense)
 *        ↓ patch carve per cluster     (each mass carries authored micro-structure)
 *        ↓ placed in the burst frame   (composition, not distribution)
 *        ↓ GPU density field           (core solid → rim lottery → sparse flecks)
 *        ↓ noise drift on loose points (the mass visibly sheds particles)
 *
 * density = clusterMask(aD) — evaluated per point against its cluster's core,
 * controlling survival, size, drift amplitude and brightness. Points at the rim
 * that win the lottery detach and float; everything else is solid, opaque and
 * depth-tested so masses OCCLUDE — dark gaps are real, not painted.
 *
 * One draw call per mass, one shared program, typed arrays end to end.
 */

const BIOME_VS = /* glsl */`
attribute vec3 aColor;
attribute vec4 aRandom;
attribute float aD;          // 0..1 normalised distance from the cluster core

uniform float uTime, uDPR;
uniform float uReveal;       // burst progress, staged
uniform float uBright;
uniform float uSizePx;       // per-cluster grain size
uniform float uMaxPx;
uniform float uCoreStart;    // where the core ends and dissolution begins
uniform float uKeepFloor;    // survival probability at the rim (the floaters)
uniform float uDrift;        // rim drift amplitude, bake units

varying vec3 vColor;
varying vec4 vRand;
varying float vLoose;
varying float vFog;

uniform float uFogK;

${NOISE}

void main() {
  /* The density field. core=1 deep inside the mass, 0 at the rim. The carve
   * boundary is warped by coherent noise BEFORE the smoothstep, so the mass
   * silhouette is lobed and organic rather than the sphere the carve used --
   * per-point jitter here would read as fuzz; coherent noise reads as growth. */
  float d = aD + cnoise(position * 0.32 + vec3(7.3)) * 0.22;
  float core = 1.0 - smoothstep(uCoreStart, 1.0, d);
  float loose = 1.0 - core;

  /* Survival lottery: everything survives in the core; toward the rim only
   * uKeepFloor of points remain, as detached floaters. aRandom.w is a fixed
   * ticket, so the survivor set is stable frame to frame. */
  float keep = step(aRandom.w, mix(uKeepFloor, 1.0, core));
  float reveal = smoothstep(0.0, 1.0, uReveal);
  if (keep < 0.5 || reveal < 0.02) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // clipped, zero fragment cost
    gl_PointSize = 0.0;
    return;
  }

  vec3 pos = position;

  /* Drift: barely-there breathing in the core, real wander on loose points --
   * the dissolution has MOTION, matter drifting off the mass. Curl-ish: two
   * decorrelated noise reads, no straight random walk. */
  float n1 = cnoise(position * 0.22 + uTime * 0.045 + aRandom.x * 6.0);
  float n2 = cnoise(position * 0.19 - uTime * 0.038 + aRandom.y * 9.0);
  float amp = 0.05 + loose * loose * uDrift;
  pos += vec3(n1, n2 * 0.7, -n1 * 0.6) * amp;
  /* loose points bob upward slowly -- spores, not rain */
  pos.y += loose * (0.3 + aRandom.y * 0.9) * (0.5 + 0.5 * sin(uTime * 0.14 + aRandom.z * 8.0));

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  float len = max(1e-3, length(mv.xyz));

  /* Sizing: cores run full size and FUSE into solid mass; loose points shrink
   * to flecks. Twinkle is a few percent, not a strobe. */
  float tw = 1.0 + sin(uTime * 3.0 + aRandom.y * 20.0) * 0.06;
  float psize = uSizePx * uDPR * (26.0 / len) * mix(0.4, 1.0, core) * tw * reveal;
  gl_PointSize = clamp(psize, 0.0, uMaxPx);

  vColor = aColor;
  vRand = aRandom;
  vLoose = loose;
  /* exp2 fog against true view distance, matched to the scene's FogExp2 -- this
   * shader is custom so it gets no fog chunks for free. */
  vFog = 1.0 - exp(-uFogK * uFogK * len * len);
  gl_Position = projectionMatrix * mv;
}`;

const BIOME_FS = /* glsl */`
uniform sampler2D uMatcap;
uniform float uTime, uBright, uGlint;
uniform vec3 uFogColor;

varying vec3 vColor;
varying vec4 vRand;
varying float vLoose;
varying float vFog;

vec2 rotateUV(vec2 uv, float r) {
  float c = cos(r), s = sin(r);
  vec2 p = uv - 0.5;
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c) + 0.5;
}
float softLightC(float b, float s) {
  return s < 0.5 ? 2.0 * b * s + b * b * (1.0 - 2.0 * s)
                 : sqrt(b) * (2.0 * s - 1.0) + 2.0 * b * (1.0 - s);
}

void main() {
  vec2 uv = vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y);
  if (length(uv - 0.5) > 0.5) discard;

  vec3 color = vColor;

  /* Their matcap trick, kept: a rotating sample soft-lit over the grain gives
   * each point internal shading so clumps read as material, not confetti. */
  vec2 mUV = rotateUV(uv, sin(uTime * 0.9 + vRand.z * 20.0) * 0.5 + 1.0);
  vec3 matcap = texture2D(uMatcap, mUV).rgb;
  color = vec3(softLightC(color.r, matcap.r), softLightC(color.g, matcap.g), softLightC(color.b, matcap.b));

  /* Sparse pale glints -- the ~1.5% of grains catching light. This is the ONLY
   * thing meant to clear the bloom threshold inside a mass. */
  float glint = step(0.985, vRand.x) * (0.35 + 0.65 * max(0.0, sin(uTime * 2.1 + vRand.y * 30.0)));
  color += vec3(0.72, 0.9, 0.62) * glint * uGlint;

  /* Loose flecks run a touch brighter: matter catching light as it breaks off. */
  color *= 1.0 + vLoose * 0.25;

  color *= uBright;
  color = mix(color, uFogColor, clamp(vFog, 0.0, 1.0));

  /* HalfFloat + bloom project rule: cap the output, no spikes into the mips. */
  gl_FragColor = vec4(min(color, vec3(1.1)), 1.0);
}`;

/* Dense-seed detection: coarse grid histogram over a stride sample of the bake.
 * The densest well-separated cells are where the SCAN says vegetation clumps --
 * carving patches there keeps every mass authored, not procedural. */
function findSeeds(position, count, want, minSep) {
  const stride = Math.max(1, Math.floor(count / 60000));
  const cell = 2.2;
  const map = new Map();
  for (let i = 0; i < count; i += stride) {
    const k = Math.round(position[i * 3] / cell) + ','
            + Math.round(position[i * 3 + 1] / cell) + ','
            + Math.round(position[i * 3 + 2] / cell);
    map.set(k, (map.get(k) || 0) + 1);
  }
  const cells = [...map.entries()].map(([k, n]) => {
    const [x, y, z] = k.split(',').map(Number);
    return { p: [x * cell, y * cell, z * cell], n };
  }).sort((a, b) => b.n - a.n);

  const seeds = [];
  for (const c of cells) {
    if (seeds.length >= want) break;
    if (seeds.every(s => Math.hypot(s[0] - c.p[0], s[1] - c.p[1], s[2] - c.p[2]) >= minSep)) {
      seeds.push(c.p);
    }
  }
  // pathological bake: fall back to reusing the densest cell
  while (seeds.length < want) seeds.push(cells[0] ? cells[0].p : [0, 0, 0]);
  return seeds;
}

/* Solve the carve radius that captures ~targetPts around a seed, from a stride
 * sample -- patch density varies wildly across the bake, so a fixed radius
 * would give one mass 8k points and another 400k. */
function solveRadius(position, count, seed, targetPts) {
  const stride = Math.max(1, Math.floor(count / 50000));
  const sampled = Math.ceil(count / stride);
  const wantSampled = targetPts / count * sampled;
  let lo = 1.0, hi = 20.0;
  for (let it = 0; it < 9; it++) {
    const mid = (lo + hi) / 2;
    const m2 = mid * mid;
    let n = 0;
    for (let i = 0; i < count; i += stride) {
      const dx = position[i * 3] - seed[0];
      const dy = position[i * 3 + 1] - seed[1];
      const dz = position[i * 3 + 2] - seed[2];
      if (dx * dx + dy * dy + dz * dz < m2) n++;
    }
    if (n < wantSampled) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * @param shared   { uTime, uDPR } — the scene's shared uniforms
 * @param cloud    { position, color, count } — bake positions + RETINTED colours
 * @param matcap   texture standing in for their tMap
 * @param opts.clusters  [{ at:[x,y,z], r, pts, bright, sizePx, maxPx, glint, drift }]
 *                 `at` is holder-local (the holder rides camGroup in burst),
 *                 `r` the world radius of the mass, `pts` its point budget.
 * @param opts.fogDensity / fogColor  matched to the scene fog
 */
export function buildBiome(shared, cloud, matcap, opts = {}) {
  const { position, color, count } = cloud;
  const specs = opts.clusters ?? [];

  const seeds = findSeeds(position, count, specs.length, 6.0);

  const group = new THREE.Group();
  const uniformsList = [];
  const stats = [];

  for (let ci = 0; ci < specs.length; ci++) {
    const spec = specs[ci];
    const seed = seeds[ci];
    const target = spec.pts ?? 70000;
    const srcR = solveRadius(position, count, seed, target);
    const srcR2 = srcR * srcR;

    /* Exact gather. Hard cap at 1.5x target via stride skip so a mis-estimate
     * cannot balloon one mass into half the bake. */
    const idx = [];
    for (let i = 0; i < count; i++) {
      const dx = position[i * 3] - seed[0];
      const dy = position[i * 3 + 1] - seed[1];
      const dz = position[i * 3 + 2] - seed[2];
      if (dx * dx + dy * dy + dz * dz < srcR2) idx.push(i);
    }
    const cap = Math.ceil(target * 1.5);
    const skip = idx.length > cap ? idx.length / cap : 1;

    const n = Math.min(idx.length, cap);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const rnd = new Float32Array(n * 4);
    const dst = new Float32Array(n);
    for (let w = 0; w < n; w++) {
      const i = idx[Math.floor(w * skip)];
      const dx = position[i * 3] - seed[0];
      const dy = position[i * 3 + 1] - seed[1];
      const dz = position[i * 3 + 2] - seed[2];
      pos[w * 3] = dx; pos[w * 3 + 1] = dy; pos[w * 3 + 2] = dz;
      col[w * 3] = color[i * 3]; col[w * 3 + 1] = color[i * 3 + 1]; col[w * 3 + 2] = color[i * 3 + 2];
      rnd[w * 4] = Math.random(); rnd[w * 4 + 1] = Math.random();
      rnd[w * 4 + 2] = Math.random(); rnd[w * 4 + 3] = Math.random();
      dst[w] = Math.sqrt(dx * dx + dy * dy + dz * dz) / srcR;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aRandom', new THREE.BufferAttribute(rnd, 4));
    geo.setAttribute('aD', new THREE.BufferAttribute(dst, 1));

    const uniforms = {
      uTime: shared.uTime,
      uDPR: shared.uDPR,
      uReveal: { value: 0 },
      uBright: { value: spec.bright ?? 0.4 },
      uSizePx: { value: spec.sizePx ?? 3.0 },
      uMaxPx: { value: spec.maxPx ?? 7.0 },
      /* 0.72, not 0.55: the bake is sheet-like, so point count grows with
       * radius^2 and MOST carved points sit in the outer band. A core ending at
       * 0.55 put the bulk of every mass into the dissolution lottery and the
       * body came out as thin speckle. */
      uCoreStart: { value: spec.coreStart ?? 0.72 },
      uKeepFloor: { value: spec.keepFloor ?? 0.1 },
      uDrift: { value: spec.drift ?? 1.4 },
      uGlint: { value: spec.glint ?? 0.7 },
      uFogK: { value: opts.fogDensity ?? 0.022 },
      uFogColor: { value: new THREE.Color(opts.fogColor ?? '#04100a') },
      uMatcap: { value: matcap },
    };

    /* Opaque, depth-tested: masses occlude -- the screens, the shaft, each
     * other. This is what separates structure from scrim. */
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: BIOME_VS,
      fragmentShader: BIOME_FS,
      transparent: false,
      depthWrite: true,
      depthTest: true,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.position.fromArray(spec.at);
    points.scale.setScalar((spec.r ?? 5) / srcR);
    /* each mass spun differently so two patches from one neighbourhood never
     * read as the same billboard twice */
    points.rotation.set(0, ci * 2.399, (spec.roll ?? 0));
    group.add(points);

    uniformsList.push(uniforms);
    stats.push({ i: ci, pts: n, srcR: +srcR.toFixed(2), seed: seed.map(v => +v.toFixed(1)) });
  }

  return {
    group, uniformsList, stats,
    /** burst progress in, all masses grow in with the room */
    setReveal(p) {
      const k = Math.min(1, Math.max(0, p));
      for (const u of uniformsList) u.uReveal.value = k;
    },
  };
}
