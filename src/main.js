import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import Lenis from 'lenis';

import { PROJECTS, shuffled } from './projects.js';
import { buildSpine, buildParticles, spinePath, SPINE_TOP } from './world.js';
import { loadSpine } from './spine-glb.js';
import { FluidBackground } from './fluid.js';
import { PhysarumBackground } from './physarum.js';
import { buildCards, CARD_ORBIT, CAM_ORBIT } from './cards.js';
import { loadEnvTexture, loadNormalTexture, makeEnvTexture, makeSharedVideoTexture } from './textures.js';

/* ---------------------------------------------------------------- */
// GLSL-style smoothstep: tolerates e0 > e1, which the original relies on
// for its smoothStep(1, 0.85, p) tail easing.
function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
const lerp = (a, b, t) => a + (b - a) * t;

const QUERY = new URLSearchParams(location.search);
const LOW = QUERY.get('q') === 'low';
const DPR = LOW ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
const PARTICLES = LOW ? 14000 : 150000;   // dense enough for the coral clumps
const BLOOM_SCALE = LOW ? 0.15 : 0.3;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------------- *
 *  Renderer
 * ---------------------------------------------------------------- */
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false, powerPreference: 'high-performance',
});
renderer.setPixelRatio(DPR);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // keeps the additive stack from clipping
renderer.toneMappingExposure = 0.62;
renderer.setClearColor(0x000000, 1);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);   // pitch black
scene.fog = new THREE.FogExp2(0x000000, 0.022); // black fog, no colour cast

// UIL: CAMERA_Element_2_Work — fov 35, position [0,0,2] inside its group
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 200);
const camGroup = new THREE.Group();
camera.position.set(0, 0, 2);
camGroup.add(camera);
scene.add(camGroup);

/* ---------------------------------------------------------------- *
 *  Shared uniforms
 * ---------------------------------------------------------------- */
const shared = {
  uTime: { value: 0 },
  uDPR: { value: DPR },
  uScrollDelta: { value: 0 },
  uResolution: { value: new THREE.Vector2(innerWidth * DPR, innerHeight * DPR) },
  uMouse: { value: new THREE.Vector2(0.5, 0.5) },
};

/* ---------------------------------------------------------------- *
 *  Refraction target — stands in for the original's WorkRefraction
 *  MRT buffer. The scene is drawn without the cards, then the cards
 *  sample it through radialBlur().
 * ---------------------------------------------------------------- */
const refractionRT = new THREE.WebGLRenderTarget(
  Math.round(innerWidth * 0.5), Math.round(innerHeight * 0.5),
  { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true }
);

/* ---------------------------------------------------------------- *
 *  World
 * ---------------------------------------------------------------- */
// particle bloom around the column
const particles = buildParticles(shared, PARTICLES);
scene.add(particles);

/* Backdrop. Both simulations render to an offscreen target that is handed to
 * scene.background, so they always draw behind every object and can never
 * overlap the spine or the cards. Pick with ?bg=fiber|fluid|off. */
const BG = QUERY.get('bg') || 'fiber';
let background = null;
if (BG === 'fiber') {
  background = new PhysarumBackground(renderer, {
    trailWidth: LOW ? 512 : 1024,
    trailHeight: LOW ? 320 : 640,
    maxParticleTex: LOW ? 256 : 512,
  });
} else if (BG === 'fluid') {
  background = new FluidBackground(renderer, {
    simRes: LOW ? 64 : 128,
    dyeRes: LOW ? 256 : 512,
    iterations: LOW ? 10 : 18,
    intensity: 0.5,
  });
}
if (background && background.enabled) {
  background.setSize(innerWidth, innerHeight);
  scene.background = background.texture;
} else if (background) {
  console.warn(`${BG} background disabled: required float render targets unavailable`);
  background = null;
}

// Proxy column only exists as a fallback if the GLB fails to load.
const proxy = buildSpine(shared);
proxy.visible = false;
scene.add(proxy);

// ?spine=off skips the model entirely; ?spine=high|max|raw picks the build
if (QUERY.get('spine') !== 'off') {
  loadSpine(shared, { quality: QUERY.get('spine') || 'high' }).then(({ group, stats }) => {
    scene.add(group);
    console.log('spine.glb', stats);
  }).catch(e => { proxy.visible = true; console.warn('spine.glb failed:', e.message); });
} else {
  proxy.visible = true;
}

// Active Theory's own tEnv / tNormal, straight off activetheory.net
const envTex = loadEnvTexture();
const normalTex = loadNormalTexture();
const video = makeSharedVideoTexture();

/* Light the GLB with an IBL rather than recolouring it, so its baked
 * basecolor/normal maps read exactly as authored. Active Theory's own env1.jpg
 * is used as the source — a clearcoat needs something with actual structure to
 * reflect, and a smooth procedural gradient gives a dead-flat highlight. */
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
scene.environmentIntensity = 1.6;
// TextureLoader is async — PMREM needs the decoded image, so build it on load.
// Until then a procedural canvas env keeps reflections from popping in black.
{
  const stopgap = makeEnvTexture();
  stopgap.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = pmrem.fromEquirectangular(stopgap).texture;
  stopgap.dispose();

  new THREE.TextureLoader().load('assets/at/env1.jpg', tex => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const old = scene.environment;
    scene.environment = pmrem.fromEquirectangular(tex).texture;
    old?.dispose();
    tex.dispose();
  }, undefined, () => {
    // not fetched — the procedural stopgap above stays as the IBL
  });
}

const key = new THREE.DirectionalLight(0xbcd8ff, 2.4); key.position.set(3, 6, 4); scene.add(key);
const rim = new THREE.DirectionalLight(0x7f9dff, 1.8); rim.position.set(-4, 2, -5); scene.add(rim);
scene.add(new THREE.AmbientLight(0x2a3550, 0.55));

/* Travelling specular. Parented to the camera group so the wet highlight slides
 * across the vertebrae as the rail orbits, which is what sells the surface as
 * wet rather than merely glossy. */
const wetSpec = new THREE.PointLight(0xdCEBff, 26, 26, 2);
wetSpec.position.set(1.6, 2.4, 1.2);
camGroup.add(wetSpec);

const projects = shuffled(PROJECTS);
const { group: cardGroup, cards } = buildCards(projects, shared, {
  env: envTex, normal: normalTex, video: video.texture, refraction: refractionRT.texture,
});
scene.add(cardGroup);

document.getElementById('a11yProjects').innerHTML = projects
  .map(p => `<a href="/work/${p.perma}" aria-label="${p.title}">${p.title}</a>`).join('');

/* ---------------------------------------------------------------- *
 *  Camera rail — one waypoint per card (matches handleCameraScroll)
 * ---------------------------------------------------------------- */
// distance to the focused card lands at ~4.3 units, inside the label's
// crange(uCamDistance, 5.0, 6.0, 1.0, 0.0) visibility window
/* _cameraTargets — one per card, exactly as WorkItems.positionViews() builds
 * them: position = card position * 2, quaternion = the card's own quaternion.
 * No lead-in or tail waypoints; the original has none. */
const waypoints = cards.map(c => c.camTarget);

/* ---------------------------------------------------------------- *
 *  Scroll
 * ---------------------------------------------------------------- */
const scroller = document.getElementById('scroll');
const track = document.getElementById('track');
track.style.height = '1050vh';
let scrollProgress = 0, smoothProgress = 0, scrollDelta = 0, prevProgress = 0;
function readScroll() {
  const max = scroller.scrollHeight - scroller.clientHeight;
  scrollProgress = max > 0 ? scroller.scrollTop / max : 0;
}
scroller.addEventListener('scroll', readScroll, { passive: true });

/* Locomotive-style eased scrolling. Lenis drives the FXScroll container, so
 * wheel/touch/keyboard all get inertia instead of stepping. Reduced-motion
 * users get the native, un-smoothed scroll. */
const lenis = REDUCED ? null : new Lenis({
  wrapper: scroller,
  content: track,
  lerp: 0.075,                 // heavier glide, close to Locomotive's default feel
  wheelMultiplier: 0.9,
  touchMultiplier: 1.6,
  smoothWheel: true,
  syncTouch: true,
});
window.__lenis = lenis;   // lets tooling jump the scroll without fighting the easing

const hint = document.getElementById('hint');
let hintHidden = false;

/* ---------------------------------------------------------------- *
 *  Pointer + hover picking
 * ---------------------------------------------------------------- */
// Minimal tween matching Hydra's shader.tween(key, value, ms, ease, delay)
const easeOutSine = t => Math.sin((t * Math.PI) / 2);
const tweens = [];
function tweenUniform(uniform, to, ms, ease, delay = 0) {
  const i = tweens.findIndex(t => t.u === uniform);
  if (i > -1) tweens.splice(i, 1);
  tweens.push({ u: uniform, from: uniform.value, to, ms, ease, delay, t: 0 });
}
function stepTweens(dtMs) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    tw.t += dtMs;
    const p = (tw.t - tw.delay) / tw.ms;
    if (p <= 0) continue;
    if (p >= 1) { tw.u.value = tw.to; tweens.splice(i, 1); continue; }
    tw.u.value = tw.from + (tw.to - tw.from) * tw.ease(p);
  }
}

const pointer = new THREE.Vector2(0, 0);       // NDC, for raycasting
const mouse01 = new THREE.Vector2(0.5, 0.5);   // 0..1, what the shaders expect
addEventListener('pointermove', e => {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  mouse01.set(e.clientX / innerWidth, e.clientY / innerHeight);
  // fluid wants GL orientation (y up)
  background?.setPointer?.(e.clientX / innerWidth, 1 - e.clientY / innerHeight);
});
const raycaster = new THREE.Raycaster();
let hovered = null;
let activeVideoCard = null;

// WorkItem.onClick guards on `_this.__distToCamera > 30` before navigating
addEventListener('click', () => {
  if (!hovered || hovered._dist > 30) return;
  history.pushState(null, '', `/work/${hovered.project.perma}`);
  document.title = `${hovered.project.title} · Active Theory`;
});

/* ---------------------------------------------------------------- *
 *  Post
 * ---------------------------------------------------------------- */
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// threshold sits just under the spine's emissive so the column blooms while
// the cards and particles keep their edges
const bloom = new UnrealBloomPass(
  new THREE.Vector2(innerWidth * BLOOM_SCALE, innerHeight * BLOOM_SCALE), 0.72, 0.55, 0.58);
composer.addPass(bloom);

const CompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 }, uScroll: { value: 0 }, uScrollDelta: { value: 0 },
    uGradient: { value: new THREE.Vector2(0.02, 0.9) },
    uResolution: { value: new THREE.Vector2(innerWidth, innerHeight) },
    uUIColor: { value: new THREE.Color('#8a8bcf') }, uUIBlend: { value: 0 },
    // fiber light spill
    tFiber: { value: null },
    uFiberColor: { value: new THREE.Color('#7dd63a') },
    uFiberLight: { value: 0.0 },
    uFiberGain: { value: 0.055 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tFiber;
    uniform float uTime, uScroll, uScrollDelta, uUIBlend;
    uniform float uFiberLight, uFiberGain;
    uniform vec2 uGradient, uResolution;
    uniform vec3 uUIColor, uFiberColor;
    varying vec2 vUv;
    vec3 rgb2hsv(vec3 c){
      vec4 K=vec4(0.,-1./3.,2./3.,-1.);
      vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));
      vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));
      float d=q.x-min(q.w,q.y); return vec3(abs(q.z+(q.w-q.y)/(6.*d+1e-10)),d/(q.x+1e-10),q.x);
    }
    vec3 hsv2rgb(vec3 c){
      vec4 K=vec4(1.,2./3.,1./3.,3.);
      vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www);
      return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y);
    }
    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
    float vnoise(vec2 p){
      vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y)*2.-1.;
    }
    vec2 scaleUV(vec2 uv, vec2 s){ return (uv-0.5)/s+0.5; }
    // GlobalComposite.fs blend helpers
    vec3 blendAdd(vec3 base, vec3 blend){ return min(base + blend, vec3(1.0)); }
    vec3 blendAdd(vec3 base, vec3 blend, float o){ return blendAdd(base, blend) * o + base * (1.0 - o); }
    float blendOverlay(float b, float s){ return b < 0.5 ? (2.0*b*s) : (1.0 - 2.0*(1.0-b)*(1.0-s)); }
    vec3 blendOverlay(vec3 b, vec3 s){ return vec3(blendOverlay(b.r,s.r), blendOverlay(b.g,s.g), blendOverlay(b.b,s.b)); }
    vec3 blendOverlay(vec3 b, vec3 s, float o){ return blendOverlay(b, s) * o + b * (1.0 - o); }
    vec2 rotateUV(vec2 uv, float r){
      float c = cos(r), s = sin(r);
      vec2 p = uv - 0.5;
      return vec2(p.x*c - p.y*s, p.x*s + p.y*c) + 0.5;
    }
    float getNoise(vec2 uv, float t){
      float x = uv.x * uv.y * t * 1000.0;
      return fract(mod(x, 13.0) * mod(x, 123.0)) - 0.5;
    }

    void main(){
      vec3 color = texture2D(tDiffuse, vUv).rgb;
      vec2 squareUV = scaleUV(vUv, vec2(1.4, uResolution.x / uResolution.y));

      /* Corner glow, transcribed from GlobalComposite.fs: a violet-blue base
       * whose hue drifts on Perlin noise, added into the corners and blended
       * toward the active project's accent through uUIColor / uUIBlend. */
      vec3 gradient = rgb2hsv(vec3(0.5, 0.5, 1.0));
      gradient.x += vnoise(squareUV * 0.65 - uTime * 0.04) * 0.065 + 0.88;
      gradient = hsv2rgb(gradient);
      gradient = mix(gradient, uUIColor, uUIBlend * 0.75);

      vec2 noiseUV = rotateUV(squareUV, radians(15.0));
      float gNoise = 0.5 + vnoise(noiseUV * 1.1 + uTime * 0.03 + uScroll * 0.08) * 0.5;
      float cornerNoise = 0.7 * 1.6 * smoothstep(uGradient.x, uGradient.y * 0.9, length(squareUV - 0.5));
      color = blendAdd(color, gradient, 0.05 + pow(cornerNoise * gNoise, 2.0));

      /* Fiber light spill. The backdrop sits behind everything, so on its own
       * it illuminates nothing. Adding its halo here — after the scene, before
       * the grain — lets the light bleed over the spine and through the glass,
       * which is what reads as the fibers actually lighting the frame. */
      if (uFiberLight > 0.001) {
        float f = clamp(texture2D(tFiber, vUv).x * uFiberGain, 0.0, 1.0);
        float spill = smoothstep(0.06, 0.85, f);
        color = blendAdd(color, uFiberColor, spill * uFiberLight);
        // wider, weaker wash so the falloff does not end abruptly
        color += uFiberColor * pow(f, 1.5) * uFiberLight * 0.30;
      }

      float vig = smoothstep(1.45, 0.30, length((vUv - 0.5) * vec2(1.0, 0.88)));
      color *= mix(0.78, 1.0, vig);

      // film grain — the original overlays at 0.15
      color = blendOverlay(color, vec3(getNoise(vUv, fract(uTime) + 0.5)), 0.15);

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};
const compositePass = new ShaderPass(CompositeShader);
composer.addPass(compositePass);

// only the fiber backdrop exposes a separable halo that can spill as light
if (background?.enabled && background.glowTexture) {
  compositePass.uniforms.tFiber.value = background.glowTexture;
  compositePass.uniforms.uFiberLight.value = 0.55;
}
composer.addPass(new OutputPass());

/* ---------------------------------------------------------------- *
 *  Nav waveform
 * ---------------------------------------------------------------- */
const wave = document.getElementById('wave');
const wctx = wave.getContext('2d');
let audioOn = true;
wave.addEventListener('click', () => { audioOn = !audioOn; });
function drawWave(t) {
  const w = wave.width, h = wave.height;
  wctx.clearRect(0, 0, w, h);
  const amp = audioOn ? 1 : 0;
  wctx.lineWidth = 2;
  for (let pass = 0; pass < 3; pass++) {
    wctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const u = x / w;
      const y = h / 2 + Math.sin(u * 6 + t * 3 + pass * 0.8) * 7 * amp * Math.sin(u * Math.PI);
      x === 0 ? wctx.moveTo(x, y) : wctx.lineTo(x, y);
    }
    wctx.strokeStyle = `hsla(${190 + Math.sin(t + pass) * 30}, 90%, 78%, ${0.32 + pass * 0.16})`;
    wctx.stroke();
  }
}

/* ---------------------------------------------------------------- *
 *  Loop
 * ---------------------------------------------------------------- */
const target = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
let first = true;
const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  // Lenis already eases the scroll position, so this second pass is only a
  // light trailing filter — full 0.1 damping on top reads as mush.
  lenis?.raf(t * 1000);
  smoothProgress = lerp(smoothProgress, scrollProgress, REDUCED ? 1 : 0.28);
  const raw = (smoothProgress - prevProgress) / Math.max(dt, 1e-4);
  prevProgress = smoothProgress;
  scrollDelta = lerp(scrollDelta, raw, 0.12);

  stepTweens(dt * 1000);
  shared.uTime.value = t;
  shared.uScrollDelta.value = scrollDelta * 60;
  shared.uMouse.value.lerp(mouse01, 0.08);   // WorkItem: mouse.lerp(Mouse.normal, 0.08)

  // ---- camera rail
  const offset = 0.06;
  const scrollValue = smoothstep(offset, 1 - offset, smoothProgress);
  const n = waypoints.length;
  const segPos = scrollValue * (n - 1);
  const i1 = Math.floor(segPos), i2 = Math.min(i1 + 1, n - 1);
  const frac = segPos - i1;

  target.position.copy(waypoints[i1].position).lerp(waypoints[i2].position, frac);
  target.quaternion.copy(waypoints[i1].quaternion).slerp(waypoints[i2].quaternion, frac);
  // verbatim from handleCameraScroll
  target.position.y += -1 * smoothstep(0, 0.15, smoothProgress);
  target.position.y += 1 * smoothstep(1, 0.85, smoothProgress);

  /* handleCameraScroll drives camera.GROUP. The camera itself sits at a local
   * offset inside that group — UIL: CAMERA_Element_2_Work position [0,0,2] —
   * so the eye is 2 units further out along the group's +Z than the waypoint.
   * uCamDistance is still measured to the group, which is why labels stay lit. */
  if (first) {
    first = false;
    camGroup.position.copy(target.position);
    camGroup.quaternion.copy(target.quaternion);
  } else {
    camGroup.position.lerp(target.position, 0.2);
    camGroup.quaternion.slerp(target.quaternion, 0.2);
  }
  camGroup.updateMatrixWorld(true);

  /* ViewState on the original only instantiates a handful of WorkItems at a
   * time — hence `total = Math.min(7, views.length)` in positionViews, and the
   * onAddView / onRemoveView scale tweens. Emulate that window here, otherwise
   * the second turn of the helix shows through behind the focused card. */
  const focusIdx = scrollValue * (cards.length - 1);
  for (const c of cards) {
    // smooth falloff rather than a hard cutoff, so nothing pops in as a ghost
    const cull = smoothstep(2.7, 1.5, Math.abs(c.i - focusIdx));
    c.pMat.uniforms.uCull.value = cull;
    c.lMat.uniforms.uAlpha.value = cull;
    c.holder.visible = cull > 0.004;
  }

  // ---- hover picking
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(
    cards.filter(c => c.holder.visible).map(c => c.panel), false);
  hovered = hits.length ? cards.find(c => c.panel === hits[0].object) : null;
  // the hit's UV is the cursor's position on the card itself — that is what
  // the liquid needs; screen-space uMouse alone can't tell it where to pool
  const hoverUV = hits.length ? hits[0].uv : null;

  // ---- per-card uniforms + far-to-near sorting
  // Values transcribed from WorkItem's own render tick:
  //   mouse.lerp(Mouse.normal, 0.08)
  //   uHover = Math.lerp(hovered ? 1 : 0, uHover, 0.08)
  //   ui.uHover = mesh.uHover;  ui.uCamDistance = paneRT.camdistance
  let nearest = null, nearestDist = Infinity;
  for (const c of cards) {
    // WorkPaneUI measures to camera.GROUP, not the eye:
    //   camdistance = mesh.getWorldPosition().distanceTo(camera.group.position)
    const d = c.pos.distanceTo(camGroup.position);
    c._dist = d;
    const hoverTarget = c === hovered ? 1 : 0;
    c.pMat.uniforms.uHover.value = lerp(c.pMat.uniforms.uHover.value, hoverTarget, 0.08);
    c.lMat.uniforms.uHover.value = c.pMat.uniforms.uHover.value;
    c.lMat.uniforms.uCamDistance.value = d;
    c.pMat.uniforms.uFocus.value = lerp(
      c.pMat.uniforms.uFocus.value, smoothstep(7.5, 3.8, d), 0.08);

    // trail the cursor across the card; prev frame gives the drag velocity
    if (c === hovered && hoverUV) {
      const up = c.pMat.uniforms.uPointer.value;
      c.pMat.uniforms.uPointerPrev.value.copy(up);
      up.lerp(hoverUV, 0.20);
    }
    if (d < nearestDist) { nearestDist = d; nearest = c; }
  }

  // Work/updatedVideo: the nearest card owns the video texture and crossfades
  // in over 500ms easeOutSine after a 300ms delay; every other card snaps to 0.
  if (nearest !== activeVideoCard) {
    if (activeVideoCard) activeVideoCard.pMat.uniforms.uVideoBlend.value = 0;
    activeVideoCard = nearest;
    if (nearest) tweenUniform(nearest.pMat.uniforms.uVideoBlend, 1, 500, easeOutSine, 300);
  }
  cards.slice().sort((a, b) => b._dist - a._dist)
    .forEach((c, i) => { c.panel.renderOrder = 10 + i * 2; c.label.renderOrder = 11 + i * 2; });

  if (nearest) {
    const u = compositePass.uniforms;
    u.uUIColor.value.lerp(new THREE.Color(nearest.project.color), 0.03);
    u.uUIBlend.value = lerp(u.uUIBlend.value, smoothstep(9, 4, nearestDist), 0.05);
  }

  const u = compositePass.uniforms;
  u.uTime.value = t;
  u.uScroll.value = smoothProgress * 20;   // the original scales scroll x20 for shaders
  u.uScrollDelta.value = shared.uScrollDelta.value;

  if (!hintHidden && smoothProgress > 0.02) { hintHidden = true; hint.style.opacity = '0'; }
  else if (hintHidden && smoothProgress <= 0.02) { hintHidden = false; hint.style.opacity = '1'; }
  // backdrop steps into its own targets and restores the render target itself
  background?.update(dt);
  video.update(t);
  drawWave(t);

  // ---- refraction pass: scene without the cards
  cardGroup.visible = false;
  renderer.setRenderTarget(refractionRT);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  cardGroup.visible = true;

  composer.render();
}

/* ---------------------------------------------------------------- */
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  refractionRT.setSize(Math.round(innerWidth * 0.5), Math.round(innerHeight * 0.5));
  background?.setSize(innerWidth, innerHeight);
  bloom.setSize(innerWidth * BLOOM_SCALE, innerHeight * BLOOM_SCALE);
  shared.uResolution.value.set(innerWidth * DPR, innerHeight * DPR);
  compositePass.uniforms.uResolution.value.set(innerWidth, innerHeight);
  const portrait = innerWidth < innerHeight;
  compositePass.uniforms.uGradient.value.set(portrait ? 0.05 : 0.02, portrait ? 2.0 : 0.9);
  cards.forEach(c => { c.pMat.uniforms.uPhone.value = portrait ? 1 : 0; });
});

const input = document.querySelector('.ChatDOM textarea');
input.addEventListener('focus', () => input.classList.add('extended'));
input.addEventListener('blur', () => { if (!input.value) input.classList.remove('extended'); });

readScroll();
frame();

const loading = document.getElementById('loading');
requestAnimationFrame(() => requestAnimationFrame(() => {
  loading.style.opacity = '0';
  setTimeout(() => loading.remove(), 900);
}));

