import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { makeStudioEnv } from './textures.js';

/* Liquid-glass emblem. Belongs to the Home hero and the About section.
 *
 *   source  emblem.glb      53.36 MB   1,912,782 tris   3x JPEG maps
 *   opt     emblem.opt.glb   2.66 MB     ~536k tris     64px webp  (-95.0%)
 *
 * The geometry is used exactly as authored -- nothing here touches vertices, and
 * the model's own maps are dropped rather than sampled.
 *
 * The material is SCREEN-SPACE REFRACTION, not three's `transmission`. See the
 * long note at the material itself for why transmission cannot be used here.
 * An earlier version of this header documented a transmission/thickness/
 * attenuation/dispersion material -- that material was removed and never worked;
 * none of those properties are set. The material below is authoritative.
 *
 * Two things a caller must know:
 *
 *   1. It needs a scene-snapshot buffer passed as `opts.refraction`, and the
 *      emblem MUST be excluded from whatever pass renders that buffer. It samples
 *      the buffer it would otherwise be drawn into, so including it is a feedback
 *      loop. Against a bare void with nothing behind it the glass is genuinely
 *      invisible -- that is correct physics, not a bug.
 *
 *   2. `rimLights` defaults to true and parents two PointLights INTO the returned
 *      group. Pass `rimLights: false` if that group will ever be hidden by
 *      toggling `.visible`: three's projectObject early-returns on an invisible
 *      subtree, so the lights leave the light list, and light counts are part of
 *      the program cache key -- toggling would force a shader recompile.
 */

const URL = 'assets/emblem.opt.glb';

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

  /* Screen-space refraction, NOT three's `transmission`.
   *
   * `transmission` was the obvious choice and it does not work here: it makes the
   * renderer run its own extra full-scene pass into an internal target to resolve
   * what sits behind the glass, and that fights EffectComposer -- the entire
   * frame rendered black, not just the emblem. Confirmed by toggling
   * transmission to 0 at runtime, which brought the whole scene back instantly.
   *
   * So this uses Active Theory's own technique instead, from HomeLogoShader.glsl:
   *
   *   vec3 color = texture2D(tRefraction, screenuv - vNormal.xy * 0.05
   *                                                - normal.xy * 0.005).rgb;
   *
   * A snapshot of the scene is sampled through the surface normal. main.js already
   * renders that buffer, and the emblem is excluded from it, so there is no
   * feedback loop. It costs no extra pass, it cannot conflict with the composer,
   * and it is what their glass monogram actually does.
   *
   * Injection goes at <emissivemap_fragment> rather than <opaque_fragment>. That
   * is deliberate: an earlier attempt to inject at opaque_fragment on the spine
   * blanked the frame, whereas adding into totalEmissiveRadiance is the pattern
   * already working for the spine glow. */
  const material = new THREE.MeshPhysicalMaterial({
    /* Very dark base. The visible colour is all refraction and rim, added on top;
     * a light albedo would sit under it as a milky haze and kill the clarity. */
    color: new THREE.Color(opts.color ?? '#0a1410'),
    metalness: 0.0,
    roughness: opts.roughness ?? 0.06,
    clearcoat: 1.0,
    clearcoatRoughness: opts.clearcoatRoughness ?? 0.04,
    iridescence: opts.iridescence ?? 0.4,
    iridescenceIOR: 1.3,
    iridescenceThicknessRange: [180, 380],
    envMapIntensity: opts.envMapIntensity ?? 1.8,
    side: THREE.FrontSide,
  });

  const glass = {
    tRefraction: { value: opts.refraction ?? null },
    uResolution: shared.uResolution,
    /* .x how far the normal bends the lookup, .y how much refraction is mixed in */
    uRefract: { value: new THREE.Vector2(
      opts.refractOffset ?? 0.09, opts.refractAmount ?? 1.05) },
    uTint: { value: new THREE.Color(opts.tint ?? '#8affc8') },   // mint edge
    uCore: { value: new THREE.Color(opts.core ?? '#eafff4') },   // hot rim
    /* Fresnel 3.2 keeps the rim to a narrow band at grazing angles. Lower values
     * spread it across the whole surface, which reads as a glowing outline rather
     * than a polished edge. */
    uFresnel: { value: opts.fresnelPower ?? 3.2 },
    /* 1.1, not the 4.2 I was testing with. The rim was cranked while diagnosing a
     * mesh that turned out to be rendering black for an unrelated reason (zeroed
     * quantized normals), and at that gain every bevel blows out to white. */
    uEdgeGain: { value: opts.edgeGain ?? 1.1 },
  };
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, glass);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tRefraction;
        uniform vec2 uResolution;
        uniform vec2 uRefract;
        uniform vec3 uTint;
        uniform vec3 uCore;
        uniform float uFresnel;
        uniform float uEdgeGain;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          /* Safe normalize, not normalize(). normalize(vec3(0)) is 0/0 -- NaN.
           *
           * This mesh is the one asset in the project where that is a live risk:
           * KHR_mesh_quantization stores its normals as an Int8Array, and a component
           * that quantises to zero across all three axes leaves a zero-length normal.
           * The project already hit the extreme version of this once, when
           * computeVertexNormals() truncated EVERY normal to zero and the emblem
           * rendered as a black silhouette. A handful of genuinely zero normals in a
           * 282k-vertex mesh produces the same NaN, just locally.
           *
           * Locally is enough. A few NaN fragments are invisible in the raw render --
           * which is why the scene read as healthy from the pixel oracle -- but
           * UnrealBloomPass runs a separable blur over the buffer, and a blur of NaN
           * is NaN everywhere. That is what blacked the whole frame, and why it
           * tracked the emblem's on-screen SIZE: bigger emblem, more bad fragments.
           * It also explains why raising the bloom threshold did not help -- every
           * comparison against NaN is false, so NaN sails through any high-pass. */
          vec3 N = normal / max(1e-6, length(normal));
          vec3 V = vViewPosition / max(1e-6, length(vViewPosition));

          // AT's lookup: screen UV pushed sideways by the surface normal
          vec2 screenuv = gl_FragCoord.xy / uResolution;
          screenuv -= N.xy * 0.1 * uRefract.x;
          screenuv = clamp(screenuv, vec2(0.001), vec2(0.999));
          vec3 refr = texture2D(tRefraction, screenuv).rgb;

          /* Chromatic split: sampling each channel at a slightly different offset
           * is the cheap stand-in for dispersion, and it is what puts the prism
           * fringe on the bevels where the normal turns hardest. */
          vec2 disp = N.xy * 0.1 * uRefract.x * 0.35;
          refr.r = texture2D(tRefraction, clamp(screenuv + disp, vec2(0.001), vec2(0.999))).r;
          refr.b = texture2D(tRefraction, clamp(screenuv - disp, vec2(0.001), vec2(0.999))).b;

          float fres = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), uFresnel);

          /* Refraction reads through the middle of the form and falls away at
           * grazing angles, where the rim takes over -- that crossover is what
           * makes a surface read as thick glass rather than a tinted window. */
          totalEmissiveRadiance += refr * uRefract.y * (1.0 - fres * 0.55);

          // mint edge, going to a hot near-white core at the very grazing angles
          vec3 rim = mix(uTint, uCore, pow(fres, 3.0));
          totalEmissiveRadiance += rim * fres * uEdgeGain;
        }`);
  };
  material.customProgramCacheKey = () => 'emblem-glass';
  /* onBeforeCompile shares these by reference, so main.js can rebind
   * tRefraction after the buffer is resized. */
  material.userData.glassUniforms = glass;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.setScalar(scale);
  mesh.frustumCulled = false;

  /* Dedicated studio environment rather than the scene's. The scene env is
   * Active Theory's env1.jpg -- blue-teal and low dynamic range, which gives the
   * glass a flat, slightly plasticky highlight. This is a few very bright
   * softboxes against near-black in HalfFloat, which is what produces crisp
   * travelling glints. Assigned per-material so it does not disturb the spine. */
  let env = null;
  if (opts.env !== false) {
    const pmrem = new THREE.PMREMGenerator(opts.renderer);
    pmrem.compileEquirectangularShader();
    const src = makeStudioEnv({ size: 512 });
    env = pmrem.fromEquirectangular(src).texture;
    material.envMap = env;
    src.dispose();
    pmrem.dispose();
  }

  const group = new THREE.Group();
  group.add(mesh);

  /* Two hard rim lights, parented to the emblem's own group.
   *
   * The environment gives broad reflections, but the bright specular streaks
   * running along the bevels in the reference are point sources. Parenting them
   * to the group rather than the scene means they hold their angle relative to
   * the emblem as it turns, so the highlight travels along an edge instead of
   * sweeping past and leaving it flat.
   *
   * Small distance values keep them from touching the rest of the scene. */
  if (opts.rimLights !== false) {
    const a = new THREE.PointLight(0xffffff, opts.rimIntensity ?? 22, 14, 2);
    a.position.set(-3.2, 3.0, 3.0);
    group.add(a);
    const b = new THREE.PointLight(0xbfffe0, (opts.rimIntensity ?? 40) * 0.55, 14, 2);
    b.position.set(3.4, -1.4, 2.2);
    group.add(b);
  }

  return {
    group, mesh, material, env,
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
