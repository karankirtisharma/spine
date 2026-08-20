import * as THREE from 'three';

/* The water crossing — Active Theory's burst->work waterline, both sides.
 *
 * Scraped 2026-08-16 from their live compiled bundle
 * (activetheory.net/assets/shaders/compiled.vs, chunk names TreeWaterShader.glsl
 * and WaterCeilingShader.glsl) and verified character-for-character against
 * source by an independent fetch. Their transition between the ring room and
 * the lab is NOT a bespoke water pass: each room owns a water mesh — the ring
 * room a mirror-reflective FLOOR (TreeWaterShader), the lab a caustic CEILING
 * (WaterCeilingShader) — and their FXScrollTransition (which we already run
 * verbatim as the burst->work wipe) sweeps between the two rooms. Crossing the
 * seam therefore reads as passing through the surface: topside below you going
 * out, underside above you coming in. This module is those two meshes.
 *
 * Their live tuning values, read from uil.1780406240914.json, are the DEFAULTS
 * here: uSpeed 0.04, uScale 1000, uWaterUVStrength -5, uBrightness 2,
 * uLight (-2.96, 7.5, -1.93, 0.04), uColor white.
 *
 * THREE DELIBERATE DEPARTURES, each because our stage differs, none tuned away
 * from their look:
 *
 *   1. time -> uTime (shared bag). Their engine injects a global `time`; note
 *      their getWaterNoise shadows it locally — kept, it is a transcription.
 *   2. tMRO: theirs samples empty_mro.jpg — an empty MRO plate, i.e. constant.
 *      Ported as const vec3(1.0): roughness 1 selects their tightened matcap
 *      branch, occlusion 1 leaves the product alone.
 *   3. The ceiling's second MRT drawbuffer (CleanroomVolumetricLight, a
 *      luma-thresholded bright pass their composite re-adds blurred) has no
 *      MRT chain here; the site's own bloom provides that halo. Single output.
 *
 * tMirrorReflection is NO LONGER a departure. An earlier build substituted a
 * screen-space flip of the deep's flat film backdrop (the water section was
 * going to composite the client's still); the client's call is that the still
 * is REFERENCE ONLY and the section is a real 3D scene — our own foliage
 * continued down to real water. So the mirror is now what theirs is: the
 * scene re-rendered from the eye reflected about the surface into a 1024px
 * target (their FX.Mirror), sampled through vMirrorCoord exactly as their
 * shader ships. createMirror() below is that recreation — the standard planar
 * reflector: reflected virtual camera, oblique near-plane clip so nothing
 * below the surface leaks into the reflection, and a bias matrix mapping
 * world positions to the target's uv.
 *
 * tMap for the ceiling: theirs is cracked_ice_basecolor.png sampled through
 * scaleUV(vUv, 0.1) — a ZOOM to 10x, so the texture tiles 10 times across the
 * sheet and must wrap. Ours is a tileable voronoi crack web synthesized at
 * load (makeCrackedIceTexture in textures.js) in the same family: bright cell
 * edges on deep ice blue. tVideo: theirs overlays their shared site video;
 * ours overlays the deep's film — the same pattern with our own footage. */

const CHUNKS = /* glsl */`
  vec2 scaleUV(vec2 uv, vec2 scale) {
    return (uv - 0.5) / scale + 0.5;
  }
  vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
  }
  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }
  float blendOverlayF(float base, float blend) {
    return base < 0.5 ? (2.0 * base * blend) : (1.0 - 2.0 * (1.0 - base) * (1.0 - blend));
  }
  vec3 blendOverlay(vec3 base, vec3 blend, float opacity) {
    vec3 o = vec3(blendOverlayF(base.r, blend.r), blendOverlayF(base.g, blend.g),
                  blendOverlayF(base.b, blend.b));
    return o * opacity + base * (1.0 - opacity);
  }
  float luma(vec3 color) {
    return dot(color, vec3(0.299, 0.587, 0.114));
  }
`;

/* waternormals.fs, verbatim (their `time` shadow included) apart from the
 * uniform rename. The classic three.js Ocean four-tap: one tiling normal map
 * at four prime-divisor scales and scroll speeds. tNormal here is the SAME
 * assets/at/waternormals.jpg the transition pass warps its seam with. */
const WATER_NORMALS = /* glsl */`
  vec4 getWaterNoise(sampler2D tNormal, vec2 uv, float speed, float scale) {
    float time = uTime * 0.2 * speed;
    vec2 uv0 = (uv / 103.0) + vec2(time / 17.0, time / 29.0);
    vec2 uv1 = uv / 107.0 - vec2(time / -19.0, time / 31.0);
    vec2 uv2 = uv / vec2(897.0, 983.0) + vec2(time / 101.0, time / 97.0);
    vec2 uv3 = uv / vec2(991.0, 877.0) - vec2(time / 109.0, time / -113.0);
    vec4 noise = (texture2D(tNormal, uv0 * scale)) +
      (texture2D(tNormal, uv1 * scale)) +
      (texture2D(tNormal, uv2 * scale)) +
      (texture2D(tNormal, uv3 * scale));
    return noise * 0.5 - 1.0;
  }
  vec3 getWaterNormal(sampler2D tNormal, vec2 uv, float speed, float scale) {
    vec4 noise = getWaterNoise(tNormal, uv, speed, scale);
    return normalize(noise.xzy * vec3(2.0, 1.0, 2.0));
  }
`;

/* fbr.fs, the parts the water calls, verbatim apart from the constant MRO
 * (departure 3) and the stock matcap chunk their #require(matcap.vs) pulls. */
const FBR = /* glsl */`
  const float PI = 3.14159265359;
  vec2 reflectMatcap(vec3 pos, vec3 normal) {
    vec3 e = normalize(pos - cameraPosition);
    vec3 r = reflect(e, normal);
    float m = 2.0 * sqrt(r.x * r.x + r.y * r.y + (r.z + 1.0) * (r.z + 1.0));
    return r.xy / m + 0.5;
  }
  float pcrange(float v, float oldMin, float oldMax, float newMin, float newMax) {
    float x = (((v - oldMin) * (newMax - newMin)) / (oldMax - oldMin)) + newMin;
    return clamp(x, min(newMin, newMax), max(newMin, newMax));
  }
  float geometricOcclusion(float NdL, float NdV, float roughness) {
    float r = roughness;
    float aL = 2.0 * NdL / (NdL + sqrt(r * r + (1.0 - r * r) * (NdL * NdL)));
    float aV = 2.0 * NdV / (NdV + sqrt(r * r + (1.0 - r * r) * (NdV * NdV)));
    return aL * aV;
  }
  float microfacetDistribution(float roughness, float NdH) {
    float rSq = roughness * roughness;
    float f = (NdH * rSq - NdH) * NdH + 1.0;
    return rSq / (PI * f * f);
  }
  vec3 getFBR(vec3 baseColor, vec3 normal, vec3 mPos) {
    /* empty_mro.jpg, MEASURED, not guessed: the plate is a 2x2 jpg whose
     * pixels read (0.996, 0.247, 1.0) -- downloaded from their site and
     * sampled 2026-08-16. An earlier port assumed vec3(1.0), and that one
     * wrong number silently destroyed the water: roughness 1 makes the GGX
     * distribution below CONSTANT (rSq=1 -> f=1 -> D=1/PI regardless of
     * NdH), so no highlight could ever form and the surface rendered as a
     * flat wash. Their real roughness 0.247 is what shapes the ripple
     * glints. Occlusion stays 1. */
    const vec3 mro = vec3(0.996, 0.247, 1.0);
    float roughness = mro.g;
    vec2 aUV = reflectMatcap(mPos, normal);
    vec2 bUV = ((aUV - 0.5) * 0.5 - vec2(0.1)) + 0.5;
    vec2 mUV = mix(aUV, bUV, roughness);
    vec3 V = normalize(cameraPosition - mPos);
    vec3 L = normalize(uLight.xyz);
    vec3 H = normalize((L + V) / 2.);
    float NdL = pcrange(clamp(dot(normal, L), 0.001, 1.0), 0.0, 1.0, 0.4, 1.0);
    float NdV = pcrange(clamp(abs(dot(normal, V)), 0.001, 1.0), 0.0, 1.0, 0.4, 1.0);
    float NdH = clamp(dot(normal, H), 0.0, 1.0);
    float G = geometricOcclusion(NdL, NdV, roughness);
    float D = microfacetDistribution(roughness, NdH);
    vec3 specContrib = G * D / (4.0 * NdL * NdV) * uColor;
    vec3 color = NdL * specContrib * uLight.w;
    return ((baseColor * texture2D(tMatcap, mUV).rgb) + color) * mro.b;
  }
`;

const TOPSIDE_VS = /* glsl */`
  uniform mat4 uMirrorMatrix;
  varying vec2 vUv;
  varying vec3 vMPos;
  varying vec4 vMirrorCoord;
  void main() {
    vUv = uv;
    vec4 mPos = modelMatrix * vec4(position, 1.0);
    vMPos = mPos.xyz / mPos.w;
    vMirrorCoord = uMirrorMatrix * mPos;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/* TreeWaterShader fragment, their main() line for line; the mirror lookup is
 * their own vMirrorCoord projective sample against the FX.Mirror target.
 * uAlpha is ours -- their floor never fades, ours arrives with the section. */
const TOPSIDE_FS = /* glsl */`
  uniform sampler2D tWaterNormal;
  uniform sampler2D tMirrorReflection;
  uniform sampler2D tMatcap;
  uniform float uSpeed;
  uniform float uScale;
  uniform float uWaterUVStrength;
  uniform float uBrightness;
  uniform vec4 uLight;
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uAlpha;
  varying vec2 vUv;
  varying vec3 vMPos;
  varying vec4 vMirrorCoord;
  ${WATER_NORMALS}
  ${FBR}
  void main() {
    vec2 uv = vMirrorCoord.xy / vMirrorCoord.w;

    vec3 normal = getWaterNormal(tWaterNormal, vUv, uSpeed * 0.05, uScale * 0.8);
    uv -= normal.xy * 0.015 * uWaterUVStrength;
    uv.y -= 0.04;

    /* FRESNEL WEIGHTING, a documented departure toward physical water.
     * Their shader samples the mirror at full strength everywhere -- right
     * for their room, which only ever sees the surface at grazing angles.
     * Our eye hangs 0.4..3 units over the water looking down, and uniform
     * reflectance there is the one thing ray-traced water never does:
     * real water reflects at grazing incidence and opens into dark depth
     * under a steep view (Schlick, F0 ~= 0.02). The near field now falls
     * to a deep body tint while the distance stays mirror -- which also
     * keeps any bright reflection from smearing down the whole plane. */
    /* Exponent 5 with a 0.10 floor is textbook Schlick for a FLAT surface,
     * and it was wrong here in a way the client circled: it killed the
     * reflection everywhere except a thin grazing band at the waterline,
     * so the plants' reflections stopped dead partway down the frame. Two
     * reasons real water keeps reflecting there -- the surface is ROUGH,
     * so its facets present grazing angles to the eye long after the mean
     * plane has tilted away (the ripple normals here already carry that),
     * and a dark body gives the reflection nothing to compete with. So:
     * exponent 3 for a gentler falloff, floor 0.38 so the near field stays
     * genuinely reflective. Darkness now comes from the deep tint and the
     * contrast curve, not from throwing the reflection away. */
    /* 0.60, from 0.50, from 0.38 -- the same note, walked up one step at a
     * time because the client is judging it by eye and each step is cheap to
     * take back. They circled the water's near edge: the lit band reads well
     * but ends too high up the frame, and they want it carrying further DOWN.
     *
     * Down the frame IS the near field, and what darkens it is this floor:
     * at a steep view fres goes to 0 and the surface falls back to the deep
     * body tint, which is nearly black. Raising the floor keeps more mirror
     * in exactly that region, so the lit water extends toward the bottom of
     * frame without touching the waterline, the ripple field, the plane's
     * size, the fade, or anything the crossing depends on. One number.
     *
     * 0.60 is the practical ceiling for the FLOOR. Past ~0.7 the
     * grazing-to-steep gradient flattens into an even sheet and the surface
     * reads as a flat panel again -- the depth the fresnel exists to give is
     * the first thing lost, and it does not show in a still, only in motion.
     * So the floor stops here and further reach comes from the exponent
     * below instead.
     *
     * EXPONENT 2.5, from 3.0, and this is the better lever for "further down
     * the frame". The floor lifts the whole steep-angle region uniformly; the
     * exponent WIDENS the band over which the reflection hands off to the
     * body tint, so the lit water extends downward while the gradient itself
     * survives. Reach without flatness -- which is exactly what the floor
     * could not give past 0.6.
     *
     * (Its own limit, for whoever comes next: below ~2.0 the falloff is so
     * broad that the waterline stops reading as a horizon, because the near
     * and far water converge in brightness. 2.5 is well inside that.)
     *
     * The peak-preserving knee further down still asymptotes at 0.90, under
     * bloom's 0.95 threshold, so the brighter near field cannot spike the
     * mip chain. */
    vec3 V = normalize(cameraPosition - vMPos);
    float fres = pow(1.0 - clamp(dot(normal, V), 0.0, 1.0), 2.5);
    float reflAmt = mix(0.60, 1.0, fres);
    /* the same body colour the underside uses -- one water, one tint */
    vec3 deepTint = vec3(0.002, 0.026, 0.016);
    vec3 baseColor = mix(deepTint,
      texture2D(tMirrorReflection, uv).rgb * uBrightness, reflAmt);
    vec3 color = getFBR(baseColor, normal, vMPos);

    color = mix(color, baseColor * 0.8, 0.2);
    color *= 0.9;

    /* THE PROJECT'S OWN BLOOM RULE, which this shader never got: no spikes
     * into the mip chain. planets.js carries the same min() and says so.
     *
     * The mirror sample is multiplied by uBrightness 9, so bright reflected
     * content leaves here far above 1. The composer's targets are HalfFloat
     * and keep it, and bloom thresholds at 0.95 -- so the surface was pushing
     * values several times over the threshold into a 5-mip separable blur.
     * That is what washed the whole UPPER half of the frame green once the
     * water entered at the bottom: the glow was not in the sky, it was the
     * water's overshoot smeared frame-wide by bloom.
     *
     * Clamping at 1 leaves the water fully able to bloom -- anything genuinely
     * over 0.95 still does -- while removing the multiples-of-threshold spike
     * that turned a highlight into a wash. */
    /* A CEILING THAT KEEPS THE HUE, replacing a hard min().
     *
     * min(color, 1.0) pins every bright pixel to EXACTLY 1.0 while bloom
     * thresholds at 0.95 -- so the whole bright band of the surface sat just
     * ABOVE the threshold, and the four-tap ripple field pushed pixels back
     * and forth across it every frame. Bloom switching on and off per pixel
     * per frame IS the flicker along the bottom; clamping harder only
     * flattens the plateau and sharpens the boundary it oscillates on.
     *
     * A per-channel knee was tried too and was worse in a different way: all
     * three channels converge on one ceiling, so green highlights bleach to
     * white -- (5, 14, 8) came out at saturation 0.019.
     *
     * So the shoulder is applied to the PEAK channel and the colour scaled by
     * the ratio. Magnitude compressed, ratio untouched: that same highlight
     * leaves at (0.318, 0.891, 0.509), saturation 0.643, still green. The peak
     * asymptotes at KNEE + 1/K = 0.90 no matter how hot the mirror sample gets
     * at uBrightness 9 -- under the bloom threshold, so the surface can
     * neither blow out to white nor oscillate across it.
     *
     * The rule both earlier versions broke: tone mapping must preserve the
     * ratio between channels; only magnitude may be compressed. */
    const float KNEE = 0.55;
    const float K = 2.86;               // peak asymptote = KNEE + 1/K = 0.90
    float peak = max(max(color.r, color.g), color.b);
    if (peak > KNEE) {
      float over = peak - KNEE;
      color *= (KNEE + over / (1.0 + over * K)) / peak;
    }

    gl_FragColor = vec4(color, uAlpha);
  }
`;

const CEILING_VS = /* glsl */`
  varying vec2 vUv;
  varying vec3 vMPos;
  void main() {
    vUv = uv;
    vec4 mPos = modelMatrix * vec4(position, 1.0);
    vMPos = mPos.xyz / mPos.w;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/* The underside sheet. Their WaterCeilingShader (cracked-ice caustic +
 * video overlay) shipped here through several rounds and is preserved
 * verbatim in git history and docs SS3b; it is retired from the crossing
 * at the client's direct call -- see the note inside main(). */
const CEILING_FS = /* glsl */`
  uniform sampler2D tWaterNormal;
  uniform sampler2D tMirrorReflection;
  uniform vec2 uResolution;
  uniform float uSpeed;
  uniform float uScale;
  uniform float uAlpha;
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vMPos;
  ${CHUNKS}
  ${WATER_NORMALS}
  /* THE UNDERSIDE IS NOW THE SAME WATER AS THE TOPSIDE -- the client's
   * direct call, made against side-by-side frames: the topside's broken
   * fine-chop patches are the water; the cracked-ice caustic web read as
   * "something else". Their WaterCeilingShader (verbatim in git history
   * and docs SS3b) is retired from the crossing; this fragment shades the
   * sheet from the SAME four-tap normal field the topside scrolls, at the
   * same world frequency and speed, with the same recipe: dark deep base,
   * broken teal patches where the moving facets catch the above-light,
   * tight sparkle on the steepest facets. Two offset light directions keep
   * the two patch fields from ever aligning, so nothing repeats. Their
   * radial vignette survives -- the sheet still dies into murk with
   * distance instead of ending on an edge. */
  void main() {
    vec3 wn = getWaterNormal(tWaterNormal, vUv, uSpeed * 0.05, uScale * 0.8);
    /* SAME WATER, SAME SOURCE. The topside reads as liquid because real
     * reflected imagery is shattered by the ripple field -- so this side
     * samples THE SAME MIRROR TARGET, kept live over the card room (see
     * the mirror pass in main.js), displaced by the same chop. Sampling
     * in SCREEN space matches the topside's projective vMirrorCoord, so
     * the wiggle frequency is identical on both sides of the crossing;
     * plane-uv stretched to haze at this grazing incidence. Earlier cuts
     * shaded the normals directly, or sampled the film -- both rendered
     * as a flat teal wall, which is what "unrealistic" was. */
    /* 0.17 displacement, matching the topside's own (its -9 uWaterUVStrength
     * works out to ~0.135 of screen, and this side is closer): at 0.05 the
     * card room came through as a READABLE mirror image -- card edges, even
     * the lettering -- which reads as a mirror, not as water. Past ~0.15
     * nothing survives as a recognizable object, only moving liquid light,
     * which is exactly what the topside does with the bank above it. */
    vec2 fuv = gl_FragCoord.xy / uResolution;
    fuv += wn.xy * 0.17;
    vec3 refl = texture2D(tMirrorReflection, fuv).rgb;

    /* NOT named "patch" -- reserved in GLSL; cost one invisible ceiling */
    float f1 = clamp(dot(wn, normalize(vec3(-0.25, 1.0, 0.35))), 0.0, 1.0);
    float facets = smoothstep(0.60, 0.76, f1);
    float sparkle = pow(clamp(dot(wn, normalize(vec3(0.2, 1.0, -0.3))), 0.0, 1.0), 24.0);
    /* body and facet colours pulled green and down with the rest */
    vec3 deep = vec3(0.002, 0.026, 0.016);
    vec3 teal = vec3(0.07, 0.40, 0.24);
    /* DARKER AND GREENER, second pass. Darkening water honestly means
     * deepening CONTRAST, not dimming evenly (an even dim flattens this
     * sheet back toward the grey wall it took several rounds to escape),
     * so the curve goes pow 1.4 -> 2.0 and the gain 0.42 -> 0.26: mids
     * sink into the body colour, true highlights survive as the broken
     * patches. The GREEN comes from the channel weights, not a tint on
     * top: red is cut hard (0.55 -> 0.30) and blue pulled under green
     * (0.9 -> 0.62), so what survives the reflection is the scene's own
     * green rather than the teal-cyan the mirror carries. The body tint
     * and the facet teal follow the same bias. */
    vec3 col = deep + pow(refl, vec3(2.0)) * vec3(0.30, 1.0, 0.62) * 0.26
             + teal * (facets * 0.07 + sparkle * 0.18);

    /* DEPTH ATTENUATION, in world units, and the other half of the
     * realism fix: a 96-unit sheet seen from a metre below runs to the
     * frame edge at every distance, so it tiled as an even wall of chop.
     * Real water swallows its own ceiling within a few metres -- the far
     * sheet goes to murk, and only the pool overhead stays legible.
     *
     * 0.026 from 0.085, and the vignette widened with it, on the client's
     * "more water". These two -- not the plane size -- are what decide how
     * much of the sheet reads as LIT WATER: at 0.085 the murk closed in
     * about 12 units out, so however large the mesh got, only a narrow band
     * of it was ever visible and the water stayed a band. 0.026 carries it
     * to roughly 40 units, which fills the frame at the crossing while the
     * exponential still does its job -- the far sheet dissolves rather than
     * ending, and the near pool stays brightest.
     *
     * Laddered live against the client frame at 920vh: 0.045 read as a
     * moderate lift, 0.026 as a real body of water, and 0.014 went too far
     * -- the sheet flattened into an even teal wall, swallowed the spine
     * sculpture, and its lit region ended in a hard horizontal cut. This is
     * the last stop before the depth gradient stops reading. */
    float dist = length(vMPos - cameraPosition);
    col *= exp(-dist * 0.026);
    col *= smoothstep(0.75, 0.12, length(vUv - 0.5));
    gl_FragColor = vec4(col, uAlpha);
  }
`;

/* ------------------------------------------------------------------ *
 *  MirrorRenderer -- a LITERAL port of their class, scraped from the live
 *  bundle 2026-08-16 (`String(MirrorRenderer)` on activetheory.net).
 *
 *  Their TreeScene builds it through TreeMirror, also scraped verbatim:
 *
 *      let mirror = _this.createFragment(FX.Mirror, _this.layers.water.mesh,
 *                                        { size: 1024 });
 *      mirror.start();
 *      for (let key in _this.layers)
 *        if (_this.layers[key].shader) mirror.add(_this.layers[key]);
 *
 *  -- so: FX.Mirror bound to the WATER mesh at size 1024, and every layer
 *  carrying a shader is added to the reflection. FX.Mirror's decorateShader
 *  is what injects the two uniforms our fragment already reads:
 *
 *      shader.uniforms.tMirrorReflection = renderer.renderTarget.texture
 *      shader.uniforms.uMirrorMatrix     = renderer.textureMatrix
 *
 *  Their defaults, carried here: size 1024, clipBias 0.01, sx 0.5, tx 0,
 *  LINEAR min/mag, no mipmaps.
 *
 *  TWO THINGS THIS PORT FIXES that a from-memory planar reflector got
 *  wrong, both taken straight off their source:
 *    - `up` starts at (0, -1, 0), NOT (0, 1, 0), and is rotated, reflected
 *      and negated. With +1 the reflection comes out inverted.
 *    - the oblique clip's third row is `c.z + 1 - clipBias`; dropping the
 *      bias term leaves surface-plane geometry fighting the near plane.
 *
 *  Departure, and the only one: theirs renders a SEPARATE FXScene holding
 *  just the added layers. We have one scene, so the caller passes the scene
 *  and the surface is hidden for the pass -- same result (the surface must
 *  not see itself), without a second scene graph to keep in sync.
 * ------------------------------------------------------------------ */
function createMirror(size = 1024, clipBias = 0.01, sx = 0.5, tx = 0) {
  const renderTarget = new THREE.WebGLRenderTarget(size, size, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
  });
  const textureMatrix = new THREE.Matrix4();
  let mirrorCamera = null;

  const mirrorPlane = new THREE.Plane();
  const normalDir = new THREE.Vector3(0, 0, 1);
  const normal = new THREE.Vector3();
  const mirrorWorldPosition = new THREE.Vector3();
  const cameraWorldPosition = new THREE.Vector3();
  const rotationMatrix = new THREE.Matrix4();
  const lookAtPosition = new THREE.Vector3(0, 0, -1);
  const clipPlane = new THREE.Vector4();
  const viewVec = new THREE.Vector3();
  const targetVec = new THREE.Vector3();
  const up = new THREE.Vector3();
  const q = new THREE.Vector4();
  /* scratch for the near-plane guard in render() */
  const guardRot = new THREE.Matrix4();
  const guardNormal = new THREE.Vector3();
  const guardEye = new THREE.Vector3();
  const guardPos = new THREE.Vector3();

  /* updateTextureMatrix(), theirs line for line */
  function updateTextureMatrix(camera, surface) {
    surface.updateMatrixWorld();
    camera.updateMatrixWorld();
    mirrorWorldPosition.setFromMatrixPosition(surface.matrixWorld);
    cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);
    rotationMatrix.extractRotation(surface.matrixWorld);
    normal.copy(normalDir).applyMatrix4(rotationMatrix);

    viewVec.copy(mirrorWorldPosition).sub(cameraWorldPosition);
    viewVec.reflect(normal).negate();
    viewVec.add(mirrorWorldPosition);

    rotationMatrix.extractRotation(camera.matrixWorld);
    lookAtPosition.set(0, 0, -1).applyMatrix4(rotationMatrix);
    lookAtPosition.add(cameraWorldPosition);
    targetVec.copy(mirrorWorldPosition).sub(lookAtPosition);
    targetVec.reflect(normal).negate();
    targetVec.add(mirrorWorldPosition);

    up.set(0, -1, 0).applyMatrix4(rotationMatrix).reflect(normal).negate();

    mirrorCamera.position.copy(viewVec);
    mirrorCamera.up.copy(up);
    mirrorCamera.lookAt(targetVec);
    mirrorCamera.updateMatrixWorld();
    mirrorCamera.projectionMatrix.copy(camera.projectionMatrix);

    textureMatrix.set(
      sx, 0, 0, sx + tx,
      0, 0.5, 0, 0.5,
      0, 0, 0.5, 0.5,
      0, 0, 0, 1);
    textureMatrix.multiply(mirrorCamera.projectionMatrix);
    textureMatrix.multiply(mirrorCamera.matrixWorldInverse);

    mirrorPlane.setFromNormalAndCoplanarPoint(normal, mirrorWorldPosition);
    mirrorPlane.applyMatrix4(mirrorCamera.matrixWorldInverse);
    clipPlane.set(mirrorPlane.normal.x, mirrorPlane.normal.y,
                  mirrorPlane.normal.z, mirrorPlane.constant);

    const pm = mirrorCamera.projectionMatrix;
    q.x = (Math.sign(clipPlane.x) + pm.elements[8]) / pm.elements[0];
    q.y = (Math.sign(clipPlane.y) + pm.elements[9]) / pm.elements[5];
    q.z = -1;
    q.w = (1 + pm.elements[10]) / pm.elements[14];
    const c = clipPlane.multiplyScalar(2 / clipPlane.dot(q));
    pm.elements[2] = c.x;
    pm.elements[6] = c.y;
    pm.elements[10] = c.z + 1 - clipBias;
    pm.elements[14] = c.w;
  }

  /* how close to its own plane the eye may get before the mirror stops
   * re-rendering -- see the guard in render() */
  const MIRROR_EPS = 0.25;

  function render(renderer, scene, camera, surface) {
    if (!mirrorCamera) mirrorCamera = camera.clone();
    /* THE GUARD, and this is the one-frame flash at the crossing.
     *
     * updateTextureMatrix below builds a reflected camera and an oblique clip
     * plane from the eye's SIGNED DISTANCE to the surface. Nothing defends
     * against that distance reaching zero or changing sign -- and the eye
     * passes through this plane on every crossing. Within a hair of it the
     * reflected camera converges onto the real one and the oblique clip
     * starts slicing the frustum it is supposed to bound, so the target is
     * filled with garbage.
     *
     * The mirror also runs at HALF RATE, so the water samples that garbage on
     * the frames it is produced and the next render corrects it: a one-to-two
     * frame flash that reverses. Measured off the client's capture, +9.54 mean
     * luma in a single frame and -7.53 two frames later -- a signature no
     * continuous shading term can produce, which is why every shader-side fix
     * missed it.
     *
     * Below the plane, or within EPS of it, do not re-render. The target holds
     * its last good contents, which at that distance is a grazing reflection
     * of the same water and indistinguishable -- and it saves a whole scene
     * pass exactly where the frame is most expensive.
     *
     * Measured along the SURFACE'S OWN NORMAL, not world Y: the topside's
     * normal is +Y and the underside's is -Y, so each face's valid side is
     * positive by this measure and one test covers both. Returns FALSE when
     * it declines, so the caller's "never sample an unwritten target"
     * invariant is driven by whether a render actually happened -- setting
     * that flag on a call that early-returned here would satisfy the
     * invariant with nothing drawn. */
    surface.updateMatrixWorld();
    camera.updateMatrixWorld();
    guardRot.extractRotation(surface.matrixWorld);
    guardNormal.set(0, 0, 1).applyMatrix4(guardRot);
    guardEye.setFromMatrixPosition(camera.matrixWorld);
    guardPos.setFromMatrixPosition(surface.matrixWorld);
    if (guardEye.sub(guardPos).dot(guardNormal) < MIRROR_EPS) return false;
    updateTextureMatrix(camera, surface);
    const wasVisible = surface.visible;
    surface.visible = false;                 // see the departure note
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(renderTarget);
    renderer.clear();
    renderer.render(scene, mirrorCamera);
    renderer.setRenderTarget(prevTarget);
    surface.visible = wasVisible;
    return true;
  }

  return { rt: renderTarget, textureMatrix, render };
}

/**
 * Build both sides of the waterline. `normalTex` must be the shared
 * assets/at/waternormals.jpg upload; `filmTex` the deep's film texture (the
 * ceiling's video overlay, unused since the underside became the same
 * water); `matcapTex` their matcap-test.jpg. The topside reflects
 * `mirror.rt` -- call `mirror.render(renderer, scene, camera, topside)`
 * from the frame loop before any render that draws the surface.
 */
export function buildWater(shared, { normalTex, filmTex, matcapTex }) {
  /* 512, a quarter of their 1024 and of what this shipped at. The mirror
   * pass is a WHOLE EXTRA SCENE RENDER every frame, and the client's
   * recording measured the page dropping 9.4% of its frames, so it has to
   * earn its cost. It survives the cut because nothing in this water reads
   * the reflection sharply: both faces displace the sample by ~0.15 of the
   * frame through the ripple field, which destroys detail far finer than
   * the resolution does. Verified by eye at the tableau and the dive. */
  const mirror = createMirror(512);
  const topMat = new THREE.ShaderMaterial({
    uniforms: {
      tWaterNormal: { value: normalTex },
      tMirrorReflection: { value: mirror.rt.texture },
      tMatcap: { value: matcapTex },
      /* uil ships uSpeed 0.04 / uScale 1000 / uWaterUVStrength -5 -- values
       * for a surface the size of theirs under a lit room. On our 260-unit
       * plane those normals rolled in broad synchronized bands that the
       * grazing view stretched into long bright lines -- the client's
       * "abstract neon" verdict. Finer (3000), slower (0.03), and with the
       * mirror sample more deeply broken (-9), the reflection shatters into
       * drifting patches with dark water between them -- their own topside's
       * read in the underwater recording. */
      uSpeed: { value: 0.03 },
      uScale: { value: 3000 },
      uWaterUVStrength: { value: -9 },
      /* THE EXPOSURE DEPARTURE, and the only tuning that leaves their uil
       * values. Theirs are uBrightness 2, uLight.w 0.04, uColor #ffffff --
       * right for THEIR stage, a lit room with bright structure and cables
       * hanging over the surface. Ours reflects the deep's own footage, which
       * is near-black: measured live in the pane, the mirror target needed
       * ~20x gain before ANY reflected content was visible, which is why the
       * surface first shipped reading as a dark smear.
       *
       * So the mirror sample is exposed up (uBrightness 9) and the specular
       * carries the ripple sparkle (uLight.w 1.6). HISTORY OF THAT KNOB,
       * because it flip-flopped for a real reason: with the mro plate
       * mis-ported as vec3(1.0), roughness 1 made the GGX D term constant,
       * so ANY specular weight rendered as a structureless slab -- 1.2
       * looked broken and it was backed down to 0.30. With the plate's REAL
       * roughness (0.247, measured from their 2x2 jpg) the term shapes
       * per-ripple glints, and 1.6 reads as moonlit chop, live in the pane.
       * uColor carries the cyan-green highlight of the client's demo. */
      /* 2.6, down from 9.0 -- the white along the bottom.
       *
       * A ceiling was the wrong tool and three attempts at one proved it. At
       * uBrightness 9 the mirror sample is driven so far past any ceiling that
       * the bright region of the surface sits PINNED at it: a flat plateau at
       * the cap, which against a near-black scene reads as white. Clamping,
       * a per-channel knee and a peak-preserving shoulder all bounded the
       * value correctly and all still produced a saturated plateau, because
       * saturation is what happens when the input is far above the limit.
       *
       * The 9 was chosen when the mirror target was measured near-black and
       * needed heavy gain to show anything. It is no longer near-black -- the
       * deep is lit -- so the gain is now doing the opposite of its job.
       *
       * 2.6 keeps the reflection clearly readable while leaving headroom under
       * the ceiling, so the surface renders as a range of greens instead of a
       * clipped white slab. The ceiling stays as a safety net for genuine
       * highlights; it is no longer load-bearing. */
      uBrightness: { value: 2.6 },
      /* w 0.5, down from 1.6: with the finer chop each glint is small, and
       * at 1.6 their sum re-approached the white-line look. uColor is a
       * muted teal -- the client's spec bans bright white/blue highlights,
       * and their own water's sparkle is green-teal throughout. */
      uLight: { value: new THREE.Vector4(-2.96, 7.5, -1.93, 0.34) },
      /* greener and dimmer with the rest of the pass: the sparkle was the
       * one place cyan still entered the frame */
      uColor: { value: new THREE.Color(0.16, 0.68, 0.42) },
      uTime: shared.uTime,
      uAlpha: { value: 0 },
      uMirrorMatrix: { value: mirror.textureMatrix },
    },
    vertexShader: TOPSIDE_VS,
    fragmentShader: TOPSIDE_FS,
    transparent: true,
    /* depthWrite ON for the same reason the film's is: transparent-no-write
     * pixels inherit the background's depth and the DOF blurs them as
     * background. The surface must stay sharp -- it is the thing being
     * looked at. fog off like the film: it carries its own atmosphere. */
    depthWrite: true,
    fog: false,
    side: THREE.DoubleSide,
  });
  /* The water section's surface. 110 x 70: wider than any frustum and long
   * enough to run from behind the eye (no visible near rim) to past the far
   * bank. Position is the caller's -- it belongs to the section's world
   * pocket, set where the scene is assembled. */
  const topside = new THREE.Mesh(new THREE.PlaneGeometry(110, 70), topMat);
  topside.rotation.x = -Math.PI / 2;

  const ceilMat = new THREE.ShaderMaterial({
    uniforms: {
      /* the same normals the topside scrolls, but at 9000, not a
       * "world-matched" 1100 -- the matching that matters is SCREEN
       * frequency at the VIEWING distance. The topside's visible band
       * sits 10-45 units out; the dive sees the ceiling from 0.35-5
       * units, where 1100 put less than one ripple tile across the whole
       * frame -- the normal field was effectively constant on screen and
       * every fragment variant rendered as flat haze (three cuts chased
       * shader causes before zeroing the mesh isolated it). 9000 puts
       * ~1 tile per 0.8 world units: real variation at arm's length. */
      tWaterNormal: { value: normalTex },
      /* the SAME mirror target the topside samples -- see the fragment */
      tMirrorReflection: { value: mirror.rt.texture },
      uResolution: shared.uResolution,
      uSpeed: { value: 0.03 },
      /* 162000, tracking the sheet's widening below. getWaterNormal is fed
       * vUv, which stays 0..1 however large the plane is, so enlarging the
       * mesh alone STRETCHES the ripple field by the same factor -- the sheet
       * gets bigger and visibly smoother, which is the opposite of the ask.
       * Scaling the tiling with the size holds ripples-per-world-unit
       * constant, so the extra sheet arrives already carrying the same
       * detail the near field has. */
      uScale: { value: 162000 },
      uAlpha: { value: 0 },
      uTime: shared.uTime,
    },
    vertexShader: CEILING_VS,
    fragmentShader: CEILING_FS,
    transparent: true,
    depthWrite: true,
    fog: false,
    side: THREE.DoubleSide,
  });
  /* The lab's water ceiling: hung over the whole card room, centred near the
   * spine so the radial vignette's bright pool sits above the column. y +2
   * puts the sheet filling the top of frame at the rail's first waypoint
   * (eye y 0, fov 35) while clearing card 0's top edge at +0.875. The spine
   * runs to y 6 and pierces it, exactly as their column pierces theirs. */
  /* 1728, from 288, from 96 -- and the last number is set by where the FADE
   * finishes, not by taste.
   *
   * The client circled a hard horizontal line partway down the water and
   * asked for the surface to carry on into the depths with no cut. That line
   * is this plane's own far edge. The sheet has always ended inside the
   * frustum; what changed is that opening up the murk (exp(-dist*0.026))
   * left it still ~3% lit where the geometry stops, and 3% against a
   * near-black room is a visible edge. The fade has to reach zero BEFORE the
   * edge arrives, or the edge is what you see.
   *
   * At 0.026 the water is gone by roughly 265 units, and the eye sits off
   * the sheet's centre, so the far edge needs to be several hundred units
   * out. Laddered live at 955vh: 288 showed the client's line, 1152 dropped
   * and softened it, 2592 removed it outright. 1728 is the middle of that
   * -- comfortably past where the exponential has finished -- so the water
   * now dissolves into murk and the geometry never announces itself.
   *
   * The original note follows, since the reasoning still holds: the client
   * asked for "more water", and a bisect at the
   * crossing found the whole water BODY is this sheet, not the topside: hide
   * the ceiling at 920vh and the entire expanse goes, leaving bare dark room.
   * At 96 the sheet ran out inside the frustum, so its far edge read as a
   * hard horizon line partway up the frame with nothing beyond it -- the
   * water looked like a band rather than a body. At 288 the edge is 144 units
   * out, where the depth attenuation above (exp(-dist*0.085)) has already
   * taken it to zero, so the sheet fades into murk instead of ending.
   *
   * It also widens the radial vignette's bright pool in world terms (that
   * fade is in plane uv), which is the "density" half of the ask: a much
   * larger area of the sheet now reads as lit water rather than as falloff.
   * 3x is where the edge stops being reachable; 4.5x looked identical for
   * more overdraw. uScale tracks it -- see the note there. */
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(1728, 1728), ceilMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(-2, 2.0, 0);

  return { topside, ceiling, topMat, ceilMat, mirror };
}
