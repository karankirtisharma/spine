/* Bakes astrogreen.glb into a point cloud: assets/astro-points.bin
 *
 * WHY BAKE, rather than ship the GLB and render it as a mesh.
 *
 * The source is a Tripo AI export and it is in poor shape for the web:
 *
 *     60.78 MB    92 meshes    92 materials    276 textures
 *     1,045,212 verts    1,990,672 tris    no skin, no animation
 *
 * That is ~230 MB of VRAM once uploaded, for an object that is never rendered as
 * a surface. Reference frames 5 through 12 all show the astronaut as a PARTICLE
 * SHELL -- the nebula in frame 6, the detonation in frame 9 and the orbital rings
 * in frame 12 are all clearly visible THROUGH the figure, and the suit's seams and
 * silhouette read as accumulated grain rather than as lit geometry. There is no
 * frame in the sequence where a solid body appears.
 *
 * So none of the 276 textures, none of the UVs and none of the triangles survive to
 * runtime. What is needed is a well-distributed set of surface points with their
 * normals, which is exactly what this produces -- and 140k of those quantised come
 * to about 1.2 MB, in the same range as Active Theory's own baked clouds
 * (flower_spine-512 is 1.83 MB). Their florets and their tree cloud are baked the
 * same way; this follows that discipline rather than inventing another.
 *
 * SAMPLING is area-weighted over the triangles, via a cumulative-area table and a
 * binary search per sample. Uniform-per-triangle sampling would clump grain onto
 * the mesh's dense regions -- and a Tripo export's density is an artefact of its
 * reconstruction, not of the form -- so area weighting is what makes the shell read
 * as an even surface.
 *
 * DETERMINISTIC. A seeded PRNG, not Math.random: the bake is committed, so a
 * re-run has to reproduce it byte for byte or the asset churns in git for no
 * reason. mulberry32 is 4 lines and has ample quality for surface scatter.
 *
 * CONTAINER (little-endian throughout):
 *
 *     offset 0    10 bytes   JSON byte length, ASCII digits, NUL-padded
 *     offset 10   N bytes    JSON header
 *     then        pad to a 2-byte boundary
 *                 Int16Array  position, count * 3, normalised to the bounds
 *                 Int8Array   normal,   count * 3, x127
 *
 * The 10-byte-prefix + JSON-header shape is deliberately Active Theory's own (see
 * parseATContainer in src/flower-cloud.js) so this project has ONE container idea
 * rather than two. The payload is plain quantised typed arrays instead of Draco:
 * Draco would need the decoder on a second asset path for maybe 400 KB, and the
 * quantisation here is already lossless at the precision the shell renders at.
 *
 * Usage: node scripts/bake-astro.mjs [count]
 *        node scripts/bake-astro.mjs --src other.glb --out other.bin
 */
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const COUNT = Number(argv.find(a => /^\d+$/.test(a)) ?? 140000);
const SRC = flag('src', '../astrogreen.glb');
const OUT = flag('out', 'assets/astro-points.bin');
/* Target height in world units. The astronaut spans roughly 78-92% of frame height
 * across frames 5-8; main.js scales per section, so this is only a normalisation so
 * the runtime numbers are not hostage to whatever unit Tripo exported in. */
const TARGET_H = 10;

/* mulberry32 -- seeded, so the committed bake is reproducible. */
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const t0 = Date.now();
const io = new NodeIO();
console.log(`reading ${SRC} …`);
const doc = await io.read(SRC);
const root = doc.getRoot();

/* Flatten the scene graph. Every primitive's positions and normals are pushed
 * through its node's WORLD matrix -- 92 nodes each carry their own transform, and
 * reading the accessors raw would pile all 92 parts on top of each other at the
 * origin. (The same trap the spine and emblem loaders document for
 * KHR_mesh_quantization, one level further out.) */
const tris = [];   // {p: [9 floats], n: [9 floats]}
let srcVerts = 0, srcTris = 0, skippedNoNormal = 0;

function mul(m, x, y, z, w) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
  ];
}

for (const scene of root.listScenes()) {
  const walk = (node, parent) => {
    const local = node.getMatrix();
    const world = parent ? mat4mul(parent, local) : local;
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        const nrm = prim.getAttribute('NORMAL');
        if (!pos) continue;
        if (!nrm) { skippedNoNormal++; continue; }
        srcVerts += pos.getCount();
        const idx = prim.getIndices();
        const n = idx ? idx.getCount() : pos.getCount();
        const P = [0, 0, 0], N = [0, 0, 0];
        for (let i = 0; i < n; i += 3) {
          const a = idx ? idx.getScalar(i) : i;
          const b = idx ? idx.getScalar(i + 1) : i + 1;
          const c = idx ? idx.getScalar(i + 2) : i + 2;
          const t = { p: [], n: [] };
          for (const v of [a, b, c]) {
            pos.getElement(v, P); nrm.getElement(v, N);
            t.p.push(...mul(world, P[0], P[1], P[2], 1));
            /* w = 0 for normals: direction, not position, so translation must not
             * apply. Non-uniform node scale would strictly need the
             * inverse-transpose; these nodes are uniformly scaled, and the vectors
             * are renormalised per sample below anyway. */
            t.n.push(...mul(world, N[0], N[1], N[2], 0));
          }
          tris.push(t);
          srcTris++;
        }
      }
    }
    for (const child of node.listChildren()) walk(child, world);
  };
  for (const node of scene.listChildren()) walk(node, null);
}

function mat4mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
                   + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

if (!tris.length) throw new Error('no triangles with normals found');
console.log(`  ${srcVerts.toLocaleString()} verts, ${srcTris.toLocaleString()} tris`
  + (skippedNoNormal ? `, ${skippedNoNormal} prims skipped (no normals)` : ''));

/* Bounds, then normalise: centre on x/z, sit the feet at y = 0, scale to TARGET_H.
 * Feet at zero rather than centred because frame 12 stands the figure ON a particle
 * floor -- an origin at the soles is what makes that placement one number. */
let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (const t of tris) {
  for (let v = 0; v < 3; v++) {
    for (let a = 0; a < 3; a++) {
      const val = t.p[v * 3 + a];
      if (val < mn[a]) mn[a] = val;
      if (val > mx[a]) mx[a] = val;
    }
  }
}
const srcH = mx[1] - mn[1];
const S = TARGET_H / Math.max(1e-9, srcH);
const cx = (mn[0] + mx[0]) / 2, cz = (mn[2] + mx[2]) / 2;
console.log(`  source bounds ${mn.map(v => v.toFixed(2))} .. ${mx.map(v => v.toFixed(2))}`);
console.log(`  height ${srcH.toFixed(3)} -> ${TARGET_H} (scale ${S.toFixed(4)})`);

/* Cumulative area table for weighted sampling. Degenerate triangles (a real
 * possibility in a reconstruction) contribute zero area and so can never be
 * selected -- no need to filter them separately. */
const cum = new Float64Array(tris.length);
let total = 0;
for (let i = 0; i < tris.length; i++) {
  const p = tris[i].p;
  const e1 = [p[3] - p[0], p[4] - p[1], p[5] - p[2]];
  const e2 = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
  const cr = [e1[1] * e2[2] - e1[2] * e2[1],
              e1[2] * e2[0] - e1[0] * e2[2],
              e1[0] * e2[1] - e1[1] * e2[0]];
  total += 0.5 * Math.hypot(cr[0], cr[1], cr[2]);
  cum[i] = total;
}
console.log(`  surface area ${total.toFixed(1)} (source units)`);

const rand = rng(0x0A57B0);
const pos = new Int16Array(COUNT * 3);
const nrm = new Int8Array(COUNT * 3);
/* Quantisation range: the normalised model, padded 2%. Positions are stored as a
 * fraction of this box so the decoder needs only the bounds from the header. */
const qmn = [(mn[0] - cx) * S, 0, (mn[2] - cz) * S];
const qmx = [(mx[0] - cx) * S, TARGET_H, (mx[2] - cz) * S];
for (let a = 0; a < 3; a++) {
  const pad = (qmx[a] - qmn[a]) * 0.01 + 1e-4;
  qmn[a] -= pad; qmx[a] += pad;
}

for (let i = 0; i < COUNT; i++) {
  // binary search the cumulative table
  const r = rand() * total;
  let lo = 0, hi = tris.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; }
  const t = tris[lo];

  /* Uniform barycentric on a triangle: the sqrt is what stops samples bunching
   * toward one corner, which a raw (u, v) pair does. */
  let u = rand(), v = rand();
  const su = Math.sqrt(u);
  const b0 = 1 - su, b1 = su * (1 - v), b2 = su * v;

  const px = (t.p[0] * b0 + t.p[3] * b1 + t.p[6] * b2 - cx) * S;
  const py = (t.p[1] * b0 + t.p[4] * b1 + t.p[7] * b2 - mn[1]) * S;
  const pz = (t.p[2] * b0 + t.p[5] * b1 + t.p[8] * b2 - cz) * S;

  let nx = t.n[0] * b0 + t.n[3] * b1 + t.n[6] * b2;
  let ny = t.n[1] * b0 + t.n[4] * b1 + t.n[7] * b2;
  let nz = t.n[2] * b0 + t.n[5] * b1 + t.n[8] * b2;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;

  const q = (val, a) => {
    const f = (val - qmn[a]) / (qmx[a] - qmn[a]);        // 0..1
    return Math.max(-32768, Math.min(32767, Math.round(f * 65535 - 32768)));
  };
  pos[i * 3] = q(px, 0); pos[i * 3 + 1] = q(py, 1); pos[i * 3 + 2] = q(pz, 2);
  nrm[i * 3] = Math.max(-127, Math.min(127, Math.round(nx * 127)));
  nrm[i * 3 + 1] = Math.max(-127, Math.min(127, Math.round(ny * 127)));
  nrm[i * 3 + 2] = Math.max(-127, Math.min(127, Math.round(nz * 127)));
}

const header = JSON.stringify({
  name: 'astro-points',
  count: COUNT,
  /* The decoder reconstructs position as
   *     qmn + (i16 + 32768) / 65535 * (qmx - qmn) */
  qmin: qmn.map(v => +v.toFixed(6)),
  qmax: qmx.map(v => +v.toFixed(6)),
  height: TARGET_H,
  attributes: [['position', 'i16'], ['normal', 'i8']],
  source: path.basename(SRC),
  srcTris,
});
const hb = Buffer.from(header, 'utf8');
const lenField = Buffer.alloc(10);          // NUL-padded by alloc
lenField.write(String(hb.length), 0, 'ascii');
/* Pad so the Int16 view starts 2-byte aligned. Buffer.from on a typed array copies
 * bytes, so misalignment would not throw here -- it would silently shear the data
 * for anyone constructing a view over the whole file instead of slicing. */
const headEnd = 10 + hb.length;
const pad = Buffer.alloc((2 - (headEnd % 2)) % 2);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([
  lenField, hb, pad,
  Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength),
  Buffer.from(nrm.buffer, nrm.byteOffset, nrm.byteLength),
]));

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`\n${OUT}  ${COUNT.toLocaleString()} points  ${kb} KB`
  + `  (source ${(fs.statSync(SRC).size / 1048576).toFixed(1)} MB)`);
console.log(`took ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
