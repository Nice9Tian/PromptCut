/**
 * 在线卡片实际权限验收：真实 content.put → 转译 → stage RPC → 用户卡/图卡/声音线程。
 * 2026-10-08 P1/P3：外链照常；无 Allowlist/Trusted Types/WebRTC 护栏也执行。
 * 保留 A 父页/凭证/素材/伪造RPC/结构边界，B 插入边界，G 无 Allowlist 仍执行，C 无 header 拒绝，L/S/N/M 配置回退。
 * 旧 A5/A9/P1 外发为零与 WebRTC 封堵不适用；四类外链由 card-policy-probe.mjs 实际加载验收。
 * node scripts/probes/online-card-security-probe.mjs --dist dist-online --base-port 5900 --doc-port 5903 --asset-port 5904
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import puppeteer from 'puppeteer';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startHostedProxy, proxyOrigins } from './lib/hosted-proxy.mjs';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { createSharedProject, buildAuthProtocols } from '../../server/auth/client.mjs';
import { normalizeEntry, sharedProtocols } from '../../server/auth/shared-config.mjs';
import { createWsEndpoint } from '../../server/render-node/ws-transport.mjs';
import { createContentClient } from '../../server/render-node/content-client.mjs';
import { wsBaseOf } from '../../server/auth/route.mjs';
import { createAssetClient } from '../../server/asset-store/client.mjs';
import { stageCspHeader, editorCspHeader } from '../../src/online/stagePolicy.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const BASE = Number(arg('--base-port', 5750));
const DOC_PORT = Number(arg('--doc-port', 8780)), ASSET_PORT = Number(arg('--asset-port', 8781));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'online-card-security-shots')));
const ONLY = arg('--only', 'A,B,G,C,L,S,N,M').split(',');
const HEADFUL = argv.includes('--headful');
const SINK_PORT = BASE + 7;
const EVIL = `http://127.0.0.1:${SINK_PORT}`;
const ORIGINS = proxyOrigins(BASE);
const DOC_DIRECT = `http://127.0.0.1:${DOC_PORT}`;
fs.mkdirSync(OUT, { recursive: true });

/** 探针知道的秘密:值 → 标签。**值不打印**,比对时只报标签 */
const secrets = new Map();

/* ------------------------------------------------------------------ 记分 */
const fails = [], notes = [];
let pass = 0;
/** 打印前把票据形状的串与探针知道的秘密都盖掉(令牌、密钥的值不进输出) */
const scrub = (s) => { let o = s.replace(/v1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'v1.***'); for (const [value] of secrets) o = o.split(value).join('***'); return o; };
const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s === undefined ? '' : scrub(s.length > 300 ? `${s.slice(0, 300)}…` : s); };
const check = (label, ok, detail) => { console.log(`${ok ? '  过' : '不过'}  ${label}${detail === undefined || detail === '' ? '' : `  〔${short(detail)}〕`}`); if (ok) pass++; else fails.push(label); return !!ok; };
/** 已知缺口:`present` 为真 = 缺口还在(记现状,不算失败);为假 = 缺口不见了(同样不算失败,但要醒目提醒更新文档) */
const gaps = [];
const gap = (label, present, detail) => { console.log(`${present ? '缺口' : '注意'}  ${label}${present ? '' : ' —— 这一条缺口已不存在,更新契约与报告里的表述'}${detail ? `  〔${short(detail)}〕` : ''}`); gaps.push({ label, present }); if (!present) notes.push(`缺口已不存在:${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30_000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { check(`等到:${what}`, false, `${ms} ms 没等到`); return null; }
    await sleep(every);
  }
}

/* ------------------------------------------------------------------ 夹具:探测代码(ESM 写法换成 CommonJS) */
const FIXTURE_DIR = path.join(ROOT, 'scripts', 'probes', 'fixtures', 'online-card-boundary');
const LIB = (() => {
  const names = [];
  const src = fs.readFileSync(path.join(FIXTURE_DIR, 'probe-boundary-attempts.ts'), 'utf8')
    .replace(/^export (async )?function (\w+)/gm, (_m, a, n) => { names.push(n); return `${a ?? ''}function ${n}`; });
  if (/^\s*(import|export)\s/m.test(src)) throw new Error('夹具里还有没换掉的 import / export');
  return `${src}\n${names.map((n) => `exports.${n} = ${n};`).join('\n')}\n`;
})();

/* ------------------------------------------------------------------ 收集站 */
const png = (() => { const p = new PNG({ width: 4, height: 4 }); for (let i = 0; i < 16; i++) p.data.set([10, 200, 30, 255], i * 4); return PNG.sync.write(p); })();
const sink = { connections: 0, requests: [], udp: 0 };
const sinkSrv = http.createServer((req, res) => {
  sink.requests.push(`${req.method} ${req.url}`);
  const type = req.url.includes('.js') ? 'text/javascript' : req.url.includes('.css') ? 'text/css' : req.url.includes('.png') ? 'image/png' : 'text/html';
  res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': type });
  res.end(req.url.includes('.png') ? png : '');
});
sinkSrv.on('connection', () => { sink.connections++; });
sinkSrv.on('upgrade', (req, socket) => { sink.requests.push(`UPGRADE ${req.url}`); socket.destroy(); });
const sinkUdp = dgram.createSocket('udp4');
sinkUdp.on('message', () => { sink.udp++; });
const resetSink = () => { sink.connections = 0; sink.udp = 0; sink.requests.length = 0; };
const sinkNow = () => ({ tcp: sink.connections, udp: sink.udp, http: sink.requests.length, sample: sink.requests.slice(0, 6) });
await new Promise((res, rej) => { sinkSrv.once('error', rej); sinkSrv.listen(SINK_PORT, '127.0.0.1', res); });
await new Promise((res) => sinkUdp.bind(SINK_PORT, '127.0.0.1', res));

/* ------------------------------------------------------------------ 托管组合、项目、素材 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-card-security-hosted-'));
const combo = await startHostedCombo({
  dataDir, docPort: DOC_PORT, assetPort: ASSET_PORT, host: '127.0.0.1', trustLoopback: false, clusterToken: randomBytes(32).toString('base64url'),
  docPublicUrl: `ws://pc.localhost:${BASE}/hosted/`, assetPublicUrl: `${ORIGINS.editor}/media/api/asset`, log: () => {},
});
const stamp = Date.now().toString(36);
const NAME = `ocs-${stamp}`;
const creator = { username: 'boss', password: `boss-${randomBytes(9).toString('hex')}` };
const PROJECT_PW = `pw-${randomBytes(9).toString('hex')}`;
const made = await createSharedProject({ base: DOC_DIRECT, name: NAME, mode: 'free', creator, password: PROJECT_PW });

const addSecret = (label, value) => { if (typeof value === 'string' && value.length >= 8) secrets.set(value, label); };
addSecret('项目密码', PROJECT_PW);
addSecret('创建者密码', creator.password);

async function wsAsCreator() {
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId: made.projectId, username: creator.username, deviceId: 'ocs-probe-node-01', deviceName: 'probe-node', as: 'creator', password: creator.password, role: 'page' });
  const ws = new WebSocket(DOC_DIRECT.replace(/^http/, 'ws'), protocols);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const ask = (msg) => new Promise((resolve) => {
    const reqId = `p${Math.random().toString(36).slice(2)}`;
    const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
  return { ask, close: () => ws.close() };
}
let MEDIA_HASH = '';
{
  // 在线页面只加入、不新建:替创建者写进一份空项目(同 `lib-seed.mjs`),再传一张图当素材
  const node = await wsAsCreator();
  const opened = await node.ask({ type: 'project.open', projectId: made.projectId });
  const body = { version: 1, id: `ocs-seed-${made.projectId.slice(-8)}`, name: NAME, width: 1920, height: 1080, fps: 30, duration: 30, themeId: 'midnight', media: [],
    tracks: [{ id: 't-1', name: '序列 1', clips: [] }, { id: 't-2', name: '序列 2', clips: [] }] };
  const seeded = await node.ask({ type: 'project.op', projectId: made.projectId, opId: randomBytes(16).toString('base64url'), ops: [{ op: 'set', path: '', value: body }] });
  check('准备:替创建者写进空项目', !/error|reject/i.test(String(opened?.type) + String(seeded?.type)), { opened: opened?.type, seeded: seeded?.type });
  const tk = await node.ask({ type: 'auth.ticket', kind: 'asset', access: 'rw' });
  addSecret('创建者的读写素材票据', tk?.ticket);
  const assets = createAssetClient({ base: `http://127.0.0.1:${ASSET_PORT}/api/asset`, ticket: () => tk.ticket });
  const put = await assets.put('media', png, { ext: 'png' });
  MEDIA_HASH = put.hash;
  check('准备:创建者凭读写票据把一张图传进素材服务', /^[0-9a-f]{64}$/.test(MEDIA_HASH), { size: put.size });
  const bare = await fetch(`http://127.0.0.1:${ASSET_PORT}/api/asset/media/${MEDIA_HASH}`);
  check('准备:素材服务不信回环,不带票据读素材是 401', bare.status === 401, bare.status);
  node.close();
  // 三份夹具原样写进内容库:同步来的用户卡 / 图卡(真实加载路径)
  const entry = normalizeEntry({ url: wsBaseOf(DOC_DIRECT), projectId: made.projectId, username: creator.username, password: creator.password, as: 'creator', role: 'page', deviceId: 'ocs-probe-content1', deviceName: 'ocs-probe content' });
  const ep = createWsEndpoint({ url: entry.url, protocols: sharedProtocols(entry, { role: 'page' }), log: () => {} });
  await new Promise((r) => { if (ep.connected) r(); else ep.onOpen(r); });
  const content = createContentClient(ep);
  const putErrors = [];
  for (const file of ['probe-boundary-attempts.ts', 'probe-boundary-card.tsx', 'probe-boundary-graph.tsx']) {
    const r = await content.put('card-source', `src/cards/user/${file}`, fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8')).catch((e) => ({ error: String(e?.message ?? e) }));
    if (r?.error) putErrors.push(`${file}:${r.error}`);
  }
  check('准备:三份探测夹具原样写进内容库(card-source,src/cards/user/ 下)', putErrors.length === 0, putErrors);
  try { ep.close?.(); } catch { /* 已经关了 */ }
}
const BOUNDARY_CARDS = { user: 'probe-boundary-card', graph: 'probe-boundary-graph' };

/* ------------------------------------------------------------------ 浏览器 */
const NETLOG = path.join(OUT, 'netlog.json');
try { fs.rmSync(NETLOG, { force: true }); } catch { /* 没有 */ }
const browser = await puppeteer.launch({ pipe: true,
  headless: !HEADFUL, protocolTimeout: 900_000,
  args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--mute-audio', '--window-position=-32000,-32000', '--site-per-process', `--log-net-log=${NETLOG}`, '--net-log-capture-mode=IncludeSensitive',
    ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : [])],
});
const summary = { chrome: await browser.version(), out: OUT };
const DNS = { guarded: `g${randomBytes(5).toString('hex')}.pcexfil.invalid`, control: `c${randomBytes(5).toString('hex')}.pcexfil.invalid` };

/** 核对代理发的响应头(Node 这边直接连端口,Host 头给舞台的主机名) */
const headOf = (port, host, urlPath) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath, headers: { host } }, (r) => { r.resume(); resolve({ status: r.statusCode, headers: r.headers }); });
  req.on('error', reject); req.end();
});

/**
 * 开一个成员页:新的浏览器上下文、加入项目、(第一次)摆一张内置卡与一张图片素材。
 * `saveRtc`:在每个文档的页面脚本之前留一份原装的 `RTCPeerConnection`(仿「脚本加固被绕过」)。
 */
let clipsAdded = false;
async function openMember(tag, { saveRtc = false, mobile = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const popups = [];
  ctx.on('targetcreated', (t) => { if (t.type() === 'page' && t.url() && t.url() !== 'about:blank') popups.push(t.url()); });
  if (mobile) {
    await page.emulate({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      viewport: { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false },
    });
    await page.evaluateOnNewDocument(() => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 4 }); });
  } else {
    await page.setViewport({ width: 1600, height: 900 });
  }
  if (saveRtc) await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(window, '__pcSavedRtc', { value: window.RTCPeerConnection, enumerable: false });
      const create = Document.prototype.createElement;
      Object.defineProperty(window, '__pcMakeFrame', { value: () => create.call(document, 'iframe'), enumerable: false });
    } catch { /* Worker 等没有 */ }
  });
  // 声音线程里的探测结果由线程 postMessage 出来:在每个文档的页面脚本之前给 Worker 包一层接住(只多听一个消息,不改线程)
  await page.evaluateOnNewDocument(() => {
    try {
      const W = window.Worker;
      if (typeof W !== 'function') return;
      const Wrapped = function (...a) {
        const w = new W(...a);
        w.addEventListener('message', (e) => { const d = e.data; if (d && typeof d === 'object' && typeof d.__pcBoundary === 'string') { window.__pcBoundaryWorker = { ...(window.__pcBoundaryWorker ?? {}), [d.__pcBoundary]: d.r }; } });
        return w;
      };
      Wrapped.prototype = W.prototype;
      Object.defineProperty(window, 'Worker', { value: Wrapped, configurable: true, writable: true });
    } catch { /* 没有 Worker */ }
  });
  page.on('dialog', (d) => void d.accept());
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  if (process.env.PROBE_DEBUG) page.on('console', (msg) => { if (msg.type() === 'warn' || msg.type() === 'error') console.error('[console:' + tag + ']', scrub(msg.text().slice(0, 400))); });
  // 页面经文档服务拿到的每一张票据都算秘密(读的、读写的、连接用的)
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', (ev) => {
    const data = ev?.response?.payloadData;
    if (typeof data !== 'string' || !data.includes('ticket')) return;
    try { const m = JSON.parse(data); if (typeof m.ticket === 'string') addSecret(`页面拿到的票据(${m.type})`, m.ticket); } catch { /* 不是 JSON */ }
  });
  const typeInto = async (sel, value) => {
    await page.waitForSelector(sel, { visible: true, timeout: 30_000 });
    await page.click(sel, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(sel, value, { delay: 5 });
  };
  await page.goto(`${ORIGINS.editor}/editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
  await typeInto('[data-pc="join-name"]', NAME);
  await typeInto('[data-pc="join-username"]', `m-${tag.toLowerCase()}`);
  await typeInto('[data-pc="join-password"]', PROJECT_PW);
  await page.click('[data-pc="join-submit"]');
  await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 });
  await until(`${tag} 时间轴`, () => page.evaluate(() => !!window.__pcStore), 30_000);
  if (!clipsAdded) {
    clipsAdded = true;
    await page.evaluate((hash) => {
      const S = window.__pcStore;
      S.actions.addClipOnNewTrack({ index: 0, cardId: 'punch-pill', start: 0, duration: 6 });
      const m = S.actions.addMedia({ kind: 'image', name: 'probe.png', url: '/@media/' + hash, hash, ext: 'png', size: 100, width: 4, height: 4 });
      S.actions.addClipOnNewTrack({ index: 1, mediaId: m.id, start: 0, duration: 6 });
    }, MEDIA_HASH);
  }
  await page.evaluate(() => window.__pcStore.actions.seek(1));
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && !f.detached);
  const stageOf = (i) => stageFrames().find((f) => f.url().startsWith(`${ORIGINS.stages[i]}/`)) ?? null;
  const diag = () => page.evaluate(() => { const d = window.__pcPreviewDiag?.(); return d ? { dual: d.dual, onlineStages: d.onlineStages, cardExec: d.cardExec, lowMemory: d.lowMemory } : null; });
  const gateOf = (frame) => frame.evaluate(() => ({ gate: window.__pcCardExecGate?.() ?? null, iso: window.__pcStageIsolation?.() ?? null, url: location.origin + location.pathname })).catch(() => null);
  /** 每个文档里夹具写的顶层记号(`__pcBoundaryLoaded`):编辑页面与每个舞台文档各一条 */
  const marks = async () => ({
    editor: await page.evaluate(() => globalThis.__pcBoundaryLoaded ?? null).catch(() => 'err'),
    stages: await Promise.all(stageFrames().map((f) => f.evaluate(() => ({ url: location.origin + location.pathname, loaded: globalThis.__pcBoundaryLoaded ?? null })).catch(() => ({ url: '?', loaded: 'err' })))),
  });
  return { tag, ctx, page, popups, pageErrors, stageFrames, stageOf, diag, gateOf, marks, close: () => ctx.close().catch(() => {}) };
}

/** 页面认出同步来的卡(定时重取内容库,最多几秒) */
const knowsCard = (m, cardId) => until(`${m.tag} 页面认出同步来的卡 ${cardId}`, () => m.page.evaluate((id) => !!window.__pcCardSources?.()?.cards?.some((c) => c.id === id), cardId), 60_000, 500);
/** 放一个用这张卡的片段(同步来的卡不在主注册表,经 editCardProject 直接放);已有同 id 的片段就换掉它的参数 */
const putBoundaryClip = (m, clipId, cardId, start, params) => m.page.evaluate((id, card, at, p) => {
  const S = window.__pcStore;
  S.actions.editCardProject((proj) => {
    const tracks = proj.tracks.map((tr) => ({ ...tr, clips: tr.clips.filter((c) => c.id !== id) })).filter((tr) => tr.id !== 'ocs-t-' + id);
    return { ...proj, duration: Math.max(proj.duration, at + 4), tracks: [{ id: 'ocs-t-' + id, name: '序列 ' + id, clips: [{ id, cardId: card, start: at, end: at + 2, params: p }] }, ...tracks] };
  });
}, clipId, cardId, start, params);
/** 这张卡在本页的运行状态(编辑页面的注册表) */
const runStateOf = (m, cardId) => m.page.evaluate((id) => { const d = window.__pcCardExecDiag?.(); if (!d) return null; const per = Object.fromEntries(Object.entries(d.stages).map(([k, v]) => [k, (v.states.find((s) => s[0] === id) ?? [null, null])[1]])); return { available: d.available, visual: d.visual, bundles: d.bundles, per, graph: Object.fromEntries(Object.entries(d.stages).map(([k, v]) => [k, v.graph])) }; }, cardId).catch(() => null);

/** 在一个帧里执行夹具的某个函数(与加载器执行转译结果同一个办法) */
const runInFrameRaw = (frame, fn, ctx, { worker = false } = {}) => frame.evaluate(async (code, fnName, c, inWorker) => {
  if (!inWorker) {
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', code)(() => { throw new Error('探针里没有模块'); }, mod, mod.exports);
    const arg2 = fnName === 'webrtcAttack' ? window.__pcSavedRtc : undefined;
    return await mod.exports[fnName](c, arg2);
  }
  // 声音那一半:舞台起 blob Worker(继承舞台文档的策略);Worker 里先建 Trusted Types 的缺省策略再执行(同 `spawnWorker.ts`)
  const boot = 'if (self.trustedTypes && !self.trustedTypes.defaultPolicy) self.trustedTypes.createPolicy("default", { createHTML: (s) => s, createScript: (s) => s, createScriptURL: (s) => s });'
    + 'onmessage = async (e) => { const m = { exports: {} }; try { new Function("require", "module", "exports", e.data.code)(() => { throw new Error("no modules"); }, m, m.exports); postMessage({ ok: true, out: await m.exports[e.data.fn](e.data.ctx) }); } catch (err) { postMessage({ ok: false, error: String(err) }); } };';
  const w = new Worker(URL.createObjectURL(new Blob([boot], { type: 'text/javascript' })));
  try {
    return await new Promise((res) => { w.onmessage = (ev) => res(ev.data.ok ? ev.data.out : { 'worker-error': ev.data.error }); w.onerror = (ev) => res({ 'worker-error': String(ev.message) }); w.postMessage({ code, fn: fnName, ctx: c }); setTimeout(() => res({ 'worker-error': '超时' }), 120_000); });
  } finally { w.terminate(); }
}, LIB, fn, ctx, worker).catch((e) => ({ 'run-error': String(e?.message ?? e).slice(0, 300) }));
/** 每次执行有时限:舞台被探测代码带死(渲染进程卡住)时回 `run-error`,由断言去报,探针自己不挂 */
const RUN_TIMEOUT_MS = Number(process.env.PROBE_RUN_TIMEOUT_MS ?? 180_000);
async function runInFrame(frame, fn, ctx, opts) {
  const t0 = Date.now();
  if (process.env.PROBE_DEBUG) console.error(`[run] ${fn}${opts?.worker ? '(worker)' : ''} ${ctx?.tag ?? ''} …`);
  let r = await Promise.race([runInFrameRaw(frame, fn, ctx, opts), sleep(RUN_TIMEOUT_MS).then(() => null)]);
  if (r === null) r = { 'run-error': `${RUN_TIMEOUT_MS} ms 没返回,停在 ${await Promise.race([frame.evaluate(() => String(globalThis.__pcBoundaryProgress)).catch(() => '?'), sleep(3000).then(() => '(舞台没应答)')])}` };
  if (process.env.PROBE_DEBUG) console.error(`[run] ${fn} ${ctx?.tag ?? ''} ${Date.now() - t0} ms${r && r['run-error'] ? ` 出错:${r['run-error']}` : ''}`);
  return r;
}

const flat = (o) => Object.entries(o ?? {}).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
/** 一段倒出来的文本里有没有探针知道的秘密;回命中的标签(不回值) */
const leaksIn = (textDump) => { const hit = new Set(); for (const [value, label] of secrets) if (textDump.includes(value)) hit.add(label); return [...hit]; };
const TICKET_SHAPE = /v1\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/;

/** 起代理 → 跑一个场景 → 关代理 */
async function withProxy(options, fn) {
  const proxy = await startHostedProxy({ dist: DIST, basePort: BASE, docPort: DOC_PORT, assetPort: ASSET_PORT, ...options });
  try { return await fn(proxy); } finally { await proxy.close(); }
}

/** 等本页的判定落定(不是 pending),回诊断 */
const settled = (m, ms = 40_000) => until(`${m.tag} 本页的执行判定落定`, async () => { const d = await m.diag(); return d && d.cardExec && d.cardExec.reason !== 'pending' && (d.dual ? m.stageFrames().length >= 2 : true) ? d : null; }, ms);

try {
  /* ============================================================ A 隔离生效 */
  if (ONLY.includes('A')) await withProxy({ policy: 'full' }, async (proxy) => {
    console.log('\n== A 隔离生效(新 nginx:策略头 + 出口白名单 + /media-s/)');
    resetSink();
    const m = await openMember('A');
    const canary = `PCCANARY${randomBytes(12).toString('hex')}`;
    addSecret('探针种在编辑器页存储里的记号', canary);
    // 记号种进编辑器页的每一种存储与一个全局变量
    await m.page.evaluate(async (c) => {
      localStorage.setItem('pc.probe.canary', c);
      sessionStorage.setItem('pc.probe.canary', c);
      document.cookie = `pc_probe_canary=${c}; Path=/`;
      window.__pcProbeCanary = c;
      await new Promise((res) => { const r = indexedDB.open('pc-probe-canary-db', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { const tx = r.result.transaction('s', 'readwrite'); tx.objectStore('s').put(c, 'k'); tx.oncomplete = () => { r.result.close(); res(); }; }; });
      try { const d = await navigator.storage.getDirectory(); const f = await d.getFileHandle('pc-probe-canary.txt', { create: true }); const w = await f.createWritable(); await w.write(c); await w.close(); } catch { /* 没有 OPFS */ }
      try { const ch = await caches.open('pc-probe-canary'); await ch.put('/pc-probe-canary', new Response(c)); } catch { /* 没有 Cache */ }
    }, canary);
    const d0 = await settled(m);
    summary.A = { cardExec: d0?.cardExec, onlineStages: d0?.onlineStages?.handshake };
    const sA = m.stageOf(0), sB = m.stageOf(1);
    const gA = sA ? await m.gateOf(sA) : null, gB = sB ? await m.gateOf(sB) : null;
    check('A1 本页是双舞台、握手成功', d0?.dual === true && d0?.onlineStages?.handshake === 'ok', d0?.onlineStages);
    check('A1 两台舞台自检通过(跨源、策略出自响应头、文档边界加固装上，无 TT 强制)', [gA, gB].every((g) => g?.iso?.report?.ok === true && g.iso.report.csp === 'header' && g.iso.report.crossOrigin === true && g.iso.harden?.installed === true), [gA?.iso?.report, gB?.iso?.report]);
    check('A1 不设置卡片出口护栏(egress none)', [gA, gB].every((g) => g?.iso?.report?.egress === 'none'), [gA?.iso?.report?.egress, gB?.iso?.report?.egress]);
    check('A1 票据交接成功、本页判「可执行」,两台舞台的执行闸门开着', d0?.cardExec?.enabled === true && gA?.gate?.allowed === true && gB?.gate?.allowed === true, { page: d0?.cardExec?.reason, A: gA?.gate, B: gB?.gate });
    check('A1 舞台载的是舞台入口 stage.html', [gA, gB].every((g) => /\/editor\/stage\.html$/.test(g?.url ?? '')), [gA?.url, gB?.url]);
    const sandbox = await m.page.$$eval('iframe[data-pc^="stage-frame"]', (els) => els.map((e) => e.getAttribute('sandbox')));
    check('A1 舞台 iframe 的 sandbox 只有 allow-scripts allow-same-origin', sandbox.length >= 2 && sandbox.every((s) => s === 'allow-scripts allow-same-origin'), sandbox);
    const hs = await headOf(BASE + 1, `s1.pc.localhost:${BASE + 1}`, '/editor/stage.html'), he = await headOf(BASE, `pc.localhost:${BASE}`, '/editor');
    check('A1 舞台响应带内容安全策略(与 stagePolicy.mjs 逐字相同)且没有出口白名单', hs.headers['content-security-policy'] === stageCspHeader(ORIGINS.editor) && hs.headers['connection-allowlist'] === undefined && hs.headers['x-dns-prefetch-control'] === 'off', hs.headers['connection-allowlist']);
    check('A1 编辑器页响应带 frame-src(只许本源与两个舞台源)', he.headers['content-security-policy'] === editorCspHeader(ORIGINS.stages), he.headers['content-security-policy']);
    const sid = d0?.cardExec?.sid ?? '';
    const mediaSrc = sA ? await until('A 舞台里的素材元素', () => sA.evaluate((hash) => { const el = [...document.querySelectorAll('img,video')].find((e) => (e.getAttribute('src') ?? '').includes(hash)); return el ? el.getAttribute('src') : null; }, MEDIA_HASH), 20_000) : null;
    check('A1 舞台读素材的地址是 /media-s/<sid>/media/<哈希>,不带 ?t=', mediaSrc === `/media-s/${sid}/media/${MEDIA_HASH}`, (mediaSrc ?? '').replace(MEDIA_HASH, '<哈希>').replace(/\?t=.*/, '?t=…'));
    await until('A 舞台凭 cookie 取到素材', () => proxy.requests.some((r) => r.path === `/media-s/${sid}/media/${MEDIA_HASH}` && (r.status === 200 || r.status === 206)), 20_000);
    for (const g of proxy.grants) addSecret('交接给舞台源的只读素材票据', g.ticket);
    check('A1 交接请求到了两个舞台源(票据在 Authorization 头里)', ['stageA', 'stageB'].every((r) => proxy.grants.some((g) => g.role === r && g.sid === sid && g.ticket.length > 40)), proxy.grants.map((g) => g.role));
    // 编辑器页存的凭证、设备身份
    const editorSecrets = await m.page.evaluate(() => {
      const out = [];
      const walk = (v, where, key) => {
        if (typeof v === 'string') { if (/^[A-Za-z0-9_-]{43}$/.test(v) || /^(key|password|secret|token|proof|ticket)$/i.test(key ?? '')) out.push({ label: `编辑器页存的凭证(${where})`, value: v }); return; }
        if (v && typeof v === 'object') for (const [k, c] of Object.entries(v)) walk(c, where, k);
      };
      for (const k of Object.keys(localStorage)) { let v = localStorage.getItem(k); try { v = JSON.parse(v); } catch { /* 原样 */ } walk(v, k, k); }
      const dev = localStorage.getItem('pc.online.device');
      if (dev) { try { const j = JSON.parse(dev); for (const [k, c] of Object.entries(j)) if (typeof c === 'string' && c.length >= 12 && /id/i.test(k)) out.push({ label: `设备身份(${k})`, value: c }); } catch { if (dev.length >= 12) out.push({ label: '设备身份', value: dev }); } }
      return out;
    });
    for (const s of editorSecrets) addSecret(s.label, s.value);
    check('A3 准备:探针手里有编辑器页存的凭证、设备身份与票据可比', editorSecrets.some((s) => /凭证/.test(s.label)) && [...secrets.values()].some((l) => /票据/.test(l)), [...new Set(secrets.values())]);

    const mkCtx = (tag, graph, stageOrigin) => ({ tag, graph, collector: EVIL, collectorPort: SINK_PORT, dnsHost: DNS.guarded, sid, mediaHash: MEDIA_HASH, stageOrigin, frameDocUrl: '/editor/stage.html', magic: `MAGIC${randomBytes(6).toString('hex')}`, listenMs: 1500 });
    const ctxA = mkCtx('user-card', false, undefined), ctxB = mkCtx('graph-card', true, undefined);
    /*
     * 「卡片代码」的执行办法与加载器相同。分三段:
     *   一、闸门开着(A1 已核):读父页、把读得到的一切倒出来、图卡读素材、声音线程;
     *   二、两台舞台都开始听父页的消息,然后舞台 A 试着造一个子框架 —— 加固拦下并上报,父页改判、把取档策略重发给两台(RPC),
     *       听到的消息里不该有票据;
     *   三、伪造消息、外传、加固各条路(这时闸门已经因为第二段关上了;照样硬跑,断言看的是浏览器与加固拦不拦得住)。
     */
    /*
     * 真实加载路径:越权探测卡的片段摆上(参数里带 ctx)→ 等这张卡在本页「能运行」(两台舞台的加载器都执行了它的模块顶层)→
     *   一、声音那一半:请编辑页面生成这段卡片的声音,经舞台 RPC 到实例 B 起的声音线程,`audio()` 在线程里跑 Worker 那一组;
     *   二、窗口那一半:播放头拨到片段上,可见的那台舞台挂上它,卡片代码把探测整套跑一遍(其间探针在编辑页面改一处项目,
     *       让父页经 RPC 下发项目内容;探测里那一步「试着造子框架」被加固拦下并上报,父页改判、把取档策略重发给两台)。
     */
    const runCard = async (member, which, ctx, at) => {
      const cardId = BOUNDARY_CARDS[which], clipId = `ocs-probe-${which}`, tag = which === 'user' ? 'user-card' : 'graph-card';
      const r = {};
      await knowsCard(member, cardId);
      await putBoundaryClip(member, clipId, cardId, at, { ctx: { ...ctx, listenAfterMs: 5000 } });
      const ready = await until(`${member.tag} ${cardId} 在本页能运行(两台舞台都载入成功)`, async () => { const s = await runStateOf(member, cardId); return s && s.per.A?.state === 'ready' && s.per.B?.state === 'ready' ? s : null; }, 60_000, 500);
      r.runState = ready ?? await runStateOf(member, cardId);
      r.marks = await member.marks();
      // 一、声音线程
      const audio = await member.page.evaluate(async (id) => {
        try { const sound = await window.__pcIo.sound(); const out = await sound.generateCardAudio(id, { force: true }); return { ok: out?.ok === true }; } catch (e) { return { error: String(e?.message ?? e).slice(0, 200) }; }
      }, clipId);
      r.audioAsk = audio;
      const workerTag = `${tag}-audio`;
      r.worker = await until(`${member.tag} 声音线程里的探测跑完(${workerTag})`, async () => { for (const f of member.stageFrames()) { const v = await f.evaluate((t) => window.__pcBoundaryWorker?.[t] ?? null, workerTag).catch(() => null); if (v) return v; } return null; }, 180_000, 500) ?? { 'worker-error': `没跑起来:${JSON.stringify(audio)}` };
      r.workerHost = await Promise.all(member.stageFrames().map((f) => f.evaluate((t) => ({ id: new URLSearchParams(location.search).get('id'), has: !!window.__pcBoundaryWorker?.[t] }), workerTag).catch(() => null)));
      // 二、窗口
      await member.page.evaluate((t) => window.__pcStore.actions.seek(t), at + 0.5);
      await until(`${member.tag} 可见舞台挂上了 ${cardId}、探测开始跑`, async () => { for (const f of member.stageFrames()) { if (await f.evaluate((t) => !!globalThis.__pcBoundaryStarted?.[t], tag).catch(() => false)) return true; } return false; }, 60_000, 250);
      // 听的时候在编辑页面改一处项目:父页把项目内容经 RPC 下发给两台(setProject),里面同样不该有凭证类的东西
      await sleep(1500);
      await member.page.evaluate(() => { window.__pcStore.actions.addClipOnNewTrack({ index: 0, cardId: 'punch-pill', start: 6, duration: 2 }); });
      const done = await until(`${member.tag} ${cardId} 的探测整套跑完`, async () => { for (const f of member.stageFrames()) { const v = await f.evaluate((t) => globalThis.__pcBoundary?.[t] ?? null, tag).catch(() => null); if (v) return { v, url: f.url().replace(/\?.*$/, '') }; } return null; }, RUN_TIMEOUT_MS * 2, 1000);
      Object.assign(r, done?.v ?? {});
      r.ranIn = done?.url ?? null;
      if (!done) { const prog = await Promise.all(member.stageFrames().map((f) => Promise.race([f.evaluate(() => String(globalThis.__pcBoundaryProgress)).catch(() => '?'), sleep(3000).then(() => '(舞台没应答)')]))); r.exfil = { 'run-error': `没跑完,停在 ${prog.join(' / ')}` }; }
      return r;
    };
    const rA = sA && sB ? await runCard(m, 'user', ctxA, 10) : {};
    rA.sid = sid;
    check('A-真实路径 越权探测用户卡:页面转译成包、两台舞台的加载器都执行了它(运行状态 ready),探测是卡片代码自己在可见舞台里跑的', rA.runState?.per?.A?.state === 'ready' && rA.runState?.per?.B?.state === 'ready' && /\/editor\/stage\.html$/.test(rA.ranIn ?? ''), { runState: rA.runState, ranIn: rA.ranIn });
    check('E 编辑页面不执行:越权探测卡的模块顶层记号只出现在两台舞台里,编辑页面的文档里没有', rA.marks?.editor === null && rA.marks?.stages?.length === 2 && rA.marks.stages.every((s) => s.loaded?.['user-card'] === true && /\/editor\/stage\.html$/.test(s.url)), rA.marks);
    check('A6-真实路径 越权探测用户卡的 audio() 是在实例 B 起的声音线程里被调用的', rA.workerHost?.some((h) => h?.id === 'B' && h.has) && !rA.workerHost?.some((h) => h?.id === 'A' && h.has) && !rA.worker?.['worker-error'], { ask: rA.audioAsk, host: rA.workerHost, err: rA.worker?.['worker-error'] });
    // 越权探测图卡另开一页(上一页的会话已经因为加固拦下的事不再执行);先把用户卡片段的参数清掉,它在这一页不跑
    let rB = {}, mG = null;
    if (sA && sB) {
      await putBoundaryClip(m, 'ocs-probe-user', BOUNDARY_CARDS.user, 10, {});
      await sleep(1500);
      mG = await openMember('Ag');
      const dG = await settled(mG);
      const sidG = dG?.cardExec?.sid ?? '';
      await until('Ag 舞台凭 cookie 取到素材', () => proxy.requests.some((r) => r.path === `/media-s/${sidG}/media/${MEDIA_HASH}` && (r.status === 200 || r.status === 206)), 30_000);
      for (const g of proxy.grants) addSecret('交接给舞台源的只读素材票据', g.ticket);
      ctxB.sid = sidG;
      rB = await runCard(mG, 'graph', ctxB, 14);
      rB.sid = sidG;
      check('A-真实路径 越权探测图卡:图形能力够、两台舞台都载入成功(ready),card() 是在可见舞台里被求值的', rB.runState?.per?.A?.state === 'ready' && rB.runState?.per?.B?.state === 'ready' && rB.runState?.graph?.A === 'ok' && /\/editor\/stage\.html$/.test(rB.ranIn ?? ''), { runState: rB.runState, ranIn: rB.ranIn });
      check('E 编辑页面不执行(图卡那一页):顶层记号只在两台舞台里', rB.marks?.editor === null && rB.marks?.stages?.length === 2 && rB.marks.stages.every((s) => s.loaded?.['graph-card'] === true), rB.marks);
      check('A6-真实路径 越权探测图卡的 audio() 是在实例 B 起的声音线程里被调用的', rB.workerHost?.some((h) => h?.id === 'B' && h.has) && !rB.worker?.['worker-error'], { ask: rB.audioAsk, host: rB.workerHost, err: rB.worker?.['worker-error'] });
    }
    await sleep(2000);
    summary.A.userCard = { parent: rA.parent, exfil: rA.exfil, harden: rA.harden, worker: rA.worker };
    summary.A.graphCard = { parent: rB.parent, media: rB.media, exfil: rB.exfil, harden: rB.harden, worker: rB.worker };

    for (const [who, r] of [['越权探测用户卡(舞台 A)', rA], ['越权探测图卡(舞台 B)', rB]]) {
      /* A2 父页对象 */
      const mustThrow = ['parent.document', 'parent.location.href', 'parent.localStorage', 'parent.sessionStorage', 'parent.indexedDB', 'parent.__pcStore', 'parent.__pcPreviewDiag', 'parent.fetch', 'parent.eval', 'parent.document.cookie', 'top.document', 'top.location.href', 'top.localStorage', 'parent.name'];
      const notThrown = mustThrow.filter((k) => !/^抛错:SecurityError/.test(r.parent?.[k] ?? ''));
      check(`A2 ${who}:读父页与顶层的 ${mustThrow.length} 种属性全部抛 SecurityError`, notThrown.length === 0, notThrown.map((k) => `${k}=${r.parent?.[k]}`));
      const sib = [0, 1, 2, 3].map((i) => r.parent?.[`parent.frames[${i}]`] ?? '').filter((v) => v && v !== '自己' && !/^抛错:(SecurityError|TypeError)/.test(v));
      check(`A2 ${who}:别的框架(另一台舞台)读不到`, sib.length === 0, sib);
      check(`A2 ${who}:opener、frameElement 为空`, r.parent?.opener === 'null' && r.parent?.frameElement === 'null', `${r.parent?.opener} / ${r.parent?.frameElement}`);
      /* A3 凭证、票据、本机存储 */
      const all = `${flat(r.parent)}\n${flat(r.dump)}\n${flat(r.heard)}\n${flat(r.media)}\n${flat(r.worker)}\n${flat(r.exfil)}`;
      const leaked = leaksIn(all);
      check(`A3 ${who}:读得到的一切里没有凭证、票据、设备身份、编辑器页存储里的记号(共比对 ${secrets.size} 个秘密,倒出 ${all.length} 字符)`, leaked.length === 0 && all.length > 5000, leaked);
      const shaped = TICKET_SHAPE.test(all), tq = /[?&]t=v1\./.test(all);
      check(`A3 ${who}:读得到的一切里没有任何票据形状的串,也没有 ?t=`, !shaped && !tq, { shaped, tq });
      for (const k of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'cookieStore', 'opfs', 'caches', 'performance', 'dom', 'globals', 'parent-messages']) {
        const v = r.dump?.[k];
        check(`A3 ${who}:${k} 读出来了、里面没有秘密`, typeof v === 'string' && !/^抛错|^超时/.test(v) && leaksIn(v).length === 0 && !TICKET_SHAPE.test(v), typeof v === 'string' ? `${v.length} 字符` : v);
      }
      check(`A3 ${who}:舞台里可读的 cookie 是空的(票据的 cookie 是 HttpOnly)`, r.dump?.['document.cookie'] === '' && r.dump?.cookieStore === '[]', `${r.dump?.['document.cookie']} / ${r.dump?.cookieStore}`);
      const heard = r.heard?.['parent-messages'] ?? '';
      check(`A3 ${who}:听到了父页下发的项目内容(RPC setProject)与重发的取档策略(setMediaPolicy,基址是 /media-s/<sid>、票据是 null),整段消息里没有秘密`, /"method":"setProject"/.test(heard) && /setMediaPolicy/.test(heard) && heard.includes(`/media-s/${r.sid}`) && /"ticket":null/.test(heard) && leaksIn(heard).length === 0 && !TICKET_SHAPE.test(heard), { chars: heard.length, methods: [...new Set([...heard.matchAll(/"method":"(\w+)"/g)].map((x) => x[1]))] });
      check(`A3 ${who}:凭 cookie 读素材的应答头里没有票据;舞台自己发交接请求被拒`, /^200 /.test(r.dump?.['media-headers'] ?? '') && /^403 /.test(r.dump?.['grant-from-stage'] ?? ''), `${(r.dump?.['media-headers'] ?? '').slice(0, 4)} / ${(r.dump?.['grant-from-stage'] ?? '').slice(0, 4)}`);
      /* A6 声音线程 */
      const w = r.worker ?? {};
      check(`A6 ${who}:声音线程里没有父页、顶层、文档、localStorage、opener,也没有 RTCPeerConnection`, w['w.globals'] === 'undefined/undefined/undefined/undefined/undefined' && w['w.RTCPeerConnection'] === 'undefined/undefined', `${w['w.globals']} ; ${w['w.RTCPeerConnection']}`);
      const wNet = ['w.fetch', 'w.fetch-no-cors', 'w.xhr', 'w.websocket', 'w.eventsource', 'w.importScripts', 'w.dynamic-import', 'w.nested-worker-url', 'w.webtransport'].filter((k) => /到达|已建/.test(w[k] ?? ''));
      check(`A6 ${who}:声音线程仍无父页凭证，外链按舞台策略可到达`, !w['worker-error'] && wNet.includes('w.fetch'), wNet);
      notes.push('不适用：旧A6 blob声音线程出网为零；这是卡片线程，audio-js工具专用断网sandbox代码没有改动。');
      /* A7 加固 */
      const paths = Object.entries(r.harden ?? {}).filter(([k]) => k !== 'own' && k !== '收尾时的子框架数');
      const got = paths.filter(([, v]) => /拿到了|OPENED/.test(v)).map(([k]) => k);
      check(`A7 ${who}:保留 WebRTC，结构保护拒绝新子框架`, paths.length >= 40 && got.length === 0, got.length ? got : r.harden?.own);
      const leftFrames = paths.filter(([, v]) => !/子框架 0 个/.test(v)).map(([k, v]) => `${k}:${v}`);
      check(`A7 ${who}:每条路试完舞台里都没有留下子框架`, leftFrames.length === 0 && r.harden?.['收尾时的子框架数'] === '0', leftFrames);
    }
    for (const k of ['XSLT', 'importNode(从取回来的同源文档)', 'XHR responseType=document']) console.log(`        回归:${k} → 用户卡 ${rA.harden?.[k]} ; 图卡 ${rB.harden?.[k]}`);
    /* A4 图卡干得了活 */
    const md = rB.media ?? {};
    check('A4 图卡:凭 cookie 按 Range 取素材是 206、字节是 PNG 的头', /^206 bytes 0-7\/\d+ 137,80,78,71,13,10,26,10$/.test(md.range ?? ''), md.range);
    check('A4 图卡:素材画进 2D 画布、传进 WebGL2 纹理都读得回像素(没被污染)', md['img-canvas-2d'] === '10,200,30,255' && md['img-webgl2'] === '10,200,30,255', `${md['img-canvas-2d']} / ${md['img-webgl2']}`);
    check('A4 图卡:换一个 sid、不带票据走旧路由都是 401', md['other-sid'] === '状态:401' && md['legacy-route-without-ticket'] === '状态:401', `${md['other-sid']} / ${md['legacy-route-without-ticket']}`);
    check('A4 图卡:只放行 GET / HEAD 与素材字节那一种路径(POST 405,别的命名空间与子路由 404)', md['post-to-media'] === '状态:405' && md['other-namespace'] === '状态:404' && md['chunks-route'] === '状态:404', `${md['post-to-media']} / ${md['other-namespace']} / ${md['chunks-route']}`);
    check('A6 声音线程凭同一张 cookie 取得到素材(应答头里没有票据)', /^状态:200 /.test(rB.worker?.['w.media'] ?? ''), (rB.worker?.['w.media'] ?? '').slice(0, 8));
    /* 外链是已授权能力，不能再断言收集站为零。 */
    const e1 = sinkNow();
    check('A5 用户卡与图卡实际外链请求到达公开夹具', e1.http > 0 && [rA,rB].every(r => Object.values(r.exfil ?? {}).some(v => /到达/.test(v))), e1);
    notes.push('不适用：旧 A5 全面外发为零、WebRTC 构造器不存在；P1/P3 已撤销。');
    /* A7 试图造子框架之后父页不再执行 */
    const d1 = await until('A 父页收到加固拦下的上报', async () => { const d = await m.diag(); return d?.cardExec?.reason === 'breach' ? d : null; }, 10_000);
    const gA2 = sA ? await m.gateOf(sA) : null;
    check('A7 有代码试图造子框架之后:父页本次会话不再判「可执行」(原因 breach),舞台的执行闸门关上', d1?.cardExec?.enabled === false && gA2?.gate?.allowed === false, { page: d1?.cardExec?.reason, stage: gA2?.gate });
    /* A8 父页对伪造消息 */
    const after = await m.page.evaluate(async (magics) => {
      const parts = [];
      for (const k of Object.keys(localStorage)) parts.push(k + '=' + localStorage.getItem(k));
      for (const info of await indexedDB.databases()) {
        const db = await new Promise((res, rej) => { const r = indexedDB.open(info.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        for (const store of Array.from(db.objectStoreNames)) {
          const rows = await new Promise((res) => { const r = db.transaction(store, 'readonly').objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
          try { parts.push(JSON.stringify(rows)); } catch { /* 存的不是普通对象 */ }
        }
        db.close();
      }
      const storage = parts.join('\n');
      return {
        alive: !!window.__pcPreviewDiag?.(), xss: typeof window.__pcXss, html: document.querySelectorAll('[data-pcboundary-html]').length,
        polluted: typeof ({}).polluted, hugeNumber: /7\.77e\+?98/.test(storage), forgedIdentity: magics.some((x) => storage.includes('FORGED-' + x)), bytes: storage.length,
        probeRun: JSON.stringify(window.__pcPreviewDiag?.().probeRun ?? null).length,
        t: window.__pcStore.getState().t, duration: window.__pcStore.getState().project.duration,
      };
    }, [ctxA.magic, ctxB.magic]);
    check('A8 父页对伪造的握手、回包、舞台事件:没崩、没有页面错误', after.alive === true && m.pageErrors.length === 0, m.pageErrors.slice(0, 3));
    check('A8 父页没有把舞台交来的 HTML 放进活文档(里面的脚本没执行、原型没被污染)', after.xss === 'undefined' && after.html === 0 && after.polluted === 'undefined', after);
    check('A8 父页的存储里没有伪造事件里那个超范围的数', after.hugeNumber === false, { bytes: after.bytes, forgedIdentity: after.forgedIdentity });
    check('A8 伪造的时刻(1e99 秒)没把播放头带出时间轴', typeof after.t === 'number' && after.t >= 0 && after.t <= after.duration, { t: after.t, duration: after.duration });
    await m.page.screenshot({ path: path.join(OUT, 'a-editor.png') }).catch(() => {});
    if (mG) {
      const dG1 = await mG.diag();
      check('A7 图卡那一页同样:试图造子框架之后父页不再判「可执行」;没有页面错误、没开出新窗口', dG1?.cardExec?.enabled === false && dG1.cardExec.reason === 'breach' && mG.pageErrors.length === 0 && mG.popups.length === 0, { page: dG1?.cardExec?.reason, errors: mG.pageErrors.slice(0, 3), popups: mG.popups });
      await mG.page.screenshot({ path: path.join(OUT, 'a-editor-graph.png') }).catch(() => {});
      // 收尾:图卡片段的参数也清掉 —— 后面几组的页面里这两张卡照常载入(记号断言要用),但片段没有参数、不跑探测
      await putBoundaryClip(mG, 'ocs-probe-graph', BOUNDARY_CARDS.graph, 14, {});
      await sleep(1500);
      await mG.close();
    }
    await m.close();

    /* A5 导航类:每种单开一页 */
    summary.A.nav = {};
    for (const nav of ['top', 'parent', 'open', 'open-top', 'anchor-blank', 'form-top']) {
      if (process.env.PROBE_SKIP_NAV) break; // 调探针时省时间用;验收不许带
      resetSink();
      const n = await openMember(`An${nav.replace(/-/g, '')}`);
      await settled(n);
      const f = n.stageOf(0);
      const said = f ? await runInFrame(f, 'navAttack', { collector: EVIL, tag: 'nav', nav }).catch((e) => `帧没了:${String(e.message).slice(0, 60)}`) : '没有舞台';
      await sleep(2500);
      const e = sinkNow();
      const stillEditor = n.page.url().startsWith(`${ORIGINS.editor}/editor`) && await n.page.evaluate(() => !!window.__pcStore).catch(() => false);
      summary.A.nav[nav] = { said, ...e, popups: n.popups };
      check(`A5 导航类(${nav}):sandbox 保持顶层没被带走、没开出新窗口`, stillEditor && n.popups.filter((u) => u.startsWith(EVIL)).length === 0, { said, ...e, popups: n.popups });
      await n.close();
    }
  });

  /* ============================================================ B 浏览器层面拦 WebRTC */
  if (ONLY.includes('B')) await withProxy({ policy: 'full' }, async () => {
    console.log('\n== B 假设脚本加固被绕过(页面脚本之前留了一份原装构造器):不把WebRTC封堵作为执行前提');
    resetSink();
    const m = await openMember('B', { saveRtc: true });
    await settled(m);
    const f = m.stageOf(0);
    const has = f ? await f.evaluate(() => typeof window.__pcSavedRtc + '/' + typeof window.RTCPeerConnection) : '';
    check('B 准备:舞台里原装构造器留着(function),当前全局也保留 function', has === 'function/function', has);
    notes.push('不适用：B WebRTC 外发为零，已撤销出口护栏；不再主动发送 STUN。');
    const ins = f ? await runInFrame(f, 'insertAttacks', { tag: 'bypass' }) : {};
    summary.B = { insert: ins };
    const entries = Object.entries(ins).filter(([k]) => k !== '收尾时的子框架数');
    const through = entries.filter(([, v]) => !/^抛错:TypeError;同一拍里子框架 0 个$/.test(v)).map(([k, v]) => `${k}:${v}`);
    check(`B 假设「不给造子框架元素」那一层也被绕过(手里有一个原装造出来的 iframe 元素):${entries.length} 个插入入口全部拦下,舞台里没出现子框架`, entries.length >= 20 && through.length === 0 && ins['收尾时的子框架数'] === '0', through.length ? through : `收尾时子框架 ${ins['收尾时的子框架数']} 个`);
    await m.close();
  });

  /* G 无 Allowlist 的浏览器依旧执行画面。 */
  if (ONLY.includes('G')) await withProxy({ policy: 'csp-only' }, async () => {
    const m=await openMember('G'); const d=await settled(m); const f=m.stageOf(0); const g=f?await m.gateOf(f):null;
    check('G 无 Allowlist 自检通过、画面执行开关开启', g?.iso?.report?.ok===true && g.iso.report.egress==='none' && d?.cardExec?.enabled===true, {report:g?.iso?.report,page:d?.cardExec});
    await knowsCard(m,BOUNDARY_CARDS.user);
    const ready=await until('G 用户卡载入两台舞台',()=>runStateOf(m,BOUNDARY_CARDS.user).then(r=>r?.per?.A?.state==='ready'&&r?.per?.B?.state==='ready'?r:null),60000,500);
    const marks=await m.marks(); const visual=await m.page.evaluate(()=>window.__pcCardExecDiag?.()?.visual);
    check('G 无 Allowlist 用户卡两台舞台 ready，画面可执行，编辑页未执行', !!ready && visual===true && marks.editor===null && marks.stages.length===2 && marks.stages.every(s=>s.loaded?.['user-card']===true), {ready,visual,marks});
    summary.G={ready,visual,marks};await m.close();
  });
  /* C 删除响应头与meta的负向对照仍拒绝执行。 */
  if(ONLY.includes('C')) await withProxy({policy:'none'},async()=>{
    const m=await openMember('C');const d=await settled(m);
    const reports=await until('C 两台舞台真实自检均完成',async()=>{const rs=await Promise.all(m.stageFrames().map(f=>m.gateOf(f)));return rs.length===2&&rs.every(g=>g?.iso?.report)?rs:null;},30000) ?? [];
    check('C 无 CSP 的真实自检拒绝执行',d?.cardExec?.enabled===false && reports.length===2 && reports.every(g=>g?.iso?.report?.ok===false&&g.iso.report.reasons.includes('no-policy')),{page:d?.cardExec,reports});
    summary.C={page:d?.cardExec};await m.close();
  });

  /* ============================================================ L 旧 nginx */
  const offScenario = async (label, tag, proxyOptions, memberOptions, expect) => withProxy(proxyOptions, async (proxy) => {
    console.log(`\n== ${label}`);
    const m = await openMember(tag, memberOptions);
    const d = await settled(m);
    // 后台舞台挂得晚:等每个舞台文档的自检都出了结论再看(闸门不再是 checking)
    await until(`${tag} 每个舞台文档的自检出结论`, async () => { const gs = await Promise.all(m.stageFrames().map((f) => m.gateOf(f))); return gs.length >= (d?.dual ? 2 : 1) && gs.every((g) => g?.gate && g.gate.reason !== 'checking'); }, 30_000);
    const frames = m.stageFrames();
    const gates = await Promise.all(frames.map((f) => m.gateOf(f)));
    const editorGate = await m.page.evaluate(() => window.__pcCardExecGate?.() ?? null);
    summary[tag] = { cardExec: d?.cardExec, dual: d?.dual, stages: gates.map((g) => ({ url: g?.url, gate: g?.gate, report: g?.iso?.report ?? null })) };
    check(`${tag} 本页不执行用户卡与图卡,原因是 ${expect.reason}`, d?.cardExec?.enabled === false && d.cardExec.reason === expect.reason, d?.cardExec);
    check(`${tag} 编辑器页与每个舞台文档的执行闸门都是关的(共 ${gates.length} 个舞台文档)`, editorGate?.allowed === false && gates.length >= 1 && gates.every((g) => g?.gate?.allowed === false), { editor: editorGate, stages: gates.map((g) => g?.gate) });
    if (expect.dual !== undefined) check(`${tag} ${expect.dual ? '仍是双舞台' : '是同源单舞台'}`, d?.dual === expect.dual && (expect.dual || frames.every((f) => f.url().startsWith(`${ORIGINS.editor}/`))), { dual: d?.dual, frames: frames.map((f) => f.url().replace(/\?.*$/, '')) });
    if (expect.report) check(`${tag} 舞台自检的结论:${expect.report}`, gates.every((g) => g?.iso?.report?.ok === false && g.iso.report.reasons.includes(expect.report)), gates.map((g) => g?.iso?.report?.reasons));
    const drawn = await until(`${tag} 内置卡照常画出来`, async () => { for (const f of m.stageFrames()) { if (await f.evaluate(() => [...document.querySelectorAll('[data-pc-clip]:not([data-pc-media])')].some((w) => w.childElementCount > 0)).catch(() => false)) return true; } return false; }, 30_000);
    check(`${tag} 内置卡照常画出来`, !!drawn);
    if (expect.legacyMedia) {
      const src = await until(`${tag} 舞台里的素材元素`, async () => { for (const f of m.stageFrames()) { const s = await f.evaluate((hash) => { const el = [...document.querySelectorAll('img,video')].find((e) => (e.getAttribute('src') ?? '').includes(hash)); return el ? el.getAttribute('src') : null; }, MEDIA_HASH).catch(() => null); if (s) return s; } return null; }, 20_000);
      check(`${tag} 素材照旧走 /media 加 ?t=(这样的舞台文档不执行用户代码),没有交接请求`, /\/media\/api\/asset\/media\/[0-9a-f]{64}\?t=/.test(src ?? '') && proxy.grants.length === 0, { src: (src ?? '').replace(/\?t=.*/, '?t=…'), grants: proxy.grants.length });
    }
    // E 编辑页面不执行:项目里有用越权探测卡的片段、内容库里有它们的源码,拨到片段上,任何文档里都没有顶层记号
    await knowsCard(m, BOUNDARY_CARDS.user);
    await m.page.evaluate(() => window.__pcStore.actions.seek(10.5));
    await sleep(5000);
    const marks = await m.marks();
    check(`E ${tag} 不执行:拨到越权探测卡的片段上,编辑页面与 ${marks.stages.length} 个舞台文档里都没有越权探测卡的顶层记号`, marks.editor === null && marks.stages.length >= 1 && marks.stages.every((s) => s.loaded === null), marks);
    check(`${tag} 没有页面错误`, m.pageErrors.length === 0, m.pageErrors.slice(0, 3));
    await m.page.screenshot({ path: path.join(OUT, `${tag.toLowerCase()}-editor.png`) }).catch(() => {});
    await m.close();
  });
  if (ONLY.includes('L')) await offScenario('L 旧 nginx:没有策略头、没有 /media-s/(新页面先上、nginx 没改)', 'L', { policy: 'legacy' }, {}, { reason: 'not-isolated', dual: true, report: 'meta-only', legacyMedia: true });
  if (ONLY.includes('S')) await offScenario('S 托管方关掉总开关(运行配置 onlineCardExec: false)', 'S', { policy: 'full', onlineCardExec: false }, {}, { reason: 'switch-off', dual: true, legacyMedia: true });
  if (ONLY.includes('N')) await offScenario('N 没有舞台源(读不到运行配置;放本机、没有 nginx 子域的部署)', 'N', { policy: 'legacy', runtimeConfig: false }, {}, { reason: 'single-stage', dual: false });
  if (ONLY.includes('M')) await offScenario('M 低内存档(仿手机)', 'M', { policy: 'full' }, { mobile: true }, { reason: 'single-stage', dual: false });
} catch (e) {
  check('探针没有中途出错', false, String(e?.stack ?? e).slice(0, 500));
} finally {
  await browser.close().catch(() => {});
  /* A9 / C DNS:网络日志里有没有对那两个域名的解析 */
  try {
    const text = fs.readFileSync(NETLOG, 'utf8');
    const resolved = (host) => text.split('\n').filter((l) => l.includes(host) && /"host"|HOST_RESOLVER|dns/i.test(l)).length;
    const anywhere = (host) => text.split(host).length - 1;
    notes.push('不适用：A9 卡片 DNS 零请求；出口护栏已撤销。');

    summary.netlogBytes = text.length;
  } catch (e) {
    check('读到 Chrome 的网络日志', false, String(e?.message ?? e));
  }
  sinkSrv.closeAllConnections?.(); sinkSrv.close(); sinkUdp.close();
  await combo.close?.().catch?.(() => {});
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  try { fs.rmSync(NETLOG, { force: true }); } catch { /* 留着也行 */ }
}
const ok = fails.length === 0;
console.log(JSON.stringify({ ok, pass, fail: fails.length, gaps, fails, notes, secretsCompared: secrets.size, ...summary }));
process.exit(ok ? 0 : 1);
