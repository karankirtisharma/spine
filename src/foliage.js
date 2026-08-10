import * as THREE from 'three';
import { buildRawCloud } from './flower-cloud.js';

/* THE ENVIRONMENT — closing the density gap.
 *
 * Measured before this existed: land 24% of the frame lit, the hero volume 5-10%,
 * work 44%. Active Theory's frames are effectively 100% -- edge-to-edge scanned
 * foliage with a place's depth. The difference was never a particle simulation:
 * their mass is the SAME baked clouds this project already ships, instanced and
 * placed as WALLS, plus light pools among the leaves.
 *
 * So this module is placement, not effects:
 *
 *   walls      instances of the flower_spine bake (their scanned foliage with
 *              authored per-point colour) and of their tree cloud, arranged as
 *              curtains at the frame edges and a bowl around the work orbit
 *   pools      their _lightvolume/light.jpg as additive sprites -- the coloured
 *              glows among the foliage. Green family, not their red: colours are
 *              ours by the standing rule
 *
 * Instances share ONE geometry per source cloud (the walls draw the same 262k
 * points several times; one upload). Materials are per-instance for brightness
 * banding but compile to one program, since the shader source is identical.
 *
 * DEPTH BANDING is done with per-instance brightness rather than fog alone:
 * far instances are authored dimmer, which is atmospheric perspective the fog
 * then only has to finish, and it costs nothing per frame.
 */

const texLoader = new THREE.TextureLoader();

export function loadPoolTexture() {
  const t = texLoader.load('assets/at/env/_lightvolume_light.jpg');
  t.colorSpace = THREE.SRGBColorSpace;
  /* Additive sprites make black transparent by construction, which is exactly
   * what their light plate is -- a glow painted on black. No mask needed. */
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/**
 * @param shared   uniform bag (uTime, uDPR)
 * @param flower   decoded flower cloud {position, color, count} — REQUIRED
 * @param tree     decoded tree cloud or null — walls fall back to flower-only
 * @param matcap   the bubble matcap the cloud shader samples
 */
export function buildFoliage(shared, flower, tree, matcap) {
  const all = [];        // every instance, for the sparkle/scroll drives
  let flowerGeo = null, treeGeo = null;

  const inst = (source, opts) => {
    const first = source === 'tree' ? treeGeo : flowerGeo;
    const cloud = source === 'tree' ? tree : flower;
    const made = buildRawCloud(shared, cloud, matcap, { ...opts, geometry: first });
    if (source === 'tree' && !treeGeo) treeGeo = made.geometry;
    if (source === 'flower' && !flowerGeo) flowerGeo = made.geometry;
    made.group.position.set(...opts.at);
    if (opts.rotY) made.group.rotation.y = opts.rotY;
    all.push(made);
    return made;
  };

  /* ---- THE WORK BOWL, the frame the density complaint was filed against.
   *
   * Their Experiences shot carries its mass at the frame EDGES with the centre
   * left to the subject. The card orbit is ~3.8 units around the spine at the
   * origin of the work region (y ~ -7); these sit at radius 22-34, far enough
   * that the cards stay readable, close enough to fill the frame corners.
   * Brightness falls with distance -- the banding that reads as air. */
  const workGroup = new THREE.Group();
  /* Brightness roughly HALVED from the first pass, and that pass is worth a
   * line: at 0.26-0.42 the walls filled the frame exactly as intended (69.9%
   * lit, measured) but read as bright moss competing with the cards. Their
   * Experiences frame keeps the foliage DARK -- near-black olive mass with a
   * few lit pockets where the pools sit -- and the subject carries the light.
   * The walls also sit further out (z pushed ~6 units) because the work camera
   * ORBITS at radius 7.6, and a wall authored for the resting view swings
   * uncomfortably close at the orbit's far ends. */
  /* DENSE, by request. The halved pass (0.10-0.22) read as faint smudges at the
   * work entry and the user circled exactly that band asking for 'the exact
   * dense one' -- so the judgement call that dimmed it is reversed: brightness
   * back to the measured-69.9%%-lit levels, walls pulled back in, and two MID
   * masses added where the circled gap was. The cards still read because they
   * are additive-bright and float nearer the camera than any wall. */
  const WORK_SPECS = [
    // back wall, three overlapping masses
    { src: 'flower', at: [-14, -2, -26], scale: 0.55, bright: 0.34, rotY: 0.4 },
    { src: 'flower', at: [10, -6, -30], scale: 0.62, bright: 0.30, rotY: 2.2 },
    { src: 'flower', at: [-2, -14, -33], scale: 0.70, bright: 0.26, rotY: 4.1 },
    // mid band -- the circled gap: masses flanking the card lane
    { src: 'flower', at: [-18, -8, -19], scale: 0.48, bright: 0.30, rotY: 1.5 },
    { src: 'tree', at: [17, -4, -21], scale: 0.95, bright: 0.28, rotY: 5.0 },
    // side curtains
    { src: 'tree', at: [-27, -16, -13], scale: 1.15, bright: 0.40, rotY: 0.9 },
    { src: 'tree', at: [25, -12, -17], scale: 1.05, bright: 0.36, rotY: 3.6 },
    // canopy overhead — the dark mass their frames keep above the subject
    { src: 'flower', at: [4, 16, -20], scale: 0.60, bright: 0.20, rotY: 5.3 },
  ];
  for (const s of WORK_SPECS) {
    if (s.src === 'tree' && !tree) s.src = 'flower';
    workGroup.add(inst(s.src, { at: s.at, scale: s.scale, brightness: s.bright,
                                sizeBias: 2.2, rotY: s.rotY }).group);
  }

  /* ---- LAND CURTAINS. The landing already reads at 24% and its lower-left
   * belongs to the headline, so these stay high and right/left-far: a top-right
   * mass and a far-left column, both behind the existing composition (z < -8). */
  const landGroup = new THREE.Group();
  const LAND_SPECS = [
    { src: 'tree', at: [11, 6, -12], scale: 0.85, bright: 0.24, rotY: 1.2 },
    { src: 'flower', at: [-13, 3, -14], scale: 0.42, bright: 0.20, rotY: 2.8 },
  ];
  for (const s of LAND_SPECS) {
    if (s.src === 'tree' && !tree) s.src = 'flower';
    landGroup.add(inst(s.src, { at: s.at, scale: s.scale, brightness: s.bright,
                                sizeBias: 1.4, rotY: s.rotY }).group);
  }

  /* ---- HERO CURTAINS. The volume's centre is composed as a void (frames 2-4)
   * and stays one; the density belongs at the borders. The holder is repositioned
   * every stage to track the descending camera, same pattern as the jellyfish. */
  const heroGroup = new THREE.Group();
  const HERO_SPECS = [
    { src: 'tree', at: [-13, 2, -9], scale: 0.9, bright: 0.20, rotY: 0.6 },
    { src: 'flower', at: [13, -3, -11], scale: 0.5, bright: 0.18, rotY: 3.9 },
    { src: 'flower', at: [-11, -9, -13], scale: 0.45, bright: 0.15, rotY: 1.9 },
  ];
  for (const s of HERO_SPECS) {
    if (s.src === 'tree' && !tree) s.src = 'flower';
    heroGroup.add(inst(s.src, { at: s.at, scale: s.scale, brightness: s.bright,
                                sizeBias: 1.6, rotY: s.rotY }).group);
  }

  /* ---- LIGHT POOLS. Their _lightvolume/light.jpg -- the painted glow plate their
   * light volumes sample -- as additive sprites among the foliage. This is gap #2
   * (nothing lights anything): a pool BEHIND a foliage mass silhouettes its front
   * clumps and rims its edges, which is most of what "sitting in a place" is.
   * Hue stays in the green family; theirs are red/orange, colours are ours. */
  const poolTex = loadPoolTexture();
  const mkPool = (x, y, z, scale, color, opacity) => {
    const m = new THREE.SpriteMaterial({
      map: poolTex, color: new THREE.Color(color),
      transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const s = new THREE.Sprite(m);
    s.position.set(x, y, z);
    s.scale.set(scale, scale * 1.4, 1);   // their plate is a vertical shaft
    return s;
  };
  // work: two pools low in the walls, one high — the deep glows in their frame
  workGroup.add(mkPool(-16, -10, -24, 16, '#3fae6c', 0.34));
  workGroup.add(mkPool(14, -14, -26, 13, '#7dd63a', 0.26));
  workGroup.add(mkPool(2, 10, -30, 18, '#2c6e4f', 0.22));
  // land: one behind the right curtain
  landGroup.add(mkPool(10, 4, -13, 10, '#3fae6c', 0.20));
  // hero: one, low and faint, under the descent
  heroGroup.add(mkPool(-10, -4, -12, 12, '#356e46', 0.18));

  return {
    workGroup, landGroup, heroGroup,

    /** Per-frame drives shared with the other cloud instances: their WorkPage
      * accumulates uSparkle and eases uRotate; the walls twinkle on the same
      * clock so they read as the same material as the column dressing. */
    update(dt) {
      for (const i of all) {
        i.uniforms.uSparkle.value += 0.005;
        i.uniforms.uRotate.value += dt * 0.006;
      }
    },

    stats: {
      instances: all.length,
      flowerInstances: all.filter(i => i.geometry === flowerGeo).length,
      treeInstances: all.filter(i => i.geometry === treeGeo).length,
      pointsPerFlower: flower.count,
      pointsPerTree: tree ? tree.count : 0,
    },
  };
}
