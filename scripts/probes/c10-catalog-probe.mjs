/**
 * 在线浏览器模式里的内置 Lottie、粒子素材卡取得到 `/catalog/…`、画面不空白（C10 收尾：动效素材目录随在线构建部署）。
 *
 *   node scripts/probes/c10-catalog-probe.mjs [--dist <在线构建目录>] [--out <目录>] [--base-port 5850] [--no-catalog] [--keep-temp]
 *
 * 本机替身（与 `c10-browser-probe.mjs` 同形，与阿里云同形）：
 *   - 托管组合（文档服务 + 素材服务，只绑 127.0.0.1）；
 *   - 仿 nginx 的三个源：编辑器页（+0）与两个舞台（+1、+2）都给 `/editor`（在线构建）、`/hosted/`、`/media/` 反代，每个响应带 `Origin-Agent-Cluster: ?1`；
 *     **`/catalog/` 照托管端 nginx 片段的规则**：只放行 `/catalog/(lottie|particles)/<[A-Za-z0-9-]+>.json`，文件取在线构建的 `catalog/`，
 *     其余 `/catalog/…` 回 404；头同 `/editor`（Referrer-Policy、nosniff、OAC），缓存 `no-cache`。
 *     `--no-catalog`：不开 `/catalog/` 路由（重现修之前的线上：nginx 除 /editor、/media 外一律 404），用来对照；
 *   - 创建者 = 桌面版 dev server（端口 +5～+7；它自己起的预渲染进程用临时端口），建项目、放一张 Lottie 素材卡（`lottie-bodymovin`，src 是
 *     `/catalog/lottie/bodymovin.json`）与一张粒子卡（`particles`，config 填 `/catalog/particles/<名>.json`），勾「多用户协作」放云端、取邀请链接；
 *     创建者不当渲染节点：成员那边没有预渲染快照，画面只能活渲，活渲就要取 `/catalog/`；
 *   - 成员 = 电脑浏览器（普通档）打开邀请链接进入，停在两张卡各自的时间点上，等精确活渲。
 *
 * 判据（每项一行进结果行的 `checks`）：
 *   C1 桌面行为不变：创建者页（dev server 中间件）的 `/catalog/` 请求全 200，两张卡画面非空；
 *   C2 在线：成员页（含两个舞台 iframe）对 `/catalog/` 的请求全 200、两张卡的地址都取到了，且请求发自舞台源；
 *   C3 在线：停在 Lottie 卡上，可见舞台里 Lottie 的 svg 挂上了、截图非空；
 *   C4 在线：停在粒子卡上，可见舞台里粒子引擎装上了（tsParticles 生成的 canvas 在位 —— 配置取不到时引擎不装、没有 canvas），
 *      且 canvas 里非透明像素数与桌面（C1）相同。
 *
 * 已知（2f7f821 上，与 /catalog/ 无关）：粒子卡在编辑器预览里停住时 canvas 是空的 —— 桌面 dev server、有头 Chrome、简单参数（不填 config）
 * 同样如此，所以 C1、C4 不判「粒子画面非空」，只判引擎装上、与桌面一致；非空与否记在结果行的 steps.desktop.particlesInk 里。
 *   `--no-catalog` 时 C2～C4 预期不过（结果行 `expectFail: true`，退出码仍按判据）。
 *
 * 截图写进 --out（缺省临时目录下 shots/）：creator-lottie.png、creator-particles.png、member-lottie.png、member-particles.png（整页）与
 * member-lottie-stage.png、member-particles-stage.png（可见舞台 iframe）。不打印令牌、口令、邀请码原文。
 * 输出：过程写 stderr；stdout 最后一行一行 JSON `{ ok, fails, checks, catalogRequests, … }`。
 */
import { spawn, spawnSync } from 'node:child_process';
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
const NO_CATALOG = argv.includes('--no-catalog');
const BASE = Number(arg('--base-port', 5850));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4, node: BASE + 5 };
const SITE = `http://127.0.0.1:${PORTS.editor}`;
const STAGE_ORIGINS = [`http://127.0.0.1:${PORTS.stageA}`, `http://127.0.0.1:${PORTS.stageB}`];
const HOSTED = `${SITE}/hosted/`;
const EDITOR = `${SITE}/editor`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-c10-catalog-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'shots')));
fs.mkdirSync(OUT, { recursive: true });
const LOTTIE = { card: 'lottie-bodymovin', url: '/catalog/lottie/bodymovin.json', start: 0, duration: 4, at: 1.5 };
const PARTICLES = { card: 'particles', url: '/catalog/particles/bubble.json', start: 4, duration: 4, at: 6 };
const CATALOG_PATH = /^\/catalog\/(lottie|particles)\/[A-Za-z0-9-]+\.json$/;

const started = Date.now();
const fails = [];
const checks = [];
const out = { ok: false, noCatalog: NO_CATALOG, expectFail: NO_CATALOG, site: SITE, stageOrigins: STAGE_ORIGINS, out: OUT, steps: {} };
const check = (cond, label, extra) => { checks.push({ ok: !!cond, label, ...(extra === undefined ? {} : { extra }) }); if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 400)}`)); return !!cond; };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
const codeOf = (link) => String(link ?? '').split('invite=')[1] ?? '';

async function until(label, fn, timeoutMs, everyMs = 300) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) { fails.push(`超时:${label}`); return null; }
    await delay(everyMs);
  }
}
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

/* ================================================================== 本机替身:托管组合 + 三个源的仿 nginx */

let combo = null;
const proxies = [];
const siteLog = [];
async function startLocalSite() {
  for (const p of [PORTS.editor, PORTS.stageA, PORTS.stageB, PORTS.doc, PORTS.asset]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  let DIST = arg('--dist', null);
  if (!DIST) {
    DIST = path.join(TMP, 'dist-online');
    say('local.build-online', { dist: DIST });
    const b = spawnSync(process.execPath, [viteBin(), 'build', '--mode', 'online', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    if (b.status !== 0) throw new Error(`在线构建失败:${String(b.stderr).slice(-600)}`);
  }
  DIST = path.resolve(DIST);
  out.dist = DIST;
  out.distHasCatalog = fs.existsSync(path.join(DIST, 'catalog'));
  const { startHostedCombo } = await import('../../server/hosted/combo.mjs');
  fs.mkdirSync(path.join(TMP, 'hosted'), { recursive: true });
  combo = await startHostedCombo({
    dataDir: path.join(TMP, 'hosted'), docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    docPublicUrl: `ws://127.0.0.1:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
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
      const sendFile = (file, cache, type) => {
        res.writeHead(200, { 'Content-Type': type ?? MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache, ...sec });
        fs.createReadStream(file).pipe(res);
      };
      // 托管端 nginx 片段的 /catalog/:只放行登记形状的 .json,文件在 <部署目录>/editor/catalog/(在线构建的 catalog/)
      if (!NO_CATALOG && url.pathname.startsWith('/catalog/')) {
        const f = path.join(DIST, ...url.pathname.split('/').filter(Boolean));
        const ok = CATALOG_PATH.test(url.pathname) && f.startsWith(path.join(DIST, 'catalog')) && fs.existsSync(f);
        siteLog.push({ origin, path: url.pathname, status: ok ? 200 : 404 });
        if (!ok) { res.writeHead(404, { 'Content-Type': 'text/plain', ...sec }); return res.end('not found'); }
        return sendFile(f, 'no-cache', 'application/json; charset=utf-8');
      }
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
      if (url.pathname.startsWith('/catalog/')) siteLog.push({ origin, path: url.pathname, status: 404 });
      res.writeHead(404, { 'Content-Type': 'text/plain', ...OAC });
      res.end('not found');
    });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, origin);
      if (!(url.pathname === '/hosted' || url.pathname.startsWith('/hosted/'))) return socket.destroy();
      const target = (url.pathname.slice('/hosted'.length) || '/') + url.search;
      const up = net.connect(PORTS.doc, '127.0.0.1', () => {
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
    proxies.push(server);
    return new Promise((r) => server.listen(port, '127.0.0.1', r));
  };
  await Promise.all([makeProxy(PORTS.editor), makeProxy(PORTS.stageA), makeProxy(PORTS.stageB)]);
  say('local.up', { site: SITE, stages: STAGE_ORIGINS, dist: DIST, distHasCatalog: out.distHasCatalog, catalogRoute: !NO_CATALOG });
}

/* ================================================================== 创建者的桌面编辑器(不当渲染节点) */

let editor = null;
const editorLog = [];
async function startEditor() {
  for (const p of [PORTS.node, PORTS.node + 1, PORTS.node + 2]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  const dir = path.join(TMP, 'editor');
  const tmp = path.join(dir, 'tmp');
  for (const d of [tmp, path.join(dir, 'data'), path.join(dir, 'card-overrides'), path.join(dir, 'projects'), path.join(dir, 'work')]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env };
  for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_NODE_PROFILE', 'PROMPTCUT_HOST_MAX_CONCURRENT', 'PROMPTCUT_TEST_CODE_VERSION', 'PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_SHARED_CONFIG',
    'PROMPTCUT_PUSH', 'PROMPTCUT_HEADLESS', 'PROMPTCUT_ROLE', 'PROMPTCUT_ASSET_URL', 'PROMPTCUT_CARD_SYNC', 'PROMPTCUT_LAN_HOST', 'VITE_PC_ONLINE', 'PROMPTCUT_TEST_ENV_FINGERPRINT']) delete env[key];
  Object.assign(env, {
    PROMPTCUT_EXPORT_DIR: dir, PROMPTCUT_DATA_DIR: path.join(dir, 'data'), PROMPTCUT_CARD_OVERRIDES: path.join(dir, 'card-overrides'),
    PROMPTCUT_PROJECTS_DIR: path.join(dir, 'projects'), PROMPTCUT_WORK_DIR: path.join(dir, 'work'), PROMPTCUT_STREAMS: '0', TEMP: tmp, TMP: tmp, TMPDIR: tmp,
    PROMPTCUT_DEVICE_ID: 'c10-catalog-creator0', PROMPTCUT_DEVICE_NAME: 'c10-catalog 创建者',
  });
  const child = spawn(process.execPath, [viteBin(), '--port', String(PORTS.node), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  let partial = '';
  const keep = (c) => {
    const lines = (partial + c.toString()).split(/\r?\n/);
    partial = lines.pop();
    for (const line of lines) { editorLog.push(line); if (editorLog.length > 8000) editorLog.shift(); }
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  editor = { child, origin: `http://127.0.0.1:${PORTS.node}` };
  const up = await until('创建者编辑器起来', async () => {
    if (child.exitCode !== null) throw new Error('exited');
    return fetch(`${editor.origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 240_000, 500);
  if (!up) throw new Error(`编辑器没起来:${editorLog.slice(-8).join(' | ').slice(0, 500)}`);
  say('editor.up', { origin: editor.origin, pid: child.pid });
}
async function stopEditor() {
  if (!editor?.child?.pid) return;
  const pre = await fetch(`${editor.origin}/api/prerender/info`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json(), () => null);
  killTree(editor.child.pid);
  const prePort = pre?.url ? Number(new URL(pre.url).port) : null;
  if (prePort) for (const p of [prePort, prePort + 1, prePort + 2]) { const pid = pidOnPort(p); if (pid) killTree(pid); }
  for (const p of [PORTS.node, PORTS.node + 1, PORTS.node + 2]) { const pid = pidOnPort(p); if (pid) killTree(pid); }
  editor = null;
}

/* ================================================================== 页面小件 */

let browser = null;
const P = (page, fn, ...a) => page.evaluate(fn, ...a);
const textOf = (page, sel) => page.$eval(sel, (el) => el.textContent ?? '').catch(() => '');
async function typeInto(page, sel, text) {
  await page.waitForSelector(sel, { visible: true, timeout: 20_000 });
  await page.click(sel);
  await page.$eval(sel, (el) => el.select());
  await page.keyboard.press('Backspace');
  if (text) await page.type(sel, text, { delay: 5 });
}
/** 新页面:记下 /catalog/ 的请求与响应(连同发请求的 frame 的源) */
async function newPage(ctx) {
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.pageErrors = [];
  page.on('pageerror', (e) => page.pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  page.consoleErrors = [];
  page.on('console', (m) => { if (m.type() !== 'log' && page.consoleErrors.length < 80) page.consoleErrors.push(`${m.type()}: ${m.text().slice(0, 240)}`); });
  page.catalog = [];
  const frameOrigin = (r) => { try { return new URL(r.frame()?.url() ?? '').origin; } catch { return null; } };
  page.on('response', (res) => {
    let u;
    try { u = new URL(res.url()); } catch { return; }
    if (!u.pathname.startsWith('/catalog/')) return;
    page.catalog.push({ url: `${u.origin}${u.pathname}`, status: res.status(), frameOrigin: frameOrigin(res.request()), type: res.headers()['content-type'] ?? null, cache: res.headers()['cache-control'] ?? null, oac: res.headers()['origin-agent-cluster'] ?? null, fromCache: res.fromCache() });
  });
  page.on('requestfailed', (r) => {
    let u;
    try { u = new URL(r.url()); } catch { return; }
    if (u.pathname.startsWith('/catalog/')) page.catalog.push({ url: `${u.origin}${u.pathname}`, status: 0, failed: r.failure()?.errorText ?? 'failed', frameOrigin: frameOrigin(r) });
  });
  return page;
}
const previewDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcPreviewDiag?.() ?? null)); } catch { return null; } }).catch(() => null);
/** 可见舞台的 frame(按 __pcPreviewDiag 的 frontId;桌面单舞台时取第一个舞台 frame) */
async function frontFrame(page) {
  const d = await previewDiag(page);
  const stages = page.frames().filter((f) => /[?&]stage=1/.test(f.url()));
  const id = d?.frontId ?? null;
  return (id && stages.find((f) => new URL(f.url()).searchParams.get('id') === id)) || stages[0] || null;
}
/** 可见舞台里某个片段的画面状态:Lottie 的 svg 图元数、粒子 canvas 里非透明像素数、占位与压暗 */
const clipState = (frame, clipId) => frame.evaluate((id) => {
  const w = document.querySelector(`[data-pc-clip="${id}"]`);
  if (!w) return { present: false };
  const slot = w.querySelector(':scope > [data-pc-placeholder-slot]');
  const plane = w.querySelector(':scope > [data-pc-snapshot-plane]');
  const svgShapes = [...w.querySelectorAll('svg path, svg image, svg rect, svg ellipse')].filter((e) => !e.closest('[data-pc-placeholder-slot]')).length;
  const engineCanvas = w.querySelectorAll('canvas[data-generated]').length;
  let canvasInk = null;
  for (const c of w.querySelectorAll('canvas')) {
    try {
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx || !c.width || !c.height) continue;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 16) if (d[i] > 8) n++;
      canvasInk = (canvasInk ?? 0) + n;
    } catch { /* 非 2d 上下文 */ }
  }
  return { present: true, placeholder: !!slot && !slot.hidden, plane: !!plane, suppressed: w.classList.contains('pc-suppressed'), settling: w.classList.contains('pc-settling'), svgShapes, engineCanvas, canvasInk, text: (w.textContent ?? '').trim().slice(0, 80) };
}, clipId).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
/** 截舞台 iframe 的图,数「与四角背景色明显不同」的像素比例与颜色数 */
async function stageInk(page, frame, file) {
  const el = await frame.frameElement();
  if (!el) return null;
  const buf = await el.screenshot({ path: file }).catch(() => null);
  if (!buf) return null;
  const { PNG } = createRequire(import.meta.url)('pngjs');
  const png = PNG.sync.read(Buffer.from(buf));
  const { width, height, data } = png;
  const px = (x, y) => { const i = (y * width + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  // 背景 = 出现最多的两种颜色（空舞台是透明棋盘格的两种灰；铺满的卡是它的底色），与两者都明显不同的像素算「画了东西」
  const q = ([r, g, b]) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  const hist = new Map();
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) { const k = q(px(x, y)); hist.set(k, (hist.get(k) ?? 0) + 1); }
  const bg = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => [(k >> 10) << 3, ((k >> 5) & 31) << 3, (k & 31) << 3]);
  let diff = 0;
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
    const [r, g, b] = px(x, y);
    if (bg.every((c) => Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]) > 40)) diff++;
  }
  return { width, height, bg, inkRatio: Number((diff / Math.ceil(width / 2) / Math.ceil(height / 2)).toFixed(4)), colors: hist.size };
}
async function seekAndSettle(page, t, clipId, label) {
  await P(page, (tt) => { const s = window.__pcStore; s.actions.pause?.(); s.actions.seek(tt); }, t);
  let last = null;
  const settled = await until(`${label}:可见舞台里的片段活渲落定`, async () => {
    const f = await frontFrame(page);
    if (!f) return null;
    last = await clipState(f, clipId);
    return last?.present && !last.placeholder && !last.suppressed && !last.settling ? last : null;
  }, 90_000, 400);
  await delay(1500);
  const f = await frontFrame(page);
  return { settled: !!settled, state: f ? await clipState(f, clipId) : last, frame: f };
}

/* ================================================================== 主流程 */

const state = {};
try {
  await startLocalSite();
  const health = await fetch(`${SITE}/hosted/healthz`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json(), (e) => ({ error: String(e?.message ?? e) }));
  if (!check(health?.ok, '托管端 /hosted/healthz', health)) throw new Error('托管端不通');
  // 仿 nginx 的 /catalog/ 规则自检:登记的名字 200、没登记的、非 .json、跳目录都 404
  const rule = {};
  for (const p of [LOTTIE.url, PARTICLES.url, '/catalog/lottie/no-such.json', '/catalog/lottie/index.json.bak', '/catalog/magicui/index.json', '/catalog/lottie/../../index.html']) {
    rule[p] = await fetch(`${STAGE_ORIGINS[0]}${p}`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.status, () => 0);
  }
  out.rule = rule;
  if (!NO_CATALOG) check(rule[LOTTIE.url] === 200 && rule[PARTICLES.url] === 200 && rule['/catalog/lottie/no-such.json'] === 404 && rule['/catalog/magicui/index.json'] === 404 && rule['/catalog/lottie/index.json.bak'] === 404 && rule['/catalog/lottie/../../index.html'] === 404, '仿 nginx 的 /catalog/ 规则:登记的 200、其余 404', rule);

  /* ---------------------------------------------------------------- 0. 创建者(桌面)建项目、放两张卡、放云端 */
  await startEditor();
  const { default: puppeteer } = await import('puppeteer');
  browser = await puppeteer.launch({
    headless: true, protocolTimeout: 600_000, defaultViewport: { width: 1600, height: 1000 },
    args: ['--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'],
  });
  const creatorCtx = await browser.createBrowserContext();
  const creator = await newPage(creatorCtx);
  state.creator = creator;
  await creator.goto(`${editor.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await until('创建者页面舞台起来', () => P(creator, () => document.querySelectorAll('iframe').length >= 1 && !document.querySelector('[data-pc="probe-gate"]')), 300_000, 500);
  await P(creator, () => { for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click(); });
  const projName = `c10素材目录-${Date.now().toString(36)}`;
  const clips = await P(creator, async (spec) => {
    const S = await import('/src/store/project.ts');
    S.actions.newProject(spec.name);
    const l = S.actions.addClipOnNewTrack({ index: 0, cardId: spec.lottie.card, start: spec.lottie.start, duration: spec.lottie.duration });
    const p = S.actions.addClipOnNewTrack({ index: 0, cardId: spec.particles.card, start: spec.particles.start, duration: spec.particles.duration });
    S.actions.setClipParams(p.id, { config: spec.particles.url });
    S.actions.seek(0);
    const proj = S.getState().project;
    const all = proj.tracks.flatMap((t) => t.clips ?? []);
    return { lottie: l?.id ?? null, particles: p?.id ?? null, docId: proj.id, params: Object.fromEntries(all.map((c) => [c.cardId, c.params ?? {}])) };
  }, { name: projName, lottie: LOTTIE, particles: PARTICLES });
  Object.assign(state, clips);
  check(state.lottie && state.particles && clips.params?.particles?.config === PARTICLES.url, '创建者放好 Lottie 素材卡与粒子卡(config 是 /catalog/ 地址)', clips);
  // 新放的卡要测量:遮罩可能晚一拍才出现。等它出现又退下(15 秒内没出现也算),且测量不在跑、连续 3 秒没有遮罩
  {
    const t0 = Date.now();
    let seen = false;
    let clearSince = 0;
    await until('创建者页面测量测完', async () => {
      const x = await P(creator, async () => { const R = await import('/src/editor/probeRunner.ts'); return { running: R.probeProgress().running, gate: !!document.querySelector('[data-pc="probe-gate"]') }; });
      if (x.running || x.gate) { seen = true; clearSince = 0; return null; }
      if (!seen && Date.now() - t0 < 15_000) return null;
      clearSince ||= Date.now();
      return Date.now() - clearSince >= 3000 ? true : null;
    }, 300_000, 200);
  }

  // C1 桌面行为不变:停在两张卡上,dev server 中间件给 /catalog/
  const cl = await seekAndSettle(creator, LOTTIE.at, state.lottie, '桌面 Lottie');
  await creator.screenshot({ path: path.join(OUT, 'creator-lottie.png') });
  const clInk = cl.frame ? await stageInk(creator, cl.frame, path.join(OUT, 'creator-lottie-stage.png')) : null;
  const cp = await seekAndSettle(creator, PARTICLES.at, state.particles, '桌面粒子');
  await creator.screenshot({ path: path.join(OUT, 'creator-particles.png') });
  const cpInk = cp.frame ? await stageInk(creator, cp.frame, path.join(OUT, 'creator-particles-stage.png')) : null;
  const cCat = creator.catalog.slice();
  out.steps.desktop = { lottie: { state: cl.state, ink: clInk }, particles: { state: cp.state, ink: cpInk }, catalogRequests: cCat };
  check(cCat.length > 0 && cCat.every((r) => r.status === 200 || r.status === 304) && [LOTTIE.url, PARTICLES.url].every((u) => cCat.some((r) => r.url.endsWith(u))), 'C1 桌面:创建者页的 /catalog/ 请求全 200,两张卡的地址都取到了', cCat);
  check(cl.state?.svgShapes > 0 && clInk?.inkRatio > 0.02, 'C1 桌面:Lottie 画面非空', { state: cl.state, ink: clInk });
  // 粒子:引擎装上(tsParticles 生成的 canvas 在位)= 配置取到了;预览画面是否非空另记(见文件头「已知」)
  check(cp.state?.engineCanvas > 0, 'C1 桌面:粒子卡的引擎装上了(配置取到、canvas 生成)', { state: cp.state, ink: cpInk });
  out.steps.desktop.particlesInk = { canvasInk: cp.state?.canvasInk ?? null, inkRatio: cpInk?.inkRatio ?? null };
  await P(creator, (t) => window.__pcStore.actions.seek(t), 0);

  // 放云端
  await P(creator, () => window.dispatchEvent(new Event('pc-open-project-settings')));
  await creator.waitForSelector('[data-pc="collab-section"]', { visible: true, timeout: 20_000 });
  await creator.click('[data-pc="collab-toggle"]');
  await creator.waitForSelector('[data-pc="collab-where-hosted"]', { visible: true });
  await creator.click('[data-pc="collab-where-hosted"]');
  await typeInto(creator, '[data-pc="collab-hosted-url"]', HOSTED);
  await creator.click('.pc-dialog-foot .pc-btn--primary');
  const enabled = await until('放云端开启完成', async () => { const t = await textOf(creator, '[data-pc="collab-status"]'); return t && !t.includes('正在设置') ? t : null; }, 90_000, 300);
  if (!check(enabled?.includes('多用户协作已开启。'), '创建者开启「多用户协作」放云端', { status: enabled })) throw new Error('放云端没成');
  await creator.waitForSelector('[data-pc="collab-invite-link"]', { timeout: 20_000 });
  state.link = (await textOf(creator, '[data-pc="collab-invite-link"]')).trim();
  await creator.keyboard.press('Escape');
  say('creator.done', { lottie: state.lottie, particles: state.particles });

  /* ---------------------------------------------------------------- 1. 成员(电脑浏览器,普通档)凭邀请链接进入 */
  const memberCtx = await browser.createBrowserContext();
  const member = await newPage(memberCtx);
  state.member = member;
  await member.goto(`${EDITOR}#invite=${codeOf(state.link)}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await member.waitForSelector('[data-pc="join-invite-project"]', { visible: true, timeout: 60_000 });
  await typeInto(member, '[data-pc="join-username"]', '电脑成员');
  await member.click('[data-pc="join-submit"]');
  if (!check(await member.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 90_000 }).then(() => true, () => false), '成员凭邀请链接进入', { message: await textOf(member, '[data-pc="join-message"]') })) throw new Error('成员没进去');
  // 首次打开在加载遮罩下测量卡片(测量本身就在舞台里活渲这两张卡):等遮罩出现又退下,且连续 3 秒不再出现
  let gateSeen = false;
  let clearSince = 0;
  await until('成员页的加载遮罩出现又退下、两个舞台起来', async () => {
    const g = await P(member, () => !!document.querySelector('[data-pc="probe-gate"]'));
    if (g) { gateSeen = true; clearSince = 0; return null; }
    const d = await previewDiag(member);
    if (!gateSeen || !d?.dual) return null;
    clearSince ||= Date.now();
    return Date.now() - clearSince >= 3000 ? true : null;
  }, 300_000, 200);
  const d1 = await previewDiag(member);
  out.steps.memberStages = { dual: d1?.dual ?? null, frontId: d1?.frontId ?? null, frames: member.frames().filter((f) => /[?&]stage=1/.test(f.url())).map((f) => new URL(f.url()).origin) };

  const ml = await seekAndSettle(member, LOTTIE.at, state.lottie, '在线 Lottie');
  await member.screenshot({ path: path.join(OUT, 'member-lottie.png') });
  const mlInk = ml.frame ? await stageInk(member, ml.frame, path.join(OUT, 'member-lottie-stage.png')) : null;
  const mp = await seekAndSettle(member, PARTICLES.at, state.particles, '在线粒子');
  await member.screenshot({ path: path.join(OUT, 'member-particles.png') });
  const mpInk = mp.frame ? await stageInk(member, mp.frame, path.join(OUT, 'member-particles-stage.png')) : null;
  const mCat = member.catalog.slice();
  out.steps.online = { lottie: { frameOrigin: ml.frame ? new URL(ml.frame.url()).origin : null, state: ml.state, ink: mlInk }, particles: { frameOrigin: mp.frame ? new URL(mp.frame.url()).origin : null, state: mp.state, ink: mpInk }, catalogRequests: mCat };
  const fromStages = mCat.filter((r) => STAGE_ORIGINS.includes(r.frameOrigin));
  check(mCat.length > 0 && mCat.every((r) => r.status === 200 || r.status === 304) && [LOTTIE.url, PARTICLES.url].every((u) => mCat.some((r) => r.url.endsWith(u) && (r.status === 200 || r.status === 304))) && fromStages.length > 0,
    'C2 在线:成员页(含舞台 iframe)的 /catalog/ 请求全 200,两张卡的地址都取到了,且有发自舞台源的', mCat);
  check(mCat.every((r) => r.status === 0 || (r.oac === '?1' && /json/.test(r.type ?? ''))), 'C2 在线:/catalog/ 响应带 Origin-Agent-Cluster: ?1、类型是 JSON', mCat.map((r) => ({ oac: r.oac, type: r.type })));
  check(ml.settled && ml.state?.svgShapes > 0 && mlInk?.inkRatio > 0.02, 'C3 在线:Lottie 卡活渲落定、svg 挂上、画面非空', { state: ml.state, ink: mlInk });
  check(mp.settled && mp.state?.engineCanvas > 0, 'C4 在线:粒子卡活渲落定、引擎装上了(配置取到、canvas 生成)', { state: mp.state, ink: mpInk });
  check((mp.state?.canvasInk ?? -1) === (cp.state?.canvasInk ?? -2), 'C4 在线:粒子 canvas 的非透明像素数与桌面一致(同一份配置、同一个 t)', { online: mp.state?.canvasInk ?? null, desktop: cp.state?.canvasInk ?? null });
  out.memberDiag = { pageErrors: member.pageErrors.slice(-8), consoleErrors: member.consoleErrors.filter((t) => /catalog|lottie|particles|粒子/i.test(t)).slice(-12) };
} catch (e) {
  fails.push(`探针异常:${String(e?.stack ?? e).slice(0, 1200)}`);
  for (const [name, page] of [['creator', state.creator], ['member', state.member]]) if (page) await page.screenshot({ path: path.join(OUT, `fatal-${name}.png`) }).catch(() => {});
} finally {
  out.siteCatalogLog = siteLog.slice(0, 60);
  try { await browser?.close(); } catch { /* 已关 */ }
  try { fs.writeFileSync(path.join(OUT, 'creator-editor.log'), editorLog.join('\n')); } catch { /* 写不了 */ }
  await stopEditor().catch(() => {});
  for (const s of proxies) await new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); });
  try { await combo?.close(); } catch { /* 已关 */ }
  out.cleanup = { listening: [PORTS.editor, PORTS.stageA, PORTS.stageB, PORTS.doc, PORTS.asset, PORTS.node, PORTS.node + 1, PORTS.node + 2].filter((p) => pidOnPort(p)) };
  if (!KEEP) {
    for (const d of fs.readdirSync(TMP)) {
      const p = path.join(TMP, d);
      if (path.resolve(p) === OUT) continue;
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 句柄还没放 */ }
    }
  }
  out.ms = Date.now() - started;
  out.checks = checks;
  out.fails = fails;
  out.ok = fails.length === 0;
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
