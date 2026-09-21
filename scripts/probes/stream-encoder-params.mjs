// G0-b (7)：找出各编码器的**严格 GOP** 参数，并用 box 解析 + ffprobe 双重验证
//   - 每 15 帧恰好一个 IDR、无 B 帧、无场景切换插帧
//   - 每个分段（fMP4 fragment）的样本数恰好 15、首帧是 IDR
//
//   node scripts/probes/stream-encoder-params.mjs --json out.json
//   node scripts/probes/stream-encoder-params.mjs --repeats 3 --w 1920 --h 1080
//
// 两种喂法都跑：
//   per-segment：15 帧一次 ffmpeg 调用（G3 的实际设计）
//   long-run   ：45 帧一次调用（看 -g / sc_threshold 是否真的每 15 帧切一刀）
// 画面里第 8 帧起是**完全不同的内容**（硬场景切换），专门逼场景切换插帧。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  findFfmpeg, ffprobeOf, ffmpegVersion, probeEncoders, encodeSegment, ENCODER_ARGS, QUALITY_DEFAULT,
  splitFmp4, segmentInfo, initInfo, syntheticFrame, encodePng, even, stats, writeJson, arg,
} from './stream-common.mjs';

const execFileAsync = promisify(execFile);

const W = even(Number(arg('w', '1920')));
const H = even(Number(arg('h', '1080')));
const FPS = Number(arg('fps', '30'));
const REPEATS = Number(arg('repeats', '3'));
const outDir = String(arg('out', path.join(os.tmpdir(), 'pc-stream-encoder-params')));
const jsonOut = arg('json');

fs.mkdirSync(outDir, { recursive: true });

const ffmpeg = findFfmpeg();
const ffprobe = ffprobeOf(ffmpeg);

// ── 素材：45 帧，第 8 / 23 / 38 帧起内容整个换掉（硬场景切换） ────────────────
console.log(`造素材 ${W}x${H} 45 帧（合成画面，第 8/23/38 帧硬切）…`);
const pngs = [];
for (let i = 0; i < 45; i++) {
  // 硬切：把相位跳一大步，画面内容完全不同
  const jump = i >= 38 ? 900 : i >= 23 ? 600 : i >= 8 ? 300 : 0;
  pngs.push(encodePng(syntheticFrame(W, H, i + jump), W, H));
}
console.log(`素材就绪：PNG 共 ${(pngs.reduce((s, p) => s + p.length, 0) / 1e6).toFixed(1)} MB`);

// ── ffprobe：帧类型序列 ──────────────────────────────────────────────────────
async function frameTypes(file) {
  const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'frame=pict_type,key_frame', '-of', 'csv=p=0', file], { maxBuffer: 1 << 22 });
  return stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => {
    const [key, type] = l.split(',');
    return { key: key === '1', type: type || '?' };
  });
}

async function runCase(encoder, frames, label, opts = {}) {
  const res = await encodeSegment(ffmpeg, frames, { encoder, fps: FPS, ...opts });
  const file = path.join(outDir, `${encoder}-${label}.mp4`);
  fs.writeFileSync(file, res.buffer);
  const split = splitFmp4(res.buffer);
  const segs = split.segments.map(segmentInfo);
  const types = await frameTypes(file).catch((e) => ({ error: String(e.message).slice(0, 200) }));
  return {
    label, encoder, ms: res.ms, bytes: res.buffer.length, file,
    init: initInfo(split.init),
    initBytes: split.init.length,
    droppedBoxes: split.dropped,
    boxes: split.boxes,
    segmentCount: split.segments.length,
    segmentSamples: segs.map((s) => s.sampleCount),
    segmentBytes: split.segments.map((s) => s.length),
    firstSampleSync: segs.map((s) => s.firstSampleIsSync),
    baseDecodeTimes: segs.map((s) => s.baseDecodeTime),
    pictTypes: Array.isArray(types) ? types.map((t) => (t.key ? t.type.toUpperCase() : t.type.toLowerCase())).join('') : types,
    keyFrameIdx: Array.isArray(types) ? types.map((t, i) => (t.key ? i : -1)).filter((i) => i >= 0) : null,
    hasB: Array.isArray(types) ? types.some((t) => t.type === 'B') : null,
  };
}

const report = {
  probe: 'stream-encoder-params',
  when: new Date().toISOString(),
  env: { ffmpeg: await ffmpegVersion(ffmpeg), node: process.version, w: W, h: H, fps: FPS, repeats: REPEATS },
  stacked: { w: W, h: H * 2 + 16 },
  encoders: [],
  cases: [],
  timing: {},
};

console.log('探测本机可用编码器…');
report.encoders = await probeEncoders(ffmpeg);
for (const e of report.encoders) console.log(`  ${e.name}: ${e.ok ? 'OK' : 'NO — ' + e.error}`);

const candidates = ['libx264', 'h264_nvenc', 'h264_nvenc_ll', 'h264_qsv', 'h264_amf', 'h264_mf', 'h264_mf_sw'].filter((name) => {
  const base = name.replace(/_(ll|sw)$/, '');
  return report.encoders.find((e) => e.name === base)?.ok;
});
console.log(`要测的参数组：${candidates.join(', ')}`);

for (const encoder of candidates) {
  console.log(`\n=== ${encoder} ===`);
  console.log(`  参数：${ENCODER_ARGS[encoder](QUALITY_DEFAULT[encoder]).join(' ')}`);
  const perSegMs = [];
  let perSeg = null, longRun = null;
  for (let r = 0; r < REPEATS; r++) {
    try {
      const c = await runCase(encoder, pngs.slice(0, 15), `seg15-r${r}`);
      perSegMs.push(c.ms);
      if (r === 0) perSeg = c;
      report.cases.push(c);
    } catch (e) {
      report.cases.push({ label: `seg15-r${r}`, encoder, error: String(e.message).slice(0, 400) });
      console.log(`  per-segment 失败：${String(e.message).slice(0, 200)}`);
      break;
    }
  }
  try {
    longRun = await runCase(encoder, pngs, 'long45');
    report.cases.push(longRun);
  } catch (e) {
    report.cases.push({ label: 'long45', encoder, error: String(e.message).slice(0, 400) });
  }
  report.timing[encoder] = { perSegment15Ms: stats(perSegMs) };
  if (perSeg) {
    console.log(`  15 帧一段：${stats(perSegMs).p50} ms（${perSegMs.map((m) => m.toFixed(0)).join('/')}），${(perSeg.bytes / 1024).toFixed(0)} KB，` +
      `分段 ${perSeg.segmentCount} 个 样本 ${perSeg.segmentSamples.join(',')}，首帧同步 ${perSeg.firstSampleSync.join(',')}，codec ${perSeg.init.codec}`);
    console.log(`  帧类型：${perSeg.pictTypes}`);
  }
  if (longRun && !longRun.error) {
    console.log(`  45 帧一次：${longRun.ms} ms，分段 ${longRun.segmentCount} 个 样本 ${longRun.segmentSamples.join(',')}，关键帧位置 ${longRun.keyFrameIdx?.join(',')}`);
    console.log(`  帧类型：${longRun.pictTypes}`);
  }
}

// ── 判定 ─────────────────────────────────────────────────────────────────────
report.verdict = {};
for (const encoder of candidates) {
  const seg = report.cases.find((c) => c.encoder === encoder && c.label === 'seg15-r0' && !c.error);
  const long = report.cases.find((c) => c.encoder === encoder && c.label === 'long45' && !c.error);
  report.verdict[encoder] = {
    perSegmentOk: !!seg && seg.segmentCount === 1 && seg.segmentSamples[0] === 15 && seg.firstSampleSync[0] === true && seg.hasB === false,
    longRunOk: !!long && long.segmentCount === 3 && long.segmentSamples.every((n) => n === 15) &&
      long.firstSampleSync.every(Boolean) && long.hasB === false &&
      JSON.stringify(long.keyFrameIdx) === JSON.stringify([0, 15, 30]),
    args: ENCODER_ARGS[encoder](QUALITY_DEFAULT[encoder]),
    note: seg ? `${seg.segmentCount} 段 / 样本 ${seg.segmentSamples} / codec ${seg.init.codec}` : '未跑成',
  };
}

console.log('\n=== 判定 ===');
for (const [k, v] of Object.entries(report.verdict)) {
  console.log(`  ${k}: per-segment ${v.perSegmentOk ? 'PASS' : 'FAIL'}, long-run ${v.longRunOk ? 'PASS' : 'FAIL'}  (${v.note})`);
}

if (jsonOut) console.log(`\nJSON -> ${writeJson(String(jsonOut), report)}`);
console.log(`码流 -> ${outDir}`);
