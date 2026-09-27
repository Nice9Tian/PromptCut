// C10 其余（在线浏览器模式 L1 后台舞台 / L2 页面内快照库）的可行性探针。报告：docs/reports/AGENT-c10-probe.md。
//
// 四组实验，全部用 puppeteer 自带的 Chrome，自起静态服务（端口段 --port-base 起 10 个，缺省 5420～5429）：
//
//   P1 进程隔离与主文档长任务：父页 + 可见舞台 iframe + 后台舞台 iframe（opacity 0 叠在原位）。后台舞台跑
//      busy（150～300 ms 忙循环）、snap（真实的 createSnapshot，逐帧推一个有状态的粒子场景）、snapidb（snap 且把
//      控件 HTML postMessage 给父页，父页 deflate 后写 IndexedDB，即 L2 的路子）。父页与可见舞台量 longtask 与 rAF 间隔。
//      布置：a-same（舞台与父页同源）、b-port（同主机换端口）、c-port-oac（换端口 + Origin-Agent-Cluster: ?1）、
//            d-sub（同站子域 editor./s1./s2.pc.test，同端口）、e-sub-oac（子域 + OAC）。
//   P2 后台舞台的节拍：跨源 + OAC 的后台 iframe 放在不同位置（原位 opacity 0 / translate 到屏外 / left:-10000px /
//      1×1 / visibility:hidden），页面可见、切到另一个标签（hidden）、窗口最小化（仅有头）三种状态下，
//      数 rAF、setTimeout(0) 链、requestIdleCallback（无超时 / 1000 ms 超时）每秒回调数，以及「每次 rIC 推一帧」的
//      L1 调度每秒能推几帧（轻场景、重场景两种）。
//   P3 IndexedDB：父页写 20～200 KB 的随机字节条目到 256 MiB（每帧一个事务），读回；estimate() / persist()；
//      用 CDP Storage.overrideQuotaForOrigin 压低配额，写到 QuotaExceededError 后「回收一批再试一次」；
//      跨源舞台 iframe 看不看得到父页的库；隐身上下文的 estimate()。
//   P4 跨源舞台读素材：起托管组合 server/hosted/main.mjs（临时数据目录），舞台从另一个源读 /api/asset/media
//      （Range、Bearer 预检、<video>/<img> 有无 crossorigin、画到 canvas 后能否 toDataURL），对照
//      「去掉 CORS 头的代理」和「舞台自己源下前缀反代 /media」。另起一次 PROMPTCUT_TEST_NO_LOOPBACK_TRUST=1 看 401 读不读得到。
//
// 用法：
//   node scripts/probes/c10-stage-probe.mjs p1 [--rounds 3] [--heads both|headful|headless] [--modes busy,snap,snapidb]
//                                              [--layouts a-same,b-port,...] [--n 500]
//   node scripts/probes/c10-stage-probe.mjs p2 [--rounds 3] [--heads both] [--places ...] [--hidden-places overlay-opacity0,translate-offscreen]
//   node scripts/probes/c10-stage-probe.mjs p3 [--heads both] [--total-mib 256]
//   node scripts/probes/c10-stage-probe.mjs p3q                        真实配额撞 QuotaExceededError（临时占约 10 GiB 磁盘，见 runP3Quota）
//   node scripts/probes/c10-stage-probe.mjs p4 [--heads headless]
//   node scripts/probes/c10-stage-probe.mjs calibrate [--n 500]      只量 createSnapshot 的单帧耗时
//   公共：--gpu on（不加 --disable-gpu；本机 GPU 路径下 rAF 只有 ~11 次 / 秒，所以缺省加）、--out <目录>（JSON 与构建的 snap.js，缺省系统临时目录下 c10-stage-probe）、--port-base 5420
//
// 说明：
// - createSnapshot 是 src/render/createSnapshot.ts 本体，开跑时用 rolldown 打成 IIFE 放进 --out，不入库。
// - 启动 Chrome 时去掉 puppeteer 缺省的 --disable-background-timer-throttling、--disable-backgrounding-occluded-windows、
//   --disable-renderer-backgrounding 和它那一串 --disable-features，让节流与进程模型和用户的 Chrome 一致。
// - 子域用 --host-resolver-rules 把 *.pc.test 指到 127.0.0.1，并用 --unsafely-treat-insecure-origin-as-secure 让它们
//   算安全上下文（线上是 HTTPS）。
// - 每个 P1 用例都新起一个浏览器，免得「这个源是不是 origin-keyed」的判定在 BrowsingInstance 里沿用（见 oac-probe.mjs）。
// - 每个用例记系统 CPU 占用（os.cpus() 在测量窗口内的差值）；每轮开头记一次 Win32_Processor LoadPercentage。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { flagArg, serve, closeAll, sleep } from './probe-connect.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CMD = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'p1';
const OUT = path.resolve(flagArg('out', path.join(os.tmpdir(), 'c10-stage-probe')));
const BASE = Number(flagArg('port-base', '5420'));
const ROUNDS = Number(flagArg('rounds', '3'));
const HEADS = (() => { const h = flagArg('heads', 'both'); return h === 'both' ? ['headful', 'headless'] : [h]; })();
const N_HEAVY = Number(flagArg('n', '500'));
// 本机 GPU 路径下 rAF 只有 ~11 次 / 秒（报告「环境」一节），缺省加 --disable-gpu 走软件合成器（有头 180 Hz、无头 60 Hz）
const GPU = flagArg('gpu', 'off') === 'on';
const PORT = { parent: BASE, s1: BASE + 1, s2: BASE + 2, sub: BASE + 3, p4stage: BASE + 4, p4strip: BASE + 5, p4prefix: BASE + 6, doc: BASE + 8, asset: BASE + 9 };
fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ 公共 */

const log = (...a) => console.log(...a);
const cpuTimes = () => os.cpus().map((c) => c.times);
function cpuPct(a, b) {
  let idle = 0, total = 0;
  for (let i = 0; i < a.length; i++) {
    for (const k of Object.keys(a[i])) total += b[i][k] - a[i][k];
    idle += b[i].idle - a[i].idle;
  }
  return total ? +(100 * (1 - idle / total)).toFixed(1) : null;
}
function winLoad() {
  try {
    return Number(execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average'], { encoding: 'utf8', timeout: 20000 }).trim());
  } catch { return null; }
}
function stats(xs) {
  if (!xs || !xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1), over50: s.filter((x) => x > 50).length, mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) };
}

const SUB_HOSTS = ['editor.pc.test', 's1.pc.test', 's2.pc.test'];
async function launch(head, extra = []) {
  const secure = SUB_HOSTS.map((h) => `http://${h}:${PORT.sub}`).join(',');
  const defaults = await puppeteer.defaultArgs({ headless: head === 'headless' });
  const ignore = ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    ...defaults.filter((a) => a.startsWith('--disable-features='))];
  return puppeteer.launch({
    headless: head === 'headless',
    ignoreDefaultArgs: ignore,
    defaultViewport: null,
    protocolTimeout: 300000,
    args: [...(GPU ? [] : ['--disable-gpu']), '--window-size=1100,820', '--window-position=40,40', `--host-resolver-rules=MAP *.pc.test 127.0.0.1`, `--unsafely-treat-insecure-origin-as-secure=${secure}`, ...extra],
  });
}

/** 把 src/render/createSnapshot.ts 打成 IIFE（全局 PCSnap） */
async function buildSnap() {
  const file = path.join(OUT, 'snap.js');
  const { build } = await import('rolldown');
  await build({ cwd: ROOT, input: path.join(ROOT, 'src/render/createSnapshot.ts'), output: { format: 'iife', name: 'PCSnap', file }, write: true, logLevel: 'silent' });
  return fs.readFileSync(file, 'utf8');
}

/* ------------------------------------------------------------------ 页面 */

// 舞台页：一个有状态的粒子场景（每帧位置由上一帧推出，照 stateful 推帧卡的样子），可见舞台每个 rAF 推一帧（播放），
// 后台舞台收到 start 后按 mode 干活。所有结果经 postMessage 回父页。
const STAGE_HTML = `<!doctype html><meta charset=utf-8><title>stage</title>
<style>
body{margin:0;background:#123;overflow:hidden;font-family:sans-serif}
.p{position:absolute;left:0;top:0;width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 30% 30%,#fff,#39f 60%,#036);box-shadow:0 0 6px rgba(80,160,255,.8);color:#fff;font-size:10px;line-height:22px;text-align:center}
.p:nth-child(3n){background:radial-gradient(circle,#ffd,#f93 60%,#630);border-radius:4px}
.p:nth-child(5n){filter:blur(1px);text-shadow:0 0 3px #000}
</style>
<body><div data-pc-scene id=scene style="position:absolute;inset:0"><div data-pc-clip="c1" data-pc-local-frame="0" id=clip style="position:absolute;inset:0"></div></div>
<script src="/snap.js"></script>
<script>
const Q = new URLSearchParams(location.search);
const role = Q.get('role') || 'bg';
let parts = [];
const clip = document.getElementById('clip');
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function scene(n, ids) {
  clip.textContent = ''; parts = [];
  for (let i = 0; i < n; i++) { const d = document.createElement('div'); d.className = 'p'; if (ids) d.id = 'p' + i; d.textContent = i % 100; clip.appendChild(d);
    parts.push({ el: d, x: rnd() * 600, y: rnd() * 340, vx: rnd() * 4 - 2, vy: rnd() * 4 - 2, h: rnd() * 360 }); }
}
let frame = 0;
function step() {
  frame++;
  for (const p of parts) { p.x += p.vx; p.y += p.vy; if (p.x < 0 || p.x > 620) p.vx = -p.vx; if (p.y < 0 || p.y > 340) p.vy = -p.vy; p.h = (p.h + 1.7) % 360;
    p.el.style.transform = 'translate(' + p.x.toFixed(1) + 'px,' + p.y.toFixed(1) + 'px) rotate(' + ((frame * 3) % 360) + 'deg)';
    p.el.style.opacity = (0.4 + 0.6 * Math.abs(Math.sin((frame + p.h) / 20))).toFixed(2); p.el.style.color = 'hsl(' + p.h.toFixed(0) + ',80%,70%)'; }
  clip.dataset.pcLocalFrame = String(frame);
}
scene(+(Q.get('n') || (role === 'vis' ? 120 : 500)));

const lts = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) lts.push(+e.duration.toFixed(1)); }).observe({ type: 'longtask' }); } catch {}
let rec = null, last = performance.now();
(function raf() { const now = performance.now(); if (rec) rec.gaps.push(now - last); last = now; if (role === 'vis') step(); requestAnimationFrame(raf); })();

let working = false, units = [], mode = 'busy', post = false, htmlBytes = 0;
function unit() {
  if (!working) return;
  const t0 = performance.now();
  if (mode === 'busy') { const d = 150 + Math.random() * 150; while (performance.now() - t0 < d) {} }
  else { step(); const s = PCSnap.createSnapshot(document.getElementById('scene')); const h = s.controls[0] ? s.controls[0].html : s.html; htmlBytes = h.length;
    if (post) parent.postMessage({ kind: 'snap', frame, html: h }, '*'); }
  units.push(performance.now() - t0);
  setTimeout(unit, 0);
}

// P2：节拍计数
let tick = null;
function cadence(kind, n) {
  const c = { kind, count: 0, work: [], t0: performance.now(), vis: document.visibilityState };
  tick = c;
  const alive = () => tick === c;
  if (kind === 'raf') (function f() { if (!alive()) return; c.count++; requestAnimationFrame(f); })();
  if (kind === 'timeout0') (function f() { if (!alive()) return; c.count++; setTimeout(f, 0); })();
  if (kind === 'timeout16') (function f() { if (!alive()) return; c.count++; setTimeout(f, 16); })();
  if (kind === 'ric') (function f() { if (!alive()) return; requestIdleCallback(() => { if (!alive()) return; c.count++; f(); }); })();
  if (kind === 'ric1000') (function f() { if (!alive()) return; requestIdleCallback(() => { if (!alive()) return; c.count++; f(); }, { timeout: 1000 }); })();
  // bakeT：每帧之间只让一次 setTimeout(0)，是「页面空闲时」能推的上限
  if (kind === 'bakeT') { scene(n); (function f() { if (!alive()) return; setTimeout(() => { if (!alive()) return; const t = performance.now(); step(); PCSnap.createSnapshot(document.getElementById('scene')); c.work.push(performance.now() - t); c.count++; f(); }, 0); })(); }
  // bakeRT：rIC（无超时）只当「此刻空闲」的门闸，门闸过了再用 setTimeout(0) 做一帧
  if (kind === 'bakeRT') { scene(n); (function f() { if (!alive()) return; requestIdleCallback(() => setTimeout(() => { if (!alive()) return; const t = performance.now(); step(); PCSnap.createSnapshot(document.getElementById('scene')); c.work.push(performance.now() - t); c.count++; f(); }, 0)); })(); }
  if (kind === 'bake') { scene(n); (function f() { if (!alive()) return; requestIdleCallback((dl) => { if (!alive()) return; const t = performance.now(); step(); PCSnap.createSnapshot(document.getElementById('scene')); c.work.push(performance.now() - t); c.count++; f(); }, { timeout: 1000 }); })(); }
}

addEventListener('message', (e) => {
  const m = e.data || {};
  const reply = (x) => parent.postMessage(Object.assign({ reqId: m.reqId }, x), '*');
  if (m.cmd === 'rec-start') { rec = { gaps: [], lt0: lts.length }; reply({ ok: true }); }
  if (m.cmd === 'rec-stop') { const r = rec; rec = null; reply({ gaps: r ? r.gaps : [], lts: lts.slice(r ? r.lt0 : 0) }); }
  if (m.cmd === 'start') { mode = m.mode; post = !!m.post; units = []; working = true; setTimeout(unit, 0); reply({ ok: true }); }
  if (m.cmd === 'stop') { working = false; reply({ units, htmlBytes, oac: window.originAgentCluster, crossOriginIsolated: window.crossOriginIsolated }); }
  if (m.cmd === 'cadence') { cadence(m.kind, m.n); reply({ ok: true }); }
  if (m.cmd === 'cadence-stop') { const c = tick; tick = null; const dt = performance.now() - c.t0; reply({ kind: c.kind, count: c.count, ms: dt, perSec: +(c.count * 1000 / dt).toFixed(2), work: c.work, visAtStart: c.vis, visAtEnd: document.visibilityState }); }
  if (m.cmd === 'idb-count') { const req = indexedDB.open(m.db); req.onsuccess = () => { const db = req.result; if (!db.objectStoreNames.contains('s')) { reply({ count: 0, stores: [...db.objectStoreNames] }); db.close(); indexedDB.deleteDatabase(m.db); return; }
      const r2 = db.transaction('s').objectStore('s').count(); r2.onsuccess = () => { reply({ count: r2.result }); db.close(); }; }; req.onerror = () => reply({ error: String(req.error) }); }
  if (m.cmd === 'estimate') { (navigator.storage ? navigator.storage.estimate() : Promise.resolve(null)).then((x) => reply({ estimate: x, origin: location.origin, oac: window.originAgentCluster })); }
  if (m.cmd === 'calib') { scene(m.n, m.ids); const t = []; let bytes = 0, html = ''; for (let i = 0; i < m.frames; i++) { step(); const t0 = performance.now(); const s = PCSnap.createSnapshot(document.getElementById('scene')); t.push(performance.now() - t0); bytes = s.controls[0].html.length; html = s.html; }
    let h = 0x811c9dc5; for (let i = 0; i < html.length; i++) h = Math.imul(h ^ html.charCodeAt(i), 16777619);
    reply({ t, bytes, sceneBytes: html.length, sceneHash: (h >>> 0).toString(16) }); }
});
parent.postMessage({ kind: 'ready', role, origin: location.origin }, '*');
</script>`;

// 父页：可见舞台 + 后台舞台（opacity 0 叠在原位），自己也有一条轻动画（时间轴播放头）。
const PARENT_HTML = `<!doctype html><meta charset=utf-8><title>parent</title>
<body style="margin:0;font:12px sans-serif">
<div id=wrap style="position:relative;width:640px;height:360px;margin:8px">
  <iframe id=vis style="position:absolute;left:0;top:0;width:640px;height:360px;border:0"></iframe>
  <iframe id=bg style="position:absolute;left:0;top:0;width:640px;height:360px;border:0;opacity:0;pointer-events:none"></iframe>
</div>
<div style="position:relative;width:640px;height:24px;margin:8px;background:#ddd"><div id=head style="position:absolute;top:0;width:2px;height:24px;background:#c00"></div></div>
<div id=status></div>
<script>
const Q = new URLSearchParams(location.search);
const lts = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) lts.push({ d: +e.duration.toFixed(1), name: e.name, attr: (e.attribution || []).map((a) => a.containerType + ':' + a.containerSrc).join('|') }); }).observe({ type: 'longtask' }); } catch {}
let rec = null, last = performance.now(), f = 0;
(function raf() { const now = performance.now(); if (rec) rec.push(now - last); last = now; f++; document.getElementById('head').style.left = (f % 640) + 'px'; requestAnimationFrame(raf); })();
const ready = {};
let seq = 0; const waiting = new Map();
let idb = null, writes = 0, writeBytes = 0, writeMs = [];
function openIdb() { return new Promise((res, rej) => { const r = indexedDB.open('c10probe-p1', 1); r.onupgradeneeded = () => r.result.createObjectStore('snapshots'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function deflate(str) { const s = new Blob([str]).stream().pipeThrough(new CompressionStream('deflate')); return new Uint8Array(await new Response(s).arrayBuffer()); }
addEventListener('message', async (e) => {
  const m = e.data || {};
  if (m.kind === 'ready') { ready[m.role] = m.origin; return; }
  if (m.kind === 'snap') { if (!idb) return; const t0 = performance.now(); const z = await deflate(m.html);
    await new Promise((res) => { const tx = idb.transaction('snapshots', 'readwrite'); tx.objectStore('snapshots').put(z, ['snap', 'c1', m.frame]); tx.oncomplete = res; tx.onerror = res; });
    writes++; writeBytes += z.length; writeMs.push(performance.now() - t0); return; }
  if (m.reqId !== undefined && waiting.has(m.reqId)) { waiting.get(m.reqId)(m); waiting.delete(m.reqId); }
});
window.__ask = (which, msg) => new Promise((res) => { const reqId = ++seq; waiting.set(reqId, res); document.getElementById(which).contentWindow.postMessage(Object.assign({ reqId }, msg), '*'); });
window.__setup = async (vis, bg) => { if (vis) document.getElementById('vis').src = vis; else document.getElementById('vis').remove(); document.getElementById('bg').src = bg;
  const t0 = performance.now(); while ((vis && !ready.vis) || !ready.bg) { if (performance.now() - t0 > 20000) throw new Error('stage not ready'); await new Promise((r) => setTimeout(r, 50)); } return ready; };
window.__recStart = async (withVis) => { rec = []; window.__lt0 = lts.length; if (withVis) await __ask('vis', { cmd: 'rec-start' }); };
window.__recStop = async (withVis) => { const gaps = rec; rec = null; const v = withVis ? await __ask('vis', { cmd: 'rec-stop' }) : null; return { gaps, lts: lts.slice(window.__lt0), vis: v, visibility: document.visibilityState, focus: document.hasFocus() }; };
window.__idbOn = async () => { idb = await openIdb(); };
window.__idbStats = () => ({ writes, writeBytes, writeMs });
window.__place = (css) => { Object.assign(document.getElementById('bg').style, css); };
</script>`;

/* ------------------------------------------------------------------ 服务 */

let CASE = { oac: false };
function makeHandler(SNAP) {
  return (req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (type, body) => { res.setHeader('Content-Type', type); res.setHeader('Cache-Control', 'no-store'); if (CASE.oac) res.setHeader('Origin-Agent-Cluster', '?1'); res.end(body); };
    if (u.pathname === '/snap.js') return send('text/javascript', SNAP);
    if (u.pathname === '/stage') return send('text/html; charset=utf-8', STAGE_HTML);
    if (u.pathname === '/' || u.pathname === '/parent') return send('text/html; charset=utf-8', PARENT_HTML);
    res.statusCode = 404; res.end();
  };
}
async function startStatic(SNAP) {
  const h = makeHandler(SNAP);
  return Promise.all([serve(PORT.parent, h, '127.0.0.1'), serve(PORT.s1, h, '127.0.0.1'), serve(PORT.s2, h, '127.0.0.1'), serve(PORT.sub, h, '127.0.0.1')]);
}

const LAYOUTS = {
  'a-same': { oac: false, parent: `http://127.0.0.1:${PORT.parent}/`, vis: `http://127.0.0.1:${PORT.parent}/stage?role=vis`, bg: `http://127.0.0.1:${PORT.parent}/stage?role=bg` },
  'b-port': { oac: false, parent: `http://127.0.0.1:${PORT.parent}/`, vis: `http://127.0.0.1:${PORT.s1}/stage?role=vis`, bg: `http://127.0.0.1:${PORT.s2}/stage?role=bg` },
  'c-port-oac': { oac: true, parent: `http://127.0.0.1:${PORT.parent}/`, vis: `http://127.0.0.1:${PORT.s1}/stage?role=vis`, bg: `http://127.0.0.1:${PORT.s2}/stage?role=bg` },
  'd-sub': { oac: false, parent: `http://editor.pc.test:${PORT.sub}/`, vis: `http://s1.pc.test:${PORT.sub}/stage?role=vis`, bg: `http://s2.pc.test:${PORT.sub}/stage?role=bg` },
  'e-sub-oac': { oac: true, parent: `http://editor.pc.test:${PORT.sub}/`, vis: `http://s1.pc.test:${PORT.sub}/stage?role=vis`, bg: `http://s2.pc.test:${PORT.sub}/stage?role=bg` },
};

/**
 * 有头 Chrome 起来后的头几秒 rAF 只有 2～3 次 / 秒（本机实测，之后跳到显示器的 180 Hz），
 * 所以测量前等到父页 rAF 超过 30 次 / 秒，最多 25 秒；回实际等了多久与最后的帧率。
 */
async function waitFps(page) {
  const t0 = Date.now();
  let fps = 0;
  while (Date.now() - t0 < 25000) {
    fps = await page.evaluate(() => new Promise((res) => { let n = 0; const s = performance.now(); (function f() { n++; if (performance.now() - s < 500) requestAnimationFrame(f); else res(n * 2); })(); }));
    if (fps > 30) break;
  }
  return { waitedMs: Date.now() - t0, fps };
}

async function procInfo(browser) {
  try {
    const cdp = await browser.target().createCDPSession();
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    await cdp.detach().catch(() => {});
    return processInfo;
  } catch (e) { return { error: String(e.message || e) }; }
}
async function targets(browser) {
  const cdp = await browser.target().createCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  await cdp.detach().catch(() => {});
  return targetInfos;
}

/* ------------------------------------------------------------------ P1 */

async function p1Case(head, layoutName, mode) {
  const L = LAYOUTS[layoutName];
  CASE = { oac: L.oac };
  const browser = await launch(head);
  try {
    const page = await browser.newPage();
    await page.goto(L.parent, { waitUntil: 'load' });
    await page.evaluate((v, b) => window.__setup(v, b), L.vis, L.bg + (mode === 'busy' ? '' : `&n=${N_HEAVY}`));
    await sleep(1500);
    const warm = await waitFps(page);
    const tg = await targets(browser);
    const oopif = tg.filter((t) => t.type === 'iframe').map((t) => new URL(t.url).host);
    const frames = await Promise.all(page.frames().map((f) => f.evaluate(() => ({ origin: location.origin, oac: window.originAgentCluster })).catch(() => null)));
    // 基线：后台空闲
    let c0 = cpuTimes();
    await page.evaluate(() => window.__recStart(true));
    await sleep(3000);
    const base = await page.evaluate(() => window.__recStop(true));
    const cpuBase = cpuPct(c0, cpuTimes());
    // 加载：后台干活
    if (mode === 'snapidb') await page.evaluate(() => window.__idbOn());
    await page.evaluate((m) => window.__ask('bg', { cmd: 'start', mode: m === 'busy' ? 'busy' : 'snap', post: m === 'snapidb' }), mode);
    await sleep(500);
    const pi0 = await procInfo(browser);
    c0 = cpuTimes();
    await page.evaluate(() => window.__recStart(true));
    await sleep(6000);
    const load = await page.evaluate(() => window.__recStop(true));
    const cpuLoad = cpuPct(c0, cpuTimes());
    const pi1 = await procInfo(browser);
    const bgStop = await page.evaluate(() => window.__ask('bg', { cmd: 'stop' }));
    const idbStats = mode === 'snapidb' ? await page.evaluate(() => window.__idbStats()) : null;
    const renderers = Array.isArray(pi1) ? pi1.filter((p) => p.type === 'renderer').map((p) => { const b = Array.isArray(pi0) ? pi0.find((q) => q.id === p.id) : null; return { id: p.id, cpuS: +(p.cpuTime - (b ? b.cpuTime : 0)).toFixed(2) }; }).sort((a, b) => b.cpuS - a.cpuS) : pi1;
    const row = {
      head, gpu: GPU, warm, layout: layoutName, mode, version: await browser.version(), oopif, frames,
      cpuBase, cpuLoad,
      parentBase: { raf: stats(base.gaps), lt: base.lts.length, visibility: base.visibility, focus: base.focus },
      parentLoad: { raf: stats(load.gaps), lt: load.lts.length, visibility: load.visibility, focus: load.focus, ltMs: stats(load.lts.map((x) => x.d)), ltAttr: [...new Set(load.lts.map((x) => x.name + '/' + x.attr))].slice(0, 4) },
      visBase: { raf: stats(base.vis.gaps), lt: base.vis.lts.length },
      visLoad: { raf: stats(load.vis.gaps), lt: load.vis.lts.length },
      bg: { units: bgStop.units.length, unitMs: stats(bgStop.units), htmlBytes: bgStop.htmlBytes, oac: bgStop.oac },
      idb: idbStats ? { writes: idbStats.writes, bytes: idbStats.writeBytes, ms: stats(idbStats.writeMs) } : null,
      renderers,
    };
    return row;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runP1() {
  const SNAP = await buildSnap();
  const servers = await startStatic(SNAP);
  const layouts = (flagArg('layouts') || Object.keys(LAYOUTS).join(',')).split(',');
  const modes = (flagArg('modes') || 'busy,snap,snapidb').split(',');
  const rows = [];
  const file = path.join(OUT, `p1-${Date.now()}.json`);
  try {
    for (let r = 1; r <= ROUNDS; r++) {
      for (const head of HEADS) {
        const wl = winLoad();
        log(`\n=== P1 round ${r} ${head}  Win32 LoadPercentage=${wl}`);
        for (const mode of modes) {
          for (const lay of layouts) {
            let row;
            try { row = await p1Case(head, lay, mode); } catch (e) { row = { head, layout: lay, mode, error: String(e.stack || e) }; }
            row.round = r; row.winLoad = wl;
            rows.push(row);
            fs.writeFileSync(file, JSON.stringify(rows, null, 1));
            if (row.error) { log(`${lay} ${mode}: ERROR ${row.error.split('\n')[0]}`); continue; }
            log(`${head.padEnd(8)} ${mode.padEnd(7)} ${lay.padEnd(10)} cpu ${row.cpuBase}/${row.cpuLoad}%  oopif=[${row.oopif.join(',')}] oac=${row.bg.oac} ` +
              `| parent lt ${row.parentBase.lt}->${row.parentLoad.lt} rAF p95 ${row.parentBase.raf.p95}->${row.parentLoad.raf.p95} max ${row.parentLoad.raf.max} >50:${row.parentLoad.raf.over50} ` +
              `| vis lt ${row.visLoad.lt} rAF p95 ${row.visBase.raf.p95}->${row.visLoad.raf.p95} max ${row.visLoad.raf.max} ` +
              `| bg ${row.bg.units}u ${row.bg.unitMs.p50}ms html ${row.bg.htmlBytes}${row.idb ? ` | idb ${row.idb.writes}w p95 ${row.idb.ms.p95}ms` : ''} | renderers ${Array.isArray(row.renderers) ? row.renderers.length : '?'} | ${row.parentBase.visibility}/${row.parentLoad.visibility} focus ${row.parentLoad.focus}`);
          }
        }
      }
    }
  } finally { await closeAll(servers); }
  log(`\nJSON: ${file}`);
}

/* ------------------------------------------------------------------ calibrate */

async function runCalibrate() {
  // --ids：每个粒子带 id（p0、p1…），量整场景 id 改名的代价；sceneHash 是最后一帧整场景 html 的 FNV-1a，
  // 改动前后对照输出是否逐字节相同（docs/reports/AGENT-snapshot-ids.md）
  const IDS = process.argv.includes('--ids');
  const SNAP = await buildSnap();
  const servers = await startStatic(SNAP);
  const browser = await launch('headless');
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${PORT.parent}/`);
    await page.evaluate((b) => window.__setup(null, b), `http://127.0.0.1:${PORT.s2}/stage?role=bg&n=10`);
    for (const n of (flagArg('ns') || `200,600,1000,1400,2000`).split(',').map(Number)) {
      const r = await page.evaluate((n, ids) => window.__ask('bg', { cmd: 'calib', n, frames: 8, ids }), n, IDS);
      log(`n=${n}${IDS ? ' ids' : ''} createSnapshot ms ${JSON.stringify(stats(r.t))} controlHtml=${r.bytes}B sceneHtml=${r.sceneBytes}B sceneHash=${r.sceneHash}`);
    }
  } finally { await browser.close(); await closeAll(servers); }
}

/* ------------------------------------------------------------------ P2 */

const PLACEMENTS = {
  'onscreen-opacity1': { left: '0px', top: '0px', opacity: '1', transform: '', visibility: '', width: '640px', height: '360px' },
  'overlay-opacity0': { left: '0px', top: '0px', opacity: '0', transform: '', visibility: '', width: '640px', height: '360px' },
  'translate-offscreen': { left: '0px', top: '0px', opacity: '0', transform: 'translate(-5000px,0)', visibility: '', width: '640px', height: '360px' },
  'left-10000': { left: '-10000px', top: '0px', opacity: '1', transform: '', visibility: '', width: '640px', height: '360px' },
  'tiny-1px': { left: '0px', top: '0px', opacity: '0', transform: '', visibility: '', width: '1px', height: '1px' },
  'visibility-hidden': { left: '0px', top: '0px', opacity: '1', transform: '', visibility: 'hidden', width: '640px', height: '360px' },
};
const HIDDEN_PLACES = (flagArg('hidden-places') || 'overlay-opacity0,translate-offscreen').split(',');
const CADENCES = [['raf', 2500], ['timeout0', 2500], ['timeout16', 2500], ['ric', 3000], ['ric1000', 3000], ['bake', 5000, 50], ['bake', 5000, N_HEAVY], ['bakeT', 4000, 50], ['bakeT', 4000, N_HEAVY], ['bakeRT', 4000, 50], ['bakeRT', 4000, N_HEAVY]];

async function p2Measure(page, state) {
  const out = {};
  for (const [kind, ms, n] of CADENCES) {
    const key = kind.startsWith('bake') ? `${kind}-n${n}` : kind;
    const winMs = state === 'visible' ? ms : Math.max(ms, 6000);
    const c0 = cpuTimes();
    await page.evaluate((k, n) => window.__ask('bg', { cmd: 'cadence', kind: k, n }), kind, n);
    await sleep(winMs);
    const r = await page.evaluate(() => window.__ask('bg', { cmd: 'cadence-stop' }));
    out[key] = { perSec: r.perSec, count: r.count, ms: Math.round(r.ms), vis: `${r.visAtStart}/${r.visAtEnd}`, workMs: r.work.length ? stats(r.work) : undefined, cpu: cpuPct(c0, cpuTimes()) };
  }
  return out;
}

async function runP2() {
  const SNAP = await buildSnap();
  const servers = await startStatic(SNAP);
  const rows = [];
  const file = path.join(OUT, `p2-${Date.now()}.json`);
  const places = (flagArg('places') || Object.keys(PLACEMENTS).join(',')).split(',');
  try {
    for (let r = 1; r <= ROUNDS; r++) {
      for (const head of HEADS) {
        const wl = winLoad();
        log(`\n=== P2 round ${r} ${head}  Win32 LoadPercentage=${wl}`);
        for (const place of places) {
          CASE = { oac: true };
          const browser = await launch(head);
          try {
            const page = await browser.newPage();
            await page.goto(LAYOUTS['c-port-oac'].parent, { waitUntil: 'load' });
            await page.evaluate((b) => window.__setup(null, b), `http://127.0.0.1:${PORT.s2}/stage?role=bg&n=10`);
            await page.evaluate((css) => window.__place(css), PLACEMENTS[place]);
            await sleep(1000);
            const warm = await waitFps(page);
            const states = [];
            // 可见
            states.push([`visible(${await page.evaluate(() => document.visibilityState)},fps${warm.fps})`, await p2Measure(page, 'visible')]);
            // 页面不可见时各位置表现相同（冒烟实测），只对 --hidden-places 里的位置测
            if (HIDDEN_PLACES.includes(place)) {
            // 切到另一个标签
            const other = await browser.newPage();
            await other.goto('about:blank');
            await other.bringToFront();
            await sleep(1500);
            const visHidden = await page.evaluate(() => document.visibilityState);
            states.push([`other-tab(${visHidden})`, await p2Measure(page, 'hidden')]);
            await page.bringToFront();
            await other.close();
            await sleep(1000);
            // 最小化（仅有头）
            if (head === 'headful') {
              const cdp = await page.createCDPSession();
              const { windowId } = await cdp.send('Browser.getWindowForTarget');
              await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
              await sleep(1500);
              const visMin = await page.evaluate(() => document.visibilityState);
              states.push([`minimized(${visMin})`, await p2Measure(page, 'hidden')]);
              await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
              await cdp.detach().catch(() => {});
            }
            }
            for (const [st, m] of states) {
              const row = { round: r, head, winLoad: wl, place, state: st, m };
              rows.push(row);
              log(`${head.padEnd(8)} ${place.padEnd(19)} ${st.padEnd(22)} ` + Object.entries(m).map(([k, v]) => `${k}=${v.perSec}/s${v.workMs ? `(${v.workMs.p50}ms)` : ''}`).join(' ') + `  cpu~${m.raf.cpu}%`);
            }
            fs.writeFileSync(file, JSON.stringify(rows, null, 1));
          } catch (e) {
            rows.push({ round: r, head, place, error: String(e.stack || e) });
            log(`${place}: ERROR ${String(e.message || e)}`);
          } finally { await browser.close().catch(() => {}); }
        }
      }
    }
  } finally { await closeAll(servers); }
  log(`\nJSON: ${file}`);
}

/* ------------------------------------------------------------------ P3 */

async function runP3() {
  const SNAP = await buildSnap();
  const servers = await startStatic(SNAP);
  const TOTAL = Number(flagArg('total-mib', '256')) * 1024 * 1024;
  const file = path.join(OUT, `p3-${Date.now()}.json`);
  const rows = [];
  CASE = { oac: true };
  try {
    for (let r = 1; r <= ROUNDS; r++) for (const head of HEADS) {
      const wl = winLoad();
      const browser = await launch(head);
      try {
        const page = await browser.newPage();
        const origin = `http://127.0.0.1:${PORT.parent}`;
        await page.goto(origin + '/', { waitUntil: 'load' });
        await page.evaluate((b) => window.__setup(null, b), `http://127.0.0.1:${PORT.s2}/stage?role=bg&n=10`);
        const row = { round: r, head, winLoad: wl, version: await browser.version() };
        // 1. 写 / 读吞吐
        const c0 = cpuTimes();
        row.io = await page.evaluate(async (TOTAL) => {
          const lts = []; const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) lts.push(e.duration); }); po.observe({ type: 'longtask' });
          await new Promise((r) => { const d = indexedDB.deleteDatabase('c10probe-p3'); d.onsuccess = d.onerror = d.onblocked = r; });
          const est0 = await navigator.storage.estimate();
          const persisted0 = await navigator.storage.persisted();
          const persist = await navigator.storage.persist();
          const db = await new Promise((res, rej) => { const r = indexedDB.open('c10probe-p3', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
          const put = (key, val) => new Promise((res, rej) => { const tx = db.transaction('s', 'readwrite'); tx.objectStore('s').put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
          const get = (key) => new Promise((res, rej) => { const tx = db.transaction('s'); const g = tx.objectStore('s').get(key); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); });
          const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
          let bytes = 0, i = 0; const wms = []; const keys = [];
          const buf = new Uint8Array(200 * 1024); crypto.getRandomValues(buf.subarray(0, 65536));
          for (let k = 65536; k < buf.length; k += 65536) crypto.getRandomValues(buf.subarray(k, Math.min(buf.length, k + 65536)));
          const tw0 = performance.now(); const lt0 = lts.length;
          while (bytes < TOTAL) {
            const size = 20 * 1024 + Math.floor(Math.random() * 180 * 1024);
            const v = buf.slice(0, size); v[0] = i & 255; v[1] = (i >> 8) & 255; // 不同内容
            const key = ['snap', 'card' + (i % 7), i]; const t = performance.now(); await put(key, v); wms.push(performance.now() - t); keys.push(key); bytes += size; i++;
          }
          const writeS = (performance.now() - tw0) / 1000; const writeLt = lts.length - lt0;
          const est1 = await navigator.storage.estimate();
          // 随机顺序读回
          for (let k = keys.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [keys[k], keys[j]] = [keys[j], keys[k]]; }
          const rms = []; let rbytes = 0; const tr0 = performance.now(); const lt1 = lts.length;
          for (const key of keys) { const t = performance.now(); const v = await get(key); rms.push(performance.now() - t); rbytes += v.byteLength; }
          const readS = (performance.now() - tr0) / 1000; const readLt = lts.length - lt1;
          // 批量写（20 条一个事务）对照，64 MiB
          const tb0 = performance.now(); let bb = 0, n = 0;
          while (bb < 64 * 1024 * 1024) { await new Promise((res, rej) => { const tx = db.transaction('s', 'readwrite'); const st = tx.objectStore('s'); for (let k = 0; k < 20; k++) { const size = 20 * 1024 + Math.floor(Math.random() * 180 * 1024); const v = buf.slice(0, size); v[0] = n & 255; v[1] = (n >> 8) & 255; v[2] = 0xbb; st.put(v, ['batch', 'x', n++]); bb += size; } tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
          const batchS = (performance.now() - tb0) / 1000;
          const est2 = await navigator.storage.estimate();
          po.disconnect(); db.close();
          const mib = (b) => +(b / 1048576).toFixed(1);
          return { entries: i, writeMiB: mib(bytes), writeS: +writeS.toFixed(1), writeMiBps: +(bytes / 1048576 / writeS).toFixed(1), writeTxMs: { p50: q(wms, 0.5), p95: q(wms, 0.95), max: q(wms, 1) }, writeLongTasks: writeLt,
            readMiBps: +(rbytes / 1048576 / readS).toFixed(1), readS: +readS.toFixed(1), readGetMs: { p50: q(rms, 0.5), p95: q(rms, 0.95), max: q(rms, 1) }, readLongTasks: readLt,
            batchMiBps: +(bb / 1048576 / batchS).toFixed(1),
            est0: { usageMiB: mib(est0.usage), quotaMiB: mib(est0.quota), details: est0.usageDetails }, est1: { usageMiB: mib(est1.usage), quotaMiB: mib(est1.quota), details: est1.usageDetails }, est2: { usageMiB: mib(est2.usage), quotaMiB: mib(est2.quota) },
            persisted0, persist, persistedAfter: await navigator.storage.persisted() };
        }, TOTAL);
        row.io.cpu = cpuPct(c0, cpuTimes());
        log(`P3 r${row.round} ${head} io ${JSON.stringify(row.io)}`);

        // 2. 配额压低：写到 QuotaExceededError，回收一批再试一次
        const cdp = await page.createCDPSession();
        const usageNow = await page.evaluate(async () => (await navigator.storage.estimate()).usage);
        const quotaSize = Math.round(usageNow + 32 * 1024 * 1024);
        await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize });
        row.quota = await page.evaluate(async () => {
          const db = await new Promise((res, rej) => { const r = indexedDB.open('c10probe-p3', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
          const put = (key, val) => new Promise((res, rej) => { const tx = db.transaction('s', 'readwrite'); tx.objectStore('s').put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
          const mib = (b) => +(b / 1048576).toFixed(2);
          const estA = await navigator.storage.estimate();
          const val = (n) => { const v = new Uint8Array(150 * 1024); crypto.getRandomValues(v.subarray(0, 65536)); crypto.getRandomValues(v.subarray(65536, 131072)); crypto.getRandomValues(v.subarray(131072)); v[0] = n & 255; return v; };
          let n = 0, bytes = 0, err = null;
          for (; n < 2000; n++) { try { await put(['q', 'x', n], val(n)); bytes += 150 * 1024; } catch (e) { err = { name: e && e.name, message: String(e && e.message).slice(0, 160) }; break; } }
          const estB = await navigator.storage.estimate();
          // 回收一批：删最早写入的 ['snap', …] 条目 16 MiB 左右（~150 条）
          const tDel = performance.now();
          const deleted = await new Promise((res, rej) => { const tx = db.transaction('s', 'readwrite'); const st = tx.objectStore('s'); let c = 0, b = 0; const cur = st.openCursor(IDBKeyRange.bound(['snap'], ['snap', []])); cur.onsuccess = () => { const x = cur.result; if (!x || b >= 16 * 1048576) return; b += x.value.byteLength; c++; x.delete(); x.continue(); }; tx.oncomplete = () => res({ c, b }); tx.onerror = () => rej(tx.error); });
          const delMs = performance.now() - tDel;
          const estC = await navigator.storage.estimate();
          const retry = [];
          let ok = false;
          try { await put(['q', 'x', n], val(n)); ok = true; retry.push({ after: 'immediate', ok: true }); } catch (e) { retry.push({ after: 'immediate', ok: false, name: e && e.name }); }
          for (const wait of [1000, 5000]) { if (ok) break; await new Promise((r) => setTimeout(r, wait)); try { await put(['q', 'x', n], val(n)); ok = true; retry.push({ after: wait, ok: true }); } catch (e) { retry.push({ after: wait, ok: false, name: e && e.name }); } }
          // 回收后还能再写多少
          let more = 0; if (ok) { for (let k = 1; k < 400; k++) { try { await put(['q', 'y', k], val(k)); more += 150 * 1024; } catch { break; } } }
          const estD = await navigator.storage.estimate();
          db.close();
          return { quotaMiB: mib(estA.quota), usageBeforeMiB: mib(estA.usage), wroteBeforeErrorMiB: mib(bytes), error: err, usageAtErrorMiB: mib(estB.usage), deleted: { count: deleted.c, MiB: mib(deleted.b), ms: +delMs.toFixed(1) }, usageAfterDeleteMiB: mib(estC.usage), retry, moreAfterRetryMiB: mib(more), usageEndMiB: mib(estD.usage) };
        });
        await cdp.send('Storage.overrideQuotaForOrigin', { origin }).catch(() => {});
        log(`P3 r${row.round} ${head} quota ${JSON.stringify(row.quota)}`);

        // 3. 分区：跨源舞台看父页的库
        await page.evaluate(async () => { await new Promise((res) => { const r = indexedDB.open('c10probe-part', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { const tx = r.result.transaction('s', 'readwrite'); tx.objectStore('s').put('x', 1); tx.oncomplete = () => { r.result.close(); res(); }; }; }); });
        const crossCount = await page.evaluate(() => window.__ask('bg', { cmd: 'idb-count', db: 'c10probe-part' }));
        const crossEst = await page.evaluate(() => window.__ask('bg', { cmd: 'estimate' }));
        // 同源舞台对照
        await page.evaluate(() => { const f = document.getElementById('bg'); f.src = location.origin + '/stage?role=bg&n=10'; });
        await sleep(1500);
        const sameCount = await page.evaluate(() => window.__ask('bg', { cmd: 'idb-count', db: 'c10probe-part' }));
        row.partition = { crossOriginStage: crossCount, crossOriginEstimate: crossEst, sameOriginStage: sameCount };
        log(`P3 r${row.round} ${head} partition ${JSON.stringify(row.partition)}`);
        await page.evaluate(async () => { for (const n of ['c10probe-p3', 'c10probe-part', 'c10probe-p1']) await new Promise((r) => { const d = indexedDB.deleteDatabase(n); d.onsuccess = d.onerror = d.onblocked = r; }); });

        // 4. 隐身上下文
        const ctx = await browser.createBrowserContext();
        const ip = await ctx.newPage();
        await ip.goto(origin + '/', { waitUntil: 'load' });
        row.incognito = await ip.evaluate(async () => { const e = await navigator.storage.estimate(); return { quotaMiB: +(e.quota / 1048576).toFixed(1), usage: e.usage, persist: await navigator.storage.persist() }; });
        await ctx.close();
        log(`P3 r${row.round} ${head} incognito ${JSON.stringify(row.incognito)}`);
        rows.push(row);
        fs.writeFileSync(file, JSON.stringify(rows, null, 1));
      } finally { await browser.close().catch(() => {}); }
    }
  } finally { await closeAll(servers); }
  log(`\nJSON: ${file}`);
}

/**
 * P3 的补充：Chrome 152 里 CDP Storage.overrideQuotaForOrigin 回 ok 却不生效（estimate().quota 不变、写多少都不报错），
 * 所以用真实配额撞 QuotaExceededError：无头、一次性配置目录，按 8 MiB 一条写到报错，然后删一批（64 MiB）立刻重试一次。
 * 会临时占掉约「源配额」那么多磁盘（本机约 10 GiB），浏览器关掉时连配置目录一起删。
 */
async function runP3Quota() {
  const SNAP = await buildSnap();
  const servers = await startStatic(SNAP);
  const file = path.join(OUT, `p3q-${Date.now()}.json`);
  const browser = await launch('headless');
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${PORT.parent}/`, { waitUntil: 'load' });
    // 页面里备好库与写入函数；写入按批从 Node 驱动，免得单次 evaluate 超过协议时限
    await page.evaluate(async () => {
      window.__db = await new Promise((res, rej) => { const q = indexedDB.open('c10probe-q', 1); q.onupgradeneeded = () => q.result.createObjectStore('s'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      window.__put = (key, val) => new Promise((res, rej) => { const tx = __db.transaction('s', 'readwrite'); tx.objectStore('s').put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
      const base = new Uint8Array(8 * 1048576); for (let k = 0; k < base.length; k += 65536) crypto.getRandomValues(base.subarray(k, k + 65536));
      window.__val = (n) => { const v = base.slice(); v[0] = n & 255; v[1] = (n >> 8) & 255; return v; };
    });
    const mib = (x) => +(x / 1048576).toFixed(1);
    const est = () => page.evaluate(async () => { const e = await navigator.storage.estimate(); return { usage: e.usage, quota: e.quota }; });
    const est0 = await est();
    const freeGiB = () => { const st = fs.statfsSync(os.tmpdir()); return Math.round(st.bavail * st.bsize / 1073741824); };
    log(`P3q quota at start ${mib(est0.quota)} MiB, disk free ${freeGiB()} GiB`);
    const t0 = Date.now(); let n = 0, err = null;
    while (!err && n < 4000) {
      const r = await page.evaluate(async (from) => { let k = from; try { for (; k < from + 64; k++) await __put(k, __val(k)); return { n: k }; } catch (e) { return { n: k, err: { name: e && e.name, message: String(e && e.message).slice(0, 200) } }; } }, n);
      n = r.n; err = r.err || null;
      if (n % 256 === 0 || err) log(`  wrote ${n * 8} MiB ${err ? 'ERR ' + err.name : ''} (disk free ${freeGiB()} GiB)`);
      if (!err && freeGiB() < 40) { err = { name: 'probe-stop', message: 'disk free < 40 GiB, stopped by the probe' }; break; }
    }
    const writeS = (Date.now() - t0) / 1000;
    const est1 = await est();
    const tDel = Date.now();
    await page.evaluate(() => new Promise((res, rej) => { const tx = __db.transaction('s', 'readwrite'); tx.objectStore('s').delete(IDBKeyRange.bound(0, 7)); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }));
    const delMs = Date.now() - tDel;
    const est2 = await est();
    const retry = []; let ok = false;
    for (const wait of [0, 1000, 5000]) {
      if (ok) break; if (wait) await sleep(wait);
      const x = await page.evaluate(async (k) => { try { await __put(k, __val(k)); return { ok: true }; } catch (e) { return { ok: false, name: e && e.name }; } }, n);
      ok = x.ok; retry.push({ wait, ...x });
    }
    let more = 0;
    if (ok) more = await page.evaluate(async (from) => { let m = 0; for (let k = 1; k < 20; k++) { try { await __put(from + k, __val(from + k)); m++; } catch { break; } } return m; }, n);
    const est3 = await est();
    await page.evaluate(() => new Promise((res) => { __db.close(); const d = indexedDB.deleteDatabase('c10probe-q'); d.onsuccess = d.onerror = d.onblocked = res; }));
    const r = { quota0MiB: mib(est0.quota), usage0MiB: mib(est0.usage), entries8MiB: n, wroteMiB: n * 8, writeS: +writeS.toFixed(1), writeMiBps: +(n * 8 / writeS).toFixed(1), error: err,
      atError: { usageMiB: mib(est1.usage), quotaMiB: mib(est1.quota) }, deleted: { entries: 8, MiB: 64, ms: delMs }, afterDelete: { usageMiB: mib(est2.usage), quotaMiB: mib(est2.quota) },
      retry, moreEntriesAfterRetry: more, end: { usageMiB: mib(est3.usage), quotaMiB: mib(est3.quota) } };
    log(`P3q ${JSON.stringify(r)}`);
    fs.writeFileSync(file, JSON.stringify(r, null, 1));
  } finally { await browser.close().catch(() => {}); await closeAll(servers); }
  log(`\nJSON: ${file}`);
}

/* ------------------------------------------------------------------ P4 */

function proxy(port, target, { strip = false, prefix = null, stagePage = null } = {}) {
  const counts = { total: 0, range: 0, options: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (stagePage && (u.pathname === '/stage' || u.pathname === '/')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(stagePage); }
    let pathname = u.pathname;
    if (prefix) { if (!pathname.startsWith(prefix.from)) { res.statusCode = 404; return res.end(); } pathname = prefix.to + pathname.slice(prefix.from.length); }
    counts.total++; if (req.headers.range) counts.range++; if (req.method === 'OPTIONS') counts.options++;
    const headers = { ...req.headers, host: new URL(target).host };
    const up = http.request(new URL(pathname + u.search, target), { method: req.method, headers }, (ur) => {
      const h = { ...ur.headers };
      if (strip) for (const k of Object.keys(h)) if (k.startsWith('access-control-')) delete h[k];
      res.writeHead(ur.statusCode, h); ur.pipe(res);
    });
    up.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(up);
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, counts })));
}

const P4_STAGE = `<!doctype html><meta charset=utf-8><title>p4 stage</title><body>
<script>
window.__p4 = async (url, kinds) => {
  const out = {};
  const guard = (p, ms = 8000) => Promise.race([p, new Promise((r) => setTimeout(() => r({ ok: false, error: 'timeout' }), ms))]);
  if (kinds.includes('range')) out.range = await guard(fetch(url, { headers: { Range: 'bytes=0-1023' } }).then(async (r) => ({ ok: true, status: r.status, contentRange: r.headers.get('content-range'), len: (await r.arrayBuffer()).byteLength })).catch((e) => ({ ok: false, error: String(e) })));
  if (kinds.includes('bearer')) out.bearer = await guard(fetch(url, { headers: { Range: 'bytes=0-15', Authorization: 'Bearer probe' } }).then(async (r) => ({ ok: true, status: r.status, len: (await r.arrayBuffer()).byteLength })).catch((e) => ({ ok: false, error: String(e) })));
  const draw = (el, w, h) => { try { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(el, 0, 0, w, h); c.toDataURL(); return 'readable'; } catch (e) { return 'tainted:' + e.name; } };
  for (const co of [null, 'anonymous']) {
    if (kinds.includes('video')) out['video' + (co ? '-cors' : '')] = await guard(new Promise((res) => { const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; if (co) v.crossOrigin = co;
      v.onloadeddata = () => res({ ok: true, w: v.videoWidth, canvas: draw(v, 64, 36) }); v.onerror = () => res({ ok: false, error: 'media error ' + (v.error && v.error.code) }); v.src = url; document.body.appendChild(v); }));
    if (kinds.includes('img')) out['img' + (co ? '-cors' : '')] = await guard(new Promise((res) => { const i = new Image(); if (co) i.crossOrigin = co; i.onload = () => res({ ok: true, w: i.naturalWidth, canvas: draw(i, 32, 32) }); i.onerror = () => res({ ok: false, error: 'img error' }); i.src = url; }));
  }
  return out;
};
parent.postMessage({ kind: 'ready', role: 'bg', origin: location.origin }, '*');
</script>`;

async function startHosted(dataDir, noTrust) {
  const env = { ...process.env, PROMPTCUT_DATA_DIR: dataDir, PROMPTCUT_DOCSERVICE_PORT: String(PORT.doc), PROMPTCUT_ASSET_PORT: String(PORT.asset), PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1' };
  if (noTrust) env.PROMPTCUT_TEST_NO_LOOPBACK_TRUST = '1';
  const child = spawn(process.execPath, [path.join(ROOT, 'server/hosted/main.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  child.stdout.on('data', (d) => lines.push(String(d))); child.stderr.on('data', (d) => lines.push(String(d)));
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try { const r = await fetch(`http://127.0.0.1:${PORT.asset}/api/asset/media/${'0'.repeat(64)}/chunks`); if (r.status) break; } catch { /* 还没起来 */ }
    if (child.exitCode !== null) throw new Error('hosted exited: ' + lines.join(''));
    await sleep(300);
  }
  return { child, lines, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); setTimeout(r, 5000); }) };
}

async function runP4() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c10p4-'));
  const mp4 = path.join(OUT, 'p4.mp4');
  if (!fs.existsSync(mp4)) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', mp4]);
  const png = fs.readFileSync(path.join(ROOT, 'desktop/src-tauri/icons/128x128.png'));
  const file = path.join(OUT, `p4-${Date.now()}.json`);
  const result = { dataDir, rows: [] };
  let hosted = await startHosted(dataDir, false);
  const staticSrv = await serve(PORT.p4stage, (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(req.url.startsWith('/stage') ? P4_STAGE : PARENT_HTML); }, '127.0.0.1');
  const parentSrv = await serve(PORT.parent, (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(PARENT_HTML); }, '127.0.0.1');
  const assetBase = `http://127.0.0.1:${PORT.asset}/api/asset`;
  const strip = await proxy(PORT.p4strip, `http://127.0.0.1:${PORT.asset}`, { strip: true });
  const prefixed = await proxy(PORT.p4prefix, `http://127.0.0.1:${PORT.asset}`, { strip: true, prefix: { from: '/media/', to: '/api/asset/media/' }, stagePage: P4_STAGE });
  try {
    const { createAssetClient } = await import('../../server/asset-store/client.mjs');
    const client = createAssetClient({ base: assetBase });
    const v = await client.put('media', fs.readFileSync(mp4), { ext: 'mp4' });
    const im = await client.put('media', png, { ext: 'png' });
    result.hashes = { mp4: v.hash, png: im.hash };
    const cases = [
      { name: 'A 跨源直连素材服务（有 ACAO:*）', stage: `http://127.0.0.1:${PORT.p4stage}/stage`, base: `${assetBase}/media` },
      { name: 'B 跨源、代理去掉 CORS 头', stage: `http://127.0.0.1:${PORT.p4stage}/stage`, base: `http://127.0.0.1:${PORT.p4strip}/api/asset/media` },
      { name: 'C 舞台同源前缀反代 /media（且去掉 CORS 头）', stage: `http://127.0.0.1:${PORT.p4prefix}/stage`, base: `http://127.0.0.1:${PORT.p4prefix}/media` },
    ];
    for (const head of HEADS) {
      const browser = await launch(head);
      try {
        for (const c of cases) {
          const page = await browser.newPage();
          await page.goto(`http://127.0.0.1:${PORT.parent}/`, { waitUntil: 'load' });
          await page.evaluate((b) => window.__setup(null, b), c.stage);
          const frame = page.frames().find((f) => f.url().startsWith(c.stage));
          const before = { ...strip.counts, p: { ...prefixed.counts } };
          const mp4r = await frame.evaluate((u) => window.__p4(u, ['range', 'bearer', 'video']), `${c.base}/${v.hash}?t=probe-ticket`);
          const pngr = await frame.evaluate((u) => window.__p4(u, ['img']), `${c.base}/${im.hash}?t=probe-ticket`);
          const row = { head, case: c.name, mp4: mp4r, png: pngr, proxyCounts: { strip: { ...strip.counts }, prefix: { ...prefixed.counts }, before } };
          result.rows.push(row);
          log(`P4 ${head} ${c.name}\n   mp4 ${JSON.stringify(mp4r)}\n   png ${JSON.stringify(pngr)}`);
          await page.close();
        }
      } finally { await browser.close().catch(() => {}); }
    }
    // 401 能否被跨源读到（不信任回环，票据是假的）
    await hosted.stop();
    hosted = await startHosted(dataDir, true);
    const browser = await launch('headless');
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${PORT.parent}/`, { waitUntil: 'load' });
      await page.evaluate((b) => window.__setup(null, b), cases[0].stage);
      const frame = page.frames().find((f) => f.url().startsWith(cases[0].stage));
      result.noTrust = await frame.evaluate((u) => window.__p4(u, ['range', 'bearer', 'video']), `${assetBase}/media/${v.hash}?t=bogus`);
      log(`P4 no-loopback-trust bogus ticket ${JSON.stringify(result.noTrust)}`);
    } finally { await browser.close().catch(() => {}); }
  } finally {
    await hosted.stop();
    await closeAll([staticSrv, parentSrv, strip.server, prefixed.server]);
    fs.writeFileSync(file, JSON.stringify(result, null, 1));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }
  log(`\nJSON: ${file}`);
}

/* ------------------------------------------------------------------ main */

log(`c10-stage-probe ${CMD} out=${OUT} ports ${BASE}..${BASE + 9} puppeteer Chrome ${await (async () => { const b = await launch('headless'); const v = await b.version(); await b.close(); return v; })()}`);
if (CMD === 'p1') await runP1();
else if (CMD === 'p2') await runP2();
else if (CMD === 'p3') await runP3();
else if (CMD === 'p3q') await runP3Quota();
else if (CMD === 'p4') await runP4();
else if (CMD === 'calibrate') await runCalibrate();
else { console.error('unknown command ' + CMD); process.exitCode = 2; }
