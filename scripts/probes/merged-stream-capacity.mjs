// 合并流评估 · 第 1 问的后半：在解码器的尺寸上限下，一条合并流能放几张卡。纯计算，不起浏览器。
//
// 卡的矩形取自实测：
//   small-a  704×424：仓库里已有的流清单（out/frame-library/streams/*/stream.json）里 640×360 的卡，四周各留 32 像素溢出；
//   small-b  612×450、medium 1320×772：docs/plan/g0-b-stream-prototype.md 量的实体框并集（odometer、growth-curve）；
//   full     1920×1080：不设框的卡（缺省铺满画面）和所有组流。
// 一格 = 矩形宽 × 2×(矩形高 + 8)（server/bakery/ffmpeg.mjs 的 streamFilter：上下两半各垫 8 行）。
//
// 三种排法：
//   grid     甲、丙（重新编码）：格子随便排，这里用「按高度排序、一行一行摆」的简单装箱；
//   halves   甲、丙的变体：一格的色半区和不透明度半区可以分开摆（多一步在着色器里各取各的位置）；
//   vstack   乙（拼码流，一格一条带）：只能竖着叠，每格要和合并画面等宽（窄的格补黑边到最宽的那格），每格四周另留 32 像素黑边；
//   rowslice 乙（拼码流，每行宏块一条带）：能横着排，但每幅条带数 = 各列的宏块行数之和，实测硬解超过 256 条就解错。
//
//   node scripts/probes/merged-stream-capacity.mjs [--json <文件>]
import path from 'node:path';
import { arg, writeJson, workDir } from './merged-stream-common.mjs';

const CARDS = { 'small-a': { w: 704, h: 424 }, 'small-b': { w: 612, h: 450 }, medium: { w: 1320, h: 772 }, full: { w: 1920, h: 1080 } };
const LIMITS = [
  { id: 'pc-4096x4096', label: '这台 PC 实测的硬解上限', W: 4096, H: 4096 },
  { id: 'phone-4096x2304', label: '中高端手机常见的上限（查资料，H.264 5.1/5.2 级）', W: 4096, H: 2304 },
  { id: 'phone-1920x1088', label: '低端手机 / 安卓兼容性要求的底线（查资料）', W: 1920, H: 1088 },
];
const MAX_SLICES = 256;
const up16 = (n) => Math.ceil(n / 16) * 16;
const cellOf = (c) => ({ w: c.w, h: 2 * (c.h + 8) });

/** 一行一行摆（先高后矮），回放得下的张数。items: [{ w, h }]，按给的顺序尽量多放 */
function shelf(items, W, H) {
  const rows = [];
  let placed = 0;
  for (const it of items) {
    if (it.w > W || it.h > H) break;
    let row = rows.find((r) => r.used + it.w <= W && it.h <= r.h);
    if (!row) {
      const y = rows.reduce((a, r) => a + r.h, 0);
      if (y + it.h > H) break;
      row = { used: 0, h: it.h }; rows.push(row);
    }
    row.used += it.w; placed++;
  }
  return placed;
}
const grid = (cards, W, H) => shelf(cards.map(cellOf), W, H);
/** 色半区、不透明度半区分开摆：每张卡两块 w × (h + 8)，两块都放下才算一张 */
function halves(cards, W, H) {
  for (let n = cards.length; n > 0; n--) {
    const blocks = cards.slice(0, n).flatMap((c) => [{ w: c.w, h: c.h + 8 }, { w: c.w, h: c.h + 8 }]).sort((a, b) => b.h - a.h);
    if (shelf(blocks, W, H) === blocks.length) return n;
  }
  return 0;
}
/** 乙·竖叠：格高取 16 的倍数，四周 32 像素黑边；合并画面的宽 = 最宽那格 */
function vstack(cards, W, H) {
  let y = 0, n = 0;
  for (const c of cards) { const w = up16(c.w + 64), h = up16(2 * (c.h + 64 + 8)); if (w > W || y + h > H) break; y += h; n++; }
  return n;
}
/** 乙·每行一条带：同样的黑边；按行摆，另加「每幅条带数 ≤ 256」 */
function rowslice(cards, W, H) {
  for (let n = cards.length; n > 0; n--) {
    const cells = cards.slice(0, n).map((c) => ({ w: up16(c.w + 64), h: up16(2 * (c.h + 64 + 8)) })).sort((a, b) => b.h - a.h);
    if (shelf(cells, W, H) !== n) continue;
    const slices = cells.reduce((a, c) => a + c.h / 16, 0);
    if (slices <= MAX_SLICES) return n;
  }
  return 0;
}

const many = (name, n) => Array.from({ length: n }, () => CARDS[name]);
const SCENES = [
  { id: '全是小卡（704×424）', cards: many('small-a', 64) },
  { id: '全是小卡（612×450）', cards: many('small-b', 64) },
  { id: '全是中等卡（1320×772）', cards: many('medium', 16) },
  { id: '全是满屏卡（1920×1080）', cards: many('full', 8) },
  { id: '一张满屏卡 + 小卡（704×424）', cards: [CARDS.full, ...many('small-a', 40)] },
  { id: '混合：满屏 1、中等 1、其余小卡', cards: [CARDS.full, CARDS.medium, ...many('small-a', 40)] },
];

const report = { probe: 'merged-stream-capacity', when: new Date().toISOString(), cells: Object.fromEntries(Object.entries(CARDS).map(([k, c]) => [k, `${c.w}x${c.h} → ${cellOf(c).w}x${cellOf(c).h}`])), rows: [] };
console.log('一格的编码尺寸：', JSON.stringify(report.cells));
for (const lim of LIMITS) {
  console.log(`\n== ${lim.label}：${lim.W}×${lim.H}`);
  for (const s of SCENES) {
    const row = { limit: lim.id, scene: s.id, grid: grid(s.cards, lim.W, lim.H), halves: halves(s.cards, lim.W, lim.H), vstack: vstack(s.cards, lim.W, lim.H), rowslice: rowslice(s.cards, lim.W, lim.H) };
    report.rows.push(row);
    console.log(`  ${s.id.padEnd(22)} 重新编码（整格）${String(row.grid).padStart(2)} 张｜重新编码（两半分开摆）${String(row.halves).padStart(2)} 张｜拼码流·竖叠 ${String(row.vstack).padStart(2)} 张｜拼码流·每行一条带 ${String(row.rowslice).padStart(2)} 张`);
  }
}

// 吞吐：硬解的总产能是按像素算的。capacity 取自 merged-stream-play / decode-limits 的实测（--gpx 可改），这里只做除法
const GPX = Number(arg('gpx', '1.78'));
console.log(`\n== 按像素吞吐（${GPX} Gpx/s，这台 PC；docs/plan/g0-b-stream-prototype.md 第 (4) 节量的）最多能同时解几张卡，和拼不拼无关`);
report.throughput = [];
for (const [name, c] of Object.entries(CARDS)) {
  const px = cellOf(c).w * cellOf(c).h;
  const row = { card: name, pixelsPerFrame: px, at30: Math.floor((GPX * 1e9) / (px * 30)), at60: Math.floor((GPX * 1e9) / (px * 60)) };
  report.throughput.push(row);
  console.log(`  ${name.padEnd(8)} 一格 ${(px / 1e6).toFixed(2)} 百万像素：30 帧/秒 ${row.at30} 张，60 帧/秒 ${row.at60} 张`);
}
const jsonOut = arg('json');
const out = jsonOut && jsonOut !== true ? String(jsonOut) : path.join(workDir('capacity'), 'capacity.json');
writeJson(out, report);
console.log('结果写到', out);
