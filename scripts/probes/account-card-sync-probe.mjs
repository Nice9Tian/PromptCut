/**
 * 账号云端项目里的卡片源码同步、卡片声音上传、Agent 一侧旧绑定的端到端探针(报告 `docs/reports/AGENT-v18-cardsync.md`)。
 *
 * 真的服务组合:账号服务、文档服务、独立的素材服务进程(`server/test/fixtures/account-dual-user-path.mjs`,两个账号);
 * 两个桌面编辑器进程(本仓库根起的开发服务器,各有自己的卡片改动层、设备号、数据目录);一个在线页面(在线构建,经夹具的公网入口给)。
 *
 *   npx vite build --mode online --outDir out/v18-cardsync/dist-online
 *   node scripts/probes/account-card-sync-probe.mjs --dist out/v18-cardsync/dist-online [--out <截图目录>] [--keep-temp]
 *   (要设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE,同账号那几条测试)
 *
 * 端口:甲的编辑器 28640(舞台 +1、+2)、乙的编辑器 28645(+1、+2)、夹具 28650～28656(公网入口 28656)、在线页面的两个舞台源 28657、28658(https,同主机)。
 *
 * 没有用真的桌面外壳:页面不点登录表单,直接调 `createAccountClient` 与 `enterAccountProject`(登录表单背后的那两个调用);
 * 外壳的账号桥(`desktop/src-tauri/src/account_vault.rs`)由探针在 Node 一侧照它的接口代答(login / recover / request / logout,
 * 同样的路径白名单),密码与令牌只在内存里。在线页面走真的登录表单。
 *
 * 步骤与核对(`fails` 为空才算过;甲页面往项目里写的几步集中在登录后 100 秒内做,原因见正文第 1 步的注释):
 *   0  甲的编辑器在本机项目里:Agent 服务端绑着本机项目(`/api/agent/status`);进账号项目后变成没绑(原问题:还绑着本机项目)
 *   1  甲建云端项目、建一张用户卡(只在甲的改动层里)、放一个片段 → 甲把源码传上内容库
 *   2  乙进项目 → 乙的改动层里装上源码、页面注册表认得、舞台画出 v1;在线页面也画出 v1
 *   3  甲改卡(v2)→ 乙热更新成 v2(没有整页刷新),舞台画出 v2
 *   4  另一条账号连接直接往内容库写一张卡(模拟云端 Agent)→ 甲、乙的改动层都装上
 *   5  卡片声音:甲放一张带声音的卡、生成声音 → 上传成功;乙凭自己的素材票据取到同样的字节并能解码
 *   6  乙改成只读:乙改卡,上传被拒(not-listed),甲那边仍是原来的版本;改回可写后补传,甲装上乙的版本(v3)
 *   7  乙被踢:乙的同步回到本机空间、不再连;甲再改卡(v4),乙拿不到
 *   8  甲退出登录:甲的同步连接被关、回到本机空间;退出前取的票据连不进去
 * 输出:过程写 stderr;stdout 最后一行是一行 JSON。不打印密码、令牌、票据。
 */
import '../lib/no-user-dirs.mjs';
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import WS from 'ws';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startAccountDualUserFixture } from './account-dual-user-path-probe.mjs';
import { editorSecurityHeaders, mediaSRoute, stageSecurityHeaders } from '../../src/online/stagePolicy.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'out', 'v18-cardsync', 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'docs', 'reports', 'assets', 'v18-cardsync')));
const A_PORT = 28640, B_PORT = 28645;
/** `cards`(缺省):卡片源码同步那一套;`link`:页面那条文档连接的寿命(到期前换会话、断一次传输、睡眠醒来、账号服务不通) */
const SCENARIO = arg('--scenario', 'cards');
/** 排查用:做完第几步就停(缺省做完) */
const STOP_AFTER = Number(arg('--stop-after', '99'));
const FIXTURE_PORTS = [28650, 28651, 28652, 28653, 28654, 28655, 28656];
const STAGE_PORTS = [28657, 28658];
const ORIGIN = `https://127.0.0.1:${FIXTURE_PORTS[6]}`;
/*
 * 在线页面的两个舞台源:与编辑器页同一个主机、不同端口的 https(用夹具公网入口的那张自签证书)。
 * 编辑器页向舞台源交接素材票据靠一个 HttpOnly cookie,要求两边同站且同为 https(真环境是 `https://<主机>` 与 `https://s1.<主机>`);
 * 夹具的公网入口只认 `https://127.0.0.1:<端口>` 这一个源,所以舞台只能摆在同主机的别的端口上。
 * cookie 不分端口,这种摆法测不出「舞台看不见编辑器页的 cookie」,那不是本探针要核的(隔离本身见 `online-card-isolation-*` 那几条探针)。
 */
const STAGES = [`https://127.0.0.1:${STAGE_PORTS[0]}`, `https://127.0.0.1:${STAGE_PORTS[1]}`];
fs.mkdirSync(OUT, { recursive: true });

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时(${ms} ms)`);
    await sleep(150);
  }
}

const RUN = Date.now().toString(36);
const CARD_ID = `acs-probe-${RUN}`;
const CARD_REL = `src/cards/user/${CARD_ID}.tsx`;
const AGENT_CARD_ID = `acs-agent-${RUN}`;
const AGENT_CARD_REL = `src/cards/user/${AGENT_CARD_ID}.tsx`;
const MARK = (v) => `ACS-${RUN}-${v}`.toUpperCase();
const cardSource = (id, mark, bg = '#224') => `import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  return <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 72, color: "#fff", background: "${bg}" }}>{"${mark}"} {params.text}</div>;
}
export const ${id.replace(/[^a-zA-Z0-9]/g, '_')}: CardDef<Params> = {
  id: "${id}", name: "账号同步探针", description: "account-card-sync-probe", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-account-card-sync-'));
const procs = [];
const fails = [];
const navigations = [];
const res = { runId: RUN, cardId: CARD_ID, ports: { a: A_PORT, b: B_PORT, fixture: FIXTURE_PORTS, stages: STAGE_PORTS }, shots: [] };
let fixture = null, browser = null, ca = null;
const wsLog = {};
const stageServers = [];
/** 舞台源拒掉的 `/media-s/…` 请求(状态码与路径形状) */
const stageRejects = [];
const check = (ok, name, detail) => { if (!ok) { fails.push(detail === undefined ? name : `${name}(${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); say('FAIL', { name, detail }); } else say('ok', { name }); return !!ok; };

/* ---------------- 进程 ---------------- */

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
function start(name, args, env) {
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } });
  const log = [];
  const keep = (c) => { log.push(c.toString()); if (log.length > 4000) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const p = { name, child, log, text: () => log.join('') };
  procs.push(p);
  say('spawn', { name, pid: child.pid });
  return p;
}
async function stopAll() {
  for (const p of procs.reverse()) {
    const c = p.child;
    if (!c.pid || c.exitCode !== null) continue;
    const exited = new Promise((r) => c.once('exit', r));
    // 编辑器还拉着预渲染进程和它的 Chrome:连进程树一起结束(只结束自己起的这几棵)
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else c.kill('SIGKILL');
    await Promise.race([exited, sleep(10_000)]);
    say('stopped', { name: p.name, pid: c.pid });
  }
}
async function startEditor(tag, port) {
  const dir = path.join(TMP, tag);
  const overrides = path.join(dir, 'card-overrides');
  for (const d of [overrides, path.join(dir, 'data'), path.join(dir, 'vite-cache')]) fs.mkdirSync(d, { recursive: true });
  const p = start(`editor-${tag}`, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    PROMPTCUT_NO_PORT_FILE: '1',
    PROMPTCUT_DATA_DIR: path.join(dir, 'data'),
    PROMPTCUT_VITE_CACHE_DIR: path.join(dir, 'vite-cache'),
    PROMPTCUT_PUSH: '0',
    PROMPTCUT_LAN_HOST: '',
    PROMPTCUT_CARD_OVERRIDES: overrides,
    PROMPTCUT_DEVICE_ID: `acs-${tag}-${RUN}`.padEnd(16, '0'),
    PROMPTCUT_DEVICE_NAME: `account-card-sync-${tag}`,
    // 编辑器进程自己连夹具的公网入口(自签根证书);真环境里是正式证书,不需要这一项
    NODE_EXTRA_CA_CERTS: fixture.caFile,
    // 账号项目的卡片同步只许连账号云端的文档服务;探针的账号服务是夹具,显式放行它的源
    PROMPTCUT_ACCOUNT_CLOUD_ORIGIN: ORIGIN,
  });
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (p.child.exitCode !== null) throw new Error(`编辑器 ${tag} 退出了:${p.text().slice(-600)}`);
    return fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 240_000, `编辑器 ${tag} 起来`);
  return { tag, origin, overrides, proc: p };
}

/* ---------------- 夹具的公网入口上的请求(Node 一侧) ---------------- */

function edge(route, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request(new URL(route, ORIGIN), { method: data === null ? 'GET' : 'POST', ca, timeout: 20_000,
      headers: { ...(data === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 不是 JSON */ } resolve({ status: r.statusCode, body: json }); });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.end(data ?? undefined);
  });
}
/**
 * 桌面外壳账号桥的替身:接口、路径白名单照 `desktop/src-tauri/src/account_vault.rs` 的脚本。恢复凭证与令牌只留在这个对象里。
 */
function nativeBridge(state) {
  const ROUTES = ['/hosted/shared/account/create', '/hosted/shared/account/join', '/hosted/shared/account/session', '/hosted/shared/account/admin', '/hosted/shared/account/members'];
  const out = (r) => (r.status >= 200 && r.status < 300 && r.body?.ok ? r.body : { ok: false, status: r.status, code: r.body?.code ?? 'cloud-request-failed' });
  return async (operation, args = {}) => {
    try {
      if (operation === 'configuration') return { ok: true, origin: ORIGIN };
      if (operation === 'login') {
        const v = out(await edge('/api/account/editor/login', { body: args }));
        if (v.ok) { state.recovery = v.recoveryToken; state.deviceId = args.deviceId; state.token = v.accessToken; state.accountId = v.account?.id; }
        return v;
      }
      if (operation === 'recover') {
        if (!state.recovery) return null;
        const v = out(await edge('/api/account/editor/recover', { body: { recoveryToken: state.recovery, deviceId: state.deviceId, requestId: randomUUID() } }));
        if (v.ok) { state.recovery = v.recoveryToken; state.token = v.accessToken; }
        return v;
      }
      if (operation === 'logout') {
        const v = out(await edge('/api/account/editor/logout', { body: {}, token: args.accessToken }));
        if (v.ok || v.status === 401) state.recovery = null;
        return v;
      }
      if (operation === 'request') {
        // 探针模拟「账号服务一时不通」:会话接口回 503
        if (state.blockSession && args.path === '/hosted/shared/account/session') return { ok: false, status: 503, code: 'account-unavailable' };
        const consent = args.path === '/api/account/cloud-agent-consent';
        if ((!ROUTES.includes(args.path) && !consent) || !args.accessToken) throw new Error('bad-path');
        state.requests[args.path] = (state.requests[args.path] ?? 0) + 1;
        return out(await edge(args.path, { body: args.body, token: args.accessToken }));
      }
      throw new Error('bad-operation');
    } catch { return { ok: false, status: 503, code: 'desktop-account-bridge' }; }
  };
}
/** 一条裸的账号连接:发一条消息等回包(模拟云端 Agent 写内容库、核对内容库、验旧票据) */
async function rawDoc(ticket, message) {
  const socket = new WS(`${ORIGIN.replace(/^https:/, 'wss:')}/hosted/`, ['promptcut.v1', `promptcut.account.${ticket}`], { ca, handshakeTimeout: 8000 });
  try {
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('raw timeout')), 10_000);
      socket.on('message', (bytes) => { let m; try { m = JSON.parse(bytes.toString('utf8')); } catch { return; } if (m.reqId === 'raw') { clearTimeout(timer); resolve(m); } });
    });
    socket.send(JSON.stringify({ ...message, reqId: 'raw' }));
    return await reply;
  } finally { socket.terminate(); }
}
const sessionOf = (state, projectId) => edge('/hosted/shared/account/session', { body: { projectId, deviceId: state.deviceId, requestId: randomUUID() }, token: state.token });
async function admin(state, projectId, body) {
  const s = await sessionOf(state, projectId);
  return edge('/hosted/shared/account/admin', { body: { projectId, expectedAccessRevision: s.body.accessRevision, requestId: randomUUID(), ...body }, token: state.token });
}

/* ---------------- 在线页面的静态站(在线构建)与两个舞台源 ---------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.wav': 'audio/wav' };
function sendFile(req, res, relative, headers) {
  const file = path.resolve(DIST, relative);
  const rel = path.relative(DIST, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, headers); res.end(); return; }
  const bytes = fs.readFileSync(file);
  res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}
function staticHandler(stage) {
  return (req, res) => {
    const headers = stage ? stageSecurityHeaders(ORIGIN) : editorSecurityHeaders(STAGES);
    const url = new URL(req.url, ORIGIN);
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, headers); res.end(); return true; }
    if (url.pathname === '/editor/runtime-config.json') { res.writeHead(200, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ v: 1, stageOrigins: STAGES })); return true; }
    if (url.pathname === '/editor/_iso/ok') { res.writeHead(204, headers); res.end(); return true; }
    if (url.pathname === '/editor/_iso/redirect') { res.writeHead(302, { ...headers, location: '/editor/_iso/ok' }); res.end(); return true; }
    if (['/editor', '/editor/', '/editor/index.html'].includes(url.pathname)) { sendFile(req, res, 'index.html', headers); return true; }
    if (url.pathname.startsWith('/editor/')) { sendFile(req, res, decodeURIComponent(url.pathname.slice('/editor/'.length)), headers); return true; }
    if (url.pathname.startsWith('/catalog/')) { sendFile(req, res, decodeURIComponent(url.pathname.slice(1)), headers); return true; }
    res.writeHead(404, headers); res.end(); return true;
  };
}
/**
 * 舞台源(与 `scripts/probes/lib/hosted-proxy.mjs` 的舞台角色同样的路由,判定取自 `src/online/stagePolicy.mjs`):
 * 舞台自检用的两条、`/media-s/<sid>/…`(票据交接成 HttpOnly cookie、再换成 Authorization 头转给素材服务)、在线构建的静态文件。
 */
function stageHandler(origin) {
  const fallback = staticHandler(true);
  return (req, res) => {
    const sec = stageSecurityHeaders(ORIGIN);
    const url = new URL(req.url, origin);
    const p = url.pathname;
    const end = (status, headers = {}, body = '') => { res.writeHead(status, { ...sec, ...headers }); res.end(body); };
    const forward = (upstreamPath, headers) => {
      const up = http.request({ host: '127.0.0.1', port: fixture.ports.asset, method: req.method, path: upstreamPath, headers }, (r) => { res.writeHead(r.statusCode ?? 502, { ...r.headers, ...sec }); r.pipe(res); });
      up.on('error', () => { if (!res.headersSent) end(502); else res.destroy(); });
      req.pipe(up);
    };
    const route = mediaSRoute({ method: req.method, pathname: p, origin: req.headers.origin ?? null, authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null }, { editorOrigin: ORIGIN, secure: true });
    if (route.kind === 'reject') { stageRejects.push({ status: route.status, path: p.replace(/[a-f0-9]{16,}/g, '…') }); return end(route.status); }
    if (route.kind === 'preflight' || route.kind === 'grant') return end(204, route.headers);
    if (route.kind === 'proxy') { const headers = { ...req.headers, authorization: route.authorization }; delete headers.cookie; return forward(route.path, headers); }
    if (p === '/editor/_iso/ok') return end(204, { 'cache-control': 'no-store' });
    if (p === '/editor/_iso/redirect') return end(302, { 'cache-control': 'no-store', location: '/editor/_iso/ok' });
    return fallback(req, res);
  };
}
async function startStage(port, origin) {
  const handler = stageHandler(origin);
  const sockets = new Set();
  const server = https.createServer({ key: fs.readFileSync(path.join(fixture.fixtureDir, 'wrong.key')), cert: fs.readFileSync(path.join(fixture.fixtureDir, 'wrong.crt')) }, (req, res) => { try { handler(req, res); } catch { if (!res.headersSent) res.writeHead(500); res.end(); } });
  server.on('connection', (s) => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  stageServers.push({ server, sockets });
}

/* ---------------- 页面 ---------------- */

const P = (page, fn, ...args) => page.evaluate(fn, ...args);
const getJson = (url) => fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }).then((r) => r.json());

async function openDesktop(ed, state) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => say('pageerror', { tag: ed.tag, message: String(e?.message ?? e).slice(0, 300) }));
  page.on('dialog', (d) => void d.dismiss());
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push({ tag: ed.tag, at: Date.now() }); });
  // 各编辑器有自己的依赖预构建目录,第一次打开要等预构建
  page.setDefaultNavigationTimeout(300_000);
  // 这一页与文档服务之间的项目消息(只留类型、版本、谁写的、改了哪些路径):查「你的近期修改已被…覆盖」是谁的哪一步引起的
  const frames = (wsLog[ed.tag] = []);
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const note = (dir) => ({ requestId, response }) => {
    if (response.opcode !== 1) return;
    let m; try { m = JSON.parse(response.payloadData); } catch { return; }
    if (!['project.op', 'project.ops', 'project.overwritten', 'project.op.ok', 'selection.set', 'selection.ok', 'project.open'].includes(m?.type)) return;
    frames.push({ dir, sock: requestId, at: Date.now(), type: m.type, rev: m.rev ?? null, opId: m.opId ?? null, entity: m.entity ?? null, pageId: m.pageId ?? null,
      by: (m.by ?? m.actor)?.accountId ?? null, bySession: (m.by ?? m.actor)?.session ?? m.session ?? null,
      paths: Array.isArray(m.ops) ? m.ops.map((o) => `${o.op} ${String(o.path).slice(0, 80)}`).slice(0, 12) : null, overwrote: m.overwrote ?? null });
    if (frames.length > 3000) frames.shift();
  };
  cdp.on('Network.webSocketFrameReceived', note('in'));
  cdp.on('Network.webSocketFrameSent', note('out'));
  await page.exposeFunction('__probeNative', nativeBridge(state));
  await page.goto(`${ed.origin}/?editor`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => P(page, () => !!window.__pcSyncTest && window.__pcSyncTest.view().status === 'online'), 180_000, `${ed.tag} 页面接上本机文档服务`);
  await waitFor(() => P(page, () => !document.querySelector('[data-pc="probe-gate"]')), 300_000, `${ed.tag} 测量遮罩退下`).catch(() => null);
  await P(page, () => { for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click(); });
  return page;
}
/** 登录(经账号桥的替身);回账号号 */
const loginDesktop = (page, account) => P(page, async (origin, name, password) => {
  const C = await import('/src/account/client.ts');
  const M = await import('/src/editor/sync/syncManager.ts');
  const device = await M.ensureDevice();
  const client = C.createAccountClient({ online: false, origin, device, native: (operation, args) => window.__probeNative(operation, args ?? {}) });
  window.__probeClient = client;
  return (await client.login(name, password, false)).id;
}, ORIGIN, account.name, account.password);
const enterDesktop = (page, projectId, name, create) => P(page, async (origin, projectId, name, create) => {
  const M = await import('/src/editor/sync/syncManager.ts');
  const K = await import('/src/kernel/project.ts');
  const client = window.__probeClient;
  const initial = K.createEmptyProject(name);
  let first;
  if (create) projectId = (await client.create(name, initial, crypto.randomUUID())).projectId;
  else first = await client.join(projectId, crypto.randomUUID());
  await M.enterAccountProject({ client, origin, projectId, name, initial, ...(first ? { firstSession: first } : {}) });
  return projectId;
}, ORIGIN, projectId, name, create);

const pageCard = (page, cardId) => P(page, async (cardId) => {
  const R = await import('/src/kernel/registry.ts');
  const u = R.userCardSources();
  const file = u.fileOf[cardId];
  return { known: R.getCard(cardId) != null, src: file ? u.files[file] ?? null : null };
}, cardId);
async function stageHas(page, text) {
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try { if (await f.evaluate((t) => document.body?.innerText?.includes(t) ?? false, text)) return f.url(); } catch { /* 正在导航的 frame 取不到就跳过 */ }
  }
  return null;
}
async function shot(page, name) {
  // 测量遮罩挡着舞台时先等它退下(等不到就照拍)
  await waitFor(() => P(page, () => !document.querySelector('[data-pc="probe-gate"]')), 60_000, '测量遮罩退下').catch(() => null);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  res.shots.push(path.relative(ROOT, file).split(path.sep).join('/'));
}
/** 关掉挡在舞台上的对话框(首启的 AI 助手设置;里面有本机配置的痕迹,不该进截图) */
async function dismissDialogs(page) {
  for (let i = 0; i < 3; i++) {
    const closed = await P(page, () => { let n = 0; for (const b of document.querySelectorAll('[role="dialog"] button, .ais-dialog button')) if (b.textContent?.trim() === '关闭') { b.click(); n++; } return n; }).catch(() => 0);
    if (!closed) break;
    await sleep(200);
  }
  if (await P(page, () => !!document.querySelector('.ais-dialog')).catch(() => false)) throw new Error('AI 助手设置对话框关不掉,不截图');
}
/** 舞台没画出来时:每个舞台 frame 里注册表认不认得这张卡、页面上写着什么 */
async function stageDiag(page, cardId) {
  const out = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    out.push(await f.evaluate(async (cardId) => {
      let known = null;
      try { known = (await import('/src/kernel/registry.ts')).getCard(cardId) != null; } catch (e) { known = `import-failed:${String(e?.message ?? e).slice(0, 80)}`; }
      return { url: location.href.slice(0, 80), known, text: (document.body?.innerText ?? '').slice(0, 120), diag: (() => { try { const d = window.__pcStageDiag?.(); return d ? Object.keys(d) : null; } catch { return null; } })() };
    }, cardId).catch((e) => ({ url: f.url().slice(0, 80), error: String(e?.message ?? e).slice(0, 120) })));
  }
  return out;
}
const onlineDiag = (page, cardId) => P(page, (cardId) => {
  const d = window.__pcCardExecDiag?.();
  const sources = window.__pcCardSources?.();
  const preview = window.__pcPreviewDiag?.();
  return { dual: preview?.dual ?? null, cardExec: preview?.cardExec ?? null, available: d?.available ?? null, visual: d?.visual ?? null, run: d?.run?.[cardId] ?? null, cards: (sources?.cards ?? []).map((c) => c.id), frames: [...document.querySelectorAll('iframe')].map((f) => { try { return new URL(f.src).origin; } catch { return null; } }) };
}, cardId).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
/**
 * 页面那条文档连接的寿命(真实的 120 秒访问令牌)。时间都从甲登录算起:
 *   约 15 秒  乙(桌面)断一次传输:几秒内接回,之后照常收到甲的改动
 *   30 / 130 / 250 / 400 秒  甲(桌面)各改一次、在线页面各改一次:别的成员看得到,服务端版本前进
 *   135～270 秒  在线页面挂起(浏览器把页面的脚本与计时器停掉,模拟电脑睡眠,超过一个令牌寿命);醒来后先显示离线、重连上,
 *                追上别人的改动,自己再改一次别人看得到
 *                (挂起的是在线页面:桌面这两页是开发服务器给的,挂起会让热更新通道断开、醒来整页重载,那是开发服务器的行为)
 *   全程        甲每换一次会话,都在新连接上重新发布选区(同一个页面号)并得到确认
 *   400 秒之后  甲的账号服务不通:到期后页面转离线(不显示在线),离线时改一次;恢复后补发,别人看得到
 */
async function linkScenario({ A, B, pageA, pageB, stateA, stateB, projectId, aLoginAt }) {
  const since = () => Math.round((Date.now() - aLoginAt) / 1000);
  const L = (res.link = { checkpoints: [], scenario: 'link' });
  // 在线页面(乙的账号)
  const ctxC = await browser.createBrowserContext();
  await ctxC.overridePermissions(ORIGIN, []);
  const pageC = await ctxC.newPage();
  pageC.setDefaultTimeout(90_000); pageC.setDefaultNavigationTimeout(120_000);
  pageC.on('pageerror', (e) => say('pageerror', { tag: 'online', message: String(e?.message ?? e).slice(0, 300) }));
  const typeInto = async (selector, value) => { const input = await pageC.waitForSelector(selector, { visible: true }); await input.click({ clickCount: 3 }); await pageC.keyboard.press('Backspace'); await input.type(value); };
  await pageC.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });
  await typeInto('[data-pc="account-projects"] input[name="username"]', fixture.accounts[1].name);
  await typeInto('[data-pc="account-projects"] input[name="password"]', fixture.accounts[1].password);
  await pageC.waitForFunction(() => { const b = document.querySelector('[data-pc="account-projects"] form button.sp-primary-btn'); return Boolean(b && !b.disabled); });
  await pageC.click('[data-pc="account-projects"] form button.sp-primary-btn');
  await pageC.waitForSelector('[data-pc="account-name"]', { visible: true });
  await typeInto('[data-pc="cloud-project-link"]', `${ORIGIN}/editor?project=${projectId}`);
  await pageC.click('[data-pc="cloud-join"]');
  await pageC.waitForSelector('[data-pc="editor"]', { visible: true });
  await waitFor(() => P(pageC, () => !!window.__pcStore), 30_000, '在线页面的时间轴');
  say('link.online-entered', { at: since() });

  // 三个页面各记一份状态流水(每 250 毫秒看一眼页面显示的同步状态)
  const watch = (page) => P(page, () => {
    window.__linkLog = [];
    const read = () => (window.__pcSyncTest ? window.__pcSyncTest.view().status : document.querySelector('[data-pc="sync-status"]')?.getAttribute('data-status') ?? null);
    setInterval(() => { const s = read(); const log = window.__linkLog; if (!log.length || log[log.length - 1].s !== s) log.push({ at: Date.now(), s }); }, 250);
  });
  await watch(pageA); await watch(pageB);
  const statusLog = (page) => P(page, () => window.__linkLog ?? []).catch(() => []);

  const addDesktop = (page, at) => P(page, async (at) => { const S = await import('/src/store/project.ts'); return S.actions.addCardClip('av-pulse', at, { duration: 1 })?.id ?? null; }, at);
  const hasDesktop = (page, id) => P(page, async (id) => (await import('/src/store/project.ts')).getState().project.tracks.some((t) => t.clips.some((c) => c.id === id)), id).catch(() => false);
  const addOnline = (at) => P(pageC, (at) => window.__pcStore.actions.addCardClip('av-pulse', at, { duration: 1 })?.id ?? null, at);
  const hasOnline = (id) => P(pageC, (id) => window.__pcStore.getState().project.tracks.some((t) => t.clips.some((c) => c.id === id)), id).catch(() => false);
  const serverRev = async (state) => { const t = await sessionOf(state, projectId); const m = await rawDoc(t.body.connectionTicket, { type: 'project.open', projectId }); return m.rev ?? null; };
  const lifeOf = (page) => P(page, () => window.__pcSyncTest?.accountLife?.() ?? null).catch(() => null);
  const until = (seconds) => waitFor(() => since() >= seconds, 600_000, `甲登录满 ${seconds} 秒`);
  let slot = 20;
  let frozen = false;

  // ---- 断一次传输(乙的桌面页面、在线页面)
  await until(12);
  {
    const cutOne = async (label, cut, stats, hasFn) => {
      const before = await stats();
      const t0 = Date.now();
      const did = await cut();
      const back = await waitFor(async () => { const s = await stats(); return s && s.resumes > (before?.resumes ?? 0) && s.transport === 'ws' ? Date.now() : null; }, 90_000, `${label} 接回`).catch(() => null);
      const id = await addDesktop(pageA, slot += 2);
      const seen = await waitFor(() => hasFn(id).then((v) => (v ? Date.now() : null)), 90_000, `${label} 收到断线之后甲的改动`).catch(() => null);
      const out = { did, resumeMs: back ? back - t0 : null, sawEditMs: seen ? seen - t0 : null, opens: (await stats())?.opens ?? null };
      L[`cut-${label}`] = out;
      check(did === true && out.resumeMs !== null && out.resumeMs < 10_000 && out.sawEditMs !== null && out.sawEditMs < 15_000, `断一次传输-${label}:几秒内接回并收到之后的改动`, out);
    };
    await cutOne('desktop', () => P(pageB, () => window.__pcSyncTest.cut()), () => P(pageB, () => window.__pcSyncTest.link()), (id) => hasDesktop(pageB, id));
  }

  // ---- 四个时刻各改一次
  for (const at of [30, 130, 250, 400]) {
    if (at === 250) {
      // 130 秒那一轮之后在线页面被挂起,到这里还没醒:这一轮它不看、不改
    }
    await until(at);
    const revBefore = await serverRev(stateA);
    const idA = await addDesktop(pageA, slot += 2);
    const observers = { 乙桌面: () => hasDesktop(pageB, idA), ...(frozen ? {} : { 在线页面: () => hasOnline(idA) }) };
    const seenA = {};
    for (const [name, fn] of Object.entries(observers)) seenA[name] = !!(await waitFor(fn, 15_000, `${name} 看到甲在 ${at} 秒的改动`).catch(() => false));
    // 在线页面挂起的那一轮由乙(桌面)来改
    const idC = frozen ? await addDesktop(pageB, slot += 2) : await addOnline(slot += 2);
    const seenC = !!(await waitFor(() => hasDesktop(pageA, idC), 15_000, `甲看到别人在 ${at} 秒的改动`).catch(() => false));
    await sleep(500);
    const revAfter = await serverRev(stateA);
    const cp = { at, atActual: since(), aEdit: seenA, [frozen ? 'bEdit' : 'onlineEdit']: { 甲桌面: seenC }, rev: [revBefore, revAfter], lifeA: await lifeOf(pageA), lifeB: await lifeOf(pageB) };
    L.checkpoints.push(cp);
    check(Object.values(seenA).every(Boolean) && seenC && revAfter >= revBefore + 2, `登录 ${at} 秒:甲改一次、${frozen ? '乙' : '在线页面'}改一次,别的成员看得到,版本前进`, cp);
    if (at === 130) {
      // 在线页面睡着:挂起页面(计时器、脚本全停),超过一个令牌寿命
      const cdpB = await pageC.createCDPSession();
      await cdpB.send('Page.enable');
      await cdpB.send('Page.setWebLifecycleState', { state: 'frozen' });
      frozen = cdpB;
      L.sleep = { frozenAt: since() };
      say('link.online-suspended', { at: since() });
    }
    if (at === 250) {
      await until(272);
      const missed = idA;
      await frozen.send('Page.setWebLifecycleState', { state: 'active' });
      L.sleep.wokeAt = since();
      // 用户回到这个标签页(醒来的电脑上标签页回到前台);不这么做,后台标签页的定时器被浏览器压到一分钟一次
      await pageC.bringToFront();
      const cdp = frozen; frozen = false;
      const t0 = Date.now();
      const caught = await waitFor(() => hasOnline(missed).then((v) => (v ? Date.now() : null)), 60_000, '在线页面醒来后追上睡着时别人的改动').catch(() => null);
      const idB = await addOnline(slot += 2);
      const seenB = await waitFor(() => hasDesktop(pageA, idB).then((v) => (v ? Date.now() : null)), 30_000, '甲看到在线页面醒来后的改动').catch(() => null);
      L.sleep = { ...L.sleep, sleptSeconds: L.sleep.wokeAt - L.sleep.frozenAt, caughtUpMs: caught ? caught - t0 : null, editSeenByAMs: seenB ? seenB - t0 : null };
      check(L.sleep.sleptSeconds >= 125 && !!caught && !!seenB, '睡眠醒来(在线页面挂起超过一个令牌寿命):追上别人的改动,自己再改别人看得到', L.sleep);
      await cdp.detach().catch(() => {});
    }
  }

  // 到这里甲在线 400 多秒:换过几次会话、页面显示过哪些状态、进项目的提示有没有重复弹
  {
    const logA = await statusLog(pageA);
    const lifeA = await lifeOf(pageA);
    const toastA = await P(pageA, () => (document.querySelector('[data-pc="sync-toasts"]')?.textContent ?? '').split('已进入云端项目').length - 1);
    L.steady = { lifeA, statusesA: [...new Set(logA.map((x) => x.s))], toastEntered: toastA };
    check((lifeA?.renews ?? 0) >= 4 && lifeA.expires === 0, '甲 400 秒里按时换了至少 4 次会话,连接没有作废过', lifeA);
    check(L.steady.statusesA.every((s) => s === 'online' || s === 'connecting'), '甲的页面这 400 秒只显示过在线(换会话的瞬间是连接中),没有离线', L.steady.statusesA);
    check(toastA === 1, '「已进入云端项目」只提示一次(换会话不重复提示)', toastA);
    // 选区:甲每条到文档服务的连接上都发布过选区、都得到确认,而且是同一个页面号
    const fr = wsLog.a ?? [];
    const socks = [...new Set(fr.filter((f) => f.type === 'project.open').map((f) => f.sock))];
    const perSock = socks.map((s) => ({ set: fr.filter((f) => f.sock === s && f.type === 'selection.set').length, ok: fr.filter((f) => f.sock === s && f.type === 'selection.ok').length }));
    const pageIds = [...new Set(fr.filter((f) => f.type === 'selection.set').map((f) => f.pageId))];
    L.selection = { connections: socks.length, perConnection: perSock, pageIds: pageIds.length };
    check(socks.length >= (lifeA?.renews ?? 0) + 1 && perSock.every((x) => x.set >= 1 && x.ok >= 1) && pageIds.length === 1, '甲每换一次会话都在新连接上重新发布了选区并得到确认,页面号不变', L.selection);
  }

  // ---- 账号服务不通(只对甲的页面):到期后如实转离线;离线时的改动恢复后补发
  {
    stateA.blockSession = true;
    const t0 = Date.now();
    const offline = await waitFor(() => P(pageA, () => (window.__pcSyncTest.view().status === 'offline' ? Date.now() : null)), 150_000, '甲换不成会话、到期后转离线').catch(() => null);
    const lifeA = await lifeOf(pageA);
    const idOff = await addDesktop(pageA, slot += 2);
    await sleep(3000);
    const during = { status: await P(pageA, () => window.__pcSyncTest.view().status), seenByB: await hasDesktop(pageB, idOff), toasts: await P(pageA, () => [...document.querySelectorAll('[data-pc="sync-toasts"] > *')].map((e) => e.textContent?.trim().slice(0, 40)).slice(-4)) };
    await dismissDialogs(pageA);
    await shot(pageA, 'link-a-account-service-down');
    stateA.blockSession = false;
    const back = await waitFor(() => hasDesktop(pageB, idOff).then((v) => (v ? Date.now() : null)), 60_000, '账号服务恢复后甲离线时的改动补发,乙看得到').catch(() => null);
    const after = await waitFor(() => P(pageA, () => (window.__pcSyncTest.view().status === 'online' ? 'online' : null)), 30_000, '甲回到在线').catch(() => P(pageA, () => window.__pcSyncTest.view().status));
    L.outage = { offlineAfterMs: offline ? offline - t0 : null, expires: lifeA?.expires ?? null, during, recovered: !!back, statusAfter: after };
    check(!!offline && during.status === 'offline' && during.seenByB === false, '账号服务不通:到期后甲的页面如实显示离线,不是在线', L.outage);
    check(!!back && after === 'online', '账号服务恢复:甲离线时的改动补发成功,乙看得到,甲回到在线', { recovered: !!back, statusAfter: after });
    await shot(pageA, 'link-a-recovered');
  }
}

const cardStatus = (ed) => getJson(`${ed.origin}/api/cards/sync/status`);
const cardSourceOf = async (ed, id) => { const s = await getJson(`${ed.origin}/api/cards/source?id=${id}`).catch(() => null); return s?.ok ? s.source : null; };
const overrideOf = (ed, rel) => { try { return fs.readFileSync(path.join(ed.overrides, rel), 'utf8'); } catch { return null; } };

try {
  // ---------- 夹具:账号服务、文档服务、素材服务进程;公网入口上给在线构建
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`没有在线构建:${DIST}(先跑 npx vite build --mode online --outDir …)`);
  fixture = await startAccountDualUserFixture({ ports: FIXTURE_PORTS, publicHandler: staticHandler(false) });
  ca = fs.readFileSync(fixture.caFile);
  for (const [i, port] of STAGE_PORTS.entries()) await startStage(port, STAGES[i]);
  res.fixture = { origin: fixture.origin, assetPid: fixture.assetPid };
  say('fixture.ready', res.fixture);
  const stateA = { requests: {} }, stateB = { requests: {} };

  // ---------- 两个桌面编辑器进程
  const A = await startEditor('a', A_PORT);
  browser = await puppeteer.launch({ headless: true, acceptInsecureCerts: true, defaultViewport: { width: 1440, height: 900 }, protocolTimeout: 240_000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio'] });
  const pageA = await openDesktop(A, stateA);
  const B = await startEditor('b', B_PORT);
  const pageB = await openDesktop(B, stateB);
  say('editors.ready', { a: A.origin, b: B.origin });

  // ---------- 0 Agent 服务端的绑定:进账号项目之前绑着本机项目
  const agentBefore = await waitFor(async () => { const s = await getJson(`${A.origin}/api/agent/status`); return s.bound ? s : null; }, 30_000, '甲的 Agent 服务端绑上本机项目');
  res.agentBefore = { bound: agentBefore.bound, mode: agentBefore.mode, projectId: agentBefore.projectId ?? null };
  check(agentBefore.bound === true && agentBefore.mode === 'local', '0-甲进账号项目前 Agent 服务端绑着本机项目', res.agentBefore);

  // ---------- 1 甲登录、建云端项目、进去;建卡、放片段
  // 甲这个页面往项目里写的几步(放片段、生成声音)排在前面做;页面连接过了访问令牌的 120 秒之后还写得进去,在后面「连接的寿命」一步单独核
  const accountA = await loginDesktop(pageA, fixture.accounts[0]);
  const aLoginAt = Date.now();
  const projectName = `账号卡片同步-${RUN}`;
  const projectId = await enterDesktop(pageA, null, projectName, true);
  res.projectId = projectId;
  await waitFor(() => P(pageA, () => window.__pcSyncTest.view().kind === 'shared' && !!window.__pcSyncTest.view().shared?.accountId), 30_000, '甲进入账号项目');
  const agentAfter = await waitFor(async () => { const s = await getJson(`${A.origin}/api/agent/status`); return s.bound === false ? s : null; }, 15_000, '甲的 Agent 服务端解绑').catch(() => getJson(`${A.origin}/api/agent/status`));
  res.agentAfter = { bound: agentAfter.bound, projectId: agentAfter.projectId ?? null };
  check(agentAfter.bound === false, '0-甲进账号项目后 Agent 服务端不再绑着本机项目', res.agentAfter);
  const aBound = await waitFor(async () => { const s = await cardStatus(A); return s.projectId === projectId && s.connected ? s : null; }, 30_000, '甲的卡片源码同步连上账号项目');
  check(aBound.local === false, '1-甲的卡片源码同步绑在账号项目上', { projectId: aBound.projectId, local: aBound.local });

  const created = await postJson(`${A.origin}/api/cards/create`, { id: CARD_ID, source: cardSource(CARD_ID, MARK('v1')), existingIds: [], projectId });
  if (!created.ok) throw new Error(`甲建卡失败:${created.error}`);
  check(overrideOf(A, CARD_REL)?.includes(MARK('v1')) && !fs.existsSync(path.join(ROOT, CARD_REL)), '1-卡只在甲的改动层里(仓库底版没有)');
  await waitFor(async () => (await pageCard(pageA, CARD_ID)).known, 30_000, '甲页面认出新卡');
  const clipId = await P(pageA, async (id) => {
    const S = await import('/src/store/project.ts');
    const c = S.actions.addCardClip(id, 0, { duration: 5 });
    S.actions.seek(1);
    return c?.id ?? null;
  }, CARD_ID);
  if (!clipId) throw new Error('甲没放上片段');
  const aPushed = await waitFor(async () => { const s = await cardStatus(A); return s.records?.[CARD_REL]?.rev >= 1 ? s : null; }, 30_000, '甲把卡传上内容库');
  res.aRecord = aPushed.records[CARD_REL];
  check(res.aRecord.mine === true, '1-甲把源码传上云端内容库', res.aRecord);

  // ---------- 2 乙进项目
  const accountB = await loginDesktop(pageB, fixture.accounts[1]);
  check(!!accountA && !!accountB && accountA !== accountB, '2-两个不同的账号');
  await enterDesktop(pageB, projectId, projectName, false);
  const t2 = Date.now();
  await waitFor(() => P(pageB, async (clipId) => (await import('/src/store/project.ts')).getState().project.tracks.some((t) => t.clips.some((c) => c.id === clipId)), clipId), 30_000, '乙看到甲的片段');

  if (SCENARIO === 'link') {
    await linkScenario({ A, B, pageA, pageB, stateA, stateB, projectId, aLoginAt });
    throw Object.assign(new Error('link scenario done'), { done: true });
  }

  // ---------- 4(先做写项目的那半)另一条账号连接直接写内容库(模拟云端 Agent 建卡);甲认出后放一个片段
  {
    const s = await sessionOf(stateA, projectId);
    const put = await rawDoc(s.body.connectionTicket, { type: 'content.put', kind: 'card-source', key: AGENT_CARD_REL, body: cardSource(AGENT_CARD_ID, MARK('agent'), '#252'), session: 'cloud-agent-sim' });
    check(put.type === 'content.stored', '4-直接写进内容库', { type: put.type, reason: put.reason ?? null });
    const aKnows = await waitFor(async () => ((await pageCard(pageA, AGENT_CARD_ID)).known ? true : null), 30_000, '甲页面认出直接写进内容库的卡').catch(() => null);
    check(!!aKnows, '4-甲的桌面装上直接写进内容库的卡、页面认得', { override: !!overrideOf(A, AGENT_CARD_REL) });
    await P(pageA, async (id) => { const S = await import('/src/store/project.ts'); S.actions.addCardClip(id, 6, { duration: 4 }); }, AGENT_CARD_ID);
  }

  // ---------- 5(先做生成与上传)卡片声音:甲放一张带声音的内置卡、生成声音
  let audio = null;
  {
    const requestsBefore = stateA.requests['/hosted/shared/account/session'] ?? 0;
    audio = await P(pageA, async () => {
      const S = await import('/src/store/project.ts');
      const G = await import('/src/editor/io/cardAudioGeneration.ts');
      const T = await import('/src/editor/media/assetTiers.ts');
      const clip = S.actions.addCardClip('av-pulse', 11, { duration: 2 });
      if (!clip) return { ok: false, error: '没放上 av-pulse' };
      try {
        const r = await G.generateCardAudio(clip.id);
        const media = S.getState().project.media.find((m) => m.id === r.mediaId);
        return { ok: r.ok, reused: r.reused ?? null, hash: media?.hash ?? null, size: media?.size ?? null, base: T.remoteAssetBase(), accountProject: T.remoteAccountProjectId() };
      } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    });
    res.audio = { ...audio, sessionRequests: (stateA.requests['/hosted/shared/account/session'] ?? 0) - requestsBefore };
    check(audio.ok === true && /^[a-f0-9]{64}$/.test(audio.hash ?? ''), '5-甲在账号项目里生成卡片声音并上传成功', audio.ok ? { hash: audio.hash.slice(0, 12), size: audio.size } : audio);
    check(audio.accountProject === projectId, '5-用的是账号项目的素材服务', { base: audio.base, accountProject: audio.accountProject });
  }
  res.aPageWritesDoneMs = Date.now() - aLoginAt;
  check(res.aPageWritesDoneMs < 100_000, '甲页面写项目的几步在登录后 100 秒内做完(探针自己的前提)', res.aPageWritesDoneMs);
  await dismissDialogs(pageA);
  await waitFor(() => stageHas(pageA, MARK('v1')), 60_000, '甲的舞台画出 v1').catch(() => null);
  await shot(pageA, '1-a-desktop-v1');

  // ---------- 2(核对)乙装上源码、画出来
  const bInstalled = await waitFor(() => (overrideOf(B, CARD_REL)?.includes(MARK('v1')) ? Date.now() : null), 30_000, '乙的改动层里装上源码').catch(() => null);
  check(!!bInstalled, '2-乙的桌面拿到源码(改动层里)');
  res.bInstallMs = bInstalled ? Math.max(0, bInstalled - t2) : null;
  const bKnown = await waitFor(async () => { const s = await pageCard(pageB, CARD_ID); return s.known && s.src?.includes(MARK('v1')) ? s : null; }, 30_000, '乙页面认出这张卡').catch(() => null);
  check(!!bKnown, '2-乙页面的注册表里有这张卡的 v1 源码');
  await dismissDialogs(pageB);
  await P(pageB, async () => (await import('/src/store/project.ts')).actions.seek(1));
  const bStage1 = await waitFor(() => stageHas(pageB, MARK('v1')), 90_000, '乙的舞台画出 v1').catch(() => null);
  if (!check(!!bStage1, '2-乙的舞台画出 v1')) say('diag.stage', { b: await stageDiag(pageB, CARD_ID) });
  const bStatus1 = await cardStatus(B);
  res.bRecordV1 = bStatus1.records?.[CARD_REL] ?? null;
  check(res.bRecordV1?.rev === res.aRecord.rev && res.bRecordV1?.mine === false, '2-乙记下的是甲那一版', res.bRecordV1);
  await shot(pageB, '2-b-desktop-v1');
  // ---------- 舞台窗口里的代码(用户卡就在这里跑)调不到卡片同步的绑定、交票据接口;编辑器页面自己也只能绑到账号云端的文档服务
  {
    const stageFrame = pageB.frames().find((f) => f !== pageB.mainFrame() && /[?&]stage=/.test(f.url()));
    const fromStage = stageFrame ? await stageFrame.evaluate(async (projectId) => {
      const call = async (ep, body) => (await fetch(`/api/cards/sync/${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status;
      return { origin: location.origin, bind: await call('bind', { mode: 'account', projectId, url: 'wss://attacker.invalid/hosted/' }), bindLegacy: await call('bind', { mode: 'ticket', projectId, url: 'wss://attacker.invalid/' }),
        ticket: await call('ticket', { reqId: 'ct1', ticket: 'x' }), unbind: await call('unbind', {}) };
    }, projectId).catch((e) => ({ error: String(e?.message ?? e) })) : { error: '没有舞台窗口' };
    const fromPage = await P(pageB, async (projectId) => (await fetch('/api/cards/sync/bind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'account', projectId, url: 'wss://attacker.invalid/hosted/' }) })).status, projectId);
    const still = await cardStatus(B);
    res.stageGuard = { fromStage, fromPageForeignUrl: fromPage, stillBound: still.projectId === projectId && still.connected === true };
    check(fromStage.bind === 403 && fromStage.bindLegacy === 403 && fromStage.ticket === 403 && fromStage.unbind === 403 && new URL(fromStage.origin).port !== String(B_PORT), '必3-舞台窗口里调卡片同步的绑定、解绑、交票据接口全部被拒(403)', fromStage);
    check(fromPage === 400 && res.stageGuard.stillBound, '必3-编辑器页面把账号项目绑到别的地址被拒(400),原来的绑定不受影响', { fromPage, stillBound: res.stageGuard.stillBound });
  }
  if (STOP_AFTER <= 2) throw new Error('stop-after 2');

  // ---------- 4(核对)乙也装上直接写进内容库的那张卡、画得出来
  {
    const both = await waitFor(() => (overrideOf(A, AGENT_CARD_REL)?.includes(MARK('agent')) && overrideOf(B, AGENT_CARD_REL)?.includes(MARK('agent')) ? true : null), 30_000, '甲、乙都装上直接写进内容库的卡').catch(() => null);
    check(!!both, '4-甲、乙的改动层都装上直接写进内容库的卡', { a: !!overrideOf(A, AGENT_CARD_REL), b: !!overrideOf(B, AGENT_CARD_REL) });
    const known = await waitFor(async () => ((await pageCard(pageB, AGENT_CARD_ID)).known ? true : null), 30_000, '乙页面认出它').catch(() => null);
    check(!!known, '4-乙页面的注册表也认出它');
    await P(pageB, async () => (await import('/src/store/project.ts')).actions.seek(7));
    const drawn = await waitFor(() => stageHas(pageB, MARK('agent')), 60_000, '乙的舞台画出这张卡').catch(() => null);
    if (!check(!!drawn, '4-乙的舞台画出直接写进内容库的那张卡')) say('diag.stage', { b: await stageDiag(pageB, AGENT_CARD_ID) });
    await shot(pageB, '4-b-desktop-agent-card');
  }

  // ---------- 5(核对)乙凭自己的素材票据取到同样的字节并能解码
  if (audio?.ok) {
    await waitFor(() => P(pageB, async (hash) => (await import('/src/store/project.ts')).getState().project.media.some((m) => m.hash === hash), audio.hash), 30_000, '乙的项目里出现这段声音');
    const got = await P(pageB, async (hash) => {
      const T = await import('/src/editor/media/assetTiers.ts');
      const ticket = await T.remoteAssetTicket();
      const r = await fetch(`${T.remoteAssetBase()}/media/${hash}?t=${encodeURIComponent(ticket ?? '')}`, { credentials: 'omit', cache: 'no-store' });
      if (!r.ok) return { status: r.status };
      const buf = await r.arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const decoded = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(buf.slice(0));
      let peak = 0; const ch = decoded.getChannelData(0); for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
      return { status: r.status, bytes: buf.byteLength, sameHash: digest === hash, duration: decoded.duration, sampleRate: decoded.sampleRate, peak };
    }, audio.hash);
    res.audio.b = got;
    check(got.status === 200 && got.sameHash && got.bytes === audio.size && got.duration > 0 && got.peak > 0, '5-乙凭自己的素材票据取到同样的字节、解码出有声音的音频', got);
  }

  // ---------- 2(在线页面)真的登录表单(乙的账号,另一个浏览器环境),凭项目链接进
  const ctxC = await browser.createBrowserContext();
  await ctxC.overridePermissions(ORIGIN, []);
  const pageC = await ctxC.newPage();
  pageC.setDefaultTimeout(90_000);
  pageC.setDefaultNavigationTimeout(120_000);
  pageC.on('pageerror', (e) => say('pageerror', { tag: 'online', message: String(e?.message ?? e).slice(0, 300) }));
  const typeInto = async (selector, value) => { const input = await pageC.waitForSelector(selector, { visible: true }); await input.click({ clickCount: 3 }); await pageC.keyboard.press('Backspace'); await input.type(value); };
  const enterOnline = async ({ login }) => {
    await pageC.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });
    if (login) {
      await typeInto('[data-pc="account-projects"] input[name="username"]', fixture.accounts[1].name);
      await typeInto('[data-pc="account-projects"] input[name="password"]', fixture.accounts[1].password);
      await pageC.waitForFunction(() => { const b = document.querySelector('[data-pc="account-projects"] form button.sp-primary-btn'); return Boolean(b && !b.disabled); });
      await pageC.click('[data-pc="account-projects"] form button.sp-primary-btn');
    }
    await pageC.waitForSelector('[data-pc="account-name"]', { visible: true });
    await typeInto('[data-pc="cloud-project-link"]', `${ORIGIN}/editor?project=${projectId}`);
    await pageC.click('[data-pc="cloud-join"]');
    await pageC.waitForSelector('[data-pc="editor"]', { visible: true });
    await waitFor(() => P(pageC, () => !!window.__pcStore), 30_000, '在线页面的时间轴').catch(() => null);
    await P(pageC, () => window.__pcStore?.actions.seek(1)).catch(() => null);
  };
  await enterOnline({ login: true });
  say('online.entered');
  const cKnows = await waitFor(async () => { const d = await onlineDiag(pageC, CARD_ID); return d.cards?.includes(CARD_ID) && d.cards.includes(AGENT_CARD_ID) ? d : null; }, 60_000, '在线页面拿到两张卡的源码').catch(() => null);
  check(!!cKnows, '2-在线页面经自己的账号连接拿到两张卡的源码');
  const cStage1 = await waitFor(() => stageHas(pageC, MARK('v1')), 120_000, '在线页面的舞台画出 v1').catch(() => null);
  if (!check(!!cStage1, '2-在线页面的舞台画出 v1')) say('diag.online', await onlineDiag(pageC, CARD_ID));
  res.onlineStage = cStage1 ? new URL(cStage1).origin : null;
  res.online = await onlineDiag(pageC, CARD_ID).then((d) => ({ cardExec: d.cardExec ? { enabled: d.cardExec.enabled, reason: d.cardExec.reason } : null, run: d.run ?? null, grantRejects: stageRejects.filter((r) => r.path.endsWith('/_grant')).map((r) => r.status) }));
  check(res.online.cardExec?.enabled === true && res.online.run?.state === 'ready' && res.online.grantRejects.length === 0, '2-在线页面的执行闸门开着(舞台源收下账号办法的素材票据)', res.online);
  await shot(pageC, '2-c-online-v1');
  if (STOP_AFTER <= 2.5) throw new Error('stop-after 2.5');

  // ---------- 3 甲改卡:乙热更新
  await P(pageB, async () => (await import('/src/store/project.ts')).actions.seek(1));
  const navBefore = navigations.length;
  const t3 = Date.now();
  const edit = await postJson(`${A.origin}/api/cards/edit`, { id: CARD_ID, find: MARK('v1'), replace: MARK('v2') });
  if (!edit.ok) throw new Error(`甲改卡失败:${edit.error}`);
  const bV2 = await waitFor(() => (overrideOf(B, CARD_REL)?.includes(MARK('v2')) ? Date.now() : null), 30_000, '乙装上 v2').catch(() => null);
  res.bInstallV2Ms = bV2 ? bV2 - t3 : null;
  check(!!bV2, '3-乙的改动层换成 v2');
  const bHmr = await waitFor(async () => ((await pageCard(pageB, CARD_ID)).src?.includes(MARK('v2')) ? Date.now() : null), 30_000, '乙页面热更新成 v2').catch(() => null);
  res.bHmrMs = bHmr ? bHmr - t3 : null;
  check(!!bHmr, '3-乙页面热更新成 v2');
  const bStage2 = await waitFor(() => stageHas(pageB, MARK('v2')), 60_000, '乙的舞台画出 v2').catch(() => null);
  check(!!bStage2, '3-乙的舞台画出 v2');
  check(navigations.length === navBefore, '3-没有整页刷新', navigations.slice(navBefore));
  check(await P(pageB, () => window.__pcSyncTest.view().kind) === 'shared', '3-乙仍在账号项目里');
  const bStatus2 = await cardStatus(B);
  res.bNotices = (bStatus2.notices ?? []).filter((n) => n.key === CARD_REL).map((n) => ({ type: n.type, rev: n.rev, byAccount: n.actor?.accountId === accountA ? '甲' : n.actor?.accountId === accountB ? '乙' : null, role: n.actor?.role ?? null }));
  // 版本号不写死:甲建卡时「保存」与「项目用到」两路可能各传一次(原有行为),第一版可能是 rev 1 也可能是 rev 2
  check(res.bNotices.some((n) => n.type === 'installed' && n.rev === bStatus2.records?.[CARD_REL]?.rev && n.rev > res.bRecordV1.rev && n.byAccount === '甲' && n.role === 'page'), '3-乙装上的新版本是甲写的、角色 page', res.bNotices);
  await dismissDialogs(pageB);
  await shot(pageB, '3-b-desktop-v2');
  const cStage2 = await waitFor(() => stageHas(pageC, MARK('v2')), 60_000, '在线页面的舞台画出 v2').catch(() => null);
  res.onlineV2 = !!cStage2;
  check(res.onlineV2, '3-在线页面也换成 v2');
  await shot(pageC, '3-c-online-v2');

  // ---------- 连接的寿命:到这里甲、乙的编辑器进程都过了访问令牌的 120 秒
  {
    await waitFor(() => Date.now() - aLoginAt > 150_000, 200_000, '甲登录满 150 秒');
    const renewsOf = (ed) => ed.proc.text().split(/\r?\n/).filter((l) => l.includes('doc.account.renew')).map((l) => /"why":"([^"]+)"/.exec(l)?.[1] ?? '?');
    res.renews = { a: renewsOf(A), b: renewsOf(B) };
    check(res.renews.a.length >= 1 && res.renews.a.every((w) => w === 'ticket-expiring'), '寿命-甲的同步连接按票据到期换过会话、没被闸拒过', res.renews.a);
    const edit25 = await postJson(`${A.origin}/api/cards/edit`, { id: CARD_ID, find: MARK('v2'), replace: MARK('v2b') });
    if (!edit25.ok) throw new Error(`甲改卡失败:${edit25.error}`);
    const late = await waitFor(() => (overrideOf(B, CARD_REL)?.includes(MARK('v2b')) ? true : null), 30_000, '过了 120 秒之后乙照常装上').catch(() => null);
    check(!!late, '寿命-登录 150 秒之后甲改卡,乙照常装上');
    // 页面自己那条账号连接过了 120 秒之后还写得进项目(到期前换过会话)
    const serverRev = async () => { const t = await sessionOf(stateA, projectId); const m = await rawDoc(t.body.connectionTicket, { type: 'project.open', projectId }); return m.rev ?? null; };
    const revBefore = await serverRev();
    const mark = await P(pageA, async () => { const S = await import('/src/store/project.ts'); const c = S.actions.addCardClip('av-pulse', 30, { duration: 1 }); return c?.id ?? null; });
    const seen = mark ? await waitFor(() => P(pageB, async (id) => (await import('/src/store/project.ts')).getState().project.tracks.some((t) => t.clips.some((c) => c.id === id)), mark), 10_000, '乙看到甲页面在 150 秒后放的片段').catch(() => null) : null;
    const aSide = await P(pageA, async (id) => {
      const S = await import('/src/store/project.ts');
      const toasts = document.querySelector('[data-pc="sync-toasts"]')?.textContent ?? '';
      return { clipStillThere: S.getState().project.tracks.some((t) => t.clips.some((c) => c.id === id)), status: window.__pcSyncTest.view().status, unconfirmed: window.__pcSyncTest.view().unconfirmed ?? null,
        rejectedToast: /没被文档服务接受\(([^)]*)\)/.exec(toasts)?.[1] ?? null };
    }, mark).catch(() => null);
    res.pageWriteAfterExpiry = { secondsSinceLogin: Math.round((Date.now() - aLoginAt) / 1000), deliveredToB: !!seen, serverRevBefore: revBefore, serverRevAfter: await serverRev(), a: aSide };
    check(res.pageWriteAfterExpiry.deliveredToB && res.pageWriteAfterExpiry.serverRevAfter > revBefore, '寿命-登录 150 秒之后甲在页面里放片段,乙看得到,服务端版本前进(原问题:版本 10 → 10)', res.pageWriteAfterExpiry);
  }

  // ---------- 6 乙改成只读
  {
    const toR = await admin(stateA, projectId, { op: 'set-list', members: [{ accountId: accountB, access: 'r' }] });
    check(toR.status === 200, '6-创建者把乙改成只读', { status: toR.status, code: toR.body?.code ?? null });
    await waitFor(async () => (await sessionOf(stateB, projectId)).body?.access === 'r', 15_000, '乙的会话变成只读');
    await waitFor(async () => { const s = await cardStatus(B); return s.projectId === projectId && s.connected; }, 90_000, '乙的同步在只读下重新连上');
    const logMark = B.proc.text().length;
    const revBeforeB = (await cardStatus(A)).records?.[CARD_REL]?.rev ?? null;
    const editB = await postJson(`${B.origin}/api/cards/edit`, { id: CARD_ID, find: MARK('v2b'), replace: MARK('v3') });
    if (!editB.ok) throw new Error(`乙改卡失败:${editB.error}`);
    // 权限一变服务端先把乙的连接关一次,第一下上传可能撞在断线上(disconnected);重连之后补传才轮到闸来拒
    const failures = () => B.proc.text().slice(logMark).split(/\r?\n/).filter((l) => l.includes('cards.sync.put-failed') && l.includes(CARD_ID)).map((l) => /"code":"([^"]+)"/.exec(l)?.[1] ?? '?');
    await waitFor(() => failures().includes('not-listed'), 60_000, '乙的上传被闸拒').catch(() => null);
    res.readonlyRefusals = [...new Set(failures())];
    check(res.readonlyRefusals.includes('not-listed') && res.readonlyRefusals.every((c) => c === 'not-listed' || c === 'disconnected'), '6-只读成员上传被拒(not-listed)', res.readonlyRefusals);
    await sleep(1500);
    const s = await sessionOf(stateA, projectId);
    const lib = await rawDoc(s.body.connectionTicket, { type: 'content.get', kind: 'card-source', key: CARD_REL });
    check(lib.rev === revBeforeB && String(lib.body).includes(MARK('v2b')), '6-内容库仍是甲的版本', { rev: lib.rev, before: revBeforeB });
    check((await cardSourceOf(A, CARD_ID))?.includes(MARK('v2b')), '6-甲那边没有被只读成员改动');
    const toRw = await admin(stateA, projectId, { op: 'set-list', members: [{ accountId: accountB, access: 'rw' }] });
    check(toRw.status === 200, '6-改回可写', { status: toRw.status });
    const aV3 = await waitFor(async () => ((await cardSourceOf(A, CARD_ID))?.includes(MARK('v3')) ? true : null), 60_000, '改回可写后乙的版本传上去、甲装上').catch(() => null);
    check(!!aV3, '6-改回可写后乙补传成功,甲装上乙的 v3');
  }

  // ---------- 7 乙被踢
  {
    const snapshot = await P(pageA, async () => { const M = await import('/src/editor/sync/syncManager.ts'); const s = await M.accountProjectMembers(); return { accessRevision: s.accessRevision, members: s.members.map((m) => m.accountId) }; });
    const kicked = await P(pageA, async (accountId, expectedAccessRevision) => {
      const M = await import('/src/editor/sync/syncManager.ts');
      try { await M.accountMemberAdmin({ op: 'kick', accountId, expectedAccessRevision, requestId: crypto.randomUUID() }); return { ok: true }; } catch (e) { return { ok: false, error: String(e?.code ?? e?.message ?? e) }; }
    }, accountB, snapshot.accessRevision);
    check(kicked.ok, '7-创建者在页面里把乙踢出', kicked);
    const bStopped = await waitFor(async () => { const s = await cardStatus(B); return s.local === true ? s : null; }, 60_000, '乙的同步回到本机空间').catch(() => null);
    check(!!bStopped, '7-乙被踢后卡片源码同步停下(回本机空间)', bStopped ? undefined : await cardStatus(B).then((s) => ({ local: s.local, connected: s.connected, projectId: s.projectId })));
    // 页面自己每 3 秒续一次会话才发现被踢,比编辑器进程那条连接被关晚一点
    res.bBlocked = await waitFor(() => P(pageB, () => window.__pcSyncTest.view().blocked ?? null), 20_000, '乙的页面发现被踢').catch(() => null);
    check(res.bBlocked === 'kicked', '7-乙的页面知道自己被踢', res.bBlocked);
    const refusedB = await sessionOf(stateB, projectId);
    check(refusedB.status === 403 && refusedB.body?.code === 'banned', '7-乙再取会话被拒(403 banned)', { status: refusedB.status, code: refusedB.body?.code ?? null });
    const revBeforeV4 = (await cardStatus(A)).records?.[CARD_REL]?.rev ?? 0;
    const editA = await postJson(`${A.origin}/api/cards/edit`, { id: CARD_ID, find: MARK('v3'), replace: MARK('v4') });
    if (!editA.ok) throw new Error(`甲改卡失败:${editA.error}`);
    await waitFor(async () => { const s = await cardStatus(A); return s.records?.[CARD_REL]?.rev > revBeforeV4 && !s.pending.includes(CARD_REL); }, 30_000, '甲传上 v4');
    await sleep(4000);
    check(overrideOf(B, CARD_REL)?.includes(MARK('v3')) && !overrideOf(B, CARD_REL)?.includes(MARK('v4')), '7-被踢之后的版本乙拿不到');
    const bAfter = await cardStatus(B);
    check(bAfter.local === true && bAfter.projectId == null, '7-乙的编辑器进程没有再连回项目', { local: bAfter.local, projectId: bAfter.projectId ?? null });
    await dismissDialogs(pageB);
    await shot(pageB, '7-b-desktop-kicked');
  }

  // ---------- 8 甲退出登录
  {
    const held = await sessionOf(stateA, projectId);
    const logMark = A.proc.text().length;
    const out = await P(pageA, async () => { try { await window.__probeClient.logout(); return { ok: true }; } catch (e) { return { ok: false, error: String(e?.code ?? e?.message ?? e) }; } });
    check(out.ok, '8-甲在页面里退出登录', out);
    const closedLine = await waitFor(() => A.proc.text().slice(logMark).split(/\r?\n/).find((l) => l.includes('cards.sync.close') || l.includes('cards.sync.unbind')) ?? null, 60_000, '甲的同步连接被关').catch(() => null);
    check(!!closedLine, '8-甲退出登录后编辑器进程的同步连接被关');
    const aStopped = await waitFor(async () => { const s = await cardStatus(A); return s.local === true ? s : null; }, 60_000, '甲的同步回到本机空间').catch(() => null);
    check(!!aStopped, '8-甲的卡片源码同步停下(回本机空间)', aStopped ? undefined : await cardStatus(A).then((s) => ({ local: s.local, connected: s.connected, projectId: s.projectId })));
    const after = await sessionOf(stateA, projectId);
    check(after.status === 401, '8-退出登录后再取会话回 401', { status: after.status, code: after.body?.code ?? null });
    const old = await rawDoc(held.body.connectionTicket, { type: 'content.list', kind: 'card-source' }).then((m) => ({ connected: true, type: m.type, reason: m.reason ?? null }), (e) => ({ connected: false, error: String(e?.message ?? e).slice(0, 80) }));
    check(old.connected === false || old.type === 'error', '8-退出前取的、没过期的连接票据用不了', old);
    await dismissDialogs(pageA);
    await shot(pageA, '8-a-desktop-logged-out');
  }
  res.navigations = navigations.length;
  // 「你的近期修改已被…覆盖」:文档服务发给甲、乙的 project.overwritten,连同同一版本的那次提交改了哪些路径
  res.overwritten = Object.fromEntries(Object.entries(wsLog).map(([tag, frames]) => [tag, frames.filter((f) => f.type === 'project.overwritten').map((o) => ({
    entity: o.entity, rev: o.rev, by: o.by === accountA ? '甲' : o.by === accountB ? '乙' : o.by, bySession: o.bySession,
    op: frames.find((f) => f.type === 'project.ops' && f.rev === o.rev)?.paths ?? null,
    mineBefore: frames.filter((f) => f.dir === 'out' && f.type === 'project.op' && f.at < o.at).slice(-3).map((f) => f.paths),
  }))]));
  say('observe.overwritten', res.overwritten);
} catch (err) {
  if (!err?.done) fails.push(`error:${String(err?.message ?? err)}`);
  say('error', { message: String(err?.stack ?? err).slice(0, 1500) });
  for (const p of procs) {
    const lines = p.text().split(/\r?\n/).filter((l) => /\[cards\]|error|Error/.test(l)).slice(-25);
    say('proc.tail', { name: p.name, exited: p.child.exitCode, lines });
  }
} finally {
  try { await browser?.close(); } catch { /* 已经关了 */ }
  await stopAll();
  for (const s of stageServers) { for (const socket of s.sockets) socket.destroy(); await new Promise((r) => s.server.close(r)); }
  if (fixture) { try { const state = await fixture.close(); res.fixtureClosed = state?.closed === true && state?.childClosed === true; } catch { res.fixtureClosed = false; } }
  // 改卡时的备份(.pc-work/card-history)里探针卡的那几份
  try {
    const hist = path.join(ROOT, '.pc-work', 'card-history');
    for (const f of fs.existsSync(hist) ? fs.readdirSync(hist) : []) if (f.startsWith(`${CARD_ID}.`) || f.startsWith(`${AGENT_CARD_ID}.`)) fs.rmSync(path.join(hist, f), { force: true });
  } catch { /* 清不掉不影响结论 */ }
  res.repoTouched = fs.existsSync(path.join(ROOT, CARD_REL)) || fs.existsSync(path.join(ROOT, AGENT_CARD_REL));
  if (res.repoTouched) fails.push('repo-card-file-left');
  if (!argv.includes('--keep-temp')) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 上偶有句柄没放 */ } }
  else res.temp = TMP;
  res.fails = fails;
  res.ok = fails.length === 0;
  process.stdout.write(`${JSON.stringify(res)}\n`);
  process.exitCode = res.ok ? 0 : 1;
}
