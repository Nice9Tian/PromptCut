/**
 * C10a「加入别人的项目」与「多用户协作」的端到端探针（`c10a-web` 分支；契约 `docs/plan/c10a-contract.md` 第 2～7 节）。
 * 全程在本机：本机起的托管组合代替阿里云，一个小代理代替 nginx，绝不连真正的托管端。
 *
 * 用法（端口都在 c10a-web 的段 5630～5639 里）：
 *   npx vite build --mode online --outDir <目录>        先出在线构建
 *   node scripts/probes/online-join-probe.mjs --dist <在线构建目录> --out <截图目录> [--desktop-port 5630] [--proxy-port 5633]
 *        [--doc-port 5634] [--asset-port 5635] [--phases create,online,desktop,regen,cancel]
 *
 * 起的东西（都由本探针起、跑完关掉）：
 * - 托管组合（`server/hosted/combo.mjs`，同一进程）：文档服务 --doc-port、素材服务 --asset-port，数据目录在系统临时目录；
 *   `docPublicUrl = ws://127.0.0.1:<代理>/hosted/`（邀请链接的源就是代理），`assetPublicUrl = http://127.0.0.1:<代理>/media/api/asset`；
 * - 代理（代替 nginx，契约第 2 节的路由）：`/editor` 系列给在线构建（`index.html` no-store、`assets/` immutable、深路由回落），
 *   `/hosted/…` → 文档服务（含 WebSocket 升级，去掉前缀），`/media/…` → 素材服务（去掉前缀）；
 * - 桌面编辑器：本 worktree 的 `vite --port <desktop-port> --strictPort`（舞台端口 +1、+2），数据目录临时，`PROMPTCUT_PUSH=0`。
 *
 * 阶段：
 * - create：桌面版创建者在项目设置里勾「多用户协作」、选放云端、确定 → 邀请链接与二维码（截图）；链接的源是代理；
 * - online：在线构建（手机视口）四条路：凭邀请链接只填用户名、手填自由进入、「我是创建者」、粘贴邀请链接；另有错误口径
 *   （密码错、找不到项目）；限定进入的手填与凭链接；全程网络记录里没有 `/api/` 请求（守卫与请求记录两条）；
 * - desktop：桌面版开始页的同一组件：手填、「我是创建者」、粘贴邀请链接三条；
 * - regen：创建者「作废并重新生成邀请码」（当场输创建者密码）→ 旧链接在在线页面上给「已失效」口径，新链接能进；
 * - cancel：创建者取消勾选 → 拉回本机、删掉云端项目（托管端 lookup 回 404），编辑器回到本机空间。
 * 本机信任：环境变量 PROMPTCUT_TRUST_LOOPBACK=0 时托管组合关掉本机信任（同阿里云的部署），集群令牌取 PROMPTCUT_CLUSTER_TOKEN、
 * 没给就现场生成（HT-a）。
 * 结果：每项一行 JSON `{ check, ok, … }`，最后一行 `{ summary }`；有失败退出码 1。截图写进 --out。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import {
  createSharedProject, buildAuthProtocols, requestChallenge, deriveKey, adminProof, lookupProject, resolveInvite,
} from '../../server/auth/client.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'c10a-web-shots')));
const DESKTOP_PORT = Number(arg('--desktop-port', 5630));
const PROXY_PORT = Number(arg('--proxy-port', 5633));
const DOC_PORT = Number(arg('--doc-port', 5634));
const ASSET_PORT = Number(arg('--asset-port', 5635));
const PHASES = new Set(arg('--phases', 'create,online,desktop,regen,cancel').split(','));
/**
 * `--with-video`(c10a-integ 补):创建者开启前先导一段带声音的视频;开启后等它的原尺寸传到托管端素材服务;
 * 取消前把创建者本机内容库里的这一份删掉,取消后核对它从托管端拉回本机(字节与素材原尺寸相同)。
 */
const WITH_VIDEO = argv.includes('--with-video');
fs.mkdirSync(OUT, { recursive: true });

const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const DESKTOP = `http://127.0.0.1:${DESKTOP_PORT}`;
const DOC_DIRECT = `http://127.0.0.1:${DOC_PORT}`;

const results = [];
const check = (name, ok, extra = {}) => {
  const r = { check: name, ok: !!ok, ...extra };
  results.push(r);
  console.log(JSON.stringify(r));
  return !!ok;
};
const say = (step, fields = {}) => console.log(JSON.stringify({ step, ...fields }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15_000, what = '条件') {
  const t0 = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时${last instanceof Error ? `：${last.message}` : ''}`);
    await sleep(150);
  }
}

/* ------------------------------------------------------------------ 起服务 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c10a-web-hosted-'));
const editorData = fs.mkdtempSync(path.join(os.tmpdir(), 'c10a-web-editor-'));
const combo = await startHostedCombo({
  dataDir,
  docPort: DOC_PORT,
  assetPort: ASSET_PORT,
  host: '127.0.0.1',
  docPublicUrl: `ws://127.0.0.1:${PROXY_PORT}/hosted/`,
  assetPublicUrl: `${PROXY}/media/api/asset`,
  // 本机信任（HT-a，`docs/plan/http-transport-contract.md` 第 10 节）：设了 PROMPTCUT_TRUST_LOOPBACK=0 就按阿里云的样子关掉，
  // 这时必须有集群令牌：取 PROMPTCUT_CLUSTER_TOKEN，没给就现场生成一个（不打印）
  ...(process.env.PROMPTCUT_TRUST_LOOPBACK === '0'
    ? { trustLoopback: false, clusterToken: process.env.PROMPTCUT_CLUSTER_TOKEN || randomBytes(32).toString('base64url') }
    : {}),
  log: () => {},
});
say('hosted.up', { docPort: combo.docPort, assetPort: combo.assetPort, dataDir, trustLoopback: process.env.PROMPTCUT_TRUST_LOOPBACK !== '0' });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
const proxyLog = [];

/** 代替 nginx：契约第 2 节的 /editor 路由，/hosted、/media 反代并去掉前缀 */
function forward(req, res, port, strip) {
  const target = req.url.slice(strip.length) || '/';
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: target.startsWith('/') ? target : `/${target}`, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { res.statusCode = 502; res.end('bad gateway'); });
  req.pipe(up);
}
const proxy = http.createServer((req, res) => {
  const url = new URL(req.url, PROXY);
  proxyLog.push(`${req.method} ${url.pathname}`);
  if (url.pathname.startsWith('/hosted/')) return forward(req, res, DOC_PORT, '/hosted');
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
  const url = new URL(req.url, PROXY);
  if (!url.pathname.startsWith('/hosted/')) return socket.destroy();
  const target = url.pathname.slice('/hosted'.length) + url.search;
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
say('proxy.up', { url: PROXY, dist: DIST });

/** worktree 没有自己的 node_modules：按模块解析 vite，再回到包根找 bin */
function viteBin() {
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
let editorProc = null;
const editorLog = [];
if (PHASES.has('create') || PHASES.has('desktop') || PHASES.has('regen') || PHASES.has('cancel')) {
  // 产物目录(含本机素材内容库 out/media)也放进临时数据目录,不写 worktree 的 out/
  const env = { ...process.env, PROMPTCUT_PUSH: '0', PROMPTCUT_DATA_DIR: editorData, PROMPTCUT_EXPORT_DIR: path.join(editorData, 'out'), PROMPTCUT_DEVICE_ID: 'c10a-web-probe-desktop-01', PROMPTCUT_DEVICE_NAME: 'ProbeDesk' };
  delete env.PROMPTCUT_LAN_HOST;
  editorProc = spawn(process.execPath, [viteBin(), '--port', String(DESKTOP_PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  const keep = (c) => { editorLog.push(c.toString()); if (editorLog.length > 300) editorLog.shift(); };
  editorProc.stdout.on('data', keep);
  editorProc.stderr.on('data', keep);
  await waitFor(async () => {
    if (editorProc.exitCode !== null) throw new Error(`编辑器退出了：${editorLog.join('').slice(-600)}`);
    return fetch(`${DESKTOP}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 180_000, '桌面编辑器起来');
  say('desktop.up', { url: DESKTOP, pid: editorProc.pid, dataDir: editorData });
}

const browser = await puppeteer.launch({
  headless: true,
  defaultViewport: { width: 1440, height: 900 },
  args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'],
});

async function shutdown() {
  try { await browser.close(); } catch { /* 已关 */ }
  try { await combo.close(); } catch { /* 已关 */ }
  await new Promise((r) => { proxy.close(() => r()); proxy.closeAllConnections?.(); });
  if (editorProc && editorProc.exitCode === null && editorProc.pid) {
    const exited = new Promise((r) => editorProc.once('exit', r));
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(editorProc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else editorProc.kill('SIGKILL');
    await Promise.race([exited, sleep(10_000)]);
  }
  for (const d of [dataDir, editorData]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 句柄还没放 */ } }
}

/* ------------------------------------------------------------------ 页面工具 */

/** 新开一个独立的浏览器上下文（本地存储各自一份 = 各自一台设备）；在线页面用手机视口、记下全部请求 */
async function newPage({ mobile = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  if (mobile) await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36' });
  page.requests = [];
  page.on('request', (r) => page.requests.push(r.url()));
  page.consoleErrors = [];
  page.on('pageerror', (e) => page.consoleErrors.push(String(e?.message ?? e)));
  page.netErrors = [];
  page.on('response', (r) => { if (r.status() >= 400) page.netErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  page.on('requestfailed', (r) => page.netErrors.push(`failed ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.consoleLog = [];
  page.on('console', (m) => { page.consoleLog.push(`${m.type()}: ${m.text()}`); if (page.consoleLog.length > 200) page.consoleLog.shift(); });
  page.close$ = () => ctx.close();
  return page;
}
const apiRequests = (page) => page.requests.filter((u) => { try { return /^\/(editor\/)?api(\/|$)/.test(new URL(u).pathname); } catch { return false; } });
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).then(() => say('shot', { file: `${name}.png` }));
async function typeInto(page, sel, text) {
  await page.waitForSelector(sel, { visible: true, timeout: 15_000 });
  await page.click(sel);
  await page.$eval(sel, (el) => el.select());
  await page.keyboard.press('Backspace');
  if (text) await page.type(sel, text, { delay: 5 });
}
const textOf = (page, sel) => page.$eval(sel, (el) => el.textContent ?? '').catch(() => '');
const joinMessage = (page) => textOf(page, '[data-pc="join-message"]');
/** 等进了编辑器：顶栏的成员按钮出来（只有进了共享项目才有） */
const waitMembers = (page, ms = 60_000) => page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: ms });
async function waitMessage(page, want, ms = 20_000) {
  return waitFor(async () => {
    const t = await joinMessage(page);
    return t.includes(want) ? t : null;
  }, ms, `提示「${want}」`);
}

/** 凭证连接直接向托管端做一次创建者操作（探针自建的限定进入项目要一个邀请码） */
async function adminViaWs(base, projectId, creator, op, fields = {}) {
  const deviceId = 'c10a-web-probe-admin-01';
  const protocols = await buildAuthProtocols({ base, projectId, username: creator.username, deviceId, deviceName: 'probe-admin', as: 'creator', password: creator.password, role: 'page' });
  const ws = new WebSocket(base.replace(/^http/, 'ws'), protocols);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const ask = (msg) => new Promise((resolve) => {
    const reqId = `p${Math.random().toString(36).slice(2)}`;
    const on = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); }
    };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
  const ch = await ask({ type: 'shared.challenge' });
  const key = await deriveKey(creator.password, ch.salt, ch.kdf);
  const m = await adminProof({ key, projectId, username: creator.username, op, nonce: ch.nonce });
  const r = await ask({ type: 'shared.admin', op, proof: { nonce: ch.nonce, m }, ...fields });
  ws.close();
  return r;
}

/**
 * 桌面编辑器第一次开（数据目录是新的）会弹「选择 AI 助手的驱动方式」：与本探针无关，等它出来就点「关闭」。
 * 最多等 8 s；没出来就算了。
 */
async function dismissAiSetup(page) {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const closed = await page.evaluate(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"], .pc-dialog')].find((d) => /选择 AI 助手的驱动方式/.test(d.textContent ?? ''));
      if (!dlg) return false;
      const btn = [...dlg.querySelectorAll('button')].find((b) => b.textContent?.trim() === '关闭');
      btn?.click();
      return !!btn;
    });
    if (closed) { say('desktop.ai-setup-dismissed'); await sleep(300); return; }
    await sleep(250);
  }
}

/* ------------------------------------------------------------------ 阶段 */

const stamp = Date.now().toString(36);
const state = { name: `c10a探针-${stamp}`, link: null, creator: null, projectPassword: null, creatorPage: null };

async function phaseCreate() {
  const page = await newPage();
  state.creatorPage = page;
  await page.goto(`${DESKTOP}/?editor`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.querySelector('.pc-proj-menu, [data-pc="probe-gate"], header, .pc-topbar') || document.readyState === 'complete', { timeout: 60_000 });
  await dismissAiSetup(page);
  if (WITH_VIDEO) state.videos = [await importVideo(page, 'pre')];
  await page.evaluate(() => window.dispatchEvent(new Event('pc-open-project-settings')));
  await page.waitForSelector('[data-pc="collab-section"]', { visible: true, timeout: 20_000 });
  await typeInto(page, '#pc-proj-name', state.name);
  await page.click('[data-pc="collab-toggle"]');
  await page.waitForSelector('[data-pc="collab-where-hosted"]', { visible: true });
  check('create.defaults', await page.$eval('[data-pc="collab-where-lan"]', (b) => b.className.includes('--on')), { note: '缺省放本机' });
  const creatorName = await page.$eval('#pc-collab-creator', (i) => i.value);
  const cpw = await page.$eval('#pc-collab-cpw', (i) => i.value);
  const ppw = await page.$eval('#pc-collab-ppw', (i) => i.value);
  check('create.autogen', creatorName === 'ProbeDesk' && cpw.length === 16 && ppw.length === 16, { creatorName, cpwLen: cpw.length, ppwLen: ppw.length });
  await shot(page, 'create-0-defaults');
  await page.click('[data-pc="collab-where-hosted"]');
  await typeInto(page, '[data-pc="collab-hosted-url"]', DOC_DIRECT);
  state.creator = { username: creatorName, password: cpw };
  state.projectPassword = ppw;
  await page.click('.pc-dialog-foot .pc-btn--primary');
  const status = await waitFor(async () => {
    const t = await textOf(page, '[data-pc="collab-status"]');
    return t && !t.includes('正在设置') ? t : null;
  }, 40_000, '开启结果');
  if (!check('create.enabled', status.includes('多用户协作已开启。'), { status })) say('create.console', { log: page.consoleLog.slice(-25), net: page.netErrors.slice(-20) });
  if (WITH_VIDEO) {
    // 已在共享项目里再导一段(C6.6 的上传路径);开启前那一段看开启时有没有跟着传上去
    state.videos.push(await importVideo(page, 'post'));
    state.uploaded = await waitUploaded(page, state.videos);
  }
  const link = await page.waitForSelector('[data-pc="collab-invite-link"]', { timeout: 15_000 }).then(() => textOf(page, '[data-pc="collab-invite-link"]'));
  state.link = link.trim();
  check('create.link', state.link.startsWith(`${PROXY}/editor#invite=`) && /#invite=[A-Za-z0-9_-]{43}$/.test(state.link), { link: state.link.replace(/invite=.*/, 'invite=<43>') });
  const qr = await page.$eval('[data-pc="collab-qr"]', (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, svg: !!el.querySelector('svg') }; });
  check('create.qr', qr.svg && qr.w >= 240 && qr.h >= 240, qr);
  await page.waitForFunction(() => /有效期至/.test(document.querySelector('[data-pc="collab-invite-status"]')?.textContent ?? ''), { timeout: 10_000 }).catch(() => {});
  await shot(page, 'create-1-invite-qr');
  const found = await lookupProject({ base: DOC_DIRECT, name: state.name }).catch((e) => ({ error: e.status }));
  check('create.hosted-has-project', !!found.projectId, found);
  state.projectId = found.projectId;
  const byInvite = await resolveInvite({ base: DOC_DIRECT, code: state.link.split('invite=')[1] }).catch((e) => ({ error: e.status }));
  check('create.invite-resolves', byInvite.projectId === found.projectId, byInvite);
  await page.keyboard.press('Escape');
}

/** 在线页面的一次加入：`setup(page)` 填表并点加入，之后等进编辑器；回 page */
async function onlineJoin(label, url, setup, { expectOk = true } = {}) {
  const page = await newPage({ mobile: true });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 30_000 });
  await setup(page);
  if (expectOk) {
    try {
      await waitMembers(page);
      check(`${label}.entered`, true);
    } catch (e) {
      check(`${label}.entered`, false, { error: String(e.message), message: await joinMessage(page), pageErrors: page.consoleErrors.slice(-5), console: page.consoleLog.filter((l) => /^error|^warn/.test(l)).slice(-8) });
    }
    await sleep(1500);
    await shot(page, `${label}`);
  }
  return page;
}

/** 创建者页面（桌面 dev server）store 里当前项目的片段数 */
const clipCount = (page) => page.evaluate(async () => {
  const S = await import('/src/store/project.ts');
  return (S.getState().project?.tracks ?? []).reduce((n, t) => n + (t.clips?.length ?? 0), 0);
});

/**
 * 演示路径(C10a 集成返工,主会话:在线页面不许露出被守卫拦下的 `/api` 报错):凭邀请链接进来之后
 * 观看(播放、暂停、拖动)、改一处片段、开导出;全程 `window.__pcApiBlocked` 为空,页面文字里没有 `/api/`。
 * 在线构建里没有源码模块可 import,用页面挂出来的 `window.__pcStore`(时间轴)与 `window.__pcIo`。
 */
async function onlineDemo(page) {
  const blockedNow = () => page.evaluate(() => [...(window.__pcApiBlocked ?? [])]);
  const apiText = () => page.evaluate(() => (document.body.innerText.match(/[^\n]*\/api\/[^\n]*/g) ?? []).slice(0, 5));
  await sleep(3000);
  await shot(page, 'demo-0-enter');
  const steps = {};
  steps.enter = await blockedNow();
  await page.evaluate(() => { const s = window.__pcStore; s.actions.seek(0); s.actions.play(); });
  await sleep(2500);
  await page.evaluate(() => window.__pcStore.actions.pause());
  const t = await page.evaluate(() => window.__pcStore.getState().t);
  check('demo.played', t > 1, { t });
  for (const sec of [3, 0.5, 5, 1.5]) { await page.evaluate((x) => window.__pcStore.actions.seek(x), sec); await sleep(300); }
  await sleep(1000);
  await shot(page, 'demo-1-watch');
  steps.watch = await blockedNow();
  const moved = await page.evaluate(() => {
    const s = window.__pcStore;
    // 改一处:把一张卡片的结尾收短 0.25 秒(修边不会和相邻片段撞,挨个试到改得动的那一张)
    for (const clip of s.getState().project.tracks.flatMap((tr) => tr.clips).filter((c) => c.cardId && c.end - c.start > 0.5)) {
      s.actions.moveClip(clip.id, { end: clip.end - 0.25 });
      const after = s.getState().project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === clip.id);
      if (after && Math.abs(after.end - clip.end) > 1e-6) return { id: clip.id, from: clip.end, to: after.end };
    }
    return null;
  });
  check('demo.edited', !!moved && Math.abs(moved.from - moved.to - 0.25) < 1e-6, moved);
  await sleep(2000);
  steps.edit = await blockedNow();
  const exporting = page.evaluate(async () => {
    try { await window.__pcIo.exportVideo({ onWaiting: (m) => { window.__pcDemoWaiting = m; } }); return 'done'; } catch (e) { return `error: ${String(e?.message ?? e).slice(0, 200)}`; }
  }).catch((e) => `page: ${String(e?.message ?? e).slice(0, 120)}`);
  await sleep(8000);
  await shot(page, 'demo-2-export');
  steps.export = await blockedNow();
  const waiting = await page.evaluate(() => window.__pcDemoWaiting ?? null);
  const result = await Promise.race([exporting, sleep(100).then(() => 'running')]);
  say('demo.export', { waiting, result });
  const text = await apiText();
  check('demo.no-api-blocked', Object.values(steps).every((b) => b.length === 0), steps);
  check('demo.no-api-text', text.length === 0, { text });
}

async function phaseOnline() {
  const clipsBefore = state.creatorPage ? await clipCount(state.creatorPage) : null;
  // 在线构建的静态检查：路由与缓存头（契约第 2、3 节核对项的本机版）
  const h1 = await fetch(`${PROXY}/editor`);
  const idx = await h1.text();
  const asset = /\/editor\/assets\/[^"]+\.js/.exec(idx)?.[0];
  const h2 = asset ? await fetch(`${PROXY}${asset}`) : null;
  const h3 = await fetch(`${PROXY}/editor/any/deep/route`);
  check('online.routes', h1.status === 200 && h1.headers.get('cache-control') === 'no-store' && h2?.status === 200 && /immutable/.test(h2.headers.get('cache-control') ?? '') && (await h3.text()) === idx,
    { editor: h1.status, asset: h2?.status, deep: h3.status });

  const code = state.link.split('invite=')[1];
  // 1. 凭邀请链接：只填用户名
  const p1 = await onlineJoin('online-1-invite', `${PROXY}/editor#invite=${code}`, async (page) => {
    await page.waitForSelector('[data-pc="join-invite-project"]', { visible: true, timeout: 15_000 });
    const hash = await page.evaluate(() => location.hash);
    check('online-1.hash-cleared', hash === '', { hash });
    const shown = await textOf(page, '[data-pc="join-invite-project"]');
    check('online-1.project-name', shown.includes(state.name), { shown });
    check('online-1.only-username', !(await page.$('[data-pc="join-password"]')) && !(await page.$('[data-pc="join-name"]')));
    await shot(page, 'online-1-invite-form');
    await typeInto(page, '[data-pc="join-username"]', '手机小王');
    await page.click('[data-pc="join-submit"]');
  });
  await onlineDemo(p1);
  // 2. 手填，自由进入
  const p2 = await onlineJoin('online-2-manual-free', `${PROXY}/editor`, async (page) => {
    await typeInto(page, '[data-pc="join-name"]', state.name);
    await typeInto(page, '[data-pc="join-username"]', '平板小李');
    await typeInto(page, '[data-pc="join-password"]', state.projectPassword);
    await page.click('[data-pc="join-submit"]');
  });
  // 3. 我是创建者
  const p3 = await onlineJoin('online-3-creator', `${PROXY}/editor`, async (page) => {
    await typeInto(page, '[data-pc="join-name"]', state.name);
    await page.click('[data-pc="join-as-creator"]');
    await typeInto(page, '[data-pc="join-username"]', state.creator.username);
    await typeInto(page, '[data-pc="join-password"]', state.creator.password);
    await page.click('[data-pc="join-submit"]');
  });
  // 4. 粘贴邀请链接
  const p4 = await onlineJoin('online-4-paste', `${PROXY}/editor`, async (page) => {
    await typeInto(page, '[data-pc="join-link"]', `快来：${state.link}`);
    await page.click('[data-pc="join-link-submit"]');
    await page.waitForSelector('[data-pc="join-invite-project"]', { visible: true, timeout: 15_000 });
    await typeInto(page, '[data-pc="join-username"]', '粘贴的人');
    await page.click('[data-pc="join-submit"]');
  });
  // 加入的人不往项目里塞演示卡（编辑器挂上时的开场填充）：创建者那边的片段数不变
  if (state.creatorPage) {
    await sleep(2000);
    const clipsAfter = await clipCount(state.creatorPage);
    check('online.joiners-add-nothing', clipsAfter === clipsBefore, { clipsBefore, clipsAfter });
  }
  // 创建者那边看到的成员数
  if (state.creatorPage) {
    const n = await state.creatorPage.evaluate(() => document.querySelector('[data-pc="members-button"]')?.textContent ?? '');
    check('online.creator-sees-members', /成员: [4-9] 人/.test(n), { members: n });
  }
  // 错误口径
  const e1 = await onlineJoin('online-err-password', `${PROXY}/editor`, async (page) => {
    await typeInto(page, '[data-pc="join-name"]', state.name);
    await typeInto(page, '[data-pc="join-username"]', '错密码的人');
    await typeInto(page, '[data-pc="join-password"]', 'not-the-password');
    await page.click('[data-pc="join-submit"]');
  }, { expectOk: false });
  check('online.err-auth', !!(await waitMessage(e1, '用户名或密码不对。忘了的话找创建者问一下。').catch(() => null)), { message: await joinMessage(e1) });
  await shot(e1, 'online-err-auth');
  await typeInto(e1, '[data-pc="join-name"]', `不存在的项目-${stamp}`);
  await e1.click('[data-pc="join-submit"]');
  check('online.err-no-project', !!(await waitMessage(e1, '找不到这个项目，检查一下项目名。').catch(() => null)), { message: await joinMessage(e1) });
  await typeInto(e1, '[data-pc="join-link"]', 'https://example.com/editor');
  await e1.click('[data-pc="join-link-submit"]');
  check('online.err-bad-link', !!(await waitMessage(e1, '这不是有效的邀请链接。').catch(() => null)), { message: await joinMessage(e1) });
  // 用户名规则照服务端（1～64 个字符、无控制字符、首尾无空白）：输入框限 64 个字符，首尾空白提交时去掉
  await typeInto(e1, '[data-pc="join-username"]', '长'.repeat(65));
  const typed = await e1.$eval('[data-pc="join-username"]', (i) => i.value.length);
  check('online.username-max-64', typed === 64, { typed });
  await typeInto(e1, '[data-pc="join-username"]', '');
  await e1.click('[data-pc="join-submit"]');
  check('online.err-need-username', !!(await waitMessage(e1, '请输入用户名').catch(() => null)), { message: await joinMessage(e1) });

  // 限定进入：探针直接在托管端建一个，再签一个邀请码
  const rname = `c10a限定-${stamp}`;
  const rcreator = { username: 'rboss', password: 'rboss-pw-123' };
  const made = await createSharedProject({ base: DOC_DIRECT, name: rname, mode: 'restricted', creator: rcreator, list: [{ username: 'bob', password: 'bob-pw-123' }] });
  const inv = await adminViaWs(`${DOC_DIRECT}/`, made.projectId, rcreator, 'invite-create');
  check('online.restricted-invite', inv.type === 'shared.admin.ok' && typeof inv.code === 'string', { type: inv.type, reason: inv.reason });
  const r1 = await onlineJoin('online-5-restricted-manual', `${PROXY}/editor`, async (page) => {
    await typeInto(page, '[data-pc="join-name"]', rname);
    await typeInto(page, '[data-pc="join-username"]', 'bob');
    await typeInto(page, '[data-pc="join-password"]', 'bob-pw-123');
    await page.click('[data-pc="join-submit"]');
  });
  const r2 = await onlineJoin('online-6-restricted-invite', `${PROXY}/editor#invite=${inv.code}`, async (page) => {
    await page.waitForSelector('[data-pc="join-invite-project"]', { visible: true, timeout: 15_000 });
    check('online-6.asks-list-password', !!(await page.$('[data-pc="join-password"]')) && !(await page.$('[data-pc="join-name"]')));
    await typeInto(page, '[data-pc="join-username"]', 'bob');
    await typeInto(page, '[data-pc="join-password"]', 'bob-pw-123');
    await page.click('[data-pc="join-submit"]');
  });

  // /api 守卫：网络记录里没有 /api/ 请求；守卫拦下的（编辑器里还没改走在线替代的调用）逐条列出
  const pages = [p1, p2, p3, p4, e1, r1, r2];
  const api = pages.flatMap(apiRequests);
  check('online.no-api-requests', api.length === 0, { count: api.length, sample: api.slice(0, 5) });
  const blocked = new Set();
  for (const p of pages) for (const b of await p.evaluate(() => window.__pcApiBlocked ?? [])) blocked.add(b);
  // 返工:这些入口在在线页面里已置灰或不发请求,守卫一条都不该拦到
  check('online.no-api-blocked', blocked.size === 0, { count: blocked.size, paths: [...blocked].sort() });
  const errors = pages.flatMap((p) => p.consoleErrors);
  say('online.page-errors', { count: errors.length, sample: [...new Set(errors)].slice(0, 8) });
  for (const p of pages) await p.close$();
}

async function phaseDesktop() {
  const clipsBefore = state.creatorPage ? await clipCount(state.creatorPage) : null;
  // 桌面版开始页：同一组件，三条都进得去
  const join = async (label, fill) => {
    const page = await newPage();
    await page.goto(`${DESKTOP}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
    if (label === 'desktop-1-manual') await shot(page, 'desktop-0-start-page');
    await fill(page);
    try {
      await waitMembers(page, 60_000);
      check(`${label}.entered`, true);
    } catch (e) {
      check(`${label}.entered`, false, { error: String(e.message), message: await joinMessage(page) });
    }
    await sleep(1500);
    await shot(page, label);
    await page.close$();
  };
  await join('desktop-1-manual', async (page) => {
    await page.click('::-p-text(服务器地址)');
    await typeInto(page, '#pc-join-server', DOC_DIRECT);
    await typeInto(page, '[data-pc="join-name"]', state.name);
    await typeInto(page, '[data-pc="join-username"]', '桌面同事');
    await typeInto(page, '[data-pc="join-password"]', state.projectPassword);
    await page.click('[data-pc="join-submit"]');
  });
  await join('desktop-2-creator', async (page) => {
    await page.click('::-p-text(服务器地址)');
    await typeInto(page, '#pc-join-server', DOC_DIRECT);
    await typeInto(page, '[data-pc="join-name"]', state.name);
    await page.click('[data-pc="join-as-creator"]');
    await typeInto(page, '[data-pc="join-username"]', state.creator.username);
    await typeInto(page, '[data-pc="join-password"]', state.creator.password);
    await page.click('[data-pc="join-submit"]');
  });
  await join('desktop-3-paste', async (page) => {
    await typeInto(page, '[data-pc="join-link"]', state.link);
    await page.click('[data-pc="join-link-submit"]');
    await page.waitForSelector('[data-pc="join-invite-project"]', { visible: true, timeout: 15_000 });
    await typeInto(page, '[data-pc="join-username"]', '桌面粘贴');
    await page.click('[data-pc="join-submit"]');
  });
  if (state.creatorPage) {
    await sleep(2000);
    const clipsAfter = await clipCount(state.creatorPage);
    check('desktop.joiners-add-nothing', clipsAfter === clipsBefore, { clipsBefore, clipsAfter });
  }
}

async function phaseRegen() {
  const page = state.creatorPage;
  const old = state.link;
  await page.evaluate(() => window.dispatchEvent(new Event('pc-open-project-settings')));
  await page.waitForSelector('[data-pc="collab-regen"]', { visible: true, timeout: 15_000 });
  page.once('dialog', (d) => { check('regen.confirm-text', d.message().includes('作废后，旧链接和旧二维码立刻失效（项目密码不受影响）。'), { text: d.message() }); void d.accept(); });
  await page.click('[data-pc="collab-regen"]');
  await typeInto(page, '[data-pc="collab-regen-password"]', state.creator.password);
  await page.click('[data-pc="collab-regen-confirm"]');
  await waitFor(async () => (await textOf(page, '[data-pc="collab-status"]')).includes('已生成新的邀请链接与二维码。'), 15_000, '重新生成');
  state.link = (await textOf(page, '[data-pc="collab-invite-link"]')).trim();
  check('regen.new-link', state.link !== old && /#invite=[A-Za-z0-9_-]{43}$/.test(state.link));
  await shot(page, 'regen-1-new-qr');
  await page.keyboard.press('Escape');
  // 旧链接：在线页面给「已失效」口径并退回完整表单
  const o = await newPage({ mobile: true });
  await o.goto(`${PROXY}/editor#invite=${old.split('invite=')[1]}`, { waitUntil: 'domcontentloaded' });
  await o.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 30_000 });
  const msg = await waitMessage(o, '这个邀请链接已失效，向创建者要一个新的，或手动填写项目信息。').catch(() => null);
  check('regen.old-link-refused', !!msg && !!(await o.$('[data-pc="join-name"]')), { message: await joinMessage(o) });
  await shot(o, 'regen-2-old-link');
  await o.close$();
  // 新链接能进
  const n = await onlineJoin('regen-3-new-link', `${PROXY}/editor#invite=${state.link.split('invite=')[1]}`, async (page) => {
    await page.waitForSelector('[data-pc="join-invite-project"]', { visible: true, timeout: 15_000 });
    await typeInto(page, '[data-pc="join-username"]', '新链接的人');
    await page.click('[data-pc="join-submit"]');
  });
  await n.close$();
}

/** 创建者本机内容库里有没有这些哈希(`GET /api/media/local`) */
const localHas = (page, hash) => page.evaluate(async (h) => ((await (await fetch(`/api/media/local?hashes=${h}`, { cache: 'no-store' })).json()).hashes ?? []).includes(h), hash);

/** 创建者本机内容库里这个哈希的文件(`out/media/<hash>.<ext>`),回路径或 null */
const localFile = (hash) => {
  const dir = path.join(editorData, 'out', 'media');
  const n = fs.existsSync(dir) ? fs.readdirSync(dir).find((x) => x.toLowerCase().startsWith(hash)) : null;
  return n ? path.join(dir, n) : null;
};
const sha256File = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/**
 * `--with-video`:ffmpeg 出一段 2 秒带声音的视频,经编辑器的导入接口导进创建者的项目。
 * `tag` 区分开启前导入的(pre)与开启后、已在共享项目里导入的(post)。回 `{ tag, hash }`。
 */
async function importVideo(page, tag) {
  const file = path.join(editorData, `probe-${tag}.mp4`);
  const ff = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-metadata', `comment=${stamp}-${tag}`, file], { windowsHide: true });
  if (ff.status !== 0) throw new Error(`ffmpeg 出样本失败:${String(ff.stderr).slice(-400)}`);
  const name = `probe-${tag}-${stamp}.mp4`;
  const got = await page.evaluate(async (b64, name) => {
    const { getState } = await import('/src/store/project.ts');
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const io = await import('/src/editor/io/index.ts');
    await io.importVideoFiles([new File([arr], name, { type: 'video/mp4' })]);
    const find = () => getState().project.media.find((x) => x.name === name);
    for (let i = 0; i < 150 && (!find() || find().pending || !find().hash); i++) await new Promise((r) => setTimeout(r, 200));
    const m = find();
    return m ? { hash: m.tiers?.original ?? m.hash, url: m.url } : null;
  }, fs.readFileSync(file).toString('base64'), name);
  const hash = got?.hash ?? '';
  const f = hash ? localFile(hash) : null;
  // 本机内容库按内容寻址:库里那一份的 sha256 就是它的哈希(导入可能重封装过,不和样本文件比)
  check(`video.${tag}.imported`, !!hash && !!f && sha256File(f) === hash, { got, file: f && path.basename(f) });
  return { tag, hash };
}

/** 开启之后:等视频原尺寸传到托管端素材服务;回传上去了的那些 */
async function waitUploaded(page, videos) {
  const up = [];
  for (const v of videos) {
    if (!v.hash) continue;
    const st = await waitFor(async () => (await combo.stores.media.stat(v.hash)) ?? null, 90_000, `${v.tag} 的原尺寸传到托管端`).catch((e) => ({ error: String(e.message) }));
    check(`video.${v.tag}.uploaded-to-hosted`, !st?.error, { hash: v.hash.slice(0, 12), stat: st });
    if (!st?.error) up.push(v);
  }
  const queue = await page.evaluate(async () => { try { return await (await fetch('/api/media/upload-queue', { cache: 'no-store' })).json(); } catch (e) { return { error: String(e) }; } });
  say('video.upload-queue', { queue: JSON.stringify(queue).slice(0, 800) });
  return up;
}

async function phaseCancel() {
  const page = state.creatorPage;
  const pull = WITH_VIDEO ? (state.uploaded ?? []) : [];
  for (const v of pull) {
    // 删掉创建者本机内容库里的这一份,好让「取消」真的要从托管端拉回来
    const f = localFile(v.hash);
    if (f) fs.rmSync(f, { force: true });
    check(`video.${v.tag}.local-removed`, !!f && !(await localHas(page, v.hash)), { removed: f && path.basename(f) });
  }
  await page.evaluate(() => window.dispatchEvent(new Event('pc-open-project-settings')));
  await page.waitForSelector('[data-pc="collab-toggle"]', { visible: true, timeout: 15_000 });
  await page.click('[data-pc="collab-toggle"]');
  page.once('dialog', (d) => { check('cancel.confirm-text', d.message().includes('取消后其他成员不能再进入。会先把项目内容和素材原尺寸拉回本机，确认取消？'), { text: d.message() }); void d.accept(); });
  await page.click('.pc-dialog-foot .pc-btn--primary');
  const status = await waitFor(async () => {
    const t = await textOf(page, '[data-pc="collab-status"]');
    return t && !t.includes('正在把项目内容拉回本机') ? t : null;
  }, 150_000, '取消结果');
  check('cancel.done', status.includes('多用户协作已关闭，内容已拉回本机。'), { status });
  await shot(page, 'cancel-1-done');
  const gone = await lookupProject({ base: DOC_DIRECT, name: state.name }).then(() => 200, (e) => e.status);
  check('cancel.hosted-deleted', gone === 404, { lookup: gone });
  const members = await page.$('[data-pc="members-button"]');
  check('cancel.back-to-local', !members);
  if (WITH_VIDEO) {
    const still = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().project.media.map((m) => m.tiers?.original ?? m.hash));
    for (const v of pull) {
      const f = localFile(v.hash);
      check(`video.${v.tag}.pulled-back`, (await localHas(page, v.hash)) && !!f && sha256File(f) === v.hash, { file: f && path.basename(f) });
      check(`video.${v.tag}.still-referenced`, still.includes(v.hash));
    }
    check('video.some-pulled', pull.length > 0, { pulled: pull.map((v) => v.tag) });
  }
}

/**
 * 静态检查（契约第 12 节「在线构建里没有 /api/ 请求」的静态那一条）：在线构建产物里还剩多少处 `/api/` 字面量。
 * 只报不判：剩下的在 c10a-web 的文件清单之外（见报告），运行时由守卫拦下、上面的请求记录判「一条都没发出去」。
 */
function staticScan() {
  const hits = new Map();
  const dir = path.join(DIST, 'assets');
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(js|mjs|css|html)$/.test(f)) continue;
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\/api\/[A-Za-z0-9_\-/]*/g)) hits.set(m[0], (hits.get(m[0]) ?? 0) + 1);
  }
  say('online.static-scan', { distinct: hits.size, total: [...hits.values()].reduce((a, b) => a + b, 0), paths: [...hits.keys()].sort() });
}

let fatal = null;
try {
  if (PHASES.has('online')) staticScan();
  if (PHASES.has('create')) await phaseCreate();
  if (PHASES.has('online')) await phaseOnline();
  if (PHASES.has('desktop')) await phaseDesktop();
  if (PHASES.has('regen')) await phaseRegen();
  if (PHASES.has('cancel')) await phaseCancel();
} catch (e) {
  fatal = String(e?.stack ?? e);
  check('probe.fatal', false, { error: fatal.slice(0, 1200) });
  if (state.creatorPage) say('creator.console', { log: state.creatorPage.consoleLog.slice(-30) });
  try { if (state.creatorPage) await shot(state.creatorPage, 'fatal-creator'); } catch { /* 页面没了 */ }
} finally {
  await shutdown();
}
const fails = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: { checks: results.length, ok: results.length - fails.length, fail: fails.length, fails: fails.map((f) => f.check), out: OUT } }));
process.exit(fails.length ? 1 : 0);
