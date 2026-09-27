/**
 * C10 本机真浏览器验收(`docs/plan/c10-contract.md` 第 20 节 C10-A1～A5、A10):在线浏览器模式普通档。
 *
 *   node scripts/probes/c10-browser-probe.mjs [--out <目录>] [--dist <在线构建目录>] [--keep-temp]
 *        [--a10]                 只验 A10(逐帧导出跨过票据时限):托管端的素材票据时限缩短到 --ticket-ttl-ms
 *        [--ticket-ttl-ms 20000]
 *        [--no-video]            不导入视频(只验卡片)
 *        [--base-port 5420]      端口段:+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务、+5～+7 创建者编辑器与舞台端口
 *                                (A5 里创建者关掉之后,独立渲染主机用同一段)
 *
 * 本机替身(与阿里云同形):
 *   - 托管组合(文档服务 + 素材服务,只绑 127.0.0.1);
 *   - 仿 nginx 的前缀代理,开三个源:编辑器页(+0)与两个舞台(+1、+2)都给 `/editor`(在线构建)、`/hosted/` 与 `/media/` 反代,
 *     **每个响应都带 `Origin-Agent-Cluster: ?1`**;`/editor/runtime-config.json` 给两个舞台源(同 `deploy-hosted --stage-origins` 写的);
 *   - 创建者 = 桌面版 dev server + 它的预渲染进程(队列节点,pc),建项目、放卡、勾「多用户协作」放云端、取邀请链接、预渲染;
 *   - 成员 = 电脑浏览器(普通档)打开邀请链接进入。
 *
 * 验收:
 *   A1 两个舞台同站跨源、带 OAC(舞台成了独立的 iframe 目标);播放含重卡的 10 秒时间轴,主文档长任务 0,重层按拍换快照
 *   A2 首次打开在加载遮罩下测完,L2 有 costs;关掉再开不重测,已在 L2 的块不再请求
 *   A3 普通档取原尺寸(snap/),预渲染小尺寸请求 0;一层只出自一种环境
 *   A4 换帧预算装不下的层显示占位;暂停后追到精确活渲;占位撤下后不再盖回
 *   A5 关掉创建者(没有节点在线)时纯在线改一处:页面发布清单计划、不报错;起独立渲染主机(host 档、指纹与页面不同)→ 认领、切分、完成 → 页面取到新快照
 *   A10(--a10)逐帧导出跨过票据时限照常完成
 *
 * 不打印令牌、口令、邀请码原文。输出:过程写 stderr;stdout 最后一行一行 JSON `{ ok, fails, … }`。
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const A10 = argv.includes('--a10');
const KEEP = argv.includes('--keep-temp');
const VIDEO = !argv.includes('--no-video');
const BASE = Number(arg('--base-port', 5420));
const TTL_MS = Number(arg('--ticket-ttl-ms', 20_000));
if (A10) process.env.PROMPTCUT_TEST_ASSET_TICKET_TTL_MS = String(TTL_MS);
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4, node: BASE + 5 };
const FPS = 30;
const SECONDS = 10;
const EXTRA_HEAVY = 8;
const HOST_FP = '0c10b0e5f1a9e7d2';
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const SITE = `http://127.0.0.1:${PORTS.editor}`;
const STAGE_ORIGINS = [`http://127.0.0.1:${PORTS.stageA}`, `http://127.0.0.1:${PORTS.stageB}`];
const HOSTED = `${SITE}/hosted/`;
const EDITOR = `${SITE}/editor`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-c10-browser-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'shots')));
fs.mkdirSync(OUT, { recursive: true });
const started = Date.now();
const deadline = started + 60 * 60_000;

const fails = [];
const out = { ok: false, run: RUN, mode: A10 ? 'a10' : 'a1-a5', site: SITE, stageOrigins: STAGE_ORIGINS, out: OUT, steps: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 500)}`)); return !!cond; };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
const codeOf = (link) => String(link ?? '').split('invite=')[1] ?? '';

async function until(label, fn, timeoutMs, everyMs = 300) {
  const end = Math.min(Date.now() + timeoutMs, deadline);
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) { fails.push(`超时:${label}`); return null; }
    await delay(everyMs);
  }
}
const getJson = async (url, timeoutMs = 10_000) => (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).json();

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ } }
}
const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
function pidOnPort(port) {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (m && Number(m[1]) === port) return Number(m[2]);
  }
  return null;
}

/* ================================================================== 本机替身:托管组合 + 三个源的仿 nginx 代理 */

let combo = null;
const proxies = [];
const docHeaders = [];
async function startLocalSite() {
  for (const p of [PORTS.editor, PORTS.stageA, PORTS.stageB, PORTS.doc, PORTS.asset]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  let DIST = arg('--dist', null);
  if (!DIST) {
    DIST = path.join(TMP, 'dist-online');
    say('local.build-online', { dist: DIST });
    const b = spawnSync(process.execPath, [viteBin(), 'build', '--mode', 'online', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    if (b.status !== 0) throw new Error(`在线构建失败:${String(b.stderr).slice(-600)}`);
  }
  DIST = path.resolve(DIST);
  const { startHostedCombo } = await import('../../server/hosted/combo.mjs');
  fs.mkdirSync(path.join(TMP, 'hosted'), { recursive: true });
  combo = await startHostedCombo({
    dataDir: path.join(TMP, 'hosted'), docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    docPublicUrl: `ws://127.0.0.1:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
  });
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
  const OAC = { 'origin-agent-cluster': '?1' };
  const runtimeConfig = JSON.stringify({ v: 1, stageOrigins: STAGE_ORIGINS });
  const makeProxy = (port) => {
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
    proxies.push(server);
    return new Promise((r) => server.listen(port, '127.0.0.1', r));
  };
  await Promise.all([makeProxy(PORTS.editor), makeProxy(PORTS.stageA), makeProxy(PORTS.stageB)]);
  say('local.up', { site: SITE, stages: STAGE_ORIGINS, doc: PORTS.doc, asset: PORTS.asset, dist: DIST, ticketTtlMs: A10 ? TTL_MS : null });
}

/* ================================================================== 创建者的桌面编辑器(兼渲染节点) */

let editor = null;
const editorLog = [];
async function startEditor(sharedConfig) {
  for (const p of [PORTS.node, PORTS.node + 1, PORTS.node + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  const dir = path.join(TMP, 'editor');
  const tmp = path.join(dir, 'tmp');
  for (const d of [tmp, path.join(dir, 'data'), path.join(dir, 'card-overrides'), path.join(dir, 'projects'), path.join(dir, 'work')]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env };
  for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_NODE_PROFILE', 'PROMPTCUT_HOST_MAX_CONCURRENT', 'PROMPTCUT_TEST_CODE_VERSION',
    'PROMPTCUT_PUSH', 'PROMPTCUT_HEADLESS', 'PROMPTCUT_ROLE', 'PROMPTCUT_ASSET_URL', 'PROMPTCUT_CARD_SYNC', 'PROMPTCUT_LAN_HOST', 'VITE_PC_ONLINE', 'PROMPTCUT_TEST_ENV_FINGERPRINT']) delete env[key];
  Object.assign(env, {
    PROMPTCUT_EXPORT_DIR: dir, PROMPTCUT_DATA_DIR: path.join(dir, 'data'), PROMPTCUT_CARD_OVERRIDES: path.join(dir, 'card-overrides'),
    PROMPTCUT_PROJECTS_DIR: path.join(dir, 'projects'), PROMPTCUT_WORK_DIR: path.join(dir, 'work'), PROMPTCUT_STREAMS: '0', TEMP: tmp, TMP: tmp, TMPDIR: tmp,
    PROMPTCUT_QUEUE_NODE: '1', PROMPTCUT_SHARED_CONFIG: sharedConfig,
    PROMPTCUT_DEVICE_ID: `c10b-creator-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'c10-browser 创建者',
  });
  const child = spawn(process.execPath, [viteBin(), '--port', String(PORTS.node), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  let partial = '';
  const keep = (c) => {
    const lines = (partial + c.toString()).split(/\r?\n/);
    partial = lines.pop();
    for (const line of lines) { editorLog.push(line); if (editorLog.length > 8000) editorLog.shift(); }
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  editor = { child, origin: `http://127.0.0.1:${PORTS.node}` };
  const up = await until('创建者编辑器起来', async () => {
    if (child.exitCode !== null) throw new Error('exited');
    return fetch(`${editor.origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 240_000, 500);
  if (!up) throw new Error(`编辑器没起来:${editorLog.slice(-8).join(' | ').slice(0, 500)}`);
  say('editor.up', { origin: editor.origin, pid: child.pid });
}
const prerenderInfo = () => getJson(`${editor.origin}/api/prerender/info`, 3000);
const diag = async () => (await getJson(`${(await prerenderInfo()).url}/api/frames/diagnostics`, 20_000))?.queue ?? null;
async function stopEditor() {
  if (!editor?.child?.pid) return;
  const pre = await prerenderInfo().catch(() => null);
  killTree(editor.child.pid);
  const prePort = pre?.url ? Number(new URL(pre.url).port) : null;
  if (prePort) { const pid = pidOnPort(prePort); if (pid) killTree(pid); }
  for (const p of [PORTS.node, PORTS.node + 1, PORTS.node + 2]) { const pid = pidOnPort(p); if (pid) killTree(pid); }
  editor = null;
}

/* ================================================================== 独立渲染主机(本机替身,host 档) */

let host = null;
const hostLog = [];
async function startHost(config) {
  for (const p of [PORTS.node, PORTS.node + 1, PORTS.node + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用(主机)`);
  const env = { ...process.env, PROMPTCUT_TEST_ENV_FINGERPRINT: HOST_FP };
  delete env.PROMPTCUT_TEST_ASSET_TICKET_TTL_MS;
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'render-host.mjs'), '--config', config, '--port', String(PORTS.node), '--data', path.join(TMP, 'host')],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, env });
  const keep = (c) => { for (const line of c.toString().split(/\r?\n/)) if (line) { hostLog.push(line); if (hostLog.length > 4000) hostLog.shift(); } };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  host = { child, origin: `http://127.0.0.1:${PORTS.node}` };
  const ready = await until('独立渲染主机起来', () => hostLog.some((l) => l.includes('[render-host] ready')), 300_000, 500);
  say('host.up', { ready: !!ready, pid: child.pid });
  return ready;
}
const hostQueue = async () => (await getJson(`${host.origin}/api/frames/queue`, 10_000).catch(() => null));
async function stopHost() {
  if (!host?.child) return;
  try { host.child.send?.({ type: 'shutdown' }); } catch { /* 已退 */ }
  await Promise.race([new Promise((r) => host.child.once('exit', r)), delay(20_000)]);
  killTree(host.child.pid);
  for (const p of [PORTS.node, PORTS.node + 1, PORTS.node + 2]) { const pid = pidOnPort(p); if (pid) killTree(pid); }
  host = null;
}

/* ================================================================== 文档服务连接(Node 侧,创建者身份) */

async function mods() {
  const [route, client, shared, ws, endpoint, ticket, asset, fp] = await Promise.all([
    import('../../server/auth/route.mjs'), import('../../server/auth/client.mjs'), import('../../server/auth/shared-config.mjs'),
    import('../../server/render-node/ws-transport.mjs'), import('../../server/render-node/endpoint.mjs'),
    import('../../server/auth/ticket-source.mjs'), import('../../server/asset-store/client.mjs'), import('../../server/render-node/fingerprint.mjs'),
  ]);
  return { ...client, ...route, ...shared, ...ws, ...endpoint, ...ticket, ...asset, ...fp };
}
function rpcOn(ep) {
  const waiting = new Map();
  let seq = 0;
  ep.onMessage((m) => {
    const w = m?.reqId !== undefined ? waiting.get(m.reqId) : undefined;
    if (!w) return;
    waiting.delete(m.reqId);
    clearTimeout(w.timer);
    w.resolve(m);
  });
  return (message, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const reqId = `c10b-${++seq}-${randomBytes(3).toString('hex')}`;
    const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error(`等 ${message.type} 的回包超时`)); }, timeoutMs);
    waiting.set(reqId, { resolve, timer });
    if (!ep.send({ ...message, reqId })) { waiting.delete(reqId); clearTimeout(timer); reject(new Error(`${message.type} 没发出去`)); }
  });
}
async function openConn(M, { url, projectId, username, password, as }) {
  const entry = M.normalizeEntry({ url, projectId, username, password, as, role: 'page', deviceId: `c10b-chk-${randomBytes(6).toString('hex')}`, deviceName: 'c10-browser-probe 核对' });
  const ep = M.createWsEndpoint({ url: entry.url, protocols: M.sharedProtocols(entry, { role: 'page' }), log: () => {} });
  const opened = await new Promise((resolve) => {
    if (ep.connected) return resolve(true);
    const t = setTimeout(() => resolve(false), 20_000);
    ep.onOpen(() => { clearTimeout(t); resolve(true); });
  });
  if (!opened) { try { ep.close(); } catch { /* 没连上 */ } throw new Error('核对连接连不上文档服务'); }
  return { ep, rpc: rpcOn(ep), close: () => { try { ep.close(); } catch { /* 已关 */ } } };
}
async function adminOp(M, projectId, creator, op, fields = {}) {
  const protocols = await M.buildAuthProtocols({ base: HOSTED, projectId, username: creator.username, deviceId: `c10b-admin-${RUN}`.padEnd(16, '0'), deviceName: 'c10b admin', as: 'creator', password: creator.password, role: 'page' });
  const ws = new WebSocket(M.wsBaseOf(HOSTED), protocols);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const ask = (msg) => new Promise((resolve) => {
    const reqId = `a${Math.random().toString(36).slice(2)}`;
    const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
  const ch = await ask({ type: 'shared.challenge' });
  const key = await M.deriveKey(creator.password, ch.salt, ch.kdf);
  const m = await M.adminProof({ key, projectId, username: creator.username, op, nonce: ch.nonce });
  const r = await ask({ type: 'shared.admin', op, proof: { nonce: ch.nonce, m }, ...fields });
  ws.close();
  return r;
}

/* ================================================================== 页面小件 */

let browser = null;
async function launchBrowser() {
  const { default: puppeteer } = await import('puppeteer');
  return puppeteer.launch({
    headless: true, protocolTimeout: 900_000, defaultViewport: { width: 1600, height: 1000 },
    args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required', '--disable-gpu'],
  });
}
const P = (page, fn, ...a) => page.evaluate(fn, ...a);
const shot = async (page, name) => { const f = path.join(OUT, `${name}.png`); await page.screenshot({ path: f }).catch(() => {}); return f; };
const textOf = (page, sel) => page.$eval(sel, (el) => el.textContent ?? '').catch(() => '');
async function typeInto(page, sel, text) {
  await page.waitForSelector(sel, { visible: true, timeout: 20_000 });
  await page.click(sel);
  await page.$eval(sel, (el) => el.select());
  await page.keyboard.press('Backspace');
  if (text) await page.type(sel, text, { delay: 5 });
}

/** 新页面:记下素材服务请求(按命名空间与哈希,不记查询串)、各源的文档响应头、主文档长任务 */
async function newPage(ctx) {
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.pageErrors = [];
  page.on('pageerror', (e) => page.pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  page.consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' && page.consoleErrors.length < 60) page.consoleErrors.push(m.text().slice(0, 240)); });
  page.assets = [];
  page.on('request', (r) => {
    let u;
    try { u = new URL(r.url()); } catch { return; }
    const i = u.pathname.indexOf('/media/api/asset/');
    if (i < 0) return;
    const rest = u.pathname.slice(i + '/media/api/asset/'.length).split('/');
    let frameOrigin = null;
    try { frameOrigin = new URL(r.frame()?.url() ?? '').origin; } catch { /* 没有 frame */ }
    page.assets.push({ at: Date.now(), method: r.method(), origin: u.origin, frameOrigin, ns: rest[0], hash: rest[1] ?? '', sub: rest[2] ?? '' });
  });
  page.on('response', (res) => {
    const req = res.request();
    if (req.resourceType() !== 'document') return;
    let u;
    try { u = new URL(res.url()); } catch { return; }
    if (!u.pathname.startsWith('/editor')) return;
    docHeaders.push({ origin: u.origin, stage: u.searchParams.has('stage'), oac: res.headers()['origin-agent-cluster'] ?? null });
  });
  await page.evaluateOnNewDocument(() => {
    if (window.top !== window) return;
    window.__pcLongTasks = [];
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__pcLongTasks.push({ at: e.startTime, ms: e.duration }); }).observe({ type: 'longtask', buffered: true });
    } catch { /* 没有 longtask */ }
  });
  return page;
}
const joinMessage = (page) => textOf(page, '[data-pc="join-message"]');
const waitMembers = (page, ms = 90_000) => page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: ms });
const previewDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcPreviewDiag?.() ?? null)); } catch { return null; } }).catch(() => null);
const onlineDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcOnlineSnapshots?.() ?? null)); } catch { return null; } }).catch(() => null);
/** 编辑器页 L2 的三张表各几条 */
const l2Counts = (page) => P(page, () => new Promise((resolve) => {
  const r = indexedDB.open('promptcut-l2');
  r.onerror = () => resolve(null);
  r.onsuccess = () => {
    const db = r.result;
    const names = ['costs', 'snapshots', 'ranges'].filter((n) => db.objectStoreNames.contains(n));
    if (names.length !== 3) { db.close(); return resolve({ stores: [...db.objectStoreNames] }); }
    const tx = db.transaction(names, 'readonly');
    const outp = {};
    let left = names.length;
    for (const n of names) {
      const q = tx.objectStore(n).count();
      q.onsuccess = () => { outp[n] = q.result; if (--left === 0) { db.close(); resolve(outp); } };
      q.onerror = () => { outp[n] = -1; if (--left === 0) { db.close(); resolve(outp); } };
    }
  };
})).catch(() => null);
/** 可见舞台的 frame(按 __pcPreviewDiag 的 frontId) */
async function frontFrame(page) {
  const d = await previewDiag(page);
  const id = d?.frontId ?? 'A';
  return page.frames().find((f) => /[?&]stage=1/.test(f.url()) && new URL(f.url()).searchParams.get('id') === id) ?? null;
}
async function stageSample(page) {
  const f = await frontFrame(page);
  if (!f) return null;
  return f.evaluate(() => {
    const d = window.__pcStageDiag?.() ?? {};
    const wraps = [...document.querySelectorAll('[data-pc-clip]:not([data-pc-media])')].filter((w) => !w.parentElement?.closest('[data-pc-clip]')).map((w) => {
      const slot = w.querySelector(':scope > [data-pc-placeholder-slot]');
      const plane = w.querySelector(':scope > [data-pc-snapshot-plane]');
      return {
        id: w.getAttribute('data-pc-clip'),
        suppressed: w.classList.contains('pc-suppressed'),
        settling: w.classList.contains('pc-settling'),
        plane: !!plane,
        planeSig: plane ? `${plane.innerHTML.length}:${(plane.innerHTML.match(/translateX\([^)]*\)/) ?? [''])[0]}` : null,
        placeholder: !!slot && !slot.hidden,
      };
    });
    return { playing: !!d.beatRunning, t: d.t, wraps };
  }).catch(() => null);
}
function assetSummary(list) {
  const gets = list.filter((a) => a.method === 'GET' && !a.sub);
  return {
    px: gets.filter((a) => a.ns === 'px').length,
    snap: gets.filter((a) => a.ns === 'snap').length,
    media: gets.filter((a) => a.ns === 'media').length,
    mediaByFrameOrigin: Object.fromEntries([...new Set(gets.filter((a) => a.ns === 'media').map((a) => `${a.frameOrigin}→${a.origin}`))].map((k) => [k, gets.filter((a) => a.ns === 'media' && `${a.frameOrigin}→${a.origin}` === k).length])),
  };
}

/* ================================================================== 主流程 */

const state = {};
let M = null;
let conn = null;
try {
  M = await mods();
  await startLocalSite();
  const health = await getJson(`${SITE}/hosted/healthz`).catch((e) => ({ error: String(e?.message ?? e) }));
  if (!check(health?.ok, '托管端 /hosted/healthz', health)) throw new Error('托管端不通');

  /* ---------------------------------------------------------------- 0. 创建者建项目、放云端、预渲染 */
  const t0 = Date.now();
  const sharedConfig = path.join(TMP, 'creator-shared.json');
  await startEditor(sharedConfig);
  const pre0 = await until('预渲染进程就绪', async () => { const i = await prerenderInfo(); return i?.ready && i.url ? i.url : null; }, 240_000, 500);
  if (!pre0) throw new Error('预渲染进程没起来');
  browser = await launchBrowser();
  const creatorCtx = await browser.createBrowserContext();
  const creator = await newPage(creatorCtx);
  state.creator = creator;
  await creator.goto(`${editor.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await until('创建者页面舞台起来', () => P(creator, () => document.querySelectorAll('iframe').length >= 2 && !document.querySelector('[data-pc="probe-gate"]')), 300_000, 500);
  await P(creator, () => { for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click(); });
  const projName = `c10浏览器-${RUN}`;
  await P(creator, async (name) => { const S = await import('/src/store/project.ts'); S.actions.newProject(name); S.actions.seek(0); }, projName);
  if (VIDEO) {
    const { findFfmpeg } = await import('../../server/bakery/ffmpeg.mjs');
    const ffmpeg = await findFfmpeg();
    const video = path.join(TMP, `c10b-${RUN}.mp4`);
    const ff = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
      '-t', String(SECONDS), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-metadata', `comment=c10b-${RUN}`, video], { encoding: 'utf8', windowsHide: true });
    if (ff.status !== 0) throw new Error(`ffmpeg 出样本失败:${ff.stderr}`);
    const input = await creator.$('[data-pc="library"] input[type=file]');
    if (!input) throw new Error('找不到素材库的文件输入');
    await input.uploadFile(video);
    state.media = await until('视频入库、生成小尺寸', () => P(creator, async (fname) => {
      const S = await import('/src/store/project.ts');
      const m = S.getState().project.media.find((x) => x.name === fname && x.hash && x.tiers?.original && x.tiers?.small);
      return m ? { id: m.id, original: m.tiers.original, small: m.tiers.small } : null;
    }, path.basename(video)), 240_000, 500);
    if (!state.media) throw new Error('视频没入库');
  }
  const clips = await P(creator, async (spec) => {
    const S = await import('/src/store/project.ts');
    if (spec.mediaId) S.actions.addMediaClip(spec.mediaId, 0, { duration: spec.seconds });
    const light = S.actions.addClipOnNewTrack({ index: 0, cardId: 'chapter-bar', start: 0, duration: spec.seconds });
    const main = S.actions.addClipOnNewTrack({ index: 0, cardId: 'probe-slow-stepped', start: 0, duration: spec.seconds });
    S.actions.setClipParams(main.id, { burnMs: 40, label: 'main' });
    const extras = [];
    for (let i = 0; i < spec.extra; i++) {
      const c = S.actions.addClipOnNewTrack({ index: 0, cardId: 'probe-slow-stepped', start: 0, duration: 1 });
      S.actions.setClipParams(c.id, { burnMs: 40, label: 'x' });
      extras.push(c.id);
    }
    S.actions.seek(1);
    return { light: light?.id ?? null, main: main?.id ?? null, extras };
  }, { mediaId: state.media?.id ?? null, seconds: SECONDS, extra: EXTRA_HEAVY });
  Object.assign(state, clips);
  check(state.main && state.extras.length === EXTRA_HEAVY, '创建者放好卡片', clips);
  state.docId = await P(creator, async () => (await import('/src/store/project.ts')).getState().project.id);
  await until('创建者页面测量测完', async () => P(creator, async () => { const R = await import('/src/editor/probeRunner.ts'); return !R.probeProgress().running && !document.querySelector('[data-pc="probe-gate"]'); }), 300_000, 500);
  // 放云端
  await P(creator, () => window.dispatchEvent(new Event('pc-open-project-settings')));
  await creator.waitForSelector('[data-pc="collab-section"]', { visible: true, timeout: 20_000 });
  await creator.click('[data-pc="collab-toggle"]');
  await creator.waitForSelector('[data-pc="collab-where-hosted"]', { visible: true });
  const creatorCred = { username: await creator.$eval('#pc-collab-creator', (i) => i.value), password: await creator.$eval('#pc-collab-cpw', (i) => i.value) };
  state.creatorCred = creatorCred;
  state.projectPassword = await creator.$eval('#pc-collab-ppw', (i) => i.value);
  await creator.click('[data-pc="collab-where-hosted"]');
  await typeInto(creator, '[data-pc="collab-hosted-url"]', HOSTED);
  await creator.click('.pc-dialog-foot .pc-btn--primary');
  const enabled = await until('放云端开启完成', async () => { const t = await textOf(creator, '[data-pc="collab-status"]'); return t && !t.includes('正在设置') ? t : null; }, 90_000, 300);
  check(enabled?.includes('多用户协作已开启。'), '创建者开启「多用户协作」放云端', { status: enabled });
  await creator.waitForSelector('[data-pc="collab-invite-link"]', { timeout: 20_000 });
  state.link = (await textOf(creator, '[data-pc="collab-invite-link"]')).trim();
  await creator.keyboard.press('Escape');
  const found = await M.lookupProject({ base: HOSTED, name: projName });
  state.projectId = found.projectId;
  fs.writeFileSync(sharedConfig, JSON.stringify([{ url: M.wsBaseOf(HOSTED), projectId: state.projectId, username: creatorCred.username, password: creatorCred.password,
    as: 'creator', role: 'render', deviceId: `c10b-node-${RUN}`.padEnd(16, '0'), deviceName: 'c10-browser 渲染节点' }]));
  const oldPid = pidOnPort(Number(new URL(pre0).port));
  killTree(oldPid);
  await until('预渲染进程重启、就绪', async () => { const i = await prerenderInfo(); return i?.ready && i.url && i.url !== pre0 ? i.url : null; }, 180_000, 500);
  const q0 = await until('创建者的渲染节点连上托管端', async () => { const q = await diag(); return q?.active ? q : null; }, 180_000, 1000);
  state.creatorFp = q0?.envFingerprint ?? null;
  conn = await openConn(M, { url: M.wsBaseOf(HOSTED), projectId: state.projectId, username: creatorCred.username, password: creatorCred.password, as: 'creator' });
  // 层表 v 2:主重卡那一层带 contentKey、envFingerprint,各段清单的原尺寸齐
  const layer0 = await until('层表 v 2 列着主重卡、各段原尺寸齐', async () => {
    const r = await conn.rpc({ type: 'content.get', kind: 'snapshot-manifest', key: `layers:${state.docId}` });
    if (r?.type !== 'content.item' || r.missing) return null;
    const l = (r.body?.layers ?? []).find((x) => x.clipId === state.main);
    const ex = (r.body?.layers ?? []).filter((x) => state.extras.includes(x.clipId));
    if (!l || ex.length < EXTRA_HEAVY) return null;
    let frames = 0;
    for (let from = 0; from < l.count; from += r.body.span) {
      const m = await conn.rpc({ type: 'content.get', kind: 'snapshot-manifest', key: `${l.resultKey}:${from}-${Math.min(l.count - 1, from + r.body.span - 1)}` });
      if (m?.type !== 'content.item' || m.missing) return null;
      frames += (m.body?.frames ?? []).length;
    }
    return frames === l.count ? { v: r.body.v, contentKey: !!l.contentKey, envFingerprint: l.envFingerprint, resultKey: l.resultKey, count: l.count, extras: ex.length } : null;
  }, 1_200_000, 3000);
  check(layer0?.v === 2 && layer0.contentKey && layer0.envFingerprint, '层表 v 2,重层带 contentKey 与 envFingerprint', layer0);
  check(layer0 && layer0.envFingerprint === state.creatorFp, '层的产出环境 = 创建者节点的指纹', { layer: layer0?.envFingerprint, node: state.creatorFp });
  state.layer0 = layer0;
  out.steps.creator = { ms: Date.now() - t0, projectId: state.projectId, clips: { main: state.main, extras: state.extras.length, light: state.light }, creatorFp: state.creatorFp, layer: layer0 };
  say('step0.done', out.steps.creator);

  /* ---------------------------------------------------------------- 1. 成员(电脑浏览器,普通档)凭邀请链接进入 */
  const t1 = Date.now();
  const memberCtx = await browser.createBrowserContext();
  const member = await newPage(memberCtx);
  state.member = member;
  docHeaders.length = 0;
  await member.goto(`${EDITOR}#invite=${codeOf(state.link)}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await member.waitForSelector('[data-pc="join-invite-project"]', { visible: true, timeout: 60_000 });
  await typeInto(member, '[data-pc="join-username"]', '电脑成员');
  await member.click('[data-pc="join-submit"]');
  if (!check(await waitMembers(member).then(() => true, () => false), '成员凭邀请链接进入', { message: await joinMessage(member) })) throw new Error('成员没进去');
  // A2 第一句:首次打开在加载遮罩下测完
  let gateSeen = false;
  const gateDone = await until('成员页的加载遮罩出现又退下(测完)', async () => {
    const g = await P(member, () => !!document.querySelector('[data-pc="probe-gate"]'));
    if (g) gateSeen = true;
    const d = await previewDiag(member);
    return gateSeen && !g && d?.dual ? true : null;
  }, 300_000, 200);
  check(gateSeen && gateDone, 'A2:首次打开在加载遮罩下测完才进入编辑', { gateSeen });
  const costs1 = await l2Counts(member);
  check(costs1?.costs > 0, 'A2:L2 有 costs(成本记录以 mode=build 进 L2)', costs1);
  const costMode = await P(member, () => new Promise((resolve) => {
    const r = indexedDB.open('promptcut-l2');
    r.onsuccess = () => { const q = r.result.transaction('costs').objectStore('costs').getAll(); q.onsuccess = () => { resolve(q.result.map((x) => x.record?.mode)); r.result.close(); }; };
    r.onerror = () => resolve(null);
  })).catch(() => null);
  check(Array.isArray(costMode) && costMode.length && costMode.every((m) => m === 'build'), 'A2:成本记录 mode=build', costMode);

  // A1:两个舞台同站跨源、带 OAC
  const d1 = await previewDiag(member);
  const frames = await P(member, () => [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('src') || '').filter((s) => /[?&]stage=1/.test(s)));
  const origins = frames.map((s) => { try { return new URL(s).origin; } catch { return null; } });
  check(d1?.dual === true && frames.length === 2, 'A1:普通档开两个舞台', { dual: d1?.dual, frames: frames.length, stages: d1?.onlineStages });
  check(origins.includes(STAGE_ORIGINS[0]) && origins.includes(STAGE_ORIGINS[1]) && !origins.includes(SITE), 'A1:两个舞台与编辑器页同站跨源(各用一个源)', origins);
  const editorDoc = docHeaders.find((h) => h.origin === SITE && !h.stage);
  const stageDocs = docHeaders.filter((h) => h.stage);
  check(editorDoc?.oac === '?1' && stageDocs.length >= 2 && stageDocs.every((h) => h.oac === '?1'), 'A1:编辑器页与两个舞台页都带 Origin-Agent-Cluster: ?1', { editor: editorDoc, stages: stageDocs });
  const cdp = await member.createCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  const iframeTargets = targetInfos.filter((t) => t.type === 'iframe').map((t) => new URL(t.url).origin);
  check(STAGE_ORIGINS.every((o) => iframeTargets.includes(o)), 'A1:两个舞台各成独立的 iframe 目标(进了独立进程)', iframeTargets);
  const caps = d1?.hostCaps ?? {};
  check(['A', 'B'].every((id) => caps[id]?.measure === true && caps[id]?.catchUp === true && caps[id]?.prerender === false && caps[id]?.lowMemory === false),
    'A1:宿主能力表照实报(能测量、能追活渲,prerender 为假)', caps);
  state.pageFp = await P(member, () => {
    const c = document.createElement('canvas').getContext('webgl');
    const ext = c?.getExtension('WEBGL_debug_renderer_info');
    return { platform: navigator.platform, renderer: ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '', vendor: ext ? c.getParameter(ext.UNMASKED_VENDOR_WEBGL) : '', ua: navigator.userAgent };
  }).then((e) => M.describeEnvironment({ platform: e.platform, renderer: e.renderer, vendor: e.vendor, chromeVersion: e.ua }).fingerprint).catch(() => null);

  // A3:普通档取原尺寸
  const ready = await until('成员页主重卡的原尺寸就绪(层表 v 2、snap/ 进 L2)', async () => {
    const o = await onlineDiag(member);
    const l = o?.layers?.find((x) => x.clipId === state.main);
    return o?.tier === 'original' && o.mapVersion === 2 && l && l.ready > 0 ? { o, l } : null;
  }, 180_000, 1000);
  check(ready, 'A3:在线来源取原尺寸一档,主重卡有就绪区间', ready?.l);
  await member.bringToFront();
  await P(member, () => { const s = window.__pcStore; s.actions.seek(0); });
  await delay(4000);
  const snapBeforePlay = new Set(member.assets.filter((a) => a.ns === 'snap').map((a) => a.hash));

  // A1:播放含重卡的 10 秒时间轴:主文档长任务 0,重层按拍换快照
  await P(member, () => { window.__pcLongTasks.length = 0; });
  const beatBefore = (await previewDiag(member))?.beatSwap ?? {};
  await P(member, () => { const s = window.__pcStore; s.actions.seek(0); s.actions.play(); });
  const samples = [];
  let placeholderSeen = null;
  const tPlay = Date.now();
  while (Date.now() - tPlay < 11_500) {
    const x = await stageSample(member);
    const d = await previewDiag(member);
    if (x) samples.push({ ...x, beat: d?.beatSwap?.last ?? null });
    if (!placeholderSeen && x && x.t < 1 && d?.beatSwap?.last?.placeholder?.length) {
      const ids = d.beatSwap.last.placeholder;
      const shown = x.wraps.filter((w) => ids.includes(w.id) && w.placeholder && !w.plane);
      if (shown.length) { placeholderSeen = { t: x.t, fit: d.beatSwap.last.fit, deadMs: d.beatSwap.last.deadMs, placeholder: ids, shown: shown.map((w) => w.id) }; await shot(member, 'a4-placeholder-while-playing'); }
    }
    await delay(150);
  }
  const longTasks = await P(member, () => window.__pcLongTasks.slice());
  const beatAfter = (await previewDiag(member))?.beatSwap ?? {};
  const playing = samples.filter((s) => s.playing);
  const mainSigs = playing.filter((s) => s.t >= 1).map((s) => s.wraps.find((w) => w.id === state.main)).filter((w) => w?.suppressed && w.plane).map((w) => w.planeSig);
  check(longTasks.length === 0, 'A1:播放 10 秒,主文档长任务 0', { count: longTasks.length, worst: longTasks.sort((a, b) => b.ms - a.ms).slice(0, 3) });
  check(playing.length >= 10, 'A1:播放中采到可见舞台的样子', { samples: samples.length, playing: playing.length });
  check(new Set(mainSigs).size >= 5, 'A1:重层按拍换快照(播放中主重卡的快照平面一直在换帧)', { distinct: new Set(mainSigs).size, of: mainSigs.length });
  const deliveries = (beatAfter.deliveries ?? 0) - (beatBefore.deliveries ?? 0);
  check(deliveries >= 100 && (beatAfter.underThrottle ?? 0) > (beatBefore.underThrottle ?? 0), 'A1/L4:播放中每拍投递、不受 33 ms 节流', { deliveries, underThrottle: (beatAfter.underThrottle ?? 0) - (beatBefore.underThrottle ?? 0) });
  // A4:装不下的层显示占位
  check(placeholderSeen, 'A4:换帧预算装不下的层显示占位(0～1 秒 9 张重卡)', placeholderSeen ?? samples.filter((s) => s.t < 1).slice(0, 2).map((s) => ({ t: s.t, beat: s.beat })));
  out.steps.play = { ms: Date.now() - t1, longTasks: longTasks.length, samples: samples.length, mainDistinctFrames: new Set(mainSigs).size, deliveries, placeholder: placeholderSeen };

  // A4:暂停后追到精确活渲,占位撤下后不再盖回
  await until('播放到头停下', () => P(member, () => !window.__pcStore.getState().playing), 20_000, 300);
  await P(member, () => window.__pcStore.actions.seek(0.5));
  const settled = await until('暂停后 0.5 秒处追到精确活渲(重层不抑制、没有快照平面、没有占位)', async () => {
    const x = await stageSample(member);
    if (!x || x.playing) return null;
    const heavy = x.wraps.filter((w) => w.id === state.main || state.extras.includes(w.id));
    return heavy.length >= EXTRA_HEAVY + 1 && heavy.every((w) => !w.suppressed && !w.plane && !w.placeholder && !w.settling) ? x : null;
  }, 30_000, 300);
  check(settled, 'A4:暂停后追到精确活渲(与桌面同判据:停下就撤兜底)');
  await shot(member, 'a4-settled-live');
  await delay(3000);
  const stillLive = await stageSample(member);
  check(stillLive && stillLive.wraps.filter((w) => w.id === state.main || state.extras.includes(w.id)).every((w) => !w.suppressed && !w.plane && !w.placeholder),
    'A4:占位撤下后不再盖回(3 秒后仍是活渲)', stillLive?.wraps?.slice(0, 4));
  const pd = await previewDiag(member);
  out.steps.settle = { settled: !!settled, stillLive: !!stillLive, feedSettled: pd?.snapshotFeed?.settled?.length ?? null, backWork: pd?.backWork, probeFrames: pd?.probeFrames };
  check(pd?.probeFrames?.gzFrames > 0 && pd.probeFrames.htmlBytes === 0, 'A1/第 2 节:后台舞台的探针帧压成可转移的 ArrayBuffer 交出', pd?.probeFrames);
  check(pd?.backWork?.sent > 0 && pd.backWork.on === true, '第 2 节:后台活由父页判空闲经 RPC 发开始 / 停止', pd?.backWork);

  // A3:网络记录
  const sum1 = assetSummary(member.assets);
  check(sum1.snap > 0 && sum1.px === 0, 'A3:普通档取 snap/ 原尺寸、预渲染小尺寸请求 0', sum1);
  if (VIDEO) check(Object.keys(sum1.mediaByFrameOrigin).some((k) => STAGE_ORIGINS.some((o) => k === `${o}→${o}`)) && !Object.keys(sum1.mediaByFrameOrigin).some((k) => STAGE_ORIGINS.some((o) => k.startsWith(`${o}→`) && !k.endsWith(o))),
    '第 2 节:跨源舞台用相对地址读自己源上反代的 /media', sum1.mediaByFrameOrigin);
  const o3 = await onlineDiag(member);
  check(o3?.layers?.length && o3.layers.every((l) => l.envFingerprint === state.creatorFp), 'A3:一层只出自一种环境(层表记录的那一种)', o3?.layers?.map((l) => ({ clip: l.clipId.slice(0, 6), fp: l.envFingerprint })));
  out.steps.member = { ms: Date.now() - t1, stages: origins, iframeTargets, caps, requests: sum1, l2: costs1, pageFp: state.pageFp,
    publisher: await P(member, () => window.__pcPlanPublisher?.() ?? null).catch(() => null) };
  say('step1.done', out.steps.member);

  if (A10) {
    /* ---------------------------------------------------------------- A10. 逐帧导出跨过票据时限 */
    const t10 = Date.now();
    const frames10 = Number(arg('--export-frames', SECONDS * FPS));
    const exported = await P(member, async (n) => {
      const t = performance.now();
      const r = await window.__pcIo.exportVideoBrowser({ maxFrames: n, originals: true });
      return { ms: performance.now() - t, frames: r.result?.frames ?? null, error: r.error ?? null, waits: r.waits, renewal: r.renewal ?? null, stats: r.result?.stats ?? null };
    }, frames10);
    check(exported?.frames === frames10, 'A10:逐帧导出照常完成', exported);
    check(exported && exported.ms > TTL_MS * 1.2, 'A10:导出时长跨过票据时限', { ms: exported?.ms, ttl: TTL_MS });
    check(exported?.renewal?.renewals >= 1, 'A10:导出途中提前续签了票据', exported?.renewal);
    if (VIDEO) check(exported?.stats?.ticketSwaps > 0, 'A10:素材地址的票据跟着换', exported?.stats);
    out.steps.a10 = { ms: Date.now() - t10, ttlMs: TTL_MS, export: exported };
    say('a10.done', out.steps.a10);
  } else {
    /* ---------------------------------------------------------------- A2. 关掉再开:不重测,已在 L2 的块不再请求 */
    const t2 = Date.now();
    await P(member, () => window.__pcStore.actions.seek(1));
    await delay(4000);
    const snapHave = new Set(member.assets.filter((a) => a.ns === 'snap').map((a) => a.hash));
    const markA2 = member.assets.length;
    await member.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
    const back = await until('成员刷新后回到共享项目、双舞台就位', async () => { const d = await previewDiag(member); return d?.dual && (await P(member, () => !!document.querySelector('[data-pc="members-button"]'))) ? d : null; }, 120_000, 500);
    let gateAgain = false;
    for (let i = 0; i < 40; i++) { if (await P(member, () => !!document.querySelector('[data-pc="probe-gate"]')).catch(() => false)) gateAgain = true; await delay(250); }
    await P(member, () => window.__pcStore.actions.seek(1));
    await delay(6000);
    const refetched = member.assets.slice(markA2).filter((a) => a.ns === 'snap' && snapHave.has(a.hash));
    const costs2 = await l2Counts(member);
    check(back && !gateAgain, 'A2:关掉再开不重测(加载遮罩不再出现)', { back: !!back, gateAgain });
    check(costs2?.costs === costs1?.costs, 'A2:costs 条数不变', { before: costs1, after: costs2 });
    check(refetched.length === 0 && snapHave.size > 0, 'A2:已在 L2 的块不再请求', { have: snapHave.size, refetched: refetched.length });
    const o2 = await onlineDiag(member);
    check(o2?.l2Hits > 0, 'A2:块从 L2 读回', { l2Hits: o2?.l2Hits, snapFetches: o2?.snapFetches });
    out.steps.reopen = { ms: Date.now() - t2, gateAgain, costs: costs2, refetched: refetched.length, l2Hits: o2?.l2Hits ?? null };
    say('step2.done', out.steps.reopen);

    /* ---------------------------------------------------------------- A5. 没有节点在线时改一处不报错;独立渲染主机认领、切分、完成 */
    const t5 = Date.now();
    await creator.close().catch(() => {});
    await stopEditor();
    say('a5.creator-stopped');
    const keyBefore = (await onlineDiag(member))?.layers?.find((l) => l.clipId === state.main)?.resultKey ?? null;
    const errorsBefore = member.pageErrors.length;
    const edited = await P(member, (id) => { const s = window.__pcStore; s.actions.setClipParams(id, { label: 'main-v2' }); return s.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.params?.label; }, state.main);
    check(edited === 'main-v2', 'A5:纯在线改一处(主重卡的文字)', { edited });
    const published = await until('A5:页面发布清单计划(测量落定后、防抖)', async () => {
      const d = await P(member, () => window.__pcPlanPublisher?.() ?? null);
      const hit = d?.log?.filter((e) => e.ok).at(-1);
      return hit && d.log.filter((e) => e.ok).length >= 2 ? { ...hit, all: d.log.length } : null;
    }, 90_000, 500);
    const pubDiag = await P(member, () => window.__pcPlanPublisher?.() ?? null).catch(() => null);
    check(published && published.id.includes('#clips:') && published.state === 'open', 'A5:页面发布清单计划(plan:<项目>@<版本>#clips:…),没有节点时 open 等着', published ?? pubDiag);
    out.steps.publisher = pubDiag;
    await delay(8000);
    const toasts = await P(member, () => [...document.querySelectorAll('[data-pc="toast"], .pc-toast')].map((t) => t.textContent)).catch(() => []);
    check(member.pageErrors.length === errorsBefore && !toasts.some((t) => /失败|出错|错误/.test(t ?? '')), 'A5:没有节点在线时不报错', { pageErrors: member.pageErrors.slice(errorsBefore), toasts });
    // 独立渲染主机(host 档、测试指纹,与页面的环境不同)
    const hostConfig = path.join(TMP, 'host.json');
    fs.writeFileSync(hostConfig, JSON.stringify([{ url: M.wsBaseOf(HOSTED), projectId: state.projectId, username: '渲染主机', password: state.projectPassword,
      as: 'member', role: 'render', deviceId: `c10b-host-${RUN}`.padEnd(16, '0'), deviceName: 'c10-browser 独立渲染主机' }]));
    await startHost(hostConfig);
    const claimed = await until('A5:独立渲染主机认领清单计划并切分完成', async () => {
      const q = await hostQueue();
      const body = q?.body ?? q;
      const nodes = body?.nodes ?? [];
      const planDone = hostLog.some((l) => l.includes('plan-split') || l.includes('executor.plan'));
      return planDone && nodes.some((n) => (n.completed ?? 0) > 0) ? { nodes: nodes.map((n) => ({ nodeId: n.nodeId, claimed: n.claimed, completed: n.completed, failed: n.failed })), envFingerprint: body?.envFingerprint ?? null } : null;
    }, 900_000, 2000);
    check(claimed, 'A5:独立渲染主机(host 档)认领、切分、完成', claimed ?? hostLog.slice(-12));
    check(claimed?.envFingerprint === HOST_FP && HOST_FP !== state.pageFp && HOST_FP !== state.creatorFp, 'A5:认领的节点与页面发布方环境不同(主机用测试指纹)', { host: claimed?.envFingerprint, page: state.pageFp, creator: state.creatorFp });
    const fresh = await until('A5:页面取到主机产的新快照(层换了新键、环境是主机的,snap/ 就绪)', async () => {
      const o = await onlineDiag(member);
      const l = o?.layers?.find((x) => x.clipId === state.main);
      return l && l.resultKey !== keyBefore && l.envFingerprint === HOST_FP && l.ready > 0 ? l : null;
    }, 600_000, 2000);
    check(fresh, 'A5:页面取到新快照', fresh ?? (await onlineDiag(member))?.layers);
    await P(member, () => window.__pcStore.actions.seek(2));
    await P(member, () => { const s = window.__pcStore; s.actions.seek(2); s.actions.play(); });
    let newShown = null;
    for (let i = 0; i < 20 && !newShown; i++) {
      await delay(200);
      const x = await stageSample(member);
      const w = x?.playing ? x.wraps.find((y) => y.id === state.main) : null;
      if (w?.plane && w.suppressed) newShown = { t: x.t, planeSig: w.planeSig };
    }
    await P(member, () => window.__pcStore.actions.pause());
    const newHtml = await (await frontFrame(member))?.evaluate((id) => document.querySelector(`[data-pc-clip="${CSS.escape(id)}"] [data-pc-snapshot-plane]`)?.textContent ?? '', state.main).catch(() => '');
    check(newShown, 'A5:播放中主重卡贴着新快照', newShown);
    out.steps.a5 = { ms: Date.now() - t5, published, host: claimed, newLayer: fresh ? { resultKey: fresh.resultKey.slice(0, 12), envFingerprint: fresh.envFingerprint, ready: fresh.ready } : null, shown: newShown, planeText: newHtml?.slice(0, 40) ?? null };
    say('a5.done', out.steps.a5);
  }
} catch (e) {
  fails.push(`探针异常:${String(e?.stack ?? e).slice(0, 1200)}`);
  for (const [name, page] of [['creator', state.creator], ['member', state.member]]) if (page) await shot(page, `fatal-${name}`).catch(() => {});
} finally {
  if (state.member) out.memberDiag = { pageErrors: state.member.pageErrors?.slice(-8), consoleErrors: state.member.consoleErrors?.slice(-8) };
  let deleted = null;
  if (M && state.projectId && state.creatorCred) {
    const r = await adminOp(M, state.projectId, state.creatorCred, 'delete').catch((err) => ({ type: 'error', reason: String(err?.message ?? err) }));
    deleted = r?.type ?? null;
  }
  try { conn?.close(); } catch { /* 已关 */ }
  try { await browser?.close(); } catch { /* 已关 */ }
  try { fs.writeFileSync(path.join(OUT, 'creator-editor.log'), editorLog.join('\n')); fs.writeFileSync(path.join(OUT, 'host.log'), hostLog.join('\n')); } catch { /* 写不了 */ }
  await stopHost().catch(() => {});
  await stopEditor().catch(() => {});
  for (const s of proxies) await new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); });
  try { await combo?.close(); } catch { /* 已关 */ }
  out.cleanup = { deleted, listening: [PORTS.editor, PORTS.stageA, PORTS.stageB, PORTS.doc, PORTS.asset, PORTS.node, PORTS.node + 1, PORTS.node + 2].filter((p) => pidOnPort(p)) };
  if (!KEEP) {
    for (const d of fs.readdirSync(TMP)) {
      const p = path.join(TMP, d);
      if (path.resolve(p) === OUT) continue;
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 句柄还没放 */ }
    }
  }
  out.ms = Date.now() - started;
  out.fails = fails;
  out.ok = fails.length === 0;
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
