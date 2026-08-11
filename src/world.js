import * as THREE from 'three';
import { makeBubbleMatcap } from './textures.js';
import { rand } from './rng.js';

/* Placeholder spine + ambience. Deliberately lightweight: the real spine mesh
 * is coming in as a GLB, so this only has to establish correct scale, silhouette
 * and colour for the cards to sit against.
 *
 * Scale is set by the card shaders' authored constants (see cards.js): cards are
 * ~3.4 units wide and the camera sits ~4 units back, so the spine is ~0.5 units
 * across and the whole column is ~50 units tall. */

/* The column runs well above the first card pair and below the last, so there
 * is always spine behind a card — cards must never float against empty space. */
/* Cards orbit the Y axis at radius 3.8 and drop 0.12 * min(7, n) per item, so
 * 14 cards span y 0 down to about -10.9. The column runs past both ends. */
export const SPINE_TOP = 6;
export const SPINE_BOTTOM = -20;

// The original's cards sit on a mathematical helix around x=0,z=0, so the
// column stays on the axis rather than wandering off it.
export function spinePath(y) {
  return new THREE.Vector3(0, y, 0);
}

function iridescentMaterial(shared) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime },
    transparent: true,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      attribute float aSeed;
      uniform float uTime;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying float vSeed;
      void main() {
        vSeed = aSeed;
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vViewDir = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying float vSeed;
      vec3 hsv2rgb(vec3 c){
        vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
        vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
        return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
      }
      void main() {
        vec3 N = normalize(vNormalW);
        float fres = pow(1.0 - clamp(dot(N, normalize(vViewDir)), 0.0, 1.0), 2.2);
        float hue = 0.72 + fres * 0.32 + sin(vSeed + uTime * 0.1) * 0.05;
        vec3 col = hsv2rgb(vec3(fract(hue), 0.40, 1.0));
        vec3 base = mix(vec3(0.04, 0.045, 0.07), col, 0.5) + col * fres * 1.4;
        gl_FragColor = vec4(base, clamp(0.25 + fres * 0.7, 0.0, 1.0));
      }
    `,
  });
}

function seed(geo, count) {
  const s = new Float32Array(count);
  for (let i = 0; i < count; i++) s[i] = rand() * 100;
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(s, 1));
}

export function buildSpine(shared) {
  const group = new THREE.Group();
  const mat = iridescentMaterial(shared);

  // vertebrae
  const COUNT = 300;
  const geo = new THREE.TorusGeometry(0.40, 0.15, 8, 20);
  geo.rotateX(Math.PI / 2);
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const step = (SPINE_TOP - SPINE_BOTTOM) / COUNT;
  for (let i = 0; i < COUNT; i++) {
    const y = SPINE_TOP - i * step;
    const wide = i % 3 !== 2;
    const r = wide ? 1.0 + Math.sin(i * 1.7) * 0.16 : 0.6;
    s.set(r, wide ? 0.5 : 0.8, r);
    q.setFromEuler(new THREE.Euler(Math.sin(i * 0.7) * 0.12, i * 0.22, Math.cos(i * 0.5) * 0.12));
    m.compose(spinePath(y), q, s);
    mesh.setMatrixAt(i, m);
  }
  seed(geo, COUNT);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  group.add(mesh);

  // fronds
  const BCOUNT = 700;
  const bgeo = new THREE.ConeGeometry(0.11, 0.55, 4, 1, true);
  bgeo.translate(0, 0.27, 0);
  bgeo.scale(1, 1, 0.3);
  const blades = new THREE.InstancedMesh(bgeo, mat, BCOUNT);
  for (let i = 0; i < BCOUNT; i++) {
    const y = SPINE_TOP - rand() * (SPINE_TOP - SPINE_BOTTOM);
    const p = spinePath(y);
    const a = rand() * Math.PI * 2;
    const r = 0.28 + rand() * 0.16;
    p.x += Math.cos(a) * r;
    p.z += Math.sin(a) * r;
    const sc = 0.5 + rand() * 1.4;
    s.set(sc, sc * (0.7 + rand()), sc);
    q.setFromEuler(new THREE.Euler(0, -a, 0));
    q.multiply(new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0), Math.PI * 0.5 - 0.35 - rand() * 0.8));
    m.compose(p, q, s);
    blades.setMatrixAt(i, m);
  }
  seed(bgeo, BCOUNT);
  blades.instanceMatrix.needsUpdate = true;
  blades.frustumCulled = false;
  group.add(blades);

  return group;
}

/* ------------------------------------------------------------------ *
 *  Particle burst around the spine
 * ------------------------------------------------------------------ */
/* ---- 3D value noise, for the particle density field ---------------------- */
function makeNoise3(seed = 1) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const perm = new Uint8Array(512);
  const src = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [src[i], src[j]] = [src[j], src[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = src[i & 255];

  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + t * (b - a);
  const g = (h, x, y, z) => {
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
    return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
  };
  const noise = (x, y, z) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);
    const A = perm[X] + Y, AA = perm[A & 255] + Z, AB = perm[(A + 1) & 255] + Z;
    const B = perm[(X + 1) & 255] + Y, BA = perm[B & 255] + Z, BB = perm[(B + 1) & 255] + Z;
    return lerp(
      lerp(lerp(g(perm[AA & 255] & 15, x, y, z), g(perm[BA & 255] & 15, x - 1, y, z), u),
           lerp(g(perm[AB & 255] & 15, x, y - 1, z), g(perm[BB & 255] & 15, x - 1, y - 1, z), u), v),
      lerp(lerp(g(perm[(AA + 1) & 255] & 15, x, y, z - 1), g(perm[(BA + 1) & 255] & 15, x - 1, y, z - 1), u),
           lerp(g(perm[(AB + 1) & 255] & 15, x, y - 1, z - 1), g(perm[(BB + 1) & 255] & 15, x - 1, y - 1, z - 1), u), v), w);
  };
  const fbm = (x, y, z, oct = 4) => {
    let f = 0, a = 0.5, fr = 1;
    for (let i = 0; i < oct; i++) { f += a * noise(x * fr, y * fr, z * fr); fr *= 2.02; a *= 0.5; }
    return f;
  };
  return { noise, fbm };
}

/* Green-dominant glitter, tinted to the spine's emissive. A few cooler and
 * warmer accents are kept so clumps do not read as one flat hue — the original
 * blooms are multi-toned even when one colour dominates. */
export const PALETTE = [
  new THREE.Color('#7dd63a'), new THREE.Color('#a8e838'), new THREE.Color('#4fb02a'),
  new THREE.Color('#c8ff6a'), new THREE.Color('#d8ff9a'), new THREE.Color('#2f8f22'),
  new THREE.Color('#48bdb5'), new THREE.Color('#e9f9ff'),
];

/**
 * Particle bloom around the spine.
 *
 * The original runs this on the GPU: FlowerParticleShader reads positions out
 * of `tPos`, an Antimatter GPGPU simulation whose particles ride a curl-noise
 * flow field. That is the trick behind the density — grains are not scattered
 * independently, they are *advected along a noise field*, so they pile into
 * connected wispy sheets with organic voids between them rather than forming
 * separate blobs.
 *
 * Reproduced here on the CPU with the same two ingredients:
 *   1. rejection-sample against an fbm density field, so grains only survive
 *      where the field is dense — this carves the voids and the filaments
 *   2. displace survivors along a curl-ish gradient of that field, which drags
 *      them into strands instead of leaving spherical clumps
 */
export function buildParticles(shared, count = 60000) {
  const { fbm } = makeNoise3(1337);

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const rnd = new Float32Array(count * 3);       // seed, sizeBias, speed
  let n = 0;

  const put = (x, y, z, c, boost, size) => {
    pos[n * 3] = x; pos[n * 3 + 1] = y; pos[n * 3 + 2] = z;
    col[n * 3] = c.r * boost; col[n * 3 + 1] = c.g * boost; col[n * 3 + 2] = c.b * boost;
    rnd[n * 3] = rand() * 100;
    rnd[n * 3 + 1] = size;
    rnd[n * 3 + 2] = 0.3 + rand();
    n++;
  };

  const span = SPINE_TOP - SPINE_BOTTOM;
  const DENS = 0.62;    // density field frequency
  const clumpTarget = Math.floor(count * 0.93);
  let guard = 0;

  while (n < clumpTarget && guard < clumpTarget * 60) {
    guard++;
    const y = SPINE_TOP - rand() * span;
    const a = rand() * Math.PI * 2;
    // radial profile: hugs the column, long thin tail outward — biased tighter
    // to the spine than a flat pow(2) so the blooms read as one dense mass
    // clinging to the column rather than dust drifting away from it
    const r = 0.42 + Math.pow(rand(), 2.6) * 3.4;
    const base = spinePath(y);
    let x = base.x + Math.cos(a) * r;
    let z = base.z + Math.sin(a) * r;

    // --- density field. Two octaves at different scales gives big lobes with
    //     fine granular structure inside them.
    const coarse = fbm(x * DENS, y * DENS * 0.7, z * DENS, 4) * 0.5 + 0.5;
    const fine = fbm(x * DENS * 3.1 + 11, y * DENS * 3.1, z * DENS * 3.1 - 7, 3) * 0.5 + 0.5;
    let d = Math.pow(coarse, 1.6) * (0.55 + fine * 0.75);
    // thin out with distance from the column
    d *= Math.max(0, 1 - (r - 0.42) / 3.4) ** 1.1;
    if (rand() > d * 2.6) continue;        // rejection sample

    // --- curl-ish displacement: offset the sample point and take the field's
    //     gradient, then push along its perpendicular. Drags grains into
    //     filaments the way an advected GPGPU system does.
    const e = 0.35;
    const gx = fbm((x + e) * DENS, y * DENS, z * DENS, 2) - fbm((x - e) * DENS, y * DENS, z * DENS, 2);
    const gy = fbm(x * DENS, (y + e) * DENS, z * DENS, 2) - fbm(x * DENS, (y - e) * DENS, z * DENS, 2);
    const gz = fbm(x * DENS, y * DENS, (z + e) * DENS, 2) - fbm(x * DENS, y * DENS, (z - e) * DENS, 2);
    const w = 0.85;
    x += (gy - gz) * w;
    const yy = y + (gz - gx) * w * 0.7;
    z += (gx - gy) * w;

    /* Colour follows the coarse field rather than being picked per grain, so
     * neighbouring particles share a hue and clumps read as one organism. */
    const hueIdx = Math.min(PALETTE.length - 1,
      Math.floor((coarse * 0.75 + rand() * 0.25) * PALETTE.length));
    const c = PALETTE[hueIdx];

    put(x, yy, z, c,
        0.45 + d * 0.9 + rand() * 0.5,
        0.26 + Math.pow(rand(), 3.5) * 1.0);
  }

  // ---- fine dust filling the remainder, drifting wider
  while (n < count) {
    const y = SPINE_TOP - rand() * span;
    const p = spinePath(y);
    const radius = 0.7 + Math.pow(rand(), 2.4) * 5.5;
    const angle = rand() * Math.PI * 2;
    const c = PALETTE[(rand() * PALETTE.length) | 0];
    put(p.x + Math.cos(angle) * radius, y + (rand() - 0.5) * 1.2,
        p.z + Math.sin(angle) * radius, c, 0.3 + rand() * 0.5,
        0.22 + rand() * 0.3);
  }

  console.log('particles', { placed: n, requested: count, rejectionTries: guard });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 3));

  /* Shading technique ported from Active Theory's own FlowerParticleShader.glsl
   * (extracted live from activetheory.net/assets/shaders/compiled.vs — see
   * README). Their grains are not soft additive glow: each is a matcap-shaded
   * "bubble" (soft-light + overlay blend of a sphere-shaded texture), pushed
   * through an HSV hue/saturation grade, rendered near-opaque with a hard
   * circular cutout and only occasional sparkle flashes. That is what reads as
   * a dense sculpted mass rather than flat dust. tMap/tPointColor/tLightTexture
   * are proprietary UIL-bound textures and are not redistributed, so the
   * bubble matcap is regenerated procedurally (textures.js#makeBubbleMatcap)
   * and colour comes from our own per-vertex palette instead of their texture.
   *
   * Blending stays additive rather than matching their near-opaque draw: at
   * this count the sprites cover ~1.5x the screen, so opaque normal-blended
   * discs stack into a solid milky sheet instead of reading as glitter. AT can
   * afford opaque grains because theirs are GPU-advected and far sparser
   * on screen; ours need overlaps to sum as brightness, not as coverage. */
  const matcap = makeBubbleMatcap();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime, uDPR: shared.uDPR, uScrollDelta: shared.uScrollDelta,
      uMatcap: { value: matcap },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute vec3 aColor, aRnd;   // seed, sizeBias, speed
      uniform float uTime, uDPR, uScrollDelta;
      varying vec3 vColor;
      varying float vFade;
      varying float vSparkle;
      varying vec3 vWorldPos;
      varying vec3 vRnd;
      void main() {
        vColor = aColor;
        vRnd = aRnd;
        vec3 p = position;

        // slow breathing drift so the blooms shimmer rather than sit still
        float s = aRnd.x;
        p.x += sin(uTime * 0.22 * aRnd.z + s) * 0.05;
        p.y += cos(uTime * 0.18 * aRnd.z + s * 1.7) * 0.05;
        p.z += sin(uTime * 0.20 * aRnd.z + s * 2.3) * 0.05;
        p.y -= uScrollDelta * 0.02 * aRnd.z;
        vWorldPos = p;

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = length(mv.xyz);
        vFade = smoothstep(38.0, 1.0, dist);
        // uSparkle equivalent: grains twinkle out of phase with each other
        vSparkle = 0.55 + 0.45 * sin(uTime * 2.6 * aRnd.z + s * 6.2831);
        // per-particle size pulse, mirroring their vScale
        float pulse = 1.0 + 0.3 * sin(uTime * 5.0 + s * 20.0);
        // floor the size so distant grains stay visible instead of dropping
        // below a pixel and disappearing into the bloom
        gl_PointSize = max(1.3, (6.4 * uDPR) * aRnd.y * pulse * (8.0 / dist));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uMatcap;
      uniform float uTime;
      varying vec3 vColor;
      varying float vFade;
      varying float vSparkle;
      varying vec3 vWorldPos;
      varying vec3 vRnd;

      vec3 rgb2hsv(vec3 c) {
        vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
        vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
        vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
        float d = q.x - min(q.w, q.y);
        float e = 1.0e-10;
        return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
      }
      vec3 hsv2rgb(vec3 c) {
        vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
        vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
        return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
      }
      float softLightC(float b, float s) {
        return s < 0.5 ? 2.0 * b * s + b * b * (1.0 - 2.0 * s) : sqrt(b) * (2.0 * s - 1.0) + 2.0 * b * (1.0 - s);
      }
      vec3 blendSoftLight(vec3 base, vec3 blend, float o) {
        vec3 r = vec3(softLightC(base.r, blend.r), softLightC(base.g, blend.g), softLightC(base.b, blend.b));
        return mix(base, r, o);
      }
      vec3 blendOverlay(vec3 base, vec3 blend, float o) {
        vec3 r = mix(2.0 * base * blend, 1.0 - 2.0 * (1.0 - base) * (1.0 - blend), step(0.5, base));
        return mix(base, r, o);
      }

      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        if (d > 0.5) discard;
        // real falloff, not a hard-edged disc -- overlapping hard discs tile
        // into a sheet, a falloff keeps grains separable where they stack
        float edge = smoothstep(0.5, 0.15, d);

        vec3 matcap = texture2D(uMatcap, gl_PointCoord).rgb;
        vec3 color = vColor;
        color = blendSoftLight(color, matcap, 0.45);
        color = blendOverlay(color, matcap, 0.18);

        // organic hue drift, echoing their world-position-driven noise term
        float n = sin(vWorldPos.x * 0.6 + uTime * 0.15)
                * sin(vWorldPos.y * 0.5 - uTime * 0.1)
                * sin(vWorldPos.z * 0.7 + uTime * 0.12);
        color = rgb2hsv(color);
        color.x += n * 0.025;
        color.y *= 1.05;
        color = hsv2rgb(color);

        vec3 sparkle = vec3(1.0, 1.0, 0.95);
        color = mix(color, sparkle, smoothstep(0.75, 1.0, vSparkle) * pow(fract(vRnd.x * 13.0), 12.0) * 0.6);

        color *= mix(0.6, 1.2, vFade);
        gl_FragColor = vec4(color, vFade * edge * 0.55);
      }
    `,
  });

  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}
