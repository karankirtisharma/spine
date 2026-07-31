import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * GPU fluid background — Stam-style semi-Lagrangian Navier-Stokes solver.
 *
 * Pass shaders transcribed from Active Theory's own assets/shaders/compiled.vs
 * (fluidBase.vs, advectionShader.fs, divergenceShader.fs, curlShader.fs,
 * vorticityShader.fs, pressureShader.fs, gradientSubtractShader.fs,
 * splatShader.fs) — the same solver that drives tFluid in GlobalComposite.
 * The splat is a line segment (prevPoint -> point), which is what produces
 * continuous trails rather than dotted blobs.
 *
 * Output is a plain THREE.Texture for `scene.background`, so it is always
 * drawn behind every object and can never occlude the scene.
 */

const BASE_VS = /* glsl */`
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform vec2 texelSize;
void main () {
    vUv = uv;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(position, 1.0);
}`;

const ADVECTION_FS = /* glsl */`
varying vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform float dt;
uniform float dissipation;
void main () {
    vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
    gl_FragColor = dissipation * texture2D(uSource, coord);
    gl_FragColor.a = 1.0;
}`;

const DIVERGENCE_FS = /* glsl */`
varying highp vec2 vUv, vL, vR, vT, vB;
uniform sampler2D uVelocity;
void main () {
    float L = texture2D(uVelocity, vL).x;
    float R = texture2D(uVelocity, vR).x;
    float T = texture2D(uVelocity, vT).y;
    float B = texture2D(uVelocity, vB).y;
    vec2 C = texture2D(uVelocity, vUv).xy;
    if (vL.x < 0.0) { L = -C.x; }
    if (vR.x > 1.0) { R = -C.x; }
    if (vT.y > 1.0) { T = -C.y; }
    if (vB.y < 0.0) { B = -C.y; }
    float div = 0.5 * (R - L + T - B);
    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
}`;

const CURL_FS = /* glsl */`
varying highp vec2 vUv, vL, vR, vT, vB;
uniform sampler2D uVelocity;
void main () {
    float L = texture2D(uVelocity, vL).y;
    float R = texture2D(uVelocity, vR).y;
    float T = texture2D(uVelocity, vT).x;
    float B = texture2D(uVelocity, vB).x;
    float vorticity = R - L - T + B;
    gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
}`;

const VORTICITY_FS = /* glsl */`
varying vec2 vUv, vL, vR, vT, vB;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main () {
    float L = texture2D(uCurl, vL).x;
    float R = texture2D(uCurl, vR).x;
    float T = texture2D(uCurl, vT).x;
    float B = texture2D(uCurl, vB).x;
    float C = texture2D(uCurl, vUv).x;
    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curl * C;
    force.y *= -1.0;
    vec2 vel = texture2D(uVelocity, vUv).xy;
    gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);
}`;

const PRESSURE_FS = /* glsl */`
varying highp vec2 vUv, vL, vR, vT, vB;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main () {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    float divergence = texture2D(uDivergence, vUv).x;
    gl_FragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRADIENT_FS = /* glsl */`
varying highp vec2 vUv, vL, vR, vT, vB;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main () {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity.xy -= vec2(R - L, T - B);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
}`;

const SPLAT_FS = /* glsl */`
varying vec2 vUv;
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform vec2 prevPoint;
uniform float radius;
uniform float uAdd;
float blendScreen(float base, float blend) { return 1.0-((1.0-base)*(1.0-blend)); }
vec3 blendScreen(vec3 base, vec3 blend) {
    return vec3(blendScreen(base.r, blend.r), blendScreen(base.g, blend.g), blendScreen(base.b, blend.b));
}
float l(vec2 uv, vec2 point1, vec2 point2) {
    vec2 pa = uv - point1, ba = point2 - point1;
    pa.x *= aspectRatio;
    ba.x *= aspectRatio;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
}
float cubicOut(float t) { float f = t - 1.0; return f * f * f + 1.0; }
void main () {
    vec3 splat = (1.0 - cubicOut(clamp(l(vUv, prevPoint.xy, point.xy) / radius, 0.0, 1.0))) * color;
    vec3 base = texture2D(uTarget, vUv).xyz;
    gl_FragColor = vec4(mix(blendScreen(base, splat), base + splat, uAdd), 1.0);
}`;

const DISPLAY_FS = /* glsl */`
varying vec2 vUv;
uniform sampler2D uTexture;
uniform float uIntensity;
void main () {
    vec3 c = texture2D(uTexture, vUv).rgb * uIntensity;
    float vig = smoothstep(1.30, 0.10, length(vUv - 0.5));
    gl_FragColor = vec4(c * mix(0.55, 1.0, vig), 1.0);
}`;

function makeRT(w, h, type, filter) {
  return new THREE.WebGLRenderTarget(w, h, {
    minFilter: filter, magFilter: filter,
    format: THREE.RGBAFormat, type,
    depthBuffer: false, stencilBuffer: false,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
}

function pingPong(w, h, type, filter) {
  let a = makeRT(w, h, type, filter), b = makeRT(w, h, type, filter);
  return {
    get read() { return a; }, get write() { return b; },
    swap() { const t = a; a = b; b = t; },
    setSize(w2, h2) { a.setSize(w2, h2); b.setSize(w2, h2); },
    dispose() { a.dispose(); b.dispose(); },
  };
}

export class FluidBackground {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.enabled = true;

    const gl = renderer.getContext();
    const isWebGL2 = renderer.capabilities.isWebGL2;
    const canFloat = isWebGL2
      ? !!gl.getExtension('EXT_color_buffer_float')
      : !!gl.getExtension('OES_texture_half_float');
    if (!canFloat) { this.enabled = false; return; }

    const linearOK = isWebGL2 || !!gl.getExtension('OES_texture_half_float_linear');
    this.filter = linearOK ? THREE.LinearFilter : THREE.NearestFilter;
    this.type = THREE.HalfFloatType;

    this.simRes = opts.simRes ?? 128;
    this.dyeRes = opts.dyeRes ?? 512;
    this.iterations = opts.iterations ?? 18;
    this.curlStrength = opts.curl ?? 26;
    // dye persists long enough to read as a backdrop, not a brief flash
    this.velocityDissipation = opts.velocityDissipation ?? 0.994;
    this.densityDissipation = opts.densityDissipation ?? 0.9975;
    this.splatRadius = opts.splatRadius ?? 0.19;
    this.aspect = 1;

    this.velocity = pingPong(this.simRes, this.simRes, this.type, this.filter);
    this.density = pingPong(this.dyeRes, this.dyeRes, this.type, this.filter);
    this.pressure = pingPong(this.simRes, this.simRes, this.type, THREE.NearestFilter);
    this.divergence = makeRT(this.simRes, this.simRes, this.type, THREE.NearestFilter);
    this.curl = makeRT(this.simRes, this.simRes, this.type, THREE.NearestFilter);
    this.output = makeRT(this.dyeRes, this.dyeRes, THREE.UnsignedByteType, THREE.LinearFilter);
    this.output.texture.colorSpace = THREE.SRGBColorSpace;

    const mk = (fs, uniforms) => new THREE.ShaderMaterial({
      vertexShader: BASE_VS, fragmentShader: fs,
      uniforms: { texelSize: { value: new THREE.Vector2() }, ...uniforms },
      depthTest: false, depthWrite: false,
    });

    this.mAdvect = mk(ADVECTION_FS, {
      uVelocity: { value: null }, uSource: { value: null },
      dt: { value: 0 }, dissipation: { value: 1 },
    });
    this.mDivergence = mk(DIVERGENCE_FS, { uVelocity: { value: null } });
    this.mCurl = mk(CURL_FS, { uVelocity: { value: null } });
    this.mVorticity = mk(VORTICITY_FS, {
      uVelocity: { value: null }, uCurl: { value: null },
      curl: { value: this.curlStrength }, dt: { value: 0 },
    });
    this.mPressure = mk(PRESSURE_FS, { uPressure: { value: null }, uDivergence: { value: null } });
    this.mGradient = mk(GRADIENT_FS, { uPressure: { value: null }, uVelocity: { value: null } });
    this.mSplat = mk(SPLAT_FS, {
      uTarget: { value: null }, aspectRatio: { value: 1 },
      color: { value: new THREE.Vector3() },
      point: { value: new THREE.Vector2() }, prevPoint: { value: new THREE.Vector2() },
      radius: { value: this.splatRadius }, uAdd: { value: 0 },
    });
    this.mDisplay = mk(DISPLAY_FS, {
      uTexture: { value: null }, uIntensity: { value: opts.intensity ?? 0.5 },
    });

    this.quad = new FullScreenQuad();
    this.pointer = new THREE.Vector2(0.5, 0.5);
    this.prevPointer = new THREE.Vector2(0.5, 0.5);
    this.pointerMoved = false;
    this._idle = 0;
    this._hue = Math.random();
    this._c = new THREE.Color();
    this._v = new THREE.Vector3();
  }

  get texture() { return this.enabled ? this.output.texture : null; }

  setSize(width, height) {
    if (!this.enabled) return;
    this.aspect = width / height;
    this.mSplat.uniforms.aspectRatio.value = this.aspect;
    const dyeW = Math.round(this.dyeRes * this.aspect);
    this.density.setSize(dyeW, this.dyeRes);
    this.output.setSize(dyeW, this.dyeRes);
  }

  setPointer(x, y) {
    this.prevPointer.copy(this.pointer);
    this.pointer.set(x, y);
    this.pointerMoved = true;
  }

  _blit(material, target, texelW, texelH) {
    material.uniforms.texelSize.value.set(1 / texelW, 1 / texelH);
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  _splat(x, y, px, py, color, radius) {
    const S = this.simRes, D = this.density.read;
    const u = this.mSplat.uniforms;
    u.point.value.set(x, y);
    u.prevPoint.value.set(px, py);
    u.radius.value = radius;

    u.color.value.set((x - px) * 900, (y - py) * 900, 0);
    u.uAdd.value = 1;
    u.uTarget.value = this.velocity.read.texture;
    this._blit(this.mSplat, this.velocity.write, S, S);
    this.velocity.swap();

    u.color.value.copy(color);
    u.uAdd.value = 0;
    u.uTarget.value = this.density.read.texture;
    this._blit(this.mSplat, this.density.write, D.width, D.height);
    this.density.swap();
  }

  update(dt) {
    if (!this.enabled) return;
    const step = Math.min(dt, 1 / 30);
    const S = this.simRes;
    const D = this.density.read;
    const prevTarget = this.renderer.getRenderTarget();
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;

    if (this.pointerMoved &&
        (Math.abs(this.pointer.x - this.prevPointer.x) > 1e-4 ||
         Math.abs(this.pointer.y - this.prevPointer.y) > 1e-4)) {
      this._idle = 0;
      this._c.setHSL((this._hue += 0.006) % 1, 0.85, 0.55);
      this._splat(this.pointer.x, this.pointer.y, this.prevPointer.x, this.prevPointer.y,
        this._v.set(this._c.r, this._c.g, this._c.b), this.splatRadius);
      this.prevPointer.copy(this.pointer);
    } else {
      this._idle += step;
      if (this._idle > 0.16) {
        this._idle = 0;
        const t = performance.now() * 0.0004;
        const x = 0.5 + Math.cos(t * 1.3) * 0.34;
        const y = 0.5 + Math.sin(t * 0.9) * 0.30;
        const px = 0.5 + Math.cos(t * 1.3 - 0.09) * 0.34;
        const py = 0.5 + Math.sin(t * 0.9 - 0.09) * 0.30;
        this._c.setHSL((this._hue += 0.012) % 1, 0.8, 0.5);
        this._splat(x, y, px, py,
          this._v.set(this._c.r, this._c.g, this._c.b), this.splatRadius * 1.5);
      }
    }
    this.pointerMoved = false;

    this.mCurl.uniforms.uVelocity.value = this.velocity.read.texture;
    this._blit(this.mCurl, this.curl, S, S);

    this.mVorticity.uniforms.uVelocity.value = this.velocity.read.texture;
    this.mVorticity.uniforms.uCurl.value = this.curl.texture;
    this.mVorticity.uniforms.dt.value = step;
    this._blit(this.mVorticity, this.velocity.write, S, S);
    this.velocity.swap();

    this.mDivergence.uniforms.uVelocity.value = this.velocity.read.texture;
    this._blit(this.mDivergence, this.divergence, S, S);

    this.renderer.setRenderTarget(this.pressure.read);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clearColor();

    this.mPressure.uniforms.uDivergence.value = this.divergence.texture;
    for (let i = 0; i < this.iterations; i++) {
      this.mPressure.uniforms.uPressure.value = this.pressure.read.texture;
      this._blit(this.mPressure, this.pressure.write, S, S);
      this.pressure.swap();
    }

    this.mGradient.uniforms.uPressure.value = this.pressure.read.texture;
    this.mGradient.uniforms.uVelocity.value = this.velocity.read.texture;
    this._blit(this.mGradient, this.velocity.write, S, S);
    this.velocity.swap();

    this.mAdvect.uniforms.dt.value = step * 60;
    this.mAdvect.uniforms.uVelocity.value = this.velocity.read.texture;
    this.mAdvect.uniforms.uSource.value = this.velocity.read.texture;
    this.mAdvect.uniforms.dissipation.value = this.velocityDissipation;
    this._blit(this.mAdvect, this.velocity.write, S, S);
    this.velocity.swap();

    this.mAdvect.uniforms.uVelocity.value = this.velocity.read.texture;
    this.mAdvect.uniforms.uSource.value = this.density.read.texture;
    this.mAdvect.uniforms.dissipation.value = this.densityDissipation;
    this._blit(this.mAdvect, this.density.write, D.width, D.height);
    this.density.swap();

    this.mDisplay.uniforms.uTexture.value = this.density.read.texture;
    this._blit(this.mDisplay, this.output, D.width, D.height);

    this.renderer.setRenderTarget(prevTarget);
    this.renderer.autoClear = prevAutoClear;
    this.renderer.setClearColor(0x000000, 1);
  }

  dispose() {
    if (!this.enabled) return;
    this.velocity.dispose(); this.density.dispose(); this.pressure.dispose();
    this.divergence.dispose(); this.curl.dispose(); this.output.dispose();
    this.quad.dispose();
  }
}
