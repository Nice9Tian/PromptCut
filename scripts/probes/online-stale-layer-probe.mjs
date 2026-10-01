/**
 * 在线浏览器模式改参数后不再贴旧层(stale-layer;交接 `HANDOFF-2026-09-29.md` 第 4 节第二条)。
 * 全程在本机:本机托管组合代替阿里云,仿 nginx 的前缀代理开三个源(编辑器页 + 两个舞台,都带 OAC),在线构建当页面。
 *
 *   npx vite build --mode online --outDir <目录>
 *   node scripts/probes/online-stale-layer-probe.mjs --dist <在线构建目录> [--out <截图目录>] [--base-port 5750]
 *
 * 端口:+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务(缺省 5750～5754)。
 * 探针替渲染节点:按乙页面手里的项目(经文档服务同步来的那一份,过一遍 `renderProject`)用服务端的 `layerMapOf` 写层表
 * (于是每层带 `inputSig`,与真节点同一条代码),段清单每帧都有原尺寸与小尺寸;字节由代理在 `/media/api/asset/snap|px/<hash>` 上直接给。
 *
 * 摆法(一个共享项目,0～4 秒):
 *   u  内容库同步来的用户卡 `probe-synced-card`(在线页面跑不了)
 *   b  内置重卡 `probe-slow-stepped`(stateful、每帧烧 40 ms;在线普通档判重,播放时贴快照、暂停活渲)
 *
 * 断言(普通档,甲、乙两个成员):
 *   1. 第一版层表:两页暂停在 1 秒时 u 贴「SNAP u v1」;播放中 b 贴「SNAP b v1」。
 *   2. 甲改 u 的参数:甲、乙两页的舞台在一拍之内不再贴 u 的旧层、显示沙漏(`awaiting`,不是图标);
 *      用舞台里的 MutationObserver 记时刻:甲从改的那一刻算,乙从它的 store 收到这次修改算。父页 `__pcOnlineSnapshots().stale` 列着 u。
 *   3. 甲把参数改回原来的:原来那一层还在,两页又贴「SNAP u v1」。
 *   4. 甲再改 u、改 b:u 两页沙漏;播放中 b 不再贴「SNAP b v1」(占位或活渲);等满 STALE_AWAIT_MS(15 s)还没新层,u 转成图标、时间轴出徽标。
 *   5. 渲染节点(探针)按新项目写第二版层表与清单:两页 u 贴「SNAP u v2」、图标与徽标撤掉;播放中 b 贴「SNAP b v2」。
 * 不打印口令;结果最后一行是一行 JSON(`ok`、`fails`、各段时延),截图在 --out。
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { createSharedProject, buildAuthProtocols } from '../../server/auth/client.mjs';
import { layerMapOf } from '../../server/artifact-transfer.mjs';
import { renderProject } from '../../server/render-project.mjs';
import { clipInputSig } from '../../src/render/layerInputSig.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'online-stale-layer-shots')));
const BASE = Number(arg('--base-port', 5750));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4 };
const SITE = `http://127.0.0.1:${PORTS.editor}`;
const STAGE_ORIGINS = [`http://127.0.0.1:${PORTS.stageA}`, `http://127.0.0.1:${PORTS.stageB}`];
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
/** 与 `src/render/snapshotSource.ts` 的 `STALE_AWAIT_MS` 同值 */
const STALE_AWAIT_MS = 15_000;
/** 「一拍之内」的判据:舞台 30 fps 一拍 33 ms,父页投递另有 33 ms 的换 DOM 节流;留足余量按 250 ms 判,实测值照记 */
const BEAT_BUDGET_MS = 250;
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return !!cond; };
const say = (k, v) => console.log(JSON.stringify({ [k]: v }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 20_000, every = 150) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { v = null; last = String(e?.message ?? e); }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}${last ? ` (${last.slice(0, 120)})` : ''}`); return null; }
    await sleep(every);
  }
}
const SYNCED_ID = 'probe-synced-card';
const SYNCED_KEY = `src/cards/user/${SYNCED_ID}.tsx`;
const SYNCED_SOURCE = `/** 探针:内容库同步来的用户卡(本机构建里没有) */
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function ProbeSynced({ params }: CardProps<Params>) {
  return <div className="absolute inset-0 flex items-center justify-center">{params.text}</div>;
}
export const probeSyncedCard: CardDef<Params> = {
  id: "${SYNCED_ID}",
  name: "探针同步卡",
  frameMode: "stateful",
  defaults: { text: "synced" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: ProbeSynced,
};
`;

/* ------------------------------------------------------------------ 服务 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-stale-layer-hosted-'));
const combo = await startHostedCombo({
  dataDir, docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
  docPublicUrl: `ws://127.0.0.1:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
});
const fakeAssets = new Map();
const assetLog = [];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
const OAC = { 'origin-agent-cluster': '?1' };
const runtimeConfig = JSON.stringify({ v: 1, stageOrigins: STAGE_ORIGINS });
const servers = [];
function makeProxy(port) {
  const origin = `http://127.0.0.1:${port}`;
  const forward = (req, res, upstream, strip) => {
    const target = req.url.slice(strip.length) || '/';
    const up = http.request({ host: '127.0.0.1', port: upstream, method: req.method, path: target.startsWith('/') ? target : `/${target}`, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, { ...r.headers, ...OAC });
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502, OAC); res.end('bad gateway'); });
    req.pipe(up);
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin);
    if (url.pathname === '/hosted' || url.pathname.startsWith('/hosted/')) return forward(req, res, PORTS.doc, '/hosted');
    const m = /^\/media\/api\/asset\/(snap|px)\/([0-9a-f]{64})$/.exec(url.pathname);
    if (m) {
      assetLog.push({ at: Date.now(), ns: m[1], hash: m[2], port });
      const hit = fakeAssets.get(`${m[1]}/${m[2]}`);
      if (hit && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': hit.type, 'Content-Length': hit.bytes.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*', ...OAC });
        return res.end(hit.bytes);
      }
    }
    if (url.pathname.startsWith('/media/')) return forward(req, res, PORTS.asset, '/media');
    const sec = { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...OAC };
    const sendFile = (file, cache) => {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache, ...sec });
      fs.createReadStream(file).pipe(res);
    };
    if (url.pathname === '/editor/runtime-config.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...sec });
      return res.end(runtimeConfig);
    }
    const index = path.join(DIST, 'index.html');
    if (url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html') return sendFile(index, 'no-store');
    if (url.pathname.startsWith('/editor/assets/')) {
      const f = path.join(DIST, decodeURIComponent(url.pathname.slice('/editor/'.length)));
      if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404, sec); return res.end('not found'); }
      return sendFile(f, 'public, max-age=31536000, immutable');
    }
    if (url.pathname.startsWith('/editor/')) return sendFile(index, 'no-store');
    res.writeHead(404, { 'Content-Type': 'text/plain', ...OAC });
    res.end('not found');
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, origin);
    if (!(url.pathname === '/hosted' || url.pathname.startsWith('/hosted/'))) return socket.destroy();
    const target = (url.pathname.slice('/hosted'.length) || '/') + url.search;
    const up = net.connect(PORTS.doc, '127.0.0.1', () => {
      const lines = [`${req.method} ${target} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  servers.push(server);
  return new Promise((r) => server.listen(port, '127.0.0.1', r));
}
await Promise.all([makeProxy(PORTS.editor), makeProxy(PORTS.stageA), makeProxy(PORTS.stageB)]);

/* ------------------------------------------------------------------ 共享项目 */
const stamp = Date.now().toString(36);
const NAME = `osl-${stamp}`;
const creator = { username: 'boss', password: `boss-${randomBytes(6).toString('hex')}` };
const PROJECT_PW = `pw-${randomBytes(6).toString('hex')}`;
const made = await createSharedProject({ base: DOC_DIRECT, name: NAME, mode: 'free', creator, password: PROJECT_PW });
async function wsAsCreator(projectId = made.projectId) {
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId, username: creator.username, deviceId: 'osl-probe-node-01', deviceName: 'probe-node', as: 'creator', password: creator.password, role: 'page' });
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

/* ------------------------------------------------------------------ 浏览器 */
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--site-per-process'] });
async function newPage(label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  await page.setViewport({ width: 1600, height: 900 });
  page.label = label;
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.message ?? e).slice(0, 200)));
  return page;
}
async function typeInto(page, sel, text) {
  await page.waitForSelector(sel, { visible: true, timeout: 15_000 });
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  if (text) await page.type(sel, text, { delay: 5 });
}
async function join(page, username) {
  await page.goto(`${SITE}/editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
  await typeInto(page, '[data-pc="join-name"]', NAME);
  await typeInto(page, '[data-pc="join-username"]', username);
  await typeInto(page, '[data-pc="join-password"]', PROJECT_PW);
  await page.click('[data-pc="join-submit"]');
  await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 });
  await until(`${username} 的时间轴`, () => page.evaluate(() => !!window.__pcStore), 30_000);
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
const stageFrames = (page) => page.frames().filter((f) => /[?&]stage=1/.test(f.url()));
async function visibleStage(page) {
  for (const f of stageFrames(page)) {
    const el = await f.frameElement().catch(() => null);
    const vis = el ? await el.evaluate((e) => { const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5 && e.getBoundingClientRect().width > 10; }).catch(() => false) : false;
    if (vis) return f;
  }
  return stageFrames(page)[0] ?? null;
}
async function stageShot(page, name) {
  const f = await visibleStage(page);
  const el = f ? await f.frameElement().catch(() => null) : null;
  const box = el ? await el.boundingBox().catch(() => null) : null;
  if (!box || box.width < 10) return null;
  await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { ...box, scale: Math.min(4, 1600 / box.width) } }).catch(() => {});
  return `${name}.png`;
}
/** 可见舞台里某个片段:贴着的快照文字、占位槽位显没显示与原因、包裹层是否被抑制(贴快照中) */
async function clipOnStage(page, id) {
  const f = await visibleStage(page);
  if (!f) return null;
  return f.evaluate((cid) => {
    const w = document.querySelector(`[data-pc-clip="${cid}"]:not([data-pc-media])`);
    if (!w) return { wrapper: false };
    const snap = w.querySelector(':scope > [data-pc-snapshot-plane]');
    const slot = w.querySelector(':scope > [data-pc-placeholder-slot]');
    const plane = slot?.querySelector('[data-pc-placeholder-plane]');
    return { wrapper: true, snapText: snap && snap.childElementCount > 0 ? (snap.textContent ?? '').trim().slice(0, 40) : null,
      placeholder: !!slot && !slot.hidden, reason: slot && !slot.hidden ? (slot.getAttribute('data-pc-placeholder-reason') ?? plane?.getAttribute('data-pc-placeholder-reason') ?? null) : null,
      suppressed: w.classList.contains('pc-suppressed') };
  }, id).catch(() => null);
}
const badgeOf = (page, id) => page.evaluate((cid) => !!document.querySelector(`[data-clip-id="${cid}"] [data-pc="clip-custom-card"]`), id).catch(() => null);
/**
 * 在两个舞台里装 MutationObserver:某几个片段的状态(快照文字、占位与原因)一变就记一笔 `{ at: 真实时钟, … }`。
 * 记在舞台自己的 `window.__oslLog` 里;读的时候按可见舞台取。
 */
async function installStageLog(page, ids) {
  for (const f of stageFrames(page)) {
    await f.evaluate((ids2) => {
      if (window.__oslLog) return;
      window.__oslLog = [];
      // 舞台的 Date.now / performance.now 被接管成舞台时间:用真实时钟(timeOrigin + __pcRealNow)记,才能和父页的 Date.now 比
      const real = () => performance.timeOrigin + (window.__pcRealNow ? window.__pcRealNow() : performance.now());
      const last = {};
      const look = () => {
        for (const id of ids2) {
          const w = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
          const snap = w?.querySelector(':scope > [data-pc-snapshot-plane]');
          const slot = w?.querySelector(':scope > [data-pc-placeholder-slot]');
          const plane = slot?.querySelector('[data-pc-placeholder-plane]');
          const s = { snap: snap && snap.childElementCount > 0 ? (snap.textContent ?? '').trim().slice(0, 30) : null,
            reason: slot && !slot.hidden ? (slot.getAttribute('data-pc-placeholder-reason') ?? plane?.getAttribute('data-pc-placeholder-reason') ?? 'shown') : null };
          const key = `${s.snap}|${s.reason}`;
          if (last[id] === key) continue;
          last[id] = key;
          window.__oslLog.push({ at: Math.round(real()), origin: location.origin, id, ...s });
        }
      };
      new MutationObserver(look).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      look();
    }, ids).catch(() => {});
  }
}
/**
 * 两个舞台的记录合在一起,再配上父页记的「哪一个舞台可见」的时间线(舞台换班时可见的那一个会变):
 * 回 `{ at, id, snap, reason }` 的序列,只留当时可见的那个舞台的状态(换班那一刻补一笔新可见舞台的当前状态)。
 */
/**
 * 各文档(父页、两个舞台各在自己的进程里)的 `timeOrigin + 单调时钟` 彼此差几毫秒到几十毫秒,不能直接比:
 * 每个文档对探针进程的 Date.now 校一次钟(来回 7 次取往返最短的那次,误差 ≤ 往返的一半),记录一律换算成探针进程的时刻。
 */
async function clockOffset(ctx) {
  let best = null;
  for (let i = 0; i < 7; i++) {
    const t0 = Date.now();
    const v = await ctx.evaluate(() => performance.timeOrigin + (window.__pcRealNow ? window.__pcRealNow() : performance.now())).catch(() => null);
    const t1 = Date.now();
    if (typeof v !== 'number') continue;
    if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: v - (t0 + t1) / 2 };
  }
  return best ?? { rtt: null, offset: 0 };
}
const offsets = new Map();
async function calibrate(page) {
  offsets.set(page, await clockOffset(page));
  for (const f of stageFrames(page)) offsets.set(`${page.label}|${new URL(f.url()).origin}`, await clockOffset(f));
}
/** 父页里记的时刻 → 探针进程的时刻 */
const fromPage = (page, t) => (typeof t === 'number' ? Math.round(t - (offsets.get(page)?.offset ?? 0)) : t);
async function stageLog(page, id) {
  const all = [];
  for (const f of stageFrames(page)) all.push(...(await f.evaluate(() => window.__oslLog ?? []).catch(() => [])));
  for (const e of all) e.at = Math.round(e.at - (offsets.get(`${page.label}|${e.origin}`)?.offset ?? 0));
  const vis = (await page.evaluate(() => window.__oslVis ?? []).catch(() => [])).map((v) => ({ ...v, at: fromPage(page, v.at) }));
  // 早于第一笔可见记录的(两边时钟差几毫秒)算第一笔那个舞台的
  const visAt = (t) => { let o = vis[0]?.origin ?? null; for (const v of vis) { if (v.at <= t) o = v.origin; else break; } return o; };
  const events = [...all.filter((e) => e.id === id).map((e) => ({ ...e, kind: 'stage' })), ...vis.map((v) => ({ at: v.at, kind: 'vis', origin: v.origin }))].sort((a, b) => a.at - b.at);
  const lastBy = {};
  const outL = [];
  for (const e of events) {
    if (e.kind === 'stage') { lastBy[e.origin] = e; if (visAt(e.at) === e.origin) outL.push({ at: e.at, snap: e.snap, reason: e.reason, origin: e.origin }); }
    else if (lastBy[e.origin]) outL.push({ at: e.at, snap: lastBy[e.origin].snap, reason: lastBy[e.origin].reason, origin: e.origin, swap: true });
  }
  return outL;
}
/** 父页记「哪一个舞台 iframe 可见」:属性一变就看一次 */
async function installVisLog(page) {
  await page.evaluate(() => {
    if (window.__oslVis) return;
    window.__oslVis = [];
    let last = null;
    const look = () => {
      const f = [...document.querySelectorAll('iframe')].filter((e) => /[?&]stage=1/.test(e.src)).find((e) => { const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5 && e.getBoundingClientRect().width > 10; });
      const origin = f ? new URL(f.src).origin : null;
      if (origin === last) return;
      last = origin;
      window.__oslVis.push({ at: Math.round(performance.timeOrigin + performance.now()), origin });
    };
    new MutationObserver(look).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    setInterval(look, 20);
    look();
  });
}
/** 页面里每 10 ms 看一次 store:某片段的某个参数第一次等于期望值的时刻(乙「收到这次修改」的时刻) */
function watchParam(page, id, key, value) {
  return page.evaluate((cid, k, v) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const c = window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((x) => x.id === cid);
      if (c?.params?.[k] === v) return resolve(Math.round(performance.timeOrigin + performance.now()));
      if (Date.now() - t0 > 30_000) return resolve(null);
      setTimeout(tick, 10);
    };
    tick();
  }), id, key, value);
}
/** 这台页面自己的在线来源诊断 */
const onlineDiag = (page) => page.evaluate(() => window.__pcOnlineSnapshots?.() ?? null).catch(() => null);

/* ------------------------------------------------------------------ 预渲染结果(替渲染节点写) */
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2b1d6d40000000049454e44ae426082', 'hex');
const FP = 'osl0probe0fp0000';
function makeLayer(clipId, tag, color, count) {
  const html = Buffer.from(`<div data-probe-snap="${clipId}" style="position:absolute;inset:0;background:${color};color:#fff;font:bold 120px sans-serif;display:flex;align-items:center;justify-content:center">SNAP ${tag}</div>`, 'utf8');
  const png = Buffer.concat([PNG_1PX, Buffer.from(`${clipId}:${tag}`)]);
  const L = { clipId, tag, rk: randomBytes(32).toString('hex'), ck: randomBytes(32).toString('hex'), full: sha(html), small: sha(png), count };
  fakeAssets.set(`snap/${L.full}`, { type: 'text/html', bytes: html });
  fakeAssets.set(`px/${L.small}`, { type: 'image/png', bytes: png });
  return L;
}
async function writeManifests(node, L, span) {
  for (let from = 0; from < L.count; from += span) {
    const to = Math.min(L.count - 1, from + span - 1);
    const frames = [], small = [];
    for (let f = from; f <= to; f++) { frames.push([f, L.full, 300]); small.push([f, L.small, 80]); }
    const r = await node.ask({ type: 'content.put', kind: 'snapshot-manifest', key: `${L.rk}:${from}-${to}`,
      body: { v: 1, kind: 'snapshot', tier: 'shared', resultKey: L.rk, dirKey: L.rk, entryKey: null, range: { from, to }, canvasHeavy: false, frames, small } });
    check(r.type === 'content.stored', `写段清单 ${L.clipId} ${L.tag}`, r);
  }
}
/** 按某个页面手里的项目、用服务端的 layerMapOf 写层表(每层带 inputSig,与真节点同一条代码) */
async function writeLayerMap(node, page, layers, span) {
  const project = renderProject(await page.evaluate(() => JSON.parse(JSON.stringify(window.__pcStore.getState().project))));
  const entry = { key: `osl-entry-${randomBytes(4).toString('hex')}`, project,
    cardPlan: layers.map((L) => ({ clipId: L.clipId, snapshotKey: L.rk, contentKey: L.ck, envFingerprint: FP, tier: 'shared', sampling: { firstFrame: 0 }, count: L.count })) };
  const body = layerMapOf(entry, { fingerprint: FP, span });
  const r = await node.ask({ type: 'content.put', kind: 'snapshot-manifest', key: `layers:${project.id}`, body });
  check(r.type === 'content.stored', '写层表', r);
  return body;
}

try {
  const node = await wsAsCreator();
  const put = await node.ask({ type: 'content.put', kind: 'card-source', key: SYNCED_KEY, body: SYNCED_SOURCE });
  check(put.type === 'content.stored', '创建者写卡片源码(card-source)', put);

  /* ============================================================ 甲摆片段,乙加入 */
  const A = await newPage('甲');
  await join(A, '甲');
  const setup = await store(A, `
    S.actions.editCardProject((p) => ({ ...p, duration: Math.max(p.duration, 4), tracks: [
      { id: 'osl-t-u', name: '序列 u', clips: [{ id: 'osl-u', cardId: args[0], start: 0, end: 4, params: { text: 'one' }, frame: { x: 0, y: 0, w: 960, h: 540 } }] },
      { id: 'osl-t-b', name: '序列 b', clips: [{ id: 'osl-b', cardId: 'probe-slow-stepped', start: 0, end: 4, params: { burnMs: 40, label: 'b1' }, frame: { x: 960, y: 540, w: 960, h: 540 } }] },
      ...p.tracks] }));
    S.actions.seek(1);
    const p = S.getState().project;
    return { projectId: p.id, fps: p.fps || 30 };`, SYNCED_ID);
  out.setup = setup;
  const U = 'osl-u', B_ = 'osl-b';
  const count = 4 * setup.fps;
  const span = count / 2;
  const B = await newPage('乙');
  await join(B, '乙');
  await until('乙收到甲摆的片段', () => store(B, `return S.getState().project.tracks.some((t) => t.clips.some((c) => c.id === 'osl-b'));`), 30_000);
  await store(B, `S.actions.seek(1); return true;`);

  /* ============================================================ 1. 第一版层表 */
  const L1 = { u: makeLayer(U, 'u v1', '#15803d', count), b: makeLayer(B_, 'b v1', '#1d4ed8', count) };
  for (const L of Object.values(L1)) await writeManifests(node, L, span);
  const map1 = await writeLayerMap(node, B, [L1.u, L1.b], span);
  out.map1 = map1.layers.map((l) => ({ clipId: l.clipId, inputSig: l.inputSig ?? null }));
  check(map1.layers.every((l) => typeof l.inputSig === 'string' && /^i1-/.test(l.inputSig)), '第一版层表每层带 inputSig', out.map1);
  const s1 = {};
  for (const [label, pg] of [['A', A], ['B', B]]) {
    s1[label] = await until(`${label}:u 贴 SNAP u v1`, async () => {
      const x = await clipOnStage(pg, U);
      return x?.snapText?.includes('u v1') && !x.placeholder ? x : null;
    }, 45_000);
  }
  check(s1.A && s1.B, '第一版:甲、乙两页 u 贴出旧层 SNAP u v1', s1);
  // 播放中 b 贴快照(判重的内置卡)
  async function playbackSnapOf(pg, id, want, ms = 30_000) {
    const t0 = Date.now();
    const seen = new Set();
    let hit = null;
    await store(pg, `S.actions.seek(0.5); S.actions.play(); return true;`);
    while (!hit && Date.now() - t0 < ms) {
      const x = await clipOnStage(pg, id);
      seen.add(x ? (x.snapText ? x.snapText : x.placeholder ? `ph:${x.reason}` : 'live') : 'none');
      if (x?.snapText?.includes(want)) hit = x;
      const t = await store(pg, `return S.getState().t ?? null;`).catch(() => null);
      if (typeof t === 'number' && t > 3.3) await store(pg, `S.actions.seek(0.5); S.actions.play(); return true;`);
      await sleep(60);
    }
    await store(pg, `S.actions.pause(); S.actions.seek(1); return true;`);
    return { hit, seen: [...seen] };
  }
  out.b1 = { A: await playbackSnapOf(A, B_, 'b v1'), B: await playbackSnapOf(B, B_, 'b v1') };
  check(out.b1.A.hit && out.b1.B.hit, '第一版:播放中内置重卡 b 贴 SNAP b v1(甲、乙)', out.b1);

  /* ============================================================ 2. 甲改 u 的参数:两页一拍之内撤旧层、显示沙漏 */
  // 播放检查之后停在 1 秒:先等两页可见舞台又贴着 u 的旧层,再装记录器、再改
  for (const [label, pg] of [['A', A], ['B', B]]) {
    await until(`${label}:改之前 u 贴着 SNAP u v1`, async () => {
      const x = await clipOnStage(pg, U);
      return x?.snapText?.includes('u v1') && !x.placeholder ? x : null;
    }, 20_000);
  }
  await stageShot(A, 'stale-1-A-v1');
  // 先记父页「哪一个舞台可见」,再装舞台里的记录器(两边都用 timeOrigin + 单调时钟,可以相比)
  await installVisLog(A);
  await installVisLog(B);
  await installStageLog(A, [U, B_]);
  await installStageLog(B, [U, B_]);
  await calibrate(A);
  await calibrate(B);
  out.clocks = Object.fromEntries([...offsets].map(([k, v]) => [typeof k === 'string' ? k : k.label, { rtt: v.rtt, offset: Math.round(v.offset) }]));
  say('clocks', out.clocks);
  /*
   * 不改任何东西静置 6 秒,只记不判:暂停着的 u 偶尔在旧层与沙漏之间闪一下(舞台换班、父页 5 秒一次的对账重投)。
   * 拿掉本分支的 setInputs 重新构建跑同一段,照样闪 —— 是原有的行为,不是本改动引入的(报告里单列)。
   */
  {
    const tIdle = Date.now();
    await sleep(6_000);
    const idle = { A: (await stageLog(A, U)).filter((e) => e.at >= tIdle), B: (await stageLog(B, U)).filter((e) => e.at >= tIdle) };
    out.idle = { flipsA: idle.A.filter((e) => !e.snap?.includes('u v1')).length, flipsB: idle.B.filter((e) => !e.snap?.includes('u v1')).length };
    say('idle', { ...out.idle, A: idle.A, B: idle.B });
    for (const [label, pg] of [['A', A], ['B', B]]) {
      await until(`${label}:静置之后 u 仍贴着 SNAP u v1`, async () => {
        const x = await clipOnStage(pg, U);
        return x?.snapText?.includes('u v1') && !x.placeholder ? x : null;
      }, 20_000);
    }
  }
  const bGot = watchParam(B, U, 'text', 'two');
  const tEdit = fromPage(A, await store(A, `const t = Math.round(performance.timeOrigin + performance.now()); S.actions.setClipParams('osl-u', { text: 'two' }); return t;`));
  const tB = fromPage(B, await bGot);
  check(typeof tB === 'number', '乙收到甲改的参数', tB);
  await sleep(1500);
  const firstAfter = (log, t0, pred) => log.find((e) => e.at >= t0 && pred(e)) ?? null;
  const logA = await stageLog(A, U), logB = await stageLog(B, U);
  // 改之前那一刻可见舞台的状态(确认那时贴着旧层)
  const beforeOf = (log, t0) => [...log].reverse().find((e) => e.at < t0) ?? null;
  const goneA = firstAfter(logA, tEdit, (e) => !e.snap?.includes('u v1'));
  // 乙从甲改的那一刻量起(乙的 store 每 10 ms 看一次,「收到」的时刻比实际晚最多 10 ms;舞台可能比它还早变)
  const goneB = firstAfter(logB, tEdit, (e) => !e.snap?.includes('u v1'));
  const glassA = firstAfter(logA, tEdit, (e) => e.reason === 'awaiting');
  const glassB = firstAfter(logB, tEdit, (e) => e.reason === 'awaiting');
  const beforeA = beforeOf(logA, tEdit), beforeB = beforeOf(logB, tEdit);
  const s2 = {
    editToStaleA: goneA ? goneA.at - tEdit : null, editToStaleB: goneB ? goneB.at - tEdit : null, editToSyncB: tB ? tB - tEdit : null,
    syncToStaleB: goneB && tB ? Math.max(0, goneB.at - tB) : null,
    editToGlassA: glassA ? glassA.at - tEdit : null, editToGlassB: glassB ? glassB.at - tEdit : null,
    nowA: await clipOnStage(A, U), nowB: await clipOnStage(B, U),
    diagA: (await onlineDiag(A))?.stale ?? null, diagB: (await onlineDiag(B))?.stale ?? null,
    beforeA, beforeB, logA: logA.slice(-6), logB: logB.slice(-6),
  };
  check(beforeA?.snap?.includes('u v1') && beforeB?.snap?.includes('u v1'), '改之前那一刻两页可见舞台都贴着旧层(时延从这里量起)', { beforeA, beforeB });
  out.edit1 = s2;
  say("edit1", s2);
  check(s2.editToStaleA !== null && s2.editToStaleA <= BEAT_BUDGET_MS, `甲:改参数后 ${BEAT_BUDGET_MS} ms 内不再贴旧层`, s2);
  check(s2.syncToStaleB !== null && s2.syncToStaleB <= BEAT_BUDGET_MS, `乙:收到修改后 ${BEAT_BUDGET_MS} ms 内不再贴旧层`, s2);
  check(s2.nowA?.placeholder && s2.nowA.reason === 'awaiting' && !s2.nowA.snapText, '甲:u 显示沙漏(awaiting,不是图标)', s2.nowA);
  check(s2.nowB?.placeholder && s2.nowB.reason === 'awaiting' && !s2.nowB.snapText, '乙:u 显示沙漏(awaiting,不是图标)', s2.nowB);
  check(s2.diagA?.some((x) => x.clipId === U && x.awaiting) && s2.diagB?.some((x) => x.clipId === U && x.awaiting), '两页在线来源都认出 u 的层过期(在路上)', { a: s2.diagA, b: s2.diagB });
  check((await badgeOf(A, U)) === false && (await badgeOf(B, U)) === false, '在路上:时间轴不出徽标');
  await stageShot(A, 'stale-2-A-hourglass');
  await stageShot(B, 'stale-2-B-hourglass');

  /* ============================================================ 3. 改回原来的参数:原来那一层照贴 */
  const bBack = watchParam(B, U, 'text', 'one');
  await store(A, `S.actions.setClipParams('osl-u', { text: 'one' }); return true;`);
  await bBack;
  const s3 = {};
  for (const [label, pg] of [['A', A], ['B', B]]) {
    s3[label] = await until(`${label}:改回原参数后 u 又贴 SNAP u v1`, async () => {
      const x = await clipOnStage(pg, U);
      return x?.snapText?.includes('u v1') && !x.placeholder ? x : null;
    }, 10_000);
  }
  out.revert = s3;
  check(s3.A && s3.B, '改回原来的参数:原来那一层还在,两页照贴', s3);

  /* ============================================================ 4a. 两页都在播放、都贴着 b 的旧层时,甲改 b:量两页多久不再贴 */
  const s4 = {};
  {
    const playing = async () => {
      for (const pg of [A, B]) {
        const t = await store(pg, `return S.getState().playing ? S.getState().t : null;`).catch(() => null);
        if (t === null || t > 3.2) await store(pg, `S.actions.seek(0.3); S.actions.play(); return true;`);
      }
    };
    const both = await until('两页都在播放、都贴着 SNAP b v1', async () => {
      await playing();
      const [xa, xb] = [await clipOnStage(A, B_), await clipOnStage(B, B_)];
      return xa?.snapText?.includes('b v1') && xb?.snapText?.includes('b v1') ? { xa, xb } : null;
    }, 30_000, 40);
    const bGotB = watchParam(B, B_, 'label', 'b2');
    const tEditB = fromPage(A, await store(A, `const t = Math.round(performance.timeOrigin + performance.now()); S.actions.setClipParams('osl-b', { label: 'b2' }); return t;`));
    const tSyncB = fromPage(B, await bGotB);
    await sleep(1200);
    const [la, lb] = [await stageLog(A, B_), await stageLog(B, B_)];
    await store(A, `S.actions.pause(); S.actions.seek(1); return true;`);
    await store(B, `S.actions.pause(); S.actions.seek(1); return true;`);
    /*
     * 播放中重卡每拍换一次快照,两拍之间可能夹一拍占位(原有行为,拿掉本改动也一样):所以不看「改之前那一刻」,
     * 看改之前 500 ms 里贴过旧层(证明在贴),以及改之后最后一次贴旧层离改的那一刻多久(= 多久不再贴)。
     */
    const recentV1 = (log) => log.some((e) => e.at >= tEditB - 500 && e.at < tEditB && e.snap?.includes('b v1'));
    const lastV1 = (log) => [...log].reverse().find((e) => e.at >= tEditB && e.snap?.includes('b v1')) ?? null;
    const endOf = (log, e) => (e ? (log.find((x) => x.at > e.at)?.at ?? Infinity) : tEditB);
    s4.bPlay = { both: !!both, editToSyncB: tSyncB ? tSyncB - tEditB : null, recentA: recentV1(la), recentB: recentV1(lb),
      lastV1A: lastV1(la), lastV1B: lastV1(lb) };
    // 旧层最后一次在屏上一直留到下一笔记录;不再贴的时刻 = 那一刻
    s4.bPlay.editToStaleA = endOf(la, s4.bPlay.lastV1A) - tEditB;
    s4.bPlay.editToStaleB = endOf(lb, s4.bPlay.lastV1B) - tEditB;
    s4.bPlay.tailA = la.slice(-5);
    s4.bPlay.tailB = lb.slice(-5);
    say('bPlay', s4.bPlay);
    check(both && s4.bPlay.recentA && s4.bPlay.recentB, '改 b 之前 500 ms 里两页播放中都贴过 SNAP b v1', s4.bPlay);
    check(s4.bPlay.editToStaleA <= BEAT_BUDGET_MS, `甲:播放中改内置重卡的参数,${BEAT_BUDGET_MS} ms 内不再贴旧层`, s4.bPlay);
    check(s4.bPlay.editToStaleB - (s4.bPlay.editToSyncB ?? 0) <= BEAT_BUDGET_MS, `乙:收到修改后 ${BEAT_BUDGET_MS} ms 内不再贴 b 的旧层`, s4.bPlay);
  }

  /* ============================================================ 4b. 再改 u:沙漏 → 等满转图标;b 播放中不贴旧层 */
  const bGot2 = watchParam(B, U, 'text', 'three');
  const tEdit2 = await store(A, `const t = Date.now(); S.actions.setClipParams('osl-u', { text: 'three' }); return t;`);
  await bGot2;
  for (const [label, pg] of [['A', A], ['B', B]]) {
    s4[`glass${label}`] = await until(`${label}:再改之后 u 沙漏`, async () => {
      const x = await clipOnStage(pg, U);
      return x?.placeholder && x.reason === 'awaiting' && !x.snapText ? x : null;
    }, 5_000);
  }
  check(s4.glassA && s4.glassB, '再改参数:两页 u 沙漏', s4);
  // b 在播放中:不再贴 SNAP b v1(占位或活渲)
  async function playbackNoOld(pg, id, old, ms = 4_000) {
    const seen = new Set();
    let bad = null;
    const t0 = Date.now();
    await store(pg, `S.actions.seek(0.5); S.actions.play(); return true;`);
    while (Date.now() - t0 < ms) {
      const x = await clipOnStage(pg, id);
      const tag = x ? (x.snapText ? `snap:${x.snapText}` : x.placeholder ? `ph:${x.reason}` : 'live') : 'none';
      seen.add(tag);
      if (x?.snapText?.includes(old)) bad = x;
      await sleep(60);
    }
    await store(pg, `S.actions.pause(); S.actions.seek(1); return true;`);
    return { bad, seen: [...seen] };
  }
  s4.bA = await playbackNoOld(A, B_, 'b v1');
  s4.bB = await playbackNoOld(B, B_, 'b v1');
  check(!s4.bA.bad && !s4.bB.bad, '内置重卡改了参数:播放中两页都不再贴 SNAP b v1(占位或活渲)', { a: s4.bA, b: s4.bB });
  s4.diagA = (await onlineDiag(A))?.stale ?? null;
  check(s4.diagA?.some((x) => x.clipId === B_), '甲在线来源认出 b 的层过期', s4.diagA);
  // 等满 STALE_AWAIT_MS:u 转成图标,时间轴出徽标
  const wait = Math.max(0, tEdit2 + STALE_AWAIT_MS + 3_000 - Date.now());
  await sleep(wait);
  for (const [label, pg] of [['A', A], ['B', B]]) {
    s4[`icon${label}`] = await until(`${label}:等满之后 u 是图标、有徽标`, async () => {
      const x = await clipOnStage(pg, U);
      const badge = await badgeOf(pg, U);
      return x?.placeholder && x.reason === 'unsupported' && badge ? { stage: x, badge } : null;
    }, 10_000);
  }
  out.edit2 = s4;
  check(s4.iconA && s4.iconB, `等满 ${STALE_AWAIT_MS} ms 还没新层:两页 u 转成「需要本地 PC 渲染辅助」图标、时间轴出徽标`, { a: s4.iconA, b: s4.iconB });
  await stageShot(A, 'stale-3-A-icon');

  /* ============================================================ 5. 渲染节点写第二版:新结果换上 */
  const L2 = { u: makeLayer(U, 'u v2', '#b45309', count), b: makeLayer(B_, 'b v2', '#7e22ce', count) };
  for (const L of Object.values(L2)) await writeManifests(node, L, span);
  const tWrite = Date.now();
  const map2 = await writeLayerMap(node, B, [L2.u, L2.b], span);
  out.map2 = map2.layers.map((l) => ({ clipId: l.clipId, inputSig: l.inputSig ?? null }));
  check(map2.layers.every((l, i) => l.inputSig && l.inputSig !== map1.layers[i].inputSig), '第二版层表的 inputSig 与第一版不同', { map1: out.map1, map2: out.map2 });
  const s5 = {};
  for (const [label, pg] of [['A', A], ['B', B]]) {
    s5[label] = await until(`${label}:新结果换上(u 贴 SNAP u v2,图标、徽标撤掉)`, async () => {
      const x = await clipOnStage(pg, U);
      const badge = await badgeOf(pg, U);
      return x?.snapText?.includes('u v2') && !x.placeholder && badge === false ? { stage: x, ms: Date.now() - tWrite } : null;
    }, 30_000);
  }
  check(s5.A && s5.B, '渲染节点渲完:两页 u 自动换上新结果,图标与徽标撤掉', s5);
  await stageShot(A, 'stale-4-A-v2');
  await stageShot(B, 'stale-4-B-v2');
  s5.bA = await playbackSnapOf(A, B_, 'b v2');
  s5.bB = await playbackSnapOf(B, B_, 'b v2');
  s5.planA = await A.evaluate(() => window.__pcPlanPublisher?.()?.lastClips ?? null).catch(() => null);
  check(s5.bA.hit && s5.bB.hit, '播放中内置重卡 b 贴新结果 SNAP b v2(甲、乙)', { a: s5.bA, b: s5.bB, planA: s5.planA });
  check(!s5.bA.seen.some((x) => x.includes('b v1')) && !s5.bB.seen.some((x) => x.includes('b v1')), '之后再没贴过 SNAP b v1', { a: s5.bA.seen, b: s5.bB.seen });
  s5.diag = { A: (await onlineDiag(A))?.stale ?? null, B: (await onlineDiag(B))?.stale ?? null };
  // 两页手里的项目按同一算法算出的签名,与第二版层表里记的对照(排查用)
  const projOf = (pg) => pg.evaluate(() => JSON.parse(JSON.stringify(window.__pcStore.getState().project)));
  const [pa, pb] = [await projOf(A), await projOf(B)];
  s5.sigs = { map: out.map2, A: { u: clipInputSig(pa, U), b: clipInputSig(pa, B_) }, B: { u: clipInputSig(pb, U), b: clipInputSig(pb, B_) },
    clipA: pa.tracks.flatMap((t) => t.clips).find((c) => c.id === B_), clipB: pb.tracks.flatMap((t) => t.clips).find((c) => c.id === B_),
    layersA: ((await onlineDiag(A))?.layers ?? []).map((l) => ({ clipId: l.clipId, ready: l.ready, inputSig: l.inputSig })),
    layersB: ((await onlineDiag(B))?.layers ?? []).map((l) => ({ clipId: l.clipId, ready: l.ready, inputSig: l.inputSig })) };
  say('sigs', s5.sigs);
  check((s5.diag.A ?? []).length === 0 && (s5.diag.B ?? []).length === 0, '新层表对得上:两页没有过期的层', s5.diag);
  out.fresh = s5;
  await shot(A, 'stale-4-A-page');
  out.errors = { A: A.errors.slice(0, 5), B: B.errors.slice(0, 5) };
  check(A.errors.length === 0 && B.errors.length === 0, '两页没有页面错误', out.errors);
  node.close();
} catch (e) {
  fails.push(`探针异常:${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  await browser.close().catch(() => {});
  for (const s of servers) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r())); }
  await combo.close?.().catch?.(() => {});
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 留着也无妨 */ }
}
out.ok = fails.length === 0;
out.fails = fails;
say('result', { ok: out.ok, fails: fails.length });
console.log(JSON.stringify({ ok: out.ok, fails,
  edit1: out.edit1 ? { editToStaleA: out.edit1.editToStaleA, editToStaleB: out.edit1.editToStaleB, editToSyncB: out.edit1.editToSyncB, syncToStaleB: out.edit1.syncToStaleB, editToGlassA: out.edit1.editToGlassA, editToGlassB: out.edit1.editToGlassB } : null,
  revert: !!(out.revert?.A && out.revert?.B),
  edit2: out.edit2 ? { bA: out.edit2.bA?.seen, bB: out.edit2.bB?.seen, iconA: !!out.edit2.iconA, iconB: !!out.edit2.iconB } : null,
  fresh: out.fresh ? { uA: out.fresh.A?.ms ?? null, uB: out.fresh.B?.ms ?? null, bA: out.fresh.bA?.seen, bB: out.fresh.bB?.seen } : null,
  maps: { v1: out.map1 ?? null, v2: out.map2 ?? null } }));
process.exit(out.ok ? 0 : 1);
