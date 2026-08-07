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
];

/* --soft: report failures but exit 0.
 *
 * This runs as Vercel's build step (see vercel.json), and every one of these
 * files has a working fallback in the app -- a missing asset should make the
 * render thinner, not fail the deploy. Locally the default stays strict so a
 * broken path is noticed. */
const SOFT = process.argv.includes('--soft');

fs.mkdirSync(OUT, { recursive: true });

let ok = 0, failed = 0;
for (const rel of FILES) {
  const name = rel.split('/').pop();
  const dest = path.join(OUT, name);
  try {
    const res = await fetch(BASE + rel);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    console.log(`${name.padEnd(20)} ${(buf.length / 1024).toFixed(0)} KB`);
    ok++;
  } catch (e) {
    console.error(`FAILED ${rel}: ${e.message}`);
    failed++;
    if (!SOFT) process.exitCode = 1;
  }
}

console.log(`\n${ok} fetched, ${failed} failed${SOFT && failed ? ' (soft — deploy continues on fallbacks)' : ''}`);
