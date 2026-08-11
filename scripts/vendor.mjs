/* Copies the ESM files this project imports out of node_modules into vendor/.
 *
 * index.html uses a bare importmap and there is no bundler, so whatever the
 * importmap points at has to exist in the deployed tree. node_modules is not
 * committed, so pointing at it works locally and 404s everywhere else.
 *
 * Rather than committing all of node_modules (or all ~8 MB of three/examples),
 * this walks the relative-import graph from the handful of entry points and
 * copies only what is reachable. Bare 'three' imports inside the addons are
 * left alone — the importmap resolves those.
 *
 * Run after changing dependencies:  npm run vendor
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'vendor';

// entry points, as <source path> -> <path under vendor/>
const ENTRIES = [
  ['node_modules/three/build/three.module.js', 'three/build/three.module.js'],
  ['node_modules/lenis/dist/lenis.mjs', 'lenis/lenis.mjs'],
  ...[
    'postprocessing/EffectComposer.js',
    'postprocessing/RenderPass.js',
    'postprocessing/UnrealBloomPass.js',
    'postprocessing/ShaderPass.js',
    'postprocessing/OutputPass.js',
    'postprocessing/Pass.js',
    'loaders/GLTFLoader.js',
    'math/MeshSurfaceSampler.js',
    'loaders/DRACOLoader.js',
    'libs/meshopt_decoder.module.js',
  ].map(p => [`node_modules/three/examples/jsm/${p}`, `three/examples/jsm/${p}`]),
];

/* The Draco decoder is fetched at runtime by DRACOLoader.setDecoderPath, not
 * imported, so the import walk below can never reach it. Copied verbatim.
 * Needed for Active Theory's flower point cloud (see flower-cloud.js). */
const RAW_COPIES = [
  ['node_modules/three/examples/jsm/libs/draco/draco_decoder.js',
   'three/examples/jsm/libs/draco/draco_decoder.js'],
  ['node_modules/three/examples/jsm/libs/draco/draco_decoder.wasm',
   'three/examples/jsm/libs/draco/draco_decoder.wasm'],
  ['node_modules/three/examples/jsm/libs/draco/draco_wasm_wrapper.js',
   'three/examples/jsm/libs/draco/draco_wasm_wrapper.js'],
];

// matches `from './x.js'` / `import './x.js'` / `import(...)`
const IMPORT_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g;

const seen = new Set();
let copied = 0, bytes = 0;

/* ---------------------------------------------------------------- *
 *  Vendor contracts.
 *
 *  Nothing here PATCHES a vendored file -- deliberately. A local patch has to
 *  be reapplied on every re-vendor, and the one that gets forgotten is the one
 *  that matters. Instead we depend only on upstream API, and assert here that
 *  the API we depend on still exists. If a future three.js drops it, the
 *  vendor step fails loudly at copy time rather than silently handing us back
 *  the old behaviour at runtime.
 *
 *  MeshSurfaceSampler: src/canopy.js and src/alcove.js call
 *  .setRandomGenerator(rand) so surface scatter draws from our seeded stream.
 *  Without it the sampler falls back to Math.random internally and the scene
 *  stops being reproducible -- which is invisible in a screenshot and fatal to
 *  the pixel-diff harness the whole organisation pass depends on.
 * ---------------------------------------------------------------- */
const CONTRACTS = [
  { file: 'MeshSurfaceSampler.js', needs: /setRandomGenerator\s*\(/,
    why: 'src/canopy.js + src/alcove.js seed surface scatter through it; ' +
         'without it the scene is no longer deterministic (see src/rng.js)' },
];

function checkContracts(srcPath, code) {
  const base = path.basename(srcPath);
  for (const c of CONTRACTS) {
    if (base !== c.file) continue;
    if (!c.needs.test(code)) {
      console.error(`\nVENDOR CONTRACT BROKEN: ${c.file} no longer exposes ` +
                    `${c.needs}\n  why it matters: ${c.why}\n`);
      process.exitCode = 1;
    } else {
      console.log(`  contract ok: ${c.file} ${c.needs}`);
    }
  }
}

function visit(srcPath, destRel) {
  const key = path.normalize(srcPath);
  if (seen.has(key)) return;
  seen.add(key);

  if (!fs.existsSync(srcPath)) {
    console.error(`missing: ${srcPath}`);
    process.exitCode = 1;
    return;
  }

  const code = fs.readFileSync(srcPath, 'utf8');
  checkContracts(srcPath, code);
  const dest = path.join(OUT, destRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, code);
  copied++; bytes += Buffer.byteLength(code);

  // follow relative imports only; bare specifiers go through the importmap
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    visit(
      path.join(path.dirname(srcPath), spec),
      path.join(path.dirname(destRel), spec)
    );
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
for (const [src, dest] of ENTRIES) visit(src, dest);

// binary/runtime-fetched files: straight copy, no import walk
for (const [src, destRel] of RAW_COPIES) {
  if (!fs.existsSync(src)) {
    console.error(`missing: ${src}`);
    process.exitCode = 1;
    continue;
  }
  const dest = path.join(OUT, destRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  copied++; bytes += fs.statSync(src).size;
}

console.log(`vendored ${copied} files, ${(bytes / 1048576).toFixed(2)} MB -> ${OUT}/`);
