/**
 * C10a 验收的演示探针(契约 `docs/plan/c10a-contract.md` 第 12 节「本机替身跑 demo」「低内存档逐帧导出一段」)。
 * 复用 `online-join-probe.mjs`(托管组合、nginx 形状的代理、加入表单、重新生成邀请码)、`lowmem-online-probe.mjs`
 * (手机仿真、请求记录、逐帧导出)、`c66-t9-probe.mjs`(创建者兼渲染节点、重卡片段的人工钉死、plan 落定)的做法。
 *
 *   node scripts/probes/c10a-demo-probe.mjs [--site <源>] [--local] [--out <目录>]
 *        [--dist <在线构建目录>]   只对 --local;不给就现场 `vite build --mode online` 到临时目录
 *        [--port 5660]            创建者桌面编辑器(另占 +1、+2 当舞台端口)
 *        [--proxy-port 5663] [--doc-port 5664] [--asset-port 5665]   只对 --local
 *        [--export-seconds 10] [--timeout-min 50] [--keep-temp]
 *        [--hold-min N] [--debug-port P]   排障:第 2 步之后停 N 分钟;浏览器开远程调试端口(本机替身用 5667)
 *
 * - `--site` 缺省 `https://8-219-80-16.sslip.io`:页面取 `<源>/editor`,文档服务 `<源>/hosted/`,素材服务 `<源>/media/api/asset`。
 * - `--local`:本机替身。起本机托管组合(只绑 127.0.0.1)与 nginx 形状的代理(`/editor` 给在线构建,`/hosted/`、`/media/` 反代),
 *   页面与服务同源,源就是代理 `http://127.0.0.1:<proxy-port>`。
 * - 不打印令牌、口令、邀请码原文:结果里邀请码只写前 4 位与长度;请求记录只记路径(去掉查询串里的票据)。
 *
 * 流程:
 *   1. 创建者兼渲染节点:本机起桌面版 dev server(数据目录与改动层临时,`PROMPTCUT_QUEUE_NODE=1`,`PROMPTCUT_SHARED_CONFIG`
 *      指向一个此刻还不存在的文件 —— 预渲染进程先不连);页面新建项目,经素材库导入一段带声音的视频(`?tiers=1`,本机生成小尺寸),
 *      放一张轻卡(拿页面测量写成本记录用的 device 串),按成本记录的「人工钉死」给重卡片段的两个版本(改前、改后)写记录,
 *      再放重卡片段(`probe-typewriter`,审阅过的独立推帧卡、共享档);项目设置里勾「多用户协作」放云端,取邀请链接;
 *      之后写渲染用的共享配置(创建者身份、`role: 'render'`)、结束预渲染进程让编辑器照常重启它(重启后读到配置、连上项目,
 *      重放 preload);等两档素材上云、plan 切出的细任务全部落定、层表与清单(含小尺寸)写进内容库。
 *   2. 手机成员:Chrome 移动端仿真(手机视口、触屏、`deviceMemory: 4`)打开邀请链接,只填用户名加入;断言判为低内存档
 *      (进入提示、只有一个同源舞台)、网络记录里视频只有小尺寸、预渲染只有 `px/` 小位图、没有原尺寸与 `snap/`;截图。
 *   3. 在手机上改一处(重卡片段的参数换成已钉死的第二个版本):创建方的渲染节点认领重渲,新的预渲染小尺寸(新的 `px/` 哈希)
 *      回到手机页面;记下时长。
 *   4. 低内存档逐帧导出:先在手机上造一个缺原尺寸的素材片段,导出提示「等待上传方」、不出片;删掉它后导出 `--export-seconds` 秒,
 *      ffprobe 核对帧数、时长、编码;这一段的请求记录里用的是素材原尺寸与预渲染原尺寸(`snap/`)。
 *   5. 作废邀请码:创建者「作废并重新生成」,旧链接给表 A 的失效文案,新链接能进。
 *   6. 桌面版开始页:同一项目用桌面版的加入表单进一次(手填、粘贴邀请链接两条)。
 *   7. 收尾:以创建者身份 `delete` 云端项目,结束自己起的进程,删临时目录。
 *
 * 输出:过程写 stderr(一行一条 JSON);stdout 最后一行是一行 JSON `{ ok, fails, … }`,`ok` 为假时退出码 1。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
const LOCAL = argv.includes('--local');
const KEEP = argv.includes('--keep-temp');
const PORT = Number(arg('--port', 5660));
const PROXY_PORT = Number(arg('--proxy-port', 5663));
const DOC_PORT = Number(arg('--doc-port', 5664));
const ASSET_PORT = Number(arg('--asset-port', 5665));
const EXPORT_SECONDS = Number(arg('--export-seconds', 10));
const TIMEOUT_MS = Number(arg('--timeout-min', 50)) * 60_000;
const FPS = 30;
const CLIP_SECONDS = Math.max(EXPORT_SECONDS, 4);
const HEAVY_CARD = 'probe-typewriter';
const LIGHT_CARD = 'chapter-bar';
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const SITE = LOCAL ? `http://127.0.0.1:${PROXY_PORT}` : String(arg('--site', 'https://8-219-80-16.sslip.io')).replace(/\/+$/, '');
const HOSTED = `${SITE}/hosted/`;
const EDITOR = `${SITE}/editor`;
const ASSET_PREFIX = '/media/api/asset/';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-c10a-demo-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'shots')));
fs.mkdirSync(OUT, { recursive: true });
const started = Date.now();
const deadline = started + TIMEOUT_MS;

const fails = [];
const out = { ok: false, run: RUN, mode: LOCAL ? 'local' : 'site', site: SITE, out: OUT, steps: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 400)}`)); return !!cond; };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** 邀请码只写前 4 位与长度 */
const codeOf = (link) => String(link ?? '').split('invite=')[1] ?? '';
const redactInvite = (link) => { const c = codeOf(link); return c ? { prefix: c.slice(0, 4), length: c.length } : null; };

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
/** 在某个端口上监听的进程号(只用来结束本探针起的编辑器的预渲染子进程) */
function pidOnPort(port) {
  if (process.platform === 'win32') {
    const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
      if (m && Number(m[1]) === port) return Number(m[2]);
    }
    return null;
  }
  const r = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return Number(r.stdout.trim().split(/\s+/)[0]) || null;
}

/* ================================================================== 本机替身:托管组合 + nginx 形状的代理 */

let combo = null;
let proxy = null;
const proxyStats = { hostedNoSlash: 0 };
async function startLocalSite() {
  for (const p of [PROXY_PORT, DOC_PORT, ASSET_PORT]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
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
    dataDir: path.join(TMP, 'hosted'), docPort: DOC_PORT, assetPort: ASSET_PORT, host: '127.0.0.1',
    docPublicUrl: `ws://127.0.0.1:${PROXY_PORT}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
  });
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
  const forward = (req, res, port, strip) => {
    const target = req.url.slice(strip.length) || '/';
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: target.startsWith('/') ? target : `/${target}`, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.statusCode = 502; res.end('bad gateway'); });
    req.pipe(up);
  };
  // `/hosted`(不带斜杠)也放行,但记数:桌面版的 route.wsBaseOf 会去掉末尾斜杠(见报告「演示探针」)
  const isHosted = (p) => { if (p === '/hosted') { proxyStats.hostedNoSlash++; return true; } return p.startsWith('/hosted/'); };
  proxy = http.createServer((req, res) => {
    const url = new URL(req.url, SITE);
    if (isHosted(url.pathname)) return forward(req, res, DOC_PORT, '/hosted');
    if (url.pathname.startsWith('/media/')) return forward(req, res, ASSET_PORT, '/media');
    const sec = { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
    const sendFile = (file, cache) => {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache, ...sec });
      fs.createReadStream(file).pipe(res);
    };
    const index = path.join(DIST, 'index.html');
    if (url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html') return sendFile(index, 'no-store');
    if (url.pathname.startsWith('/editor/assets/')) {
      const f = path.join(DIST, decodeURIComponent(url.pathname.slice('/editor/'.length)));
      if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404, sec); return res.end('not found'); }
      return sendFile(f, 'public, max-age=31536000, immutable');
    }
    if (url.pathname.startsWith('/editor/')) return sendFile(index, 'no-store');
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  proxy.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, SITE);
    if (!isHosted(url.pathname)) return socket.destroy();
    const target = (url.pathname.slice('/hosted'.length) || '/') + url.search;
    const up = net.connect(DOC_PORT, '127.0.0.1', () => {
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
  await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
  say('local.up', { site: SITE, docPort: DOC_PORT, assetPort: ASSET_PORT, dist: DIST });
}

/* ================================================================== 创建者的桌面编辑器 */

let editor = null;
const editorLog = [];
async function startEditor(sharedConfig) {
  for (const p of [PORT, PORT + 1, PORT + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  const dir = path.join(TMP, 'editor');
  const tmp = path.join(dir, 'tmp');
  for (const d of [tmp, path.join(dir, 'data'), path.join(dir, 'card-overrides'), path.join(dir, 'projects'), path.join(dir, 'work')]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env };
  for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_NODE_PROFILE', 'PROMPTCUT_HOST_MAX_CONCURRENT', 'PROMPTCUT_TEST_CODE_VERSION',
    'PROMPTCUT_PUSH', 'PROMPTCUT_HEADLESS', 'PROMPTCUT_ROLE', 'PROMPTCUT_ASSET_URL', 'PROMPTCUT_CARD_SYNC', 'PROMPTCUT_LAN_HOST', 'VITE_PC_ONLINE']) delete env[key];
  Object.assign(env, {
    PROMPTCUT_EXPORT_DIR: dir, PROMPTCUT_DATA_DIR: path.join(dir, 'data'), PROMPTCUT_CARD_OVERRIDES: path.join(dir, 'card-overrides'),
    PROMPTCUT_PROJECTS_DIR: path.join(dir, 'projects'), PROMPTCUT_WORK_DIR: path.join(dir, 'work'), PROMPTCUT_STREAMS: '0', TEMP: tmp, TMP: tmp, TMPDIR: tmp,
    PROMPTCUT_QUEUE_NODE: '1', PROMPTCUT_SHARED_CONFIG: sharedConfig,
    PROMPTCUT_DEVICE_ID: `c10ademo-a-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'c10a-demo 创建者',
  });
  const child = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  let partial = '';
  const keep = (c) => {
    const lines = (partial + c.toString()).split(/\r?\n/);
    partial = lines.pop();
    for (const line of lines) { editorLog.push(line); if (editorLog.length > 8000) editorLog.shift(); }
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  editor = { child, origin: `http://127.0.0.1:${PORT}` };
  const up = await until('创建者编辑器起来', async () => {
    if (child.exitCode !== null) throw new Error('exited');
    return fetch(`${editor.origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 240_000, 500);
  if (!up) throw new Error(`编辑器没起来:${editorLog.slice(-8).join(' | ').slice(0, 500)}`);
  say('editor.up', { origin: editor.origin, pid: child.pid });
}
const prerenderInfo = () => getJson(`${editor.origin}/api/prerender/info`, 3000);
const diag = async () => (await getJson(`${(await prerenderInfo()).url}/api/frames/diagnostics`, 20_000))?.queue ?? null;

/* ================================================================== 文档服务连接(Node 侧,创建者身份) */

async function mods() {
  const [route, client, shared, ws, endpoint, ticket, asset] = await Promise.all([
    import('../../server/auth/route.mjs'), import('../../server/auth/client.mjs'), import('../../server/auth/shared-config.mjs'),
    import('../../server/render-node/ws-transport.mjs'), import('../../server/render-node/endpoint.mjs'),
    import('../../server/auth/ticket-source.mjs'), import('../../server/asset-store/client.mjs'),
  ]);
  return { ...client, ...route, ...shared, ...ws, ...endpoint, ...ticket, ...asset, createSharedProject: route.createSharedProject };
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
    const reqId = `demo-${++seq}-${randomBytes(3).toString('hex')}`;
    const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error(`等 ${message.type} 的回包超时`)); }, timeoutMs);
    waiting.set(reqId, { resolve, timer });
    if (!ep.send({ ...message, reqId })) { waiting.delete(reqId); clearTimeout(timer); reject(new Error(`${message.type} 没发出去`)); }
  });
}
async function openConn(M, { url, projectId, username, password, as }) {
  const entry = M.normalizeEntry({ url, projectId, username, password, as, role: 'page', deviceId: `c10ademo-chk-${randomBytes(6).toString('hex')}`, deviceName: 'c10a-demo-probe 核对' });
  const ep = M.createWsEndpoint({ url: entry.url, protocols: M.sharedProtocols(entry, { role: 'page' }), log: () => {} });
  const opened = await new Promise((resolve) => {
    if (ep.connected) return resolve(true);
    const t = setTimeout(() => resolve(false), 20_000);
    ep.onOpen(() => { clearTimeout(t); resolve(true); });
  });
  if (!opened) { try { ep.close(); } catch { /* 没连上 */ } throw new Error('核对连接连不上文档服务'); }
  const assetUrl = await new Promise((resolve) => {
    const t = setTimeout(() => { stop(); resolve(null); }, 15_000);
    const stop = M.watchServiceEndpoints(ep, ['asset'], (list) => {
      const u = list.find((e) => e.kind === 'asset' && Array.isArray(e.urls) && e.urls.length)?.urls[0];
      if (u) { clearTimeout(t); stop(); resolve(u); }
    });
  });
  const rpc = rpcOn(ep);
  const client = M.createAssetClient({ base: assetUrl, ticket: M.createTicketSource(ep, { access: 'r' }) });
  return { ep, rpc, assetUrl, client, close: () => { try { ep.close(); } catch { /* 已关 */ } } };
}
/** 创建者操作(作废、删除):一条带证明的一次性连接 */
async function adminOp(M, projectId, creator, op, fields = {}) {
  const protocols = await M.buildAuthProtocols({ base: HOSTED, projectId, username: creator.username, deviceId: `c10ademo-admin-${RUN}`.padEnd(16, '0'), deviceName: 'c10a-demo admin', as: 'creator', password: creator.password, role: 'page' });
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
    headless: true, protocolTimeout: 900_000, defaultViewport: { width: 1440, height: 900 },
    args: [...(arg('--debug-port', null) ? [`--remote-debugging-port=${arg('--debug-port', null)}`] : []), '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
      ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : [])],
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

/** 新的浏览器上下文(本地存储各一份 = 各是一台设备);手机仿真时注入 deviceMemory 4、记下素材服务请求 */
async function newPage({ mobile = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.pageErrors = [];
  page.on('pageerror', (e) => page.pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  page.consoleErrors = [];
  page.badResponses = [];
  page.on('response', (res) => { if (res.status() >= 400 && page.badResponses.length < 40) { try { const u = new URL(res.url()); page.badResponses.push(`${res.status()} ${u.pathname.slice(0, 120)}`); } catch { /* 不是地址 */ } } });
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warn') && page.consoleErrors.length < 40) page.consoleErrors.push(`${m.type()}: ${m.text()}`.slice(0, 240)); });
  page.assets = [];
  if (mobile) {
    await page.emulate({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      viewport: { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false },
    });
    await page.evaluateOnNewDocument(() => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 4 }); });
    // 只记路径(查询串里有票据,不记)
    page.on('request', (r) => {
      let u;
      try { u = new URL(r.url()); } catch { return; }
      if (u.origin !== new URL(SITE).origin || !u.pathname.startsWith(ASSET_PREFIX)) return;
      const rest = u.pathname.slice(ASSET_PREFIX.length).split('/');
      page.assets.push({ at: Date.now(), method: r.method(), ns: rest[0], hash: rest[1] ?? '', sub: rest[2] ?? '' });
    });
  }
  page.close$ = () => ctx.close();
  return page;
}
/** 素材服务请求摘要:按命名空间分,`media/<hash>` 的取字节请求按哈希分档 */
function assetSummary(list, { small = new Set(), original = new Set() } = {}) {
  const gets = list.filter((a) => a.method === 'GET' && !a.sub);
  const media = gets.filter((a) => a.ns === 'media');
  return {
    mediaSmall: media.filter((a) => small.has(a.hash)).length,
    mediaOriginal: media.filter((a) => original.has(a.hash)).length,
    mediaOther: media.filter((a) => !small.has(a.hash) && !original.has(a.hash)).length,
    px: gets.filter((a) => a.ns === 'px').length,
    snap: gets.filter((a) => a.ns === 'snap').length,
    chunks: list.filter((a) => a.sub === 'chunks').length,
  };
}
const joinMessage = (page) => textOf(page, '[data-pc="join-message"]');
const waitMembers = (page, ms = 90_000) => page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: ms });

/* ================================================================== 主流程 */

const state = {};
let M = null;
let conn = null;
try {
  M = await mods();
  if (LOCAL) await startLocalSite();
  const health = await getJson(`${SITE}/hosted/healthz`).catch((e) => ({ error: String(e?.message ?? e) }));
  if (!check(health?.ok, '托管端 /hosted/healthz', health)) throw new Error('托管端不通');

  /* ---------------------------------------------------------------- 1. 创建者兼渲染节点 */
  const t1 = Date.now();
  const { findFfmpeg } = await import('../../server/bakery/ffmpeg.mjs');
  const ffmpeg = await findFfmpeg();
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));
  const video = path.join(TMP, `demo-${RUN}.mp4`);
  const ff = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
    '-t', String(CLIP_SECONDS), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-metadata', `comment=c10a-demo-${RUN}`, video], { encoding: 'utf8', windowsHide: true });
  if (ff.status !== 0) throw new Error(`ffmpeg 出样本失败:${ff.stderr}`);
  const sharedConfig = path.join(TMP, 'creator-shared.json'); // 放云端之后才写
  await startEditor(sharedConfig);
  const pre0 = await until('预渲染进程就绪', async () => { const i = await prerenderInfo(); return i?.ready && i.url ? i.url : null; }, 240_000, 500);
  if (!pre0) throw new Error('预渲染进程没起来');
  browser = await launchBrowser();
  const creator = await newPage();
  state.creator = creator;
  await creator.goto(`${editor.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await until('创建者页面舞台起来、测量遮罩退下', () => P(creator, () => document.querySelectorAll('iframe').length >= 2 && !document.querySelector('[data-pc="probe-gate"]')), 300_000, 500);
  await P(creator, () => { for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click(); });
  const projName = `c10a演示-${RUN}`;
  await P(creator, async (name) => { const S = await import('/src/store/project.ts'); S.actions.newProject(name); S.actions.seek(0); }, projName);
  // 经素材库的文件输入导入(页面导入路径,?tiers=1:本机生成小尺寸)
  const input = await creator.$('[data-pc="library"] input[type=file]');
  if (!input) throw new Error('找不到素材库的文件输入');
  await input.uploadFile(video);
  const media = await until('视频入库、生成小尺寸', () => P(creator, async (fname) => {
    const S = await import('/src/store/project.ts');
    const m = S.getState().project.media.find((x) => x.name === fname && x.hash && x.tiers?.original && x.tiers?.small);
    return m ? { id: m.id, original: m.tiers.original, small: m.tiers.small } : null;
  }, path.basename(video)), 240_000, 500);
  if (!media) throw new Error('视频没入库或没生成小尺寸');
  state.media = media;
  const lightClip = await P(creator, async (spec) => {
    const S = await import('/src/store/project.ts');
    const p = S.getState().project;
    if (!p.tracks.some((t) => t.clips.some((c) => c.mediaId === spec.mediaId))) S.actions.addMediaClip(spec.mediaId, 0, { duration: spec.seconds });
    const c = S.actions.addClipOnNewTrack({ index: 0, cardId: spec.light, start: 0, duration: spec.seconds });
    S.actions.seek(0);
    return c?.id ?? null;
  }, { mediaId: media.id, seconds: CLIP_SECONDS, light: LIGHT_CARD });
  // 页面测量写成本记录;从轻卡那条记录上取页面的 device 串(同 T9)
  let idleSince = null;
  await until('创建者页面测量测完', async () => {
    const idle = await P(creator, async () => { const R = await import('/src/editor/probeRunner.ts'); return !R.probeProgress().running && !document.querySelector('[data-pc="probe-gate"]'); }).catch(() => false);
    if (!idle) { idleSince = null; return false; }
    idleSince ??= Date.now();
    return Date.now() - idleSince >= 1500;
  }, 300_000, 250);
  const salts = [`demo-${RUN}-v1`, `demo-${RUN}-v2`];
  const keys = await P(creator, async (spec) => {
    const S = await import('/src/store/project.ts');
    const I = await import('/src/editor/costIdentity.ts');
    const R = await import('/src/kernel/registry.ts');
    const p = S.getState().project;
    const def = R.getCard(spec.heavy);
    const clips = spec.salts.map((salt, i) => ({ id: `demo-pin-${i}`, cardId: spec.heavy, start: 0, end: spec.seconds, params: { ...(def?.defaults ?? {}), probeSalt: salt } }));
    I.resetClipIdentityCache();
    const syn = I.clipIdentityOf({ ...p, tracks: [...p.tracks, { id: 'demo-pin-track', name: 'pin', clips }] }).identityKeys;
    I.resetClipIdentityCache();
    const own = I.clipIdentityOf(S.getState().project).identityKeys;
    return { heavy: clips.map((c) => syn[c.id] ?? null), light: own[spec.lightClip] ?? null };
  }, { heavy: HEAVY_CARD, salts, seconds: CLIP_SECONDS, lightClip });
  const costs = (await getJson(`${editor.origin}/api/data/costs`))?.costs ?? [];
  const lightRec = costs.find((r) => r.identityKey === keys.light) ?? null;
  if (!check(keys.heavy.every(Boolean) && lightRec?.device, '算出重卡片段两个版本的成本身份、拿到页面的 device 串', { keys: keys.heavy.map((k) => !!k), light: !!lightRec })) throw new Error('钉不住重卡片段');
  const pins = keys.heavy.map((identityKey) => ({ identityKey, device: lightRec.device, ...(lightRec.mode ? { mode: lightRec.mode } : {}), fps: FPS, pinnedHeavy: true, measuredAt: Date.now(), note: 'c10a-demo-probe 人工钉死' }));
  const pinPut = await fetch(`${editor.origin}/api/data/costs`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: pins }) }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
  check(pinPut?.ok, '写入重卡片段的钉死记录', pinPut);
  await until('预渲染进程收到钉死记录', async () => {
    const c = (await getJson(`${(await prerenderInfo()).url}/api/data/costs`, 5000))?.costs ?? [];
    return keys.heavy.every((k) => c.some((r) => r.identityKey === k && r.pinnedHeavy === true)) || null;
  }, 30_000);
  const heavyClip = await P(creator, async (spec) => {
    const S = await import('/src/store/project.ts');
    const c = S.actions.addClipOnNewTrack({ index: 0, cardId: spec.heavy, start: 0, duration: spec.seconds });
    if (c) S.actions.setClipParams(c.id, { probeSalt: spec.salt });
    S.actions.seek(1);
    return c?.id ?? null;
  }, { heavy: HEAVY_CARD, seconds: CLIP_SECONDS, salt: salts[0] });
  if (!heavyClip) throw new Error('没放上重卡片段');
  state.heavyClip = heavyClip;
  // 层表按项目文档的 id 记(`layers:<project.id>`,渲染节点写、在线页面读),不是共享项目号
  state.docId = await P(creator, async () => (await import('/src/store/project.ts')).getState().project.id);
  await shot(creator, '1-creator-project');

  // 项目设置里勾「多用户协作」放云端
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
  check(enabled?.includes('多用户协作已开启。'), '项目设置里开启「多用户协作」放云端', { status: enabled });
  await creator.waitForSelector('[data-pc="collab-invite-link"]', { timeout: 20_000 });
  state.link = (await textOf(creator, '[data-pc="collab-invite-link"]')).trim();
  check(state.link.startsWith(`${EDITOR}#invite=`) && /#invite=[A-Za-z0-9_-]{43}$/.test(state.link), '邀请链接是 <源>/editor#invite=<43 位>', redactInvite(state.link));
  await shot(creator, '1-creator-invite');
  await creator.keyboard.press('Escape');
  const found = await M.lookupProject({ base: HOSTED, name: projName });
  state.projectId = found.projectId;
  // 渲染用的共享配置(创建者身份、role: render),结束预渲染进程让编辑器照常重启它
  fs.writeFileSync(sharedConfig, JSON.stringify([{ url: M.wsBaseOf(HOSTED), projectId: state.projectId, username: creatorCred.username, password: creatorCred.password,
    as: 'creator', role: 'render', deviceId: `c10ademo-node-${RUN}`.padEnd(16, '0'), deviceName: 'c10a-demo 渲染节点' }]));
  const oldPort = Number(new URL(pre0).port);
  const oldPid = pidOnPort(oldPort);
  check(oldPid, '找到预渲染进程(按它的端口)', { port: oldPort });
  killTree(oldPid);
  const pre1 = await until('预渲染进程重启、就绪', async () => { const i = await prerenderInfo(); return i?.ready && i.url && i.url !== pre0 ? i.url : null; }, 180_000, 500);
  const q0 = await until('本机队列节点连上托管端并报到', async () => { const q = await diag(); return q?.active ? q : null; }, 180_000, 1000);
  check(q0?.active, '创建者的渲染节点连上托管端', q0 ? { connected: q0.connected } : null);
  // 两档素材上云(开启前导入的素材由开启时的按哈希入队交给上传队列)
  conn = await openConn(M, { url: M.wsBaseOf(HOSTED), projectId: state.projectId, username: creatorCred.username, password: creatorCred.password, as: 'creator' });
  check(conn.assetUrl && new URL(conn.assetUrl).origin === new URL(SITE).origin, '素材服务与页面同源', { assetUrl: conn.assetUrl });
  const upTiers = await until('素材两档都传到托管端', async () => {
    const [s, o] = await Promise.all([conn.client.chunks('media', media.small).catch(() => null), conn.client.chunks('media', media.original).catch(() => null)]);
    return s?.complete && o?.complete ? true : null;
  }, 300_000, 1000);
  check(upTiers, '开启前导入的视频两档都上到托管端');
  // 预渲染:plan 切出的细任务全部落定;层表与清单(含小尺寸)在内容库
  const settled = await waitPlanSettled('首次预渲染', new Set());
  const layers = await until('层表列着重卡片段、清单带小尺寸、小位图在素材服务上', () => heavyLayer(), 300_000, 2000);
  state.layer0 = layers;
  check(layers?.smallCount > 0, '预渲染小尺寸推到素材服务', layers ? { key: layers.key.slice(0, 12), frames: layers.frames, small: layers.smallCount } : state.layerWhy);
  out.steps.creator = { ms: Date.now() - t1, project: { name: projName, projectId: state.projectId }, media: { small: media.small.slice(0, 12), original: media.original.slice(0, 12) },
    invite: redactInvite(state.link), plan: settled, prerenderRestarted: !!pre1, heavy: layers ? { key: layers.key.slice(0, 12), frames: layers.frames, small: layers.smallCount } : null };
  say('step1.done', out.steps.creator);

  /* ---------------------------------------------------------------- 2. 手机成员 */
  const t2 = Date.now();
  const phone = await newPage({ mobile: true });
  state.phone = phone;
  await phone.goto(`${EDITOR}#invite=${codeOf(state.link)}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await phone.waitForSelector('[data-pc="join-invite-project"]', { visible: true, timeout: 60_000 });
  check(!(await phone.$('[data-pc="join-password"]')), '凭邀请链接只要用户名');
  await shot(phone, '2-phone-invite-form');
  await typeInto(phone, '[data-pc="join-username"]', '手机成员');
  await phone.click('[data-pc="join-submit"]');
  const joined = await waitMembers(phone).then(() => true, () => false);
  if (!check(joined, '手机凭邀请链接进入', { message: await joinMessage(phone) })) throw new Error('手机没进去');
  const lowToast = await until('手机判为低内存档(进入提示)', () => P(phone, () => document.body.innerText.includes('当前是低内存档')), 20_000, 300);
  const frames = await P(phone, () => [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('src') || '').filter((s) => /[?&]stage=1/.test(s)));
  check(lowToast, '手机判为低内存档:出现表 C 的进入提示');
  check(frames.length === 1 && /[?&]preview=stage/.test(frames[0]), '手机只有一个同源舞台(live 变体)', frames);
  const smallShown = await until('手机上重卡贴着预渲染小尺寸', async () => {
    const f = phone.frames().find((x) => /[?&]stage=1/.test(x.url()));
    return f ? f.evaluate(() => !!document.querySelector('img[data-pc-small-snapshot]')) : false;
  }, 120_000, 1000);
  check(smallShown, '手机上重卡显示预渲染小尺寸位图', smallShown ? undefined : await stageDiag(phone));
  await P(phone, () => { const s = window.__pcStore; s.actions.seek(0); s.actions.play(); });
  await delay(3000);
  await P(phone, () => { const s = window.__pcStore; s.actions.pause(); s.actions.seek(2.5); });
  await delay(2000);
  const tier = { small: new Set([media.small]), original: new Set([media.original]) };
  const sum2 = assetSummary(phone.assets, tier);
  check(sum2.mediaSmall > 0 && sum2.mediaOriginal === 0 && sum2.mediaOther === 0, '手机:视频只有小尺寸请求', sum2);
  check(sum2.px > 0 && sum2.snap === 0, '手机:预渲染只有 px/ 小位图、没有 snap/', sum2);
  const phoneShot = await shot(phone, '2-phone-lowmem');
  out.steps.phone = { ms: Date.now() - t2, lowMemoryToast: !!lowToast, stageFrames: frames.length, smallShown: !!smallShown, requests: sum2, shot: phoneShot,
    online: await P(phone, () => { try { const d = window.__pcOnlineSnapshots?.(); return d ? { layers: d.layers?.length ?? 0, smallFetches: d.smallFetches ?? null } : null; } catch { return null; } }) };
  say('step2.done', out.steps.phone);
  // 排障:--hold-min N 在这里停 N 分钟(配 --debug-port 从外面连上浏览器看)
  if (Number(arg('--hold-min', 0)) > 0) { say('hold', { minutes: Number(arg('--hold-min', 0)) }); await delay(Number(arg('--hold-min', 0)) * 60_000); }

  /* ---------------------------------------------------------------- 3. 手机上改一处,渲染节点重渲,新的小尺寸回到手机 */
  const t3 = Date.now();
  const pxBefore = new Set(phone.assets.filter((a) => a.ns === 'px').map((a) => a.hash));
  const keyBefore = state.layer0?.key ?? null;
  const edited = await P(phone, (spec) => {
    const s = window.__pcStore;
    s.actions.setClipParams(spec.id, { probeSalt: spec.salt });
    return s.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === spec.id)?.params?.probeSalt ?? null;
  }, { id: heavyClip, salt: salts[1] });
  check(edited === salts[1], '手机上改了重卡片段的参数', { edited: edited === salts[1] });
  const creatorSaw = await until('创建者那边收到手机的修改', () => P(creator, async (spec) => {
    const S = await import('/src/store/project.ts');
    return S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === spec.id)?.params?.probeSalt === spec.salt;
  }, { id: heavyClip, salt: salts[1] }), 30_000, 300);
  check(creatorSaw, '修改经文档服务到了创建者');
  // 手机这边层表里重卡的键换了(渲染节点重渲、写了新层表),之后取到的 px/ 小位图是新的
  const phoneKey = () => P(phone, (id) => (window.__pcOnlineSnapshots?.()?.layers ?? []).find((l) => l.clipId === id)?.key ?? null, heavyClip).catch(() => null);
  const keyAtStart = await phoneKey();
  let keyChangedAt = null;
  const newPx = await until('新的预渲染小尺寸回到手机(新键下的 px/ 小位图)', async () => {
    const k = await phoneKey();
    if (!keyChangedAt && k && k !== keyAtStart) keyChangedAt = Date.now();
    if (!keyChangedAt) return null;
    const fresh = phone.assets.filter((a) => a.ns === 'px' && a.method === 'GET' && !a.sub && !pxBefore.has(a.hash) && a.at >= keyChangedAt - 1000);
    return fresh.length ? { keyMs: keyChangedAt - t3, first: fresh[0].at - t3, count: fresh.length } : null;
  }, 900_000, 1000);
  check(newPx, '手机收到重渲后的新小尺寸');
  // 整段重渲完:内容库里新键下每一段清单都在、小位图都在素材服务上
  const layer1 = await until('重渲整段完成(新键下的清单与小位图齐全)', async () => { const l = await heavyLayer(); return l && l.key !== keyBefore ? l : null; }, 900_000, 2000);
  check(layer1, '层表里重卡片段换了新的键、整段重渲完成', { before: keyBefore?.slice(0, 12), after: layer1?.key?.slice(0, 12), why: layer1 ? undefined : state.layerWhy });
  await shot(phone, '3-phone-after-edit');
  out.steps.edit = { ms: Date.now() - t3, newKeyMs: newPx?.keyMs ?? null, newSmallMs: newPx?.first ?? null, newPxRequests: newPx?.count ?? 0, fullRerenderMs: layer1 ? Date.now() - t3 : null,
    keyChanged: !!layer1, newKey: layer1 ? { key: layer1.key.slice(0, 12), frames: layer1.frames, small: layer1.smallCount } : null };
  say('step3.done', out.steps.edit);

  /* ---------------------------------------------------------------- 4. 低内存档逐帧导出 */
  const t4 = Date.now();
  // 4a. 造一个缺原尺寸的素材片段:导出前核对要提示「等待上传方」、不出片
  const fakeHash = sha256(Buffer.from(`c10a-demo-missing-${RUN}`));
  const fakeName = `缺原尺寸-${RUN}.mp4`;
  const fake = await P(phone, (spec) => {
    const s = window.__pcStore;
    const m = s.actions.addMedia({ kind: 'video', name: spec.name, url: `/@media/${spec.hash}`, hash: spec.hash, ext: 'mp4', tiers: { original: spec.hash }, duration: 2 });
    const c = s.actions.addClipOnNewTrack({ index: 0, mediaId: m.id, start: 0, duration: 2 });
    return { mediaId: m.id, clipId: c?.id ?? null };
  }, { name: fakeName, hash: fakeHash });
  const blocked = await P(phone, async () => {
    const r = await window.__pcIo.exportVideoBrowser({ maxFrames: 30, originals: true });
    return { produced: !!r.result, waits: r.waits, error: r.error ?? null };
  });
  check(!blocked.produced && blocked.waits.some((w) => w.includes('等待上传方') && w.includes(fakeName)), '缺原尺寸时提示「等待上传方」、不出片', { produced: blocked.produced, waits: blocked.waits.slice(0, 2) });
  await P(phone, (spec) => { const s = window.__pcStore; if (spec.clipId) s.actions.removeClip(spec.clipId); s.actions.removeMedia(spec.mediaId); }, fake);
  const cleaned = await P(phone, (id) => !window.__pcStore.getState().project.media.some((m) => m.id === id), fake.mediaId);
  check(cleaned, '删掉造的缺原尺寸素材');
  // 4b. 原尺寸都到齐后导出:重渲之后的预渲染原尺寸也要就绪(等 plan 落定)
  await waitPlanSettled('改后重渲', new Set(settled?.plans ?? []));
  const exportMark = phone.assets.length;
  let exported = null;
  for (let attempt = 0; attempt < 20 && !exported?.result && Date.now() < deadline; attempt++) {
    exported = await P(phone, async (frames) => window.__pcIo.exportVideoBrowser({ maxFrames: frames, originals: true }), EXPORT_SECONDS * FPS);
    if (!exported?.result) { say('export.retry', { attempt, waits: exported?.waits?.slice(0, 2), error: exported?.error }); await delay(15_000); }
  }
  const sum4 = assetSummary(phone.assets.slice(exportMark), tier);
  let probe4 = null;
  if (check(exported?.result, '逐帧导出出片', { waits: exported?.waits?.slice(0, 2), error: exported?.error })) {
    const mp4 = path.join(OUT, '4-lowmem-export.mp4');
    fs.writeFileSync(mp4, Buffer.from(exported.base64, 'base64'));
    const pr = spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,nb_read_frames,duration', '-of', 'json', mp4], { encoding: 'utf8', windowsHide: true });
    probe4 = JSON.parse(pr.stdout || '{}').streams ?? [];
    const v = probe4.find((s) => s.codec_type === 'video');
    const a = probe4.find((s) => s.codec_type === 'audio');
    check(v?.codec_name === 'h264' && Number(v.nb_read_frames) === EXPORT_SECONDS * FPS, `导出:h264、${EXPORT_SECONDS * FPS} 帧`, v);
    check(v && Math.abs(Number(v.duration) - EXPORT_SECONDS) < 0.05, `导出:时长 ${EXPORT_SECONDS} 秒`, v?.duration);
    check(a?.codec_name === 'aac', '导出:有 AAC 音轨', a);
    out.steps.exportFile = mp4;
  }
  check(sum4.mediaOriginal > 0 && sum4.mediaSmall === 0, '导出用的是素材原尺寸', sum4);
  check(sum4.snap > 0, '导出用的是预渲染原尺寸(snap/)', sum4);
  out.steps.export = { ms: Date.now() - t4, missingCase: { produced: blocked.produced, waits: blocked.waits.length }, frames: exported?.result?.frames ?? null, ffprobe: probe4, requests: sum4 };
  say('step4.done', out.steps.export);

  /* ---------------------------------------------------------------- 5. 作废并重新生成邀请码 */
  const t5 = Date.now();
  const oldLink = state.link;
  await P(creator, () => window.dispatchEvent(new Event('pc-open-project-settings')));
  await creator.waitForSelector('[data-pc="collab-regen"]', { visible: true, timeout: 20_000 });
  await creator.click('[data-pc="collab-regen"]');
  await typeInto(creator, '[data-pc="collab-regen-password"]', creatorCred.password);
  await creator.click('[data-pc="collab-regen-confirm"]');
  await until('重新生成邀请码', async () => (await textOf(creator, '[data-pc="collab-status"]')).includes('已生成新的邀请链接与二维码。'), 20_000);
  state.link = (await textOf(creator, '[data-pc="collab-invite-link"]')).trim();
  check(state.link !== oldLink && /#invite=[A-Za-z0-9_-]{43}$/.test(state.link), '签发了新的邀请链接', redactInvite(state.link));
  await creator.keyboard.press('Escape');
  const oldPage = await newPage({ mobile: true });
  await oldPage.goto(`${EDITOR}#invite=${codeOf(oldLink)}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await oldPage.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
  const refused = await until('旧链接给失效文案', async () => (await joinMessage(oldPage)).includes('这个邀请链接已失效，向创建者要一个新的，或手动填写项目信息。'), 20_000);
  check(refused, '作废后旧链接被拒(表 A 的失效文案)', { message: await joinMessage(oldPage) });
  await shot(oldPage, '5-old-link-refused');
  await oldPage.close$();
  const newJoin = await newPage({ mobile: true });
  await newJoin.goto(`${EDITOR}#invite=${codeOf(state.link)}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await newJoin.waitForSelector('[data-pc="join-invite-project"]', { visible: true, timeout: 60_000 });
  await typeInto(newJoin, '[data-pc="join-username"]', '新链接成员');
  await newJoin.click('[data-pc="join-submit"]');
  check(await waitMembers(newJoin).then(() => true, () => false), '新链接能进', { message: await joinMessage(newJoin) });
  await newJoin.close$();
  out.steps.regen = { ms: Date.now() - t5, oldInvite: redactInvite(oldLink), newInvite: redactInvite(state.link), oldRefused: !!refused };
  say('step5.done', out.steps.regen);

  /* ---------------------------------------------------------------- 6. 桌面版开始页的加入表单 */
  const t6 = Date.now();
  const desktopJoin = async (label, fill) => {
    const page = await newPage();
    await page.goto(`${editor.origin}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 90_000 });
    await fill(page);
    const ok = await waitMembers(page).then(() => true, () => false);
    check(ok, `桌面版开始页:${label}进得去`, { message: await joinMessage(page) });
    await shot(page, `6-desktop-${label}`);
    await page.close$();
    return ok;
  };
  const manual = await desktopJoin('手填', async (page) => {
    await page.click('::-p-text(服务器地址)');
    await typeInto(page, '#pc-join-server', HOSTED);
    await typeInto(page, '[data-pc="join-name"]', projName);
    await typeInto(page, '[data-pc="join-username"]', '桌面同事');
    await typeInto(page, '[data-pc="join-password"]', state.projectPassword);
    await page.click('[data-pc="join-submit"]');
  });
  const pasted = await desktopJoin('粘贴邀请链接', async (page) => {
    await typeInto(page, '[data-pc="join-link"]', state.link);
    await page.click('[data-pc="join-link-submit"]');
    await page.waitForSelector('[data-pc="join-invite-project"]', { visible: true, timeout: 30_000 });
    await typeInto(page, '[data-pc="join-username"]', '桌面粘贴');
    await page.click('[data-pc="join-submit"]');
  });
  out.steps.desktop = { ms: Date.now() - t6, manual, pasted };
  say('step6.done', out.steps.desktop);
} catch (e) {
  fails.push(`探针异常:${String(e?.stack ?? e).slice(0, 1200)}`);
  for (const [name, page] of [['creator', state.creator], ['phone', state.phone]]) if (page) await shot(page, `fatal-${name}`);
} finally {
  /* ---------------------------------------------------------------- 7. 收尾 */
  const t7 = Date.now();
  let deleted = null;
  if (M && state.projectId && state.creatorCred) {
    const r = await adminOp(M, state.projectId, state.creatorCred, 'delete').catch((e) => ({ type: 'error', reason: String(e?.message ?? e) }));
    const gone = await M.lookupProject({ base: HOSTED, name: `c10a演示-${RUN}` }).then(() => 200, (e) => e.status ?? 'error');
    deleted = { reply: r?.type ?? null, lookup: gone };
    check(r?.type === 'shared.admin.ok' && gone === 404, '收尾:以创建者身份删掉云端项目', deleted);
  }
  try { conn?.close(); } catch { /* 已关 */ }
  try { await browser?.close(); } catch { /* 已关 */ }
  try { fs.writeFileSync(path.join(OUT, 'creator-editor.log'), editorLog.join('\n')); } catch { /* 写不了 */ }
  if (editor?.child?.pid) {
    const pre = await prerenderInfo().catch(() => null);
    killTree(editor.child.pid);
    // 预渲染进程是编辑器的子进程,按进程树一起结束;它的端口还在就再按端口结束一次
    const prePort = pre?.url ? Number(new URL(pre.url).port) : null;
    if (prePort) { const pid = pidOnPort(prePort); if (pid) killTree(pid); }
  }
  if (proxy) await new Promise((r) => { proxy.close(() => r()); proxy.closeAllConnections?.(); });
  try { await combo?.close(); } catch { /* 已关 */ }
  out.steps.cleanup = { ms: Date.now() - t7, deleted, proxy: LOCAL ? proxyStats : undefined };
  if (!KEEP) {
    // 截图目录缺省在临时目录里:给了 --out 才留
    for (const d of fs.readdirSync(TMP)) {
      const p = path.join(TMP, d);
      if (path.resolve(p) === OUT) continue;
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 句柄还没放 */ }
    }
    if (!OUT.startsWith(TMP)) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 同上 */ } }
  }
  out.ms = Date.now() - started;
  out.fails = fails;
  out.ok = fails.length === 0;
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}

/* ================================================================== 小工具(需要 M、conn、editor) */

/** 等页面发布的 plan 切出细任务并全部落定(同 T9);`seen` 里的 plan 不算。回摘要或 null */
async function waitPlanSettled(label, seen) {
  let lastCount = 0;
  let lastAt = Date.now();
  const r = await until(`${label}:plan 切出的细任务全部落定`, async () => {
    const q = await diag();
    const mine = (q?.published ?? []).filter((p) => !seen.has(p.planId));
    if (!mine.length) return null;
    if (mine.length !== lastCount) { lastCount = mine.length; lastAt = Date.now(); }
    const latest = [...mine].reverse().find((p) => Array.isArray(q.plans?.[p.planId]) && q.plans[p.planId].length);
    if (!latest) return null;
    const derived = q.plans[latest.planId];
    const states = derived.map((id) => q.tasks?.[id]?.state ?? 'pending');
    if (!states.every((s) => s === 'done' || s === 'failed')) return null;
    if (Date.now() - lastAt < 3000) return null;
    return { planId: latest.planId, plans: (q.published ?? []).map((p) => p.planId), tasks: derived.length, done: states.filter((s) => s === 'done').length, failed: states.filter((s) => s === 'failed').length };
  }, 1_200_000, 1000);
  if (r) check(r.failed === 0, `${label}:没有细任务失败`, r);
  return r;
}

/** 手机舞台里重卡包裹层的样子(排障用) */
async function stageDiag(page) {
  const f = page.frames().find((x) => /[?&]stage=1/.test(x.url()));
  const stage = f ? await f.evaluate((id) => {
    const wrap = document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]`);
    return { wrap: !!wrap, cls: wrap?.className ?? null, plane: !!wrap?.querySelector('[data-pc-snapshot-plane]'), imgs: wrap ? wrap.querySelectorAll('img').length : 0,
      clips: [...document.querySelectorAll('[data-pc-clip]')].map((e) => e.getAttribute('data-pc-clip')).slice(0, 8) };
  }, state.heavyClip).catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) })) : null;
  const online = await page.evaluate(() => { try { return window.__pcOnlineSnapshots?.() ?? null; } catch (e) { return { error: String(e) }; } }).catch(() => null);
  return { badResponses: page.badResponses?.slice(-12), consoleErrors: page.consoleErrors?.slice(-6), pageErrors: page.pageErrors?.slice(-5), preview: await page.evaluate(() => { try { return window.__pcPreviewDiag?.() ?? null; } catch { return null; } }).catch(() => null), heavyClip: state.heavyClip, frameUrl: f ? f.url().split('?')[0] : null, stage, online: online ? JSON.parse(JSON.stringify(online)) : null };
}

/** 内容库里重卡片段的层与它各段清单:键、帧数、小尺寸张数;小位图都在素材服务上才回。没到齐时把原因记进 state.layerWhy */
async function heavyLayer() {
  const reply = await conn.rpc({ type: 'content.get', kind: 'snapshot-manifest', key: `layers:${state.docId}` });
  if (reply?.type !== 'content.item' || reply.missing) { state.layerWhy = { map: reply?.type ?? null, missing: !!reply?.missing }; return null; }
  const layer = (reply.body?.layers ?? []).find((l) => l.clipId === state.heavyClip);
  if (!layer) { state.layerWhy = { heavyClip: state.heavyClip, layers: (reply.body?.layers ?? []).map((l) => ({ clipId: l.clipId, kind: l.kind, count: l.count })) }; return null; }
  const span = Math.max(1, Number(reply.body.span) || 60);
  let frames = 0;
  const small = [];
  for (let from = 0; from < layer.count; from += span) {
    const to = Math.min(layer.count - 1, from + span - 1);
    const m = await conn.rpc({ type: 'content.get', kind: 'snapshot-manifest', key: `${layer.resultKey}:${from}-${to}` });
    if (m?.type !== 'content.item' || m.missing) { state.layerWhy = { segment: `${from}-${to}`, count: layer.count, span, reply: m?.type ?? null }; return null; }
    frames += (m.body?.frames ?? []).length;
    for (const s of m.body?.small ?? []) small.push(s[1]);
  }
  if (!small.length) { state.layerWhy = { frames, small: 0 }; return null; }
  for (const h of [...new Set(small)].slice(0, 5)) {
    const has = await conn.client.has('px', h).catch((e) => `error: ${String(e?.message ?? e).slice(0, 120)}`);
    if (has !== true) { state.layerWhy = { frames, small: small.length, pxHas: has }; return null; }
  }
  return { key: layer.key, frames, smallCount: small.length };
}
