// G0-b (8)：稀疏分段的实际码率。G2 的口径是「每张 PNG 连续喂 stride 次，timescale 和 avcC 不变；
// 画面最多滞后 stride − 1 帧」，所以一个 15 帧分段在 stride = 3 时只有 5 张不同的画面。
// 与满密度（15 张都不同）对比文件大小、编码耗时，并验证分段仍是 15 个样本、首帧 IDR。
//
// G 的验收写的是「stride = 3 稀疏分段文件 ≤ 满密度 1.3 倍」——本探针就是去量这个倍数
// （直觉上重复帧应当远小于满密度，验收那条其实是个很松的上界）。
//
//   node scripts/probes/stream-sparse.mjs --cards particles-snow,growth-curve,scene-3d,odometer --json out.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findFfmpeg, ffmpegVersion, encodeSegment, splitFmp4, segmentInfo,
  pngSize, stats, writeJson, arg,
} from './stream-common.mjs';

const MATERIAL = String(arg('material', path.join(os.tmpdir(), 'pc-stream-material')));
const CARDS = String(arg('cards', 'particles-snow,growth-curve,scene-3d,odometer')).split(',').map((s) => s.trim()).filter(Boolean);
const STRIDES = String(arg('strides', '1,2,3,5')).split(',').map(Number);
const FPS = Number(arg('fps', '30'));
const ENCODER = String(arg('encoder', 'libx264'));
const RANGE = String(arg('range', 'tv'));     // (5) 的结论：线上用 tv
const REPEATS = Number(arg('repeats', '3'));
const jsonOut = arg('json');

const ffmpeg = findFfmpeg();
const report = {
  probe: 'stream-sparse',
  when: new Date().toISOString(),
  env: { ffmpeg: await ffmpegVersion(ffmpeg), node: process.version, fps: FPS, encoder: ENCODER, range: RANGE, repeats: REPEATS },
  cards: [],
};

for (const cardId of CARDS) {
  const dir = path.join(MATERIAL, cardId, 'frames');
  if (!fs.existsSync(dir)) { console.log(`跳过 ${cardId}：没有素材`); continue; }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  if (files.length < 15) { console.log(`跳过 ${cardId}：只有 ${files.length} 帧`); continue; }
  const all = files.map((f) => fs.readFileSync(path.join(dir, f)));
  const { width, height } = pngSize(all[0]);
  console.log(`\n=== ${cardId} === ${width}x${height}`);
  const card = { cardId, width, height, rows: [] };

  for (const stride of STRIDES) {
    // 一个 15 帧分段：取第 0、stride、2*stride… 张，每张连续喂 stride 次，凑够 15 个样本
    const distinct = Math.ceil(15 / stride);
    const pngs = [];
    for (let k = 0; k < distinct; k++) pngs.push(all[Math.min(all.length - 1, k * stride)]);
    const msList = [];
    let last = null;
    for (let r = 0; r < REPEATS; r++) {
      last = await encodeSegment(ffmpeg, pngs, { encoder: ENCODER, fps: FPS, range: RANGE, stride });
      msList.push(last.ms);
    }
    const split = splitFmp4(last.buffer);
    const info = segmentInfo(split.segments[0]);
    const bytes = split.segments[0].length;
    const row = {
      stride, distinctFrames: distinct, fedSamples: distinct * stride,
      encodeMs: stats(msList), segBytes: bytes,
      kbps: +((bytes * 8) / (15 / FPS) / 1000).toFixed(0),
      sampleCount: info.sampleCount, firstSampleIsSync: info.firstSampleIsSync,
      maxLagFrames: stride - 1,
    };
    card.rows.push(row);
    console.log(`  stride ${stride}：不同画面 ${distinct} 张，喂 ${row.fedSamples} 个样本 -> 分段样本 ${info.sampleCount}，` +
      `${(bytes / 1024).toFixed(1)} KB（${row.kbps} kbps），编码 ${row.encodeMs.p50} ms，最多滞后 ${row.maxLagFrames} 帧`);
  }
  const full = card.rows.find((r) => r.stride === 1);
  for (const r of card.rows) {
    r.sizeVsFull = full ? +(r.segBytes / full.segBytes).toFixed(3) : null;
    r.encodeMsVsFull = full ? +(r.encodeMs.p50 / full.encodeMs.p50).toFixed(3) : null;
  }
  console.log(`  相对满密度：${card.rows.map((r) => `stride ${r.stride} -> 体积 ${(r.sizeVsFull * 100).toFixed(0)}%、耗时 ${(r.encodeMsVsFull * 100).toFixed(0)}%`).join('；')}`);
  report.cards.push(card);
}

// ── 汇总：stride 3 相对满密度 ────────────────────────────────────────────────
const s3 = report.cards.map((c) => c.rows.find((r) => r.stride === 3)).filter(Boolean);
report.summary = {
  stride3SizeVsFull: stats(s3.map((r) => r.sizeVsFull)),
  stride3EncodeMsVsFull: stats(s3.map((r) => r.encodeMsVsFull)),
  allSegmentsHave15Samples: report.cards.every((c) => c.rows.every((r) => r.sampleCount === 15)),
  allFirstSampleSync: report.cards.every((c) => c.rows.every((r) => r.firstSampleIsSync === true)),
};
console.log(`\n=== 汇总 ===`);
console.log(`stride 3 体积 / 满密度：p50 ${(report.summary.stride3SizeVsFull.p50 * 100).toFixed(0)}%（${s3.map((r) => (r.sizeVsFull * 100).toFixed(0) + '%').join(', ')}），验收上界 130%`);
console.log(`stride 3 编码耗时 / 满密度：p50 ${(report.summary.stride3EncodeMsVsFull.p50 * 100).toFixed(0)}%`);
console.log(`每段样本恰 15：${report.summary.allSegmentsHave15Samples ? 'PASS' : 'FAIL'}；首帧同步样本：${report.summary.allFirstSampleSync ? 'PASS' : 'FAIL'}`);

if (jsonOut) console.log(`\nJSON -> ${writeJson(String(jsonOut), report)}`);
