import * as THREE from 'three';

/* God rays from the glass mark — Active Theory's VolumetricLight.fs, LightBlur.fs
 * and the one line of HomeComposite.fs that consumes them.
 *
 * Their Home does `volumetricLight.addLight(logo)`: the mark is the light source,
 * and the shafts streaming off it are what stops their hero from reading as flat
 * particles on black. All three shaders are transcribed verbatim; the constants
 * for exposure/decay/density/weight are the classic radial-blur god-ray set, which
 * their shader exposes as uniforms rather than authoring.
 *
 * The chain, and why it is three passes rather than one:
 *
 *   1. occlusion  the scene rendered so that only the light source is bright.
 *                 Here that is a single render with the mark visible and the
 *                 columns and plume hidden, at quarter resolution -- the rays are
 *                 a wide blur, so resolution buys nothing.
 *   2. rays       VolumetricLight.fs marches 20 samples per pixel toward the
 *                 light's SCREEN position, decaying as it goes. That march is the
 *                 whole effect: it smears the bright source outward along the
 *                 view ray.
 *   3. blur       LightBlur.fs, twice, separable -- their blur9 horizontally then
 *                 vertically. Without it the 20-sample march shows as 20 discrete
 *                 steps, which reads as banding rather than light.
 *
 * The result is added into the composite, exactly as HomeComposite.fs does:
 *
 *   color += texture2D(tVolumetricBlur, vUv).rgb * uVolumetricStrength;
 */

const QUAD_VS = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/* gaussianblur.fs — their blur9, the standard 9-tap with linear-sampling offsets
 * (1.3846 / 3.2308), which is what makes 9 taps cover 17 pixels. */
const RAYS_FS = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 lightPos;
  uniform float fExposure;
  uniform float fDecay;
  uniform float fDensity;
  uniform float fWeight;
  uniform float fClamp;
  varying vec2 vUv;

  const int iSamples = 20;

  void main() {
    vec2 deltaTextCoord = vUv - lightPos;
    deltaTextCoord *= 1.0 / float(iSamples) * fDensity;
    vec2 coord = vUv;

    float illuminationDecay = 1.0;
    vec4 color = vec4(0.0);

    for (int i = 0; i < iSamples; i++) {
      coord -= deltaTextCoord;
      vec4 texel = texture2D(tDiffuse, coord);
      texel *= illuminationDecay * fWeight;

      color += texel;
      illuminationDecay *= fDecay;
    }

    color *= fExposure;
    color = clamp(color, 0.0, fClamp);
    gl_FragColor = color;
  }
`;

const BLUR_FS = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 uDir;
  uniform vec2 resolution;
  varying vec2 vUv;

  vec4 blur9(sampler2D image, vec2 uv, vec2 res, vec2 direction) {
    vec4 color = vec4(0.0);
    vec2 off1 = vec2(1.3846153846) * direction;
    vec2 off2 = vec2(3.2307692308) * direction;
    color += texture2D(image, uv) * 0.2270270270;
    color += texture2D(image, uv + (off1 / res)) * 0.3162162162;
    color += texture2D(image, uv - (off1 / res)) * 0.3162162162;
    color += texture2D(image, uv + (off2 / res)) * 0.0702702703;
    color += texture2D(image, uv - (off2 / res)) * 0.0702702703;
    return color;
  }

  void main() {
    gl_FragColor = blur9(tDiffuse, vUv, resolution, uDir);
  }
`;

/**
 * @param renderer
 * @param opts.scale   fraction of the frame the chain runs at (0.25 by default)
 * @param opts.tint    the rays are multiplied by this — their light is warm white,
 *                     ours takes the pale end of the green ramp
 */
export function buildVolumetricLight(renderer, opts = {}) {
  const scale = opts.scale ?? 0.25;
  const rt = () => new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
  });
  const occlusion = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
  });
  const a = rt(), b = rt();
  /* Two OUTPUT targets, alternated per frame, and this is not an optimisation.
   *
   * The composite samples this chain's result every frame, and three does not unbind
   * textures between draws -- so the result texture is still sitting on a texture
   * unit when the next frame binds it as a framebuffer. WebGL calls that a feedback
   * loop and drops the draw: GL_INVALID_OPERATION, every frame, and the pass silently
   * produces nothing. Handing out the one written LAST frame while writing the other
   * means the two never coincide. */
  const out = [rt(), rt()];
  let flip = 0;

  const raysMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VS, fragmentShader: RAYS_FS,
    uniforms: {
      tDiffuse: { value: occlusion.texture },
      lightPos: { value: new THREE.Vector2(0.5, 0.5) },
      /* Their names, standard values. fDensity 0.5 sets how far along the view ray
       * the march reaches, fDecay 0.94 how fast it fades, and fClamp caps the
       * accumulation so a very bright source cannot blow the whole frame. */
      fExposure: { value: opts.exposure ?? 0.32 },
      fDecay: { value: opts.decay ?? 0.94 },
      fDensity: { value: opts.density ?? 0.5 },
      fWeight: { value: opts.weight ?? 0.32 },
      fClamp: { value: opts.clamp ?? 1.0 },
    },
    depthTest: false, depthWrite: false,
  });
  const blurMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VS, fragmentShader: BLUR_FS,
    uniforms: {
      tDiffuse: { value: null },
      uDir: { value: new THREE.Vector2(1, 0) },
      resolution: { value: new THREE.Vector2(1, 1) },
    },
    depthTest: false, depthWrite: false,
  });

  // one fullscreen triangle-pair, reused for all three passes
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), raysMat);
  quad.frustumCulled = false;
  quadScene.add(quad);

  const projected = new THREE.Vector3();
  const prevClear = new THREE.Color();
  let w = 0, h = 0;

  return {
    /* Dynamic, because the output target alternates -- see `out` above. Callers
     * must read this every frame rather than caching it once. */
    get texture() { return out[flip].texture; },
    tint: new THREE.Color(opts.tint ?? '#cdf59a'),

    setSize(fullW, fullH) {
      w = Math.max(1, Math.round(fullW * scale));
      h = Math.max(1, Math.round(fullH * scale));
      occlusion.setSize(w, h); a.setSize(w, h); b.setSize(w, h);
      out[0].setSize(w, h); out[1].setSize(w, h);
      blurMat.uniforms.resolution.value.set(w, h);
    },

    /**
     * Render the chain for one frame.
     *
     * @param scene    the live scene
     * @param camera
     * @param lightObj the object acting as the light source
     * @param hide     objects to hide for the occlusion pass — everything that is
     *                 not the source, so the source is the only bright thing in it
     */
    render(scene, camera, lightObj, hide) {
      // the march is in screen space, so the source's NDC position is the input
      lightObj.getWorldPosition(projected).project(camera);
      raysMat.uniforms.lightPos.value.set(
        projected.x * 0.5 + 0.5, projected.y * 0.5 + 0.5);

      const hidden = [];
      for (const o of hide) if (o && o.visible) { o.visible = false; hidden.push(o); }

      /* The occlusion pass must be BLACK where there is no light, and that means
       * dropping the scene background for it.
       *
       * This is the single thing that makes or breaks the effect. The march at
       * step 2 smears whatever it finds outward from the light -- so with the
       * scene's backdrop still in the buffer it smears the backdrop, and since our
       * backdrop is a flat dark green covering every pixel, the result was a green
       * wash over the entire frame rather than shafts. Which is exactly what it
       * looked like: not god rays, a green flood.
       *
       * Only `background` is swapped, never `fog`. `fog: !!fog` is in three's
       * program cache key and drives #define USE_FOG, so nulling the fog here
       * would recompile every lit material in the scene twice a frame. Background
       * is drawn separately and is not in the key. */
      const prevBg = scene.background;
      renderer.getClearColor(prevClear);
      const prevAlpha = renderer.getClearAlpha();
      scene.background = null;
      renderer.setClearColor(0x000000, 1);

      renderer.setRenderTarget(occlusion);
      renderer.clear();
      renderer.render(scene, camera);

      scene.background = prevBg;
      renderer.setClearColor(prevClear, prevAlpha);
      for (const o of hidden) o.visible = true;

      quad.material = raysMat;
      renderer.setRenderTarget(a);
      renderer.render(quadScene, quadCam);

      // separable: horizontal into b, then vertical back into b via a
      quad.material = blurMat;
      blurMat.uniforms.tDiffuse.value = a.texture;
      blurMat.uniforms.uDir.value.set(1, 0);
      renderer.setRenderTarget(b);
      renderer.render(quadScene, quadCam);

      blurMat.uniforms.tDiffuse.value = b.texture;
      blurMat.uniforms.uDir.value.set(0, 1);
      renderer.setRenderTarget(a);
      renderer.render(quadScene, quadCam);

      /* Final vertical pass straight into the output target the composite is NOT
       * currently sampling. blur9 with a zero direction would be an exact copy
       * (all five taps land on the same texel and the weights sum to 1), so this
       * does real work rather than costing a blit. */
      flip = 1 - flip;
      blurMat.uniforms.tDiffuse.value = a.texture;
      blurMat.uniforms.uDir.value.set(0, 1);
      renderer.setRenderTarget(out[flip]);
      renderer.render(quadScene, quadCam);

      renderer.setRenderTarget(null);
    },
  };
}
