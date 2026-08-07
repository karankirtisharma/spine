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
import { loadFlowerCloud, buildFlowerCloud, retintToPalette } from './flower-cloud.js';
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
  } catch (e) {
    console.info(`flower cloud unavailable (${e.message}) — procedural fallback, run npm run fetch:assets`);
  }
})());
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
    renderer,
    /* 5.0, not the 4.0 the isolation view used. Their Home numbers imply a mark
     * of roughly this size: the tails hang 20 units below it, the camera sits
     * 30-45 units out at fov 30, and the mark reads as about a third of frame
     * height in their reference. */
    targetHeight: 5.0,
    rimLights: false,
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
      spineGroup = group;    // the god-ray source for the work section
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
const jelly = buildJelly(shared, { refraction: refractionRT.texture, matcap: jellyMatcap,
                                  normalMap: jellyNormal });
const jellyHolder = new THREE.Group();
jellyHolder.add(jelly.group);
scene.add(jellyHolder);
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
const TRANSITION_VH = 30;
const transitionRT = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
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
    /* Phase 4's core flash: strength, and where on screen the mark is. */
    uFlash: { value: 0 },
    uFlashPos: { value: new THREE.Vector2(0.5, 0.5) },
    /* The inclined horizon in reference image 1. .x is how present it is (0 = off),
     * .y where it crosses the left edge as a fraction of frame height. */
    uHorizon: { value: new THREE.Vector2(0, 0.52) },
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
    uniform float uFlash;
    uniform vec2 uFlashPos;
    uniform vec2 uHorizon;
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

      // film grain — the original overlays at 0.15
      color = blendOverlay(color, vec3(getNoise(vUv, fract(uTime) + 0.5)), 0.15);

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};
const compositePass = new ShaderPass(CompositeShader);
composer.addPass(compositePass);
composer.addPass(new OutputPass());

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
window.__passes = { transition: transitionPass, bloom, composite: compositePass };
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
 * camera.position.y. So the orientation is a constant: atan(2.59 / 40) up. */
const HOME_PITCH = Math.atan2(4.59 - 2, 40);

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
const ABOUT_LOGO_SCALE_XY = 1.2;
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
let hpF = 0, landPF = 0, homeVisibleF = 0;
const VOLUME = ['drift', 'gather', 'burst'];

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
  workRoot.visible = name === 'work';
  /* homeRoot is the crossing tails (the plume moved to atmosRoot long ago), and
   * reference image 1 shows the tails prominently under the ring -- so they belong
   * to land as much as to the volume. */
  homeRoot.visible = inVolume || name === 'land';
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
    heroCloud.uniforms.uBrightness.value =
      name === 'work' ? 0.3 : (name === 'land' ? 0.45 : 0.5);
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
  home.plumeUniforms.uAlpha.value = name === 'land'
    ? PLUME_ALPHA_ABOUT
    : PLUME_ALPHA_HOME * HERO.density / 0.16;
  /* Inward pull and outward throw. uAttract moves the field toward uLogoPos across
   * gather; uShock is the expanding shell radius that throws it back out across
   * burst. Both are additions to their shader -- see home.js. */
  home.plumeUniforms.uAttract.value = inVolume ? HERO.attract : 0;
  home.plumeUniforms.uShock.value = inVolume ? HERO.shock * 26 : 0;
  if (emblem) emblem.group.visible = name !== 'work';

  if (name === 'work') {
    /* Unchanged from the single-section build, and deliberately so: this is the
     * rail test/compare.mjs pins against test/baseline.json. */
    camGroup.position.copy(workCamPos);
    camGroup.quaternion.copy(workCamQuat);
    camera.position.set(0, 0, 1.25);
    camera.rotation.set(0, 0, 0);
    setFov(35);

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
    camGroup.position.set(0, lerp(40, -7, hpF), lerp(-30, 5, homeVisibleF) - 15 * (1 - hpF));
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
    camGroup.position.set(0, 0, 0);
    camGroup.quaternion.identity();
    camera.position.set(0, 0, ABOUT_CAM_Z);
    camera.rotation.set(0, 0, 0);
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
      emblem.group.scale.setScalar(1);
      emblem.mesh.rotation.set(0, logoRotY + LOGO_ASSET_FIX, 0);
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
        2 * dragRotation - radians(24) * landPF + LOGO_ASSET_FIX + radians(90), 0);
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
  emblemRig.position.copy(emblemPos);

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
  /* The jellyfish belong to the hero VOLUME (section 2 onward), not to the landing.
   * The swarm was added to land on a read of reference image 1, but on our frame four
   * of them crowd the mark and the headline and the composition is stronger without
   * any -- and reference image 2, which is the volume, is where the single specimen
   * actually appears. So: none in land, one in the volume. */
  jellyHolder.visible = inVolume;
  cometHolder.visible = inVolume;
  nebula.group.visible = name !== 'work';
  if (name === 'land') {
    // no jelly placement here -- land shows none, see the visibility note above
    /* Centred and CLOSE (z -6): at -12 the clusters shrank into the far field and
     * the busy grain buried them. This near, they span the frame at full size the
     * way image 1's colour masses do. */
    nebula.group.position.set(0, 1.5, -6);
  } else if (inVolume) {
    const camY = camGroup.position.y;
    jellyHolder.position.set(-7.5, camY + 2.5, -5);
    cometHolder.position.set(7.0, camY + 9.5, -8);
    nebula.group.position.set(0, camY + 4.5, -4);
  }
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
  mist.uniforms.uNebula.value = name === 'land' ? 0.6 : (inVolume ? 0.7 : 0.45);
  jelly.uniforms.uScroll.value = inVolume ? hpF : 0;
}

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
  const TR = transitionState(smoothProgress, RANGES, SECTION_ORDER, TRANSITION_VH,
                             ['drift', 'work']);
  /* The section that will end up owning the frame. DOM layers follow this rather
   * than `section` so the copy is already in place as the seam arrives, instead of
   * popping in behind it. */
  const front = TR.active ? TR.incoming : section;
  window.__frameState.front = front;
  window.__frameState.tr = TR.active ? { t: +TR.t.toFixed(3), from: TR.outgoing, to: TR.incoming } : null;

  about.setActive(front === 'land');
  /* The chat panel was Active Theory's Home element. None of the four reference
   * frames shows it, and the brief is strict to the frames -- so it stays hidden.
   * The DOM is kept because it is a faithful recreation of theirs; removing it
   * would lose that work for no layout gain. */
  chatDOM.classList.add('off');
  setNavSub(front);

  landPF = S.land.progress;
  /* Combined progress across the volume: 0 at drift's start, 1 at burst's end.
   * Derived from the range table rather than averaging the three locals, so it is
   * exactly affine in the global scalar -- same argument as the Work remap. */
  const volA = RANGES.ranges.drift.start, volB = RANGES.ranges.burst.end;
  hpF = Math.min(1, Math.max(0, (smoothProgress - volA) / (volB - volA)));
  /* The scroll-driven hero drives: image 2 = drift's resting look, image 3 =
   * gather's, image 4 = burst's. See heroDrives in src/intro.js. */
  HERO = heroDrives(S.drift.progress, S.gather.progress, S.burst.progress);
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
  const rimOn = front === 'work' ? 0 : (front === 'land' ? 0.45 : 1);
  emblemRimA.intensity = lerp(emblemRimA.intensity, EMBLEM_RIM * rimOn, 0.15);
  emblemRimB.intensity = lerp(emblemRimB.intensity, EMBLEM_RIM * 0.55 * rimOn, 0.15);

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
  /* 1.0 in Work, so section 3 is bit-identical to what it shipped as. Sections 1 and
   * 2 come down. `__over.sat` overrides it live for dialling in. */
  u.uSaturation.value = front === 'work' ? 1 : (window.__over.sat ?? HERO_SATURATION);
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
  const inVolumeFront = VOLUME.includes(front);
  /* Land runs bloom at half strength. In the reference the glow belongs to the
   * MARK; the particle field around it stays crisp. Full-strength bloom over a
   * dense field smears every grain a few pixels wide, and that smear -- more than
   * any sprite property -- is what read as "blurry, unprofessional". */
  bloom.strength = inVolumeFront ? BLOOM_STRENGTH * HERO.bloom
    : (front === 'land' ? BLOOM_STRENGTH * 0.5 : BLOOM_STRENGTH);
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
  wetSpec.intensity = front === 'work' ? 28 : 0;
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

  /* Set-piece animation, after stageSection so the nebula billboards to the final
   * camera. During a wipe the outgoing staging re-renders with billboards facing the
   * incoming camera -- one frame of misalignment on face-on glow quads, invisible. */
  jelly.update(dt);
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
  u.uVolumetricStrength.value = wantRays ? rayGain * HERO.fog
    : (front === 'land' ? rayGain * 0.25
    : (front === 'work' && spineGroup ? rayGain * 0.55 : 0));
  const raySource = front === 'work' ? spineGroup : (emblem && emblem.mesh);
  if (raySource && u.uVolumetricStrength.value > 0.004) {
    /* The hide list is everything that is NOT the light source. One source only:
     * the mark in the hero sections, the spine column in work. Leaving any point
     * cloud in the occlusion buffer makes every grain its own light source, which
     * is a white-out rather than shafts -- that is what turned an earlier hero
     * frame into a green starburst. In work that means hiding the cards, the
     * flower cloud and the ambient particles so the column alone emits. */
    /* ambienceRoot (cloud + mist) is on both hide lists: additive mist in the
     * occlusion buffer becomes a diffuse light source and washes the shafts out. */
    volumetric.render(scene, camera, raySource,
      front === 'work'
        ? [cardGroup, particles, flowers && flowers.group, ambienceRoot]
        : [...home.columns, home.plume, ambienceRoot,
           jelly.group, comet.group, nebula.group]);
    u.tVolumetricBlur.value = volumetric.texture;
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
    renderer.setRenderTarget(transitionRT);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    stageSection(front);
  }

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
  refractionRT.setSize(Math.round(w * 0.5), Math.round(h * 0.5));
  /* Full resolution, unlike the refraction target: this one is half the frame
   * during a wipe, so a downscale would show as a soft half against a sharp one. */
  transitionRT.setSize(w, h);
  transitionPass.uniforms.resolution.value.set(w, h);
  volumetric.setSize(w, h);
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
  /* The wipe's own program too, which otherwise links at the first seam. It only
   * binds through the composer, so this renders one composed frame -- harmless,
   * the overlay is still covering the canvas. */
  transitionPass.uniforms.uTransition.value = 1;
  transitionPass.uniforms.tMap1.value = transitionRT.texture;
  transitionPass.uniforms.tNormal.value = normalTex;
  transitionPass.enabled = true;
  composer.render();
  transitionPass.enabled = false;

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

