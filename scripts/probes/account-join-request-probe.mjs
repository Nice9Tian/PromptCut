/**
 * 申请加入与「任何知道链接的人都可加入」勾选的端到端探针:桌面、在线、手机三处各走一遍并截图
 * (2026-10-22 用户定,`docs/semantics/workflow/project.md`「多用户协作」第 26、27 条;报告 `docs/reports/AGENT-claude-join-requests.md`)。
 *
 * 真的服务组合:账号后端、文档服务、独立的素材服务进程、TLS 入口(`server/test/fixtures/cloud-queue-user-path.mjs`),
 * 探针另在账号后端注册几个账号。三处:
 *   桌面  本工作区起的开发服务器(桌面那一份),页面里的 `window.__TAURI__.core.invoke('account_bridge', …)` 由探针在 Node 一侧
 *         照外壳的接口代答,**同样只放行外壳写死的五条路由**(`desktop/src-tauri/src/account_vault.rs`);
 *   在线  在线构建(`vite build --mode online` 的 `dist-online/`)由夹具的 TLS 入口在 `/editor/` 下发,与 `/api/account`、`/hosted` 同源,
 *         和生产的摆法一样;页面凭网站登录(cookie)走,没有任何替身;
 *   手机  同一份在线构建,`?layout=mobile`、手机视口与触屏。
 * 每处:创建者取消勾选(截图)→ 申请人被挡住、点「发送申请」(截图)→ 创建者成员按钮上的数字角标、成员浮层 / 面板里的申请列表(截图)
 *   → 通过一个(他直接进来;桌面那一遍项目设了二级密码,他要输一次)→ 拒绝一个(他看到「创建者没有通过你的申请」)。桌面另看被踢的人。
 *
 *   node scripts/probes/account-join-request-probe.mjs [--only desktop,online,mobile] [--out out/join-requests] [--keep-temp]
 *        [--dist dist-online] [--editor-port 5940] [--fixture-ports 5943,5944,5945,5946,5947,5948,5949]
 *   (要设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE,同账号那几条测试;要先 `npx vite build --mode online`)
 *
 * 端口:编辑器 5940(舞台 5941、5942),夹具 5943～5949(入口 5949);夹具里云端 Agent 的入口探针用不到,给 0 由系统挑一个临时端口。
 * 输出:过程写 stderr;截图与 evidence.json 在 --out 下;stdout 最后一行是一行 JSON(`fails` 为空才算过)。不打印密码、令牌、票据。
 */
import '../lib/no-user-dirs.mjs';
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { reopenEditorEnv } from './reopen-editor-env.mjs';
import { editorSecurityHeaders } from '../../src/online/stagePolicy.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(ROOT, arg('--out', 'out/join-requests'));
const DIST = path.resolve(ROOT, arg('--dist', 'dist-online'));
const ONLY = arg('--only', 'desktop,online,mobile').split(',');
const KEEP = argv.includes('--keep-temp');
const EDITOR_PORT = Number(arg('--editor-port', '5940'));
const FIXTURE_PORTS = arg('--fixture-ports', '5943,5944,5945,5946,5947,5948,5949').split(',').map(Number);
// 外壳写死的放行清单(与 account_vault.rs 逐字一致;`src/account/joinRequest.test.mjs` 的 JRC-2 另有守门)
const SHELL_ROUTES = ['/hosted/shared/account/create', '/hosted/shared/account/join', '/hosted/shared/account/session', '/hosted/shared/account/admin', '/hosted/shared/account/members'];
fs.mkdirSync(OUT, { recursive: true });

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields }).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]')}\n`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时(${ms} ms)`);
    await sleep(250);
  }
}
const RUN = Date.now().toString(36);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-join-request-probe-'));
const procs = [], fails = [];
const res = { runId: RUN, ports: { editor: EDITOR_PORT, fixture: FIXTURE_PORTS }, checks: [], shots: [], bridgePaths: [] };
let fixture = null, browser = null, ca = null, ORIGIN = '';
const check = (ok, name, detail) => {
  res.checks.push({ name, ok: !!ok });
  if (!ok) { fails.push(detail === undefined ? name : `${name}(${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); say('FAIL', { name, detail }); }
  else say('ok', { name });
  return !!ok;
};

/* ---------------- 在线构建:由夹具的入口在 /editor/ 下发(与 /api/account、/hosted 同源) ---------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.webp': 'image/webp' };
function onlineHandler() {
  const headers = editorSecurityHeaders([]);
  const root = path.resolve(DIST);
  return async (req, res) => {
    const url = new URL(req.url, 'https://edge.invalid');
    if (!['GET', 'HEAD'].includes(req.method)) return false;
    if (url.pathname === '/editor/runtime-config.json') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ v: 1 })); return true;
    }
    let rel = null;
    if (['/editor', '/editor/', '/editor/index.html'].includes(url.pathname)) rel = 'index.html';
    else if (url.pathname.startsWith('/editor/')) rel = decodeURIComponent(url.pathname.slice('/editor/'.length));
    else if (url.pathname.startsWith('/catalog/')) rel = decodeURIComponent(url.pathname.slice(1));
    if (!rel) return false;
    const file = path.resolve(root, rel);
    if (path.relative(root, file).startsWith('..') || path.isAbsolute(path.relative(root, file))) return false;
    let bytes;
    try { if (!fs.statSync(file).isFile()) return false; bytes = fs.readFileSync(file); } catch { return false; }
    res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
    return true;
  };
}

/* ---------------- 夹具入口上的请求(Node 一侧) ---------------- */

function edge(route, { method, body, token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request(new URL(route, ORIGIN), { method: method ?? (data === null ? 'GET' : 'POST'), ca, timeout: 20_000,
      headers: { ...(data === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 不是 JSON */ }
        resolve({ status: r.statusCode, body: json, cookie: r.headers['set-cookie']?.[0]?.split(';')[0] }); });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.end(data ?? undefined);
  });
}
/** 网站这一侧的一个会话(cookie + CSRF,同网站页面);只在探针内存里 */
function siteClient() {
  let cookie = '', csrf = '';
  return async (method, route, body) => {
    const r = await edge(`/api/account${route}`, { method, body, headers: { ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrf } : {}) } });
    if (r.cookie) cookie = r.cookie;
    if (r.body?.csrfToken) csrf = r.body.csrfToken;
    return r;
  };
}
/** 账号的公共部分:编辑器令牌(网站会话换来的,和页面用的同一种)、「我创建的」里按名字找项目号 */
function withSite(account, site) {
  account.editorToken = async () => {
    const s = await site('POST', '/editor/session', { deviceId: `probe-${account.name}`.slice(0, 64), deviceName: `probe ${account.name}`, requestId: randomUUID() });
    if (s.status !== 200) throw new Error(`${account.name} 拿编辑器令牌失败:${s.status}`);
    return s.body.accessToken;
  };
  account.ownedProjectId = async projectName => (await site('GET', '/projects')).body?.owned?.find(p => p.name === projectName)?.projectId ?? null;
  return account;
}
/** 注册一个账号;密码只在探针内存里 */
async function registerAccount(name) {
  const site = siteClient();
  await site('GET', '/me');
  const password = `probe-${randomUUID()}`;
  const made = await site('POST', '/register', { name, password });
  if (made.status !== 200) throw new Error(`注册 ${name} 失败:${made.status} ${made.body?.code}`);
  return withSite({ name, password, id: made.body.account.id }, site);
}
/** 夹具已经注册好的账号:网站上登录一次 */
async function loginAccount(account) {
  const site = siteClient();
  await site('GET', '/me');
  const r = await site('POST', '/login', { name: account.name, password: account.password, remember: false });
  if (r.status !== 200) throw new Error(`${account.name} 网站登录失败:${r.status} ${r.body?.code}`);
  return withSite({ ...account, id: r.body.account.id }, site);
}
const api = (route, body, token) => edge(route, { body, token });
/**
 * 凭登录令牌走一次 `/join`(知道链接就能进时)。刚落账的加入要等素材服务追上访问事件才发得出会话,追上之前回 503 `asset-unavailable`:
 * 用同一个请求号重试(服务端按请求号重放,不会多记一次)
 */
async function joinApi(who, projectId) {
  const requestId = randomUUID(), token = await who.editorToken();
  let r;
  for (let i = 0; i < 20; i++) {
    r = await api('/hosted/shared/account/join', { projectId, deviceId: `probe-${who.id.slice(-8)}`, requestId }, token);
    if (r.status !== 503) return r;
    await sleep(500);
  }
  return r;
}
async function adminAs(token, projectId, body) {
  const members = await api('/hosted/shared/account/members', { projectId }, token);
  if (members.status !== 200) throw new Error(`读成员失败:${members.status} ${members.body?.code}`);
  return api('/hosted/shared/account/admin', { projectId, expectedAccessRevision: members.body.accessRevision, requestId: randomUUID(), ...body }, token);
}

/* ---------------- 桌面外壳账号桥的替身(同样的路由白名单、失败时只带回 status 与 code) ---------------- */

function nativeBridge(state) {
  const out = r => (r.status >= 200 && r.status < 300 && r.body?.ok ? r.body : { ok: false, status: r.status, code: r.body?.code ?? 'cloud-request-failed' });
  return async (operation, args = {}) => {
    try {
      if (operation === 'configuration') return { ok: true, origin: ORIGIN };
      if (operation === 'login') {
        const v = out(await edge('/api/account/editor/login', { body: args }));
        if (v.ok) { state.recovery = v.recoveryToken; state.deviceId = args.deviceId; state.token = v.accessToken; }
        return v;
      }
      if (operation === 'recover') {
        if (!state.recovery) return null;
        const v = out(await edge('/api/account/editor/recover', { body: { recoveryToken: state.recovery, deviceId: state.deviceId, requestId: randomUUID() } }));
        if (v.ok) { state.recovery = v.recoveryToken; state.token = v.accessToken; }
        return v;
      }
      if (operation === 'logout') return { ok: true };
      if (operation === 'request') {
        if ((!SHELL_ROUTES.includes(args.path) && args.path !== '/api/account/cloud-agent-consent') || !args.accessToken) throw new Error('bad-path');
        if (SHELL_ROUTES.includes(args.path) && (args.body === undefined || args.body === null)) throw new Error('bad-request');
        res.bridgePaths.push(args.path);
        return out(await edge(args.path, { body: args.body, token: args.accessToken }));
      }
      throw new Error('bad-operation');
    } catch { return { ok: false, status: 503, code: 'desktop-account-bridge' }; }
  };
}

/* ---------------- 进程 ---------------- */

function viteBin() { return path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js'); }
function start(name, args, env) {
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  const log = [];
  const keep = c => { log.push(c.toString()); if (log.length > 4000) log.shift(); };
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  const p = { name, child, text: () => log.join('') };
  procs.push(p); say('spawn', { name, pid: child.pid });
  return p;
}
async function stopAll() {
  for (const p of procs.reverse()) {
    const c = p.child;
    if (!c.pid || c.exitCode !== null) continue;
    const exited = new Promise(r => c.once('exit', r));
    // 只结束自己起的这一棵(编辑器连同它拉起的预渲染进程)
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else c.kill('SIGKILL');
    await Promise.race([exited, sleep(10_000)]);
    say('stopped', { name: p.name, pid: c.pid });
  }
}
async function startEditor(port) {
  const dataDir = path.join(TMP, 'editor');
  const overrides = path.join(dataDir, 'card-overrides');
  const viteCache = path.join(dataDir, 'node_modules', '.vite-probe');
  for (const d of [overrides, viteCache]) fs.mkdirSync(d, { recursive: true });
  const proc = start('editor', [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], reopenEditorEnv(dataDir, {
    PROMPTCUT_VITE_CACHE_DIR: viteCache, PROMPTCUT_CARD_OVERRIDES: overrides,
    PROMPTCUT_DEVICE_ID: `join-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'join-request-probe',
    PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '0', PROMPTCUT_NODE_PROFILE: 'user', PROMPTCUT_SHARED_CONFIG: '', PROMPTCUT_QUEUE_NODE: '0',
    NODE_EXTRA_CA_CERTS: fixture.caFile, PROMPTCUT_ACCOUNT_CLOUD_ORIGIN: ORIGIN,
  }));
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (proc.child.exitCode !== null) throw new Error(`编辑器退出了:${proc.text().slice(-600)}`);
    return fetch(`${base}/api/docservice/device`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false);
  }, 300_000, '编辑器起来');
  return { base, proc };
}

/* ---------------- 页面 ---------------- */

const P = (page, fn, ...args) => page.evaluate(fn, ...args);
const has = (page, sel) => P(page, s => !!document.querySelector(s), sel);
const textOf = (page, sel) => P(page, s => document.querySelector(s)?.textContent?.trim() ?? null, sel);
async function click(page, sel, what = sel) {
  await waitFor(() => P(page, s => { const el = document.querySelector(s); return !!el && !el.disabled; }, sel), 60_000, `可以点 ${what}`);
  await P(page, s => document.querySelector(s).click(), sel);
}
/** 往受控输入框里填字(React 的 value setter + input 事件) */
async function fill(page, sel, value) {
  await page.waitForSelector(sel, { timeout: 60_000 });
  await P(page, (s, v) => {
    const el = document.querySelector(s);
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, sel, value);
}
/**
 * 在线页面进了云端项目会弹「使用云端 Agent 前请先了解」(与本探针无关):点「拒绝」关掉——不同意、不发任何对话。
 * `waitMs` 给一段时间等它出来(刚进项目时它是稍后才弹的)
 */
async function dismissConsent(page, waitMs = 0) {
  const t0 = Date.now();
  do {
    if (await has(page, '[data-pc="cloud-agent-consent"]')) {
      await P(page, () => [...document.querySelectorAll('[data-pc="cloud-agent-consent"] button')].find(b => b.textContent?.trim() === '拒绝')?.click());
      await waitFor(async () => !(await has(page, '[data-pc="cloud-agent-consent"]')), 10_000, '关掉云端 Agent 的说明').catch(() => null);
      return true;
    }
    if (waitMs) await sleep(250);
  } while (Date.now() - t0 < waitMs);
  return false;
}
async function shot(page, name, { scrollTo } = {}) {
  await dismissConsent(page);
  if (scrollTo) await P(page, s => document.querySelector(s)?.scrollIntoView({ block: 'center' }), scrollTo).catch(() => undefined);
  await sleep(400);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  res.shots.push(path.relative(ROOT, file).split(path.sep).join('/'));
  say('shot', { name });
}
/** 开着的页面(出错时逐个留一张截图和页面上的字,排查用) */
const openPages = [];
async function debugDump(tag) {
  for (const [i, page] of openPages.entries()) {
    try {
      if (page.isClosed()) continue;
      await page.screenshot({ path: path.join(OUT, `debug-${tag}-${i}.png`) });
      const info = await P(page, () => ({ url: location.pathname + location.search, error: document.querySelector('[data-pc="account-error"], .err[role="alert"]')?.textContent ?? null,
        body: document.body?.innerText?.slice(0, 1500) ?? '' }));
      say('debug.page', { tag, i, ...info });
    } catch (error) { say('debug.page-failed', { tag, i, message: String(error?.message ?? error).slice(0, 200) }); }
  }
}
async function newPage({ viewport = { width: 1440, height: 900 }, mobile = false, native = null } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  openPages.push(page);
  page.on('console', m => { if (m.type() === 'error' || /\[(collab|sync|account)\]/.test(m.text())) say('console', { type: m.type(), text: m.text().slice(0, 300) }); });
  page.setDefaultTimeout(120_000); page.setDefaultNavigationTimeout(300_000);
  await page.setViewport({ ...viewport, ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  if (mobile) await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36');
  page.on('pageerror', e => say('pageerror', { message: String(e?.message ?? e).slice(0, 240) }));
  if (native) {
    await page.exposeFunction('__probeNative', nativeBridge(native));
    // 桌面外壳的全局对象:只给账号桥这一个命令(别的命令回 null,等于没有外壳)
    await page.evaluateOnNewDocument(() => {
      window.__TAURI__ = { core: { invoke: async (command, payload) => (command === 'account_bridge' ? window.__probeNative(payload?.operation, payload?.args ?? {}) : null) } };
    });
  }
  return page;
}
/** 开始页(桌面、在线的「云端项目」那一块)登录 */
async function startLogin(page, account) {
  await page.waitForSelector('[data-pc="account-projects"] input[name="username"]', { timeout: 300_000 });
  await fill(page, '[data-pc="account-projects"] input[name="username"]', account.name);
  await fill(page, '[data-pc="account-projects"] input[name="password"]', account.password);
  await P(page, () => document.querySelector('[data-pc="account-projects"] input[name="username"]').closest('form').requestSubmit());
  await page.waitForSelector('[data-pc="account-name"]', { timeout: 60_000 });
}
/** 开始页凭链接加入(填链接、点「加入并打开项目」) */
async function startJoin(page, link) {
  await fill(page, '[data-pc="cloud-project-link"]', link);
  await click(page, '[data-pc="cloud-join"]', '加入并打开项目');
}
const requestState = (page, attr = 'data-pc') => P(page, a => document.querySelector(`[${a}="join-request"]`)?.getAttribute('data-state') ?? null, attr);
const inEditor = page => has(page, '[data-pc="members-button"]');
async function waitGateGone(page) { await waitFor(() => P(page, () => !document.querySelector('[data-pc="lowmem-gate"]')), 120_000, '测量遮罩退下').catch(() => null); }
async function openSettings(page) {
  await P(page, () => window.dispatchEvent(new Event('pc-open-project-settings')));
  await page.waitForSelector('[data-pc="collab-section"]', { timeout: 30_000 });
}
async function closeSettings(page) { await P(page, () => [...document.querySelectorAll('.pc-dialog-foot button')].find(b => b.textContent?.trim() === '取消')?.click()); await sleep(300); }
async function openMembers(page) {
  if (!(await has(page, '[data-pc="members-pop"]'))) await click(page, '[data-pc="members-button"]', '成员按钮');
  await page.waitForSelector('[data-pc="members-pop"]', { timeout: 30_000 });
}
const requestRow = id => `[data-pc="account-join-request"][data-account-id="${id}"]`;

/* ---------------- 桌面 ---------------- */

async function scenarioDesktop(accounts) {
  const out = {};
  const [A, B, C, D, K] = [accounts.creator, accounts.b, accounts.c, accounts.d, accounts.k];
  const editor = await startEditor(EDITOR_PORT);
  const stateA = {}, stateC = {}, stateD = {}, stateK = {};

  // —— 创建者:登录、在开始页新建云端项目(夹具自带的那个项目内容只有 `{ tracks: [] }`,编辑器打不开,不用它)
  const pageA = await newPage({ native: stateA });
  await pageA.goto(`${editor.base}/?nosetup=1`, { waitUntil: 'domcontentloaded' });
  await startLogin(pageA, A);
  const name = `申请加入-桌面-${RUN}`;
  await fill(pageA, '[data-pc="cloud-project-name"]', name);
  await click(pageA, '[data-pc="cloud-create"]', '新建云端项目');
  await waitFor(() => inEditor(pageA), 180_000, '创建者进入新项目');
  await waitGateGone(pageA);
  const projectId = out.projectId = await waitFor(() => A.ownedProjectId(name), 30_000, '取新项目的项目号');
  const link = `${ORIGIN}/editor?project=${projectId}`;
  // 乙、K 先凭链接进来(这时还知道链接就能进);K 之后被创建者踢掉
  for (const [who, label] of [[B, '乙'], [K, 'K']]) {
    const r = await joinApi(who, projectId);
    check(r.status === 200, `桌面-${label} 先凭链接进来`, { status: r.status, code: r.body?.code });
  }
  await openSettings(pageA);
  await pageA.waitForSelector('[data-pc="collab-entry"][data-state="link"]', { timeout: 30_000 });
  out.order = await P(pageA, () => {
    const els = [...document.querySelectorAll('[data-pc="collab-regen-link"], [data-pc="collab-secondary-password"], [data-pc="collab-entry"]')];
    return els.map(el => el.getAttribute('data-pc'));
  });
  check(JSON.stringify(out.order) === JSON.stringify(['collab-regen-link', 'collab-secondary-password', 'collab-entry']), '桌面-勾选在「作废并重新生成项目链接」「项目二级密码」两个按钮下面', out.order);
  check(await P(pageA, () => document.querySelector('[data-pc="collab-entry-toggle"]').checked === true), '桌面-缺省勾着');
  await shot(pageA, 'desktop-1-entry-checked', { scrollTo: '[data-pc="collab-entry"]' });
  await click(pageA, '[data-pc="collab-entry-toggle"]', '取消勾选');
  await pageA.waitForSelector('[data-pc="collab-entry"][data-state="list"]', { timeout: 30_000 });
  out.listHint = await textOf(pageA, '[data-pc="collab-entry-hint"]');
  check(/只允许账号名单（现在的 3 位成员）/.test(out.listHint ?? ''), '桌面-取消勾选后:名单就是现在的 3 位成员(创建者、乙、K)', out.listHint);
  await shot(pageA, 'desktop-2-entry-list', { scrollTo: '[data-pc="collab-entry"]' });
  out.whereText = await textOf(pageA, '[data-pc="collab-where-text"]');
  check(out.whereText === '云端', '桌面-取消勾选后「放在」那一行只写「云端」(不再写「自由进入」)', out.whereText);
  // 再勾回去:那一行与勾选两边都不打架;再取消,接着走只放名单的流程
  await click(pageA, '[data-pc="collab-entry-toggle"]', '再勾上');
  await pageA.waitForSelector('[data-pc="collab-entry"][data-state="link"]', { timeout: 30_000 });
  check((await textOf(pageA, '[data-pc="collab-where-text"]')) === '云端' && await P(pageA, () => document.querySelector('[data-pc="collab-entry-toggle"]').checked === true),
    '桌面-再勾上:「放在」仍只写「云端」,勾选勾着');
  await shot(pageA, 'desktop-2b-entry-rechecked', { scrollTo: '[data-pc="collab-entry"]' });
  await click(pageA, '[data-pc="collab-entry-toggle"]', '再取消');
  await pageA.waitForSelector('[data-pc="collab-entry"][data-state="list"]', { timeout: 30_000 });
  await closeSettings(pageA);
  // 项目二级密码(创建者经接口设):被通过的人进来时仍要输一次
  const secondary = `二级-${RUN}`;
  // 创建者另用一个网站会话换来的令牌(不碰页面那一份恢复凭证,免得两边同时续)
  check((await adminAs(await A.editorToken(), projectId, { op: 'set-secondary-password', password: secondary })).status === 200, '桌面-创建者设了项目二级密码');

  // —— 申请人丙:被挡住 → 发送申请 → 已发送
  const pageC = await newPage({ native: stateC });
  await pageC.goto(`${editor.base}/?nosetup=1`, { waitUntil: 'domcontentloaded' });
  await startLogin(pageC, C);
  await startJoin(pageC, link);
  await waitFor(async () => (await requestState(pageC)) === 'none', 60_000, '丙看到被挡住');
  out.blockedText = await textOf(pageC, '[data-pc="join-request-text"]');
  check(out.blockedText === '你不在这个项目的成员名单中。' && await has(pageC, '[data-pc="join-request-send"]'), '桌面-被名单挡住:「你不在这个项目的成员名单中」和「发送申请」按钮', out.blockedText);
  check(!(await has(pageC, '[data-pc="account-error"]')), '桌面-被挡住时不另弹错误条');
  await shot(pageC, 'desktop-3-blocked');
  await click(pageC, '[data-pc="join-request-send"]', '发送申请');
  await waitFor(async () => (await requestState(pageC)) === 'pending', 30_000, '丙的申请发出');
  out.sentText = await textOf(pageC, '[data-pc="join-request-text"]');
  check(out.sentText === '已发送，等创建者通过', '桌面-发出后「已发送，等创建者通过」', out.sentText);
  await shot(pageC, 'desktop-4-sent');

  // —— 申请人丁也发一条
  const pageD = await newPage({ native: stateD });
  await pageD.goto(`${editor.base}/?nosetup=1`, { waitUntil: 'domcontentloaded' });
  await startLogin(pageD, D);
  await startJoin(pageD, link);
  await waitFor(async () => (await requestState(pageD)) === 'none', 60_000, '丁看到被挡住');
  await click(pageD, '[data-pc="join-request-send"]', '丁发送申请');
  await waitFor(async () => (await requestState(pageD)) === 'pending', 30_000, '丁的申请发出');

  // —— 创建者:成员按钮上的数字角标(收着时 15 秒取一次)、成员浮层里的申请列表
  await pageA.bringToFront();
  const badge = await waitFor(async () => { const t = await textOf(pageA, '[data-pc="members-request-badge"]'); return t === '2' ? t : null; }, 60_000, '成员按钮上出数字角标 2');
  check(badge === '2', '桌面-有新申请时成员按钮上出数字角标', badge);
  await shot(pageA, 'desktop-5-badge');
  await openMembers(pageA);
  await pageA.waitForSelector(requestRow(C.id), { timeout: 30_000 });
  out.requestRows = await P(pageA, () => [...document.querySelectorAll('[data-pc="account-join-request"]')].map(el => ({
    id: el.getAttribute('data-account-id'), text: el.textContent, approve: !!el.querySelector('[data-pc="account-join-approve"]'), reject: !!el.querySelector('[data-pc="account-join-reject"]') })));
  check(out.requestRows.length === 2 && out.requestRows.every(r => r.approve && r.reject), '桌面-申请列表在成员浮层里,每条有「通过」「拒绝」', out.requestRows.map(r => r.id));
  check(out.requestRows.every(r => !/@|login|cred/.test(r.text)), '桌面-申请里只有账号名、账号号、时间(不带邮箱、登录号)');
  await shot(pageA, 'desktop-6-requests');
  // 通过丙
  await click(pageA, `${requestRow(C.id)} [data-pc="account-join-approve"]`, '通过丙');
  await waitFor(async () => !(await has(pageA, requestRow(C.id))), 30_000, '丙那一条消失');
  await waitFor(() => has(pageA, `[data-pc="account-member"][data-account-id="${C.id}"]`), 30_000, '丙出现在成员里');
  await shot(pageA, 'desktop-7-approved-creator');
  // 丙:不用再点什么,自己再走一次加入;项目设了二级密码,要输一次
  await pageC.bringToFront();
  await waitFor(() => has(pageC, '[data-pc="cloud-secondary-password"]'), 60_000, '丙被通过后问二级密码');
  out.approvedText = await textOf(pageC, '[data-pc="join-request-text"]');
  out.approvedError = await textOf(pageC, '[data-pc="account-error"]');
  check(out.approvedText === '创建者已通过你的申请。' && /二级密码/.test(out.approvedError ?? ''), '桌面-通过后申请人直接进,设了二级密码的仍要输一次', { text: out.approvedText, error: out.approvedError });
  await shot(pageC, 'desktop-8-approved-password');
  await fill(pageC, '[data-pc="cloud-secondary-password"]', secondary);
  await P(pageC, () => document.querySelector('[data-pc="cloud-join"]').closest('form').requestSubmit());
  await waitFor(() => inEditor(pageC), 120_000, '丙进入项目');
  await waitGateGone(pageC);
  check(await P(pageC, () => window.__pcSyncTest?.view().shared?.accountId !== undefined), '桌面-丙进来了(连着云端项目)');
  await shot(pageC, 'desktop-9-approved-entered');
  // 拒绝丁
  await pageA.bringToFront();
  await openMembers(pageA);
  await click(pageA, `${requestRow(D.id)} [data-pc="account-join-reject"]`, '拒绝丁');
  await waitFor(async () => !(await has(pageA, requestRow(D.id))), 30_000, '丁那一条消失');
  await pageD.bringToFront();
  await waitFor(async () => (await requestState(pageD)) === 'rejected', 60_000, '丁看到被拒');
  out.rejectedText = await textOf(pageD, '[data-pc="join-request-text"]');
  check(out.rejectedText === '创建者没有通过你的申请', '桌面-被拒显示「创建者没有通过你的申请」', out.rejectedText);
  check(!(await inEditor(pageD)), '桌面-被拒的人没进来');
  await shot(pageD, 'desktop-10-rejected');
  // 被踢的人:不能申请(要先解除禁入)
  check((await adminAs(await A.editorToken(), projectId, { op: 'kick', accountId: K.id })).status === 200, '桌面-创建者踢了 K');
  const pageK = await newPage({ native: stateK });
  await pageK.goto(`${editor.base}/?nosetup=1`, { waitUntil: 'domcontentloaded' });
  await startLogin(pageK, K);
  await startJoin(pageK, link);
  out.bannedText = await waitFor(() => textOf(pageK, '[data-pc="account-error"]'), 60_000, 'K 看到被禁入');
  check(out.bannedText === '你已被禁止加入这个项目。' && !(await has(pageK, '[data-pc="join-request"]')), '桌面-被踢的账号没有「发送申请」', out.bannedText);
  await shot(pageK, 'desktop-11-banned');
  out.bridgeRoutes = [...new Set(res.bridgePaths)].sort();
  check(out.bridgeRoutes.every(p => SHELL_ROUTES.includes(p) || p === '/api/account/cloud-agent-consent'), '桌面-账号桥只用到外壳放行的路由', out.bridgeRoutes);
  for (const page of [pageA, pageC, pageD, pageK]) await page.browserContext().close().catch(() => undefined);
  return out;
}

/* ---------------- 在线(网页) ---------------- */

async function onlineLogin(page, account) {
  await page.goto(`${ORIGIN}/editor/?nosetup=1`, { waitUntil: 'domcontentloaded' });
  await startLogin(page, account);
}
async function scenarioOnline(accounts) {
  const out = {};
  // 网站每个 IP 一小时只许注册 5 个账号(夹具已用 2 个):在线那一遍用桌面那一遍的丙、丁去申请另一个项目
  const [A, E, F] = [accounts.creator, accounts.c, accounts.d];
  // 创建者:网页上登录、新建一个云端项目(新建出来就勾着「多用户协作」与「任何知道链接的人都可加入」)
  const pageA = await newPage();
  await onlineLogin(pageA, A);
  const name = `申请加入-在线-${RUN}`;
  await fill(pageA, '[data-pc="cloud-project-name"]', name);
  await click(pageA, '[data-pc="cloud-create"]', '新建云端项目');
  await waitFor(() => inEditor(pageA), 180_000, '创建者进入新项目');
  await waitGateGone(pageA);
  await dismissConsent(pageA, 8000);
  await openSettings(pageA);
  await pageA.waitForSelector('[data-pc="collab-entry"][data-state="link"]', { timeout: 30_000 });
  await shot(pageA, 'online-1-entry-checked', { scrollTo: '[data-pc="collab-entry"]' });
  await click(pageA, '[data-pc="collab-entry-toggle"]', '取消勾选');
  await pageA.waitForSelector('[data-pc="collab-entry"][data-state="list"]', { timeout: 30_000 });
  out.listHint = await textOf(pageA, '[data-pc="collab-entry-hint"]');
  check(/只允许账号名单（现在的 1 位成员）/.test(out.listHint ?? ''), '在线-取消勾选后名单就是现在的成员', out.listHint);
  await shot(pageA, 'online-2-entry-list', { scrollTo: '[data-pc="collab-entry"]' });
  check((await textOf(pageA, '[data-pc="collab-where-text"]')) === '云端', '在线-「放在」那一行只写「云端」');
  await closeSettings(pageA);
  // 项目号从网站的「我创建的」里取(在线页面的地址里不带)
  out.projectId = accounts.onlineProjectId = await waitFor(() => A.ownedProjectId(name), 30_000, '取新项目的项目号');
  // 申请人戊:被挡住 → 发送申请 → 已发送
  const pageE = await newPage();
  await pageE.goto(`${ORIGIN}/editor/?nosetup=1&project=${out.projectId}`, { waitUntil: 'domcontentloaded' });
  await startLogin(pageE, E);
  check((await P(pageE, () => document.querySelector('[data-pc="cloud-project-link"]').value)).includes(out.projectId), '在线-打开项目链接时链接已经填好');
  await click(pageE, '[data-pc="cloud-join"]', '加入并打开项目');
  await waitFor(async () => (await requestState(pageE)) === 'none', 60_000, '戊看到被挡住');
  check((await textOf(pageE, '[data-pc="join-request-text"]')) === '你不在这个项目的成员名单中。', '在线-被名单挡住的提示与按钮');
  await shot(pageE, 'online-3-blocked');
  await click(pageE, '[data-pc="join-request-send"]', '发送申请');
  await waitFor(async () => (await requestState(pageE)) === 'pending', 30_000, '戊的申请发出');
  await shot(pageE, 'online-4-sent');
  // 申请人己
  const pageF = await newPage();
  await pageF.goto(`${ORIGIN}/editor/?nosetup=1&project=${out.projectId}`, { waitUntil: 'domcontentloaded' });
  await startLogin(pageF, F);
  await click(pageF, '[data-pc="cloud-join"]', '己加入');
  await waitFor(async () => (await requestState(pageF)) === 'none', 60_000, '己看到被挡住');
  await click(pageF, '[data-pc="join-request-send"]', '己发送申请');
  await waitFor(async () => (await requestState(pageF)) === 'pending', 30_000, '己的申请发出');
  // 创建者:角标、申请列表、通过戊、拒绝己
  await pageA.bringToFront();
  await waitFor(async () => (await textOf(pageA, '[data-pc="members-request-badge"]')) === '2', 60_000, '在线-成员按钮上出数字角标 2');
  check(true, '在线-有新申请时成员按钮上出数字角标');
  await shot(pageA, 'online-5-badge');
  await openMembers(pageA);
  await pageA.waitForSelector(requestRow(E.id), { timeout: 30_000 });
  await shot(pageA, 'online-6-requests');
  await click(pageA, `${requestRow(E.id)} [data-pc="account-join-approve"]`, '通过戊');
  await waitFor(async () => !(await has(pageA, requestRow(E.id))), 30_000, '戊那一条消失');
  await click(pageA, `${requestRow(F.id)} [data-pc="account-join-reject"]`, '拒绝己');
  await waitFor(async () => !(await has(pageA, requestRow(F.id))), 30_000, '己那一条消失');
  await shot(pageA, 'online-7-after-decisions');
  // 戊:自己进来(这个项目没设二级密码);己:看到被拒
  await pageE.bringToFront();
  await waitFor(() => inEditor(pageE), 120_000, '在线-戊被通过后直接进来');
  await waitGateGone(pageE);
  await dismissConsent(pageE, 8000);
  check(true, '在线-通过后申请人直接能进');
  await shot(pageE, 'online-8-approved-entered');
  await pageF.bringToFront();
  await waitFor(async () => (await requestState(pageF)) === 'rejected', 60_000, '己看到被拒');
  check((await textOf(pageF, '[data-pc="join-request-text"]')) === '创建者没有通过你的申请', '在线-被拒显示「创建者没有通过你的申请」');
  await shot(pageF, 'online-9-rejected');
  for (const page of [pageA, pageE, pageF]) await page.browserContext().close().catch(() => undefined);
  return out;
}

/* ---------------- 手机 ---------------- */

const MOBILE = { width: 390, height: 844 };
async function mobileLogin(page, account, query = '') {
  await page.goto(`${ORIGIN}/editor/?layout=mobile&nosetup=1${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-pcm="login"] input[name="username"]', { timeout: 300_000 });
  await fill(page, '[data-pcm="login"] input[name="username"]', account.name);
  await fill(page, '[data-pcm="login"] input[name="password"]', account.password);
  await P(page, () => document.querySelector('[data-pcm="login"]').requestSubmit());
  await page.waitForSelector('[data-pcm="account-chip"]', { timeout: 60_000 });
}
async function scenarioMobile(accounts) {
  const out = {};
  // 手机那一遍:K(在桌面那个项目里被踢,与这个项目无关)、乙(夹具的第二个账号,不是这个项目的成员)
  const [A, G, H] = [accounts.creator, accounts.k, accounts.b];
  const projectId = accounts.onlineProjectId;
  if (!projectId) throw new Error('手机那一遍用在线那一遍建的项目:先跑 online');
  const query = `&project=${projectId}`;
  // 申请人庚、辛:手机开始页 →「加入别人的项目」→ 被挡住 → 发送申请
  const pageG = await newPage({ viewport: MOBILE, mobile: true });
  await mobileLogin(pageG, G, query);
  await click(pageG, '[data-pcm="home-join"]', '加入别人的项目');
  await click(pageG, '[data-pcm="join-submit"]', '加入');
  await waitFor(async () => (await requestState(pageG, 'data-pcm')) === 'none', 60_000, '庚看到被挡住');
  check((await textOf(pageG, '[data-pcm="join-request-text"]')) === '你不在这个项目的成员名单中。' && await has(pageG, '[data-pcm="join-request-send"]'), '手机-被名单挡住的提示与「发送申请」');
  await shot(pageG, 'mobile-1-blocked');
  await click(pageG, '[data-pcm="join-request-send"]', '发送申请');
  await waitFor(async () => (await requestState(pageG, 'data-pcm')) === 'pending', 30_000, '庚的申请发出');
  check((await textOf(pageG, '[data-pcm="join-request-text"]')) === '已发送，等创建者通过', '手机-发出后「已发送，等创建者通过」');
  await shot(pageG, 'mobile-2-sent');
  const pageH = await newPage({ viewport: MOBILE, mobile: true });
  await mobileLogin(pageH, H, query);
  await click(pageH, '[data-pcm="home-join"]', '辛:加入别人的项目');
  await click(pageH, '[data-pcm="join-submit"]', '辛:加入');
  await waitFor(async () => (await requestState(pageH, 'data-pcm')) === 'none', 60_000, '辛看到被挡住');
  await click(pageH, '[data-pcm="join-request-send"]', '辛发送申请');
  await waitFor(async () => (await requestState(pageH, 'data-pcm')) === 'pending', 30_000, '辛的申请发出');
  // 创建者在手机上:项目列表 → 进项目 → 成员按钮上的角标 → 成员面板里的申请
  const pageA = await newPage({ viewport: MOBILE, mobile: true });
  await mobileLogin(pageA, A);
  await click(pageA, `[data-pcm="proj"][data-project="${projectId}"]`, '创建者打开项目');
  await pageA.waitForSelector('[data-pcm="members-btn"]', { timeout: 180_000 });
  await waitFor(async () => (await textOf(pageA, '[data-pcm="members-request-badge"]')) === '2', 60_000, '手机-成员按钮上出数字角标 2');
  check(true, '手机-有新申请时成员按钮上出数字角标');
  await shot(pageA, 'mobile-3-badge');
  await click(pageA, '[data-pcm="members-btn"]', '成员按钮');
  await pageA.waitForSelector(`[data-pcm="join-request-row"][data-account-id="${G.id}"]`, { timeout: 30_000 });
  await shot(pageA, 'mobile-4-requests');
  await click(pageA, `[data-pcm="join-request-row"][data-account-id="${G.id}"] [data-pcm="join-request-approve"]`, '通过庚');
  await waitFor(async () => !(await has(pageA, `[data-pcm="join-request-row"][data-account-id="${G.id}"]`)), 30_000, '庚那一条消失');
  await click(pageA, `[data-pcm="join-request-row"][data-account-id="${H.id}"] [data-pcm="join-request-reject"]`, '拒绝辛');
  await waitFor(async () => !(await has(pageA, '[data-pcm="join-request-row"]')), 30_000, '申请都处理完');
  await shot(pageA, 'mobile-5-after-decisions');
  // 庚:自己进来;辛:看到被拒
  await pageG.bringToFront();
  await waitFor(() => has(pageG, '[data-pcm="members-btn"]'), 120_000, '手机-庚被通过后直接进来');
  check(true, '手机-通过后申请人直接能进');
  await shot(pageG, 'mobile-6-approved-entered');
  await pageH.bringToFront();
  await waitFor(async () => (await requestState(pageH, 'data-pcm')) === 'rejected', 60_000, '辛看到被拒');
  check((await textOf(pageH, '[data-pcm="join-request-text"]')) === '创建者没有通过你的申请', '手机-被拒显示「创建者没有通过你的申请」');
  await shot(pageH, 'mobile-7-rejected');
  for (const page of [pageA, pageG, pageH]) await page.browserContext().close().catch(() => undefined);
  return out;
}

/* ---------------- 主流程 ---------------- */

try {
  for (const name of ['PROMPTCUT_ACCOUNT_PROVIDER_ROOT', 'PROMPTCUT_PASSWORD_ORDER_MODULE']) if (!process.env[name]) throw new Error(`缺环境变量 ${name}`);
  if (ONLY.some(o => o !== 'desktop') && !fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`没有在线构建 ${DIST}:先跑 npx vite build --mode online`);
  const { startCloudQueueUserFixture } = await import('../../server/test/fixtures/cloud-queue-user-path.mjs');
  fixture = await startCloudQueueUserFixture({ ports: FIXTURE_PORTS, agentPort: 0, publicHandler: onlineHandler() });
  ORIGIN = fixture.origin;
  ca = fs.readFileSync(fixture.caFile);
  say('fixture.ready', { origin: ORIGIN });
  // 网站每个 IP 一小时只许注册 5 个账号(`RATES.registerPerIp`),夹具已注册 2 个:这里只再注册 3 个,三处轮着用
  const accounts = { creator: await loginAccount(fixture.accounts[0]), b: await loginAccount(fixture.accounts[1]) };
  for (const key of ['c', 'd', 'k']) accounts[key] = await registerAccount(`join${key.toUpperCase()}${RUN}`.slice(0, 24));
  say('accounts.ready', { names: Object.values(accounts).map(a => a.name) });
  browser = await puppeteer.launch({ headless: true, acceptInsecureCerts: true, protocolTimeout: 300_000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio'] });
  if (ONLY.includes('desktop')) res.desktop = await scenarioDesktop(accounts);
  if (ONLY.includes('online')) res.online = await scenarioOnline(accounts);
  if (ONLY.includes('mobile')) res.mobile = await scenarioMobile(accounts);
} catch (error) {
  fails.push(`探针中断:${String(error?.message ?? error).slice(0, 300)}`);
  say('ERROR', { message: String(error?.stack ?? error).slice(0, 1200) });
  await debugDump('fail').catch(() => undefined);
} finally {
  await browser?.close().catch(() => undefined);
  await stopAll();
  await fixture?.close().catch(() => undefined);
  if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  res.fails = fails;
  const text = JSON.stringify(res, null, 2).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]');
  fs.writeFileSync(path.join(OUT, 'evidence.json'), text);
  process.stdout.write(`${JSON.stringify({ ok: fails.length === 0, fails, shots: res.shots }).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]')}\n`);
  process.exit(fails.length ? 1 : 0);
}
