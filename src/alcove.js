import * as THREE from 'three';
import { parseATContainer, buildRawCloud } from './flower-cloud.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { buildCanopy } from './canopy.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

/* THE ALCOVE — Active Theory's vegetated room, wrapped around the coin in burst.
 *
 * The reference (vegg.mp4 + the algae screenshot) is their TreeScene reveal: the
 * hero void grows a ROOM around the mark as you scroll -- angled ceiling structure
 * with glowing cable runs, every wall carpeted in algae-like growth, a bright
 * window of moving footage behind the coin, haze between the layers.
 *
 * Every mesh here is theirs, decoded from the committed env set:
 *
 *   tree_room/structure.bin   the room shell -- ceiling beams, side masses
 *   tree_room/pillars.bin     verticals
 *   tree_room/cables.bin      the ceiling runs that glow green in their frame
 *   room/bush.bin             ONE clump of vegetation, ~2k tris
 *   room/bush_instances.bin   THE SCATTER, and the reason this looks grown rather
 *                             than placed: a baked table of offset / scale /
 *                             orientation / random per instance -- their artists'
 *                             authored distribution of the bush over the room.
 *                             Type-1 container, generic Draco attributes by
 *                             unique id, same decode route as the tree cloud.
 *
 * MATERIALS are ours (green family, the standing rule): the shell renders as a
 * near-black silhouette that exists to OCCLUDE and catch fog, the cables render
 * additive as light runs, and the bushes take a per-instance green graded by the
 * baked random -- their TreeFBR's textured lighting chain does not port (it wants
 * the FBR chunks and room lightmaps), and a dark mass with lit pockets is what
 * their own frame reduces to at these values.
 *
 * The window is the shared showreel video the cards already decode -- one <video>
 * element site-wide -- on a dim plane behind the mark, with the light-volume plate
 * in front of it. That is exactly what their bright backdrop is: a screen seen
 * through vegetation.
 */

let _draco = null;
function draco() {
  if (_draco) return _draco;
  _draco = new DRACOLoader();
  _draco.setDecoderPath('./vendor/three/examples/jsm/libs/draco/');
  _draco.setDecoderConfig({ type: 'js' });
  return _draco;
}

async function decodeMesh(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const { dracoBuffer } = parseATContainer(await res.arrayBuffer());
  return new Promise((resolve, reject) => {
    draco().decodeDracoFile(dracoBuffer, resolve, null, null,
      THREE.LinearSRGBColorSpace, reject);
  });
}

/* The instance table: generic attribute names by Draco unique id, in header order
 * (offset 0, scale 1, orientation 2, random 3) -- the same route loadTreeCloud
 * takes for the tree's offset/random pair. */
async function decodeInstances(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const { dracoBuffer } = parseATContainer(await res.arrayBuffer());
  const geo = await new Promise((resolve, reject) => {
    draco().decodeDracoFile(
      dracoBuffer, resolve,
      { offset: 0, scale: 1, orientation: 2, random: 3 },
      /* Type NAMES, not constructors. DRACOLoader posts this map into its worker,
       * and a typed-array constructor cannot be structured-cloned -- the loader
       * dies with DataCloneError before decoding a byte. The worker resolves the
       * string on its own global: `self[attributeTypes[name]]` (DRACOLoader.js
       * line ~585). This exact mistake also silently killed the tree cloud. */
      { offset: 'Float32Array', scale: 'Float32Array', orientation: 'Float32Array', random: 'Float32Array' },
      THREE.LinearSRGBColorSpace, reject);
  });
  const out = {
    offset: geo.getAttribute('offset'),
    scale: geo.getAttribute('scale'),
    orientation: geo.getAttribute('orientation'),
    random: geo.getAttribute('random'),
  };
  if (!out.offset) throw new Error(`${url}: no offset attribute in instance table`);
  return out;
}

/**
 * @param shared   uniform bag (uTime)
 * @param opts.video     shared showreel VideoTexture for the window (may be null)
 * @param opts.poolTex   the light-volume plate texture (reused from foliage)
 */
export function buildAlcove(shared, opts = {}) {
  const group = new THREE.Group();
  group.visible = false;

  /* Everything that fades with the burst reveal registers its material here with
   * its authored full-strength opacity; setReveal scales them together. The growth
   * cloud is opaque by design (the flower shader's occlusion rule), so it fades by
   * BRIGHTNESS instead -- growthUniforms is set once the decode lands. */
  const fading = [];
  let growthUniforms = null;
  let canopyUniforms = null;
  const GROWTH_BRIGHT = 0.65;
  const fade = (mat, full) => { fading.push({ mat, full }); mat.transparent = true; mat.opacity = 0; return mat; };

  const ready = (async () => {
    const [structure, pillars, panels, bush, table, soil, rwalls] = await Promise.all([
      decodeMesh('assets/at/env/tree_room_structure.bin'),
      decodeMesh('assets/at/env/tree_room_pillars.bin'),
      decodeMesh('assets/at/env/panels_2x3.bin'),
      decodeMesh('assets/at/env/room_bush.bin'),
      decodeInstances('assets/at/env/room_bush_instances.bin'),
      decodeMesh('assets/at/env/tree_room_rocky_soil.bin'),
      decodeMesh('assets/at/env/tree_room_walls.bin'),
    ]);

    /* Fit: their room in its own units, normalised so the shell spans a known
     * width. Everything shares one normalisation so the bush table's offsets stay
     * aligned with the structure they were authored against. */
    structure.computeBoundingBox();
    const bb = structure.boundingBox;
    const size = new THREE.Vector3().subVectors(bb.max, bb.min);
    const centre = new THREE.Vector3().addVectors(bb.min, bb.max).multiplyScalar(0.5);
    /* 64: at 46 the room sat as a band across the lower half -- the burst camera is
     * ~35 units out, so the frame spans ~37 units at the mark and the shell has to
     * overshoot it comfortably for its edges to leave the frame. */
    const S = (opts.width ?? 64) / Math.max(1e-6, size.x);

    const norm = new THREE.Group();
    norm.scale.setScalar(S);
    norm.position.set(-centre.x * S, -centre.y * S, -centre.z * S);
    group.add(norm);

    /* ---- the shell: near-black occluder that catches fog. DoubleSide because the
     * camera sits INSIDE the room. */
    const shellMat = fade(new THREE.MeshBasicMaterial({
      color: new THREE.Color('#0a120c'), side: THREE.DoubleSide, fog: true,
    }), 1.0);
    for (const g of [structure, pillars]) {
      const m = new THREE.Mesh(g, shellMat);
      m.frustumCulled = false;
      norm.add(m);
    }

    /* ---- the cable runs, additive: the green light lines along their ceiling. */
    /* ---- THE SCREENS: their panels/2x3 grid carrying the shared showreel. This
     * is the reference's back wall -- a bank of glowing video panels seen through
     * the growth. (The cables mesh is GONE outright: it decodes as fat diagonal
     * beams, and at any additive opacity it filled the frame with the pale glass
     * panels the first screenshots showed. Their frame shows no beams at all --
     * the structure reads only as darkness behind the moss.) */
    panels.computeBoundingBox();
    const pbb = panels.boundingBox;
    const psz = new THREE.Vector3().subVectors(pbb.max, pbb.min);
    const pc = new THREE.Vector3().addVectors(pbb.min, pbb.max).multiplyScalar(0.5);
    const pfit = 22 / Math.max(1e-6, psz.x);
    const scrMat = fade(new THREE.MeshBasicMaterial({
      map: opts.video ?? null,
      /* cool cast, their screens run blue against the warm moss */
      color: new THREE.Color(opts.video ? '#bcd6ea' : '#274b66'),
      fog: false, depthWrite: false, side: THREE.DoubleSide,
    }), 0.85);
    const screens = new THREE.Mesh(panels, scrMat);
    screens.scale.setScalar(pfit);
    screens.position.set(-pc.x * pfit, 1.5 - pc.y * pfit, -14 - pc.z * pfit);
    screens.frustumCulled = false;
    group.add(screens);

    /* ---- THE GROWTH. Their bush mesh through their instance table, rendered as
     * POINT GRAIN rather than as solid meshes.
     *
     * The first pass drew the 30 instances as InstancedMesh + MeshBasicMaterial,
     * and unlit flat colour on a leaf-cluster mesh reads as exactly what it is: a
     * band of giant flat cutouts. Their growth reads GRANULAR -- moss made of
     * grain, the same visual material as every cloud on this site. So: sample each
     * bush surface area-weighted (MeshSurfaceSampler), push the samples through
     * THEIR instance transform, and hand the merged cloud to the flower shader.
     * Their authored distribution survives verbatim; only the rendering of each
     * clump changes, into the language the reference frame actually shows. */
    const count = table.offset.count;
    const PER_BUSH = 3200;
    const total = count * PER_BUSH;
    const gpos = new Float32Array(total * 3);
    const gcol = new Float32Array(total * 3);
    const sampler = new MeshSurfaceSampler(new THREE.Mesh(bush)).build();
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(),
          p = new THREE.Vector3(), sc = new THREE.Vector3(), sp = new THREE.Vector3();
    const col = new THREE.Color(), jit = new THREE.Color();
    /* Graded greens off the baked random -- deep shadow moss to lit algae. The
     * palette is ours; the DISTRIBUTION of light-to-dark across the room is theirs,
     * because it rides their random channel. */
    const RAMP = [new THREE.Color('#0d1a11'), new THREE.Color('#1e3a24'),
                  new THREE.Color('#3a6132'), new THREE.Color('#7fae4e')];
    let w = 0;
    for (let i = 0; i < count; i++) {
      p.fromBufferAttribute(table.offset, i);
      if (table.orientation && table.orientation.itemSize === 4) {
        q.fromBufferAttribute(table.orientation, i);
      } else q.identity();
      if (table.scale) {
        sc.fromBufferAttribute(table.scale, i);
        if (table.scale.itemSize === 1) sc.setScalar(table.scale.getX(i));
      } else sc.setScalar(1);
      m4.compose(p, q, sc);
      const r = table.random ? table.random.getX(i) : Math.random();
      const fr = r * (RAMP.length - 1);
      const i0 = Math.min(RAMP.length - 1, Math.floor(fr));
      const i1 = Math.min(RAMP.length - 1, i0 + 1);
      col.copy(RAMP[i0]).lerp(RAMP[i1], fr - i0);
      for (let s = 0; s < PER_BUSH; s++) {
        sampler.sample(sp);
        sp.applyMatrix4(m4);
        gpos[w * 3] = sp.x; gpos[w * 3 + 1] = sp.y; gpos[w * 3 + 2] = sp.z;
        /* per-point value jitter so a clump has interior life, like the bakes */
        const v = 0.7 + Math.random() * 0.6;
        jit.copy(col).multiplyScalar(v);
        gcol[w * 3] = jit.r; gcol[w * 3 + 1] = jit.g; gcol[w * 3 + 2] = jit.b;
        w++;
      }
    }
    const growth = buildRawCloud(shared, { position: gpos, color: gcol, count: total },
                                 opts.matcap ?? null, { sizeBias: 1.6, brightness: 0 });
    growthUniforms = growth.uniforms;
    growth.points.frustumCulled = false;
    norm.add(growth.group);

    /* ---- THE CANOPY: the GPU-instanced foliage field (see canopy.js). 900
     * copies of their bush scattered area-weighted over their rocky_soil and
     * walls surfaces, one draw call, dissolving to flecks at the field's rim
     * where the grain clouds take over. Lives under `norm` so its room-space
     * scatter shares the structure's normalisation, like everything else. */
    const canopy = buildCanopy(bush, [soil, rwalls], {
      count: 900,
      timeUniform: shared.uTime,
      fieldCenter: centre.clone(),
      fieldRadius: Math.max(size.x, size.z) * 0.62,
      /* density falloff in WORLD units; the burst eye sits ~35 out */
      densNear: 30, densFar: 85,
      fogDensity: 0.022, fogColor: '#04100a',
    });
    canopyUniforms = canopy.uniforms;
    norm.add(canopy.mesh);

    /* NO pool sprite at the mark. Three rounds of dimming it still compounded
     * with the emblem's own glow and bloom into the white ball every screenshot
     * kept showing. The reference's centre light is the MARK ITSELF over the
     * screens; nothing else is needed and everything else was noise. */

    return {
      instances: count,
      shellTris: (structure.index ? structure.index.count : structure.attributes.position.count) / 3,
      bushTris: (bush.index ? bush.index.count : bush.attributes.position.count) / 3,
      roomSize: [+size.x.toFixed(1), +size.y.toFixed(1), +size.z.toFixed(1)],
      fit: +S.toFixed(3),
    };
  })().catch(err => {
    console.warn('[alcove] room decode failed; burst keeps the void.\n       ', err);
    return null;
  });

  return {
    group,
    ready,
    /** 0..1 with burst's local progress: the room grows in around the mark, the
      * same reveal the reference video shows across its scroll. Assigned per
      * staging, never eased -- the wipe rule. */
    setReveal(p) {
      const k = p * p * (3 - 2 * p);
      for (const f of fading) f.mat.opacity = f.full * k;
      if (growthUniforms) growthUniforms.uBrightness.value = GROWTH_BRIGHT * k;
      if (canopyUniforms) canopyUniforms.uReveal.value = k;
    },
  };
}
