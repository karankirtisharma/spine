import * as THREE from 'three';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { NOISE } from './shaders.js';
import { makeRng } from './rng.js';
/* Own stream: canopy is built inside the alcove's async decode, which races
 * the cloud chain. Sharing the global stream made its scatter depend on which
 * chain resolved first. Keyed to a constant, so it is reproducible either way. */
const rand = makeRng(0xCA0F1A);

/* THE CANOPY — a GPU-instanced foliage field, one draw call.
 *
 * The brief, implemented literally:
 *
 *   - low-poly foliage clusters scattered across 3D terrain:  the cluster is
 *     Active Theory's own room/bush.bin (~2k tris) and the terrain is their
 *     tree_room rocky_soil + walls meshes -- scatter positions are area-weighted
 *     surface samples WITH the surface normal, so clusters grow out of the ground
 *     and off the walls the way vegetation actually does
 *   - custom GLSL, noise-based displacement:  cnoise sways each cluster's crown in
 *     the vertex shader, weighted by height within the cluster so roots hold still
 *   - distance-based density falloff:  each instance carries a random threshold;
 *     past uDensNear the density curve drops and instances whose threshold exceeds
 *     it COLLAPSE -- fewer clusters with distance, resolved per-instance on the GPU
 *   - randomized scale/rotation:  per-instance quaternion (surface normal + random
 *     yaw) and scale in [0.6, 1.7]
 *   - progressive dissolution at the edges:  an edge factor over the field radius
 *     shrinks clusters toward their origin and lofts them -- the solid canopy
 *     breaks into small floating flecks toward the rim, where the site's existing
 *     grain clouds take over as the fully-dissolved phase
 *   - deep black-green lighting, green emissive highlights:  a two-stop ramp from
 *     near-black to moss by height-in-cluster, with an emissive tip term bloom can
 *     pick up; volumetric fog via an exp2 term matched to the scene fog
 *
 * One InstancedBufferGeometry, one ShaderMaterial, one draw call. No per-cluster
 * three.js objects anywhere.
 */

const CANOPY_VS = /* glsl */`
  attribute vec3 iOffset;
  attribute vec4 iQuat;
  attribute float iScale;
  attribute vec4 iRandom;

  uniform float time;
  uniform float uReveal;
  uniform float uSway;
  uniform float uClusterH;
  uniform vec2 uDensity;       // x: falloff start (world units), y: falloff end
  uniform vec3 uFieldCenter;   // room space
  uniform float uFieldRadius;  // room space

  varying float vH;
  varying float vEdge;
  varying float vFog;
  varying vec4 vRand;

  uniform float uFogDensity;

  ${NOISE}

  vec3 qrot(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }

  void main() {
    /* Height within the cluster, BEFORE any transform: drives sway, the colour
     * ramp and the emissive tips. */
    float hgt = clamp(position.y / max(1e-4, uClusterH), 0.0, 1.0);
    vH = hgt;
    vRand = iRandom;

    /* Edge factor in room space -- the dissolution field. */
    float edge = smoothstep(uFieldRadius * 0.55, uFieldRadius, distance(iOffset.xz, uFieldCenter.xz));
    vEdge = edge;

    /* Distance-based density: the falloff is computed against the CAMERA in world
     * space, per instance (constant across the cluster so it cannot tear). */
    vec3 originW = vec3(modelMatrix * vec4(iOffset, 1.0));
    float dCam = distance(originW, cameraPosition);
    float density = 1.0 - smoothstep(uDensity.x, uDensity.y, dCam);

    /* keep: does THIS instance survive at this distance? iRandom.w is its fixed
     * lottery ticket, so the set of survivors is stable frame to frame and thins
     * smoothly as the camera recedes. */
    float keep = step(iRandom.w, density + 0.12);

    /* solidity: alive, inside the field, revealed. As it drops the cluster's
     * vertices collapse toward the instance origin -- a bush shrinking to a fleck.
     * The floor (0.035) keeps dissolved instances as TINY floating particles
     * rather than degenerate zero-area triangles. */
    float solid = keep * (1.0 - edge * 0.85) * clamp(uReveal, 0.0, 1.0);
    vec3 lp = qrot(iQuat, position * iScale) * max(0.035, solid);

    /* Noise sway, crown-weighted: the displacement the brief asks for. Phase rides
     * the instance random so no two clusters breathe together. */
    float n = cnoise(iOffset * 0.14 + time * 0.10 + iRandom.x * 7.0);
    lp.xz += n * uSway * hgt * iScale * solid;

    /* Dissolved matter floats: edge instances loft and drift upward. */
    vec3 room = iOffset + lp;
    room.y += edge * (0.6 + iRandom.y * 1.4) * uReveal;

    vec4 world = modelMatrix * vec4(room, 1.0);
    vec4 mv = viewMatrix * world;

    /* exp2 fog against the true view distance, matched to the scene's FogExp2 so
     * the canopy sits IN the same air as everything else. */
    vFog = 1.0 - exp(-uFogDensity * uFogDensity * dot(mv.xyz, mv.xyz));

    gl_Position = projectionMatrix * mv;
  }
`;

const CANOPY_FS = /* glsl */`
  uniform vec3 uDeep;
  uniform vec3 uMid;
  uniform vec3 uEmissive;
  uniform vec3 uFogColor;
  uniform float time;

  varying float vH;
  varying float vEdge;
  varying float vFog;
  varying vec4 vRand;

  void main() {
    /* Deep black-green at the roots to moss at the crown; per-instance value
     * jitter so the field is not one repeated bush colour. */
    vec3 color = mix(uDeep, uMid, vH * vH);
    color *= 0.7 + vRand.z * 0.6;

    /* Green emissive tips -- the highlight bloom picks up. Gated hard to the
     * crown (pow 3) and twinkling on the instance's own phase. */
    float tip = pow(vH, 3.0);
    float tw = 0.6 + 0.4 * sin(time * 1.7 + vRand.z * 40.0);
    color += uEmissive * tip * tw * 0.5;

    /* Dissolving flecks run brighter -- matter catching light as it breaks up. */
    color += uEmissive * vEdge * 0.15;

    color = mix(color, uFogColor, clamp(vFog, 0.0, 1.0));

    /* Project rule: HalfFloat + bloom, one Inf pixel blacks the frame. */
    color = clamp(color, vec3(0.0), vec3(1.5));
    gl_FragColor = vec4(color, 1.0);
  }
`;

/**
 * @param bushGeo       their cluster geometry (room/bush.bin, decoded)
 * @param terrainGeos   geometries to scatter over, in the SAME (room) space
 * @param opts.count    instance count, default 900
 * @param opts.fieldCenter/fieldRadius   room-space dissolution field
 * @param opts.fogColor/fogDensity      matched to the scene fog
 */
export function buildCanopy(bushGeo, terrainGeos, opts = {}) {
  const COUNT = opts.count ?? 900;

  bushGeo.computeBoundingBox();
  const clusterH = Math.max(1e-4, bushGeo.boundingBox.max.y - bushGeo.boundingBox.min.y);

  /* Area-weighted scatter across ALL terrain surfaces: sample counts split by
   * surface area so a big floor does not get the same share as a sliver of wall. */
  const samplers = terrainGeos.map(g => {
    const m = new THREE.Mesh(g);
    const s = new MeshSurfaceSampler(m).build();
    g.computeBoundingBox();
    // crude area proxy: bbox surface area; close enough for share-splitting
    const d = new THREE.Vector3().subVectors(g.boundingBox.max, g.boundingBox.min);
    const area = 2 * (d.x * d.y + d.y * d.z + d.z * d.x) + 1e-6;
    return { s, area };
  });
  const totalArea = samplers.reduce((a, s) => a + s.area, 0);

  const offsets = new Float32Array(COUNT * 3);
  const quats = new Float32Array(COUNT * 4);
  const scales = new Float32Array(COUNT);
  const rands = new Float32Array(COUNT * 4);

  const p = new THREE.Vector3(), n = new THREE.Vector3();
  const q = new THREE.Quaternion(), yaw = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  let w = 0;
  for (const { s, area } of samplers) {
    const share = Math.round(COUNT * area / totalArea);
    for (let i = 0; i < share && w < COUNT; i++, w++) {
      s.sample(p, n);
      offsets[w * 3] = p.x; offsets[w * 3 + 1] = p.y; offsets[w * 3 + 2] = p.z;
      /* +Y of the cluster aligns to the surface normal, then a random yaw about
       * that normal -- bushes point OUT of whatever they grow on. */
      q.setFromUnitVectors(UP, n.lengthSq() > 1e-8 ? n.normalize() : UP);
      yaw.setFromAxisAngle(n, rand() * Math.PI * 2);
      q.multiply(yaw);
      quats[w * 4] = q.x; quats[w * 4 + 1] = q.y; quats[w * 4 + 2] = q.z; quats[w * 4 + 3] = q.w;
      scales[w] = 0.6 + rand() * 1.1;
      for (let k = 0; k < 4; k++) rands[w * 4 + k] = rand();
    }
  }
  // rounding shortfall: fill from the first sampler
  while (w < COUNT) {
    samplers[0].s.sample(p, n);
    offsets[w * 3] = p.x; offsets[w * 3 + 1] = p.y; offsets[w * 3 + 2] = p.z;
    q.setFromUnitVectors(UP, n.lengthSq() > 1e-8 ? n.normalize() : UP);
    quats[w * 4] = q.x; quats[w * 4 + 1] = q.y; quats[w * 4 + 2] = q.z; quats[w * 4 + 3] = q.w;
    scales[w] = 0.6 + rand() * 1.1;
    for (let k = 0; k < 4; k++) rands[w * 4 + k] = rand();
    w++;
  }

  const geo = new THREE.InstancedBufferGeometry();
  geo.index = bushGeo.index;
  geo.setAttribute('position', bushGeo.attributes.position);
  if (bushGeo.attributes.normal) geo.setAttribute('normal', bushGeo.attributes.normal);
  geo.instanceCount = COUNT;
  geo.setAttribute('iOffset', new THREE.InstancedBufferAttribute(offsets, 3));
  geo.setAttribute('iQuat', new THREE.InstancedBufferAttribute(quats, 4));
  geo.setAttribute('iScale', new THREE.InstancedBufferAttribute(scales, 1));
  geo.setAttribute('iRandom', new THREE.InstancedBufferAttribute(rands, 4));

  const uniforms = {
    time: opts.timeUniform ?? { value: 0 },
    uReveal: { value: 0 },
    uSway: { value: opts.sway ?? 0.35 },
    uClusterH: { value: clusterH },
    uDensity: { value: new THREE.Vector2(opts.densNear ?? 28, opts.densFar ?? 80) },
    uFieldCenter: { value: opts.fieldCenter ?? new THREE.Vector3() },
    uFieldRadius: { value: opts.fieldRadius ?? 40 },
    uFogDensity: { value: opts.fogDensity ?? 0.022 },
    uFogColor: { value: new THREE.Color(opts.fogColor ?? '#04100a') },
    uDeep: { value: new THREE.Color(opts.deep ?? '#06120a') },
    uMid: { value: new THREE.Color(opts.mid ?? '#33532a') },
    uEmissive: { value: new THREE.Color(opts.emissive ?? '#7dd63a') },
  };

  const mat = new THREE.ShaderMaterial({
    vertexShader: CANOPY_VS,
    fragmentShader: CANOPY_FS,
    uniforms,
    /* Opaque and depth-tested -- the same occlusion rule as the point clouds: the
     * canopy must be able to hide what is behind it or it reads as a scrim. */
    transparent: false,
    depthWrite: true,
    depthTest: true,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;   // instances live in attributes; bounds are meaningless

  return { mesh, uniforms };
}
