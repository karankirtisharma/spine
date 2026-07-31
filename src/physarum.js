import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Physarum ("fiber") background — slime-mould agent simulation.
 *
 * Ported from the algorithm and default parameters in
 * amandaghassaei/gpu-io → examples/physarum (MIT). Implemented natively on
 * three.js render targets rather than vendoring gpu-io, so it shares this
 * renderer's context instead of standing up a second one.
 *
 *   decayFactor 0.9 · depositAmount 4 · particleDensity 0.35
 *   sensorDistance 18 · sensorAngle 5.5° · stepSize 2
 *   rotationAngle 45° · renderAmplitude 0.03
 *
 * Each agent samples the trail at three angles around its heading, turns
 * toward the strongest, steps forward and deposits. The trail is then blurred
 * and decayed. Emergent transport networks — the fibers — come out of that.
 *
 * Output is a plain THREE.Texture for `scene.background`, so it always draws
 * behind every object and can never occlude the scene.
 */

const QUAD_VS = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`;

const INIT_FS = /* glsl */`
varying vec2 vUv;
uniform vec2 uDims;
uniform float uSeed;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
    float a = hash(vUv + uSeed);
    float b = hash(vUv * 1.7 + uSeed + 3.1);
    float c = hash(vUv * 2.3 + uSeed + 7.7);
    gl_FragColor = vec4(a * uDims.x, b * uDims.y, c * 6.2831853, 1.0);
}`;

const UPDATE_FS = /* glsl */`
varying vec2 vUv;
uniform sampler2D uParticles;
uniform sampler2D uTrail;
uniform vec2 uDims;
uniform float uSensorDistance;
uniform float uSensorAngle;
uniform float uRotationAngle;
uniform float uStepSize;
uniform float uTime;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float sense(vec2 pos, float angle) {
    vec2 s = pos + vec2(cos(angle), sin(angle)) * uSensorDistance;
    // toroidal domain
    s = mod(s + uDims, uDims);
    return texture2D(uTrail, s / uDims).x;
}

void main() {
    vec4 p = texture2D(uParticles, vUv);
    vec2 pos = p.xy;
    float heading = p.z;

    float c = sense(pos, heading);
    float l = sense(pos, heading + uSensorAngle);
    float r = sense(pos, heading - uSensorAngle);

    if (c > l && c > r) {
        // keep going
    } else if (c < l && c < r) {
        // both sides better — pick one at random
        float rnd = hash(vUv + uTime);
        heading += (rnd < 0.5 ? -1.0 : 1.0) * uRotationAngle;
    } else if (l < r) {
        heading -= uRotationAngle;
    } else if (r < l) {
        heading += uRotationAngle;
    }

    pos += vec2(cos(heading), sin(heading)) * uStepSize;
    pos = mod(pos + uDims, uDims);

    gl_FragColor = vec4(pos, heading, 1.0);
}`;

// agents are drawn as points; each vertex fetches its own position
const DEPOSIT_VS = /* glsl */`
attribute vec2 aRef;
uniform sampler2D uParticles;
uniform vec2 uDims;
void main() {
    vec4 p = texture2D(uParticles, aRef);
    vec2 clip = (p.xy / uDims) * 2.0 - 1.0;
    gl_PointSize = 1.0;
    gl_Position = vec4(clip, 0.0, 1.0);
}`;

const DEPOSIT_FS = /* glsl */`
uniform float uDeposit;
void main() { gl_FragColor = vec4(uDeposit, uDeposit, uDeposit, 1.0); }`;

const DIFFUSE_FS = /* glsl */`
varying vec2 vUv;
uniform sampler2D uTrail;
uniform vec2 uTexel;
uniform float uDecay;
void main() {
    // four linear taps average a 3x3 neighbourhood, then decay
    vec4 sum = texture2D(uTrail, vUv + vec2( uTexel.x,  uTexel.y))
             + texture2D(uTrail, vUv + vec2(-uTexel.x,  uTexel.y))
             + texture2D(uTrail, vUv + vec2( uTexel.x, -uTexel.y))
             + texture2D(uTrail, vUv + vec2(-uTexel.x, -uTexel.y));
    gl_FragColor = (sum * 0.25) * uDecay;
}`;

// separable gaussian, run at quarter resolution to build the fiber halo
const BLUR_FS = /* glsl */`
varying vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uDir;
void main() {
    vec4 c = texture2D(uSrc, vUv) * 0.227027;
    c += (texture2D(uSrc, vUv + uDir * 1.3846) + texture2D(uSrc, vUv - uDir * 1.3846)) * 0.316216;
    c += (texture2D(uSrc, vUv + uDir * 3.2308) + texture2D(uSrc, vUv - uDir * 3.2308)) * 0.070270;
    gl_FragColor = c;
}`;

const RENDER_FS = /* glsl */`
varying vec2 vUv;
uniform sampler2D uTrail;
uniform sampler2D uGlow;
uniform float uGlowStrength;
uniform float uGlowGain;
uniform float uAmplitude;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform float uDim;
void main() {
    float v = texture2D(uTrail, vUv).x * uAmplitude;
    v = clamp(v, 0.0, 1.0);
    // ramp the scalar field into the scene's palette
    vec3 c = mix(uColorA, uColorB, smoothstep(0.0, 0.55, v));
    c = mix(c, uColorC, smoothstep(0.5, 1.0, v));
    c *= smoothstep(0.0, 0.18, v);

    /* Halo. The scene's UnrealBloom threshold sits well above these values, so
     * the fibers would never bloom on their own — this bakes the glow in at
     * quarter res instead of brightening them past the threshold, which would
     * blow the backdrop out. */
    /* Halo needs its own gain and a soft knee, not a power curve. The blurred
     * trail is already a small number, so pow() on it collapses the glow to
     * nothing; smoothstep instead gates the dim field out while letting the
     * bright filaments come through at full strength. */
    float g = clamp(texture2D(uGlow, vUv).x * uAmplitude * uGlowGain, 0.0, 1.0);
    // higher knee + gentle curve: only the densest strands pick up any halo,
    // and it stays a soft bloom rather than a lit tube
    float glow = smoothstep(0.18, 0.85, g);
    c += uColorC * glow * uGlowStrength;

    // faint core, tinted green so it never clips toward white
    c += vec3(0.62, 1.0, 0.55) * pow(clamp(v * 1.1, 0.0, 1.0), 5.0) * 0.10;

    float vig = smoothstep(1.30, 0.12, length(vUv - 0.5));
    gl_FragColor = vec4(c * mix(0.55, 1.0, vig) * uDim, 1.0);
}`;

function makeRT(w, h, type, filter) {
  return new THREE.WebGLRenderTarget(w, h, {
    minFilter: filter, magFilter: filter,
    format: THREE.RGBAFormat, type,
    depthBuffer: false, stencilBuffer: false,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
}

export class PhysarumBackground {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.enabled = true;

    const gl = renderer.getContext();
    const isWebGL2 = renderer.capabilities.isWebGL2;
    // agent positions are in pixels, so they need full float precision
    const canFloat = isWebGL2 && !!gl.getExtension('EXT_color_buffer_float');
    if (!canFloat) { this.enabled = false; return; }

    this.trailW = opts.trailWidth ?? 1024;
    this.trailH = opts.trailHeight ?? 640;
    // gpu-io default particleDensity 0.35; clamp so this stays a background cost
    const wanted = Math.floor(this.trailW * this.trailH * (opts.density ?? 0.35));
    this.ptSize = Math.min(opts.maxParticleTex ?? 512,
      Math.pow(2, Math.ceil(Math.log2(Math.sqrt(wanted)))));
    this.count = this.ptSize * this.ptSize;

    /* gpu-io's defaults are tuned for a full-resolution canvas (~1920 wide).
     * This trail is 1024, so the sensor/step distances are scaled down to keep
     * the network fine rather than ropey. */
    this.deposit = opts.depositAmount ?? 4;
    this.decay = opts.decayFactor ?? 0.92;
    this.sensorDistance = opts.sensorDistance ?? 6;
    this.sensorAngle = THREE.MathUtils.degToRad(opts.sensorAngle ?? 5.5);
    this.rotationAngle = THREE.MathUtils.degToRad(opts.rotationAngle ?? 45);
    this.stepSize = opts.stepSize ?? 1;
    this.amplitude = opts.renderAmplitude ?? 0.02;

    const F = THREE.FloatType, H = THREE.HalfFloatType;
    this.pA = makeRT(this.ptSize, this.ptSize, F, THREE.NearestFilter);
    this.pB = makeRT(this.ptSize, this.ptSize, F, THREE.NearestFilter);
    this.tA = makeRT(this.trailW, this.trailH, H, THREE.LinearFilter);
    this.tB = makeRT(this.trailW, this.trailH, H, THREE.LinearFilter);
    // quarter-res ping-pong for the halo blur
    this.glowW = Math.max(1, this.trailW >> 2);
    this.glowH = Math.max(1, this.trailH >> 2);
    this.gA = makeRT(this.glowW, this.glowH, H, THREE.LinearFilter);
    this.gB = makeRT(this.glowW, this.glowH, H, THREE.LinearFilter);
    this.output = makeRT(this.trailW, this.trailH, THREE.UnsignedByteType, THREE.LinearFilter);
    this.output.texture.colorSpace = THREE.SRGBColorSpace;

    const dims = new THREE.Vector2(this.trailW, this.trailH);
    const mk = (fs, uniforms) => new THREE.ShaderMaterial({
      vertexShader: QUAD_VS, fragmentShader: fs, uniforms,
      depthTest: false, depthWrite: false,
    });

    this.mInit = mk(INIT_FS, { uDims: { value: dims }, uSeed: { value: Math.random() * 100 } });
    this.mUpdate = mk(UPDATE_FS, {
      uParticles: { value: null }, uTrail: { value: null }, uDims: { value: dims },
      uSensorDistance: { value: this.sensorDistance },
      uSensorAngle: { value: this.sensorAngle },
      uRotationAngle: { value: this.rotationAngle },
      uStepSize: { value: this.stepSize },
      uTime: { value: 0 },
    });
    this.mDiffuse = mk(DIFFUSE_FS, {
      uTrail: { value: null },
      uTexel: { value: new THREE.Vector2(1 / this.trailW, 1 / this.trailH) },
      uDecay: { value: this.decay },
    });
    this.mBlur = mk(BLUR_FS, {
      uSrc: { value: null }, uDir: { value: new THREE.Vector2() },
    });
    this.mRender = mk(RENDER_FS, {
      uTrail: { value: null }, uAmplitude: { value: this.amplitude },
      uGlow: { value: null },
      uGlowStrength: { value: opts.glowStrength ?? 0.30 },
      // the blur drops peak values well below the core's, so the halo needs
      // its own gain before the knee rather than reusing uAmplitude alone
      uGlowGain: { value: opts.glowGain ?? 3.2 },
      /* Kept dim on purpose: this is a backdrop, not a subject. Ramp runs to
       * the same green the spine emits, so the fibers read as light spilling
       * off the column rather than an unrelated violet field. */
      uColorA: { value: new THREE.Color(opts.colorA ?? '#020604') },
      uColorB: { value: new THREE.Color(opts.colorB ?? '#12451c') },
      uColorC: { value: new THREE.Color(opts.colorC ?? '#7dd63a') },
      uDim: { value: opts.dim ?? 0.30 },
    });

    // point cloud used for the deposit pass
    const refs = new Float32Array(this.count * 2);
    for (let i = 0; i < this.count; i++) {
      refs[i * 2] = ((i % this.ptSize) + 0.5) / this.ptSize;
      refs[i * 2 + 1] = (Math.floor(i / this.ptSize) + 0.5) / this.ptSize;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.count * 3), 3));
    g.setAttribute('aRef', new THREE.BufferAttribute(refs, 2));
    this.depositMat = new THREE.ShaderMaterial({
      vertexShader: DEPOSIT_VS, fragmentShader: DEPOSIT_FS,
      uniforms: {
        uParticles: { value: null }, uDims: { value: dims },
        uDeposit: { value: this.deposit },
      },
      transparent: true, blending: THREE.AdditiveBlending,
      depthTest: false, depthWrite: false,
    });
    this.points = new THREE.Points(g, this.depositMat);
    this.points.frustumCulled = false;
    this.depositScene = new THREE.Scene();
    this.depositScene.add(this.points);
    this.depositCam = new THREE.Camera();

    this.quad = new FullScreenQuad();
    this._seeded = false;
    this._t = 0;
  }

  get texture() { return this.enabled ? this.output.texture : null; }

  _blit(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  _clear(target) {
    this.renderer.setRenderTarget(target);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clearColor();
  }

  update(dt) {
    if (!this.enabled) return;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    this._t += dt;

    if (!this._seeded) {
      this._seeded = true;
      this._blit(this.mInit, this.pA);
      this._clear(this.tA);
      this._clear(this.tB);
    }

    // 1. sense + steer + step
    this.mUpdate.uniforms.uParticles.value = this.pA.texture;
    this.mUpdate.uniforms.uTrail.value = this.tA.texture;
    this.mUpdate.uniforms.uTime.value = this._t;
    this._blit(this.mUpdate, this.pB);
    const pt = this.pA; this.pA = this.pB; this.pB = pt;

    // 2. deposit onto the existing trail (additive, no clear)
    this.depositMat.uniforms.uParticles.value = this.pA.texture;
    r.setRenderTarget(this.tA);
    r.render(this.depositScene, this.depositCam);

    // 3. diffuse + decay
    this.mDiffuse.uniforms.uTrail.value = this.tA.texture;
    this._blit(this.mDiffuse, this.tB);
    const tt = this.tA; this.tA = this.tB; this.tB = tt;

    // 4. halo — downsample then separable gaussian, two widening passes
    this.mBlur.uniforms.uSrc.value = this.tA.texture;
    this.mBlur.uniforms.uDir.value.set(1 / this.glowW, 0);
    this._blit(this.mBlur, this.gA);
    this.mBlur.uniforms.uSrc.value = this.gA.texture;
    this.mBlur.uniforms.uDir.value.set(0, 1 / this.glowH);
    this._blit(this.mBlur, this.gB);
    this.mBlur.uniforms.uSrc.value = this.gB.texture;
    this.mBlur.uniforms.uDir.value.set(2.5 / this.glowW, 0);
    this._blit(this.mBlur, this.gA);
    this.mBlur.uniforms.uSrc.value = this.gA.texture;
    this.mBlur.uniforms.uDir.value.set(0, 2.5 / this.glowH);
    this._blit(this.mBlur, this.gB);

    // 5. colourise
    this.mRender.uniforms.uTrail.value = this.tA.texture;
    this.mRender.uniforms.uGlow.value = this.gB.texture;
    this._blit(this.mRender, this.output);

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    r.setClearColor(0x000000, 1);
  }

  setSize() { /* fixed simulation domain; the texture is stretched to fit */ }

  dispose() {
    if (!this.enabled) return;
    this.pA.dispose(); this.pB.dispose();
    this.tA.dispose(); this.tB.dispose();
    this.gA.dispose(); this.gB.dispose();
    this.output.dispose();
    this.points.geometry.dispose();
    this.quad.dispose();
  }
}

