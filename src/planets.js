import * as THREE from 'three';
import { NOISE } from './shaders.js';

/* PLANETS — the celestial bodies of the deep section, per the reference frame:
 * a large emerald planet upper-left half-buried in the foliage banks, a mid
 * planet lower-right with a tiny companion, and a remote moon or two.
 *
 * Procedural, not downloaded: at this darkness a planet is 80% silhouette,
 * 15% noise-textured terminator and 5% atmospheric rim, and a shader does all
 * three better than a textured GLB — no asset weight, no license audit, and
 * the surface ROTATES by resampling the noise field around Y, which a static
 * bake cannot do without a second texture fetch pipeline.
 *
 * Real THREE.Mesh spheres, opaque and depth-tested, so the vegetation banks
 * genuinely occlude them — "partially obscured by atmospheric foliage" comes
 * free from the depth buffer rather than from compositing tricks. */

const PLANET_VS = /* glsl */`
varying vec3 vN;      // object-space normal — the noise samples in object space
varying vec3 vWN;     // world normal, for lighting
varying vec3 vView;   // world view direction, for the fresnel rim

void main() {
  vN = normal;
  vWN = normalize(mat3(modelMatrix) * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vView = normalize(cameraPosition - world.xyz);
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const PLANET_FS = /* glsl */`
uniform float uTime, uSpin, uSeed;
uniform vec3 uLightDir;   // world
uniform vec3 uBase, uDark, uRim;
uniform float uRimGain, uLightGain;

varying vec3 vN, vWN, vView;

${NOISE}

void main() {
  /* The surface pattern spins; the lighting and rim stay fixed. Resampling the
   * noise field through a rotating frame IS the rotation — no per-frame JS. */
  float a = uTime * uSpin;
  float c = cos(a), s = sin(a);
  vec3 p = vec3(vN.x * c - vN.z * s, vN.y, vN.x * s + vN.z * c);

  /* two octaves of terrain + one broad band read as continents and cloud
   * belts at this scale; more would be invisible at this darkness */
  float t = cnoise(p * 2.3 + uSeed) * 0.6
          + cnoise(p * 5.1 + uSeed * 2.0) * 0.25
          + sin(p.y * 4.0 + cnoise(p * 1.7 + uSeed) * 2.0) * 0.18;
  vec3 surf = mix(uDark, uBase, clamp(t * 0.5 + 0.5, 0.0, 1.0));

  /* the terminator: a soft crescent, most of the sphere stays night */
  vec3 N = normalize(vWN);
  float ndl = dot(N, normalize(uLightDir));
  float lit = smoothstep(-0.05, 0.55, ndl);

  /* atmospheric fresnel rim — the reference's soft green limb glow */
  float fr = pow(clamp(1.0 - dot(N, normalize(vView)), 0.0, 1.0), 2.6);

  vec3 color = surf * (0.05 + lit * uLightGain)
             + uRim * fr * uRimGain * (0.35 + lit * 0.65);

  /* HalfFloat + bloom project rule: no spikes into the mip chain */
  gl_FragColor = vec4(min(color, vec3(1.0)), 1.0);
}`;

/**
 * @param opts.bodies [{ at:[x,y,z], r, spin, seed, base, dark, rim, rimGain,
 *                       lightGain, detail }] — holder-local placement
 * @param opts.lightDir  shared world light direction (the shaft from above)
 */
export function buildPlanets(shared, opts = {}) {
  const group = new THREE.Group();
  const bodies = opts.bodies ?? [];
  const lightDir = new THREE.Vector3().fromArray(opts.lightDir ?? [-0.3, 0.75, 0.5]).normalize();

  for (const b of bodies) {
    const uniforms = {
      uTime: shared.uTime,
      uSpin: { value: b.spin ?? 0.008 },
      uSeed: { value: b.seed ?? Math.random() * 10 },
      uLightDir: { value: lightDir },
      uBase: { value: new THREE.Color(b.base ?? '#1b4a2e') },
      uDark: { value: new THREE.Color(b.dark ?? '#04120a') },
      uRim: { value: new THREE.Color(b.rim ?? '#57c99a') },
      uRimGain: { value: b.rimGain ?? 0.5 },
      uLightGain: { value: b.lightGain ?? 0.4 },
    };
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(b.r ?? 1, b.detail ?? 48, b.detail ?? 48),
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: PLANET_VS,
        fragmentShader: PLANET_FS,
        transparent: false,
        depthWrite: true,
        depthTest: true,
      }));
    mesh.position.fromArray(b.at);
    /* varied axial tilt so the cloud bands are not all horizontal */
    mesh.rotation.z = b.tilt ?? (Math.random() - 0.5) * 0.7;
    group.add(mesh);
  }

  return { group };
}
