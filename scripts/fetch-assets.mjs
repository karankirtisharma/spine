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
];

fs.mkdirSync(OUT, { recursive: true });

for (const rel of FILES) {
  const name = rel.split('/').pop();
  const dest = path.join(OUT, name);
  try {
    const res = await fetch(BASE + rel);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    console.log(`${name.padEnd(20)} ${(buf.length / 1024).toFixed(0)} KB`);
  } catch (e) {
    console.error(`FAILED ${rel}: ${e.message}`);
    process.exitCode = 1;
  }
}
