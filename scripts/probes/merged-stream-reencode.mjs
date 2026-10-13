// 合并流评估 · 第 2 问的甲（重新编码）和丙（直接按合并后的样子编）：产一个 15 帧分段要多久、多大、画质掉多少。
//
// 「格」= 一张卡的单卡流画面：宽 = 卡的矩形宽，高 = 2 × (矩形高 + 8)（上半预乘色、下半不透明度，各带 8 行填充）。
// 三种格（矩形取自 docs/plan/g0-b-stream-prototype.md 里量过的实体框并集）：
//   small 612×450（odometer）→ 612×916；medium 1320×772（growth-curve）→ 1320×1560；full 1920×1080（满屏）→ 1920×2176。
//
// 步骤：
//   1. 每种格造 8 张互不相同的卡（合成画面，带半透明），用**产品的命令行**（server/bakery/ffmpeg.mjs 的 streamSegmentArgs，
//      rawvideo 输入）各编 2 个分段——这就是现在的单卡流，记每段耗时、体积；另编一份无损的当画质参照。
//   2. 甲：把 N = 2、4、8 条单卡流的同一个分段交给 ffmpeg 解出来、xstack 拼成网格、再用产品的 x264 参数编一遍。
//      网格受硬解上限 4096×4096 约束（merged-stream-decode-limits.mjs 量的），放不下的写「放不下」。
//   3. 丙：不经单卡流，直接把 N 张卡的原始画面拼成一张大图送进产品的滤镜链和编码器（一次编码）。
//   4. 画质：参照（无损）对单卡流、参照对「合并流里裁出来的那一格」各算 PSNR，差值就是再编一遍掉的。
//
//   node scripts/probes/merged-stream-reencode.mjs [--repeats 3] [--json <文件>]
import fs from 'node:fs';
import path from 'node:path';
import { arg, runFfmpeg, splitFmp4, cpuBusy, writeJson, workDir, median, round, PRODUCT_X264, COLOR_TAGS, FMP4_FLAGS } from './merged-stream-common.mjs';
import { syntheticFrame } from './stream-common.mjs';
import { streamSegmentArgs, streamFilter } from '../../server/bakery/ffmpeg.mjs';

const REPEATS = Number(arg('repeats', '3'));
const FPS = 30, SEG = 15, CARDS = 8, HW_MAX = 4096;
const jsonOut = arg('json');
const dir = workDir('reencode');

const KINDS = [
  { id: 'small', w: 612, h: 450 },
  { id: 'medium', w: 1320, h: 772 },
  { id: 'full', w: 1920, h: 1080 },
];
const cellSize = (k) => ({ W: k.w, H: 2 * (k.h + 8) });

/** 一张卡一个分段的原始 RGBA（straight alpha），每张卡的画面相位不同 */
function rawSegment(kind, card, segment) {
  const frames = [];
  for (let i = 0; i < SEG; i++) frames.push(syntheticFrame(kind.w, kind.h, card * 40 + segment * SEG + i));
  return Buffer.concat(frames);
}

/** 产品的命令行（去掉它自带的 -y -hide_banner -loglevel error，runFfmpeg 会加） */
const productArgs = (w, h) => streamSegmentArgs({ encoder: 'libx264', fps: FPS, raw: { width: w, height: h } }).slice(4);
/** 无损参照：同一条滤镜链，x264 qp 0 */
const losslessArgs = (w, h) => ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', `${w}x${h}`, '-framerate', String(FPS), '-i', 'pipe:0',
  '-filter_complex', streamFilter('yuv420p'), '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-g', '15', '-bf', '0', ...COLOR_TAGS, '-an', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1'];

async function psnr(fileA, fileB, cropB = null) {
  const graph = cropB ? `[1:v]crop=${cropB.w}:${cropB.h}:${cropB.x}:${cropB.y}[b];[0:v][b]psnr` : '[0:v][1:v]psnr';
  const res = await runFfmpeg(['-loglevel', 'info', '-i', fileA, '-i', fileB, '-lavfi', graph, '-f', 'null', '-']);
  const m = /PSNR y:([\d.inf]+) u:([\d.inf]+) v:([\d.inf]+) average:([\d.inf]+)/.exec(res.stderr);
  return m ? { y: Number(m[1]), average: Number(m[4]) } : { error: res.stderr.split(/\r?\n/).slice(-2).join(' | ') };
}

const report = { probe: 'merged-stream-reencode', when: new Date().toISOString(), repeats: REPEATS, cpuBusyBefore: await cpuBusy(), encoder: PRODUCT_X264.join(' '), kinds: [] };

for (const kind of KINDS) {
  const { W, H } = cellSize(kind);
  const row = { id: kind.id, rect: `${kind.w}x${kind.h}`, cell: `${W}x${H}`, single: null, merge: [], direct: [] };
  console.log(`\n== ${kind.id}：卡的矩形 ${kind.w}×${kind.h} → 一格 ${W}×${H}`);

  // 1. 单卡流（现状）+ 无损参照
  const singleMs = [], singleBytes = [], singleCpu = [];
  for (let c = 0; c < CARDS; c++) {
    for (let s = 0; s < 2; s++) {
      const raw = rawSegment(kind, c, s);
      let best = null;
      for (let r = 0; r < (c === 0 ? REPEATS : 1); r++) {
        const res = await runFfmpeg(productArgs(kind.w, kind.h), { input: raw, bench: true });
        if (res.code !== 0) throw new Error(`单卡流编码失败：${res.stderr}`);
        singleMs.push(res.ms); singleCpu.push(res.cpuMs);
        best = res;
      }
      singleBytes.push(splitFmp4(best.stdout).segments[0].length);
      fs.writeFileSync(path.join(dir, `${kind.id}-c${c}-s${s}.mp4`), best.stdout);
      if (c < 2 && s === 0) {
        const ref = await runFfmpeg(losslessArgs(kind.w, kind.h), { input: raw });
        if (ref.code !== 0) throw new Error(`无损参照失败：${ref.stderr}`);
        fs.writeFileSync(path.join(dir, `${kind.id}-c${c}-s${s}-ref.mp4`), ref.stdout);
      }
      fs.writeFileSync(path.join(dir, `${kind.id}-c${c}-s${s}.rgba`), raw);
    }
  }
  const refPsnr = await psnr(path.join(dir, `${kind.id}-c0-s0-ref.mp4`), path.join(dir, `${kind.id}-c0-s0.mp4`));
  row.single = { msPerSegment: { median: round(median(singleMs), 0), min: round(Math.min(...singleMs), 0) }, cpuMsPerSegment: round(median(singleCpu), 0), bytesPerSegment: round(median(singleBytes), 0), psnrVsLossless: refPsnr };
  console.log(`单卡流（现状）：每段墙钟 ${row.single.msPerSegment.median} ms（最快 ${row.single.msPerSegment.min}）、处理器时间 ${row.single.cpuMsPerSegment} ms，每段 ${(row.single.bytesPerSegment / 1024).toFixed(1)} KB，对无损 PSNR ${refPsnr.average ?? refPsnr.error} dB`);

  for (const n of [2, 4, 8]) {
    const cols = Math.min(n, Math.floor(HW_MAX / W));
    const rows = cols ? Math.ceil(n / cols) : 0;
    if (!cols || rows * H > HW_MAX) {
      row.merge.push({ n, fits: false, why: `${n} 格要 ${cols || 1} 列 × ${rows || n} 行 = ${(cols || 1) * W}×${(rows || n) * H}，超出 ${HW_MAX}×${HW_MAX}` });
      console.log(`甲 拼 ${n} 格：放不下（${row.merge.at(-1).why}）`);
      continue;
    }
    const layout = Array.from({ length: n }, (_, i) => `${(i % cols) * W}_${Math.floor(i / cols) * H}`).join('|');
    const mergedW = cols * W, mergedH = rows * H;
    // 甲：解 N 条再编一条。xstack 空着的格子填黑
    const inputs = [];
    for (let c = 0; c < n; c++) inputs.push('-i', path.join(dir, `${kind.id}-c${c}-s0.mp4`));
    const times = [], cpus = [];
    let out = null;
    for (let r = 0; r < REPEATS; r++) {
      out = await runFfmpeg([...inputs, '-filter_complex', `xstack=inputs=${n}:layout=${layout}:fill=black,format=yuv420p`, ...PRODUCT_X264, ...COLOR_TAGS, '-video_track_timescale', String(FPS), ...FMP4_FLAGS, 'pipe:1'], { bench: true });
      if (out.code !== 0) throw new Error(`拼 ${n} 格失败：${out.stderr.split(/\r?\n/).slice(-3).join(' | ')}`);
      times.push(out.ms); cpus.push(out.cpuMs);
    }
    const mergedFile = path.join(dir, `${kind.id}-merged-${n}.mp4`);
    fs.writeFileSync(mergedFile, out.stdout);
    const mergedBytes = splitFmp4(out.stdout).segments[0].length;
    const q = await psnr(path.join(dir, `${kind.id}-c0-s0-ref.mp4`), mergedFile, { w: W, h: H, x: 0, y: 0 });
    const q1 = await psnr(path.join(dir, `${kind.id}-c1-s0-ref.mp4`), mergedFile, { w: W, h: H, x: (1 % cols) * W, y: Math.floor(1 / cols) * H });
    const m = { n, fits: true, grid: `${cols}×${rows}`, size: `${mergedW}x${mergedH}`, msPerSegment: { median: round(median(times), 0), min: round(Math.min(...times), 0) }, cpuMsPerSegment: round(median(cpus), 0),
      cpuVsSumOfSingles: round(median(cpus) / (row.single.cpuMsPerSegment * n), 2),
      bytes: mergedBytes, bytesVsSumOfSingles: round(mergedBytes / (row.single.bytesPerSegment * n), 2), psnrCell0VsLossless: q, psnrCell1VsLossless: q1,
      psnrDrop: q.average != null && refPsnr.average != null ? round(refPsnr.average - q.average, 2) : null };
    row.merge.push(m);
    console.log(`甲 拼 ${n} 格（${m.grid} = ${m.size}）：每段墙钟 ${m.msPerSegment.median} ms（最快 ${m.msPerSegment.min}）、处理器时间 ${m.cpuMsPerSegment} ms（是 ${n} 条单卡流编码之和的 ${m.cpuVsSumOfSingles} 倍），${(mergedBytes / 1024).toFixed(1)} KB（是 ${n} 条单卡流之和的 ${m.bytesVsSumOfSingles} 倍），第 0 格对无损 PSNR ${q.average ?? q.error} dB（比单卡流掉 ${m.psnrDrop} dB）`);

    // 丙：直接把 N 张卡的原始画面横着拼成一张大图（色半区在上、不透明度半区在下，就是一张更宽的卡），一次编码。
    // 只在一行放得下时量（多行的排法要改滤镜链，不在这次范围里）
    if (rows === 1) {
      const raws = Array.from({ length: n }, (_, c) => fs.readFileSync(path.join(dir, `${kind.id}-c${c}-s0.rgba`)));
      const wide = Buffer.alloc(mergedW * kind.h * 4 * SEG);
      for (let f = 0; f < SEG; f++) for (let y = 0; y < kind.h; y++) for (let c = 0; c < n; c++) {
        raws[c].copy(wide, ((f * kind.h + y) * mergedW + c * kind.w) * 4, (f * kind.h + y) * kind.w * 4, (f * kind.h + y + 1) * kind.w * 4);
      }
      const dt = [], dc = [];
      let d = null;
      for (let r = 0; r < REPEATS; r++) { d = await runFfmpeg(productArgs(mergedW, kind.h), { input: wide, bench: true }); if (d.code !== 0) throw new Error(`丙 失败：${d.stderr.split(/\r?\n/).slice(-3).join(' | ')}`); dt.push(d.ms); dc.push(d.cpuMs); }
      const dBytes = splitFmp4(d.stdout).segments[0].length;
      row.direct.push({ n, size: `${mergedW}x${H}`, msPerSegment: { median: round(median(dt), 0), min: round(Math.min(...dt), 0) }, cpuMsPerSegment: round(median(dc), 0), bytes: dBytes });
      console.log(`丙 直接编 ${n} 格（${mergedW}×${H}）：每段墙钟 ${round(median(dt), 0)} ms（最快 ${round(Math.min(...dt), 0)}）、处理器时间 ${round(median(dc), 0)} ms，${(dBytes / 1024).toFixed(1)} KB`);
    }
  }
  report.kinds.push(row);
}

report.cpuBusyAfter = await cpuBusy();
console.log(`\n处理器占用：开始 ${report.cpuBusyBefore}%，结束 ${report.cpuBusyAfter}%（忙的时候量的耗时偏大）`);
// 原始像素文件大，量完就删
for (const f of fs.readdirSync(dir)) if (f.endsWith('.rgba')) fs.rmSync(path.join(dir, f), { force: true });
const out = jsonOut && jsonOut !== true ? String(jsonOut) : path.join(dir, 'reencode.json');
writeJson(out, report);
console.log('结果写到', out);
