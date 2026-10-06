/**
 * 压测「新开的页面打开在线页 `<站点>/editor` 等 DOMContentLoaded」(TODO「偶发:探针里新开的页面打不开在线页」;报告 `docs/reports/AGENT-nav-hang.md`)。
 * 照在线探针的写法起本机站点(托管组合 + 仿 nginx 的前缀代理三个源,都带 OAC,在线构建当页面),反复「开新页面 → goto → 等 DOMContentLoaded」,
 * 每次记耗时;超时当场取证,取完再多等一段看它是「慢」还是「挂死」。
 *
 *   npx vite build --mode online --outDir <目录>
 *   node scripts/probes/online-nav-stress-probe.mjs --dist <在线构建目录> [--base-port 6090] [--mode ctx|same|fresh] [--iters 300]
 *        [--keep 5] [--join 1] [--stages 2|0] [--timeout 60000] [--late 120000] [--recycle 25] [--burn 0] [--netlog 1] [--out <目录>]
 *
 * 形态:
 *   --mode ctx    同一个浏览器,每页一个新的浏览器上下文(在线用户卡探针的 newPage 写法),页面留着,最多留 --keep 页,多了关最早的;
 *   --mode same   同一个浏览器、同一个缺省上下文里连开新页(同一主机的连接池共用),同样最多留 --keep 页;
 *   --mode fresh  每次新起浏览器,只开一页。
 *   --join 1      每页 DOMContentLoaded 之后加入共享项目进编辑器(舞台、文档服务的 WebSocket 都跑起来,像探针里的成员页面)。
 *   --stages 2    运行配置给两个跨源舞台源;0 时运行配置回 404(同源单舞台)。
 *   --recycle N   ctx / same 形态每 N 次换一个浏览器(网络日志按浏览器分文件,没出事的那份删掉)。
 *   --burn N      另起 N 个线程空转占 CPU(模拟机器忙)。
 *   --content-length 1  静态文件带 Content-Length(像 nginx);缺省用分块传输(与各在线探针的站点服务一样)。
 *   --gzip 1            静态文件按 Accept-Encoding 现压 gzip、分块传输(线上 nginx 的样子)。
 *   --headless shell    用 chrome-headless-shell;缺省 true(新 headless,完整 Chrome)。
 *   --fixed 1     与各探针一样带 probe-chrome.mjs 的 PROBE_CHROME_ARGS(缺省);--fixed 0 不带,复现卡死用。
 *   --netlog 1    每个浏览器带 `--log-net-log`,只留出过超时的那份(在 --out 下)。
 *
 * 端口:+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务(缺省 6090～6094)。
 * 每次一行 JSON 进度;超时的取证写 --out/fail-<序号>.json(CDP 网络事件里挂着的请求、生命周期事件、另开会话读的 readyState 与框架树、
 * 浏览器进程表、站点服务在途请求与连接数、控制台、截图)。最后一行是汇总 JSON。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { createSharedProject } from '../../server/auth/client.mjs';
import { seedSharedProject } from './lib-seed.mjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'online-nav-stress')));
const BASE = Number(arg('--base-port', 6090));
const MODE = arg('--mode', 'ctx');
const ITERS = Number(arg('--iters', 300));
const KEEP = Number(arg('--keep', 5));
const JOIN = arg('--join', '1') === '1';
const STAGES = Number(arg('--stages', 2));
const NAV_TIMEOUT = Number(arg('--timeout', 60_000));
const LATE = Number(arg('--late', 120_000));
const RECYCLE = Number(arg('--recycle', 25));
const BURN = Number(arg('--burn', 0));
const NETLOG = arg('--netlog', '1') === '1';
/** 1(缺省):与各探针一样带 `PROBE_CHROME_ARGS`(probe-chrome.mjs);0:不带,复现 Chrome for Testing 缺省配置下的卡死 */
const FIXED = arg('--fixed', '1') === '1';
const HEADLESS = arg('--headless', 'true');
/** 静态文件带 Content-Length(像 nginx);缺省 0 = 与各在线探针一样用分块传输 */
const CONTENT_LENGTH = arg('--content-length', '0') === '1';
/** 静态文件按请求的 Accept-Encoding 现压 gzip、分块传输(线上 nginx 开了 gzip 的样子) */
const GZIP = arg('--gzip', '0') === '1';
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4 };
const SITE = `http://127.0.0.1:${PORTS.editor}`;
const STAGE_ORIGINS = [`http://127.0.0.1:${PORTS.stageA}`, `http://127.0.0.1:${PORTS.stageB}`];
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
fs.mkdirSync(OUT, { recursive: true });

const say = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms} ms: ${what}`)), ms))]);
const safe = async (fn, ms, what) => { try { return await withTimeout(Promise.resolve().then(fn), ms, what); } catch (e) { return { error: String(e?.message ?? e).slice(0, 300) }; } };

/* ------------------------------------------------------------------ 占 CPU */
const burners = [];
for (let i = 0; i < BURN; i++) burners.push(new Worker('for(;;){Math.sqrt(Math.random())}', { eval: true }));

/* ------------------------------------------------------------------ 服务 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-nav-stress-hosted-'));
const combo = await startHostedCombo({
  dataDir, docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
  docPublicUrl: `ws://127.0.0.1:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
});

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
const OAC = { 'origin-agent-cluster': '?1' };
const runtimeConfig = JSON.stringify({ v: 1, stageOrigins: STAGE_ORIGINS });
/** 站点服务侧:在途请求(还没 finish / close 的)与每个源的连接数 */
let reqSeq = 0;
const inflight = new Map();
const sockets = new Map();
const recentDone = [];
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
    const id = ++reqSeq;
    const rec = { id, port, url: req.url.slice(0, 120), t0: Date.now(), bytes: 0, remote: req.socket.remotePort };
    inflight.set(id, rec);
    const origWrite = res.write.bind(res);
    res.write = (chunk, ...rest) => { rec.bytes += chunk?.length ?? 0; return origWrite(chunk, ...rest); };
    const done = (how) => { if (!inflight.has(id)) return; inflight.delete(id); rec.ms = Date.now() - rec.t0; rec.how = how; recentDone.push(rec); if (recentDone.length > 400) recentDone.shift(); };
    res.on('finish', () => done('finish'));
    res.on('close', () => done('close'));
    const url = new URL(req.url, origin);
    if (url.pathname === '/hosted' || url.pathname.startsWith('/hosted/')) return forward(req, res, PORTS.doc, '/hosted');
    if (url.pathname.startsWith('/media/')) return forward(req, res, PORTS.asset, '/media');
    const sec = { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...OAC };
    const sendFile = (file, cache) => {
      if (GZIP && /gzip/.test(String(req.headers['accept-encoding'] ?? ''))) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', ...sec });
        fs.createReadStream(file).on('error', (e) => { rec.err = String(e.message); res.destroy(e); }).pipe(zlib.createGzip({ level: 1 })).pipe(res);
        return;
      }
      const len = CONTENT_LENGTH ? { 'Content-Length': fs.statSync(file).size } : {};
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache, ...len, ...sec });
      fs.createReadStream(file).on('error', (e) => { rec.err = String(e.message); res.destroy(e); }).pipe(res);
    };
    if (url.pathname === '/editor/runtime-config.json') {
      if (!STAGES) { res.writeHead(404, { 'Content-Type': 'text/plain', ...sec }); return res.end('no runtime config (probe)'); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...sec });
      return res.end(runtimeConfig);
    }
    const index = path.join(DIST, 'index.html');
    const isPage = url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html';
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
  server.on('connection', (s) => { sockets.set(port, (sockets.get(port) ?? 0) + 1); s.on('close', () => sockets.set(port, sockets.get(port) - 1)); });
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
const serverSnapshot = () => ({
  inflight: [...inflight.values()].map((r) => ({ ...r, age: Date.now() - r.t0 })),
  sockets: Object.fromEntries(sockets),
  recentSlow: recentDone.filter((r) => r.ms > 2000).slice(-20),
});

/* ------------------------------------------------------------------ 共享项目 */
const stamp = Date.now().toString(36);
const NAME = `nav-${stamp}`;
const creator = { username: 'boss', password: `boss-${randomBytes(6).toString('hex')}` };
const PROJECT_PW = `pw-${randomBytes(6).toString('hex')}`;
if (JOIN) {
  const made = await createSharedProject({ base: DOC_DIRECT, name: NAME, mode: 'free', creator, password: PROJECT_PW });
  // 在线页面只加入、不新建(`dce4b22b`):先替创建者写进一份空项目,否则页面进不去(等不到成员按钮)
  const seeded = await seedSharedProject({ base: DOC_DIRECT, projectId: made.projectId, creator, name: NAME });
  if (!seeded.ok) throw new Error(`替创建者写进空项目失败:${JSON.stringify(seeded)}`);
}

/* ------------------------------------------------------------------ 浏览器 */
let browser = null;
let browserSeq = 0;
let browserNetlog = null;
let browserFailed = false;
async function launch() {
  browserSeq++;
  browserNetlog = NETLOG ? path.join(OUT, `netlog-b${browserSeq}-${stamp}.json`) : null;
  browserFailed = false;
  const args = [...(FIXED ? PROBE_CHROME_ARGS : []), '--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--site-per-process'];
  if (browserNetlog) args.push(`--log-net-log=${browserNetlog}`);
  if (process.env.PC_CHROME_ARGS) args.push(...process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean));
  browser = await puppeteer.launch({ headless: HEADLESS === 'false' ? false : HEADLESS === 'shell' ? 'shell' : true, protocolTimeout: 600_000, args });
}
async function closeBrowser() {
  if (!browser) return;
  const b = browser;
  browser = null;
  await withTimeout(b.close(), 30_000, 'browser.close').catch(() => { try { b.process()?.kill(); } catch { /* 已退 */ } });
  if (browserNetlog && !browserFailed) {
    for (let i = 0; i < 10; i++) { try { fs.rmSync(browserNetlog, { force: true }); break; } catch { await sleep(500); } }
  }
}

async function typeInto(page, sel, text) {
  await page.waitForSelector(sel, { visible: true, timeout: 30_000 });
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  if (text) await page.type(sel, text, { delay: 5 });
}

/** 开一页并挂上自己的 CDP 会话记网络与生命周期事件(与 puppeteer 自己的会话分开,取证时不依赖它) */
async function openPage(i) {
  const ctx = MODE === 'ctx' ? await browser.createBrowserContext() : null;
  const page = ctx ? await ctx.newPage() : await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on('dialog', (d) => void d.accept());
  const rec = { i, console: [], errors: [], net: new Map(), life: [], t0: 0 };
  page.on('console', (m) => { if (rec.console.length < 80) rec.console.push({ at: Date.now() - rec.t0, type: m.type(), text: m.text().slice(0, 200) }); });
  page.on('pageerror', (e) => rec.errors.push(String(e?.message ?? e).slice(0, 200)));
  page.on('error', (e) => rec.errors.push(`page crashed: ${String(e?.message ?? e).slice(0, 120)}`));
  const s = await page.createCDPSession();
  await s.send('Network.enable');
  await s.send('Page.enable');
  await s.send('Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {});
  const at = () => Date.now() - rec.t0;
  s.on('Network.requestWillBeSent', (e) => rec.net.set(e.requestId, { url: e.request.url.slice(0, 120), start: at(), type: e.type, prio: e.request.initialPriority, frame: e.frameId, redirect: !!e.redirectResponse }));
  s.on('Network.responseReceived', (e) => { const r = rec.net.get(e.requestId); if (r) { r.resp = at(); r.status = e.response.status; r.proto = e.response.protocol; r.conn = e.response.connectionId; r.reused = e.response.connectionReused; r.timing = e.response.timing ? { dns: e.response.timing.dnsStart, conn: e.response.timing.connectStart, send: e.response.timing.sendStart, recvHeaders: e.response.timing.receiveHeadersEnd } : null; } });
  s.on('Network.dataReceived', (e) => { const r = rec.net.get(e.requestId); if (r) r.bytes = (r.bytes ?? 0) + e.dataLength; });
  s.on('Network.loadingFinished', (e) => { const r = rec.net.get(e.requestId); if (r) r.end = at(); });
  s.on('Network.loadingFailed', (e) => { const r = rec.net.get(e.requestId); if (r) { r.end = at(); r.failed = e.errorText; r.canceled = e.canceled; } });
  s.on('Page.lifecycleEvent', (e) => {
    if (rec.life.length < 60) rec.life.push({ at: at(), name: e.name, frame: e.frameId.slice(0, 8), loader: e.loaderId.slice(0, 8) });
    if (e.name === 'init') rec.mainFrameId ??= e.frameId;
    if (e.name === 'DOMContentLoaded' && e.frameId === rec.mainFrameId) rec.dclCdp ??= at();
  });
  s.on('Page.domContentEventFired', () => { rec.dclCdp ??= at(); });
  s.on('Page.loadEventFired', () => { rec.loadCdp ??= at(); });
  s.on('Page.frameNavigated', (e) => { if (!e.frame.parentId) rec.mainNav = { at: at(), url: e.frame.url.slice(0, 80), loader: e.frame.loaderId.slice(0, 8) }; });
  s.on('Page.frameRequestedNavigation', (e) => { rec.reqNav ??= { at: at(), url: e.url.slice(0, 80) }; });
  s.on('Inspector.targetCrashed', () => rec.errors.push('targetCrashed'));
  return { page, ctx, rec, session: s };
}
async function closePage(p) {
  await safe(() => p.session.detach(), 5000, 'detach');
  await safe(() => p.page.close(), 20_000, 'page.close');
  if (p.ctx) await safe(() => p.ctx.close(), 20_000, 'ctx.close');
}

/** 超时时当场取证 */
async function forensics(p, i, why) {
  const { page, rec } = p;
  const f = { i, why, mode: MODE, join: JOIN, stages: STAGES, browserSeq, at: new Date().toISOString(), load: os.loadavg?.()[0] ?? null, freeMemMB: Math.round(os.freemem() / 1048576) };
  f.server = serverSnapshot();
  const reqs = JSON.parse(JSON.stringify([...rec.net.values()]));
  f.netTotal = reqs.length;
  f.netPending = reqs.filter((r) => r.end === undefined);
  f.netDone = reqs.filter((r) => r.end !== undefined).map((r) => ({ url: r.url, start: r.start, resp: r.resp, end: r.end, status: r.status, failed: r.failed, reused: r.reused, conn: r.conn }));
  f.life = JSON.parse(JSON.stringify(rec.life));
  f.dclCdp = rec.dclCdp ?? null;
  f.loadCdp = rec.loadCdp ?? null;
  f.mainNav = rec.mainNav ?? null;
  f.reqNav = rec.reqNav ?? null;
  f.console = rec.console;
  f.errors = rec.errors;
  f.puppeteerMainUrl = await safe(() => page.mainFrame().url(), 3000, 'mainFrame.url');
  f.puppeteerFrames = await safe(() => page.frames().map((x) => x.url().slice(0, 100)), 3000, 'frames');
  // 另开一个 CDP 会话读页面状态:主线程要是卡死,这里也会超时——那本身就是证据
  const fresh = await safe(() => page.target().createCDPSession(), 10_000, 'createCDPSession');
  if (fresh && !fresh.error) {
    f.readyState = await safe(async () => (await fresh.send('Runtime.evaluate', { expression: `JSON.stringify({ rs: document.readyState, href: location.href, root: document.getElementById('root')?.childElementCount ?? null, scripts: [...document.scripts].map((s) => s.src.slice(-40)), res: performance.getEntriesByType('resource').map((e) => ({ n: e.name.slice(-48), s: Math.round(e.startTime), d: Math.round(e.duration), sz: e.transferSize })), nav: performance.getEntriesByType('navigation')[0]?.toJSON?.() ?? null })`, returnByValue: true })).result?.value ?? null, 10_000, 'readyState');
    f.frameTree = await safe(async () => { const t = await fresh.send('Page.getFrameTree'); const walk = (n) => ({ url: n.frame.url.slice(0, 100), loader: n.frame.loaderId?.slice(0, 8), children: (n.childFrames ?? []).map(walk) }); return walk(t.frameTree); }, 10_000, 'getFrameTree');
    f.navHistory = await safe(async () => (await fresh.send('Page.getNavigationHistory')).entries.map((e) => e.url.slice(0, 80)), 10_000, 'navHistory');
    await safe(() => fresh.detach(), 3000, 'detach');
  } else f.freshSession = fresh;
  const bs = await safe(() => browser.target().createCDPSession(), 10_000, 'browser session');
  if (bs && !bs.error) {
    f.processes = await safe(async () => (await bs.send('SystemInfo.getProcessInfo')).processInfo.map((x) => ({ type: x.type, id: x.id, cpu: Math.round(x.cpuTime * 10) / 10 })), 10_000, 'getProcessInfo');
    f.targets = await safe(async () => (await bs.send('Target.getTargets')).targetInfos.map((t) => ({ type: t.type, url: t.url.slice(0, 90), attached: t.attached, ctx: t.browserContextId?.slice(0, 6) })), 10_000, 'getTargets');
    await safe(() => bs.detach(), 3000, 'detach');
  } else f.browserSession = bs;
  f.browserPid = browser.process()?.pid ?? null;
  f.browserAlive = browser.process() ? browser.process().exitCode === null : null;
  f.connected = browser.connected;
  const shotFile = path.join(OUT, `fail-${stamp}-${i}.png`);
  f.shot = await safe(async () => { await page.screenshot({ path: shotFile }); return shotFile; }, 15_000, 'screenshot');
  // 多等一段:DCL 来不来(慢,还是挂死)
  const t1 = Date.now();
  let late = null;
  while (Date.now() - t1 < LATE) {
    if (rec.dclCdp !== undefined) { late = { dclCdp: rec.dclCdp, waitedMs: Date.now() - t1 }; break; }
    await sleep(1000);
  }
  f.late = late ?? { never: true, waitedMs: Date.now() - t1 };
  f.lateReadyState = await safe(async () => page.evaluate(() => document.readyState), 10_000, 'late readyState');
  f.serverAfter = serverSnapshot();
  f.netPendingAfter = [...rec.net.values()].filter((r) => r.end === undefined);
  f.lifeAfter = rec.life;
  const file = path.join(OUT, `fail-${stamp}-${i}.json`);
  fs.writeFileSync(file, JSON.stringify(f, null, 1));
  return { file, late: f.late, readyState: f.readyState, pending: f.netPending.length };
}

/* ------------------------------------------------------------------ 压测 */
const results = [];
const fails = [];
const open = [];
let sinceLaunch = 0;
const tStart = Date.now();
try {
  for (let i = 1; i <= ITERS; i++) {
    if (!browser || (MODE !== 'fresh' && RECYCLE > 0 && sinceLaunch >= RECYCLE)) {
      while (open.length) await closePage(open.shift());
      await closeBrowser();
      await launch();
      sinceLaunch = 0;
    }
    sinceLaunch++;
    const p = await openPage(i);
    p.rec.t0 = Date.now();
    let navErr = null;
    try {
      await p.page.goto(`${SITE}/editor`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    } catch (e) { navErr = String(e?.message ?? e).slice(0, 200); }
    const gotoMs = Date.now() - p.rec.t0;
    const r = { i, gotoMs, dclCdp: p.rec.dclCdp ?? null, open: open.length, browserSeq };
    if (navErr) {
      r.navErr = navErr;
      browserFailed = true;
      const fx = await forensics(p, i, navErr);
      r.forensics = fx;
      fails.push(r);
      say({ FAIL: r });
    } else if (JOIN) {
      const tj = Date.now();
      try {
        await p.page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
        await typeInto(p.page, '[data-pc="join-name"]', NAME);
        await typeInto(p.page, '[data-pc="join-username"]', `u${i}`);
        await typeInto(p.page, '[data-pc="join-password"]', PROJECT_PW);
        await p.page.click('[data-pc="join-submit"]');
        await p.page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 });
        r.joinMs = Date.now() - tj;
      } catch (e) { r.joinErr = String(e?.message ?? e).slice(0, 160); }
    }
    results.push(r);
    if (!navErr) say({ i, gotoMs, joinMs: r.joinMs, joinErr: r.joinErr, open: r.open, b: browserSeq });
    if (MODE === 'fresh') { await closePage(p); await closeBrowser(); }
    else { open.push(p); while (open.length > KEEP) await closePage(open.shift()); }
  }
} finally {
  while (open.length) await closePage(open.shift()).catch(() => {});
  await closeBrowser().catch(() => {});
  for (const w of burners) await w.terminate();
  for (const s of servers) s.closeAllConnections?.(), s.close();
  await combo?.close?.().catch?.(() => {});
}
const ok = results.filter((r) => !r.navErr);
const sorted = ok.map((r) => r.gotoMs).sort((a, b) => a - b);
const pct = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
say({
  summary: { mode: MODE, join: JOIN, stages: STAGES, keep: KEEP, burn: BURN, headless: HEADLESS, contentLength: CONTENT_LENGTH, gzip: GZIP, fixed: FIXED, executable: process.env.PUPPETEER_EXECUTABLE_PATH ?? null, chromeArgs: process.env.PC_CHROME_ARGS ?? '', iters: results.length, fails: fails.length, joinErrs: results.filter((r) => r.joinErr).length,
    gotoMs: { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: sorted.at(-1) ?? null }, minutes: Math.round((Date.now() - tStart) / 6000) / 10,
    failFiles: fails.map((f) => f.forensics?.file), cpus: os.cpus().length },
});
process.exit(0);
