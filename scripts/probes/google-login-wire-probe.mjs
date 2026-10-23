// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
/**
 * 编辑器登录页「用 Google 继续」真跑一遍（分支 `claude/google-login-wire`）。
 *
 * 为什么有这支探针：这条路原来是两个会话各做一半 —— 登录页里 Google 那一块（`src/start/OnlineLogin.tsx`）
 * 和外面接业务层那一层（`src/start/VibeLogin.tsx`）—— 接缝上没有任何测试，于是「登成功了但页面一动不动」
 * 这种毛病只能等用户在生产上撞到（2026-10-24 用户报「用Google账号登录进不去，授权以后没有反应」）。
 *
 * 全在本机、全是真进程：真的 VisuHive 账号服务（`account/app.mjs`）、账号版文档服务、素材服务进程、
 * 在线构建当 `/editor/`。**只有两样是假的**：
 *   1. 身份服务（真实部署里是另一个进程，负责验 Google 的签名）换成夹具里的假身份，不验签、直接回「这是谁」——
 *      和 VisuHive 自己的 `account/test/third-party.test.mjs` 同一个办法；
 *   2. Google 的 `gsi/client` 脚本换成桩：它照 GIS 的样子提供 `initialize` / `renderButton`，
 *      `renderButton` 画一颗真按钮，点下去就拿事先摆好的凭据调页面注册的那个回调 ——
 *      也就是「用户在 Google 弹窗里点了同意」之后 GIS 会做的那一件事。
 * 绝不连生产，也不需要任何真的 Google 账号。
 *
 *   node scripts/probes/google-login-wire-probe.mjs --dist dist-online --site-root <VisuHive>/site --out <目录>
 *   要设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE（同全量测试）、PROMPTCUT_NO_PORT_FILE=1
 *   端口：夹具 6530～6536、Agent 服务 6537（分给这条分支的 6530～6539）
 *
 * 走的路：
 *   ① 已经关联过 Google 的账号：打开 /editor/ → 是登录页 → Google 那一块画出来了 → 点它 →
 *      **离开登录页、进开始页、顶上是这个账号的名字**；同时核对真发生过 `POST /api/account/third-party/login` 200
 *      与 `/api/account/editor/session`（换编辑器令牌）；
 *   ② 还没关联过的 Google 身份：点下去应当出「起一个账号名」那一步，填好建号 → 同样进开始页。
 * 最后一行是一行 JSON：{ ok, steps, fails }。退出码 0 过、1 不过。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { editorSecurityHeaders, stageSecurityHeaders } from '../../src/online/stagePolicy.mjs';
import { startAccountConversationControlsUserFixture } from '../../server/test/fixtures/account-conversation-controls-user-path.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 15 * 60_000).unref();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (key, dflt) => { const i = argv.indexOf(key); return i < 0 ? dflt : argv[i + 1]; };
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const SITE = path.resolve(arg('--site-root', path.join(process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT ?? '', 'site')));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out/google-login-wire')));
await fs.mkdir(OUT, { recursive: true });
const FIXTURE_PORTS = [6530, 6531, 6532, 6533, 6534, 6535, 6536];
const AGENT_PORT = 6537;
const STAGE_PORTS = [6538, 6539];
const ORIGIN = `https://127.0.0.1:${FIXTURE_PORTS[6]}`;
const STAGES = STAGE_PORTS.map((p, i) => `http://s${i + 1}.pc.localhost:${p}`);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
const T = 60_000;

/** 这颗「凭据」在真实世界里是 Google 签的 ID 令牌；这里不验签，假身份照字面认人 */
const LINKED_TOKEN = 'fixture-google-credential-linked';
const FRESH_TOKEN = 'fixture-google-credential-fresh';
const LINKED = { provider: 'google', subject: 'g-fixture-linked', email: 'linked@example.test', emailVerified: true, name: 'Linked Google 用户' };
const FRESH = { provider: 'google', subject: 'g-fixture-fresh', email: 'fresh@example.test', emailVerified: true, name: 'Fresh Google 用户' };

const fails = [];
const out = { ok: false, out: OUT, steps: {} };
const step = (k, v) => { out.steps[k] = v; console.error(`[step] ${k} ${JSON.stringify(v).slice(0, 300)}`); };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = T, every = 250) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}`); return null; }
    await sleep(every);
  }
}

/** 假身份服务：按令牌字面认人，不验签。账号服务那一侧照常跑（`verifyThirdParty` 只调 `verify`） */
const identity = {
  calls: [],
  async verify(provider, token) {
    identity.calls.push({ provider, token });
    if (token === LINKED_TOKEN) return LINKED;
    if (token === FRESH_TOKEN) return FRESH;
    throw Object.assign(new Error('fixture-unknown-token'), { code: 'bad-token' });
  },
};

/* ---------------- 静态服务：在线构建当 /editor/，官网页面当其余路径 ---------------- */
function below(root, relative) { const target = path.resolve(root, relative); const rel = path.relative(root, target); return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? target : null; }
async function sendFile(req, res, root, relative, headers) {
  const file = below(root, relative);
  let stat;
  try { stat = file && await fs.stat(file); } catch { /* 404 */ }
  if (!stat?.isFile()) { res.writeHead(404, headers); res.end(); return; }
  const bytes = await fs.readFile(file);
  res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}
function staticHandler(stage = false) {
  return async (req, res) => {
    const headers = stage ? stageSecurityHeaders(ORIGIN) : editorSecurityHeaders(STAGES);
    const url = new URL(req.url, ORIGIN);
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, headers); res.end(); return; }
    if (url.pathname === '/editor/runtime-config.json') { res.writeHead(200, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ v: 1, stageOrigins: STAGES })); return; }
    if (url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html' || /^\/editor\/(p|s)\//.test(url.pathname)) return sendFile(req, res, DIST, 'index.html', headers);
    if (url.pathname.startsWith('/editor/')) return sendFile(req, res, DIST, decodeURIComponent(url.pathname.slice('/editor/'.length)), headers);
    if (url.pathname.startsWith('/catalog/')) return sendFile(req, res, DIST, decodeURIComponent(url.pathname.slice(1)), headers);
    if (!stage) {
      const file = url.pathname === '/' ? 'index.html' : ['/account', '/login', '/register', '/reset'].includes(url.pathname) ? `${url.pathname.slice(1)}.html` : decodeURIComponent(url.pathname.slice(1));
      return sendFile(req, res, SITE, file, { 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
    }
    res.writeHead(404, headers); res.end();
  };
}
const stageServers = [];
async function startStage(port) {
  const handler = staticHandler(true);
  const server = http.createServer((req, res) => { void handler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  stageServers.push(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
}

/**
 * Google 的 `gsi/client` 换成桩。
 *
 * 桩守住 GIS 对页面的那一点约定：`initialize({ callback })` 把回调收下，`renderButton(parent)` 往里放一颗
 * 够高的按钮（登录页会量它的高度，太矮就判成「没画出来」）。点它＝用户在 Google 弹窗里点了同意，
 * 于是拿 `window.__pcGoogleCredential` 调那个回调。这一步之后的每一行代码都是产品代码。
 */
const GSI_STUB = `
window.google = window.google || {}; window.google.accounts = window.google.accounts || {};
window.google.accounts.id = {
  initialize(config) { window.__pcGsiConfig = config; },
  renderButton(parent) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = '通过 Google 继续操作（桩）';
    b.setAttribute('data-pc', 'fixture-google-button');
    b.style.cssText = 'width:320px;height:44px;display:block;';
    b.addEventListener('click', () => {
      window.__pcGsiConfig && window.__pcGsiConfig.callback({ credential: window.__pcGoogleCredential });
    });
    parent.replaceChildren(b);
    window.__pcGsiRendered = true;
  },
};
`;

async function newPage(browser, label, credential) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.label = label; page.errors = []; page.net = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.stack ?? e?.message ?? e).slice(0, 500)));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/account/')) page.net.push(`${r.request().method()} ${u.pathname} ${r.status()}`);
  });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    // Google 的脚本不出网：换成桩。页面里那个 `<script src=...>` 其余一切照旧
    if (req.url().startsWith('https://accounts.google.com/gsi/client')) {
      void req.respond({ status: 200, contentType: 'text/javascript; charset=utf-8', body: GSI_STUB });
      return;
    }
    // 其它去 Google 的请求（按钮图、埋点）一律掐掉，省得无头环境等 DNS
    if (/(^|\.)google(apis)?\.com$/.test(new URL(req.url()).hostname)) { void req.abort(); return; }
    void req.continue();
  });
  await page.evaluateOnNewDocument((c) => { window.__pcGoogleCredential = c; }, credential);
  await page.setViewport({ width: 1440, height: 900 });
  page.setDefaultTimeout(T);
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
const exists = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel);
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel);

/** 走到「登录页画出了 Google 按钮」为止，回那一页 */
async function openLoginPage(browser, label, credential) {
  const page = await newPage(browser, label, credential);
  await page.goto(`${ORIGIN}/editor/`, { waitUntil: 'domcontentloaded' });
  const login = await until(`${label} 登录页`, () => page.$('[data-pc="start-vibe-login"]'), T);
  const button = await until(`${label} Google 按钮画出来`, () => page.$('[data-pc="fixture-google-button"]'), T);
  step(`${label}-login-page`, { loginPage: !!login, googleButton: !!button });
  return page;
}

let fixture = null, browser = null;
try {
  fixture = await startAccountConversationControlsUserFixture({
    ports: FIXTURE_PORTS, agentPort: AGENT_PORT, publicHandler: staticHandler(),
    thirdParty: { identity, providers: [{ provider: 'google', clientId: 'fixture-google-client-id.apps.googleusercontent.com' }] },
  });
  check(fixture.origin === ORIGIN, '本机账号版环境起来了', fixture.origin);
  for (const port of STAGE_PORTS) await startStage(port);

  // ① 的前提：把那个 Google 身份先关联到夹具里已有的账号 dualUser0（真实世界里是用户早先绑过）
  const owner = fixture.store.accountByNameKey('dualuser0');
  check(!!owner, '夹具里找得到 dualUser0');
  const linked = owner && fixture.store.linkIdentity({ provider: LINKED.provider, subject: LINKED.subject, accountId: owner.id, email: LINKED.email, now: Date.now() });
  check(!!linked, '把 Google 身份关联到 dualUser0');
  step('0-fixture', { account: owner?.name ?? null, linked: !!linked });

  browser = await puppeteer.launch({ headless: true, acceptInsecureCerts: true, protocolTimeout: 600_000,
    args: [...PROBE_CHROME_ARGS, '--no-first-run', '--ignore-certificate-errors',
      '--host-resolver-rules=MAP s1.pc.localhost 127.0.0.1,MAP s2.pc.localhost 127.0.0.1'] });

  /* ========== ① 已关联的账号：点下去应当进开始页 ========== */
  {
    const page = await openLoginPage(browser, 'linked', LINKED_TOKEN);
    await shot(page, '1-login-page');
    await (await page.$('[data-pc="fixture-google-button"]')).click();
    const started = await until('linked 进开始页', () => page.$('[data-pc="start-online"][data-signed-in]'), T);
    const stillLogin = await exists(page, '[data-pc="start-vibe-login"]');
    const who = await text(page, '[data-pc="start-account-name"]');
    await shot(page, '2-after-google');
    const net = page.net.slice();
    check(!!started, '① 点完 Google 就离开登录页、进开始页', { stillLogin, net: net.slice(-6) });
    check(!stillLogin, '① 登录页收起来了');
    check(net.some((l) => l === 'POST /api/account/third-party/login 200'), '① 真向账号服务登过', net);
    check(net.some((l) => l.includes('/api/account/editor/session') && l.endsWith('200')), '① 换到了编辑器令牌', net);
    check(page.errors.length === 0, '① 页面没有脚本错误', page.errors.slice(0, 2));
    step('1-linked', { started: !!started, stillLogin, accountName: who, net: net.slice(-8), errors: page.errors.length });
  }

  /* ========== ② 没关联过的身份：先起账号名，再进开始页 ========== */
  {
    const page = await openLoginPage(browser, 'fresh', FRESH_TOKEN);
    await (await page.$('[data-pc="fixture-google-button"]')).click();
    const nameBox = await until('fresh 要起账号名那一步', () => page.$('[data-pc="start-login-google-name"] input'), T);
    await shot(page, '3-need-name');
    let started = null, stillLogin = true;
    if (nameBox) {
      await nameBox.click({ clickCount: 3 });
      await nameBox.type('googleNewcomer');
      await (await page.$('[data-pc="start-login-google-create"]')).click();
      started = await until('fresh 进开始页', () => page.$('[data-pc="start-online"][data-signed-in]'), T);
      stillLogin = await exists(page, '[data-pc="start-vibe-login"]');
      await shot(page, '4-after-register');
    }
    check(!!nameBox, '② 没关联过的身份要先起一个账号名');
    check(!!started, '② 起完名字就进开始页', { stillLogin, net: page.net.slice(-6) });
    step('2-fresh', { needName: !!nameBox, started: !!started, stillLogin, net: page.net.slice(-8), errors: page.errors.length });
  }

  out.ok = fails.length === 0;
} catch (e) {
  fails.push(`抛了:${String(e?.stack ?? e?.message ?? e).slice(0, 600)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const s of stageServers) await new Promise((r) => s.close(r));
  if (fixture) await fixture.close().catch(() => {});
}
out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
