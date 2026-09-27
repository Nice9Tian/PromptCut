/**
 * C10 其余 `claude/c10-ui` 的验收探针(`docs/plan/c10-contract.md` 第 9、10、11 节,第 20 节 C10-A6、A7、A8)。
 * 全程在本机:本机托管组合代替阿里云,小代理代替 nginx,在线构建当页面,绝不连真正的托管端。
 *
 *   npx vite build --mode online --outDir <目录>
 *   node scripts/probes/c10-ui-probe.mjs --dist <在线构建目录> [--out <截图目录>]
 *        [--proxy-port 5703] [--proxy2-port 5706] [--doc-port 5704] [--asset-port 5705]
 *
 * 起的东西(都由本探针起、跑完关掉):托管组合(文档服务、素材服务,数据目录在系统临时目录);两个同形的代理
 * (成员甲走 --proxy-port,成员乙走 --proxy2-port;只断甲的那一个,乙照常在线);无头 Chrome。
 *
 * 断言:
 *   A6 用户卡(仓库里的 `mu-animated-shiny-text`)的片段:时间轴上有「该模式暂不支持自定义卡」徽标(悬停文案),内置卡没有;
 *      舞台上是常驻的「需要本地 PC 渲染辅助」,不是沙漏;层表里有这一层也不取它的清单、不取它的 `px/` 字节(内置卡那一层照取);
 *      片段照常可选中、改参数、移动,另一成员看得到。
 *   A7 置灰:导入媒体、配音、SKILL、片段右键「转写字幕」置灰且悬停是表 A 文案;点了不发请求、没有页面错误、`/api` 守卫一条没拦;
 *      被覆盖时给不打断的提示带「下载备份」;离线(会话接续期间不闪)→「连不上服务器…」+ 常驻提示 + 原生离开确认;
 *      断网 →「当前没有网络连接。」;恢复 →「丢弃」后给「下载备份」、同步面板列出、逐个下载出 JSON;
 *      无冲突的离线修改恢复时「已恢复连接，正在提交离线时的修改…」/「离线时的修改已全部提交。」;素材服务断开 →「连不上素材服务…」。
 *   A8 `POST merge/<projectId>/<共享键>` 回 501。
 * 不打印口令;结果最后一行是一行 JSON(`ok`、`fails`、各项数字),截图在 --out。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { createSharedProject, buildAuthProtocols } from '../../server/auth/client.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'c10-ui-shots')));
const PROXY_PORT = Number(arg('--proxy-port', 5703));
const PROXY2_PORT = Number(arg('--proxy2-port', 5706));
const DOC_PORT = Number(arg('--doc-port', 5704));
const ASSET_PORT = Number(arg('--asset-port', 5705));
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const PROXY2 = `http://127.0.0.1:${PROXY2_PORT}`;
const DOC_DIRECT = `http://127.0.0.1:${DOC_PORT}`;
fs.mkdirSync(OUT, { recursive: true });
const DL = path.join(OUT, 'downloads');
fs.mkdirSync(DL, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, A6: {}, A7: {}, A8: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 500))); return !!cond; };
const say = (k, v) => console.log(JSON.stringify({ [k]: v }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 15_000, every = 200) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}`); return null; }
    await sleep(every);
  }
}
const UNSUP = (entry) => `在线浏览器模式暂不支持${entry}，请在电脑上的 PromptCut 里使用。`;
const TEXT = {
  noNetwork: '当前没有网络连接。',
  docDown: '连不上服务器，请稍后再试。你的修改先留在本页，恢复后会自动提交。',
  assetDown: '连不上素材服务，素材原尺寸和预渲染结果暂时显示不了。',
  recovering: '已恢复连接，正在提交离线时的修改…',
  recovered: '离线时的修改已全部提交。',
  unsent: '当前离线，有未提交的修改。关闭页面将丢失这些操作。',
  custom: '该模式暂不支持自定义卡',
};

/* ------------------------------------------------------------------ 服务 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c10-ui-hosted-'));
const combo = await startHostedCombo({
  dataDir, docPort: DOC_PORT, assetPort: ASSET_PORT, host: '127.0.0.1',
  docPublicUrl: `ws://127.0.0.1:${PROXY_PORT}/hosted/`, assetPublicUrl: `${PROXY}/media/api/asset`, log: () => {},
});

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
/** 同形代理(代替 nginx)。`ctl.blockWs` 断 WebSocket(现有的掐掉、新的拒掉),`ctl.blockMedia` 让 `/media/` 连不上 */
function makeProxy(port, origin) {
  const ctl = { log: [], blockWs: false, blockMedia: false, sockets: new Set() };
  const forward = (req, res, upPort, strip) => {
    const target = req.url.slice(strip.length) || '/';
    const up = http.request({ host: '127.0.0.1', port: upPort, method: req.method, path: target.startsWith('/') ? target : `/${target}`, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on('error', () => { res.statusCode = 502; res.end('bad gateway'); });
    req.pipe(up);
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin);
    ctl.log.push({ at: Date.now(), m: req.method, p: url.pathname });
    if (url.pathname.startsWith('/hosted/')) return forward(req, res, DOC_PORT, '/hosted');
    if (url.pathname.startsWith('/media/')) {
      if (ctl.blockMedia) return req.socket.destroy();
      return forward(req, res, ASSET_PORT, '/media');
    }
    const sendFile = (file, cache) => { res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache }); fs.createReadStream(file).pipe(res); };
    const index = path.join(DIST, 'index.html');
    if (url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html') return sendFile(index, 'no-store');
    if (url.pathname.startsWith('/editor/assets/')) {
      const f = path.join(DIST, decodeURIComponent(url.pathname.slice('/editor/'.length)));
      if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
      return sendFile(f, 'public, max-age=31536000, immutable');
    }
    if (url.pathname.startsWith('/editor/')) return sendFile(index, 'no-store');
    res.writeHead(404); res.end('not found');
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, origin);
    if (!url.pathname.startsWith('/hosted/') || ctl.blockWs) return socket.destroy();
    const target = url.pathname.slice('/hosted'.length) + url.search;
    const up = net.connect(DOC_PORT, '127.0.0.1', () => {
      const lines = [`${req.method} ${target} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    const pair = { socket, up };
    ctl.sockets.add(pair);
    const drop = () => ctl.sockets.delete(pair);
    socket.on('close', drop); up.on('close', drop);
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  ctl.cutWs = () => { ctl.blockWs = true; for (const p of ctl.sockets) { p.socket.destroy(); p.up.destroy(); } ctl.sockets.clear(); };
  ctl.listen = () => new Promise((r) => server.listen(port, '127.0.0.1', r));
  ctl.close = () => new Promise((r) => { for (const p of ctl.sockets) { p.socket.destroy(); p.up.destroy(); } server.close(() => r()); server.closeAllConnections?.(); });
  return ctl;
}
const px1 = makeProxy(PROXY_PORT, PROXY);
const px2 = makeProxy(PROXY2_PORT, PROXY2);
await px1.listen();
await px2.listen();

/* ------------------------------------------------------------------ 共享项目 */
const stamp = Date.now().toString(36);
const NAME = `c10ui-${stamp}`;
const creator = { username: 'boss', password: `boss-${randomBytes(6).toString('hex')}` };
const PROJECT_PW = `pw-${randomBytes(6).toString('hex')}`;
const made = await createSharedProject({ base: DOC_DIRECT, name: NAME, mode: 'free', creator, password: PROJECT_PW });

/** 凭证连接直接向托管端发请求(探针替渲染节点写层表与段清单) */
async function wsAsCreator() {
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId: made.projectId, username: creator.username, deviceId: 'c10-ui-probe-node-01', deviceName: 'probe-node', as: 'creator', password: creator.password, role: 'page' });
  const ws = new WebSocket(DOC_DIRECT.replace(/^http/, 'ws'), protocols);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const ask = (msg) => new Promise((resolve) => {
    const reqId = `p${Math.random().toString(36).slice(2)}`;
    const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
  return { ask, close: () => ws.close() };
}

/* ------------------------------------------------------------------ 浏览器 */
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: ['--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required'] });
async function newPage(label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.label = label;
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.message ?? e)));
  page.consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') page.consoleErrors.push(m.text()); });
  page.requests = [];
  page.on('request', (r) => page.requests.push({ at: Date.now(), url: r.url() }));
  const cdp = await page.createCDPSession();
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }).catch(() => {});
  return page;
}
async function typeInto(page, sel, text) {
  await page.waitForSelector(sel, { visible: true, timeout: 15_000 });
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  if (text) await page.type(sel, text, { delay: 5 });
}
async function join(page, origin, username) {
  await page.goto(`${origin}/editor`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
  await typeInto(page, '[data-pc="join-name"]', NAME);
  await typeInto(page, '[data-pc="join-username"]', username);
  await typeInto(page, '[data-pc="join-password"]', PROJECT_PW);
  await page.click('[data-pc="join-submit"]');
  await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 });
  await until(`${username} 的时间轴`, () => page.evaluate(() => !!window.__pcStore), 30_000);
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
const stageFrame = (page) => page.frames().find((f) => /[?&]stage=1/.test(f.url()));
/** 页面里记下顶栏状态措辞出现过哪几种(MutationObserver),和常驻提示出没出现过 */
const installRecorder = (page) => page.evaluate(() => {
  window.__probeSeen = [];
  const note = () => {
    const el = document.querySelector('[data-pc="sync-online-status"]');
    const kind = el?.getAttribute('data-kind') ?? null;
    const unsent = !!document.querySelector('[data-pc="offline-unsent"]');
    const last = window.__probeSeen[window.__probeSeen.length - 1];
    if (!last || last.kind !== kind || last.unsent !== unsent) window.__probeSeen.push({ at: Date.now(), kind, text: el?.textContent ?? null, unsent });
  };
  new MutationObserver(note).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  note();
});
const seen = (page) => page.evaluate(() => window.__probeSeen ?? []);
const statusNow = (page) => page.evaluate(() => { const el = document.querySelector('[data-pc="sync-online-status"]'); return el ? { kind: el.getAttribute('data-kind'), text: el.textContent, title: el.getAttribute('title') } : null; });
const downloads = () => fs.readdirSync(DL).filter((f) => f.endsWith('.json'));

try {
  /* ============================================================ 成员甲进入、摆片段 */
  const A = await newPage('甲');
  await join(A, PROXY, '甲');
  await installRecorder(A);
  const setup = await store(A, `
    const S2 = S;
    const u = S2.actions.addClipOnNewTrack({ index: 0, cardId: 'mu-animated-shiny-text', start: 0, duration: 4 });
    const b = S2.actions.addClipOnNewTrack({ index: 1, cardId: 'punch-pill', start: 0, duration: 4 });
    const m = S2.actions.addMedia({ kind: 'video', name: 'probe.mp4', url: '/@media/' + args[0], hash: args[0], ext: 'mp4', size: 1000, duration: 4, width: 1280, height: 720 });
    const mc = S2.actions.addClipOnNewTrack({ index: 2, mediaId: m.id, start: 0, duration: 4 });
    S2.actions.seek(1);
    const p = S2.getState().project;
    return { projectId: p.id, u: u && u.id, b: b && b.id, media: m.id, mediaClip: mc && mc.id, fps: p.fps || 30 };`, randomBytes(32).toString('hex'));
  out.setup = { ...setup, sharedProjectId: made.projectId };
  check(setup.u && setup.b && setup.mediaClip, '摆片段', setup);

  /* 层表与段清单(替渲染节点写):用户卡与内置卡各一层,4 秒 = 两段,每帧一张小位图 */
  const node = await wsAsCreator();
  const layerOf = (clipId) => ({ clipId, rk: randomBytes(32).toString('hex'), small: [] });
  const layers = [layerOf(setup.u), layerOf(setup.b)];
  const count = 4 * setup.fps;
  for (const L of layers) {
    for (const [from, to] of [[0, count / 2 - 1], [count / 2, count - 1]]) {
      const frames = [], small = [];
      for (let f = from; f <= to; f++) {
        const h = randomBytes(32).toString('hex');
        frames.push([f, randomBytes(32).toString('hex'), 200]);
        small.push([f, h, 20]);
        L.small.push(h);
      }
      const r = await node.ask({ type: 'content.put', kind: 'snapshot-manifest', key: `${L.rk}:${from}-${to}`, body: { v: 1, kind: 'snapshot', tier: 'shared', resultKey: L.rk, dirKey: L.rk, entryKey: null, range: { from, to }, canvasHeavy: false, frames, small } });
      check(r.type === 'content.stored', '写段清单', r);
    }
  }
  const map = { v: 1, kind: 'layer-map', projectId: setup.projectId, fps: setup.fps, width: 1920, height: 1080, span: count / 2, at: Date.now(),
    layers: layers.map((L) => ({ clipId: L.clipId, kind: 'html', key: L.rk, tier: 'shared', resultKey: L.rk, dirKey: L.rk, entryKey: null, firstFrame: 0, count })) };
  const rm = await node.ask({ type: 'content.put', kind: 'snapshot-manifest', key: `layers:${setup.projectId}`, body: map });
  check(rm.type === 'content.stored', '写层表', rm);
  node.close();

  /* ============================================================ A6 用户卡 */
  await sleep(8000); // 层表每几秒轮询一次;预取按播放头前后 2 秒
  const pxReq = (hashes) => px1.log.filter((r) => /\/media\/api\/asset\/px\//.test(r.p) && hashes.some((h) => r.p.endsWith(h))).length;
  const a6 = {};
  a6.pxUser = pxReq(layers[0].small);
  a6.pxBuiltin = pxReq(layers[1].small);
  a6.online = await A.evaluate(() => window.__pcOnlineSnapshots?.() ?? null);
  const readyOf = (id) => a6.online?.layers?.find((l) => l.clipId === id)?.ready ?? null;
  a6.readyUser = readyOf(setup.u);
  a6.readyBuiltin = readyOf(setup.b);
  a6.badges = await A.evaluate((u, b) => ({
    user: !!document.querySelector(`[data-clip-id="${u}"] [data-pc="clip-custom-card"]`),
    builtin: !!document.querySelector(`[data-clip-id="${b}"] [data-pc="clip-custom-card"]`),
    title: document.querySelector(`[data-clip-id="${u}"] [data-pc="clip-custom-card"]`)?.getAttribute('title') ?? null,
  }), setup.u, setup.b);
  a6.stage = await stageFrame(A)?.evaluate(() => {
    const fixed = [...document.querySelectorAll('[data-pc-placeholder-fixed]')];
    return { fixed: fixed.length, text: fixed.map((e) => e.textContent).join('|').slice(0, 200) };
  }).catch((e) => ({ error: String(e) }));
  a6.feed = await A.evaluate(() => window.__pcPreviewDiag?.()?.snapshotFeed ?? null);
  check(a6.badges.user && !a6.badges.builtin, 'A6 时间轴徽标只在用户卡片段上', a6.badges);
  check(a6.badges.title === TEXT.custom, 'A6 徽标悬停文案', a6.badges.title);
  check(a6.stage?.fixed >= 1 && /需要本地 PC 渲染辅助/.test(a6.stage?.text ?? ''), 'A6 舞台常驻「需要本地 PC 渲染辅助」', a6.stage);
  check(a6.pxUser === 0, 'A6 用户卡那一层一个 px 请求都没有', a6.pxUser);
  check(a6.pxBuiltin > 0, 'A6 对照:内置卡那一层照常预取 px', a6.pxBuiltin);
  check(a6.readyUser === 0, 'A6 用户卡那一层不取清单(就绪帧 0)', a6.readyUser);
  check((a6.readyBuiltin ?? 0) > 0, 'A6 对照:内置卡那一层取到了清单', a6.readyBuiltin);
  check(!(a6.feed?.picks ?? []).some((p) => p.clipId === setup.u), 'A6 选帧里没有用户卡', a6.feed);
  // 悬停出全文:鼠标移到徽标上(原生 title 提示),截图
  const badge = await A.$(`[data-clip-id="${setup.u}"] [data-pc="clip-custom-card"]`);
  if (badge) { await badge.hover(); await sleep(1200); }
  await shot(A, 'a6-1-user-card');
  // 片段照常可选中、改参数、移动
  const clipEl = await A.$(`[data-clip-id="${setup.u}"]`);
  if (clipEl) { const bb = await clipEl.boundingBox(); await A.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); await sleep(400); }
  a6.selected = await store(A, `return S.getState().selection.includes(args[0]);`, setup.u);
  check(a6.selected, 'A6 用户卡片段点得选中');
  await store(A, `S.actions.setClipParams(args[0], { text: 'c10-ui 改过' }); S.actions.moveClip(args[0], { start: 0.5, end: 4.5 }); return true;`, setup.u);
  out.A6 = a6;

  /* ============================================================ A8 */
  const merge = await fetch(`${PROXY}/media/api/asset/merge/${made.projectId}/${'ab'.repeat(32)}`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  out.A8 = { status: merge.status, body: await merge.json().catch(() => null) };
  check(merge.status === 501, 'A8 POST merge 回 501', out.A8);

  /* ============================================================ A7 置灰 */
  const a7 = {};
  const grey = await A.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const imp = q('[data-pc-add="media"]');
    const voice = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes('配音') || b.textContent?.trim() === '配音设置');
    const skill = [...document.querySelectorAll('.pc-modeswitch-item')].find((b) => b.textContent?.trim() === 'SKILL');
    const f = (el) => el ? { disabled: !!el.disabled, title: el.getAttribute('title') } : null;
    return { importMedia: f(imp), voice: f(voice), skill: f(skill), agentOff: q('[data-pc="online-agent-off"]')?.textContent ?? null };
  });
  a7.grey = grey;
  check(grey.importMedia?.disabled && grey.importMedia.title === UNSUP('导入媒体'), 'A7 导入媒体置灰+表 A 文案', grey.importMedia);
  check(grey.voice?.disabled && grey.voice.title === UNSUP('配音'), 'A7 配音置灰+表 A 文案', grey.voice);
  check(grey.skill?.disabled && grey.skill.title === UNSUP('SKILL 模式'), 'A7 SKILL 置灰+表 A 文案', grey.skill);
  // 点一遍(禁用的按钮真点也不触发;另用 el.click() 再点一次),点前点后比请求与错误
  const before = { req: A.requests.length, err: A.errors.length + A.consoleErrors.length };
  for (const sel of ['[data-pc-add="media"]']) { const el = await A.$(sel); if (el) { await el.hover(); await sleep(900); await shot(A, 'a7-1-import-hover'); await el.click().catch(() => {}); } }
  await A.evaluate(() => {
    for (const b of document.querySelectorAll('button')) if (b.disabled && /在线浏览器模式暂不支持/.test(b.getAttribute('title') || '')) b.click();
  });
  // 片段右键「转写字幕」
  const mc = await A.$(`[data-clip-id="${setup.mediaClip}"]`);
  if (mc) { const bb = await mc.boundingBox(); await A.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2, { button: 'right' }); await sleep(500); }
  a7.sttItem = await A.evaluate(() => {
    const it = [...document.querySelectorAll('[data-pc="tl-ctxmenu"] .pc-tl-ctxmenu-item')].find((e) => e.textContent?.trim() === '转写字幕');
    return it ? { disabled: it.getAttribute('aria-disabled') === 'true', title: it.getAttribute('title') } : null;
  });
  if (a7.sttItem) {
    const it = (await A.$$('[data-pc="tl-ctxmenu"] .pc-tl-ctxmenu-item')).find(async (h) => (await h.evaluate((e) => e.textContent?.trim())) === '转写字幕');
    await A.evaluate(() => [...document.querySelectorAll('[data-pc="tl-ctxmenu"] .pc-tl-ctxmenu-item')].find((e) => e.textContent?.trim() === '转写字幕')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await shot(A, 'a7-2-stt-menu');
    await A.evaluate(() => [...document.querySelectorAll('[data-pc="tl-ctxmenu"] .pc-tl-ctxmenu-item')].find((e) => e.textContent?.trim() === '转写字幕')?.click());
    void it;
  }
  await A.keyboard.press('Escape');
  check(a7.sttItem?.disabled && a7.sttItem.title === UNSUP('语音识别'), 'A7 右键「转写字幕」置灰+表 A 文案', a7.sttItem);
  await sleep(1500);
  const newReq = A.requests.slice(before.req).map((r) => r.url).filter((u) => !/\/media\/api\/asset\/(media|px|snap)\//.test(u));
  a7.clickRequests = newReq;
  // 「Failed to load resource」是探针的替身层表里没上传字节的 px/ 与假素材的 404(预取与对账轮询发的,和点击无关),不算
  a7.clickErrors = [...A.errors, ...A.consoleErrors].slice(before.err).filter((e) => !/^Failed to load resource/.test(e));
  check(newReq.length === 0, 'A7 点置灰的入口不发请求(素材服务的对账轮询除外)', newReq.slice(0, 5));
  check(a7.clickErrors.length === 0, 'A7 点置灰的入口不露报错', a7.clickErrors.slice(0, 5));
  check(grey.agentOff === UNSUP('AI 助手') || grey.agentOff === null, 'A7 AI 助手占位是表 A 文案(没打开就不在 DOM)', grey.agentOff);

  /* ------------------------------------------------ 被覆盖:乙改甲刚改过的同一处 */
  const B = await newPage('乙');
  await join(B, PROXY2, '乙');
  a7.bSeesEdit = await until('乙看到甲对用户卡片段的改动', () => store(B, `const c = S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === args[0]); return c && Math.abs(c.start - 0.5) < 1e-6 && c.params && c.params.text === 'c10-ui 改过' ? { start: c.start, text: c.params.text } : null;`, setup.u), 20_000);
  check(!!a7.bSeesEdit, 'A6 用户卡片段的改动经文档服务提交,另一成员看得到');
  await store(A, `S.actions.setClipParams(args[0], { text: '甲写的' }); return true;`, setup.b);
  await sleep(1500);
  await store(B, `S.actions.setClipParams(args[0], { text: '乙盖掉' }); return true;`, setup.b);
  const toast = await until('甲收到被覆盖的提示(带下载备份)', () => A.evaluate(() => {
    const t = [...document.querySelectorAll('.pc-toast')].find((e) => e.querySelector('[data-pc="backup-download"]'));
    return t ? t.textContent : null;
  }), 15_000);
  a7.overwrittenToast = toast;
  const dl0 = downloads().length;
  await shot(A, 'a7-3-overwritten-toast');
  await A.evaluate(() => [...document.querySelectorAll('.pc-toast [data-pc="backup-download"]')].pop()?.click());
  const dl1 = await until('被覆盖备份下载出 JSON', () => downloads().length > dl0 ? downloads() : null, 10_000);
  a7.overwrittenDownload = dl1 ? dl1.filter((f) => /被覆盖/.test(f)) : null;
  check(a7.overwrittenDownload?.length >= 1, 'A7 被覆盖时「下载备份」能下载', dl1);
  a7.autoDownloadedBeforeClick = dl0;
  check(dl0 === 0, 'A7 不自动下载(点之前一份都没有)', dl0);

  /* ------------------------------------------------ 离线第 1 轮:会话接续期间不闪 → 连不上服务器 → 断网 → 冲突 → 丢弃 */
  const t0 = Date.now();
  px1.cutWs();
  await sleep(1000);
  await store(A, `S.actions.moveClip(args[0], { start: 1, end: 5 }); return true;`, setup.u); // 离线时的修改(之后会冲突)
  await sleep(6000);
  a7.duringResume = await statusNow(A);
  check(a7.duringResume === null, 'A7 会话接续期间(断开 7 秒内)顶栏不闪状态', a7.duringResume);
  await store(B, `S.actions.moveClip(args[0], { start: 2, end: 6 }); return true;`, setup.u); // 乙在这期间改同一张
  const docDown = await until('甲顶栏「连不上服务器」', async () => { const s = await statusNow(A); return s?.kind === 'docDown' ? s : null; }, 120_000, 500);
  a7.docDown = docDown && { ...docDown, afterSec: Math.round((Date.now() - t0) / 1000) };
  check(docDown?.text === TEXT.docDown, 'A7 连不上文档服务的措辞', docDown);
  a7.unsent = await A.evaluate(() => document.querySelector('[data-pc="offline-unsent"]')?.textContent ?? null);
  check(a7.unsent === TEXT.unsent, 'A7 离线且有未提交时常驻提示', a7.unsent);
  a7.beforeUnload = await A.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
  check(a7.beforeUnload === true, 'A7 关页面时挂原生离开确认(beforeunload 被拦)', a7.beforeUnload);
  await shot(A, 'a7-4-doc-down-unsent');
  await A.setOfflineMode(true);
  const noNet = await until('甲顶栏「当前没有网络连接」', async () => { const s = await statusNow(A); return s?.kind === 'noNetwork' ? s : null; }, 10_000);
  check(noNet?.text === TEXT.noNetwork, 'A7 断网的措辞', noNet);
  await shot(A, 'a7-5-no-network');
  await A.setOfflineMode(false);
  px1.blockWs = false;
  const dialog = await until('甲弹出离线对话框(第一条被拒)', () => A.$('[data-pc="offline-dialog"]'), 60_000, 500);
  check(!!dialog, 'A7 恢复后第一条被拒 → 离线对话框(C6.5 共用)');
  await shot(A, 'a7-6-offline-dialog');
  const dlBefore = downloads().length;
  const discardAt = Date.now();
  await A.evaluate(() => [...document.querySelectorAll('[data-pc="offline-dialog"] button')].find((b) => b.textContent?.includes('不要了'))?.click());
  const discardToast = await until('「丢弃」后当场给「下载备份」', () => A.evaluate(() => [...document.querySelectorAll('.pc-toast')].find((e) => /已丢弃/.test(e.textContent || '') && e.querySelector('[data-pc="backup-download"]'))?.textContent ?? null), 10_000);
  a7.discardToast = discardToast;
  check(downloads().length === dlBefore, 'A7 丢弃后不自动下载', downloads());
  await shot(A, 'a7-7-discard-toast');
  await A.evaluate(() => [...document.querySelectorAll('.pc-toast')].find((e) => /已丢弃/.test(e.textContent || ''))?.querySelector('[data-pc="backup-download"]')?.click());
  const dl2 = await until('丢弃的备份下载出 JSON', () => downloads().some((f) => /离线丢弃/.test(f)) ? downloads() : null, 10_000);
  const discardFile = dl2?.find((f) => /离线丢弃/.test(f));
  if (discardFile) {
    const body = JSON.parse(fs.readFileSync(path.join(DL, discardFile), 'utf8'));
    a7.discardFile = { name: discardFile, kind: body?.backup?.kind, batch: body?.backup?.batch?.length };
  }
  check(a7.discardFile?.kind === 'offline-discard' && a7.discardFile.batch >= 1, 'A7 丢弃的备份是 offline-discard 的 JSON', a7.discardFile);
  // 同步面板:「备份 N」列出本页内存里的全部备份,逐个下载
  a7.backupsChip = await A.evaluate(() => document.querySelector('[data-pc="sync-backups"]')?.textContent?.trim() ?? null);
  await A.click('[data-pc="sync-backups"]').catch(() => {});
  await A.waitForSelector('[data-pc="backups-dialog"]', { visible: true, timeout: 5000 }).catch(() => {});
  a7.backupRows = await A.evaluate(() => document.querySelectorAll('[data-pc="backups-dialog"] [data-pc="backup-row"]').length);
  await shot(A, 'a7-8-backups-panel');
  const dl3n = downloads().length;
  // 逐个真点(同一页面一口气触发多个下载会被浏览器的「多文件下载」拦下)
  for (const h of await A.$('[data-pc="backups-dialog"] [data-pc="backup-download"]')) { await h.click(); await sleep(1500); }
  await until('面板里逐个下载', () => downloads().length >= dl3n + a7.backupRows ? true : null, 10_000);
  a7.panelDownloads = downloads().length - dl3n;
  check(a7.backupRows >= 2 && a7.panelDownloads >= a7.backupRows, 'A7 同步面板列出全部备份、逐个下载', { chip: a7.backupsChip, rows: a7.backupRows, got: a7.panelDownloads });
  await A.evaluate(() => [...document.querySelectorAll('[data-pc="backups-dialog"] button')].find((b) => b.textContent?.trim() === '关闭')?.click());
  a7.storage = await A.evaluate(async () => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage), idb: (await indexedDB.databases?.())?.map((d) => d.name) ?? null }));
  const hasBackup = (keys) => (keys ?? []).some((k) => /backup|备份/i.test(k));
  check(!hasBackup(a7.storage.local) && !hasBackup(a7.storage.session) && !hasBackup(a7.storage.idb), 'A7 备份不进任何浏览器存储', a7.storage);
  await sleep(4000);
  a7.afterDiscard = (await seen(A)).filter((s) => s.at > discardAt).map((s) => s.kind);
  check(!a7.afterDiscard.includes('recovered'), 'A7 丢弃之后不说「离线时的修改已全部提交」', a7.afterDiscard);

  /* ------------------------------------------------ 离线第 2 轮:没有冲突 → 恢复中 → 恢复完成 */
  await sleep(2000);
  px1.cutWs();
  await sleep(1000);
  await store(A, `S.actions.setClipParams(args[0], { text: '离线时甲改的' }); return true;`, setup.b);
  await until('第 2 轮甲顶栏「连不上服务器」', async () => (await statusNow(A))?.kind === 'docDown', 120_000, 500);
  px1.blockWs = false;
  await until('第 2 轮恢复完成', async () => (await seen(A)).some((s) => s.kind === 'recovered'), 60_000, 300);
  const s2 = await seen(A);
  a7.round2 = s2.filter((s) => s.at > t0).map((s) => s.kind);
  check(s2.some((s) => s.kind === 'recovered' && s.text === TEXT.recovered), 'A7 恢复完成的措辞', a7.round2);
  a7.recoveringSeen = s2.some((s) => s.kind === 'recovering' && s.text === TEXT.recovering);
  const bGot = await until('乙收到甲离线时的修改', () => store(B, `const c = S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === args[0]); return c && c.params && c.params.text === '离线时甲改的';`, setup.b), 15_000);
  check(!!bGot, 'A7 离线时的修改恢复后提交到文档服务');
  await shot(A, 'a7-9-recovered');

  /* ------------------------------------------------ 素材服务连不上 */
  px1.blockMedia = true;
  const assetDown = await until('甲顶栏「连不上素材服务」', async () => { const s = await statusNow(A); return s?.kind === 'assetDown' ? s : null; }, 30_000, 500);
  check(assetDown?.text === TEXT.assetDown, 'A7 连不上素材服务的措辞', assetDown);
  await shot(A, 'a7-10-asset-down');
  px1.blockMedia = false;
  await until('素材服务恢复后状态撤下', async () => (await statusNow(A)) === null, 30_000, 500);

  /* ------------------------------------------------ /api 守卫与请求记录 */
  a7.apiBlocked = [...await A.evaluate(() => window.__pcApiBlocked ?? []), ...await B.evaluate(() => window.__pcApiBlocked ?? [])];
  a7.apiRequests = [...px1.log, ...px2.log].filter((r) => /^\/(editor\/)?api\//.test(r.p)).map((r) => r.p);
  check(a7.apiBlocked.length === 0 && a7.apiRequests.length === 0, 'A7 全程 /api 守卫一条没拦、网络记录里没有 /api 请求', { blocked: a7.apiBlocked.slice(0, 5), req: a7.apiRequests.slice(0, 5) });
  a7.pageErrors = [...A.errors, ...B.errors];
  a7.seen = (await seen(A)).map((s) => ({ t: Math.round((s.at - t0) / 1000), kind: s.kind, unsent: s.unsent }));
  out.A7 = a7;
  out.downloads = downloads();
} catch (e) {
  fails.push(`异常:${e?.stack || e}`);
} finally {
  await browser.close().catch(() => {});
  await px1.close();
  await px2.close();
  await combo.close?.().catch?.(() => {});
  try { await combo.stop?.(); } catch { /* 没有 stop */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
}
out.ok = fails.length === 0;
out.fails = fails;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
