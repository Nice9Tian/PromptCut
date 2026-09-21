// G0-b (10)：裁剪矩形取法。r75-05 第 3 条把第一版定成「包裹层框在整段 motion 下的包围盒 ∩ 画布」
// （从项目数据算、不实测），并把「要不要改成实测实体框并集」交给本原型定稿。
//
// 这里对 2～4 张真卡量三个矩形，再各编一遍比面积、编码耗时和文件大小：
//   wrapper —— 包裹层框 ∩ 画布。隔离工程里卡没有 frame / motion，包裹层就是整张画布，
//              所以这一档就是整幅 1920x1080（这正是第一版口径在「全幅卡」上的样子）。
//   union   —— 实测实体框的**并集**：逐帧扫 PNG 的 alpha，取 alpha > 0 的包围盒，15 帧取并，
//              再按 r75-05 第 1 条外扩到偶数宽高。
//   perFrame—— 逐帧实体框里最大的那一个（只作参照：它不能当分段的裁剪矩形，因为分段里
//              每一帧的几何必须一样；列出来是为了看 motion 让并集涨了多少）。
//
//   node scripts/probes/stream-crop-rect.mjs --cards particles-snow,growth-curve,scene-3d,odometer --json out.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findFfmpeg, ffmpegVersion, encodeSegment, splitFmp4, pngToRgba, pngSize,
  even, stats, writeJson, arg,
} from './stream-common.mjs';

const MATERIAL = String(arg('material', path.join(os.tmpdir(), 'pc-stream-material')));
const CARDS = String(arg('cards', 'particles-snow,growth-curve,scene-3d,odometer')).split(',').map((s) => s.trim()).filter(Boolean);
const FPS = Number(arg('fps', '30'));
const ENCODER = String(arg('encoder', 'libx264'));
const RANGE = String(arg('range', 'tv'));
const REPEATS = Number(arg('repeats', '3'));
const ALPHA_MIN = Number(arg('alpha-min', '1'));   // alpha > 这个值才算「画到了」
const jsonOut = arg('json');

const ffmpeg = findFfmpeg();
const report = {
  probe: 'stream-crop-rect',
  when: new Date().toISOString(),
  env: { ffmpeg: await ffmpegVersion(ffmpeg), node: process.version, fps: FPS, encoder: ENCODER, range: RANGE, alphaMin: ALPHA_MIN, repeats: REPEATS },
  cards: [],
};

/** 一帧 RGBA 里 alpha > min 的包围盒，没有就返回 null */
function alphaBox(rgba, W, H, min) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      if (rgba[row + x * 4 + 3] > min) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 外扩到偶数宽高，并钳在画布内（r75-05 第 1 条） */
function evenClamp(r, W, H) {
  const w = Math.min(even(r.w), W), h = Math.min(even(r.h), H);
  return { x: Math.max(0, Math.min(r.x, W - w)), y: Math.max(0, Math.min(r.y, H - h)), w, h };
}

for (const cardId of CARDS) {
  const dir = path.join(MATERIAL, cardId, 'frames');
  if (!fs.existsSync(dir)) { console.log(`跳过 ${cardId}：没有素材`); continue; }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort().slice(0, 15);
  if (files.length < 15) { console.log(`跳过 ${cardId}：只有 ${files.length} 帧`); continue; }
  const pngs = files.map((f) => fs.readFileSync(path.join(dir, f)));
  const { width: W, height: H } = pngSize(pngs[0]);
  console.log(`\n=== ${cardId} === 画布 ${W}x${H}`);

  // 逐帧实体框
  const boxes = [];
  for (const f of files) {
    const rgba = await pngToRgba(ffmpeg, path.join(dir, f), W, H);
    boxes.push(alphaBox(rgba, W, H, ALPHA_MIN));
  }
  const painted = boxes.filter(Boolean);
  if (!painted.length) { console.log('  整段全透明，跳过'); continue; }
  const union = evenClamp({
    x: Math.min(...painted.map((b) => b.x)),
    y: Math.min(...painted.map((b) => b.y)),
    w: Math.max(...painted.map((b) => b.x + b.w)) - Math.min(...painted.map((b) => b.x)),
    h: Math.max(...painted.map((b) => b.y + b.h)) - Math.min(...painted.map((b) => b.y)),
  }, W, H);
  const biggest = painted.reduce((m, b) => (b.w * b.h > m.w * m.h ? b : m), painted[0]);
  const wrapper = { x: 0, y: 0, w: W, h: H };

  const canvasArea = W * H;
  const card = {
    cardId, canvas: { W, H },
    rects: {
      wrapper: { ...wrapper, area: canvasArea, pctOfCanvas: 100 },
      union: { ...union, area: union.w * union.h, pctOfCanvas: +(100 * union.w * union.h / canvasArea).toFixed(1) },
      biggestPerFrame: { ...evenClamp(biggest, W, H), area: even(biggest.w) * even(biggest.h), pctOfCanvas: +(100 * even(biggest.w) * even(biggest.h) / canvasArea).toFixed(1) },
    },
    perFrameBoxes: boxes,
    encode: [],
  };
  console.log(`  包裹层框（∩画布）= ${W}x${H}（100 %）`);
  console.log(`  实体框并集      = ${union.w}x${union.h} @ (${union.x},${union.y})  ${card.rects.union.pctOfCanvas} % 的画布`);
  console.log(`  单帧最大实体框  = ${card.rects.biggestPerFrame.w}x${card.rects.biggestPerFrame.h}  ${card.rects.biggestPerFrame.pctOfCanvas} % —— 并集比它大 ${(card.rects.union.area / card.rects.biggestPerFrame.area).toFixed(2)} 倍（motion 撑出来的部分）`);

  for (const [name, rect] of [['wrapper', wrapper], ['union', union]]) {
    const msList = [];
    let last = null;
    for (let r = 0; r < REPEATS; r++) {
      last = await encodeSegment(ffmpeg, pngs, { encoder: ENCODER, fps: FPS, range: RANGE, crop: rect });
      msList.push(last.ms);
    }
    const split = splitFmp4(last.buffer);
    const row = {
      rect: name, ...rect, stackedH: rect.h * 2 + 16,
      encodeMs: stats(msList), segBytes: split.segments[0].length,
      decodeFrameBytesNv12: Math.round(rect.w * (rect.h * 2 + 16) * 1.5),
    };
    card.encode.push(row);
    console.log(`  裁到 ${name.padEnd(7)} ${rect.w}x${rect.h} -> 拼合 ${rect.w}x${row.stackedH}：编码 ${row.encodeMs.p50} ms（${msList.map((m) => m.toFixed(0)).join('/')}），分段 ${(row.segBytes / 1024).toFixed(1)} KB，解码帧 ${(row.decodeFrameBytesNv12 / 1e6).toFixed(2)} MB`);
  }
  const w0 = card.encode.find((e) => e.rect === 'wrapper'), u0 = card.encode.find((e) => e.rect === 'union');
  card.savings = {
    areaPct: +(100 * (1 - u0.w * u0.h / (w0.w * w0.h))).toFixed(1),
    encodeMsPct: +(100 * (1 - u0.encodeMs.p50 / w0.encodeMs.p50)).toFixed(1),
    segBytesPct: +(100 * (1 - u0.segBytes / w0.segBytes)).toFixed(1),
    decodeBytesPct: +(100 * (1 - u0.decodeFrameBytesNv12 / w0.decodeFrameBytesNv12)).toFixed(1),
  };
  console.log(`  并集相对包裹层框省：面积 ${card.savings.areaPct} %、编码耗时 ${card.savings.encodeMsPct} %、分段体积 ${card.savings.segBytesPct} %、解码帧字节 ${card.savings.decodeBytesPct} %`);
  report.cards.push(card);
}

report.summary = {
  areaSavedPct: stats(report.cards.map((c) => c.savings.areaPct)),
  encodeMsSavedPct: stats(report.cards.map((c) => c.savings.encodeMsPct)),
  segBytesSavedPct: stats(report.cards.map((c) => c.savings.segBytesPct)),
  decodeBytesSavedPct: stats(report.cards.map((c) => c.savings.decodeBytesPct)),
};
console.log(`\n=== 汇总（实体框并集 相对 包裹层框）===`);
console.log(`  面积省 p50 ${report.summary.areaSavedPct.p50} %（${report.cards.map((c) => c.cardId + ' ' + c.savings.areaPct + '%').join('，')}）`);
console.log(`  编码耗时省 p50 ${report.summary.encodeMsSavedPct.p50} %`);
console.log(`  分段体积省 p50 ${report.summary.segBytesSavedPct.p50} %`);
console.log(`  解码帧字节省 p50 ${report.summary.decodeBytesSavedPct.p50} %`);

if (jsonOut) console.log(`\nJSON -> ${writeJson(String(jsonOut), report)}`);
