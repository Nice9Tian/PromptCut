/*
 * R9 M5 的像素验收:canvas 卡迁进共享 WebGL 渲染器前后,同一帧导出**非边缘像素差 ≤ 1/255**。
 *
 * 为什么不是逐像素相同:迁移前 `scene-3d` 自建 `THREE.WebGLRenderer({ alpha: true, antialias: true })`,
 * 迁移后是 `{ alpha: true, antialias: false, premultipliedAlpha: true }` + 多重采样 FBO + blit,
 * 抗锯齿边缘必然有差(任务书 M5 明写的例外);非边缘像素不许差过 1 级。
 *
 * 跑法(两台 dev server:迁移前的树、迁移后的树,各自 `npx vite --port <p> --strictPort --host 127.0.0.1`):
 *   node scripts/probes/gl-migrate-compare.mjs --base http://127.0.0.1:5243 --origin http://127.0.0.1:5240 [--out out/gl-migrate]
 *
 * 项目:4 张不同参数的 `scene-3d`(纽结 / 方块线框 / 球贴图 / 晶体逆光),640×360、30 fps、1 秒,导出第 0～9 帧。
 * 贴图是 ffmpeg 现做的一张带透明的 PNG,放进**两棵树各自的** `out/media/`(`--base-tree` 给迁移前那棵树的路径),
 * 经 `/@media/` 取。两边都用本树的 `server/bakery/` 导出 —— 这一步没改导出引擎,只改页面。
 *
 * 判定:
 *   - 边缘 = 迁移前那张图里,3×3 邻域内任一通道相差 > EDGE_GRAD 的像素,再向外扩 1 像素;
 *   - 非边缘像素任一通道差 > 1 就不过;边缘像素的差只统计、不判。
 * 每帧写 `<out>/diff-NNNNNN.png`(红 = 非边缘差 > 1,黄 = 边缘差,灰 = 相同),另存两边原图方便看。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { exportFrames } from '../../server/bakery/index.mjs';
import { flagArg } from './probe-connect.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const base = flagArg('base');
const origin = flagArg('origin');
const baseTree = flagArg('base-tree');
const out = path.resolve(flagArg('out', path.join(ROOT, 'out', 'gl-migrate')));
const frames = flagArg('frames', '0-9');
const EDGE_GRAD = Number(flagArg('edge-grad', '16'));
if (!base || !origin) throw new Error('用法:--base <迁移前 dev server> --origin <迁移后 dev server> [--base-tree <迁移前那棵树>]');

/* 贴图:一张 256×256 带透明的 PNG,两棵树各放一份 */
const texName = 'gl-migrate-texture.png';
for (const tree of [ROOT, baseTree].filter(Boolean)) {
  const dir = path.join(tree, 'out', 'media');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, texName);
  if (fs.existsSync(file)) continue;
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=256x256:rate=1', '-frames:v', '1',
    '-vf', 'format=rgba,geq=r=r(X\\,Y):g=g(X\\,Y):b=b(X\\,Y):a=if(lt(hypot(X-128\\,Y-128)\\,110)\\,255\\,0)', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 贴图失败:${r.stderr}`);
}

const card = (id, over) => ({ id, cardId: 'scene-3d', start: 0, end: 1, params: {
  shape: 'knot', color: '#8ab4ff', metal: 0.6, rough: 0.25, size: 0.55, spinY: 0.15, spinX: 0, tilt: -18, light: 'studio', fov: 0, wire: 'no', texture: '', ...over } });
const project = { version: 1, id: 'gl-migrate', name: 'gl-migrate', width: 640, height: 360, fps: 30, duration: 1, themeId: 'default', media: [], tracks: [
  { id: 't1', clips: [{ ...card('knot', {}), frame: { x: 160, y: 90, w: 320, h: 180, anchor: [0.5, 0.5] } }] },
  { id: 't2', clips: [{ ...card('cube', { shape: 'cube', wire: 'yes', color: '#ffb44a', spinY: 0.4, spinX: 0.2 }), frame: { x: 480, y: 90, w: 320, h: 180, anchor: [0.5, 0.5] } }] },
  { id: 't3', clips: [{ ...card('globe', { shape: 'sphere', texture: `/@media/${texName}`, metal: 0.1, rough: 0.8, light: 'soft', spinY: 0.3 }), frame: { x: 160, y: 270, w: 320, h: 180, anchor: [0.5, 0.5] } }] },
  { id: 't4', clips: [{ ...card('gem', { shape: 'crystal', light: 'rim', color: '#b388ff', spinY: -0.25, tilt: 30 }), frame: { x: 480, y: 270, w: 320, h: 180, anchor: [0.5, 0.5] } }] },
] };

const urlOf = (o) => `${o}/?export=1&timeline=${encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(project)))}`;
fs.rmSync(out, { recursive: true, force: true });
const baseOut = path.join(out, 'base');
const candOut = path.join(out, 'candidate');
await exportFrames({ url: urlOf(base), out: baseOut, noVideo: true, frames, workers: 1 });
await exportFrames({ url: urlOf(origin), out: candOut, noVideo: true, frames, workers: 1 });

const files = fs.readdirSync(path.join(baseOut, 'frames')).filter((f) => f.endsWith('.png')).sort();
let fail = 0;
const rows = [];
for (const f of files) {
  const a = PNG.sync.read(fs.readFileSync(path.join(baseOut, 'frames', f)));
  const b = PNG.sync.read(fs.readFileSync(path.join(candOut, 'frames', f)));
  if (a.width !== b.width || a.height !== b.height) throw new Error(`${f}: 尺寸不同`);
  const W = a.width, H = a.height;
  const px = (d, x, y, c) => d[(y * W + x) * 4 + c];
  const grad = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let g = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      for (let c = 0; c < 4; c++) g = Math.max(g, Math.abs(px(a.data, x, y, c) - px(a.data, nx, ny, c)));
    }
    if (g > EDGE_GRAD) grad[y * W + x] = 1;
  }
  const edge = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!grad[y * W + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H) edge[ny * W + nx] = 1;
    }
  }
  const diffImg = new PNG({ width: W, height: H });
  let same = 0, edgeDiff = 0, edgeMax = 0, flatBad = 0, flatMax = 0, flatDiff1 = 0;
  for (let i = 0; i < W * H; i++) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]));
    let rgb = [40, 40, 40];
    if (d === 0) same++;
    else if (edge[i]) { edgeDiff++; edgeMax = Math.max(edgeMax, d); rgb = [255, 210, 0]; }
    else { flatMax = Math.max(flatMax, d); if (d > 1) { flatBad++; rgb = [255, 0, 0]; } else { flatDiff1++; rgb = [0, 120, 255]; } }
    diffImg.data.set([...rgb, 255], i * 4);
  }
  fs.writeFileSync(path.join(out, `diff-${f}`), PNG.sync.write(diffImg));
  const row = { frame: f, pixels: W * H, same, edgeDiff, edgeMax, flatDiff1, flatBad, flatMax, pass: flatBad === 0 };
  if (!row.pass) fail++;
  rows.push(row);
  console.log(`${f}: ${row.pass ? 'PASS' : 'FAIL'} 相同 ${same}/${W * H}; 边缘差 ${edgeDiff} 个(最大 ${edgeMax}); 非边缘差 1 级 ${flatDiff1} 个、> 1 级 ${flatBad} 个(最大 ${flatMax})`);
}
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ base, origin, frames, edgeGrad: EDGE_GRAD, rows }, null, 2));
console.log(fail ? `FAIL ${fail}/${rows.length} 帧的非边缘像素差 > 1/255` : `PASS ${rows.length} 帧:非边缘像素差都 ≤ 1/255`);
console.log('产物:', out);
process.exitCode = fail ? 1 : 0;
