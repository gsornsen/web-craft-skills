#!/usr/bin/env node
// Converts a product's read-only ASCII STL source assets (under competition/example_assets/,
// per the manifest's "sourceDir") into compact binary STL copies under this skill's own
// assets/<assetsDir>/ directory. NEVER touches example_assets/ (read-only).
//
// Also writes a geometry-report.json (bounding box / center / radius-from-origin per part)
// next to the converted files, both as a sanity check ("do these parts share one world
// coordinate frame?") and as calibration data if you're hand-tuning a new product's
// camPresets in its manifest.
//
// Usage:
//   node tools/convert-stl.mjs <product>          # e.g. `node tools/convert-stl.mjs orb`
//
// To add a NEW product: drop its manifest at products/<product>.json (see products/orb.json
// for the schema: parts[].file must name the ASCII .stl as it exists in sourceDir; this script
// writes the binary copy as the same name with .bin.stl appended, into assets/<assetsDir>/).
// Then run this script once to populate assets/<assetsDir>/, and render.mjs --product=<product>
// picks it up automatically. If the manifest omits "camPresets", the viewer auto-frames the
// camera from the loaded geometry's bounding sphere (reasonable but untuned — see SKILL.md).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');
const COMPETITION_ROOT = path.resolve(SKILL_ROOT, '../../..');

const product = process.argv[2];
if (!product) {
  console.error('usage: node tools/convert-stl.mjs <product>   (e.g. orb)');
  process.exit(2);
}

const manifestPath = path.join(SKILL_ROOT, 'products', `${product}.json`);
if (!fs.existsSync(manifestPath)) {
  console.error(`no manifest at ${manifestPath}`);
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const SRC_DIR = path.join(COMPETITION_ROOT, manifest.sourceDir);
const OUT_DIR = path.join(SKILL_ROOT, 'assets', manifest.assetsDir || product);
fs.mkdirSync(OUT_DIR, { recursive: true });

function parseAsciiSTL(text) {
  // Fast line-oriented parse: collect triangle vertex triples + facet normals.
  const lines = text.split('\n');
  const tris = []; // each: {n:[nx,ny,nz], v:[[x,y,z]x3]}
  let normal = null;
  let verts = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes('facet normal')) {
      const m = l.trim().split(/\s+/);
      normal = [parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
      verts = [];
    } else if (l.includes('vertex')) {
      const m = l.trim().split(/\s+/);
      verts.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
      if (verts.length === 3) {
        tris.push({ n: normal, v: verts });
      }
    }
  }
  return tris;
}

function writeBinarySTL(tris, outPath) {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write(`Binary STL converted from ASCII source (model-render skill, product=${product})`.padEnd(80, ' ').slice(0, 80), 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  let off = 84;
  for (const t of tris) {
    buf.writeFloatLE(t.n[0], off); buf.writeFloatLE(t.n[1], off + 4); buf.writeFloatLE(t.n[2], off + 8);
    off += 12;
    for (const v of t.v) {
      buf.writeFloatLE(v[0], off); buf.writeFloatLE(v[1], off + 4); buf.writeFloatLE(v[2], off + 8);
      off += 12;
    }
    buf.writeUInt16LE(0, off); off += 2;
  }
  fs.writeFileSync(outPath, buf);
}

function stats(tris) {
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  let sumr2min = Infinity, sumr2max = 0;
  for (const t of tris) {
    for (const v of t.v) {
      const [x, y, z] = v;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
      const r2 = x * x + y * y;
      if (r2 < sumr2min) sumr2min = r2;
      if (r2 > sumr2max) sumr2max = r2;
    }
  }
  return {
    bbox: { x: [minx, maxx], y: [miny, maxy], z: [minz, maxz] },
    size: { x: maxx - minx, y: maxy - miny, z: maxz - minz },
    center: { x: (minx + maxx) / 2, y: (miny + maxy) / 2 },
    radiusFromOrigin: { min: Math.sqrt(sumr2min), max: Math.sqrt(sumr2max) },
  };
}

const report = {};
for (const part of manifest.parts) {
  const f = part.file;
  const srcPath = path.join(SRC_DIR, f);
  const text = fs.readFileSync(srcPath, 'utf8');
  const tris = parseAsciiSTL(text);
  const outPath = path.join(OUT_DIR, f.replace(/\.stl$/, '.bin.stl'));
  writeBinarySTL(tris, outPath);
  const srcSize = fs.statSync(srcPath).size;
  const outSize = fs.statSync(outPath).size;
  const s = stats(tris);
  report[f] = { triangles: tris.length, srcBytes: srcSize, binBytes: outSize, ...s };
  console.log(`${f}: ${tris.length} tris, ${(srcSize / 1024).toFixed(0)}KB ascii -> ${(outSize / 1024).toFixed(0)}KB binary`);
  console.log(`  bbox x=[${s.bbox.x.map(v => v.toFixed(2))}] y=[${s.bbox.y.map(v => v.toFixed(2))}] z=[${s.bbox.z.map(v => v.toFixed(2))}]`);
  console.log(`  center=(${s.center.x.toFixed(2)}, ${s.center.y.toFixed(2)})  r(origin)=[${s.radiusFromOrigin.min.toFixed(2)}, ${s.radiusFromOrigin.max.toFixed(2)}]`);
}
fs.writeFileSync(path.join(OUT_DIR, 'geometry-report.json'), JSON.stringify(report, null, 2));
console.log('\nWrote', path.join(OUT_DIR, 'geometry-report.json'));
