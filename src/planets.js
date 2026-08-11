import * as THREE from 'three';
import { NOISE } from './shaders.js';
import { rand } from './rng.js';

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
varying float vFog;

uniform float uFogK;

void main() {
  vN = normal;
  vWN = normalize(mat3(modelMatrix) * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vView = normalize(cameraPosition - world.xyz);
  vec4 mv = viewMatrix * world;
  /* exp2 fog against the true view distance, matched to the scene's FogExp2.
   * This shader is custom, so it gets no fog chunks for free -- and without
   * them a body 56 units out wrote full-strength colour while every other
   * object at that depth was ~78% faded into the background. That mismatch is
   * what made a planet read as a flat disc pasted over the foliage rather than
   * as something genuinely far away behind it. */
  vFog = 1.0 - exp(-uFogK * uFogK * dot(mv.xyz, mv.xyz));
  gl_Position = projectionMatrix * mv;
}`;

const PLANET_FS = /* glsl */`
uniform float uTime, uSpin, uSeed;
uniform vec3 uLightDir;   // world
uniform vec3 uBase, uDark, uRim, uFogColor;
uniform float uRimGain, uLightGain, uFogGain, uReveal;

varying vec3 vN, vWN, vView;
varying float vFog;

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
  float ndv = clamp(1.0 - dot(N, normalize(vView)), 0.0, 1.0);
  float fr = pow(ndv, 2.6);

  vec3 color = surf * (0.05 + lit * uLightGain)
             + uRim * fr * uRimGain * (0.35 + lit * 0.65);

  /* Fog to the scene's background, and it is doing the heaviest lifting here:
   * at these depths it takes ~80% of the body, which is what lets the
   * silhouette sit BEHIND the vegetation instead of on top of it.
   *
   * uFogGain under 1 on purpose. Applied in full, exp2 fog at 60+ units erases
   * these outright -- and a luminous body seen through haze does not vanish,
   * it dims and desaturates while staying brighter than the medium. Holding a
   * little back is the difference between "distant planet" and "no planet". */
  color = mix(color, uFogColor, clamp(vFog * uFogGain, 0.0, 1.0));

  /* The reveal: emerging from the haze as the descent deepens. Mixing toward
   * the fog rather than dropping alpha means the body is always solid -- it
   * just recedes until it is indistinguishable from the murk. */
  color = mix(uFogColor, color, clamp(uReveal, 0.0, 1.0));

  /* Feather the limb. A sphere's silhouette is a mathematically hard circle,
   * and against foliage a hard circle reads as a cutout however well it is
   * fogged. Fading alpha over the last few degrees of grazing angle gives the
   * body an atmosphere to dissolve through -- the edge stops being findable. */
  float alpha = 1.0 - smoothstep(0.88, 1.0, ndv);

  /* HalfFloat + bloom project rule: no spikes into the mip chain */
  gl_FragColor = vec4(min(color, vec3(1.0)), alpha);
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
  /* ONE reveal uniform shared by every body, so the whole sky emerges from the
   * haze on a single continuous write rather than popping in with a boolean.
   * It scales COLOUR toward the fog, not alpha: a body that fades by alpha
   * turns translucent and the vegetation shows through it, which reads as a
   * ghost; one that fades toward the fog colour simply recedes. */
  const uReveal = { value: 0 };

  for (const b of bodies) {
    const uniforms = {
      uTime: shared.uTime,
      uSpin: { value: b.spin ?? 0.008 },
      uSeed: { value: b.seed ?? rand() * 10 },
      uLightDir: { value: lightDir },
      uBase: { value: new THREE.Color(b.base ?? '#1b4a2e') },
      uDark: { value: new THREE.Color(b.dark ?? '#04120a') },
      uRim: { value: new THREE.Color(b.rim ?? '#57c99a') },
      uRimGain: { value: b.rimGain ?? 0.5 },
      uLightGain: { value: b.lightGain ?? 0.4 },
      uFogK: { value: opts.fogDensity ?? 0.022 },
      uFogGain: { value: b.fogGain ?? opts.fogGain ?? 0.72 },
      uFogColor: { value: new THREE.Color(opts.fogColor ?? '#04100a') },
      uReveal,
    };
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(b.r ?? 1, b.detail ?? 48, b.detail ?? 48),
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: PLANET_VS,
        fragmentShader: PLANET_FS,
        /* Transparent for the feathered limb, but depthWrite STAYS ON: these
         * are solid bodies and the vegetation in front must occlude them
         * normally. The only transparency is the last few degrees of the rim. */
        transparent: true,
        depthWrite: true,
        depthTest: true,
      }));
    /* drawn before the foliage so the feathered limb blends against the
     * background rather than against whatever happened to be sorted first */
    mesh.renderOrder = -3;
    mesh.position.fromArray(b.at);
    /* varied axial tilt so the cloud bands are not all horizontal */
    mesh.rotation.z = b.tilt ?? (rand() - 0.5) * 0.7;
    group.add(mesh);
  }

  return {
    group,
    /** 0..1 — the sky emerging from the haze as the descent deepens. */
    setReveal(p) { uReveal.value = Math.min(1, Math.max(0, p)); },
  };
}
