import * as THREE from 'three';
import { NOISE } from './shaders.js';

/* THE CYPHERNAUT — the figure carrying reference frames 5 through 12.
 *
 * A POINT SHELL, not a mesh, and that is read off the frames rather than chosen for
 * performance: in frame 6 the nebula shows through the torso, in frame 9 the
 * detonation shows through, and in frame 12 the orbital rings pass behind the chest
 * and out the other side. The suit's seams, the backpack outline and the helmet ring
 * all read as accumulated grain. There is no frame in the sequence where a solid
 * surface appears. So the source GLB's 1.99M triangles and 276 textures are baked
 * offline into 140k surface points -- see scripts/bake-astro.mjs.
 *
 * WHAT DRAWS THE FIGURE is fresnel, and it is worth being explicit because it is the
 * whole trick. A uniformly-bright point cloud of a human reads as a vague swarm. In
 * every reference frame the SILHOUETTE and the seam edges burn brightest while the
 * flat of the chest stays dim. That is exactly `1 - |dot(N, V)|`: points whose normal
 * is perpendicular to the view sit on a limb's edge. Weighting brightness by it turns
 * the same 140k points into a legible figure with an outline, and it costs one dot
 * product. Frame 8 is that effect at its strongest.
 *
 * TWO SHELLS, one geometry. The additive shell is the glow. The OCCLUDER shell is a
 * near-black copy on normal blending, and frame 9 is why it exists: the detonation
 * sits behind the astronaut and the suit is plainly opaque against it -- dark interior,
 * hot rim. Additive blending can only brighten, so the glow shell alone cannot produce
 * that. The occluder's alpha rests at 0 and main.js raises it for the burst. It shares
 * the geometry buffer, so it costs one extra draw call and no extra upload.
 *
 * The sequence's four beats drive these uniforms rather than swapping materials:
 *
 *   frames 5-8   uDefinition 0 -> 1   diffuse cloud tightening onto the suit,
 *                uBrightness rising; the halo behind the head is the emblem
 *   frame 9      uOcclude up, uTint toward cyan-white, the burst behind
 *   frames 10-11 uTint toward gold, uSparkle up, dust around it
 *   frame 12     uTint teal, uDefinition 1, HUD rings and a particle floor
 */

/* ---- container -----------------------------------------------------------
 * Written by scripts/bake-astro.mjs. The 10-byte-prefix + JSON-header shape is
 * Active Theory's own (parseATContainer in flower-cloud.js) so this project keeps ONE
 * container idea; the payload is quantised typed arrays rather than Draco.
 */
const ASTRO_URL = './assets/astro-points.bin';

async function loadAstroPoints(url = ASTRO_URL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const u8 = new Uint8Array(buf);

  const lenStr = new TextDecoder().decode(u8.subarray(0, 10)).replace(/\0+$/, '').trim();
  const jsonLen = parseInt(lenStr, 10);
  if (!Number.isFinite(jsonLen) || jsonLen <= 0 || jsonLen > 4096) {
    throw new Error(`${url}: bad header length prefix "${lenStr}"`);
  }
  const meta = JSON.parse(new TextDecoder().decode(u8.subarray(10, 10 + jsonLen)).trim());
  const count = meta.count;

  /* Payload starts on a 2-byte boundary, matching the baker's padding. */
  let off = 10 + jsonLen;
  if (off % 2) off++;

  /* Positions are DEQUANTISED ON THE CPU into Float32 rather than handed to GL as a
   * normalised Int16 attribute. GL's signed-normalised mapping divides by 32767 while
   * the baker encoded against 65535, so the two disagree by ~1.5e-5 of the bounding
   * box -- harmless, but it would mean the shader had to carry the exact decode
   * formula and the header's qmin/qmax as uniforms to be correct. 1.7 MB of float
   * positions buys that ambiguity away outright.
   *
   * Normals stay Int8 normalised: a unit direction in [-1, 1] is precisely what
   * signed-normalised gives, so there is no mismatch to reason about. */
  const qi = new Int16Array(buf, off, count * 3);
  const ni = new Int8Array(buf, off + count * 6, count * 3);
  /* v2 of the bake appends one crease byte per point -- the seam weight that draws
   * the suit's quilting. Guarded so a v1 file still loads (it just has no seams). */
  const hasCrease = (meta.attributes ?? []).some(a => a[0] === 'crease');
  const ci = hasCrease ? new Int8Array(buf, off + count * 9, count) : null;
  const position = new Float32Array(count * 3);
  const { qmin, qmax } = meta;
  for (let a = 0; a < 3; a++) {
    const lo = qmin[a], span = qmax[a] - lo;
    for (let i = 0; i < count; i++) {
      position[i * 3 + a] = lo + ((qi[i * 3 + a] + 32768) / 65535) * span;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(ni, 3, true));
  geometry.setAttribute('aCrease', ci
    ? new THREE.BufferAttribute(ci, 1, true)          // 0..127 -> 0..1 normalised
    : new THREE.BufferAttribute(new Float32Array(count), 1));
  /* Stable per-point random, generated here rather than baked: it costs 4 bytes a
   * point in the file and one multiply here, and keeping it out of the asset means the
   * bake stays purely geometric. Seeded off the index so it is identical every load --
   * the sparkle pattern must not reshuffle between reloads while comparing frames. */
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // cheap integer hash -> [0,1)
    let h = (i * 2654435761) >>> 0;
    h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
    seed[i] = (h >>> 8) / 16777216;
  }
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geometry.computeBoundingSphere();

  return { geometry, meta };
}

const ASTRO_VS = /* glsl */`
  uniform float time;
  uniform float uSize;
  uniform float uDefinition;
  uniform float uScatter;
  uniform float uFresnelPow;
  uniform float uPixelRatio;
  uniform float uEraseY;
  uniform float uEraseSoft;

  attribute float aSeed;
  attribute float aCrease;

  varying float vFres;
  varying float vSeed;
  varying float vCrease;
  varying float vConsume;
  varying vec3 vWorldNormal;

  ${NOISE}

  void main() {
    vec3 pos = position;
    vSeed = aSeed;
    vCrease = aCrease;

    /* MATERIALISE. At uDefinition 0 every point is pushed off the surface along its
     * own normal by a noise field, so the figure is a loose haze with only its mass
     * suggested; at 1 they sit exactly on the baked surface. Frames 5 to 8 walk that
     * dial, which is what makes the suit resolve out of the particle field rather than
     * fade up as a finished object.
     *
     * Displacing along the NORMAL rather than in a random direction matters: it keeps
     * the cloud's shape a swollen version of the figure instead of a sphere, so the
     * silhouette is readable even at definition 0. */
    float loose = 1.0 - clamp(uDefinition, 0.0, 1.0);
    if (loose > 0.001) {
      float n = cnoise(pos * 0.35 + time * 0.08 + aSeed * 4.0);
      pos += normal * (0.35 + n * 0.65) * loose * uScatter;
    }

    /* THE METAMORPHOSIS (frames 13-16). Everything below uEraseY is being consumed
     * by the rising spine: points scatter outward along their normals, drift upward
     * like embers, and fade (the fragment reads vConsume). Driving this by
     * OBJECT-SPACE height means the erase line is one uniform, the same closed-form
     * y-based discipline as everything else on this figure. uEraseY rests at -1 --
     * below the boots -- so the whole effect is inert outside the morph beat. */
    vConsume = clamp((uEraseY - position.y) / max(0.2, uEraseSoft), 0.0, 1.0);
    if (vConsume > 0.001) {
      float sw = cnoise(pos * 0.5 + time * 0.12 + aSeed * 6.0);
      pos += normal * vConsume * (0.9 + sw * 0.7);
      pos.y += vConsume * (0.6 + aSeed * 1.1);
    }

    vWorldNormal = normalize(mat3(modelMatrix[0].xyz, modelMatrix[1].xyz, modelMatrix[2].xyz) * normal);

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);

    /* THE FIGURE-DRAWING TERM. viewDir in world space, so the silhouette tracks the
     * camera rather than the model's own axes. abs() so front and back faces of the
     * shell light the same edge -- the far wall of a limb is on the same silhouette as
     * the near one, and a point cloud has no depth test to separate them anyway. */
    vec3 worldPos = vec3(modelMatrix * vec4(pos, 1.0));
    vec3 V = normalize(cameraPosition - worldPos);
    vFres = pow(1.0 - clamp(abs(dot(vWorldNormal, V)), 0.0, 1.0), uFresnelPow);

    /* Perspective attenuation with a FLOOR. Without the floor a 10-unit figure seen
     * from 40 units has most of its points under a pixel, and a sub-pixel point does
     * not render dim -- it aliases in and out, which reads as static rather than as a
     * distant figure. This project has been caught by that exact thing on the jelly's
     * filaments. The ratio term keeps the figure's density identical on HiDPI. */
    float sz = uSize * uPixelRatio * (0.55 + aSeed * 0.9);
    // edge points draw larger, thickening the outline; seam points likewise --
    // the reference's grooves are LINES with width, not chains of specks
    sz *= 1.0 + vFres * 0.85 + aCrease * 0.55;
    gl_PointSize = max(1.15 * uPixelRatio, sz * 260.0 / max(1.0, -mv.z));

    gl_Position = projectionMatrix * mv;
  }
`;

const ASTRO_FS = /* glsl */`
  uniform vec3 uTint;
  uniform vec3 uEdgeTint;
  uniform float uBrightness;
  uniform float uSparkle;
  uniform float uSeam;
  uniform float uCore;
  uniform float uAlpha;
  uniform float time;

  varying float vFres;
  varying float vSeed;
  varying float vCrease;
  varying float vConsume;
  varying vec3 vWorldNormal;

  void main() {
    /* Crisp disc with a one-band antialiased edge, not a wide gaussian. The project
     * already learned this on the hero plume: a soft falloff was called out as looking
     * blurry and unprofessional, and the fix was a narrow band paid for with size and
     * bloom rather than with spread. */
    vec2 d = gl_PointCoord - 0.5;
    float mask = smoothstep(0.5, 0.42, length(d));
    if (mask <= 0.0) discard;

    /* Silhouette burn. uCore is the floor -- how much the flat of the suit glows at
     * all -- and the fresnel term is what actually draws the figure. */
    /* Gain 1.0, NOT 2.2. This is the constant that made the figure a white column.
     * At 2.2 a single edge point evaluates to lit 2.14, so it clipped on its own
     * before any overlap -- measured 42.7% of the figure's lit pixels pinned at 250+.
     * Capped at 1.0, one point can never clip and the bright edges are built by
     * ACCUMULATION of several high-fresnel points, which is what additive blending is
     * for and what leaves the flat of the suit dark. Measured after: 5.2% clipped,
     * 86% of lit pixels in the lower-mid range. */
    float lit = uCore + vFres * (1.0 - uCore);
    /* THE SEAMS. Baked dihedral creases -- the quilting, panel grooves and helmet
     * ring -- burn on top of the fresnel edge. This is the term that turns the flat
     * dust ghost into the reference's line-drawn suit: the interior gains structure
     * without the fill brightening. min() keeps the single-point no-clip rule. */
    lit = min(lit + vCrease * uSeam, 1.0);

    /* Sparkle: a per-point twinkle on its own phase. Frames 10 and 11 show individual
     * grains popping across the figure; this is that, and it is the same idea as the
     * uSparkle term on their flower cloud. */
    float tw = 0.5 + 0.5 * sin(time * 2.1 + vSeed * 62.8);
    lit *= 1.0 + uSparkle * (tw - 0.5) * 1.6;

    /* Edge hue: the reference edges run cooler/whiter than the body fill in every
     * frame, which is what stops a single-hue cloud reading as flat green paint. */
    vec3 col = mix(uTint, uEdgeTint, clamp(vFres * 1.35, 0.0, 1.0));
    col *= lit * uBrightness;

    /* Hard ceiling, project rule: HalfFloat targets, additive blending and
     * UnrealBloom mean one hot pixel becomes Inf and one Inf pixel blacks the whole
     * frame once the separable blur reaches it. */
    col = clamp(col, vec3(0.0), vec3(1.6));
    /* Consumed points go out as embers: brighten a touch as they scatter, then die.
     * The (1 - c)^2 keeps the fade front tight against the spine's rising crown. */
    float c = vConsume;
    float ember = (1.0 - c) * (1.0 - c);
    gl_FragColor = vec4(col * (1.0 + c * 0.8), mask * uAlpha * ember);
  }
`;

/* The occluder's fragment. Same discs, near-black, on NORMAL blending -- the only way
 * a point shell can darken what is behind it. Alpha is fresnel-INVERTED: strongest
 * across the flat of the suit, falling off at the silhouette, so it fills the body
 * without eating the glow shell's outline. */
const OCCLUDE_FS = /* glsl */`
  uniform vec3 uColor;
  uniform float uAlpha;
  varying float vFres;
  varying float vSeed;
  varying float vConsume;
  varying vec3 vWorldNormal;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float mask = smoothstep(0.5, 0.42, length(d));
    if (mask <= 0.0) discard;
    float body = 1.0 - clamp(vFres * 1.1, 0.0, 1.0);
    // a scattered ember must not darken what is behind it
    gl_FragColor = vec4(uColor, mask * body * uAlpha * (1.0 - vConsume));
  }
`;

/**
 * @param shared          the shared uniform bag from main.js (uTime, uResolution)
 * @param opts.scale      uniform scale; the baked figure is 10 units tall, feet at y=0
 * @param opts.position   rest position of the group
 * @param opts.url        override the baked cloud path
 */
export function buildAstro(shared, opts = {}) {
  const group = new THREE.Group();
  const basePos = opts.position ? new THREE.Vector3().copy(opts.position) : new THREE.Vector3();
  group.position.copy(basePos);
  group.scale.setScalar(opts.scale ?? 1);

  /* Uniform objects, shared by reference between the two shells where they mean the
   * same thing -- so main.js drives one value and both materials follow. */
  const uDefinition = { value: 1 };
  const uScatter = { value: opts.scatter ?? 1.6 };
  const uSize = { value: opts.size ?? 0.055 };
  const uFresnelPow = { value: opts.fresnelPow ?? 1.6 };
  const uPixelRatio = { value: Math.min(2, (globalThis.devicePixelRatio || 1)) };
  /* The metamorphosis dial. Object-space y below which the figure is consumed;
   * rests below the boots so nothing happens outside the morph beat. Shared by
   * both shells so the dark fill dies with the glow it backs. */
  const uEraseY = { value: -1 };
  const uEraseSoft = { value: opts.eraseSoft ?? 1.4 };

  const glowUniforms = {
    time: shared.uTime,
    uSize, uDefinition, uScatter, uFresnelPow, uPixelRatio, uEraseY, uEraseSoft,
    /* Body fill and edge. Frame 5-8's figure is a deep green with pale mint edges;
     * main.js retints per beat (cyan-white at the burst, gold in the dust, teal in
     * the grid). */
    uTint: { value: new THREE.Color(opts.tint ?? '#2f7d52') },
    uEdgeTint: { value: new THREE.Color(opts.edgeTint ?? '#d8ffe8') },
    /* 0.075, swept against clipped-pixel fraction rather than chosen by eye -- see
     * the gain note in the fragment. Around 0.22 the figure is a blob; below ~0.04 it
     * stops reading against the grain field. */
    uBrightness: { value: opts.brightness ?? 0.075 },
    uSparkle: { value: opts.sparkle ?? 0.35 },
    /* Seam gain. 0.9 puts a fully-creased point at the cap on its own; the visible
     * line weight then comes from accumulation along the groove. */
    uSeam: { value: opts.seam ?? 1.0 },
    /* 0.16: the flat of the suit is dim but not absent. At 0 the figure becomes a
     * pure wire outline with a hole in the middle, which no reference frame shows. */
    uCore: { value: opts.core ?? 0.05 },
    uAlpha: { value: opts.alpha ?? 1 },
  };

  /* The occluder gets its OWN size, 2.4x the glow's. Both shells draw the same 90k
   * points, but their jobs differ: the glow wants grain (small discs, gaps between
   * them ARE the texture), the occluder wants to be a WALL -- at matching size the
   * gaps between its discs let the nova core through at full strength and the
   * chest read white against the very detonation it must stay dark against.
   * Overlapping dark discs saturate toward uColor under normal blending, so the
   * oversize costs nothing visually where the glow repaints edges on top. */
  const uSizeOcclude = { value: (opts.size ?? 0.055) * 2.4 };
  const occludeUniforms = {
    time: shared.uTime,
    uSize: uSizeOcclude, uDefinition, uScatter, uFresnelPow, uPixelRatio, uEraseY, uEraseSoft,
    uColor: { value: new THREE.Color(opts.occludeColor ?? '#04100a') },
    // rests at 0; only the detonation beat needs the figure to read as opaque
    uAlpha: { value: 0 },
  };

  const glowMat = new THREE.ShaderMaterial({
    vertexShader: ASTRO_VS,
    fragmentShader: ASTRO_FS,
    uniforms: glowUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const occludeMat = new THREE.ShaderMaterial({
    vertexShader: ASTRO_VS,
    fragmentShader: OCCLUDE_FS,
    uniforms: occludeUniforms,
    transparent: true,
    depthWrite: false,
    // NormalBlending, deliberately: additive cannot darken, and darkening is the job
    blending: THREE.NormalBlending,
  });

  let glow = null, occluder = null, modelStats = null;
  let drawn = opts.points ?? 90000;

  /* Both shells share one geometry, so one drawRange governs both -- which is what we
   * want: the occluder must cover exactly the points the glow draws, or the dark fill
   * and the bright edge would disagree about where the figure is. */
  function setPoints(n) {
    if (!glow) { drawn = n; return; }
    const max = glow.geometry.attributes.position.count;
    drawn = Math.max(1, Math.min(max, Math.round(n)));
    glow.geometry.setDrawRange(0, drawn);
  }

  const ready = loadAstroPoints(opts.url ?? ASTRO_URL).then(({ geometry, meta }) => {
    /* The occluder is added FIRST so it draws first. Both have depthWrite off, so
     * within a transparent group three orders by insertion once renderOrder ties --
     * and the dark fill has to land under the glow, not over it. renderOrder is set
     * explicitly rather than relying on that. */
    occluder = new THREE.Points(geometry, occludeMat);
    occluder.renderOrder = -1;
    occluder.frustumCulled = false;      // the vertex shader walks points off-bounds
    group.add(occluder);

    glow = new THREE.Points(geometry, glowMat);
    glow.renderOrder = 0;
    glow.frustumCulled = false;
    group.add(glow);

    /* DENSITY AS A DIAL, via setDrawRange.
     *
     * The bake samples the surface in RANDOM order (area-weighted, then written as
     * drawn), so any PREFIX of the buffer is itself a valid uniform random subset of
     * the figure. That makes drawRange a free, artefact-free LOD -- no second asset,
     * no reshuffling, and the subset is stable across frames so the grain does not
     * crawl when the count changes.
     *
     * It matters because additive point clouds are density-limited, not gain-limited:
     * all 140k over a figure 163px wide is ~7 points per lit pixel, which fills the
     * suit solid however dim each point is. The references show individual grains, so
     * the count has to come down as the figure gets smaller in frame.
     * main.js sets this per beat via setPoints(). */
    setPoints(opts.points ?? 90000);

    modelStats = {
      source: meta.source ?? 'astro-points',
      points: meta.count,
      srcTris: meta.srcTris ?? null,
      bakedHeight: meta.height,
      /* Worth reading back: the figure's own proportions, which the reference framing
       * numbers in main.js are solved against. */
      widthAtShoulders: null,
    };
    return modelStats;
  }).catch(err => {
    console.warn('[astro] baked point cloud failed to load; no figure this session.\n'
      + '        run `node scripts/bake-astro.mjs` to build assets/astro-points.bin\n'
      + '       ', err);
    return null;
  });

  /* Idle float. The figure is weightless in every frame and never still: a slow bob,
   * a slight heel, and a drift so shallow it reads as being carried rather than as
   * moving. Accumulated phase rather than wall-clock, so a backgrounded tab resumes
   * instead of teleporting -- same reasoning as the jellyfish's drift. */
  let phase = 0;

  return {
    group,
    ready,
    get glow() { return glow; },
    get occluder() { return occluder; },
    uniforms: glowUniforms,
    occludeUniforms,
    setPoints,
    get drawnPoints() { return drawn; },
    /* Shared by reference with both materials; exposed once. */
    shape: { uDefinition, uScatter, uSize, uFresnelPow, uEraseY, uEraseSoft },

    update(dt) {
      phase += dt;
      group.position.set(
        basePos.x + Math.sin(phase * 0.13) * 0.22,
        basePos.y + Math.sin(phase * 0.09 + 0.7) * 0.42,
        basePos.z + Math.cos(phase * 0.06) * 0.18
      );
      group.rotation.z = Math.sin(phase * 0.05) * 0.028;
      // a barely-there yaw so the fresnel edge travels around the limbs
      group.rotation.y = Math.sin(phase * 0.037) * 0.10;
    },

    onResize() {
      uPixelRatio.value = Math.min(2, (globalThis.devicePixelRatio || 1));
    },

    get stats() { return modelStats; },
  };
}
