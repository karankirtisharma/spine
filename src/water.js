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
 * FOUR DELIBERATE DEPARTURES, each because our stage differs, none tuned away
 * from their look:
 *
 *   1. time -> uTime (shared bag). Their engine injects a global `time`; note
 *      their getWaterNoise shadows it locally — kept, it is a transcription.
 *   2. tMirrorReflection: theirs is an FX.Mirror render target — the whole
 *      room re-rendered 1024px from the reflected eye. Ours would re-render
 *      the deep, but at the crossing the deep's backdrop IS the film plane, a
 *      flat quad: the exact planar mirror of a screen-covering flat backdrop
 *      is its own texture flipped about the waterline's screen height. So the
 *      film texture stands in for the mirror RT, flipped about uHorizonY and
 *      mapped through the film's cover-fit (uFilmFit). Same projective idea,
 *      zero extra renders, and the reflection really is the scene above.
 *   3. tMRO: theirs samples empty_mro.jpg — an empty MRO plate, i.e. constant.
 *      Ported as const vec3(1.0): roughness 1 selects their tightened matcap
 *      branch, occlusion 1 leaves the product alone.
 *   4. The ceiling's second MRT drawbuffer (CleanroomVolumetricLight, a
 *      luma-thresholded bright pass their composite re-adds blurred) has no
 *      MRT chain here; the site's own bloom provides that halo. Single output.
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
    const vec3 mro = vec3(1.0);   // empty_mro.jpg, see departure 3
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
  varying vec2 vUv;
  varying vec3 vMPos;
  void main() {
    vUv = uv;
    vec4 mPos = modelMatrix * vec4(position, 1.0);
    vMPos = mPos.xyz / mPos.w;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/* TreeWaterShader fragment, their main() line for line; `uv` is the mirror
 * lookup, built here from the screen coordinate flipped about the waterline
 * instead of vMirrorCoord (departure 2). uAlpha is ours -- their floor never
 * fades, ours arrives with the crossing. */
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
  uniform float uHorizonY;
  uniform vec2 uFilmFit;
  uniform vec2 uResolution;
  varying vec2 vUv;
  varying vec3 vMPos;
  ${WATER_NORMALS}
  ${FBR}
  void main() {
    vec2 screen = gl_FragCoord.xy / uResolution;
    vec2 uv = vec2(screen.x, 2.0 * uHorizonY - screen.y);

    vec3 normal = getWaterNormal(tWaterNormal, vUv, uSpeed * 0.05, uScale * 0.8);
    uv -= normal.xy * 0.015 * uWaterUVStrength;
    uv.y -= 0.04;

    // through the film's cover-fit -- the flat backdrop standing in for the mirror RT
    uv = (uv - 0.5) * uFilmFit + 0.5;

    vec3 baseColor = texture2D(tMirrorReflection, uv).rgb * uBrightness;
    vec3 color = getFBR(baseColor, normal, vMPos);

    color = mix(color, baseColor * 0.8, 0.2);
    color *= 0.9;

    gl_FragColor = vec4(color, uAlpha);
  }
`;

const CEILING_VS = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/* WaterCeilingShader fragment, verbatim minus the MRT drawbuffer (departure 4);
 * their commented-out noise lines dropped with the rest of their dead code. */
const CEILING_FS = /* glsl */`
  uniform sampler2D tMap;
  uniform sampler2D tVideo;
  uniform float uAlpha;
  uniform float uTime;
  varying vec2 vUv;
  ${CHUNKS}
  /* their simplenoise.glsl cnoise, verbatim (the sinf sum) */
  float cnoise(vec2 v) {
    float t = v.x * 0.3;
    v.y *= 0.8;
    float noise = 0.0;
    float s = 0.5;
    noise += (sin(v.x * 0.9 / s + t * 10.0) + sin(v.x * 2.4 / s + t * 15.0) +
              sin(v.x * -3.5 / s + t * 4.0) + sin(v.x * -2.5 / s + t * 7.1)) * 0.3;
    noise += (sin(v.y * -0.3 / s + t * 18.0) + sin(v.y * 1.6 / s + t * 18.0) +
              sin(v.y * 2.6 / s + t * 8.0) + sin(v.y * -2.6 / s + t * 4.5)) * 0.3;
    return noise;
  }
  void main() {
    vec2 uv = scaleUV(vUv, vec2(0.1));
    /* these two lines are IN their shipped shader, commented out -- the
     * undulation experiment they left dark. The live site's sheet gets its
     * life from volumetrics and particles instead; we have neither on this
     * plane, so the warp carries the motion. Their constants, uncommented. */
    uv += cnoise(uv * 5.0 + uTime * 0.1) * 0.02;
    uv += cnoise(uv * 1.0 - uTime * 0.1) * 0.04;
    vec4 color = texture2D(tMap, uv);

    vec3 hsl = rgb2hsv(color.rgb);
    hsl.x -= length(vUv - 0.5) * 0.2;
    hsl.y *= 0.5;

    color.rgb = hsv2rgb(hsl);

    color.rgb *= smoothstep(0.45, 0.0, length(vUv - 0.5));
    vec3 video = texture2D(tVideo, scaleUV(vUv, vec2(0.4))).rgb;
    color.rgb = blendOverlay(color.rgb, video, 0.3);

    color.rgb = pow(color.rgb, vec3(2.2));

    color.a *= uAlpha;
    gl_FragColor = color;
  }
`;

/**
 * Build both sides of the waterline. `normalTex` must be the shared
 * assets/at/waternormals.jpg upload; `filmTex` the deep's VideoTexture;
 * `matcapTex` their matcap-test.jpg; `crackTex` a tileable crack basecolor.
 */
export function buildWater(shared, { normalTex, filmTex, matcapTex, crackTex }) {
  const topMat = new THREE.ShaderMaterial({
    uniforms: {
      tWaterNormal: { value: normalTex },
      tMirrorReflection: { value: filmTex },
      tMatcap: { value: matcapTex },
      uSpeed: { value: 0.04 },            // uil: Element_9_TreeScene
      uScale: { value: 1000 },
      uWaterUVStrength: { value: -5 },
      uBrightness: { value: 2 },
      uLight: { value: new THREE.Vector4(-2.96, 7.5, -1.93, 0.04) },
      uColor: { value: new THREE.Color(1, 1, 1) },
      uTime: shared.uTime,
      uAlpha: { value: 0 },
      uHorizonY: { value: 0.3 },
      uFilmFit: { value: new THREE.Vector2(1, 1) },
      uResolution: shared.uResolution,
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
  /* The topside floor of the deep's tail. 110 x 70: from behind the eye
   * (z 55 > eye 41.8, so the near edge clips the frame bottom rather than
   * showing a rim) out past the film plane, and wider than the frustum. */
  const topside = new THREE.Mesh(new THREE.PlaneGeometry(110, 70), topMat);
  topside.rotation.x = -Math.PI / 2;
  topside.position.set(0, -6.5, 20);

  const ceilMat = new THREE.ShaderMaterial({
    uniforms: {
      tMap: { value: crackTex },
      tVideo: { value: filmTex },
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
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(96, 96), ceilMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(-2, 2.0, 0);

  return { topside, ceiling, topMat, ceilMat };
}
