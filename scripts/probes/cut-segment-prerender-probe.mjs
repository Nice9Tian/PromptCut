/**
 * 剪辑段参与预渲染(语义 `docs/semantics/mechanism/rendering.md`「剪辑段」)—— 真 Chrome、真编码器的端到端探针,**比像素**。
 *
 *   node scripts/probes/cut-segment-prerender-probe.mjs (--origin http://127.0.0.1:5400 | --port 5400) [--out <dir>] [--keep] [--json <file>]
 *
 * 给 `--port` 就自己在检出根起一台 dev server(另占 +1、+2 当舞台端口),用完按进程号收掉。本进程里直接起 `FramePipeline`
 * (同预渲染进程的代码),库根放临时目录。
 *
 * 项目(1280×720、30 fps):激活剪辑「主」只有一条序列、一个剪辑段 S(第 1～5 秒,框 960×540 居中,`cutOffset` 1 秒)引用剪辑「重」;
 * 「重」里一张推帧卡 `r6-stateful`(CSS 动画,每帧横移 10 像素,0～6 秒)和一个剪辑段引用剪辑「里」(两层嵌套),「里」里一张 `probe-slow`。
 * S 的偏移 1 秒落在 `r6-stateful` 的中间,所以嵌套场景要从更早处推过来(预卷 1 秒)才对。
 *
 * 逐条核对:
 *   1. 卡片计划里有 S 的控件:剪辑段节点(`cutSegment`、预卷 1 秒、推帧口径 stateful)、有成本键、不走整帧 PNG 那一支(`cacheable` 为假)。
 *   2. 流的计划:S 一条 `solo: 'cut'` 的单卡流(包裹层坐标),第一帧 30、最后一帧 149,要回放、挂载帧早于段起点(含预卷)。
 *   3. 隔离工程(流用的)导出的每一帧与整个项目导出的同一帧逐像素相同(框居中,隔离工程把框摆在同一处)—— 流里放的就是活渲的画面。
 *   4. 稀疏版:每个分段一张,样本最像分段的第一帧;满密度:每个分段头、中、尾的样本最像它自己那一帧(前后各两帧里),平均误差小。
 *   5. 舞台贴流:真舞台(跨源两台)上把 S 抑制、发它的流平面,停在几帧上截图,与整个项目导出的同一帧比:最像的是它自己那一帧。
 *   6. 失效:改了被引用剪辑「里」(两层深)里那张卡的参数,S 的成本键、流键都变;改激活剪辑里别的东西(加一条隐藏序列)不变。
 *
 * 输出 JSON 结论,过程写 stderr;任何一条不过就以非零退出。耗时只记录。截图写到 `--out`。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { serve, flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { handleStreamRequest, planStreams, SPARSE_STRIDE } from '../../server/frame-stream.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { findFfmpeg, dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';
import { decodePngRgba } from '../../server/bakery/capture-canvas.mjs';
import { startDevServer, emptyUrlOf, decodeSegment, newError, tallyDecodedDirect, sleep, round2 } from './below-stream-common.mjs';
import { streamPlanesFor } from '../../src/render/streamPlayer.ts';
import { streamSegmentFirstFrame, streamSegmentFrameCount } from '../../src/render/streamSegments.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-cut-prerender-probe-${Date.now().toString(36)}`));
process.env.PROMPTCUT_STREAM_POOL = '1';
if (!ORIGIN && !PORT) { console.error('要给 --origin <dev server> 或 --port <自己起一台>'); process.exit(2); }

const FPS = 30, WIDTH = 1280, HEIGHT = 720, DURATION = 6;
const SEG = 'seg-s';
const FRAME = { x: 160, y: 90, w: 960, h: 540 };
const WANT = [30, 149];

const card = (id, cardId, start, end, params = {}, extra = {}) => ({ id, cardId, start, end, params, ...extra });
const segOf = (id, cutId, start, end, extra = {}) => ({ id, cardId: '', cutId, start, end, params: {}, ...extra });
function projectOf(id, { innerLabel = 'inner', extraTrack = false } = {}) {
  return {
    version: 1, id, name: id, width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION, themeId: 'dark',
    media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
    tracks: [
      ...(extraTrack ? [{ id: 'tr-extra', name: 'extra', hidden: true, clips: [card('extra-1', 'probe-slow', 0, 1, { burnMs: 0, label: 'x' })] }] : []),
      { id: 'tr-main', name: 'main', clips: [segOf(SEG, 'c-heavy', 1, 5, { cutOffset: 1, frame: { ...FRAME } })] },
    ],
    activeCutId: 'c-main',
    cuts: [
      { id: 'c-main', name: '主' },
      { id: 'c-heavy', name: '重', duration: 6, transitions: [], tracks: [
        { id: 'h-1', name: 'h1', clips: [card('h-r6', 'r6-stateful', 0, 6)] },
        { id: 'h-2', name: 'h2', clips: [segOf('h-seg', 'c-inner', 0, 6)] },
      ] },
      { id: 'c-inner', name: '里', duration: 6, transitions: [], tracks: [
        { id: 'i-1', name: 'i1', clips: [card('i-slow', 'probe-slow', 0, 6, { burnMs: 0, label: innerLabel })] },
      ] },
    ],
  };
}
const PROJECT = projectOf('cut-prerender-probe');

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); say('FAIL', { label, extra }); } else say('ok', { label }); return cond; };
async function until(label, fn, timeoutMs, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await sleep(everyMs);
  }
}

function frameStore() {
  const png = new Map(), cache = new Map();
  return {
    put: (frame, buf) => png.set(frame, Buffer.from(buf)),
    png: (frame) => png.get(frame),
    rgba(frame) {
      if (cache.has(frame)) return cache.get(frame);
      const data = decodePngRgba(png.get(frame))?.data;
      if (!data) throw new Error(`解不开第 ${frame} 帧的参照`);
      cache.set(frame, data);
      if (cache.size > 64) cache.delete(cache.keys().next().value);
      return data;
    },
  };
}
async function exportFrames(bakery, project, emptyUrl, last, dir) {
  const store = frameStore();
  await bakery.reset(project, emptyUrl);
  bakery.streamLease = null;
  await bakeFrames(bakery, { out: dir, fps: FPS, frames: `0-${last}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
    onFrame: async (i, buf) => { store.put(i, buf); } });
  return store;
}
function decodedDiff(picture, rect, truth) {
  const e = newError();
  tallyDecodedDirect(e, picture, rect, truth, WIDTH);
  return e.count ? e.sum / e.count : 0;
}
function sampleDiff(a, b) { let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]); return sum / a.length; }
/** 整幅 RGBA 两份逐字节不同的字节数 */
function bytesDiff(a, b) { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; }
function rgbOver(buf, bg = [0x20, 0x20, 0x20]) {
  const png = PNG.sync.read(buf);
  const out = new Uint8Array(png.width * png.height * 3);
  for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
    const a = png.data[i + 3] / 255;
    for (let k = 0; k < 3; k++) out[j + k] = Math.round(png.data[i + k] * a + bg[k] * (1 - a));
  }
  return { width: png.width, height: png.height, rgb: out };
}
/** 两幅 RGB 在框里的平均差 */
function rectDiff(a, b, r = FRAME) {
  let sum = 0, n = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const i = (y * a.width + x) * 3;
    for (let k = 0; k < 3; k++) { sum += Math.abs(a.rgb[i + k] - b.rgb[i + k]); n++; }
  }
  return sum / n;
}
const toPng = (img) => { const png = new PNG({ width: img.width, height: img.height }); for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) { png.data[i] = img.rgb[j]; png.data[i + 1] = img.rgb[j + 1]; png.data[i + 2] = img.rgb[j + 2]; png.data[i + 3] = 255; } return PNG.sync.write(png); };

const hostHtml = (oa, ob) => `<!doctype html><html><head><meta charset="utf-8"><title>cut prerender probe host</title></head>
<body style="margin:0;background:#202020">
<iframe id="a" src="${oa}/?stage=1&id=A&preview=stage&prerender=1" style="width:${WIDTH}px;height:${HEIGHT}px;border:0;display:block"></iframe>
<iframe id="b" src="${ob}/?stage=1&id=B&preview=stage&prerender=1" style="width:${WIDTH}px;height:${HEIGHT}px;border:0;display:block;opacity:0;pointer-events:none;position:absolute;left:0;top:0"></iframe>
<script type="module">
function createStageRpc(target, targetOrigin) {
  let nextId = 1; const pending = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== target) return; const d = e.data;
    if (d && d.type === 'pc-rpc-reply') { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.ok ? p.resolve(d.result) : p.reject(new Error(d.error)); }
  });
  const call = (method) => (...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); target.postMessage({ type: 'pc-rpc', id, method, args }, targetOrigin); });
  const c = {};
  for (const m of ['setProject', 'setTime', 'setRole', 'play', 'pause', 'setSuppressed', 'setStreamPlanes', 'setPlaying']) c[m] = call(m);
  return c;
}
const waitReady = (frame, targetOrigin) => new Promise((res) => {
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    res(createStageRpc(frame.contentWindow, targetOrigin));
  });
});
window.__ready = Promise.all([waitReady(document.getElementById('a'), '${oa}'), waitReady(document.getElementById('b'), '${ob}')])
  .then(([a, b]) => { window.__rpc = a; window.__rpcB = b; return true; });
</script></body></html>`;

function openPipeline(root, origin, { frozen = false } = {}) {
  const pipeline = new FramePipeline({ root, origin: () => origin, interactive: true, playhead: () => null });
  pipeline.streamPicked = () => true;
  const producer = pipeline.streamProducer();
  producer.attachRoute();
  const gate = { hold: true, frozen };
  const busy = pipeline.streamBusy.bind(pipeline);
  pipeline.streamBusy = (now) => busy(now) || gate.frozen || (gate.hold && producer.streams.size > 0 && !producer.encoding.size && !producer.needsSparseAnywhere());
  const layers = new Map();
  pipeline.readyIndex.subscribe((message) => { if (message.type === 'layer' && message.kind === 'stream') layers.set(message.clipId, message); });
  return { pipeline, producer, gate, layers };
}
const allAt = (producer, want) => {
  const s = producer.status();
  if (!s.streams.length) return null;
  for (const row of s.streams) for (let n = row.firstSegment; n <= row.lastSegment; n++) if (!want(row.segments[n])) return null;
  return !producer.encoding.size ? s : null;
};
const segmentsOf = (state) => { const out = []; for (let n = state.spec.firstSegment; n <= state.spec.lastSegment; n++) out.push(n); return out; };
const controlOf = (entry) => (entry?.cardPlan ?? []).find((c) => c.clipId === SEG) ?? null;

const out = { out: OUT, project: { width: WIDTH, height: HEIGHT, fps: FPS, segment: SEG, frame: FRAME, want: WANT } };
await fs.mkdir(OUT, { recursive: true });
let dev = null, bakery = null, browser = null, hostServer = null;
const pipelines = [];
const started = Date.now();
try {
  const ffmpeg = await findFfmpeg();
  let origin = ORIGIN;
  if (!origin) { dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'cutprerender' }); origin = dev.origin; say('spawn', { pid: dev.pid, port: PORT }); }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;
  const emptyUrl = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
  bakery = await openBakery({ url: emptyUrl });

  // ================================================================ 1、2:卡片计划与流的计划
  const A = openPipeline(path.join(OUT, 'library-a'), origin);
  pipelines.push(A.pipeline);
  let t0 = Date.now();
  const entry = await A.pipeline.preload(PROJECT);
  const control = await until('卡片计划里有剪辑段', () => controlOf(entry) ?? controlOf([...A.pipeline.entries?.values?.() ?? []].at(-1)), 120_000);
  out.control = control && { costKey: control.costKey, cacheable: control.cacheable, frameMode: control.frameMode, capabilities: control.capabilities, start: control.start, end: control.end, count: control.count, sampling: control.sampling };
  check(!!control, '1:卡片计划里有剪辑段 S 的控件');
  check(control?.capabilities?.cutSegment === true && control?.capabilities?.cutPreroll === 1 && control?.frameMode === 'stateful', '1:剪辑段节点:cutSegment、预卷 1 秒、推帧口径 stateful', control?.capabilities);
  check(typeof control?.costKey === 'string' && !!control.costKey, '1:剪辑段有成本键');
  check(control?.cacheable === false, '1:剪辑段不走整帧 PNG 那一支(cacheable 为假)');

  if (!(await until('稀疏版齐了', () => allAt(A.producer, (s) => !!s), 600_000))) throw new Error(`稀疏版没产完:${JSON.stringify(A.producer.status().log.slice(-8))}`);
  await sleep(600);
  out.sparseMs = Date.now() - t0;
  const states = [...A.producer.streams.values()];
  const state = states.find((s) => s.spec.topClipId === SEG);
  check(states.length === 1 && !!state, '2:只有 S 一条流', states.map((s) => s.spec.topClipId));
  if (!state) throw new Error('没有 S 的流');
  const spec = state.spec;
  out.spec = { kind: spec.kind, plane: spec.plane, solo: spec.solo, originFrame: spec.originFrame, lastFrame: spec.lastFrame, mountFrame: spec.mountFrame, replay: spec.replay, offset: spec.offset, bound: spec.bound, hasMedia: spec.hasMedia, streamKey: spec.streamKey };
  check(spec.kind === 'card' && spec.plane === 'local' && spec.solo === 'cut', '2:剪辑段级的单卡流(solo cut,包裹层坐标)', out.spec);
  check(spec.originFrame === WANT[0] && spec.lastFrame === WANT[1], '2:第 30～149 帧', out.spec);
  check(spec.replay === true && spec.mountFrame === 0, '2:要回放,挂载帧含预卷(第 0 帧)', out.spec);
  check(spec.offset?.x === FRAME.x && spec.offset?.y === FRAME.y, '2:隔离工程把框摆在原处(居中)', spec.offset);

  // ================================================================ 3:隔离工程 = 整个项目的活渲
  const refDir = path.join(OUT, 'ref-project'); await fs.mkdir(refDir, { recursive: true });
  const isoDir = path.join(OUT, 'ref-isolated'); await fs.mkdir(isoDir, { recursive: true });
  const truth = await exportFrames(bakery, PROJECT, emptyUrl, WANT[1], refDir);
  const iso = await exportFrames(bakery, state.isolated, emptyUrl, WANT[1], isoDir);
  {
    const diffs = [];
    for (let f = WANT[0]; f <= WANT[1]; f++) { const d = bytesDiff(truth.rgba(f), iso.rgba(f)); if (d) diffs.push([f, d]); }
    out.isolatedVsProject = { frames: WANT[1] - WANT[0] + 1, differing: diffs.length, first: diffs.slice(0, 5) };
    check(diffs.length === 0, '3:隔离工程导出的每一帧与整个项目导出的同一帧逐像素相同', out.isolatedVsProject);
    // 预卷对不对:第 30 帧(段起点)的画面和「从段起点才开始推」的不一样 —— 拿第 0 帧比(r6 推帧卡 1 秒后横移 300 像素)
    const d0 = bytesDiff(truth.rgba(30), iso.rgba(30));
    check(d0 === 0, '3:段起点那一帧(预卷之后)也相同', d0);
    for (const f of [30, 75, 149]) await fs.writeFile(path.join(OUT, `export-${f}.png`), toPng(rgbOver(truth.png(f))));
  }

  // ================================================================ 4:稀疏与满密度
  const decodeOf = async (n, name) => {
    const { manifest } = state;
    const seg = manifest.segments[n];
    const meta = manifest.inits[seg.init];
    const rect = { x: meta.rect.x + spec.offset.x, y: meta.rect.y + spec.offset.y, w: meta.rect.w, h: meta.rect.h };
    const init = await fs.readFile(A.producer.store.initFile(spec.streamKey, seg.init));
    const bytes = await fs.readFile(path.join(A.producer.store.dir(spec.streamKey), seg.file));
    const decoded = await decodeSegment(ffmpeg, init, bytes, OUT, name);
    const frameBytes = rect.w * 2 * (rect.h + 8) * 3;
    const samples = [];
    for (let k = 0; (k + 1) * frameBytes <= decoded.length; k++) samples.push(decoded.subarray(k * frameBytes, (k + 1) * frameBytes));
    return { seg, rect, samples, exact: decoded.length === seg.samples * frameBytes };
  };
  {
    const rows = [], wrong = [];
    for (const n of segmentsOf(state)) {
      const first = streamSegmentFirstFrame(n, spec.originFrame);
      const count = streamSegmentFrameCount(n, spec.originFrame, spec.lastFrame);
      const d = await decodeOf(n, `sparse-${n}`);
      const same = Math.max(0, ...d.samples.slice(1).map((s) => sampleDiff(s, d.samples[0])));
      const cands = [first - 2, first - 1, first, first + 1, first + 2].filter((c) => c >= 0 && c <= spec.lastFrame);
      const scores = cands.map((c) => [c, decodedDiff(d.samples[0], d.rect, truth.rgba(c))]).sort((a, b) => a[1] - b[1]);
      if (d.seg.stride !== SPARSE_STRIDE || d.seg.samples !== count || !d.exact || same > 1.5 || scores[0][0] !== first) wrong.push({ n, stride: d.seg.stride, samples: d.seg.samples, count, same: round2(same), best: scores[0][0], first });
      rows.push({ n, first, best: scores[0][0], err: round2(scores[0][1]) });
    }
    out.sparse = rows;
    check(rows.length === spec.lastSegment + 1 && wrong.length === 0, '4:稀疏版每个分段一张,最像的是分段的第一帧', wrong.slice(0, 4));
  }
  t0 = Date.now();
  A.gate.hold = false;
  A.producer.kick();
  if (!(await until('满密度齐了', () => (allAt(A.producer, (s) => s?.stride === 1) && !A.producer.workers.size ? true : null), 900_000))) throw new Error(`满密度没产完:${JSON.stringify(A.producer.status().log.slice(-8))}`);
  out.denseMs = Date.now() - t0;
  {
    const rows = [], wrong = [];
    let worstErr = 0;
    for (const n of segmentsOf(state)) {
      const first = streamSegmentFirstFrame(n, spec.originFrame);
      const count = streamSegmentFrameCount(n, spec.originFrame, spec.lastFrame);
      const d = await decodeOf(n, `dense-${n}`);
      if (d.seg.stride !== 1 || d.seg.samples !== count || !d.exact) { wrong.push({ n, stride: d.seg.stride, samples: d.seg.samples, count }); continue; }
      for (let k = 0; k < count; k++) {
        const f = first + k;
        const scores = [f - 2, f - 1, f, f + 1, f + 2].filter((c) => c >= 0 && c <= spec.lastFrame).map((c) => [c, decodedDiff(d.samples[k], d.rect, truth.rgba(c))]).sort((a, b) => a[1] - b[1]);
        const own = scores.find(([c]) => c === f)[1];
        worstErr = Math.max(worstErr, own);
        if (scores[0][0] !== f) wrong.push({ n, frame: f, best: scores[0][0] });
        rows.push({ frame: f, err: round2(own) });
      }
    }
    out.dense = { frames: rows.length, worstErr: round2(worstErr), wrong: wrong.slice(0, 6) };
    check(rows.length === WANT[1] - WANT[0] + 1 && wrong.length === 0, '4:满密度逐帧:每一帧的样本最像的是它自己那一帧', out.dense);
    check(worstErr < 6, '4:满密度逐帧的平均误差小(H.264 有损,每帧平均差 < 6/255)', out.dense);
  }

  // ================================================================ 5:舞台贴流
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  if (!ports.ok || !Array.isArray(ports.ports) || ports.ports.length < 2) throw new Error(`舞台端口没起来:${JSON.stringify(ports)}`);
  const u = new URL(origin);
  const [originA, originB] = ports.ports.slice(0, 2).map((p) => `${u.protocol}//${u.hostname}:${p}`);
  const HOST_PATH = '/__cut-prerender-probe-host';
  hostServer = await serve(0, (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === HOST_PATH) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(hostHtml(originA, originB)); return; }
    if (url.pathname.startsWith('/api/frames/') && handleStreamRequest(A.producer.store, req, res, url.pathname.slice('/api/frames'.length))) return;
    res.statusCode = 404; res.end();
  }, '127.0.0.1');
  const base = `http://127.0.0.1:${hostServer.address().port}`;
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  const frameA = () => page.frames().find((f) => f.url().startsWith(originA));
  const frameB = () => page.frames().find((f) => f.url().startsWith(originB));
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const rpcB = (method, ...a) => page.evaluate((m, a2) => window.__rpcB[m](...a2), method, a);
  const planesAt = (f) => streamPlanesFor([...A.layers.values()], new Set([SEG]), f);
  await page.goto(base + HOST_PATH);
  await page.waitForFunction(() => window.__ready, { timeout: 120000 });
  await page.evaluate(() => window.__ready);
  for (const f of [frameA(), frameB()]) await f.evaluate((b) => { window.__pcStreamBase = b; }, base);
  await rpc('setProject', PROJECT, { reset: true });
  await rpcB('setProject', PROJECT, { reset: true });
  await rpc('setRole', 'front');
  await rpcB('setRole', 'back', { job: 'probe' });
  await rpc('setTime', WANT[0] / FPS);
  await rpc('setPlaying', true);
  await rpc('setSuppressed', [SEG]);
  const iframeBox = await (await page.$('#a')).boundingBox();
  const shotStage = async () => {
    await frameA().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    return rgbOver(await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } }));
  };
  const seekTo = async (f) => {
    const planes = planesAt(f);
    await rpc('setStreamPlanes', planes);
    const got = await frameA().evaluate(async (frame, fps) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const start = now();
      await window.__pcStage.setTime(frame / fps + 1e-4);
      for (;;) {
        const tracks = window.__pcStageDiag().streams.tracks;
        if (tracks.length === 1 && tracks.every((t) => t.lastDrawn === frame)) return { ms: +(now() - start).toFixed(1) };
        if (now() - start > 8000) return { ms: null, drawn: tracks.map((t) => t.lastDrawn), errors: tracks.map((t) => t.lastError), tracks: tracks.length };
        await wait(2);
      }
    }, f, FPS);
    await rpc('setStreamPlanes', planes);
    await sleep(60);
    return { planes, got };
  };
  {
    const rows = [];
    for (const f of [31, 47, 75, 100, 133, 149]) {
      const { planes, got } = await seekTo(f);
      if (!check(planes.length === 1 && got.ms !== null, `5:第 ${f} 帧流平面画出来了`, { planes: planes.length, got })) continue;
      const stage = await shotStage();
      const scores = [f - 2, f - 1, f, f + 1, f + 2].filter((c) => c >= 0 && c <= WANT[1]).map((c) => [c, rectDiff(stage, rgbOver(truth.png(c)))]).sort((a, b) => a[1] - b[1]);
      rows.push({ frame: f, best: scores[0][0], err: round2(scores.find(([c]) => c === f)[1]), scores: scores.map(([c, v]) => [c, round2(v)]) });
      if (f === 75) {
        await fs.writeFile(path.join(OUT, 'stage-stream-75.png'), toPng(stage));
      }
    }
    // 舞台上真贴的是流:剪辑段的活子树藏着(`.pc-suppressed`),流平面露着
    out.stageDom = await frameA().evaluate((id) => {
      const wrap = document.querySelector(`[data-pc-clip="${id}"]`);
      const plane = wrap?.querySelector('[data-pc-stream-plane]');
      const scene = wrap?.querySelector('[data-pc-cut-scene]');
      return { suppressed: !!wrap?.classList.contains('pc-suppressed'), plane: !!plane && getComputedStyle(plane).display !== 'none', sceneHidden: !scene || getComputedStyle(scene).display === 'none' };
    }, SEG);
    out.stage = rows;
    check(rows.length === 6 && rows.every((r) => r.best === r.frame), '5:舞台贴流:每一帧最像的是整个项目导出的它自己那一帧', rows.map((r) => [r.frame, r.best, r.err]));
    check(rows.every((r) => r.err < 4), '5:舞台贴流与活渲导出的平均差 < 4/255(框内)', rows.map((r) => [r.frame, r.err]));
    check(out.stageDom.suppressed && out.stageDom.plane && out.stageDom.sceneHidden, '5:舞台上剪辑段的活子树藏着、流平面露着', out.stageDom);
  }

  // ================================================================ 6:失效
  {
    const fpOf = async (project) => {
      const p = new FramePipeline({ root: path.join(OUT, `library-x-${Math.random().toString(36).slice(2, 7)}`), origin: () => origin, interactive: true, playhead: () => null });
      pipelines.push(p);
      p.streamPicked = () => true;
      p.streamBusy = () => true; // 只要计划,不产
      const e = await p.preload(project);
      const c = await until('卡片计划(失效用例)', () => controlOf(e), 120_000);
      const specs = planStreams(e, { picked: () => true, envFingerprint: 'probe-fp', below: false });
      return { costKey: c?.costKey ?? null, member: c?.streamMemberKey ?? null, streamKey: specs.find((s) => s.topClipId === SEG)?.streamKey ?? null };
    };
    const base0 = await fpOf(projectOf('cut-prerender-probe'));
    const changed = await fpOf(projectOf('cut-prerender-probe', { innerLabel: 'changed' }));
    const unrelated = await fpOf(projectOf('cut-prerender-probe', { extraTrack: true }));
    out.invalidation = { base: base0, changedInner: changed, unrelated };
    check(!!base0.costKey && !!base0.streamKey, '6:原项目有成本键与流键', base0);
    check(changed.costKey && changed.costKey !== base0.costKey && changed.streamKey !== base0.streamKey, '6:改了两层深的被引用剪辑里的卡,成本键与流键都变', out.invalidation);
    check(unrelated.costKey === base0.costKey && unrelated.streamKey === base0.streamKey, '6:激活剪辑里加一条隐藏序列,剪辑段的键不变', out.invalidation);
  }
} catch (error) {
  fails.push(`探针出错:${error?.message || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { hostServer?.close(); } catch { /* ignore */ }
  for (const p of pipelines) { try { await p.close(); } catch { /* ignore */ } }
  try { await bakery?.close(); } catch { /* ignore */ }
  dropStreamEncoderSpares();
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) {
    try {
      for (const name of await fs.readdir(OUT)) if (!/\.(json|png)$/.test(name)) await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* ignore */ }
  }
}
out.elapsedMs = Date.now() - started;
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(out.ok ? 'PASS' : `FAIL ${fails.length}`);
process.exit(out.ok ? 0 : 1);
