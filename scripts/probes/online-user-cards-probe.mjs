/**
 * 在线浏览器模式的用户卡(C10 契约第 9 节,2026-09-29 用户改语义;验收 C10-A6 新写法)。
 * 全程在本机:本机托管组合代替阿里云,仿 nginx 的前缀代理开三个源(编辑器页 + 两个舞台,都带 OAC),在线构建当页面。
 *
 *   npx vite build --mode online --outDir <目录>
 *   node scripts/probes/online-user-cards-probe.mjs --dist <在线构建目录> [--out <截图目录>] [--base-port 5744]
 *
 * 端口:+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务(缺省 5744～5748)。
 * 预渲染结果由探针替渲染节点写:内容库的层表(v 2)与段清单(每帧都有原尺寸与小尺寸),字节由代理在 `/media/api/asset/snap|px/<hash>`
 * 上直接给(探针自己的「nginx」,不经素材服务的写票据);代理记下每个请求。
 *
 * 摆法(一个共享项目,五条轨道同一时段,各占画面的一格):
 *   b   内置卡 `punch-pill`(有层)
 *   u   仓库用户卡 `mu-animated-shiny-text`(有层)
 *   s1  内容库同步来的用户卡 `probe-synced-card`(有层)
 *   s2  同一张同步卡(先没有层,后补)
 *   s3  同一张同步卡(一直没有层;低内存档核补渲用)
 *   x   未知 id `probe-unknown-card`
 * 同步卡的源码由创建者 `content.put` 进内容库(`card-source`,键 `src/cards/user/probe-synced-card.tsx`)。
 *
 * 断言:
 *   普通档(电脑浏览器,两个跨源舞台):
 *     - 时间轴标签:s1 →「探针同步卡」,x →「未知卡片」;
 *     - 有层的 u、s1:清单与 `snap/` 请求 > 0,舞台贴出快照,没有图标;时间轴没有徽标;
 *     - 没有层的 s2:舞台是「需要本地 PC 渲染辅助」(不是沙漏),时间轴有徽标、悬停文案对;给它写层与清单后几秒内图标换成快照、徽标撤掉;
 *     - x:舞台不画、不挂徽标;
 *     - 页面发布的清单计划(`__pcPlanPublisher().lastClips`)含 u、s1、s2、s3。
 *   低内存档(仿手机):`__pcBackfill()` 在等的片段含 s3;舞台上 u、s1 贴小尺寸(`px/` 请求 > 0),s3 是图标。
 * 不打印口令;结果最后一行是一行 JSON(`ok`、`fails`、各项数字),截图在 --out。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { createSharedProject, buildAuthProtocols } from '../../server/auth/client.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'online-user-cards-shots')));
const BASE = Number(arg('--base-port', 5744));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4 };
const SITE = `http://127.0.0.1:${PORTS.editor}`;
const STAGE_ORIGINS = [`http://127.0.0.1:${PORTS.stageA}`, `http://127.0.0.1:${PORTS.stageB}`];
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, normal: {}, lowmem: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return !!cond; };
const say = (k, v) => console.log(JSON.stringify({ [k]: v }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 20_000, every = 250) {
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
const UNSUPPORTED = '需要本地 PC 渲染辅助';
const SYNCED_ID = 'probe-synced-card';
const SYNCED_NAME = '探针同步卡';
const SYNCED_KEY = `src/cards/user/${SYNCED_ID}.tsx`;
const SYNCED_SOURCE = `/** 探针:内容库同步来的用户卡(本机构建里没有) */
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function ProbeSynced({ params }: CardProps<Params>) {
  return <div className="absolute inset-0 flex items-center justify-center">It's {params.text}</div>;
}
export const probeSyncedCard: CardDef<Params> = {
  id: "${SYNCED_ID}",
  name: "${SYNCED_NAME}",
  description: "探针用",
  frameMode: "stateful",
  defaults: { text: "synced" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: ProbeSynced,
};
`;

/* ------------------------------------------------------------------ 服务 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-user-cards-hosted-'));
const combo = await startHostedCombo({
  dataDir, docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
  docPublicUrl: `ws://127.0.0.1:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
});

/** 代理直接给的预渲染字节:`<ns>/<hash>` → { type, bytes } */
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
const NAME = `ouc-${stamp}`;
const creator = { username: 'boss', password: `boss-${randomBytes(6).toString('hex')}` };
const PROJECT_PW = `pw-${randomBytes(6).toString('hex')}`;
const made = await createSharedProject({ base: DOC_DIRECT, name: NAME, mode: 'free', creator, password: PROJECT_PW });

/** 凭证连接直接向托管端发请求(探针替渲染节点写层表与段清单、替桌面版写卡片源码) */
async function wsAsCreator() {
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId: made.projectId, username: creator.username, deviceId: 'ouc-probe-node-01', deviceName: 'probe-node', as: 'creator', password: creator.password, role: 'page' });
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
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: ['--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--site-per-process'] });
async function newPage(label, { mobile = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  if (mobile) {
    await page.emulate({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      viewport: { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false },
    });
    await page.evaluateOnNewDocument(() => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 4 }); });
  } else {
    await page.setViewport({ width: 1600, height: 900 });
  }
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
/** 可见舞台那一块放大截一张(整页截图里舞台只有两成大,图标看不清) */
async function stageShot(page, name) {
  const f = await visibleStage(page);
  const el = f ? await f.frameElement().catch(() => null) : null;
  const box = el ? await el.boundingBox().catch(() => null) : null;
  if (!box || box.width < 10) return null;
  await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { ...box, scale: Math.min(4, 1600 / box.width) } }).catch(() => {});
  return `${name}.png`;
}
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
/** 可见舞台那一帧(`?stage=1`,两个舞台里此刻可见的那一个;低内存档只有一个) */
async function visibleStage(page) {
  const frames = page.frames().filter((f) => /[?&]stage=1/.test(f.url()));
  for (const f of frames) {
    const el = await f.frameElement().catch(() => null);
    const vis = el ? await el.evaluate((e) => { const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5 && e.getBoundingClientRect().width > 10; }).catch(() => false) : false;
    if (vis) return f;
  }
  return frames[0] ?? null;
}
/** 舞台里每个片段的状态:有没有包裹层、组件、快照平面(原尺寸 / 小尺寸)、占位槽位显没显示、原因与种类 */
async function stageState(page, ids) {
  const f = await visibleStage(page);
  if (!f) return null;
  return f.evaluate((ids2) => {
    const outS = {};
    for (const id of ids2) {
      const w = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
      if (!w) { outS[id] = { wrapper: false }; continue; }
      const snap = w.querySelector(':scope > [data-pc-snapshot-plane]');
      const slot = w.querySelector(':scope > [data-pc-placeholder-slot]');
      const plane = slot?.querySelector('[data-pc-placeholder-plane]');
      outS[id] = {
        wrapper: true,
        snapshot: !!snap && snap.childElementCount > 0,
        snapText: snap?.textContent?.trim().slice(0, 40) ?? null,
        small: !!snap?.querySelector('img[data-pc-small-snapshot]'),
        placeholderShown: !!slot && !slot.hidden,
        reason: slot?.getAttribute('data-pc-placeholder-reason') ?? plane?.getAttribute('data-pc-placeholder-reason') ?? null,
        kind: plane?.getAttribute('data-pc-placeholder-kind') ?? null,
        text: slot && !slot.hidden ? (plane?.textContent ?? '').trim().slice(0, 40) : null,
        fixed: !!w.querySelector('[data-pc-placeholder-fixed]'),
        classes: w.className,
      };
    }
    return outS;
  }, ids);
}
async function timelineState(page, ids) {
  return page.evaluate((ids2) => Object.fromEntries(ids2.map((id) => {
    const el = document.querySelector(`[data-clip-id="${id}"]`);
    const badge = el?.querySelector('[data-pc="clip-custom-card"]');
    return [id, el ? { label: (el.querySelector('span.truncate')?.textContent ?? '').trim(), badge: !!badge, title: badge?.getAttribute('title') ?? null } : null];
  })), ids);
}

/* ------------------------------------------------------------------ 预渲染结果(替渲染节点写) */
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
/** 1×1 的 PNG(小尺寸;类型照写 image/png) */
const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2b1d6d40000000049454e44ae426082', 'hex');
function makeLayer(clipId, color, fps, count) {
  const html = Buffer.from(`<div data-probe-snap="${clipId}" style="position:absolute;inset:0;background:${color};color:#fff;font:bold 160px sans-serif;display:flex;align-items:center;justify-content:center">SNAP ${clipId}</div>`, 'utf8');
  const png = Buffer.concat([PNG_1PX, Buffer.from(clipId)]); // 每层一张不同的「小尺寸」(尾巴不同,哈希不同;浏览器照样解得出 PNG)
  const L = { clipId, rk: randomBytes(32).toString('hex'), ck: randomBytes(32).toString('hex'), full: sha(html), small: sha(png), count, fps };
  fakeAssets.set(`snap/${L.full}`, { type: 'text/html', bytes: html });
  fakeAssets.set(`px/${L.small}`, { type: 'image/png', bytes: png });
  return L;
}
async function writeManifests(node, L) {
  const half = L.count / 2;
  for (const [from, to] of [[0, half - 1], [half, L.count - 1]]) {
    const frames = [], small = [];
    for (let f = from; f <= to; f++) { frames.push([f, L.full, 300]); small.push([f, L.small, 80]); }
    const r = await node.ask({ type: 'content.put', kind: 'snapshot-manifest', key: `${L.rk}:${from}-${to}`,
      body: { v: 1, kind: 'snapshot', tier: 'shared', resultKey: L.rk, dirKey: L.rk, entryKey: null, range: { from, to }, canvasHeavy: false, frames, small } });
    check(r.type === 'content.stored', `写段清单 ${L.clipId}`, r);
  }
}
async function writeLayerMap(node, projectId, fps, layers) {
  const map = { v: 2, kind: 'layer-map', projectId, fps, width: 1920, height: 1080, span: layers[0].count / 2, at: Date.now(),
    layers: layers.map((L) => ({ clipId: L.clipId, kind: 'html', key: L.rk, tier: 'shared', resultKey: L.rk, dirKey: L.rk, entryKey: null, firstFrame: 0, count: L.count, contentKey: L.ck, envFingerprint: 'ouc0probe0fp0000' })) };
  const r = await node.ask({ type: 'content.put', kind: 'snapshot-manifest', key: `layers:${projectId}`, body: map });
  check(r.type === 'content.stored', '写层表', r);
}
const reqsFor = (L, ns) => assetLog.filter((r) => r.ns === ns && r.hash === (ns === 'snap' ? L.full : L.small)).length;

try {
  /* ============================================================ 创建者:同步卡的源码进内容库 */
  const node = await wsAsCreator();
  const put = await node.ask({ type: 'content.put', kind: 'card-source', key: SYNCED_KEY, body: SYNCED_SOURCE });
  check(put.type === 'content.stored', '创建者写卡片源码(card-source)', put);

  /* ============================================================ 普通档成员:摆片段 */
  const A = await newPage('甲');
  await join(A, '甲');
  const tiles = [[0, 0], [640, 0], [1280, 0], [0, 360], [640, 360], [1280, 360]];
  const setup = await store(A, `
    const ids = { b: 'ouc-b', u: 'ouc-u', s1: 'ouc-s1', s2: 'ouc-s2', s3: 'ouc-s3', x: 'ouc-x' };
    const cards = { b: 'punch-pill', u: 'mu-animated-shiny-text', s1: args[1], s2: args[1], s3: args[1], x: 'probe-unknown-card' };
    const tiles = args[0];
    S.actions.editCardProject((p) => ({
      ...p,
      duration: Math.max(p.duration, 4),
      tracks: [
        ...Object.keys(ids).map((k, i) => ({ id: 'ouc-t-' + k, name: '序列 ' + k, clips: [{ id: ids[k], cardId: cards[k], start: 0, end: 4, params: {},
          frame: { x: tiles[i][0], y: tiles[i][1], scale: 1 / 3 } }] })),
        ...p.tracks,
      ],
    }));
    S.actions.seek(1);
    const p = S.getState().project;
    return { projectId: p.id, ids, fps: p.fps || 30 };`, tiles, SYNCED_ID);
  out.setup = { ...setup, sharedProjectId: made.projectId };
  check(!!setup?.projectId, '摆片段', setup);
  const ID = setup.ids;
  const count = 4 * setup.fps;

  /* 层表与段清单:b、u、s1 有层;s2、s3 没有 */
  const L = { b: makeLayer(ID.b, '#1d4ed8', setup.fps, count), u: makeLayer(ID.u, '#15803d', setup.fps, count), s1: makeLayer(ID.s1, '#b45309', setup.fps, count) };
  for (const k of ['b', 'u', 's1']) await writeManifests(node, L[k]);
  await writeLayerMap(node, setup.projectId, setup.fps, [L.b, L.u, L.s1]);

  /* ============================================================ 普通档 */
  const n = {};
  n.cardSources = await until('页面从内容库认出同步卡', () => A.evaluate((id) => {
    const d = window.__pcCardSources?.();
    return d && d.cards.some((c) => c.id === id) ? d : null;
  }, SYNCED_ID), 30_000);
  n.timeline = await until('时间轴标签(同步卡真名)', async () => {
    const t = await timelineState(A, Object.values(ID));
    return t?.[ID.s1]?.label === SYNCED_NAME ? t : null;
  }, 20_000);
  check(n.timeline?.[ID.s1]?.label === SYNCED_NAME, '标签:同步卡 → 真名', n.timeline?.[ID.s1]);
  check(n.timeline?.[ID.x]?.label === '未知卡片', '标签:未知 id →「未知卡片」', n.timeline?.[ID.x]);
  // 舞台:有层的贴快照、没有图标;没层的同步卡是图标(不是沙漏);未知 id 不画
  n.stage = await until('舞台:u、s1 贴出快照,s2 是「需要本地 PC 渲染辅助」', async () => {
    const s = await stageState(A, Object.values(ID));
    return s && s[ID.u]?.snapshot && s[ID.s1]?.snapshot && s[ID.s2]?.placeholderShown ? s : null;
  }, 45_000);
  const st = n.stage ?? {};
  for (const k of ['u', 's1']) {
    check(st[ID[k]]?.snapshot && /SNAP/.test(st[ID[k]]?.snapText ?? ''), `舞台:${k} 贴出预渲染快照`, st[ID[k]]);
    check(!st[ID[k]]?.placeholderShown, `舞台:${k} 没有图标`, st[ID[k]]);
    check(!st[ID[k]]?.fixed, `舞台:${k} 没有常驻槽位`, st[ID[k]]);
  }
  check(st[ID.s2]?.placeholderShown && st[ID.s2]?.reason === 'unsupported' && /^unsupported/.test(st[ID.s2]?.kind ?? '') && (st[ID.s2]?.text ?? '').includes(UNSUPPORTED),
    '舞台:没有层的同步卡是「需要本地 PC 渲染辅助」(不是沙漏)', st[ID.s2]);
  check(st[ID.x]?.wrapper === false, '舞台:未知 id 不画', st[ID.x]);
  check(st[ID.b]?.wrapper === true, '舞台:内置卡在', st[ID.b]);
  n.requests = { snapU: reqsFor(L.u, 'snap'), snapS1: reqsFor(L.s1, 'snap'), snapB: reqsFor(L.b, 'snap'), pxAny: assetLog.filter((r) => r.ns === 'px').length };
  n.online = await A.evaluate(() => window.__pcOnlineSnapshots?.() ?? null);
  const manifestsOf = (id) => n.online?.layers?.find((l) => l.clipId === id) ?? null;
  check(n.requests.snapU > 0 && n.requests.snapS1 > 0, '有层的 u、s1:snap/ 请求 > 0', n.requests);
  check(n.requests.pxAny === 0, '普通档:预渲染小尺寸请求 0', n.requests);
  check(manifestsOf(ID.u)?.ready > 0 && manifestsOf(ID.s1)?.ready > 0, '有层的 u、s1:清单取了、就绪帧 > 0', { u: manifestsOf(ID.u), s1: manifestsOf(ID.s1) });
  // 时间轴徽标:只在 s2、s3(没有层)上
  n.badges = await until('徽标:s2、s3 有,u、s1 没有', async () => {
    const t = await timelineState(A, Object.values(ID));
    return t && t[ID.s2]?.badge && t[ID.s3]?.badge && !t[ID.u]?.badge && !t[ID.s1]?.badge ? t : null;
  }, 30_000) ?? await timelineState(A, Object.values(ID));
  for (const k of ['u', 's1', 'b', 'x']) check(n.badges?.[ID[k]] && !n.badges[ID[k]].badge, `时间轴:${k} 没有徽标`, n.badges?.[ID[k]]);
  check(n.badges?.[ID.s2]?.badge && n.badges[ID.s2].title === UNSUPPORTED, '时间轴:s2 有徽标、悬停文案「需要本地 PC 渲染辅助」', n.badges?.[ID.s2]);
  const badge = await A.$(`[data-clip-id="${ID.s2}"] [data-pc="clip-custom-card"]`);
  if (badge) { await badge.hover(); await sleep(1200); }
  await shot(A, 'normal-1-before-s2-layer');
  n.stageShot1 = await stageShot(A, 'normal-1-stage');
  // 页面发布的清单计划含用户卡与同步卡
  n.plan = await until('页面发布的清单计划含 u、s1、s2、s3', async () => {
    const d = await A.evaluate(() => window.__pcPlanPublisher?.() ?? null);
    const clips = d?.lastClips ?? [];
    return [ID.u, ID.s1, ID.s2, ID.s3].every((id) => clips.includes(id)) ? d : null;
  }, 90_000) ?? await A.evaluate(() => window.__pcPlanPublisher?.() ?? null);
  check([ID.u, ID.s1, ID.s2, ID.s3].every((id) => (n.plan?.lastClips ?? []).includes(id)), '普通档清单计划含用户卡与同步卡片段', { lastClips: n.plan?.lastClips, log: n.plan?.log?.slice(-3) });
  check(!(n.plan?.lastClips ?? []).includes(ID.x), '清单计划不含未知 id(它不画、不判重)', n.plan?.lastClips);

  // 给 s2 补层与清单:几秒内图标换成快照、徽标撤掉
  L.s2 = makeLayer(ID.s2, '#7e22ce', setup.fps, count);
  await writeManifests(node, L.s2);
  await writeLayerMap(node, setup.projectId, setup.fps, [L.b, L.u, L.s1, L.s2]);
  const t0 = Date.now();
  n.after = await until('s2 补了层:图标换成快照、徽标撤掉', async () => {
    const s = await stageState(A, [ID.s2]);
    const t = await timelineState(A, [ID.s2]);
    return s?.[ID.s2]?.snapshot && !s[ID.s2].placeholderShown && t?.[ID.s2] && !t[ID.s2].badge ? { stage: s[ID.s2], timeline: t[ID.s2], ms: Date.now() - t0 } : null;
  }, 20_000);
  check(!!n.after, 's2:产物到了换上快照、撤掉图标与徽标', n.after);
  if (n.after) check(n.after.ms < 15_000, 's2:几秒内换上', n.after.ms);
  await shot(A, 'normal-2-after-s2-layer');
  n.stageShot2 = await stageShot(A, 'normal-2-stage');
  n.errors = A.errors.slice(0, 5);
  out.normal = n;

  /* ============================================================ 低内存档(仿手机) */
  const P = await newPage('丙', { mobile: true });
  await join(P, '丙');
  const lm = {};
  lm.diag = await P.evaluate(() => ({ lowMemory: !!document.querySelector('[data-pc-low-memory]') || null, stages: [...document.querySelectorAll('iframe')].filter((f) => /[?&]stage=1/.test(f.src)).length }));
  lm.backfill = await until('低内存档:补渲在等的片段含 s3', async () => {
    const d = await P.evaluate(() => window.__pcBackfill?.() ?? null);
    const waiting = new Set([...(d?.waiting ?? []).map((w) => w.clip), ...(d?.log ?? []).flatMap((e) => e.clips ?? [])]);
    return waiting.has(ID.s3) ? { waiting: [...waiting], log: d.log.slice(-3) } : null;
  }, 120_000);
  check(lm.backfill?.waiting?.includes(ID.s3), '低内存档:__pcBackfill 的缺口含没有层的同步卡 s3', lm.backfill);
  check(!(lm.backfill?.waiting ?? []).includes(ID.u) && !(lm.backfill?.waiting ?? []).includes(ID.s1), '低内存档:有层的 u、s1 不进补渲', lm.backfill);
  await store(P, `S.actions.seek(1.5); return true;`);
  lm.stage = await until('低内存档舞台:u、s1 贴小尺寸,s3 是图标', async () => {
    const s = await stageState(P, [ID.u, ID.s1, ID.s3, ID.x]);
    return s && s[ID.u]?.small && s[ID.s1]?.small && s[ID.s3]?.placeholderShown ? s : null;
  }, 60_000) ?? await stageState(P, [ID.u, ID.s1, ID.s3, ID.x]);
  for (const k of ['u', 's1']) check(lm.stage?.[ID[k]]?.small && !lm.stage[ID[k]].placeholderShown, `低内存档舞台:${k} 贴预渲染小尺寸、没有图标`, lm.stage?.[ID[k]]);
  check(lm.stage?.[ID.s3]?.placeholderShown && lm.stage[ID.s3].reason === 'unsupported' && (lm.stage[ID.s3].text ?? '').includes(UNSUPPORTED), '低内存档舞台:s3 是「需要本地 PC 渲染辅助」', lm.stage?.[ID.s3]);
  check(lm.stage?.[ID.x]?.wrapper === false, '低内存档舞台:未知 id 不画', lm.stage?.[ID.x]);
  lm.requests = { pxU: reqsFor(L.u, 'px'), pxS1: reqsFor(L.s1, 'px') };
  check(lm.requests.pxU > 0 && lm.requests.pxS1 > 0, '低内存档:u、s1 的 px/ 请求 > 0', lm.requests);
  // 停下追一帧之后(时限 5 秒):用户卡照旧贴着小尺寸,不被「画好」撤掉
  await sleep(6000);
  lm.afterSettle = await stageState(P, [ID.u, ID.s1, ID.s3]);
  for (const k of ['u', 's1']) check(lm.afterSettle?.[ID[k]]?.small && !lm.afterSettle[ID[k]].placeholderShown, `低内存档停下之后:${k} 照旧贴小尺寸`, lm.afterSettle?.[ID[k]]);
  lm.settle = await P.evaluate(() => window.__pcPreviewDiag?.()?.lowMemSettle ?? null).catch(() => null);
  await shot(P, 'lowmem-1');
  lm.stageShot = await stageShot(P, 'lowmem-1-stage');
  lm.errors = P.errors.slice(0, 5);
  out.lowmem = lm;
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
out.assetRequests = { snap: assetLog.filter((r) => r.ns === 'snap').length, px: assetLog.filter((r) => r.ns === 'px').length };
say('result', { ok: out.ok, fails: fails.length });
console.log(JSON.stringify({ ok: out.ok, fails, normal: { timeline: out.normal.timeline, requests: out.normal.requests, planClips: out.normal.plan?.lastClips, after: out.normal.after }, lowmem: { backfill: out.lowmem.backfill, requests: out.lowmem.requests }, assetRequests: out.assetRequests }));
process.exit(out.ok ? 0 : 1);
