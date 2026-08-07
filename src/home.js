import * as THREE from 'three';
import { NOISE, COLOR_UTILS } from './shaders.js';
import { RGB_SHIFT, BLEND_MODES, TRANSFORM_UV } from './glsl-chunks.js';

/* SECTION 1 — HOME (420vh, route `home`)
 *
 * Two pieces of geometry live here, both driven by Active Theory's own shaders,
 * transcribed from activetheory.net/assets/shaders/compiled.vs:
 *
 *   columns   HomeColumnShader.glsl  — the crossing teardrop tails under the mark
 *   plume     ParticleTestShader.glsl — the rising particle plume and its burst
 *
 * The glass mark itself is not built here. main.js owns a single emblem instance
 * that Home and About take turns driving, because the two sections are never
 * on screen together and one instance means one shader program.
 *
 * WHAT IS THEIRS AND WHAT IS NOT
 *
 * Every line of vertex math below is copied from their shader, including the
 * constants. Three substitutions were unavoidable and are marked at the point of
 * use rather than only here:
 *
 *   1. tPos. Their plume reads its base positions out of an Antimatter FBO
 *      simulation (`texture2D(tPos, position.xy)`). There is no simulation here,
 *      so `position` IS the base position, seeded into the annulus their own
 *      shader implies — see seedPlume. Every displacement applied on top is theirs.
 *   2. tPointColor. Their per-point spawn colours come out of the same
 *      simulation. Ours is a `pointColor` attribute sampled from our green ramp.
 *   3. tVideo. Their columns and plume soft-light the showreel through
 *      themselves, which is where the magenta in their frame comes from. The
 *      columns keep that blend (fed by our own video texture); the plume drops it,
 *      because at 60k additive points a magenta term overwhelms the palette.
 *
 * NOT built yet, and deliberately not faked: the jellyfish (JellyShader.glsl,
 * which needs their whole fbr.vs/fbr.fs lighting chunk), the lens streak
 * (HydraLensStreakPass/CompositeStreak, a four-pass chain), and HomeBGShader's
 * backdrop plane. The first two are the comet and the drifting jellies in the
 * reference frames.
 */

// GLSL-style smoothstep, tolerating e0 > e1 the way the shaders rely on
const ss = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/* The plume's base distribution.
 *
 * Their own shader states the interesting bounds, which is why this is a seed and
 * not a guess: the fragment discards anything with `length(vPos.xz) < 2.5`, and
 * `funnel = smoothstep(8.0, 5.0, length(pos.xz))` only does work out to 8. So
 * there is a hole of radius 2.5 at the middle, and the ring from 2.5 to 8 is the
 * part that gets lofted — that ring is the plume, everything beyond it is
 * ambient drift.
 *
 * Rejection-sampled against a density ENVELOPE rather than filled uniformly.
 * That is the whole point of this function and the reason it looks the way it
 * does. Their positions come out of an Antimatter FBO simulation where particles
 * are advected and respawned, so the cloud has no boundary. A uniform cylinder
 * does, and it shows: seen from the side it reads on screen as a rectangle with
 * a flat ceiling and two vertical walls, which is exactly what a first pass at
 * this looked like. Tapering the density instead means the field has no edge to
 * see. Same rejection-sampling approach world.js uses for the coral clumps.
 *
 * sqrt on the radius is the standard fix for polar sampling: without it points
 * pile up at the inner edge, and the funnel term would then apply to most of the
 * cloud rather than to a core.
 */
/* R_OUT is a compromise between the two failure modes and was arrived at by
 * looking at both. At 9.5 -- the widest radius their funnel term does any work at
 * -- the volume's wall is inside frame and reads as a hard vertical edge. At 18
 * the edge is gone but the points spread over so much solid angle that the result
 * is an even starfield filling the frame, with the mark and the tails lost in it.
 * 12 with a steep envelope puts the density where their funnel is and leaves the
 * periphery sparse enough to read as void. */
const R_IN = 2.5, R_OUT = 12, Y_HALF = 12;
const WHITE = new THREE.Color(1, 1, 1);

function seedPlume(count, palette) {
  const position = new Float32Array(count * 3);
  const random = new Float32Array(count * 4);
  const pointColor = new Float32Array(count * 3);
  const c = new THREE.Color();
  let tries = 0;

  for (let i = 0; i < count;) {
    tries++;
    const r = Math.sqrt(R_IN * R_IN + Math.random() * (R_OUT * R_OUT - R_IN * R_IN));
    const y = (Math.random() * 2 - 1) * Y_HALF;
    // dense core, thinning to nothing well before either bound
    if (Math.random() > ss(R_OUT, R_IN + 1, r) * ss(Y_HALF, 3, Math.abs(y))) continue;

    const a = Math.random() * Math.PI * 2;
    position[i * 3] = Math.cos(a) * r;
    position[i * 3 + 1] = y;
    position[i * 3 + 2] = Math.sin(a) * r;

    /* random.x  sparkle phase and the pow(x,50) size lottery
     * random.y  the pow(y, mix(40,2,funnel)) loft exponent — this is the one that
     *           decides which points ride the plume, so it must be uniform
     * random.z  the pow(z,400) glint lottery
     * random.w  entrance offset and drift amplitude */
    for (let k = 0; k < 4; k++) random[i * 4 + k] = Math.random();

    /* Brightness falls off much harder than density does. Density alone is not
     * enough separation: a dim point still clears the bloom threshold once a few
     * of them stack additively, and that is what turned the periphery into an
     * even glow rather than void. */
    const core = ss(9, 3, r);
    c.copy(palette[(Math.random() * palette.length) | 0]);
    /* VALUE variety, not hue variety, and it is the fix for the flat green field.
     *
     * Their hero is full of near-white highlights and dark olive shadows, and both
     * come from things we do not have: the showreel bleeding through the grains and
     * a warm-white volumetric source. Picking uniformly across eight saturated
     * greens instead gives every grain the same hue at the same value, and the
     * result reads as one flat green wash however dense it is.
     *
     * So roughly one grain in six is pulled most of the way to white and given a
     * much higher floor. Those are the highlights. The hue is untouched -- this is
     * still the green scheme, it just has a top end. */
    const pale = Math.random() < 0.17;
    if (pale) c.lerp(WHITE, 0.5 + Math.random() * 0.4);
    /* A per-point brightness lottery on top of the radial falloff, and this is the
     * term that actually killed the flat green wash.
     *
     * Radial falloff alone still makes every grain in the core bright, and 30k
     * bright soft discs at 11-48px cover the frame twice over -- additively, so the
     * gaps fill in and the field reads as one continuous glow however the palette
     * is tuned. Their frame is just as dense but most of its grains are dark olive
     * with only a minority glowing, which is what leaves black between them.
     *
     * pow(random, 2.2) puts the bulk near the floor and a tail up at full
     * brightness. Density is unchanged; the haze is not. */
    const lottery = 0.18 + 0.82 * Math.pow(Math.random(), 2.2);
    c.multiplyScalar(((pale ? 0.5 : 0.12) + core * 0.95) * lottery);
    pointColor[i * 3] = c.r; pointColor[i * 3 + 1] = c.g; pointColor[i * 3 + 2] = c.b;
    i++;
  }
  return { position, random, pointColor, tries };
}

const COLUMN_VS = /* glsl */`
  uniform float uVisible;
  uniform float uOffset;
  uniform float uDirection;
  varying vec2 vUv;
  varying vec3 vPos;
  varying vec3 vWorldPos;
  varying float vTop;

  void main() {
    vUv = uv;
    vec3 pos = position;

    vTop = smoothstep(9.8, 9.8 - 2.0 * smoothstep(0.8, 1.0, uVisible), pos.y);

    pos.y -= pow((1.0 - uVisible), 1.15) * 20.0;

    float radius = mix(1.9, 4.0, smoothstep(10.0, -10.0, pos.y));
    pos.x += cos(-pos.y * 0.32 * uDirection + uOffset) * radius;
    pos.z += sin(-pos.y * 0.32 * uDirection + uOffset) * radius;

    pos.x += cos(-pos.y * 10.0 * uDirection) * 0.1 * pow((1.0 - uVisible), 1.25);
    pos.z += sin(-pos.y * 10.0 * uDirection) * 0.1 * pow((1.0 - uVisible), 1.25);

    vWorldPos = vec3(modelMatrix * vec4(pos, 1.0));
    vPos = pos;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const COLUMN_FS = /* glsl */`
  uniform sampler2D tMap;
  uniform sampler2D tVideo;
  uniform sampler2D tRefraction;
  uniform float uAlpha;
  uniform float uVisible;
  uniform float time;
  uniform vec2 resolution;
  varying vec2 vUv;
  varying vec3 vPos;
  varying vec3 vWorldPos;
  varying float vTop;

  ${RGB_SHIFT}
  ${BLEND_MODES}

  void main() {
    vec2 uv = vUv;
    vec2 screenuv = gl_FragCoord.xy / resolution;
    uv.y *= 1.2;
    uv.y += uVisible;

    vec2 texUV = uv;
    texUV.y += time * 0.1 - cameraPosition.y * 0.03;

    vec4 color = texture2D(tRefraction, screenuv);
    vec3 video = texture2D(tVideo, screenuv).rgb;

    float highlight = smoothstep(0.03, 0.0, abs(0.97 - uVisible)) * smoothstep(0.8, 1.0, vUv.y);

    color.rgb += getRGB(tMap, texUV, 0.2, 0.00001).rgb * 0.5;
    color.rgb = pow(color.rgb * mix(0.8, 1.5, highlight), vec3(1.2));
    color.rgb = blendSoftLight(color.rgb, video, 0.7);
    color.rgb += pow(highlight, 2.0) * 0.5 * video;
    color.rgb *= mix(1.0, 1.5, highlight);

    color.a = mix(vTop, 1.0, highlight * 0.3);
    color.rgb = pow(0.1 + color.rgb * mix(1.5, 2.5, highlight) * 1.5, vec3(1.5));

    color.a *= uAlpha;

    gl_FragColor = color;
  }
`;

const PLUME_VS = /* glsl */`
  attribute vec4 random;
  attribute vec3 pointColor;

  uniform float DPR;
  uniform float time;
  uniform float uScroll;
  uniform float uVisible;
  uniform float uSizeBias;
  uniform float uMaxSize;
  uniform vec3 uLogoPos;
  uniform float uAttract;
  uniform float uShock;

  varying vec3 vLightColor;
  varying vec3 vPos;
  varying vec4 vRandom;
  varying float vScale;
  varying float vRipple;
  varying float vRippleDist;
  varying vec3 vWorldPos;

  ${NOISE}

  void main() {
    /* AT: vec3 pos = texture2D(tPos, position.xy).xyz -- their Antimatter FBO.
     * Substituted: the attribute already IS the seeded base position. */
    vec3 pos = position;

    float funnel = smoothstep(8.0, 5.0, length(pos.xz));
    float scrollMove = smoothstep(0.9, 0.0, uScroll) * mix(2.0, mix(27.0, -10.0, (1.0 - uVisible)), pow(random.y, mix(40.0, 2.0, funnel)));

    pos.y += (1.0 - uVisible) * 10.0 * random.w;
    pos.y += scrollMove;
    pos.y += sin(time + random.x * 20.0) * 0.5 * pow(random.w, 30.0);
    pos.y -= smoothstep(0.8, 1.0, uScroll) * 2.0 * pow(funnel, 5.0);

    pos.x += cos(scrollMove * 0.4) * 1.0;
    pos.z += sin(scrollMove * 0.4) * 1.0;

    vec3 worldPos = vec3(modelMatrix * vec4(pos, 1.0));
    vWorldPos = worldPos;

    pos.x += cos(uLogoPos.y * 0.1 + time * 0.1) * smoothstep(5.0, 3.0, length(worldPos - uLogoPos)) * 4.0 * random.w;
    pos.z += sin(uLogoPos.y * 0.1 + time * 0.1) * smoothstep(5.0, 3.0, length(worldPos - uLogoPos)) * 4.0 * random.w;

    /* ---- intro: gravity, then shockwave.
     *
     * Applied to pos after their own displacements so their drift still reads
     * underneath it, and computed from the ORIGINAL world position so the pull
     * direction does not chase itself frame to frame.
     *
     * The attraction is deliberately not uniform: grains further out move a larger
     * fraction of the way in, which is what makes the field collapse rather than
     * merely shrink, and it leaves the near ones to hold the centre's density. */
    vec3 toLogo = uLogoPos - worldPos;
    float toLogoLen = max(0.001, length(toLogo));
    float pull = uAttract * min(toLogoLen * 0.75, 14.0);
    /* Never pull a grain past their own discard hole.
     *
     * Their fragment drops anything with length(vPos.xz) < 2.5, which is what keeps
     * the middle of frame clear for the mark. An unclamped attractor walks the whole
     * field straight into that radius, and at full compression every grain is
     * discarded at once -- the field does not converge, it vanishes. Capping the pull
     * short of it means compression genuinely piles grains up against the hole. */
    pull = min(pull, max(0.0, toLogoLen - 3.4));
    pos += (toLogo / toLogoLen) * pull;

    /* The shell. Grains within it are pushed radially outward, hardest at the
     * leading edge -- so the wave passes through the field as a moving band rather
     * than displacing everything at once.
     *
     * WRITTEN OUT RATHER THAN smoothstep(uShock, uShock * 0.55, toLogoLen), which is
     * what this was and which was the cause of every black frame in this project.
     *
     * uShock rests at 0 whenever there is no burst -- all of the About section, and
     * phases 1 to 3 of the intro. At 0 both smoothstep edges are 0, so it evaluates
     * (x - 0) / (0 - 0): a division by zero, giving NaN. Multiplying by step(0.01,
     * uShock) does NOT rescue that, because NaN * 0 is NaN, not 0. The NaN reached
     * gl_PointSize and the fragment colour, UnrealBloomPass blurred it across the
     * whole buffer, and the entire frame came back black -- which is exactly what it
     * looked like: the scene rendered fine with bloom disabled, no single object was
     * at fault, and it only showed in sections where uShock happened to be 0.
     *
     * The guard is the branch, not the arithmetic: nothing here may divide by a
     * value that can be zero. */
    float shellHit = 0.0;
    if (uShock > 0.01) {
      float k = clamp((uShock - toLogoLen) / (uShock * 0.45), 0.0, 1.0);
      shellHit = k * k * (3.0 - 2.0 * k);
    }
    pos -= (toLogo / toLogoLen) * shellHit * uShock * 0.55;

    float dist = length(worldPos - cameraPosition);

    /* The burst. A travelling sine in distance-from-the-mark, raised to a power
     * between 100 and 200 so only a thin shell of it survives -- that shell is
     * the expanding ring, and it lifts, brightens and enlarges the points it
     * passes through. All four constants are theirs. */
    vec3 ripplePos = vWorldPos;
    ripplePos += cnoise(ripplePos * 0.15 + time * 0.1) * 1.5;
    float rippleDist = length(ripplePos - uLogoPos);
    vRippleDist = rippleDist;
    /* clamp() before the pow, and it is the whole reason this scene stayed on screen.
     *
     * Their line is 0.5 + sin(...) * 0.5, which is [0,1] in exact arithmetic. It is
     * not in practice: sin() of a large argument goes through range reduction, and
     * drivers return values a hair outside [-1,1] once the argument is big enough. A
     * ripple of -5e-8 then hits pow(), and pow() of a negative base is UNDEFINED in
     * GLSL -- it returns garbage or NaN. With an exponent of 100 to 200 there is no
     * recovering from it.
     *
     * That NaN propagated to gl_PointSize and to the fragment colour, and because
     * additive blending computes src * srcAlpha + dst, it poisoned the destination
     * even at zero alpha. UnrealBloomPass then blurred it across the entire buffer
     * and the whole frame went black.
     *
     * It is TIME-DEPENDENT, which is what made it so hard to see: sin's argument here
     * is -time * 0.8, so the frame renders correctly for the first minute or so and
     * then goes black. Every "this section is broken" and "this intro phase is broken"
     * conclusion earlier was really just "I screenshotted that one later".
     *
     * Third instance of this exact bug in this project -- the flower cloud's sparkle
     * and this shader's own sparkle term were the first two. Any pow() whose base
     * comes from a trig function needs the clamp. */
    float ripple = clamp(0.5 + sin(-time * 0.8 + rippleDist * 0.2 - 1.0) * 0.5, 0.0, 1.0);
    ripple = pow(ripple, mix(100.0, 200.0, smoothstep(5.0, 25.0, rippleDist)));
    ripple *= smoothstep(25.0, 15.0, rippleDist);
    ripple = pow(ripple, 2.0);
    vRipple = ripple;
    pos.y += ripple * 0.2 * pow(random.w, 4.0);

    // AT: vLightColor = texture2D(tPointColor, position.xy).rgb * 1.4
    vLightColor = pointColor * 1.4;

    vPos = pos;
    vRandom = random;

    vScale = smoothstep(8.0, 15.0, dist);
    vScale *= 1.0 + (0.5 + sin(time * 5.0 + vRandom.x * 20.0) * 0.5) * 0.2;
    vScale += 1.0 * ripple;
    vScale *= mix(1.0, 3.0, pow(random.x, 50.0));
    vScale *= smoothstep(4.0, 5.0, rippleDist);

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    /* Their point-size expression, verbatim, under a hard ceiling.
     *
     * The 1000.0/dist term is calibrated for their world scale. It is right here
     * -- their camera block puts the eye 30-45 units out and this section uses
     * those numbers unchanged -- but the pow(random.x, 50.0) lottery multiplies a
     * few points by 3 and the ripple adds another 1.0 on top, so the tail of the
     * distribution reaches sizes that stall the GPU at this count. Clamping the
     * tail is what the flower cloud needed for the same reason. */
    gl_PointSize = min(uMaxSize, 0.06 * DPR * 2.0 * vScale * (1000.0 / length(mvPosition.xyz)) * uSizeBias);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const PLUME_FS = /* glsl */`
  uniform sampler2D tMap;
  uniform float time;
  uniform float uAlpha;

  varying vec3 vLightColor;
  varying vec3 vPos;
  varying vec4 vRandom;
  varying float vScale;
  varying float vRipple;
  varying float vRippleDist;
  varying vec3 vWorldPos;

  ${NOISE}
  ${COLOR_UTILS}
  ${BLEND_MODES}
  ${TRANSFORM_UV}

  void main() {
    vec2 uv = vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y);
    if (length(uv - 0.5) > 0.5) discard;
    if (vScale < 0.1) discard;
    // their own guard: nothing inside the 2.5 radius, which keeps the mark clear
    if (length(vPos.xz) < 2.5) discard;

    vec3 color = vLightColor;
    color *= 1.0 + vRipple * 0.1;

    /* max(0.0, ...) is a guard, not a change of theirs. Their expression reaches
     * -0.6, which is harmless where it lands but not once a pow() sees it: pow of
     * a negative channel is undefined in GLSL and returns garbage. That is
     * exactly the bug that produced purple flecks in the flower cloud. */
    vec3 sparkle = vec3(max(0.0, 0.4 + sin(time * 3.0 + vRandom.y * 20.0)));
    color += sparkle * pow(vRandom.z, 400.0) * vRipple * 0.5;

    float noise = cnoise(vWorldPos * 0.05 - time * 0.2 + length(vWorldPos) * 0.05);

    color = rgb2hsv(max(color, vec3(0.0)));
    color.x += vRipple * 0.05 * vRandom.y - noise * 0.05;
    color.y *= 1.2;
    color.z *= 1.0 + noise * 0.2;
    color = hsv2rgb(color);
    /* max() after the HSV round trip, and it is load-bearing, not tidiness.
     *
     * The 1.2 on saturation pushes it past 1, and hsv2rgb's final
     * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y) EXTRAPOLATES for c.y > 1 --
     * mix does not clamp its interpolant -- so channels near the clamp's floor
     * come out NEGATIVE. blendSoftLight below then computes sqrt(base) on them,
     * and sqrt of a negative is NaN. In the composer's half-float targets that
     * NaN survives, additive blending spreads it (NaN times 0 is still NaN, so
     * even zero-alpha fragments poison the buffer), and UnrealBloom's blur turns
     * one bad pixel into a fully black frame.
     *
     * Found by staged bisection: constant-color fragment rendered fine, so the
     * poison had to be in this stage's math; this is the only term that can go
     * non-finite. Fourth NaN bug in this project, second distinct mechanism. */
    color = max(color, vec3(0.0));

    // Bubble Texture -- their comment, their rotating matcap lookup
    vec2 matcapUV = rotateUV(uv, sin(time * 1.0 + vRandom.z * 20.0) * 0.5 + 1.0);
    vec3 matcap = texture2D(tMap, matcapUV).rgb * 2.0;
    color = blendSoftLight(color, matcap, 0.4);

    /* CRISP disc, near their original. Theirs is a discard outside r 0.5 and
     * opaque inside -- a hard-edged circle, and that hardness is most of why their
     * field reads as sharp, professional particles. An earlier version here used a
     * wide falloff (0.5 -> 0.15) to tame additive overdraw, and that was the wrong
     * trade: it turned every grain into a defocused blob and the whole field read
     * as blur. The rim is one narrow anti-aliased band now; overdraw is paid for
     * with SIZE and ALPHA (see uSizeBias / uAlpha), not with edge softness. */
    float a = smoothstep(0.5, 0.44, length(uv - 0.5));
    gl_FragColor = vec4(color, a * uAlpha);
  }
`;

/**
 * @param shared  the shared uniform bag from main.js (uTime, uDPR, uResolution)
 * @param opts.refraction   scene snapshot texture, bound as tRefraction
 * @param opts.map          tiling texture for the columns (their tMap)
 * @param opts.video        their tVideo
 * @param opts.matcap       the plume's bubble matcap (their tMap)
 * @param opts.palette      THREE.Color[] the plume samples its point colours from
 */
export function buildHome(shared, opts = {}) {
  const group = new THREE.Group();

  /* ---- the two crossing tails ------------------------------------------- *
   * A 20-unit cylinder is the right host geometry because every number in
   * their vertex shader is expressed in the -10..10 range: the radius flare
   * reads `smoothstep(10.0, -10.0, pos.y)` and the top fade reads
   * `smoothstep(9.8, ...)`. 240 height segments so the helix stays smooth out
   * at the wide end -- at radius 4 a coarser tube visibly facets. */
  const radius = opts.columnRadius ?? 0.18;
  const columnGeo = new THREE.CylinderGeometry(radius, radius, 20, 16, 240, true);

  const columns = [-1, 1].map(dir => {
    const material = new THREE.ShaderMaterial({
      vertexShader: COLUMN_VS,
      fragmentShader: COLUMN_FS,
      uniforms: {
        tMap: { value: opts.map ?? null },
        tVideo: { value: opts.video ?? null },
        tRefraction: { value: opts.refraction ?? null },
        uAlpha: { value: 1 },
        uVisible: { value: 0 },
        /* Both columns share one uOffset on purpose. With opposite uDirection
         * and the same phase the two helices coincide at pos.y 0 and diverge
         * either side of it, which is what makes them cross -- give them
         * different offsets and they become two unrelated spirals. */
        uOffset: { value: opts.columnOffset ?? 0 },
        uDirection: { value: dir },
        time: shared.uTime,
        resolution: shared.uResolution,
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,   // open-ended tube, so the far wall must draw
    });
    const mesh = new THREE.Mesh(columnGeo, material);
    mesh.frustumCulled = false;   // the vertex shader moves it far outside its bounds
    group.add(mesh);
    return mesh;
  });

  /* ---- the plume -------------------------------------------------------- */
  const count = opts.plumeCount ?? 60000;
  const palette = opts.palette ?? [new THREE.Color('#7dd63a')];
  const seed = seedPlume(count, palette);
  const plumeGeo = new THREE.BufferGeometry();
  plumeGeo.setAttribute('position', new THREE.BufferAttribute(seed.position, 3));
  plumeGeo.setAttribute('random', new THREE.BufferAttribute(seed.random, 4));
  plumeGeo.setAttribute('pointColor', new THREE.BufferAttribute(seed.pointColor, 3));

  const plumeMat = new THREE.ShaderMaterial({
    vertexShader: PLUME_VS,
    fragmentShader: PLUME_FS,
    uniforms: {
      tMap: { value: opts.matcap ?? null },
      DPR: shared.uDPR,
      time: shared.uTime,
      uScroll: { value: 0 },
      uVisible: { value: 0 },
      uAlpha: { value: opts.plumeAlpha ?? 0.62 },
      /* Their hero's grains are not specks. The reference frame is full of large
       * soft discs -- 30 to 50px, with visible internal shading from the matcap --
       * mixed with much finer ones, which is what gives it the drifting-petals
       * read rather than a starfield. Two numbers control that here:
       *
       *   uSizeBias  scales their whole size expression. At 0.55 the typical grain
       *              landed near 4px, too small for the matcap to show at all, so
       *              every point was a flat dot.
       *   uMaxSize   only clips the tail. Their pow(random.x, 50.0) lottery times
       *              3 plus the ripple's +1 puts a handful of points far above the
       *              rest, and it is that handful that reads as the big leaves --
       *              so the ceiling has to be well clear of the typical size, not
       *              near it.
       *
       * At bias 1.5 and 30 units out the typical grain is ~11px and the lottery
       * winners reach the 48px ceiling. Count comes down to compensate: bigger
       * points at the same count is the additive overdraw that stalled the flower
       * cloud. */
      /* 0.9 / 26, down from 1.5 / 48. The big-bokeh reading came at the price of
       * the whole field looking defocused -- the reference's grains are mostly
       * TINY sharp specks with a sparse mid tier, and the pow(random.x, 50.0)
       * lottery still supplies the occasional large bubble at the lower ceiling.
       * Smaller typical size also halves the additive overdraw, which is what
       * pays for the crisp edge in the fragment below. */
      uSizeBias: { value: opts.plumeSizeBias ?? 0.9 },
      uMaxSize: { value: opts.plumeMaxSize ?? 26 },
      uLogoPos: { value: new THREE.Vector3() },
      /* Intro drives, not Active Theory's. Their plume drifts at a constant rate
       * because their hero has no scripted intro -- it is a steady state you scroll
       * through. These two add the story the brief asks for: uAttract pulls the
       * field toward the mark through the gathering and compression phases, uShock is
       * the radius of an expanding shell that throws it back out at the burst. */
      uAttract: { value: 0 },
      uShock: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const plume = new THREE.Points(plumeGeo, plumeMat);
  plume.frustumCulled = false;
  group.add(plume);

  return {
    group, columns, plume,
    columnUniforms: columns.map(c => c.material.uniforms),
    plumeUniforms: plumeMat.uniforms,

    /**
     * One update per frame, transcribed from their `Home` class render tick.
     *
     * @param progress  Home's local scroll progress, 0..1
     * @param visible   their visibleV — the entrance ramp, NOT scroll (see main.js)
     * @param logoPos   world position of the glass mark, which main.js owns
     * @param logoRotY  its Y rotation, which the tails copy
     */
    update(progress, visible, logoPos, logoRotY) {
      /* column.position.y = logo.position.y - 10 puts the TOP of a 20-unit
       * column exactly at the mark, so the tails hang from it. Their vTop term
       * then fades the last 2 units out, which is why there is no visible join. */
      for (const c of columns) {
        c.position.set(logoPos.x, logoPos.y - 10, logoPos.z);
        c.rotation.y = logoRotY;
        c.material.uniforms.uVisible.value = Math.min(1, Math.max(0, (visible - 0.5) / 0.5));
      }

      const pu = plumeMat.uniforms;
      pu.uScroll.value = progress;
      // AT: uVisible = Math.smoothStep(0, 0.92, visibleV)
      const v = Math.min(1, Math.max(0, visible / 0.92));
      pu.uVisible.value = v * v * (3 - 2 * v);
      // AT: uLogoPos = logo.position, then x += 1 and z += 2 -- the plume is
      // attracted to a point offset from the mark, so the swirl is not symmetric
      pu.uLogoPos.value.set(logoPos.x + 1, logoPos.y, logoPos.z + 2);
    },

    stats: {
      plume: count, seedTries: seed.tries,
      columnTris: columnGeo.index ? columnGeo.index.count / 3 : 0,
    },
  };
}
