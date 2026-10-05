/**
 * 桌面应用自动成为共享项目的渲染节点:照壳的真实启动环境跑一遍(报告 `docs/archive/agent-reports/AGENT-desktop-auto-node.md`;
 * 语义 `docs/semantics/product/platforms.md`「渲染节点」:加入共享项目的桌面应用自动成为这个项目的渲染节点)。
 *
 *   node scripts/probes/desktop-auto-node-probe.mjs [--base-port 5750] [--dist <在线构建目录>] [--out <目录>] [--keep-temp]
 *        [--skip-off]        不跑第二遍(PROMPTCUT_AUTO_RENDER_NODE=0)
 *        [--only-off]        只跑第二遍
 *        [--keep-project]    结束时不删探针建的共享项目
 *        [--timeout-min 60]
 *
 *   对着真实托管端(主会话部署之后自己跑;子会话不对阿里云跑):
 *   node scripts/probes/desktop-auto-node-probe.mjs --remote https://<站点> [--base-port 5750] [--skip-off]
 *     - 不起本机托管组合:在线页面取 `<站点>/editor`,文档服务 `<站点>/hosted/`,素材服务 `<站点>/media/api/asset`;
 *     - 共享项目由桌面页面当场建(勾「多用户协作」放云端),凭证是页面表单上生成的,只在内存里用,不打印、不落盘;
 *       结束时用创建者凭证删掉这个项目(`--keep-project` 不删,只打印项目 id)。
 *
 * 端口段(+0～+9):+0 编辑器页的源(在线构建、`/hosted/`、`/media/` 反代)、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务、
 * +5 桌面版编辑器(+6、+7 是它的舞台端口)。桌面版的预渲染进程照壳的做法由编辑器自己挑空闲端口(`listenSafe`)。
 *
 * 桌面版照壳(`desktop/src-tauri/src/lib.rs` 约 440～500 行)的方式起:`node node_modules/vite/bin/vite.js --port <+5> --strictPort --host 127.0.0.1`,
 * 环境从本进程的环境里**去掉全部 `PROMPTCUT_*` 与 `VITE_PC_*`**,再只放壳给的那几类:`BROWSER=none`、`PROMPTCUT_EXPORT_DIR`、`PROMPTCUT_DATA_DIR`
 * (都指到系统临时目录,帧库不落 `Videos\PromptCut`),外加两个存储位置 `PROMPTCUT_PROJECTS_DIR`、`PROMPTCUT_WORK_DIR`(壳不设,缺省落在
 * 应用目录里;这里指到临时目录,免得写进工作副本)。明确不设 `PROMPTCUT_SHARED_CONFIG`、`PROMPTCUT_QUEUE_NODE`、`PROMPTCUT_PUSH`。
 *
 * 第一遍(缺省开关):
 *   0  桌面页面建项目:重卡 H(`probe-slow-stepped`,本机 preload 先渲出来,只在本机帧库里 —— 真机缺陷里「两小时前渲过、只在本地」的层)、
 *      用户卡 U1、U2(`mu-animated-shiny-text`);勾「多用户协作」放云端(本机托管组合当云端)。
 *   A1 桌面进入项目后,队列诊断 `/api/frames/queue` 的 `nodes` 里有这个项目的节点;推送日志有 `push.started`,目标是云端素材服务
 *   A2 云端内容库出现这个项目的层表(`layers:<项目文档 id>`),H 那一层(交接前渲的、补推上去的)与用户卡 U1 那一层各段清单齐,产物字节在云端素材服务里
 *   A3 另一台设备(在线构建、另一个浏览器上下文 = 另一个设备 id)凭邀请进同一项目,贴出 U1 的层(没有「需要本地 PC 渲染辅助」图标与徽标)
 *   A4 桌面页面关掉(节点照常在线)之后,在线页面把 U2 改成一段新内容(没有预渲染结果):在线页面发布的清单计划被这台桌面的节点认领、切分,
 *      细任务由它完成,在线页面随之贴上
 *   A5 桌面页面回来(同一个标签页,刷新后回到共享项目、重交配置),再离开项目:节点撤掉,`nodes` 回空,推送队列停
 *   A7 桌面绑着共享项目时,另一个浏览器上下文在同一台桌面上开一个**不共享**的本机项目 B(同样的重卡,标签不同):
 *      B 的帧在本机渲完之后,云端素材服务里没有 B 的任何一块、云端内容库没有 B 的层表,B 的 plan 没发进共享项目的队列;
 *      推送诊断里记着挡掉的段(`outOfScope`);绑定没被打断(仍绑着共享项目)(报告 `docs/archive/agent-reports/AGENT-push-scope.md`)
 *   另核:桌面页面与在线页面的项目文档 id 一致、层表键对得上;节点报的代码版本就是在线构建嵌的那一个。
 * 第二遍(`PROMPTCUT_AUTO_RENDER_NODE=0`):
 *   A6 同样建项目放云端,等 40 秒:不起节点(`nodes` 空)、不推送(日志没有 `push.started`,云端没有这个项目的层表)
 *
 * 输出:过程写 stderr;stdout 最后一行一行 JSON `{ ok, fails, … }`。不打印口令、邀请码、票据。
 *
 * 环境变量 `PC_CHROME_ARGS`(空格分隔)只把参数原样透传给探针起的 Chrome,排障取证用,例如 `--log-net-log=<文件>` 抓网络日志
 * (r4、r5 两次合流里探针新开的页面偶发 120～180 s 打不开在线页,见 `docs/plan/TODO.md`)、云端 Linux 以 root 运行时的 `--no-sandbox`。
 * 不要用它关 TLS 校验(如 `--ignore-certificate-errors`),否则证书有问题时探针照样通过,掩盖真问题。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
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
const BASE = Number(arg('--base-port', 5750));
const KEEP = argv.includes('--keep-temp');
const KEEP_PROJECT = argv.includes('--keep-project');
const SKIP_OFF = argv.includes('--skip-off');
const ONLY_OFF = argv.includes('--only-off');
const REMOTE_ARG = arg('--remote', null);
const REMOTE = !!REMOTE_ARG;
const PORTS = { site: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4, desktop: BASE + 5 };
for (const p of [5190, 5191, 5192, 5203, 5210]) if (Object.values(PORTS).includes(p) || PORTS.desktop + 1 === p || PORTS.desktop + 2 === p) { process.stderr.write(`端口段碰到了 ${p}(用户的编辑器或安装版)\n`); process.exit(2); }
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const SITE = REMOTE ? String(REMOTE_ARG).replace(/\/+$/, '') : `http://127.0.0.1:${PORTS.site}`;
const STAGE_ORIGINS = REMOTE ? [] : [`http://127.0.0.1:${PORTS.stageA}`, `http://127.0.0.1:${PORTS.stageB}`];
const HOSTED = `${SITE}/hosted/`;
const EDITOR = `${SITE}/editor`;
const ASSET = `${SITE}/media/api/asset`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-auto-node-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'shots')));
fs.mkdirSync(OUT, { recursive: true });
const started = Date.now();
const deadline = started + Number(arg('--timeout-min', 60)) * 60_000;
const FPS = 30;
const SECONDS = 4;

const fails = [];
const out = { ok: false, run: RUN, target: REMOTE ? 'remote' : 'local', site: SITE, out: OUT, steps: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 600)}`)); return !!cond; };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
const codeOf = (link) => String(link ?? '').split('invite=')[1] ?? '';

async function until(label, fn, timeoutMs, everyMs = 500) {
  const begin = Date.now();
  const end = Math.min(Date.now() + timeoutMs, deadline);
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    // 每一处等待落定都记一行(等了多久),卡在哪一步从 stderr 看得出来
    if (v) { say('wait.ok', { label, ms: Date.now() - begin }); return v; }
    if (Date.now() > end) { say('wait.timeout', { label, ms: Date.now() - begin }); fails.push(`超时:${label}`); return null; }
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

/* ================================================================== 本机替身:托管组合 + 三个源的仿 nginx 代理(同 c10-browser-probe) */

let combo = null;
const proxies = [];
/** 代理上升级过的连接(两头的 socket),收尾时一起掐掉 */
const upgraded = new Set();
let DIST = null;
async function startLocalSite() {
  for (const p of [PORTS.site, PORTS.stageA, PORTS.stageB, PORTS.doc, PORTS.asset]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  DIST = arg('--dist', null);
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
    docPublicUrl: `ws://127.0.0.1:${PORTS.site}/hosted/`, assetPublicUrl: ASSET, log: () => {},
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
      upgraded.add(socket);
      socket.on('close', () => upgraded.delete(socket));
      const up = net.connect(PORTS.doc, '127.0.0.1', () => {
        const lines = [`${req.method} ${target} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      upgraded.add(up);
      up.on('close', () => { upgraded.delete(up); socket.destroy(); });
      socket.on('close', () => up.destroy());
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
    });
    proxies.push(server);
    return new Promise((r) => server.listen(port, '127.0.0.1', r));
  };
  await Promise.all([makeProxy(PORTS.site), makeProxy(PORTS.stageA), makeProxy(PORTS.stageB)]);
  say('local.up', { site: SITE, doc: PORTS.doc, asset: PORTS.asset, dist: DIST });
}

/* ================================================================== 桌面版编辑器:照壳的环境起 */

/** 照壳给的环境:去掉全部 PROMPTCUT_* / VITE_PC_*,只放壳给的那几类(路径指到临时目录) */
function shellEnv(dir, { autoOff }) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^PROMPTCUT_/i.test(k) || /^VITE_PC_/i.test(k)) continue;
    env[k] = v;
  }
  const tmp = path.join(dir, 'tmp');
  for (const d of [tmp, path.join(dir, 'data'), path.join(dir, 'projects'), path.join(dir, 'work')]) fs.mkdirSync(d, { recursive: true });
  Object.assign(env, {
    BROWSER: 'none',
    PROMPTCUT_EXPORT_DIR: dir,
    PROMPTCUT_DATA_DIR: path.join(dir, 'data'),
    PROMPTCUT_PROJECTS_DIR: path.join(dir, 'projects'),
    PROMPTCUT_WORK_DIR: path.join(dir, 'work'),
    TEMP: tmp, TMP: tmp, TMPDIR: tmp,
  });
  if (autoOff) env.PROMPTCUT_AUTO_RENDER_NODE = '0';
  // 排障(`--prerender-log`):预渲染进程的全部输出另存一份(壳不设这个变量;只影响日志)
  if (argv.includes('--prerender-log')) env.PROMPTCUT_PRERENDER_LOG = path.join(OUT, `${path.basename(dir)}-prerender.log`);
  return env;
}

let desktop = null;
async function startDesktop({ autoOff, name }) {
  for (const p of [PORTS.desktop, PORTS.desktop + 1, PORTS.desktop + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  const dir = path.join(TMP, name);
  const env = shellEnv(dir, { autoOff });
  const envKeys = Object.keys(env).filter((k) => /^PROMPTCUT_/i.test(k)).sort();
  check(!envKeys.includes('PROMPTCUT_SHARED_CONFIG') && !envKeys.includes('PROMPTCUT_QUEUE_NODE') && !envKeys.includes('PROMPTCUT_PUSH'), `${name}:桌面版环境里没有 SHARED_CONFIG / QUEUE_NODE / PUSH`, envKeys);
  const log = [];
  const child = spawn(process.execPath, [path.relative(ROOT, viteBin()).startsWith('node_modules') ? 'node_modules/vite/bin/vite.js' : viteBin(), '--port', String(PORTS.desktop), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  let partial = '';
  const keep = (c) => {
    const lines = (partial + c.toString()).split(/\r?\n/);
    partial = lines.pop();
    // 行首带收到的时刻(`@<毫秒>`),分段耗时据此拼;找行的正则不锚行首,解析 JSON 从第一个 `{` 起,不受影响
    for (const line of lines) { log.push(`@${Date.now()} ${line}`); if (log.length > 20000) log.shift(); }
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  desktop = { child, origin: `http://127.0.0.1:${PORTS.desktop}`, log, dir, name };
  const up = await until(`${name}:桌面版编辑器起来`, async () => {
    if (child.exitCode !== null) throw new Error('exited');
    return fetch(`${desktop.origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 240_000, 500);
  if (!up) throw new Error(`编辑器没起来:${log.slice(-8).join(' | ').slice(0, 500)}`);
  const pre = await until(`${name}:预渲染进程就绪`, async () => { const i = await getJson(`${desktop.origin}/api/prerender/info`, 3000); return i?.ready && i.url ? i.url : null; }, 240_000, 500);
  if (!pre) throw new Error('预渲染进程没起来');
  desktop.prerender = pre;
  say('desktop.up', { name, origin: desktop.origin, prerender: pre, envKeys });
  return { envKeys };
}
async function stopDesktop() {
  if (!desktop?.child?.pid) return;
  const pre = await getJson(`${desktop.origin}/api/prerender/info`, 3000).catch(() => null);
  try { fs.writeFileSync(path.join(OUT, `${desktop.name}-editor.log`), desktop.log.join('\n')); } catch { /* 写不了 */ }
  killTree(desktop.child.pid);
  const prePort = pre?.url ? Number(new URL(pre.url).port) : null;
  if (prePort) { const pid = pidOnPort(prePort); if (pid) killTree(pid); }
  for (const p of [PORTS.desktop, PORTS.desktop + 1, PORTS.desktop + 2]) { const pid = pidOnPort(p); if (pid) killTree(pid); }
  desktop = null;
}
const dq = () => getJson(`${desktop.origin}/api/frames/queue`, 10_000);
const dRenderNode = () => getJson(`${desktop.origin}/api/frames/render-node`, 10_000);
const dRelay = () => getJson(`${desktop.origin}/api/render-node/status`, 10_000);
const dDiag = () => getJson(`${desktop.prerender}/api/frames/diagnostics`, 20_000);
/** 桌面版编辑器日志里转出来的预渲染进程行(`[prerender] …`) */
const logLines = (re) => (desktop?.log ?? []).filter((l) => re.test(l));
const jsonOfLine = (line) => { try { return JSON.parse(line.slice(line.indexOf('{'))); } catch { return null; } };

/* ================================================================== 文档服务的核对连接 */

let M = null;
async function mods() {
  const [route, client, shared, ticket, asset, link] = await Promise.all([
    import('../../server/auth/route.mjs'), import('../../server/auth/client.mjs'), import('../../server/auth/shared-config.mjs'),
    import('../../server/auth/ticket-source.mjs'), import('../../server/asset-store/client.mjs'), import('../../server/render-node/session-link.mjs'),
  ]);
  return { ...client, ...route, ...shared, ...ticket, ...asset, createDocEndpoint: link.createDocEndpoint };
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
    const reqId = `dan-${++seq}-${randomBytes(3).toString('hex')}`;
    const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error(`等 ${message.type} 的回包超时`)); }, timeoutMs);
    waiting.set(reqId, { resolve, timer });
    if (!ep.send({ ...message, reqId })) { waiting.delete(reqId); clearTimeout(timer); reject(new Error(`${message.type} 没发出去`)); }
  });
}
async function openConn({ projectId, username, password, as }) {
  const entry = M.normalizeEntry({ url: M.wsBaseOf(HOSTED), projectId, username, password, as, role: 'page', deviceId: `dan-chk-${randomBytes(6).toString('hex')}`, deviceName: 'desktop-auto-node 核对' });
  const ep = M.createDocEndpoint({ url: entry.url, protocols: M.sharedProtocols(entry, { role: 'page' }), log: () => {} });
  const opened = await new Promise((resolve) => {
    if (ep.connected) return resolve(true);
    const t = setTimeout(() => resolve(false), 20_000);
    ep.onOpen(() => { clearTimeout(t); resolve(true); });
  });
  if (!opened) { try { ep.close(); } catch { /* 没连上 */ } throw new Error('核对连接连不上文档服务'); }
  const assets = M.createAssetClient({ base: ASSET, ticket: M.createTicketSource(ep, { access: 'r' }) });
  return { ep, rpc: rpcOn(ep), assets, close: () => { try { ep.close(); } catch { /* 已关 */ } } };
}
async function adminDelete(projectId, creator) {
  const protocols = await M.buildAuthProtocols({ base: HOSTED, projectId, username: creator.username, deviceId: `dan-admin-${RUN}`.padEnd(16, '0'), deviceName: 'desktop-auto-node admin', as: 'creator', password: creator.password, role: 'page' });
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
  const m = await M.adminProof({ key, projectId, username: creator.username, op: 'delete', nonce: ch.nonce });
  const r = await ask({ type: 'shared.admin', op: 'delete', proof: { nonce: ch.nonce, m } });
  ws.close();
  return r?.type ?? null;
}
/** 层表里某个片段那一层:各段清单齐不齐、产物字节在不在云端素材服务 */
async function layerCovered(conn, docId, clipId, { notResultKey = null } = {}) {
  const r = await conn.rpc({ type: 'content.get', kind: 'snapshot-manifest', key: `layers:${docId}` });
  if (r?.type !== 'content.item' || r.missing) return null;
  const l = (r.body?.layers ?? []).find((x) => x.clipId === clipId);
  if (!l || (notResultKey && l.resultKey === notResultKey)) return null;
  let frames = 0;
  const hashes = [];
  for (let from = 0; from < l.count; from += r.body.span) {
    const m = await conn.rpc({ type: 'content.get', kind: 'snapshot-manifest', key: `${l.resultKey}:${from}-${Math.min(l.count - 1, from + r.body.span - 1)}` });
    if (m?.type !== 'content.item' || m.missing) return null;
    for (const f of m.body?.frames ?? []) { frames++; if (typeof f?.[1] === 'string') hashes.push(f[1]); }
  }
  if (frames !== l.count) return null;
  let present = 0;
  for (const h of hashes) if (await conn.assets.has('snap', h)) present++;
  return present === hashes.length ? { mapProjectId: r.body.projectId ?? null, v: r.body.v, envFingerprint: l.envFingerprint, fullResultKey: l.resultKey, resultKey: l.resultKey.slice(0, 16), count: l.count, blocks: hashes.length, present } : null;
}

/* ================================================================== 页面小件(同 c10-browser-probe) */

let browser = null;
async function launchBrowser() {
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  return puppeteer.launch({
    headless: true, protocolTimeout: 900_000, defaultViewport: { width: 1600, height: 1000 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required', '--disable-gpu', ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : [])],
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
async function newPage(ctx) {
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.pageErrors = [];
  page.on('pageerror', (e) => page.pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  return page;
}
const previewDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcPreviewDiag?.() ?? null)); } catch { return null; } }).catch(() => null);
const onlineDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcOnlineSnapshots?.() ?? null)); } catch { return null; } }).catch(() => null);
async function frontFrame(page) {
  const d = await previewDiag(page);
  const id = d?.frontId ?? 'A';
  return page.frames().find((f) => /[?&]stage=1/.test(f.url()) && new URL(f.url()).searchParams.get('id') === id) ?? null;
}
/** 可见舞台上这个片段:贴着快照没有、「需要本地 PC 渲染辅助」的图标在不在 */
async function clipStage(page, clipId) {
  const f = await frontFrame(page);
  return f ? f.evaluate((id) => {
    const w = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
    const slot = w?.querySelector(':scope > [data-pc-placeholder-slot]');
    const plane = w?.querySelector(':scope > [data-pc-snapshot-plane]');
    return w ? { snapshot: !!plane && plane.childElementCount > 0, placeholder: !!slot && !slot.hidden, reason: slot?.getAttribute('data-pc-placeholder-reason') ?? null } : null;
  }, clipId).catch(() => null) : null;
}
const clipBadge = (page, clipId) => P(page, (id) => !!document.querySelector(`[data-clip-id="${id}"] [data-pc="clip-custom-card"]`), clipId).catch(() => null);
/** 在线页面贴出了这个片段的层:层表里有、就绪、舞台上是快照、没有图标与徽标 */
async function onlinePasted(page, clipId, seekTo, { notResultKey = null } = {}) {
  await P(page, (t) => window.__pcStore.actions.seek(t), seekTo).catch(() => {});
  const o = await onlineDiag(page);
  const l = o?.layers?.find((x) => x.clipId === clipId && (!notResultKey || x.resultKey !== notResultKey));
  const st = await clipStage(page, clipId);
  const badge = await clipBadge(page, clipId);
  return l && l.ready > 0 && st?.snapshot && !st.placeholder && badge === false ? { layer: { ready: l.ready, envFingerprint: l.envFingerprint ?? null, resultKey: String(l.resultKey ?? '').slice(0, 16) }, stage: st } : null;
}

/** 桌面页面建项目、放卡、测完 */
async function desktopProject(page, name, { userCards, label = 'H' }) {
  await page.goto(`${desktop.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await until('桌面页面舞台起来', () => P(page, () => document.querySelectorAll('iframe').length >= 2 && !document.querySelector('[data-pc="probe-gate"]')), 300_000, 500);
  await P(page, () => { for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click(); });
  await P(page, async (n) => { const S = await import('/src/store/project.ts'); S.actions.newProject(n); S.actions.seek(0); }, name);
  const clips = await P(page, async (spec) => {
    const S = await import('/src/store/project.ts');
    const heavy = S.actions.addClipOnNewTrack({ index: 0, cardId: 'probe-slow-stepped', start: 0, duration: spec.seconds });
    S.actions.setClipParams(heavy.id, { burnMs: 40, label: spec.label });
    const out = { heavy: heavy?.id ?? null, u1: null, u2: null };
    if (spec.userCards) {
      const u1 = S.actions.addClipOnNewTrack({ index: 0, cardId: 'mu-animated-shiny-text', start: 0, duration: spec.seconds });
      S.actions.setClipParams(u1.id, { text: `U1 ${spec.run}` });
      const u2 = S.actions.addClipOnNewTrack({ index: 0, cardId: 'mu-animated-shiny-text', start: 0, duration: spec.seconds });
      S.actions.setClipParams(u2.id, { text: `U2 ${spec.run}` });
      out.u1 = u1?.id ?? null;
      out.u2 = u2?.id ?? null;
    }
    S.actions.seek(1);
    return out;
  }, { seconds: SECONDS, userCards, run: RUN, label });
  const docId = await P(page, async () => (await import('/src/store/project.ts')).getState().project.id);
  await until('桌面页面测量测完', async () => P(page, async () => { const R = await import('/src/editor/probeRunner.ts'); return !R.probeProgress().running && !document.querySelector('[data-pc="probe-gate"]'); }), 300_000, 500);
  return { ...clips, docId };
}
/** 桌面页面勾「多用户协作」放云端;回 { projectId, link, creator } */
async function enableCloud(page, name) {
  await P(page, () => window.dispatchEvent(new Event('pc-open-project-settings')));
  await page.waitForSelector('[data-pc="collab-section"]', { visible: true, timeout: 20_000 });
  await page.click('[data-pc="collab-toggle"]');
  await page.waitForSelector('[data-pc="collab-where-hosted"]', { visible: true });
  const nameFilled = await until('创建者用户名的缺省值填上', () => page.$eval('#pc-collab-creator', (i) => i.value.trim()).catch(() => ''), 10_000, 200);
  if (!nameFilled) { fails.pop(); await typeInto(page, '#pc-collab-creator', `dan-creator-${RUN}`.slice(0, 32)); }
  const creator = { username: await page.$eval('#pc-collab-creator', (i) => i.value), password: await page.$eval('#pc-collab-cpw', (i) => i.value) };
  await page.click('[data-pc="collab-where-hosted"]');
  await typeInto(page, '[data-pc="collab-hosted-url"]', HOSTED);
  await page.click('.pc-dialog-foot .pc-btn--primary');
  const enabled = await until('放云端开启完成', async () => { const t = await textOf(page, '[data-pc="collab-status"]'); return t && !t.includes('正在设置') ? t : null; }, 90_000, 300);
  check(enabled?.includes('多用户协作已开启。'), `${name}:桌面页面开启「多用户协作」放云端`, { status: enabled });
  await page.waitForSelector('[data-pc="collab-invite-link"]', { timeout: 20_000 });
  const link = (await textOf(page, '[data-pc="collab-invite-link"]')).trim();
  await page.keyboard.press('Escape');
  const found = await M.lookupProject({ base: HOSTED, name });
  return { projectId: found.projectId, link, creator, enabledAt: Date.now() };
}
/** 本机帧库里这张卡已经渲了几帧(桌面页面交接前的本机 preload) */
async function localFrames(clipId) {
  const d = await dDiag().catch(() => null);
  for (const plan of d?.plans ?? []) {
    const c = plan.controls?.find((x) => x.clipId === clipId);
    if (!c?.snapshotKey || c.tier !== 'shared') continue;
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(desktop.dir, 'frame-library', 'controls-html', c.snapshotKey, 'index.json'), 'utf8'));
      let n = 0;
      for (const v of idx.frames ?? []) { const [a, b] = Array.isArray(v) ? v : [v, v]; n += b - a + 1; }
      return { frames: n, picked: c.picked, key: c.snapshotKey.slice(0, 12) };
    } catch { return { frames: 0, picked: c.picked, key: c.snapshotKey.slice(0, 12) }; }
  }
  return null;
}
/** 这张卡在本机帧库里的共享档快照键(完整) */
async function snapKeyOf(clipId) {
  const d = await dDiag().catch(() => null);
  for (const plan of d?.plans ?? []) {
    const c = plan.controls?.find((x) => x.clipId === clipId);
    if (c?.snapshotKey && c.tier === 'shared') return c.snapshotKey;
  }
  return null;
}
/** 本机帧库里这个共享档快照键下每一帧 HTML 的 sha256(推送时块的哈希就是它,`artifact-transfer.mjs`) */
async function frameHashes(key) {
  const { createHash } = await import('node:crypto');
  const dir = path.join(desktop.dir, 'frame-library', 'controls-html', key);
  const out = new Set();
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (/^\d+\.html$/.test(f)) out.add(createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex'));
  return out;
}
/** 在线构建里嵌的代码版本是不是这一个(在编辑器页的脚本里找这串 64 位十六进制) */
async function onlineBuildHas(codeVersion) {
  if (!/^[a-f0-9]{64}$/.test(String(codeVersion))) return false;
  const html = await (await fetch(EDITOR, { signal: AbortSignal.timeout(20_000) })).text();
  const srcs = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((m) => new URL(m[1], `${EDITOR}/`).href);
  const seen = new Set();
  const queue = [...srcs];
  while (queue.length && seen.size < 400) {
    const u = queue.shift();
    if (seen.has(u)) continue;
    seen.add(u);
    const text = await (await fetch(u, { signal: AbortSignal.timeout(20_000) })).text().catch(() => '');
    if (text.includes(codeVersion)) return true;
    for (const m of text.matchAll(/["'`](\.{0,2}\/?(?:editor\/)?assets\/[A-Za-z0-9._-]+\.js)["'`]/g)) queue.push(new URL(m[1], u).href);
  }
  return false;
}

/* ================================================================== 主流程 */

const state = {};
const projects = [];
let conn = null;
try {
  M = await mods();
  if (!REMOTE) await startLocalSite();
  const health = await getJson(`${SITE}/hosted/healthz`).catch((e) => ({ error: String(e?.message ?? e) }));
  if (!check(health?.ok, '托管端 /hosted/healthz', health)) throw new Error('托管端不通');
  browser = await launchBrowser();

  if (!ONLY_OFF) {
    /* ---------------------------------------------------------------- 0. 桌面页面建项目、本机先渲、放云端 */
    const t0 = Date.now();
    const env0 = await startDesktop({ autoOff: false, name: 'desktop-on' });
    out.steps.env = env0;
    const dctx = await browser.createBrowserContext();
    const dpage = await newPage(dctx);
    state.desktopPage = dpage;
    const name = `自动节点-${RUN}`;
    const clips = await desktopProject(dpage, name, { userCards: true });
    Object.assign(state, clips);
    check(state.heavy && state.u1 && state.u2, '桌面页面放好 H、U1、U2', clips);
    const q00 = await dq();
    check(Array.isArray(q00?.nodes) && q00.nodes.length === 0, '本机项目(还没放云端)时没有节点', q00);
    // 交接前本机 preload 先把 H 渲完(真机缺陷里「帧库里渲过、只在本地」的层)
    const localH = await until('本机 preload 先把 H 渲完', async () => { const f = await localFrames(state.heavy); return f && f.frames >= SECONDS * FPS ? f : null; }, 600_000, 2000);
    state.localBefore = { heavy: localH, u1: await localFrames(state.u1), u2: await localFrames(state.u2) };
    say('step0.local', state.localBefore);
    const cloud = await enableCloud(dpage, name);
    Object.assign(state, { projectId: cloud.projectId, link: cloud.link, creator: cloud.creator });
    projects.push({ projectId: cloud.projectId, creator: cloud.creator });
    out.steps.create = { ms: Date.now() - t0, projectId: state.projectId, docId: state.docId, clips: { heavy: state.heavy, u1: state.u1, u2: state.u2 }, localBefore: state.localBefore };
    say('step0.done', out.steps.create);

    /* ---------------------------------------------------------------- A1. 节点起来、推送队列建起来(目标是云端素材服务) */
    const t1 = Date.now();
    const q1 = await until('A1:队列诊断的 nodes 里有这个项目的节点', async () => {
      const q = await dq();
      const n = q?.nodes?.find((x) => x.projectId === state.projectId);
      return n?.connected ? q : null;
    }, 240_000, 1000);
    const node = q1?.nodes?.find((x) => x.projectId === state.projectId);
    check(!!node, 'A1:桌面进入项目后成了这个项目的渲染节点', q1);
    const pushStarted = await until('A1:推送日志有 push.started', () => logLines(/\[artifact-push\] push\.started /).map(jsonOfLine).find((j) => j?.projectId === state.projectId) ?? null, 60_000, 500);
    const assetBaseLine = logLines(/\[artifact-push\] push\.asset-base /).map(jsonOfLine).filter(Boolean);
    check(pushStarted && String(pushStarted.asset ?? '').startsWith(ASSET), 'A1:push.started,推送目标是云端素材服务', { pushStarted, assetBaseLine });
    check(pushStarted?.docservice === 'page' && String(pushStarted?.url ?? '').includes('/hosted'), 'A1:推送队列连的是页面交来的那个文档服务', pushStarted);
    const rn1 = await dRenderNode();
    const relay1 = await dRelay();
    check(rn1?.bound === true && rn1.projectId === state.projectId && rn1.started === true, 'A1:预渲染进程的自动渲染节点绑着这个项目', rn1);
    check(relay1?.binding?.projectId === state.projectId && relay1.enabled === true, 'A1:编辑器进程记着这份共享配置(不含票据)', relay1);
    check(!JSON.stringify([rn1, relay1]).includes('v1.'), 'A1:诊断里没有票据', null);
    state.nodeSummary = { nodeId: node?.nodeId ?? null, codeVersion: q1?.codeVersion ?? null, envFingerprint: q1?.envFingerprint ?? null };
    out.steps.a1 = { ms: Date.now() - t1, node: node ? { projectId: node.projectId, nodeId: node.nodeId, connected: node.connected } : null, pushStarted, assetBase: assetBaseLine.slice(-3), renderNode: rn1, relay: { binding: relay1?.binding, relay: relay1?.relay } };
    say('a1.done', out.steps.a1);

    /* ---------------------------------------------------------------- A2. 云端层表:H(交接前渲的、补推的)齐、字节在云端 */
    const t2 = Date.now();
    conn = await openConn({ projectId: state.projectId, username: state.creator.username, password: state.creator.password, as: 'creator' });
    const heavyCloud = await until('A2:云端层表里 H 那一层各段清单齐、字节在云端素材服务', () => layerCovered(conn, state.docId, state.heavy), 600_000, 3000);
    check(!!heavyCloud, 'A2:交接前本机渲的层(H)补推到云端素材服务并写进云端层表', heavyCloud);
    const backfill = logLines(/\[queue-node\] render-node\.backfill /).map(jsonOfLine).filter(Boolean);
    check(backfill.some((b) => b.projectId === state.projectId && b.frames >= SECONDS * FPS), 'A2:补推日志 render-node.backfill 列出交接前已有的帧', backfill);
    check(!heavyCloud || heavyCloud.envFingerprint === state.nodeSummary.envFingerprint, 'A2:H 那一层出自这台桌面的环境', { layer: heavyCloud?.envFingerprint, node: state.nodeSummary.envFingerprint });
    out.steps.a2 = { ms: Date.now() - t2, heavy: heavyCloud, backfill };
    say('a2.heavy', out.steps.a2);

    /* ---------------------------------------------------------------- A7. 同时开着的另一个本机项目:它的帧不到云端 */
    const t7 = Date.now();
    const octx = await browser.createBrowserContext();
    const opage = await newPage(octx);
    const other = await desktopProject(opage, `本机另一项目-${RUN}`, { userCards: false, label: `B ${RUN}` });
    const otherLocal = await until('A7:另一个本机项目的重卡在本机渲完', async () => { const f = await localFrames(other.heavy); return f && f.frames >= SECONDS * FPS ? f : null; }, 600_000, 2000);
    check(!!otherLocal, 'A7:另一个本机项目的帧写进了同一个帧库', otherLocal);
    const keyB = await snapKeyOf(other.heavy);
    const keyA = await snapKeyOf(state.heavy);
    check(keyB && keyB !== keyA, 'A7:两个项目的重卡快照键不同', { keyA: keyA?.slice(0, 12), keyB: keyB?.slice(0, 12) });
    // 推送队列静置 1.5 s 再推,留足余量等它(推错了也该推完了)
    await delay(15_000);
    const hashesA = keyA ? await frameHashes(keyA) : new Set();
    const hashesB = [...(keyB ? await frameHashes(keyB) : new Set())].filter((h) => !hashesA.has(h));
    let leaked = 0;
    for (const h of hashesB) if (await conn.assets.has('snap', h)) leaked++;
    const mapB = await conn.rpc({ type: 'content.get', kind: 'snapshot-manifest', key: `layers:${other.docId}` }).catch((e) => ({ error: String(e?.message ?? e) }));
    const push7 = (await dDiag())?.push ?? null;
    const published7 = (await dDiag())?.queue?.published ?? [];
    const outLines = logLines(/\[artifact-push\] push\.out-of-scope /).map(jsonOfLine).filter(Boolean);
    const rn7 = await dRenderNode();
    check(hashesB.length > 0 && leaked === 0, 'A7:云端素材服务里没有另一个本机项目的任何一块', { blocks: hashesB.length, leaked });
    check(mapB?.type === 'content.item' && mapB.missing === true, 'A7:云端内容库没有另一个本机项目的层表', { type: mapB?.type, missing: mapB?.missing, error: mapB?.error });
    check((push7?.outOfScope ?? 0) > 0 && !(push7?.items ?? []).some((i) => keyB && i.id.includes(keyB)), 'A7:推送队列挡掉了另一个项目的段(outOfScope),队里没有它的', { outOfScope: push7?.outOfScope, scope: push7?.scope, items: push7?.items?.length });
    check(!published7.some((p) => p.projectId === other.docId), 'A7:另一个项目的 plan 没发进共享项目的队列', published7.map((p) => p.projectId));
    check(outLines.length > 0, 'A7:编辑器日志里看得到 push.out-of-scope', logLines(/push\./).slice(-5));
    check(rn7?.bound === true && rn7.projectId === state.projectId, 'A7:开另一个本机项目没有打断共享项目的绑定', rn7);
    // 绑定项目照常:H 那一层仍齐(A2 已核),这里再核一次它的块都在
    const heavyStill = await layerCovered(conn, state.docId, state.heavy);
    check(!!heavyStill, 'A7:绑定项目的层照常在云端', heavyStill);
    out.steps.a7 = { ms: Date.now() - t7, otherDocId: other.docId, keyB: keyB?.slice(0, 12), frames: otherLocal?.frames ?? 0, blocks: hashesB.length, leaked,
      layerMapMissing: mapB?.missing === true, outOfScope: push7?.outOfScope ?? null, scope: push7?.scope ?? null, published: published7.map((p) => p.projectId), outOfScopeLines: outLines.length };
    say('a7.done', out.steps.a7);
    await opage.close().catch(() => {});
    await octx.close().catch(() => {});

    /* ---------------------------------------------------------------- A3. 另一台设备的在线页面进同一项目,贴出 U1 */
    const t3 = Date.now();
    const mctx = await browser.createBrowserContext();
    const member = await newPage(mctx);
    state.member = member;
    await member.goto(`${EDITOR}#invite=${codeOf(state.link)}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await member.waitForSelector('[data-pc="join-invite-project"]', { visible: true, timeout: 60_000 });
    await typeInto(member, '[data-pc="join-username"]', '另一台设备');
    await member.click('[data-pc="join-submit"]');
    const joined = await member.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 90_000 }).then(() => true, () => false);
    if (!check(joined, 'A3:在线页面凭邀请进入', { message: await textOf(member, '[data-pc="join-message"]') })) throw new Error('在线页面没进去');
    await until('A3:在线页面测完', async () => !(await P(member, () => !!document.querySelector('[data-pc="probe-gate"]'))) && (await previewDiag(member))?.dual !== undefined, 300_000, 500);
    const a3Marks = { joined: Date.now() - t3 };
    const firstU1 = { stage: await clipStage(member, state.u1), badge: await clipBadge(member, state.u1) };
    const u1 = await until('A3:在线页面贴出 U1 的层(没有图标与徽标)', () => onlinePasted(member, state.u1, 1), 900_000, 4000);
    a3Marks.pasted = Date.now() - t3;
    a3Marks.firstPlanAt = ((await P(member, () => window.__pcPlanPublisher?.() ?? null).catch(() => null))?.log ?? []).find((x) => x.ok)?.at ?? null;
    if (a3Marks.firstPlanAt) a3Marks.firstPlanAt -= t3;
    await shot(member, 'a3-online-u1');
    check(!!u1, 'A3:在线页面贴出用户卡 U1 的层,没有「需要本地 PC 渲染辅助」', { u1, firstU1, last: { stage: await clipStage(member, state.u1), badge: await clipBadge(member, state.u1), online: (await onlineDiag(member))?.layers?.find((x) => x.clipId === state.u1) ?? null } });
    const u1Cloud = await until('A2:云端层表里 U1 那一层齐、字节在云端', () => layerCovered(conn, state.docId, state.u1), 120_000, 3000);
    check(!!u1Cloud, 'A2:用户卡 U1 那一层写进云端层表,产物字节在云端素材服务', u1Cloud);
    // 核对:项目文档 id 两边一致、层表键对得上
    const memberDocId = await P(member, () => window.__pcStore.getState().project.id);
    check(memberDocId === state.docId && (u1Cloud?.mapProjectId ?? state.docId) === state.docId, '核对:桌面页面与在线页面的项目文档 id 一致,层表键 layers:<id> 对得上', { desktop: state.docId, member: memberDocId, map: u1Cloud?.mapProjectId, tenant: state.projectId });
    // 核对:节点报的代码版本 = 在线构建嵌的那一个
    const cvOk = await onlineBuildHas(state.nodeSummary.codeVersion).catch(() => false);
    check(cvOk, '核对:渲染节点报的代码版本就是在线构建嵌进页面的那一个(requires.codeVersion)', { node: String(state.nodeSummary.codeVersion).slice(0, 16) });
    out.steps.a3 = { ms: Date.now() - t3, marks: a3Marks, firstU1, u1, u1Cloud, ids: { desktop: state.docId, member: memberDocId, tenant: state.projectId }, codeVersionInOnlineBuild: cvOk };
    say('a3.done', out.steps.a3);

    /* ---------------------------------------------------------------- A4. 桌面页面关掉;在线页面把 U2 改成新内容,清单计划由这台桌面认领并完成 */
    const t4 = Date.now();
    await dpage.goto('about:blank').catch(() => {});
    await delay(3000);
    const qGone = await dq();
    check(qGone?.nodes?.some((x) => x.projectId === state.projectId), 'A4:桌面页面关掉之后节点照常在线', qGone);
    const before = await P(member, () => window.__pcPlanPublisher?.() ?? null).catch(() => null);
    // U2 改之前那一层的结果键:改完之后要等一层新的(不同的结果键),免得把旧内容的层当成贴上了
    const u2Old = await until('A4:改之前 U2 已有一层(在线计划渲的)', () => layerCovered(conn, state.docId, state.u2), 600_000, 3000);
    const oldKey = u2Old?.fullResultKey ?? null;
    // 分段计时(毫秒,相对「在线页面改 U2」那一刻):planPublishedAt 是页面记的发布成功时刻,其余是探针看到的时刻(按各自的轮询间隔有滞后)
    const marks = { start: t4, u2OldSeen: Date.now(), edit: Date.now() };
    await P(member, (spec) => { const s = window.__pcStore; s.actions.setClipParams(spec.id, { text: spec.text }); s.actions.seek(1); }, { id: state.u2, text: `U2 新内容 ${RUN}` });
    await delay(1500);
    const firstU2 = { stage: await clipStage(member, state.u2), badge: await clipBadge(member, state.u2) };
    await shot(member, 'a4-online-u2-before');
    const plan = await until('A4:在线页面发布了含 U2 的新清单计划', async () => {
      const d = await P(member, () => window.__pcPlanPublisher?.() ?? null).catch(() => null);
      return d?.last && d.last !== before?.last && d.lastClips?.includes(state.u2) ? d : null;
    }, 120_000, 1000);
    const planId = plan?.last ?? null;
    marks.planSeen = Date.now();
    marks.planPublishedAt = [...(plan?.log ?? [])].reverse().find((x) => x.id === planId && x.ok)?.at ?? null;
    const claimed = await until('A4:这台桌面的节点认领并切分了在线页面的那个计划', async () => {
      const q = (await dDiag())?.queue;
      const inClaims = q?.claims?.some((c) => c.id === planId);
      const split = q?.plans && Object.prototype.hasOwnProperty.call(q.plans, planId);
      return inClaims && split ? { derived: q.plans[planId], completed: q.local?.completed ?? [] } : null;
    }, 600_000, 2000);
    marks.claimedSeen = Date.now();
    check(!!claimed, 'A4:在线页面发布的清单计划被这台桌面的节点认领、切分', { planId, claimed: !!claimed });
    const u2Cloud = await until('A4:云端层表里 U2 换成新内容那一层(结果键变了)、各段齐、字节在云端', () => layerCovered(conn, state.docId, state.u2, { notResultKey: oldKey }), 900_000, 3000);
    marks.cloudLayerSeen = Date.now();
    check(!!u2Cloud && !!oldKey, 'A4:U2 的新内容由这台桌面渲出、推到云端、写进层表', { oldKey: oldKey?.slice(0, 16), u2Cloud });
    const u2 = await until('A4:在线页面贴上 U2 的新内容', () => onlinePasted(member, state.u2, 1, { notResultKey: oldKey }), 900_000, 4000);
    marks.pastedSeen = Date.now();
    await shot(member, 'a4-online-u2-after');
    check(!!u2, 'A4:在线页面随之贴上 U2(没有图标与徽标)', { u2, firstU2, last: { stage: await clipStage(member, state.u2), online: (await onlineDiag(member))?.layers?.find((x) => x.clipId === state.u2) ?? null } });
    const q4 = (await dDiag())?.queue;
    const derived = Array.isArray(q4?.plans?.[planId]) ? q4.plans[planId] : [];
    const doneByDesktop = derived.filter((id) => q4?.local?.completed?.includes(id) || q4?.local?.dedup?.includes(id));
    check(derived.length === 0 || doneByDesktop.length > 0, 'A4:那个计划切出的细任务由这台桌面完成', { derived: derived.length, doneByDesktop: doneByDesktop.length });
    const rel = Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, typeof v === 'number' ? v - marks.edit : null]));
    out.steps.a4 = { ms: Date.now() - t4, editToPastedMs: marks.pastedSeen - marks.edit, marks: rel, marksAbs: marks, planId, firstU2, oldKey: oldKey?.slice(0, 16), u2Cloud, derived: derived.length, doneByDesktop: doneByDesktop.length, u2, pageGoneNodes: qGone?.nodes?.map((n) => n.projectId) };
    say('a4.done', out.steps.a4);
    // 分段耗时的原始材料:预渲染进程的队列诊断(事件里有 executor.render-timing)
    try { fs.writeFileSync(path.join(OUT, 'a4-diag.json'), JSON.stringify(await dDiag(), null, 1)); } catch { /* 取不到 */ }

    /* ---------------------------------------------------------------- A5. 桌面页面回来(刷新后回到共享项目),再离开:节点撤掉 */
    const t5 = Date.now();
    await dpage.goto(`${desktop.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    const resumed = await until('A5:桌面页面回到共享项目(同一标签页,刷新后自动回去)', () => P(dpage, async () => {
      const S = await import('/src/editor/sync/syncManager.ts');
      const H = window.__pcRenderNodeHandoff?.();
      return S.currentSharedLink() && H?.bound ? { handoff: H } : null;
    }), 180_000, 1000);
    check(!!resumed, 'A5:桌面页面回到共享项目、重交配置', resumed);
    const rnBack = await dRenderNode();
    check(rnBack?.bound === true && rnBack.counters?.same >= 1 && rnBack.counters?.starts === 1, 'A5:同一个项目重交配置只换票据,不重建节点', rnBack?.counters);
    if (resumed) {
      await P(dpage, async () => { const S = await import('/src/editor/sync/syncManager.ts'); S.leaveSharedToLocal(); });
    } else {
      // 页面回不去时照样验撤掉:直接走编辑器进程的撤掉接口(页面离开时发的就是它)
      await fetch(`${desktop.origin}/api/render-node/unbind`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: state.projectId, reason: 'probe' }) }).catch(() => {});
    }
    const q5 = await until('A5:离开项目后 nodes 回空', async () => { const q = await dq(); return Array.isArray(q?.nodes) && q.nodes.length === 0 && q.auto?.bound === false ? q : null; }, 60_000, 1000);
    const relay5 = await dRelay();
    check(!!q5, 'A5:桌面页面离开项目后节点撤掉,nodes 回空', q5 ?? await dq());
    check(relay5?.binding === null, 'A5:编辑器进程不再记着这份共享配置', relay5?.binding);
    const teardown = (await until('A5:日志有 render-node.teardown', () => { const t = logLines(/\[queue-node\] render-node\.teardown /).map(jsonOfLine).filter(Boolean); return t.length ? t : null; }, 30_000, 500)) ?? [];
    const dPush = await until('A5:推送队列停了', async () => { const d = await dDiag(); return d && !('push' in d) ? d : null; }, 30_000, 1000);
    check(!!dPush, 'A5:推送队列停了(预渲染进程诊断里没有 push)', (await dDiag())?.push ?? null);
    out.steps.a5 = { ms: Date.now() - t5, resumed: !!resumed, counters: rnBack?.counters, nodes: q5?.nodes ?? null, teardown };
    say('a5.done', out.steps.a5);
    out.steps.pageErrors = { desktop: dpage.pageErrors.slice(-6), member: member.pageErrors.slice(-6) };
    try { conn.close(); } catch { /* 已关 */ }
    conn = null;
    await member.close().catch(() => {});
    await dctx.close().catch(() => {});
    await mctx.close().catch(() => {});
    await stopDesktop();
  }

  if (!SKIP_OFF) {
    /* ---------------------------------------------------------------- A6. PROMPTCUT_AUTO_RENDER_NODE=0:不起节点、不推送 */
    const t6 = Date.now();
    const env6 = await startDesktop({ autoOff: true, name: 'desktop-off' });
    const ctx6 = await browser.createBrowserContext();
    const page6 = await newPage(ctx6);
    const name6 = `自动节点关-${RUN}`;
    const clips6 = await desktopProject(page6, name6, { userCards: true });
    await until('A6:本机 preload 先把 H 渲完', async () => { const f = await localFrames(clips6.heavy); return f && f.frames >= SECONDS * FPS ? f : null; }, 600_000, 2000);
    const cloud6 = await enableCloud(page6, name6);
    projects.push({ projectId: cloud6.projectId, creator: cloud6.creator });
    await delay(40_000);
    const q6 = await dq();
    const rn6 = await dRenderNode();
    const relay6 = await dRelay();
    check(Array.isArray(q6?.nodes) && q6.nodes.length === 0, 'A6:开关关着:不起节点(nodes 空)', q6);
    check(rn6?.enabled === false && rn6.off === 'disabled' && rn6.bound === false, 'A6:预渲染进程报开关关着、没绑', rn6);
    check(relay6?.enabled === false && relay6.binding === null, 'A6:编辑器进程不记、不转共享配置', relay6);
    check(logLines(/\[artifact-push\] push\.started /).length === 0 && logLines(/\[queue-node\] render-node\.(bind|started) /).length === 0, 'A6:日志里没有 push.started、render-node.bind', logLines(/push\.started|render-node\./).slice(-5));
    const c6 = await openConn({ projectId: cloud6.projectId, username: cloud6.creator.username, password: cloud6.creator.password, as: 'creator' });
    const map6 = await c6.rpc({ type: 'content.get', kind: 'snapshot-manifest', key: `layers:${clips6.docId}` }).catch((e) => ({ error: String(e?.message ?? e) }));
    c6.close();
    check(map6?.type === 'content.item' && map6.missing === true, 'A6:云端没有这个项目的层表(没推送)', { type: map6?.type, missing: map6?.missing, error: map6?.error });
    out.steps.a6 = { ms: Date.now() - t6, envKeys: env6.envKeys, nodes: q6?.nodes, renderNode: rn6, relay: relay6, layerMapMissing: map6?.missing === true };
    say('a6.done', out.steps.a6);
    await ctx6.close().catch(() => {});
    await stopDesktop();
  }
} catch (e) {
  fails.push(`探针异常:${String(e?.stack ?? e).slice(0, 1200)}`);
  for (const [name, page] of [['desktop', state.desktopPage], ['member', state.member]]) if (page) await shot(page, `fatal-${name}`).catch(() => {});
} finally {
  try { conn?.close(); } catch { /* 已关 */ }
  const deleted = [];
  for (const p of projects) {
    if (KEEP_PROJECT) { deleted.push({ projectId: p.projectId, kept: true }); continue; }
    deleted.push({ projectId: p.projectId, result: await Promise.race([
      adminDelete(p.projectId, p.creator).catch((err) => `error:${String(err?.message ?? err).slice(0, 80)}`),
      delay(20_000).then(() => 'timeout'),
    ]) });
  }
  try { await browser?.close(); } catch { /* 已关 */ }
  await stopDesktop().catch(() => {});
  // 升级过的 WebSocket 连接不归 http 服务器管,close 的回调会一直等它们:先全部掐掉,再限时等(以前会在这里挂住、不出结果行)
  for (const sock of upgraded) { try { sock.destroy(); } catch { /* 已断 */ } }
  const within = (p, ms) => Promise.race([p, delay(ms)]);
  for (const s of proxies) await within(new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); }), 5000);
  try { await within(combo?.close(), 10_000); } catch { /* 已关 */ }
  out.cleanup = { deleted, listening: [PORTS.site, PORTS.stageA, PORTS.stageB, PORTS.doc, PORTS.asset, PORTS.desktop, PORTS.desktop + 1, PORTS.desktop + 2].filter((p) => pidOnPort(p)) };
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
