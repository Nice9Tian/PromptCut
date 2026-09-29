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
 *        [--hold-min N] [--hold-on-fail] [--debug-port P]   排障:第 2 步之后停 N 分钟(带 --hold-on-fail 时只在前两步有失败才停);浏览器开远程调试端口(本机替身用 5667)
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
 *   1b. 创建者刷新页面:同一个标签页刷新之后回到刷新前打开的共享项目(同一份项目文档、仍是创建者)。
 *   2. 手机成员:Chrome 移动端仿真(手机视口、触屏、`deviceMemory: 4`)打开邀请链接,只填用户名加入;断言判为低内存档
 *      (进入提示、只有一个同源舞台)、网络记录里视频只有小尺寸、预渲染只有 `px/` 小位图、没有原尺寸与 `snap/`,也没有任何
 *      `/@media/…` 请求(有就记下发起方:元素链或调用栈;手机整段在第 4 步末再核一次);截图。第 1 步 plan 落定时重卡每帧两档都在。
 *   3. 在手机上改一处(重卡片段的参数换成已钉死的第二个版本):创建方的渲染节点认领重渲,手机舞台换上新键下的预渲染小尺寸;
 *      记下时长与时刻分解(`steps.edit.timeline`:plan 发布、认领、切分,各段认领 / 渲染 / 完成,手机层表、清单、贴上;L22)。
 *   4. 低内存档逐帧导出:先在手机上造一个缺原尺寸的素材片段,导出提示「等待上传方」、不出片;删掉它后导出 `--export-seconds` 秒,
 *      ffprobe 核对帧数、时长、编码;这一段的请求记录里用的是素材原尺寸与预渲染原尺寸(`snap/`)。
 *   5. 作废邀请码:创建者「作废并重新生成」,旧链接给表 A 的失效文案,新链接能进。
 *   6. 桌面版开始页:同一项目用桌面版的加入表单进一次(手填、粘贴邀请链接两条)。
 *   7. 收尾:以创建者身份 `delete` 云端项目,结束自己起的进程,删临时目录。
 *
 * 注意:创建者的 dev server 跑在本工作区上。跑的期间不要改工作区里的文件 —— Tailwind v4 的 Vite 插件会把改动过的
 * 非模块文件(连 docs 下的 .md 也算)当作类名来源,静默让所有页面整页重载。结果里 `creatorPage` 记着创建者页面的
 * 每次顶层导航与意外重载次数。
 *
 * 输出:过程写 stderr(一行一条 JSON);stdout 最后一行是一行 JSON `{ ok, fails, … }`,`ok` 为假时退出码 1。
 *
 * `PC_CHROME_ARGS` 只把参数原样透传给探针起的 Chrome(典型用途:云端 Linux 以 root 运行要 `--no-sandbox`);不要用它关 TLS 校验(如 `--ignore-certificate-errors`),否则对远端站点的探针在证书有问题时照样通过,掩盖真问题。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
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
    import('../../server/render-node/session-link.mjs'), import('../../server/render-node/endpoint.mjs'),
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
  // 核对连接贯穿整个演示:是一个会话(HT-a,`createDocEndpoint`),传输断一次在保留期内接续
  const ep = M.createDocEndpoint({ url: entry.url, protocols: M.sharedProtocols(entry, { role: 'page' }), log: () => {} });
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
  // 顶层导航(含整页重载)与 Vite 客户端消息:查「创建者页面中途整页重载」用;地址只记源与路径
  // 只算真正的整页导航:puppeteer 的 'framenavigated' 对同页跳转(清掉 #invite 的 replaceState、改 hash)也发,
  // 所以直接听 CDP:`Page.frameNavigated` 只在换文档时发,同页跳转走 `Page.navigatedWithinDocument`,另记 sameDocNavs 备查。
  page.navs = [];
  page.sameDocNavs = 0;
  const whereOf = (url) => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return '?'; } };
  const navCdp = await page.createCDPSession();
  await navCdp.send('Page.enable');
  let topFrameId = null;
  navCdp.on('Page.frameNavigated', ({ frame }) => {
    if (frame.parentId) return;
    topFrameId = frame.id;
    const where = whereOf(frame.url);
    page.navs.push({ at: new Date().toISOString(), url: where });
    if (page.navs.length > 1) say('page.renavigated', { url: where, count: page.navs.length });
  });
  navCdp.on('Page.navigatedWithinDocument', ({ frameId }) => { if (frameId === topFrameId) page.sameDocNavs++; });
  page.viteLog = [];
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[vite]') && page.viteLog.length < 60) page.viteLog.push(`${new Date().toISOString()} ${t}`.slice(0, 240)); });
  if (mobile) {
    await page.emulate({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      viewport: { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false },
    });
    await page.evaluateOnNewDocument(() => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 4 }); });
    /*
     * 在线页面不该有 `/@media/…` 请求(那是桌面编辑器进程的路由;低内存档也不取素材原尺寸):记下是谁发的 ——
     * 媒体元素 / 图片的 src 由谁设(元素与它往上几层的 class)、fetch 的调用栈。同源舞台 iframe 里一样挂。
     */
    await page.evaluateOnNewDocument(() => {
      const hits = (window.__pcMediaHits = []);
      const isMedia = (v) => { try { return new URL(String(v), location.href).pathname.startsWith('/@media/'); } catch { return false; } };
      const where = (el) => {
        const chain = [];
        for (let n = el; n && n.nodeType === 1 && chain.length < 8; n = n.parentElement) {
          const pc = n.getAttribute('data-pc') || n.getAttribute('data-pc-media') || n.getAttribute('data-pc-clip');
          chain.push(`${n.tagName.toLowerCase()}${n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}${pc ? `[${pc}]` : ''}`);
        }
        return chain.join(' < ');
      };
      const note = (kind, url, el) => {
        if (hits.length >= 20) return;
        hits.push({ kind, path: new URL(String(url), location.href).pathname.slice(0, 90), frame: location.pathname + location.search.slice(0, 40), el: el ? where(el) : null,
          stack: String(new Error().stack || '').split('\n').slice(2, 12).map((s) => s.trim()).join(' | ').slice(0, 1200) });
      };
      const origFetch = window.fetch;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : input?.url;
        if (url && isMedia(url)) note('fetch', url, null);
        return origFetch.call(this, input, init);
      };
      for (const proto of [HTMLMediaElement.prototype, HTMLImageElement.prototype, HTMLSourceElement.prototype]) {
        const d = Object.getOwnPropertyDescriptor(proto, 'src');
        if (!d?.set) continue;
        Object.defineProperty(proto, 'src', { ...d, set(v) { if (isMedia(v)) note(`${this.tagName.toLowerCase()}.src`, v, this); return d.set.call(this, v); } });
      }
      const setAttr = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name, value) {
        if (String(name).toLowerCase() === 'src' && isMedia(value)) note(`${this.tagName.toLowerCase()}[src]`, value, this);
        return setAttr.call(this, name, value);
      };
      const OrigXhrOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) { if (isMedia(url)) note('xhr', url, null); return OrigXhrOpen.call(this, method, url, ...rest); };
    });
    page.relMedia = [];
    // 只记路径(查询串里有票据,不记)
    page.on('request', (r) => {
      let u;
      try { u = new URL(r.url()); } catch { return; }
      if (u.pathname.startsWith('/@media/') && page.relMedia.length < 40) {
        const init = r.initiator?.() ?? null;
        const frames = init?.stack?.callFrames ?? [];
        page.relMedia.push({ at: Date.now(), path: u.pathname.slice(0, 90), type: r.resourceType(), initiator: init?.type ?? null,
          stack: frames.slice(0, 8).map((f) => `${f.functionName || '?'}@${String(f.url).split('/').pop()}:${f.lineNumber}:${f.columnNumber}`) });
      }
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
  state.lightClip = lightClip;
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
  // 契约第 9 节「任务完成的条件:两档都推送成功」:plan 落定时重卡每一帧都有小尺寸
  check(layers && layers.frames === layers.count && layers.smallCount === layers.frames, 'plan 落定时重卡每帧两档都在(原尺寸帧数 = 层的帧数 = 小尺寸张数)',
    layers ? { frames: layers.frames, count: layers.count, small: layers.smallCount, missingSmall: layers.missingSmall.slice(0, 20) } : null);
  out.steps.creator = { ms: Date.now() - t1, project: { name: projName, projectId: state.projectId }, media: { small: media.small.slice(0, 12), original: media.original.slice(0, 12) },
    invite: redactInvite(state.link), plan: settled, prerenderRestarted: !!pre1, heavy: layers ? { key: layers.key.slice(0, 12), frames: layers.frames, small: layers.smallCount, ...(layers.missingSmall.length ? { missingSmall: layers.missingSmall.slice(0, 20) } : {}) } : null };
  say('step1.done', out.steps.creator);

  /* ---------------------------------------------------------------- 1b. 创建者刷新页面,回到刷新前打开的共享项目 */
  // 产品行为(C10a r2):同一个标签页刷新之后回到共享项目;回不去的话之后没人替改动重发计划,手机永远等不到新键
  const t1b = Date.now();
  state.creatorReloads = 1;
  await creator.reload({ waitUntil: 'domcontentloaded', timeout: 180_000 });
  const resumed = await until('创建者刷新后回到共享项目', () => P(creator, async (spec) => {
    const Y = await import('/src/editor/sync/syncManager.ts');
    const S = await import('/src/store/project.ts');
    const v = Y.getSyncView();
    const clip = S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === spec.clip);
    return v.shared?.projectId === spec.projectId && v.shared.creator && clip && document.querySelectorAll('iframe').length >= 2 ? { docId: S.getState().project.id } : null;
  }, { projectId: state.projectId, clip: heavyClip }), 120_000, 500);
  check(resumed && resumed.docId === state.docId, '创建者刷新页面后回到刷新前的共享项目(同一份项目文档)', resumed);
  out.steps.creatorReload = { ms: Date.now() - t1b, resumed: !!resumed };
  say('step1b.done', out.steps.creatorReload);

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
  /*
   * 暂停着进来:c10a 契约第 17 节起低内存档停下时追当前一帧(重卡也画),画好之前贴预渲染小尺寸。
   * 所以这里等的是「重卡有画面」:要么贴着小尺寸,要么已经被停下追一帧画成活渲(小尺寸在播放中另核)。
   */
  const smallShown = await until('手机上重卡有画面(贴预渲染小尺寸,或停下追一帧画出)', async () => {
    const x = await stageSample(phone);
    const w = x?.wraps?.find((y) => y.id === state.heavyClip);
    if (w?.small) return 'small';
    const drawn = x?.lowMemSettle?.drawn?.some((d) => d.clipId === state.heavyClip);
    return w && drawn && !w.suppressed && !w.plane ? 'live' : null;
  }, 120_000, 1000);
  const phoneDiag = smallShown ? null : await stageDiag(phone);
  check(smallShown, '手机上重卡有画面(贴预渲染小尺寸,或停下追一帧画出)', phoneDiag ? '(见 steps.phone.diag)' : smallShown);
  /*
   * c10a 契约第 17 节(1):低内存档全部按重卡 —— 播放时一律贴预渲染小尺寸、不活渲任何卡(轻卡也抑制;
   * 没有产物的层显示占位)。播放中采几次舞台的样子。
   */
  await P(phone, () => { const s = window.__pcStore; s.actions.seek(0); s.actions.play(); });
  const playSamples = [];
  for (let i = 0; i < 6; i++) { await delay(450); playSamples.push(await stageSample(phone)); }
  /*
   * c10a 契约第 17 节(2):停下追当前一帧 —— 暂停(再点到 2.5 秒)后,舞台在时限内把这一帧的所有卡活渲一次;
   * 到时限没画好的维持占位。等父页记下这一秒的结果,记下耗时。
   */
  const settleAt = (sec) => until(`手机停下追一帧落定(${sec === null ? '暂停处' : `${sec} 秒`})`, () => P(phone, (want) => {
    const r = window.__pcPreviewDiag?.()?.lowMemSettle;
    const t = window.__pcStore.getState().t;
    const at = want === null ? t : want;
    return r && r.ok && Math.abs(r.sec - at) < 1e-6 && Math.abs(t - at) < 1e-6 ? r : null;
  }, sec), 30_000, 200);
  // 暂停:停在舞台最后一拍,在那一秒追一帧
  await P(phone, () => window.__pcStore.actions.pause());
  const settlePause = await settleAt(null);
  await shotStage(phone, '2-phone-stage-paused');
  // 点时间轴到 2.5 秒:同样是停下,在 2.5 秒追一帧
  await P(phone, () => window.__pcStore.actions.seek(2.5));
  const settle = await settleAt(2.5);
  const afterSettle = await stageSample(phone);
  await shotStage(phone, '2-phone-stage-settled');
  check(settlePause, '暂停后停下追一帧落定', settlePause ? { sec: settlePause.sec, ms: settlePause.ms, drawn: settlePause.drawn.length, timedOut: settlePause.timedOut.length } : null);
  const playing = playSamples.filter((x) => x?.playing);
  check(playing.length >= 3, '手机播放中采到舞台的样子(至少 3 次)', { samples: playSamples.length, playing: playing.length });
  check(playing.every((x) => x.wraps.length > 0 && x.wraps.every((w) => w.suppressed) && x.lowMemLive.length === 0 && x.settling.length === 0),
    '手机播放中:所有卡(重卡、轻卡)都抑制着,不活渲', playing.map((x) => ({ wraps: x.wraps.map((w) => `${w.id.slice(0, 6)}:${w.suppressed ? 'S' : 'L'}${w.small ? '+img' : ''}${w.placeholder ? '+ph' : ''}`), live: x.lowMemLive })).slice(0, 3));
  check(playing.some((x) => x.wraps.some((w) => w.id === state.heavyClip && w.small)), '手机播放中:重卡贴着预渲染小尺寸');
  check(playing.every((x) => x.wraps.every((w) => w.small || w.placeholder || w.unsupported)), '手机播放中:每一层要么贴小尺寸、要么占位(不透明)',
    playing.map((x) => x.wraps.filter((w) => !w.small && !w.placeholder && !w.unsupported).map((w) => w.id)).slice(0, 3));
  const active = afterSettle?.wraps?.map((w) => w.id) ?? [];
  const accounted = new Set([...(settle?.drawn ?? []).map((d) => d.clipId), ...(settle?.timedOut ?? []), ...(settle?.skipped ?? [])]);
  check(settle?.ok === true && settle.timeoutMs === 5000, '停下追一帧:时限 5 秒,这一次没被打断', settle ? { ok: settle.ok, reason: settle.reason, timeoutMs: settle.timeoutMs } : null);
  check(settle && settle.ms <= settle.timeoutMs + 1000, '停下追一帧:在时限内收尾(画完或超时维持占位)', settle ? { ms: settle.ms } : null);
  check(active.length > 0 && active.every((id) => accounted.has(id)), '停下追一帧:当前这一帧的每张卡都有着落(画好 / 超时 / 不追)', { active, drawn: settle?.drawn, timedOut: settle?.timedOut });
  const drawnIds = new Set((settle?.drawn ?? []).map((d) => d.clipId));
  check((afterSettle?.wraps ?? []).filter((w) => drawnIds.has(w.id)).every((w) => !w.suppressed && !w.plane && !w.settling),
    '停下追一帧:画好的层撤了兜底、换上活渲', afterSettle?.wraps);
  check((afterSettle?.wraps ?? []).filter((w) => (settle?.timedOut ?? []).includes(w.id)).every((w) => w.suppressed && (w.small || w.placeholder)),
    '停下追一帧:到时限没画好的层维持占位(或小尺寸)', afterSettle?.wraps);
  state.lowmem = {
    play: { samples: playSamples.length, playing: playing.length, allSuppressed: playing.every((x) => x.wraps.every((w) => w.suppressed)) },
    settle: settle ? { ms: settle.ms, timeoutMs: settle.timeoutMs, drawn: settle.drawn.map((d) => ({ clip: d.clipId.slice(0, 8), ms: d.ms })), timedOut: settle.timedOut.map((id) => id.slice(0, 8)), skipped: settle.skipped.length } : null,
    settlePause: settlePause ? { sec: settlePause.sec, ms: settlePause.ms, drawn: settlePause.drawn.length, timedOut: settlePause.timedOut.length } : null,
  };
  await delay(2000);
  const tier = { small: new Set([media.small]), original: new Set([media.original]) };
  const sum2 = assetSummary(phone.assets, tier);
  check(sum2.mediaSmall > 0 && sum2.mediaOriginal === 0 && sum2.mediaOther === 0, '手机:视频只有小尺寸请求', sum2);
  check(sum2.px > 0 && sum2.snap === 0, '手机:预渲染只有 px/ 小位图、没有 snap/', sum2);
  const rel2 = await relMediaOf(phone);
  check(!rel2.requests.length, '手机:没有 /@media 请求(在线页面没有这条路由,低内存档也不取素材原尺寸)', rel2);
  const phoneShot = await shot(phone, '2-phone-lowmem');
  if (phoneDiag) say('phone.diag', phoneDiag);
  out.steps.phone = { ms: Date.now() - t2, lowMemoryToast: !!lowToast, stageFrames: frames.length, smallShown: !!smallShown, requests: sum2, shot: phoneShot,
    online: await P(phone, () => { try { const d = window.__pcOnlineSnapshots?.(); return d ? { layers: d.layers?.length ?? 0, smallFetches: d.smallFetches ?? null } : null; } catch { return null; } }),
    relMedia: rel2.requests.length, ...(rel2.requests.length ? { relMediaDetail: rel2 } : {}),
    ...(phoneDiag ? { diag: phoneDiag } : {}), lowmem: state.lowmem };
  say('step2.done', out.steps.phone);

  /* ---------------------------------------------------------------- 2c. 轻重判定与补渲(C10 其余第 3 节:共享成本记录加界限搜索) */
  /*
   * C10 其余第 3 节取代 c10a 第 17 节的「全部按重卡」(契约 c10-contract.md 第 3 节、第 18 节第 8 条):
   * - 创建者桌面版测完卡、把成本记录转写进文档服务(钉死的重卡片段那两条记录没有单帧耗时,不转写);
   * - 手机打开项目时取本项目的记录做界限搜索:轻卡(chapter-bar)有记录、本机跑得动 → 判轻;重卡片段没有记录 → 判重;
   * - 补渲只对判重又缺产物的层:重卡片段已有产物,轻卡判轻 —— 这一步不该发出任何补渲;
   * - 判轻的卡播放时同样不活渲,没有产物就占位(以前这里断言「轻卡补渲来的小尺寸」,按新规则改成断言它不补渲、占位)。
   * 补渲的整条路(发布、节点认领、backfill 排在 normal 之后、小尺寸回到手机)由第 3 步新放的卡覆盖:它还没有成本记录,按重卡。
   */
  const t2c = Date.now();
  const search = await until('手机的界限搜索做完', () => P(phone, () => { const d = window.__pcLowMemSearch?.(); return d?.outcome ? d : null; }), 300_000, 500);
  const lightKey = keys.light;
  check(search && search.outcome.records > 0, '手机取到了本项目的成本记录', search ? { records: search.outcome.records } : null);
  check(search && search.outcome.light.includes(lightKey), '轻卡(有记录、本机跑得动)判轻', search?.outcome ? { light: search.outcome.light.length, heavy: search.outcome.heavy.length, trace: search.outcome.trace } : null);
  check(search && search.judgedHeavyClips.includes(heavyClip) && !search.judgedHeavyClips.includes(state.lightClip), '重卡片段(没有单帧耗时记录)判重,轻卡不在判重的片段里', search ? { heavy: search.judgedHeavyClips } : null);
  check(search && search.outcome.measurements <= Math.ceil(Math.log2(search.outcome.order.length + 1)) + 4, '测量次数 ≤ ⌈log₂(n+1)⌉ + 4', search ? { measurements: search.outcome.measurements, n: search.outcome.order.length } : null);
  await delay(5000); // 补渲每 3 秒核一次:给它两轮
  const bfLog = await P(phone, () => window.__pcBackfill?.()?.log ?? []);
  check(!bfLog.some((e) => e.clips.includes(state.lightClip) || e.clips.includes(heavyClip)), '判轻的轻卡、已有产物的重卡都不发补渲', bfLog.map((e) => ({ id: e.id.slice(0, 30), clips: e.clips.length })));
  await P(phone, () => { const s = window.__pcStore; s.actions.seek(0.5); s.actions.play(); });
  let lightPlaceholder = null;
  for (let i = 0; i < 8 && !lightPlaceholder; i++) {
    await delay(400);
    const x = await stageSample(phone);
    const w = x?.playing ? x.wraps.find((y) => y.id === state.lightClip) : null;
    if (w?.suppressed && w.placeholder && !w.small) { lightPlaceholder = { at: i }; await shotStage(phone, '2c-phone-stage-playing-light-placeholder'); }
  }
  await P(phone, () => { const s = window.__pcStore; s.actions.pause(); s.actions.seek(2.5); });
  check(lightPlaceholder, '手机播放中判轻的轻卡不活渲、没有产物显示占位');
  out.steps.backfill = { ms: Date.now() - t2c, search: search ? { records: search.outcome.records, n: search.outcome.order.length, measurements: search.outcome.measurements, light: search.outcome.light.length, heavyClips: search.judgedHeavyClips.length } : null,
    backfillLog: bfLog.length, lightPlaceholderWhilePlaying: !!lightPlaceholder };
  say('step2c.done', out.steps.backfill);
  // 排障:--hold-min N 在这里停 N 分钟(配 --debug-port 从外面连上浏览器看)
  if (Number(arg('--hold-min', 0)) > 0 && (!argv.includes('--hold-on-fail') || fails.length)) { say('hold', { minutes: Number(arg('--hold-min', 0)) }); await delay(Number(arg('--hold-min', 0)) * 60_000); }

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
  const editAt = Date.now();
  // L22:第 3 步的时刻分解。改完就开始采样(手机每秒一次、创建者的队列诊断每 2 秒一次),第 3 步末尾算各段时刻
  const tl3 = startStep3Timeline({ t0: t3, heavyClip, creatorSawAt: editAt });
  /*
   * c10a 契约第 17 节(4):补渲排在本机判重的任务之后。改动让重卡重渲(本机判重的 normal 任务),
   * 同时在手机上再放一张轻卡(缺产物 → 补渲);节点先做完 normal 的,空下来再做 backfill 的。
   * C10 其余第 3 节起:这张新放的卡片段长度与第一张不同(卡片身份不同),手机打开时取到的成本记录里没有它 → 按重卡 → 缺产物就补渲。
   */
  state.extraClip = await P(phone, (spec) => {
    const s = window.__pcStore;
    const c = s.actions.addClipOnNewTrack({ index: 0, cardId: spec.light, start: 1, duration: 3 });
    return c?.id ?? null;
  }, { light: LIGHT_CARD });
  check(state.extraClip, '手机上再放了一张轻卡(缺产物)');
  // 手机这边层表里重卡的键换了(渲染节点认下新一版、写了新层表)
  const phoneKey = () => P(phone, (id) => (window.__pcOnlineSnapshots?.()?.layers ?? []).find((l) => l.clipId === id)?.key ?? null, heavyClip).catch(() => null);
  const keyAtStart = await phoneKey();
  let keyChangedAt = null;
  // 整段重渲完:内容库里新键下每一段清单都在、小位图都在素材服务上。和下面「手机换上」并行等,各记各的时刻
  // (L22:以前串在「手机收到新 px」之后等,整段重渲的时长被前一步拖长)
  let layer1At = null;
  const layer1P = until('重渲整段完成(新键下每帧两档齐全)', async () => { const l = await heavyLayer(); return l && l.key !== keyBefore && l.frames === l.count && l.smallCount === l.frames && l.missingSmall.length === 0 ? l : null; }, 900_000, 2000)
    .then((l) => { layer1At = Date.now(); return l; });
  /*
   * L22:「新的小尺寸到手机」按手机的就绪表判:层表换了新键、新键下已有带小尺寸的清单进了就绪表(页面据此贴图)。
   * 不再按「手机请求了以前没见过的 px/ 哈希」判:重卡改的 probeSalt 不影响画面,新键下的小位图与旧键逐字节相同、哈希相同,
   * 手机缓存里已有,根本不会再请求;以前量到的「新 px」其实是同一步里新放的轻卡的补渲产物,排在全部普通任务之后。
   * 旧量法的数仍记在 newPxMs。暂停着时低内存档把当前帧活渲出来(停下追一帧),舞台不贴小尺寸,所以「舞台换上」
   * 另在就绪之后放一小段播放来看(mountedWhilePlayingMs),只记录、不判。
   */
  const newPx = await until('新键下的预渲染小尺寸进了手机的就绪表', async () => {
    const k = await phoneKey();
    if (!keyChangedAt && k && k !== keyAtStart) keyChangedAt = Date.now();
    if (!keyChangedAt || !k) return null;
    const ready = await P(phone, (id) => window.__pcPreviewDiag?.()?.snapshotFeed?.ready?.find((r) => r.clipId === id)?.kinds?.[0] ?? null, heavyClip).catch(() => null);
    return ready && k.startsWith(ready.key) && ready.ranges > 0 ? { keyMs: keyChangedAt - t3, first: Date.now() - t3 } : null;
  }, 900_000, 500);
  check(newPx, '新键下的预渲染小尺寸到了手机(就绪表)');
  let mountedWhilePlaying = null;
  if (newPx) {
    const k = await phoneKey();
    const playFrom = await P(phone, () => window.__pcStore.getState().t);
    const t3p = Date.now();
    await P(phone, (t) => { const s = window.__pcStore; s.actions.seek(Math.max(0, t - 0.5)); s.actions.play(); }, playFrom);
    for (let i = 0; i < 16 && !mountedWhilePlaying; i++) {
      await delay(250);
      const m = await P(phone, (id) => window.__pcPreviewDiag?.()?.snapshotFeed?.mounted?.find((x) => x.clipId === id)?.key ?? null, heavyClip).catch(() => null);
      const w = await stageSample(phone).then((x) => x?.wraps?.find((y) => y.id === heavyClip) ?? null, () => null);
      if (m && k?.startsWith(m) && w?.small) mountedWhilePlaying = { ms: Date.now() - t3, afterPlayMs: Date.now() - t3p };
    }
    await P(phone, (t) => { const s = window.__pcStore; s.actions.pause(); s.actions.seek(t); }, playFrom);
  }
  const layer1 = await layer1P;
  check(layer1, '层表里重卡片段换了新的键、整段重渲完成', { before: keyBefore?.slice(0, 12), after: layer1?.key?.slice(0, 12), why: layer1 ? undefined : state.layerWhy });
  // 补渲排在后面:手机为新放的轻卡发的补渲做完,核对节点的认领先后
  const bf3 = state.extraClip ? await until('手机为新放的轻卡发出补渲任务', () => P(phone, (spec) => {
    const d = window.__pcBackfill?.();
    const hit = [...(d?.log ?? [])].reverse().find((e) => !e.error && e.at >= spec.at && e.clips.includes(spec.id));
    return hit ? { id: hit.id, clips: hit.clips } : null;
  }, { id: state.extraClip, at: editAt - 1000 }), 120_000, 500) : null;
  const order = bf3 ? await until('新放的轻卡的补渲细任务做完', async () => {
    const q = await diag();
    const derived = q?.plans?.[bf3.id];
    if (!Array.isArray(derived) || !derived.length) return null;
    if (!derived.every((id) => ['done', 'failed'].includes(q.tasks?.[id]?.state))) return null;
    const claims = (q.claims ?? []).filter((c) => c.at >= editAt && !c.id.startsWith('plan:'));
    const normal = claims.map((c, i) => [c, i]).filter(([c]) => c.priority !== 'backfill').map(([, i]) => i);
    const backfill = claims.map((c, i) => [c, i]).filter(([c]) => c.priority === 'backfill').map(([, i]) => i);
    // 补渲切出的细任务里,认领时是 normal 档的(同一个结果键已有创建方的 normal 任务:不另起、按 normal 做)
    const derivedClaims = (q.claims ?? []).filter((c) => derived.includes(c.id));
    return { claims: claims.length, normal: normal.length, backfill: backfill.length, lastNormal: normal.length ? Math.max(...normal) : null, firstBackfill: backfill.length ? Math.min(...backfill) : null,
      seq: claims.map((c) => (c.priority === 'backfill' ? 'B' : 'N')).join(''), derived: derived.length, derivedNormal: derivedClaims.filter((c) => c.priority !== 'backfill').length };
  }, 900_000, 2000) : null;
  /*
   * 两种结果都合乎「补渲排在后面」(mechanism/document-service.md「优先级」):
   * - 补渲的细任务是新键:标 backfill,节点先做完 normal 再做它们;
   * - 创建方这一版的 normal 计划也切到了新放的卡(它在创建方那边还没测、按声明判重),细任务同键:不另起、按 normal 做,
   *   一张 backfill 都不出现(c10-cost 第 2 轮实测 `NNNNNNN`,第 1 轮 `NNNNNNNNBB`,取决于两边谁先发布)。
   */
  const orderOk = !!order && order.normal > 0 && (order.backfill > 0 ? order.lastNormal < order.firstBackfill : order.derivedNormal > 0);
  check(orderOk, '补渲细任务排在本机判重的任务之后(节点先做完 normal,再做 backfill;同键已有 normal 任务时按 normal 做)', order);
  const extraSmall = state.extraClip ? await until('新放的轻卡的小尺寸回到手机', () => P(phone, (id) => {
    const l = (window.__pcOnlineSnapshots?.()?.layers ?? []).find((x) => x.clipId === id);
    return l && l.ready > 0 ? { ready: l.ready } : null;
  }, state.extraClip), 300_000, 1000) : null;
  check(extraSmall, '新放的轻卡的补渲小尺寸回到手机', extraSmall);
  state.order = order;
  await shot(phone, '3-phone-after-edit');
  const timeline = await tl3.finish({ layer1, pxBefore, extraClip: state.extraClip, fullRerenderAt: layer1At });
  const freshPx = phone.assets.filter((a) => a.ns === 'px' && a.method === 'GET' && !a.sub && !pxBefore.has(a.hash) && a.at >= t3);
  out.steps.edit = { ms: Date.now() - t3, newKeyMs: newPx?.keyMs ?? null, newSmallMs: newPx?.first ?? null, newPxMs: freshPx.length ? freshPx[0].at - t3 : null, mountedWhilePlayingMs: mountedWhilePlaying?.ms ?? null, newPxRequests: freshPx.length,
    fullRerenderMs: layer1 && layer1At ? layer1At - t3 : null,
    keyChanged: !!layer1, newKey: layer1 ? { key: layer1.key.slice(0, 12), frames: layer1.frames, small: layer1.smallCount } : null, backfillOrder: state.order, timeline };
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
  // 补渲进层表的轻卡也按预渲染原尺寸导出,改动之后要等它们补渲完,多给几轮
  for (let attempt = 0; attempt < 60 && !exported?.result && Date.now() < deadline; attempt++) {
    exported = await P(phone, async (frames) => window.__pcIo.exportVideoBrowser({ maxFrames: frames, originals: true }), EXPORT_SECONDS * FPS);
    if (!exported?.result) { say('export.retry', { attempt, waits: exported?.waits?.slice(0, 2), error: exported?.error }); await delay(15_000); }
  }
  const sum4 = assetSummary(phone.assets.slice(exportMark), tier);
  const rel4 = await relMediaOf(phone);
  check(!rel4.requests.length, '手机整段(进入、改一处、导出):没有 /@media 请求', rel4);
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
  /*
   * 创建者页面的顶层导航:第一次是探针自己的 goto,第 1b 步探针自己刷新一次,此外的都是「意外的整页重载」。
   * 开发服务里最常见的来源是 Tailwind v4 的 Vite 插件:它自动扫描项目里的文件找类名,扫描到的非模块文件
   * (docs 下的 .md 等)一改就静默发 full-reload(服务端日志里没有「page reload」)。所以跑探针期间不要改工作区里的文件。
   * 产品上刷新后会回到共享项目(第 1b 步验的就是这个),意外重载只记下、不判失败。
   */
  if (state.creator) {
    out.creatorPage = { navs: state.creator.navs, sameDocNavs: state.creator.sameDocNavs, expected: 1 + (state.creatorReloads ?? 0), vite: state.creator.viteLog,
      server: editorLog.filter((l) => /page reload|optimized dependencies|new dependencies|reloading|server restarted/i.test(l)).slice(0, 20).map((l) => l.slice(0, 240)) };
    out.creatorPage.unexpectedReloads = Math.max(0, state.creator.navs.length - out.creatorPage.expected);
  }
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

/** 手机页面上的 `/@media/…` 请求(请求记录 + 页面里挂的钩子记下的发起方:元素链或调用栈;各 frame 都收) */
async function relMediaOf(page) {
  const hits = [];
  for (const f of page.frames()) {
    try { hits.push(...((await f.evaluate(() => window.__pcMediaHits ?? [])) ?? [])); } catch { /* frame 走了 */ }
  }
  return { requests: page.relMedia ?? [], hits: hits.slice(0, 12) };
}

/**
 * 手机舞台此刻的样子(c10a 契约第 17 节的断言用):在播没有、每张活跃卡的包裹层抑制没有、贴没贴小尺寸、有没有占位、
 * 是不是本机渲染不了的卡,以及舞台记下的停下追一帧状态。
 */
async function stageSample(page) {
  const f = page.frames().find((x) => /[?&]stage=1/.test(x.url()));
  if (!f) return null;
  return f.evaluate(() => {
    const d = window.__pcStageDiag?.() ?? {};
    const wraps = [...document.querySelectorAll('[data-pc-clip]:not([data-pc-media])')].filter((w) => !w.parentElement?.closest('[data-pc-clip]')).map((w) => {
      const slot = w.querySelector(':scope > [data-pc-placeholder-slot]');
      return {
        id: w.getAttribute('data-pc-clip'),
        suppressed: w.classList.contains('pc-suppressed'),
        settling: w.classList.contains('pc-settling'),
        plane: !!w.querySelector(':scope > [data-pc-snapshot-plane]'),
        small: !!w.querySelector(':scope > [data-pc-snapshot-plane] img[data-pc-small-snapshot]'),
        placeholder: !!slot && !slot.hidden,
        unsupported: !!slot && !slot.hidden && slot.getAttribute('data-pc-placeholder-reason') === 'unsupported', // 2026-09-29 起 unsupported 进显隐调度(不再常驻)
      };
    });
    return { playing: !!d.beatRunning, t: d.t, wraps, lowMemLive: d.lowMemLive ?? [], settling: d.settling ?? [], lowMemSettle: d.lowMemSettle ?? null };
  }).catch(() => null);
}

/** 手机舞台 iframe 的截图(页面截图在窄屏上看不到预览) */
async function shotStage(page, name) {
  const f = path.join(OUT, `${name}.png`);
  try {
    const el = await page.$('iframe[src*="stage=1"]');
    if (!el) return null;
    await el.evaluate((n) => n.scrollIntoView({ block: 'center' }));
    await el.screenshot({ path: f });
    return f;
  } catch { return null; }
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

/**
 * L22:第 3 步「新的小尺寸到手机」的时刻分解。改动一到创建者就开始在后台采样,第 3 步末尾 `finish` 算出各段时刻:
 *
 *   edit(手机改参数) → creatorSaw(创建者收到) → planPublished(创建者发布 plan,诊断 `published`) → planClaimed(节点认领 plan)
 *   → planSplit(plan 的 task.done,切出细任务) → 各重卡细任务的 claim / render(执行器 `executor.render`,原尺寸与小尺寸同一趟产)
 *   / done(task.done 到创建者:推送两档与写清单都在它之前) → phoneLayerMap(手机层表换成新键) → phoneManifest(手机取到新键下带小尺寸的清单)
 *   → phoneReadyIndex(新键的就绪区间进了手机的就绪表) → phoneMounted(手机舞台贴上新键的画面) → phoneNewPx(手机第一次请求新哈希的 px/)。
 *
 * 手机那边每秒采一次(只记变化),创建者的队列诊断每 2 秒取一次(`events` 只留最近 80 条,采样时累积)。每个时刻给绝对时刻(ISO)
 * 与距改动(`t0`)的毫秒数。拿不到数据源的段记 null,并在 `missing` 里写原因。
 */
function startStep3Timeline({ t0, heavyClip, creatorSawAt }) {
  const phone = state.phone;
  const phoneTrack = [];
  const events = new Map();
  const firstDone = new Map();
  let lastDiag = null;
  const absorb = (q) => {
    for (const e of q?.events ?? []) if (e.at >= t0 - 5000) events.set(`${e.at}|${e.event}|${e.id ?? ''}`, e);
    for (const [id, x] of Object.entries(q?.tasks ?? {})) if (x?.at >= t0 && !firstDone.has(id)) firstDone.set(id, { state: x.state, at: x.at, error: x.error });
  };
  let running = true;
  let lastSig = '';
  const loop = (async () => {
    let lastDiagAt = 0;
    while (running) {
      const at = Date.now();
      const s = await P(phone, (id) => {
        const o = window.__pcOnlineSnapshots?.();
        const f = window.__pcPreviewDiag?.()?.snapshotFeed;
        const layer = o?.layers?.find((l) => l.clipId === id) ?? null;
        const ready = f?.ready?.find((r) => r.clipId === id)?.kinds?.[0] ?? null;
        return { key: layer?.key?.slice(0, 12) ?? null, ready: layer?.ready ?? 0, feedKey: ready?.key ?? null, feedRanges: ready?.ranges ?? 0,
          pick: f?.picks?.find((m) => m.clipId === id)?.key ?? null, mounted: f?.mounted?.find((m) => m.clipId === id)?.key ?? null, t: window.__pcStore?.getState?.().t ?? null };
      }, heavyClip).catch(() => null);
      const w = await stageSample(phone).then((x) => x?.wraps?.find((y) => y.id === heavyClip) ?? null, () => null);
      if (s) {
        const row = { ...s, small: !!w?.small, suppressed: !!w?.suppressed, placeholder: !!w?.placeholder };
        const sig = JSON.stringify(row);
        if (sig !== lastSig) { lastSig = sig; phoneTrack.push({ at, ...row }); }
      }
      if (at - lastDiagAt >= 2000) {
        lastDiagAt = at;
        const q = await diag().catch(() => null);
        if (q) { lastDiag = q; absorb(q); }
      }
      await delay(Math.max(0, 1000 - (Date.now() - at)));
    }
  })();
  const stamp = (at) => (Number.isFinite(at) ? { at: new Date(at).toISOString(), ms: at - t0 } : null);
  return {
    async finish({ layer1, pxBefore, extraClip, fullRerenderAt }) {
      running = false;
      await loop.catch(() => {});
      const q = (await diag().catch(() => null)) ?? lastDiag;
      absorb(q);
      const doneOf = (id) => firstDone.get(id) ?? null;
      const missing = [];
      const newKey = layer1?.key?.slice(0, 12) ?? null;
      const resultKey = layer1?.resultKey ?? null;
      // 创建者:改动之后发布的 plan(改参数、加轻卡各可能一版)
      const pubs = (q?.published ?? []).filter((p) => p.at >= t0 - 1000).sort((a, b) => a.at - b.at);
      const claims = (q?.claims ?? []).filter((c) => c.at >= t0 - 1000);
      const plans = pubs.map((p) => {
        const claim = claims.find((c) => c.id === p.planId);
        const done = doneOf(p.planId);
        const derived = q?.plans?.[p.planId] ?? null;
        return { planId: p.planId.slice(0, 48), rev: p.projectRev, published: stamp(p.at), claimed: stamp(claim?.at), split: done?.state === 'done' ? stamp(done.at) : null,
          derived: Array.isArray(derived) ? derived.length : null };
      });
      if (!pubs.length) missing.push('planPublished:诊断 published 里没有改动之后的发布(可能是别的节点发布的,或 published 被清过)');
      // 重卡新键的细任务:id 是 snapshot:<resultKey>:<from>-<to>
      const renders = [...events.values()].filter((e) => e.event === 'executor.render');
      const heavyTasks = resultKey ? [...new Set([...claims.map((c) => c.id), ...Object.keys(q?.tasks ?? {})])].filter((id) => id.startsWith(`snapshot:${resultKey}:`)) : [];
      const segs = heavyTasks.map((id) => {
        const m = /:(\d+)-(\d+)$/.exec(id);
        const claim = claims.find((c) => c.id === id);
        const done = doneOf(id);
        const r = renders.filter((e) => e.id === id).sort((a, b) => a.at - b.at).pop();
        return { range: m ? `${m[1]}-${m[2]}` : id.slice(-12), from: m ? Number(m[1]) : null, priority: claim?.priority ?? null, claimed: stamp(claim?.at),
          renderStart: r ? stamp(r.at - r.ms) : null, renderEnd: stamp(r?.at), renderMs: r?.ms ?? null, done: done?.state === 'done' ? stamp(done.at) : null,
          pushMs: r && done?.state === 'done' ? done.at - r.at : null };
      }).sort((a, b) => (a.claimed?.ms ?? Infinity) - (b.claimed?.ms ?? Infinity));
      if (!resultKey) missing.push('heavyTasks:重渲没完成,不知道新键的 resultKey');
      else if (!segs.length) missing.push('heavyTasks:诊断里没有新键的细任务(不是本机节点认领的?)');
      if (segs.some((x) => !x.renderEnd)) missing.push('render:部分段的 executor.render 事件不在诊断 events(只留最近 80 条、采样间隔 2 秒)里');
      // 手机那一侧
      const first = (pred) => phoneTrack.find(pred)?.at;
      const keyAt = newKey ? first((x) => x.key === newKey) : undefined;
      const manifestAt = newKey ? first((x) => x.key === newKey && x.ready > 0) : undefined;
      const readyAt = newKey ? first((x) => x.feedKey === newKey && x.feedRanges > 0) : undefined;
      const mountedAt = newKey ? first((x) => x.mounted === newKey) : undefined;
      // 手机播放头所在的段(重卡从第 0 帧起;span 与层表一致,缺省 60)
      const t = phoneTrack.at(-1)?.t ?? null;
      const phoneFrame = t === null ? null : Math.floor(t * FPS + 1e-6);
      const heavySet = new Set(layer1?.smallHashes ?? []);
      const pxAfter = phone.assets.filter((a) => a.ns === 'px' && a.method === 'GET' && !a.sub && a.at >= t0);
      const heavyNew = pxAfter.filter((a) => heavySet.has(a.hash) && !pxBefore.has(a.hash));
      const otherNew = pxAfter.filter((a) => !heavySet.has(a.hash) && !pxBefore.has(a.hash));
      const reused = [...heavySet].filter((h) => pxBefore.has(h)).length;
      if (!mountedAt) missing.push('phoneMounted:暂停着时手机舞台没贴新键(低内存档停下追一帧,当前帧是活渲);播放时贴上的时刻见 steps.edit.mountedWhilePlayingMs');
      const phoneSeg = segs.find((x) => x.from !== null && phoneFrame !== null && x.from <= phoneFrame && phoneFrame < x.from + 60) ?? null;
      const short = (id) => (id.startsWith('plan:') ? id.slice(0, 40) : `${id.split(':')[0]}:${(id.split(':')[1] ?? '').slice(0, 8)}:${id.split(':').pop()}`);
      const queue = claims.map((c) => ({ id: short(c.id), priority: c.priority, claimMs: c.at - t0, doneMs: doneOf(c.id) ? doneOf(c.id).at - t0 : null,
        state: doneOf(c.id)?.state ?? null, ...(doneOf(c.id)?.error ? { error: String(doneOf(c.id).error).slice(0, 120) } : {}),
        renderMs: renders.filter((e) => e.id === c.id).pop()?.ms ?? null }));
      const nodeEvents = [...events.values()].filter((e) => e.event !== 'executor.render' && e.at >= t0).sort((a, b) => a.at - b.at)
        .map((e) => ({ ms: e.at - t0, event: e.event, ...(e.id ? { id: short(String(e.id)) } : {}), ...(e.error ? { error: String(e.error).slice(0, 120) } : {}) }));
      return {
        t0: stamp(t0), creatorSaw: stamp(creatorSawAt), plans, heavySegments: segs, phoneFrame, phoneSegment: phoneSeg?.range ?? null,
        phoneLayerMap: stamp(keyAt), phoneManifest: stamp(manifestAt), phoneReadyIndex: stamp(readyAt), phoneMounted: stamp(mountedAt),
        phoneNewPx: { heavyFirst: stamp(heavyNew[0]?.at), heavyCount: heavyNew.length, otherFirst: stamp(otherNew[0]?.at), otherCount: otherNew.length,
          heavyHashes: heavySet.size, heavyHashesAlreadyOnPhone: reused, extraClip: extraClip ? extraClip.slice(0, 8) : null },
        fullRerender: stamp(fullRerenderAt), queue, nodeEvents, phoneTrack: phoneTrack.map((x) => ({ ms: x.at - t0, ...x, at: undefined })), missing,
      };
    },
  };
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
  const missingSmall = [];
  for (let from = 0; from < layer.count; from += span) {
    const to = Math.min(layer.count - 1, from + span - 1);
    const m = await conn.rpc({ type: 'content.get', kind: 'snapshot-manifest', key: `${layer.resultKey}:${from}-${to}` });
    if (m?.type !== 'content.item' || m.missing) { state.layerWhy = { segment: `${from}-${to}`, count: layer.count, span, reply: m?.type ?? null }; return null; }
    frames += (m.body?.frames ?? []).length;
    const smallAt = new Set((m.body?.small ?? []).map((s) => s[0]));
    for (const [f] of m.body?.frames ?? []) if (!smallAt.has(f)) missingSmall.push(f);
    for (const s of m.body?.small ?? []) small.push(s[1]);
  }
  if (!small.length) { state.layerWhy = { frames, small: 0 }; return null; }
  for (const h of [...new Set(small)].slice(0, 5)) {
    const has = await conn.client.has('px', h).catch((e) => `error: ${String(e?.message ?? e).slice(0, 120)}`);
    if (has !== true) { state.layerWhy = { frames, small: small.length, pxHas: has }; return null; }
  }
  return { key: layer.key, resultKey: layer.resultKey, frames, count: layer.count, smallCount: small.length, missingSmall, smallHashes: small };
}
