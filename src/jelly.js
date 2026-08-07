import * as THREE from 'three';
import { NOISE, COLOR_UTILS } from './shaders.js';
import { FRESNEL } from './glsl-chunks.js';

/* THE JELLYFISH — JellyShader.glsl, transcribed where it ports
 *
 * The mushroom-cap drifter at frame left in reference frames 1 and 2: a dark
 * desaturated sage cap about 1.2 units across, a faint lit rim on the cap
 * edge, and five filament tentacles hanging 4-6 units below it, each swaying
 * on its own phase. It is scenery, not a hero object. In both reference
 * frames it sits barely above the background value and reads mostly as a
 * silhouette against the particle field -- everything in the fragment shader
 * is tuned to keep it that way, and the output is clamped besides, because
 * this scene composites through HalfFloat targets with additive blending and
 * UnrealBloom, where one hot pixel becomes Inf and one Inf pixel becomes a
 * black frame once the separable blur touches it.
 *
 * WHAT IS THEIRS AND WHAT IS NOT
 *
 * Active Theory's JellyShader.glsl (compiled.vs) supplies the VERTEX
 * displacement, ported verbatim -- all three terms, every constant theirs:
 *
 *   1. cap wobble    pos.y += cnoise(pos * vec3(0.1, 0.5, 0.1) * 0.8
 *                                    + time * 0.5 * 0.35) * 0.6
 *   2. fine ripple   pos.x/z += sin/cos(pos.y + time * 0.1 + uScroll) * 0.1
 *   3. broad sway    pos.x/z += sin/cos(pos.y * 0.04 + time * 0.2) * 1.0
 *
 * At term 1's noise frequency the whole cap spans about a twentieth of a
 * noise cell, so it does not ripple the surface -- it bobs the body as one
 * slow mass. Term 3 is nearly uniform along the body for the same reason
 * (pos.y * 0.04 covers a quarter radian over six units of tentacle), so it
 * reads as whole-body drift with a slight lag whipping down the filaments.
 * That lag is the entire jellyfish walk cycle, and it costs three sin calls.
 *
 * Their FRAGMENT does not port. It opens with getFBR / unpackNormalFBR from
 * their fbr.vs / fbr.fs chunks -- a full forward-lit material chain (normal
 * map unpacking, matcap, per-light accumulation, tNormal / uNormalStrength
 * uniforms) that is not among this bundle's extractable chunks, and it also
 * feeds on tVideo of the showreel. Rather than fake that chain, the fragment
 * here is an interpretation built from our own chunks: FRESNEL for the rim,
 * cnoise mottle so the cap is not a flat card, base colour #22301f lifting
 * to #93a86a only at grazing angles. Their mouse-whiten term (vMouse) and
 * the video feed are deliberately dropped -- both fight the quiet-silhouette
 * read the reference frames show. Their tRefraction sample survives in
 * spirit: opts.refraction, when provided, is added at the rim only.
 *
 * INTERPRETATIONS beyond the fragment, marked again at point of use:
 *   - uPhase. Their bundle draws one jelly mesh; our tentacles are separate
 *     tubes, and giving each one a phase offset into term 3 stops them
 *     swaying in unison. The offset fades in over the first two units below
 *     the cap so the tentacle roots still move WITH the cap -- a constant
 *     offset at amplitude 1.0 visibly tears the root joint off the body.
 *   - uScroll. Theirs is the page scroll feeding the ripple phase. It is
 *     exposed in the returned uniforms and rests at 0, which is safe here:
 *     it is a phase term, never a divisor or a smoothstep edge.
 */

const JELLY_VS = /* glsl */`
  uniform float time;
  uniform float uScroll;
  uniform float uPhase;

  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;
  varying float vY;

  ${NOISE}

  void main() {
    vec3 pos = position;

    /* AT, JellyShader.glsl vertex, verbatim from here down to the varyings.
     * Order matters and is preserved: the wobble writes pos.y FIRST, and both
     * sway terms then read the wobbled pos.y, exactly as their shader does. */
    pos.y += cnoise(pos * vec3(0.1, 0.5, 0.1) * 0.8 + time * 0.5 * 0.35) * 0.6;

    pos.x += sin(pos.y + time * 0.1 + uScroll) * 0.1;
    pos.z += cos(pos.y + time * 0.1 + uScroll) * 0.1;

    /* Their broad sway, with one addition: uPhase, our per-tentacle offset
     * (0 on the cap). It is faded in below the cap so the tentacle root sways
     * exactly with the body and only the free length diverges -- smoothstep
     * with descending edges is the idiom their own shaders use everywhere
     * (smoothstep(10.0, -10.0, ...) and friends), and the edges here are
     * distinct constants, so the zero-width NaN trap cannot arise. */
    float ph = uPhase * smoothstep(-0.6, -2.4, pos.y);
    pos.x += sin(pos.y * 0.04 + time * 0.2 + ph) * 1.0;
    pos.z += cos(pos.y * 0.04 + time * 0.2 + ph) * 1.0;

    /* vY is the UNDISPLACED y -- the fragment fades tentacle tips by where
     * they are on the strand, not by where the sway happens to put them. */
    vY = position.y;

    vWorldPos = vec3(modelMatrix * vec4(pos, 1.0));
    // AT: vNormal = normalMatrix * normal; vViewDir = -vec3(modelViewMatrix * vec4(pos, 1.0))
    vNormal = normalMatrix * normal;
    vViewDir = -vec3(modelViewMatrix * vec4(pos, 1.0));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const JELLY_FS = /* glsl */`
  uniform sampler2D tRefraction;
  uniform float uRefraction;
  uniform float time;
  uniform vec2 resolution;
  uniform vec3 uBaseColor;
  uniform vec3 uRimColor;
  uniform vec3 uTint;
  uniform float uRim;
  uniform float uAlpha;
  uniform float uFadeFrom;
  uniform float uFadeTo;

  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;
  varying float vY;

  ${FRESNEL}
  ${NOISE}
  ${COLOR_UTILS}

  void main() {
    /* getFresnel normalizes both of its vector arguments internally, and
     * normalize() of a zero-length vector is NaN -- the same NaN that bloom
     * smears into a black frame. Interpolated normals CAN reach zero (two
     * opposing face normals averaged across a silhouette edge of this open
     * lathe), so both vectors are guarded before the chunk ever sees them. */
    vec3 nrm = vNormal;
    if (dot(nrm, nrm) < 1.0e-8) nrm = vec3(0.0, 0.0, 1.0);
    vec3 vdir = vViewDir;
    if (dot(vdir, vdir) < 1.0e-8) vdir = vec3(0.0, 0.0, 1.0);
    vec3 nUnit = nrm / max(1.0e-6, length(nrm));

    /* The rim. getFresnel already takes abs() of the dot before its pow, so
     * front and back faces of the open lathe light the same edge -- which is
     * what an actual translucent bell does. The clamp before OUR pow is the
     * project rule: the base is mathematically in [0,1] but nothing derived
     * from interpolation gets near a pow un-clamped in this codebase. */
    float f = clamp(getFresnel(nrm, vdir, 1.0), 0.0, 1.0);
    float rim = pow(f, 3.0) * uRim;

    /* Slow mottle so the cap has some interior life. cnoise is roughly
     * [-1, 1], the factor stays in [0.88, 1.12] -- it can never go negative,
     * so no clamp is needed before the multiply. */
    float noise = cnoise(vWorldPos * 1.5 + time * 0.12);

    /* Dark desaturated sage lifting to the pale rim only at grazing angles.
     * The base sits at value 0.19 -- in the reference frames the body is
     * scarcely brighter than the background, and it is the RIM that draws
     * the silhouette, not the fill. */
    vec3 color = mix(uBaseColor, uRimColor, rim);
    color *= 1.0 + noise * 0.12;

    /* AT's fragment adds texture2D(tRefraction, screenuv) * uReflection.y.
     * Ours keeps the idea but gates it twice: uRefraction is 0 whenever no
     * texture was supplied (a sampler cannot be null-checked in GLSL, so the
     * guard lives in this uniform, set from JS), and the sample is weighted
     * by the rim so the scene only ever glints through the edge -- a full
     * face refraction turns the quiet silhouette into a glass hero. */
    if (uRefraction > 0.001) {
      vec2 screenuv = gl_FragCoord.xy / resolution;
      screenuv += nUnit.xy * 0.02;
      color += texture2D(tRefraction, screenuv).rgb * uRefraction * rim;
    }

    color *= uTint;

    /* Tentacle tips dissolve rather than end. crange divides by the edge
     * difference, so the two fade uniforms are set from JS constants that
     * differ by at least 1.0 in every material -- never equal, no 0/0. The
     * cap gets edges far below its own geometry so it resolves to 1.0. */
    float a = uAlpha * crange(vY, uFadeFrom, uFadeTo, 0.0, 1.0);

    /* Hard ceiling, project rule: the composer runs HalfFloat targets with
     * additive blending and UnrealBloom, and a value spike becomes Inf, and
     * one Inf pixel blacks the whole frame once the blur reaches it. This
     * material never gets near 1.5, and the clamp keeps that a fact rather
     * than a hope. */
    color = clamp(color, vec3(0.0), vec3(1.5));
    gl_FragColor = vec4(color, a);
  }
`;

/* ---- geometry ------------------------------------------------------------ *
 * The cap is a lathe: a dome profile swept past 90 degrees so the rim curls
 * slightly under, with a small outward flare on the last quarter -- that
 * flare is the mushroom skirt, and it is what separates the reference
 * silhouette from a plain hemisphere. Rim lands near x 0.61, so the cap is
 * about 1.23 units across. The first point is nudged off x = 0 because a
 * degenerate ring at the pole gives the lathe averaged zero-length normals. */
const CAP_R = 0.55, CAP_H = 0.4;

function capProfile(steps = 24) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * Math.PI * 0.58;              // sweep to ~104deg: slight under-curl
    let x = Math.sin(a) * CAP_R;
    const y = Math.cos(a) * CAP_H;
    x += Math.pow(t, 6) * 0.08;                // the skirt flare, last quarter only
    pts.push(new THREE.Vector2(Math.max(1e-4, x), y));
  }
  return pts;
}

/* Five tentacles (the brief allows 4-6; the reference frames read as five).
 * Lengths, roots and phases are fixed rather than randomised so the layout
 * matches frame to frame and reload to reload -- this thing is set dressing
 * in a composed shot, not a particle system. Roots sit inside the skirt
 * radius; phases are spread over the full sway cycle so no two strands ever
 * whip together. Root offsets are baked into the GEOMETRY, not mesh.position:
 * the sway operates on object-space pos, so cap and tentacles must share one
 * object space or the phase fade cannot hold the joints closed. */
const TENT_SPECS = [
  { len: 5.6, angle: 0.0, r: 0.16, phase: 0.0 },
  { len: 4.4, angle: 1.26, r: 0.24, phase: 2.4 },
  { len: 5.1, angle: 2.51, r: 0.14, phase: 4.8 },
  { len: 4.2, angle: 3.77, r: 0.22, phase: 1.2 },
  { len: 4.9, angle: 5.03, r: 0.19, phase: 3.6 },
];

/**
 * @param shared            the shared uniform bag from main.js (uTime, uResolution used)
 * @param opts.position     THREE.Vector3 rest position. The reference frames put it
 *                          about 22% from frame left at mid-height; that mapping is
 *                          camera-dependent, so placement is the caller's call.
 * @param opts.scale        uniform group scale, default 1
 * @param opts.refraction   scene snapshot texture, bound as tRefraction. May be null;
 *                          the shader's uRefraction gate stays 0 in that case.
 * @param opts.tint         THREE.Color (or anything Color() accepts) multiplied over
 *                          the final colour, default white
 */
export function buildJelly(shared, opts = {}) {
  const group = new THREE.Group();
  const basePos = opts.position ? new THREE.Vector3().copy(opts.position) : new THREE.Vector3();
  group.position.copy(basePos);
  group.scale.setScalar(opts.scale ?? 1);

  /* Uniform OBJECTS shared across all six materials, the same way main.js
   * shares uTime: drive the value once, every material sees it. */
  const uScroll = { value: 0 };
  const tRefraction = { value: opts.refraction ?? null };
  const uRefraction = { value: opts.refraction ? 0.3 : 0 };
  const uTint = { value: new THREE.Color(opts.tint ?? 0xffffff) };

  const makeMaterial = ({ phase, rim, alpha, fadeFrom, fadeTo }) =>
    new THREE.ShaderMaterial({
      vertexShader: JELLY_VS,
      fragmentShader: JELLY_FS,
      uniforms: {
        time: shared.uTime,
        resolution: shared.uResolution,
        uScroll,
        tRefraction,
        uRefraction,
        uTint,
        uPhase: { value: phase },
        uRim: { value: rim },
        uAlpha: { value: alpha },
        uBaseColor: { value: new THREE.Color('#22301f') },
        uRimColor: { value: new THREE.Color('#93a86a') },
        uFadeFrom: { value: fadeFrom },
        uFadeTo: { value: fadeTo },
      },
      /* NORMAL blending, deliberately, in an additive scene: a dark
       * silhouette can only exist if it can occlude what is behind it, and
       * additive blending can only brighten. depthWrite stays off with the
       * rest of the translucent stack; at alpha 0.92 the far wall of the
       * open lathe ghosting through the near one reads as body density, not
       * as an artifact. DoubleSide because the lathe is an open shell -- the
       * underside of the cap is in frame whenever the jelly bobs above the
       * camera line. */
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

  /* ---- the cap ---------------------------------------------------------- */
  const capGeo = new THREE.LatheGeometry(capProfile(), 48);
  const capMat = makeMaterial({
    phase: 0,
    rim: 1.0,
    alpha: 0.92,
    /* Fade edges parked 40 units below a cap whose lowest point is at about
     * -0.11: crange clamps, resolves to 1.0 across the whole cap, and the
     * edges still differ by 1.0 so its divisor can never be zero. */
    fadeFrom: -40.0,
    fadeTo: -39.0,
  });
  const cap = new THREE.Mesh(capGeo, capMat);
  // the vertex shader walks it up to ~1.7 units off its bounds; same call home.js makes
  cap.frustumCulled = false;
  group.add(cap);

  /* ---- the tentacles ----------------------------------------------------- */
  const tentacles = TENT_SPECS.map(spec => {
    /* A 6-sided open taper, 96 height segments: term 2's ripple has a
     * wavelength of 2*PI units along y, so a strand this long needs the
     * subdivision or the ripple facets. Root radius 0.016 down to 0.004 --
     * in the reference these are hairs, and any thicker they read as ropes. */
    const geo = new THREE.CylinderGeometry(0.016, 0.004, spec.len, 6, 96, true);
    geo.translate(
      Math.cos(spec.angle) * spec.r,
      -spec.len / 2 - 0.12,               // top of the strand just under the skirt
      Math.sin(spec.angle) * spec.r
    );
    const mat = makeMaterial({
      phase: spec.phase,
      /* A 0.016-radius tube is ALL grazing angle, so full rim strength would
       * light the entire strand like a filament bulb. Kept low: the strands
       * should be darker than the cap edge, just catching light in places. */
      rim: 0.3,
      alpha: 0.6,
      /* Dissolve over the last two units of the strand. Edge difference is a
       * constant 2.0 -- crange's divisor cannot be zero. */
      fadeFrom: -spec.len - 0.12,
      fadeTo: -spec.len + 1.88,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  });

  /* ---- drift ------------------------------------------------------------- *
   * The shader already carries AT's sway; this layer adds the slow wander of
   * the whole animal through the frame, which their scene drives from its
   * scroll camera and ours gets from update(dt). Accumulated internal phase,
   * on purpose: driving this from wall-clock time would teleport the jelly
   * after a background tab pause, where an accumulated phase (dt already
   * clamped by the caller) just resumes. The three frequencies share no
   * common period, so the path never visibly loops. */
  let phase = 0;

  return {
    group,
    tentacles,
    uniforms: {
      uScroll,
      uRefraction,
      uTint,
      cap: capMat.uniforms,
      tentacles: tentacles.map(t => t.material.uniforms),
    },

    update(dt) {
      phase += dt;
      group.position.set(
        basePos.x + Math.sin(phase * 0.11) * 0.45,
        basePos.y + Math.sin(phase * 0.07 + 1.3) * 0.6,
        basePos.z + Math.cos(phase * 0.05) * 0.3
      );
      // a slight heel as it drifts, so the bob reads as swimming, not hovering
      group.rotation.z = Math.sin(phase * 0.06) * 0.07;
    },

    stats: {
      tentacles: TENT_SPECS.length,
      capTris: capGeo.index ? capGeo.index.count / 3 : 0,
      tentacleTris: tentacles.reduce(
        (n, t) => n + (t.geometry.index ? t.geometry.index.count / 3 : 0), 0),
    },
  };
}
