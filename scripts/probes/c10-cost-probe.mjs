/**
 * C10 其余第 3 节「低内存档的完整规则」的本机探针(分支 `claude/c10-cost`;语义 `mechanism/rendering.md`「低内存档」、
 * `mechanism/document-service.md`「成本记录」)。做法照 `c10a-demo-probe.mjs`(本机托管组合、nginx 形状的代理、创建者桌面版、手机仿真)。
 *
 *   node scripts/probes/c10-cost-probe.mjs [--dist <在线构建目录>] [--port 5670] [--proxy-port 5673] [--doc-port 5674] [--asset-port 5675]
 *        [--cards 16] [--timeout-min 25] [--keep-temp] [--out <目录>] [--debug-port 5677]
 *
 * 流程:
 *   1. 起本机托管组合(只绑 127.0.0.1)与代理(`/editor` 给在线构建,`/hosted/`、`/media/` 反代);不给 `--dist` 就现场 `vite build --mode online`;
 *   2. 创建者桌面版(dev server,临时数据目录,不当渲染节点):新建项目,放 `--cards` 张成本由参数定的卡(`probe-slow`,
 *      `burnMs` 从 0 递增到超过预算),等桌面加载遮罩下测完;项目设置里勾「多用户协作」放云端,取邀请链接;
 *   3. 等桌面版把成本记录转写进文档服务(`SharedCostRelay`),用 Node 侧的成员连接 `cost.list` 核对:本项目每张卡都有记录;
 *   4. 手机成员(Chrome 移动端仿真、`deviceMemory: 4`,判为低内存档)凭邀请链接加入,等界限搜索做完(`window.__pcLowMemSearch()`):
 *      - 取到了本项目的全部记录;测量次数 ≤ ⌈log₂(n + 1)⌉ + 4(约 log₂(n) + 2);
 *      - 判出轻重:实测过的按实测(× 成本倍率 > B 为重),没测的按界限;本机耗时单调时,判轻的卡正好是 `burnMs` 小的那一半;
 *      - 补渲只为判重又缺产物的层发(`window.__pcBackfill()` 的片段清单 ⊆ 判重的片段,不含任何判轻的片段);
 *      - 播放时判轻的卡同样抑制着、不活渲(显示用的表全部判重)。
 *   5. 收尾:以创建者身份删掉云端项目,结束自己起的进程,删临时目录。
 *
 * 注意:创建者的 dev server 跑在本工作区上,跑的期间不要改工作区里的文件(见 `c10a-demo-probe.mjs` 文件头)。
 * 不打印令牌、口令、邀请码原文。输出:过程写 stderr;stdout 最后一行是 `{ ok, fails, … }`,`ok` 为假时退出码 1。
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
const KEEP = argv.includes('--keep-temp');
const PORT = Number(arg('--port', 5670));
const PROXY_PORT = Number(arg('--proxy-port', 5673));
const DOC_PORT = Number(arg('--doc-port', 5674));
const ASSET_PORT = Number(arg('--asset-port', 5675));
const CARDS = Math.max(4, Number(arg('--cards', 16)));
const TIMEOUT_MS = Number(arg('--timeout-min', 25)) * 60_000;
const FPS = 30;
const B = (1000 / FPS) * 0.7;
const SLOW_CARD = 'probe-slow';
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const SITE = `http://127.0.0.1:${PROXY_PORT}`;
const HOSTED = `${SITE}/hosted/`;
const EDITOR = `${SITE}/editor`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-c10-cost-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'shots')));
fs.mkdirSync(OUT, { recursive: true });
const started = Date.now();
const deadline = started + TIMEOUT_MS;
/** 每张卡每帧烧掉的毫秒数:0 起,跨过预算 B(23.3 ms)到约 1.7 B */
const BURNS = Array.from({ length: CARDS }, (_, i) => Math.round((i * 40) / (CARDS - 1)));

const fails = [];
const out = { ok: false, run: RUN, site: SITE, out: OUT, cards: CARDS, burns: BURNS, budgetMs: Number(B.toFixed(2)), steps: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 600)}`)); return !!cond; };
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

/* ================================================================== 本机托管组合 + 代理(同 c10a-demo-probe) */

let combo = null;
let proxy = null;
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
  const isHosted = (p) => p === '/hosted' || p.startsWith('/hosted/');
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
async function startEditor() {
  for (const p of [PORT, PORT + 1, PORT + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  const dir = path.join(TMP, 'editor');
  const tmp = path.join(dir, 'tmp');
  for (const d of [tmp, path.join(dir, 'data'), path.join(dir, 'card-overrides'), path.join(dir, 'projects'), path.join(dir, 'work')]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env };
  for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_NODE_PROFILE', 'PROMPTCUT_HOST_MAX_CONCURRENT', 'PROMPTCUT_TEST_CODE_VERSION',
    'PROMPTCUT_PUSH', 'PROMPTCUT_HEADLESS', 'PROMPTCUT_ROLE', 'PROMPTCUT_ASSET_URL', 'PROMPTCUT_CARD_SYNC', 'PROMPTCUT_LAN_HOST', 'VITE_PC_ONLINE', 'PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_SHARED_CONFIG']) delete env[key];
  Object.assign(env, {
    PROMPTCUT_EXPORT_DIR: dir, PROMPTCUT_DATA_DIR: path.join(dir, 'data'), PROMPTCUT_CARD_OVERRIDES: path.join(dir, 'card-overrides'),
    PROMPTCUT_PROJECTS_DIR: path.join(dir, 'projects'), PROMPTCUT_WORK_DIR: path.join(dir, 'work'), PROMPTCUT_STREAMS: '0', TEMP: tmp, TMP: tmp, TMPDIR: tmp,
    PROMPTCUT_DEVICE_ID: `c10cost-a-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'c10-cost 创建者',
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

/* ================================================================== Node 侧的成员连接(核对文档服务里的记录) */

async function mods() {
  const [route, client, shared, ws] = await Promise.all([
    import('../../server/auth/route.mjs'), import('../../server/auth/client.mjs'), import('../../server/auth/shared-config.mjs'),
    import('../../server/render-node/ws-transport.mjs'),
  ]);
  return { ...client, ...route, ...shared, ...ws };
}
async function openRpc(M, { url, projectId, username, password, as }) {
  const entry = M.normalizeEntry({ url, projectId, username, password, as, role: 'page', deviceId: `c10cost-chk-${randomBytes(6).toString('hex')}`, deviceName: 'c10-cost-probe 核对' });
  const ep = M.createWsEndpoint({ url: entry.url, protocols: M.sharedProtocols(entry, { role: 'page' }), log: () => {} });
  const opened = await new Promise((resolve) => {
    if (ep.connected) return resolve(true);
    const t = setTimeout(() => resolve(false), 20_000);
    ep.onOpen(() => { clearTimeout(t); resolve(true); });
  });
  if (!opened) { try { ep.close(); } catch { /* 没连上 */ } throw new Error('核对连接连不上文档服务'); }
  const waiting = new Map();
  let seq = 0;
  ep.onMessage((m) => {
    const w = m?.reqId !== undefined ? waiting.get(m.reqId) : undefined;
    if (!w) return;
    waiting.delete(m.reqId);
    clearTimeout(w.timer);
    w.resolve(m);
  });
  const rpc = (message, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const reqId = `cost-${++seq}`;
    const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error(`等 ${message.type} 的回包超时`)); }, timeoutMs);
    waiting.set(reqId, { resolve, timer });
    if (!ep.send({ ...message, reqId })) { waiting.delete(reqId); clearTimeout(timer); reject(new Error(`${message.type} 没发出去`)); }
  });
  return { rpc, close: () => { try { ep.close(); } catch { /* 已关 */ } } };
}
async function adminDelete(M, projectId, creator) {
  const protocols = await M.buildAuthProtocols({ base: HOSTED, projectId, username: creator.username, deviceId: `c10cost-admin-${RUN}`.padEnd(16, '0'), deviceName: 'c10-cost admin', as: 'creator', password: creator.password, role: 'page' });
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
  return r;
}

/* ================================================================== 页面 */

let browser = null;
async function launchBrowser() {
  const { default: puppeteer } = await import('puppeteer');
  return puppeteer.launch({
    headless: true, protocolTimeout: 900_000, defaultViewport: { width: 1440, height: 900 },
    args: [...(arg('--debug-port', null) ? [`--remote-debugging-port=${arg('--debug-port', null)}`] : []), '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'],
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
async function newPage({ mobile = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.pageErrors = [];
  page.on('pageerror', (e) => page.pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  if (mobile) {
    await page.emulate({
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
      viewport: { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false },
    });
    await page.evaluateOnNewDocument(() => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 4 }); });
  }
  page.close$ = () => ctx.close();
  return page;
}

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
        small: !!w.querySelector(':scope > [data-pc-snapshot-plane] img[data-pc-small-snapshot]'),
        placeholder: !!slot && !slot.hidden,
        unsupported: !!w.querySelector(':scope > [data-pc-placeholder-fixed]'),
      };
    });
    return { playing: !!d.beatRunning, wraps, lowMemLive: d.lowMemLive ?? [] };
  }).catch(() => null);
}

/* ================================================================== 主流程 */

const state = {};
let M = null;
let check$ = null;
try {
  M = await mods();
  await startLocalSite();
  const health = await getJson(`${SITE}/hosted/healthz`).catch((e) => ({ error: String(e?.message ?? e) }));
  if (!check(health?.ok, '托管端 /hosted/healthz', health)) throw new Error('托管端不通');

  /* ---------------------------------------------------------------- 2. 创建者桌面版:放卡、测、放云端 */
  const t2 = Date.now();
  await startEditor();
  await until('预渲染进程就绪', async () => { const i = await prerenderInfo(); return i?.ready && i.url ? i.url : null; }, 240_000, 500);
  browser = await launchBrowser();
  const creator = await newPage();
  state.creator = creator;
  await creator.goto(`${editor.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await until('创建者页面舞台起来、测量遮罩退下', () => P(creator, () => document.querySelectorAll('iframe').length >= 2 && !document.querySelector('[data-pc="probe-gate"]')), 300_000, 500);
  await P(creator, () => { for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click(); });
  const projName = `c10成本-${RUN}`;
  state.clips = await P(creator, async (spec) => {
    const S = await import('/src/store/project.ts');
    S.actions.newProject(spec.name);
    const ids = [];
    spec.burns.forEach((burn, i) => {
      const c = S.actions.addClipOnNewTrack({ index: 0, cardId: spec.card, start: 0, duration: 2 });
      if (c) { S.actions.setClipParams(c.id, { burnMs: burn, label: `b${burn}-${i}` }); ids.push({ id: c.id, burn }); }
    });
    S.actions.seek(0);
    return ids;
  }, { name: projName, card: SLOW_CARD, burns: BURNS });
  check(state.clips.length === CARDS, `放上 ${CARDS} 张 probe-slow`, state.clips.length);
  // 桌面版测完每张卡:本机成本记录里有项目里每个片段的卡片身份(探针在后台舞台补测新卡,不挡界面)
  await until('创建者页面把每张卡都测完', () => P(creator, async () => {
    const S = await import('/src/store/project.ts');
    const I = await import('/src/editor/costIdentity.ts');
    const D = await import('/src/editor/planDispatch.ts');
    const keys = Object.values(I.clipIdentityOf(S.getState().project).identityKeys);
    const have = new Set(D.currentCosts().filter((r) => Number.isFinite(r.stepMs)).map((r) => r.identityKey));
    return keys.length > 0 && keys.every((k) => have.has(k));
  }), 600_000, 500);
  const desk = await P(creator, async () => {
    const S = await import('/src/store/project.ts');
    const I = await import('/src/editor/costIdentity.ts');
    const D = await import('/src/editor/planDispatch.ts');
    const keys = I.clipIdentityOf(S.getState().project).identityKeys;
    return { keys, costs: D.currentCosts().map((r) => ({ identityKey: r.identityKey, stepMs: r.stepMs, device: r.device.slice(0, 40) })) };
  });
  state.keyOfClip = desk.keys;
  const deskByKey = new Map(desk.costs.map((r) => [r.identityKey, r.stepMs]));
  check(state.clips.every((c) => deskByKey.has(desk.keys[c.id])), '桌面版测完每张卡', { measured: state.clips.filter((c) => deskByKey.has(desk.keys[c.id])).length });
  // 放云端
  await P(creator, () => window.dispatchEvent(new Event('pc-open-project-settings')));
  await creator.waitForSelector('[data-pc="collab-section"]', { visible: true, timeout: 20_000 });
  await creator.click('[data-pc="collab-toggle"]');
  await creator.waitForSelector('[data-pc="collab-where-hosted"]', { visible: true });
  state.creatorCred = { username: await creator.$eval('#pc-collab-creator', (i) => i.value), password: await creator.$eval('#pc-collab-cpw', (i) => i.value) };
  await creator.click('[data-pc="collab-where-hosted"]');
  await typeInto(creator, '[data-pc="collab-hosted-url"]', HOSTED);
  await creator.click('.pc-dialog-foot .pc-btn--primary');
  const enabled = await until('放云端开启完成', async () => { const t = await textOf(creator, '[data-pc="collab-status"]'); return t && !t.includes('正在设置') ? t : null; }, 90_000, 300);
  check(enabled?.includes('多用户协作已开启。'), '项目设置里开启「多用户协作」放云端', { status: enabled });
  await creator.waitForSelector('[data-pc="collab-invite-link"]', { timeout: 20_000 });
  state.link = (await textOf(creator, '[data-pc="collab-invite-link"]')).trim();
  await creator.keyboard.press('Escape');
  state.projectId = (await M.lookupProject({ base: HOSTED, name: projName })).projectId;
  out.steps.desktop = { ms: Date.now() - t2, clips: state.clips.length, measured: desk.costs.length,
    deskStepMs: state.clips.map((c) => ({ burn: c.burn, stepMs: deskByKey.get(desk.keys[c.id]) ?? null })) };
  say('step2.done', out.steps.desktop);

  /* ---------------------------------------------------------------- 3. 桌面版把成本记录转写进文档服务 */
  const t3 = Date.now();
  check$ = await openRpc(M, { url: M.wsBaseOf(HOSTED), projectId: state.projectId, username: state.creatorCred.username, password: state.creatorCred.password, as: 'creator' });
  const wantKeys = new Set(state.clips.map((c) => desk.keys[c.id]));
  const listed = await until('文档服务里有本项目每张卡的成本记录', async () => {
    const r = await check$.rpc({ type: 'cost.list', projectId: state.projectId });
    if (r?.type !== 'cost.listing') return null;
    const have = new Set(r.records.map((x) => x.identityKey));
    return [...wantKeys].every((k) => have.has(k)) ? r : null;
  }, 60_000, 1000);
  const relay = await P(creator, () => window.__pcSharedCosts?.() ?? null);
  check(listed, '桌面版连着共享项目时把成本记录转写进文档服务', relay);
  if (listed) {
    const byKey = new Map(listed.records.map((r) => [r.identityKey, r]));
    check(state.clips.every((c) => Math.abs((byKey.get(desk.keys[c.id])?.stepMs ?? -1) - deskByKey.get(desk.keys[c.id])) < 1e-6), '文档服务里的单帧耗时与桌面版测的相同');
    check(listed.records.every((r) => /^[0-9a-f]{16}$/.test(r.envFingerprint) && r.samples >= 1 && r.mode === 'dev'), '记录带环境指纹、采样帧数、构建模式(桌面版是 dev)', listed.records.slice(0, 2));
  }
  out.steps.docservice = { ms: Date.now() - t3, records: listed?.records.length ?? 0, envFingerprints: [...new Set((listed?.records ?? []).map((r) => r.envFingerprint))], relay };
  say('step3.done', out.steps.docservice);

  /* ---------------------------------------------------------------- 4. 手机:低内存档的界限搜索 */
  const t4 = Date.now();
  const phone = await newPage({ mobile: true });
  state.phone = phone;
  await phone.goto(`${EDITOR}#invite=${codeOf(state.link)}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await phone.waitForSelector('[data-pc="join-invite-project"]', { visible: true, timeout: 60_000 });
  await typeInto(phone, '[data-pc="join-username"]', '手机成员');
  await phone.click('[data-pc="join-submit"]');
  const joined = await phone.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 90_000 }).then(() => true, () => false);
  if (!check(joined, '手机凭邀请链接进入')) throw new Error('手机没进去');
  const lowToast = await until('手机判为低内存档', () => P(phone, () => document.body.innerText.includes('当前是低内存档')), 30_000, 300);
  check(lowToast, '手机判为低内存档(进入提示)');
  // 遮罩:搜索真要测时出现
  let gateSeen = false;
  const s = await until('手机的界限搜索做完', async () => {
    if (!gateSeen) gateSeen = await P(phone, () => !!document.querySelector('[data-pc="lowmem-gate"]')).catch(() => false);
    return P(phone, () => { const d = window.__pcLowMemSearch?.(); return d?.outcome ? d : null; });
  }, 300_000, 250);
  await shot(phone, '4-phone-after-search');
  if (!s) throw new Error('手机的界限搜索没做完');
  const o = s.outcome;
  const n = o.order.length;
  const bound = Math.ceil(Math.log2(n + 1)) + 2 + 2;
  check(o.records >= CARDS, '手机取到了本项目的成本记录', { records: o.records });
  check(n === CARDS && o.unrecorded.length === 0, '每张卡都有代表耗时(卡片身份在桌面 dev 与在线构建里相同)', { order: n, unrecorded: o.unrecorded.length });
  check(o.measurements <= bound, `测量次数 ≤ ⌈log₂(n+1)⌉ + 4 = ${bound}`, { measurements: o.measurements, n, approx: Number((Math.log2(n) + 2).toFixed(2)) });
  check(o.measurements >= 1, '真的在手机舞台里测了', o.measurements);
  const measured = o.trace.filter((x) => !x.cached);
  check(measured.every((x) => x.ms === null || typeof x.ms === 'number'), '测量记录形状');
  // 判定:实测过的按实测;其余按界限。本机耗时随 burnMs 单调时,判轻的就是 order 里界限以前的
  const keyLight = new Set(o.light);
  const inconsistent = measured.filter((x) => x.ms !== null && ((x.ms > o.budgetMs) === keyLight.has(x.key)));
  check(inconsistent.length === 0, '实测过的卡按实测判(单帧耗时 > B 为重)', inconsistent);
  const byBurn = state.clips.map((c) => ({ burn: c.burn, light: keyLight.has(desk.keys[c.id]) })).sort((a, b) => a.burn - b.burn);
  const firstHeavy = byBurn.findIndex((x) => !x.light);
  const monotone = firstHeavy < 0 || byBurn.slice(firstHeavy).every((x) => !x.light);
  check(monotone, '判轻的卡是 burnMs 小的那一段、判重的是大的那一段', byBurn);
  check(o.light.length > 0 && o.heavy.length > 0, '既有判轻也有判重', { light: o.light.length, heavy: o.heavy.length });
  // 补渲:只为判重又缺产物的层(没有渲染节点,判重的层都缺)
  const heavyClips = new Set(s.judgedHeavyClips);
  const lightClips = state.clips.filter((c) => keyLight.has(desk.keys[c.id])).map((c) => c.id);
  const bf = await until('手机为判重又缺产物的层发补渲', () => P(phone, () => { const d = window.__pcBackfill?.(); const hit = d?.log?.find((e) => !e.error); return hit ? { id: hit.id, clips: hit.clips, log: d.log.length } : null; }), 30_000, 500);
  check(bf && bf.clips.length > 0 && bf.clips.every((id) => heavyClips.has(id)), '补渲的片段清单都是判重的片段', { clips: bf?.clips?.length, heavy: heavyClips.size });
  check(bf && lightClips.every((id) => !bf.clips.includes(id)), '判轻的卡不发补渲', { light: lightClips.length });
  check(bf && [...heavyClips].every((id) => bf.clips.includes(id)), '判重又缺产物的层都进了补渲清单', { missing: [...heavyClips].filter((id) => !bf?.clips?.includes(id)).length });
  // 播放:判轻的卡同样抑制着,不活渲(显示用的表全部判重)
  await P(phone, () => { const st = window.__pcStore; st.actions.seek(0); st.actions.play(); });
  const samples = [];
  for (let i = 0; i < 5; i++) { await delay(400); samples.push(await stageSample(phone)); }
  await P(phone, () => window.__pcStore.actions.pause());
  const playing = samples.filter((x) => x?.playing);
  const lightSet = new Set(lightClips);
  check(playing.length >= 2, '手机播放中采到舞台的样子', { samples: samples.length, playing: playing.length });
  check(playing.every((x) => x.wraps.length > 0 && x.wraps.every((w) => w.suppressed) && x.lowMemLive.length === 0),
    '手机播放中:判轻的卡也抑制着、不活渲(没有产物就占位)', playing.map((x) => x.wraps.map((w) => `${lightSet.has(w.id) ? 'L' : 'H'}:${w.suppressed ? 'S' : 'live'}${w.placeholder ? '+ph' : ''}`)).slice(0, 2));
  check(playing.every((x) => x.wraps.every((w) => w.small || w.placeholder || w.unsupported)), '手机播放中:每一层要么贴小尺寸、要么占位(不透明)');
  const stageSampleOut = playing[0] ? { wraps: playing[0].wraps.length, light: playing[0].wraps.filter((w) => lightSet.has(w.id)).length } : null;
  out.steps.phone = {
    ms: Date.now() - t4, gateSeen, envFingerprint: o.envFingerprint, n, measurements: o.measurements, searchMeasurements: o.searchMeasurements, bound,
    approxLog2Plus2: Number((Math.log2(n) + 2).toFixed(2)), boundary: o.boundary, threshold: o.threshold, elapsedMs: o.elapsedMs,
    trace: o.trace.map((x) => ({ i: x.index, ms: x.ms === null ? null : Number(x.ms.toFixed(2)), cached: x.cached })),
    byBurn, backfill: bf ? { clips: bf.clips.length, id: bf.id.slice(0, 48) } : null, playing: playing.length, stageSample: stageSampleOut,
    pageErrors: phone.pageErrors.slice(0, 5),
  };
  say('step4.done', out.steps.phone);
} catch (e) {
  fails.push(`探针异常:${String(e?.stack ?? e).slice(0, 1200)}`);
  for (const [name, page] of [['creator', state.creator], ['phone', state.phone]]) if (page) await shot(page, `fatal-${name}`);
} finally {
  const t5 = Date.now();
  let deleted = null;
  try { check$?.close(); } catch { /* 已关 */ }
  if (M && state.projectId && state.creatorCred) {
    const r = await adminDelete(M, state.projectId, state.creatorCred).catch((e) => ({ type: 'error', reason: String(e?.message ?? e) }));
    deleted = r?.type ?? null;
    check(r?.type === 'shared.admin.ok', '收尾:删掉云端项目', r);
  }
  try { await browser?.close(); } catch { /* 已关 */ }
  try { fs.writeFileSync(path.join(OUT, 'creator-editor.log'), editorLog.join('\n')); } catch { /* 写不了 */ }
  if (editor?.child?.pid) {
    const pre = await prerenderInfo().catch(() => null);
    killTree(editor.child.pid);
    const prePort = pre?.url ? Number(new URL(pre.url).port) : null;
    if (prePort) { const pid = pidOnPort(prePort); if (pid) killTree(pid); }
    for (const p of [PORT, PORT + 1, PORT + 2]) { const pid = pidOnPort(p); if (pid) killTree(pid); }
  }
  if (proxy) await new Promise((r) => { proxy.close(() => r()); proxy.closeAllConnections?.(); });
  try { await combo?.close(); } catch { /* 已关 */ }
  out.steps.cleanup = { ms: Date.now() - t5, deleted };
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
