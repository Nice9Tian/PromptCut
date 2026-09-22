// 探针:音频图卡判重(轻 / 重分类)方案的三组前提实测。计划见 restructure_planning/audio_determine_plan.md。
//
//   node scripts/probes/audio-determine-probe.mjs                  -> puppeteer 自带的 Chrome
//   node scripts/probes/audio-determine-probe.mjs --connect        -> 桌面壳 WebView2(9333)
//   node scripts/probes/audio-determine-probe.mjs --json out.json  -> 结果另存一份 JSON
//   --port 5231(缺省)  --seconds 60(每张卡的片段长度)  --only cost|codec|chunk
//   --serve-only --host 0.0.0.0  -> 只起页面不开浏览器,给 iPad Safari 之类手动打开 http://<本机IP>:5231/ ,结果看 window.__probe
//
// 三组:
//   (A) cost  —— 七张合成音频图卡在 Worker 里逐块求值(块 = 0.5 s),量整趟每块耗时(实时倍率 RTF =
//                 计算耗时 / 这块声音时长),再用「随机抽 16 块取 p90」估一遍,看抽样估计和整趟真值差多少。
//   (B) codec —— WebCodecs AudioEncoder / AudioDecoder 支持哪些编码;AAC / Opus 编解码往返的速度和误差。
//   (C) chunk —— 真的 src/audio/fxChain.ts 效果链:一次渲完 vs 分段(10 s 一段)+ 不同预滚时长,接缝误差多大。
//
// 结果(2026-09-23,Chrome 152)存在 restructure_planning/reports/audio-probe-2026-09-23.json。
//
// 误差两个口径:maxRel = max|a−b| / peak(a)(「最大差 8%」按这个读),rmsDb = 20·log10(rms(a−b) / rms(a))。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { connectArg, flagArg, openBrowser, pageFactory, serve, closeAll } from './probe-connect.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(flagArg('port', '5231'));
const SECONDS = Number(flagArg('seconds', '60'));
const ONLY = flagArg('only', null);
const JSON_OUT = flagArg('json', null);
const HOST = flagArg('host', '127.0.0.1');
const SERVE_ONLY = process.argv.includes('--serve-only');

// ── 把真的效果链搬进一个静态目录:fxChain.ts 去类型、改 import 路径 ─────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-audio-probe-'));
const fxTs = fs.readFileSync(path.join(ROOT, 'src/audio/fxChain.ts'), 'utf8');
fs.writeFileSync(path.join(dir, 'fxChain.js'), stripTypeScriptTypes(fxTs).replace('"../kernel/audioFx.mjs"', '"./audioFx.mjs"'));
for (const f of ['audioFx.mjs', 'filters.mjs']) fs.copyFileSync(path.join(ROOT, 'src/kernel', f), path.join(dir, f));

// ── 合成音频图卡:签名和 CardDef.audio 一样 (sources, { start, count, sampleRate }, params) → 交错 Float32 ──
// 写成字符串,原样塞进 Worker。source 输入是确定性噪声(模拟已解码的素材,取样本身不计成本)。
const CARDS = String.raw`
const TAU = Math.PI * 2;
const CARDS = {
  // 1. 正弦:最便宜的一档
  sine: { inputs: [], async audio(s, r) {
    const out = new Float32Array(r.count * 2);
    for (let i = 0; i < r.count; i++) { const v = 0.3 * Math.sin(TAU * 440 * (r.start + i) / r.sampleRate); out[2 * i] = v; out[2 * i + 1] = v; }
    return out;
  } },
  // 2. 64 个分音的加法合成:中等
  additive64: { inputs: [], async audio(s, r) {
    const out = new Float32Array(r.count * 2);
    for (let i = 0; i < r.count; i++) {
      const t = (r.start + i) / r.sampleRate; let v = 0;
      for (let k = 1; k <= 64; k++) v += Math.sin(TAU * 110 * k * t) / k;
      out[2 * i] = 0.2 * v; out[2 * i + 1] = 0.2 * v;
    }
    return out;
  } },
  // 3 / 4. FIR 卷积:要往前多取 taps−1 个样本(随机访问,但每块代价固定)
  fir1024: { inputs: ['source'], async audio(s, r) { return fir(await s.source.block(r.start - 1023, r.count + 1023), r.count, 1024); } },
  fir4096: { inputs: ['source'], async audio(s, r) { return fir(await s.source.block(r.start - 4095, r.count + 4095), r.count, 4096); } },
  // 5. 有状态、从 0 推起:一阶低通每块都从片段开头重算 —— 代价随位置线性涨(对应 pinned 渲染 4 的长 motion)
  iirFromZero: { inputs: ['source'], async audio(s, r) {
    const all = await s.source.block(0, r.start + r.count), out = new Float32Array(r.count * 2);
    let l = 0, rr = 0; const a = 0.01;
    for (let i = 0; i < r.start + r.count; i++) {
      l += a * (all[2 * i] - l); rr += a * (all[2 * i + 1] - rr);
      if (i >= r.start) { out[2 * (i - r.start)] = l; out[2 * (i - r.start) + 1] = rr; }
    }
    return out;
  } },
  // 6. 卡接卡:additive64 的输出再过 fir1024(代价相加)
  chain: { inputs: ['upstream'], async audio(s, r) { return fir(await s.upstream.block(r.start - 1023, r.count + 1023), r.count, 1024); } },
  // 7. 尖刺:平时正弦,每 10 秒里有 1 秒做一次 fir4096 —— 代价随位置非单调
  spiky: { inputs: ['source'], async audio(s, r) {
    const sec = Math.floor(r.start / r.sampleRate);
    if (sec % 10 === 7) return fir(await s.source.block(r.start - 4095, r.count + 4095), r.count, 4096);
    return CARDS.sine.audio(s, r);
  } },
  // 8. 尾部突变:片段最后 1 秒改做 fir16384(RTF ≈ 0.8),之前都是正弦 —— 抽样几乎一定漏掉
  tailSpike: { inputs: ['source'], async audio(s, r) {
    if (r.start >= r.clipFrames - r.sampleRate) return fir(await s.source.block(r.start - 16383, r.count + 16383), r.count, 16384);
    return CARDS.sine.audio(s, r);
  } },
  // 9. 不纯:相位存在闭包里、跨调用累加 —— 同一段换一种切块方式结果就变(违反「按区间随机访问」的约定)
  impure: { inputs: [], async audio(s, r) {
    const out = new Float32Array(r.count * 2);
    for (let i = 0; i < r.count; i++) { IMPURE.phase += TAU * 440 / r.sampleRate; const v = 0.3 * Math.sin(IMPURE.phase); out[2 * i] = v; out[2 * i + 1] = v; }
    return out;
  } },
};
const IMPURE = { phase: 0 };
function fir(x, count, taps) {
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    let l = 0, rr = 0;
    for (let k = 0; k < taps; k++) { const w = 1 / taps; l += w * x[2 * (i + taps - 1 - k)]; rr += w * x[2 * (i + taps - 1 - k) + 1]; }
    out[2 * i] = l; out[2 * i + 1] = rr;
  }
  return out;
}
// 确定性噪声:第 n 个样本只由 n 决定(随机访问一致)
function noiseAt(n) { let x = (n * 2654435761) >>> 0; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return (x / 4294967296) * 2 - 1; }
function sourcesOf(card, sampleRate) {
  const out = {};
  for (const name of card.inputs) {
    out[name] = name === 'upstream'
      ? { block: (start, count) => CARDS.additive64.audio({}, { start, count, sampleRate }) }
      : { block: async (start, count) => { const b = new Float32Array(count * 2); for (let i = 0; i < count; i++) { const v = 0.5 * noiseAt(start + i); b[2 * i] = v; b[2 * i + 1] = -v; } return b; } };
  }
  return out;
}
`;

const WORKER = CARDS + String.raw`
self.onmessage = async (e) => {
  const { id, start, count, sampleRate, clipFrames, split } = e.data;
  const card = CARDS[id];
  if (split) {
    // 分块无关性:同一段整块算一次、切成 split 份再算一次,逐样本比
    const whole = await card.audio(sourcesOf(card, sampleRate), { start, count, sampleRate, clipFrames });
    const step = Math.ceil(count / split), parts = new Float32Array(count * 2);
    for (let at = 0; at < count; at += step) {
      const n = Math.min(step, count - at);
      parts.set(await card.audio(sourcesOf(card, sampleRate), { start: start + at, count: n, sampleRate, clipFrames }), at * 2);
    }
    let same = true; for (let i = 0; i < whole.length; i++) if (whole[i] !== parts[i]) { same = false; break; }
    self.postMessage({ same });
    return;
  }
  const t0 = performance.now();
  const s = sourcesOf(card, sampleRate);
  // source 取样的成本单独扣掉:真实素材解码另算(见 B 组)
  const t1 = performance.now();
  const out = await card.audio(s, { start, count, sampleRate, clipFrames });
  const ms = performance.now() - t1 + (t1 - t0);
  self.postMessage({ ms, n: out.length });
};
`;

const PAGE = String.raw`<!doctype html><meta charset="utf-8"><title>audio-determine-probe</title>
<script type="module">
import { buildFxChain } from './fxChain.js';
import { normalizeAudioFxDef } from './audioFx.mjs';
const SR = 48000;
const q = new URLSearchParams(location.search);
const SECONDS = Number(q.get('seconds') || 60), ONLY = q.get('only') || '';
const res = { ua: navigator.userAgent, hw: navigator.hardwareConcurrency };

const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(p / 100 * a.length) - 1)]; };
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

// ── (A) 成本 ──────────────────────────────────────────────────────────────────────
async function costCase() {
  const worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(WORKER)}], { type: 'text/javascript' })));
  const clipFrames = SECONDS * SR;
  const call = (id, start, count) => new Promise((ok) => { worker.onmessage = (e) => ok(e.data.ms); worker.postMessage({ id, start, count, sampleRate: SR, clipFrames }); });
  const pure = (id) => new Promise((ok) => { worker.onmessage = (e) => ok(e.data.same); worker.postMessage({ id, start: 10 * SR, count: SR / 2, sampleRate: SR, clipFrames, split: 7 }); });
  const BLOCK = SR / 2, blocks = Math.floor(SECONDS * 2), blockMs = 500;
  const out = {};
  for (const id of ['sine', 'additive64', 'fir1024', 'fir4096', 'iirFromZero', 'chain', 'spiky', 'tailSpike', 'impure']) {
    const cold = await call(id, 0, BLOCK);                       // 第一块(JIT 冷)
    const full = [];
    for (let b = 0; b < blocks; b++) full.push(await call(id, b * BLOCK, BLOCK));
    const rtf = full.map((ms) => ms / blockMs);
    // 2 秒滑动窗口(= 播放缓冲提前量)里的平均 RTF 最大值:缓冲吸收得了单块尖刺,吸收不了持续 2 秒的
    let win = 0; for (let b = 0; b + 4 <= rtf.length; b++) win = Math.max(win, (rtf[b] + rtf[b + 1] + rtf[b + 2] + rtf[b + 3]) / 4);
    // 抽样估计:5 组种子,每组随机 16 块取 p90(对应画面卡「抽 16 帧取 p90」)
    const est = [];
    for (let seed = 1; seed <= 5; seed++) {
      const r = rng(seed * 7919), picks = [];
      for (let k = 0; k < 16; k++) picks.push(await call(id, Math.floor(r() * blocks) * BLOCK, BLOCK) / blockMs);
      est.push(pct(picks, 90));
    }
    // 最后一块单测一次(有状态卡的最差位置)
    const last = (await call(id, (blocks - 1) * BLOCK, BLOCK)) / blockMs;
    out[id] = {
      coldFirstBlockMs: +cold.toFixed(2),
      totalRtf: +(full.reduce((a, b) => a + b, 0) / (SECONDS * 1000)).toFixed(4),
      p50Rtf: +pct(rtf, 50).toFixed(4), p90Rtf: +pct(rtf, 90).toFixed(4), maxRtf: +Math.max(...rtf).toFixed(4),
      lastBlockRtf: +last.toFixed(4),
      maxWindow2sRtf: +win.toFixed(4),
      pure: await pure(id),
      sampledP90Rtf: est.map((v) => +v.toFixed(4)),
    };
  }
  worker.terminate();
  return out;
}

// ── 测试信号:60 s 立体声,音调 + 断续噪声段 + 静音段(让压缩器 / 混响都有活干)──────────────
function testSignal(seconds, noise = 1) {
  const n = Math.floor(seconds * SR), L = new Float32Array(n), R = new Float32Array(n);
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR, gate = (t % 0.73) < 0.2 ? 1 : 0, quiet = (t % 11) > 9 ? 0 : 1;
    const v = quiet * (0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.15 * Math.sin(2 * Math.PI * 1760 * t) + 0.4 * noise * gate * rnd());
    L[i] = v; R[i] = 0.8 * v + 0.05 * noise * rnd() * quiet;
  }
  return [L, R];
}
function metrics(refCh, gotCh, from = 0, to = refCh[0].length) {
  let peak = 0, maxd = 0, se = 0, sr = 0, n = 0;
  for (let c = 0; c < refCh.length; c++) for (let i = from; i < to; i++) {
    const a = refCh[c][i], b = gotCh[c][i] ?? 0, d = Math.abs(a - b);
    if (Math.abs(a) > peak) peak = Math.abs(a); if (d > maxd) maxd = d; se += d * d; sr += a * a; n++;
  }
  return { maxRel: +(maxd / Math.max(peak, 1e-9)).toExponential(3), rmsDb: +(10 * Math.log10(Math.max(se, 1e-30) / Math.max(sr, 1e-30))).toFixed(1) };
}

// ── (B) WebCodecs ─────────────────────────────────────────────────────────────────
async function codecCase() {
  const out = { encoder: {}, decoder: {}, roundtrip: {} };
  if (!('AudioEncoder' in self)) return { error: 'no WebCodecs audio' };
  const base = { sampleRate: SR, numberOfChannels: 2 };
  for (const codec of ['opus', 'mp4a.40.2', 'flac', 'mp3', 'vorbis', 'pcm-f32', 'pcm-s16']) {
    out.encoder[codec] = await AudioEncoder.isConfigSupported({ ...base, codec, bitrate: 192000 }).then((r) => r.supported).catch((e) => 'throw:' + e.name);
    out.decoder[codec] = await AudioDecoder.isConfigSupported({ ...base, codec }).then((r) => r.supported).catch((e) => 'throw:' + e.name);
  }
  // 预渲染结果的存储形态:f32 原样 / s16 / s16 + 浏览器自带 CompressionStream(不用装库)
  out.storage = {};
  for (const sigName of ['music', 'tonal']) {
    const [L, R] = testSignal(30, sigName === 'music' ? 1 : 0), n = L.length;
    const s16 = new Int16Array(n * 2); let maxq = 0, peak = 0;
    for (let i = 0; i < n; i++) for (const [c, x] of [[0, L[i]], [1, R[i]]]) { const q = Math.max(-32768, Math.min(32767, Math.round(x * 32767))); s16[2 * i + c] = q; maxq = Math.max(maxq, Math.abs(q / 32767 - x)); peak = Math.max(peak, Math.abs(x)); }
    const deflate = async (buf, fmt) => new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new CompressionStream(fmt))).arrayBuffer()).length;
    out.storage[sigName] = { f32Bytes: n * 8, s16Bytes: n * 4, s16DeflateBytes: await deflate(s16, 'deflate-raw'), s16MaxRel: +(maxq / peak).toExponential(2), bytesPerSecF32: 384000 };
  }
  for (const sigName of ['music', 'tonal']) {
  const [L, R] = testSignal(30, sigName === 'music' ? 1 : 0);
  for (const [codec, bitrate, extra] of [['opus', 128000, {}], ['mp4a.40.2', 192000, { aac: { format: 'adts' } }]]) {
    if (out.encoder[codec] !== true || out.decoder[codec] !== true) { out.roundtrip[sigName + ':' + codec] = 'unsupported'; continue; }
    try {
      const chunks = []; let decCfg = null;
      const enc = new AudioEncoder({ output: (c, meta) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); chunks.push({ type: c.type, timestamp: c.timestamp, duration: c.duration, data: b }); if (meta?.decoderConfig) decCfg = meta.decoderConfig; }, error: (e) => { throw e; } });
      enc.configure({ ...base, codec, bitrate, ...extra });
      const t0 = performance.now(), F = 4800;
      for (let i = 0; i < L.length; i += F) {
        const n = Math.min(F, L.length - i), planar = new Float32Array(n * 2);
        planar.set(L.subarray(i, i + n), 0); planar.set(R.subarray(i, i + n), n);
        enc.encode(new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i / SR * 1e6), data: planar }));
      }
      await enc.flush(); const encMs = performance.now() - t0; enc.close();
      const bytes = chunks.reduce((a, c) => a + c.data.length, 0);
      const dL = [], dR = [];
      const dec = new AudioDecoder({ output: (d) => { const n = d.numberOfFrames, a = new Float32Array(n), b = new Float32Array(n);
        d.copyTo(a, { planeIndex: 0, format: 'f32-planar' }); d.copyTo(b, { planeIndex: Math.min(1, d.numberOfChannels - 1), format: 'f32-planar' }); dL.push(a); dR.push(b); d.close(); }, error: (e) => { throw e; } });
      dec.configure(decCfg || { ...base, codec });
      const t1 = performance.now();
      for (const c of chunks) dec.decode(new EncodedAudioChunk({ type: c.type, timestamp: c.timestamp, duration: c.duration, data: c.data }));
      await dec.flush(); const decMs = performance.now() - t1; dec.close();
      const cat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0), o = new Float32Array(n); let at = 0; for (const p of parts) { o.set(p, at); at += p.length; } return o; };
      const gL = cat(dL), gR = cat(dR);
      // 编码器延迟(priming):在 0..4096 里找最相关的偏移。窗口要落在噪声段里(1.46 s 起正好是一段噪声的开头),
      // 纯音调窗口按周期会对出一串等价的偏移
      let best = 0, bestV = -Infinity; const w0 = Math.round(1.46 * SR);
      for (let lag = 0; lag <= 4096; lag += 1) { let s = 0; for (let i = w0; i < w0 + 9600; i++) s += L[i] * (gL[i + lag] ?? 0); if (s > bestV) { bestV = s; best = lag; } }
      const shifted = [gL.subarray(best), gR.subarray(best)];
      const n = Math.min(L.length, shifted[0].length) - SR;
      out.roundtrip[sigName + ':' + codec] = { bitrate, bytes, encRtf: +(encMs / 30000).toFixed(4), decRtf: +(decMs / 30000).toFixed(4), primingSamples: best,
        decodedFrames: gL.length, ...metrics([L, R], shifted, SR, n) };
    } catch (e) { out.roundtrip[sigName + ':' + codec] = 'error: ' + e.message; }
  }
  }
  return out;
}

// ── (C) 分段渲染 + 预滚 vs 一次渲完(真的 fxChain)──────────────────────────────────────
const FX = {
  voice: { name: 'voice', ops: [{ kind: 'highpass', freq: 100 }, { kind: 'peaking', freq: 3000, q: 1, db: 3 }, { kind: 'compressor', threshold: -24, ratio: 3 }] },
  longTail: { name: 'longTail', ops: [{ kind: 'delay', time: 0.4, feedback: 0.6, mix: 0.4 }, { kind: 'reverb', decay: 2, mix: 0.3 }, { kind: 'limiter', ceiling: -1 }] },
  all: { name: 'all', ops: [{ kind: 'highpass', freq: 100 }, { kind: 'compressor' }, { kind: 'delay' }, { kind: 'reverb' }, { kind: 'limiter' }] },
};
async function renderRange(sig, def, from, len) {
  const ctx = new OfflineAudioContext(2, len, SR);
  const buf = ctx.createBuffer(2, len, SR);
  buf.copyToChannel(sig[0].subarray(from, from + len), 0); buf.copyToChannel(sig[1].subarray(from, from + len), 1);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const chain = buildFxChain(ctx, def, undefined, len / SR, false);
  src.connect(chain.input); chain.output.connect(ctx.destination); chain.setTime(0, len / SR, 0, false);
  src.start(0);
  const out = await ctx.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}
async function chunkCase() {
  const sig = testSignal(SECONDS), N = sig[0].length, W = 10 * SR, out = {};
  for (const [name, raw] of Object.entries(FX)) {
    const def = { id: name, ...normalizeAudioFxDef(raw) };
    const t0 = performance.now();
    const whole = await renderRange(sig, def, 0, N);
    const again = await renderRange(sig, def, 0, N);
    const oneShotMs = performance.now() - t0;
    const row = { oneShotMs: +(oneShotMs / 2).toFixed(1), deterministic: metrics(whole, again).maxRel === 0, preroll: {} };
    for (const P of [0, 0.25, 0.5, 1, 2, 4, 8]) {
      const pre = Math.round(P * SR), got = [new Float32Array(N), new Float32Array(N)];
      const t1 = performance.now();
      for (let s = 0; s < N; s += W) {
        const from = Math.max(0, s - pre), len = Math.min(N, s + W) - from, part = await renderRange(sig, def, from, len);
        got[0].set(part[0].subarray(s - from), s); got[1].set(part[1].subarray(s - from), s);
      }
      row.preroll[P + 's'] = { ...metrics(whole, got), ms: +(performance.now() - t1).toFixed(1) };
    }
    out[name] = row;
  }
  return out;
}

try {
  if (!ONLY || ONLY === 'cost') res.cost = await costCase();
  if (!ONLY || ONLY === 'codec') res.codec = await codecCase();
  if (!ONLY || ONLY === 'chunk') res.chunk = await chunkCase();
} catch (e) { res.error = String(e && e.stack || e); }
window.__probe = res;
</script>`;

const server = await serve(PORT, (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' ) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  const file = path.join(dir, path.basename(url.pathname));
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
}, HOST);

if (SERVE_ONLY) {
  console.log(`页面在 http://${HOST}:${PORT}/?seconds=${SECONDS} ,Ctrl+C 退出`);
  await new Promise(() => {});
}

const connect = connectArg();
const b = await openBrowser({ connect, launch: { headless: true, args: ['--autoplay-policy=no-user-gesture-required'] } });
const pages = await pageFactory(b.browser, b.mode);
const h = await pages.fresh();
let result;
try {
  h.page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
  await h.page.goto(`http://127.0.0.1:${PORT}/?seconds=${SECONDS}${ONLY ? '&only=' + ONLY : ''}`, { waitUntil: 'load' });
  await h.page.waitForFunction(() => window.__probe, { timeout: 20 * 60_000, polling: 500 });
  result = await h.page.evaluate(() => window.__probe);
} finally {
  await pages.release(h); await b.close(); await closeAll([server]);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
