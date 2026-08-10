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

/** A creeper: long trailing strands that fall almost straight, leafed the
 * whole way down. Unlike protoVine (a compact hanging tuft) these are built to
 * be ROOTED OFF-SCREEN and read as growth descending into frame -- the strand
 * is 3-5x longer than the clump is wide, so wherever it is cut by the viewport
 * you see a continuing run of stem rather than the place it started. */
function protoCreeper() {
  const a = acc();
  const n = 5;
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * Math.PI * 2 + rnd(-0.6, 0.6);
    const m = place([Math.cos(yaw) * rnd(0, 0.3), 0, Math.sin(yaw) * rnd(0, 0.3)],
                    [rnd(-0.1, 0.1), -yaw, rnd(-0.1, 0.1)]);
    /* long, and only gently curved: a creeper falls under its own weight, it
     * does not arc like a frond */
    const h = rnd(3.0, 5.2);
    pushBlade(a, m, { h, w: 0.02, bend: rnd(0.25, 0.7), curve: 2.4, seg: 10, curl: 0.08 });
    /* Leaves along the WHOLE length, thinning slightly toward the tip, so the
     * strand carries foliage wherever the frame happens to cut it.
     *
     * NARROW and LANCEOLATE, and deeply channelled. A leaf at w = 0.42*L with a
     * shallow curl is a broad flat card, and at this scale that is exactly what
     * it renders as -- a visible 2D polygon. At 0.24 the silhouette is a blade
     * rather than a paddle, the sharper profile exponent closes both ends to
     * points, and curl 0.85 folds it along its spine so the two halves catch
     * light differently. That fold is what reads as a surface with a direction
     * instead of a flat quad. */
    const leaves = 13;
    for (let k = 1; k <= leaves; k++) {
      const t = k / (leaves + 0.5);
      const side = k % 2 === 0 ? 1 : -1;
      const lm = new THREE.Matrix4().copy(m).multiply(
        place([0.7 * Math.pow(t, 2.4), h * t, 0],
              [rnd(-0.6, 0.6), 0, side * rnd(0.9, 1.5)]));
      const L = (1 - t * 0.3) * rnd(0.15, 0.26);
      pushLeaf(a, lm, {
        h: L, w: L * 0.24, bend: side * 0.05, curl: 0.85,
        profile: t2 => Math.pow(Math.sin(Math.PI * Math.pow(t2, 0.72)), 1.25),
      });
    }
  }
  return a;
}

const PROTOS = {
  grass: protoGrass, fern: protoFern, shrub: protoShrub,
  moss: protoMoss, vine: protoVine, creeper: protoCreeper,
};

/* ------------------------------------------------------------------ *
 *  Leaf cards — the ecosystem's mass layer
 *
 *  Alpha-tested crossed quads carrying painted leaf silhouettes, instanced by
 *  the thousand. The geometry prototypes above stay the foreground/midground
 *  truth; the cards are what buys the reference's DENSITY at a cost the GPU
 *  does not notice. alphaTest (discard), never blended transparency, so they
 *  keep depth-writing and occlude correctly like everything else.
 * ------------------------------------------------------------------ */

/* The atlas: 4x2 cells, painted at build time. Drawn in neutral sage so the
 * shader's ramp does the colouring -- the texture provides SILHOUETTE and vein
 * structure, not the palette. */
function makeLeafAtlas() {
  const W = 1024, H = 512, C = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);

  const grad = (x0, y0, x1, y1, a, b) => {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, a); gr.addColorStop(1, b);
    return gr;
  };

  /* one ovate leaf: base at (0, 0), tip at (0, -len) in the current transform */
  function leaf(len, w, skew = 0) {
    g.beginPath();
    g.moveTo(0, 0);
    g.bezierCurveTo(-w, -len * 0.25, -w * (1 + skew * 0.3), -len * 0.72, 0, -len);
    g.bezierCurveTo(w * (1 - skew * 0.3), -len * 0.72, w, -len * 0.25, 0, 0);
    g.fillStyle = grad(0, 0, 0, -len, '#5a7247', '#93ac78');
    g.fill();
    /* veins: a centre rib plus angled side ribs, brighter than the blade */
    g.strokeStyle = 'rgba(215,230,195,0.5)';
    g.lineWidth = len * 0.012 + 1;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -len * 0.96); g.stroke();
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(215,230,195,0.3)';
    for (let i = 1; i <= 5; i++) {
      const y = -len * (i / 6);
      const vw = w * (1 - i / 6) * 0.8;
      g.beginPath(); g.moveTo(0, y); g.lineTo(-vw, y - len * 0.07); g.stroke();
      g.beginPath(); g.moveTo(0, y); g.lineTo(vw, y - len * 0.07); g.stroke();
    }
  }

  const cell = (i, fn) => {
    g.save();
    g.translate((i % 4) * C + C / 2, Math.floor(i / 4) * C + C * 0.96);
    fn();
    g.restore();
  };

  // 0-2: single leaves, three proportions
  cell(0, () => leaf(C * 0.9, C * 0.30));
  cell(1, () => leaf(C * 0.92, C * 0.18, 0.5));
  cell(2, () => leaf(C * 0.82, C * 0.40, -0.3));
  // 3: willow — long and narrow, slight curve via rotation
  cell(3, () => { g.rotate(0.12); leaf(C * 0.94, C * 0.11); });
  // 4-5: fern fronds — a stem with shrinking leaflets
  for (const [ci, sway] of [[4, 0.25], [5, -0.2]]) {
    cell(ci, () => {
      g.rotate(sway * 0.4);
      g.strokeStyle = '#6d8557'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(sway * C * 0.3, -C * 0.5, sway * C * 0.5, -C * 0.92); g.stroke();
      for (let i = 0; i < 11; i++) {
        const t = i / 11;
        const x = sway * C * 0.5 * t * t;
        const y = -C * 0.9 * t;
        const L = C * 0.16 * (1 - t * 0.72);
        for (const s of [-1, 1]) {
          g.save(); g.translate(x, y); g.rotate(s * (1.25 - t * 0.3)); leaf(L, L * 0.3); g.restore();
        }
      }
    });
  }
  // 6: sprig — several small leaves off one short stem
  cell(6, () => {
    g.strokeStyle = '#6d8557'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -C * 0.55); g.stroke();
    const spots = [[0, -C * 0.5, 0, 0.55], [0, -C * 0.42, 0.9, 0.5], [0, -C * 0.42, -0.9, 0.5],
                   [0, -C * 0.26, 1.25, 0.45], [0, -C * 0.26, -1.25, 0.45], [0, -C * 0.12, 1.5, 0.4], [0, -C * 0.12, -1.5, 0.4]];
    for (const [x, y, r, s] of spots) {
      g.save(); g.translate(x, y); g.rotate(r); leaf(C * s * 0.6, C * s * 0.2); g.restore();
    }
  });
  // 7: grass clump — tapered strokes fanning up
  cell(7, () => {
    for (let i = 0; i < 9; i++) {
      const a = (i / 8 - 0.5) * 1.1;
      g.save(); g.rotate(a);
      g.fillStyle = grad(0, 0, 0, -C * 0.9, '#4a6039', '#88a468');
      g.beginPath();
      g.moveTo(-3, 0);
      g.quadraticCurveTo(-1, -C * 0.5, 0, -C * (0.6 + (i % 3) * 0.12));
      g.quadraticCurveTo(1, -C * 0.5, 3, 0);
      g.fill();
      g.restore();
    }
  });

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* which atlas cells each card kind may draw */
const CARD_CELLS = { leaf: [0, 1, 2, 3], fern: [4, 5], sprig: [6], grass: [7] };

/* two crossed quads, base at y=0, 1 unit tall — aH rides v so the bend/sway
 * weighting works identically to the built geometry */
function cardGeometry() {
  const pos = [], nrm = [], uv = [], hgt = [], idx = [];
  const quad = (nx, nz, sx, sz) => {
    const base = pos.length / 3;
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const w = (u - 0.5) * 0.72;
      pos.push(w * sx, v, w * sz);
      nrm.push(nx, 0, nz);
      uv.push(u, v);
      hgt.push(v);
    }
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  };
  quad(0, 1, 1, 0);
  quad(1, 0, 0, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aH', new THREE.Float32BufferAttribute(hgt, 1));
  g.setIndex(idx);
  return g;
}

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
attribute vec3 iBend;       // the interaction field's spring state, CPU-integrated
attribute float aH;         // height fraction up the plant
#ifdef USE_ATLAS
attribute vec2 iCell;       // which painted leaf this instance draws
varying vec2 vUvA;
#endif

uniform float uTime, uReveal, uWind, uFogK;
/* The cursor as a RAY through the scene rather than a point: the vegetation
 * occupies 40 units of depth, so a single interaction point would only ever
 * disturb one slice of it. A ray makes the cursor a rod pushed through the
 * growth, which is what "moving through underwater grass" actually is. */
uniform vec3 uCurO, uCurD;
uniform float uCurR, uCurOn, uFlow;

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

  /* ---- THE UNDERWATER CURRENT.
   *
   * Always on, and slow: this is a submerged forest, not a windy one. Two
   * octaves at very low frequency -- a broad drift the whole bed shares, plus a
   * smaller stir so neighbours are not in lockstep -- with an independent
   * vertical breath. Times are 0.05-0.09, roughly a quarter of the wind rates
   * this replaced, which is the difference between "suspended in water" and
   * "breezy".
   *
   * Depth-layered: the near beds move most, the far slope almost not at all, so
   * the environment has parallax in its MOTION and not only in its layout. */
  float depthAmp = 0.5 + 0.8 * smoothstep(-12.0, 30.0, iOffset.z);
  vec3 drift = vec3(
    cnoise(iOffset * 0.07 + uTime * 0.05),
    cnoise(iOffset * 0.06 + uTime * 0.035 + 31.0),
    cnoise(iOffset * 0.07 - uTime * 0.045 + 11.0));
  vec3 stir = vec3(
    cnoise(iOffset * 0.19 + uTime * 0.09 + 5.0),
    0.0,
    cnoise(iOffset * 0.17 - uTime * 0.08 + 17.0));
  vec3 flow = drift + stir * 0.45;
  /* a slow vertical breath, phase-offset per instance so the bed undulates
   * rather than pulsing as one body */
  flow.y += sin(uTime * 0.28 + iRand.x * 6.28) * 0.35;
  lp += flow * uWind * aH * aH * max(s, 0.001) * depthAmp;

  /* ---- THE INTERACTION FIELD.
   *
   * iBend is the plant's spring state -- integrated on the CPU against the
   * cursor's impulses and ripples, so the recovery is real second-order motion
   * (overshoot, settle) rather than a shader easing curve.
   *
   * It is applied as a BEND, not a translation: the weight rises as aH², so
   * the root is pinned and displacement accumulates up the stem. That is what
   * curves a blade instead of sliding it. */
  float bendW = aH * aH;
  lp += iBend * bendW * s;
  /* Arc-length compensation: a bent stem is no taller than a straight one, so
   * pull the tip down by roughly the sagitta. Without this, hard pushes visibly
   * STRETCH the plants. */
  lp.y -= dot(iBend, iBend) * bendW * 0.16 * s;

  vec3 world = iOffset + lp;

  /* Fine detail near the cursor: curl-ish noise flow, gated by distance to the
   * cursor ray so it exists only in the disturbed pocket. The CPU field carries
   * the mass motion; this carries the shimmer of individual leaves inside it. */
  if (uCurOn > 0.5) {
    vec3 toP = world - uCurO;
    float t = max(0.0, dot(toP, uCurD));
    float dRay = distance(world, uCurO + uCurD * t);
    float prox = 1.0 - smoothstep(0.0, uCurR, dRay);
    if (prox > 0.001) {
      float c1 = cnoise(world * 0.55 + uTime * 1.1);
      float c2 = cnoise(world * 0.48 - uTime * 0.9 + 23.0);
      /* the two reads are decorrelated and fed in perpendicular, which is what
       * gives the pocket a swirling flow rather than a shove */
      lp += vec3(c1, c2 * 0.5, -c1 * 0.8 + c2 * 0.4) * prox * prox * uFlow * bendW * s;
      world = iOffset + lp;
    }
  }
  vec4 mv = modelViewMatrix * vec4(world, 1.0);

  vN = normalize(qrot(iQuat, normal));
  vWorld = world;
  vH = aH;
  vEdge = iEdge;
  vR = iRand;
#ifdef USE_ATLAS
  vUvA = (uv + iCell) * vec2(0.25, 0.5);
#endif
  float len = max(1e-3, length(mv.xyz));
  vFog = 1.0 - exp(-uFogK * uFogK * len * len);

  gl_Position = projectionMatrix * mv;
}`;

const FLORA_FS = /* glsl */`
uniform vec3 uDeep, uMid, uTip, uFogColor, uLightDir, uLightCol, uRimCol;
uniform float uTime, uBright;
#ifdef USE_ATLAS
uniform sampler2D uAtlas;
varying vec2 vUvA;
#endif

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

#ifdef USE_ATLAS
  /* alpha-TESTED, never blended: cutout cards keep writing depth and occlude
   * like solid geometry. The painted texture carries silhouette and veins; the
   * ramp above stays the palette, so cards and built plants share one colour
   * world by construction. */
  vec4 tex = texture2D(uAtlas, vUvA);
  if (tex.a < 0.5) discard;
  base *= tex.rgb * 1.5;
#endif

  /* Key light + sky/ground ambient, with an OCCLUSION term. The ambient is
   * gated by height within the plant (vH): the deep interior of a clump gets
   * almost none and its crown gets the full sky. That is a cheap stand-in for
   * the ambient occlusion in the reference -- no AO pass, no extra buffer, but
   * the same read, because in real vegetation the thing that darkens a crevice
   * IS its lack of sky access. Without it every leaf sits at the same ambient
   * level and a mass flattens into one green silhouette. */
  float ndl = max(0.0, dot(n, normalize(uLightDir)));
  float sky = 0.5 + 0.5 * n.y;
  float ao = mix(0.18, 1.0, smoothstep(0.0, 0.8, vH));
  vec3 col = base * (0.13 + 0.34 * sky) * ao + base * uLightCol * ndl * 1.05 * ao;

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
  const clearing = opts.clearing ?? null;

  /* One prototype geometry per kind, built once and shared by every bed that
   * uses it — the instancing is what makes thousands of plants affordable.
   * Beds named 'card:<kind>' draw the leaf atlas on crossed quads instead of
   * built geometry; every card bed shares ONE quad geometry and one material,
   * so the whole card layer is a single draw whatever its count. */
  const isCard = k => k.startsWith('card');
  let cardGeo = null;
  const geos = {};
  const need = new Set(beds.map(b => b.proto));
  for (const k of need) {
    geos[k] = isCard(k) ? (cardGeo = cardGeo || cardGeometry()) : toGeometry(PROTOS[k]());
  }

  /* Group instances by prototype so each kind is ONE draw call. Cards all
   * group under 'card' regardless of kind — the kind only picks atlas cells. */
  const byProto = {};
  for (const k of need) {
    const key = isCard(k) ? 'card' : k;
    byProto[key] = byProto[key] || { off: [], quat: [], scl: [], rnd: [], edge: [], cell: [] };
  }

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
    const bedIsCard = isCard(bed.proto);
    const B = byProto[bedIsCard ? 'card' : bed.proto];
    const cells = bedIsCard ? (CARD_CELLS[bed.proto.split(':')[1]] ?? CARD_CELLS.leaf) : null;
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
      const ang0 = Math.atan2(v, u);
      const lobe = 0.78 + 0.22 * Math.sin(ang0 * 3 + (bed.seed ?? 0)) + 0.12 * Math.sin(ang0 * 7 + 1.7);
      const edge = Math.min(1, r / lobe);
      /* accumulates every density modifier applied below */
      let scaleMul = 1;

      pos.copy(bed.at ? _p.fromArray(bed.at) : _p.set(0, 0, 0));
      pos.addScaledVector(tanA, u * R * squash).addScaledVector(tanB, v * R);
      /* Thickness along the normal, not surface relief. A bank scattered on a
       * PLANE is a wall with a findable edge; the same plants spread several
       * units through the normal become a volume you are looking into, and the
       * "where does the foliage start" question stops having an answer. */
      pos.addScaledVector(nrm, (Math.random() - 0.5) * (bed.relief ?? 0.6));

      /* ---- THE CLEARING.
       *
       * A noise-warped opening around the artifact. Rejection is PROGRESSIVE --
       * the odds of a plant surviving fall as it approaches the centre, and the
       * survivors shrink -- so the density ramps down over several units
       * instead of stopping at a boundary. Depth is de-weighted (0.32) so the
       * clearing is a rough tube along the sight line rather than a bubble,
       * which is what keeps the space open BEHIND the coin as well as beside
       * it. The lobed radius makes the opening irregular; a clean circle would
       * read as a vignette cut into the forest. */
      if (clearing) {
        const cdx = pos.x - clearing.at[0];
        const cdy = pos.y - clearing.at[1];
        const cdz = (pos.z - clearing.at[2]) * 0.32;
        const cd = Math.hypot(cdx, cdy, cdz);
        const ang = Math.atan2(cdy, cdx);
        const lobed = clearing.radius *
          (1 + 0.30 * Math.sin(ang * 2.3 + 1.1) + 0.16 * Math.sin(ang * 5.1 - 0.6));
        if (cd < lobed) {
          const tt = cd / lobed;
          if (Math.random() > tt * tt) continue;      // thins toward the centre
          scaleMul *= 0.3 + 0.7 * tt;                 // and survivors shrink
        }
      }

      /* UP is the surface normal, then a random spin about it, then a tilt.
       * This is the whole reason grass points up and moss hugs: orientation is
       * derived from the surface, not randomised. */
      q.setFromUnitVectors(UP, nrm);
      qy.setFromAxisAngle(nrm, Math.random() * Math.PI * 2);
      q.multiply(qy);
      const tilt = bed.tilt ?? 0.18;
      qt.setFromEuler(new THREE.Euler(rnd(-tilt, tilt), 0, rnd(-tilt, tilt)));
      q.multiply(qt);

      const scale = rnd(s0, s1) * (1 - edge * 0.35) * scaleMul;
      B.off.push(pos.x, pos.y, pos.z);
      B.quat.push(q.x, q.y, q.z, q.w);
      B.scl.push(scale);
      B.rnd.push(Math.random(), Math.random(), Math.random(), Math.random());
      B.edge.push(edge);
      if (cells) {
        const ci = cells[(Math.random() * cells.length) | 0];
        B.cell.push(ci % 4, Math.floor(ci / 4));
      }
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
    /* the cursor rod, in flora-local space */
    uCurO: { value: new THREE.Vector3() },
    uCurD: { value: new THREE.Vector3(0, 0, -1) },
    uCurR: { value: opts.cursorRadius ?? 4.5 },
    uCurOn: { value: 0 },
    uFlow: { value: opts.flow ?? 0.55 },
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

  /* The card material: same shaders, same uniform INSTANCES (the spread copies
   * references, so every drive updates both materials at once), plus the atlas
   * behind a define. Built lazily — no card beds, no atlas. */
  let cardMat = null;
  if (byProto.card) {
    cardMat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uAtlas: { value: makeLeafAtlas() } },
      defines: { USE_ATLAS: 1 },
      vertexShader: FLORA_VS,
      fragmentShader: FLORA_FS,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
    });
  }

  const meshes = [];
  /* Per-prototype simulation state for the interaction field. Kept as flat
   * typed arrays alongside the GPU attribute they feed, so the physics step is
   * a straight loop with no allocation. */
  const sim = [];
  for (const k of Object.keys(byProto)) {
    const B = byProto[k];
    const n = B.scl.length;
    if (!n) continue;
    const src = k === 'card' ? cardGeo : geos[k];
    const off = new Float32Array(B.off);
    const bend = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    const bendAttr = new THREE.InstancedBufferAttribute(bend, 3);
    bendAttr.setUsage(THREE.DynamicDrawUsage);

    const ig = new THREE.InstancedBufferGeometry();
    ig.index = src.index;
    ig.setAttribute('position', src.attributes.position);
    ig.setAttribute('normal', src.attributes.normal);
    ig.setAttribute('aH', src.attributes.aH);
    ig.instanceCount = n;
    ig.setAttribute('iOffset', new THREE.InstancedBufferAttribute(off, 3));
    ig.setAttribute('iQuat', new THREE.InstancedBufferAttribute(new Float32Array(B.quat), 4));
    ig.setAttribute('iScale', new THREE.InstancedBufferAttribute(new Float32Array(B.scl), 1));
    ig.setAttribute('iRand', new THREE.InstancedBufferAttribute(new Float32Array(B.rnd), 4));
    ig.setAttribute('iEdge', new THREE.InstancedBufferAttribute(new Float32Array(B.edge), 1));
    ig.setAttribute('iBend', bendAttr);
    if (k === 'card') {
      ig.setAttribute('uv', src.attributes.uv);
      ig.setAttribute('iCell', new THREE.InstancedBufferAttribute(new Float32Array(B.cell), 2));
    }
    const m = new THREE.Mesh(ig, k === 'card' ? cardMat : mat);
    m.frustumCulled = false;
    group.add(m);
    meshes.push({ proto: k, instances: n, tris: (src.index.count / 3) * n });
    sim.push({ n, off, bend, vel, attr: bendAttr, scl: new Float32Array(B.scl) });
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

  /* ------------------------------------------------------------------ *
   *  THE INTERACTION FIELD
   *
   *  cursor -> interaction field -> displacement -> ripple propagation ->
   *  spring/damping recovery.
   *
   *  Integrated on the CPU, one state per PLANT (not per vertex): 2,840 springs
   *  is nothing, and it buys real second-order motion -- a plant pushed aside
   *  overshoots coming back and settles, which no shader easing curve gives
   *  you. The GPU then spends that state as a bend up each stem.
   *
   *  Two force sources, and they do different jobs:
   *
   *    THE ROD    the cursor as a ray through the scene. Plants near the ray
   *               are pushed radially away from it, scaled by cursor SPEED --
   *               a stationary cursor parts the growth barely at all, a fast
   *               one shoves it aside. This is the "strongest at the cursor"
   *               term.
   *    RIPPLES    impulses dropped along the cursor's path, each expanding as
   *               a travelling gaussian ring. A plant only feels one when the
   *               ring ARRIVES, so disturbance propagates outward through the
   *               bed instead of appearing everywhere at once, and the wake
   *               keeps flowing after the cursor has gone.
   * ------------------------------------------------------------------ */
  const RIPPLES = 14;
  /* The wake: a short history of where the cursor has been and which way it was
   * travelling. Each sample is a SOFT BLOB that widens and fades with age -- not
   * a ring. A ring has a visible edge, and the brief rules out visible circles;
   * a widening blob delivers the same "disturbance spreading outward" without
   * ever drawing a circle in the vegetation. */
  const ripple = Array.from({ length: RIPPLES }, () => ({
    x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0, age: 1e9, str: 0,
  }));
  let rNext = 0;
  const prevCur = new THREE.Vector3();
  let hasPrev = false, sinceDrop = 0;

  /* Live-tunable, and deliberately so: the feel of an interaction field is not
   * a thing screenshots can judge, and the dev pane's throttled rAF advances
   * the sim at a fraction of real speed, so numbers that measure right there
   * can still feel wrong at 60fps. Exposed on the handle as `.cfg` for tuning
   * from the console without a reload. */
  const cfg = {
    /* OVERDAMPED, on purpose. C > 2*sqrt(K) means a disturbed plant slides back
     * to rest without crossing it -- soft, heavy, fluid. The underdamped spring
     * this replaced snapped back through rest and read as elastic, which is
     * exactly the rubber-band feel water does not have. */
    stiffness: opts.stiffness ?? 7,
    damping: opts.damping ?? 7.5,
    radius: opts.cursorRadius ?? 7.5,     // the disturbed pocket, world units
    depth: opts.cursorDepth ?? 18,        // how far along the ray the pocket reaches
    push: opts.push ?? 3.4,               // force scale -- small; the spec asks for 5-15%
    idle: opts.idlePush ?? 0.12,          // a parked cursor still stirs the water faintly
    maxBend: opts.maxBend ?? 0.22,        // tip excursion in the plant's own units
    /* how the disturbance direction is composed. NO RADIAL TERM EXISTS: the
     * cursor says WHERE, never which way. */
    flowMix: opts.flowMix ?? 0.72,        // share taken by the swirling flow field
    dragMix: opts.dragMix ?? 0.55,        // share taken by the cursor's travel direction
    liftMix: opts.liftMix ?? 0.18,        // the small vertical component
    spread: opts.wakeSpread ?? 5.5,       // how fast a wake blob widens, units/second
    rippleLife: opts.rippleLife ?? 2.2,
    dropEvery: opts.rippleSpacing ?? 1.0, // wake spacing along the cursor path
  };
  /* how far along the ray the cursor's interaction point sits */
  const curProbeT = (o, d, p) =>
    (p.x - o.x) * d.x + (p.y - o.y) * d.y + (p.z - o.z) * d.z;

  /* THE FLOW FIELD — a slow swirling current, sampled at a plant's own
   * position. Built from a stream-function-style combination of sines so it
   * circulates rather than radiating: there is no source and no sink anywhere
   * in it, which is precisely the property a radial force lacks and why this
   * cannot produce a vortex centred on the pointer. Neighbouring plants sample
   * nearly the same value, so a patch leans TOGETHER. */
  const _f = { x: 0, y: 0, z: 0 };
  function flowAt(x, y, z, t) {
    const a = Math.sin(x * 0.21 + t * 0.13) * Math.cos(z * 0.18 - t * 0.11);
    const b = Math.sin(z * 0.23 - t * 0.09) * Math.cos(y * 0.17 + t * 0.07);
    const c = Math.sin(y * 0.15 + t * 0.05) * Math.cos(x * 0.19 + t * 0.08);
    _f.x = Math.cos(z * 0.19 + t * 0.10) * 0.8 - a;
    _f.y = (b - c) * 0.5;
    _f.z = Math.sin(x * 0.22 - t * 0.12) * 0.8 + b;
    const l = Math.hypot(_f.x, _f.y, _f.z) || 1;
    _f.x /= l; _f.y /= l; _f.z /= l;
    return _f;
  }
  let now = 0;

  const cp = new THREE.Vector3(), rad = new THREE.Vector3();

  return {
    group, dust, uniforms, dustUniforms, cfg,
    stats: { plants: total, dust: dustPos.length / 3, draws: meshes.length + 1, meshes },
    setReveal(p) {
      const k = Math.min(1, Math.max(0, p));
      uniforms.uReveal.value = k;
      dustUniforms.uReveal.value = k;
    },

    /**
     * @param dt      seconds
     * @param origin  cursor ray origin, FLORA-LOCAL
     * @param dir     cursor ray direction, normalised
     * @param probe   the ray's world point at the vegetation's depth, local —
     *                where ripples are dropped
     * @param active  false when the pointer is not over the section: the field
     *                relaxes rather than freezing mid-push
     */
    interact(dt, origin, dir, probe, active) {
      const step = Math.min(dt, 1 / 30);         // a tab-switch stall must not explode the springs
      now += step;

      uniforms.uCurO.value.copy(origin);
      uniforms.uCurD.value.copy(dir);
      uniforms.uCurOn.value = active ? 1 : 0;

      /* Cursor speed drives everything: this is the velocity-based deformation.
       * Measured on the probe point, so it is a world-space speed rather than a
       * pixel one and behaves the same at every depth. */
      let speed = 0;
      if (active && hasPrev) speed = prevCur.distanceTo(probe) / Math.max(step, 1e-4);
      const dirX = active && hasPrev ? (probe.x - prevCur.x) : 0;
      const dirY = active && hasPrev ? (probe.y - prevCur.y) : 0;
      const dirZ = active && hasPrev ? (probe.z - prevCur.z) : 0;
      const dl = Math.hypot(dirX, dirY, dirZ) || 1;

      /* Drop a ripple when the cursor has travelled far enough. Distance-gated,
       * not time-gated, so a slow drag leaves an evenly spaced wake and a flick
       * leaves a sparse one -- both read as a trail rather than a strobe. */
      sinceDrop += speed * step;
      if (active && hasPrev && speed > 1.5 && sinceDrop > cfg.dropEvery) {
        sinceDrop = 0;
        const r = ripple[rNext];
        rNext = (rNext + 1) % RIPPLES;
        r.x = probe.x; r.y = probe.y; r.z = probe.z;
        r.dx = dirX / dl; r.dy = dirY / dl; r.dz = dirZ / dl;
        r.age = 0;
        r.str = Math.min(1, speed / 22);
      }
      for (const r of ripple) r.age += step;
      if (active) { prevCur.copy(probe); hasPrev = true; } else hasPrev = false;

      /* The rod's strength is VELOCITY-LED. The static term is deliberately tiny
       * (0.05): a parked cursor holding a permanent trench open through the
       * vegetation is the tell of a mouse-follow effect, and the brief rules it
       * out. A still cursor barely parts the growth; a moving one shoves it. */
      const rodAmp = active ? (cfg.idle + Math.min(1, speed / 16)) * cfg.push : 0;
      /* Where along the rod the cursor "is". Without this the influence is an
       * INFINITE tube: every plant within 4.5 units of the line responds, at
       * any depth, and 40 units of vegetation all move at once. The window
       * makes it a finger dipped in at the cursor's depth. */
      const tProbe = curProbeT(origin, dir, probe);

      for (const S of sim) {
        const { n, off, bend, vel } = S;
        for (let i = 0; i < n; i++) {
          const i3 = i * 3;
          const px = off[i3], py = off[i3 + 1], pz = off[i3 + 2];
          let fx = 0, fy = 0, fz = 0;
          /* Depth layering: the burst eye sits near z 38 looking down -z, so a
           * larger z is nearer the camera. Foreground responds most, background
           * barely -- without this the whole forest moves as one flat sheet. */
          const depthAmp = 0.45 + 0.85 * Math.min(1, Math.max(0, (pz + 12) / 42));

          /* THE FLOW FIELD.
           *
           * This is the whole correction. The direction a plant moves is read
           * from a smooth swirling field sampled at the PLANT's own position,
           * blended with the direction the cursor is travelling. Neighbours
           * therefore lean the same way -- a current passing through -- instead
           * of each leaning along its own radius from the pointer, which is
           * what built the starburst.
           *
           * The cursor contributes a MASK, never a direction. Nothing in this
           * function computes normalize(plant - cursor). */
          const ft = flowAt(px, py, pz, now);

          if (rodAmp > 0) {
            const tx = px - origin.x, ty = py - origin.y, tz = pz - origin.z;
            const t = Math.max(0, tx * dir.x + ty * dir.y + tz * dir.z);
            cp.set(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
            const d = Math.hypot(px - cp.x, py - cp.y, pz - cp.z);
            const dz = Math.abs(t - tProbe) / cfg.depth;
            if (d < cfg.radius && dz < 1) {
              /* influence mask only: cos² in radius, cos in depth, so the
               * pocket has no edge anywhere */
              const f = Math.cos((d / cfg.radius) * Math.PI * 0.5);
              const amp = rodAmp * f * f * Math.cos(dz * Math.PI * 0.5) * depthAmp;
              fx += (ft.x * cfg.flowMix + (dirX / dl) * cfg.dragMix) * amp;
              fy += (ft.y * cfg.flowMix) * amp * cfg.liftMix;
              fz += (ft.z * cfg.flowMix + (dirZ / dl) * cfg.dragMix) * amp;
            }
          }

          /* THE WAKE. Each past cursor sample is a soft blob that WIDENS as it
           * ages while fading -- the disturbance spreads outward and keeps the
           * vegetation flowing after the cursor has gone, with no ring and no
           * radial component. Direction is the cursor's heading at that moment,
           * blended with the same flow field. */
          for (const r of ripple) {
            if (r.age > cfg.rippleLife) continue;
            const d = Math.hypot(px - r.x, py - r.y, pz - r.z);
            const reach = cfg.radius + r.age * cfg.spread;
            if (d > reach) continue;
            const f = Math.cos((d / reach) * Math.PI * 0.5);
            const fade = 1 - r.age / cfg.rippleLife;
            const amp = r.str * f * f * fade * fade * cfg.push * depthAmp * 0.8;
            fx += (ft.x * cfg.flowMix + r.dx * cfg.dragMix) * amp;
            fy += (ft.y * cfg.flowMix) * amp * cfg.liftMix;
            fz += (ft.z * cfg.flowMix + r.dz * cfg.dragMix) * amp;
          }

          /* spring + damping toward rest. Underdamped on purpose: C is below
           * the critical 2*sqrt(K), so a released plant swings back through
           * rest once and settles -- vegetation, not a slider. */
          const K = cfg.stiffness, C = cfg.damping;
          const bx = bend[i3], by = bend[i3 + 1], bz = bend[i3 + 2];
          let vx = vel[i3] + (fx - K * bx - C * vel[i3]) * step;
          let vy = vel[i3 + 1] + (fy - K * by - C * vel[i3 + 1]) * step;
          let vz = vel[i3 + 2] + (fz - K * bz - C * vel[i3 + 2]) * step;
          let nx = bx + vx * step, ny = by + vy * step, nz = bz + vz * step;

          /* Hard ceiling on the excursion. Without it a fast flick can drive
           * the integrator past the point where the arc-length term in the
           * shader makes sense and plants visibly tear. */
          const mag = Math.hypot(nx, ny, nz);
          const MAXB = cfg.maxBend;
          if (mag > MAXB) {
            const k = MAXB / mag;
            nx *= k; ny *= k; nz *= k;
            vx *= k; vy *= k; vz *= k;
          }
          vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
          bend[i3] = nx; bend[i3 + 1] = ny; bend[i3 + 2] = nz;
        }
        S.attr.needsUpdate = true;
      }
    },
  };
}
