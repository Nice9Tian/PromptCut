// Probe: WebCodecs H.264 decoding, for 目标 G 的 G0-a(1).
//
//   node scripts/probes/videodecoder-probe.mjs                -> puppeteer's own Chrome
//   node scripts/probes/videodecoder-probe.mjs --connect       -> the desktop shell's WebView2 on 9333
//   node scripts/probes/videodecoder-probe.mjs --json out.json
//
// Two halves:
//   (a) `VideoDecoder.isConfigSupported` for `avc1.640028` (High@L4.0) with
//       prefer-hardware / prefer-software / no-preference, plus the same question for
//       the 上下拼合 geometry G 实际要用的（1920x2176 一帧，Level 4.0 放不下）,
//       plus `navigator.mediaCapabilities.decodingInfo` (its `powerEfficient` is the only
//       standard signal that says a hardware decoder is really behind it).
//   (b) 真解码：ffmpeg 现做一段 H.264（编码参数照 G3：-g 15 -keyint_min 15 -sc_threshold 0
//       -bf 0 -preset veryfast -crf 16），在页面里喂给 VideoDecoder，记每帧耗时。
//       两种码流形态都跑：Annex B（无 description）和 G5 要用的 AVCC（description = avcC）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { connectArg, flagArg, openBrowser, pageFactory, serve, closeAll, sleep } from './probe-connect.mjs';

const connect = connectArg();
const jsonOut = flagArg('json');
const outDir = flagArg('out', path.join(os.tmpdir(), 'pc-videodecoder-probe'));
const PORT = Number(flagArg('port', '5241'));
const HOST = flagArg('host', '127.0.0.1');
const FPS = 30;
const FRAMES = Number(flagArg('frames', '90'));
const REPEATS = Number(flagArg('repeats', '2'));

fs.mkdirSync(outDir, { recursive: true });

// ── 1. make the clips ────────────────────────────────────────────────────────
// `aud=1` puts an access-unit delimiter in front of every AU, which makes splitting
// the elementary stream into frames unambiguous.
function encode(name, size, level) {
  const file = path.join(outDir, `${name}.h264`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${FPS}`,
    '-frames:v', String(FRAMES),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16',
    '-profile:v', 'high', '-level', level,
    '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-bf', '0',
    '-x264-params', 'aud=1',
    '-pix_fmt', 'yuv420p', '-f', 'h264', file], { stdio: ['ignore', 'ignore', 'inherit'] });
  return fs.readFileSync(file);
}

/** Split an Annex B stream into NAL units. */
function nals(buf) {
  const out = [];
  let i = 0, start = -1;
  while (i < buf.length - 3) {
    const three = buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1;
    const four = buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1;
    if (three || four) {
      const scLen = four ? 4 : 3;
      if (start >= 0) out.push({ scStart: start, body: startBody(start), end: i });
      start = i;
      i += scLen;
    } else i++;
  }
  if (start >= 0) out.push({ scStart: start, body: startBody(start), end: buf.length });
  function startBody(s) {
    return buf[s + 2] === 1 ? s + 3 : s + 4;
  }
  return out.map((n) => ({ ...n, type: buf[n.body] & 0x1f }));
}

/** Group NALs into access units on the AUD (type 9); fall back to VCL boundaries. */
function accessUnits(buf) {
  const list = nals(buf);
  const hasAud = list.some((n) => n.type === 9);
  const aus = [];
  let cur = null;
  for (const n of list) {
    const boundary = hasAud ? n.type === 9 : (n.type === 1 || n.type === 5) && cur && cur.sawVcl;
    if (!cur || boundary) { cur = { nals: [], sawVcl: false, key: false }; aus.push(cur); }
    cur.nals.push(n);
    if (n.type === 1 || n.type === 5) cur.sawVcl = true;
    if (n.type === 5) cur.key = true;
  }
  return aus.filter((a) => a.sawVcl);
}

/** avcC from the in-band SPS/PPS, plus length-prefixed samples (what G5 will feed). */
function toAvcc(buf) {
  const list = nals(buf);
  const sps = list.find((n) => n.type === 7), pps = list.find((n) => n.type === 8);
  if (!sps || !pps) throw new Error('码流里没有 SPS/PPS');
  const spsB = buf.subarray(sps.body, sps.end), ppsB = buf.subarray(pps.body, pps.end);
  const head = Buffer.from([1, spsB[1], spsB[2], spsB[3], 0xff, 0xe1, spsB.length >> 8, spsB.length & 0xff]);
  const mid = Buffer.from([1, ppsB.length >> 8, ppsB.length & 0xff]);
  const avcc = Buffer.concat([head, spsB, mid, ppsB]);
  const codec = 'avc1.' + [spsB[1], spsB[2], spsB[3]].map((b) => b.toString(16).padStart(2, '0')).join('');
  const chunks = [];
  const parts = [];
  let off = 0;
  for (const au of accessUnits(buf)) {
    const pieces = [];
    for (const n of au.nals) {
      if (n.type === 9 || n.type === 7 || n.type === 8) continue; // AUD/SPS/PPS live in avcC
      const body = buf.subarray(n.body, n.end);
      const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
      pieces.push(len, body);
    }
    const sample = Buffer.concat(pieces);
    parts.push(sample);
    chunks.push({ o: off, n: sample.length, key: au.key });
    off += sample.length;
  }
  return { avcc, codec, data: Buffer.concat(parts), chunks };
}

function toAnnexB(buf) {
  const chunks = [];
  const aus = accessUnits(buf);
  for (let i = 0; i < aus.length; i++) {
    const a = aus[i];
    const o = a.nals[0].scStart;
    const n = (i + 1 < aus.length ? aus[i + 1].nals[0].scStart : buf.length) - o;
    chunks.push({ o, n, key: a.key });
  }
  return { data: buf, chunks };
}

const clips = {};
function addClip(name, size, level) {
  const raw = encode(name, size, level);
  const avcc = toAvcc(raw);
  const annexb = toAnnexB(raw);
  const [w, h] = size.split('x').map(Number);
  clips[name] = {
    name, width: w, height: h, codec: avcc.codec, fps: FPS,
    bytes: raw.length,
    avcc: { description: avcc.avcc.toString('base64'), data: avcc.data, chunks: avcc.chunks },
    annexb: { data: annexb.data, chunks: annexb.chunks },
  };
  return clips[name];
}

console.log('ffmpeg 生成码流…');
const main = addClip('p1080', '1920x1080', '4.0');
const stacked = addClip('stacked', '1920x2176', '5.1');
console.log(`  p1080   ${main.width}x${main.height}  codec=${main.codec}  ${main.avcc.chunks.length} 帧  ${(main.bytes / 1024).toFixed(0)} KB`);
console.log(`  stacked ${stacked.width}x${stacked.height}  codec=${stacked.codec}  ${stacked.avcc.chunks.length} 帧  ${(stacked.bytes / 1024).toFixed(0)} KB\n`);

// ── 2. serve them ────────────────────────────────────────────────────────────
const PAGE = `<!doctype html><meta charset=utf-8><title>videodecoder-probe</title>
<body style="margin:0;background:#111;color:#ddd;font:14px monospace;padding:12px">
<div id=log>ready</div><script>
window.__clips = ${JSON.stringify(Object.fromEntries(Object.entries(clips).map(([k, c]) =>
  [k, { width: c.width, height: c.height, codec: c.codec, fps: c.fps, frames: c.avcc.chunks.length }])))};
const cache = new Map();
window.__load = async (clip, fmt) => {
  const key = clip + '/' + fmt;
  if (!cache.has(key)) {
    const [bin, meta] = await Promise.all([
      fetch('/clip/' + key + '.bin').then(r => r.arrayBuffer()),
      fetch('/clip/' + key + '.json').then(r => r.json()),
    ]);
    cache.set(key, { bytes: new Uint8Array(bin), meta });
  }
  return cache.get(key);
};
</script></body>`;

const servers = [await serve(PORT, (req, res) => {
  const u = new URL(req.url, 'http://x');
  const m = /^\/clip\/([a-z0-9]+)\/(avcc|annexb)\.(bin|json)$/.exec(u.pathname);
  if (m) {
    const c = clips[m[1]]; if (!c) { res.writeHead(404); return res.end(); }
    const part = c[m[2]];
    if (m[3] === 'bin') { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }); return res.end(part.data); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ chunks: part.chunks, description: part.description ?? null, codec: c.codec, width: c.width, height: c.height, fps: c.fps }));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(PAGE);
})];

// ── 3. in-page work ──────────────────────────────────────────────────────────
const SUPPORT = async (specs) => {
  const out = [];
  for (const s of specs) {
    const cfg = { codec: s.codec };
    if (s.width) { cfg.codedWidth = s.width; cfg.codedHeight = s.height; }
    if (s.hw) cfg.hardwareAcceleration = s.hw;
    if (s.latency !== undefined) cfg.optimizeForLatency = s.latency;
    let r;
    try {
      const sup = await VideoDecoder.isConfigSupported(cfg);
      r = { supported: sup.supported, echoed: JSON.parse(JSON.stringify(sup.config ?? null)) };
    } catch (e) { r = { error: String(e && e.message || e) }; }
    let mc = null;
    if (s.width) {
      try {
        mc = await navigator.mediaCapabilities.decodingInfo({
          type: 'file',
          video: { contentType: `video/mp4; codecs="${s.codec}"`, width: s.width, height: s.height, bitrate: 8_000_000, framerate: 30 },
        });
        mc = { supported: mc.supported, smooth: mc.smooth, powerEfficient: mc.powerEfficient };
      } catch (e) { mc = { error: String(e && e.message || e) }; }
    }
    out.push({ ...s, ...r, mediaCapabilities: mc });
  }
  return out;
};

const DECODE = async ({ clip, fmt, hw, paced, latency, count }) => {
  const { bytes, meta } = await window.__load(clip, fmt);
  const cfg = { codec: meta.codec, codedWidth: meta.width, codedHeight: meta.height, hardwareAcceleration: hw };
  if (latency !== undefined) cfg.optimizeForLatency = latency;
  if (fmt === 'avcc') cfg.description = Uint8Array.from(atob(meta.description), (c) => c.charCodeAt(0));
  const sup = await VideoDecoder.isConfigSupported(cfg);
  if (!sup.supported) return { unsupported: true, cfgCodec: meta.codec };

  const outTimes = [], dims = new Set();
  let err = null, resolveOne = null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      outTimes.push(performance.now());
      dims.add(frame.codedWidth + 'x' + frame.codedHeight);
      frame.close();
      if (resolveOne) { const r = resolveOne; resolveOne = null; r(); }
    },
    error: (e) => { err = String(e && e.message || e); if (resolveOne) { const r = resolveOne; resolveOne = null; r(); } },
  });
  decoder.configure(cfg);

  const n = Math.min(count, meta.chunks.length);
  const submit = [];
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const c = meta.chunks[i];
    submit.push(performance.now());
    decoder.decode(new EncodedVideoChunk({
      type: c.key ? 'key' : 'delta',
      timestamp: Math.round(i * 1e6 / meta.fps),
      duration: Math.round(1e6 / meta.fps),
      data: bytes.subarray(c.o, c.o + c.n),
    }));
    if (paced) {
      const want = outTimes.length + 1;
      while (outTimes.length < want && !err) await new Promise((r) => { resolveOne = r; setTimeout(r, 2000); });
    }
  }
  await decoder.flush();
  const t1 = performance.now();
  decoder.close();
  if (err) return { error: err, frames: outTimes.length };

  const lat = outTimes.map((t, i) => t - submit[i]);
  const gaps = outTimes.slice(1).map((t, i) => t - outTimes[i]);
  const stat = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { min: +s[0].toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2), mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) };
  };
  return {
    frames: outTimes.length, dims: [...dims],
    firstFrameMs: +(outTimes[0] - t0).toFixed(2),
    totalMs: +(t1 - t0).toFixed(2),
    fps: +(outTimes.length / (t1 - t0) * 1000).toFixed(1),
    perFrameLatencyMs: stat(lat),
    outputGapMs: stat(gaps),
  };
};

// ── 4. run ───────────────────────────────────────────────────────────────────
const { browser, mode, close } = await openBrowser({ connect, launch: { headless: false, args: ['--window-size=700,400'] } });
const version = await browser.version();
const factory = await pageFactory(browser, mode);
const handle = await factory.fresh();
const page = handle.page;
const report = { probe: 'videodecoder', mode, browser: version, when: new Date().toISOString(),
  clips: Object.fromEntries(Object.entries(clips).map(([k, c]) => [k, { width: c.width, height: c.height, codec: c.codec, frames: c.avcc.chunks.length, bytes: c.bytes }])) };

try {
  await page.goto(`http://${HOST}:${PORT}/`, { waitUntil: 'load' });
  report.env = await page.evaluate(() => ({
    ua: navigator.userAgent,
    uaData: navigator.userAgentData ? JSON.parse(JSON.stringify(navigator.userAgentData.brands)) : null,
    hasVideoDecoder: typeof VideoDecoder !== 'undefined',
    hasMediaCapabilities: !!(navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo),
    dpr: devicePixelRatio,
  }));
  console.log(`videodecoder-probe  mode=${mode}  browser=${version}`);
  console.log(`VideoDecoder=${report.env.hasVideoDecoder}  UA=${report.env.ua}\n`);
  if (!report.env.hasVideoDecoder) throw new Error('这个浏览器没有 VideoDecoder');

  // (a) isConfigSupported matrix
  const specs = [];
  for (const hw of ['prefer-hardware', 'prefer-software', 'no-preference', undefined]) {
    specs.push({ label: `avc1.640028 (任务书原文)`, codec: 'avc1.640028', hw });
    specs.push({ label: `avc1.640028 1920x1080`, codec: 'avc1.640028', width: 1920, height: 1080, hw });
    specs.push({ label: `avc1.640028 1920x2176 (G 的上下拼合)`, codec: 'avc1.640028', width: 1920, height: 2176, hw });
    specs.push({ label: `${stacked.codec} 1920x2176`, codec: stacked.codec, width: 1920, height: 2176, hw });
  }
  report.isConfigSupported = await page.evaluate(SUPPORT, specs);
  for (const r of report.isConfigSupported) {
    const mc = r.mediaCapabilities;
    console.log(`  ${String(r.hw ?? '(未指定)').padEnd(16)} ${r.label.padEnd(36)} supported=${r.supported}${r.error ? ' ERR ' + r.error : ''}` +
      `${mc ? `  mediaCapabilities: supported=${mc.supported} smooth=${mc.smooth} powerEfficient=${mc.powerEfficient}` : ''}`);
  }

  // (b) real decode
  console.log('\n真解码:');
  report.decode = [];
  const runs = [];
  for (const fmt of ['avcc', 'annexb']) {
    for (const hw of ['prefer-hardware', 'prefer-software']) {
      runs.push({ clip: 'p1080', fmt, hw, paced: false, count: FRAMES, label: `1080p ${fmt} ${hw} burst` });
      runs.push({ clip: 'p1080', fmt, hw, paced: true, latency: true, count: 30, label: `1080p ${fmt} ${hw} paced(optimizeForLatency)` });
    }
  }
  runs.push({ clip: 'stacked', fmt: 'avcc', hw: 'prefer-hardware', paced: false, count: FRAMES, label: `1920x2176 avcc prefer-hardware burst` });
  runs.push({ clip: 'stacked', fmt: 'avcc', hw: 'prefer-software', paced: false, count: FRAMES, label: `1920x2176 avcc prefer-software burst` });

  for (const r of runs) {
    const reps = [];
    for (let i = 0; i < REPEATS; i++) {
      reps.push(await page.evaluate(DECODE, r));
      await sleep(250);
    }
    report.decode.push({ ...r, reps });
    const fmtOne = (x) => x.unsupported ? 'UNSUPPORTED' : x.error ? 'ERR ' + x.error
      : `${x.frames}帧 ${x.dims.join(',')} first=${x.firstFrameMs}ms total=${x.totalMs}ms (${x.fps} fps) 每帧latency p50=${x.perFrameLatencyMs.p50} p95=${x.perFrameLatencyMs.p95} max=${x.perFrameLatencyMs.max} 出帧间隔 p50=${x.outputGapMs.p50} max=${x.outputGapMs.max}`;
    console.log(`  ${r.label}`);
    reps.forEach((x, i) => console.log(`    run${i + 1}: ${fmtOne(x)}`));
  }
} finally {
  await factory.release(handle);
  await close();
  await closeAll(servers);
}

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
console.log(`\n码流: ${outDir}${jsonOut ? `\nJSON: ${jsonOut}` : ''}`);
