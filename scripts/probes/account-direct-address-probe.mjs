/**
 * 在线浏览器项目直达地址与分享链接的端到端探针(2026-10-23 用户定;`docs/semantics/product/platforms.md`「项目直达地址」「分享链接」,
 * 形式见 `docs/semantics/mechanism/platforms.md`「项目地址」)。
 *
 * 真的服务组合(同 `account-join-request-probe.mjs`):账号后端、文档服务、独立的素材服务进程、TLS 入口
 * (`server/test/fixtures/cloud-queue-user-path.mjs`)。在线构建由夹具入口在 `/editor/` 下发,与 `/api/account`、`/hosted` 同源,
 * 并照生产 nginx 的 `try_files $uri /editor/index.html`:`/editor/` 底下不是文件的路径都回编辑器页(`/editor/assets/` 底下没有的回 404)。
 *
 * 验收(全过才算过):
 *   1 创建者新建云端项目后,地址栏是 `/editor/p/<项目号>`,不带 `?project=` 和令牌;刷新后自动回到这个项目;
 *   2 点「首页」回开始页,地址回到 `/editor/`;再打开直达地址,直接进项目;
 *   3 没登录的人打开分享链接 `/editor/s/<项目号>/<令牌>`:「凭链接加入」已填好这条链接;登录、点加入后进项目,
 *     地址换成直达地址,令牌不在地址栏里;
 *   4 同一个浏览器(已登录)另开直达地址:直接进项目;
 *   5 不是成员的人登录后打开直达地址:留在开始页、不进编辑器,并说明原因;
 *   6 旧形式 `/editor/?project=<号>&token=<令牌>` 照常:链接框填好,换成新形式的分享链接;
 *   7 项目设了二级密码:成员打开直达地址时弹出二级密码框(和从列表点进去一样),输对后进项目,地址是直达地址;
 *   8 手机版(`?layout=mobile`):已登录的成员打开直达地址,直接进手机版编辑器。
 *
 *   node scripts/probes/account-direct-address-probe.mjs [--out out/direct-address] [--keep-temp] [--dist dist-online]
 *        [--fixture-ports 6430,6431,6432,6433,6434,6435,6436]
 *   (要设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE,同账号那几条测试;要先 `npx vite build --mode online`)
 *
 * 端口:夹具 6430～6436(入口 6436);夹具里云端 Agent 的入口探针用不到,给 0 由系统挑。
 * 输出:过程写 stderr;截图与 evidence.json 在 --out 下;stdout 最后一行是一行 JSON(`fails` 为空才算过)。不打印密码、令牌、票据。
 */
import '../lib/no-user-dirs.mjs';
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { editorSecurityHeaders } from '../../src/online/stagePolicy.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(ROOT, arg('--out', 'out/direct-address'));
const DIST = path.resolve(ROOT, arg('--dist', 'dist-online'));
const KEEP = argv.includes('--keep-temp');
const FIXTURE_PORTS = arg('--fixture-ports', '6430,6431,6432,6433,6434,6435,6436').split(',').map(Number);
fs.mkdirSync(OUT, { recursive: true });

const REDACT = /[A-Za-z0-9_-]{43,}|\/editor\/s\/[^/\s"]+\/[A-Za-z0-9_-]+|token=[A-Za-z0-9_-]+/g;
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields }).replace(REDACT, '[redacted]')}\n`);
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-direct-address-probe-'));
const fails = [];
const res = { runId: RUN, ports: { fixture: FIXTURE_PORTS }, checks: [], shots: [] };
let fixture = null, browser = null, ca = null, ORIGIN = '';
const check = (ok, name, detail) => {
  res.checks.push({ name, ok: !!ok });
  if (!ok) { fails.push(detail === undefined ? name : `${name}(${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); say('FAIL', { name, detail }); }
  else say('ok', { name });
  return !!ok;
};

/* ---------------- 在线构建:/editor/ 下发,不是文件的路径回编辑器页(同生产 nginx 的兜底) ---------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.webp': 'image/webp' };
function onlineHandler() {
  const headers = editorSecurityHeaders([]);
  const root = path.resolve(DIST);
  const send = (req, res, file) => {
    const bytes = fs.readFileSync(file);
    res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
    return true;
  };
  return async (req, res) => {
    const url = new URL(req.url, 'https://edge.invalid');
    if (!['GET', 'HEAD'].includes(req.method)) return false;
    if (url.pathname === '/editor/runtime-config.json') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ v: 1 })); return true;
    }
    let rel = null;
    if (url.pathname === '/editor' || url.pathname === '/editor/') rel = 'index.html';
    else if (url.pathname.startsWith('/editor/')) rel = decodeURIComponent(url.pathname.slice('/editor/'.length));
    else if (url.pathname.startsWith('/catalog/')) rel = decodeURIComponent(url.pathname.slice(1));
    if (!rel) return false;
    const file = path.resolve(root, rel);
    const inside = !path.relative(root, file).startsWith('..') && !path.isAbsolute(path.relative(root, file));
    if (inside) { try { if (fs.statSync(file).isFile()) return send(req, res, file); } catch { /* 不是文件 */ } }
    // 生产 nginx:`location ^~ /editor/assets/ { try_files $uri =404; }`、`location ^~ /editor/ { try_files $uri /editor/index.html; }`
    if (!url.pathname.startsWith('/editor/') || url.pathname.startsWith('/editor/assets/')) return false;
    return send(req, res, path.join(root, 'index.html'));
  };
}

/* ---------------- 夹具入口上的请求(Node 一侧;同 account-join-request-probe.mjs) ---------------- */

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
function siteClient() {
  let cookie = '', csrf = '';
  return async (method, route, body) => {
    const r = await edge(`/api/account${route}`, { method, body, headers: { ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrf } : {}) } });
    if (r.cookie) cookie = r.cookie;
    if (r.body?.csrfToken) csrf = r.body.csrfToken;
    return r;
  };
}
function withSite(account, site) {
  account.editorToken = async () => {
    const s = await site('POST', '/editor/session', { deviceId: `probe-${account.name}`.slice(0, 64), deviceName: `probe ${account.name}`, requestId: randomUUID() });
    if (s.status !== 200) throw new Error(`${account.name} 拿编辑器令牌失败:${s.status}`);
    return s.body.accessToken;
  };
  account.ownedProjectId = async projectName => (await site('GET', '/projects')).body?.owned?.find(p => p.name === projectName)?.projectId ?? null;
  return account;
}
async function registerAccount(name) {
  const site = siteClient();
  await site('GET', '/me');
  const password = `probe-${randomUUID()}`;
  const made = await site('POST', '/register', { name, password });
  if (made.status !== 200) throw new Error(`注册 ${name} 失败:${made.status} ${made.body?.code}`);
  return withSite({ name, password, id: made.body.account.id }, site);
}
async function loginAccount(account) {
  const site = siteClient();
  await site('GET', '/me');
  const r = await site('POST', '/login', { name: account.name, password: account.password, remember: false });
  if (r.status !== 200) throw new Error(`${account.name} 网站登录失败:${r.status} ${r.body?.code}`);
  return withSite({ ...account, id: r.body.account.id }, site);
}
const api = (route, body, token) => edge(route, { body, token });
/** 创建者的会话里带着项目的链接令牌(`ProjectSession.linkToken`);刚建好的项目素材服务可能还没追上,503 时重试 */
async function linkTokenOf(who, projectId) {
  const token = await who.editorToken();
  for (let i = 0; i < 20; i++) {
    const r = await api('/hosted/shared/account/session', { projectId, deviceId: `probe-${who.id.slice(-8)}`, requestId: randomUUID() }, token);
    if (r.status === 200 && typeof r.body?.linkToken === 'string') return r.body.linkToken;
    if (r.status !== 503) throw new Error(`取链接令牌失败:${r.status} ${r.body?.code}`);
    await sleep(500);
  }
  throw new Error('取链接令牌一直 503');
}
async function adminAs(token, projectId, body) {
  const members = await api('/hosted/shared/account/members', { projectId }, token);
  if (members.status !== 200) throw new Error(`读成员失败:${members.status} ${members.body?.code}`);
  return api('/hosted/shared/account/admin', { projectId, expectedAccessRevision: members.body.accessRevision, requestId: randomUUID(), ...body }, token);
}

/* ---------------- 页面 ---------------- */

const P = (page, fn, ...args) => page.evaluate(fn, ...args);
const has = (page, sel) => P(page, s => !!document.querySelector(s), sel);
const textOf = (page, sel) => P(page, s => document.querySelector(s)?.textContent?.trim() ?? null, sel);
const pathOf = page => P(page, () => location.pathname + location.search);
async function click(page, sel, what = sel) {
  await waitFor(() => P(page, s => { const el = document.querySelector(s); return !!el && !el.disabled; }, sel), 60_000, `可以点 ${what}`);
  await P(page, s => document.querySelector(s).click(), sel);
}
async function fill(page, sel, value) {
  await page.waitForSelector(sel, { timeout: 60_000 });
  await P(page, (s, v) => {
    const el = document.querySelector(s);
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, sel, value);
}
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
async function shot(page, name) {
  await dismissConsent(page);
  await sleep(400);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  res.shots.push(path.relative(ROOT, file).split(path.sep).join('/'));
  say('shot', { name });
}
const openPages = [];
async function debugDump(tag) {
  for (const [i, page] of openPages.entries()) {
    try {
      if (page.isClosed()) continue;
      await page.screenshot({ path: path.join(OUT, `debug-${tag}-${i}.png`) });
      const info = await P(page, () => ({ error: document.querySelector('[data-pc="account-error"], .err[role="alert"]')?.textContent ?? null, body: document.body?.innerText?.slice(0, 800) ?? '' }));
      say('debug.page', { tag, i, ...info });
    } catch (error) { say('debug.page-failed', { tag, i, message: String(error?.message ?? error).slice(0, 200) }); }
  }
}
/** 一个浏览器配置(cookie 各自一份);同一个配置里另开的页面共用网站登录 */
const newContext = () => browser.createBrowserContext();
async function newPage(context, { mobile = false } = {}) {
  const page = await context.newPage();
  openPages.push(page);
  page.on('console', m => { if (m.type() === 'error') say('console', { type: m.type(), text: m.text().slice(0, 300) }); });
  page.on('pageerror', e => say('pageerror', { message: String(e?.message ?? e).slice(0, 240) }));
  page.setDefaultTimeout(120_000); page.setDefaultNavigationTimeout(300_000);
  if (mobile) {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36');
  } else await page.setViewport({ width: 1440, height: 900 });
  return page;
}
async function startLogin(page, account) {
  await page.waitForSelector('[data-pc="account-projects"] input[name="username"]', { timeout: 300_000 });
  await fill(page, '[data-pc="account-projects"] input[name="username"]', account.name);
  await fill(page, '[data-pc="account-projects"] input[name="password"]', account.password);
  await P(page, () => document.querySelector('[data-pc="account-projects"] input[name="username"]').closest('form').requestSubmit());
  await page.waitForSelector('[data-pc="account-name"]', { timeout: 60_000 });
}
const inEditor = page => has(page, '[data-pc="members-button"]');
const onStartPage = page => has(page, '[data-pc="account-projects"]');
async function waitGateGone(page) { await waitFor(() => P(page, () => !document.querySelector('[data-pc="lowmem-gate"]')), 120_000, '测量遮罩退下').catch(() => null); }
async function enteredEditor(page, what) {
  await waitFor(() => inEditor(page), 180_000, what);
  await waitGateGone(page);
  await dismissConsent(page, 3000);
}

/* ---------------- 场景 ---------------- */

async function scenario(A, B, C) {
  const out = {};
  // 1 创建者新建云端项目:地址栏换成直达地址
  const ctxA = await newContext();
  const pageA = await newPage(ctxA);
  await pageA.goto(`${ORIGIN}/editor/?nosetup=1`, { waitUntil: 'domcontentloaded' });
  await startLogin(pageA, A);
  const name = `直达地址-${RUN}`;
  await fill(pageA, '[data-pc="cloud-project-name"]', name);
  await click(pageA, '[data-pc="cloud-create"]', '新建云端项目');
  await enteredEditor(pageA, '创建者进入新项目');
  const projectId = out.projectId = await waitFor(() => A.ownedProjectId(name), 30_000, '取新项目的项目号');
  const direct = `/editor/p/${projectId}`;
  out.afterCreate = await pathOf(pageA);
  check(out.afterCreate === `${direct}?nosetup=1`, '1-新建后地址栏是直达地址(不带 project、令牌)', out.afterCreate);
  await shot(pageA, '1-created');
  await pageA.reload({ waitUntil: 'domcontentloaded' });
  await enteredEditor(pageA, '刷新后回到项目');
  check(await inEditor(pageA), '1-刷新后自动回到这个项目');
  check((await pathOf(pageA)).startsWith(direct), '1-刷新后地址还是直达地址', await pathOf(pageA));
  await shot(pageA, '1-reloaded');

  // 2 回首页 → /editor/;再开直达地址直接进
  await P(pageA, () => window.dispatchEvent(new Event('pc-go-home')));
  await waitFor(() => onStartPage(pageA), 60_000, '回到开始页');
  out.afterHome = await pathOf(pageA);
  check(out.afterHome === '/editor/?nosetup=1', '2-回首页后地址回到 /editor/', out.afterHome);
  await pageA.goto(`${ORIGIN}${direct}?nosetup=1`, { waitUntil: 'domcontentloaded' });
  await enteredEditor(pageA, '再开直达地址进项目');
  check(await inEditor(pageA), '2-已登录时打开直达地址直接进项目');

  // 3 没登录的乙打开分享链接。新项目一开始没有链接令牌,创建者「作废并重新生成项目链接」之后才有(`server/account/authority.mjs` 的 regen-link)
  check((await adminAs(await A.editorToken(), projectId, { op: 'regen-link' })).status === 200, '3-创建者重新生成了项目链接');
  const token = await linkTokenOf(A, projectId);
  const share = `/editor/s/${projectId}/${token}`;
  const ctxB = await newContext();
  const pageB = await newPage(ctxB);
  await pageB.goto(`${ORIGIN}${share}?nosetup=1`, { waitUntil: 'domcontentloaded' });
  await pageB.waitForSelector('[data-pc="cloud-project-link"]', { timeout: 300_000 });
  check((await P(pageB, () => document.querySelector('[data-pc="cloud-project-link"]').value)) === `${ORIGIN}${share}`, '3-分享链接打开后「凭链接加入」已填好这条链接');
  await startLogin(pageB, B);
  check(!(await inEditor(pageB)), '3-分享链接不自动进项目(和原来一样登录后点加入)');
  await click(pageB, '[data-pc="cloud-join"]', '加入并打开项目');
  await enteredEditor(pageB, '乙加入后进项目');
  out.afterJoin = await pathOf(pageB);
  check(out.afterJoin === `${direct}?nosetup=1`, '3-加入后地址换成直达地址', out.afterJoin.replace(token, '[token]'));
  check(!out.afterJoin.includes(token), '3-令牌不留在地址栏里');
  await shot(pageB, '3-joined');

  // 4 同一个浏览器另开直达地址
  const pageB2 = await newPage(ctxB);
  await pageB2.goto(`${ORIGIN}${direct}?nosetup=1`, { waitUntil: 'domcontentloaded' });
  await enteredEditor(pageB2, '乙另开直达地址进项目');
  check(await inEditor(pageB2), '4-已登录的成员另开直达地址直接进项目');

  // 5 不是成员的丙
  const ctxC = await newContext();
  const pageC = await newPage(ctxC);
  await pageC.goto(`${ORIGIN}${direct}?nosetup=1`, { waitUntil: 'domcontentloaded' });
  await startLogin(pageC, C);
  out.nonMemberError = await waitFor(() => textOf(pageC, '[data-pc="account-error"]'), 60_000, '丙看到进不去的原因');
  await sleep(1500);
  check(!(await inEditor(pageC)) && await onStartPage(pageC), '5-不是成员的人留在开始页、不进编辑器');
  check(!!out.nonMemberError, '5-并说明原因', out.nonMemberError);
  await shot(pageC, '5-not-member');

  // 6 旧形式链接照常
  const pageB3 = await newPage(ctxB);
  await pageB3.goto(`${ORIGIN}/editor/?nosetup=1&project=${projectId}&token=${token}`, { waitUntil: 'domcontentloaded' });
  await pageB3.waitForSelector('[data-pc="cloud-project-link"]', { timeout: 300_000 });
  check(await waitFor(async () => (await P(pageB3, () => document.querySelector('[data-pc="cloud-project-link"]').value)) === `${ORIGIN}${share}`, 30_000, '旧链接预填').catch(() => false),
    '6-旧形式 ?project=&token= 照常:链接框填好(换成新形式)');

  // 7 二级密码:成员打开直达地址时弹出二级密码框
  const secondary = `二级-${RUN}`;
  check((await adminAs(await A.editorToken(), projectId, { op: 'set-secondary-password', password: secondary })).status === 200, '7-创建者设了项目二级密码');
  const pageB4 = await newPage(ctxB);
  await pageB4.goto(`${ORIGIN}${direct}?nosetup=1`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => has(pageB4, '[data-pc="cloud-secondary-password"]'), 120_000, '弹出二级密码框');
  out.secondaryText = await textOf(pageB4, '[data-pc="account-error"]');
  check(!(await inEditor(pageB4)), '7-要二级密码时先不进项目');
  await shot(pageB4, '7-secondary');
  await fill(pageB4, '[data-pc="cloud-secondary-password"]', secondary);
  await P(pageB4, () => document.querySelector('[data-pc="cloud-join"]').closest('form').requestSubmit());
  await enteredEditor(pageB4, '输对二级密码后进项目');
  check((await pathOf(pageB4)) === `${direct}?nosetup=1`, '7-输对后进项目,地址是直达地址', await pathOf(pageB4));

  // 8 手机版
  const pageM = await newPage(ctxB, { mobile: true });
  await pageM.goto(`${ORIGIN}${direct}?nosetup=1&layout=mobile`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => has(pageM, '[data-pcm="editor"]'), 180_000, '手机版进项目');
  await dismissConsent(pageM, 3000);
  check(await has(pageM, '[data-pcm="editor"]'), '8-手机版打开直达地址直接进编辑器');
  check((await pathOf(pageM)).startsWith(direct), '8-手机版地址是直达地址', await pathOf(pageM));
  await shot(pageM, '8-mobile');
  return out;
}

/* ---------------- 主流程 ---------------- */

try {
  for (const name of ['PROMPTCUT_ACCOUNT_PROVIDER_ROOT', 'PROMPTCUT_PASSWORD_ORDER_MODULE']) if (!process.env[name]) throw new Error(`缺环境变量 ${name}`);
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`没有在线构建 ${DIST}:先跑 npx vite build --mode online`);
  const { startCloudQueueUserFixture } = await import('../../server/test/fixtures/cloud-queue-user-path.mjs');
  fixture = await startCloudQueueUserFixture({ ports: FIXTURE_PORTS, agentPort: 0, publicHandler: onlineHandler() });
  ORIGIN = fixture.origin;
  ca = fs.readFileSync(fixture.caFile);
  say('fixture.ready', { origin: ORIGIN });
  // 夹具已注册 2 个账号;网站每个 IP 一小时只许注册 5 个,这里只再注册 1 个
  const A = await loginAccount(fixture.accounts[0]), B = await loginAccount(fixture.accounts[1]);
  const C = await registerAccount(`direct${RUN}`.slice(0, 24));
  browser = await puppeteer.launch({ headless: true, acceptInsecureCerts: true, protocolTimeout: 300_000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio'] });
  res.result = await scenario(A, B, C);
} catch (error) {
  fails.push(`探针中断:${String(error?.message ?? error).slice(0, 300)}`);
  say('ERROR', { message: String(error?.stack ?? error).slice(0, 1200) });
  await debugDump('fail').catch(() => undefined);
} finally {
  await browser?.close().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  res.fails = fails;
  const text = JSON.stringify(res, null, 2).replace(REDACT, '[redacted]');
  fs.writeFileSync(path.join(OUT, 'evidence.json'), text);
  process.stdout.write(`${JSON.stringify({ ok: fails.length === 0, fails, shots: res.shots }).replace(REDACT, '[redacted]')}\n`);
  process.exit(fails.length ? 1 : 0);
}
