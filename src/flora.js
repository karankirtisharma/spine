import * as THREE from 'three';
import { NOISE } from './shaders.js';

/* FLORA — actual low-poly vegetation geometry, GPU-instanced.
 *
 * This REPLACES the point-cloud foliage outright. The rule that governs the
 * whole file: the silhouette is made of geometry, never of particles. A blade
 * of grass is a tapered ribbon of triangles that tapers to a point; a fern is a
 * stem with leaflets attached along it; moss is a tuft of short blades hugging
 * its surface. Disable the dust layer entirely (?flora=solo) and the frame must
 * still read as vegetation -- that is the acceptance test.
 *
 * Structure:
 *
 *   PROTOTYPES   grass tuft / fern bush / leaf shrub / moss pad / hanging vine
 *                built from primitives (blade, leaf, stem+leaflets) in code
 *        |
 *   BEDS         oriented, noise-warped elliptical patches -- the ground, the
 *                walls, the ceiling. Scatter is ON a surface with the surface's
 *                normal as UP, so grass points up, moss hugs, vines hang.
 *        |
 *   INSTANCES    one InstancedBufferGeometry per prototype, per-instance
 *                offset / quaternion / scale / random / edge factor
 *        |
 *   DUST         a SECONDARY layer: points sampled off the prototype surfaces
 *                of RIM instances, carrying the same transform, drifting out.
 *                The particles are made of the plants, not the other way round.
 */

/* ------------------------------------------------------------------ *
 *  Primitives — real geometry, in a local frame with +Y as "up the plant"
 * ------------------------------------------------------------------ */

/** Accumulator: flat arrays we append primitives into. */
const acc = () => ({ pos: [], nrm: [], hgt: [], idx: [] });

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * A tapered ribbon: the shared body of a grass blade, a stem and a leaf.
 * `profile(t)` returns the half-width at height fraction t, which is the only
 * difference between them — grass tapers monotonically to a point, a leaf
 * swells in the middle and closes at both ends.
 */
function pushRibbon(a, m4, { h, w, bend = 0.2, curve = 1.7, seg = 5, curl = 0.35, profile }) {
  const base = a.pos.length / 3;
  const prof = profile ?? (t => Math.pow(1 - t, 0.65));
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const y = h * t;
    const x = bend * Math.pow(t, curve);
    const hw = w * prof(t);
    /* the ribbon is channelled, not flat: the edges curl back along -Z. That
     * curvature is what makes a blade catch light along its spine instead of
     * reading as a paper cutout. */
    const z = -curl * hw;
    for (const s of [-1, 1]) {
      _v.set(x + s * hw, y, z).applyMatrix4(m4);
      a.pos.push(_v.x, _v.y, _v.z);
      /* normal of a channelled ribbon: mostly +Z, tilted outward by the curl */
      _n.set(s * curl * 0.9, 0, 1).normalize()
        .transformDirection(m4);
      a.nrm.push(_n.x, _n.y, _n.z);
      a.hgt.push(t);
    }
  }
  for (let i = 0; i < seg; i++) {
    const o = base + i * 2;
    a.idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
  }
}

/** Grass blade / stem: tapers to a point. */
const pushBlade = (a, m4, o) => pushRibbon(a, m4, o);

/** Leaf: lens profile — closed at the base, widest at 45%, pointed at the tip. */
const pushLeaf = (a, m4, o) => pushRibbon(a, m4, {
  seg: 4, curve: 1.4, curl: 0.5,
  profile: t => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.85),
  ...o,
});

const rnd = (a, b) => a + Math.random() * (b - a);

/** Reusable scratch so prototype building allocates almost nothing. */
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();

function place(pos, euler) {
  _e.set(euler[0], euler[1], euler[2]);
  _q.setFromEuler(_e);
  _p.set(pos[0], pos[1], pos[2]);
  return _m.compose(_p, _q, _s).clone();
}

/* ---- the prototypes ------------------------------------------------- */

/** A tuft of grass: blades fanning up and out from a common base. */
function protoGrass() {
  const a = acc();
  const n = 17;
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * Math.PI * 2 + rnd(-0.35, 0.35);
    const tilt = rnd(0.05, 0.42);                    // outward lean from vertical
    const r = rnd(0, 0.11);
    pushBlade(a, place([Math.cos(yaw) * r, 0, Math.sin(yaw) * r], [tilt * Math.cos(yaw + 1.57), -yaw, tilt * Math.sin(yaw + 1.57) + tilt * 0.6]), {
      h: rnd(0.55, 1.35), w: rnd(0.028, 0.055), bend: rnd(0.12, 0.5), seg: 5,
    });
  }
  return a;
}

/** A fern frond: one curving stem carrying paired leaflets that shrink to the tip. */
function pushFrond(a, m4, { h = 1.15, bend = 0.55 } = {}) {
  const stem = new THREE.Matrix4().copy(m4);
  pushBlade(a, stem, { h, w: 0.022, bend, curve: 1.9, seg: 6, curl: 0.1 });
  const pairs = 8;
  for (let i = 1; i <= pairs; i++) {
    const t = i / (pairs + 1);
    const y = h * t;
    const x = bend * Math.pow(t, 1.9);
    /* leaflets shrink toward the tip and sweep forward — that gradient is what
     * makes a frond read as a frond rather than as a bottlebrush */
    const len = (1 - t * 0.72) * rnd(0.26, 0.34);
    for (const side of [-1, 1]) {
      const lm = new THREE.Matrix4().copy(m4).multiply(
        place([x, y, 0], [0, 0, side * (1.15 - t * 0.35)]));
      pushLeaf(a, lm, { h: len, w: len * 0.3, bend: side * 0.1, curl: 0.45 });
    }
  }
}

function protoFern() {
  const a = acc();
  const n = 5;
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * Math.PI * 2 + rnd(-0.3, 0.3);
    pushFrond(a, place([0, 0, 0], [rnd(0.25, 0.6) * Math.cos(yaw), -yaw, rnd(0.25, 0.6) * Math.sin(yaw)]),
      { h: rnd(0.95, 1.4), bend: rnd(0.4, 0.75) });
  }
  return a;
}

/** A leafy shrub: short stems, each carrying alternating broad leaves. */
function protoShrub() {
  const a = acc();
  const n = 7;
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * Math.PI * 2 + rnd(-0.4, 0.4);
    const tilt = rnd(0.15, 0.55);
    const m = place([Math.cos(yaw) * rnd(0, 0.1), 0, Math.sin(yaw) * rnd(0, 0.1)],
                    [tilt * Math.cos(yaw), -yaw, tilt * Math.sin(yaw)]);
    const h = rnd(0.45, 0.75);
    pushBlade(a, m, { h, w: 0.02, bend: 0.2, seg: 4, curl: 0.1 });
    const leaves = 5;
    for (let k = 1; k <= leaves; k++) {
      const t = k / (leaves + 0.6);
      const side = k % 2 === 0 ? 1 : -1;
      const lm = new THREE.Matrix4().copy(m).multiply(
        place([0.2 * Math.pow(t, 1.7), h * t, 0], [rnd(-0.3, 0.3), 0, side * rnd(0.8, 1.3)]));
      const L = (1 - t * 0.35) * rnd(0.24, 0.36);
      pushLeaf(a, lm, { h: L, w: L * 0.42, bend: side * 0.06, curl: 0.55 });
    }
  }
  return a;
}

/** Moss: a dense low pad of short blades that hugs whatever it grows on. */
function protoMoss() {
  const a = acc();
  const n = 40;
  for (let i = 0; i < n; i++) {
    const yaw = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 0.26;
    pushBlade(a, place([Math.cos(yaw) * r, 0, Math.sin(yaw) * r],
                       [rnd(-0.4, 0.4), yaw, rnd(-0.4, 0.4)]), {
      h: rnd(0.06, 0.19), w: rnd(0.016, 0.03), bend: rnd(0.02, 0.09), seg: 3,
    });
  }
  return a;
}

/** A hanging strand: for ceiling beds, where the bed normal already points down. */
function protoVine() {
  const a = acc();
  const n = 4;
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * Math.PI * 2 + rnd(-0.5, 0.5);
    const m = place([Math.cos(yaw) * rnd(0, 0.18), 0, Math.sin(yaw) * rnd(0, 0.18)],
                    [rnd(-0.12, 0.12), -yaw, rnd(-0.12, 0.12)]);
    const h = rnd(1.3, 2.4);
    pushBlade(a, m, { h, w: 0.018, bend: rnd(0.15, 0.45), curve: 2.1, seg: 7, curl: 0.1 });
    const leaves = 9;
    for (let k = 1; k <= leaves; k++) {
      const t = k / (leaves + 0.5);
      const side = k % 2 === 0 ? 1 : -1;
      const lm = new THREE.Matrix4().copy(m).multiply(
        place([0.4 * Math.pow(t, 2.1), h * t, 0], [rnd(-0.4, 0.4), 0, side * rnd(0.9, 1.4)]));
      const L = rnd(0.14, 0.26);
      pushLeaf(a, lm, { h: L, w: L * 0.38, bend: side * 0.05, curl: 0.5 });
    }
  }
  return a;
}

const PROTOS = { grass: protoGrass, fern: protoFern, shrub: protoShrub, moss: protoMoss, vine: protoVine };

function toGeometry(a) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(a.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(a.nrm, 3));
  g.setAttribute('aH', new THREE.Float32BufferAttribute(a.hgt, 1));
  g.setIndex(a.idx);
  return g;
}

/* ------------------------------------------------------------------ *
 *  Shaders
 * ------------------------------------------------------------------ */

const FLORA_VS = /* glsl */`
attribute vec3 iOffset;
attribute vec4 iQuat;
attribute float iScale;
attribute vec4 iRand;
attribute float iEdge;      // 0 at the bed's core, 1 at its rim
attribute float aH;         // height fraction up the plant

uniform float uTime, uReveal, uWind, uFogK;

varying float vH, vEdge, vFog;
varying vec3 vN, vWorld;
varying vec4 vR;

${NOISE}

vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

void main() {
  /* Growth is staggered per instance so the bed fills in organically rather
   * than inflating as one object. */
  float grow = clamp(uReveal * 1.5 - iRand.z * 0.5, 0.0, 1.0);
  /* Toward the rim the PLANTS thin out and shrink; the dust layer carries the
   * mass onward from there. Geometry never fades to a ghost -- it shrinks and
   * is gone, which is what keeps silhouettes crisp. */
  float rim = 1.0 - smoothstep(0.60, 1.0, iEdge);
  float s = iScale * grow * mix(0.0, 1.0, rim);

  vec3 lp = qrot(iQuat, position * s);

  /* Wind: coherent across neighbours (noise on the instance origin), weighted
   * by height² so roots hold and tips travel. */
  float w1 = cnoise(iOffset * 0.16 + uTime * 0.20);
  float w2 = cnoise(iOffset * 0.13 - uTime * 0.16 + 11.0);
  lp.xz += vec2(w1, w2) * uWind * aH * aH * max(s, 0.001) * 1.6;

  vec3 world = iOffset + lp;
  vec4 mv = modelViewMatrix * vec4(world, 1.0);

  vN = normalize(qrot(iQuat, normal));
  vWorld = world;
  vH = aH;
  vEdge = iEdge;
  vR = iRand;
  float len = max(1e-3, length(mv.xyz));
  vFog = 1.0 - exp(-uFogK * uFogK * len * len);

  gl_Position = projectionMatrix * mv;
}`;

const FLORA_FS = /* glsl */`
uniform vec3 uDeep, uMid, uTip, uFogColor, uLightDir, uLightCol, uRimCol;
uniform float uTime, uBright;

varying float vH, vEdge, vFog;
varying vec3 vN, vWorld;
varying vec4 vR;

void main() {
  /* Thin double-sided geometry: flip the normal on backfaces or half of every
   * plant lights as if it faced away. */
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;

  /* Base colour: dark at the root, moss at mid, pale at the tip, with the
   * per-instance random shifting each plant's whole ramp so a bed is not one
   * repeated green. */
  vec3 base = mix(uDeep, uMid, smoothstep(0.0, 0.75, vH));
  base = mix(base, uTip, smoothstep(0.62, 1.0, vH) * (0.35 + vR.x * 0.65));
  base *= 0.62 + vR.y * 0.7;

  /* Key light + sky/ground ambient. Restrained: the reference is 80-90% dark
   * and the light is doing shaping work, not illumination. */
  float ndl = max(0.0, dot(n, normalize(uLightDir)));
  float sky = 0.5 + 0.5 * n.y;
  vec3 col = base * (0.16 + 0.30 * sky) + base * uLightCol * ndl * 0.95;

  /* Translucency: leaves lit from behind glow along the tips, which is most of
   * what makes vegetation read as alive rather than as painted cardboard. */
  float back = max(0.0, dot(-n, normalize(uLightDir)));
  col += uRimCol * pow(back, 2.5) * vH * 0.5;

  col *= uBright;
  col = mix(col, uFogColor, clamp(vFog, 0.0, 1.0));
  /* HalfFloat + bloom project rule: never hand the mip chain a spike. */
  gl_FragColor = vec4(min(col, vec3(1.1)), 1.0);
}`;

/* The dust layer. Positions are SAMPLED OFF the plants, so every particle
 * begins its life on a leaf and drifts from there. */
const DUST_VS = /* glsl */`
attribute vec4 aRand;
attribute float aEdge;
attribute vec3 aColor;

uniform float uTime, uReveal, uFogK, uSizePx;
uniform vec2 uResolution;

varying vec3 vC;
varying float vFog, vA;

${NOISE}

void main() {
  vec3 p = position;
  /* Curl-ish drift: two decorrelated noise reads plus a slow rise. Amplitude
   * grows with the source plant's rim factor, so dust near a mass's core barely
   * stirs and dust off the rim genuinely leaves. */
  float amp = 0.15 + aEdge * aEdge * 1.9;
  float n1 = cnoise(p * 0.28 + uTime * 0.09 + aRand.x * 5.0);
  float n2 = cnoise(p * 0.24 - uTime * 0.07 + aRand.y * 8.0);
  p += vec3(n1, n2 * 0.6, -n1 * 0.7) * amp;
  p.y += aEdge * (0.25 + aRand.y * 1.1) * (0.5 + 0.5 * sin(uTime * 0.13 + aRand.z * 7.0));

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float len = max(1e-3, length(mv.xyz));
  /* Resolution-relative, not DPR-relative: gl_PointSize is physical pixels, so
   * DPR-only sizing shrinks the grain's share of a taller frame. */
  gl_PointSize = clamp(uSizePx * (uResolution.y / 680.0) * (22.0 / len), 0.0, 4.0);

  vC = aColor;
  vFog = 1.0 - exp(-uFogK * uFogK * len * len);
  vA = clamp(uReveal * 1.3 - aRand.w * 0.3, 0.0, 1.0) * mix(0.35, 1.0, aEdge);
  gl_Position = projectionMatrix * mv;
}`;

const DUST_FS = /* glsl */`
uniform vec3 uFogColor;
varying vec3 vC;
varying float vFog, vA;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = dot(uv, uv);
  if (d > 0.25) discard;
  float a = vA * smoothstep(0.25, 0.02, d);
  vec3 c = mix(vC, uFogColor, clamp(vFog, 0.0, 1.0));
  gl_FragColor = vec4(min(c, vec3(1.1)), a);
}`;

/* ------------------------------------------------------------------ *
 *  Beds — oriented, noise-warped patches that plants grow ON
 * ------------------------------------------------------------------ */

const UP = new THREE.Vector3(0, 1, 0);

/**
 * @param opts.beds  [{ at:[x,y,z], normal:[x,y,z], radius, squash, proto,
 *                      count, scale:[min,max], tilt }]
 *                   `normal` is the surface's up: [0,1,0] floor, [0,-1,0]
 *                   ceiling (vines hang), [±1,0,0] wall (moss hugs).
 * @param opts.dustPer  points sampled per rim instance
 */
export function buildFlora(shared, opts = {}) {
  const group = new THREE.Group();
  const beds = opts.beds ?? [];

  /* One prototype geometry per kind, built once and shared by every bed that
   * uses it — the instancing is what makes thousands of plants affordable. */
  const geos = {};
  const need = new Set(beds.map(b => b.proto));
  for (const k of need) geos[k] = toGeometry(PROTOS[k]());

  /* Group instances by prototype so each kind is ONE draw call. */
  const byProto = {};
  for (const k of need) byProto[k] = { off: [], quat: [], scl: [], rnd: [], edge: [] };

  const dustPos = [], dustRnd = [], dustEdge = [], dustCol = [];
  const RAMP = (opts.dustRamp ?? ['#10241a', '#1b3a24', '#315c38', '#54784b', '#8fae72'])
    .map(h => new THREE.Color(h));
  const dc = new THREE.Color();

  const q = new THREE.Quaternion(), qy = new THREE.Quaternion(), qt = new THREE.Quaternion();
  const nrm = new THREE.Vector3(), tanA = new THREE.Vector3(), tanB = new THREE.Vector3();
  const pos = new THREE.Vector3(), sp = new THREE.Vector3();
  const mat4 = new THREE.Matrix4(), sv = new THREE.Vector3();

  let total = 0;
  for (const bed of beds) {
    const B = byProto[bed.proto];
    nrm.fromArray(bed.normal ?? [0, 1, 0]).normalize();
    /* an orthonormal basis on the surface */
    tanA.set(1, 0, 0);
    if (Math.abs(nrm.dot(tanA)) > 0.9) tanA.set(0, 0, 1);
    tanB.copy(nrm).cross(tanA).normalize();
    tanA.copy(tanB).cross(nrm).normalize();

    const R = bed.radius ?? 5;
    const squash = bed.squash ?? 1;          // elongate the patch along tanA
    const count = bed.count ?? 400;
    const [s0, s1] = bed.scale ?? [0.6, 1.4];

    for (let i = 0; i < count; i++) {
      /* Elliptical, noise-warped boundary — NEVER a rectangle. Rejection keeps
       * the silhouette irregular instead of a clean disc. */
      let u = 0, v = 0, r = 2;
      for (let tries = 0; tries < 8 && r > 1; tries++) {
        u = Math.random() * 2 - 1; v = Math.random() * 2 - 1;
        r = Math.hypot(u, v);
      }
      if (r > 1) continue;
      /* lobe the rim so the patch has bays and promontories */
      const ang = Math.atan2(v, u);
      const lobe = 0.78 + 0.22 * Math.sin(ang * 3 + (bed.seed ?? 0)) + 0.12 * Math.sin(ang * 7 + 1.7);
      const edge = Math.min(1, r / lobe);

      pos.copy(bed.at ? _p.fromArray(bed.at) : _p.set(0, 0, 0));
      pos.addScaledVector(tanA, u * R * squash).addScaledVector(tanB, v * R);
      /* surface relief so a bed is not a flat plane of plants */
      pos.addScaledVector(nrm, (Math.random() - 0.5) * (bed.relief ?? 0.6));

      /* UP is the surface normal, then a random spin about it, then a tilt.
       * This is the whole reason grass points up and moss hugs: orientation is
       * derived from the surface, not randomised. */
      q.setFromUnitVectors(UP, nrm);
      qy.setFromAxisAngle(nrm, Math.random() * Math.PI * 2);
      q.multiply(qy);
      const tilt = bed.tilt ?? 0.18;
      qt.setFromEuler(new THREE.Euler(rnd(-tilt, tilt), 0, rnd(-tilt, tilt)));
      q.multiply(qt);

      const scale = rnd(s0, s1) * (1 - edge * 0.35);
      B.off.push(pos.x, pos.y, pos.z);
      B.quat.push(q.x, q.y, q.z, q.w);
      B.scl.push(scale);
      B.rnd.push(Math.random(), Math.random(), Math.random(), Math.random());
      B.edge.push(edge);
      total++;

      /* ---- THE DUST, sampled OFF this plant.
       * Only rim instances shed, and the count rises with the rim factor, so
       * the particle field is a property of where the vegetation is thinning
       * rather than an independent cloud. */
      const per = Math.round((opts.dustPer ?? 26) * Math.max(0, edge - 0.45) * 2.2);
      if (per > 0) {
        const g = geos[bed.proto];
        const pa = g.attributes.position, ha = g.attributes.aH;
        mat4.compose(pos, q, sv.setScalar(scale));
        for (let k = 0; k < per; k++) {
          const vi = (Math.random() * pa.count) | 0;
          sp.fromBufferAttribute(pa, vi).applyMatrix4(mat4);
          /* a hair off the surface, so dust reads as leaving the plant */
          sp.x += (Math.random() - 0.5) * 0.12;
          sp.y += (Math.random() - 0.5) * 0.12;
          sp.z += (Math.random() - 0.5) * 0.12;
          dustPos.push(sp.x, sp.y, sp.z);
          dustRnd.push(Math.random(), Math.random(), Math.random(), Math.random());
          dustEdge.push(edge);
          const t = Math.min(0.999, ha.getX(vi) * 0.8 + Math.random() * 0.3);
          const f = t * (RAMP.length - 1);
          const i0 = Math.floor(f);
          dc.copy(RAMP[i0]).lerp(RAMP[Math.min(RAMP.length - 1, i0 + 1)], f - i0);
          dustCol.push(dc.r, dc.g, dc.b);
        }
      }
    }
  }

  const uniforms = {
    uTime: shared.uTime,
    uReveal: { value: 0 },
    uWind: { value: opts.wind ?? 0.13 },
    uBright: { value: opts.bright ?? 1 },
    uFogK: { value: opts.fogDensity ?? 0.022 },
    uFogColor: { value: new THREE.Color(opts.fogColor ?? '#04100a') },
    uDeep: { value: new THREE.Color(opts.deep ?? '#020604') },
    uMid: { value: new THREE.Color(opts.mid ?? '#1b3a24') },
    uTip: { value: new THREE.Color(opts.tip ?? '#54784b') },
    uLightDir: { value: new THREE.Vector3().fromArray(opts.lightDir ?? [-0.35, 0.85, 0.4]) },
    uLightCol: { value: new THREE.Color(opts.lightCol ?? '#7d9a63') },
    uRimCol: { value: new THREE.Color(opts.rimCol ?? '#8fae72') },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FLORA_VS,
    fragmentShader: FLORA_FS,
    /* Opaque, depth-tested, double-sided: plants must occlude each other and
     * the room behind them, and thin ribbons are seen from both faces. */
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
  });

  const meshes = [];
  for (const k of need) {
    const B = byProto[k];
    const n = B.scl.length;
    if (!n) continue;
    const src = geos[k];
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = src.index;
    ig.setAttribute('position', src.attributes.position);
    ig.setAttribute('normal', src.attributes.normal);
    ig.setAttribute('aH', src.attributes.aH);
    ig.instanceCount = n;
    ig.setAttribute('iOffset', new THREE.InstancedBufferAttribute(new Float32Array(B.off), 3));
    ig.setAttribute('iQuat', new THREE.InstancedBufferAttribute(new Float32Array(B.quat), 4));
    ig.setAttribute('iScale', new THREE.InstancedBufferAttribute(new Float32Array(B.scl), 1));
    ig.setAttribute('iRand', new THREE.InstancedBufferAttribute(new Float32Array(B.rnd), 4));
    ig.setAttribute('iEdge', new THREE.InstancedBufferAttribute(new Float32Array(B.edge), 1));
    const m = new THREE.Mesh(ig, mat);
    m.frustumCulled = false;
    group.add(m);
    meshes.push({ proto: k, instances: n, tris: (src.index.count / 3) * n });
  }

  /* ---- the dust layer, as its own object so it can be switched off wholesale
   * for the geometry-only acceptance test. */
  const dustUniforms = {
    uTime: shared.uTime,
    uResolution: shared.uResolution,
    uReveal: { value: 0 },
    uSizePx: { value: opts.dustSizePx ?? 1.7 },
    uFogK: uniforms.uFogK,
    uFogColor: uniforms.uFogColor,
  };
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.Float32BufferAttribute(dustPos, 3));
  dustGeo.setAttribute('aRand', new THREE.Float32BufferAttribute(dustRnd, 4));
  dustGeo.setAttribute('aEdge', new THREE.Float32BufferAttribute(dustEdge, 1));
  dustGeo.setAttribute('aColor', new THREE.Float32BufferAttribute(dustCol, 3));
  const dust = new THREE.Points(dustGeo, new THREE.ShaderMaterial({
    uniforms: dustUniforms,
    vertexShader: DUST_VS,
    fragmentShader: DUST_FS,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  }));
  dust.frustumCulled = false;
  group.add(dust);

  return {
    group, dust, uniforms, dustUniforms,
    stats: { plants: total, dust: dustPos.length / 3, draws: meshes.length + 1, meshes },
    setReveal(p) {
      const k = Math.min(1, Math.max(0, p));
      uniforms.uReveal.value = k;
      dustUniforms.uReveal.value = k;
    },
  };
}
