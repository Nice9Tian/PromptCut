/**
 * 在线普通档两个舞台「握手之后又断」(C10 契约第 2 节〔裁〕,2026-09-30;看守在 `src/online/stageWatch.ts`,接线在 `src/editor/Preview.tsx`)。
 * 全程在本机:本机托管组合代替阿里云,仿 nginx 的前缀代理开三个源(编辑器页 + 两个舞台,都带 OAC),在线构建当页面。
 *
 *   npx vite build --mode online --outDir <目录>
 *   node scripts/probes/online-stage-watch-probe.mjs --dist <在线构建目录> [--out <截图目录>] [--base-port 5720]
 *
 * 端口:+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务(缺省 5720～5724)。
 *
 * 断言:
 *   W1 握手:两个跨源舞台都握上手(`__pcStageWatch()` 两台 alive、handshake ok、`__pcPreviewDiag().dual`)。
 *   W2 握手后 B 断开、重载握回来:用 CDP 的 `Page.crash` 弄崩舞台 B 的渲染进程(跨源 iframe 自成目标);
 *      页面在「断开判定 + 一拍」内重载 B(代理记到 B 源上新的舞台页请求),B 重新握手,仍是双舞台、没退回;
 *      编辑器页自己没崩、可见舞台 A 一直在画片段。
 *   W3 重载也握不回来 → 退回单舞台:代理让舞台 A 的源对舞台页一律回 503,再弄崩 A(此刻的可见舞台);
 *      页面重载 A 失败,重载后约 20 秒退回同源单舞台(handshake failed、dual 假、只剩一个舞台 iframe、它在编辑器页的源上),
 *      可见舞台重新画出片段(不空白);从弄崩到画回来的总耗时记在结果里。
 *   W4 退回后不反复重载:之后 60 秒里两个舞台源都没有再收到舞台页请求,`reloads` 不变。
 *
 * 机器忙时(同机别的探针在跑)判定的时限有余量:断开判定 15 秒 + 心跳 5 秒 + 重载时限 20 秒,各处等待都放宽到 2 倍以上。
 * 结果最后一行是一行 JSON(`ok`、`fails`、各项数字),截图在 --out。
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { createSharedProject } from '../../server/auth/client.mjs';
import { seedSharedProject } from './lib-seed.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'online-stage-watch-shots')));
const BASE = Number(arg('--base-port', 5720));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4 };
const SITE = `http://127.0.0.1:${PORTS.editor}`;
const STAGE_ORIGINS = [`http://127.0.0.1:${PORTS.stageA}`, `http://127.0.0.1:${PORTS.stageB}`];
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, load: os.loadavg?.()[0] ?? null, cpus: os.cpus().length };
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

/* ------------------------------------------------------------------ 服务 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-stage-watch-hosted-'));
const combo = await startHostedCombo({
  dataDir, docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
  docPublicUrl: `ws://127.0.0.1:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
});

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
const OAC = { 'origin-agent-cluster': '?1' };
const runtimeConfig = JSON.stringify({ v: 1, stageOrigins: STAGE_ORIGINS });
/** 每个源上收到的舞台页请求(`/editor` 的 HTML,带 `stage=1`):时间 */
const stagePageHits = new Map();
/** 让这些端口对舞台页回 503(模拟那台舞台的源坏了,重载握不回来) */
const broken = new Set();
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
    // 跨源舞台载的是舞台入口 stage.html(在线执行用户卡与图卡,`online-card-exec-contract.md` 第 3.3 节);同源单舞台仍是 /editor/?stage=1。两种都算「舞台页请求」
    const isStageEntry = url.pathname === '/editor/stage.html';
    const isPage = url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html' || isStageEntry;
    if (isPage && url.searchParams.get('stage') === '1') {
      if (!stagePageHits.has(port)) stagePageHits.set(port, []);
      stagePageHits.get(port).push(Date.now());
      if (broken.has(port)) { res.writeHead(503, { 'Content-Type': 'text/plain', ...sec }); return res.end('stage origin down (probe)'); }
    }
    if (isStageEntry) { const entry = path.join(DIST, 'stage.html'); return sendFile(fs.existsSync(entry) ? entry : index, 'no-store'); }
    if (isPage) return sendFile(index, 'no-store');
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
const hits = (port) => (stagePageHits.get(port) ?? []).length;

/* ------------------------------------------------------------------ 共享项目 */
const stamp = Date.now().toString(36);
const NAME = `osw-${stamp}`;
const creator = { username: 'boss', password: `boss-${randomBytes(6).toString('hex')}` };
const PROJECT_PW = `pw-${randomBytes(6).toString('hex')}`;
const made = await createSharedProject({ base: DOC_DIRECT, name: NAME, mode: 'free', creator, password: PROJECT_PW });
// 在线页面只加入、不新建(`dce4b22b`):先替创建者写进一份空项目,否则页面进不去(等不到成员按钮)
check((await seedSharedProject({ base: DOC_DIRECT, projectId: made.projectId, creator, name: NAME })).ok, '替创建者写进空项目');

/* ------------------------------------------------------------------ 浏览器 */
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--site-per-process', ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : [])] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on('dialog', (d) => void d.accept());
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));
const consoleWarn = [];
page.on('console', (m) => { const t = m.text(); if (/舞台 [AB] |退回同源单舞台/.test(t)) consoleWarn.push(t.slice(0, 200)); });
let pageCrashed = false;
page.on('error', () => { pageCrashed = true; });

async function typeInto(sel, text) {
  await page.waitForSelector(sel, { visible: true, timeout: 15_000 });
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  if (text) await page.type(sel, text, { delay: 5 });
}
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
const store = (src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
const watchDiag = () => page.evaluate(() => window.__pcStageWatch?.() ?? null);
const previewDiag = () => page.evaluate(() => { const d = window.__pcPreviewDiag?.(); return d ? { dual: d.dual, frontId: d.frontId, onlineStages: d.onlineStages } : null; });
const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()));
/** 可见舞台里画没画出片段(包裹层在、有子节点) */
async function visibleDrawn(clipId) {
  for (const f of stageFrames()) {
    const el = await f.frameElement().catch(() => null);
    const vis = el ? await el.evaluate((e) => { const cs = getComputedStyle(e); return Number(cs.opacity) > 0.5 && e.getBoundingClientRect().width > 10; }).catch(() => false) : false;
    if (!vis) continue;
    const drawn = await f.evaluate((id) => { const w = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`); return !!w && w.childElementCount > 0; }, clipId).catch(() => false);
    if (drawn) return { url: f.url() };
  }
  return null;
}
/** 弄崩一台跨源舞台的渲染进程(它自成一个目标) */
async function crashStage(port) {
  const t = browser.targets().find((x) => x.url().startsWith(`http://127.0.0.1:${port}/`) && /[?&]stage=1/.test(x.url()));
  if (!t) return { ok: false, why: 'no target', targets: browser.targets().map((x) => `${x.type()} ${x.url().slice(0, 60)}`) };
  const s = await t.createCDPSession();
  await s.send('Page.crash').catch(() => {});
  return { ok: true, type: t.type() };
}

try {
  /* ============================================================ W1 握手 */
  await page.goto(`${SITE}/editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
  await typeInto('[data-pc="join-name"]', NAME);
  await typeInto('[data-pc="join-username"]', 'boss2');
  await typeInto('[data-pc="join-password"]', PROJECT_PW);
  await page.click('[data-pc="join-submit"]');
  await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 });
  await until('时间轴', () => page.evaluate(() => !!window.__pcStore), 30_000);
  const CLIP = 'osw-b';
  await store(`
    S.actions.editCardProject((p) => ({ ...p, duration: Math.max(p.duration, 6),
      tracks: [{ id: 'osw-t', name: '序列', clips: [{ id: args[0], cardId: 'punch-pill', start: 0, end: 6, params: {}, frame: { x: 0, y: 0, w: 960, h: 540 } }] }, ...p.tracks] }));
    S.actions.seek(1); return true;`, CLIP);
  out.w1 = await until('两个舞台握上手', async () => {
    const w = await watchDiag();
    return w && w.handshake === 'ok' && w.A === 'alive' && w.B === 'alive' ? w : null;
  }, 60_000);
  out.w1preview = await previewDiag();
  check(out.w1preview?.dual === true, 'W1 双舞台', out.w1preview);
  check(!!(await until('W1 可见舞台画出片段', () => visibleDrawn(CLIP), 30_000)), 'W1 可见舞台画出片段');
  await shot('w1-dual');

  /* ============================================================ W2 握手后 B 断开,重载握回来 */
  if (out.w1) {
    const hitsB0 = hits(PORTS.stageB);
    const t0 = Date.now();
    out.w2crash = await crashStage(PORTS.stageB);
    check(out.w2crash.ok, 'W2 找到舞台 B 的目标', out.w2crash);
    const reloaded = await until('W2 页面重载舞台 B', async () => {
      const w = await watchDiag();
      return hits(PORTS.stageB) > hitsB0 && w?.reloads >= 1 ? w : null;
    }, 60_000, 500);
    out.w2reloadMs = reloaded ? Date.now() - t0 : null;
    const back = await until('W2 B 重新握手', async () => {
      const w = await watchDiag();
      return w && w.B === 'alive' && w.reloads >= 1 ? w : null;
    }, 60_000, 500);
    out.w2recoverMs = back ? Date.now() - t0 : null;
    await sleep(25_000); // 过了重载时限仍不退回
    out.w2 = await watchDiag();
    out.w2preview = await previewDiag();
    check(out.w2?.handshake === 'ok' && out.w2?.fellBack === false && out.w2preview?.dual === true, 'W2 重载握回来后仍是双舞台、没退回', { w: out.w2, p: out.w2preview });
    check(out.w2?.reloads === 1, 'W2 只重载了一次', out.w2);
    check(!pageCrashed, 'W2 编辑器页自己没崩');
    check(!!(await visibleDrawn(CLIP)), 'W2 可见舞台仍在画片段');
    await shot('w2-recovered');

    /* ============================================================ W3 重载也握不回来 → 退回单舞台 */
    const front = out.w2preview?.frontId ?? 'A';
    const frontPort = front === 'A' ? PORTS.stageA : PORTS.stageB;
    broken.add(frontPort);
    const t1 = Date.now();
    out.w3crash = await crashStage(frontPort);
    check(out.w3crash.ok, `W3 找到舞台 ${front} 的目标`, out.w3crash);
    const fell = await until('W3 退回单舞台', async () => {
      const w = await watchDiag();
      return w && w.handshake === 'failed' ? w : null;
    }, 120_000, 500);
    out.w3fallbackMs = fell ? Date.now() - t1 : null;
    out.w3 = fell;
    check(/断开后重载,20 秒内没握回来/.test(fell?.reason ?? ''), 'W3 退回原因是重载 20 秒没握回来', fell);
    const drawnAgain = await until('W3 单舞台画回片段', () => visibleDrawn(CLIP), 60_000, 500);
    out.w3drawnMs = drawnAgain ? Date.now() - t1 : null;
    out.w3preview = await previewDiag();
    const frames = stageFrames();
    out.w3frames = frames.map((f) => f.url().replace(/\?.*$/, ''));
    check(out.w3preview?.dual === false, 'W3 dual 假', out.w3preview);
    check(frames.length === 1 && frames[0].url().startsWith(`${SITE}/`), 'W3 只剩一个舞台 iframe,在编辑器页的源上', out.w3frames);
    check(!!drawnAgain && drawnAgain.url.startsWith(`${SITE}/`), 'W3 可见舞台(同源单舞台)画出片段', drawnAgain);
    // 重载后 20 秒才退回:从重载到退回至少 ~20 秒
    check(out.w3fallbackMs === null || out.w3fallbackMs >= 20_000, 'W3 退回不早于重载时限', out.w3fallbackMs);
    await shot('w3-single');

    /* ============================================================ W4 退回后不反复重载 */
    const h0 = { a: hits(PORTS.stageA), b: hits(PORTS.stageB) };
    const r0 = (await watchDiag())?.reloads;
    await sleep(60_000);
    const h1 = { a: hits(PORTS.stageA), b: hits(PORTS.stageB) };
    const w4 = await watchDiag();
    out.w4 = { before: h0, after: h1, reloads: [r0, w4?.reloads], handshake: w4?.handshake };
    check(h1.a === h0.a && h1.b === h0.b, 'W4 退回后两个舞台源没再收到舞台页请求', out.w4);
    check(w4?.reloads === r0 && w4?.handshake === 'failed', 'W4 退回后 reloads 不变、握手仍是 failed', out.w4);
    check(!!(await visibleDrawn(CLIP)), 'W4 单舞台仍在画片段');
    check(!pageCrashed, 'W4 编辑器页没崩');
  }
} catch (e) {
  fails.push(`异常:${String(e?.stack ?? e).slice(0, 400)}`);
} finally {
  out.stagePageHits = Object.fromEntries([...stagePageHits].map(([p, v]) => [p, v.length]));
  out.consoleWarn = consoleWarn.slice(-10);
  out.pageErrors = pageErrors.slice(0, 5);
  out.fails = fails;
  out.ok = fails.length === 0;
  await browser.close().catch(() => {});
  for (const s of servers) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r())); }
  await combo.close?.().catch?.(() => {});
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
