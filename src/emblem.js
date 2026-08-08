import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { loadJellyMatcap, loadLogoNormal } from './textures.js';
import { TRANSFORM_UV, RANGE, RGB_SHIFT, FRESNEL, RADIAL_BLUR, MATCAP_VS,
         BLEND_MODES, RGB2HSV } from './glsl-chunks.js';

/* Liquid-glass emblem — Active Theory's AboutLogoShader, ported.
 *
 *   source  emblem.glb      53.36 MB   1,912,782 tris   3x JPEG maps
 *   opt     emblem.opt.glb   2.66 MB     ~536k tris     64px webp  (-95.0%)
 *
 * The geometry is used exactly as authored -- nothing here touches vertices, and
 * the model's own maps are dropped rather than sampled.
 *
 * THE MATERIAL IS NOW THEIR LOGO SHADER, not a PBR clearcoat. What was here before
 * was MeshPhysicalMaterial (clearcoat, iridescence, PMREM studio env, two rim
 * PointLights) with one AT refraction line injected -- physically-based shading
 * that read as neither glass nor their coin, which is what got it called out.
 * Their coin is not lit at all. AboutLogoShader (compiled.vs) is an UNLIT stack,
 * and uil binds onto it the SAME faceted-crystal matcap the jellyfish wears:
 *
 *   tMap      assets/images/room/matcap-test.jpg    (the crystal ball photograph)
 *   tNormal   assets/images/jungle_soil_normal.png  uNormalStrength 0.24
 *
 * The stack, in their order: a UV-animated matcap sweep across the face (getRGB
 * through rotating scaled UVs -- the slow liquid churn), a SCREEN-SPACE normal
 * read (scaleUV(screenuv, 5.0) pushed by vNormal and vViewDir -- this is the wavy
 * organic distortion over everything), radial-blurred refraction of the scene, the
 * true matcap term via reflectMatcap, two rainbow fresnel overlays, a travelling
 * soft-light shimmer band, a hue drift, and pow 1.5.
 *
 * PORT DEPARTURES, each marked at point of use:
 *   - tVideo (their showreel feed) does not exist here. Its soft-light wash is
 *     dropped; its rim tint becomes white -- exactly what their own code mixes it
 *     60% toward anyway.
 *   - rainbowColor is driven through the GREEN window of their ramp only
 *     ([0.085, 0.28]): the effect's physics is theirs, the colour scheme is ours.
 *   - Their two vUv edge fades masked their monogram's texture-atlas edges; on
 *     this GLB's planar UVs they would darken one corner of the coin, so they go.
 *   - `float center` in their source is computed and never read. Not carried.
 *   - #drawbuffer Refraction vec4(0.0) is their way of keeping the coin out of the
 *     refraction buffer; ours is refractExclude, already in place.
 *
 * What a caller must know is unchanged: it needs a scene-snapshot as
 * `opts.refraction`, and the emblem MUST be excluded from the pass rendering that
 * buffer (it samples the buffer it would be drawn into -- feedback). Against a
 * bare void the glass is genuinely near-invisible; that is the technique, not a
 * bug. The rimLights option is GONE: an unlit shader cannot see lights, and
 * main.js's scene-level rig covers the neighbouring lit materials.
 */

const URL = 'assets/emblem.opt.glb';

/* AT, AboutLogoShader.glsl vertex, adapted only in that vMUV uses the world-space
 * normal. Their source passes vNormal (their framework's normalMatrix product) into
 * reflectMatcap, whose contract is world space; under three's conventions
 * normalMatrix is VIEW space, so passing it here would spin the matcap with the
 * camera. The jelly took the same route and it is verified right. vNormal stays
 * view-space for the fresnel term, exactly as theirs uses it. */
const LOGO_VS = /* glsl */`
  varying vec2 vUv;
  varying vec3 vPos;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec2 vMUV;

  ${MATCAP_VS}

  void main() {
    vUv = uv;
    vec3 pos = position;
    vPos = pos;
    vWorldPos = vec3(modelMatrix * vec4(pos, 1.0));
    vNormal = normalMatrix * normal;
    vViewDir = -vec3(modelViewMatrix * vec4(pos, 1.0));
    vec3 wn = normalize(mat3(modelMatrix[0].xyz, modelMatrix[1].xyz, modelMatrix[2].xyz) * normal);
    vMUV = reflectMatcap(vWorldPos, wn);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const LOGO_FS = /* glsl */`
  uniform sampler2D tMap;
  uniform sampler2D tNormal;
  uniform sampler2D tRefraction;
  uniform float uAlpha;
  uniform float uNormalStrength;
  uniform float time;
  uniform vec2 resolution;

  varying vec2 vUv;
  varying vec3 vPos;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec2 vMUV;

  ${TRANSFORM_UV}
  ${RANGE}
  ${RGB_SHIFT}
  ${FRESNEL}
  ${RADIAL_BLUR}
  ${BLEND_MODES}
  ${RGB2HSV}

  /* Their rainbowColor, verbatim (same function their jelly shader defines). */
  vec3 rainbowColor(float t) {
      t = mod(t, 1.0); // Wraps the t value between 0.0 and 1.0
      if (t < 0.03) return mix(vec3(0.5, 0.0, 0.5), vec3(0.5, 0.0, 1.0), t / 0.03); // violet to blue
      else if (t < 0.06) return mix(vec3(0.5, 0.0, 1.0), vec3(0.0, 0.0, 1.0), (t - 0.03) / 0.03); // blue to darker blue
      else if (t < 0.09) return mix(vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 1.0), (t - 0.06) / 0.03); // darker blue to cyan
      else if (t < 0.12) return mix(vec3(0.0, 1.0, 1.0), vec3(0.0, 1.0, 0.0), (t - 0.09) / 0.03); // cyan to green
      else if (t < 0.18) return mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 1.0, 0.0), (t - 0.12) / 0.06); // green to yellow
      else if (t < 0.24) return mix(vec3(1.0, 1.0, 0.0), vec3(1.0, 0.5, 0.0), (t - 0.18) / 0.06); // yellow to orange
      else return mix(vec3(1.0, 0.5, 0.0), vec3(1.0, 0.0, 0.0), (t - 0.24) / 0.06); // orange to red
  }

  /* PORT DEPARTURE: their calls drive t across 0..0.3 -- the entire ramp, violet to
   * orange. The site's scheme is green, so the same drive signal is remapped into the
   * ramp's green quarter. Also the clamp their mix() lacks: rainbowColor extrapolates
   * past its last stop for t > 0.30 (negative channels -> the hsv sqrt NaN class). */
  vec3 rainbowGreen(float t) {
      return rainbowColor(mix(0.085, 0.28, clamp(t / 0.3, 0.0, 1.0)));
  }

  void main() {
    vec2 uv = vUv;
    vec2 screenuv = gl_FragCoord.xy / resolution;

    /* Their face sweep: the matcap dragged through scaled, slowly rotating UVs.
     * This is the liquid churn on the flat of the coin. */
    uv = scaleUV(uv, vec2(1.8));

    /* Their screen-space normal read. scaleUV(screenuv, 5.0) spans ~[-2, 3], which
     * is why the texture must repeat-wrap; pushing the lookup by vNormal and
     * vViewDir is what makes the relief cling to the form instead of sitting on the
     * screen like a filter. */
    vec2 normalUV = scaleUV(screenuv, vec2(5.0)) - vNormal.xy * 0.3 - vViewDir.xy * 0.2;
    vec3 normal = crange(texture2D(tNormal, normalUV).rgb, vec3(0.0), vec3(1.0), vec3(-1.0), vec3(1.0));

    uv = rotateUV(uv, 1.0 + sin(time * 0.5) * 0.5);
    uv += normal.xy * 0.02 * uNormalStrength;
    uv += vViewDir.xy * 0.025 * uNormalStrength;

    vec4 color = getRGB(tMap, uv, 0.2, 0.001) * 0.6;

    /* Fresnel 1.8 -- much broader than the PBR rim this replaces, and that breadth
     * is correct: their coin's edge light washes well into the face. The normal
     * perturbation makes it ragged rather than machined. */
    float f = getFresnel(vNormal + normal * 0.05, vViewDir, 1.8);
    screenuv -= vNormal.xy * 0.1;
    screenuv += normal.xy * 0.01;

    /* PORT DEPARTURE: their blendSoftLight(color, video, 0.8) showreel wash sat
     * here. No video feed exists in this build, so the term is dropped. */

    /* Their refraction: the scene snapshot radially blurred -- blur IS the frost.
     * The lookup is pushed hard by the surface normal (0.25) and softly by the
     * relief (0.06), both scaled by their uNormalStrength. */
    vec2 refractionuv = gl_FragCoord.xy / resolution;
    refractionuv += vNormal.xy * 0.25 * uNormalStrength;
    refractionuv += normal.xy * 0.06 * uNormalStrength;
    vec3 refractionTex = radialBlur(tRefraction, refractionuv, 8.0, 8.0).rgb;
    color.rgb += refractionTex * 0.6;

    /* The true matcap term. Additive, full strength -- on the crystal photograph the
     * limb is near-black, so this paints the bevels bright and leaves the face to
     * the sweep and refraction above. */
    color += texture2D(tMap, vMUV);

    color.rgb = blendOverlay(color.rgb, rainbowGreen(f * 0.3), 0.1);
    color.rgb += rainbowGreen(f * 0.2) * 0.05;
    color *= 1.0 + f * .6;
    /* Their line ends * mix(video, vec3(1.0), 0.6); with no video the mix target
     * stands in for the whole factor. */
    color.rgb += pow(f, 2.0) * 0.8 * vec3(1.0);

    /* The travelling shimmer: a soft-light flash gated to the FACE (smoothstep away
     * from the rim) that drifts with time and view angle. This is the single most
     * recognisable motion on their coin. */
    color.rgb = blendSoftLight(color.rgb, vec3(1.0),
      smoothstep(0.2, 0.0, f) * mix(0.0, 1.0, abs(sin(time * 0.4 - f * 2.0 - vViewDir.x * 2.0))) * 2.0);

    /* Their hue drift. max() before rgb2hsv is the project rule -- the additive
     * stack above cannot go negative today, but nothing downstream of a soft-light
     * sqrt gets an unguarded base in this codebase. */
    vec3 hueShift = rgb2hsv(max(color.rgb, vec3(0.0)));
    hueShift.x += sin(time * 0.5 + normal.x * 3.0 + vNormal.x * 0.5) * 0.1;
    hueShift.y *= 0.7;
    color.rgb = hsv2rgb(hueShift);

    color.rgb = pow(max(color.rgb, vec3(0.0)) * 1.0, vec3(1.5));
    color.a *= uAlpha;

    /* Hard ceiling, project rule: HalfFloat targets + additive stack + UnrealBloom
     * means one hot pixel becomes Inf and one Inf pixel blacks the frame. */
    color.rgb = clamp(color.rgb, vec3(0.0), vec3(1.75));
    gl_FragColor = color;
  }
`;

export async function loadEmblem(shared, opts = {}) {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const t0 = performance.now();
  const gltf = await loader.loadAsync(opts.url ?? URL);
  const loadMs = Math.round(performance.now() - t0);

  let source = null;
  gltf.scene.traverse(o => { if (o.isMesh && !source) source = o; });
  if (!source) throw new Error(`no mesh in ${opts.url ?? URL}`);

  /* KHR_mesh_quantization puts the decode scale on the NODE, so raw geometry
   * bounds are meaningless until the node transform is baked in. Same trap as
   * the spine, where skipping this produced a model at half size. */
  gltf.scene.updateMatrixWorld(true);
  const geometry = source.geometry.clone();
  geometry.applyMatrix4(source.matrixWorld);
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const size = new THREE.Vector3().subVectors(bb.max, bb.min);

  // centre on its own bounds so it rotates about the emblem, not a corner
  geometry.translate(
    -(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -(bb.min.z + bb.max.z) / 2);
  /* Do NOT computeVertexNormals() here.
   *
   * KHR_mesh_quantization stores normals as an Int8Array. computeVertexNormals
   * writes unit floats into whatever buffer already exists, so components like
   * 0.71 truncate to 0 and EVERY normal becomes a zero vector. The mesh then
   * renders as a pure black silhouette -- no lighting, no fresnel, and emissive
   * has no visible effect either, which is a genuinely confusing symptom.
   *
   * The export's own normals are correct and already dequantized by the loader,
   * so there is nothing to recompute. If they ever did need rebuilding, the
   * attribute would have to be replaced with a Float32 one first. */
  geometry.computeBoundingSphere();

  const targetHeight = opts.targetHeight ?? 5.0;
  const scale = targetHeight / Math.max(1e-4, size.y);

  /* This GLB may not carry UVs -- the old PBR material never read them, so it was
   * never checked. Their shader's face sweep (getRGB through rotating UVs) needs
   * them; a flat coin planar-maps cleanly from its own xy bounds. Authored UVs, if
   * present, are used untouched. */
  if (!geometry.attributes.uv) {
    const p = geometry.attributes.position;
    // boundingBox above was computed before the centring translate; recompute
    geometry.computeBoundingBox();
    const bbNow = geometry.boundingBox;
    const sx = Math.max(1e-6, bbNow.max.x - bbNow.min.x);
    const sy = Math.max(1e-6, bbNow.max.y - bbNow.min.y);
    const uvArr = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      uvArr[i * 2] = (p.getX(i) - bbNow.min.x) / sx;
      uvArr[i * 2 + 1] = (p.getY(i) - bbNow.min.y) / sy;
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  }

  /* Their textures, per the versioned uil: the SAME crystal matcap the jellyfish
   * binds (one extra upload if main.js already made one -- 50 KB, accepted to keep
   * the call site unchanged), and the soil relief at their 0.24 strength. */
  const material = new THREE.ShaderMaterial({
    vertexShader: LOGO_VS,
    fragmentShader: LOGO_FS,
    uniforms: {
      time: shared.uTime,
      resolution: shared.uResolution,
      tMap: { value: opts.matcap ?? loadJellyMatcap() },
      tNormal: { value: opts.normalMap ?? loadLogoNormal() },
      tRefraction: { value: opts.refraction ?? null },
      uNormalStrength: { value: opts.normalStrength ?? 0.24 },
      uAlpha: { value: 1 },
    },
    /* Opaque, deliberately. Their coin's see-through quality is the refraction
     * sample, not blending -- a transparent coin would double-expose against the
     * additive particle field behind it. FrontSide: a 536k-tri plate's interior
     * back faces would z-fight at DoubleSide for nothing. */
    transparent: false,
    side: THREE.FrontSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.setScalar(scale);
  mesh.frustumCulled = false;

  const group = new THREE.Group();
  group.add(mesh);

  return {
    group, mesh, material, env: null,
    update(dt) {
      /* Slow turn. Glass is only interesting in motion -- the reflections and
       * the dispersion fringes travel across the bevels, which is most of what
       * reads as expensive. */
      mesh.rotation.y += (opts.spin ?? 0.18) * dt;
      // a slight nod so the rings catch the key light at varying angles
      mesh.rotation.x = Math.sin(shared.uTime.value * 0.22) * 0.05;
    },
    stats: {
      file: opts.url ?? URL, loadMs,
      verts: geometry.attributes.position.count,
      tris: (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3,
      size: [+size.x.toFixed(3), +size.y.toFixed(3), +size.z.toFixed(3)],
      scale: +scale.toFixed(3),
    },
  };
}
