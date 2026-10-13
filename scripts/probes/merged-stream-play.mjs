// 合并流评估 · 第 4 问：播放一侧的代价。解一张大画面再按格子分给各层，和现在每张卡一个解码器比；同屏能带多少张重卡。
//
// 页面一侧在 merged-stream-play-page.js（四种做法的说明也在那里）。这里造流、起无头浏览器、逐个情形跑、汇总。
//   - 小卡：矩形 640×360 → 一格 640×736；合并流按 6 列排，受硬解上限 4096×4096 约束最多 6×5 = 30 格。
//   - 满屏卡：矩形 1920×1080 → 一格 1920×2176；一条合并流只放得下 2 格（3840×2176）。
// 每个情形用 rAF 播 4 秒（缺省），记：要画的帧里按时画上的有几帧、每拍主线程画图耗时、rAF 间隔、丢了几个 WebGL 上下文。
// 另外每种做法单画同一帧取一小块像素互相比（确认按格子分出来的和单卡流画的是同一幅）。
//
//   node scripts/probes/merged-stream-play.mjs --port 27900 [--browser puppeteer|chrome|edge] [--seconds 4] [--only small|full] [--json <文件>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arg, runFfmpeg, splitFmp4, serveLocal, closeServer, launchHeadless, gpuInfo, cpuBusy, writeJson, workDir, PRODUCT_X264, COLOR_TAGS, FMP4_FLAGS } from './merged-stream-common.mjs';
import { syntheticFrame } from './stream-common.mjs';
import { streamSegmentArgs } from '../../server/bakery/ffmpeg.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(arg('port', '27900'));
const WHICH = String(arg('browser', 'puppeteer'));
const SECONDS = Number(arg('seconds', '4'));
const ONLY = arg('only');
const jsonOut = arg('json');
const FPS_SRC = 30, FRAMES = 60, NSEG = 4;
const dir = workDir('play');
const blobs = {};
const put = (base, mp4) => { const s = splitFmp4(mp4); blobs[`${base}/init.mp4`] = s.init; s.segments.forEach((seg, i) => { blobs[`${base}/seg${i}.m4s`] = seg; }); return s.segments.length; };

const KINDS = {
  small: { w: 640, h: 360, distinct: 30, cols: 6, counts: [6, 12, 16, 24, 30] },
  full: { w: 1920, h: 1080, distinct: 4, cols: 2, counts: [6, 12] },
};

/** 造单卡流（产品命令行，60 帧 = 4 个分段），存成文件给后面拼合并流用；已有就不重造 */
async function single(kind, id, card) {
  const k = KINDS[kind];
  const file = path.join(dir, `${kind}-c${card}.mp4`);
  if (!fs.existsSync(file)) {
    const frames = [];
    for (let i = 0; i < FRAMES; i++) frames.push(syntheticFrame(k.w, k.h, card * 23 + i));
    const res = await runFfmpeg(streamSegmentArgs({ encoder: 'libx264', fps: FPS_SRC, raw: { width: k.w, height: k.h } }).slice(4), { input: Buffer.concat(frames) });
    if (res.code !== 0) throw new Error(`造单卡流失败：${res.stderr}`);
    fs.writeFileSync(file, res.stdout);
  }
  const n = put(`/p/${kind}/c${card}`, fs.readFileSync(file));
  if (n !== NSEG) throw new Error(`${file} 切出 ${n} 段，应当 ${NSEG}`);
  return file;
}

/** 甲：把几条单卡流解出来拼成网格再编（合并流） */
async function merged(kind, name, files, cols) {
  const k = KINDS[kind];
  const W = k.w, H = 2 * (k.h + 8);
  const file = path.join(dir, `${kind}-${name}.mp4`);
  if (!fs.existsSync(file)) {
    const layout = files.map((_, i) => `${(i % cols) * W}_${Math.floor(i / cols) * H}`).join('|');
    const res = await runFfmpeg([...files.flatMap((f) => ['-i', f]), '-filter_complex', `xstack=inputs=${files.length}:layout=${layout}:fill=black,format=yuv420p`,
      ...PRODUCT_X264, ...COLOR_TAGS, '-video_track_timescale', String(FPS_SRC), ...FMP4_FLAGS, 'pipe:1']);
    if (res.code !== 0) throw new Error(`拼合并流失败：${res.stderr.split(/\r?\n/).slice(-3).join(' | ')}`);
    fs.writeFileSync(file, res.stdout);
  }
  put(`/p/${kind}/${name}`, fs.readFileSync(file));
  return `/p/${kind}/${name}`;
}

const report = { probe: 'merged-stream-play', when: new Date().toISOString(), browser: WHICH, seconds: SECONDS, cpuBusyBefore: await cpuBusy(), runs: [], pixelChecks: [] };
const plans = [];
for (const [kind, k] of Object.entries(KINDS)) {
  if (ONLY && ONLY !== kind) continue;
  console.log(`造流：${kind}（${k.distinct} 张不同的卡）…`);
  const files = [];
  for (let c = 0; c < k.distinct; c++) files.push(await single(kind, kind, c));
  const W = k.w, H = 2 * (k.h + 8);
  for (const n of k.counts) {
    const singles = Array.from({ length: n }, (_, i) => `/p/${kind}/c${i % k.distinct}`);
    // 合并流：每条最多装 perStream 格（受 4096×4096 约束）
    const maxRows = Math.floor(4096 / H);
    const perStream = k.cols * maxRows;
    const mergedList = [];
    for (let at = 0; at < n; at += perStream) {
      const cells = Math.min(perStream, n - at);
      const cellFiles = Array.from({ length: cells }, (_, i) => files[(at + i) % k.distinct]);
      const url = await merged(kind, `m${cells}-at${at % k.distinct}`, cellFiles, k.cols);
      mergedList.push({ url, cols: k.cols, cells });
    }
    plans.push({ kind, n, cellW: W, cellH: H, singles, merged: mergedList });
  }
}

const page0 = `<!doctype html><meta charset="utf-8"><title>merged-stream-play</title><script src="/demux.js"></script><script src="/play.js"></script><body></body>`;
const server = await serveLocal(PORT, { '/': page0, '/demux.js': fs.readFileSync(path.join(here, 'stream-demux-browser.js')), '/play.js': fs.readFileSync(path.join(here, 'merged-stream-play-page.js')), ...blobs });
const handle = await launchHeadless(WHICH, ['--window-size=1920,1080']);
const MODES = ['per', 'per-shared', 'merged-crop', 'merged-shared'];
try {
  report.gpu = await gpuInfo(handle.browser);
  console.log('浏览器：', report.gpu.product, '|', report.gpu.angle);
  const runOne = async (plan, mode, fps, extra = {}) => {
    const page = await handle.browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    try {
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
      return await page.evaluate((o) => window.runPlay(o), { mode, layers: plan.n, cellW: plan.cellW, cellH: plan.cellH, singles: plan.singles, merged: plan.merged, nSeg: NSEG, fps, seconds: SECONDS, ...extra });
    } catch (e) { return { mode, layers: plan.n, fps, pageError: String(e.message || e) }; } finally { await page.close().catch(() => {}); }
  };

  // 像素核对：每种做法单画第 20 帧，取第 0 层和最后一层中间 48×48
  for (const plan of plans.filter((p) => p.n === 6)) {
    const got = {};
    for (const mode of MODES) got[mode] = await runOne(plan, mode, FPS_SRC, { snapshotAt: 20 });
    const diff = (a, b) => { if (!a || !b) return null; let s = 0, m = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); s += d; if (d > m) m = d; } return { meanAbs: +(s / a.length).toFixed(3), max: m }; };
    const base = got.per.patches;
    const row = { kind: plan.kind, frame: 20, nonEmpty: base?.[0] ? base[0].some((v) => v > 0) : false };
    for (const mode of MODES.slice(1)) row[mode] = [diff(base?.[0], got[mode].patches?.[0]), diff(base?.[1], got[mode].patches?.[1])];
    report.pixelChecks.push(row);
    console.log(`像素核对 ${plan.kind}（第 20 帧，和现状做法比，第 0 层 / 最后一层）：`, JSON.stringify(row));
  }

  for (const plan of plans) {
    for (const fps of [30, 60]) {
      for (const mode of MODES) {
        const busy = await cpuBusy(300);
        const r = await runOne(plan, mode, fps);
        delete r.patches;
        r.kind = plan.kind; r.cpuBusyBefore = busy;
        report.runs.push(r);
        if (r.pageError) { console.log(`${plan.kind} ×${plan.n} ${fps}fps ${mode}：页面出错 ${r.pageError}`); continue; }
        console.log(`${plan.kind.padEnd(5)} ×${String(plan.n).padEnd(2)} ${fps}fps ${mode.padEnd(13)} 解码器 ${String(r.decoders).padEnd(2)} | 按时画上 ${r.exact}/${r.wanted} 帧 | 每拍画图 ${r.drawMs.mean} ms（p95 ${r.drawMs.p95}，最大 ${r.drawMs.max}）| rAF 间隔均值 ${r.raf.meanGap} ms，>25ms 的 ${r.raf.over25ms} 次 | 上下文丢失 ${r.contextsLostEvents}，没画过的层 ${r.layersNeverDrawn} | ${r.frameFormats.join('/')}${r.decoderErrors.length ? ' | 解码器报错 ' + r.decoderErrors[0] : ''} | 开头处理器占用 ${busy}%`);
      }
    }
  }
} finally {
  await handle.close();
  await closeServer(server);
}
report.cpuBusyAfter = await cpuBusy();
const out = jsonOut && jsonOut !== true ? String(jsonOut) : path.join(dir, `play-${WHICH}.json`);
writeJson(out, report);
console.log('结果写到', out);
