// G0-b (9)：fMP4 切分。Node 端按 MP4 box 切出 init.mp4（ftyp+moov）和逐分段文件
// （moof+mdat），丢 mfra；验证
//   - 同一条流后续分段的 init 逐字节相同（r75-05 非阻塞 3.4：不同就要换流签名）
//   - 页面里只拿 init.mp4 + 任意一个分段就能从该分段首帧解码（随机访问成立）
//   - codec 串从 avcC 拼（G0-a 发现实际是 avc1.6400xx，不是写死的 640028）
//
//   node scripts/probes/stream-fmp4-split.mjs --json out.json
//   node scripts/probes/stream-fmp4-split.mjs --segments 5 --encoder libx264 --w 1920 --h 1080
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findFfmpeg, ffmpegVersion, encodeSegment, splitFmp4, segmentInfo, initInfo,
  syntheticFrame, encodePng, even, writeJson, arg,
} from './stream-common.mjs';
import { openBrowser, pageFactory, serve, closeAll } from './probe-connect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const W = even(Number(arg('w', '1920')));
const H = even(Number(arg('h', '1080')));
const FPS = Number(arg('fps', '30'));
const SEGMENTS = Number(arg('segments', '5'));
const ENCODER = String(arg('encoder', 'libx264'));
const PORT = Number(arg('port', '5243'));
const outDir = String(arg('out', path.join(os.tmpdir(), 'pc-stream-fmp4')));
const jsonOut = arg('json');
const connect = process.argv.includes('--connect') ? 'http://127.0.0.1:9333' : null;

const streamDir = path.join(outDir, 'stream-1');
fs.rmSync(streamDir, { recursive: true, force: true });
fs.mkdirSync(streamDir, { recursive: true });

const ffmpeg = findFfmpeg();
const report = {
  probe: 'stream-fmp4-split',
  when: new Date().toISOString(),
  env: { ffmpeg: await ffmpegVersion(ffmpeg), node: process.version, w: W, h: H, fps: FPS, encoder: ENCODER, segments: SEGMENTS },
  nodeSide: { segments: [] },
  browserSide: null,
  verdict: {},
};

// ── Node 端：每个分段一次 ffmpeg 调用（G3 的设计），各自按 box 切 ───────────
console.log(`编码 ${SEGMENTS} 个分段（每段 15 帧，${W}x${H} -> ${W}x${H * 2 + 16}），编码器 ${ENCODER}…`);
const inits = [];
for (let s = 0; s < SEGMENTS; s++) {
  const pngs = [];
  for (let i = 0; i < 15; i++) pngs.push(encodePng(syntheticFrame(W, H, s * 15 + i), W, H));
  const res = await encodeSegment(ffmpeg, pngs, { encoder: ENCODER, fps: FPS });
  const split = splitFmp4(res.buffer);
  if (split.segments.length !== 1) console.log(`  !! 第 ${s} 段切出了 ${split.segments.length} 个分段`);
  inits.push(split.init);
  const segFile = path.join(streamDir, `seg-${String(s).padStart(3, '0')}.m4s`);
  fs.writeFileSync(segFile, split.segments[0]);
  const info = segmentInfo(split.segments[0]);
  report.nodeSide.segments.push({
    index: s, encodeMs: res.ms, rawBytes: res.buffer.length,
    initBytes: split.init.length, segBytes: split.segments[0].length,
    boxes: split.boxes, dropped: split.dropped,
    sampleCount: info.sampleCount, firstSampleIsSync: info.firstSampleIsSync, baseDecodeTime: info.baseDecodeTime,
  });
  console.log(`  seg ${s}: ${res.ms} ms, 分段 ${(split.segments[0].length / 1024).toFixed(0)} KB, init ${split.init.length} B, ` +
    `样本 ${info.sampleCount}, 首帧同步 ${info.firstSampleIsSync}, 丢掉 ${JSON.stringify(split.dropped)}`);
}

// init.mp4 只写一次，后续必须逐字节相同
fs.writeFileSync(path.join(streamDir, 'init.mp4'), inits[0]);
const initIdentical = inits.every((b) => b.equals(inits[0]));
const info0 = initInfo(inits[0]);
report.nodeSide.init = { ...info0, bytes: inits[0].length, identicalAcrossSegments: initIdentical };
report.nodeSide.initHashes = inits.map((b) => b.length + ':' + [...b.subarray(0, 16)].map((x) => x.toString(16)).join(''));
console.log(`\ninit.mp4 ${inits[0].length} B，codec ${info0.codec}，${info0.width}x${info0.height}，timescale ${info0.timescale}`);
console.log(`后续分段的 init 逐字节相同：${initIdentical ? 'YES' : 'NO'}`);
if (!initIdentical) {
  const firstDiff = inits.map((b, i) => {
    if (i === 0) return null;
    if (b.length !== inits[0].length) return `长度 ${b.length} != ${inits[0].length}`;
    for (let k = 0; k < b.length; k++) if (b[k] !== inits[0][k]) return `第 ${k} 字节 ${b[k]} != ${inits[0][k]}`;
    return null;
  }).filter(Boolean);
  report.nodeSide.initDiffs = firstDiff;
  console.log(`  差异：${firstDiff.join('; ')}`);
}

// ── 页面端：init + 任意一个分段 -> 随机访问 ─────────────────────────────────
const server = await serve(PORT, (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><meta charset="utf-8"><title>fmp4 split probe</title><body></body>');
  }
  const file = path.join(streamDir, path.basename(url.pathname));
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}, '127.0.0.1');

const { browser, mode, close } = await openBrowser({
  connect,
  launch: { headless: true, args: ['--enable-features=SharedArrayBuffer'] },
});
const factory = await pageFactory(browser, mode);
const handle = await factory.fresh();
const page = handle.page;

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.addScriptTag({ path: path.join(here, 'stream-demux-browser.js') });

  // 每个分段各单独开一个 VideoDecoder，只喂 init + 它自己。
  const browserSide = await page.evaluate(async (opts) => {
    const { segments, fps, contentH } = opts;
    const initBuf = await (await fetch('init.mp4')).arrayBuffer();
    const init = PCStream.parseInit(initBuf);
    const support = await VideoDecoder.isConfigSupported({
      codec: init.codec, description: init.description,
      codedWidth: init.width, codedHeight: init.height, hardwareAcceleration: 'prefer-hardware',
    });
    const out = { codec: init.codec, width: init.width, height: init.height, naluLengthSize: init.naluLengthSize, supported: support.supported, cases: [] };

    for (const segIndex of segments) {
      const t0 = performance.now();
      const segBuf = await (await fetch(`seg-${String(segIndex).padStart(3, '0')}.m4s`)).arrayBuffer();
      const fetchMs = performance.now() - t0;
      const chunks = PCStream.chunksOf(segBuf, { segmentIndex: segIndex, fps, perSegment: 15 });
      const frames = [];
      let firstFrameMs = null;
      const tDec = performance.now();
      const dec = new VideoDecoder({
        output: (f) => {
          if (firstFrameMs == null) firstFrameMs = performance.now() - tDec;
          frames.push({ ts: f.timestamp, w: f.displayWidth, h: f.displayHeight });
          f.close();
        },
        error: (e) => { out.error = String(e); },
      });
      dec.configure({
        codec: init.codec, description: init.description,
        codedWidth: init.width, codedHeight: init.height, hardwareAcceleration: 'prefer-hardware',
      });
      // 只喂这一个分段：第一个 chunk 必须是 key，否则随机访问不成立
      for (const c of chunks) dec.decode(c);
      await dec.flush();
      const totalMs = performance.now() - tDec;
      dec.close();
      out.cases.push({
        segIndex, fetchMs: +fetchMs.toFixed(2), segBytes: segBuf.byteLength,
        chunkCount: chunks.length, firstChunkIsKey: chunks[0].type === 'key',
        decoded: frames.length, firstFrameMs: firstFrameMs == null ? null : +firstFrameMs.toFixed(2),
        totalMs: +totalMs.toFixed(2),
        firstTimestamp: frames[0]?.ts ?? null,
        expectedFirstTimestamp: Math.round(segIndex * 15 * 1e6 / fps),
        codedSize: frames[0] ? `${frames[0].w}x${frames[0].h}` : null,
      });
    }
    return out;
  }, { segments: Array.from({ length: SEGMENTS }, (_, i) => i), fps: FPS, contentH: H });

  report.browserSide = { ...browserSide, browserMode: mode, ua: await page.evaluate(() => navigator.userAgent) };
  console.log(`\n页面端（${mode}，${report.browserSide.ua.match(/(Chrome|Edg)\/[\d.]+/)?.[0]}）：codec ${browserSide.codec}，isConfigSupported ${browserSide.supported}，NALU 长度字段 ${browserSide.naluLengthSize} 字节`);
  for (const c of browserSide.cases) {
    console.log(`  只给 init + seg ${c.segIndex}: 首 chunk 是 key=${c.firstChunkIsKey}，解出 ${c.decoded}/${c.chunkCount} 帧，` +
      `首帧 ${c.firstFrameMs} ms，整段 ${c.totalMs} ms，fetch ${c.fetchMs} ms，ts ${c.firstTimestamp}（期望 ${c.expectedFirstTimestamp}），codedSize ${c.codedSize}`);
  }
} finally {
  await factory.release(handle).catch(() => {});
  await close();
  await closeAll([server]);
}

// ── 判定 ─────────────────────────────────────────────────────────────────────
const b = report.browserSide;
report.verdict = {
  initIdentical,
  mfraDropped: report.nodeSide.segments.every((s) => s.dropped.includes('mfra')),
  oneFragmentPerSegment: report.nodeSide.segments.every((s) => s.sampleCount === 15 && s.firstSampleIsSync === true),
  codecFromAvcC: report.nodeSide.init.codec,
  randomAccess: !!b && b.cases.every((c) => c.firstChunkIsKey && c.decoded === 15 && c.firstTimestamp === c.expectedFirstTimestamp),
};
console.log('\n=== 判定 ===');
for (const [k, v] of Object.entries(report.verdict)) console.log(`  ${k}: ${v === true ? 'PASS' : v === false ? 'FAIL' : v}`);

if (jsonOut) console.log(`\nJSON -> ${writeJson(String(jsonOut), report)}`);
console.log(`流目录 -> ${streamDir}`);
