/**
 * 剪辑段里依赖下层的卡带着下层一起产轨道流(〔裁〕R01:2026-10-22 用户定「毛玻璃卡带着下层一起产轨道流。不是不产轨道流。」)——
 * 真 Chrome、真编码器、真跨源舞台的端到端探针,**比像素**。
 *
 *   node scripts/probes/cut-below-stream-probe.mjs --port 5900 [--host-port 5905] [--out <目录>] [--keep] [--json <文件>]
 *
 * 给 `--port` 就在检出根起一台 dev server(另占 +1、+2 当舞台端口;带 `PROMPTCUT_NO_PORT_FILE=1`),用完按进程号收掉;
 * `--host-port` 是本探针放舞台宿主页、发流字节与素材图的小服务。本进程里直接起 `FramePipeline`(同预渲染进程的代码)。
 *
 * 场景(1280×720、30 fps、4 秒):
 *   激活剪辑「主」(从上到下):剪辑段 S(0～3.5 秒,引用「玻璃」,偏移 0.3 秒,框 1024×576 居中 = 缩到 0.8,淡入 0.4 秒);
 *     段外的下层:一张竖条色带的静态图(六条色带,边缘锐利;毛玻璃要是透过段去滤它,一眼看得出来。用图不用视频:舞台在探针宿主里
 *     没有父页给素材对时刻,视频停在第 0 帧,和导出页对不上)。
 *   剪辑「玻璃」(从上到下):段里上面的层 `punch-pill`(右上角);**毛玻璃**里程表 `odometer`(审阅表里依赖下层;目标卡 V);
 *     段里的下层:R6 推帧卡 `r6-stateful`(色块每秒匀速滑 300 像素,从毛玻璃底下滑过:每一帧毛玻璃滤到的都不一样);
 *     再下面一枚不透明度 0.6、带阴影的大药丸 `punch-pill`(半透明,底下透明)。
 *   R6 推帧卡自己也判重、贴它自己的单卡流(`solo: 'flat'`),舞台上不用活渲它(探针宿主里没有父页给它对历史)。
 *
 * 逐条核对:
 *   1. 流的计划:V 有一条 `kind: 'below'` 的流,`within` 是 `S~`,下层只有段里那枚药丸(段外的视频、段里上面的药丸都不算);
 *      回放、从嵌套场景挂上那一帧起;
 *   2. 产:稀疏版、满密度都齐;差分取层没有失败,用上了毛玻璃外框的掩码;
 *   3. 隔离工程:顶层只留 S(去掉框、淡入),「玻璃」里上面的层藏起来;
 *   4. 舞台贴流:真舞台(跨源两台)上只抑制 V、发它的流平面(`plane: "stage"`,挂在嵌套舞台里),别的层照常活渲;停在几帧上截图
 *      (含淡入那几帧),与整个项目的活渲导出比:每一帧最像的都是它自己那一帧、段的框里平均差 < 4/255;
 *      流平面挂在嵌套场景里(`[data-pc-cut-scene]` 里面)、V 的嵌套包裹层被抑制;
 *   5. 对照:同一刻不贴流、只抑制 V(毛玻璃那一块没了)和贴流比,段的框里差明显更大(证明 4 比到的是流画的东西);
 *   6. 采样边界:整个项目的活渲导出里,毛玻璃面板底下(段里没有别的层的那一块)段外视频的色带分界照样是锐利的一条边(玻璃半透明,
 *      透过它看得见段外的层,但它不滤它们)—— 毛玻璃只滤段里的下层(嵌套场景的 `clip-path`)。这一条不依赖流,改前那棵树上也跑得出读数。
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
import { handleStreamRequest, SPARSE_STRIDE } from '../../server/frame-stream.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { findFfmpeg, dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';
import { startDevServer, emptyUrlOf, sleep, round2 } from './below-stream-common.mjs';
import { streamPlanesFor } from '../../src/render/streamPlayer.ts';

const args = process.argv.slice(2);
const PORT = Number(flagArg('port', '0', args));
const HOST_PORT = Number(flagArg('host-port', String(PORT ? PORT + 5 : 0), args));
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-cut-below-probe-${Date.now().toString(36)}`));
process.env.PROMPTCUT_STREAM_POOL = '1';
if (!PORT) { console.error('要给 --port <自己起一台 dev server 的端口>'); process.exit(2); }
for (const p of [PORT, PORT + 1, PORT + 2, HOST_PORT]) if ([5190, 5191, 5192].includes(p)) { console.error(`端口 ${p} 是用户常驻的`); process.exit(2); }

const FPS = 30, WIDTH = 1280, HEIGHT = 720, DURATION = 4;
const SEG = 'seg-s';
const V = `${SEG}~cg-glass`;
const INNER_BELOW = `${SEG}~cg-below`, INNER_ABOVE = `${SEG}~cg-above`, R6 = `${SEG}~cg-r6`;
/** 段的框(屏幕上):1024×576 居中 */
const FRAME = { x: 128, y: 72, w: 1024, h: 576 };
const SEG_END = 3.5;
/** 流的帧范围:段 0～3.5 秒露出,里程表在「玻璃」里 0～4 秒,偏移 0.3 秒 → 露出窗口 [0, 3.5) 秒 = 第 0～104 帧 */
const LAST = Math.round(SEG_END * FPS) - 1;
/** 比像素停的那几帧:淡入里(0.4 秒 = 12 帧)两帧,之后几帧 */
const CHECK_FRAMES = [4, 10, 31, 47, 75, 100];

const scale = WIDTH / 1920;
const card = (id, cardId, start, end, params = {}, extra = {}) => ({ id, kind: 'card', cardId, start, end, params, ...extra });
function projectOf(id, { mediaUrl, outerVideo = true } = {}) {
  // outerVideo:段外那张色带图在不在(第 6 条拿掉它比)
  return {
    version: 1, id, name: id, width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION, themeId: 'dark',
    media: outerVideo ? [{ id: 'm-stripes', kind: 'image', name: 'stripes.png', url: mediaUrl }] : [],
    filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
    tracks: [
      { id: 'tr-seg', name: 'seg', clips: [{ id: SEG, cardId: '', cutId: 'c-glass', start: 0, end: SEG_END, cutOffset: 0.3, params: {}, frame: { ...FRAME }, fadeIn: 0.4 }] },
      ...(outerVideo ? [{ id: 'tr-video', name: 'stripes', clips: [{ id: 'clip-video', mediaId: 'm-stripes', start: 0, end: DURATION, params: {} }] }] : []),
    ],
    activeCutId: 'c-main',
    cuts: [
      { id: 'c-main', name: '主' },
      { id: 'c-glass', name: '玻璃', duration: DURATION, transitions: [], tracks: [
        { id: 'g-above', name: 'above', clips: [card('cg-above', 'punch-pill', 0, DURATION, { text: '段里上面的层' },
          { frame: { x: Math.round(WIDTH * 0.78), y: Math.round(HEIGHT * 0.2), w: 1280, h: 720, anchor: [0.5, 0.5], scale: scale * 0.5 } })] },
        { id: 'g-glass', name: 'glass', clips: [card('cg-glass', 'odometer', 0, DURATION, { position: 'left', value: 86420, label: '剪辑段里的毛玻璃' },
          { frame: { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale } })] },
        { id: 'g-r6', name: 'r6', clips: [card('cg-r6', 'r6-stateful', 0, DURATION, {}, { frame: { x: -250, y: 0, w: WIDTH, h: HEIGHT, anchor: [0, 0] } })] },
        { id: 'g-below', name: 'below', clips: [card('cg-below', 'punch-pill', 0, DURATION, { text: '段里的下层(半透明)' },
          { frame: { x: Math.round(WIDTH * 0.3), y: Math.round(HEIGHT * 0.45), w: 1280, h: 720, anchor: [0.5, 0.5], scale: scale * 1.4 },
            opacity: 0.6, emphasis: { kind: 'shadow', color: '#000000', size: 36, opacity: 0.7, dx: 0, dy: 18 } })] },
      ] },
    ],
  };
}

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 900))); say('FAIL', { label, extra }); } else say('ok', { label }); return cond; };
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
function rgbOver(buf, bg = [0x20, 0x20, 0x20]) {
  const png = PNG.sync.read(buf);
  const out = new Uint8Array(png.width * png.height * 3);
  for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
    const a = png.data[i + 3] / 255;
    for (let k = 0; k < 3; k++) out[j + k] = Math.round(png.data[i + k] * a + bg[k] * (1 - a));
  }
  return { width: png.width, height: png.height, rgb: out };
}
function rectDiff(a, b, r = FRAME) {
  let sum = 0, n = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const i = (y * a.width + x) * 3;
    for (let k = 0; k < 3; k++) { sum += Math.abs(a.rgb[i + k] - b.rgb[i + k]); n++; }
  }
  return sum / n;
}
/** 六条竖色带(每条 213 或 214 像素宽),PNG 字节 */
function stripesPng() {
  const colors = [[255, 24, 0], [0, 212, 0], [255, 240, 0], [0, 16, 255], [255, 40, 255], [0, 230, 255]];
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const c = colors[Math.min(5, Math.floor(x * 6 / WIDTH))];
    const i = (y * WIDTH + x) * 4;
    png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}
/**
 * 那条色带分界(屏幕上 x = `xb` 与 `xb + 1` 之间)锐不锐:每一行在分界处那一步的跳变,占分界两边各 6 像素之间总变化的比例,取平均。
 * 锐利的边接近 1(一步跳完);被模糊(24px 的 blur)的边摊成十几步,比例在 0.2 以下。
 */
function edgeConcentration(img, xb, y0, y1) {
  let sum = 0, n = 0;
  const px = (x, y) => { const i = (y * img.width + x) * 3; return [img.rgb[i], img.rgb[i + 1], img.rgb[i + 2]]; };
  for (let y = y0; y < y1; y++) {
    const a = px(xb, y), b = px(xb + 1, y), l = px(xb - 6, y), r = px(xb + 7, y);
    const step = a.reduce((t, v, k) => t + Math.abs(b[k] - v), 0), total = l.reduce((t, v, k) => t + Math.abs(r[k] - v), 0);
    if (total > 6) { sum += Math.min(1, step / total); n++; }
  }
  return n ? sum / n : 0;
}
/** 一块里每一行横向相邻像素差的最大值(三个通道相加)的平均:锐利的边是一个大跳变,被模糊的边摊成一串小差 */
function edgeStrength(img, r) {
  let sum = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    let best = 0;
    for (let x = r.x; x < r.x + r.w - 1; x++) {
      const i = (y * img.width + x) * 3;
      const d = Math.abs(img.rgb[i] - img.rgb[i + 3]) + Math.abs(img.rgb[i + 1] - img.rgb[i + 4]) + Math.abs(img.rgb[i + 2] - img.rgb[i + 5]);
      if (d > best) best = d;
    }
    sum += best;
  }
  return sum / r.h;
}
const crop = (img, r) => { const rgb = new Uint8Array(r.w * r.h * 3); for (let y = 0; y < r.h; y++) rgb.set(img.rgb.subarray(((y + r.y) * img.width + r.x) * 3, ((y + r.y) * img.width + r.x + r.w) * 3), y * r.w * 3); return { width: r.w, height: r.h, rgb }; };
const toPng = (img) => { const png = new PNG({ width: img.width, height: img.height }); for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) { png.data[i] = img.rgb[j]; png.data[i + 1] = img.rgb[j + 1]; png.data[i + 2] = img.rgb[j + 2]; png.data[i + 3] = 255; } return PNG.sync.write(png); };

async function exportFrames(bakery, project, emptyUrl, last, dir) {
  const png = new Map();
  await bakery.reset(project, emptyUrl);
  bakery.streamLease = null;
  await bakeFrames(bakery, { out: dir, fps: FPS, frames: `0-${last}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
    onFrame: async (i, buf) => { png.set(i, Buffer.from(buf)); } });
  return png;
}

const hostHtml = (oa, ob) => `<!doctype html><html><head><meta charset="utf-8"><title>cut below probe host</title></head>
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

const out = { out: OUT, project: { width: WIDTH, height: HEIGHT, fps: FPS, segment: SEG, target: V, frame: FRAME, frames: [0, LAST] } };
await fs.mkdir(OUT, { recursive: true });
let dev = null, bakery = null, browser = null, hostServer = null, pipeline = null;
let truth = null, PROJECT = null, emptyUrl = null;
const started = Date.now();
try {
  const ffmpeg = await findFfmpeg();
  dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'cutbelow' });
  say('spawn', { pid: dev.pid, port: PORT });
  const origin = dev.origin;
  const stripes = stripesPng();
  // 宿主小服务:舞台宿主页、流的字节(产流管线起来后挂上)、色带图
  let streamStore = null;
  const HOST_PATH = '/__cut-below-probe-host';
  let hostPage = '';
  hostServer = await serve(HOST_PORT, (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === '/media/stripes.png') { res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'no-store'); res.end(stripes); return; }
    if (url.pathname === HOST_PATH) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(hostPage); return; }
    if (streamStore && url.pathname.startsWith('/api/frames/') && handleStreamRequest(streamStore, req, res, url.pathname.slice('/api/frames'.length))) return;
    res.statusCode = 404; res.end();
  }, '127.0.0.1');
  const base = `http://127.0.0.1:${HOST_PORT}`;
  PROJECT = projectOf('cut-below-probe', { mediaUrl: `${base}/media/stripes.png` });
  emptyUrl = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
  bakery = await openBakery({ url: emptyUrl });

  // ================================================================ 1、3:流的计划、隔离工程
  pipeline = new FramePipeline({ root: path.join(OUT, 'library'), origin: () => origin, interactive: true, playhead: () => null });
  // 预渲染集合本由页面的分派表定;这里只放行毛玻璃这一张(别的卡在舞台上照常活渲)
  pipeline.streamPicked = (entry, clipId) => clipId === V || clipId === R6;
  const producer = pipeline.streamProducer();
  producer.attachRoute();
  streamStore = producer.store;
  const gate = { hold: true };
  const busy = pipeline.streamBusy.bind(pipeline);
  pipeline.streamBusy = (now) => busy(now) || (gate.hold && producer.streams.size > 0 && !producer.encoding.size && !producer.needsSparseAnywhere());
  const layers = new Map();
  pipeline.readyIndex.subscribe((message) => { if (message.type === 'layer' && message.kind === 'stream') layers.set(message.clipId, message); });
  let t0 = Date.now();
  await pipeline.preload(PROJECT);
  const state = await until('毛玻璃 V 有流', () => [...producer.streams.values()].find((s) => s.spec.topClipId === V) ?? null, 180_000);
  out.streams = [...producer.streams.values()].map((s) => [s.spec.kind, s.spec.topClipId]);
  check(!!state, '1:毛玻璃 V 有流', out.streams);
  if (state) {
  const spec = state.spec;
  out.spec = { kind: spec.kind, plane: spec.plane, within: spec.within ?? null, belowClipIds: spec.belowClipIds, firstFrame: spec.firstFrame, lastFrame: spec.lastFrame,
    mountFrame: spec.mountFrame, replay: spec.replay, bound: spec.bound, streamKey: spec.streamKey.slice(0, 16), contentKey: spec.contentKey.slice(0, 16), inputSig: spec.inputSig };
  check(spec.kind === 'below' && spec.plane === 'stage' && spec.within === `${SEG}~`, '1:V 是依赖下层的流,只算嵌套场景 S~ 里的下层', out.spec);
  check(JSON.stringify(spec.belowClipIds) === JSON.stringify([INNER_BELOW, R6]), '1:下层是段里的半透明药丸和 R6 推帧卡(段外的色带图、段里上面的药丸都不算)', spec.belowClipIds);
  check(spec.firstFrame === 0 && spec.lastFrame === LAST && spec.replay === true && spec.mountFrame === 0, '1:第 0～104 帧,回放、从第 0 帧起', out.spec);
  {
    const iso = state.isolated;
    const shown = (tracks) => (tracks ?? []).filter((t) => !t.hidden && !t.sourceOnly).flatMap((t) => t.clips.map((c) => c.id));
    const seg = (iso?.tracks ?? []).flatMap((t) => t.clips).find((c) => c.id === SEG);
    out.isolated = iso && { top: shown(iso.tracks), glass: shown(iso.cuts.find((c) => c.id === 'c-glass')?.tracks), segFrame: seg?.frame ?? null, segFadeIn: seg?.fadeIn ?? null };
    check(JSON.stringify(out.isolated) === JSON.stringify({ top: [SEG], glass: ['cg-glass', 'cg-r6', 'cg-below'], segFrame: null, segFadeIn: null }), '3:隔离工程顶层只留 S(去掉框与淡入),「玻璃」里上面的药丸藏起来', out.isolated);
  }

  // ================================================================ 2:产(稀疏、满密度)
  const segsOf = (st) => { const m = st?.manifest; const o = []; if (!st) return [null]; for (let n = st.spec.firstSegment; n <= st.spec.lastSegment; n++) o.push(m?.segments?.[n] ?? null); return o; };
  const r6State = () => [...producer.streams.values()].find((x) => x.spec.topClipId === R6) ?? null;
  const segs = () => [...segsOf(state), ...segsOf(r6State())];
  if (!(await until('稀疏版齐了', () => (segs().every(Boolean) && !producer.encoding.size ? true : null), 600_000))) throw new Error(`稀疏版没产完:${JSON.stringify(producer.status().log.slice(-8))}`);
  out.sparseMs = Date.now() - t0;
  check(segs().every((s) => s.stride === SPARSE_STRIDE), '2:稀疏版每个分段一张', segs().map((s) => s.stride));
  t0 = Date.now();
  gate.hold = false;
  producer.kick();
  if (!(await until('满密度齐了', () => (segs().every((s) => s?.stride === 1) && !producer.encoding.size && !producer.workers.size ? true : null), 900_000))) throw new Error(`满密度没产完:${JSON.stringify(producer.status().log.slice(-8))}`);
  out.denseMs = Date.now() - t0;
  out.below = state.below ? { failed: state.below.failed, frames: state.below.frames, glassFrames: state.below.glassFrames, absent: state.below.absent, same: state.below.same, checks: state.below.checks, overflows: state.below.overflows } : null;
  check(!!out.below && out.below.failed === null && out.below.glassFrames > 0 && out.below.checks > 0, '2:差分取层没有失败,用上了毛玻璃外框的掩码,每个分段都实测过', out.below);
  out.manifest = { tight: state.manifest.tight ?? null, segments: segs().map((s) => ({ stride: s.stride, samples: s.samples, box: s.box ?? null })) };

  // ================================================================ 参照:整个项目的活渲导出
  const refDir = path.join(OUT, 'ref'); await fs.mkdir(refDir, { recursive: true });
  truth = await exportFrames(bakery, PROJECT, emptyUrl, LAST, refDir);
  for (const f of [10, 47]) await fs.writeFile(path.join(OUT, `export-${f}.png`), toPng(rgbOver(truth.get(f))));

  // ================================================================ 4、5:舞台贴流
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  if (!ports.ok || !Array.isArray(ports.ports) || ports.ports.length < 2) throw new Error(`舞台端口没起来:${JSON.stringify(ports)}`);
  const u = new URL(origin);
  const [originA, originB] = ports.ports.slice(0, 2).map((p) => `${u.protocol}//${u.hostname}:${p}`);
  hostPage = hostHtml(originA, originB);
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  const frameA = () => page.frames().find((f) => f.url().startsWith(originA));
  const frameB = () => page.frames().find((f) => f.url().startsWith(originB));
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const rpcB = (method, ...a) => page.evaluate((m, a2) => window.__rpcB[m](...a2), method, a);
  // 依赖下层的流那一层带 `streamKind: 'below'`:页面把它的平面当舞台坐标的平面(`plane: "stage"`,同 `snapshotFeed.ts` 的 `streamLayers`)
  const planesAt = (f) => streamPlanesFor([...layers.values()].map((m) => ({ ...m, ...(m.streamKind === 'below' ? { plane: 'stage' } : {}) })), new Set([V, R6]), f);
  // 对照(第 5 条)只拿掉毛玻璃的流,R6 的照贴
  const planesNoGlass = (f) => planesAt(f).filter((p) => !p.clipIds.includes(V));
  await page.goto(base + HOST_PATH);
  await page.waitForFunction(() => window.__ready, { timeout: 120000 });
  await page.evaluate(() => window.__ready);
  for (const f of [frameA(), frameB()]) await f.evaluate((b) => { window.__pcStreamBase = b; }, base);
  await rpc('setProject', PROJECT, { reset: true });
  await rpcB('setProject', PROJECT, { reset: true });
  await rpc('setRole', 'front');
  await rpcB('setRole', 'back', { job: 'probe' });
  await rpc('setTime', 1 / FPS);
  // 停着(暂停时同样贴流,`mechanism/rendering.md`「兜底顺序」)
  await rpc('setPlaying', false);
  await rpc('setSuppressed', [V, R6]);
  const iframeBox = await (await page.$('#a')).boundingBox();
  const shotStage = async () => {
    await frameA().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    return rgbOver(await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } }));
  };
  /** 拨到第 f 帧(视频要追到这一帧):`withPlane` 时发 V 的流平面并等它画出这一帧 */
  const seekTo = async (f, withPlane = true) => {
    const planes = withPlane ? planesAt(f) : planesNoGlass(f);
    await rpc('setStreamPlanes', planes);
    const got = await frameA().evaluate(async (frame, fps, want) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const start = now();
      await window.__pcStage.setTime(frame / fps + 1e-4);
      for (;;) {
        const tracks = window.__pcStageDiag().streams.tracks.filter((t) => !t.over);
        const imgs = [...document.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth > 0);
        if (tracks.length === want && tracks.every((t) => t.lastDrawn === frame) && imgs.length) return { ms: +(now() - start).toFixed(1) };
        if (now() - start > 10000) return { ms: null, drawn: tracks.map((t) => t.lastDrawn), errors: tracks.map((t) => t.lastError), tracks: tracks.length, imgs: [...document.querySelectorAll('img')].map((i) => [i.complete, i.naturalWidth]) };
        await wait(5);
      }
    }, f, FPS, planes.length);
    await rpc('setStreamPlanes', planes);
    await sleep(250);
    return { planes, got };
  };
  const domNow = () => frameA().evaluate((v) => {
    const w = document.querySelector(`[data-pc-flat-clip="${v}"]`);
    const plane = document.querySelector(`canvas[data-pc-group-plane][data-pc-stream-group="${v}"]`);
    const shown = (el) => !!el && getComputedStyle(el).display !== 'none';
    return { wrapper: !!w, suppressed: !!w?.classList.contains('pc-suppressed'), plane: !!plane, planeShown: shown(plane), planeInCutScene: !!plane?.closest('[data-pc-cut-scene]'),
      cutSceneClipPath: getComputedStyle(document.querySelector('[data-pc-cut-scene]')).clipPath };
  }, V);
  {
    const rows = [];
    for (const f of CHECK_FRAMES) {
      const { planes, got } = await seekTo(f);
      const glassPlane = planes.find((p) => p.clipIds.includes(V));
      if (!check(planes.length === 2 && glassPlane?.plane === 'stage' && got.ms !== null, `4:第 ${f} 帧 V(plane: stage)和 R6 的流平面都画出来了`, { planes: planes.map((p) => ({ ids: p.clipIds, plane: p.plane ?? null })), got })) continue;
      const stage = await shotStage();
      const scores = [f - 2, f - 1, f, f + 1, f + 2].filter((c) => c >= 0 && c <= LAST).map((c) => [c, rectDiff(stage, rgbOver(truth.get(c)))]).sort((a, b) => a[1] - b[1]);
      // 并列(画面这几帧一样)时算它自己:自己那一帧的差不比最小的大 0.02
      const own = scores.find(([c]) => c === f)[1];
      const row = { frame: f, best: own <= scores[0][1] + 0.02 ? f : scores[0][0], err: round2(own), scores: scores.map(([c, v]) => [c, round2(v)]) };
      if (f === 10 || f === 47) {
        await fs.writeFile(path.join(OUT, `stage-stream-${f}.png`), toPng(stage));
        out[`dom${f}`] = await domNow();
        // 5:对照 —— 同一刻只抑制、不贴流
        const bare = await seekTo(f, false);
        const without = await shotStage();
        await fs.writeFile(path.join(OUT, `stage-nostream-${f}.png`), toPng(without));
        row.withoutStream = round2(rectDiff(without, rgbOver(truth.get(f))));
        row.bareOk = bare.got.ms !== null;
      }
      rows.push(row);
    }
    out.stage = rows;
    check(rows.length === CHECK_FRAMES.length && rows.every((r) => r.best === r.frame), '4:舞台贴流:每一帧最像的是整个项目导出的它自己那一帧(含淡入那两帧;并列算它自己)', rows.map((r) => [r.frame, r.best, r.err]));
    check(rows.every((r) => r.err < 4), '4:舞台贴流与活渲导出在段的框里平均差 < 4/255', rows.map((r) => [r.frame, r.err]));
    check(['dom10', 'dom47'].every((k) => out[k]?.suppressed && out[k]?.planeShown && out[k]?.planeInCutScene), '4:V 的嵌套包裹层被抑制,流平面露着、挂在嵌套场景里', { dom10: out.dom10, dom47: out.dom47 });
    check(String(out.dom47?.cutSceneClipPath ?? '').startsWith('inset('), '4:嵌套场景挂着 clip-path(毛玻璃的采样边界)', out.dom47?.cutSceneClipPath);
    const contrast = rows.filter((r) => r.withoutStream !== undefined);
    check(contrast.length === 2 && contrast.every((r) => r.withoutStream > Math.max(3 * r.err, 2)), '5:对照:不贴毛玻璃的流(那一块没了,R6 的照贴)时差明显更大', contrast.map((r) => [r.frame, r.err, r.withoutStream]));
  }

  }

  // ================================================================ 6:采样边界(导出里毛玻璃没有透过段去滤段外的视频)
  {
    // 毛玻璃那块面板(屏幕坐标约 193～455 × 272～447)右下角、段里没有别的层的一小块:底下是段外色带图绿、黄两条色带的分界(x = 426 | 427)。
    // 毛玻璃的暗底是半透明的:它不滤段外的层时,分界透过面板照样是一步跳完的锐利的边;要是透过段去滤了,分界被模糊成十几步的渐变
    const region = { x: 395, y: 398, w: 55, h: 40 };
    const XB = Math.ceil(2 * WIDTH / 6) - 1;   // 第 2 条色带的最后一列(426),它右边一列起是第 3 条
    const glassDir = path.join(OUT, 'ref-glass'); await fs.mkdir(glassDir, { recursive: true });
    const withVideo = rgbOver((truth ?? await exportFrames(bakery, PROJECT, emptyUrl, 47, glassDir)).get(47));
    const blackDir = path.join(OUT, 'ref-black'); await fs.mkdir(blackDir, { recursive: true });
    const noVideo = rgbOver((await exportFrames(bakery, projectOf('cut-below-probe-black', { outerVideo: false }), emptyUrl, 47, blackDir)).get(47));
    // 同样那条分界在段的框外面(没有毛玻璃)的样子:「锐利的边」的量级
    const bare = { x: 395, y: 690, w: 55, h: 20 };
    out.sampling = { region, edgeUnderGlass: round2(edgeStrength(withVideo, region)), edgeNoVideo: round2(edgeStrength(noVideo, region)), edgeBare: round2(edgeStrength(withVideo, bare)),
      concentrationUnderGlass: round2(edgeConcentration(withVideo, XB, region.y, region.y + region.h)), concentrationBare: round2(edgeConcentration(withVideo, XB, bare.y, bare.y + bare.h)) };
    await fs.writeFile(path.join(OUT, 'export-47-glass-crop.png'), toPng(crop(withVideo, { x: 180, y: 260, w: 300, h: 200 })));
    check(out.sampling.edgeUnderGlass > 4 * Math.max(out.sampling.edgeNoVideo, 2) && out.sampling.concentrationUnderGlass >= 0.6,
      '6:毛玻璃面板底下段外色带的分界照样一步跳完(毛玻璃只滤段里的下层,没有透过段去滤段外的层)', out.sampling);
  }
} catch (error) {
  fails.push(`探针出错:${error?.message || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { hostServer?.close(); } catch { /* ignore */ }
  try { await pipeline?.close(); } catch { /* ignore */ }
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
