import fs from 'node:fs';

const buf = fs.readFileSync(process.argv[2]);
const magic = buf.readUInt32LE(0);
if (magic !== 0x46546c67) throw new Error('not a GLB');
const total = buf.readUInt32LE(8);

let off = 12, json = null, binLen = 0;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
  if (type === 0x004e4942) binLen = len;
  off += 8 + len + ((4 - (len % 4)) % 4);
}

const g = json;
const sum = a => (a || []).length;
console.log('file MB       ', (total / 1048576).toFixed(2));
console.log('BIN MB        ', (binLen / 1048576).toFixed(2));
console.log('generator     ', g.asset?.generator);
console.log('extensionsUsed', g.extensionsUsed || []);
console.log('meshes        ', sum(g.meshes));
console.log('nodes         ', sum(g.nodes));
console.log('materials     ', sum(g.materials));
console.log('textures      ', sum(g.textures));
console.log('images        ', sum(g.images));
console.log('animations    ', sum(g.animations));
console.log('skins         ', sum(g.skins));

let tris = 0, verts = 0;
for (const m of g.meshes || []) {
  for (const p of m.primitives || []) {
    const posAcc = g.accessors[p.attributes.POSITION];
    verts += posAcc.count;
    if (p.indices != null) tris += g.accessors[p.indices].count / 3;
    else tris += posAcc.count / 3;
  }
}
console.log('vertices      ', verts.toLocaleString());
console.log('triangles     ', Math.round(tris).toLocaleString());

console.log('\n-- meshes --');
(g.meshes || []).slice(0, 25).forEach((m, i) => {
  const attrs = Object.keys(m.primitives[0].attributes).join(',');
  const c = g.accessors[m.primitives[0].attributes.POSITION].count;
  console.log(`  [${i}] ${m.name || '(unnamed)'}  prims=${m.primitives.length} verts=${c} attrs=${attrs}`);
});

console.log('\n-- materials --');
(g.materials || []).slice(0, 25).forEach((m, i) => {
  const p = m.pbrMetallicRoughness || {};
  console.log(`  [${i}] ${m.name || '(unnamed)'} base=${JSON.stringify(p.baseColorFactor)} metal=${p.metallicFactor} rough=${p.roughnessFactor} tex=${p.baseColorTexture ? 'y' : 'n'}`);
});

console.log('\n-- images --');
(g.images || []).slice(0, 25).forEach((im, i) => {
  const bv = g.bufferViews[im.bufferView];
  console.log(`  [${i}] ${im.name || '(unnamed)'} ${im.mimeType} ${(bv ? bv.byteLength / 1048576 : 0).toFixed(2)}MB`);
});

// world-space bounds from POSITION accessor min/max (ignores node transforms)
let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
for (const m of g.meshes || []) for (const p of m.primitives || []) {
  const a = g.accessors[p.attributes.POSITION];
  if (a.min) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], a.min[i]); max[i] = Math.max(max[i], a.max[i]); }
}
console.log('\nlocal bounds  min', min.map(v => +v.toFixed(3)), 'max', max.map(v => +v.toFixed(3)));
console.log('size          ', max.map((v, i) => +(v - min[i]).toFixed(3)));
