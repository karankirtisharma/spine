import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import Lenis from 'lenis';

import { PROJECTS, shuffled } from './projects.js';
import { buildSpine, buildParticles, spinePath, SPINE_TOP, SPINE_BOTTOM, PALETTE } from './world.js';
import { loadSpine } from './spine-glb.js';
import { loadFlowerCloud, buildFlowerCloud, retintToPalette, loadTreeCloud } from './flower-cloud.js';
import { buildFlora } from './flora.js';
import { buildPlanets } from './planets.js';
import { buildFoliage, loadPoolTexture } from './foliage.js';
import { buildAlcove } from './alcove.js';
import { loadEmblem } from './emblem.js';
import { buildHome } from './home.js';
import { buildAbout } from './about.js';
import { SECTION_ORDER, SECTION_VH, buildRanges, sectionState } from './sections.js';
import { TransitionShader, transitionState } from './transition.js';
import { buildVolumetricLight } from './volumetric.js';
import { heroDrives } from './intro.js';
import { buildJelly } from './jelly.js';
import { buildComet } from './comet.js';
import { buildNebula } from './nebula.js';
import { buildCards, CARD_ORBIT, CAM_ORBIT } from './cards.js';
import { loadEnvTexture, loadNormalTexture, makeEnvTexture, makeSharedVideoTexture, makeBubbleMatcap, makeStrandTexture, loadJellyMatcap, loadJellyNormal } from './textures.js';
import { buildFilmSequence } from './filmseq.js';
import { buildWater } from './water.js';

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

/* Section 3's content, as one toggleable root.
 *
 * Deliberately contains NO lights: three's projectObject early-returns on an
 * invisible subtree, so hiding a root that held lights would change the light
 * count, and light counts are in the program cache key -- every lit material would
 * compile a new program. The four scene lights stay on `scene` / `camGroup`.
 * Also stays at renderOrder 0: a Group's renderOrder propagates to all descendants
 * and sorts before everything else, which would override the card depth sort. */
const workRoot = new THREE.Group();
scene.add(workRoot);

/* Section 1 and 2's roots, under the same three rules.
 *
 * Section 2 holds no geometry at all -- its content is DOM and the shared emblem --
 * so its root exists only to keep the three sections symmetrical. */
const homeRoot = new THREE.Group();
scene.add(homeRoot);
const aboutRoot = new THREE.Group();
scene.add(aboutRoot);

/* The shared atmosphere: content that belongs to no single section.
 *
 * This exists because of a specific failure. With the plume locked inside
 * homeRoot, About had nothing in it but the mark -- so at the Home/About seam the
 * wipe mixed a full frame of particles against pure black, and on screen that does
 * not read as one scene replacing another. It reads as a layer with its bottom cut
 * off, which is exactly what it was called out as.
 *
 * Sections 1 and 2 are two camera positions in ONE volume, not two pocket worlds.
 * Anything that should survive a section change lives here. */
const atmosRoot = new THREE.Group();
scene.add(atmosRoot);

/* The scanned-cloud backdrop, split out of atmosRoot so it can serve EVERY section
 * including work -- the spine used to sit in bare void while the hero sections had
 * the full ambience behind them. The plume stays in atmosRoot (its additive sparks
 * would fight the cards); this root carries only the opaque cloud, repositioned and
 * rescaled per section in stageSection. */
const ambienceRoot = new THREE.Group();
scene.add(ambienceRoot);

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
/* Objects that must NOT appear in the refraction snapshot, because they sample it.
 * Anything glass-like pushes itself on here at construction. Kept as a list rather
 * than a hardcoded pair so a new section can add its own emblem instance without
 * editing the render loop. */
const refractExclude = [];

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
/* Second instance of their baked cloud, for the hero atmosphere — see where it is
 * built for why the hero needs their scanned structure rather than particles. */
let heroCloud = null;
let foliage = null;
/* THE BURST'S VEGETATION — real low-poly plant geometry, GPU-instanced, see
 * flora.js. Every point-cloud attempt at foliage (the lush ring, then the
 * carved biome masses) failed the same way: particles cannot carry a
 * silhouette, so the frame read as dot fog however it was tuned. The plants
 * are geometry now; particles are a secondary layer shed off their rims.
 * `?flora=solo` renders geometry + mark on black — the acceptance test. */
let flora = null;
const floraHolder = new THREE.Group();
const FLORA_SOLO = new URLSearchParams(location.search).get('flora') === 'solo';
const particles = buildParticles(shared, PARTICLES);
workRoot.add(particles);

/* Everything the loading overlay waits on. The spine GLB and the flower cloud
 * both land ~1s in and each drags a shader compile with it; dismissing the
 * overlay after two frames (as this used to) meant the canvas was on screen
 * while those stalls happened, and the browser composited half-drawn frames --
 * the black rectangles on refresh. */
const readyTasks = [];

readyTasks.push((async () => {
  try {
    const cloud = await loadFlowerCloud('assets/at/flower_spine-512.bin');
    /* Two retints from the one bake. retintToPalette returns a new array and does
     * not touch its input, so the raw colours can be mapped twice -- the spine
     * instance keeps the ramp section 3 already ships, and the hero gets its own.
     * Tinting once and sharing would mean changing section 3 to fix the hero. */
    const rawColor = cloud.color;
    if (rawColor) cloud.color = retintToPalette(rawColor, cloud.count);
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
    workRoot.add(flowers.group);
    // kept visible under ?only=emblem: the glass needs something behind it
    if (ONLY !== 'emblem') particles.visible = false;
    console.log('flower cloud', JSON.stringify(flowers.stats));

    /* SECOND INSTANCE, for the hero atmosphere behind sections 1 and 2.
     *
     * This is what the upper half of their About frame actually is: their scanned
     * point cloud, dense and textured, with real per-point colour -- moss and algae
     * on rock, not particles. The procedural plume cannot produce that however it
     * is tuned, because the structure is baked into their asset. Their bake is
     * already on disk for the work spine, so the hero gets a second instance of it.
     *
     * Built from the SAME parsed arrays, not a second fetch: buildFlowerCloud wraps
     * whatever typed arrays it is handed in fresh BufferAttributes, and the shader
     * only reads them. Identical material source too, so both instances share one
     * compiled program.
     *
     * Fitted far wider than the spine instance -- radius 16 rather than 3.2 -- so
     * it reads as a canopy the hero sits inside rather than a column dressing. */
    heroCloud = buildFlowerCloud(shared, cloud, makeBubbleMatcap(), {
      /* A DESATURATED ramp, and this is the answer to the frame being solid green.
       *
       * The default ramp is four saturated greens, so every one of their baked hues
       * lands on a fully saturated green and the hue variety in the bake is thrown
       * away -- the image then has nothing but value to work with and reads as one
       * flat colour however it is lit. Their own frame is mostly desaturated: near
       * black, olive mids, bone-white highlights, with saturated colour reserved for
       * the few bright accents.
       *
       * This ramp runs deep shadow -> olive -> sage -> bone. Still unmistakably the
       * green scheme, because the hue never leaves the family, but saturation now
       * falls as brightness rises, which is what lets highlights read as light
       * instead of as more green. */
      /* Five stops with a teal mid and a warm gold top, not the flat sage this
       * started as. The desaturated ramp was the right correction when the frame
       * was drowning in one saturated green -- but it overcorrected into monochrome,
       * and reference image 1's cloud has clear colour structure: teal pockets,
       * yellow-green bodies, warm gold crests. Their bake's hue field carries the
       * cluster identity, so mapping it through a ramp with actual hue variety
       * gives each cluster a distinct cast exactly where their scan varies. */
      color: rawColor
        ? retintToPalette(rawColor, cloud.count, {
            ramp: ['#142019', '#2e4d3f', '#3f8a74', '#9db347', '#e0d68a'],
          })
        : undefined,
      // no fog on this shader, so distance has to be dialled in by hand
      brightness: 0.5,
      targetRadius: 16,
      /* The hero camera descends y 44.5 to -4.5 and the mark tracks it, so the
       * volume has to cover that whole run. top/bottom only set where the ribbon is
       * centred; at this fit one copy already spans ~75 units. */
      top: 50, bottom: -16, copies: 0,
      sizeBias: LOW ? 0.9 : 0.6,
    });
    /* Pushed behind the mark. The fitted ribbon is a ring about the Y axis, so its
     * near arc would otherwise sit between the camera and the mark -- and this
     * cloud is opaque and depth-tested (correctly: that is what gives it dark gaps
     * and real occlusion), so it would simply hide the mark. Offsetting the whole
     * ring back puts every point beyond z 0 and leaves the glass in front of it. */
    heroCloud.group.position.z -= 20;
    ambienceRoot.add(heroCloud.group);
    console.log('hero cloud', JSON.stringify(heroCloud.stats));

    /* ---- THE ENVIRONMENT (the density pass). Foliage walls, curtains and light
     * pools built from the SAME parsed flower arrays plus their tree cloud --
     * see foliage.js for the placement reasoning. The tree decode is guarded:
     * its Draco attributes are generically named and ride unique ids, so if a
     * re-export ever reorders them the walls fall back to flower-only rather
     * than failing the whole cloud chain. */
    let treeCloud = null;
    try {
      treeCloud = await loadTreeCloud('assets/at/tree-256.bin');
      console.log('tree cloud', treeCloud.count, 'points');
    } catch (e) {
      console.info('tree cloud unavailable (' + e.message + ') — flower-only walls');
    }
    foliage = buildFoliage(shared, cloud, treeCloud, makeBubbleMatcap());
    /* The work bowl rides workRoot, so section visibility is free. The other two
     * hang off scene and are staged. Region placement: the land group lives in
     * the landing's world (origin), the hero group tracks the descending camera
     * per stage below. */
    workRoot.add(foliage.workGroup);
    scene.add(foliage.landGroup);
    scene.add(foliage.heroGroup);
    scene.add(foliage.burstGroup);
    foliage.landGroup.visible = false;
    foliage.heroGroup.visible = false;
    foliage.burstGroup.visible = false;
    console.log('foliage', JSON.stringify(foliage.stats));
  } catch (e) {
    console.info(`flower cloud unavailable (${e.message}) — procedural fallback, run npm run fetch:assets`);
  }
})());

/* ---------------------------------------------------------------- *
 *  THE VEGETATION (burst)
 *
 *  Real plant geometry on real surfaces. Beds are stated in camGroup-LOCAL
 *  coordinates because floraHolder copies camGroup in burst; the burst eye sits
 *  at local (0, 2.5, 37.9) at fov 30, so the frame's half-height at depth d is
 *  0.268*d and the visible band at z=16 runs y -3.4 .. 8.4, x +/-11.6. Every
 *  bed below is placed against that arithmetic rather than against whatever the
 *  dev pane happens to crop.
 *
 *  `normal` is the SURFACE's up, and it is what makes the vegetation read as
 *  grown rather than scattered: [0,1,0] is ground so grass stands, [0,-1,0] is
 *  the canopy so vines hang, [±1,0,0] are the banks so moss hugs them, [0,0,1]
 *  is the far slope facing the camera.
 *
 *  No assets, so this is built outside the cloud chain -- the vegetation exists
 *  even on a fresh clone with no fetch:assets run.
 * ---------------------------------------------------------------- */
flora = buildFlora(shared, {
  /* THE CLEARING around the artifact — see flora.js. Centred on the sight line
   * between the eye and the mark rather than on the mark itself, so the opening
   * runs through the frame's middle at every depth and the coin has space
   * behind it as well as beside it. */
  /* radius 10.5, up from 7.4. In the reference the vegetation is a thick
   * VIGNETTE around the frame and the middle half is open dark -- that void is
   * what gives the planets somewhere to exist and what makes the space read as
   * enormous. A tighter clearing had the growth crowding the centre, which
   * flattens the depth however well each plant is lit. */
  clearing: { at: [0, 3.8, 9], radius: 10.5 },
  /* ---- THE ENVIRONMENT, composed as named formations in three depth layers
   * rather than as a left slab and a right slab. The two slabs were the "walls"
   * -- scattered on planes at x = +/-11, uniformly dense, with a findable
   * vertical edge and a hard stop into empty space. Each side is now several
   * smaller masses at DIFFERENT depths, thicknesses and sizes, deliberately
   * asymmetric between left and right, and every one of them thins out through
   * the clearing rather than ending. */
  beds: [
    /* ---------- LAYER 1: FOREGROUND. A few large, near, very dark clumps that
     * frame the shot from the corners. Sparse by design -- these read as things
     * the camera is pushing past, not as scenery. ---------- */
    { at: [-11, -3.4, 27], normal: [0, 1, 0], radius: 3.6, squash: 1.4, seed: 21.3,
      proto: 'grass', count: 70, scale: [2.6, 4.4], tilt: 0.4, relief: 1.4 },
    { at: [9.5, -3.4, 29], normal: [0, 1, 0], radius: 3.2, squash: 1.3, seed: 22.7,
      proto: 'fern', count: 45, scale: [2.4, 4.0], tilt: 0.45, relief: 1.4 },
    /* Foreground creepers, ROOTED ABOVE THE FRAME. At depth 12 the top edge is
     * y ~5.7, so a bed at y 9-10 puts every attachment point off-screen and
     * only the trailing runs descend into shot -- which is the whole point:
     * you cannot see a plant "start" if its start is outside the viewport. */
    { at: [-10, 9.6, 26], normal: [0, -1, 0], radius: 3.4, squash: 1.3, seed: 23.1,
      proto: 'creeper', count: 22, scale: [1.4, 2.6], tilt: 0.22, relief: 3.0 },
    { at: [12, 9.2, 24], normal: [0, -1, 0], radius: 3.0, squash: 1.2, seed: 24.9,
      proto: 'creeper', count: 16, scale: [1.3, 2.4], tilt: 0.22, relief: 3.0 },

    /* ---------- LAYER 2: MIDGROUND. The environment proper. Broken into
     * irregular clusters at staggered depths; `relief` is large so each is a
     * VOLUME seen edge-on, not a plane. ---------- */
    /* left bank — three masses, receding, none of them planar */
    { at: [-12.5, 2.5, 7], normal: [1, 0, 0], radius: 5.5, squash: 1.2, seed: 5.0,
      proto: 'moss', count: 230, scale: [1.8, 3.4], tilt: 0.4, relief: 7 },
    { at: [-9.5, -1.0, 15], normal: [0.75, 0.45, 0.3], radius: 4.2, squash: 1.2, seed: 7.7,
      proto: 'fern', count: 105, scale: [1.3, 2.5], tilt: 0.45, relief: 4.5 },
    { at: [-6.5, -3.5, 11], normal: [0, 1, 0], radius: 4.0, squash: 1.3, seed: 3.3,
      proto: 'shrub', count: 110, scale: [1.3, 2.4], tilt: 0.32, relief: 2.4 },
    /* right bank — deliberately a different shape from the left: one large mass
     * further back, one curved growth reaching in, one low mound */
    { at: [12, 1.0, 9], normal: [-1, 0, 0], radius: 6.2, squash: 1.25, seed: 6.4,
      proto: 'moss', count: 260, scale: [1.8, 3.4], tilt: 0.4, relief: 7 },
    { at: [8.5, 3.0, 17], normal: [-0.8, 0.25, 0.5], radius: 4.0, squash: 1.3, seed: 11.5,
      proto: 'fern', count: 115, scale: [1.3, 2.5], tilt: 0.45, relief: 4.5 },
    { at: [7.0, -3.4, 13], normal: [0, 1, 0], radius: 4.6, squash: 1.4, seed: 1.2,
      proto: 'grass', count: 165, scale: [1.2, 2.2], tilt: 0.32, relief: 2.0 },
    /* the floor running under the whole shot, thinning through the clearing */
    { at: [-1, -3.6, 20], normal: [0, 1, 0], radius: 7.5, squash: 1.9, seed: 0.4,
      proto: 'grass', count: 330, scale: [1.2, 2.6], tilt: 0.3, relief: 1.6 },
    { at: [4, -3.3, 7], normal: [0, 1, 0], radius: 4.6, squash: 1.4, seed: 13.9,
      proto: 'shrub', count: 110, scale: [1.2, 2.2], tilt: 0.3, relief: 1.6 },
    /* The lower-left floor. This quarter came out thin: the clearing no longer
     * reaches it (its downward extent is compressed 2.4x) but no bed covered
     * it either, so the ground read as bare between the left bank and the
     * centre. TALLER than the surrounding floor beds -- the gap ran well up the
     * frame, and short grass at the floor line would leave the upper half of it
     * still empty. */
    { at: [-5.0, -3.5, 17], normal: [0, 1, 0], radius: 5.5, squash: 1.5, seed: 41.3,
      proto: 'fern', count: 130, scale: [1.8, 3.2], tilt: 0.32, relief: 2.2 },
    { at: [-3.2, -3.5, 12], normal: [0, 1, 0], radius: 4.8, squash: 1.6, seed: 42.7,
      proto: 'grass', count: 240, scale: [1.6, 2.9], tilt: 0.34, relief: 1.8 },
    /* The canopy, asymmetric: a heavy mass top-left, a sparse fringe top-right.
     * Both raised ABOVE the frame's top edge (y ~7.9 at depth 20) and switched
     * to creepers. Previously these sat just inside the frame as compact
     * hanging tufts, so you saw each clump's origin floating in mid-air with
     * gaps between them -- growth apparently starting from nothing. Rooted
     * above with long trailing strands, the same beds read as a curtain
     * descending from somewhere out of shot. */
    /* The heavy mass sits top-CENTRE-RIGHT, not top-left: the large planet
     * projects at roughly 30% width / 15% height, and a dense curtain there
     * buries it. The reference frames that planet with growth beside it and
     * open dark across it -- the body needs the space more than the corner
     * needs the foliage. */
    /* Counts roughly halved and `relief` doubled. The top-right read FLAT, and
     * density was only half of why: every strand hung at nearly the same depth,
     * so they all lit the same and the mass had no near-and-far inside it.
     * Spreading them 5-6 units through the normal gives the curtain internal
     * depth, and the wider scale range means the near ones read as near. */
    { at: [3.5, 11.2, 18], normal: [0, -1, 0], radius: 5.8, squash: 1.6, seed: 9.1,
      proto: 'creeper', count: 62, scale: [0.85, 2.3], tilt: 0.2, relief: 5.5 },
    { at: [12.0, 11.6, 15], normal: [0, -1, 0], radius: 4.4, squash: 1.4, seed: 12.7,
      proto: 'creeper', count: 36, scale: [0.8, 2.1], tilt: 0.2, relief: 5.5 },
    /* NO top-left fringe. Its strands hung across the large planet, and against
     * that bright disc the dark 0.02-wide stems disappeared while the leaves
     * still read -- so the leaves looked detached, floating on the planet with
     * nothing holding them. A stem only reads as a stem against a dark
     * background; over a lit body it is invisible and the plant falls apart.
     * The corner stays bare, which the planet wants anyway. */
    /* a second, deeper tier so the curtain has depth rather than being one
     * plane of strands -- these hang further back and read as the layer beyond */
    { at: [3.0, 12.0, 8], normal: [0, -1, 0], radius: 6.0, squash: 1.7, seed: 26.4,
      proto: 'creeper', count: 42, scale: [0.85, 1.8], tilt: 0.2, relief: 5.0 },

    /* ---------- LAYER 3: BACKGROUND. Small, dark, sparse -- it exists to make
     * the clearing bounded and to give the atmosphere something to sit in
     * front of, never to be looked at directly. ---------- */
    /* The two far beds that used to sit here are GONE. They were scattered on
     * vertical planes facing the camera (normal [0,0,1]) at mid-frame height,
     * so their plants stood in open air with no ground beneath them -- which is
     * exactly what "floating, no starting point" describes. A plant reads as
     * rooted only when the surface it grows from is also in shot; a bed hanging
     * in the middle of the void cannot ever look attached, at any density.
     *
     * The far vegetation now grows from the FLOOR, well back and low, so its
     * roots sit on the same ground plane the near beds do and it recedes into
     * the murk instead of hovering in it. */
    { at: [6, -3.4, -9], normal: [0, 1, 0], radius: 8, squash: 1.5, seed: 4.5,
      proto: 'shrub', count: 110, scale: [1.4, 2.6], tilt: 0.3, relief: 2.0 },
    { at: [-7, -3.4, -6], normal: [0, 1, 0], radius: 6.5, squash: 1.3, seed: 10.3,
      proto: 'fern', count: 70, scale: [1.3, 2.3], tilt: 0.3, relief: 2.0 },
    { at: [1, 12.5, 1], normal: [0, -1, 0], radius: 5.5, squash: 1.6, seed: 14.2,
      proto: 'creeper', count: 55, scale: [0.85, 1.6], tilt: 0.18, relief: 2.0 },

    /* ---------- THE CARD LAYER: painted-leaf cutout cards, the ecosystem's
     * mass. This is where the reference's DENSITY comes from -- thousands of
     * alpha-tested leaves filling the volumes the built plants sketch, one
     * draw call for all of them, every one through the same clearing mask and
     * flow field. Kinds pick atlas cells: leaf / fern / sprig / grass. ---- */
    // banks, both sides, thick through the volume
    { at: [-12, 1.5, 10], normal: [1, 0, 0], radius: 6.5, squash: 1.3, seed: 31.1,
      proto: 'card:sprig', count: 850, scale: [1.4, 3.0], tilt: 0.5, relief: 8 },
    { at: [11.5, 1.0, 11], normal: [-1, 0, 0], radius: 7, squash: 1.3, seed: 32.7,
      proto: 'card:leaf', count: 950, scale: [1.2, 2.6], tilt: 0.5, relief: 8 },
    /* Canopy fill, hanging, asymmetric. Moved OFF the large planet (x -8 -> 3):
     * alpha-cutout leaves silhouetted against a lit disc have no stem and no
     * shading to place them in depth, so they read as decals stuck on the
     * planet's surface -- the same failure the creepers had there. Nothing in
     * front of that body can look attached to anything; it has to be clear. */
    { at: [3, 9.4, 16], normal: [0, -1, 0], radius: 6.5, squash: 1.6, seed: 33.9,
      proto: 'card:leaf', count: 650, scale: [1.1, 2.4], tilt: 0.4, relief: 3.5 },
    { at: [9.5, 9.0, 13], normal: [0, -1, 0], radius: 5.5, squash: 1.5, seed: 34.3,
      proto: 'card:sprig', count: 450, scale: [1.0, 2.2], tilt: 0.4, relief: 3.5 },
    // floor ferns and grass running under everything
    { at: [-1, -3.6, 16], normal: [0, 1, 0], radius: 9, squash: 1.9, seed: 35.5,
      proto: 'card:fern', count: 650, scale: [1.1, 2.4], tilt: 0.4, relief: 2.5 },
    { at: [2, -3.5, 24], normal: [0, 1, 0], radius: 6, squash: 1.6, seed: 36.1,
      proto: 'card:grass', count: 500, scale: [1.3, 2.6], tilt: 0.4, relief: 2.0 },
    /* card mass over the same lower-left gap the built beds above now cover --
     * the cards supply the density, the built plants supply the silhouette */
    { at: [-5.0, -3.5, 15], normal: [0, 1, 0], radius: 6, squash: 1.6, seed: 43.9,
      proto: 'card:fern', count: 460, scale: [1.5, 3.0], tilt: 0.45, relief: 2.4 },
    /* NO far veil behind the mark. 800 cards on a vertical plane at mid-frame
     * height had nothing beneath them -- a curtain of leaves standing in open
     * air directly behind the artifact, which is the band the user circled as
     * making no sense. It cannot be fixed by thinning: a plant reads as rooted
     * only when the surface it grows from is also in shot, and this bed's
     * surface was a plane floating in the void. The far vegetation is rooted on
     * the FLOOR instead, below. */
    { at: [1, -3.5, -8], normal: [0, 1, 0], radius: 10, squash: 1.7, seed: 37.7,
      proto: 'card:fern', count: 520, scale: [1.1, 2.3], tilt: 0.45, relief: 2.5 },
  ],
  fogDensity: 0.022, fogColor: '#04100a',
  /* The palette, root to tip. `deep` is near-pure black and the ramp climbs
   * into a saturated emerald: that spread is what stands in for the ambient
   * occlusion in the reference -- crevices inside a mass fall to nothing while
   * the tips that face the light stay green, so a clump reads as a volume with
   * shadow in it rather than as a flat green shape. */
  deep: '#010402', mid: '#12331f', tip: '#4f9c55',
  lightDir: [-0.3, 0.8, 0.5], lightCol: '#7fc484', rimCol: '#79d69a',
  /* 0.5: this is the always-on underwater current, not wind. It is applied to
   * a two-octave drift + a vertical breath in the shader, all at ~0.05 time
   * rates, so a large amplitude still reads as slow suspension rather than
   * gusting. The scene must never look static when the cursor is still. */
  wind: 0.5, dustPer: 26, dustSizePx: 1.7,
  /* ---- the cursor interaction field. A FLOW FIELD, not a point force: the
   * cursor supplies a soft influence mask and the displacement DIRECTION comes
   * from a circulating current sampled at each plant, blended with the cursor's
   * travel direction. Nothing here points at or away from the pointer, which is
   * what the earlier radial version did and why it built a starburst.
   *   cursorRadius  the disturbed pocket, world units
   *   cursorDepth   how far along the cursor ray the pocket extends
   *   push          force scale -- small; deformation stays a fraction of the
   *                 vegetation's own motion
   *   stiffness/damping   overdamped (C > 2*sqrt(K)): soft, heavy, no bounce
   *   maxBend       hard ceiling on tip excursion, in the plant's own units
   *   wakeSpread    how fast a wake blob widens as it fades
   *   flow          curl-noise leaf detail inside the pocket (GPU) */
  cursorRadius: 7.5, cursorDepth: 18, push: 3.4,
  stiffness: 7, damping: 7.5, maxBend: 0.22,
  rippleLife: 2.2, wakeSpread: 5.5,
  flow: 0.35,
});
console.log('flora', JSON.stringify(flora.stats));
/* live handle for tuning the interaction field from the console */
window.__flora = flora;

/* ---------------------------------------------------------------- *
 *  THE PLANETS (burst) — the deep section's celestial bodies, placed to the
 *  reference frame in camGroup-local space (camera ~(0, 2.5, 38), fov 30:
 *  half-height 0.268·d, half-width ~0.53·d). All sit at z -18/-30, BEHIND the
 *  midground banks (z 7..27), so foliage genuinely occludes their limbs.
 * ---------------------------------------------------------------- */
const planets = buildPlanets(shared, {
  lightDir: [-0.3, 0.8, 0.5],
  bodies: [
    /* The large planet. Moved DEEPER (z -34, was -18) and up out of the corner:
     * at -18 its limb cut straight through the densest canopy mass, and a hard
     * circle crossing a leaf cluster reads as a sticker no matter how it is
     * shaded. Further back it fogs far harder, it sits in the darker gap
     * between the canopy and the left bank, and the leaves that do cross it
     * read as foreground rather than as collision. Radius up to keep the same
     * apparent size at the greater distance. */
    /* Dropped from y 14.5 to 7.5. Up there the body sat behind the hanging
     * canopy, and a dark alpha-cutout leaf in front of a lit disc has no stem,
     * no shading and no haze to place it in depth -- so it reads as a decal ON
     * the planet rather than as foliage before it. Chasing the beds sideways
     * only moves which leaves land on it. At this height the planet occupies
     * the open left-centre dark BELOW the canopy line, where nothing hangs in
     * front of it at all. */
    { at: [-15.5, 7.5, -26], r: 6.0, spin: 0.006, seed: 3.7,
      base: '#3f9a5e', dark: '#04120a', rim: '#6fdcaa', rimGain: 1.0, lightGain: 1.7 },
    /* NO close moon here. It projected just up-left of the mark and read as a
     * smudge crowding the artifact rather than as a body -- at that apparent
     * size a sphere has no terrain and no crescent to identify it, so it was
     * only ever a grey blob in the one part of the frame that must stay clean.
     * The lower-right pair carries the "several bodies at different depths"
     * job without competing with the mark. */
    /* the mid planet, lower-right, with a tiny companion */
    /* Raised y -5.6 -> -1.8 and pushed right. Down at -5.6 the body sat behind
     * the bottom-right grass and the right bank, so only a sliver of crown
     * cleared the foliage line and it read as a smudge rather than a world.
     * Up here its whole disc is above the growth, which is what the reference
     * does with its lower-right planet. */
    /* GREENED AND DIMMED to its filmed twin. Sampled at the disc centres of
     * frame 1: the film's left body reads (7,111,35) and its right (2,69,37)
     * -- both saturated greens, the right one simply darker. Ours was
     * #2f8266 with a #63cfa6 rim, which projects around hue 160 and read as
     * the distinctly BLUE-teal disc in the client's 3D frame while the
     * footage's was green. Hue pulled to ~148 and both gains cut, so the
     * body dims into the footage's rather than announcing itself. */
    { at: [13.0, -1.8, -26], r: 4.4, spin: -0.005, seed: 11.9,
      base: '#2b7a4a', dark: '#03100c', rim: '#57bd84', rimGain: 0.68, lightGain: 1.15 },
    { at: [8.4, -5.0, -25], r: 1.0, spin: 0.015, seed: 5.3,
      base: '#336b4c', dark: '#050e08', rim: '#5cbf95', rimGain: 0.75, lightGain: 1.0 },
    /* a remote moon, upper-right, mostly lost in the far haze */
    { at: [18.5, 15.5, -34], r: 1.1, spin: 0.02, seed: 9.4,
      base: '#2d5f45', dark: '#040c07', rim: '#4fa585', rimGain: 0.6, lightGain: 0.9 },
  ],
});
/* the authored placements, captured before anything steers them -- the
 * pinning above eases OUT of these, so drift and gather are untouched */
const PLANET_HOME = planets.group.children.map(m => m.position.clone());
const planetHolder = new THREE.Group();
planetHolder.add(planets.group);
scene.add(planetHolder);
planetHolder.visible = false;
floraHolder.add(flora.group);
scene.add(floraHolder);
floraHolder.visible = false;
refractExclude.push(floraHolder);

/* ---------------------------------------------------------------- *
 *  The deep's filmed epilogue -- assets/deep-bg/ as a scrubbed WebP
 *  frame sequence (the technique the GTA VI site uses for its scroll
 *  films, at the user's call). See src/filmseq.js for the measurements
 *  that justify it over the <video> scrub this replaces: 19.6ms per
 *  video seek against ~0ms for an already-decoded frame, and 315 true
 *  Topaz-upscaled frames instead of 60fps motion-interpolated ones.
 *
 *  A 13s AI-generated shot built FROM a capture of the deep's settled frame:
 *  its first frame is this scene's own composition (same planets, same
 *  foliage), an astronaut then rises with the glowing vine column, and the
 *  last frame is the column at rest. Because frame 0 matches the live render,
 *  fading the plane in over the settled deep reads as the scene coming alive
 *  rather than as a video starting -- that is the entire trick, and it is why
 *  this is a plane in the SCENE and not a DOM overlay: in the canvas it goes
 *  through the same grade, DOF, bloom and -- critically -- the burst->work
 *  WIPE as everything else. A DOM video would sit above the canvas and the
 *  seam could never consume it. (The DOM it must stay under -- the real nav --
 *  already renders above the canvas, which is also why the footage's burned-in
 *  nav copy was scrubbed out rather than kept.)
 *
 *  PLACED AT THE MARK'S DEPTH (z 0), not near the camera: the deep's DOF
 *  focuses on the mark's plane, so a screen-covering quad anywhere nearer
 *  would be defocus-blurred into mush. At z 0 it sits ON the focal plane, and
 *  the layout falls out of the depth test: everything BEHIND z 0 (nebula,
 *  planets, far beds) is covered by the plane, while the near foreground ferns
 *  still draw over it -- live parallax framing the film, which is what sells
 *  the takeover as one continuous scene.
 *
 *  SCROLL-SCRUBBED, at the user's call -- the wheel is the film's transport.
 *  The sequence's frame index is a pure function of scroll (see the frame
 *  loop); nothing plays on its own clock. */
/* the renderer is passed in so the frame swap can use copyTextureToTexture
 * (texSubImage2D) instead of reallocating the texture every frame -- see the
 * blit in filmseq.js */
const film = buildFilmSequence(renderer);
/* Blobs start downloading now. The deep is ~525vh of scroll away, so by the
 * time the film is needed the 33MB is long since in memory -- and the frame
 * loop degrades gracefully anyway: an undecoded frame just holds the previous
 * one rather than flashing. */
film.preload();
const deepBgTex = film.texture;
/* Mirrored wrap for the CEILING's Snell-window sample, which displaces
 * outside 0..1 (water.js). The film plane itself samples 0..1, so this
 * changes nothing about how the footage renders on screen. */
deepBgTex.wrapS = deepBgTex.wrapT = THREE.MirroredRepeatWrapping;
const deepBgMat = new THREE.MeshBasicMaterial({
  map: deepBgTex, transparent: true, opacity: 0,
  /* the volume's exp2 fog at ~42 units would eat most of the plane; the film
   * carries its own atmosphere */
  fog: false,
  /* depthWrite ON, unusual for a transparent quad, and load-bearing: the DOF
   * pass reads the depth buffer, and with no write the film's pixels carried
   * the depth of whatever sat BEHIND the plane -- the nebula and planets tens
   * of units past focus -- so the whole film was blurred as if it were the far
   * background. That was the user's "video is blurry". Writing depth stamps
   * the film at z 0, on the focal plane: sharp. The foreground ferns draw
   * after (nearer in the transparent sort), write their own depth over it, and
   * keep their soft near-field CoC -- "in foliage keep it good" -- exactly as
   * before. Ordering is safe: everything behind the plane has already drawn by
   * the time its depth lands. */
  depthWrite: true,
});
/* 16x9 base so cover-fit is a single uniform scale -- see the staging */
const deepBgMesh = new THREE.Mesh(new THREE.PlaneGeometry(16, 9), deepBgMat);
const deepBgHolder = new THREE.Group();
deepBgHolder.add(deepBgMesh);
scene.add(deepBgHolder);
deepBgHolder.visible = false;
refractExclude.push(deepBgHolder);
window.__film = film;   // debug: frame index, cache state, load progress

/* ---------------------------------------------------------------- *
 *  THE WATER -- Active Theory's TreeWaterShader surface, on THEIR framing.
 *
 *  Not a section, not a backdrop, not a wipe. One world-fixed horizontal
 *  plane lying below the deep, revealed by the eye continuing to sink in
 *  burst's tail. Their numbers, scraped off the live site (docs SS3b):
 *  their water is a huge plane at rotation -90, and their TreeScene camera
 *  sits at [0,5,32] looking at [-2,4.74,6] -- the eye ~4.5 UNITS ABOVE THE
 *  SURFACE, looking essentially level. WATER_SINK lands us on exactly that.
 *
 *  WHY THE FILM CANNOT MOVE OR VANISH. The film's staging positions it at
 *  `eyeY + tan(HOME_PITCH)*eyeZ` -- purely eye-relative -- so when the eye
 *  sinks, the film sinks with it and its screen framing is IDENTICAL at
 *  every point of the descent. The same is true of the flora and planets,
 *  which copy camGroup. The water is the ONLY world-fixed thing here, so
 *  the sink moves nothing on screen except the water rising into frame.
 *  (An earlier build froze the film in world space and descended past it.
 *  That is what "the frames are gone" was, and it is not what this does.)
 *
 *  THE GEOMETRY, against the parked pose (eye y -4.5, z 45, pitch 3.7 up,
 *  fov 30 so the frustum's half-angle is 15):
 *    - the frame's bottom edge at the film's depth is eyeY - 9.14, so the
 *      surface's start height (-14.6) is BELOW the frame while the eye is
 *      parked: the water is genuinely out of shot, not faded out.
 *    - the sink drops the eye 5.0 while the surface RISES to -12.4 (see
 *      WATER_Y_FROM/_TO below): they meet in the middle -- eye ~2.9 over
 *      the water at the tableau, near their 4.5-over framing but tighter,
 *      because the risen surface is what puts the waterline through the
 *      parted plant bases instead of leaving a dark gap under them.
 *    - the plane runs from behind the eye to well past the film, but the
 *      film is opaque and depth-writing at z 0, so it OCCLUDES the water
 *      beyond it. The visible waterline is therefore precisely where the
 *      surface meets the film plane -- the water ends in the footage's own
 *      foliage rather than at a mathematical horizon.
 * ---------------------------------------------------------------- */
/* THE WATER RISES as the foliage parts -- the two halves of one motion.
 * A fixed surface left a dark strip between the plant bases and the water
 * (the user circled it): the beds' bases settle around y -12.3, so a plane
 * at -14 could never touch them. The surface now climbs -14.6 -> -12.4
 * across the sink, arriving while the fringe is still lifting: by the
 * tableau the bases sit at and under the waterline and the grass stands
 * IN the water. -14.6 keeps it below the parked frustum's floor, so the
 * approved film framing still never shows it. */
/* THE FILM'S OWN PLANETS, measured off frame 1 of the sequence (the frame
 * the crossfade lands on): luminance-thresholded discs in the 1920x1080
 * plate, centres and radii taken from their HORIZONTAL extents because the
 * foliage occludes both lower limbs. u,v are film uv (v from the bottom);
 * r is the radius as a fraction of the film's HEIGHT; z is the world depth
 * to hang our matching body at; geoR is the radius its SphereGeometry was
 * built with, which the scale below divides out.
 *
 * The 3D bodies are placed by RAY through these film points rather than by
 * authored xyz -- see the planets block in stageSection -- so they project
 * onto their filmed counterparts at ANY aspect ratio. A hand-tuned xyz can
 * only match one window size, because the film's cover-fit crops
 * differently as the aspect changes. */
const FILM_PLANETS = [
  { u: 0.231, v: 0.5315, r: 0.1704, z: -21, geoR: 6.0 },   // the big left body
  { u: 0.719, v: 0.2444, r: 0.1315, z: -21, geoR: 4.4 },   // the lower-right body
];
/* (the pin window is declared with FILM_START_VH, which this file defines
 * further down -- see PLANET_PIN_A_VH there) */

/* 4.2, cut by exactly FILM_DRIFT_UNITS (0.8) when the scrub stopped
 * parking the camera: the drift now delivers the eye to -5.3 instead of
 * -4.5 before the sink begins, so the sink carries 0.8 less to land the
 * tableau on the SAME -9.5 it was verified at, and every number after it
 * -- the plunge's 2.85, the 0.05 clearance over the risen surface, the
 * boundary cut -- holds unchanged. */
/* WATER_SINK 2.2, DOWN FROM 4.2 -- paired with FILM_DRIFT_UNITS below, and
 * the pairing is the whole point.
 *
 * THE INVARIANT: filmDrift + WATER_SINK + WATER_PLUNGE_UNITS must total 7.85.
 * All three subtract from the same camGroup.y, and 7.85 is what puts the eye
 * at -12.35 -- exactly 0.05 above the risen surface -- at the boundary. Change
 * any one of them alone and the crossing moves vertically.
 *
 * That is not hypothetical: raising the drift on its own to 2.4 pushed the sum
 * to 9.45, sank the crossing 1.6 units, and put the camera UNDER the water
 * from about burstVh 455 onward. Every frame after that was rendered from
 * below the surface, which is what the client saw as a glitchy shimmering
 * band. It was reverted.
 *
 * So the travel the film section needs is TRANSFERRED from the sink rather
 * than added: 2.8 + 2.2 + 2.85 = 7.85. The eye still arrives in exactly the
 * same place, it simply gets there by descending earlier and more evenly --
 * which is the parallax that was wanted -- instead of hanging still through
 * the film and then dropping 4.2 in the tableau. */
const WATER_Y_FROM = -14.6, WATER_Y_TO = -12.4, WATER_SINK = 2.2;
/* 360..405, moved up from 355..470 when the film's runway was cut.
 *
 * This window drives BOTH the camera's 4.2-unit sink and the surface's own
 * rise, so it is the window in which the water becomes a thing you can see.
 *
 * IT OVERLAPS THE FILM BY 39VH, AND THAT IS FINE -- but only for a reason
 * worth writing down, because the arithmetic looks alarming.
 *
 * 360 was chosen to open one vh after the film's last frame when FILM_SPAN
 * was 150 (209 + 150 = 359). The span later went to 190, so the scrub now
 * runs to 399 and the surface is ~95% risen before the footage ends. The
 * comment here used to claim the separation was "unconditional: at every
 * frame the film is up, the water is still parked at WATER_Y_FROM". That is
 * no longer true and has not been since the span changed.
 *
 * What IS still true is the thing the client actually asked for -- no water
 * in the film's frame -- because the guard was never really the window. It
 * is the EYE. Through the whole overlap the eye is still high (about -9.4 at
 * burstVh 399) and pitched up by HOME_PITCH, so the risen surface at ~-12.5
 * sits three units below the frustum floor and simply is not in shot.
 * Verified by rendering burstVh 370/385/399 (track 755/770/784) at the worst
 * case -- last frame, 95% risen -- with no waterline anywhere in frame.
 *
 * So the windows are deliberately NOT re-derived from the film constants.
 * Doing that would push the water's arrival ~40vh later and move the
 * water-under-the-grass composition the client signed off on, to fix
 * something that does not happen. If the eye's height in this stretch ever
 * changes, re-check by rendering those three stops -- the eye is the
 * invariant, not the gap between the windows. */
const WATER_SINK_A_VH = 360, WATER_SINK_B_VH = 405;
/* THE PLUNGE -- the crossing itself. After the tableau breathes (470..490),
 * the eye falls the last 4.45 units and arrives 0.05 ABOVE the surface at
 * burstVh 518, two vh before the section boundary: the waterline has risen
 * to ~38% of frame (the demo's composition) and the cut to the underwater
 * side lands while the camera is at its fastest -- ease-IN (t*t), because a
 * fall accelerates; the speed is what hides the flip. There is NO WIPE at
 * this boundary any more: the crossing IS the camera passing through the
 * surface, burst side ending just above it, work side opening just under
 * its ceiling at the same fov. */
/* 2.85, retuned from 4.45 when the surface learned to rise: the plunge ends
 * 0.05 above the RISEN surface (-12.4), i.e. eye -12.35 at burstVh 518. */
/* 400..518, ONE continuous fall, and the window is the fix. The fall was
 * briefly split into a fast skim (400..420) plus a late settle (490..518),
 * which parked the eye at exactly -11.5 for the 70vh between them -- the
 * client's "viewport gets stuck": every other descent curve has saturated
 * by then (filmDrift at 399, the sink at 405, hpF long pinned), so for
 * 805..875 of track NOTHING on screen moved, and when the wipe band opened
 * at 825 the only motion in the frame was the cut line itself -- which is
 * what made the crossing read as a section sliding up rather than a dive.
 *
 * One smoothstep over the whole 118vh keeps the eye falling continuously
 * from the film's last frame to the boundary pose. Endpoint bit-identical:
 * 2.85 units, arriving 0.05 above the risen surface at 518. The eye enters
 * the mirror guard's 0.25 band for roughly the last 25vh -- it always
 * entered it at the end (the old settle spent its own tail inside it); now
 * it PASSES THROUGH at ~0.02 u/vh instead of parking at 0.05 for 100vh,
 * which is what made the stale-mirror wedge visible before. Verified
 * against the wedge frames after the change. */
const WATER_PLUNGE_A_VH = 400, WATER_PLUNGE_B_VH = 518, WATER_PLUNGE_UNITS = 2.85;
/* The whole tail descent -- sink then plunge -- as one pure curve. Shared by
 * the camera branch and the vegetation staging: the foliage PARTS for the
 * water by rising against it (see the flora staging), and both readings come
 * from this same number so they can never drift apart. */
function waterTailDrop(v) {
  const s = WATER_SINK * smoothstep(WATER_SINK_A_VH, WATER_SINK_B_VH, v);
  const t = Math.min(1, Math.max(0,
    (v - WATER_PLUNGE_A_VH) / (WATER_PLUNGE_B_VH - WATER_PLUNGE_A_VH)));
  /* t*t*(3-2t), NOT t*t, and this is a continuity fix rather than a taste one.
   *
   * t is a CLAMPED ramp, so t*t leaves the plunge travelling at full speed and
   * then stops it dead the instant t reaches 1. Measured on this curve: the
   * rise is moving 0.1999 units per vh at burstVh 517.5 and exactly 0.0000 at
   * 518.5 -- a hard velocity step, two vh before the section boundary. The
   * camera reads it as a jolt; the foliage, which rides 0.75 of this same
   * number, reads it as the rise snapping to a halt. That is the "uneven
   * keyframes" in the foliage going up, and no amount of easing the SCROLL can
   * hide it, because the discontinuity is in the curve the scroll drives.
   *
   * smoothstep has zero derivative at BOTH ends, so the fall still starts from
   * rest and accelerates -- the "a fall accelerates" intent is kept through
   * the first half -- but it also arrives at rest. Same 0.1519 peak speed in
   * the middle, 0.0107 at 517.5.
   *
   * The endpoint is bit-identical: t*t and t*t*(3-2t) both equal 1 at t=1, so
   * the plunge still lands on exactly WATER_PLUNGE_UNITS and every framing
   * solved against the tail's end is untouched. Only the shape between
   * changes. */
  return s + WATER_PLUNGE_UNITS * t * t * (3 - 2 * t);
}
/* THE SCRUB DRIFT -- the viewport does not lock while the film plays.
 *
 * With the camera parked, the scrub read as a video playing in a frozen
 * frame -- the user's "locked viewport". So the eye keeps sinking gently
 * across the film's whole span. The film plane is eye-locked (its staging
 * recomputes from the current eye), so the FOOTAGE's framing does not move
 * a pixel and the planet pinning stays glued; what moves is the REAL 3D
 * layer -- the flora fringe and foliage walls anchor partially to the world
 * (their staging), and the world-fixed grain and mist drift free -- so the
 * live foreground slides slowly against the footage. That relative slide is
 * the parallax that says "still travelling", without touching the film.
 *
 * 0.8 units is the ceiling that keeps the water out of it: at full drift
 * the frustum's floor on the film plane is y -14.44, still above the
 * surface's hidden start at -14.6. smoothstep ends at zero velocity, so
 * the hand-off into the water sink at 355 is C1-smooth. Pure in burstVh.
 * Defined here but reading FILM_START_VH from below -- legal because the
 * body only evaluates at call time, unlike the const-to-const TDZ that bit
 * the planet pin. */
/* 2.8, from 0.8. At 0.8 the eye fell 0.69 units across 146vh of scroll while
 * the footage, being eye-locked, did not move at all -- a still frame with a
 * video playing in it, which is the "locked viewport" this drift exists to
 * cure. At 2.8 the same stretch travels 2.42 units, and because floraHolder
 * re-adds 0.65 of the drift the foreground slides against the footage by 1.57
 * instead of 0.45: three and a half times the parallax.
 *
 * Paid for out of WATER_SINK, NOT added on top -- see the invariant there.
 * Verified across the whole descent rather than at one sample (the mistake
 * that let the underwater regression through): minimum eye-to-surface
 * clearance 0.050 at burstVh 518 and never negative anywhere in 200..520,
 * boundary eye -12.35 unchanged, descent monotonic throughout.
 *
 * smoothstep still ends at zero velocity, so the hand-off into the sink stays
 * C1-smooth. */
const FILM_DRIFT_UNITS = 2.8;
function filmDrift(v) {
  return FILM_DRIFT_UNITS *
    smoothstep(FILM_START_VH, FILM_START_VH + FILM_SPAN_VH, v);
}
/* the surface itself is built below, once their waternormals upload exists */
/* ---------------------------------------------------------------- *
 *  Glass emblem — ONE instance, shared by sections 1 and 2
 *
 *  Home and About both centre the glass mark, and they are never on screen at
 *  the same time, so a single instance serves both. That is not only cheaper: two
 *  instances would mean two emblem-glass programs and two more objects in the
 *  refraction-exclude list for no visible gain.
 *
 *  It hangs off `scene`, not off a section root, and each section's rig assigns
 *  its transform and its visibility. It never appears in the Work section — that
 *  overlap, the emblem sitting inside the spine and the flower cloud, is what
 *  made section three unusable.
 *
 *  ?only=emblem  isolate it against the cloud, for material work only
 * ---------------------------------------------------------------- */
let emblem = null;
const emblemPos = new THREE.Vector3();

/* Rim lights for the emblem, at SCENE level rather than inside its group.
 *
 * loadEmblem parents two PointLights into the group it returns, which cannot be
 * used here: the group's `.visible` is toggled every time the sections change,
 * and three's projectObject early-returns on an invisible subtree, so the lights
 * would leave the light list. Light counts are in the program cache key, so every
 * lit material in the scene -- including the 840k-triangle spine -- would compile
 * a fresh program at each boundary crossing.
 *
 * These two live on a holder that is ALWAYS visible and simply follows the
 * emblem. Their intensity goes to zero outside sections 1 and 2, which is the
 * remedy invariant 1 in sections.js prescribes: intensity is not in the cache key.
 *
 * Offsets and colours are copied from loadEmblem's own rim pair. They are not
 * parented under the mark's rotation there either -- the mesh spins inside the
 * group while the lights hold station -- so following position alone reproduces
 * the same travelling highlight. */
const emblemRig = new THREE.Group();
scene.add(emblemRig);
const EMBLEM_RIM = 22;
const emblemRimA = new THREE.PointLight(0xffffff, 0, 14, 2);
emblemRimA.position.set(-3.2, 3.0, 3.0);
const emblemRimB = new THREE.PointLight(0xbfffe0, 0, 14, 2);
emblemRimB.position.set(3.4, -1.4, 2.2);
emblemRig.add(emblemRimA, emblemRimB);

readyTasks.push(
  loadEmblem(shared, {
    /* 5.0, not the 4.0 the isolation view used. Their Home numbers imply a mark
     * of roughly this size: the tails hang 20 units below it, the camera sits
     * 30-45 units out at fov 30, and the mark reads as about a third of frame
     * height in their reference. */
    targetHeight: 5.0,
    /* renderer + rimLights are gone from the options: the AboutLogoShader port is
     * unlit (no PMREM env to build, no lights to see). The scene-level emblemRig
     * above stays -- its lights are in every lit material's program cache key. */
    // the scene snapshot it refracts; the emblem is excluded from this buffer
    refraction: refractionRT.texture,
  })
    .then(e => {
      emblem = e;
      scene.add(e.group);
      refractExclude.push(e.group);   // glass samples the buffer it would be drawn into
      if (ONLY === 'emblem') e.group.position.set(0, -6.0, 0);
      console.log('emblem.glb', JSON.stringify(e.stats));
    }).catch(err => console.warn('emblem.glb failed:', err.message))
);

/* The spine GLB's group, once loaded — the volumetric light source while the work
 * section fronts the frame. */
let spineGroup = null;

// Proxy column only exists as a fallback if the GLB fails to load.
const proxy = buildSpine(shared);
proxy.visible = false;
workRoot.add(proxy);

// ?spine=off skips the model entirely; ?spine=high|max|raw picks the build
// ?only=emblem skips the column: it occupies the same space and makes the
// emblem's material impossible to read against it
if (QUERY.get('spine') !== 'off' && ONLY !== 'emblem') {
  readyTasks.push(
    loadSpine(shared, {
      // ?spine=sharp|high|max|raw — sharp by default, see QUALITY_FILES
      quality: QUERY.get('spine') || 'sharp',
    }).then(({ group, stats }) => {
      workRoot.add(group);   // spine GLB
      spineGroup = group;    // kept as a handle; no longer a god-ray source
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

/* THE WATER SURFACE -- see THE WATER above for the framing arithmetic.
 * Built here because it needs their waternormals upload.
 *
 * crackTex null on purpose: the ceiling half of the port is unused, and
 * makeCrackedIceTexture() draws from the shared seeded rand() stream --
 * calling it would shift every later consumer (strands, comet, the card
 * shuffle) off the approved look. The ceiling mesh is built but never added
 * to the scene, so its null map is never compiled. */
/* no crackTex any more: the underside stopped being the cracked-ice
 * caustic when the client ruled the two sides must be the same water --
 * see the ceiling fragment in water.js */
const water = buildWater(shared, {
  normalTex,
  filmTex: deepBgTex,
  matcapTex: loadJellyMatcap(),           // their matcap-test.jpg, same file
});
/* 260 square: from behind the eye to far past the film, wider than any
 * frustum. Their own plane is size 20 at scale 100 -- effectively infinite,
 * same intent. */
water.topside.geometry.dispose();
water.topside.geometry = new THREE.PlaneGeometry(260, 260);
water.topside.position.set(0, WATER_Y_FROM, 0);   // staged: rises with the tail
water.topMat.uniforms.uAlpha.value = 1;   // no fade: it arrives by parallax
scene.add(water.topside);
water.topside.visible = false;
/* the UNDERSIDE: the same surface seen from below, over the card room --
 * their WaterCeilingShader, at the dfe3a04 pose verified live back then
 * (y 2.0 clears the rail-start eye at y 1 by one unit; the spine pierces
 * it exactly as their column pierces theirs). Staged with work. */
scene.add(water.ceiling);
water.ceiling.visible = false;
/* NOT refraction-excluded: the cards' glass should refract the water like
 * anything else once the crossing starts. */
window.__water = water;

/* THE ALCOVE -- their vegetated room, revealed around the coin across burst
 * (the vegg.mp4 reference). Their structure, pillars, cables, and their bush
 * scattered by their own baked instance table; the window is the shared showreel
 * the cards already decode. Async like every env asset; staged below. */
const alcove = buildAlcove(shared, { video: video.texture, poolTex: loadPoolTexture() });
scene.add(alcove.group);
alcove.ready.then(s => { if (s) console.log('alcove', JSON.stringify(s)); });

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

/* ---------------------------------------------------------------- *
 *  Sections 1 and 2
 * ---------------------------------------------------------------- */
/* Built here rather than earlier in the file because it needs the shared video
 * texture declared above -- their columns soft-light it through themselves. */
const home = buildHome(shared, {
  refraction: refractionRT.texture,
  map: makeStrandTexture(),
  video: video.texture,
  matcap: makeBubbleMatcap(),
  palette: PALETTE,
  plumeCount: LOW ? 8000 : 30000,
});
homeRoot.add(home.group);
/* Reparent the plume into the shared atmosphere. THREE.add removes it from
 * home.group, so the tails stay Home-only (they hang off the mark and belong to it)
 * while the particle volume carries across into About. */
atmosRoot.add(home.plume);
/* The columns sample tRefraction, so they must not be drawn into it -- same
 * feedback loop as the cards and the emblem. Pushed individually rather than as
 * the whole home group on purpose: the plume does NOT read the buffer, and it is
 * the main thing sitting behind the mark, so it has to stay in the snapshot or
 * the glass has nothing to refract. */
for (const c of home.columns) refractExclude.push(c);

/* The three reference-frame set pieces, each at scene level rather than inside a
 * section root because each appears in MORE than one section: the jellyfish is in
 * images 1 and 2, the comet in 2 and 3, the nebula in 1 and 3. stageSection places
 * and fades them per section instead of toggling subtrees. */
/* Holders, because both modules animate their OWN group transform -- the jelly's
 * bob assigns position every update and the comet accumulates drift. Placing those
 * groups from stageSection fought that animation frame by frame (the jelly simply
 * teleported back to origin). The holder is the section's to place; the module's
 * group animates freely inside it. */
/* Their crystal matcap and cracked-membrane normal map, shared by every jelly --
 * one upload each. Both are bound on every JellyShader instance in uil.json. */
const jellyMatcap = loadJellyMatcap();
const jellyNormal = loadJellyNormal();
/* scale 2.3, and the pleasing part is that it lands inside THEIR OWN RANGE.
 *
 * Their JellyInstancer scatters instances with scale.setScalar(random(1.5, 3)) and then
 * scale.y *= 1.5. Their model is natively 2.052 tall, so stretched it is 3.078.
 *
 * Framing, measured: the jellyfish sits 38 units from the camera and a 30-degree FOV
 * spans 20.4 world units vertically there. Active Theory's own 1671x949 frame puts the
 * body at 330px tall, 34.8% of frame height, which is 7.1 world units here -- so the
 * uniform scale wanted is 7.1 / 3.078 = 2.31. Their random(1.5, 3) brackets that
 * almost exactly, which is a good sign the camera distance is right too.
 *
 * (For the record on why this matters: at scale 1 the creature was 11.3% of frame
 * height, about 30px on a 426px viewport. A bell that small IS a horizontal line and a
 * body that small IS a couple of stripes, which no amount of geometry or shading work
 * can survive.) */
const jelly = buildJelly(shared, { refraction: refractionRT.texture, matcap: jellyMatcap,
                                  normalMap: jellyNormal, scale: 2.3 });
const jellyHolder = new THREE.Group();
jellyHolder.add(jelly.group);
scene.add(jellyHolder);

/* ---- THE LANDING'S JELLYFISH FIELD, off reference image 1.
 *
 * Image 1 has FIVE: one large specimen at frame left and four small ones scattered into
 * the distance. A previous pass built a landing swarm, decided it crowded the mark and
 * the headline, and deleted it -- but that was with the hand-built creature, and the
 * reference plainly shows them. With their model it is worth having, and the depth
 * arrangement is most of what makes image 1 read as a place rather than objects on black.
 *
 * Positions are SOLVED against the land camera, not guessed. Land sits at camGroup (0,0,0)
 * with camera z 15 and a 30-degree fov, so for an object at world z the frame spans
 *
 *     frameH = 2 * (15 - z) * tan(15 deg) = 0.5359 * (15 - z)
 *
 * and the model is 3.078 units tall once their 1.5x y-stretch is applied. Each entry
 * below was derived from a measurement off image 1 (percentage of frame height for size,
 * percentage of frame width for x, percentage from frame top for the bell) and then
 * converted through that relation. The measured targets, for the record:
 *
 *     near left    51.6% of frame height, bell at 14.2% width, top at 39.0%
 *     top edge     11.0%,  21.2%,  3.2%   (bell clipped by the frame edge, as theirs is)
 *     mid left     12.6%,  24.4%, 20.8%
 *     right        9.5%,   68.0%, 17.9%
 *     far right    6.8%,   88.1%, 42.9%
 *
 * Note the two levers: the near specimen gets a large scale at a moderate z, the far ones
 * smaller scales further back. Matching apparent size by distance ALONE would have put the
 * smallest at z -160, well beyond where the fog leaves anything visible.
 *
 * rotationY is theirs -- radians(90) * i, from JellyInstancer. All five clones share one
 * material and therefore one set of sway uniforms, so without it they would sway in
 * lockstep; rotating each sends the same object-space displacement a different way.
 *
 * x is in world units at a 16:9 frame, consistent with how nebula, comet and the mark are
 * placed in this file. On much wider or narrower viewports the horizontal spread drifts,
 * which for background scenery reads as a different camera rather than as a bug.
 */
const LAND_JELLY = [
  { position: new THREE.Vector3(-7.85, -1.83, -8), scale: 2.07 },
  { position: new THREE.Vector3(-10.14, 8.18, -22), scale: 0.71 },
  { position: new THREE.Vector3(-9.75, 4.90, -25), scale: 0.88 },
  { position: new THREE.Vector3(8.06, 6.89, -32), scale: 0.78 },
  { position: new THREE.Vector3(19.96, 1.09, -40), scale: 0.65 },
];
const jellyLand = new THREE.Group();
LAND_JELLY.forEach((spec, i) =>
  jellyLand.add(jelly.instance({ ...spec, rotationY: Math.PI / 2 * i })));
scene.add(jellyLand);
// same feedback rule as the volume specimen: they sample tRefraction, so they cannot
// be in the scene while it is being rendered
refractExclude.push(jellyLand);

refractExclude.push(jelly.group);   // its cap samples tRefraction — feedback rule

/* NO SWARM. A previous pass built four extra jellyfish at different scales and
 * depths for the landing, reading reference image 1 as having several. On our frame
 * they crowded the mark and the headline, and the landing is stronger with none --
 * so they were removed outright rather than left hidden. Reference image 2, which is
 * the hero volume, is where the single specimen actually belongs, and `jelly` above
 * is that one. Deleting them rather than hiding them is deliberate: four unused
 * jellyfish are five meshes each of geometry plus their materials' programs, all
 * uploaded and compiled at load for nothing. */

const comet = buildComet(shared, {});
const cometHolder = new THREE.Group();
cometHolder.add(comet.group);
scene.add(cometHolder);

const nebula = buildNebula(shared, {});
scene.add(nebula.group);

/* The MIST — a second nebula instance with its own config, and the single biggest
 * texture difference between our frames and the references. Their darkness is
 * never empty: large, almost-colourless smoky volumes sit between the grain
 * layers everywhere, and the coloured nebula reads as accents ON that murk, not
 * as stickers on black. These are huge (26-44 units), desaturated grey-olive, at
 * alphas so low each one is barely perceptible alone -- their sum is the
 * atmosphere. Parented to ambienceRoot so every section carries it, the spine
 * included; work's 1.6x ambience scale makes them wrap the card orbit. */
const MIST_CONFIG = [
  { tint: '#6b7460', position: [-8, 4, -16], scale: [34, 20], alpha: 0.060, noiseScale: 1.3, rotate: 0.2, seed: 61.2 },
  { tint: '#55604e', position: [7, -2, -20], scale: [40, 24], alpha: 0.055, noiseScale: 1.1, rotate: -0.3, seed: 12.8 },
  { tint: '#7a836b', position: [0, 8, -18], scale: [30, 16], alpha: 0.050, noiseScale: 1.5, rotate: 0.4, seed: 33.5 },
  { tint: '#4c5850', position: [-3, -7, -22], scale: [44, 22], alpha: 0.050, noiseScale: 1.0, rotate: -0.2, seed: 47.9 },
  { tint: '#8b927a', position: [10, 5, -24], scale: [26, 15], alpha: 0.045, noiseScale: 1.7, rotate: 0.5, seed: 5.6 },
  { tint: '#5e6a5a', position: [-12, 0, -26], scale: [36, 20], alpha: 0.050, noiseScale: 1.2, rotate: -0.4, seed: 78.3 },
];
const mist = buildNebula(shared, { clouds: MIST_CONFIG, aurora: 0 });
ambienceRoot.add(mist.group);

const about = buildAbout();

const projects = shuffled(PROJECTS);
const { group: cardGroup, cards } = buildCards(projects, shared, {
  env: envTex, normal: normalTex, video: video.texture, refraction: refractionRT.texture,
});
workRoot.add(cardGroup);
refractExclude.push(cardGroup);   // cards sample refractionRT through radialBlur()

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

/* Track is now the sum of the three sections: Home 420 + About 105 + Work 1050.
 *
 * Work lands on a 950vh span, which is exactly the travel a 1050vh track used to
 * give, so its local progress is bit-identical to the old global scalar. See
 * src/sections.js for the algebra and test/ranges.mjs for the proof.
 *
 * Set BEFORE the Lenis constructor below. Lenis reads the content height when it
 * is created, so any later height change would need lenis.resize() + readScroll().
 * Keeping the order is the invariant. */
const RANGES = buildRanges(SECTION_VH);
track.style.height = `${RANGES.totalVh}vh`;
let scrollProgress = 0, smoothProgress = 0, scrollDelta = 0, prevProgress = 0;
/* Per-section state, recomputed once per frame. `S.work.progress` is what every
 * consumer that used to read the global scalar now reads. */
let S = sectionState(0, RANGES);
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

/* Numeric probe for regression checking.
 *
 * Screenshots are a bad oracle for this project: shuffled(PROJECTS) reseeds every
 * load, makeSharedVideoTexture randomises its blobs, and uSparkle accumulates
 * without bound, so two runs never match byte-for-byte. These values are derived
 * from card INDEX and scroll alone, so they are reproducible -- which is what makes
 * "section 3 is unchanged" a JSON diff instead of a judgement call.
 *
 * renderer.info.programs is in here deliberately: a light-count or fog-define
 * change forces new program compiles, and that is otherwise invisible. */
/* Runtime overrides for A/B-ing one term at a time.
 *
 * Added because the frame is a stack of additive contributions -- particles,
 * bloom, god rays, corner glow -- and when it comes out washed there is no way to
 * tell which one did it by reading code. Setting a term to 0 and taking one
 * screenshot answers it in a single step, which is faster and more reliable than
 * reasoning about the shader. `__over.vol = 0` isolates the volumetric add. */
window.__over = {};
/* Set by the frame loop so the probe can report which section fronts the frame and
 * whether a wipe is mid-flight -- both invisible from the outside, and both easy to
 * mistake for a rendering bug when a seam shows up on screen. */
window.__frameState = { front: '', tr: null };
window.__dbg = () => ({
  front: window.__frameState.front,
  tr: window.__frameState.tr,
  /* Which roots are up and how the shared atmosphere is configured. Added after a
   * frame came out as an unreadable green wash while every camera number in this
   * probe was correct -- proving the rig was fine and sending the search to what
   * was actually being drawn. */
  vis: [workRoot.visible, homeRoot.visible, aboutRoot.visible, atmosRoot.visible,
        emblem ? emblem.group.visible : null].map(v => (v === null ? '-' : (v ? 1 : 0))).join(''),
  atmosZ: atmosRoot.position.z,
  sceneTris: window.__frameState.tris,
  sceneCalls: window.__frameState.drawCalls,
  plumeAlpha: home.plumeUniforms.uAlpha.value,
  colAlpha: home.columnUniforms[0].uAlpha.value,
  progress: +smoothProgress.toFixed(6),
  camPos: camGroup.position.toArray().map(v => +v.toFixed(5)),
  camQuat: camGroup.quaternion.toArray().map(v => +v.toFixed(5)),
  camLocalZ: +camera.position.z.toFixed(5),
  fov: camera.fov,
  fogDensity: scene.fog ? +scene.fog.density.toFixed(6) : null,
  cull: cards.map(c => (c.pMat.uniforms.uCull.value > 0.004 ? 1 : 0)).join(''),
  uScrollComposite: +compositePass.uniforms.uScroll.value.toFixed(5),
  uScrollFlowers: flowers ? +flowers.uniforms.uScroll.value.toFixed(5) : null,
  programs: renderer.info.programs.length,
  calls: renderer.info.render.calls,
  /* the live range table, so console tooling can locate a section instead of
   * hard-coding its start -- test/sweep.js hard-coded 525 and kept sampling
   * burst long after Work moved to 905 */
  ranges: RANGES,
});

const hint = document.getElementById('hint');
let hintHidden = false;
/* The chat panel is a Home element on their site, and it sits bottom-left where
 * About's headline lives, so it is hidden outside section 1. */
const chatDOM = document.querySelector('.ChatDOM');

/* The second nav pill swaps content per section, as the references do: image 1
 * shows "// SERVICES | OS", images 2-4 show a "QUANTUM HOP" pager. Cached label so
 * the DOM is only touched on an actual change. */
const navSubLabel = document.querySelector('.NavSubLabel');
const navSubCode = document.querySelector('.NavSubCode');
let navSubState = '';
function setNavSub(front) {
  const want = front === 'work' ? 'work' : (front === 'land' ? 'land' : 'volume');
  if (want === navSubState) return;
  navSubState = want;
  if (want === 'land') {
    navSubLabel.textContent = '// Services';
    navSubCode.textContent = 'OS';
  } else if (want === 'volume') {
    navSubLabel.textContent = '<< Quantum Hop';
    navSubCode.textContent = '>>';
  } else {
    navSubLabel.textContent = '// Work Index';
    navSubCode.textContent = String(PROJECTS.length).padStart(2, '0');
  }
}

/* ---------------------------------------------------------------- *
 *  Pointer + hover picking
 * ---------------------------------------------------------------- */
// Minimal tween matching Hydra's shader.tween(key, value, ms, ease, delay)
const easeOutSine = t => Math.sin((t * Math.PI) / 2);
const tweens = [];
function tweenUniform(uniform, to, ms, ease, delay = 0) {
  cancelTween(uniform);
  tweens.push({ u: uniform, from: uniform.value, to, ms, ease, delay, t: 0 });
}
/* Drop a uniform's in-flight tween without starting another.
 *
 * tweenUniform only ever de-duped as a side effect of starting a NEW tween on
 * the same uniform, so a caller that wanted to simply STOP one had no way to
 * say so -- and assigning uniform.value directly did not stop anything, it
 * just got overwritten on the next step. See the video-card handover, which
 * was silently relying on the assignment sticking. */
function cancelTween(uniform) {
  const i = tweens.findIndex(t => t.u === uniform);
  if (i > -1) tweens.splice(i, 1);
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

/* Drag-to-spin for sections 1 and 2, from their Home/About render ticks:
 *
 *   delta.lerp(Mouse.down ? Mouse.delta : zero, 0.07);
 *   rotation += delta.x * (Device.mobile ? 0.0075 : 0.0025);
 *
 * `dragRaw` stands in for their Mouse.delta and is consumed -- zeroed -- once per
 * frame. Theirs is not: Mouse.delta holds its last value until the next move
 * event, so a pointer held down but stationary keeps spinning the mark. Reading
 * that as a quirk rather than intent; zeroing makes a held, still pointer stop.
 * The 0.07 lerp is what carries the inertia after release either way. */
let pointerDown = false;
const dragRaw = new THREE.Vector2();
const dragDelta = new THREE.Vector2();
const ZERO2 = new THREE.Vector2();
const lastPointerPx = new THREE.Vector2();
let dragRotation = 0;

addEventListener('pointermove', e => {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  mouse01.set(e.clientX / innerWidth, e.clientY / innerHeight);
  /* A move event is proof the pointer is present, and it is the ONLY reliable
   * proof: pointerenter does not always pair with pointerleave (iframes,
   * embedded panes, a window regaining focus under a stationary cursor), and a
   * latched-false flag leaves the vegetation permanently inert. */
  pointerInside = true;
  if (pointerDown) {
    dragRaw.set(e.clientX - lastPointerPx.x, e.clientY - lastPointerPx.y);
    lastPointerPx.set(e.clientX, e.clientY);
  }
});
addEventListener('pointerdown', e => {
  pointerDown = true;
  lastPointerPx.set(e.clientX, e.clientY);
});
addEventListener('pointerup', () => { pointerDown = false; });
addEventListener('pointercancel', () => { pointerDown = false; });
/* Whether the cursor is over the canvas at all. A pointer that has left the
 * window must relax the vegetation rather than leave it held open, and
 * pointerleave on the document is the only event that reports it. */
let pointerInside = true;
document.addEventListener('pointerleave', () => { pointerInside = false; });
document.addEventListener('pointerenter', () => { pointerInside = true; });
/* Scratch for the cursor rod handed to flora each frame, in flora-local space. */
const curO = new THREE.Vector3(), curD = new THREE.Vector3(), curProbe = new THREE.Vector3();
let floraIdle = 0;
/* Eased pointer parallax for the hero camera. Heavily filtered (0.025/frame,
 * ~1.5s to settle) so the camera LAGS the cursor -- the environment reacts
 * first and the viewpoint follows, which is what keeps it feeling like a
 * floating camera rather than one bolted to the mouse. */
const camPar = new THREE.Vector2();
const camParTarget = new THREE.Vector2();
/* Liquid refraction state: previous pointer, its speed, and the damped
 * strength actually handed to the composite. */
const liqPrev = new THREE.Vector2();
let liqSpeed = 0, liqNow = 0;
/* scratch for the eased cursor handed to the slice refraction */
const cursorUv = new THREE.Vector2(0.5, 0.5);
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

/* ---------------------------------------------------------------- *
 *  Depth of field — a CoC gather pass reading the REAL depth buffer.
 *
 *  Why not BokehPass or an external composer: both re-render the scene's depth
 *  with an override material, and this scene's vegetation does its whole
 *  vertex transform (instance offset, quaternion, bend, current) in custom
 *  shaders. An override material knows none of that — every plant would write
 *  depth at its bed origin and the blur would key off garbage. Instead a
 *  DepthTexture rides the composer's OWN first target: the main render has
 *  already written correct depth for everything (instanced plants, points,
 *  glass), so we read that, for free, no second scene pass.
 *
 *  Parity: this pass sits IMMEDIATELY after RenderPass, so it always reads
 *  renderTarget2 (where RenderPass leaves color+depth) and writes rt1 — the
 *  depth texture is never an attachment of the buffer being written, which is
 *  what keeps this off the feedback-loop path.
 * ---------------------------------------------------------------- */
const sceneDepth = new THREE.DepthTexture(innerWidth, innerHeight);
/* Attached to renderTarget2 ONLY, and the pairing with the parity reset in the
 * frame loop is what makes that safe. Both halves are load-bearing:
 *
 *  - It must be on ONE target, not both. Sharing it across the ping-pong pair
 *    means the DOF pass samples a texture that is simultaneously the depth
 *    attachment of the framebuffer it is writing into -- a feedback loop, and
 *    WebGL is entitled to return anything for it. Tried, and it blurred the
 *    entire site including sections where DOF is switched off.
 *  - The parity must be pinned. EffectComposer.render() does NOT reset
 *    writeBuffer/readBuffer at the top of a frame; they carry over from
 *    wherever the previous frame's swaps left them, and the swap count depends
 *    on how many passes are ENABLED -- transitionPass toggles on only during a
 *    wipe. Left alone, the parity flips and RenderPass starts writing into
 *    renderTarget1 while DOF reads renderTarget2's whole-frame-stale depth,
 *    from a different camera position and mid-wipe a different section. That
 *    is the ghosting, and the alternation is the flicker.
 *
 * See the reset immediately before composer.render(). */
composer.renderTarget2.depthTexture = sceneDepth;
const DofShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uFocusDist: { value: 40.7 },   // camera->mark, updated per frame
    uAmount: { value: 0 },         // deepF-driven; 0 = pass-through
    uMaxCoC: { value: 7.0 },       // px at 680p, scaled by resolution
    uNear: { value: 0.05 },
    uFar: { value: 200 },
    uResolution: { value: new THREE.Vector2(innerWidth, innerHeight) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tDepth;
    uniform float uFocusDist, uAmount, uMaxCoC, uNear, uFar;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float viewZ(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      // perspective depth -> positive view distance
      return (uNear * uFar) / (uFar - d * (uFar - uNear));
    }
    /* signed circle of confusion in pixels: negative near-field, positive far */
    float coc(float z) {
      float c = (z - uFocusDist) / max(z, 1.0);
      return clamp(c, -1.0, 1.0) * uMaxCoC * (uResolution.y / 680.0);
    }

    void main() {
      vec3 sharp = texture2D(tDiffuse, vUv).rgb;
      if (uAmount < 0.003) { gl_FragColor = vec4(sharp, 1.0); return; }

      float cocC = coc(viewZ(vUv)) * uAmount;
      float r = abs(cocC);
      if (r < 0.5) { gl_FragColor = vec4(sharp, 1.0); return; }

      /* 16-tap GAUSSIAN gather on a poisson tap set.
       *
       * Two weights multiply per tap:
       *   gaussian  exp(-2.6 r²) on the tap's own radius -- a smooth falloff
       *             rather than a flat disc, so out-of-focus matter dissolves
       *             instead of acquiring a hard bokeh rim. At this scene's
       *             densities a disc kernel turns every bright dust mote into
       *             a visible ring; a gaussian just softens it.
       *   coc       the tap's OWN circle of confusion, so a sharp background
       *             pixel cannot smear across a blurred foreground leaf. This
       *             is the cheap gather's stand-in for true scatter.
       * The poisson positions stay: they decorrelate the sparse tap pattern so
       * 16 samples do not band, while the gaussian supplies the profile. */
      vec2 px = 1.0 / uResolution;
      vec3 acc = sharp; float wsum = 1.0;
      vec2 taps[16];
      taps[0]=vec2(0.94,0.28); taps[1]=vec2(-0.4,0.9); taps[2]=vec2(-0.86,-0.36); taps[3]=vec2(0.3,-0.85);
      taps[4]=vec2(0.55,0.72); taps[5]=vec2(-0.78,0.42); taps[6]=vec2(-0.32,-0.6); taps[7]=vec2(0.72,-0.44);
      taps[8]=vec2(0.18,0.5); taps[9]=vec2(-0.5,0.14); taps[10]=vec2(-0.1,-0.3); taps[11]=vec2(0.42,-0.12);
      taps[12]=vec2(0.1,0.95); taps[13]=vec2(-0.95,-0.05); taps[14]=vec2(0.05,-0.55); taps[15]=vec2(0.62,0.1);
      for (int i = 0; i < 16; i++) {
        vec2 o = taps[i] * r * px;
        float cocT = coc(viewZ(vUv + o)) * uAmount;
        /* gaussian profile on the tap's own radius */
        float gw = exp(-2.6 * dot(taps[i], taps[i]));
        /* a tap participates to the extent ITS blur circle reaches us */
        float w = gw * (clamp(abs(cocT) / max(r, 0.5), 0.0, 1.0) * 0.8 + 0.2);
        acc += texture2D(tDiffuse, vUv + o).rgb * w;
        wsum += w;
      }
      gl_FragColor = vec4(acc / wsum, 1.0);
    }`,
};
const dofPass = new ShaderPass(DofShader);
dofPass.uniforms.tDepth.value = sceneDepth;
composer.addPass(dofPass);
/* scratch for the per-frame focus solve */
const dofFocusV = new THREE.Vector3(), dofEyeV = new THREE.Vector3();

/* Section wipe, straight after the scene render and before bloom.
 *
 * RenderPass has just drawn the INCOMING section, which the shader reads as
 * tDiffuse; the outgoing one comes in as tMap1 from a target filled earlier in the
 * frame. Placing it here rather than at the end means bloom and the composite run
 * once over the mixed frame instead of once per scene -- see the note in
 * src/transition.js, which is explicit that this differs from their chain.
 *
 * Disabled outside a boundary band, so it costs nothing for all but 15vh either
 * side of each of the two seams. */
/* 90, from 30. The band is the whole width of the wipe in vh, centred on the
 * boundary, so it is literally how long the line spends sweeping the frame.
 * At 30 the seam crossed in a few frames of scroll -- fast enough to read as
 * a cut, which is exactly the complaint. Theirs is scrubbed off scroll
 * position with no time limit, so the only thing setting its pace is how much
 * scroll it is given. 90vh is roughly a second of unhurried scrolling: long
 * enough that the eye tracks the line travelling rather than noticing a
 * change. land->drift uses the same constant and is unaffected in character,
 * only in length. */
/* Per seam, because the two crossings are not the same kind of event.
 *
 * land->drift is an ordinary scene change: it wants to be long enough to read
 * as liquid and no longer. burst->work is a DESCENT THROUGH WATER, and this
 * band is literally how long that descent lasts on screen -- across it the
 * frame holds foliage above, the water body through the middle, and the spine
 * room below. At 90 the water was a glimpse between two scenes; at 160 it is a
 * passage you travel down, which is what the client's reference shows.
 *
 * These were ONE number until the widening, which stretched the land seam to
 * 160 as a side effect and left its wipe line crawling across the frame for
 * most of drift. transitionState takes a map now. */
const TRANSITION_VH = { drift: 90, work: 160 };
/* HalfFloat, to MATCH THE COMPOSER. EffectComposer's ping-pong targets are
 * HalfFloatType, so the incoming half of a wipe frame arrives at the mix in
 * HDR while these two defaulted to UnsignedByte -- the outgoing half was
 * quantised to 8 bits AND clamped at 1.0 first. Two visible asymmetries
 * across the seam: banding in the deep's near-black gradients on one side
 * only, and bloom (thresholded at 0.95 on the composited frame) firing on
 * the incoming half's over-range highlights while the same content on the
 * outgoing side had been flattened to 1.0 before the threshold ever saw it. */
/* DEVICE PIXELS, TO MATCH THE COMPOSER -- the same argument as HalfFloat
 * above, one axis over. EffectComposer sizes its ping-pong targets by
 * renderer.getPixelRatio(), so the incoming half of a wipe arrives at the mix
 * at w*DPR x h*DPR while these were built in CSS pixels: on a DPR 1.5 display
 * the outgoing half carried 44% of the incoming half's pixels and resolved
 * visibly softer against it.
 *
 * It also mattered to more than sharpness. Materials that normalise
 * gl_FragCoord.xy by shared.uResolution -- which is in DEVICE pixels (see
 * applySize) -- are correct in the composer chain and wrong when drawn into a
 * CSS-pixel target: the emblem, the home columns and the cards sampled only
 * the lower-left 1/DPR of the refraction snapshot on the outgoing side of the
 * land->drift wipe. Matching the sizes fixes both at once. */
const transitionRT = new THREE.WebGLRenderTarget(
  Math.round(innerWidth * DPR), Math.round(innerHeight * DPR), {
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
  type: THREE.HalfFloatType,
});
/* The outgoing half is rendered straight into transitionRT, outside the
 * composer, so it needs its own depth to be depth-of-field-able and its own
 * destination to be filtered INTO -- a pass cannot read and write one target.
 * Both only ever touched during a wipe. */
const transitionDepth = new THREE.DepthTexture(Math.round(innerWidth * DPR), Math.round(innerHeight * DPR));
transitionRT.depthTexture = transitionDepth;
const transitionDofRT = new THREE.WebGLRenderTarget(
  Math.round(innerWidth * DPR), Math.round(innerHeight * DPR), {
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
  type: THREE.HalfFloatType,
});
const transitionPass = new ShaderPass(TransitionShader);
transitionPass.uniforms.resolution.value = new THREE.Vector2(innerWidth, innerHeight);
transitionPass.enabled = false;
composer.addPass(transitionPass);

/* Volumetric light from the mark — their `volumetricLight.addLight(logo)`.
 *
 * Home only. Their HomeComposite.fs is the only composite of the three that adds a
 * tVolumetricBlur term, and the work spine has no light source to hang it on. */
/* Tint desaturated from the yellow-green it was. The rays are a broad additive
 * wash over a large part of frame, so a saturated tint on them pushes the whole
 * image toward one hue -- the same failure as the cloud ramp, in post rather than
 * in the geometry. A pale, barely-green white reads as light. */
const volumetric = buildVolumetricLight(renderer, { tint: '#e2ecd4' });
const VOLUMETRIC_STRENGTH = 0.5;
/* Sections 1 and 2's frame saturation. Dial live with `__over.sat = 0.5` in the
 * console; 1.0 is what the frame was before this existed. */
const HERO_SATURATION = 0.55;
// threshold sits just under the spine's emissive so the column blooms while
// the cards and particles keep their edges
/* strength, radius, threshold. Threshold 0.95, up from 0.58 originally: at that
 * level ordinary wet specular on the column cleared it, so every highlight fed
 * the bloom mips and the coarsest one returned them as hard blocks. Near 1.0
 * only genuinely blown values bloom -- the flower grains, which are what should
 * be glowing -- and the spine's sheen stays out of it. */
/* Authored strength, kept as a constant because the intro scales it: phase 1 wants
 * almost none and the burst wants several times this. */
const BLOOM_STRENGTH = 0.72;
const bloom = new UnrealBloomPass(
  new THREE.Vector2(innerWidth * BLOOM_SCALE, innerHeight * BLOOM_SCALE),
  BLOOM_STRENGTH, 0.55, 0.95);

/* Clamp the bloom input at the high-pass, before the mip chain ever sees it.
 *
 * Defence in depth against the class of failure that has now blacked this frame
 * twice by two different routes (a shader NaN, and a near-field specular spike over
 * the 65504 half-float ceiling). The mechanism is always the same downstream: one
 * non-finite texel enters the mip chain, the separable blur spreads it, and the
 * composite returns NaN across the whole canvas -- Inf passes ANY threshold because
 * every comparison against it behaves, and 0 * Inf in the blend weights is NaN.
 * Clamping here makes the chain structurally unable to propagate it, whatever
 * upstream bug produces the next one. The ceiling is far above any legitimate
 * radiance, so bloom's look is untouched. */
{
  const hp = bloom.materialHighPassFilter;
  hp.fragmentShader = hp.fragmentShader.replace(
    'vec4 texel = texture2D( tDiffuse, vUv );',
    'vec4 texel = texture2D( tDiffuse, vUv );\n' +
    '\t\t\ttexel.rgb = clamp( texel.rgb, vec3( 0.0 ), vec3( 6.0e4 ) );\n' +
    '\t\t\ttexel.rgb = mix( vec3( 0.0 ), texel.rgb, vec3( equal( texel.rgb, texel.rgb ) ) );');
  hp.needsUpdate = true;
}
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
    /* HomeComposite.fs, its whole contribution:
     *   color += texture2D(tVolumetricBlur, vUv).rgb * uVolumetricStrength; */
    tVolumetricBlur: { value: null },
    uVolumetricStrength: { value: 0 },
    uVolumetricTint: { value: new THREE.Color('#cdf59a') },
    /* Whole-frame saturation, in the same slot their HomeComposite.fs puts
     * adjustContrast. Sections 1 and 2 stack a lot of additive green -- cloud,
     * plume, god rays, corner glow, and bloom over all of it -- and no single one of
     * them is "the" cause of the frame reading as solid green; they compound. Tuning
     * them one at a time chases the symptom around. One frame-level control is
     * predictable, and it is the only place the compounded result exists.
     *
     * Held at exactly 1.0 in Work so section 3 is provably untouched. */
    uSaturation: { value: 1 },
    /* The deep grade: split-tone + top-end desaturation, ramped by deepF so it
     * exists only in the descent. Replaces the old flat 0.75 saturation pull
     * in burst — global desaturation was why the deep frame read monotone. */
    uGrade: { value: 0 },
    /* Shadow floor lift, driven alongside uGrade from the same scroll scalar. */
    uFloorLift: { value: 0.55 },
    /* Eased cursor, uv. Lagged in the frame loop so the disturbed pocket
     * trails the pointer slightly -- water has inertia. */
    uCursor: { value: new THREE.Vector2(0.5, 0.5) },
    /* shared by reference with the transition pass — one texture, one upload */
    tNormal: { value: null },
    /* Phase 4's core flash: strength, and where on screen the mark is. */
    uFlash: { value: 0 },
    uFlashPos: { value: new THREE.Vector2(0.5, 0.5) },
    /* The inclined horizon in reference image 1. .x is how present it is (0 = off),
     * .y where it crosses the left edge as a fraction of frame height. */
    uHorizon: { value: new THREE.Vector2(0, 0.52) },
    /* Liquid refraction strength, in UV units. Driven per frame from cursor
     * speed -- see the LIQUID block in the frame loop. */
    uLiquid: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uScroll, uScrollDelta, uUIBlend;
    uniform vec2 uGradient, uResolution;
    uniform vec3 uUIColor;
    uniform sampler2D tVolumetricBlur;
    uniform float uVolumetricStrength;
    uniform vec3 uVolumetricTint;
    uniform float uSaturation;
    uniform float uGrade;
    uniform float uFloorLift;   // shadow floor toward the fog hue — see the lift block
    /* eased cursor position in uv — the centre of the refraction pocket */
    uniform vec2 uCursor;
    /* the same normal map FXScrollTransition refracts through */
    uniform sampler2D tNormal;
    uniform float uFlash;
    uniform vec2 uFlashPos;
    uniform vec2 uHorizon;
    uniform float uLiquid;      // screen-space refraction, in uv units
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
      /* ---- LIQUID REFRACTION.
       *
       * The reference implementation stacks a second WebGL canvas with its own
       * renderer and a displacement-mapped plane. That cannot be layered onto
       * this site -- one renderer, one composer, and a DOM UI that must stay
       * sharp -- so this is the same optical language done in screen space, in
       * the pass that already exists. Nothing is added to the frame cost but a
       * handful of noise reads.
       *
       * It is a REFRACTION, not a physics field: the scene texture is sampled
       * through an offset UV. Nothing moves, nothing is attracted anywhere, and
       * there is no centre for a whirlpool to form around.
       *
       * The flow is two low-frequency noise reads at slightly different scales,
       * drifting in opposite directions at ~0.01-0.02 uv/s. Beating against each
       * other, they never repeat and never resolve into a recognisable texture,
       * which is the "do not let the viewer see the liquid image" requirement.
       *
       * PROTECTED CENTRE: strength scales with distance from frame centre, so
       * the compass and the copy sit in the calm and the periphery carries the
       * optics -- the cinematic lens shape, without a visible border because the
       * ramp is a smoothstep across half the frame. The DOM UI is untouched by
       * construction; it is not in this texture at all. */
      vec2 luv = vUv;
      if (uLiquid > 0.0001) {
        float lt = uTime * 0.35;
        vec2 f1 = vec2(
          vnoise(vUv * 3.1 + vec2(lt * 0.05, lt * 0.037)),
          vnoise(vUv * 3.1 + vec2(11.3 - lt * 0.041, 7.7 + lt * 0.058)));
        vec2 f2 = vec2(
          vnoise(vUv * 6.7 - vec2(lt * 0.033, lt * 0.045) + 3.3),
          vnoise(vUv * 6.7 + vec2(5.1 + lt * 0.052, 2.4 - lt * 0.036)));
        vec2 flow = f1 * 0.75 + f2 * 0.25;
        /* aspect-correct so the warp is isotropic on a wide frame */
        flow.x *= uResolution.y / uResolution.x;
        float edge = smoothstep(0.12, 0.62, length(vUv - vec2(0.5)));
        /* THE MARK'S CALM. The frame-centre ramp alone still left ~28% strength
         * on the artifact, and on its thin glass lines even a few pixels of
         * coherent warp reads as the ring MELTING -- which a screenshot showed.
         * uFlashPos is the mark's projected position, already tracked for the
         * flash, so the calm zone rides the artifact through every section:
         * zero warp on the glass, full underwater optics in the vegetation. */
        vec2 toMark = (vUv - uFlashPos) * vec2(uResolution.x / uResolution.y, 1.0);
        /* 0.16..0.46, widened. The mark's outer ring reaches ~0.2 in
         * aspect-corrected uv, so the old 0.07..0.30 guard was already fully
         * open across the ring itself and the glass took the full
         * displacement -- which is what tore it. The guard has to clear the
         * ARTIFACT, not just its centre. */
        float markGuard = smoothstep(0.16, 0.46, length(toMark));
        vec2 disp = flow * uLiquid * mix(0.28, 1.0, edge);

        /* ---- NORMAL-MAP REFRACTION — Active Theory's own technique.
         *
         * Straight from FXScrollTransition.glsl, which refracts by sampling a
         * NORMAL MAP, remapping it to [-1,1] and offsetting the sample UV by
         * its xy:
         *
         *   vec3 normal = crange(texture2D(tNormal, normalUV).rgb, 0, 1, -1, 1);
         *   uv += normal.xy * 0.025 * <masks>;
         *
         * with the sampling UV square-corrected, scaled down, and scrolled so
         * the surface moves. Same texture, same remap, same 0.025 ceiling --
         * only the mask differs, because theirs is driven by the wipe and this
         * one by the cursor.
         *
         * My hand-rolled banded shear is gone. It tore the artifact into
         * horizontal steps, and the reason is worth keeping: quantised rows
         * displace by design, so ANY amplitude big enough to notice also
         * shreds hard edges. A normal map displaces CONTINUOUSLY -- adjacent
         * pixels move together -- which is why theirs bends the image instead
         * of slicing it. */
        vec2 nUV = scaleUV(vUv, vec2(1.0, uResolution.x / uResolution.y));
        nUV = scaleUV(nUV, vec2(0.3));
        nUV.y -= uTime * 0.012;                    // the surface drifts, slowly
        nUV.x += uTime * 0.005;
        vec3 wn = texture2D(tNormal, nUV).rgb * 2.0 - 1.0;

        /* Concentrated on the cursor so it stays a hover, not a full-frame
         * filter, with a resting floor that keeps the medium alive when the
         * pointer is still. */
        vec2 toCur = (vUv - uCursor) * vec2(uResolution.x / uResolution.y, 1.0);
        float near = 1.0 - smoothstep(0.0, 0.40, length(toCur));
        float amt = (0.22 + near * near * 1.0) * uLiquid;

        disp += wn.xy * amt * 1.15;

        luv = vUv + disp * markGuard;
      }
      vec3 color = texture2D(tDiffuse, luv).rgb;
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
      /* God rays, added before the corner glow and the grain so both act on the
       * combined image. HomeComposite.fs adds the term raw; the tint is ours, and
       * it is the reason it is here at all -- their rays inherit the warm white of
       * their light source, and against a green scheme an untinted add just
       * brightens toward white and flattens the frame. */
      color += texture2D(tVolumetricBlur, vUv).rgb * uVolumetricTint * uVolumetricStrength;

      /* The inclined horizon from reference image 1.
       *
       * It runs from 48% of frame height at the left edge to 22% at the right -- a
       * rise of 0.26 in UV -- with a lighter, textured region above it and a much
       * darker one below. Structurally it is the same inclined division as their
       * FXScrollTransition seam, but here it is permanent: the hero is composed
       * around it, with the nebula above and the type below.
       *
       * Darkening below rather than brightening above, because the darker half is
       * what the type sits on and the reference's contrast there is what makes
       * CYPHERNAUT legible over a busy field. The edge itself gets the faintest lift,
       * which is what reads as a lit horizon rather than a mask boundary. */
      if (uHorizon.x > 0.001) {
        float line = uHorizon.y - vUv.x * 0.26;
        float below = smoothstep(line + 0.012, line - 0.012, vUv.y);
        color *= mix(1.0, mix(1.0, 0.42, below), uHorizon.x);
        // thin bright rim on the division
        float rim = smoothstep(0.016, 0.0, abs(vUv.y - line));
        color += vec3(0.62, 0.86, 0.70) * pow(rim, 2.0) * 0.10 * uHorizon.x;
      }

      vec3 gradient = rgb2hsv(vec3(0.40, 0.78, 0.37));
      gradient.x += vnoise(squareUV * 0.65 - uTime * 0.04) * 0.10;
      gradient = hsv2rgb(gradient);

      vec2 noiseUV = rotateUV(squareUV, radians(15.0));
      float gNoise = 0.5 + vnoise(noiseUV * 1.1 + uTime * 0.03 + uScroll * 0.08) * 0.5;
      float cornerNoise = 0.7 * 1.6 * smoothstep(uGradient.x, uGradient.y * 0.9, length(squareUV - 0.5));
      color = blendAdd(color, gradient, 0.022 + pow(cornerNoise * gNoise, 2.0));

      /* Saturation, after everything additive and before the grain.
       *
       * A luminance mix, NOT a round trip through HSV. The HSV version rendered the
       * whole frame black -- confirmed by overriding uSaturation to 1.0 at runtime,
       * which brought it straight back. This scene is mostly near-zero pixels, and
       * the compact rgb2hsv here divides by 6.0*d + 1e-10 for hue and by
       * q.x + 1e-10 for saturation; both denominators collapse on black, so the
       * round trip is unstable exactly where most of this frame lives. Mixing toward
       * luminance has no division and no branch, and it desaturates without moving
       * the hue -- so the scheme stays green, it just stops being only green. */
      float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(lum), color, uSaturation);

      /* Phase 4's core flash, added AFTER the saturation pull so it stays white-blue
       * instead of being desaturated into the green frame with everything else. That
       * ordering is the whole point of it: the burst is the one moment the scheme
       * breaks, which is what makes it read as an event.
       *
       * Aspect-corrected around the mark's screen position, with a hot core and a
       * much wider soft falloff -- the pair is what gives it a blown centre and a
       * glow reaching into the corners rather than a flat disc. */
      if (uFlash > 0.001) {
        vec2 fd = (vUv - uFlashPos) * vec2(uResolution.x / uResolution.y, 1.0);
        float r = length(fd);
        float core = pow(smoothstep(0.30, 0.0, r), 2.0);
        float wide = pow(smoothstep(1.10, 0.0, r), 3.0);
        color += (vec3(0.72, 0.92, 1.0) * core * 1.9 + vec3(0.45, 0.80, 0.95) * wide * 0.8)
                 * uFlash;
      }

      /* ---- THE DEEP GRADE, ramped by the descent (uGrade = deepF, exactly 0
       * everywhere above). Split-tone by luminance instead of the old flat
       * saturation pull: the deep frame was green at EVERY value, so it had a
       * hue but no tonal range, and flattening saturation globally only made
       * that worse. Shadows cool toward blue-black, mids stay forest, and the
       * top 15%% of luminance desaturates hard so the mark reads WHITE-HOT
       * rather than as the brightest green thing in a green frame. */
      /* ---- THE FLOOR LIFT. Runs BEFORE the grade, and unconditionally.
       *
       * The void is a medium, not an absence. Lifting the black point toward
       * the fog hue makes the shadows carry the same teal the deep fog does --
       * without it the upper sections are warm highlights against NEUTRAL
       * black, which is a single tone, while burst is genuinely split. That
       * difference is most of why the sections above the descent read as
       * objects floating in nothing rather than as the same place seen higher
       * up.
       *
       * max(), not addition: it raises the floor without touching anything
       * already above it, so highlights and the mark are untouched by
       * construction. The lift is a HUE cue, not a brightness change -- the
       * luminance it adds is a couple of percent. */
      {
        vec3 floorTint = vec3(0.016, 0.043, 0.031);   // #04100a, matches the flora fog
        float fl = dot(color, vec3(0.2126, 0.7152, 0.0722));
        float lift = (1.0 - smoothstep(0.0, 0.14, fl)) * uFloorLift;
        color = mix(color, max(color, floorTint), lift);
      }

      if (uGrade > 0.001) {
        float gLum = dot(color, vec3(0.2126, 0.7152, 0.0722));
        vec3 toned = color;
        toned = mix(toned, toned * vec3(0.32, 0.52, 0.80) * 1.55, smoothstep(0.20, 0.0, gLum) * 0.7);
        toned = mix(toned, toned * vec3(0.42, 0.63, 0.45) * 1.45,
                    smoothstep(0.0, 0.32, gLum) * smoothstep(0.60, 0.26, gLum) * 0.55);
        toned = mix(toned, mix(toned, vec3(0.81, 0.91, 0.87) * gLum * 1.2, 0.5), smoothstep(0.52, 0.9, gLum));
        /* mild overall saturation lift, then kill it in the highlights */
        float tl = dot(toned, vec3(0.2126, 0.7152, 0.0722));
        toned = mix(vec3(tl), toned, 1.1);
        toned = mix(toned, vec3(tl), smoothstep(0.58, 0.92, tl) * 0.4);
        color = mix(color, toned, uGrade);
        /* +18% exposure, deep section only. Applied here rather than by raising
         * any individual layer's brightness so the whole frame lifts together
         * and the value RELATIONSHIPS -- the mark hottest, foliage silhouette,
         * planets between -- are preserved exactly. Ramped by uGrade, so the
         * sections above the descent are untouched. */
        color *= mix(1.0, 1.18, uGrade);

        /* ---- SHAFTS FROM THE SURFACE.
         *
         * Caustics on the foliage say there is a surface overhead; these say
         * how far below it we are. Broad, near-vertical columns of slightly
         * brighter water, leaning a few degrees off true vertical and drifting
         * very slowly -- three octaves at different rates so they never line up
         * into a repeating comb. Strongest at the top of the frame and gone by
         * the bottom, which is the direction the light is coming from.
         *
         * ADDITIVE and tinted cyan-green: a shaft is light IN the medium, not
         * a lightening of the objects, so it must not multiply the scene or the
         * silhouettes go milky and the value contract breaks. */
        float sx = vUv.x * 3.1 + vUv.y * 0.42;
        float sh = sin(sx * 2.7 + uTime * 0.05) * 0.5 + 0.5;
        sh *= sin(sx * 5.3 - uTime * 0.037 + 1.7) * 0.5 + 0.5;
        sh *= sin(sx * 1.3 + uTime * 0.028 + 4.1) * 0.5 + 0.5;
        /* fall off toward the floor, and fade at the very top edge so the
         * shafts emerge from the darkness rather than starting at a hard line */
        sh *= smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.05, 0.55, vUv.y);
        color += vec3(0.30, 0.62, 0.52) * sh * 0.075 * uGrade;

        /* Depth-graded blue shift: the deeper part of the frame loses red
         * first, which is what water actually does to a spectrum and what
         * makes the bottom of the shot feel further down rather than just
         * darker. Tiny -- it works on the eye without reading as a colour
         * cast. */
        float depthMix = smoothstep(0.62, 0.0, vUv.y) * uGrade;
        color.r *= 1.0 - depthMix * 0.16;
        color.b *= 1.0 + depthMix * 0.10;
      }

      /* Film grain — the original overlays at 0.15. Kept, and kept animated:
       * static grain reads as dirt on the lens rather than as film. But the
       * refresh is QUANTISED to ~12Hz instead of running at frame rate. Grain
       * that re-rolls every frame at 60fps is both above the flicker-fusion
       * threshold (so it reads as static hiss rather than grain) and murder on
       * a video encoder. Stepping it holds each pattern for ~5 frames, which
       * looks the same to the eye, encodes cleanly, and stops screen shares
       * from shimmering. */
      float grainT = floor(uTime * 12.0) * 0.0833;
      color = blendOverlay(color, vec3(getNoise(vUv, fract(grainT) + 0.5)), 0.15);

      /* Sub-LSB dither before quantisation. A frame living almost entirely
       * under 0.2 bands visibly in 8-bit across the fog and nebula gradients;
       * a ±half-LSB offset is invisible and dissolves the contours.
       *
       * STATIC, not animated. It was time-varying, which stacked a second
       * full-frame noise layer on top of the film grain -- and per-pixel noise
       * that changes every frame is the single worst input a video encoder can
       * get: it defeats temporal prediction, so every frame becomes a keyframe
       * and screen shares/recordings shimmer heavily even though the live page
       * looks fine. A fixed pattern breaks banding just as well, because
       * banding is spatial. */
      color += vec3(getNoise(vUv * 3.7, 0.11)) / 255.0;

      /* Floor only -- no ceiling. OutputPass runs ACES after this pass, and
       * ACES exists to shoulder over-range values smoothly; a clamp here
       * flattened everything past 1.0 onto a single plateau first (which
       * ACES then mapped to one flat pale value with a hard boundary at the
       * 1.0 contour -- the exact hard-edged white-patch signature, the same
       * plateau failure the water mirror's gain fix diagnosed). Pixels at or
       * under 1.0 are untouched either way; negatives from the overlay/grain
       * math still need the floor. */
      gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
    }
  `,
};
const compositePass = new ShaderPass(CompositeShader);
/* the refraction normal map, the same one the wipe uses */
compositePass.uniforms.tNormal.value = normalTex;
composer.addPass(compositePass);
composer.addPass(new OutputPass());

/* Every fullscreen pass must IGNORE the depth buffer. Before the DOF change
 * this was moot -- no composer target carried depth, so depthTest-true quads
 * tested against an empty buffer and always passed. Now renderTarget2 holds
 * the scene's real depth for the DOF to read, and any pass that writes into
 * that target with depth testing on gets CLIPPED by the leftover scene depth:
 * near-foliage texels reject the quad's fragments, keep stale content, and
 * the frame comes out as layered garbage. One loop, belt and braces. */
for (const p of composer.passes) {
  if (p.material) { p.material.depthTest = false; p.material.depthWrite = false; }
}

/* The post chain, exposed for bisection.
 *
 * A black frame in this project has had at least three different causes -- a shader
 * that failed on near-zero pixels, a render-target feedback loop, and geometry outside
 * the frustum -- and they are indistinguishable from the outside. Being able to switch
 * one pass off at runtime turns "which of five things is it" into three tool calls
 * instead of three reloads each.
 *
 *   __passes.bloom.enabled = false
 *   __passes.composite.enabled = false
 */
window.__passes = { transition: transitionPass, bloom, composite: compositePass, dof: dofPass };
/* Scene handles, same purpose: hide one object at a time to find which one a pass is
 * choking on. `__scene.emblem.visible = false` etc. */
/* Pixel oracle. Renders the scene into a small target and reads it back, so "is the
 * frame black" stops being a judgement call about a screenshot.
 *
 * Worth the code: this project has confused a black canvas caused by a shader NaN, one
 * caused by a paused render loop, and one caused by a pass being dropped -- and a
 * screenshot looks identical in all three. `max` distinguishes them immediately: a
 * NaN-poisoned scene reads 0, a merely dark one reads low but non-zero.
 *
 *   __grab()          the scene as the current camera sees it, before post
 *   __grab(true)      the same, and also report the composed frame
 */
/* __silhouette(target, cols, rows) — the SHAPE of one object, as text.
 *
 * Exists because of a specific, repeated failure in this environment: the Claude Browser
 * pane frequently stops compositing, and when it does, screenshots time out while the
 * WebGL context keeps working perfectly. __grab already exploits that (it renders to an
 * offscreen target, so it is unaffected), but it only returns aggregates -- max, mean,
 * litPct -- which answer "is anything there" and not "what shape is it".
 *
 * Three separate rounds of jellyfish work were reviewed on the strength of a single
 * still frame or, worse, shipped with no visual check at all, because of exactly this.
 * A coarse luminance grid is not pretty, but it is enough to tell a dome from a cone
 * from a flat plate, it costs nothing, and it works when nothing else does.
 *
 *   __silhouette()                       everything the camera sees
 *   __silhouette(scene.getObjectByName)  one subtree, everything else hidden
 *
 * Isolating a subtree matters for more than tidiness: the scene is mostly additive point
 * clouds, and their glow washes over any object being measured.
 */
window.__silhouette = (target = null, cols = 60, rows = 30) => {
  const w = Math.max(1, sizedW), h = Math.max(1, sizedH);
  const rt = new THREE.WebGLRenderTarget(w, h);
  const buf = new Uint8Array(w * h * 4);

  /* Hide everything outside the target subtree, remembering only what we changed so
   * the restore cannot desync from stageSection's own visibility bookkeeping. */
  const hidden = [];
  if (target) {
    const inTarget = new Set();
    target.traverse(o => inTarget.add(o));
    scene.traverse(o => {
      if (o === scene || inTarget.has(o) || !o.visible) return;
      if (o.children.some(c => inTarget.has(c)) || inTarget.has(o.parent)) return;
      let p = o.parent, ancestorOfTarget = false;
      while (p) { if (inTarget.has(p)) { ancestorOfTarget = true; break; } p = p.parent; }
      if (ancestorOfTarget) return;
      let q = target.parent, isAncestor = false;
      while (q) { if (q === o) { isAncestor = true; break; } q = q.parent; }
      if (isAncestor) return;
      o.visible = false; hidden.push(o);
    });
  }

  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  renderer.setRenderTarget(null);
  rt.dispose();
  for (const o of hidden) o.visible = true;

  /* Cell = MAX luminance, not mean: this is a silhouette, and a thin bright tentacle
   * crossing one cell must survive rather than be averaged into the void around it. */
  const cell = new Float32Array(cols * rows);
  let peak = 0;
  for (let y = 0; y < h; y++) {
    // readRenderTargetPixels is bottom-up; flip so row 0 prints as the top of frame
    const ry = rows - 1 - Math.min(rows - 1, Math.floor(y / h * rows));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = Math.max(buf[i], buf[i + 1], buf[i + 2]);
      const c = ry * cols + Math.min(cols - 1, Math.floor(x / w * cols));
      if (l > cell[c]) cell[c] = l;
      if (l > peak) peak = l;
    }
  }

  /* TONAL HISTOGRAM over lit pixels, ten buckets of 0..255.
   *
   * The art grid answers "what shape is it" and is deliberately a MAX reduction so a
   * one-pixel-wide bright feature survives being binned. That makes it useless for
   * "is this blown out" -- every cell of a 2x-overlapped additive point cloud contains
   * some near-saturated pixel, so every cell prints as '@' whatever the exposure is.
   * Caught exactly that way while tuning the Cyphernaut shell: an 8x brightness cut
   * moved the art not at all, while the figure really was clipping.
   *
   * So the histogram is measured per PIXEL and reported separately. `clipped` is the
   * number that matters: the fraction of lit pixels at 250+. */
  const hist = new Array(10).fill(0);
  let litPx = 0, clipped = 0, sum = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const l = Math.max(buf[i], buf[i + 1], buf[i + 2]);
    if (l <= 8) continue;
    litPx++; sum += l;
    hist[Math.min(9, Math.floor(l / 25.6))]++;
    if (l >= 250) clipped++;
  }

  const RAMP = ' .:-=+*#%@';
  const lines = [];
  let minX = cols, maxX = -1, minY = rows, maxY = -1;
  /* Normalise the ramp against 255, not against `peak`. Against peak, a nearly-black
   * frame (peak 1) maps every lit cell to '@' and reads as fully saturated -- which is
   * the opposite of the truth and did briefly send this tuning the wrong way. */
  const scale = Math.max(255, peak);
  for (let r = 0; r < rows; r++) {
    let s = '';
    for (let c = 0; c < cols; c++) {
      const v = cell[r * cols + c];
      const k = Math.min(RAMP.length - 1, Math.floor(v / scale * RAMP.length));
      s += RAMP[k];
      if (v > 8) {
        if (c < minX) minX = c; if (c > maxX) maxX = c;
        if (r < minY) minY = r; if (r > maxY) maxY = r;
      }
    }
    lines.push(s);
  }

  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  return {
    art: lines.join('\n'),
    peak,
    /* Bounding box in CELLS and, more usefully, its aspect -- which is the number that
     * settles "is the bell a dome or a plate" without anyone squinting at a JPEG. */
    bbox: maxX < 0 ? null : { cols: bw, rows: bh, aspect: +(bw / bh).toFixed(2) },
    /* Fraction of frame HEIGHT the object spans; the reference framing target. */
    pctOfFrameHeight: maxX < 0 ? 0 : +(100 * bh / rows).toFixed(1),
    hiddenForMeasurement: hidden.length,
    /* Exposure, per pixel. clippedPct over a few percent means highlights are being
     * destroyed and no amount of grading downstream recovers them. */
    litPx,
    meanLit: litPx ? +(sum / litPx).toFixed(1) : 0,
    clippedPct: litPx ? +(100 * clipped / litPx).toFixed(1) : 0,
    hist,
  };
};

window.__grab = () => {
  /* MUST render at the real viewport size.
   *
   * A first version used a 64x64 target and reported this scene as nearly saturated
   * (mean 134/255) while the canvas was visibly black -- a completely wrong reading
   * that sent the search into the post chain. gl_PointSize is in PIXELS, so on a 64px
   * target a 30px grain covers a quarter of the frame; tens of thousands of them
   * additively blended peg every channel. Any oracle for a point-cloud scene has to
   * match the viewport or it measures its own downscale. */
  const w = Math.max(1, sizedW), h = Math.max(1, sizedH);
  const rt = new THREE.WebGLRenderTarget(w, h);
  const buf = new Uint8Array(w * h * 4);
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  renderer.setRenderTarget(null);
  rt.dispose();

  let max = 0, sum = 0, lit = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const m = Math.max(buf[i], buf[i + 1], buf[i + 2]);
    if (m > 8) lit++;
    max = Math.max(max, m);
    sum += buf[i] + buf[i + 1] + buf[i + 2];
  }
  return { w, h, max, mean: +(sum / (w * h * 3)).toFixed(2),
           litPct: +(100 * lit / (w * h)).toFixed(2) };
};

window.__scene = { workRoot, homeRoot, aboutRoot, atmosRoot,
                   get emblem() { return emblem && emblem.group; },
                   get heroCloud() { return heroCloud && heroCloud.group; },
                   get plume() { return home.plume; } };

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
/* the shader clock: clamped-dt accumulation, immune to tab-switch jumps --
 * see the note at the top of frame() */
let animTime = 0;
const radians = d => d * Math.PI / 180;
const flashWorld = new THREE.Vector3();

/* Which section owned the camera last frame. A change means CUT, not glide: the
 * three rigs point at completely different content, so easing between them would
 * drag the previous section's framing across the new one. Their engine cuts too --
 * FXScrollTransition.glsl wipes between two separately rendered scene textures.
 * Ours cuts and hides the cut with the composite dip below. */
let lastSection = null;

/* Home's `visibleV`.
 *
 * INTERPRETATION, and a different one from sections.js's scroll-derived `visible`.
 * For Home that scroll ramp is simply wrong: Home is on screen at scroll 0, so a
 * ramp starting at 0 would hold the entrance frozen for the first 100vh -- a
 * quarter of the section. Their visibleV for the landing route is driven by the
 * scene coming into existence, not by scrolling, which is why every term it feeds
 * is an entrance: the tails rise 20 units from below, the mark unwinds 210
 * degrees, the plume settles down by 10.
 *
 * So it runs on time from the moment the loader clears. 1.8s, eased.
 *
 * Driven off wall clock, not accumulated dt. The frame loop clamps dt to 0.05,
 * so on a slow first paint -- 10fps while the last programs link, which is exactly
 * when this runs -- accumulation advances at half real time or worse, and the
 * entrance crawls. performance.now() cannot be starved that way. */
let revealAt = 0;                   // 0 until the overlay clears
/* This frame's intro sample. Module-level because stageSection reads it too, and a
 * wipe calls that twice per frame -- sampling inside would give the two halves
 * different instants. */
/* This frame's hero-volume drives. Scroll-driven now: the four reference keyframes
 * are four scroll sections, so the story that used to play on a 5-second timer plays
 * on the scroll bar -- see heroDrives in src/intro.js. Module-level because
 * stageSection reads it too, and a wipe stages two sections in one frame. */
let HERO = heroDrives(0, 0, 0);

/* The Home camera's fixed pitch.
 *
 * UIL authors this rig as position [0,2,40] with lookAt [0,4.59,0] -- a one-time
 * setup, not a per-frame lookAt, and their render tick only ever overwrites
 * camera.position.y. So the orientation is a constant: atan(2.59 / 40) up.
 *
 * LOOKAT 3.75, NOT THEIR 4.59, AND THIS IS THE WATER'S FRAMING.
 *
 * The client kept asking for more water and four attempts at brightening it
 * failed, because brightness was never the constraint: what bounds the water
 * from ABOVE is the horizon, and the horizon sits at eye level. Their 4.59
 * pitches this rig 3.71 degrees UP, which at fov 30 parks the waterline about
 * three quarters of the way down the frame and caps the water at roughly a
 * quarter of it. No shading value can move that line.
 *
 * 3.75 pitches 2.51 degrees up instead -- a third of the way back toward
 * level -- which lifts the waterline to about two thirds down and gives the
 * water half again as much frame. Deliberately not level: the up-pitch is
 * what puts the canopy overhead and keeps the grove feeling tall, so this
 * takes part of it, not all.
 *
 * It reframes the WHOLE volume -- drift, gather and burst share this rig --
 * so the grove sits higher and there is less sky in every one of those
 * frames. That is the trade, and it is the reason it took a client
 * instruction rather than my own judgement. The film plane and the planet
 * pin both derive their placement from this same constant (see
 * deepBgHolder's staging), so they follow it rather than drifting against
 * it. */
const HOME_PITCH = Math.atan2(3.75 - 2, 40);

/* The one Home number that could not be carried over verbatim, and why.
 *
 * Their mark's base rotation is radians(270). Added to the 2 x scrollTarget term
 * that opens at radians(180), that puts the asset at 450 degrees -- 90 -- at the
 * top of the page. Their asset is a monogram suspended inside a torus, so it
 * reads at any angle and 90 degrees is a deliberate three-quarter view. Ours is
 * effectively a plate: 0.634 x 0.982 x 0.067, so at 90 degrees it is edge-on and
 * disappears to a vertical sliver.
 *
 * -90 lands it face-on at scroll 0 and leaves every other term untouched -- the
 * 380 degrees it sweeps across the section, the doubled drag, the 210-degree
 * entrance unwind. Their About offset of radians(60) is NOT corrected: it already
 * puts the mark within 20 degrees of face-on, so the same shift would break it.
 * The two rigs present their mark at different angles; only one of those angles
 * survives a flat asset.
 *
 * The correction applies to the MARK ALONE, even though their code drives the
 * tails from the same value (`column.rotation.y = logo.rotation.y`). The tails are
 * our own cylinders with no authored facing to correct, and the crossing only
 * reads as a teardrop from a particular angle -- rotating them with the mark
 * turned it into a narrow X. So the tails keep their 270 and the mark takes 180. */
const LOGO_BASE = radians(270);
const LOGO_ASSET_FIX = radians(-90);

/* How far the mark turns across the LANDING, driven by scroll.
 *
 * 75 degrees, up from 24. At 24 the turn was there in the numbers but invisible in
 * use -- across a 105vh section that is a fifth of a degree per vh, which reads as a
 * still image. 75 gives a clear, unhurried quarter-turn: enough that the bevels catch
 * the light differently as you scroll and the object reads as solid, and short of the
 * point where it becomes a spinning logo.
 *
 * It stays a SCROLL term rather than a time term on purpose. Their mark never
 * auto-rotates; every rotation on their site is driven by scroll or by drag, so the
 * object only moves when the visitor does. */
const LAND_LOGO_SPIN = 75;

/* Per-section scale for the mark, and why one scale cannot serve both.
 *
 * Their two rigs put the eye at wildly different distances from it -- Home 30 to
 * 45 units, About 6 -- yet the mark reads at a comparable fraction of frame height
 * in both. At fov 30 the frame is 16 units tall at Home's distance and 3.2 at
 * About's, a factor of 5. So their About mark is a separate object with its own
 * scale; there is no single world size that works in both rigs, and the first
 * pass at this (one instance, one scale) had it overflowing the About frame
 * entirely at 88% of frame height with the copy unreadable across it.
 *
 * Home is 1.0 -- the 5.0 targetHeight loadEmblem was given. About is 0.40, which
 * is 2.0 units against a 3.22-unit frame: a little under two thirds of frame
 * height. Still the "giant monogram" the section is built around, but the headline
 * crosses it rather than being swallowed by it.
 *
 * SUPERSEDED. Kept only as a record of a wrong turn: scaling the mark per section
 * was solving the framing problem by giving About its own world scale, and that is
 * what left the section empty of everything else. Pulling the camera back to
 * ABOUT_CAM_Z instead gets the identical framing with one shared scale, so the mark
 * is 1.0 in both sections and nothing else has to be duplicated. */
const ABOUT_CAM_Z = 15;
/* Their About mark travels y 6 -> -2 across a frame 3.22 units tall, which is 2.5
 * frame-heights of travel. ABOUT_CAM_Z makes the frame 8.05 units tall, so the same
 * relative travel is their range scaled by 8.05/3.22. Their motion, our units. */
const ABOUT_LOGO_SCALE = 8.05 / 3.22;

/* Where the shared atmosphere sits during About.
 *
 * At ABOUT_CAM_Z the eye is 15 units out and the volume reaches radius 12 about the
 * origin, so its near face is 3 units away -- the camera is effectively inside the
 * cloud. Their point-size expression is `1000.0 / dist`, so grains at 3 units come
 * out several times the size they are in Home and the section drowns in them.
 *
 * -17 slides the volume behind the mark without touching its scale: the eye is then
 * 20 to 44 units from it, which is the range Home views it at, so the grains are
 * the same size in both sections and the field reads as a backdrop the copy sits
 * on rather than a blizzard in front of it. The mark stays at z 0 and 62% of frame
 * height. Same volume, same scale, framed for the section. */
const ATMOS_ABOUT_Z = -17;

/* Mark placement for reference image 1, measured off it and converted.
 *
 * Its ring spans x 740-1150 of 1671 -- 24.5% of frame width, centred at 56.6% rather
 * than at 50%. At ABOUT_CAM_Z with fov 30 the frame is 14.87 units wide, so that ring
 * is 3.64 units across and its centre sits 0.98 units right of the axis.
 *
 * The model's ring is roughly 3.0 units across at scale 1 (it is 3.23 units wide
 * overall and the ring takes almost all of that), which puts the scale at 1.2. The
 * offset is what stops the mark sitting behind CYPHERNAUT: in the reference the
 * headline's tail runs UNDER the ring's left edge, and that only reads if the mark is
 * off-centre to the right. */
const ABOUT_LOGO_X = 0.98;
/* 1.05, down from 1.2 — the brief's "reduce its visual dominance 10-15%". The
 * artifact stays the anchor; what it gains is NEGATIVE SPACE around the outer
 * ring, which is what lets it read as an object suspended IN the environment
 * rather than a graphic laid over it. */
const ABOUT_LOGO_SCALE_XY = 1.05;
/* Pulled right back now that their scanned cloud carries the atmosphere.
 *
 * The plume was doing two jobs and only one of them was theirs. Its motion IS
 * theirs -- ParticleTestShader's funnel, loft and expanding burst ring -- but I had
 * it carrying the texture of the frame as well, and a field of green sparkles is not
 * what their hero looks like. Theirs is scanned foliage with sparks moving through
 * it. So the cloud is the substance and this is the sparks: low enough to read as
 * motion in the volume rather than as the volume itself. */
const PLUME_ALPHA_HOME = 0.22;
/* 0.26, up from 0.1 — image 1's grain clusters glow through the nebula, and at
 * 0.1 the land field read as dust rather than as the bright embedded speckle. */
const PLUME_ALPHA_ABOUT = 0.26;

function setFov(f) {
  if (camera.fov === f) return;
  camera.fov = f;
  camera.updateProjectionMatrix();
}

/* Where the Work rail's chase lives, outside the rig function.
 *
 * It has to be stepped exactly once per frame, and a wipe stages Work twice in one
 * frame -- so keeping the eased state here rather than writing camGroup directly
 * means the second staging cannot double-step it. It also removes the need to snap
 * on arrival: the chase runs during Home and About too, so by the time Work takes
 * the camera the group is already sitting on waypoint 0. */
const workCamPos = new THREE.Vector3();
const workCamQuat = new THREE.Quaternion();

/* Per-frame scalars the rigs read. Module-level rather than passed, because
 * stageSection is called with nothing but a section name and may be called twice. */
/* hpF: combined progress across the three hero-volume sections (drift+gather+burst),
 * which share ONE camera move -- Active Theory's Home rig, y 40 to -7. landPF: the
 * land section's local progress. homeVisibleF: the load entrance ramp. */
let hpF = 0, landPF = 0, homeVisibleF = 0, burstP = 0, burstVh = 0;
/* THE ARRIVAL, and the reason it cannot be S.work.progress.
 *
 * Work's rail parks on waypoint 0 for its first 6% (scrollValue's dead zone),
 * and its section progress is CLAMPED AT ZERO before the boundary. So through
 * the whole first half of the wipe the incoming camera sat perfectly still
 * while the outgoing half kept descending: half the frame moving and half
 * frozen, which is what reads as the motion stalling and then lurching.
 *
 * This is measured from GLOBAL scroll instead, over a window that opens
 * before the boundary and closes after it, so it is continuous by
 * construction -- it cannot be flattened by a section clamp, and it is the
 * same value on both of a wipe frame's two stagings. Module level for exactly
 * the reason burstVh is. */
let workDive = 1;
/* The volume's ORIGINAL scroll length, and the denominator hpF is pinned to --
 * see THE DESCENT in the frame loop. Deliberately a constant rather than
 * derived from SECTION_VH: burst's length is now the coin beat's runway and is
 * expected to change, and the descent's pacing must NOT follow it. */
const HERO_VOLUME_VH = 420;
const VOLUME = ['drift', 'gather', 'burst'];
/* the deep section's nebula grading target — see the burst staging */
const BURST_NEBULA_TINT = new THREE.Color('#2fae62');

/* ---- THE MARK'S EXIT, at the floor of the descent.
 *
 * The mark rides camGroup.y for the whole volume, so it is pinned to the same
 * spot in frame from the first pixel of drift to the last of burst -- and the
 * deep's tail is the one stretch where that is wrong. The blast is over, the
 * forest has grown in, the frame has become a PLACE rather than a composition
 * around an object, and the mark is still hanging in the middle of it. So it
 * leaves: it rises out of the top of frame and the last beat before the wipe is
 * the deep on its own.
 *
 * Vertical, and no fade. A fade would say the mark stopped existing; a physical
 * exit says it went somewhere, which is the same reading as the water carrying
 * it up.
 *
 * LINEAR IN hpF, NOT SMOOTHSTEPPED. Everything else in this volume is affine in
 * hpF -- camGroup.y is lerp(40, -7, hpF), full stop -- so the mark has to be
 * too, or it is not on the same clock as the frame it is leaving. Both the lift
 * and the spin below are linear for that reason: constant rate, strictly
 * proportional to the wheel.
 *
 * What smoothstep actually produced, read off a screen recording frame by frame:
 * the mark sat perfectly still for the first fifth of the window while the user
 * was scrolling (the curve's flat start), then covered the rest of the frame in
 * a third of a second (its 1.5x mid-curve peak). Still, then gone. A curve whose
 * whole point is to soften a move made this one read as two discontinuities.
 *
 * The volume's two established rates, both already in this file:
 *
 *   VERTICAL  camGroup.y runs 40 -> -7 across the volume, so the world moves
 *             past the mark at 47 units per unit of hpF. The frame is ~23 units
 *             tall at the mark's depth, so anything static crosses the whole
 *             frame in 0.49 hpF. That is what the planets and the foliage do,
 *             and it is what the eye has been calibrated on for three sections.
 *   ROTATION  logoRotY turns -380 degrees per unit of hpF (2 x their 190), which
 *             across this window is 63 degrees. On its own that is not a turn,
 *             it is a drift, and against a translation covering the whole frame
 *             it disappears entirely -- an object being yanked, with nothing for
 *             the eye to track.
 *
 * SPIN: TWO FULL TURNS on the mark's own axis across the lift, at the user's
 * explicit call, on top of the volume's own rotation. Not decoration -- it is
 * what gives the travel something to be read against, which is most of why the
 * same translation reads as controlled rather than as a yank.
 *
 * ONE CONSEQUENCE, worth knowing before changing the number: the asset is
 * effectively a plate (0.634 x 0.982 x 0.067, see LOGO_ASSET_FIX), so every half
 * turn takes it edge-on and it thins to a sliver. Two turns means that happens
 * four times. 4*PI lands it face-on again at the end rather than on its back.
 *
 * Added to the MARK ALONE, the way LOGO_ASSET_FIX is: logoRotY is Active
 * Theory's number and their columns copy it verbatim (see LOGO_BASE).
 *
 * The window is bounded on both sides and the runway between them is the whole
 * of the tuning: it cannot open while the blast is still bright, and it has to
 * be over before the wipe.
 *
 * THE HOLD, per the user's circled frames: the mark rides its camera-locked
 * seat through the blast, comes square to the camera inside the whiteout (see
 * SQUARE TO CAMERA in the mark block -- the flash masks the correction), and
 * the flash clears at ~0.775 on a mark already seated centre frame, face-on,
 * in the finished deep. It then HOLDS that exact pose -- exitF exactly 0, not
 * slow-moving, and the rotation pinned face-on rather than still turning.
 *
 * A and B are in VH FROM BURST'S START (burstVh), not hpF and no longer raw
 * burstP: hpF is pinned to the original 420vh descent (see THE DESCENT in the
 * frame loop) and cannot clock a beat that runs past it, and burstP rescales
 * whenever burst's length changes -- which it now does whenever the filmed
 * epilogue's scrub runway is retuned. In vh the beat is invariant: burst grew
 * 240 -> 380 for the film and not one of these numbers moved.
 *
 *   A 110    the lift begins, at scroll 495vh. The blast clears at burstVh
 *            ~63 (scroll 448vh) on a mark already seated, square and centred,
 *            so the hold is ~47vh -- the five scrolls asked for.
 *   B 240    the same scroll position B has always been (former burst end).
 *   RISE 22  sized to put the mark ENTIRELY out of frame, tails included.
 *            Its drawn extent spans ~+-0.26 NDC about its origin (measured),
 *            so the last of it -- the crossing tails below the ring, which is
 *            what the user photographed still hanging at the top edge --
 *            passes the top after ~15.25 units. 22 clears that at burstVh
 *            ~206 (scroll 591vh) and keeps travelling to 22 so nothing can
 *            drift back into frame.
 *
 * 0.170 units per vh across the rise: the same rate the exit ran at before any
 * of this, and the one that drew no speed complaint. The longer hold costs it
 * nothing, which is the whole reason burst grew -- inside 140vh hold and rise
 * were zero-sum. See SECTION_VH in sections.js for why that is safe.
 *
 * RUNWAY IS THE ONLY LEVER. Three others were built and measured first, and all
 * three are recorded here so they are not retried:
 *
 *   DRAW IT TOWARD THE CAMERA as it rises. Clearing distance scales with camera
 *     distance, so closing from 43 units to 34 cuts the travel needed from 15.25
 *     to ~13 -- 15% less over the same runway. Implemented, measured, reverted:
 *     NDC travel went 0.463 then 0.584 per 25vh, i.e. it ACCELERATES into the
 *     exit, because the closer it gets the more each world unit projects to.
 *     A lower average bought by an accelerating finish is the exact whip this
 *     whole exit was fighting.
 *   MORE vh ON BURST. sections.js's arithmetic survives it -- 80vh added leaves
 *     Work's span at exactly 950vh, only shifting its origin, which is the
 *     property that file proves. But hpF is normalised over the volume, so
 *     camGroup.y's 47-unit descent stretches by the same factor the exit window
 *     does. The RATIO is invariant; all it buys is slowing the whole volume,
 *     including the drift and gather motion that is already right.
 *   A LATER B. Ending at the wipe band instead of at burst's end costs 0.045
 *     hpF, which is 20% of the runway, to buy an empty frame the wipe was about
 *     to destroy anyway.
 *
 * Pure in hpF, like deepF, so staging the same section twice in a wipe frame
 * yields the same lift both times -- and pure scroll means the beat scrubs
 * cleanly in both directions with no state to strand. */
const MARK_EXIT_A_VH = 110, MARK_EXIT_B_VH = 240, MARK_EXIT_RISE = 22;
/* The filmed epilogue, SCROLL-SCRUBBED at the user's call: the wheel is the
 * film's transport, currentTime mapped over FILM_SPAN_VH of scroll -- park and
 * the frame parks, reverse and the ascent plays backward. 140vh for 13.1s is
 * ~10.7vh per second of footage, a natural scrub pace, and the asset is
 * encoded with a keyframe every 6 frames so every scrubbed seek decodes
 * instantly in either direction.
 *
 * FILM_START_VH 209 is just after the mark's drawn extent has fully cleared
 * (measured burstVh ~206, scroll 591vh). The film opens on this scene's own
 * settled composition, so the fade lands frame-on-frame: coin leaves, the
 * scene "comes alive", the astronaut rises where the coin went -- now at
 * whatever pace the user turns the wheel. */
/* SPAN 280, up from 140, and this is the fix for the client's "the scene
 * scrolls but the webp is stuck".
 *
 * Measured off their screen recording: from 2.6s to 3.9s the film's own
 * content barely changes (frame-to-frame delta in the film's region falls
 * to 0.4-1.0) while the live 3D at the frame edges moves three times as
 * hard (2.9-3.1). That window is the film PARKED -- its 140vh scrub ended
 * at burstVh 349 while burst runs to 520, leaving ~170vh in which the
 * wheel drove the camera and the water but not the footage. The parallax
 * drift added last commit made that worse, not better: it set the
 * foreground visibly sliding against a frozen background.
 *
 * 280 carries the last frame to burstVh 489, one vh before the plunge, so
 * the footage advances through the ENTIRE descent -- the astronaut's exit
 * now completes exactly as the camera commits to the water. Nothing else
 * moves: START, FADE, the beat windows and the water numbers are all
 * expressed in vh-from-burst-start and none of them reference the span.
 *
 * It is also cheaper. 315 frames over 280vh is 0.89vh per frame instead of
 * 0.44, so a given wheel gesture crosses HALF as many frames -- half the
 * decodes, half the texture uploads, and a proportionally larger effective
 * lookahead from the same cache. */
/* SPAN 150, cut from 280 at the client's explicit direction: shorten the
 * film's runway so the water can begin sooner, without letting the water
 * into the film's frame. 209 + 150 puts the last frame at burstVh 359, and
 * the water's rise now opens at 360 -- the two never share a frame.
 *
 * The film's COMPOSITION is untouched: same 315 frames, same plane, same
 * cover fit, same fade. Only the scroll it is spread over is shorter, so it
 * scrubs faster -- 0.48vh per frame against 0.89. That is more decodes per
 * gesture than the 280 span, though still gentler than the 0.44 the 140
 * span forced back when frames were 1920 wide and every swap reallocated
 * the texture. At 960 wide, blitted through copyTextureToTexture into a
 * fixed allocation, with the skeleton now permanently resident, the decode
 * path is a different animal from the one that number was a problem for. */
/* 190, from 150: the 150 cut left the film PARKED on its last frame from
 * burstVh 359 to the skim at 400 -- ~40vh of frozen footage against moving
 * 3D, which is the client's "background stuck while the scene moves", the
 * same parked-film failure the 280 span originally fixed. 190 lands the
 * last frame at 399, one vh before the dive begins: the footage plays for
 * the entire stretch it is on screen and hands off to the water the moment
 * it arrives. */
/* SPAN 311, from 190, so the scrub reaches the boundary and the film NEVER
 * parks.
 *
 * 190 put the last frame at burstVh 399 and left the plane holding that one
 * image for the remaining 121vh to the crossing. The plane is EYE-LOCKED --
 * its staging recomputes position and cover-fit from the live eye every frame
 * precisely so the footage does not drift -- so a parked film contributes
 * exactly ZERO screen motion. The camera is still descending through that
 * stretch (2.96 units), but the largest thing in frame is nailed in place,
 * and the eye reads the frozen majority rather than the moving remainder.
 * That is the client's "when the astronaut gets off the page the middle is
 * static", and it is why raising the camera drift alone did not cure it: the
 * lock was never in the camera.
 *
 * 209 + 311 = 520 lands the last frame exactly on the section boundary, so
 * the footage advances continuously right up to the crossing and hands over
 * to it with no held plate in between.
 *
 * It is also CHEAPER, which is worth stating because the instinct is the
 * opposite: stretching the same 315 frames over more scroll lowers the
 * density from 1.66 frames/vh to 1.01, so a given gesture crosses fewer
 * frames and triggers fewer decodes and uploads than the 190 span did. */
const FILM_START_VH = 209, FILM_SPAN_VH = 311, FILM_FADE_VH = 7;
/* Where the planets' pinning takes over from their authored placement (see
 * FILM_PLANETS). Declared here rather than beside FILM_PLANETS: these are
 * const bindings in module scope, so reading FILM_START_VH above its own
 * declaration is a TDZ throw -- which is precisely how this shipped broken
 * for one reload.
 *
 * 0..18, NOT the old 149..209 (FILM_START_VH-60 .. FILM_START_VH).
 *
 * That window existed to ease the bodies off their AUTHORED placement, which
 * was the starting pose for a drift/gather parallax phase -- back when the
 * planets were on screen through both sections. They are not any more: the
 * reveal now begins with the coin's blast, at roughly burstVh 25. With the
 * pin still opening at 149 the bodies were therefore drawn UNPINNED for
 * about 124vh -- large, close and flat, at coordinates never meant to be
 * looked at -- and then slid back to their filmed twins once the pin
 * engaged. That is the pair the client circled as a duplicate: not two sets
 * of planets, one set seen twice over, in the wrong pose first.
 *
 * Completing by 18 puts them on their filmed twins before the reveal makes
 * them visible at all, so the authored pose is never on screen. Nothing
 * about the pin's math changes -- it is derived from the live eye and the
 * film's live cover-fit every frame, so it is just as valid this early as it
 * was at 149. */
const PLANET_PIN_A_VH = 0, PLANET_PIN_B_VH = 18;
const MARK_EXIT_SPIN = Math.PI * 4;

/* Linear, but eased off rest over the first 30% of the window.
 *
 * Pure linear has a velocity STEP at A: the mark is stationary one frame and at
 * full rate the next, which is a visible flick into motion. smoothstep fixes
 * that and costs far too much -- its flat opening is the "static then bolt" this
 * whole exit has been fighting, because it spends the first fifth of the window
 * going nowhere while the user is actively scrolling.
 *
 * So: quadratic for the first k, exactly linear for the rest, C1 continuous at
 * the join, normalised to reach 1 at t=1. The mark leaves its held seat
 * imperceptibly and then rides ONE constant rate for the real travel.
 *
 * k 0.30, widened from 0.12 when the hold arrived: the ramp is the TRANSITION
 * out of a visible hold, not just a numeric derivative fix, so it has to be
 * long enough to read -- ~21vh of gathering speed before the constant rate.
 * Peak rate 1/(1 - (k+k2)/2) = 1.43x linear, still under smoothstep's 1.5x.
 *
 * ...and the same quadratic mirrored at the TOP (k2), because the original
 * ended linear-at-1 and the clamp cut it dead: a 22-unit lift and a 4pi spin
 * halting in a single frame at burstVh 240 -- the 'pop type uneven' snap.
 * The exit ease is the entry ease run backwards; the mark now settles into
 * its cleared position the same way it left its seat.
 *
 * Drives the spin as well as the lift, so the two stay locked to each other. */
const easeOffRest = (t, k = 0.30, k2 = 0.30) => {
  const m = 1 / (1 - k * 0.5 - k2 * 0.5);
  if (t <= k) return m * t * t / (2 * k);
  if (t < 1 - k2) return m * (t - k * 0.5);
  const u = 1 - t;
  return 1 - m * u * u / (2 * k2);
};

/* The god rays release across the MIDDLE of the lift -- not with it, and not
 * after it. Both wrong windows were shipped and diagnosed off recordings:
 *
 * TOO EARLY (the whole travel): the halo IS the mark in the deep -- fading
 * across the whole lift stripped it to a dark wireframe before it moved.
 *
 * TOO LATE (0.72..1, this base's original): the pass radial-blurs from the
 * mark's SCREEN position; near the top edge the halo becomes a full-height
 * light waterfall, and with the hold pushing the lift later the wipe band now
 * opens at exitF ~0.75 -- rays would still be at ~96% as the seam swept
 * through, smearing lit pixels over the incoming card.
 *
 * 0.35..0.68 of the lift: full strength through the whole hold and the first
 * third of the rise, then shedding as the mark climbs, and at zero by the time
 * it clears the top edge (exitF 0.693) -- so the shafts go out with the object
 * that casts them rather than outliving it, and the wipe band (exitF 0.86 by
 * then) never sweeps a lit beam. */
const MARK_RAY_FADE_FROM = 0.35, MARK_RAY_FADE_TO = 0.68;

/**
 * Put the scene into one section's state: what is visible, where the camera is,
 * and where the mark sits. Everything a render of that section needs.
 *
 * Idempotent and side-effect-free apart from those, which is the point -- during a
 * wipe it is called for the outgoing section, the scene rendered to a target, then
 * called again for the incoming one before the real render.
 */
function stageSection(name) {
  if (ONLY === 'emblem') return;

  const inVolume = VOLUME.includes(name);
  /* ---- THE DESCENT, as one continuous quantity.
   *
   * drift, gather and burst share ONE camera move; they are three names for
   * positions along a single shot, not three scenes. So every environmental
   * change between them has to be a function of WHERE the eye is, not of which
   * name won at the boundary -- switching planets on, the comet off and the
   * tails off at the same instant is three simultaneous pops, which is exactly
   * what the seam looked like.
   *
   * deepF ramps across the gather/burst boundary (hpF 2/3): it opens early, in
   * gather, and completes just inside burst, so the forest grows in and the sky
   * emerges WHILE the camera is still descending. That overlap is the meaning
   * in the motion -- arrival, not a cut to a new set.
   *
   * A pure function of scroll, so it is safe under the wipe rule: staging the
   * same section twice in one frame yields the same value both times, which an
   * eased-toward-target quantity would not. */
  const deepF = inVolume ? smoothstep(0.52, 0.88, hpF) : (name === 'work' ? 1 : 0);
  /* The mark's departure -- see MARK_EXIT_A_VH. Computed up here beside deepF,
   * not down in the mark block, because the DOF focus below needs it too, and
   * the god rays in the frame loop need it through __exitFor. */
  /* Linear after a short ease off rest -- see easeOffRest. NOT smoothstep: that
   * is what made the mark hold still and then bolt. */
  /* In VH FROM BURST'S START -- invariant under burst-length changes, which
   * the film's scrub runway now causes. See the constants' note. */
  const exitF = inVolume
    ? easeOffRest(Math.min(1, Math.max(0,
        (burstVh - MARK_EXIT_A_VH) / (MARK_EXIT_B_VH - MARK_EXIT_A_VH))))
    : 0;
  const markExitY = MARK_EXIT_RISE * exitF;
  /* The rays go on the tail of that, not alongside it. */
  const rayFade = smoothstep(MARK_RAY_FADE_FROM, MARK_RAY_FADE_TO, exitF);
  /* The deep grade and the DOF are NOT set here.
   *
   * They are properties of the COMPOSITED frame, and stageSection runs once
   * per section -- twice in a wipe frame -- so whichever section was staged
   * last would win. Burst-to-work wipes then rendered the burst half with the
   * work half's grade, i.e. none: the deep frame lost its colour the instant a
   * card slid in. See the blend in the frame loop, which mixes the two
   * sections' values by the wipe's own t. `deepSection` is what that blend
   * reads for this section. */
  /* ---- gradeF: the BASE grade, a sibling of deepF and not a retune of it.
   *
   * deepF's window (0.52..0.88) is right for the deep push, but it is exactly
   * zero across all of land, all of drift and the first ~60% of gather -- so
   * the split-tone, the saturation curve and the highlight desaturation never
   * ran there at all. That is why the upper sections read as objects in a void
   * while burst reads as a volume: not a different palette, an ungraded one.
   *
   * A floor of 0.28 from the first pixel, rising monotonically to exactly 1.0
   * by the end of the volume. Pure in scroll, like everything else that has to
   * survive being staged twice in a wipe frame.
   *
   * At hpF = 1: smoothstep(0, 0.88, 1) clamps to 1, so gradeF is 1.0 exactly
   * and burst is byte-identical to what it renders today. */
  /* max(deepF, floor), NOT an independent ramp -- and the reason is the
   * acceptance test itself.
   *
   * The specified form, lerp(0.28, 1, smoothstep(0, 0.88, hpF)), does not
   * reach 1.0 until hpF is 1.0, but burst OCCUPIES hpF 0.667..1. Mid-burst it
   * resolves to ~0.998 where deepF resolves to ~0.988, so every burst frame in
   * the 0.30-0.36 capture band would differ by a hair -- failing "burst must
   * be zero-diff" while nominally satisfying "gradeF = 1.0 at hpF = 1".
   *
   * Taking the max reconciles both: deepF overtakes the floor at hpF ~0.63,
   * just before burst opens, so from there gradeF IS deepF and burst is
   * byte-identical by construction. Below that the floor holds at 0.28 and the
   * grade exists from the first pixel of the site, which was the whole point. */
  /* A gentle floor RAMP under the max, not a flat floor: max(deepF, 0.28)
   * removed the plateau at zero but replaced it with a plateau at 0.28 across
   * land, drift and most of gather -- the brief asked for monotonic. The floor
   * climbs 0.28 -> 0.36 over the first two thirds of the volume and deepF
   * overtakes it right where burst opens, so the curve rises the whole way
   * AND is exactly deepF from burst onward.
   *
   * WORK STAYS AT 0. This pass is scoped to land/drift/gather; the snippet's
   * `work ? 1` would have graded section 3, which is the Active Theory port
   * pinned by test/baseline.json and has been "provably untouched" all
   * project. Flagged rather than silently applied -- say the word if you did
   * want work graded and it is one number. */
  const floorRamp = lerp(0.28, 0.36, smoothstep(0, 0.66, hpF));
  /* Work's entry now carries the deep's full grade and releases it across
   * the dive (1 at the cut, 0 by wp 0.10): with no wipe left to blend the
   * two sides, a 1 -> 0 snap at the boundary would be a visible exposure
   * jump in the same frame the camera crosses the surface -- and the murk
   * IS the underwater read. From wp 0.10 the section is grade-0, exactly
   * the provably-untouched baseline it always was. */
  const gradeF = inVolume ? Math.max(deepF, floorRamp)
    : (name === 'work' ? 1 - smoothstep(0.02, 0.10, S.work.progress) : 0.28);

  window.__deepFor = window.__deepFor || {};
  window.__gradeFor = window.__gradeFor || {};
  /* deepFor drives the DOF, which stays a deep-only effect; gradeFor drives
   * the colour grade, which now exists everywhere. Two maps because the wipe
   * blend in the frame loop has to mix each across a seam independently. */
  /* DOF RELEASES THE WATER. deepF saturates at 1 by hpF 0.88, so depth of
   * field was still at full strength through the whole water tail -- and its
   * focal plane is locked to the MARK, tens of units away. The surface, which
   * by then owns the lower half of the frame, sat far off that plane and came
   * out soft: the grass sharp, the water smeared. That is the blur band at
   * the seam, and it is not the wipe's doing at all.
   *
   * So the DOF weight (and only the DOF weight -- deepF still drives the
   * flora and planet reveals untouched) eases back to zero across the tail,
   * finishing before the sink completes. By the time the water is the subject
   * it is rendered sharp, which is also simply what a camera looking at a
   * surface a few units away would do. */
  const dofWaterRelease = inVolume
    ? 1 - smoothstep(WATER_SINK_A_VH - 60, WATER_SINK_A_VH + 40, burstVh)
    : 1;
  /* TWO SEPARATE WEIGHTS, and conflating them was a real regression.
   *
   * __deepFor is not a DOF weight -- it is the DEEP weight, and three things
   * read it: the DOF amount, the DOF amount for a wipe's outgoing half, and
   *
   *     deepRay = 1 + 0.85 * __deepFor[front]
   *
   * the god-ray strength. Folding the water release into it to stop DOF
   * blurring the surface therefore also dropped ray strength from 1.85 to
   * 1.00 across burstVh 295..395 -- a 45% lighting change in the middle of
   * the deep that had never been there. That is one of the "lights changing
   * three or four times while scrolling", and I put it there.
   *
   * __deepFor goes back to being exactly deepF. The release lives on its own
   * scalar that only depth of field reads. */
  window.__deepFor[name] = inVolume ? deepF : 0;
  window.__dofFor = window.__dofFor || {};
  window.__dofFor[name] = inVolume ? deepF * dofWaterRelease : 0;
  window.__gradeFor[name] = gradeF;
  /* The god rays are cast BY the mark -- it is the single light source in the
   * hero sections' occlusion buffer. So they leave with it, on the late curve
   * rather than the lift's own. Published per section for the same reason deepF
   * is: a wipe frame stages two of them. */
  window.__exitFor = window.__exitFor || {};
  window.__exitFor[name] = rayFade;
  if (inVolume && emblem) {
    /* focus locked to the MARK: read its true world position and the eye's,
     * so the focal plane tracks the staging rather than a hand-kept constant */
    emblem.mesh.getWorldPosition(dofFocusV);
    /* ...minus the exit lift. The focal plane is locked to the mark because the
     * mark is what the deep is composed around, not because the DOF cares where
     * that particular object is. Letting the focus ride the mark out of frame
     * would pull the plane 3 units back over the last stretch of scroll and
     * quietly soften the foliage in the one frame that is nothing but foliage. */
    dofFocusV.y -= markExitY;
    dofPass.uniforms.uFocusDist.value =
      camera.getWorldPosition(dofEyeV).distanceTo(dofFocusV);
  }
  workRoot.visible = name === 'work';
  /* homeRoot is the crossing tails (the plume moved to atmosRoot long ago), and
   * reference image 1 shows the tails prominently under the ring -- so they belong
   * to land as much as to the volume. */
  /* The crossing tails survive only in the open-space descent (drift/gather).
   * Removed from burst and now from land too, both at the user's call: the wide
   * soft ribbons read as graphics laid over the scene next to the mark's own
   * crisp glass X, which already draws the crossing silhouette. */
  /* RELEASED on deepF rather than switched off at the boundary: the mark sheds
   * its tails as the eye descends into the growth, which is a beat in the shot
   * rather than a cut between two of them. */
  homeRoot.visible = inVolume && deepF < 0.99;
  if (inVolume) for (const cu of home.columnUniforms) cu.uAlpha.value = 1 - deepF;
  aboutRoot.visible = name === 'land';
  atmosRoot.visible = name !== 'work';
  atmosRoot.position.z = name === 'land' ? ATMOS_ABOUT_Z : 0;
  /* Lifted in land: image 1 keeps its grain texture almost entirely ABOVE the
   * inclined horizon, leaving the lower half clean dark for the headline. */
  /* 2.0, down from 6.0. The full lift kept the grain in a band above the headline
   * and left the lower half pure black -- but reference image 1 has texture across
   * the WHOLE frame, the copy sitting on darker texture rather than on void. A
   * small lift keeps the densest grain out of the headline's immediate area. */
  atmosRoot.position.y = name === 'land' ? 2.0 : 0;

  /* The cloud backdrop, in every section. In work it wraps AROUND the card orbit --
   * scaled 1.6x so its ring sits ~30 units out while the camera orbits at 7.6, far
   * enough that the grains stay small and read as distant ambience rather than
   * joining the column's own dressing. Dimmer there too: the cards carry the light. */
  ambienceRoot.visible = true;
  if (name === 'work') {
    ambienceRoot.position.set(0, -7, 0);
    ambienceRoot.scale.setScalar(1.6);
  } else {
    /* Land: closer and lower than it was. z -12 instead of -17 fills the frame
     * with the scan's structure edge to edge, which is most of what makes
     * reference image 1's frame read as a PLACE rather than objects on black. */
    ambienceRoot.position.set(0, name === 'land' ? 2.0 : 0, name === 'land' ? -12 : 0);
    ambienceRoot.scale.setScalar(1);
  }
  if (heroCloud) {
    /* Dims continuously across the descent. This cloud IS the environment in
     * drift and gather, but by the deep frame the vegetation is, and a 262k
     * point bake laid over real plants reads as dirt on the lens. Fading it on
     * deepF hands the environment over gradually instead of at a boundary. */
    heroCloud.uniforms.uBrightness.value =
      name === 'work' ? 0.3 : (name === 'land' ? 0.45 : lerp(0.5, 0.14, deepF));
    /* Finer grain in land. The reference's field is mostly 1-3px specks gathered
     * into streams; at the volume's 0.6 bias the same points render as mid-size
     * discs and the frame reads closer to static than to particles. */
    heroCloud.uniforms.uSizeBias.value = name === 'land' ? 0.42 : (LOW ? 0.9 : 0.6);
  }
  /* Field density. In land it is a fixed dim backdrop under the copy; in the hero
   * volume the scroll-driven drives shape it -- sparse in drift (image 2), gathering
   * through image 3, spiking with the burst. Assigned, not eased: each half of a
   * wipe is staged and rendered separately, so an eased value would bleed one
   * section's setting into the other. */
  /* The field thins continuously into the deep: the free-floating particle
   * layer is meant to be SPARSE down there (spores and dust), and at full
   * strength it was a white dot-storm over the vegetation. Riding deepF, the
   * water simply clears as the forest closes in. */
  home.plumeUniforms.uAlpha.value = name === 'land'
    ? PLUME_ALPHA_ABOUT
    : PLUME_ALPHA_HOME * HERO.density / 0.16 * lerp(1, 0.25, deepF);
  /* Inward pull and outward throw. uAttract moves the field toward uLogoPos across
   * gather; uShock is the expanding shell radius that throws it back out across
   * burst. Both are additions to their shader -- see home.js. */
  home.plumeUniforms.uAttract.value = inVolume ? HERO.attract : 0;
  home.plumeUniforms.uShock.value = inVolume ? HERO.shock * 26 : 0;
  if (emblem) emblem.group.visible = name !== 'work';

  /* ---- THE LIGHTS ARE PER-RENDER, NOT PER-FRAME.
   *
   * wetSpec is a 28-intensity point light on camGroup, and it belongs to the
   * SPINE -- it is the travelling wet highlight that makes the column read as
   * slick. It lives on the scene, so it lights everything that renders while
   * it is on.
   *
   * It used to be written once per frame from `front`. During a wipe that is
   * fatal: a wipe frame renders TWICE -- the outgoing section into
   * transitionRT, then the incoming live -- and `front` is the INCOMING
   * section for the whole band. So from the instant the seam opened, the
   * deep's foliage was being rendered under the spine's 28-intensity light.
   * That is the white flickering and the shimmer on the upper scene, and it
   * is precisely the "upper scene affected by the lighting of the section
   * below" -- the two halves were sharing one lighting rig.
   *
   * stageSection runs once per render with `name` set to the section actually
   * being drawn, so putting it here isolates them completely: the deep half
   * renders at 0 and the work half at full, in the same frame, with no bleed
   * in either direction and nothing to ramp or fade. Pure assignment, so
   * staging twice in one frame is safe by construction. */
  wetSpec.intensity = name === 'work' ? 28 : 0;
  /* ...and work's additive particulate ARRIVES rather than switching on.
   *
   * These sprites are AdditiveBlending, so their contribution is unbounded
   * and stacks on whatever is behind them. Entering at full strength through
   * the seam they landed on the already-bright water at the bottom edge and
   * cleared bloom's threshold -- measured off the client's capture at +9.54
   * mean luma in ONE frame, reversing -7.53 two frames later. A handful of
   * grains at the frame edge blooming into a full-frame white flash.
   *
   * Ramped over work's first 12% so they accumulate with the picture instead
   * of arriving on top of it. Pure in work progress, so a wipe frame staging
   * twice gets the same answer both times, and identical from wp 0.12 on --
   * the settled section is untouched. */
  /* ALL ELEVEN OF THEM, not one. Bisected live at the reported frame by
   * locking objects invisible: the white patches only vanish once EVERY
   * Points cloud under workRoot is off. There are eleven -- the dust, the
   * flower cloud, the work foliage's own scatter -- and ramping a single
   * material's uniform left the other ten arriving at full strength, which is
   * why this looked unfixed.
   *
   * The patches are hard-edged and pale, following the grain clumps. NOT
   * additive saturation -- ten of the eleven are transparent:false,
   * depthWrite:true, alpha hard 1.0 (flower-cloud.js made them opaque on
   * purpose; see its comment about blown-out additive cores). What whitens
   * them is downstream: the early-work grade (uGrade ~1 until wp 0.10)
   * desaturates bright green toward white at 1.2x gain and adds +18%
   * exposure, and the composite's output cap flattens whatever crosses 1.0
   * into a single pale plateau with a hard boundary.
   *
   * Reached generically rather than per material -- opacity for anything that
   * respects it, uArrive/uAlpha where the shader exposes one, and uBrightness
   * as the last resort -- because the eleven do not share a single material
   * type and enumerating them by name would silently miss the next one added.
   * The uBrightness branch is the one that actually reaches the ten opaque
   * clouds: their uniform bag is uTime/uScroll/uSparkle/uBrightness/... with
   * no alpha of any kind, so the first two branches miss and transparent is
   * false. Verified live at 872vh (tr.t 0.15): scaling uBrightness removes
   * the patches with the room content intact; nothing else in this block
   * touches them at all. */
  {
    const arrive = name === 'work' ? smoothstep(0, 0.12, S.work.progress) : 0;
    workRoot.traverse((o) => {
      if (!o.isPoints || !o.material) return;
      const m = o.material;
      if (m.uniforms) {
        if (m.uniforms.uArrive) m.uniforms.uArrive.value = arrive;
        else if (m.uniforms.uAlpha) {
          if (m.__baseAlpha === undefined) m.__baseAlpha = m.uniforms.uAlpha.value;
          m.uniforms.uAlpha.value = m.__baseAlpha * arrive;
        } else if (m.uniforms.uBrightness) {
          if (m.__baseBrightness === undefined) m.__baseBrightness = m.uniforms.uBrightness.value;
          m.uniforms.uBrightness.value = m.__baseBrightness * arrive;
        }
      }
      if (m.transparent) {
        if (m.__baseOpacity === undefined) m.__baseOpacity = m.opacity;
        m.opacity = m.__baseOpacity * arrive;
      }
    });
  }
  /* ...and the mark's rims, on the same rule. The emblem is hidden in work,
   * so its lights have no business burning there while the deep half of a
   * wipe frame is the thing being drawn. */
  const rimGate = name === 'work' ? 0 : (name === 'land' ? 0.45 : 1);
  emblemRimA.intensity = EMBLEM_RIM * rimGate;
  emblemRimB.intensity = EMBLEM_RIM * 0.55 * rimGate;

  if (name === 'work') {
    camGroup.position.copy(workCamPos);
    camGroup.quaternion.copy(workCamQuat);
    camera.position.set(0, 0, 1.25);
    /* THE DIVE-IN -- work's first 57vh, which the rail already spends parked
     * on waypoint 0 (scrollValue's 0.06 dead zone), so consuming it as the
     * arrival costs the rail nothing. The burst side ends 0.05 above the
     * surface at fov 30; this side opens 0.1 UNDER its ceiling, pitched up
     * at the caustic, at the same fov -- the two halves of one plunge. The
     * eye then settles onto the rail pose as the ceiling fades overhead.
     * From wp 0.06 on, every value here is byte-identical to the baseline
     * rail; the entry deviation is the ordered underwater crossing.
     * Pure in wp, safe under staging-twice. */
    /* 0.65/0.28, down from 0.9/0.35: at 0.1 under the sheet, even a fine
     * caustic stretches into streaks at grazing incidence -- the entry now
     * opens 0.35 under it, still unmistakably at the surface but with the
     * web readable (user's screenshots drove both numbers). */
    /* workDive, not S.work.progress: the section scalar is clamped to zero
     * before the boundary, which froze this camera for the whole first half
     * of the wipe. See THE ARRIVAL. */
    const dive = workDive;
    /* 0.65. It was briefly 3.6 (sized to make the incoming content stream
     * upward at the wipe's reveal rate) and that was a mistake twice over:
     * it lifted this eye ABOVE the room's own water ceiling (+2), so the
     * incoming half rendered the room from OUTSIDE -- the ceiling slicing
     * the spine, the room's empty upper volume reading as a blank corrupted
     * band -- and the falling eye + pitch unwind made the whole incoming
     * scene visibly translate upward, which is the exact percept it was
     * meant to cure. The client's recording caught both. The real fix is
     * architectural (one world, one camera); this stays the modest
     * dive-under-the-ceiling it was authored as. */
    camGroup.position.y += 0.65 * dive;
    camera.rotation.set(0.28 * dive, 0, 0);
    setFov(lerp(35, 30, dive));

  } else if (inVolume) {
    /* ONE camera move across all three volume sections, driven by hpF -- their
     * combined progress. Splitting their 420vh Home into drift/gather/burst did not
     * split the shot: the eye descends continuously from image 2's height through
     * image 3's and into image 4's, which is why these three sections wipe into
     * each other with no transition at all.
     *
     * The move itself is verbatim from Active Theory's Home render tick:
     *
     *   camera.group.position.y  = range(scrollProgress, 0, 1, 40, -7)
     *   camera.group.position.z  = range(visibleV, 0, 1, -30, 5)
     *   camera.group.position.z -= 15 * (1 - scrollProgress)
     *   camera.position.y        = range(scrollProgress, 0, 1, 4.5, 2.5)
     *
     * Assigned, not eased: that is what their code does, and the scroll scalar
     * feeding it has already been through Lenis and the 0.28 filter. */
    /* THE SINK -- the eye keeps falling through burst's tail, from the
     * parked -4.5 down to -9.5, which is their 4.5-above-the-surface
     * framing. Everything composed in the frame (film, flora, planets)
     * is positioned relative to this same eye, so their screen framing
     * does not change by a pixel; the world-fixed water is the only thing
     * the sink reveals. Pure in burstVh, so a wipe frame staging burst
     * twice gets the same answer both times. */
    /* sink then plunge, one shared curve -- see waterTailDrop. The plunge
     * half accelerates (t*t): a fall, not an easing curve, and the boundary
     * cut lands at maximum speed, which is what hides it. */
    camGroup.position.set(0,
      lerp(40, -7, hpF) - filmDrift(burstVh) - waterTailDrop(burstVh),
      lerp(-30, 5, homeVisibleF) - 15 * (1 - hpF));
    camGroup.quaternion.identity();
    /* HERO.push on the local z: gather presses the camera in toward the mark
     * (image 3's compression), and the flash kicks it back out -- the recoil is
     * what makes the burst feel physical rather than graded on. */
    camera.position.set(0, lerp(4.5, 2.5, hpF), 40 - HERO.push);
    camera.rotation.set(HOME_PITCH, 0, 0);
    setFov(30);

  } else {
    /* Land: locked, no mouse move, no wobble, no rail -- their camera.lock().
     * Their UIL gives this rig no fov, so it inherits the 30 the site runs
     * everywhere except the work spine. Flagged as an inference, not a reading.
     *
     * THEIR AUTHORED DISTANCE IS 6, AND THIS IS 15. That is a translation, not a
     * disagreement, and it is worth being exact about why.
     *
     * Their About is its own FXScene with its own units -- which is already implied
     * by their mark being a separately scaled object there. Taken literally, 6
     * units in OUR world put the camera inside the particle volume, where their own
     * `vScale = smoothstep(8.0, 15.0, dist)` discards every grain within 8 units.
     * The section came out as a void with a mark floating in it, and the wipe into
     * it then mixed a full frame against black.
     *
     * 15 reproduces their FRAMING in this world instead of their number. The mark
     * covers the same 62% of frame height it did at their 6 with a 0.40 scale, so
     * nothing about the composition changes -- but the camera is now outside the
     * volume looking through it, so About is populated and the section is the same
     * space Home was, seen from further in. */
    /* ---- THE FLOATING CAMERA.
     *
     * Their camera.lock() held this rig perfectly still, and a still camera is
     * what made the hero read as UI over a picture: nothing in the frame had
     * parallax, so nothing had depth. Two additions, both tiny and both
     * strictly additive to their pose:
     *
     *   IDLE     two incommensurate sine pairs (0.06/0.043 Hz and 0.037 Hz)
     *            so the drift never visibly repeats -- the camera breathing
     *            while suspended, not orbiting.
     *   PARALLAX the pointer moves the eye a few hundredths of a unit. Enough
     *            that the foreground foliage slides against the background and
     *            the scene resolves as a SPACE; far too little to read as
     *            mouse-follow.
     *
     * The eye translates and the target stays put (the tiny counter-rotation
     * below), so this is real parallax rather than a pan -- a pan moves
     * everything together and buys no depth at all. */
    const ft = clock.elapsedTime;
    const driftX = Math.sin(ft * 0.377) * 0.16 + Math.sin(ft * 0.271) * 0.09;
    const driftY = Math.cos(ft * 0.233) * 0.11 + Math.sin(ft * 0.169) * 0.06;
    const driftZ = Math.sin(ft * 0.147) * 0.22;
    camGroup.position.set(0, 0, 0);
    camGroup.quaternion.identity();
    camera.position.set(
      driftX + camPar.x,
      driftY + camPar.y,
      ABOUT_CAM_Z + driftZ);
    /* look back at the artifact: the angles are the small-angle approximation
     * of aiming at (ABOUT_LOGO_X, 0), which at this distance is exact enough */
    camera.rotation.set(
      (driftY + camPar.y) * 0.010,
      -(driftX + camPar.x) * 0.010,
      0);
    setFov(30);
  }
  camGroup.updateMatrixWorld(true);

  /* ---- the mark, and the volume's geometry.
   *
   * After the camera, because the volume's mark tracks camera.group.position.y. */
  if (inVolume) {
    // AT: logo.position.y = camera.group.position.y + 4.5 - 0.6 * (1 - visibleV)
    emblemPos.set(0, camGroup.position.y + 4.5 - 0.6 * (1 - homeVisibleF), 0);
    /* 190 degrees of scroll rotation, doubled on the mark, plus a 210-degree
     * entrance that unwinds as the scene arrives. All three constants theirs. */
    const scrollTarget = radians(90) - radians(190 * hpF);
    // AT: logo.rotation.y — which their columns copy verbatim
    const logoRotY = LOGO_BASE + 2 * (dragRotation + scrollTarget)
                   + radians(210) * Math.pow(1 - homeVisibleF, 1.2);
    // AT: particles.group.rotation.y = radians(-20) + rotation + scrollTarget
    home.update(hpF, homeVisibleF, emblemPos, logoRotY,
                radians(-20) + dragRotation + scrollTarget);
    if (emblem) {
      emblem.group.position.copy(emblemPos);
      /* The exit is applied to the MARK ALONE, after home.update has taken the
       * unlifted emblemPos. That call anchors the tails and the plume's rotation
       * to the mark, and the plume is the volume's whole particle field -- lifting
       * emblemPos would carry the field out of frame with the coin. The tails are
       * already released by deepF long before hpF 0.84, so they never see this. */
      emblem.group.position.y += markExitY;
      emblem.group.scale.setScalar(1);
      /* ---- SQUARE TO CAMERA FOR THE HOLD.
       *
       * The mark is effectively a plate (0.634 x 0.982 x 0.067, see
       * LOGO_ASSET_FIX) and logoRotY keeps turning it -380 degrees per unit of
       * hpF, so by the time the deep settles it sits ~65 degrees off-axis --
       * the tilt in the user's circled frame. "Proper coin" means the plate
       * square to the camera, which is what the reference frames show.
       *
       * So the mark's own rotation eases off the scroll term and onto the
       * nearest WHOLE TURN across hpF 0.69..0.78 -- the blast's brightest
       * stretch, so the correction happens inside the whiteout and is never
       * seen as a turn. From 0.78 the mark is exactly face-on and stays that
       * way through the entire hold. The exit's two turns then ride on top and
       * land it face-on again (4*PI is a whole number of turns).
       *
       * Nearest whole turn rather than a hardcoded 0 so drag is respected: a
       * user who has spun the mark still settles to the nearest square-on
       * pose, and a 2*PI step in the rounding is pose-identical, so it cannot
       * pop once the blend has completed.
       *
       * MARK ONLY. logoRotY itself is Active Theory's number and their columns
       * copy it verbatim -- home.update above has already taken it. */
      const markRot = logoRotY + LOGO_ASSET_FIX;
      const faceOn = Math.round(markRot / (Math.PI * 2)) * (Math.PI * 2);
      const squareF = smoothstep(0.69, 0.78, hpF);
      /* Two turns across the exit, linear in exitF so the angular rate is
       * constant and scroll-locked exactly like the lift -- see MARK_EXIT_SPIN. */
      emblem.mesh.rotation.set(0,
        lerp(markRot, faceOn, squareF) + MARK_EXIT_SPIN * exitF, 0);
      /* 0.5 in burst only: there the mark sits over the screens inside the lush
       * cloud, and at exposure 1 its glass + bloom compound into the white ball
       * every burst screenshot showed. The reference's centre is a readable ring,
       * not a flare. (The AboutLogoShader's uExposure is linear, post-curve.) */
      /* Eased down as the eye descends rather than stepped at the boundary:
       * the mark dims into the dark forest the way a real object would as its
       * surroundings close in, instead of changing exposure in one frame. */
      emblem.material.uniforms.uExposure.value = lerp(1, 0.5, deepF);
    }
  } else if (name === 'land') {
    const t = about.logoTransform(landPF, dragRotation);
    /* Their About y-curve is authored for a mid-scroll reveal: range(p, -1, 1, 6,
     * -2) sits at y 2 when p is 0, which through the 2.5x world scaling is ABOVE
     * the frame -- the mark was simply missing from the landing. Land is entered at
     * p 0 and is the resting frame of reference image 1, so it gets its own gentle
     * travel through centre-frame; the AT ROTATION term is kept verbatim. */
    /* -0.2: the ring sits in the asset's upper half (teardrop point down), so
     * centring the RING at image 1's 43% frame height means holding the group's
     * origin slightly below centre. */
    emblemPos.set(ABOUT_LOGO_X, lerp(-0.2, -2.0, landPF), 0);
    if (emblem) {
      emblem.group.position.copy(emblemPos);
      emblem.group.scale.setScalar(ABOUT_LOGO_SCALE_XY);
      /* NOT t.rotY. Their About curve reads 160 degrees at progress 0 because it
       * is authored for a mid-scroll reveal (the -1..1 input range) -- which put
       * our flat mark near edge-on in the very frame image 1 shows it face-on.
       * Land's rest pose is face-on by construction, with a gentle 24-degree
       * drift across the section and the doubled drag kept from their code. */
      emblem.mesh.rotation.set(0,
        2 * dragRotation - radians(LAND_LOGO_SPIN) * landPF
        + LOGO_ASSET_FIX + radians(90), 0);
    }
    /* The tails hang from the mark here exactly as they do in the volume --
     * home.update owns that placement math, so reuse it. progress 0 pins the
     * plume-facing uniforms to their rest state; the plume itself is the dim
     * backdrop in land so that is correct, not a side effect.
     *
     * The tails' angle is FIXED at 90 degrees rather than following the mark's
     * drag rotation: the X-cross under the ring only reads as image 1's teardrop
     * from one viewing angle, and the volume happens to open at exactly this one
     * (LOGO_BASE + 2 x scrollTarget lands on 90 at its top). Land holds it. */
    home.update(0, 1, emblemPos, radians(90), 0);
  }
  /* The rim lights travel with the mark, exit included: they exist to put glints
   * on its bevels, and left behind they would become two loose point lights
   * sitting in the middle of the foliage. */
  emblemRig.position.copy(emblemPos);
  emblemRig.position.y += markExitY;

  /* ---- the set pieces, placed per section.
   *
   * Positions are read off the reference frames and expressed relative to what
   * anchors each section: the land camera is fixed so land placements are absolute;
   * the volume camera descends, so volume placements ride camGroup.y the same way
   * the mark does.
   *
   *   image 1: jelly left-of-mark at ~21% width, nebula upper-centre, aurora right
   *   image 2: jelly left mid, comet upper right, no nebula
   *   image 3: nebula everywhere, comet still visible upper right
   *   image 4: burst -- nebula dimmed under the flash, comet gone with the drives
   */
  /* Jellyfish in BOTH: the volume's single specimen (reference image 2) and the
   * landing's field of five (reference image 1). The two are separate holders because
   * the compositions are different -- one creature tracking the scroll camera versus a
   * fixed depth arrangement -- and they share geometry and material via jelly.instance.
   *
   * Land carried none for a while. That was decided when the creature was hand-built and
   * a swarm of four crowded the mark; image 1 has always shown five, so with their model
   * they are back, placed off the reference (see LAND_JELLY). */
  jellyHolder.visible = inVolume;
  jellyLand.visible = name === 'land';
  /* The comet belongs to the open-sky frames. It now FADES on deepF rather
   * than switching off at the boundary: as the canopy closes over the eye the
   * streak dims out with the open water it belonged to. */
  const cometGone = 1 - deepF;
  cometHolder.visible = inVolume && cometGone > 0.01;
  comet.uniforms.filaments.uAlpha.value = 0.85 * cometGone;
  comet.uniforms.sparks.uAlpha.value = 0.9 * cometGone;
  nebula.group.visible = name !== 'work';
  if (name === 'land') {
    /* LAND_JELLY positions are absolute world coordinates solved against the land
     * camera, so the field needs no per-frame placement -- unlike the volume specimen,
     * which tracks camGroup.position.y. */
    /* Centred and CLOSE (z -6): at -12 the clusters shrank into the far field and
     * the busy grain buried them. This near, they span the frame at full size the
     * way image 1's colour masses do. */
    nebula.group.position.set(0, 1.5, -6);
    nebula.group.scale.setScalar(1);   // burst doubles it; every exit restores
    for (const c of nebula.clouds) c.uniforms.uTint.value.set(c.cfg.tint);
  } else if (inVolume) {
    const camY = camGroup.position.y;
    /* Burst: high and BACK, in the clearing the canopy leaves above the mark.
     * Pushed to z 2 and scaled down -- at z 18 it loomed in the near field at
     * full size and dominated a frame whose subject is the mark; the brief asks
     * for it subtle and partly veiled by atmosphere. */
    /* The creature DRIFTS to its deep position instead of teleporting there:
     * it swims up and across as the eye descends, which is the one piece of
     * motion in the frame that reads as a living thing keeping its distance. */
    jellyHolder.position.set(
      lerp(-7.5, 3.5, deepF), camY + lerp(2.5, 8.0, deepF), lerp(-5, 2, deepF));
    jellyHolder.scale.setScalar(lerp(1, 0.62, deepF));
    cometHolder.position.set(7.0, camY + 9.5, -8);
    /* Burst: the nebula becomes the DEEP BACKDROP -- pushed behind the mark and
     * doubled, so the green cosmic dust fills the clearing's central void the
     * way the reference frame's does. Drift/gather keep the nearer, smaller
     * formation that reads as weather rather than as sky. */
    /* The nebula RECEDES and grades emerald continuously across the descent --
     * it does not swap. Position, scale and tint all ride deepF, so what was
     * weather overhead in drift becomes the deep sky behind the artifact by the
     * time the eye arrives. */
    nebula.group.position.set(0, camY + lerp(4.5, 3.5, deepF), lerp(-4, -13, deepF));
    nebula.group.scale.setScalar(lerp(1, 2.1, deepF));
    for (const c of nebula.clouds) {
      c.uniforms.uTint.value.set(c.cfg.tint).lerp(BURST_NEBULA_TINT, 0.55 * deepF);
    }
  }

  /* The alcove wraps the MARK, which in the volume rides camY + 4.5. Centre the
   * room a unit above the mark and push it back so the window plane sits behind
   * the glass. Only burst shows it, and its reveal follows burst's own progress
   * -- at the gather boundary progress is 0, so the room fades from nothing
   * exactly as the reference video grows it in. */
  /* The alcove is OFF. It was their scanned room -- a box -- and seen from
   * inside, a box is straight edges: the hard rectangle ruled across the frame
   * was its shell, and its bush slab was the second one. The vegetation below
   * is the environment now, and the reference's space is open forest, not a
   * room. The module stays built so the room can be revisited deliberately. */
  alcove.group.visible = false;
  /* Both the vegetation and the sky now ride deepF, so they GROW IN across the
   * gather/burst boundary instead of appearing at it. Visibility is gated on
   * the reveal being non-zero rather than on the section name -- the objects
   * are drawn while they are emerging and dropped only once they contribute
   * nothing. */
  floraHolder.visible = inVolume && deepF > 0.003 && !!flora;
  /* THE PLANETS ARRIVE OUT OF THE COIN'S BLAST, and they arrive continuously.
   *
   * Two separate faults were in play. First, they rode deepF > 0.003 -- the
   * vegetation's gate -- which put them on screen back in GATHER, ~60vh
   * before they belong. That is right for flora (alpha-tested foliage: a
   * barely-revealed plant contributes and occludes almost nothing) and wrong
   * for a 48-segment OPAQUE sphere with depthWrite on. The reveal fades
   * COLOUR toward the fog and deliberately not alpha (planets.js records that
   * alpha was tried and rejected for reading as a ghost), which only makes a
   * body recede while the BACKGROUND is fog too. In gather it is not -- the
   * nebula and the plume's field sit behind it, considerably brighter -- so a
   * fog-coloured sphere punched a flat dark hole through the field instead of
   * receding. Two of them, upper-left and lower-right.
   *
   * Second, gating a hard boolean on a threshold IS a pop: switching on at
   * deepF > 0.30 meant the first frame drawn was already 30% revealed.
   *
   * Both go away by driving the reveal from the burst itself. burstArg is the
   * same scalar heroDrives builds the flash and the shockwave from (0 at the
   * burst boundary, 1 by burstVh 182): the coin's flash peaks at 0.12-0.22 and
   * the shock disperses the field across 0..0.9. Ramping the planets over
   * 0.12..0.75 starts them exactly as the flash crests and completes them
   * while the particles are still being thrown outward, so the bodies resolve
   * out of the light's decay rather than being switched on beside it.
   *
   * Visibility now follows the reveal at ~0 instead of a threshold, so the
   * first drawn frame contributes nothing and there is no step to see. Pure
   * in scroll, so a wipe frame staging twice gets the same answer. */
  const burstArg = Math.min(1, Math.max(0, (hpF - 2 / 3) * 3));
  const planetReveal = smoothstep(0.12, 0.75, burstArg);
  planetHolder.visible = inVolume && planetReveal > 0.001;
  /* ---- the filmed epilogue -- see the film sequence setup block. Staged HERE,
   * outside the camera branch, because a wipe frame stages work after burst
   * and the plane sits at world z 0 -- inside work's card orbit. Without this
   * per-staging gate the burst staging's `visible = true` would leak into the
   * work half of every wipe frame. Assignments only; the video element's
   * transport (a side effect) lives in the frame loop. */
  deepBgHolder.visible = inVolume && burstVh > FILM_START_VH - 4;
  if (deepBgHolder.visible) {
    /* Cover-fit against the CURRENT camera, every staging: the eye is still
     * settling while the fade runs, and the aspect changes on resize. The
     * plane is 16x9, so covering the frustum is one uniform scale; 1.06
     * overscans past the pitch shift and any rounding. */
    const eyeY = camGroup.position.y + camera.position.y;
    const eyeZ = camGroup.position.z + camera.position.z;
    deepBgHolder.position.set(0, eyeY + Math.tan(HOME_PITCH) * eyeZ, 0);
    const fh = 2 * Math.tan(radians(15)) * eyeZ;
    const fw = fh * camera.aspect;
    const s = Math.max(fw / 16, fh / 9) * 1.06;
    deepBgMesh.scale.set(s, s, 1);
    deepBgMat.opacity = smoothstep(FILM_START_VH, FILM_START_VH + FILM_FADE_VH, burstVh);
  }
  /* ---- the water surface. On from before the sink starts, while it is
   * still below the frame's bottom edge, so it never switches on inside
   * the shot -- the reveal is the eye descending toward it, nothing else.
   * Gated per staging (wipe rule): work stagings must see it invisible.
   * The mirror RENDER is a side effect and lives in the frame loop. */
  water.topside.visible = inVolume && burstVh > WATER_SINK_A_VH - 25;
  /* the rise -- completes by the sink's end (470), so the whole plunge
   * happens against a settled surface and the crossing numbers hold. Pure
   * in burstVh; the mirror reads the surface's matrixWorld each frame, so
   * the reflection tracks the climb automatically. */
  water.topside.position.y = lerp(WATER_Y_FROM, WATER_Y_TO,
    smoothstep(WATER_SINK_A_VH, WATER_SINK_B_VH, burstVh));
  /* UNDERSIDE: the same surface from below, full through the dive-in and
   * the rail's opening hold, gone as the camera commits to the cards. The
   * dfe3a04 gates, verified live in that build. Pure assignments only. */
  /* THE WATER DOES NOT LEAVE. This used to switch off at work progress 0.14
   * and fade from 0.05 -- a hand-off written when work was a dry room reached
   * through a wipe. The client's note is blunt and correct: the water should
   * not disappear. You are under it for the whole section, so it stays, at
   * full alpha, and DEPTH does the dimming instead -- the fragment's
   * exp(-dist * 0.085) already carries it from full overhead at the crossing
   * to a fraction of that at the rail's deepest, which is what looking up
   * from further down actually does. Pure assignments, safe staged twice. */
  water.ceiling.visible = name === 'work';
  if (water.ceiling.visible) water.ceilMat.uniforms.uAlpha.value = 1;
  if (inVolume) {
    /* Positions updated across the WHOLE volume, not just in burst: a holder
     * whose transform is stale until the section it belongs to starts jumps on
     * its first visible frame, which is a pop of its own. */
    planetHolder.position.copy(camGroup.position);
    /* the burst-driven ramp, not deepF -- see planetHolder.visible above */
    planets.setReveal(planetReveal);
    /* ---- THE PLANETS MEET THEIR FILMED TWINS.
     *
     * The client's note: when the film takes over, nothing may reveal that
     * the background switched from 3D to video -- so the two 3D bodies are
     * steered onto the exact screen positions and sizes of the two planets
     * IN the footage (FILM_PLANETS, measured off frame 1).
     *
     * Placement is by RAY, not by authored xyz: take the film point (u,v),
     * find where it sits in the world on the film plane, and hang the body
     * on the line from the eye through it at its own depth. Because that
     * line is built from the film's live cover-fit, the body projects onto
     * its filmed twin at every aspect ratio -- which hand-tuned coordinates
     * cannot do, since the cover-fit crops differently as the window
     * changes. Radius comes down the same ray, so the silhouettes match too.
     *
     * Eased in over the 60vh before the film opens, from the authored
     * position, so drift and gather keep their parallax and the bodies have
     * arrived by the crossfade. Pure in burstVh -- safe staged twice. */
    const pin = smoothstep(PLANET_PIN_A_VH, PLANET_PIN_B_VH, burstVh);
    if (pin > 0) {
      const eyeYw = camGroup.position.y + camera.position.y;
      const eyeZw = camGroup.position.z + camera.position.z;
      const fhP = 2 * Math.tan(radians(15)) * eyeZw;
      const sP = Math.max((fhP * camera.aspect) / 16, fhP / 9) * 1.06;
      const filmYw = eyeYw + Math.tan(HOME_PITCH) * eyeZw;
      for (let i = 0; i < planets.group.children.length; i++) {
        const mesh = planets.group.children[i];
        const fp = FILM_PLANETS[i];
        if (!fp) {
          /* the two small companions have no counterpart in the footage;
           * shrinking them out before the crossfade is what stops a body
           * vanishing at it -- exactly the layer separation to avoid */
          mesh.scale.setScalar(1 - pin);
          continue;
        }
        const t = (eyeZw - fp.z) / eyeZw;
        const Px = (fp.u - 0.5) * 16 * sP;
        const Py = filmYw + (fp.v - 0.5) * 9 * sP;
        mesh.position.set(
          lerp(PLANET_HOME[i].x, t * Px, pin),
          lerp(PLANET_HOME[i].y, eyeYw + t * (Py - eyeYw) - camGroup.position.y, pin),
          lerp(PLANET_HOME[i].z, fp.z - camGroup.position.z, pin));
        mesh.scale.setScalar(lerp(1, t * fp.r * 9 * sP / fp.geoR, pin));
      }
    }
    if (flora) {
      /* The beds ride the camera group wholesale: the composition was solved
       * in camGroup-local space, so copying its position keeps every bed
       * pinned to its frame region while the eye descends. */
      floraHolder.position.copy(camGroup.position);
      /* ...EXCEPT through the water tail: eye-locked plants sat glued over
       * the rising surface and the water popped in behind them (the user's
       * "coming abruptly from the foliage"). Adding back 75% of the tail
       * drop anchors the beds mostly to the WORLD there, so as the eye
       * sinks the fringe rises aside and the water takes the space it
       * vacates -- the foliage parting IS the reveal. The 25% remainder
       * keeps the deepest side beds drifting with the frame so the edges
       * stay dressed. Same pure curve as the camera; zero before the tail,
       * so every approved film frame is untouched. */
      floraHolder.position.y += 0.75 * waterTailDrop(burstVh)
        /* the scrub drift's parallax layer: 65% world-anchored, so the
         * near fringe slides against the eye-locked film -- see filmDrift */
        + 0.65 * filmDrift(burstVh);
      flora.setReveal(deepF);
      /* The caustic arrives WITH the water, on the same descent curve as
       * everything else -- the surface overhead reveals itself as the eye
       * sinks, rather than being switched on at the section boundary. */
      flora.uniforms.uCaustic.value = deepF;
    }
  }

  /* ---- the environment (density pass). The land curtains live in the landing's
   * own world space; the hero curtains track the descending camera the same way
   * the jellyfish does; the work bowl rides workRoot and needs nothing here. */
  if (foliage) {
    foliage.landGroup.visible = name === 'land';
    foliage.heroGroup.visible = inVolume && name !== 'burst';
    /* The hand-placed burst vignette is RETIRED: the user's verdict on it was
     * correct and blunt. The lush envelope below is their asset through their
     * code; the vignette group stays built for later play but never shows. */
    foliage.burstGroup.visible = false;
    if (inVolume) {
      /* same 75% world-anchor through the water tail as the flora beds --
       * the walls part with the fringe, not behind it -- and the same 65%
       * anchor through the scrub drift, for the same parallax */
      foliage.heroGroup.position.set(0,
        camGroup.position.y + 0.75 * waterTailDrop(burstVh)
          + 0.65 * filmDrift(burstVh), 0);
    }
  }
  /* Fog banded per section, assigned not eased (wipe rule): deeper in work so the
   * foliage bowl recedes behind the cards -- atmospheric perspective is most of
   * what makes walls read as a PLACE rather than as sprites pasted at the edges. */
  scene.fog.density = name === 'work' ? 0.027 : 0.022;
  /* Formation strengths, assigned not eased (wipe rule). Land holds the faint
   * fixed presence image 1 shows; the volume follows the gather curve. The aurora
   * is image 1's right-edge light leak and belongs to land alone. */
  /* 0.8 in land, up from 0.35 -- image 1's teal and yellow clusters are a strong
   * presence, not a hint; at 0.35 they vanished under the grain. */
  nebula.uniforms.uNebula.value = name === 'land' ? 0.8 : (inVolume ? HERO.nebula : 0);
  nebula.uniforms.uAurora.value = name === 'land' ? 1 : 0;
  /* The mist is atmosphere, so unlike the coloured nebula it never goes to zero --
   * every reference frame carries it, and image 4's burst reads through it. */
  /* 0.6 in land, down from 0.75: over a crisp fine-grained field the heavier mist
   * read as a grey film -- part of the earlier "blurry" complaint. */
  /* The mist THICKENS with the descent. Image 2's entry frame reads as water
   * mainly because it is full of suspended light -- the haze is lit, not just
   * present -- and the parked deep frame had the same fog density as the open
   * frames above it, so it went dark instead of murky. Riding deepF turns the
   * arrival into a descent into the medium rather than into shadow. */
  mist.uniforms.uNebula.value = name === 'land' ? 0.6
    : (inVolume ? lerp(0.7, 1.25, deepF) : 0.45);
  jelly.uniforms.uScroll.value = inVolume ? hpF : 0;

  /* ---- ?flora=solo -- the acceptance test the brief demands: geometry and the
   * mark on black, no particles of any kind. If the vegetation is not
   * recognisable as vegetation in THIS render, the implementation is wrong and
   * no amount of atmosphere on top will save it. Applied last so it overrides
   * every visibility decision above. */
  if (FLORA_SOLO) {
    ambienceRoot.visible = false;
    atmosRoot.visible = false;
    homeRoot.visible = false;
    aboutRoot.visible = false;
    nebula.group.visible = false;
    jellyHolder.visible = false;
    jellyLand.visible = false;
    cometHolder.visible = false;
    particles.visible = false;
    alcove.group.visible = false;
    planetHolder.visible = false;
    if (foliage) {
      foliage.landGroup.visible = false;
      foliage.heroGroup.visible = false;
      foliage.burstGroup.visible = false;
    }
    if (flora) {
      floraHolder.visible = true;
      floraHolder.position.copy(camGroup.position);
      flora.setReveal(1);
      flora.dust.visible = false;
    }
    if (emblem) emblem.group.visible = true;
  }
}

function frame() {
  requestAnimationFrame(frame);
  // catches every viewport change, including the ones that fire no resize event
  applySize();
  const dt = Math.min(clock.getDelta(), 0.05);
  /* Accumulated from the CLAMPED dt, not clock.elapsedTime. The raw elapsed
   * time jumps by the full stall after a tab switch while every dt-integrated
   * spring advances 50ms -- so all the time-driven shaders (water normals,
   * sparkle, the flow field) teleported in one frame on tab return while the
   * rest of the page eased. One clock for everything. */
  animTime += dt;
  const t = animTime;

  // Lenis already eases the scroll position, so this second pass is only a
  // light trailing filter — full 0.1 damping on top reads as mush.
  lenis?.raf(t * 1000);
  /* The two scroll filters are dt-scaled: alpha = 1 - exp(-k*dt), with k
   * chosen so a 60Hz frame reproduces the old per-frame constants exactly
   * (k = -ln(1-a)*60). At 60Hz nothing changes; at 144Hz the settle time is
   * now the same wall-clock instead of 2.4x faster, which is what kept the
   * scroll feel from surviving a high-refresh display. */
  smoothProgress = lerp(smoothProgress, scrollProgress,
    REDUCED ? 1 : 1 - Math.exp(-19.72 * dt));
  const raw = (smoothProgress - prevProgress) / Math.max(dt, 1e-4);
  prevProgress = smoothProgress;
  scrollDelta = lerp(scrollDelta, raw, 1 - Math.exp(-7.67 * dt));

  stepTweens(dt * 1000);
  shared.uTime.value = t;
  shared.uScrollDelta.value = scrollDelta * 60;
  shared.uMouse.value.lerp(mouse01, 0.08);   // WorkItem: mouse.lerp(Mouse.normal, 0.08)
  /* the hero camera's pointer parallax, in world units — deliberately tiny */
  camParTarget.set(pointer.x * 0.42, pointer.y * 0.26);
  camPar.lerp(camParTarget, 0.025);

  /* ---- LIQUID: cursor speed -> refraction strength, smoothed.
   *
   * Speed is measured in NDC per second and clamped, so a flick cannot spike
   * the frame. The target is then approached at 0.06/frame, which is the whole
   * reason it reads as water settling rather than as a hover state toggling:
   * nothing here is ever assigned from the pointer directly.
   *
   * The numbers are in UV units and they are SMALL by design -- 0.006 baseline,
   * 0.018 ceiling. That is a sub-pixel-to-couple-of-pixels warp at the frame
   * edges, invisible as an effect and only felt as depth. */
  liqSpeed = liqPrev.distanceTo(pointer) / Math.max(dt, 1e-3);
  liqPrev.copy(pointer);
  /* `front` is declared further down; the pass reads LAST frame's section from
   * the frame-state probe, which for a one-frame-smoothed effect is identical. */
  const liqFront = window.__frameState.front;
  const liqOn = liqFront === 'land' || VOLUME.includes(liqFront);
  /* scroll nudges it up too, then it settles -- the transition "moves water" */
  const liqScroll = Math.min(1, Math.abs(shared.uScrollDelta.value) * 0.05);
  const liqTarget = liqOn
    ? Math.min(0.018, 0.006 + Math.min(liqSpeed, 3.5) * 0.0032 + liqScroll * 0.004)
    : 0;
  liqNow += (liqTarget - liqNow) * 0.06;
  compositePass.uniforms.uLiquid.value = liqNow;

  /* The slice refraction's centre trails the pointer at 0.09 -- water has
   * inertia, and a pocket welded to the cursor reads as a filter attached to
   * the mouse rather than as a medium being pushed through. */
  compositePass.uniforms.uCursor.value.lerp(
    cursorUv.set(mouse01.x, 1 - mouse01.y), 0.09);

  /* Remap the one global scalar into per-section local progress.
   *
   * `wp` replaces every read of smoothProgress below. Inside the Work section it
   * is bit-identical to what smoothProgress used to be (see src/sections.js), so
   * nothing downstream needed re-tuning.
   *
   * Visibility is set here, BEFORE the refraction pass, so the snapshot the glass
   * samples matches the frame that will be shown. */
  S = sectionState(smoothProgress, RANGES);
  const wp = S.work.progress;

  /* Exactly one section owns the frame outside a wipe. `active` comes straight
   * from the range table, so the five are mutually exclusive by construction --
   * which is what stops the emblem from ending up inside the spine. */
  const section = S.work.active ? 'work'
    : S.burst.active ? 'burst'
    : S.gather.active ? 'gather'
    : S.drift.active ? 'drift'
    : 'land';
  lastSection = section;

  /* Wipe state. Inside a band BOTH neighbouring sections are staged and rendered in
   * this frame and their shader mixes them across an inclined seam. Only two seams
   * wipe -- land into the volume, and the volume into the spine. drift/gather/burst
   * are one continuous camera move, so their boundaries are not scene changes and
   * must not cut -- see the seams note in src/transition.js. */
  /* 'work' IS on the seams list, and this is now settled by evidence rather
   * than by argument.
   *
   * Active Theory's bundle was scraped and read (assets/shaders/compiled.vs,
   * chunk FXScrollTransition.glsl, plus the ScrollRenderManager in their
   * app.js). Their crossing is NOT a camera passing through a surface. Each
   * section renders to its OWN render target and a fullscreen quad mixes the
   * two along an inclined line -- tMap1/tMap2, uTransition driven straight
   * off scroll progress. There is no shared world and no continuous eye.
   *
   * That matters here because several rounds were spent trying to make the
   * two sections physically continuous -- moving the card room, retiming the
   * plunge, matching camera poses -- and every one of those changes altered a
   * load-bearing world constant and broke the composition. The composite
   * needs none of it: both scenes stay exactly where they are.
   *
   * Their seam reads as liquid rather than as a cut because of four things,
   * all of which our port in src/transition.js already carries: an
   * aspect-corrected incline, a normal-map warp of the sample uv gated to a
   * band around the seam, a warp band much WIDER than the cut itself, and an
   * fwidth-based antialiased step. */
  const TR = transitionState(smoothProgress, RANGES, SECTION_ORDER, TRANSITION_VH,
                             ['drift', 'work']);
  /* The section that will end up owning the frame. DOM layers follow this rather
   * than `section` so the copy is already in place as the seam arrives, instead of
   * popping in behind it. */
  const front = TR.active ? TR.incoming : section;
  /* POST FOLLOWS THE FRAME, NOT THE DESTINATION.
   *
   * `front` is TR.incoming for the WHOLE band, so the moment a wipe opens --
   * while the screen is still essentially all outgoing -- every global post
   * term jumped to the incoming section's values. Bloom, the flash, the ray
   * gate, saturation and the wet specular all stepped at once against a
   * picture that had not changed yet: the glow/lighting glitch at the seam.
   * It stayed hidden while only land->drift wiped, because those two share
   * their post settings; turning the burst->work seam on exposed it, since
   * those sections are graded very differently.
   *
   * postFront is whichever section actually owns most of the frame, so
   * anything genuinely discrete flips at the halfway point where it is least
   * visible. Numeric terms blend across the band instead (see bloom).
   *
   * Declared HERE, beside `front`, not down in the post block -- it is read
   * by the rim lights ~120 lines earlier, and declaring it late threw a
   * temporal-dead-zone ReferenceError every single frame, which stalled the
   * loader at 3 compiled programs. */
  const postFront = (TR.active && TR.t < 0.5) ? TR.outgoing : front;
  window.__frameState.front = front;
  window.__frameState.tr = TR.active ? { t: +TR.t.toFixed(3), from: TR.outgoing, to: TR.incoming } : null;

  /* !ONLY: the landing's DOM is a fixed overlay driven from here rather than from
   * stageSection, so an isolation view's guard in stageSection never reached it and
   * the headline sat on top of the isolated object. */
  about.setActive(!ONLY && front === 'land');
  /* The chat panel was Active Theory's Home element. None of the four reference
   * frames shows it, and the brief is strict to the frames -- so it stays hidden.
   * The DOM is kept because it is a faithful recreation of theirs; removing it
   * would lose that work for no layout gain. */
  chatDOM.classList.add('off');
  setNavSub(front);

  landPF = S.land.progress;
  /* ---- THE DESCENT, PINNED TO ITS ORIGINAL LENGTH.
   *
   * hpF drives the camera's 40 -> -7 fall, deepF, the grade floor, the mark's
   * rotation -- everything about the SHOT. It used to be normalised over the
   * whole volume, which meant lengthening burst to give the coin room stretched
   * drift and gather too and made them sluggish (the user's call, and correct).
   *
   * So the denominator is now HERO_VOLUME_VH -- the original 420vh of
   * drift+gather+burst -- rather than the volume's current length. hpF advances
   * at exactly its original rate through drift, gather and the first 140vh of
   * burst, reaches 1 at the same scroll position it always did, and PINS there.
   * Drift and gather are therefore bit-identical to the shipped pacing, and the
   * blast plays out over the same 140vh.
   *
   * What burst's extra length now buys is a TAIL where hpF is already 1: the
   * camera has come to rest, the deep has fully arrived, and nothing in the
   * environment is moving. The coin's beat runs across that tail on its own
   * scalar (burstP below), which is what lets the hold be long AND the rise
   * slow AND the exit complete -- three things that were zero-sum while they
   * shared one scalar with the descent. */
  const volA = RANGES.ranges.drift.start;
  const volSpan = HERO_VOLUME_VH / RANGES.travelVh;
  /* Clamped-linear, with a C1 TAIL. The bare clamp meant everything hpF
   * drives -- the main descent (camGroup.y), its z pull, the eye height, the
   * mark/column rotation -- hit the 1.0 wall at full speed and stopped dead
   * at burstVh 140, then held for a 69vh dead stretch until filmDrift picks
   * up at 209. The largest single velocity step in the scroll, same failure
   * class the waterTailDrop comment documents for the plunge.
   *
   * Identity to 0.9 -- so deepF (saturated at 0.88), the grade, every gate
   * below sees bit-identical values -- then a parabolic ease-out that lands
   * slope-zero at t=1.1, i.e. full arrival at burstVh 182, still 27vh before
   * filmDrift. Only the last 10% of the descent retimes. */
  {
    const lin = Math.min(1.1, Math.max(0, (smoothProgress - volA) / volSpan));
    if (lin <= 0.9) hpF = lin;
    else {
      const u = lin - 0.9;                    // 0..0.2
      hpF = Math.min(1, 0.9 + u - 2.5 * u * u); // slope 1 at u=0, 0 at u=0.2
    }
  }
  /* Burst's own progress across its FULL length, the coin beat's clock. Module
   * level for the same reason hpF is: stageSection reads it and a wipe stages
   * twice per frame. */
  burstP = S.burst.progress;
  burstVh = burstP * RANGES.ranges.burst.spanVh;
  /* ...and the arrival, spanning the seam. The window starts half a wipe band
   * BEFORE the boundary -- so the incoming half is already moving on the
   * frame the line first appears -- and closes 63vh after it, which is the
   * rail's own dead zone, so it hands over to the rail exactly as the rail
   * starts to move. Nothing steps at the boundary because nothing about this
   * knows the boundary is there. */
  {
    const vhP = 1 / RANGES.travelVh;
    const wStart = RANGES.ranges.work.start;
    workDive = 1 - smoothstep(wStart - TRANSITION_VH.work * 0.5 * vhP,
                              wStart + 63 * vhP, smoothProgress);
  }
  /* The filmed epilogue's transport: THE WHEEL. The frame index is a pure
   * function of scroll over FILM_SPAN_VH -- park and the frame parks, reverse
   * and the ascent plays backward, and past burst's end (and all through
   * work) it clamps to the final frame resting under the seam. setProgress is
   * a side effect (texture rebind + cache prefetch), so it lives here in the
   * frame loop, once, never in stageSection which runs twice in wipe frames.
   * Only touched while the film could be on screen -- no cache churn from the
   * rest of the site. */
  /* ...and released once work owns the frame outright: burstVh clamps to its
   * max through the whole 1050vh work section, so this used to rebuild the
   * prefetch queue every frame of the heaviest section for a plane that is
   * not even visible there. During the band the film still parks under the
   * seam, so the gate follows the wipe out. */
  if (burstVh > FILM_START_VH - 30 && (S.burst.active || TR.active)) {
    film.setProgress(
      Math.min(1, Math.max(0, (burstVh - FILM_START_VH) / FILM_SPAN_VH)));
  }
  /* The scroll-driven hero drives: image 2 = drift's resting look, image 3 =
   * gather's, image 4 = burst's. See heroDrives in src/intro.js.
   *
   * Burst's input is derived from the PINNED hpF, not from S.burst.progress:
   * the blast is part of the shot, so it has to keep its original 140vh
   * duration rather than stretching with burst's new length. hpF 2/3..1 is
   * exactly that first 140vh. */
  HERO = heroDrives(S.drift.progress, S.gather.progress,
                    Math.min(1, Math.max(0, (hpF - 2 / 3) * 3)));
  // load entrance: the tails rise and the mark unwinds over 0.8s after the loader
  homeVisibleF = revealAt
    ? smoothstep(0, 1, Math.min(1, (performance.now() - revealAt) / 800))
    : 0;

  /* Drag inertia. Their About (our land) halves the sensitivity; the volume runs
   * full; Work has no drag at all. */
  dragDelta.lerp(pointerDown ? dragRaw : ZERO2, 0.07);
  dragRaw.set(0, 0);
  if (front !== 'work') {
    dragRotation += dragDelta.x * 0.0025 * (front === 'land' ? 0.5 : 1);
  }

  // ---- camera rail
  const offset = 0.06;
  const scrollValue = smoothstep(offset, 1 - offset, wp);
  const n = waypoints.length;
  const segPos = scrollValue * (n - 1);
  const i1 = Math.floor(segPos), i2 = Math.min(i1 + 1, n - 1);
  const frac = segPos - i1;

  target.position.copy(waypoints[i1].position).lerp(waypoints[i2].position, frac);
  target.quaternion.copy(waypoints[i1].quaternion).slerp(waypoints[i2].quaternion, frac);
  // verbatim from handleCameraScroll
  target.position.y += -1 * smoothstep(0, 0.15, wp);
  target.position.y += 1 * smoothstep(1, 0.85, wp);

  /* handleCameraScroll drives camera.GROUP. The camera itself sits at a local
   * offset inside that group — UIL: CAMERA_Element_2_Work position [0,0,2] —
   * so the eye is 2 units further out along the group's +Z than the waypoint.
   * uCamDistance is still measured to the group, which is why labels stay lit. */
  /* The rail's chase, stepped exactly once per frame and independent of which
   * section owns the camera -- see the note at workCamPos. */
  if (ONLY !== 'emblem') {
    if (first) {
      first = false;
      workCamPos.copy(target.position);
      workCamQuat.copy(target.quaternion);
    } else {
      workCamPos.lerp(target.position, 0.2);
      workCamQuat.slerp(target.quaternion, 0.2);
    }
  }

  /* Stage the section that will front the frame. Everything below -- the card
   * distance falloff, hover picking, the refraction snapshot -- reads camGroup, so
   * it has to be in place first. */
  stageSection(front);

  /* Rim lights follow the mark and fade out in Work. Intensity, never visibility --
   * see the note where emblemRig is created. Kept out of stageSection because a
   * wipe calls that twice a frame and would double-step the lerp.
   *
   * Land runs them at 0.45: its camera is 15 units out instead of 30-45, so the
   * same intensities that read as travelling glints in the volume blow the ring's
   * bevels to flat white patches at land's framing. */
  /* The rim lights are set per RENDER in stageSection now -- see THE LIGHTS
   * ARE PER-RENDER. They used to be eased here toward a single value, which a
   * wipe frame then applied to both of its renders; the easing is gone with
   * it because it is no longer needed. It existed to smooth the change at a
   * section boundary, and the only boundary that changes rim level is wiped,
   * so the wipe itself cross-fades the two images. */

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

  /* ---- hover picking, WORK ONLY.
   *
   * workRoot.visible = false hides the cards from the RENDERER, but a
   * Raycaster tests layers and never visibility, so the cards stayed
   * hit-testable in every section. The index cull below settles at focusIdx
   * 0 outside work and leaves cards 0 and 1 flagged visible, and card 0 sits
   * at world (3.8, 0, 0) -- comfortably inside the landing camera's frustum
   * and about 4 units away, so it passed the click handler's _dist > 30
   * guard too. Mousing over the right of the LANDING frame therefore set
   * `hovered`, and a click there pushed /work/<perma> into history and
   * rewrote document.title with no visible navigation, stacking a history
   * entry each time and degrading the back button.
   *
   * Gating here rather than in the click handler alone also stops the hover
   * lerps, the pointer trail and the video-card handover from running
   * against a card nobody can see. */
  raycaster.setFromCamera(pointer, camera);
  const hits = front === 'work'
    ? raycaster.intersectObjects(cards.filter(c => c.holder.visible).map(c => c.panel), false)
    : [];
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
    /* CANCEL, then zero. Assigning 0 on its own did not stick: the outgoing
     * card's own 800ms crossfade (500ms tween behind a 300ms delay) was still
     * in the list, and stepTweens overwrote the 0 on the very next frame and
     * carried it all the way to 1 -- leaving a card that is no longer nearest
     * permanently showing the shared video texture. Any handover inside that
     * 800ms window triggered it, which is to say ordinary scrubbing through
     * the helix, and it stacked: several cards could be stuck at once. */
    if (activeVideoCard) {
      cancelTween(activeVideoCard.pMat.uniforms.uVideoBlend);
      activeVideoCard.pMat.uniforms.uVideoBlend.value = 0;
    }
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
  /* 1.0 in Work, so section 3 is bit-identical to what it shipped as. Sections 1 and
   * 2 come down. `__over.sat` overrides it live for dialling in. */
  /* Burst runs greener than the rest of the volume: 0.55 was tuned for the
   * drift/gather starfield frames, and it greyed the foliage room's moss into
   * sage. The reference's masses are unmistakably green. */
  /* Burst back to 1.0: the split-tone grade owns the deep frame's colour now,
   * and stacking the old flat 0.75 desaturation under it re-created exactly
   * the monotone the grade exists to break. */
  /* ---- THE DEEP GRADE + DOF, blended across a wipe.
   *
   * Both act on the COMPOSITED frame, which during a wipe contains two
   * sections at once: the outgoing one rendered to its own target, the
   * incoming one live. Driving them from the fronting section alone meant a
   * burst-to-work wipe graded the whole blend as work -- so the burst half,
   * still filling most of the screen, lost its colour and its depth of field
   * the moment a card appeared. That is the glitch: not the transition
   * misbehaving, the grade being switched off underneath it.
   *
   * Mixing the two sections' own values by the wipe's t hands the blend a
   * grade that matches what is actually on screen at every point in the
   * crossfade. */
  {
    const dw = window.__dofFor || {};
    const gw = window.__gradeFor || {};
    const mixSeam = (map, dflt) => {
      const inV = map[front] ?? dflt;
      if (!TR.active) return inV;
      return lerp(map[TR.outgoing] ?? dflt, inV, TR.t);
    };
    /* DOF stays deep-only; the grade now exists everywhere and carries its own
     * floor. Both still blend across a seam by the wipe's own t. */
    dofPass.uniforms.uAmount.value = window.__over.dof ?? mixSeam(dw, 0);
    const gMix = window.__over.grade ?? mixSeam(gw, 0.28);
    u.uGrade.value = gMix;
    /* The shadow lift rides the grade, normalised off its 0.28 floor so it
     * runs 0.55 in land and 1.0 by burst. */
    u.uFloorLift.value = 0.55 + 0.45 * Math.min(1, Math.max(0, (gMix - 0.28) / 0.72));
  }
  /* postFront: saturation stepping while the frame was still mostly the other
   * section was part of the reported colour glitch at the seam. */
  u.uSaturation.value = postFront === 'work' ? 1
    : (window.__over.sat ?? (postFront === 'burst' ? 1 : HERO_SATURATION));
  /* Bloom follows the intro too, so "almost no bloom" in phase 1 is literal. Only
   * while Home fronts the frame; About and Work keep the authored strength. */
  /* Bloom is on everywhere. It spent a day disabled in the land section as a
   * workaround for a full-canvas blackout; the root cause is found and fixed at
   * source, and the mechanism is worth two lines here because it evaded three rounds
   * of object-level bisection: the plume fragment multiplied HSV saturation past 1,
   * hsv2rgb's mix() EXTRAPOLATES for interpolants over 1 and returned negative RGB,
   * and blendSoftLight took sqrt() of it -- NaN, kept by the half-float composer,
   * smeared frame-wide by bloom's blur. See the max() note in src/home.js. The
   * object-level bisection kept lying because a byte-target pixel probe launders
   * NaN on write; only a constant-fragment swap isolated the stage. */
  bloom.enabled = window.__over.bloom ?? true;
  const inVolumeFront = VOLUME.includes(postFront);
  /* Land runs bloom at half strength. In the reference the glow belongs to the
   * MARK; the particle field around it stays crisp. Full-strength bloom over a
   * dense field smears every grain a few pixels wide, and that smear -- more than
   * any sprite property -- is what read as "blurry, unprofessional". */
  /* ...and bloom RAMPS across the band rather than switching. burst runs at
   * BLOOM_STRENGTH * HERO.bloom (~0.54 at its end) and work at the full 0.72;
   * stepping between those is a visible bloom pop on a frame that is half
   * each. Lerping by the wipe's own progress means the glow crosses at
   * exactly the rate the picture does. */
  const bloomFor = (name) => VOLUME.includes(name)
    ? BLOOM_STRENGTH * HERO.bloom
    : (name === 'land' ? BLOOM_STRENGTH * 0.5 : BLOOM_STRENGTH);
  bloom.strength = TR.active
    ? lerp(bloomFor(TR.outgoing), bloomFor(TR.incoming), TR.t)
    : bloomFor(front);
  /* The core flash (image 4). A white-blue screen-space add centred on the mark, so
   * the burst blows out from behind the glass rather than as a full-frame fade. */
  u.uFlash.value = inVolumeFront ? HERO.flash : 0;
  /* Horizon: OFF, at the user's call. The inclined divide plus below-line darkening
   * was read off reference image 1, but on our frame the line cut across the
   * headline and the darkened lower half read as a band rather than a ground plane.
   * The shader term stays in the composite at zero cost so it can be revisited;
   * driving it is one line here. */
  u.uHorizon.value.x = 0;
  /* wetSpec is the SPINE's travelling wet highlight -- that is its whole job -- and
   * outside Work the camera group parks near the origin, which lands the light a
   * couple of units from the emblem. Near-field inverse-square on a sharp clearcoat
   * is exactly the value-spike class the composer's half-float targets turn into
   * Inf, so it is gated to the section whose look it exists for. */
  /* postFront, and RAMPED: a 28-intensity light appearing in one frame is a
   * hard lighting change, and during a wipe it lands on a picture that is
   * still half the other section. Riding the band puts the light in at the
   * same rate the room it belongs to arrives. */
  /* wetSpec is set in stageSection now, NOT here -- see THE LIGHTS ARE
   * PER-RENDER there. Leaving it in the frame loop meant one intensity for
   * both halves of a wipe frame, which lit the deep with the spine's light. */
  if (emblem) {
    emblem.mesh.getWorldPosition(flashWorld).project(camera);
    u.uFlashPos.value.set(flashWorld.x * 0.5 + 0.5, flashWorld.y * 0.5 + 0.5);
  }
  u.uTime.value = t;
  u.uScroll.value = wp * 20;   // the original scales scroll x20 for shaders
  u.uScrollDelta.value = shared.uScrollDelta.value;

  /* The SCROLL hint belongs to the top of the page -- the land section. Against the
   * global scalar it would only vanish 2% into a 1575vh track, which is 30vh in. */
  const hintP = S.land.progress;
  if (!hintHidden && hintP > 0.06) { hintHidden = true; hint.style.opacity = '0'; }
  else if (hintHidden && hintP <= 0.06) { hintHidden = false; hint.style.opacity = '1'; }
  /* Flower cloud drivers, transcribed from their WorkPage render tick:
   *   uRotate = Math.lerp(flowerRotation, uRotate, 0.05)
   *   uScroll = scrollProgress
   *   uSparkle += 0.005 */
  if (flowers) {
    const fu = flowers.uniforms;
    fu.uRotate.value = lerp(flowerRotation, fu.uRotate.value, 0.05);
    fu.uScroll.value = wp;
    fu.uSparkle.value += 0.005;
  }
  /* The hero instance of the same cloud, driven off the volume's combined progress
   * instead of Work's. uRotate turns it slowly so the canopy is not a still
   * photograph; uSparkle is their own accumulator and needs no scroll input. */
  if (heroCloud) {
    const hu = heroCloud.uniforms;
    hu.uScroll.value = hpF;
    hu.uRotate.value += dt * 0.02;
    hu.uSparkle.value += 0.005;
  }

  /* ---- THE CURSOR THROUGH THE VEGETATION.
   *
   * The cursor is handed to flora as a RAY, not a screen coordinate: the beds
   * span ~40 units of depth, so a point would only ever disturb one slice.
   * Everything is expressed in flora-LOCAL space -- floraHolder copies
   * camGroup's position with no rotation or scale, so that is a subtraction.
   *
   * `probe` is the ray sampled at the vegetation's own depth (the beds sit
   * ~24 units ahead of the burst eye); ripples are dropped there and the
   * cursor's world-space speed is measured from it.
   *
   * Runs whenever the flora is on screen, and is fed `active = false`
   * otherwise so the springs relax to rest instead of freezing mid-push. */
  if (flora) {
    const on = floraHolder.visible;
    floraIdle = on ? 0 : floraIdle + dt;
    /* Keeps integrating for a second and a half after the section leaves, so
     * the springs settle to rest off-screen rather than being frozen mid-push
     * and snapping back into view on return. */
    if (on || floraIdle < 1.5) {
      raycaster.setFromCamera(pointer, camera);
      curO.copy(raycaster.ray.origin).sub(floraHolder.position);
      curD.copy(raycaster.ray.direction);
      curProbe.copy(curD).multiplyScalar(24).add(curO);
      flora.interact(dt, curO, curD, curProbe, on && pointerInside);
      /* debug probe, opt-in: seven objects and three mapped arrays per frame
       * in the heaviest section is GC pressure with no reader unless someone
       * has asked for it (`__floraDbgOn = true` in the console) */
      if (window.__floraDbgOn) {
        window.__floraDbg = { on, inside: pointerInside,
          o: curO.toArray().map(v => +v.toFixed(2)),
          d: curD.toArray().map(v => +v.toFixed(3)),
          p: curProbe.toArray().map(v => +v.toFixed(2)) };
      }
    }
  }

  /* Set-piece animation, after stageSection so the nebula billboards to the final
   * camera. During a wipe the outgoing staging re-renders with billboards facing the
   * incoming camera -- one frame of misalignment on face-on glow quads, invisible. */
  jelly.update(dt);
  if (foliage) foliage.update(dt);
  comet.update(dt);
  nebula.update(camera, dt);
  mist.update(camera, dt);

  video.update(t);
  drawWave(t);

  /* ---- refraction pass: the scene snapshot that glass surfaces sample.
   *
   * Everything in refractExclude is hidden for this pass, and the reason differs
   * per object:
   *
   *   cards   they sample this buffer through radialBlur(), so drawing them into
   *           it would make each card refract itself.
   *   emblem  same: its material samples tRefraction. Drawing it into the buffer
   *           it reads is a feedback loop.
   *
   * An earlier version of this comment claimed the emblem was hidden because it
   * "carries a transmissive material" whose internal pass conflicted with this
   * one. That was true of a material that has since been removed -- the emblem
   * uses screen-space refraction now and sets no `transmission` at all. The guard
   * is still load-bearing, for the feedback-loop reason above; do not remove it on
   * the strength of the old rationale.
   *
   * ORDERING RULE: section visibility must be decided BEFORE this pass, so the
   * snapshot matches what the frame will actually show. */
  /* ---- god rays off the mark, their volumetricLight.addLight(logo).
   *
   * Home only, and only once the mark is actually in frame. The occlusion pass
   * hides the columns and the plume so the mark is the only bright thing in it --
   * feed it the plume and every grain becomes its own light source, which is a
   * white-out rather than shafts.
   *
   * Runs during a wipe too, on whichever side Home is: the rays are part of Home's
   * composite, and dropping them at the seam would read as the lights going out. */
  const wantRays = inVolumeFront || (TR.active && VOLUME.includes(TR.outgoing));
  const rayGain = window.__over.vol ?? VOLUMETRIC_STRENGTH;
  /* Fog and rays follow the scroll drives: flat through drift (image 2 has almost
   * none), rising through gather, peaking with the flash. Land gets a fixed low
   * level -- image 1 shows a soft glow around the mark, not shafts. Assigned, not
   * lerped: the curves are already smooth, and a filter would blunt the flash. */
  /* The work section runs the rays too, off the SPINE as the source -- the green
   * shafts fanning out from behind the column. Its strength is fixed rather than
   * drive-following: the section is a steady state, and the column is always lit. */
  /* God rays gain a deep-section boost: the shafts ARE the suspended light
   * that makes image 2's frame read as water, and at the descent's floor the
   * drive curve alone left them at roughly half what the entry frame shows.
   * Uses the blended seam value so it does not step at the work boundary. */
  /* Keyed to deepF, not the grade: the grade now has a floor everywhere, and
   * multiplying the rays by it would brighten land and drift too. Only the
   * DEEP push should thicken the suspended light. */
  /* Blended for real now: this read `__deepFor[front]` alone, and `front` is
   * TR.incoming for the WHOLE band -- work writes 0 there, so the boost fell
   * 1.85 -> 1.00 the instant the wipe opened, while the screen was still
   * almost entirely the deep. The lights visibly dimmed at the band edge.
   * Same seam blend the DOF/grade block uses. */
  const _df = window.__deepFor || {};
  const deepRay = 1 + 0.85 * (TR.active
    ? lerp(_df[TR.outgoing] ?? 0, _df[front] ?? 0, TR.t)
    : (_df[front] ?? 0));
  /* ...and released as the mark CLEARS, not as it climbs -- see the note at
   * MARK_RAY_FADE_FROM for why that distinction is the whole move. The shafts
   * are cast BY the mark: it is the only object in the occlusion buffer here,
   * and the pass radial-blurs from its screen position. Once it is above the
   * frame that position is off-screen and the buffer is empty, so what is left
   * is a fan of light with nothing at its apex -- the source gone but its shafts
   * still lying across the water. Releasing them over the last quarter of the
   * lift is what avoids that without putting the mark out early. The deep still
   * reads as water afterwards: the fog, the grade, the caustics on the foliage
   * and the suspended dust all stay. */
  /* Same front-keying fault as deepRay above: work stages rayFade 0, so for
   * the whole band the mark's release was force-zeroed under a frame still
   * mostly the deep. Blend across the band by the wipe's own t. */
  const _ef = window.__exitFor || {};
  const markExit = TR.active
    ? lerp(_ef[TR.outgoing] ?? 0, _ef[front] ?? 0, TR.t)
    : (_ef[front] ?? 0);
  /* Work's spine rays hold off until the ceiling has faded (wp 0.10..0.18):
   * during the underwater entry the shaft fired straight up through the
   * caustic sheet and printed a vertical streak over it -- the client
   * circled it. The dive is lit by the ceiling itself; the shafts belong
   * to the open card room. */
  /* NO GOD RAYS FROM THE SPINE, at the client's call.
   *
   * The column used to be the emitter for the whole work section --
   * rayGain * 0.55 once past wp 0.18. Two reasons that goes:
   *
   *   - it is the one thing in work that casts light OUTWARD. The spine's own
   *     glow is a fresnel emissive (spine-glb.js) and an emissive lights only
   *     the surface it is on, so it cannot illuminate anything else. The ray
   *     pass could: it takes the column as an occlusion source and lays a
   *     full-screen additive fan over the frame -- including, during a wipe,
   *     the half that is still the deep.
   *   - a shaft fired straight up from a column that is itself the brightest
   *     object in frame reads as a lens artefact rather than as light.
   *
   * The deep keeps its rays: there they are cast by the MARK, which is a
   * small bright source with dark around it -- the geometry god rays are for.
   * Work now has none, so the section is lit only by what is in it. */
  u.uVolumetricStrength.value = wantRays ? rayGain * HERO.fog * deepRay * (1 - markExit)
    : (postFront === 'land' ? rayGain * 0.25 : 0);
  /* postFront, not front. `front` is TR.incoming for the WHOLE band, so from
   * the instant the wipe opened the ray source switched to work's SPINE while
   * the screen was still almost entirely the deep -- the lower scene's shafts
   * cast across the upper one, which is the light bleed visible where the two
   * meet. The occlusion hide list below has the same problem and takes the
   * same fix: both now follow whichever section actually owns the frame. */
  /* ...and the spine is no longer a source at all. In work this leaves
   * raySource as the mark, which is hidden there, so the pass is skipped
   * outright and work pays nothing for it. */
  const raySource = postFront === 'work' ? null : (emblem && emblem.mesh);
  if (raySource && u.uVolumetricStrength.value > 0.004) {
    /* The hide list is everything that is NOT the light source. One source only:
     * the mark in the hero sections, the spine column in work. Leaving any point
     * cloud in the occlusion buffer makes every grain its own light source, which
     * is a white-out rather than shafts -- that is what turned an earlier hero
     * frame into a green starburst. In work that means hiding the cards, the
     * flower cloud and the ambient particles so the column alone emits. */
    /* ambienceRoot (cloud + mist) is on both hide lists: additive mist in the
     * occlusion buffer becomes a diffuse light source and washes the shafts out. */
    /* STAGE THE SECTION THIS PASS BELONGS TO, FIRST.
     *
     * This is the last place the spine's light was reaching the upper scene,
     * and the worst, because the result is applied as a FULL-SCREEN ADDITIVE
     * over the composited frame -- both halves of a wipe at once.
     *
     * The frame loop stages `front` (= TR.incoming for the whole band) at the
     * top, and this pass runs before the wipe block re-stages anything. So
     * across the entire seam the occlusion buffer was being built from WORK's
     * scene, with the spine as the emitter, and then added over a picture that
     * was still mostly the deep. Shafts cast by a column that is not in that
     * half of the frame, riding on top of it -- the white and green flashing
     * and the shimmer.
     *
     * Staging postFront makes the buffer match the section that owns the
     * frame, and `front` is restored immediately after so nothing downstream
     * sees a different scene than it expects. stageSection is pure assignment
     * and idempotent -- staging twice more in a wipe frame is exactly what it
     * is built for. */
    const restage = TR.active && postFront !== front;
    if (restage) stageSection(postFront);
    volumetric.render(scene, camera, raySource,
      postFront === 'work'
        ? [cardGroup, particles, flowers && flowers.group, ambienceRoot, water.ceiling]
        : [...home.columns, home.plume, ambienceRoot,
           jelly.group, comet.group, nebula.group, deepBgHolder, water.topside]);
    u.tVolumetricBlur.value = volumetric.texture;
    if (restage) stageSection(front);
  }

  /* ---- the outgoing section, for the wipe.
   *
   * Their FXScrollTransition mixes two scenes rendered in the same frame, so the
   * one that is leaving has to be drawn somewhere. Staged, rendered to its own
   * target, then the fronting section is staged back so everything after this --
   * the refraction snapshot and the real render -- sees the right state.
   *
   * The glass in the outgoing section samples whatever was in refractionRT last
   * frame rather than a snapshot taken under its own rig. A wipe lasts 30vh and
   * the alternative is a third full scene render; the staleness is not visible.
   *
   * Only ever runs inside a band. Outside one the pass is disabled and this whole
   * block is skipped, so the Work section pays nothing for it. */
  transitionPass.enabled = TR.active;
  if (TR.active) {
    const tu = transitionPass.uniforms;
    tu.uTransition.value = TR.t;
    tu.tMap1.value = transitionRT.texture;
    tu.tNormal.value = normalTex;

    stageSection(TR.outgoing);
    /* The mirror is NOT rendered here: the mirror pass below runs once per
     * frame under postFront's staging, which serves whichever half owns the
     * frame -- including this outgoing one while TR.t < 0.5. (An older
     * comment here claimed the burst->work wipe no longer existed; 'work'
     * is on the seams list and has been since the wipe came back.) */
    renderer.setRenderTarget(transitionRT);
    renderer.clear();
    renderer.render(scene, camera);

    /* ---- DOF ON THE OUTGOING HALF.
     *
     * This render bypasses the composer entirely -- it is a direct
     * renderer.render into a target -- so it never saw the DOF pass, and
     * scrolling out of the deep snapped its whole half of the frame sharp
     * while the incoming half stayed treated. The wipe looked like the effects
     * "glitched off" at the seam, which is exactly what it was.
     *
     * transitionRT carries its own depth texture, so the same pass can run
     * over it with the same focus solve. Only during a wipe, and only when the
     * outgoing section actually wants DOF -- outside those the block is
     * skipped and costs nothing. */
    const dofOut = window.__dofFor?.[TR.outgoing] ?? 0;
    /* Hysteresis, because this switch changes which TEXTURE tMap1 is -- the
     * DOF'd copy or the raw target. A dofOut hovering on a single threshold
     * flipped that identity frame to frame, a visible sharpness flicker on
     * the whole outgoing half. Engage above 0.02, release below 0.005. */
    transitionDofOn = transitionDofOn ? dofOut > 0.005 : dofOut > 0.02;
    if (transitionDofOn) {
      const du = dofPass.uniforms;
      const keepAmt = du.uAmount.value, keepTex = du.tDepth.value;
      du.uAmount.value = dofOut;
      du.tDepth.value = transitionDepth;
      du.tDiffuse.value = transitionRT.texture;
      renderer.setRenderTarget(transitionDofRT);
      renderer.clear();
      dofPass._fsQuad.render(renderer);
      tu.tMap1.value = transitionDofRT.texture;
      du.uAmount.value = keepAmt;
      du.tDepth.value = keepTex;
    }

    renderer.setRenderTarget(null);
    stageSection(front);
  }

  /* ---- the mirror pass, THEIR FX.Mirror: the scene re-rendered from the eye
   * reflected about the surface, into the target the water samples via
   * uMirrorMatrix. A side effect, so it lives here in the frame loop -- once,
   * after the fronting section is staged and before anything reads the scene.
   * Skipped entirely when neither face is on screen.
   *
   * It runs for the CEILING too, reflected about the ceiling plane: the
   * underside samples this same target (water.js), so without this pass it
   * would sample a target frozen at the last burst frame. Reflecting the
   * card room off the underside of the surface is also what really happens
   * down there -- total internal reflection.
   *
   * HALF RATE. This is a whole extra scene render, and the client's
   * recording measured 9.4% of frames being dropped, so it runs on every
   * other frame -- except the first frame the surface appears, which must
   * not sample an empty target. The reflection is low-frequency and then
   * shattered by a ~0.15-of-frame ripple displacement, so a 30Hz update is
   * invisible where a dropped frame is not. Together with the 512 target
   * (water.js) this is ~8x less mirror work than it shipped with. */
  /* OWNED BY THE HALF THAT OWNS THE FRAME. Both faces sample the ONE mirror
   * target, and this pass used to pick its face after stageSection(front) --
   * front being TR.incoming for the whole band. So for every frame of the
   * burst->work wipe the target held the card room reflected about the
   * CEILING plane (y +2), while the outgoing half was drawing the TOPSIDE
   * (y ~-12.4) sampling that same target: a reflection about a plane ~14
   * units away with the opposite normal, projected through the wrong matrix.
   * Out-of-range projective uv on a clamp-to-edge target is broad flat
   * plateaus with hard edges -- the pale band along the bottom of the
   * outgoing half. Restaging to postFront picks the face belonging to
   * whichever section actually dominates the frame, the same rule the ray
   * pass and saturation already follow. */
  const mirrorRestage = TR.active && postFront !== front;
  if (mirrorRestage) stageSection(postFront);
  const mirrorFace = water.topside.visible ? water.topside
    : (water.ceiling.visible ? water.ceiling : null);
  if (mirrorFace) {
    /* A face swap (topside <-> ceiling, including the postFront handover
     * mid-band) invalidates the target's contents outright -- force a fresh
     * render rather than letting the other plane's reflection linger for a
     * parity frame. */
    if (mirrorFace !== mirrorFaceLast) mirrorWarm = false;
    mirrorFaceLast = mirrorFace;
    if ((mirrorTick++ & 1) === 0 || !mirrorWarm) {
      /* Driven by whether a render ACTUALLY happened. The near-plane guard in
       * water.js can decline, and flagging warm on a declined call would
       * satisfy the "never sample an unwritten target" invariant with nothing
       * drawn -- which is the one-frame flash this exists to stop. */
      mirrorWarm = water.mirror.render(renderer, scene, camera, mirrorFace) === true;
    }
  } else {
    mirrorWarm = false;
    mirrorFaceLast = null;
    mirrorTick = 0;
  }
  if (mirrorRestage) stageSection(front);

  const refractHidden = [];
  for (const o of refractExclude) {
    if (o && o.visible) { o.visible = false; refractHidden.push(o); }
  }
  renderer.setRenderTarget(refractionRT);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  for (const o of refractHidden) o.visible = true;
  /* Geometry actually submitted for this camera, captured before the composer
   * overwrites renderer.info with its fullscreen quads. Without this there is no way
   * to tell a black frame caused by nothing being drawn from one caused by post
   * eating it -- and this project has produced both. */
  window.__frameState.tris = renderer.info.render.triangles;
  window.__frameState.drawCalls = renderer.info.render.calls;

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

  /* PIN THE PING-PONG PARITY. EffectComposer carries writeBuffer/readBuffer
   * across frames, and the swap count varies with how many passes are enabled
   * (transitionPass only during a wipe). Without this, RenderPass alternates
   * which target it writes into, and the DOF pass -- which reads
   * renderTarget2's depth attachment -- gets a whole-frame-stale depth buffer
   * on every other frame. Ghosting, plus a flicker that alternates with the
   * parity. Resetting here costs nothing and makes the buffer each pass sees
   * identical on every frame. */
  composer.writeBuffer = composer.renderTarget1;
  composer.readBuffer = composer.renderTarget2;
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
/* the mirror pass's half-rate state -- see the mirror block in the frame loop */
let mirrorTick = 0, mirrorWarm = false, mirrorFaceLast = null;
let transitionDofOn = false;
let sizedW = 0, sizedH = 0;
function applySize() {
  /* Floor at 1px. A viewport can genuinely be 0 -- an embedded preview pane that
   * has not been laid out yet reports innerWidth/innerHeight 0, and sizing render
   * targets to 0 makes every framebuffer incomplete ("Attachment has zero size"),
   * so every draw and clear is rejected for the life of the context. It does not
   * self-heal either: rAF is throttled in that state, so the loader's double-rAF
   * never fires and the overlay stays up forever. Clamping keeps the targets valid
   * until a real size arrives, and the per-frame reconciliation below then picks it
   * up with no resize event needed. */
  const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
  if (w === sizedW && h === sizedH) return;
  sizedW = w; sizedH = h;

  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  /* One depth texture, two targets: composer.setSize resizes each target's
   * depthTexture in turn, so the SHARED one is resized twice to the same
   * dimensions -- harmless. Asserting it here because a mismatch between the
   * depth texture and the colour buffer is invisible until DOF samples garbage
   * at the edges. */
  sceneDepth.image.width = w;
  sceneDepth.image.height = h;
  sceneDepth.needsUpdate = true;
  refractionRT.setSize(Math.round(w * 0.5), Math.round(h * 0.5));
  /* Full resolution AND full pixel ratio, unlike the refraction target: this
   * one is half the frame during a wipe, so anything below the composer's own
   * size shows as a soft half against a sharp one. w x h alone was exactly
   * that bug on any DPR > 1 display -- see the note at the declaration. */
  const tw = Math.round(w * DPR), th = Math.round(h * DPR);
  transitionRT.setSize(tw, th);
  transitionDofRT.setSize(tw, th);
  transitionDepth.image.width = tw;
  transitionDepth.image.height = th;
  transitionDepth.needsUpdate = true;
  /* CSS pixels on purpose: the wipe shader only reads this as an aspect ratio
   * (resolution.x / resolution.y), which is identical either way. */
  transitionPass.uniforms.resolution.value.set(w, h);
  volumetric.setSize(w, h);
  bloom.setSize(w * BLOOM_SCALE, h * BLOOM_SCALE);
  shared.uResolution.value.set(w * DPR, h * DPR);
  compositePass.uniforms.uResolution.value.set(w, h);
  dofPass.uniforms.uResolution.value.set(w, h);
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
   * against a black void it refracts black and reflects nothing, so a fully
   * emptied scene renders the emblem genuinely invisible. The particle field is
   * also what the reference frames put behind it. */
  proxy.visible = false;
  cardGroup.visible = false;
  camGroup.position.set(0, -6.0, 9.0);
  camGroup.quaternion.identity();
  /* Zero the DENSITY, never assign scene.fog = null.
   *
   * Verified in vendor/three/build/three.module.js: the program cache key carries
   * `fog: !!fog`, which drives `#define USE_FOG`. Removing the fog object flips
   * that define and forces every material in the scene to compile a new program --
   * including the 840k-triangle spine. Density 0 is visually identical and keeps
   * the define, so no recompile happens. Same rule applies to scene.environment. */
  scene.fog.density = 0;
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
  /* Prewarm every section's programs while the overlay is still up.
   *
   * Only one section is visible at a time, and three compiles a material's
   * program the first time it actually renders -- so without this, arriving at the
   * work spine for the first time compiles the 840k-triangle spine, the fourteen
   * cards and the flower cloud mid-scroll. Measured: 16 programs during Home,
   * jumping to 20 on first reaching Work. That jump is a visible hitch.
   *
   * A plain render into the (half-size) refraction target does it. Deliberately
   * NOT renderer.compile(): in current three that performs a virtual render and
   * leaves renderer state bound, which blanked the canvas outright. */
  /* ONE RENDER PER SECTION, each behind its own rig. A single render with
   * everything made visible at once is NOT enough, and the reason is worth
   * recording: projectObject skips frustum-culled objects, so nothing compiles for
   * a mesh that is off screen. Staged only under Home's rig -- eye at y 44, thirty
   * units out -- the spine and the cards sit far below the frustum and were still
   * linking later. Measured: with a single render, +3 programs appeared at the
   * About-to-Work seam; with this loop, none. */
  /* refractExclude is hidden for these renders, exactly as the per-frame refraction
   * pass does it. The prewarm draws into refractionRT, and every object in that list
   * SAMPLES refractionRT -- the cards, the mark, the columns, and now the jellyfish
   * bells -- so leaving them visible is a framebuffer/texture feedback loop. WebGL
   * rejects the draw outright (GL_INVALID_OPERATION), which both spams the console
   * and means the very materials this loop exists to compile are the ones that never
   * get drawn, silently defeating the prewarm. */
  const prewarmHidden = [];
  for (const o of refractExclude) {
    if (o && o.visible) { o.visible = false; prewarmHidden.push(o); }
  }
  for (const name of SECTION_ORDER) {
    stageSection(name);
    renderer.setRenderTarget(refractionRT);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
  }
  for (const o of prewarmHidden) o.visible = true;
  /* Second pass with them visible, into the DEFAULT framebuffer this time, so their
   * programs still compile behind the overlay -- the point of the prewarm. */
  for (const name of SECTION_ORDER) {
    stageSection(name);
    renderer.render(scene, camera);
  }
  /* THE WATER'S OWN PROGRAMS, which the section loop above cannot reach.
   *
   * Both loops stage each section at its DEFAULT scroll state, and the water
   * is gated on scroll rather than on section: topside needs
   * burstVh > WATER_SINK_A_VH - 25 and the underside needs work progress
   * under 0.14. At prewarm time burstVh is 0, so neither face is ever visible
   * for those renders and neither program is ever compiled -- the whole point
   * of the prewarm, missed for the two heaviest materials in the crossing.
   * They then link on the exact frame the surface first appears, which is the
   * "first time it appears it is jittery and glitchy": a four-tap normal
   * field, a matcap and the fake-PBR block all compiling inside one frame.
   *
   * Staged first, then forced visible, because stageSection would otherwise
   * overwrite the flag. Visibility is restored from what staging decided, not
   * from what was forced, so this leaves no state behind. */
  for (const [name, face] of [['burst', water.topside], ['work', water.ceiling]]) {
    stageSection(name);
    const was = face.visible;
    face.visible = true;
    renderer.render(scene, camera);
    face.visible = was;
  }
  /* EVERYTHING ELSE THAT IS GATED ON SCROLL, staged at real scroll positions.
   *
   * The water block above force-shows two faces by hand, but it is one
   * instance of a whole class: the deep holders (flora, planets, the film
   * plane), the comet, the nebula, the mist -- their visibility and their
   * transforms are pure functions of scroll, all closed at scroll 0 where
   * the loops above run. Each of those programs linked mid-scroll on the
   * exact frame its gate opened -- measured as 53 -> 59 -> 61 program growth
   * across the first pass through burst, and still +6 after force-showing
   * the holders alone, because forcing visibility leaves the transforms
   * unplaced and misses the next gated subsystem.
   *
   * So instead of forcing flags, drive the scroll itself: set the module
   * drives exactly as frame() derives them, then stage normally. Every gate
   * opens because the world believes it is really there. Restored below --
   * smoothProgress is persistent filter state, and leaving it parked at the
   * last prewarm stop would make the first real frame fly in from 1380vh. */
  const preScrollP = smoothProgress;
  const driveTo = (vh) => {
    smoothProgress = vh / RANGES.travelVh;
    S = sectionState(smoothProgress, RANGES);
    const volA = RANGES.ranges.drift.start;
    const volSpan = HERO_VOLUME_VH / RANGES.travelVh;
    hpF = Math.min(1, Math.max(0, (smoothProgress - volA) / volSpan));
    burstP = S.burst.progress;
    burstVh = burstP * RANGES.ranges.burst.spanVh;
    const vhP = 1 / RANGES.travelVh;
    const wStart = RANGES.ranges.work.start;
    workDive = 1 - smoothstep(wStart - TRANSITION_VH.work * 0.5 * vhP,
                              wStart + 63 * vhP, smoothProgress);
  };
  /* Two stops in burst because its gates open at different depths: 620 has
   * the deep fully arrived and the film plane on (film starts at 205 burstVh,
   * = 590 track), 750 adds the sunk water surface. The rest at mid-section. */
  for (const [vh, name] of [[175, 'drift'], [315, 'gather'],
                            [620, 'burst'], [750, 'burst'], [1380, 'work']]) {
    driveTo(vh);
    stageSection(name);
    renderer.render(scene, camera);
  }

  /* AND THE WIPE STATE ITSELF -- the one combination the loops above never
   * reproduce, and where the last programs were still linking.
   *
   * Measured after the per-section prewarm: 45 programs at load, 52 at the
   * first seam. Seven were still compiling mid-scroll. The loops stage ONE
   * section per render; a wipe frame stages TWO -- the outgoing into
   * transitionRT and the incoming live -- and materials whose program key
   * depends on that state (fog, lights, and the render target's own encoding)
   * link fresh the first time it happens.
   *
   * So this walks each seam exactly as the frame loop does: stage the
   * outgoing, render it into transitionRT, stage the incoming, render live.
   * Both real seams are covered, since land->drift and burst->work stage
   * different section pairs. */
  for (const [vh, outgoing, incoming] of [[105, 'land', 'drift'],
                                          [905, 'burst', 'work']]) {
    /* under the band's own drives, so the water/deep state inside each half
     * matches what a real wipe frame stages */
    driveTo(vh);
    stageSection(outgoing);
    renderer.setRenderTarget(transitionRT);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    stageSection(incoming);
    renderer.render(scene, camera);
  }

  /* THE COMPOSER PATH, PER SECTION, at the same drive stops. The plain
   * renderer.render loops above compile the scene materials, but the
   * composer brings its own program families keyed on what is in frame:
   * the depth attachment path the DOF reads, bloom's high-pass over real
   * content, the composite. One composed frame (the old shape of this
   * block) warmed those for exactly one staging. Behind the overlay, six
   * composed frames are cheap. */
  for (const [vh, name] of [[50, 'land'], [175, 'drift'], [315, 'gather'],
                            [620, 'burst'], [750, 'burst'], [1380, 'work']]) {
    driveTo(vh);
    stageSection(name);
    composer.writeBuffer = composer.renderTarget1;
    composer.readBuffer = composer.renderTarget2;
    composer.render();
  }
  /* The wipe's own program too, which otherwise links at the first seam. It only
   * binds through the composer, so this renders one composed frame -- harmless,
   * the overlay is still covering the canvas. */
  transitionPass.uniforms.uTransition.value = 1;
  transitionPass.uniforms.tMap1.value = transitionRT.texture;
  transitionPass.uniforms.tNormal.value = normalTex;
  transitionPass.enabled = true;
  /* same parity pin as the frame loop -- this prewarm render runs an extra
   * swapping pass, and without the reset it would hand the first real frame a
   * flipped buffer assignment */
  composer.writeBuffer = composer.renderTarget1;
  composer.readBuffer = composer.renderTarget2;
  composer.render();
  transitionPass.enabled = false;

  /* Put the drives back where the page actually is. The next frame() will
   * recompute everything from smoothProgress; what must not leak is the
   * filter state itself. */
  driveTo(preScrollP * RANGES.travelVh);
  stageSection(lastSection || SECTION_ORDER[0]);

  // two frames after compiling, so the first real frame is already on screen
  requestAnimationFrame(() => requestAnimationFrame(() => {
    loading.style.opacity = '0';
    setTimeout(() => loading.remove(), 900);
    /* Starts Home's entrance. Gated on the reveal rather than on load so the
     * 210-degree unwind and the tails rising from below actually play in view --
     * behind the overlay it would be over before anyone saw it. */
    revealAt = performance.now();
  }));
});

