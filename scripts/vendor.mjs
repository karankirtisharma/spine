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
    'libs/meshopt_decoder.module.js',
  ].map(p => [`node_modules/three/examples/jsm/${p}`, `three/examples/jsm/${p}`]),
];

// matches `from './x.js'` / `import './x.js'` / `import(...)`
const IMPORT_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g;

const seen = new Set();
let copied = 0, bytes = 0;

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

console.log(`vendored ${copied} files, ${(bytes / 1048576).toFixed(2)} MB -> ${OUT}/`);
