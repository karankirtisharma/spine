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
