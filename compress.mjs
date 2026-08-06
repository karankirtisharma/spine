/* GLB compression pipeline for assets/spine.glb
 *
 * Source: Tripo export — 1,866,762 tris / 996,089 verts, f32 attributes,
 * 4096x4096 basecolor JPEG + 4096x4096 normal PNG. 69.78 MB on disk,
 * ~232 MB VRAM once uploaded.
 *
 * The spine renders ~200px wide on a 1440px viewport and is repeated 9-12
 * times up the column, so neither the triangle count nor 4K maps are doing
 * any visible work. Pipeline: weld -> simplify -> resize -> webp -> quantize
 * -> meshopt.
 *
 * Usage: node compress.mjs [high|max]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PRESET = process.argv[2] || 'high';
const PRESETS = {
  // ratio is the fraction of triangles kept; error is max deviation as a
  // fraction of mesh extent (0.001 = 0.1%)
  high: { ratio: 0.16, error: 0.0012, tex: 2048, quality: 88, out: 'spine.opt.glb' },
  max:  { ratio: 0.07, error: 0.0035, tex: 1024, quality: 82, out: 'spine.min.glb' },
  /* `high` was tuned when the eye sat ~5.8 units back and the note in
   * spine-glb.js says the column read "roughly an eighth of frame width". The
   * camera has since moved in to ~5.05 and the framing is far tighter, so 16% of
   * triangles and 2048 maps no longer carry it -- the silhouette goes soft and
   * the basecolor visibly mushy. This keeps 45% of the triangles and 4K maps.
   * It is a bigger download, which is the correct trade for the hero object. */
  sharp: { ratio: 0.45, error: 0.0005, tex: 4096, quality: 92, out: 'spine.sharp.glb' },
};
const P = PRESETS[PRESET];
if (!P) throw new Error(`unknown preset "${PRESET}" (${Object.keys(PRESETS).join('|')})`);

const SRC = P.src ?? 'assets/spine.glb';
const OUT = path.join('assets', P.out);
const TMP = 'assets/.tmp';
fs.mkdirSync(TMP, { recursive: true });

// Node 24 refuses to spawnSync a .cmd shim, so call the CLI's JS entry directly
const CLI = path.resolve('node_modules/@gltf-transform/cli/bin/cli.js');
const run = (...args) => {
  console.log('  •', args.join(' '));
  execFileSync(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
};
const mb = f => (fs.statSync(f).size / 1048576).toFixed(2);

const t0 = Date.now();
console.log(`\npreset: ${PRESET}  (keep ${(P.ratio * 100).toFixed(0)}% tris, ${P.tex}px maps)\n`);
console.log('source:', mb(SRC), 'MB\n');

const a = `${TMP}/a.glb`, b = `${TMP}/b.glb`, c = `${TMP}/c.glb`, d = `${TMP}/d.glb`, e = `${TMP}/e.glb`;

// 1. merge duplicate accessors/materials
run('dedup', SRC, a);
// 2. weld vertices — simplification needs a connected mesh, and the Tripo
//    export ships split verts that block edge collapses
run('weld', a, b);
// 3. decimate
run('simplify', b, c, '--ratio', String(P.ratio), '--error', String(P.error));
// 4. downscale both maps
run('resize', c, d, '--width', String(P.tex), '--height', String(P.tex));
// 5. WebP — roughly 3-4x smaller than the source JPEG/PNG at matched quality
run('webp', d, e, '--quality', String(P.quality));
// 6. quantize attributes (f32 -> i16/i8) then meshopt-compress the buffers.
//    `meshopt` applies quantization itself, so this is a single step.
run('meshopt', e, OUT, '--level', 'high');

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\noutput: ${OUT}  ${mb(OUT)} MB`);
console.log(`saved:  ${(100 - (fs.statSync(OUT).size / fs.statSync(SRC).size) * 100).toFixed(1)}%`);
console.log(`took:   ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
