/**
 * 在线普通档两个跨源舞台的**首次握手**计时(`src/online/stageHandshake.ts`,〔裁〕2026-09-30 `claude/stage-handshake`):
 * 每台的 20 秒从那一台 iframe 的 `load` 起算,另有自挂上起 2 分钟的总上限;可见舞台 A 加载完才挂后台舞台 B。
 * 全程在本机:本机托管组合代替阿里云,仿 nginx 的前缀代理开三个源(编辑器页 + 两个舞台,都带 OAC),在线构建当页面。
 * 代理仿的是**没有隔离策略头的旧 nginx**:跨源舞台载舞台入口 `stage.html`(自带 `<meta>` 策略),自检判没有隔离、素材照旧走 `?t=`;
 * 握手计时与它无关。「舞台页请求」按 `/editor/stage.html?stage=1`(跨源)与 `/editor/?stage=1`(同源单舞台)两种地址认。
 * 慢网络只在应用层模拟:代理把**舞台源上**的主脚本(index.html 引的入口 `assets/index-*.js`)压住 `--stage-delay-ms` 再回,
 * 编辑器页自己的源不压(不动宿主机网络)。
 *
 *   npx vite build --mode online --outDir <目录>
 *   node scripts/probes/online-stage-handshake-probe.mjs --dist <在线构建目录> [--out <截图目录>] [--base-port 6010] [--stage-delay-ms 40000]
 *
 * 端口:+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务(缺省 6010～6014)。
 * 每个场景一个新的浏览器上下文(无缓存),以成员身份加入同一个放云端的项目。代理给 `/editor/assets/` 回 `Cache-Control: public, max-age=31536000, immutable`
 * (线上 nginx 同样如此,主会话 2026-09-30 核实)。
 *
 * 断言:
 *   S4 只压可见舞台 A 的主脚本 40 秒:约 20 秒进过渡期,同源单舞台画出片段(挂上到第一次画出 ≤ 24 秒),跨源的 A / B 改作隐藏的预热 iframe
 *      继续加载;A 约 40 秒 load、B 随后 load、两台握上 → 换回双舞台:预热的 iframe 直接接任(跨源舞台页各只请求一次),盖板撤下后
 *      跨源 A 画出片段;出画面之后(含换回那一下)可见舞台空白不超过 1 秒;`__pcBrowserNode()` 资格恢复(能当纯浏览器节点)。
 *   S1 慢加载:两个舞台源的主脚本各压 40 秒。同 S4,只是 B 也压、约 80 秒才握上。
 *   S2 舞台 A 的源坏了(舞台页回 503):错误页照样 load,约 20 秒后退回同源单舞台(原因「舞台 A 加载完 20 秒没握上手」),
 *      只剩一个舞台 iframe、在编辑器页的源上,画出片段;从挂上到退回、到画出的时长记在结果里。
 *   S3 舞台 B 的源坏了:A 正常握手,B 在 A load 之后挂、错误页 load,约 20 秒后退回,单舞台画出片段。
 *
 * 结果最后一行是一行 JSON(`ok`、`fails`、各项数字),截图在 --out。
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startHostedCombo } from '../../server/hosted/combo.mjs';
import { createSharedProject } from '../../server/auth/client.mjs';
import { seedSharedProject } from './lib-seed.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'online-stage-handshake-shots')));
const BASE = Number(arg('--base-port', 6010));
const DELAY = Number(arg('--stage-delay-ms', 40_000));
const ONLY = (arg('--only', 'S4,S1,S2,S3')).split(',');
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4 };
const SITE = `http://127.0.0.1:${PORTS.editor}`;
const STAGE_ORIGINS = [`http://127.0.0.1:${PORTS.stageA}`, `http://127.0.0.1:${PORTS.stageB}`];
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, delayMs: DELAY, cpus: os.cpus().length };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 20_000, every = 250) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { v = null; last = String(e?.message ?? e); }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}${last ? ` (${last.slice(0, 120)})` : ''}`); return null; }
    await sleep(every);
  }
}

/* ------------------------------------------------------------------ 服务 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'online-stage-handshake-hosted-'));
const combo = await startHostedCombo({
  dataDir, docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
  docPublicUrl: `ws://127.0.0.1:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
});

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
const OAC = { 'origin-agent-cluster': '?1' };
const runtimeConfig = JSON.stringify({ v: 1, stageOrigins: STAGE_ORIGINS });
const ENTRY = (fs.readFileSync(path.join(DIST, 'index.html'), 'utf8').match(/<script type="module"[^>]*src="\/editor\/(assets\/[^"]+\.js)"/) ?? [])[1];
if (!ENTRY) throw new Error('index.html 里找不到入口脚本');
/** 每个源上的事件:舞台页请求、入口脚本请求 / 回完(时间戳) */
const log = { page: new Map(), entryReq: new Map(), entryDone: new Map() };
const push = (m, port) => { if (!m.has(port)) m.set(port, []); m.get(port).push(Date.now()); };
/** 场景开关:这些舞台源压主脚本;这些舞台源对舞台页回 503 */
const cfg = { slow: new Set(), broken: new Set() };
const servers = [];
function makeProxy(port) {
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
    const sendFile = (file, cache, onDone) => {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache, ...sec });
      const s = fs.createReadStream(file);
      if (onDone) s.on('end', onDone);
      s.pipe(res);
    };
    if (url.pathname === '/editor/runtime-config.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...sec });
      return res.end(runtimeConfig);
    }
    const index = path.join(DIST, 'index.html');
    // 跨源舞台载的是舞台入口 stage.html(在线执行用户卡与图卡,`online-card-exec-contract.md` 第 3.3 节);同源单舞台仍是 /editor/?stage=1
    const isStageEntry = url.pathname === '/editor/stage.html';
    const isPage = url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html' || isStageEntry;
    if (isPage && url.searchParams.get('stage') === '1') {
      push(log.page, port);
      if (cfg.broken.has(port)) { res.writeHead(503, { 'Content-Type': 'text/plain', ...sec }); return res.end('stage origin down (probe)'); }
    }
    if (isStageEntry) { const entry = path.join(DIST, 'stage.html'); return sendFile(fs.existsSync(entry) ? entry : index, 'no-store'); }
    if (isPage) return sendFile(index, 'no-store');
    if (url.pathname.startsWith('/editor/assets/')) {
      const rel = decodeURIComponent(url.pathname.slice('/editor/'.length));
      const f = path.join(DIST, rel);
      if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404, sec); return res.end('not found'); }
      if (rel === ENTRY && port !== PORTS.editor) {
        push(log.entryReq, port);
        const done = () => push(log.entryDone, port);
        if (cfg.slow.has(port)) { const t = setTimeout(() => sendFile(f, 'public, max-age=31536000, immutable', done), DELAY); req.on('close', () => clearTimeout(t)); return; }
        return sendFile(f, 'public, max-age=31536000, immutable', done);
      }
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
  servers.push(server);
  return new Promise((r) => server.listen(port, '127.0.0.1', r));
}
await Promise.all([makeProxy(PORTS.editor), makeProxy(PORTS.stageA), makeProxy(PORTS.stageB)]);

/* ------------------------------------------------------------------ 共享项目 */
const stamp = Date.now().toString(36);
const NAME = `osh-${stamp}`;
const creator = { username: 'boss', password: `boss-${randomBytes(6).toString('hex')}` };
const PROJECT_PW = `pw-${randomBytes(6).toString('hex')}`;
const made = await createSharedProject({ base: DOC_DIRECT, name: NAME, mode: 'free', creator, password: PROJECT_PW });
// 在线页面只加入、不新建(`dce4b22b`):先替创建者写进一份空项目,否则页面进不去
check((await seedSharedProject({ base: DOC_DIRECT, projectId: made.projectId, creator, name: NAME })).ok, '替创建者写进空项目');
const CLIP = 'osh-b';

/* ------------------------------------------------------------------ 浏览器 */
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--site-per-process', ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : [])] });

/** 一个场景:新的浏览器上下文,以成员身份加入,返回页面与工具 */
async function openMember(tag, username) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on('dialog', (d) => void d.accept());
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  const consoleWarn = [];
  page.on('console', (m) => { const t = m.text(); if (/舞台|退回同源单舞台/.test(t)) consoleWarn.push(t.slice(0, 200)); });
  const typeInto = async (sel, text) => {
    await page.waitForSelector(sel, { visible: true, timeout: 15_000 });
    await page.click(sel, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    if (text) await page.type(sel, text, { delay: 5 });
  };
  await page.goto(`${SITE}/editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
  await typeInto('[data-pc="join-name"]', NAME);
  await typeInto('[data-pc="join-username"]', username);
  await typeInto('[data-pc="join-password"]', PROJECT_PW);
  await page.click('[data-pc="join-submit"]');
  await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 60_000 });
  await until(`${tag} 时间轴`, () => page.evaluate(() => !!window.__pcStore), 30_000);
  const store = (src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
  // 片段只加一次(共享项目里留着);每个场景都停在 1 秒
  await store(`
    const p0 = S.getState().project;
    if (!p0.tracks.some((t) => t.clips.some((c) => c.id === args[0])))
      S.actions.editCardProject((p) => ({ ...p, duration: Math.max(p.duration, 6),
        tracks: [{ id: 'osh-t', name: '序列', clips: [{ id: args[0], cardId: 'punch-pill', start: 0, end: 6, params: {}, frame: { x: 0, y: 0, w: 960, h: 540 } }] }, ...p.tracks] }));
    S.actions.seek(1); return true;`, CLIP);
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()));
  return {
    ctx, page, pageErrors, consoleWarn, stageFrames,
    shot: (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {}),
    hs: () => page.evaluate(() => window.__pcStageHandshake?.() ?? null),
    preview: () => page.evaluate(() => { const d = window.__pcPreviewDiag?.(); return d ? { dual: d.dual, frontId: d.frontId, onlineStages: d.onlineStages, handover: d.handover } : null; }),
    node: () => page.evaluate(() => { const n = window.__pcBrowserNode?.(); return n ? { eligibility: n.eligibility, state: n.state, reason: n.reason, nodeId: n.nodeId } : null; }),
    /** 可见舞台里画没画出片段(包裹层在、有子节点) */
    async visibleDrawn() {
      for (const f of stageFrames()) {
        const el = await f.frameElement().catch(() => null);
        const vis = el ? await el.evaluate((e) => { const cs = getComputedStyle(e); return Number(cs.opacity) > 0.5 && e.getBoundingClientRect().width > 10; }).catch(() => false) : false;
        if (!vis) continue;
        const drawn = await f.evaluate((id) => { const w = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`); return !!w && w.childElementCount > 0; }, CLIP).catch(() => false);
        if (drawn) return { url: f.url() };
      }
      return null;
    },
    async close() { await ctx.close().catch(() => {}); },
  };
}
const firstAfter = (m, port, t) => (m.get(port) ?? []).find((x) => x >= t) ?? null;
const rel = (t, t0) => (t === null || t0 === null ? null : t - t0);

try {
  /*
   * 慢加载场景(S1 两台都压、S4 只压 A):约 20 秒同源单舞台出画面(过渡期),预热的两个跨源 iframe 继续加载;
   * 两台都握上手后换回双舞台(同一个 iframe 元素接任,舞台页不重新请求),盖板撤下,能当纯浏览器节点。
   * 从挂上起每 100 ms 看一次可见舞台画没画出片段,记第一次画出的时刻和之后最长的一段空白(换回那一下的闪烁)。
   */
  async function slowScenario(tag, slowPorts, username) {
    const key = tag.toLowerCase();
    cfg.slow = new Set(slowPorts); cfg.broken = new Set();
    const tStart = Date.now();
    const hits0 = { a: log.page.get(PORTS.stageA)?.length ?? 0, b: log.page.get(PORTS.stageB)?.length ?? 0, e: log.page.get(PORTS.editor)?.length ?? 0 };
    const m = await openMember(tag, username);
    const tMount = await until(`${tag} 舞台 A 的舞台页请求`, () => firstAfter(log.page, PORTS.stageA, tStart), 60_000);
    let tFirstDrawn = null;
    let lastDrawn = null;
    let maxGap = 0;
    let stop = false;
    const drawWatch = (async () => {
      while (!stop && Date.now() - tMount < DELAY * 2 + 90_000) {
        const d = await m.visibleDrawn();
        const now = Date.now();
        if (d) {
          if (tFirstDrawn === null) tFirstDrawn = now;
          if (lastDrawn !== null) maxGap = Math.max(maxGap, now - lastDrawn);
          lastDrawn = now;
        }
        await sleep(100);
      }
    })();
    // 挂上 25 秒:已进过渡期、同源单舞台出了画面,没失败
    await sleep(Math.max(0, tMount + 25_000 - Date.now()));
    const at25 = { hs: await m.hs(), preview: await m.preview(), drawn: await m.visibleDrawn(), warm: await m.page.$$eval('[data-pc="stage-frame-warm"]', (a) => a.length).catch(() => -1) };
    out[`${key}at25`] = at25;
    check(at25.hs?.phase === 'interim' && at25.preview?.onlineStages?.handshake === 'interim' && at25.preview?.dual === false, `${tag} 挂上 25 秒时在过渡期(同源单舞台)、没失败`, at25);
    check(!!at25.drawn && at25.drawn.url.startsWith(`${SITE}/`), `${tag} 过渡期里同源单舞台画出片段`, at25.drawn);
    check(at25.warm >= 1, `${tag} 过渡期里有隐藏的预热 iframe`, at25.warm);
    check(tFirstDrawn !== null && tFirstDrawn - tMount <= 24_000, `${tag} 约 20 秒出画面(挂上到第一次画出 ≤ 24 秒)`, { firstDrawn: rel(tFirstDrawn, tMount) });
    await m.shot(`${key}-interim-25s`);
    const ok = await until(`${tag} 预热的两台都握上手`, async () => { const h = await m.hs(); return h && h.phase === 'ok' ? h : null; }, DELAY * 2 + 60_000, 250);
    const tOk = ok ? Date.now() : null;
    const handed = await until(`${tag} 换回双舞台、盖板撤下、跨源 A 画出片段`, async () => {
      const cover = await m.page.$$eval('[data-pc="stage-frame-cover"]', (a) => a.length).catch(() => -1);
      const d = await m.visibleDrawn();
      return cover === 0 && d && d.url.startsWith(`${STAGE_ORIGINS[0]}/`) ? d : null;
    }, 30_000, 100);
    const tHanded = handed ? Date.now() : null;
    await sleep(3000);
    stop = true;
    await drawWatch;
    const preview = await m.preview();
    const hits = { a: (log.page.get(PORTS.stageA)?.length ?? 0) - hits0.a, b: (log.page.get(PORTS.stageB)?.length ?? 0) - hits0.b, e: (log.page.get(PORTS.editor)?.length ?? 0) - hits0.e };
    out[key] = {
      firstDrawn: rel(tFirstDrawn, tMount), interimAt: ok?.interimAt ?? null, ok: rel(tOk, tMount), handed: rel(tHanded, tMount), handoverMs: tOk && tHanded ? tHanded - tOk : null,
      maxGapAfterFirstDrawn: maxGap, slots: ok?.slots ?? null, stagePageHits: hits, preview,
      aEntryDone: rel(firstAfter(log.entryDone, PORTS.stageA, tStart), tMount), bPage: rel(firstAfter(log.page, PORTS.stageB, tStart), tMount),
    };
    check(preview?.dual === true && preview?.onlineStages?.handshake === 'ok', `${tag} 最终是双舞台、handshake ok`, preview);
    check((ok?.slots?.A?.loadedAt ?? 0) >= DELAY - 1000, `${tag} A 的 load 在压住的时长之后`, ok?.slots);
    check(hits.a === 1 && hits.b === 1 && hits.e === 1, `${tag} 换回时预热的 iframe 直接接任,跨源舞台页各只请求一次(同源单舞台一次)`, hits);
    check(maxGap <= 1000, `${tag} 出画面之后(含换回那一下)可见舞台空白不超过 1 秒`, { maxGap });
    const node = await until(`${tag} 页面能当纯浏览器节点(资格通过)`, async () => { const n = await m.node(); return n && n.eligibility?.ok ? n : null; }, 60_000, 500);
    out[`${key}node`] = node ?? await m.node();
    check(!!node, `${tag} 换回双舞台后资格恢复`, out[`${key}node`]);
    out[`${key}warn`] = m.consoleWarn.slice(-6);
    out[`${key}errors`] = m.pageErrors.slice(0, 5);
    await m.shot(`${key}-dual`);
    await m.close();
  }

  /* ============================================================ S1 慢加载:两台主脚本各压 40 秒 */
  if (ONLY.includes('S1')) await slowScenario('S1', [PORTS.stageA, PORTS.stageB], 'm1');
  /* ============================================================ S4 只压可见舞台 A 的主脚本 40 秒 */
  if (ONLY.includes('S4')) await slowScenario('S4', [PORTS.stageA], 'm4');

  /* ============================================================ S2 舞台 A 的源坏了 */
  if (ONLY.includes('S2')) {
    cfg.slow = new Set(); cfg.broken = new Set([PORTS.stageA]);
    const tStart = Date.now();
    const m = await openMember('S2', 'm2');
    const tMount = await until('S2 舞台 A 的舞台页请求', () => firstAfter(log.page, PORTS.stageA, tStart), 60_000);
    const fell = await until('S2 退回单舞台', async () => { const p = await m.preview(); return p && p.onlineStages?.handshake === 'failed' ? p : null; }, 60_000, 250);
    const tFell = fell ? Date.now() : null;
    const drawn = await until('S2 单舞台画出片段', () => m.visibleDrawn(), 60_000, 250);
    const tDrawn = drawn ? Date.now() : null;
    out.s2 = { fellMs: rel(tFell, tMount), drawnMs: rel(tDrawn, tMount), reason: fell?.onlineStages?.reason ?? null, hs: await m.hs(), frames: m.stageFrames().map((f) => f.url().replace(/\?.*$/, '')) };
    check(/舞台 A 加载完 20 秒没握上手/.test(out.s2.reason ?? ''), 'S2 退回原因是 A 加载完 20 秒没握上手', out.s2);
    check(out.s2.fellMs !== null && out.s2.fellMs >= 19_000 && out.s2.fellMs <= 30_000, 'S2 约 20 秒退回(19～30 秒)', out.s2);
    check(out.s2.frames.length === 1 && out.s2.frames[0].startsWith(`${SITE}/`), 'S2 只剩一个舞台 iframe,在编辑器页的源上', out.s2.frames);
    check(!!drawn && drawn.url.startsWith(`${SITE}/`), 'S2 同源单舞台画出片段', drawn);
    await m.shot('s2-single');
    await m.close();
  }

  /* ============================================================ S3 舞台 B 的源坏了 */
  if (ONLY.includes('S3')) {
    cfg.slow = new Set(); cfg.broken = new Set([PORTS.stageB]);
    const tStart = Date.now();
    const m = await openMember('S3', 'm3');
    const tMount = await until('S3 舞台 A 的舞台页请求', () => firstAfter(log.page, PORTS.stageA, tStart), 60_000);
    const fell = await until('S3 退回单舞台', async () => { const p = await m.preview(); return p && p.onlineStages?.handshake === 'failed' ? p : null; }, 60_000, 250);
    const tFell = fell ? Date.now() : null;
    const drawn = await until('S3 单舞台画出片段', () => m.visibleDrawn(), 60_000, 250);
    const tDrawn = drawn ? Date.now() : null;
    out.s3 = { bPage: rel(firstAfter(log.page, PORTS.stageB, tStart), tMount), fellMs: rel(tFell, tMount), drawnMs: rel(tDrawn, tMount), reason: fell?.onlineStages?.reason ?? null, hs: await m.hs() };
    check(/舞台 B 加载完 20 秒没握上手/.test(out.s3.reason ?? ''), 'S3 退回原因是 B 加载完 20 秒没握上手', out.s3);
    check(/握上手的舞台:A/.test(out.s3.reason ?? ''), 'S3 A 握上了手', out.s3);
    check(out.s3.fellMs !== null && out.s3.fellMs >= 19_000 && out.s3.fellMs <= 35_000, 'S3 约 20 秒退回(19～35 秒)', out.s3);
    check(!!drawn && drawn.url.startsWith(`${SITE}/`), 'S3 同源单舞台画出片段', drawn);
    await m.shot('s3-single');
    await m.close();
  }
} catch (e) {
  fails.push(`异常:${String(e?.stack ?? e).slice(0, 400)}`);
} finally {
  out.stagePageHits = Object.fromEntries([...log.page].map(([p, v]) => [p, v.length]));
  out.fails = fails;
  out.ok = fails.length === 0;
  await browser.close().catch(() => {});
  for (const s of servers) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r())); }
  await combo.close?.().catch?.(() => {});
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
