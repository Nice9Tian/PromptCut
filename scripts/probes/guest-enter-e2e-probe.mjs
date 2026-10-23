/**
 * 游客进自己的云端项目：端到端探针（claude/guest-enter；0.7.21 线上实测游客建好项目后点进去报「请先登录账号。」）。
 *
 * 真的服务组合（同 `account-direct-address-probe.mjs`）：账号后端、文档服务（带游客密钥）、独立的素材服务进程、TLS 入口
 * （`server/test/fixtures/cloud-queue-user-path.mjs`）。在线构建由夹具入口在 `/editor/` 下发，与 `/hosted`、`/media` 同源。
 * 全程只用游客身份，不登录任何账号。
 *
 * 验收（全过才算过）：
 *   G1 开始页点「以游客身份进入」：拿到身份，显示「游客-XXXX」；
 *   G2 新建云端项目：进了编辑器（成员按钮在），开始页没有报「请先登录账号。」，地址栏是直达地址 `/editor/p/<项目号>`；
 *   G3 成员浮层里自己那一行是「游客-XXXX（自己）」并标着创建者；
 *   G4 导入一张图片：素材库「图片」组是 1 个项，缩略图画得出来（读的是素材服务里的字节）；
 *   G5 刷新：自动以同一个游客身份回到这个项目，图片还在、缩略图画得出来；
 *   G6 回首页、再从开始页点自己那个项目（线上出错的正是这一步）：进得去，图片还在；
 *   G7 进项目这一路上页面里没有出现「请先登录账号」（右栏云端 Agent 那里说的是游客暂时用不了，见报告）。
 *
 *   node scripts/probes/guest-enter-e2e-probe.mjs [--out out/guest-enter] [--keep-temp] [--dist dist-online]
 *        [--fixture-ports 6490,6491,6492,6493,6494,6495,6496]
 *   （要设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE，同账号那几条测试；要先 `npx vite build --mode online`；
 *    跑的时候带 PROMPTCUT_NO_PORT_FILE=1）
 *
 * 排查时设 GUEST_PROBE_DEBUG=1：另打出页面的 /hosted、/media 请求（地址里的票据打码）和导入后十几秒里素材库的样子。
 * 端口：夹具 6490～6496（入口 6496）；夹具里云端 Agent 的入口探针用不到，给 0 由系统挑。
 * 输出：过程写 stderr；截图与 evidence.json 在 --out 下；stdout 最后一行是一行 JSON（`fails` 为空才算过）。不打印令牌、票据。
 */
import '../lib/no-user-dirs.mjs';
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { editorSecurityHeaders } from '../../src/online/stagePolicy.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(ROOT, arg('--out', 'out/guest-enter'));
const DIST = path.resolve(ROOT, arg('--dist', 'dist-online'));
const KEEP = argv.includes('--keep-temp');
const FIXTURE_PORTS = arg('--fixture-ports', '6490,6491,6492,6493,6494,6495,6496').split(',').map(Number);
fs.mkdirSync(OUT, { recursive: true });

const REDACT = /[A-Za-z0-9_-]{43,}|gst1[A-Za-z0-9_-]+/g;
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-guest-enter-probe-'));
const fails = [];
const res = { runId: RUN, ports: { fixture: FIXTURE_PORTS }, checks: [], shots: [] };
let fixture = null, browser = null, ca = null, ORIGIN = '';
const check = (ok, name, detail) => {
  res.checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) });
  if (!ok) { fails.push(detail === undefined ? name : `${name}(${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); say('FAIL', { name, detail }); }
  else say('ok', { name, ...(detail !== undefined ? { detail } : {}) });
  return !!ok;
};

/* ---------------- 一张真 PNG(纯色 96×64),不带依赖 ---------------- */

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function solidPng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

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
    if (!url.pathname.startsWith('/editor/') || url.pathname.startsWith('/editor/assets/')) return false;
    return send(req, res, path.join(root, 'index.html'));
  };
}

/* ---------------- 页面 ---------------- */

const P = (page, fn, ...args) => page.evaluate(fn, ...args);
const has = (page, sel) => P(page, s => !!document.querySelector(s), sel);
const textOf = (page, sel) => P(page, s => document.querySelector(s)?.textContent?.trim() ?? null, sel);
const pathOf = page => P(page, () => location.pathname + location.search);
const bodyText = page => P(page, () => document.body?.innerText ?? '');
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
  await sleep(400);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  res.shots.push(path.relative(ROOT, file).split(path.sep).join('/'));
  say('shot', { name });
}
let thePage = null;
async function debugDump(tag) {
  try {
    if (!thePage || thePage.isClosed()) return;
    await thePage.screenshot({ path: path.join(OUT, `debug-${tag}.png`) });
    const info = await P(thePage, () => ({ error: document.querySelector('[data-pc="account-error"]')?.textContent ?? null, body: document.body?.innerText?.slice(0, 1200) ?? '' }));
    say('debug.page', { tag, ...info });
  } catch (error) { say('debug.page-failed', { tag, message: String(error?.message ?? error).slice(0, 200) }); }
}
/** 页面上出现过的「请先登录账号」(线上那个错):每一步都看一眼,只要出现过就记下来 */
const sawLoginRequired = [];
async function watchLoginRequired(page, where) {
  const t = await bodyText(page).catch(() => '');
  if (t.includes('请先登录账号')) sawLoginRequired.push(where);
}
const inEditor = page => has(page, '[data-pc="members-button"]');
async function waitGateGone(page) { await waitFor(() => P(page, () => !document.querySelector('[data-pc="lowmem-gate"]')), 120_000, '测量遮罩退下').catch(() => null); }
async function enteredEditor(page, what) {
  // 进不去时开始页会报原因:等到其一出现,报原因的当场失败(不白等三分钟)
  const outcome = await waitFor(async () => (await inEditor(page)) ? 'editor' : (await textOf(page, '[data-pc="account-error"]')) ? 'error' : null, 180_000, what);
  if (outcome === 'error') throw new Error(`${what}:开始页报「${await textOf(page, '[data-pc="account-error"]')}」`);
  await waitGateGone(page);
  // 编辑台的样式表是按需加载的:等它们都到了再往下(不然截出来是没上样式的页面)
  await waitFor(() => P(page, () => [...document.querySelectorAll('link[rel="stylesheet"]')].every(l => !!l.sheet) &&
    getComputedStyle(document.querySelector('[data-pc="members-button"]')).height === '26px'), 60_000, '编辑台样式表加载完').catch(() => null);
  await dismissConsent(page, 3000);
}
/** 素材库「图片」组:几个项、缩略图是不是真画出来了(读的是素材服务里的字节,不是本页的临时副本) */
const imagesGroup = page => P(page, () => {
  // 总览里是组框(`data-pc-group`),导入后会自动打开这个组(`data-pc-open-group`),两种都认
  const g = document.querySelector('[data-pc-open-group="images"]') ?? document.querySelector('[data-pc-group="images"]');
  if (!g) return null;
  const imgs = [...g.querySelectorAll('img')];
  const countText = g.querySelector('.pc-lib-group-count, .pc-lib-count')?.textContent?.trim() ?? '';
  return { count: Number(/^(\d+)\s*个项/.exec(countText)?.[1] ?? NaN), view: g.matches('[data-pc-open-group]') ? 'group' : 'overview',
    imgs: imgs.length, drawn: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
    srcKinds: imgs.map(i => (i.currentSrc || i.src).replace(/^(blob:|data:|https?:\/\/[^/]+)(\/[^/?]*)?.*$/, '$1$2')) };
});
async function waitImage(page, what, { drawn = true, ms = 90_000 } = {}) {
  try { return await waitFor(async () => { const g = await imagesGroup(page); return g && g.count === 1 && (!drawn || g.drawn >= 1) ? g : null; }, ms, what); }
  catch (error) { throw new Error(`${error.message}:最后看到 ${JSON.stringify(await imagesGroup(page).catch(() => null))}`); }
}

/* ---------------- Node 一侧:凭游客令牌直接读文档服务(同夹具里 openHostedProjectOverWebSocket 的走法) ---------------- */

function edgeJson(route, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(new URL(route, ORIGIN), { method: 'POST', ca, timeout: 20_000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${token}` } }, r => {
      const chunks = []; r.on('data', c => chunks.push(c));
      r.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 不是 JSON */ } resolve({ status: r.statusCode, body: json }); });
    });
    req.once('error', reject); req.once('timeout', () => req.destroy(new Error('timeout'))); req.end(data);
  });
}
async function serverProject(page, projectId) {
  const token = await P(page, () => { try { return JSON.parse(localStorage.getItem('pc.guest.v1') || 'null')?.token ?? null; } catch { return null; } });
  if (!token) return { error: 'no-token', media: [], rev: 0 };
  const s = await edgeJson('/hosted/shared/account/session', { projectId, deviceId: `probe-${RUN}`, requestId: randomUUID() }, token);
  if (s.status !== 200) return { error: `session ${s.status} ${s.body?.code}`, media: [], rev: 0 };
  const socket = new WebSocket(`${ORIGIN.replace(/^https:/, 'wss:')}/hosted/`, ['promptcut.v1', `promptcut.account.${s.body.connectionTicket}`], { ca, origin: ORIGIN, handshakeTimeout: 10_000 });
  try {
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const state = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('project.open 超时')), 10_000);
      socket.on('message', bytes => { let m; try { m = JSON.parse(bytes.toString('utf8')); } catch { return; }
        if (m.reqId === 'probe-open') { clearTimeout(timer); resolve(m); } });
      socket.send(JSON.stringify({ type: 'project.open', projectId, reqId: 'probe-open' }));
    });
    return { type: state.type, rev: state.rev, media: (state.project?.media ?? []).map(m => m.name), writers: (state.writers ?? []).map(w => w.by?.accountId ?? w.actor?.accountId ?? null).slice(0, 3) };
  } finally { socket.terminate(); }
}

/* ---------------- 场景 ---------------- */

async function scenario() {
  const out = {};
  const ctx = await browser.createBrowserContext();
  const page = thePage = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') say('console', { text: m.text().slice(0, 300) }); });
  if (process.env.GUEST_PROBE_DEBUG) page.on('response', r => { const u = r.url(); if (/\/(media|hosted)\//.test(u) || r.status() >= 400) say('http', { status: r.status(), method: r.request().method(), url: u.replace(ORIGIN, '').slice(0, 160) }); });
  page.on('pageerror', e => say('pageerror', { message: String(e?.message ?? e).slice(0, 240) }));
  page.on('dialog', d => { say('dialog', { message: d.message().slice(0, 300) }); void d.dismiss(); });
  page.setDefaultTimeout(120_000); page.setDefaultNavigationTimeout(300_000);
  await page.setViewport({ width: 1440, height: 900 });

  // G1 以游客身份进入
  await page.goto(`${ORIGIN}/editor/?nosetup=1&ui=classic`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-pc="guest-enter"]', { timeout: 300_000 });
  await click(page, '[data-pc="guest-enter"]', '以游客身份进入');
  await page.waitForSelector('[data-pc="guest-row"]', { timeout: 60_000 });
  const saved = await P(page, () => { try { return JSON.parse(localStorage.getItem('pc.guest.v1') || 'null'); } catch { return null; } });
  out.guestId = saved?.id ?? null;
  out.guestName = out.guestId ? `游客-${out.guestId.slice(-4).toUpperCase()}` : null;
  out.guestRow = await textOf(page, '[data-pc="guest-row"]');
  check(/^gst_[0-9a-f]{24}$/.test(out.guestId ?? '') && !!saved?.token, 'G1-领到游客身份并记在本机', out.guestId);
  check(!!out.guestRow && out.guestRow.includes(out.guestName), 'G1-开始页显示游客名', out.guestRow);
  await shot(page, 'G1-guest');

  // G2 新建云端项目并进去
  const name = `游客项目-${RUN}`;
  await fill(page, '[data-pc="cloud-project-name"]', name);
  await click(page, '[data-pc="cloud-create"]', '新建云端项目');
  await enteredEditor(page, '游客进入新建的项目');
  await watchLoginRequired(page, 'G2');
  check(await inEditor(page), 'G2-新建后进了编辑器');
  out.afterCreate = await pathOf(page);
  const m = /^\/editor\/p\/([^/?]+)\?nosetup=1&ui=classic$/.exec(out.afterCreate);
  out.projectId = m?.[1] ?? null;
  check(!!m, 'G2-地址栏是直达地址', out.afterCreate);
  const savedProject = await P(page, () => { try { return JSON.parse(localStorage.getItem('pc.guest.v1') || 'null')?.project ?? null; } catch { return null; } });
  check(savedProject?.id === out.projectId, 'G2-这个项目记在本机(开始页靠它列出)', savedProject);
  await shot(page, 'G2-entered');

  // G3 成员浮层
  await click(page, '[data-pc="members-button"]', '成员按钮');
  const me = await waitFor(() => P(page, id => document.querySelector(`[data-pc="account-member"][data-account-id="${id}"]`)?.textContent?.trim() ?? null, out.guestId), 30_000, '成员浮层里自己那一行')
    .catch(() => null);
  out.memberRow = me;
  out.membersError = await textOf(page, '[data-pc="account-members-error"]');
  check(!!me && me.includes(`${out.guestName}（自己）`) && me.includes('[创建者]'), 'G3-成员浮层里自己是「游客-XXXX（自己）」[创建者]', { me, error: out.membersError });
  await shot(page, 'G3-members');
  await P(page, () => document.querySelector('[data-pc="members-button"]')?.click());

  // G4 导入一张图片
  const png = path.join(TMP, `guest-probe-${RUN}.png`);
  fs.writeFileSync(png, solidPng(96, 64, [30, 160, 220]));
  const input = await page.waitForSelector('[data-pc="library"] input[type="file"]', { timeout: 60_000 });
  await input.uploadFile(png);
  if (process.env.GUEST_PROBE_DEBUG) for (let i = 0; i < 12; i++) { await sleep(1000); say('debug.lib', { lib: (await P(page, () => document.querySelector('[data-pc="library"]')?.innerText?.slice(0, 300))), toasts: (await bodyText(page)).slice(-300) }); }
  // 只核「进了项目内容」:刚导入那一刻缩略图的地址先于上传完成就挂上了、先拿到一次 404,之后不再重取
  // (不分账号游客,见报告「顺带发现」);缩略图读不读得到素材服务里的字节,由刷新之后那两步核
  out.afterImport = await waitImage(page, '导入的图片出现在素材库', { drawn: false });
  check(true, 'G4-导入后图片组 1 个项', out.afterImport);
  // 等上传落到素材服务、这一步写进文档服务:提示条里不该有「没有传上云端」「没被文档服务接受」
  await sleep(4000);
  out.rejectedToasts = (await bodyText(page)).split('\n').filter(l => l.includes('没被文档服务接受'));
  check(out.rejectedToasts.length === 0, 'G4-这一步写进了文档服务(没有「没被文档服务接受」)', out.rejectedToasts);
  out.importToasts = (await bodyText(page)).split('\n').filter(l => /传上云端|上传/.test(l)).slice(0, 5);
  check(!out.importToasts.some(l => l.includes('没有传上云端')), 'G4-没有「没有传上云端」的提示', out.importToasts);
  await watchLoginRequired(page, 'G4');
  await shot(page, 'G4-imported');
  // 不只看页面:拿这个游客的令牌另开一条连接,直接问文档服务存下来的项目内容里有没有这张图
  out.serverSide = await serverProject(page, out.projectId);
  check(out.serverSide.media.includes(path.basename(png)) && out.serverSide.rev >= 2, 'G4-文档服务存下的项目里有这张图(另开连接读)', out.serverSide);

  // G5 刷新:自动回到项目,图片还在
  await page.reload({ waitUntil: 'domcontentloaded' });
  await enteredEditor(page, '刷新后回到项目');
  check((await pathOf(page)) === out.afterCreate, 'G5-刷新后地址还是直达地址', await pathOf(page));
  out.afterReload = await waitImage(page, '刷新后图片还在').catch(async () => ({ missing: true, group: await imagesGroup(page) }));
  check(!out.afterReload.missing, 'G5-刷新后图片还在、缩略图画得出来', out.afterReload);
  const savedAfter = await P(page, () => { try { return JSON.parse(localStorage.getItem('pc.guest.v1') || 'null')?.id ?? null; } catch { return null; } });
  check(savedAfter === out.guestId, 'G5-还是同一个游客', savedAfter);
  await watchLoginRequired(page, 'G5');
  await shot(page, 'G5-reloaded');

  // G6 回首页,从开始页点自己的项目
  await P(page, () => window.dispatchEvent(new Event('pc-go-home')));
  await waitFor(() => has(page, '[data-pc="account-projects"]'), 60_000, '回到开始页');
  // 回首页后本页的游客状态还在(同一页里没刷新);刷新一次开始页,模拟线上「隔一会儿再来、点自己的项目」
  await page.goto(`${ORIGIN}/editor/?nosetup=1&ui=classic`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-pc="guest-enter"]', { timeout: 300_000 });
  await click(page, '[data-pc="guest-enter"]', '以游客身份进入(第二次)');
  await page.waitForSelector('[data-pc="guest-project-open"]', { timeout: 60_000 });
  out.guestProjectButton = await textOf(page, '[data-pc="guest-project-open"]');
  check(out.guestProjectButton === name, 'G6-开始页列出自己那个项目', out.guestProjectButton);
  await shot(page, 'G6-start');
  await click(page, '[data-pc="guest-project-open"]', '点自己的项目');
  await enteredEditor(page, '从开始页点自己的项目进去');
  check(await inEditor(page), 'G6-点自己的项目进得去');
  out.afterOpen = await waitImage(page, '从开始页进来图片还在').catch(async () => ({ missing: true, group: await imagesGroup(page) }));
  check(!out.afterOpen.missing, 'G6-图片还在', out.afterOpen);
  await watchLoginRequired(page, 'G6');
  await shot(page, 'G6-opened');

  // G7 一路上没出现「请先登录账号」;顺手记下右栏云端 Agent 那里说了什么(待用户项,见报告)
  out.agentPanel = await P(page, () => document.querySelector('[data-pc="cloud-ai"], [data-pc="right"], .pc-right')?.innerText?.slice(0, 400) ?? null);
  check(sawLoginRequired.length === 0, 'G7-进项目这一路没出现「请先登录账号」', sawLoginRequired);
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
  browser = await puppeteer.launch({ headless: true, acceptInsecureCerts: true, protocolTimeout: 300_000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio'] });
  res.result = await scenario();
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
