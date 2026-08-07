import * as THREE from 'three';
import { NOISE, COLOR_UTILS } from './shaders.js';
import { TRANSFORM_UV } from './glsl-chunks.js';

/* NEBULA — the soft glowing volumes and the right-edge aurora leak
 *
 * Two pieces, both atmosphere rather than objects:
 *
 *   clouds   8-12 billboarded planes shaped after reference frame 3 — the teal
 *            cluster right of centre, the yellow-green masses hugging the mark,
 *            one small purple wisp at frame left, plus two deep filler veils.
 *            Faintly present behind everything in frame 1 as well.
 *   aurora   the tall green light leak hugging the right edge of frame 1. It
 *            reads as a leak, not an object, and is tuned to stay that way.
 *
 * WHAT IS THEIRS AND WHAT IS NOT
 *
 * The clouds are built on Active Theory's LightVolume.glsl (compiled.vs), which
 * is exactly this: camera-facing glow quads whose alpha is a soft texture times
 * a noise-warped mask, tinted through an HSV hue shift. Three of its fragment
 * lines are used structurally intact and are marked at the point of use:
 *
 *   - the rotateUV(auv, time * uRotateTexture * 0.1) texture spin
 *   - the noise-warp trio: uv += noise * range; uv = scaleUV(uv, range(noise,
 *     -1.0, 0.0, 0.96, 1.02)); uv.x += sin(time * 0.04) * 0.3
 *   - the rgb2hsv / hue += shift / hsv2rgb tint block
 *
 * Two substitutions were unavoidable:
 *
 *   1. tMap / tMask. Their alpha comes from a painted soft-glow texture times a
 *      mask texture. There are no texture assets in this recreation, so the
 *      alpha is fbm (from the NOISE chunk) times a radial falloff instead. The
 *      falloff plays the role of tMap, the fbm plays the role of tMask — same
 *      slot in the same expression, different generator. Interpretation, and it
 *      is what makes the edges ragged rather than round.
 *   2. Instancing. Theirs is a single instanced draw with per-instance offset /
 *      attribs attributes and a rotationMatrix in the vertex stage. At 10 quads
 *      an instanced path buys nothing, so each cloud is its own mesh driven
 *      from a config array, and billboarding is a lookAt in update(camera)
 *      rather than vertex math. Same picture, less machinery.
 *
 * The aurora has NO direct source in their bundle — nothing in compiled.vs
 * draws it (their frame most likely gets it from HomeBGShader's painted
 * backdrop texture, which is also an asset we do not have). It is an
 * interpretation of reference frame 1, with one borrowed idiom: the
 * cnoise-driven hue drift from NavBGShader.glsl's rainbow block, adapted from
 * their vec2 cnoise overload to our vec3-only cnoise and tamed from *0.2 to
 * *0.04 because a visible rainbow would read as UI, not atmosphere.
 *
 * MAGNITUDE DISCIPLINE. Everything here is additive under UnrealBloom on
 * HalfFloat targets. Both fragments keep their peak rgb well under 1.0 by
 * construction and clamp to 1.5 on the way out anyway — one hot pixel becomes
 * Inf in the blur chain and takes the whole frame with it. The clouds sit at
 * roughly 0.3 peak: they are meant to be amplified by bloom, not to feed it.
 */

/* ---- cloud layout, read off reference frame 3 --------------------------- *
 * World scale matches home.js: the mark at the origin, camera 30-45 units out,
 * the plume ring from radius 2.5 to 12. At that distance the visible half
 * width is roughly 25 units, which is what puts the purple wisp at -13 and the
 * teal cluster at +10..14.
 *
 *   tint        per-cloud colour, fed through their HSV hue-shift block
 *   position    world, z pushed to -7..-14 so every cloud sits BEHIND the
 *               plume and the mark — these are backdrop, and a cloud in front
 *               of the grains flattens the whole depth read
 *   scale       plane size in world units, [width, height]
 *   alpha       peak alpha BEFORE uNebula — deliberately 0.07..0.17. These
 *               overlap, and additive overlap sums; four veils at 0.15 already
 *               put 0.6 of coverage on a pixel before bloom touches it
 *   noiseScale  fbm frequency over the plane — higher = finer curdling
 *   rotate      their uRotateTexture rate; sign alternates so adjacent clouds
 *               do not visibly co-rotate
 *   seed        offsets the fbm field so no two clouds share a pattern
 */
const CLOUD_CONFIG = [
  // yellow-green masses around the mark — the broad olive field of frame 3
  { tint: '#9db332', position: [-4.5, 1.5, -8], scale: [16, 11], alpha: 0.16, noiseScale: 2.6, rotate: 0.4, seed: 11.3 },
  { tint: '#b7c93e', position: [3.5, -1.0, -7], scale: [13, 9], alpha: 0.14, noiseScale: 3.1, rotate: -0.3, seed: 4.7 },
  { tint: '#87a02b', position: [-1.0, -4.0, -10], scale: [18, 10], alpha: 0.12, noiseScale: 2.2, rotate: 0.25, seed: 27.1 },
  { tint: '#c9d465', position: [1.5, 4.5, -9], scale: [11, 7], alpha: 0.1, noiseScale: 3.6, rotate: -0.5, seed: 8.9 },
  // the teal cluster right of centre
  { tint: '#2fd4a8', position: [11.5, -2.5, -9], scale: [10, 7], alpha: 0.17, noiseScale: 2.9, rotate: 0.35, seed: 15.2 },
  { tint: '#1fae8e', position: [14.0, -4.0, -11], scale: [8, 6], alpha: 0.13, noiseScale: 3.4, rotate: -0.4, seed: 31.7 },
  { tint: '#49e0c0', position: [9.5, -1.0, -7], scale: [6, 4.5], alpha: 0.12, noiseScale: 4.2, rotate: 0.6, seed: 2.4 },
  // the one small purple wisp at frame left — elongated, standing on end
  { tint: '#8a5fc9', position: [-13.5, 2.5, -10], scale: [4.5, 9], alpha: 0.12, noiseScale: 3.0, rotate: 0.3, seed: 19.6 },
  /* Two deep, near-black-green veils. NOT in any single feature of the
   * reference — they are what keeps the three coloured groups from floating as
   * separate stickers on black. Frame 3's darkness is murky, not empty, and
   * these two provide the murk. Interpretation. */
  { tint: '#41552a', position: [6.0, 2.0, -13], scale: [20, 12], alpha: 0.08, noiseScale: 1.8, rotate: 0.2, seed: 44.2 },
  { tint: '#2d4a3c', position: [-8.0, -2.0, -14], scale: [22, 13], alpha: 0.07, noiseScale: 1.6, rotate: -0.2, seed: 52.8 },
];

/* Their LightVolume.vs minus the instancing: transformPosition() and the
 * per-instance rotationMatrix are gone because billboarding happens in JS
 * (update's lookAt) and each cloud is its own mesh. What remains is exactly
 * their varying handoff. */
const CLOUD_VS = /* glsl */`
  varying vec2 vUv;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    vWorldPos = vec3(modelMatrix * vec4(position, 1.0));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CLOUD_FS = /* glsl */`
  uniform vec3 uTint;
  uniform float uCloudAlpha;
  uniform float uSeed;
  uniform float uNoiseScale;
  uniform float uRotate;
  uniform float uHueDrift;
  uniform float uNebula;
  uniform float time;
  uniform vec2 resolution;   // part of the shared bag contract; unused here

  varying vec2 vUv;
  varying vec3 vWorldPos;

  ${NOISE}
  ${COLOR_UTILS}
  ${TRANSFORM_UV}

  void main() {
    /* The MASK falloff is computed from RAW vUv, before any warp touches it.
     * This is a deliberate departure from LightVolume, which warps the mask uv
     * itself: their mask texture has empty margins to warp into, our
     * procedural disc does not. Warp the disc and the ragged edge periodically
     * slides off the quad, showing a straight geometric clip — so the disc
     * pins the silhouette to the plane and all raggedness lives in the fbm
     * term instead. */
    float disc = smoothstep(0.5, 0.15, length(vUv - 0.5));

    // AT: auv = rotateUV(vUv, time * uRotateTexture * 0.1) — their texture spin
    vec2 uv = rotateUV(vUv, time * uRotate * 0.1);

    /* AT's noise-warp trio from LightVolume.fs, structurally intact:
     *   uv += noise * uNoiseRange * 0.1;
     *   uv = scaleUV(uv, vec2(range(noise, -1.0, 0.0, 0.96, 1.02)));
     *   uv.x += sin(time * 0.04) * 0.3;
     * Two adaptations, both stated:
     *   - the warp noise samples vWorldPos, not object-space vPos, so
     *     neighbouring clouds sample one continuous field and knit together
     *     where they overlap instead of visibly sliding across each other
     *   - crange instead of their unclamped range(). Clamping only changes
     *     noise > 0.0 (scale capped at 1.02 instead of drifting to 1.08) and
     *     guarantees scaleUV never divides by anything near zero
     *   - their 0.3 x-drift shifted the MASK texture; on our fbm it is kept,
     *     because fbm has no margins to run out of */
    float warp = cnoise(vWorldPos * 0.22 + time * 0.03);
    uv += warp * 0.08;
    uv = scaleUV(uv, vec2(crange(warp, -1.0, 0.0, 0.96, 1.02)));
    uv.x += sin(time * 0.04) * 0.3;

    /* The tMask substitute. fbm spans roughly -0.9..0.9 in practice; crange
     * maps the useful band to 0..1 and CLAMPS, so the pow below always sees a
     * non-negative base — pow of a negative base is undefined GLSL and has
     * produced NaN three times in this project already. The exponent steepens
     * the transition, which is what makes the edges curdle instead of fog. */
    float body = crange(fbm(vec3(uv * uNoiseScale, uSeed + time * 0.03)), -0.35, 0.55, 0.0, 1.0);
    body = pow(body, 1.6);

    /* AT's tint block from LightVolume.fs:
     *   color = rgb2hsv(uColor); color += vOffset * uHueShift * 0.01;
     *   color = hsv2rgb(color);
     * Their per-instance vOffset becomes the warp noise, so hue drifts with
     * the same field that moves the cloud. hsv2rgb runs the hue through
     * fract(), so a hue nudged below zero wraps rather than breaking. */
    vec3 hsv = rgb2hsv(uTint);
    hsv.x += warp * uHueDrift * 0.01;
    hsv.z *= 0.85 + 0.3 * body;
    vec3 color = hsv2rgb(hsv);

    float alpha = disc * body * uCloudAlpha * uNebula;

    /* 0.6 keeps peak rgb near 0.55 for the hottest tint. These are atmosphere:
     * bloom multiplies them, ten of them overlap additively, and a cloud that
     * is bright on its own washes the frame once both of those stack. The
     * min() is the hard Inf guard every additive material here carries. */
    gl_FragColor = vec4(color * 0.6, alpha);
    gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(1.5));
  }
`;

/* ---- aurora ------------------------------------------------------------- *
 * Interpretation throughout — see the header. The ribbon is a tall plane bowed
 * in the vertex stage; geometry-level curvature would also work but the vertex
 * bow lets the sway ride the same arc term for free. */
const AURORA_VS = /* glsl */`
  uniform float time;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vec3 pos = position;

    /* One half-sine of arc over the ribbon's height: the middle bows toward
     * frame centre (-x) and slightly toward the camera (+z), which is what
     * turns a flat card into the curved leak of reference frame 1. The arc
     * term is also the sway envelope, so the pinned ends never move — a
     * ribbon whose ends wander reads as an object, and this must not. */
    float arc = sin(clamp(uv.y, 0.0, 1.0) * 3.14159265);
    pos.x -= arc * 2.0;
    pos.z += arc * 1.2;
    pos.x += sin(time * 0.12 + uv.y * 4.0) * 0.35 * arc;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const AURORA_FS = /* glsl */`
  uniform vec3 uColorDeep;
  uniform vec3 uColorBright;
  uniform float uAurora;
  uniform float time;
  uniform vec2 resolution;   // part of the shared bag contract; unused here

  varying vec2 vUv;

  ${NOISE}
  ${COLOR_UTILS}

  void main() {
    vec2 uv = vUv;

    /* The scrolling body: fbm advected downward in uv.y so the gradient runs
     * upward on screen. crange clamps, so every consumer below sees 0..1. */
    float flow = fbm(vec3(uv.x * 1.5, uv.y * 2.5 - time * 0.08, 7.31));
    float body = crange(flow, -0.45, 0.55, 0.0, 1.0);

    // deep green at the foot, #2fbf4f toward the head, bent by the flow field
    float ramp = clamp(uv.y * 0.8 + flow * 0.3, 0.0, 1.0);
    vec3 color = mix(uColorDeep, uColorBright, ramp);

    /* AT: rainbow.x += cnoise(-bgUV*0.5 - bgUV.y*0.5 - time*0.05 ...) * 0.2
     * — NavBGShader.glsl's hue drift. Adapted: their cnoise has a vec2
     * overload, ours is vec3-only so time moves to the third lane; and the
     * amplitude is cut to 0.04 because at 0.2 the leak cycles visibly through
     * cyan and reads as UI chrome instead of light. */
    vec3 hsv = rgb2hsv(color);
    hsv.x += cnoise(vec3(-uv * 0.5 - uv.y * 0.5, time * 0.05)) * 0.04;
    color = hsv2rgb(hsv);

    /* Alpha dies at ALL FOUR edges. The vertex bow moves the silhouette, so
     * any edge that keeps alpha shows as a razor line sweeping the frame —
     * the top fade is the widest because the head of the leak dissolves over
     * a fifth of its height in the reference. */
    float edge = smoothstep(0.0, 0.18, uv.x) * smoothstep(1.0, 0.82, uv.x)
               * smoothstep(0.0, 0.14, uv.y) * smoothstep(1.0, 0.8, uv.y);

    float alpha = edge * (0.15 + 0.55 * body) * uAurora;

    /* 0.5 puts peak rgb near 0.38 — in the reference this is the faintest
     * light on the page, a leak the bloom is allowed to breathe on, and any
     * more than this competes with the mark. Same Inf guard as the clouds. */
    color *= 0.4 + 0.6 * body;
    gl_FragColor = vec4(color * 0.5, alpha);
    gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(1.5));
  }
`;

const _camPos = new THREE.Vector3();

/**
 * @param shared  the shared uniform bag from main.js
 *                ({ uTime, uDPR, uScrollDelta, uResolution, uMouse })
 * @param opts.clouds        config array override, same shape as CLOUD_CONFIG
 * @param opts.nebula        initial master cloud intensity (uNebula, 0..1)
 * @param opts.aurora        initial aurora intensity (uAurora, 0..1)
 * @param opts.auroraDeep    foot colour of the ribbon gradient
 * @param opts.auroraBright  head colour of the ribbon gradient
 */
export function buildNebula(shared, opts = {}) {
  const group = new THREE.Group();

  /* ONE uniform object each, shared by reference across every material, so a
   * single write from the caller fades the whole formation — same pattern as
   * shared.uTime itself. uNebula scales cloud alpha, uAurora the ribbon. */
  const uNebula = { value: opts.nebula ?? 1 };
  const uAurora = { value: opts.aurora ?? 1 };

  /* ---- clouds ----------------------------------------------------------- *
   * One unit quad, scaled per mesh. Billboarding is a lookAt in update():
   * cheap, and for face-on glow quads indistinguishable from the vertex-stage
   * spherical billboard their instanced version implies. */
  const planeGeo = new THREE.PlaneGeometry(1, 1);
  const configs = opts.clouds ?? CLOUD_CONFIG;

  const clouds = configs.map(cfg => {
    const material = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VS,
      fragmentShader: CLOUD_FS,
      uniforms: {
        uTint: { value: new THREE.Color(cfg.tint) },
        uCloudAlpha: { value: cfg.alpha },
        uSeed: { value: cfg.seed },
        uNoiseScale: { value: cfg.noiseScale },
        uRotate: { value: cfg.rotate },
        uHueDrift: { value: cfg.hueDrift ?? 1.5 },
        uNebula,
        time: shared.uTime,
        resolution: shared.uResolution,
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(planeGeo, material);
    mesh.position.fromArray(cfg.position);
    mesh.scale.set(cfg.scale[0], cfg.scale[1], 1);
    group.add(mesh);

    /* Per-cloud bob parameters, derived from the seed rather than random so a
     * reload shows the same sky. Speeds land in 0.02..0.1 rad/s — a cloud that
     * visibly travels stops being weather and starts being a prop. */
    return {
      mesh,
      cfg,
      uniforms: material.uniforms,
      baseY: cfg.position[1],
      bobAmp: 0.4,
      bobSpeed: 0.06 + 0.04 * Math.sin(cfg.seed),
      bobPhase: cfg.seed,
    };
  });

  /* ---- aurora ----------------------------------------------------------- *
   * 4 x 96 segments: the bow and sway are pure functions of uv.y, so height
   * segments are the only ones doing work — width segments stay minimal.
   * Position hugs the right edge of frame at home.js's world scale (visible
   * half-width is ~25 at the camera's 30-45 unit distance), yawed inward so
   * the bowed face catches the camera instead of presenting edge-on. */
  const auroraGeo = new THREE.PlaneGeometry(6, 34, 4, 96);
  const auroraMat = new THREE.ShaderMaterial({
    vertexShader: AURORA_VS,
    fragmentShader: AURORA_FS,
    uniforms: {
      uColorDeep: { value: new THREE.Color(opts.auroraDeep ?? '#07240f') },
      uColorBright: { value: new THREE.Color(opts.auroraBright ?? '#2fbf4f') },
      uAurora,
      time: shared.uTime,
      resolution: shared.uResolution,
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,   // the yaw + bow can show its back at frame edge
    blending: THREE.AdditiveBlending,
  });
  const aurora = new THREE.Mesh(auroraGeo, auroraMat);
  aurora.position.set(23, 0, -8);
  aurora.rotation.y = -0.4;
  // the vertex bow moves it ~2 units outside its geometric bounds
  aurora.frustumCulled = false;
  group.add(aurora);

  return {
    group,
    clouds,
    aurora,
    uniforms: { uNebula, uAurora },

    /**
     * Once per frame, before render.
     *
     * @param camera  the scene camera; every cloud lookAt-billboards to it
     * @param dt      accepted for API symmetry with the other sections; the
     *                bob reads shared.uTime instead so pausing time pauses
     *                the sky with everything else
     */
    update(camera /* , dt */) {
      camera.getWorldPosition(_camPos);
      const t = shared.uTime.value;
      for (const c of clouds) {
        /* Bob BEFORE lookAt, so the culling bounds three computes from the
         * mesh transform stay honest — the fragment never moves geometry, so
         * unlike the plume these meshes keep frustum culling on. */
        c.mesh.position.y = c.baseY + Math.sin(t * c.bobSpeed + c.bobPhase) * c.bobAmp;
        c.mesh.lookAt(_camPos);
      }
    },

    stats: {
      clouds: clouds.length,
      cloudTris: clouds.length * (planeGeo.index ? planeGeo.index.count / 3 : 0),
      auroraTris: auroraGeo.index ? auroraGeo.index.count / 3 : 0,
    },
  };
}
