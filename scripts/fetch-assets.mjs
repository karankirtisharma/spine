/* Pulls the two textures the card shader binds, straight from activetheory.net.
 *
 * These are Active Theory's own assets and are deliberately NOT committed to
 * this repository — they are fetched into assets/at/ on your machine instead.
 * Paths come from uil.json:
 *   WorkItemShader/.../_txtEnv     -> assets/images/work/env1.jpg
 *   WorkItemShader/.../_txtNormal  -> assets/images/tree_room/waternormals.jpg
 *
 * If you would rather not depend on their server, textures.js still exports
 * makeEnvTexture() / makeNormalTexture(), which generate procedural stand-ins.
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://activetheory.net/';
const OUT = 'assets/at';
const FILES = [
  'assets/images/work/env1.jpg',
  'assets/images/tree_room/waternormals.jpg',
  /* The flower cloud. This is the real find: the coral/floret clusters around
   * their spine are not simulated at runtime, they are a baked Draco point
   * cloud carrying both positions and per-point colours, in four LODs that
   * line up exactly with Tests.flowerParticleCount():
   *   128 -> 16384   256 -> 65536   512 -> 262144   1024 -> 1048576
   * Container is their own wrapper, not raw Draco -- see flower-cloud.js.
   * 1024 is 7.3 MB, so only the two middle LODs are pulled by default. */
  'assets/geometry/particles/flower_spine-256.bin',
  'assets/geometry/particles/flower_spine-512.bin',
  /* The jellyfish material. uil.json binds both of these on every JellyShader
   * instance, and together they are the whole reason their jellyfish reads as a
   * three-dimensional glass creature:
   *   JellyShader/.../_tx_tMap, _tx_tMatcap -> room/matcap-test.jpg
   *   JellyShader/.../_tx_tNormal           -> pbr/alien_cracked_2_normal.png
   * The matcap is a photographed faceted crystal ball -- being indexed by surface
   * normal, it supplies form and prismatic dispersion that no hand-authored fresnel
   * tint reproduces. The normal map is a cracked organic membrane and is what keeps
   * the bell from looking like a smooth CG dome. */
  'assets/images/room/matcap-test.jpg',
  'assets/images/pbr/alien_cracked_2_normal.png',
  /* THE JELLYFISH MODEL. Everything before this was a procedural reconstruction of
   * their creature -- a lathe bell, a tapering column, five tube filaments, all
   * invented here and repeatedly wrong. This is the actual mesh.
   *
   * Finding it took the versioned uil: the app boots with
   *   window.UIL_STATIC_PATH = "assets/data/uil.1780406240914.json"
   * and THAT file lists every geometry the site uses, including
   *   assets/geometry/home/jellyfish.bin
   * The unversioned assets/data/uil.json, which is what earlier passes read, has the
   * shader parameters but none of the geometry paths -- which is why the model was
   * never found and kept getting rebuilt by hand instead.
   *
   * Container is their standard wrapper (see flower-cloud.js parseATContainer):
   * a 10-byte ASCII length prefix, an 81-byte JSON header, then a Draco payload.
   *   {"name":"jellyfish","type":0,"attributes":[["position",7],["normal",7],["uv",7]]}
   * 15,672 vertices / 5,224 triangles, non-indexed, 0.819 x 2.052 x 0.826 units,
   * centred on the origin. 24 KB compressed, so it is committed. */
  'assets/geometry/home/jellyfish.bin',
  /* The logo glass. The versioned uil binds this as tNormal on AboutLogoShader
   * (uNormalStrength 0.24); sampled in screen space it is what gives their coin its
   * wavy liquid distortion. The matcap half of that shader is matcap-test.jpg, which
   * the jellyfish already pulls above. */
  'assets/images/jungle_soil_normal.png',
  /* The bubble sprite both LogoParticleShader and TreeParticleShader bind as tMap;
   * the foliage walls sample it. */
  'assets/images/particle/matcap3.png',
  /* Their baked tree point cloud -- 256k points, attributes offset+random. The
   * second foliage silhouette in the density pass; see loadTreeCloud. */
  'assets/geometry/particles/tree-256.bin',
];

/* The environment set: their tree_room / room meshes, the light-volume plates and
 * the area-light table. Fetched into assets/at/env/ with the path flattened to
 * dir_name, which is how foliage.js references them. Meshes not yet wired (rooms,
 * rocks, water) are pulled anyway so the room work needs no second fetch pass. */
const ENV_FILES = [
  'assets/geometry/particles/tree-128.bin',
  'assets/geometry/tree_room/tree_leaves.bin', 'assets/geometry/tree_room/tree_trunk.bin',
  'assets/geometry/tree_room/rock_L.bin', 'assets/geometry/tree_room/rock_R.bin',
  'assets/geometry/tree_room/structure.bin', 'assets/geometry/tree_room/pillars.bin',
  'assets/geometry/tree_room/rocky_soil.bin', 'assets/geometry/tree_room/sand.bin',
  'assets/geometry/tree_room/water.bin', 'assets/geometry/tree_room/cables.bin',
  'assets/geometry/tree_room/walls.bin', 'assets/geometry/tree_room/mask.bin',
  'assets/geometry/room/floor.bin', 'assets/geometry/room/walls.bin',
  'assets/geometry/room/land.bin', 'assets/geometry/room/light.bin',
  'assets/geometry/room/prop.bin', 'assets/geometry/room/bush.bin',
  'assets/geometry/room/bush_instances.bin', 'assets/geometry/panels/2x3.bin',
  'assets/images/_lightvolume/light.jpg', 'assets/images/_lightvolume/light-mask.jpg',
  'assets/images/_lighting/arealights.json',
];

/* --soft: report failures but exit 0.
 *
 * This runs as Vercel's build step (see vercel.json), and every one of these
 * files has a working fallback in the app -- a missing asset should make the
 * render thinner, not fail the deploy. Locally the default stays strict so a
 * broken path is noticed. */
const SOFT = process.argv.includes('--soft');

/* Reject an SPA index page served in place of a missing asset.
 *
 * The source is a single-page app: a path it does not have returns 200 with
 * the site's index.html, not a 404. `res.ok` is therefore true and the HTML
 * was written straight into the asset as if it were binary -- which is how
 * assets/at/jungle_soil_normal.png came to be a 5,952-byte copy of Active
 * Theory's index page committed as a normal map. Nothing failed loudly: the
 * texture loader's decode error fired, its procedural fallback took over,
 * and the emblem quietly lost its authored surface detail for months.
 *
 * Checked by content, not by content-type, because the server labels the
 * fallback page by the requested extension. */
function assertNotHtml(buf, rel) {
  const head = buf.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
    throw new Error('served the SPA index page, not the asset (missing upstream?)');
  }
}

fs.mkdirSync(OUT, { recursive: true });

let ok = 0, failed = 0;
for (const rel of FILES) {
  const name = rel.split('/').pop();
  const dest = path.join(OUT, name);
  try {
    const res = await fetch(BASE + rel);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    assertNotHtml(buf, rel);
    fs.writeFileSync(dest, buf);
    console.log(`${name.padEnd(20)} ${(buf.length / 1024).toFixed(0)} KB`);
    ok++;
  } catch (e) {
    console.error(`FAILED ${rel}: ${e.message}`);
    failed++;
    if (!SOFT) process.exitCode = 1;
  }
}

fs.mkdirSync(path.join(OUT, 'env'), { recursive: true });
for (const rel of ENV_FILES) {
  const name = rel.split('/').slice(-2).join('_');
  const dest = path.join(OUT, 'env', name);
  try {
    const res = await fetch(BASE + rel);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    assertNotHtml(buf, rel);
    fs.writeFileSync(dest, buf);
    console.log(`env/${name.padEnd(34)} ${(buf.length / 1024).toFixed(0)} KB`);
    ok++;
  } catch (e) {
    console.error(`FAILED ${rel}: ${e.message}`);
    failed++;
    if (!SOFT) process.exitCode = 1;
  }
}

console.log(`\n${ok} fetched, ${failed} failed${SOFT && failed ? ' (soft — deploy continues on fallbacks)' : ''}`);
