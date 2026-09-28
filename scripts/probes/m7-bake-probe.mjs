/**
 * M7 契约第 8 节 P1、P2、P3(`docs/plan/m7-contract.md`):后台舞台为隔离单卡工程逐帧生成快照的节拍与隔离、
 * 生成的快照与桌面预渲染是否一致、`foreignObject` 出小尺寸与桌面 CDP 截图的差别。报告:docs/reports/AGENT-m7-probe.md。
 *
 * 舞台一侧要实验分支 `claude/m7-probe-exp` 的改动:`render(t, { jump: true, bake: { from } })` —— 快照趟不按一拍预算截断、
 * 挂载帧也生成快照、本地帧号小于 `from` 的只推不生成(即契约 4.3 的 `bake` RPC 的最小替身)。产品代码没有这个选项。
 *
 * 子命令(按顺序跑;`--out` 同一个目录):
 *
 *   node scripts/probes/m7-bake-probe.mjs desktop --origin http://127.0.0.1:5714 --out <dir>
 *       本进程里起 `FramePipeline`(与预渲染进程同一份代码)对探针项目预渲染到每张卡的共享档快照全齐(含小尺寸),
 *       把每张卡的 control、隔离单卡工程(`isolatedCardProject`)、`<帧>.html`、`<帧>.small.webp` 拷到 <dir>/desktop/<clipId>/。
 *       `--origin` 是开发服务器(实验分支的检出起的,它另占 +1、+2 两个舞台端口)。
 *
 *   node scripts/probes/m7-bake-probe.mjs browser --dist <实验分支>/dist-online --out <dir>
 *        [--port-base 5710] [--heads headless|headful|both] [--rounds 2] [--layouts cross-oac,same] [--modes seq,batch4]
 *        [--dev-stage http://127.0.0.1:5715]   另跑一遍开发服务器的舞台(非在线构建)只做 seq,给 P2 分辨构建差异
 *        [--catalog]                            另把 server/catalog 挂在 /catalog/(在线构建没有它,Lottie 素材卡取不到动画 JSON)
 *        [--ready]                              bake 带 `ready: true`(实验分支的就绪闸,照预渲染的 waitFrameReady);输出目录加 `-ready`
 *       起静态服务:+0 父页与在线构建(`/editor/`),+1、+2 两个舞台源(同一份在线构建),每个响应带 `Origin-Agent-Cluster: ?1`。
 *       父页(本脚本内联)开一个后台舞台 iframe(opacity 0 叠在原位),照 stageRpc 协议 `setRole('back')` →
 *       `setProject(隔离单卡工程, { reset })` → `render(末帧秒, { jump, bake })`;收 `probe-frame`(在线舞台是 gzip 字节),
 *       父页里 DecompressionStream 解开、WebCrypto 算 sha256(契约 4.3 的做法,只是这里在父页算),记主文档 longtask 与 rAF 间隔。
 *       seq = 一趟从挂载帧顺推到末帧;batch4 = 照桌面 4 帧一批、每批从头推;probe = 产品现有的测量快照趟(`probe: 'snapshot'`,受一拍预算截断)。每帧 HTML 写到 <dir>/browser-<layout>-<mode>/<clipId>/。
 *
 *   node scripts/probes/m7-bake-probe.mjs compare --out <dir>
 *       P2:每张卡逐帧比 desktop 与 browser-cross-oac-seq、seq 与 batch4、在线与开发舞台:逐字节(sha256)相同几帧;不同的用
 *       `compareSnapshotHtml`(样式数值 1e-6 容差)再判,记第一处差别;另把两边 HTML 各按桌面 `capture-snapshot` 的挂法截图比像素。
 *
 *   node scripts/probes/m7-bake-probe.mjs small --out <dir> [--frames 0,15,30,59] [--variant browser-cross-oac-seq] [--css <在线构建目录>]
 *       P3:在舞台源的页面里把浏览器生成的每帧 HTML 按 `smallScale` 包进 SVG `foreignObject`、以 `data:` 地址画上画布、出 WebP(质量 0.8),
 *       记每帧耗时、`getImageData` / `toDataURL` 是否抛 SecurityError(画布污染);与桌面 CDP 截的 `<帧>.small.webp` 解码后逐像素比
 *       (平均绝对差、PSNR、差 > 16 的像素占比、alpha 差)。差图写到 <dir>/small/。
 *
 * 输出:过程写 stderr;每个子命令最后一行 stdout 是一行 JSON,原始数据写 <dir>/*.json。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { flagArg, serve, closeAll, sleep } from './probe-connect.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CMD = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'desktop';
const OUT = path.resolve(flagArg('out', path.join(os.tmpdir(), 'm7-bake-probe')));
const BASE = Number(flagArg('port-base', '5710'));
const log = (...a) => console.error(...a);
// `--ready`:bake 带 `ready: true`(实验分支的就绪闸);输出目录名加 `-ready`
const READY = process.argv.includes('--ready');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ 探针项目 */

const FPS = 30;
const SECONDS = 2;
export const PROJECT = {
  id: 'm7-bake-probe', name: 'M7 生成快照探针', width: 1920, height: 1080, fps: FPS, duration: SECONDS,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    // Motion 卡(弹簧,Motion 的 JS 帧循环):框 960×540 居中,小尺寸是框大小 × 缩放比
    { id: 'tr-pill', name: 'pill', hidden: false, clips: [{ id: 'clip-pill', kind: 'card', cardId: 'punch-pill', start: 0, end: SECONDS, params: { text: 'M7 探针' }, frame: { x: 960, y: 540, w: 960, h: 540, anchor: [0.5, 0.5] } }] },
    // Motion 卡(useSpring 数字滚动)
    { id: 'tr-ticker', name: 'ticker', hidden: false, clips: [{ id: 'clip-ticker', kind: 'card', cardId: 'mu-number-ticker', start: 0, end: SECONDS, params: { value: 12480, label: '生成快照', unit: '' } }] },
    // 重的推帧卡:舞台里每个新时刻烧 40 ms(预渲染间里不烧,画面与烧不烧无关)
    { id: 'tr-slow', name: 'slow', hidden: false, clips: [{ id: 'clip-slow', kind: 'card', cardId: 'probe-slow-stepped', start: 0, end: SECONDS, params: { burnMs: 40, label: 'slow' } }] },
    // canvas 卡(tsParticles,Canvas 2D;审阅表 canvasHeavy)
    { id: 'tr-particles', name: 'particles', hidden: false, clips: [{ id: 'clip-particles', kind: 'card', cardId: 'particles', start: 0, end: SECONDS, params: { quantity: 80, seed: 7 } }] },
    // 带异步装载的 DOM 卡(Lottie 的 SVG 渲染器,动画 JSON 异步取;审阅表 independent、非 canvas):看就绪闸
    { id: 'tr-lottie', name: 'lottie', hidden: false, clips: [{ id: 'clip-lottie', kind: 'card', cardId: 'lottie-bodymovin', start: 0, end: SECONDS, params: {} }] },
  ],
};
const CLIPS = PROJECT.tracks.map((t) => t.clips[0].id);

/* ------------------------------------------------------------------ 公共 */

const cpuTimes = () => os.cpus().map((c) => c.times);
function cpuPct(a, b) {
  let idle = 0, total = 0;
  for (let i = 0; i < a.length; i++) { for (const k of Object.keys(a[i])) total += b[i][k] - a[i][k]; idle += b[i].idle - a[i].idle; }
  return total ? +(100 * (1 - idle / total)).toFixed(1) : null;
}
function winLoad() {
  try { return Number(execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average'], { encoding: 'utf8', timeout: 20000 }).trim()); } catch { return null; }
}
function stats(xs) {
  if (!xs || !xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) };
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 1));

async function launch(head, extra = []) {
  const defaults = await puppeteer.defaultArgs({ headless: head === 'headless' });
  const ignore = ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    ...defaults.filter((a) => a.startsWith('--disable-features='))];
  return puppeteer.launch({ headless: head === 'headless', ignoreDefaultArgs: ignore, defaultViewport: null, protocolTimeout: 600000,
    args: ['--disable-gpu', '--window-size=1100,820', '--window-position=40,40', ...extra] });
}

/* ------------------------------------------------------------------ desktop */

async function runDesktop() {
  const origin = flagArg('origin', 'http://127.0.0.1:5714');
  const root = path.join(OUT, 'pipeline');
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(root, { recursive: true });
  const { FramePipeline } = await import('../../server/frame-pipeline.mjs');
  const { createPushQueue } = await import('../../server/artifact-push.mjs');
  const pipeline = new FramePipeline({ root, origin: () => origin, interactive: false, dataRoot: root });
  // 小尺寸只在挂了推送队列时生成(frame-pipeline 的 smallTierEnabled):素材服务、内容库用内存替身(同 small-tier-probe.mjs)
  const blobs = new Map(), items = new Map();
  const asset = { async put(ns, bytes, { ext } = {}) { const hash = sha256(bytes); const id = `${ns}/${hash}`; const uploaded = !blobs.has(id); blobs.set(id, { bytes: Buffer.from(bytes), ext }); return { hash, uploaded }; },
    async has(ns, hash) { return blobs.has(`${ns}/${hash}`); }, async get(ns, hash) { return blobs.get(`${ns}/${hash}`)?.bytes ?? null; } };
  const content = { async put(kind, key, body) { items.set(`${kind}|${key}`, structuredClone(body)); return { hash: 'x' }; },
    async get(kind, key) { const body = items.get(`${kind}|${key}`); return body === undefined ? null : { body: structuredClone(body), hash: 'x' }; }, async list() { return { items: [], truncated: false }; } };
  const queue = createPushQueue({ pipeline, client: asset, content, dir: root, gate: false });
  queue.start();
  const t0 = Date.now();
  const res = { origin, cards: {}, winLoad: winLoad() };
  const c0 = cpuTimes();
  try {
    await pipeline.preload(PROJECT);
    const deadline = Date.now() + Number(flagArg('timeout-min', '25')) * 60000;
    const done = new Map();
    for (;;) {
      const controls = [...pipeline.entries.values()].flatMap((e) => e.cardPlan ?? []);
      for (const clipId of CLIPS) {
        if (done.has(clipId)) continue;
        const control = controls.find((c) => c.clipId === clipId && c.snapshotKey);
        if (!control) continue;
        const dir = pipeline.snapshots().dir({ tier: 'shared', key: control.snapshotKey });
        const index = await pipeline.snapshots().snapshotIndex({ tier: 'shared', key: control.snapshotKey });
        const names = await fsp.readdir(dir).catch(() => []);
        const smalls = names.filter((n) => n.endsWith('.small.webp')).length;
        if (index.count + (index.oversize?.length ? index.oversize.reduce((n, [a, b]) => n + b - a + 1, 0) : 0) >= control.count && smalls >= index.count) {
          done.set(clipId, { control, dir, doneMs: Date.now() - t0 });
          log(`desktop ${clipId}: ${index.count}/${control.count} frames, small ${smalls}, ${Date.now() - t0} ms`);
        }
      }
      if (done.size === CLIPS.length) break;
      if (Date.now() > deadline) { res.timeout = [...CLIPS.filter((c) => !done.has(c))]; log('desktop timeout', res.timeout); break; }
      await sleep(1000);
    }
    await pipeline.whenSmallSettled?.();
    const entry = [...pipeline.entries.values()][0];
    res.envFingerprint = pipeline.envFingerprint ?? null;
    for (const [clipId, { control, dir, doneMs }] of done) {
      const dst = path.join(OUT, 'desktop', clipId);
      await fsp.rm(dst, { recursive: true, force: true });
      await fsp.mkdir(dst, { recursive: true });
      for (const n of await fsp.readdir(dir)) await fsp.copyFile(path.join(dir, n), path.join(dst, n));
      const isolated = pipeline.isolatedCardProject(entry.project, control);
      writeJson(path.join(dst, 'isolated.json'), isolated);
      const slim = { clipId, key: control.key, snapshotKey: control.snapshotKey, contentKey: control.contentKey, envFingerprint: control.envFingerprint, count: control.count, sampling: control.sampling, start: control.start, end: control.end, capabilities: control.capabilities, compositing: control.compositing, appearance: control.appearance };
      writeJson(path.join(dst, 'control.json'), slim);
      // 活渲的整幅 PNG(卡片缓存,供「与活渲截图比」)
      const pngDir = path.join(root, 'controls', control.key, 'mov', 'frames');
      const pngs = await fsp.readdir(pngDir).catch(() => []);
      if (pngs.length) { await fsp.mkdir(path.join(dst, 'live'), { recursive: true }); for (const n of pngs) await fsp.copyFile(path.join(pngDir, n), path.join(dst, 'live', n)); }
      res.cards[clipId] = { count: control.count, sampling: control.sampling, snapshotKey: control.snapshotKey, doneMs, livePngs: pngs.length, files: (await fsp.readdir(dst)).length };
    }
  } finally {
    res.cpu = cpuPct(c0, cpuTimes());
    res.ms = Date.now() - t0;
    await queue.stop().catch(() => {});
    await pipeline.close().catch(() => {});
  }
  writeJson(path.join(OUT, 'desktop.json'), res);
  console.log(JSON.stringify(res));
}

/* ------------------------------------------------------------------ browser */

// 父页:一个后台舞台 iframe(opacity 0 叠在原位)+ 一条轻动画(时间轴播放头);照 stageRpc 协议说话
const PARENT_HTML = `<!doctype html><meta charset=utf-8><title>m7 parent</title>
<body style="margin:0;font:12px sans-serif">
<div id=wrap style="position:relative;width:960px;height:540px;margin:8px;background:#222">
  <iframe id=bg style="position:absolute;left:0;top:0;width:960px;height:540px;border:0;opacity:0;pointer-events:none"></iframe>
</div>
<div style="position:relative;width:960px;height:24px;margin:8px;background:#ddd"><div id=head style="position:absolute;top:0;width:2px;height:24px;background:#c00"></div></div>
<script>
const lts = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) lts.push({ at: e.startTime, d: +e.duration.toFixed(1), attr: (e.attribution || []).map((a) => a.containerType + ':' + a.containerSrc).join('|') }); }).observe({ type: 'longtask', buffered: false }); } catch {}
let gaps = null, last = performance.now(), f = 0;
(function raf() { const now = performance.now(); if (gaps) gaps.push(now - last); last = now; f++; document.getElementById('head').style.left = (f % 960) + 'px'; requestAnimationFrame(raf); })();
let ready = null, stageWin = null, stageOrigin = '*', seq = 0; const waiting = new Map();
const frames = new Map(); let frameLog = []; let pending = new Set();
async function gunzipText(buf) { const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')); return await new Response(s).text(); }
async function hex(buf) { const d = await crypto.subtle.digest('SHA-256', buf); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'pc-stage-ready') { ready = d.hostCapabilities; return; }
  if (e.source !== stageWin) return;
  if (d.type === 'pc-rpc-reply') { const w = waiting.get(d.id); if (w) { waiting.delete(d.id); d.ok ? w.res(d.result) : w.rej(new Error(d.error)); } return; }
  if (d.type === 'probe-frame') {
    const at = performance.now();
    const job = (async () => {
      const t0 = performance.now();
      const gz = d.htmlGz ? d.htmlGz.byteLength : 0;
      const html = d.htmlGz ? await gunzipText(d.htmlGz) : d.html;
      const bytes = new TextEncoder().encode(html);
      const hash = await hex(bytes);
      frames.set(d.clipId + '#' + d.localFrame, { html, hash, bytes: bytes.length, gz });
      frameLog.push({ clipId: d.clipId, localFrame: d.localFrame, at, parentMs: performance.now() - t0, gz, bytes: bytes.length });
    })();
    pending.add(job); job.finally(() => pending.delete(job));
  }
});
window.__rpc = (method, ...args) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); stageWin.postMessage({ type: 'pc-rpc', id, method, args }, stageOrigin); });
window.__setup = async (src) => { ready = null; const f = document.getElementById('bg'); f.src = src; stageWin = f.contentWindow; stageOrigin = new URL(src).origin;
  const t0 = performance.now(); while (!ready) { if (performance.now() - t0 > 60000) throw new Error('stage not ready'); await new Promise((r) => setTimeout(r, 50)); } stageWin = f.contentWindow; return ready; };
window.__recStart = () => { gaps = []; window.__lt0 = lts.length; frameLog = []; };
window.__recStop = async () => { await Promise.allSettled([...pending]); const g = gaps; gaps = null; return { gaps: g, lts: lts.slice(window.__lt0), frameLog, visibility: document.visibilityState }; };
window.__take = (key) => { const x = frames.get(key); frames.delete(key); return x || null; };
window.__keys = () => [...frames.keys()];
window.__clear = () => frames.clear();
</script>`;

function makeStaticHandler(dist) {
  const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.webp': 'image/webp' };
  return (req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Origin-Agent-Cluster', '?1');
    res.setHeader('Cache-Control', 'no-store');
    if (u.pathname === '/probe-parent') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(PARENT_HTML); }
    if (u.pathname === '/probe-blank') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end('<!doctype html><meta charset=utf-8><body style="margin:0">'); }
    // `--catalog`:另把 server/catalog 挂在 /catalog/(开发服务器有,在线构建与托管端没有;Lottie 素材卡的动画 JSON 在这里)
    const catalog = process.argv.includes('--catalog') && u.pathname.startsWith('/catalog/');
    const base = catalog ? path.join(ROOT, 'server', 'catalog') : dist;
    let p = catalog ? u.pathname.slice('/catalog/'.length) : u.pathname.startsWith('/editor/') ? u.pathname.slice('/editor/'.length) : null;
    if (p === null) { res.statusCode = 404; return res.end(); }
    if (!p) p = 'index.html';
    const file = path.join(base, decodeURIComponent(p));
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  };
}

async function bakeOne(page, { project, control, mode }) {
  const fps = project.fps || FPS;
  const start = project.tracks.find((t) => !t.hidden).clips[0].start;
  const last = control.count - 1;
  const secOf = (n) => start + n / fps;
  await page.evaluate(() => window.__clear());
  await page.evaluate(() => window.__rpc('setRole', 'back', { job: 'probe' }));
  await page.evaluate((p) => window.__rpc('setProject', p, { reset: true }), project);
  const c0 = cpuTimes();
  await page.evaluate(() => window.__recStart());
  const t0 = Date.now();
  const replies = [];
  if (mode === 'probe') {
    // 产品现有的测量快照趟(K1 `probe: 'snapshot'`,按一拍预算截断、挂载帧不生成):契约 3.3「测量时推过的帧可直接用」要它与生成快照路一致
    replies.push(await page.evaluate((t) => window.__rpc('render', t, { jump: true, probe: 'snapshot' }), secOf(last)));
  } else if (mode === 'seq') {
    replies.push(await page.evaluate((t, r) => window.__rpc('render', t, { jump: true, bake: { ready: r } }), secOf(last), READY));
  } else {
    for (let first = 0; first <= last; first += 4) {
      const to = Math.min(last, first + 3);
      replies.push(await page.evaluate((t, from, r) => window.__rpc('render', t, { jump: true, bake: { from, ready: r } }), secOf(to), first, READY));
    }
  }
  const wallMs = Date.now() - t0;
  const rec = await page.evaluate(() => window.__recStop());
  const cpu = cpuPct(c0, cpuTimes());
  const keys = await page.evaluate(() => window.__keys());
  const got = {};
  for (const k of keys) {
    const [clipId, lf] = k.split('#');
    if (clipId !== control.clipId) continue;
    const n = Number(lf);
    if (mode === 'batch4' && (n < 0 || n > last)) continue;
    got[n] = await page.evaluate((key) => window.__take(key), k);
  }
  const snapSteps = replies.flatMap((r) => r?.snapshotSteps ?? []);
  return {
    wallMs, cpu, frames: Object.keys(got).length, fps: +(Object.keys(got).length * 1000 / wallMs).toFixed(2),
    readyWaitMs: Math.round(replies.reduce((n, r) => n + (r?.readyWaitMs || 0), 0)),
    readyStuck: replies.flatMap((r) => r?.readyStuck ?? []).slice(0, 5), readyStuckCount: replies.reduce((n, r) => n + (r?.readyStuckCount || 0), 0),
    replies: replies.map((r) => ({ aborted: !!r?.aborted, reason: r?.reason, frames: r?.frames, elapsedMs: r?.elapsedMs && Math.round(r.elapsedMs), stepMs: r?.stepMs && Math.round(r.stepMs) })).slice(0, 3),
    rendersCalled: replies.length,
    snapshotMs: { inline: stats(snapSteps.map((s) => s.inlineMs)), raster: stats(snapSteps.map((s) => s.rasterMs)), serialize: stats(snapSteps.map((s) => s.serializeMs)) },
    parent: { longTasks: rec.lts.length, ltMs: rec.lts.map((x) => x.d), ltAttr: [...new Set(rec.lts.map((x) => x.attr))].slice(0, 3), raf: stats(rec.gaps), parentFrameMs: stats(rec.frameLog.map((x) => x.parentMs)), gzBytes: stats(rec.frameLog.map((x) => x.gz)), htmlBytes: stats(rec.frameLog.map((x) => x.bytes)), visibility: rec.visibility },
    got,
  };
}

async function runBrowser() {
  const dist = path.resolve(flagArg('dist', path.join(ROOT, 'dist-online')));
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error(`no ${dist}/index.html`);
  const heads = (() => { const h = flagArg('heads', 'headless'); return h === 'both' ? ['headless', 'headful'] : [h]; })();
  const rounds = Number(flagArg('rounds', '1'));
  const layouts = (flagArg('layouts') || 'cross-oac').split(',');
  const modes = (flagArg('modes') || 'seq,batch4').split(',');
  const clipsArg = flagArg('clips');
  const clips = clipsArg ? clipsArg.split(',') : CLIPS;
  const devStage = flagArg('dev-stage', null);
  const handler = makeStaticHandler(dist);
  const servers = await Promise.all([serve(BASE, handler, '127.0.0.1'), serve(BASE + 1, handler, '127.0.0.1'), serve(BASE + 2, handler, '127.0.0.1')]);
  const parentUrl = `http://127.0.0.1:${BASE}/probe-parent`;
  const stageQ = 'stage=1&dual=1&id=B&lm=0';
  const LAYOUT = {
    'cross-oac': `http://127.0.0.1:${BASE + 2}/editor/?${stageQ}`,
    same: `http://127.0.0.1:${BASE}/editor/?${stageQ}`,
    dev: devStage ? `${devStage}/?${stageQ}` : null,
  };
  const rows = [];
  const file = path.join(OUT, `browser-${Date.now()}.json`);
  try {
    for (let r = 1; r <= rounds; r++) for (const head of heads) {
      const wl = winLoad();
      log(`\n=== browser round ${r} ${head} Win32 LoadPercentage=${wl}`);
      const runs = [...layouts.flatMap((l) => modes.map((m) => [l, m])), ...(devStage && r === 1 ? [['dev', 'seq']] : [])];
      for (const [layout, mode] of runs) {
        // 每个布局 × 趟别新起一个浏览器(OAC 的判定在 BrowsingInstance 里沿用,见 oac-probe.mjs)
        const browser = await launch(head);
        try {
          const version = await browser.version();
          const page = await browser.newPage();
          await page.setViewport({ width: 1000, height: 640 });
          const errors = [];
          page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));
          await page.goto(parentUrl, { waitUntil: 'load' });
          const caps = await page.evaluate((src) => window.__setup(src), LAYOUT[layout]);
          await sleep(1500);
          const tg = await (async () => { const cdp = await browser.target().createCDPSession(); const { targetInfos } = await cdp.send('Target.getTargets'); await cdp.detach().catch(() => {}); return targetInfos.filter((t) => t.type === 'iframe').map((t) => new URL(t.url).host); })();
          for (const clipId of clips) {
            const project = readJson(path.join(OUT, 'desktop', clipId, 'isolated.json'));
            const control = readJson(path.join(OUT, 'desktop', clipId, 'control.json'));
            const res = await bakeOne(page, { project, control, mode });
            const dir = path.join(OUT, `browser-${layout}-${mode}${READY ? '-ready' : ''}${process.argv.includes('--catalog') ? '-catalog' : ''}${r > 1 || head !== 'headless' ? `-r${r}-${head}` : ''}`, clipId);
            fs.mkdirSync(dir, { recursive: true });
            for (const [n, x] of Object.entries(res.got)) if (x) fs.writeFileSync(path.join(dir, `${n}.html`), x.html);
            const row = { round: r, head, winLoad: wl, version, layout, mode, clipId, oopif: tg, caps: { measure: caps?.measure, lowMemory: caps?.lowMemory }, errors: errors.slice(0, 3), ...res, got: undefined, count: control.count };
            rows.push(row);
            writeJson(file, rows);
            log(`${head.padEnd(8)} ${layout.padEnd(9)} ${mode.padEnd(6)} ${clipId.padEnd(15)} ${row.frames}/${control.count} fr ${row.wallMs} ms = ${row.fps} fps cpu ${row.cpu}% | snapshot inline p50 ${row.snapshotMs.inline.p50} raster p50 ${row.snapshotMs.raster.p50} | parent lt ${row.parent.longTasks} ${JSON.stringify(row.parent.ltMs.slice(0, 4))} rAF p95 ${row.parent.raf.p95} max ${row.parent.raf.max} | parent/frame p95 ${row.parent.parentFrameMs.p95} ms gz p50 ${row.parent.gzBytes.p50} html p50 ${row.parent.htmlBytes.p50} | oopif [${tg}] ${errors.length ? 'ERR ' + errors[0] : ''}`);
          }
        } catch (e) {
          rows.push({ round: r, head, layout, mode, error: String(e.stack || e) });
          log(`${layout} ${mode}: ERROR ${String(e.message || e)}`);
        } finally { await browser.close().catch(() => {}); }
      }
    }
  } finally { await closeAll(servers); }
  writeJson(file, rows);
  console.log(JSON.stringify({ file, rows: rows.length, errors: rows.filter((x) => x.error).length }));
}

/* ------------------------------------------------------------------ compare(P2) */

// 与 server/bakery/capture-snapshot.mjs 同一种挂法:整幅舞台大小的页面、#root 藏起、快照 HTML 挂在绝对定位的盒子里
async function rasterizer(browser, origin, width, height) {
  const page = await browser.newPage();
  await page.goto(`${origin}/probe-blank`, { waitUntil: 'load' });
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  return {
    async png(html, box) {
      await page.evaluate((h, b) => {
        document.getElementById('pc-frame-snapshot')?.remove();
        const wrap = document.createElement('div');
        wrap.id = 'pc-frame-snapshot';
        wrap.style.cssText = b ? `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px` : 'position:absolute;left:0;top:0;width:100%;height:100%';
        const t = document.createElement('template'); t.innerHTML = h; t.content.querySelectorAll('script').forEach((x) => x.remove());
        const plane = document.createElement('div'); plane.style.cssText = 'position:absolute;inset:0'; plane.appendChild(t.content); wrap.appendChild(plane);
        document.body.appendChild(wrap);
      }, html, box);
      await page.evaluate(async () => { await Promise.all([...document.querySelectorAll('#pc-frame-snapshot img')].map((i) => i.decode().catch(() => {}))); await document.fonts.ready; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
      return await page.screenshot({ type: 'png', omitBackground: true });
    },
    async diff(a, b) {
      // 两张 PNG 在页面里解码后逐像素比
      return page.evaluate(async (x, y) => {
        const dec = async (b64) => { const bm = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob()); const c = new OffscreenCanvas(bm.width, bm.height); const g = c.getContext('2d'); g.drawImage(bm, 0, 0); return g.getImageData(0, 0, bm.width, bm.height); };
        const A = await dec(x), B = await dec(y);
        if (A.width !== B.width || A.height !== B.height) return { size: [A.width, A.height, B.width, B.height] };
        let sum = 0, over = 0, maxd = 0, n = A.width * A.height; let sq = 0;
        for (let i = 0; i < A.data.length; i += 4) { let m = 0; for (let k = 0; k < 4; k++) { const d = Math.abs(A.data[i + k] - B.data[i + k]); sum += d; sq += d * d; if (d > m) m = d; } if (m > 16) over++; if (m > maxd) maxd = m; }
        const mse = sq / (n * 4);
        return { mad: +(sum / (n * 4)).toFixed(3), psnr: mse ? +(10 * Math.log10(255 * 255 / mse)).toFixed(2) : Infinity, over16Pct: +(100 * over / n).toFixed(3), maxd };
      }, a.toString('base64'), b.toString('base64'));
    },
    close: () => page.close(),
  };
}

// 归一:去掉内联样式里的 CSS 自定义属性(在线构建压缩了 CSS,`--x: 0.4` 成了 `.4`)与 `will-change`(Motion 动画进行中才挂)
const stripVars = (h) => h.replace(/--[A-Za-z0-9_-]+:[^;"]*;?/g, '');
const stripWillChange = (h) => h.replace(/will-change:[^;"]*;?/g, '');

async function runCompare() {
  const { compareSnapshotHtml } = await import('../../src/render/snapshotCompare.mjs');
  const variants = fs.readdirSync(OUT).filter((n) => n.startsWith('browser-') && fs.statSync(path.join(OUT, n)).isDirectory());
  const pairs = [];
  for (const v of variants) pairs.push(['desktop', v]);
  if (variants.includes('browser-cross-oac-seq') && variants.includes('browser-cross-oac-batch4')) pairs.push(['browser-cross-oac-seq', 'browser-cross-oac-batch4']);
  if (variants.includes('browser-cross-oac-seq') && variants.includes('browser-dev-seq')) pairs.push(['browser-dev-seq', 'browser-cross-oac-seq']);
  if (variants.includes('browser-cross-oac-probe') && variants.includes('browser-cross-oac-seq-ready')) pairs.push(['browser-cross-oac-seq-ready', 'browser-cross-oac-probe']);
  if (variants.includes('browser-cross-oac-seq-ready') && variants.includes('browser-cross-oac-batch4-ready')) pairs.push(['browser-cross-oac-seq-ready', 'browser-cross-oac-batch4-ready']);
  const res = { pairs: {} };
  const firstDiffs = {};
  for (const [a, b] of pairs) {
    const key = `${a} vs ${b}`;
    res.pairs[key] = {};
    for (const clipId of CLIPS) {
      const da = path.join(OUT, a, clipId), db = path.join(OUT, b, clipId);
      if (!fs.existsSync(da) || !fs.existsSync(db)) continue;
      const count = readJson(path.join(OUT, 'desktop', clipId, 'control.json')).count;
      let same = 0, tolSame = 0, missA = 0, missB = 0, sameNoVars = 0, sameNoVarsWc = 0; const reasons = {}; let first = null;
      for (let n = 0; n < count; n++) {
        const fa = path.join(da, `${n}.html`), fb = path.join(db, `${n}.html`);
        const ha = fs.existsSync(fa) ? fs.readFileSync(fa, 'utf8') : null;
        const hb = fs.existsSync(fb) ? fs.readFileSync(fb, 'utf8') : null;
        if (ha === null) { missA++; continue; }
        if (hb === null) { missB++; continue; }
        if (sha256(ha) === sha256(hb)) { same++; sameNoVars++; sameNoVarsWc++; continue; }
        if (stripVars(ha) === stripVars(hb)) sameNoVars++;
        if (stripWillChange(stripVars(ha)) === stripWillChange(stripVars(hb))) sameNoVarsWc++;
        const c = compareSnapshotHtml(ha, hb);
        if (c.same) { tolSame++; continue; }
        const r = c.reason; reasons[r] = (reasons[r] || 0) + 1;
        if (!first) first = { frame: n, reason: c.reason, at: c.at, expected: String(c.expected ?? '').slice(0, 300), actual: String(c.actual ?? '').slice(0, 300), attr: c.attr, lenA: ha.length, lenB: hb.length };
      }
      res.pairs[key][clipId] = { count, bytesSame: same, sameIgnoringCssVars: sameNoVars, sameIgnoringCssVarsAndWillChange: sameNoVarsWc, sameWithin1e6: tolSame, differ: count - same - tolSame - missA - missB, missA, missB, reasons };
      if (first) firstDiffs[`${key} ${clipId}`] = first;
      log(`${key.padEnd(52)} ${clipId.padEnd(15)} same ${same} noVars ${sameNoVars} noVars+wc ${sameNoVarsWc} tol ${tolSame} differ ${res.pairs[key][clipId].differ} miss ${missA}/${missB} ${JSON.stringify(reasons)}`);
    }
  }
  res.firstDiffs = firstDiffs;
  // 像素:desktop 与 browser-cross-oac-seq 的 HTML 各截一张(与活渲 PNG 比,如果桌面留了活渲 PNG)
  const frames = (flagArg('frames') || '0,1,15,30,59').split(',').map(Number);
  const handler = makeStaticHandler(path.join(ROOT, 'dist-online'));
  const server = await serve(BASE, handler, '127.0.0.1');
  const browser = await launch('headless');
  res.pixels = {};
  try {
    const rz = await rasterizer(browser, `http://127.0.0.1:${BASE}`, PROJECT.width, PROJECT.height);
    fs.mkdirSync(path.join(OUT, 'pixels'), { recursive: true });
    for (const clipId of CLIPS) {
      const clip = PROJECT.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
      const f = clip.frame; const box = f ? { x: f.x - f.w * f.anchor[0], y: f.y - f.h * f.anchor[1], w: f.w, h: f.h } : null;
      for (const n of frames) {
        const fa = path.join(OUT, 'desktop', clipId, `${n}.html`), fb = path.join(OUT, flagArg('pix-variant', 'browser-cross-oac-seq'), clipId, `${n}.html`);
        if (!fs.existsSync(fa) || !fs.existsSync(fb)) continue;
        const pa = await rz.png(fs.readFileSync(fa, 'utf8'), box), pb = await rz.png(fs.readFileSync(fb, 'utf8'), box);
        fs.writeFileSync(path.join(OUT, 'pixels', `${clipId}-${n}-desktop.png`), pa);
        fs.writeFileSync(path.join(OUT, 'pixels', `${clipId}-${n}-browser.png`), pb);
        const row = { htmlShot: await rz.diff(pa, pb) };
        const live = path.join(OUT, 'desktop', clipId, 'live', String(n).padStart(6, '0') + '.png');
        if (fs.existsSync(live)) { const lp = fs.readFileSync(live); row.liveVsBrowser = await rz.diff(lp, pb); row.liveVsDesktop = await rz.diff(lp, pa); }
        (res.pixels[clipId] ||= {})[n] = row;
        log(`pixels ${clipId} #${n} ${JSON.stringify(row)}`);
      }
    }
    await rz.close();
  } finally { await browser.close().catch(() => {}); await closeAll([server]); }
  writeJson(path.join(OUT, 'compare.json'), res);
  console.log(JSON.stringify({ pairs: res.pairs, pixels: res.pixels }));
}

/* ------------------------------------------------------------------ small(P3) */

async function runSmall() {
  const variant = flagArg('variant', 'browser-cross-oac-seq');
  // `--css <在线构建目录>`:把构建出的全局样式表(Tailwind 基础层 + 主题)整份放进 foreignObject 的 <style>。
  // 快照只内联「与同标签基线不同」的非继承属性(snapshotStyleProps.mjs),基线靠重放页的全局样式;SVG 图像是独立文档,没有它就走 UA 默认
  const cssDist = flagArg('css', null);
  const css = cssDist ? fs.readdirSync(path.join(cssDist, 'assets')).filter((n) => n.endsWith('.css')).map((n) => fs.readFileSync(path.join(cssDist, 'assets', n), 'utf8')).join('\n') : '';
  const tag = css ? '-css' : '';
  const frames = (flagArg('frames') || '0,15,30,59').split(',').map(Number);
  const { smallSize } = await import('../../server/bakery/small-bitmap.mjs');
  const handler = makeStaticHandler(path.join(ROOT, 'dist-online'));
  const servers = await Promise.all([serve(BASE, handler, '127.0.0.1'), serve(BASE + 2, handler, '127.0.0.1')]);
  const browser = await launch('headless');
  const res = { variant, css: !!css, cssBytes: css.length, cards: {} };
  fs.mkdirSync(path.join(OUT, 'small'), { recursive: true });
  try {
    const page = await browser.newPage();
    // 舞台的源上(契约 4.4:小尺寸在舞台里生成)
    await page.goto(`http://127.0.0.1:${BASE + 2}/probe-blank`, { waitUntil: 'load' });
    const lts = [];
    for (const clipId of CLIPS) {
      const clip = PROJECT.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
      const size = smallSize({ projectWidth: PROJECT.width, projectHeight: PROJECT.height, boxWidth: clip.frame?.w ?? PROJECT.width, boxHeight: clip.frame?.h ?? PROJECT.height });
      const rowsC = {};
      for (const n of frames) {
        const fh = path.join(OUT, variant, clipId, `${n}.html`);
        const fd = path.join(OUT, 'desktop', clipId, `${n}.small.webp`);
        if (!fs.existsSync(fh) || !fs.existsSync(fd)) continue;
        const html = fs.readFileSync(fh, 'utf8');
        const out = await page.evaluate(async ({ html, w, h, bw, bh, s, desk, css }) => {
          const lt = []; const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push(e.duration); }); po.observe({ type: 'longtask' });
          const t0 = performance.now();
          // HTML 片段 → XHTML(foreignObject 里要合法 XML):借 DOM 解析再用 XMLSerializer 输出
          const tpl = document.createElement('template'); tpl.innerHTML = html; tpl.content.querySelectorAll('script').forEach((x) => x.remove());
          const div = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
          div.setAttribute('style', `position:absolute;left:0;top:0;width:${bw}px;height:${bh}px;transform:scale(${s});transform-origin:0 0;isolation:isolate;overflow:visible`);
          const plane = document.createElementNS('http://www.w3.org/1999/xhtml', 'div'); plane.setAttribute('style', 'position:absolute;inset:0'); plane.appendChild(tpl.content); div.appendChild(plane);
          if (css) { const st = document.createElementNS('http://www.w3.org/1999/xhtml', 'style'); st.textContent = css; div.insertBefore(st, div.firstChild); }
          const xhtml = new XMLSerializer().serializeToString(div);
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="${w}" height="${h}">${xhtml}</foreignObject></svg>`;
          const tSer = performance.now();
          const img = new Image(); img.decoding = 'sync';
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
          let loadErr = null; try { await img.decode(); } catch (e) { loadErr = String(e); }
          const tDec = performance.now();
          const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
          let tainted = false, taintErr = null;
          try { g.getImageData(0, 0, 1, 1); c.toDataURL('image/png').slice(0, 10); } catch (e) { tainted = true; taintErr = String(e.name || e); }
          const blob = tainted ? null : await new Promise((r) => c.toBlob(r, 'image/webp', 0.8));
          const t1 = performance.now();
          // 与桌面 CDP 的小位图逐像素比
          const deskBm = await createImageBitmap(await (await fetch('data:image/webp;base64,' + desk)).blob());
          const dc = new OffscreenCanvas(deskBm.width, deskBm.height); const dg = dc.getContext('2d'); dg.drawImage(deskBm, 0, 0); const D = dg.getImageData(0, 0, deskBm.width, deskBm.height);
          const bb = blob ? await createImageBitmap(blob) : null;
          let diff = null;
          if (bb) {
            const bc = new OffscreenCanvas(bb.width, bb.height); const bg = bc.getContext('2d'); bg.drawImage(bb, 0, 0); const B = bg.getImageData(0, 0, bb.width, bb.height);
            if (B.width === D.width && B.height === D.height) {
              let sum = 0, sq = 0, over = 0, maxd = 0, adiff = 0, opaqueA = 0, opaqueB = 0, pmSum = 0, pmOver = 0, pmMax = 0; const n = B.width * B.height;
              const dimg = new ImageData(B.width, B.height);
              for (let i = 0; i < B.data.length; i += 4) { let m = 0; for (let k = 0; k < 4; k++) { const d = Math.abs(B.data[i + k] - D.data[i + k]); sum += d; sq += d * d; if (d > m) m = d; } if (m > 16) over++; if (m > maxd) maxd = m; adiff += Math.abs(B.data[i + 3] - D.data[i + 3]);
                // 预乘后的差(近乎透明的像素 RGB 没有意义,不该算进去)
                let pm = Math.abs(B.data[i + 3] - D.data[i + 3]); for (let k = 0; k < 3; k++) pm = Math.max(pm, Math.abs(B.data[i + k] * B.data[i + 3] - D.data[i + k] * D.data[i + 3]) / 255); pmSum += pm; if (pm > 16) pmOver++; if (pm > pmMax) pmMax = pm; if (D.data[i + 3] > 8) opaqueA++; if (B.data[i + 3] > 8) opaqueB++; dimg.data[i] = Math.min(255, m * 4); dimg.data[i + 1] = 0; dimg.data[i + 2] = 0; dimg.data[i + 3] = 255; }
              const mse = sq / (n * 4);
              const oc = new OffscreenCanvas(B.width, B.height); oc.getContext('2d').putImageData(dimg, 0, 0);
              const diffPng = await oc.convertToBlob({ type: 'image/png' });
              const u8 = new Uint8Array(await diffPng.arrayBuffer()); let bin = ''; for (let k = 0; k < u8.length; k += 32768) bin += String.fromCharCode(...u8.subarray(k, k + 32768));
              diff = { pmMad: +(pmSum / n).toFixed(3), pmOver16Pct: +(100 * pmOver / n).toFixed(3), pmMax: Math.round(pmMax), mad: +(sum / (n * 4)).toFixed(3), psnr: mse ? +(10 * Math.log10(65025 / mse)).toFixed(2) : Infinity, over16Pct: +(100 * over / n).toFixed(3), maxd, alphaMad: +(adiff / n).toFixed(3), coverageDesk: +(100 * opaqueA / n).toFixed(2), coverageFo: +(100 * opaqueB / n).toFixed(2), diffPng: btoa(bin) };
            } else diff = { size: [B.width, B.height, D.width, D.height] };
          }
          po.disconnect();
          const webp = blob ? new Uint8Array(await blob.arrayBuffer()) : null; let wb = ''; if (webp) for (let k = 0; k < webp.length; k += 32768) wb += String.fromCharCode(...webp.subarray(k, k + 32768));
          return { tainted, taintErr, loadErr, serializeMs: +(tSer - t0).toFixed(1), decodeMs: +(tDec - tSer).toFixed(1), drawEncodeMs: +(t1 - tDec).toFixed(1), totalMs: +(t1 - t0).toFixed(1), svgBytes: svg.length, webpBytes: webp ? webp.length : 0, deskSize: [deskBm.width, deskBm.height], longTasks: lt, diff, webp: wb ? btoa(wb) : null };
        }, { html, w: size.width, h: size.height, bw: clip.frame?.w ?? PROJECT.width, bh: clip.frame?.h ?? PROJECT.height, s: size.scale, desk: fs.readFileSync(fd).toString('base64'), css });
        if (out.webp) fs.writeFileSync(path.join(OUT, 'small', `${clipId}-${n}-fo${tag}.webp`), Buffer.from(out.webp, 'base64'));
        if (out.diff?.diffPng) fs.writeFileSync(path.join(OUT, 'small', `${clipId}-${n}-diff${tag}.png`), Buffer.from(out.diff.diffPng, 'base64'));
        fs.copyFileSync(fd, path.join(OUT, 'small', `${clipId}-${n}-cdp.webp`));
        delete out.webp; if (out.diff) delete out.diff.diffPng;
        rowsC[n] = out; lts.push(...out.longTasks);
        log(`small ${clipId} #${n} ${JSON.stringify(out)}`);
      }
      res.cards[clipId] = { size, frames: rowsC };
    }
  } finally { await browser.close().catch(() => {}); await closeAll(servers); }
  writeJson(path.join(OUT, `small${tag}.json`), res);
  console.log(JSON.stringify(res));
}

const RUN = { desktop: runDesktop, browser: runBrowser, compare: runCompare, small: runSmall }[CMD];
if (!RUN) { log(`unknown command ${CMD}`); process.exit(2); }
await RUN();
