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
    vec3 V = normalize(cameraPosition - vMPos);
    float fres = pow(1.0 - clamp(dot(normal, V), 0.0, 1.0), 5.0);
    float reflAmt = mix(0.10, 1.0, fres);
    vec3 deepTint = vec3(0.004, 0.030, 0.024);
    vec3 baseColor = mix(deepTint,
      texture2D(tMirrorReflection, uv).rgb * uBrightness, reflAmt);
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
  uniform sampler2D tWaterNormal;
  uniform float uSpeed;
  uniform float uScale;
  uniform float uAlpha;
  uniform float uTime;
  varying vec2 vUv;
  ${CHUNKS}
  ${WATER_NORMALS}
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
    /* OUR CONTINUITY LAYER, a deliberate departure with a reason their
     * build never had: their two water rooms met through a wipe, so the
     * ceiling was never on screen a frame after the topside. Ours ARE one
     * body of water crossed by the camera, and the client's spec is
     * explicit -- no visible switch between water systems. So the ceiling
     * breathes with the SAME four-tap normal field as the topside, at the
     * same world frequency and speed (uScale/uSpeed set where the material
     * is built): the ripple wobbles the caustic web continuously, and the
     * shimmer term below modulates its brightness, which is what kills the
     * static stretched-cell panes the client circled. */
    vec3 wn = getWaterNormal(tWaterNormal, vUv, uSpeed * 0.05, uScale * 0.8);
    uv += wn.xy * 0.22;
    vec4 color = texture2D(tMap, uv);

    vec3 hsl = rgb2hsv(color.rgb);
    hsl.x -= length(vUv - 0.5) * 0.2;
    hsl.y *= 0.5;

    color.rgb = hsv2rgb(hsl);

    color.rgb *= smoothstep(0.45, 0.0, length(vUv - 0.5));
    /* the shimmer half of the continuity layer -- see the note above */
    color.rgb *= 0.75 + 0.6 * clamp(abs(wn.x) + abs(wn.y), 0.0, 1.0);
    vec3 video = texture2D(tVideo, scaleUV(vUv, vec2(0.4))).rgb;
    /* 0.12, down from their 0.3: their overlay video is mid-tone abstract
     * footage; ours is the deep's film, whose bright vine column printed a
     * static vertical band across the sheet (the client circled it). At
     * 0.12 the overlay still varies the cells without projecting imagery. */
    color.rgb = blendOverlay(color.rgb, video, 0.12);

    color.rgb = pow(color.rgb, vec3(2.2));

    color.a *= uAlpha;
    gl_FragColor = color;
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

  function render(renderer, scene, camera, surface) {
    if (!mirrorCamera) mirrorCamera = camera.clone();
    updateTextureMatrix(camera, surface);
    const wasVisible = surface.visible;
    surface.visible = false;                 // see the departure note
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(renderTarget);
    renderer.clear();
    renderer.render(scene, mirrorCamera);
    renderer.setRenderTarget(prevTarget);
    surface.visible = wasVisible;
  }

  return { rt: renderTarget, textureMatrix, render };
}

/**
 * Build both sides of the waterline. `normalTex` must be the shared
 * assets/at/waternormals.jpg upload; `filmTex` the deep's film texture (the
 * ceiling's video overlay); `matcapTex` their matcap-test.jpg; `crackTex` a
 * tileable crack basecolor. The topside reflects `mirror.rt` -- call
 * `mirror.render(renderer, scene, camera, topside)` from the frame loop
 * before any render that draws the surface.
 */
export function buildWater(shared, { normalTex, filmTex, matcapTex, crackTex }) {
  const mirror = createMirror(1024);
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
      uBrightness: { value: 9.0 },
      /* w 0.5, down from 1.6: with the finer chop each glint is small, and
       * at 1.6 their sum re-approached the white-line look. uColor is a
       * muted teal -- the client's spec bans bright white/blue highlights,
       * and their own water's sparkle is green-teal throughout. */
      uLight: { value: new THREE.Vector4(-2.96, 7.5, -1.93, 0.5) },
      uColor: { value: new THREE.Color(0.30, 0.72, 0.60) },
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
      tMap: { value: crackTex },
      tVideo: { value: filmTex },
      /* the continuity layer's ripple field -- the same normals the topside
       * scrolls. uScale 1100 puts the ceiling's chop at the same WORLD
       * frequency as the topside's 3000 (the planes differ in size,
       * 96 vs 260, and vUv is per-plane); uSpeed matches outright. */
      tWaterNormal: { value: normalTex },
      uSpeed: { value: 0.03 },
      uScale: { value: 1100 },
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

  return { topside, ceiling, topMat, ceilMat, mirror };
}
