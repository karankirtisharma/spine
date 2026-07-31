import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { spinePath, SPINE_TOP, SPINE_BOTTOM } from './world.js';

/* Spine model — Tripo export, compressed by compress.mjs.
 *
 *   source  spine.glb      69.78 MB   1,866,762 tris   4096² jpg + 4096² png
 *   high    spine.opt.glb   2.77 MB     298,673 tris   2048² webp  (-96.0%)
 *   max     spine.min.glb   1.18 MB      ~131k tris    1024² webp  (-98.3%)
 *
 * Compressed builds use EXT_meshopt_compression + KHR_mesh_quantization +
 * EXT_texture_webp, so the loader needs the meshopt decoder wired in.
 * Local bounds 0.152 x 0.981 x 0.151, origin at the base.
 *
 * The model is one ~1-unit-tall segment, so it is repeated up the column.
 * Segments are separate Meshes sharing a single BufferGeometry so each one
 * frustum-culls independently — an InstancedMesh would submit all 1.87M
 * triangles times the segment count on every frame. */

/* Cards orbit at radius 3.8 with the camera group at 7.6 and the eye at 9.6.
 * A ~2.2-unit column reads at roughly an eighth of frame width from there,
 * which closes the gap between the spine and the flanking cards. */
const TARGET_DIAMETER = 2.2;
const OVERLAP = 0.92;          // segments overlap slightly so joints do not gap

const QUALITY_FILES = {
  high: 'assets/spine.opt.glb',   // 2.77 MB — default
  max:  'assets/spine.min.glb',   // 1.18 MB
  raw:  'assets/spine.glb',       // 69.78 MB source, for A/B comparison
};

export async function loadSpine(shared, opts = {}) {
  const { segments = null, quality = 'high' } = opts;
  const url = QUALITY_FILES[quality] || QUALITY_FILES.high;
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const t0 = performance.now();
  const gltf = await loader.loadAsync(url);
  const loadMs = Math.round(performance.now() - t0);

  let source = null;
  gltf.scene.traverse(o => { if (o.isMesh && !source) source = o; });
  if (!source) throw new Error(`no mesh in ${url}`);

  /* KHR_mesh_quantization stores positions as integers and puts the decode
   * scale on the NODE, so raw geometry bounds are meaningless for the
   * compressed builds. Bake the source transform in before measuring —
   * without this the compressed spine came out at half the source's size. */
  gltf.scene.updateMatrixWorld(true);
  const geometry = source.geometry.clone();
  geometry.applyMatrix4(source.matrixWorld);
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const size = new THREE.Vector3().subVectors(bb.max, bb.min);
  // re-origin to the base of the column so segments stack predictably
  geometry.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  geometry.computeBoundingBox();

  // uniform scale so the model's XZ footprint hits TARGET_DIAMETER
  const scale = TARGET_DIAMETER / Math.max(size.x, size.z);
  const segHeight = size.y * scale * OVERLAP;

  /* Wet-surface material. The model's own basecolor and normal maps are carried
   * over untouched — nothing here recolours it. The Tripo export ships
   * metalness 0 / roughness 0.5, which renders dead flat, so a clearcoat layer
   * is added on top: that is physically a thin film of water over the surface,
   * which is exactly the "wet" read. Clearcoat reflects without tinting the
   * albedo, so the gunmetal/patina colour is preserved. */
  const src = source.material;
  const material = new THREE.MeshPhysicalMaterial({
    map: src.map || null,
    normalMap: src.normalMap || null,
    roughnessMap: src.roughnessMap || null,
    metalnessMap: src.metalnessMap || null,
    aoMap: src.aoMap || null,
    color: src.color ? src.color.clone() : new THREE.Color(0xffffff),

    metalness: 0.0,          // keep diffuse albedo intact
    roughness: 0.34,         // damp sheen in the base layer
    clearcoat: 1.0,          // the water film
    clearcoatRoughness: 0.045,
    envMapIntensity: 2.1,
    side: THREE.FrontSide,
  });
  if (material.map) {
    material.map.colorSpace = THREE.SRGBColorSpace;
    material.map.anisotropy = 8;
  }
  if (material.normalMap) {
    material.normalMap.anisotropy = 8;
    material.normalScale = new THREE.Vector2(1.35, 1.35);   // wet micro-relief
  }

  /* Self-illumination. A fresnel-weighted emissive is injected into the PBR
   * fragment so the column glows from its own edges and crevices rather than
   * being lit from outside — the glow then feeds UnrealBloom downstream.
   * A slow band travels up the spine so it reads as alive, not painted on. */
  const glow = {
    uGlowColor: { value: new THREE.Color(opts.glowColor ?? '#7dd63a') },
    uGlowCore: { value: new THREE.Color(opts.glowCore ?? '#d8ff9a') },
    uGlowStrength: { value: opts.glowStrength ?? 1.9 },
    uGlowPower: { value: opts.glowPower ?? 2.4 },
    uTime: shared.uTime,
  };
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, glow);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uGlowColor;
        uniform vec3 uGlowCore;
        uniform float uGlowStrength;
        uniform float uGlowPower;
        uniform float uTime;
        varying vec3 vGlowWorld;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec3 V = normalize(vViewPosition);
          float fres = pow(1.0 - clamp(abs(dot(normalize(normal), V)), 0.0, 1.0), uGlowPower);
          // travelling band, plus a constant floor so the whole column glows
          float band = 0.55 + 0.45 * sin(vGlowWorld.y * 0.55 - uTime * 0.7);
          vec3 g = mix(uGlowColor, uGlowCore, pow(fres, 2.0));
          totalEmissiveRadiance += g * fres * uGlowStrength * (0.45 + 0.55 * band);
        }`);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\n        varying vec3 vGlowWorld;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n        vGlowWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  };
  material.customProgramCacheKey = () => 'spine-glow';
  material.needsUpdate = true;

  const group = new THREE.Group();
  const span = SPINE_TOP - SPINE_BOTTOM;
  const count = segments ?? Math.ceil(span / segHeight) + 1;

  for (let i = 0; i < count; i++) {
    const yBase = SPINE_TOP - i * segHeight;
    const mesh = new THREE.Mesh(geometry, material);
    // model origin sits at its base, so place the base and let it grow upward
    const p = spinePath(yBase - segHeight);
    mesh.position.set(p.x, yBase - segHeight, p.z);
    mesh.scale.setScalar(scale);
    mesh.rotation.y = i * 1.31;                 // break up the repeat
    mesh.frustumCulled = true;
    group.add(mesh);
  }

  return {
    group,
    stats: {
      file: url, loadMs,
      verts: geometry.attributes.position.count,
      tris: (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3,
      scale: +scale.toFixed(3), segHeight: +segHeight.toFixed(2), count,
    },
  };
}

/* The model's own material is used unmodified — no recolouring, no hue shift.
 * Lighting comes from the scene environment set up in main.js. */
