// 逐像素比较两个导出目录的 frames/*.png；另报 PNG 逐字节相同的帧数
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { PNG } = require('pngjs');
const [a, b] = process.argv.slice(2).map((d) => path.join(d, 'frames'));
const fa = fs.readdirSync(a).filter((f) => f.endsWith('.png')).sort();
const fb = fs.readdirSync(b).filter((f) => f.endsWith('.png')).sort();
if (fa.join() !== fb.join()) { console.log(JSON.stringify({ ok: false, reason: 'frame-list', a: fa.length, b: fb.length })); process.exit(1); }
let same = 0, diff = 0, bytesSame = 0; const diffs = [];
for (const f of fa) {
  const ba = fs.readFileSync(path.join(a, f)), bb = fs.readFileSync(path.join(b, f));
  if (crypto.createHash('sha256').update(ba).digest('hex') === crypto.createHash('sha256').update(bb).digest('hex')) { bytesSame++; same++; continue; }
  const pa = PNG.sync.read(ba), pb = PNG.sync.read(bb);
  if (pa.width !== pb.width || pa.height !== pb.height || Buffer.compare(pa.data, pb.data) !== 0) { diff++; diffs.push(f); } else same++;
}
console.log(JSON.stringify({ ok: diff === 0, frames: fa.length, pixelIdentical: same, different: diff, pngBytesIdentical: bytesSame, firstDiffs: diffs.slice(0, 10) }));
process.exit(diff === 0 ? 0 : 1);
