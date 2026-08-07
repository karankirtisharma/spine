import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import Lenis from 'lenis';

import { PROJECTS, shuffled } from './projects.js';
import { buildSpine, buildParticles, spinePath, SPINE_TOP, SPINE_BOTTOM } from './world.js';
import { loadSpine } from './spine-glb.js';
import { loadFlowerCloud, buildFlowerCloud, retintToPalette } from './flower-cloud.js';
import { loadEmblem } from './emblem.js';
import { buildCards, CARD_ORBIT, CAM_ORBIT } from './cards.js';
import { loadEnvTexture, loadNormalTexture, makeEnvTexture, makeSharedVideoTexture, makeBubbleMatcap } from './textures.js';

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
const PARTICLES = LOW ? 14000 : 220000;   // dense enough for the coral clumps
/* 0.45, not 0.3. Bloom runs on a downscaled buffer, so a single very bright
 * sub-pixel point (a flower grain, a fleck) lands in one coarse texel and the
 * mip chain upsamples it back as a hard-edged block -- the little pale squares
 * around the column. A finer buffer makes those blocks small enough to read as
 * glow. The original site runs its bloom at 0.3 too, but nothing in their scene
 * is a bright point against near-black at this density. */
const BLOOM_SCALE = LOW ? 0.15 : 0.45;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
/* ?only=emblem isolates the glass emblem for material work. Declared up here with
 * the other query flags because the flower-cloud loader reads it. */
const ONLY = QUERY.get('only');

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
renderer.setClearColor(0x03120e, 1);   // matches VOID below

const scene = new THREE.Scene();
/* Plain backdrop, as the original does -- their work section is a flat
 * near-black void that lets the spine, cloud and cards carry the colour. Not
 * pure black: the darkest step of our own green ramp, so the frame reads as the
 * same family. Fog matches exactly or the horizon shows as a seam. */
const VOID = 0x03120e;
scene.background = new THREE.Color(VOID);
scene.fog = new THREE.FogExp2(VOID, 0.022);

/* UIL: CAMERA_Element_2_Work — fov 35, position [0,0,2] inside its group.
 * Local Z pulled in from the authored 2.0 to match the live site's framing:
 * eye-to-card = (CAM_ORBIT 7.6 + z) - CARD_ORBIT 3.8, and their reference card
 * fills ~860px of a 2000px frame, which needs d~5.05. */
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 200);
const camGroup = new THREE.Group();
camera.position.set(0, 0, 1.25);
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
/* Particle cloud around the column.
 *
 * Preferred path is Active Theory's own baked cloud. Their florets are an
 * offline Draco bake carrying positions AND per-point colours -- a flat ribbon
 * that FlowerParticleShader curls into a helix around the column -- so no
 * runtime noise reproduces that structure. Their violet hues are remapped onto
 * our green ramp; their clustering is left alone.
 *
 * assets/at/ is not committed, so a fresh clone or deploy 404s here and falls
 * back to the procedural cloud in world.js. Run `npm run fetch:assets`. */
let flowers = null;
/* Their ViewController/resetWork bumps this by 2 * radians(360 * scrollProgress)
 * and zeroes uSparkle; uRotate then eases toward it at 0.05. */
let flowerRotation = 0;
const particles = buildParticles(shared, PARTICLES);
scene.add(particles);

/* Everything the loading overlay waits on. The spine GLB and the flower cloud
 * both land ~1s in and each drags a shader compile with it; dismissing the
 * overlay after two frames (as this used to) meant the canvas was on screen
 * while those stalls happened, and the browser composited half-drawn frames --
 * the black rectangles on refresh. */
const readyTasks = [];

readyTasks.push((async () => {
  try {
    const cloud = await loadFlowerCloud('assets/at/flower_spine-512.bin');
    if (cloud.color) cloud.color = retintToPalette(cloud.color, cloud.count);
    flowers = buildFlowerCloud(shared, cloud, makeBubbleMatcap(), {
      // hug the column, just inside the card orbit (CARD_ORBIT is 3.8)
      targetRadius: 3.2,
      top: SPINE_TOP,
      bottom: SPINE_BOTTOM,
      /* Their Tests.flowerParticleCount attenuation: 1.2 at the 262k tier.
       * Scaled up here because our world is ~0.4x theirs, which the point-size
       * expression already divides out -- this brings the grains back to a
       * readable size without reintroducing the overdraw stall. */
      sizeBias: LOW ? 3.2 : 2.4,
    });
    scene.add(flowers.group);
    // kept visible under ?only=emblem: the glass needs something behind it
    if (ONLY !== 'emblem') particles.visible = false;
    console.log('flower cloud', JSON.stringify(flowers.stats));
  } catch (e) {
    console.info(`flower cloud unavailable (${e.message}) — procedural fallback, run npm run fetch:assets`);
  }
})());
/* ---------------------------------------------------------------- *
 *  Glass emblem
 *
 *  ?emblem=1     add it, parked above the column
 *  ?only=emblem  hide the spine, cards and cloud, to judge the material alone
 * ---------------------------------------------------------------- */
const WANT_EMBLEM = QUERY.get('emblem') === '1' || ONLY === 'emblem';
let emblem = null;
if (WANT_EMBLEM) {
  readyTasks.push(
    loadEmblem(shared, {
      renderer,
      targetHeight: ONLY === 'emblem' ? 4.0 : 5.0,
      // the scene snapshot it refracts; the emblem is excluded from this buffer
      refraction: refractionRT.texture,
    })
      .then(e => {
        emblem = e;
        /* Parked in front of the rail's first waypoint rather than at the
         * origin, so it is actually in frame -- the camera orbits the column at
         * radius ~7.6 and never looks at world centre. */
        // in isolation, sit inside the cloud (centred ~y -7) so there is content to refract
        e.group.position.set(0, ONLY === 'emblem' ? -6.0 : SPINE_TOP + 4.0, 0);
        scene.add(e.group);
        console.log('emblem.glb', JSON.stringify(e.stats));
      }).catch(err => console.warn('emblem.glb failed:', err.message))
  );
}

// Proxy column only exists as a fallback if the GLB fails to load.
const proxy = buildSpine(shared);
proxy.visible = false;
scene.add(proxy);

// ?spine=off skips the model entirely; ?spine=high|max|raw picks the build
// ?only=emblem skips the column: it occupies the same space and makes the
// emblem's material impossible to read against it
if (QUERY.get('spine') !== 'off' && ONLY !== 'emblem') {
  readyTasks.push(
    loadSpine(shared, {
      // ?spine=sharp|high|max|raw — sharp by default, see QUALITY_FILES
      quality: QUERY.get('spine') || 'sharp',
    }).then(({ group, stats }) => {
      scene.add(group);
      console.log('spine.glb', stats);
    }).catch(e => { proxy.visible = true; console.warn('spine.glb failed:', e.message); })
  );
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
  });
}

/* Light rig, in our palette rather than the blue it started as.
 *
 * These were all blue (0xbcd8ff / 0x7f9dff / 0x2a3550 / 0xdCEBff). On a green
 * surface a blue specular lands as violet, which is where the purple blotches
 * over the vertebrae came from -- it was never a texture or a glitch, it was
 * the highlight colour. Key stays near-white so the model's own albedo still
 * reads; fill and ambient carry the green. */
/* Modest levels, and a desaturated fill.
 *
 * I had these at 4.2 / 2.8 / 1.15 to rescue the spine after removing its
 * emissive -- but the texture had already been lightened for the same reason, so
 * it was corrected twice. Between them almost every surface cleared the bloom
 * threshold, and because the fill was fully saturated green (#7dd63a) the bloom
 * spilling over the frame was green too: the whole image went monochrome.
 *
 * The fill is now a pale green rather than a pure one. It still reads green on
 * the column without tinting everything it touches. */
const key = new THREE.DirectionalLight(0xf2ffe4, 2.6); key.position.set(3, 6, 4); scene.add(key);
const rim = new THREE.DirectionalLight(0xb8e08a, 1.5); rim.position.set(-4, 2, -5); scene.add(rim);
/* Ambient is pure diffuse with no specular term, so unlike the directionals or
 * the point light it brightens without producing the blown pinpoints that bloom
 * renders as blocks. Down from 2.2 because the spine's fresnel emissive is back
 * and now carries most of its brightness -- at 2.2 the two stacked and the
 * column washed out. */
scene.add(new THREE.AmbientLight(0x315e3a, 1.15));

/* Travelling specular. Parented to the camera group so the wet highlight slides
 * across the vertebrae as the rail orbits, which is what sells the surface as
 * wet rather than merely glossy. */
/* Back to 28. I had pushed this to 70 to brighten the column, which was the
 * wrong lever entirely: a point light on a sharp clearcoat produces exactly the
 * blown specular pinpoints that bloom turns into blocks. Its job is the moving
 * highlight that sells the surface as wet, not illumination -- ambient does the
 * illuminating. */
const wetSpec = new THREE.PointLight(0xeaffb0, 28, 30, 2);
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
/* strength, radius, threshold. Threshold 0.95, up from 0.58 originally: at that
 * level ordinary wet specular on the column cleared it, so every highlight fed
 * the bloom mips and the coarsest one returned them as hard blocks. Near 1.0
 * only genuinely blown values bloom -- the flower grains, which are what should
 * be glowing -- and the spine's sheen stays out of it. */
const bloom = new UnrealBloomPass(
  new THREE.Vector2(innerWidth * BLOOM_SCALE, innerHeight * BLOOM_SCALE), 0.72, 0.55, 0.95);
composer.addPass(bloom);

const CompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 }, uScroll: { value: 0 }, uScrollDelta: { value: 0 },
    /* Start of the corner falloff. 0.02 was my own guess -- uGradient is set from
     * their JS per-orientation, not authored in uil.json -- and at that value the
     * glow reached nearly to centre and washed the frame. 0.40 keeps it to the
     * edges, which is what it reads as on their site. */
    uGradient: { value: new THREE.Vector2(0.30, 1.0) },
    uResolution: { value: new THREE.Vector2(innerWidth, innerHeight) },
    // theme green, fixed -- never lerped toward the focused project's accent
    uUIColor: { value: new THREE.Color('#7dd63a') }, uUIBlend: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uScroll, uScrollDelta, uUIBlend;
    uniform vec2 uGradient, uResolution;
    uniform vec3 uUIColor;
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

      /* Corner glow, after GlobalComposite.fs -- a base whose hue drifts on
       * Perlin noise, added into the corners.
       *
       * Two deliberate departures from the original. Theirs starts from a
       * violet-blue base and blends toward the focused project's accent, so the
       * edge wash takes on each card's colour -- which is where the orange came
       * from on RACER. Ours is built from uUIColor, held at the theme green, so
       * the wash stays green whatever card is in focus.
       *
       * uUIBlend is kept, but it now modulates the glow's STRENGTH with card
       * proximity rather than its hue. That preserves the original's behaviour of
       * responding to a focused card without letting it steal the colour. */
      /* Corner glow — Active Theory's GlobalComposite.fs, their values, our hue.
       *
       * Theirs, verbatim from the shader:
       *
       *   vec3 gradient = vec3(0.5, 0.5, 1.0);
       *   gradient = rgb2hsv(gradient);
       *   gradient.x += cnoise(squareUV*0.65 - time*0.04) * 0.065 + 0.88;
       *   gradient = hsv2rgb(gradient);
       *   float gNoise = 0.5 + cnoise(noiseUV*1.1 + time*0.03 + uScroll*0.08) * 0.5;
       *   float cornerNoise = 0.7 * 1.6 * smoothstep(uGradient.x, uGradient.y*0.9, r);
       *   color = blendAdd(color, gradient, 0.05 + pow(cornerNoise * gNoise, 2.0));
       *
       * Every number below is theirs: the 0.65 and 0.04 hue-drift rates, the
       * 0.065 drift amount, the 1.1 / 0.03 / 0.08 noise rates, the 0.7 * 1.6
       * corner gain, the 0.9 on uGradient.y, and the 0.05 + pow(..., 2.0)
       * intensity curve. That curve is what keeps it subtle: it sits at 0.05 in
       * the centre of frame and only climbs near the edges.
       *
       * Their base vec3(0.5, 0.5, 1.0) is S=0.5 V=1.0 at a blue hue, which their
       * +0.88 rotation carries to cyan. Ours starts at vec3(0.55, 1.0, 0.5) --
       * the SAME S=0.5 and V=1.0, so the intensity and how washed it reads are
       * unchanged, but the hue lands green and needs no rotation.
       *
       * The creative part is the drift: widened from their 0.065 to 0.10 so the
       * hue wanders further across the green family, chartreuse through teal,
       * instead of holding one flat green. It still reads as one colour.
       *
       * NOT reinstated: the luminance vignette. Worth being clear that their
       * shader has no such term -- the luminance darkening was mine, and taking
       * 22% off the edges on top of this is what turned a glow into a heavy
       * vignette. The edge treatment here is purely additive, as theirs is. */
      /* Two departures from their numbers, both because their frame is far
       * brighter than ours. An additive glow of a given strength is subtle over
       * their busy scene and a heavy wash over our near-black one.
       *
       *   V: theirs is 1.0 (vec3(0.5,0.5,1.0) is S=0.5 V=1.0). Ours is ~0.55, the
       *      same saturation at roughly half the value.
       *   floor: theirs adds a constant 0.05 everywhere, which over black tinted
       *      the entire frame green rather than just the edges. Ours is 0.012.
       *
       * Everything else is theirs untouched: the 0.65/0.04 hue-drift rates, the
       * 1.1/0.03/0.08 noise rates, the 0.7 * 1.6 corner gain, the 0.9 on
       * uGradient.y, and the pow(..., 2.0) falloff that keeps it to the edges. */
      vec3 gradient = rgb2hsv(vec3(0.40, 0.78, 0.37));
      gradient.x += vnoise(squareUV * 0.65 - uTime * 0.04) * 0.10;
      gradient = hsv2rgb(gradient);

      vec2 noiseUV = rotateUV(squareUV, radians(15.0));
      float gNoise = 0.5 + vnoise(noiseUV * 1.1 + uTime * 0.03 + uScroll * 0.08) * 0.5;
      float cornerNoise = 0.7 * 1.6 * smoothstep(uGradient.x, uGradient.y * 0.9, length(squareUV - 0.5));
      color = blendAdd(color, gradient, 0.022 + pow(cornerNoise * gNoise, 2.0));

      // film grain — the original overlays at 0.15
      color = blendOverlay(color, vec3(getNoise(vUv, fract(uTime) + 0.5)), 0.15);

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};
const compositePass = new ShaderPass(CompositeShader);
composer.addPass(compositePass);
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
  // catches every viewport change, including the ones that fire no resize event
  applySize();
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
  /* ?only=emblem parks the camera by hand, so the rail has to be skipped -- it
   * runs every frame and would immediately overwrite the parked transform. */
  if (ONLY !== 'emblem') {
    if (first) {
      first = false;
      camGroup.position.copy(target.position);
      camGroup.quaternion.copy(target.quaternion);
    } else {
      camGroup.position.lerp(target.position, 0.2);
      camGroup.quaternion.slerp(target.quaternion, 0.2);
    }
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
    /* uUIColor is intentionally NOT lerped toward nearest.project.color. That is
     * what the original does, and it is why the edge wash turned orange on an
     * orange card. Only the strength tracks the focused card now. */
    u.uUIBlend.value = lerp(u.uUIBlend.value, smoothstep(9, 4, nearestDist), 0.05);
  }

  const u = compositePass.uniforms;
  u.uTime.value = t;
  u.uScroll.value = smoothProgress * 20;   // the original scales scroll x20 for shaders
  u.uScrollDelta.value = shared.uScrollDelta.value;

  if (!hintHidden && smoothProgress > 0.02) { hintHidden = true; hint.style.opacity = '0'; }
  else if (hintHidden && smoothProgress <= 0.02) { hintHidden = false; hint.style.opacity = '1'; }
  /* Flower cloud drivers, transcribed from their WorkPage render tick:
   *   uRotate = Math.lerp(flowerRotation, uRotate, 0.05)
   *   uScroll = scrollProgress
   *   uSparkle += 0.005 */
  if (flowers) {
    const fu = flowers.uniforms;
    fu.uRotate.value = lerp(flowerRotation, fu.uRotate.value, 0.05);
    fu.uScroll.value = smoothProgress;
    fu.uSparkle.value += 0.005;
  }

  emblem?.update(dt);
  video.update(t);
  drawWave(t);

  /* ---- refraction pass: scene without the cards.
   *
   * The emblem is hidden for this pass. It carries a transmissive material, and a
   * transmissive material makes the renderer run its OWN extra full-scene pass
   * into an internal target to resolve what is behind the glass. Nesting that
   * inside this manual render-to-target blanked the entire frame -- not just the
   * glass, the whole composite came out black.
   *
   * Hiding it here means transmission only ever resolves during composer.render(),
   * where the renderer owns the target stack. The cards lose the emblem from
   * their refraction, which is a fair trade and barely visible. */
  cardGroup.visible = false;
  const emblemWasVisible = emblem ? emblem.group.visible : false;
  if (emblem) emblem.group.visible = false;
  renderer.setRenderTarget(refractionRT);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  cardGroup.visible = true;
  if (emblem) emblem.group.visible = emblemWasVisible;

  /* Clear the whole default framebuffer before the composer writes it.
   *
   * The composite ends on a fullscreen quad, which normally covers everything --
   * but only across whatever viewport is current. If the viewport is ever
   * narrower than the canvas (a resize landing mid-frame, or the canvas growing
   * before the passes catch up) the uncovered region keeps whatever was there
   * before, and stale content from an earlier, smaller frame shows through as a
   * hard-edged block. Clearing at full canvas size first means the worst case is
   * a region of flat backdrop rather than a rectangle of an older frame. */
  renderer.setViewport(0, 0, sizedW, sizedH);
  renderer.setScissorTest(false);
  renderer.clear(true, true, false);

  composer.render();
}

/* ---------------------------------------------------------------- *
 *  Sizing
 *
 *  Applied from the frame loop, not only from the resize event.
 *
 *  During load the viewport changes several times after init: the scroll track
 *  gets its height (which brings in a scrollbar and so changes innerWidth),
 *  webfonts land, the compositor settles. A `resize` event does not reliably
 *  fire for all of that, so the renderer and the composer's render targets were
 *  left sized for a viewport that no longer existed. The composite then blits a
 *  target of one size into a buffer of another and everything outside it stays
 *  black -- which is the stack of black rectangles on refresh, each one a
 *  different stale size.
 *
 *  Reconciling once per frame costs a comparison and makes the artifact
 *  structurally impossible: the buffers cannot be a size the canvas isn't.
 * ---------------------------------------------------------------- */
let sizedW = 0, sizedH = 0;
function applySize() {
  const w = innerWidth, h = innerHeight;
  if (w === sizedW && h === sizedH) return;
  sizedW = w; sizedH = h;

  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  refractionRT.setSize(Math.round(w * 0.5), Math.round(h * 0.5));
  bloom.setSize(w * BLOOM_SCALE, h * BLOOM_SCALE);
  shared.uResolution.value.set(w * DPR, h * DPR);
  compositePass.uniforms.uResolution.value.set(w, h);
  const portrait = w < h;
  compositePass.uniforms.uGradient.value.set(portrait ? 0.26 : 0.30, portrait ? 1.5 : 1.0);
  cards.forEach(c => { c.pMat.uniforms.uPhone.value = portrait ? 1 : 0; });
}
addEventListener('resize', applySize);
applySize();

const input = document.querySelector('.ChatDOM textarea');
input.addEventListener('focus', () => input.classList.add('extended'));
input.addEventListener('blur', () => { if (!input.value) input.classList.remove('extended'); });

/* ?only=emblem — isolate the emblem so its material can be judged without the
 * cloud and cards washing over it. Applied after everything is built, and it also
 * parks the camera on the emblem rather than on the rail's first card. */
if (ONLY === 'emblem') {
  /* particles stay ON. Clear glass is only visible through what sits behind it --
   * transmission 1.0 against a black void refracts black and reflects nothing, so
   * a fully emptied scene renders the emblem genuinely invisible. The particle
   * field is also what the reference frames put behind it. */
  proxy.visible = false;
  cardGroup.visible = false;
  camGroup.position.set(0, -6.0, 9.0);
  camGroup.quaternion.identity();
  scene.fog = null;                 // fog eats a transmissive object at distance
}

readScroll();
frame();

/* Hold the overlay until the async assets are in the scene AND their programs
 * are compiled, so the compile stall happens behind it rather than in view.
 * allSettled, not all: a missing asset must not strand the overlay, and the
 * race is a hard cap in case a decode hangs. */
const loading = document.getElementById('loading');
const revealWhenReady = Promise.allSettled(readyTasks);
/* Deliberately no renderer.compile() here. In current three it performs a
 * virtual render and leaves renderer state bound, which blanked the canvas
 * outright. Waiting for the assets is what actually hides the stall; the first
 * few real frames absorb the compile. */
/* 5s cap. Normal path is asset-driven, so the actual duration varies with what
 * is already cached -- a warm reload reveals almost immediately, a cold one
 * takes the full compile. The cap only exists so a missing or hung asset can
 * never strand the loader. */
Promise.race([revealWhenReady, new Promise(r => setTimeout(r, 5000))]).then(() => {
  // two frames after compiling, so the first real frame is already on screen
  requestAnimationFrame(() => requestAnimationFrame(() => {
    loading.style.opacity = '0';
    setTimeout(() => loading.remove(), 900);
  }));
});

