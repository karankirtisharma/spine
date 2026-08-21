import * as THREE from 'three';
import { NOISE, COLOR_UTILS } from './shaders.js';
import { rand } from './rng.js';

/* THE COMET (reference frames 2 and 3, upper-right of frame)
 *
 * A bright warm white-gold head trailing dozens of fine parallel filaments that
 * converge toward it, fading out along their length. It is the single warmest
 * element in an otherwise green frame, and it stays warm here on purpose:
 * white core, gold falloff, no green anywhere in its palette.
 *
 * WHAT IS THEIRS AND WHAT IS NOT
 *
 * On activetheory.net the streak is drawn by their Proton spline stack:
 * SplineParticleLife.fs / splineparticles.fs advance spline heads inside an
 * Antimatter FBO simulation, and ProtonTube.glsl extrudes each spline into a
 * tapered tube by reading tPos/tLife back out of that simulation. Transcribing
 * it needs the whole Proton uniform block, the spline lookup textures and two
 * ping-pong sims -- the same reason home.js skipped the jellyfish's fbr stack.
 * So the GEOMETRY here is an interpretation: statically baked filaments whose
 * motion lives entirely in the vertex shader. Three fragments of their shader
 * code survive into it, each marked at the point of use:
 *
 *   1. ProtonTube.glsl's taper envelope -- their tubes fade in and out along
 *      vLength with a double crange(). Ours keeps the crange() ramp at the head
 *      and replaces the symmetric tail ramp with a pow falloff, because a comet
 *      tail dies gradually, not at a fixed cut. Adapted, not verbatim.
 *   2. TubeShader.glsl's along-length darkening, verbatim in shape:
 *      pow(color, vec3(mix(1.0, 2.0, vLength))). It is what makes the tail
 *      end die into the background instead of clipping to zero.
 *   3. ParticleTestShader.glsl's sparkle term 0.4 + sin(time * 3.0 + rand * 20.0)
 *      for the head sparks -- CLAMPED before the pow, see the NaN note below.
 *
 * WHY LineSegments AND NOT STRETCHED POINTS
 *
 * The reference filaments are hairlines: device-space ~1px strokes whose width
 * does not change along their length or with distance. That is exactly what a
 * native GL line primitive gives for free (linewidth above 1 is unsupported
 * almost everywhere, and 1 is the look). Stretched points would need
 * per-segment orientation math in the shader, and at any point size above 1px
 * they read as beads along the strand -- the moire of overlapping sprites is
 * visible precisely because the strands run parallel. LineSegments also
 * interpolate the per-vertex along-strand coordinate linearly between samples,
 * which is the whole alpha fade for free. The cost -- duplicated interior
 * vertices instead of an index buffer -- is ~3k vertices, not worth indexing.
 *
 * NaN DISCIPLINE (three prior incidents in this project, see home.js)
 *   - every pow() base that touches sin/cos or noise is clamped first; driver
 *     range reduction lets sin() stray outside [-1,1] at large arguments and
 *     pow() of a negative base is undefined GLSL.
 *   - no smoothstep with runtime-equal edges anywhere in this file; every
 *     smoothstep here has two distinct constants.
 *   - no normalize() in the shaders at all: the lateral directions are baked
 *     unit vectors, and the point-size divisor is max()-floored.
 *   - final gl_FragColor.rgb is min()-capped at 1.5 in both fragment shaders.
 *     The composer runs HalfFloat targets with additive blending under
 *     UnrealBloom; one Inf pixel blacks the whole frame once the separable
 *     blur smears it.
 */

const STRANDS = 52;         // brief asks for 40-60; 52 reads as fibres, not a fan
const SEGS = 28;            // samples per strand; the bow needs the curvature
const SPARKS = 36;          // head cluster, one guaranteed big winner at index 0
const BASE_LEN = 8;         // world units; camera sits 30-45 out in this scale

/* Bake the filament bundle in a local frame: head at the origin, tail running
 * up +Y. The group's default rotation then tips +Y toward +X so the tail runs
 * up-right at 60 degrees from horizontal with the head at lower-left -- the
 * frame-2 pose -- and the caller can re-position/re-angle the group freely.
 *
 * Convergence is the taper: each strand's lateral radius grows from ~0.05 at
 * the head to its own rEnd (up to ~0.9) along pow(t, 0.75), so the bundle
 * pinches at the head and loosens toward the tail. Per-strand length, a gentle
 * shared bow toward -X (the reference tail curls slightly), and a baked sine
 * wiggle keep it from reading as a cylinder. All of this is ours -- their
 * spline sim produces the equivalent variation dynamically.
 */
function seedFilaments() {
  const verts = STRANDS * SEGS * 2;
  const position = new Float32Array(verts * 3);
  const aData = new Float32Array(verts * 4);
  const aLateral = new Float32Array(verts * 3);
  let v = 0;

  for (let s = 0; s < STRANDS; s++) {
    const L = BASE_LEN * (0.5 + 0.5 * rand());
    const ang = rand() * Math.PI * 2;
    const dirX = Math.cos(ang), dirZ = Math.sin(ang);
    const rEnd = 0.9 * (0.25 + 0.75 * rand());
    const bow = -(0.25 + 0.5 * rand()) * 0.10 * L;
    const wf = (2 + rand() * 3) * Math.PI;
    const wp = rand() * Math.PI * 2;
    const phase = rand();
    /* Brightness lottery, same shape as the plume's: most strands sit low and
     * a pow() tail supplies the hot minority. Uniform brightness is what makes
     * a bundle read as a solid cylinder however good the geometry is. */
    const bright = 0.35 + 0.65 * Math.pow(rand(), 2.0);
    const sway = 0.5 + rand();

    const point = (t) => {
      const r = 0.05 + (rEnd - 0.05) * Math.pow(t, 0.75);
      const wig = Math.sin(t * wf + wp) * 0.06 * t;
      return [
        dirX * r - dirZ * wig + bow * t * t,
        t * L,
        dirZ * r + dirX * wig,
      ];
    };

    for (let i = 0; i < SEGS; i++) {
      for (const t of [i / SEGS, (i + 1) / SEGS]) {
        const p = point(t);
        position[v * 3] = p[0];
        position[v * 3 + 1] = p[1];
        position[v * 3 + 2] = p[2];
        aData[v * 4] = t;
        aData[v * 4 + 1] = phase;
        aData[v * 4 + 2] = bright;
        aData[v * 4 + 3] = sway;
        aLateral[v * 3] = dirX;
        aLateral[v * 3 + 1] = 0;
        aLateral[v * 3 + 2] = dirZ;
        v++;
      }
    }
  }
  return { position, aData, aLateral, verts };
}

/* The head sparks. pow(u, 2.2) on the along-axis coordinate piles them onto
 * the first ~15% of the streak with stragglers up to 40%, matching the frames:
 * the warm glints run along the lower reach of the streak, not just at its tip.
 * sqrt on the radial draw is the usual polar-sampling fix (see seedPlume).
 * aRnd = (flicker seed, size px, brightness, unused). */
function seedSparks() {
  const position = new Float32Array(SPARKS * 3);
  const aRnd = new Float32Array(SPARKS * 4);

  for (let i = 0; i < SPARKS; i++) {
    let x, y, z, size, bright;
    if (i === 0) {
      // the guaranteed winner: the head core itself, one big soft disc
      x = 0; y = 0.2; z = 0; size = 15; bright = 1.0;
    } else {
      const t = Math.pow(rand(), 2.2) * 0.4;
      const r = (0.05 + t) * 0.8 * Math.sqrt(rand());
      const a = rand() * Math.PI * 2;
      x = Math.cos(a) * r;
      y = t * BASE_LEN;
      z = Math.sin(a) * r;
      size = 2.5 + 9 * Math.pow(rand(), 3.0);
      bright = 0.5 + 0.5 * rand();
    }
    position[i * 3] = x; position[i * 3 + 1] = y; position[i * 3 + 2] = z;
    aRnd[i * 4] = rand();
    aRnd[i * 4 + 1] = size;
    aRnd[i * 4 + 2] = bright;
    aRnd[i * 4 + 3] = rand();
  }
  return { position, aRnd };
}

const FILAMENT_VS = /* glsl */`
  attribute vec4 aData;     // x: t along strand, y: phase, z: bright, w: sway
  attribute vec3 aLateral;  // baked UNIT lateral direction -- no normalize() here

  uniform float time;

  varying float vT;
  varying float vBright;
  varying float vShimmer;

  ${NOISE}

  void main() {
    vT = aData.x;
    vBright = aData.z;

    vec3 pos = position;

    /* The shimmer, GPU-side so update() never writes vertices. A slow lateral
     * sway scaled by t -- the head end is pinned, the tail waves -- plus a
     * noise-driven brightness ripple travelling along the strand. sin here
     * feeds a displacement, never a pow, so it needs no clamp. */
    float sway = sin(time * 0.8 + aData.y * 6.2831853 + aData.x * 9.0);
    pos += aLateral * sway * 0.045 * aData.w * aData.x;

    /* cnoise is nominally [-1,1]; the clamp is a guard against the same driver
     * slop that bit sin() three times in this codebase. vShimmer lands in
     * [0.56, 1.0] and is used multiplicatively only -- never through pow. */
    float n = clamp(cnoise(vec3(aData.x * 5.0, aData.y * 10.0, time * 0.3)), -1.0, 1.0);
    vShimmer = 0.78 + 0.22 * n;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const FILAMENT_FS = /* glsl */`
  uniform float uAlpha;

  varying float vT;
  varying float vBright;
  varying float vShimmer;

  ${COLOR_UTILS}

  void main() {
    /* Along-strand envelope. The head ramp is ProtonTube.glsl's taper idiom --
     * theirs is crange(vLength, 0.0, taper, 0.0, 1.0) against a symmetric
     * crange at the far end; the far end here is a pow falloff instead because
     * the tail should die gradually, not at a fixed cut (adapted, credited in
     * the header). pow base is clamped: vT interpolates within [0,1] but the
     * clamp costs nothing and this project has paid for optimism before. */
    float fadeIn = crange(vT, 0.0, 0.03, 0.0, 1.0);
    float fall = pow(clamp(1.0 - vT, 0.0, 1.0), 1.7);
    float env = fadeIn * fall;

    /* Warm only. White core within the first third, gold beyond it, and the
     * blue channel low enough that additive stacking over the green field
     * cannot drift it cold. clamp before pow, as everywhere. */
    float head = pow(clamp(1.0 - vT * 3.0, 0.0, 1.0), 2.0);
    vec3 col = mix(vec3(1.0, 0.76, 0.42), vec3(1.0, 0.97, 0.92), head);
    col *= (0.25 + 0.75 * env) * vBright * vShimmer;

    /* TubeShader.glsl, verbatim shape: pow(color, vec3(mix(1.0, 2.0, vLength))).
     * Darkens the tail end nonlinearly so the last visible stretch of each
     * fibre dissolves instead of stopping. max() guards the base -- col is
     * non-negative by construction today, but pow() must never be trusted
     * with a base that is merely "should be" positive. */
    col = pow(max(col, vec3(0.0)), vec3(mix(1.0, 2.0, vT)));

    /* Additive under UnrealBloom: the per-fragment ceiling is the Inf firewall.
     * ~50 strands can still stack far above 1.5 in the HalfFloat target, which
     * is the intended hot head -- the cap only stops a single fragment spiking. */
    gl_FragColor = vec4(min(col, vec3(1.5)), env * uAlpha);
  }
`;

const SPARK_VS = /* glsl */`
  attribute vec4 aRnd;   // x: flicker seed, y: size px, z: brightness

  uniform float time;
  uniform float DPR;
  uniform float uMaxSize;

  varying vec4 vRnd;

  void main() {
    vRnd = aRnd;

    vec3 pos = position;
    // tiny orbital jitter so the head shivers rather than sitting frozen
    pos.x += sin(time * 1.7 + aRnd.x * 40.0) * 0.02;
    pos.y += cos(time * 1.3 + aRnd.x * 31.0) * 0.02;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    /* Same distance-attenuated sizing as the plume, floored so the divisor can
     * never blow up if the camera lands on the head, and hard-capped: a spark
     * that outgrows uMaxSize px is a bloom flare waiting to happen. */
    gl_PointSize = min(uMaxSize * DPR, aRnd.y * DPR * (30.0 / max(1.0, length(mvPosition.xyz))));
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const SPARK_FS = /* glsl */`
  uniform float time;
  uniform float uAlpha;

  varying vec4 vRnd;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;

    /* ParticleTestShader.glsl's sparkle term, their constants: 0.4 + sin(time
     * * 3.0 + rand * 20.0). CLAMPED before the pow -- their raw expression
     * reaches -0.6, and pow of a negative base is the purple-fleck/black-frame
     * bug this project has hit three times (see home.js for the autopsy). */
    float tw = clamp(0.4 + sin(time * 3.0 + vRnd.x * 20.0), 0.0, 1.0);

    float core = smoothstep(0.5, 0.08, d);
    vec3 col = mix(vec3(1.0, 0.72, 0.38), vec3(1.0, 0.97, 0.9), core);
    col *= vRnd.z * (0.45 + 0.55 * pow(tw, 2.0)) * 1.4;

    // per-fragment Inf firewall, same as the filaments
    gl_FragColor = vec4(min(col, vec3(1.5)), core * uAlpha);
  }
`;

/**
 * The comet streak from reference frames 2 and 3.
 *
 * @param shared      the shared uniform bag from main.js
 *                    { uTime, uDPR, uScrollDelta, uResolution, uMouse }
 * @param opts.position  THREE.Vector3, initial group position
 * @param opts.scale     uniform scale, default 1
 * @param opts.drift     head descent speed in units/sec, default 0.04
 * @returns { group, update(dt), uniforms, stats }
 */
export function buildComet(shared, opts = {}) {
  const group = new THREE.Group();
  if (opts.position) group.position.copy(opts.position);
  group.scale.setScalar(opts.scale ?? 1);
  /* Default pose: the bundle is baked head-at-origin, tail up +Y. Tipping +Y
   * thirty degrees toward +X puts the tail up-right at 60 degrees from
   * horizontal with the head at lower-left -- the frame-2 pose. The caller
   * owns the group and can re-angle it. */
  group.rotation.z = -Math.PI / 6;

  const drift = opts.drift ?? 0.04;

  /* ---- the filaments ---------------------------------------------------- */
  const fil = seedFilaments();
  const filGeo = new THREE.BufferGeometry();
  filGeo.setAttribute('position', new THREE.BufferAttribute(fil.position, 3));
  filGeo.setAttribute('aData', new THREE.BufferAttribute(fil.aData, 4));
  filGeo.setAttribute('aLateral', new THREE.BufferAttribute(fil.aLateral, 3));

  const filMat = new THREE.ShaderMaterial({
    vertexShader: FILAMENT_VS,
    fragmentShader: FILAMENT_FS,
    uniforms: {
      time: shared.uTime,
        uAlpha: { value: 0.85 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const filaments = new THREE.LineSegments(filGeo, filMat);
  filaments.frustumCulled = false;   // the shader sways vertices; do not trust the baked bounds
  group.add(filaments);

  /* ---- the head sparks --------------------------------------------------- */
  const spk = seedSparks();
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(spk.position, 3));
  sparkGeo.setAttribute('aRnd', new THREE.BufferAttribute(spk.aRnd, 4));

  const sparkMat = new THREE.ShaderMaterial({
    vertexShader: SPARK_VS,
    fragmentShader: SPARK_FS,
    uniforms: {
      time: shared.uTime,
        DPR: shared.uDPR,
      uMaxSize: { value: 16 },
      uAlpha: { value: 0.9 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  group.add(sparks);

  /* Head-first descent: local -Y is where the head points (head at origin,
   * tail up +Y), so transforming -Y by the group's CURRENT quaternion each
   * frame means the comet always travels head-first, and re-angling the group
   * re-aims the drift with it. At the default pose that is (-0.5, -0.866, 0):
   * very slowly toward lower-left, per the frames. One scratch vector,
   * allocated once -- update runs every frame. */
  const dir = new THREE.Vector3();

  return {
    group,

    update(dt) {
      dir.set(0, -1, 0).applyQuaternion(group.quaternion);
      group.position.addScaledVector(dir, drift * dt);
      /* The shimmer needs nothing here: both shaders read shared.uTime, which
       * main.js advances. No CPU vertex writes, ever. */
    },

    uniforms: {
      filaments: filMat.uniforms,
      sparks: sparkMat.uniforms,
    },

    stats: {
      strands: STRANDS,
      segmentsPerStrand: SEGS,
      filamentVerts: fil.verts,
      sparks: SPARKS,
    },
  };
}
