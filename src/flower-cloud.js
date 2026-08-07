import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

/* Loader for Active Theory's baked flower point cloud.
 *
 * The florets around their spine are not a simulation. They are an offline
 * bake, shipped as `assets/geometry/particles/flower_spine-{128,256,512,1024}.bin`
 * and decoded in a worker at boot -- which is why a main-thread Resource Timing
 * audit of the site reports "no 3D assets loaded" and why the Draco WASM looks
 * unused. It is used, just not from the main thread.
 *
 * Container is their own, not raw Draco:
 *
 *   offset 0   10 bytes   JSON byte length, ASCII digits, NUL-padded  ("80\0\0...")
 *   offset 10  N bytes    JSON header
 *   offset 10+N           Draco payload (magic "DRACO")
 *
 * The header for the 128 LOD reads:
 *   {"name":"flower_spine-128","type":1,"attributes":[["positions",7],["colors",7]]}
 *
 * Two attributes: POSITION and COLOR. The per-point colour is what their
 * FlowerParticleShader samples as `tPointColor` -- that is why neighbouring
 * grains share a hue and each clump reads as one organism rather than as
 * independently-tinted dust.
 *
 * These are Active Theory's authored assets and are NOT committed here; they
 * land in assets/at/ via `npm run fetch:assets`, same as their textures. When
 * absent, world.js falls back to generating a cloud procedurally.
 */

const HEADER_LEN_BYTES = 10;
const DRACO_MAGIC = 'DRACO';

/** Splits their wrapper into { meta, dracoBuffer }. */
export function parseATContainer(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  const lenStr = new TextDecoder().decode(u8.subarray(0, HEADER_LEN_BYTES))
    .replace(/\0+$/, '').trim();
  const jsonLen = parseInt(lenStr, 10);
  if (!Number.isFinite(jsonLen) || jsonLen <= 0 || jsonLen > 4096) {
    throw new Error(`bad header length prefix "${lenStr}"`);
  }

  const jsonBytes = u8.subarray(HEADER_LEN_BYTES, HEADER_LEN_BYTES + jsonLen);
  const meta = JSON.parse(new TextDecoder().decode(jsonBytes).trim());

  /* Trust the magic over the arithmetic: the JSON is NUL/newline padded to the
   * declared length inconsistently across LODs, so seek the payload rather
   * than assuming it begins exactly at 10 + jsonLen. */
  const scanEnd = Math.min(u8.length, HEADER_LEN_BYTES + jsonLen + 64);
  const window = new TextDecoder('latin1').decode(u8.subarray(0, scanEnd));
  const magicAt = window.indexOf(DRACO_MAGIC, HEADER_LEN_BYTES);
  if (magicAt === -1) throw new Error('no DRACO magic found after header');

  return { meta, dracoBuffer: arrayBuffer.slice(magicAt) };
}

let _loader = null;
function dracoLoader() {
  if (_loader) return _loader;
  _loader = new DRACOLoader();
  // decoder ships in the three.js package we already vendor
  _loader.setDecoderPath('./vendor/three/examples/jsm/libs/draco/');
  _loader.setDecoderConfig({ type: 'js' });
  return _loader;
}

/**
 * Loads one LOD and returns { position, color, count }.
 * `position` / `color` are Float32Array(count * 3).
 */
export async function loadFlowerCloud(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const { meta, dracoBuffer } = parseATContainer(await res.arrayBuffer());

  /* Signature is
   *   decodeDracoFile(buffer, onLoad, attributeIDs, attributeTypes,
   *                   vertexColorSpace, onError)
   * so onError is the SIXTH argument. Passing it fourth silently corrupts the
   * task config and the promise then never settles. */
  const geometry = await new Promise((resolve, reject) => {
    dracoLoader().decodeDracoFile(
      dracoBuffer, resolve, null, null, THREE.LinearSRGBColorSpace, reject);
  });

  const posAttr = geometry.getAttribute('position');
  if (!posAttr) throw new Error(`${url}: decoded without a position attribute`);
  // Draco names the second attribute "color"; some builds surface it as COLOR
  const colAttr = geometry.getAttribute('color') || geometry.getAttribute('COLOR');

  const count = posAttr.count;
  const position = new Float32Array(posAttr.array.buffer === undefined
    ? posAttr.array : posAttr.array.slice());

  let color;
  if (colAttr) {
    color = new Float32Array(count * 3);
    const src = colAttr.array;
    const stride = colAttr.itemSize;
    // colours may arrive as normalised bytes or floats depending on the bake
    const norm = colAttr.normalized || src instanceof Uint8Array ? 1 / 255 : 1;
    for (let i = 0; i < count; i++) {
      color[i * 3] = src[i * stride] * norm;
      color[i * 3 + 1] = src[i * stride + 1] * norm;
      color[i * 3 + 2] = src[i * stride + 2] * norm;
    }
  }

  geometry.dispose();
  return { position, color, count, meta };
}

/* ------------------------------------------------------------------ *
 *  Renderer — a port of FlowerParticleShader.glsl
 * ------------------------------------------------------------------ */

/* Their vertex shader reads positions out of the Antimatter GPGPU texture
 * (`tPos`); ours come straight off the decoded cloud as an attribute, which is
 * the only structural change. Everything after that fetch is theirs verbatim,
 * including the constants — and those constants are authored in THEIR world
 * scale (the column runs roughly y=5 down to y=-45, the outer spiral throws
 * points 25 units wide). Rather than rescale every literal and risk breaking
 * their internal proportions, the cloud is left at native scale and the whole
 * group is scaled down to fit our spine afterwards. Same look, one number.
 *
 * `random` is their per-particle vec4 from Antimatter's tAttribs, generated
 * per point at load here. `uSparkle` ramps +0.005/frame, `uRotate` lerps at
 * 0.05, `uScroll` is scrollProgress — all driven from WorkPage on their side. */
const FLOWER_VS = /* glsl */`
attribute vec4 aRandom;
attribute vec3 aColor;
uniform float uTime, uDPR, uScroll, uRotate, uSizeBias, uSizeScale;
varying vec3 vLightColor;
varying vec4 vRandom;
varying float vScale;
varying float vDist;
varying vec3 vWorldPos;

void main() {
  vec3 decodedPos = position;
  vec3 pos = decodedPos;
  vec4 random = aRandom;
  float time = uTime;

  if (pos.x < 0.0) {
    pos.z = -pos.z;
    pos.y -= 5.0;
  }

  pos.x += 1.0;
  pos.z -= 0.5;

  float offset = smoothstep(0.4, 0.0, uScroll) * pow(random.x, 30.0) * 10.0;
  offset *= (0.8 + sin(pos.y * 0.2 + time * 0.02 + uScroll + random.z * 2.0) * 0.2);
  pos.y += offset;

  // Top Spiral
  pos.x -= cos(uScroll * 5.0 + length(pos.xz) * 1.0 + pos.y * 0.5 + uRotate * 2.0) * 0.5 * smoothstep(0.0, 0.5, abs(uScroll - 0.5));
  pos.z -= sin(uScroll * 5.0 + length(pos.xz) * 1.0 + pos.y * 0.5 + uRotate * 2.0) * 0.5 * smoothstep(0.0, 0.5, abs(uScroll - 0.5));

  /* Outer Spiral. step(0.95, random.y) gates this to ~5% of the cloud, thrown
   * 25 units out along a slow helix -- these are the long sweeping dotted arcs
   * that cross the frame, not a separate particle system. */
  float radius = mix(0.5, 3.0, pow(random.w, 2.0));
  pos.x -= cos(pos.y * 0.5 + sin(time * 0.05 + random.w * 5.0 * 0.1 - uRotate * 0.2)) * 25.0 * step(0.95, random.y);
  pos.z -= sin(pos.y * 0.5 + sin(time * 0.05 + random.w * 5.0 * 0.1 - uRotate * 0.2)) * 25.0 * step(0.95, random.y);

  if (pos.x < 0.0) {
    pos.x -= cos(-decodedPos.y * 0.06) * 3.0 - 3.5;
    pos.z -= sin(-decodedPos.y * 0.06) * 3.0 - 2.0;
  } else {
    pos.x -= cos(-decodedPos.y * 0.06 + 3.0) * 3.0 + 3.5;
    pos.z -= sin(-decodedPos.y * 0.06 + 3.0) * 3.0 + 1.0;
  }

  // Bottom Spiral
  pos.y -= pow(uScroll, 4.0) * 20.0 * pow(random.w, 15.0);
  pos.x -= cos(pos.y * 1.0) * 0.2 * pow(random.w, 4.0) * pow(uScroll, 3.5);
  pos.z -= sin(pos.y * 1.0) * 0.2 * pow(random.w, 4.0) * pow(uScroll, 3.5);

  pos.xz = mix(pos.xz, vec2(0.0), pow(smoothstep(5.0, -45.0, pos.y), 3.0));

  vec3 worldPos = vec3(modelMatrix * vec4(pos, 1.0));
  vWorldPos = worldPos;
  float dist = length(worldPos - cameraPosition);
  vDist = dist;
  vLightColor = aColor;
  vRandom = random;

  /* Note the near cutoff: anything closer than 3 units scales to 0 and the
   * fragment shader discards it. That is how they keep grains from blowing up
   * into blobs as the camera passes through the cloud. */
  vScale = smoothstep(3.0, 15.0, dist);
  vScale *= 1.0 + (0.5 + sin(time * 5.0 + random.y * 20.0) * 0.5) * 0.3;
  vScale *= mix(0.5, 1.5, random.z);

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  /* Their sizing, with two changes that are not cosmetic.
   *
   * The 1000.0 is calibrated for THEIR world scale. We scale the group down to
   * fit our 26-unit column, so at our view distances the same expression yields
   * ~30px points; times 262k of them that is enough overdraw to stall the GPU,
   * and the browser then composites half-finished frames (nested black
   * rectangles on refresh). uSizeScale carries the group's fit factor so the
   * sizing is expressed in our units.
   *
   * The clamp is a hard backstop: no single point may cover enough pixels to
   * put us back in that state, whatever the scale or zoom. */
  float psize = (0.0275) * uDPR * 2.0 * vScale
    * ((1000.0 * uSizeScale) / length(mvPosition.xyz)) * uSizeBias;
  gl_PointSize = clamp(psize, 0.0, 6.0);
  gl_Position = projectionMatrix * mvPosition;
}`;

/* Fragment is their FlowerParticleShader too: circular cutout, rotating matcap
 * blended soft-light + overlay, HSV grade, sparkle flash, distance falloff and
 * the final pow(color * 1.2, 1.4). tMap is theirs and not redistributed, so the
 * matcap is our procedural bubble stand-in. */
const FLOWER_FS = /* glsl */`
uniform sampler2D uMatcap;
uniform float uTime, uSparkle, uBrightness;
varying vec3 vLightColor;
varying vec4 vRandom;
varying float vScale;
varying float vDist;
varying vec3 vWorldPos;

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1.0e-10)), d / (q.x + 1.0e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
float softLightC(float b, float s) {
  return s < 0.5 ? 2.0 * b * s + b * b * (1.0 - 2.0 * s)
                 : sqrt(b) * (2.0 * s - 1.0) + 2.0 * b * (1.0 - s);
}
vec3 blendSoftLight(vec3 base, vec3 blend, float o) {
  vec3 r = vec3(softLightC(base.r, blend.r), softLightC(base.g, blend.g), softLightC(base.b, blend.b));
  return mix(base, r, o);
}
vec3 blendOverlay(vec3 base, vec3 blend, float o) {
  vec3 r = mix(2.0 * base * blend, 1.0 - 2.0 * (1.0 - base) * (1.0 - blend), step(0.5, base));
  return mix(base, r, o);
}
vec2 rotateUV(vec2 uv, float r) {
  float c = cos(r), s = sin(r);
  vec2 p = uv - 0.5;
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c) + 0.5;
}

void main() {
  vec2 uv = vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y);
  if (length(uv - 0.5) > 0.5) discard;
  if (vScale < 0.1) discard;

  vec3 color = vLightColor;
  /* Clamped to >= 0. Their expression, 0.4 plus a sine, swings from
   * -0.6 to 1.4 -- and mixing a colour toward a NEGATIVE grey, then raising the
   * result to a fractional power further down, is undefined in GLSL. It returns
   * garbage per channel, which is where the violet speckle on refresh came from.
   *
   * Refresh specifically because uSparkle starts at 0 and only climbs 0.005 a
   * frame: smoothstep(2.0, 0.2, uSparkle) is fully ON at load and takes ~7s to
   * fade, so the artefact appears then disappears. */
  vec3 sparkle = vec3(max(0.0, 0.4 + sin(uTime * 3.0 + vRandom.y * 20.0)));

  vec2 matcapUV = rotateUV(uv, sin(uTime * 1.0 + vRandom.z * 20.0) * 0.5 + 1.0);
  vec3 matcap = texture2D(uMatcap, matcapUV).rgb * 1.3;
  color = blendSoftLight(color, matcap, 0.8);
  color = blendOverlay(color, matcap, 0.1);

  color = rgb2hsv(color);
  color.y *= mix(0.5, 0.8, vRandom.w);
  color = hsv2rgb(color);

  color = mix(color, sparkle, smoothstep(2.0, 0.2, uSparkle) * pow(vRandom.x, 10.0) * 0.5);
  color *= mix(0.6, 1.0, smoothstep(15.0, 6.0, vDist));
  // max() before pow: a fractional exponent on a negative channel is undefined,
  // so this is the backstop regardless of what upstream produces
  color = pow(max(color, vec3(0.0)) * 1.2, vec3(1.4));

  /* Ceiling on the output. Their grain runs through the same gain but reaches
   * the frame via an MRT composite; ours goes straight into UnrealBloom, and a
   * grain several times over 1.0 lands in one texel of the downscaled bloom
   * buffer and comes back as a hard square. Slightly over 1 keeps a real bloom
   * response without giving it a spike to smear. */
  /* Per-instance output level.
   *
   * 1.0 for the spine cloud, so nothing about section 3 changes. Lower for the
   * hero instance, and it is not cosmetic there: this shader gets no fog (custom
   * shaders do not unless the fog chunks are written in), so a point 40 units away
   * is exactly as bright as one at 10. The hero cloud is a backdrop 20 to 60 units
   * out and at full level it reads as a wall of light rather than as distance. */
  color *= uBrightness;

  gl_FragColor = vec4(min(color, vec3(1.15)), 1.0);
}`;

const smoothstep01 = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * JS mirror of FLOWER_VS's static transform, evaluated at uScroll=0, uRotate=0,
 * time=0, so the group can be fitted to the geometry the shader really draws.
 *
 * Outer-spiral points (random.y > 0.95) are deliberately excluded: they are
 * meant to fly far off the column, and including them would inflate the bounds
 * and shrink the whole cloud to nothing.
 */
function measureTransformed(position, rnd, count, step = 37) {
  let minY = Infinity, maxY = -Infinity;
  let sumX = 0, sumZ = 0, n = 0;
  const xs = [], zs = [];

  for (let i = 0; i < count; i += step) {
    const r0 = rnd[i * 4], r1 = rnd[i * 4 + 1], r2 = rnd[i * 4 + 2];
    if (r1 > 0.95) continue;                 // outer spiral, not representative

    const ox = position[i * 3], oy = position[i * 3 + 1], oz = position[i * 3 + 2];
    let x = ox, y = oy, z = oz;

    if (x < 0) { z = -z; y -= 5.0; }
    x += 1.0;
    z -= 0.5;

    // uScroll=0 -> smoothstep(0.4, 0.0, 0.0) == 1, so the lift is active
    let offset = 1.0 * Math.pow(r0, 30) * 10.0;
    offset *= 0.8 + Math.sin(y * 0.2 + r2 * 2.0) * 0.2;
    y += offset;

    // top spiral: smoothstep(0.0, 0.5, |0 - 0.5|) == 1
    const rad = Math.hypot(x, z);
    x -= Math.cos(rad + y * 0.5) * 0.5;
    z -= Math.sin(rad + y * 0.5) * 0.5;

    // the convergence that pulls both halves onto the axis
    if (x < 0) {
      x -= Math.cos(-oy * 0.06) * 3.0 - 3.5;
      z -= Math.sin(-oy * 0.06) * 3.0 - 2.0;
    } else {
      x -= Math.cos(-oy * 0.06 + 3.0) * 3.0 + 3.5;
      z -= Math.sin(-oy * 0.06 + 3.0) * 3.0 + 1.0;
    }

    // bottom collapse toward the axis
    const k = Math.pow(smoothstep01(5.0, -45.0, y), 3);
    x += (0 - x) * k;
    z += (0 - z) * k;

    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    sumX += x; sumZ += z; xs.push(x); zs.push(z); n++;
  }

  const cx = n ? sumX / n : 0;
  const cz = n ? sumZ / n : 0;

  /* Horizontal extent about the centroid, as a high percentile rather than a
   * max: even with the outer spiral excluded the ribbon has stragglers, and a
   * hard max would let a handful of points dictate the scale for all 262k. */
  const radii = [];
  for (let i = 0; i < n; i++) radii.push(Math.hypot(xs[i] - cx, zs[i] - cz));
  radii.sort((a, b) => a - b);
  const radius = radii.length ? radii[Math.floor(radii.length * 0.92)] : 1;

  return { minY, maxY, sampled: n, cx, cz, radius };
}

/**
 * Builds the flower cloud as a THREE.Points, fitted to our spine.
 *
 * `cloud` is the result of loadFlowerCloud(). `matcap` stands in for their tMap.
 * Returns { points, group, uniforms, stats } — group carries the fit transform
 * so their native-scale vertex math stays untouched.
 */
export function buildFlowerCloud(shared, cloud, matcap, opts = {}) {
  const { position, count } = cloud;
  const color = opts.color ?? cloud.color;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));

  // Antimatter's tAttribs equivalent: one stable vec4 of noise per particle
  const rnd = new Float32Array(count * 4);
  for (let i = 0; i < rnd.length; i++) rnd[i] = Math.random();
  geo.setAttribute('aRandom', new THREE.BufferAttribute(rnd, 4));

  const uniforms = {
    uTime: shared.uTime,
    uDPR: shared.uDPR,
    uScroll: { value: 0 },
    uRotate: { value: 0 },
    uSparkle: { value: 0 },
    uSizeBias: { value: opts.sizeBias ?? 1.0 },
    uBrightness: { value: opts.brightness ?? 1.0 },
    // set below, once the fit factor is known
    uSizeScale: { value: 1.0 },
    uMatcap: { value: matcap },
  };

  /* Opaque and depth-tested, which is what their shader actually does: it ends
   * on `gl_FragColor = vec4(color, 1.0)` into MRT draw buffers, with no blend
   * mode in sight. That is why their florets read as solid sculpted clumps with
   * real occlusion and dark gaps between them.
   *
   * This was additive with depthWrite off, and that is the whole cause of the
   * blown-out white cores: 500k overlapping sprites summing on top of each
   * other, then bloom on top of that. Additive also forces every fragment
   * through a blend read, so it was carrying the overdraw cost that stalled the
   * GPU on refresh. Opaque points get early-z instead -- cheaper and correct. */
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FLOWER_VS,
    fragmentShader: FLOWER_FS,
    transparent: false,
    depthWrite: true,
    depthTest: true,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  const allPoints = [points];

  /* Fit.
   *
   * The raw bbox is the wrong thing to fit against: the vertex shader above
   * moves points a long way before they are ever drawn -- the x<0 half is
   * mirrored and dropped 5 units, both halves are pulled ~3.5 toward the axis,
   * and 5% are thrown 25 units out. Fitting the raw cloud is what put it beside
   * the column instead of around it.
   *
   * So mirror the static part of that transform here (uScroll=0, uRotate=0,
   * time=0) over a subsample, ignore the outer-spiral outliers, and fit to the
   * bounds the shader actually produces. */
  const fitStats = measureTransformed(position, rnd, count);
  const srcSpan = Math.max(1e-3, fitStats.maxY - fitStats.minY);

  /* Fit on WIDTH, not height. Their ribbon is ~20 units across and ~37 tall
   * after transform; scaling it to our 26-unit column left the florets bushing
   * ±5.7 units around a 1.1-unit spine -- five times too wide. Matching the
   * radius instead keeps the clumps hugging the column as they do in the
   * original, and the ribbon then covers a shorter run of the column, which is
   * fine because the camera only ever frames part of it. */
  const fit = (opts.targetRadius ?? 3.2) / Math.max(1e-3, fitStats.radius);

  const group = new THREE.Group();
  group.add(points);
  group.scale.setScalar(fit);
  // point sizing is authored in their units; carry the fit into the shader
  uniforms.uSizeScale.value = fit;
  // their WorkPage sets exactly this
  group.rotation.y = THREE.MathUtils.degToRad(100);

  /* Centre the transformed cloud on our column. The centroid is taken after
   * rotation so the offset lands in world space, not the group's local space. */
  const cy = Math.cos(group.rotation.y), sy = Math.sin(group.rotation.y);
  const cx = fitStats.cx * fit, cz = fitStats.cz * fit;
  group.position.x = -(cx * cy + cz * sy);
  group.position.z = -(-cx * sy + cz * cy);
  /* Vertically: centre the ribbon on the column rather than hanging it from the
   * top, since it no longer spans the full height once fitted on width. */
  const midY = (fitStats.minY + fitStats.maxY) * 0.5 * fit;
  const columnMid = ((opts.top ?? 6) + (opts.bottom ?? -20)) * 0.5;
  group.position.y = columnMid - midY;

  /* Coverage. Fitting on width leaves the ribbon shorter than our column, so
   * the top of the spine sat bare. Stack additional copies of the SAME geometry
   * and material -- no extra memory, just extra draws -- each shifted a ribbon
   * height and spun so the repeat is not obvious. */
  const fittedSpan = srcSpan * fit;
  const column = (opts.top ?? 6) - (opts.bottom ?? -20);
  const copies = opts.copies ?? Math.max(0, Math.ceil(column / fittedSpan) - 1);
  for (let i = 1; i <= copies; i++) {
    const dup = new THREE.Points(geo, mat);
    dup.frustumCulled = false;
    // alternate above/below centre so growth stays symmetric about the column
    const dir = i % 2 === 1 ? 1 : -1;
    const step = Math.ceil(i / 2) * fittedSpan * 0.94;   // slight overlap, no seam
    dup.position.y = (dir * step) / fit;                 // local space, group is scaled
    dup.rotation.y = i * 2.399;                          // golden-ish, breaks the repeat
    group.add(dup);
    allPoints.push(dup);
  }

  return {
    group, points, uniforms, allPoints,
    stats: {
      count, name: cloud.meta?.name,
      srcSpan: +srcSpan.toFixed(2), srcRadius: +fitStats.radius.toFixed(2),
      fit: +fit.toFixed(4), fittedSpan: +fittedSpan.toFixed(2),
      copies: copies + 1, drawnPoints: count * (copies + 1),
      centroid: [+fitStats.cx.toFixed(2), +fitStats.cz.toFixed(2)],
      sampled: fitStats.sampled,
    },
  };
}

/**
 * Re-tints their baked colours into our palette.
 *
 * Their bake is authored in violet/teal/magenta. The point is to keep their
 * *structure* -- which grains cluster together and how the tint varies across
 * a clump -- while moving the hue into our green family. So rather than
 * replacing the colours, each point's own luminance and saturation are
 * preserved and only the hue is remapped onto a green ramp. Clumps therefore
 * still read as one organism, just a green one.
 */
export function retintToPalette(color, count, opts = {}) {
  const ramp = (opts.ramp ?? ['#2f8f22', '#7dd63a', '#a8e838', '#d8ff9a'])
    .map(h => new THREE.Color(h));
  const jitter = opts.hueJitter ?? 0.03;
  const c = new THREE.Color();
  const hsl = { h: 0, s: 0, l: 0 };
  const out = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    c.setRGB(color[i * 3], color[i * 3 + 1], color[i * 3 + 2]);
    c.getHSL(hsl);
    /* Their hue carries the cluster identity -- neighbouring points share it.
     * Using it as the ramp coordinate keeps that grouping intact instead of
     * scrambling it with a per-point random pick. */
    const t = (hsl.h + jitter * (Math.random() - 0.5) + 1) % 1;
    const f = t * (ramp.length - 1);
    const i0 = Math.min(ramp.length - 1, Math.floor(f));
    const i1 = Math.min(ramp.length - 1, i0 + 1);
    c.copy(ramp[i0]).lerp(ramp[i1], f - i0);
    // carry their per-point brightness so the bake's internal shading survives
    c.multiplyScalar(0.55 + hsl.l * 0.9);
    out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b;
  }
  return out;
}
