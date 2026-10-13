/**
 * 探针:Lottie 卡在**在线页面**里的播放、暂停、拖动,逐帧和导出页同一帧相同;带随机表达式的五份测试素材在在线页面里同样逐帧稳定。
 * 出处:`docs/plan/render-refactor-task.md`「癸」的验收(「播放、暂停、拖动各验一遍,桌面和在线都验。带随机表达式和随机顺序文字的测试素材同样要过」)。
 * 桌面那一半在 `lottie-pipeline-probe.mjs`(`docs/reports/AGENT-rr-lottie.md`);这里补在线的。
 *
 *   node scripts/probes/lottie-online-probe.mjs [--dist <在线构建目录>] [--base-port 27280] [--out <目录>] [--keep-temp] [--no-pixels]
 *        端口(整段 +0～+9):+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务、+5～+7 导出页用的开发服务器(及它的舞台端口)。都只绑 127.0.0.1。
 *
 * 角色都在本机,做法照 `page-stream-probe.mjs`(本机托管组合 + 仿 nginx 的代理 + 在线构建;页面走「刷新后回到项目」那条产品路径进入共享项目):
 *   - 在线页面:在线构建(`vite build --mode online`,生产压缩过的代码),可见舞台和后台舞台是跨源 iframe,和线上同形;
 *   - 导出页:一台隔离的开发服务器(`preview-stop-lib.mjs` 的 `startIsolatedEditor`),`FramePipeline.bakery` + `bakeFrames` 逐帧推,
 *     和真的导出同一条取帧的路。这是"导出页同一帧"的参照。
 * 项目由在线页面里用 store 的 actions 建:1280×720、30 帧每秒,七张 Lottie 片段首尾相接——自带的 `lottie-navidad`(带嵌套蒙版)、`lottie-happy2016`、
 * 通用 `lottie` 卡放五份手写的测试素材(`scripts/probes/fixtures/lottie-seed/` 的 expr-layers、expr-cases、text-random,
 * 以及 `lottie-seed-probe.mjs` 里现造的两份变体:装载是异步的、起点不在第 0 帧)。测试素材用内联 JSON 文本传进卡的 `json` 参数,在线页面不用另有文件服务。
 * 导出页拿的是在线页面里同一份项目(片段 id 相同)。
 *
 * 验什么:
 *   export   导出页逐帧记下每张片段「看得见的 SVG 文本」的散列(口径同 `lottie-pipeline-probe.mjs`):每张片段内每帧都读到。
 *   stage    在线页面的可见舞台:
 *              暂停着点(往前、往回、跨片段乱跳)、一帧一帧挪(拖动);每次等它回到精确活渲,读这张卡看得见的 SVG 文本,要和导出页同一帧的相同;
 *              同一帧先后到的相同;五份测试素材各取一批覆盖随机表达式出现的帧;
 *              再播放几段、暂停:途中落在整帧上的样本、停下的那一帧,同样要和导出页相同。
 *   pixels   可见舞台的截图:同一帧"顺着挪到"和"从别处直接点到"两张截图逐像素相同(在线页面的像素稳定);
 *            舞台摆放的缩放正好是 1:1 时,再和导出页同一帧的 PNG 逐像素比(不是 1:1 就只报告缩放比,不比)。
 * 判定:上面各条都成立;不成立进 `fails`,退出码 1。耗时只记录。不打印令牌、口令。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的导出目录 / 数据目录,也不写公共的 port.json
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PNG } from 'pngjs';
import dnsShim from './lib/localhost-dns.cjs';
import { startHostedProxy, proxyOrigins } from './lib/hosted-proxy.mjs';
import { resumeRecord, plantResume } from './lib/online-resume-entry.mjs';
import { viteBin, portFree } from './m8/procs.mjs';
import { startIsolatedEditor } from './preview-stop-lib.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const KEEP = argv.includes('--keep-temp');
const NO_PIXELS = argv.includes('--no-pixels');
const BASE = Number(arg('--base-port', 27280));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4, dev: BASE + 5 };
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const ORIGINS = proxyOrigins(PORTS.editor);
const SITE = ORIGINS.editor;
const HOSTED = `${SITE}/hosted/`;
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
const EDITOR = `${SITE}/editor`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-lottie-online-'));
const OUT = path.resolve(arg('--out', path.join('out', 'lottie-online-probe')));
fs.mkdirSync(OUT, { recursive: true });
process.env.NODE_OPTIONS = dnsShim.withLocalhostDns(process.env.NODE_OPTIONS);

const FPS = 30;
const PROJECT = { width: 1280, height: 720, fps: FPS };
const FIX_DIR = path.join(ROOT, 'scripts', 'probes', 'fixtures', 'lottie-seed');
const readFix = (name) => JSON.parse(fs.readFileSync(path.join(FIX_DIR, name), 'utf8'));
/** 五份测试素材的 JSON 文本(同 `lottie-seed-probe.mjs` 的 `dataText`);异步的那份,外部数据素材用 data: 地址,走 XHR,装载仍是异步的 */
function fixtureText(name) {
  if (name === 'fixture') return JSON.stringify(readFix('expr-layers.json'));
  if (name === 'fixtureasync') { const d = readFix('expr-layers.json'); d.nm = 'lottie-online-fixture-async'; d.assets.push({ id: 'data_0', nm: 'footage', t: 3, u: '', p: 'data:application/json,%7B%22rows%22%3A%5B%5D%7D', e: 0 }); return JSON.stringify(d); }
  if (name === 'fixtureip') { const d = readFix('expr-layers.json'); d.nm = 'lottie-online-fixture-ip'; d.ip = 22; return JSON.stringify(d); }
  if (name === 'exprcases') return JSON.stringify(readFix('expr-cases.json'));
  if (name === 'textrandom') return JSON.stringify(readFix('text-random.json'));
  throw new Error(`不认识的素材:${name}`);
}
const CLIPS = [
  { name: 'navidad', cardId: 'lottie-navidad', start: 0, seconds: 5, params: {} },
  { name: 'happy2016', cardId: 'lottie-happy2016', start: 5, seconds: 3.4, params: {} },
  ...['fixture', 'fixtureasync', 'fixtureip', 'exprcases', 'textrandom'].map((name, i) => ({ name, cardId: 'lottie', start: 8.4 + i * 2, seconds: 2, params: { json: fixtureText(name), src: '' } })),
];
const DURATION = 18.4;
const TOTAL = Math.floor(DURATION * FPS);
const clipAt = (f) => CLIPS.find((c) => f / FPS >= c.start - 1e-9 && f / FPS < c.start + c.seconds - 1e-9) ?? null;
const startFrame = (c) => Math.round(c.start * FPS);

const fails = [];
const out = { ok: false, run: RUN, site: SITE, out: OUT };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
const check = (cond, label, extra) => { if (!cond) { const msg = label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 500)); fails.push(msg); say('FAIL', { msg }); } return !!cond; };
async function until(label, fn, timeoutMs, everyMs = 200) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) { fails.push(`超时:${label}`); return null; }
    await delay(everyMs);
  }
}

/** 页面里用的:一张卡「看得见的 SVG 文本」的散列(口径同 `lottie-pipeline-probe.mjs`) */
const GRAB_SRC = String.raw`(() => {
  if (window.__pcLottieGrab) return true;
  const normalize = (s) => { const ids = new Map(); return s.replace(/__lottie_element_\d+/g, (m) => { if (!ids.has(m)) ids.set(m, 'E' + ids.size); return ids.get(m); }); };
  const visible = (svg) => {
    const copy = svg.cloneNode(true);
    const walk = (el) => {
      if (el.style && el.style.display === 'none') { while (el.firstChild) el.removeChild(el.firstChild); for (const a of [...el.attributes]) if (a.name !== 'id' && a.name !== 'style') el.removeAttributeNode(a); return; }
      const attrs = [...el.attributes].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      for (const a of attrs) el.removeAttributeNode(a);
      for (const a of attrs) el.setAttributeNode(a);
      for (const child of [...el.children]) walk(child);
    };
    walk(copy);
    const refsOf = (el, into) => { for (const node of [el, ...el.querySelectorAll('*')]) for (const a of node.attributes) { for (const m of a.value.matchAll(/url\(["']?#([^)"']+)["']?\)/g)) into.add(m[1]); if (a.localName === 'href' && a.value.startsWith('#')) into.add(a.value.slice(1)); } };
    const byId = new Map(); for (const el of copy.querySelectorAll('[id]')) byId.set(el.getAttribute('id'), el);
    const used = new Set(); const pending = new Set();
    for (const child of copy.children) if (child.localName !== 'defs') refsOf(child, pending);
    while (pending.size) { const id = pending.values().next().value; pending.delete(id); if (used.has(id)) continue; used.add(id); const el = byId.get(id); if (el) { const more = new Set(); refsOf(el, more); for (const x of more) if (!used.has(x)) pending.add(x); } }
    for (const defs of copy.querySelectorAll('defs')) for (const res of [...defs.children]) { const ids = [res, ...res.querySelectorAll('[id]')].map((el) => el.getAttribute('id')).filter(Boolean); if (!ids.some((id) => used.has(id))) res.remove(); }
    return normalize(new XMLSerializer().serializeToString(copy));
  };
  const hash = (s) => { let a = 0x811c9dc5, b = 0x1b873593; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x85ebca6b) + 0x7f4a7c15 | 0; } return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0') + ':' + s.length; };
  window.__pcLottieGrab = (ids) => {
    const res = {};
    for (const wrap of document.querySelectorAll('[data-pc-clip]:not([data-pc-media])')) {
      const id = wrap.getAttribute('data-pc-clip');
      if (ids && !ids.includes(id)) continue;
      const svg = [...wrap.querySelectorAll('svg')].find((el) => !el.closest('[data-pc-snapshot-plane],[data-pc-placeholder-slot],[data-pc-proxy-plane]'));
      if (svg) res[id] = hash(visible(svg));
    }
    return res;
  };
  return true;
})()`;

/* ================================================================== 本机站点 */

let combo = null, hostedProxy = null;
async function startLocalSite() {
  for (const p of [PORTS.editor, PORTS.stageA, PORTS.stageB, PORTS.doc, PORTS.asset]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  let dist = arg('--dist', null);
  if (!dist) {
    dist = path.join(TMP, 'dist-online');
    say('local.build-online', { dist });
    const b = spawnSync(process.execPath, [viteBin(), 'build', '--mode', 'online', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    if (b.status !== 0) throw new Error(`在线构建失败:${String(b.stderr).slice(-600)}`);
  }
  dist = path.resolve(dist);
  const { startHostedCombo } = await import('../../server/hosted/combo.mjs');
  fs.mkdirSync(path.join(TMP, 'hosted'), { recursive: true });
  combo = await startHostedCombo({
    dataDir: path.join(TMP, 'hosted'), docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    docPublicUrl: `ws://pc.localhost:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
  });
  hostedProxy = await startHostedProxy({ dist, basePort: PORTS.editor, docPort: PORTS.doc, assetPort: PORTS.asset, policy: 'full' });
  say('local.up', { site: SITE, dist });
  return dist;
}

async function seedProject({ projectId, creator, name }) {
  const { buildAuthProtocols } = await import('../../server/auth/client.mjs');
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId, username: creator.username, deviceId: 'lop-seed-node-0001', deviceName: 'probe-seed', as: 'creator', password: creator.password, role: 'page' });
  const ws = new WebSocket(DOC_DIRECT.replace(/^http/, 'ws'), protocols);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const ask = (msg) => new Promise((resolve) => {
    const reqId = `seed${Math.random().toString(36).slice(2)}`;
    const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
  try {
    const opened = await ask({ type: 'project.open', projectId });
    const body = { version: 1, id: `seed-${projectId.slice(-8)}`, name, ...PROJECT, duration: DURATION, themeId: 'midnight', media: [], tracks: [{ id: 't-1', name: '序列 1', clips: [] }] };
    const seeded = await ask({ type: 'project.op', projectId, opId: randomBytes(16).toString('base64url'), ops: [{ op: 'set', path: '', value: body }] });
    const bad = (m) => /error|reject/i.test(String(m?.type ?? ''));
    return { ok: !bad(opened) && !bad(seeded) };
  } finally { ws.close(); }
}

/* ================================================================== 页面 */

const EVAL_TIMEOUT_MS = 30_000;
const P = (page, fn, ...a) => Promise.race([page.evaluate(fn, ...a), delay(EVAL_TIMEOUT_MS).then(() => { throw new Error('页面 30 秒没应答'); })]);
const store = (page, src, ...a) => P(page, (s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
const stageFramesOf = (page) => page.frames().filter((f) => /[?&]stage=1/.test(f.url()));
/** 此刻角色是 front 的舞台 iframe */
async function frontStage(page) {
  for (const f of stageFramesOf(page)) {
    const role = await f.evaluate(() => window.__pcStageDiag?.().role ?? null).catch(() => null);
    if (role === 'front') return f;
  }
  return null;
}

let browser = null, ctx = null, devEditor = null, pipeline = null;
const started = Date.now();
try {
  const dist = await startLocalSite();
  const health = await (await fetch(`${SITE}/hosted/healthz`)).json().catch(() => null);
  if (!check(health?.ok, '托管端 /hosted/healthz', health)) throw new Error('托管端不通');
  check(fs.existsSync(path.join(dist, 'stage.html')), '在线构建里有舞台入口 stage.html');

  const M = {
    createSharedProject: (await import('../../server/auth/client.mjs')).createSharedProject,
  };
  const projName = `Lottie在线-${RUN}`;
  const creator = { username: 'lop-creator', password: `pw-${randomBytes(6).toString('hex')}` };
  const projectPassword = `pp-${randomBytes(6).toString('hex')}`;
  const made = await M.createSharedProject({ base: DOC_DIRECT, name: projName, mode: 'free', creator, password: projectPassword });
  const projectId = made.projectId;
  check((await seedProject({ projectId, creator, name: projName })).ok, '替创建者写进空项目');

  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 900_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--site-per-process', '--window-position=-32000,-32000', '--force-device-scale-factor=1'] });
  ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 240)));
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') { const t = m.text(); if (/\[lottie\]/.test(t)) pageErrors.push(`console:${t.slice(0, 200)}`); } });
  await page.setViewport({ width: 2400, height: 1500, deviceScaleFactor: 1 });
  await plantResume(page, await resumeRecord({ base: HOSTED, derivationBase: `${DOC_DIRECT}/`, projectId, name: projName, username: 'lop-member', password: projectPassword, deviceId: `lop-member-${RUN}`.slice(0, 40).padEnd(16, '0') }));
  await page.goto(EDITOR, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const entered = await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 120_000 }).then(() => true, () => false);
  if (!check(entered, '进入项目(刷新后回到项目那条路)')) throw new Error('没进去');
  await until('双舞台握上手', async () => P(page, () => { const d = window.__pcPreviewDiag?.(); return d?.dual && d.onlineStages?.handshake === 'ok'; }), 120_000, 500);

  // ── 在线页面里建项目 ──
  const clipIds = await store(page, `
    const ids = [];
    for (const c of args[0]) {
      const clip = S.actions.addClipOnNewTrack({ index: 0, cardId: c.cardId, start: c.start, duration: c.seconds });
      if (Object.keys(c.params).length) S.actions.setClipParams(clip.id, c.params);
      ids.push(clip.id);
    }
    S.actions.select([]); S.actions.pause(); S.actions.seek(0);
    return ids;`, CLIPS.map(({ cardId, start, seconds, params }) => ({ cardId, start, seconds, params })));
  if (!check(clipIds && clipIds.length === CLIPS.length, '七张片段建成', clipIds)) throw new Error('项目没建成');
  CLIPS.forEach((c, i) => { c.id = clipIds[i]; });
  await delay(1500);
  const stored = await store(page, 'return JSON.parse(JSON.stringify(S.getState().project));');
  const project = { ...stored, fps: FPS, duration: DURATION };
  const placed = project.tracks.flatMap((t) => t.clips).map((c) => ({ id: c.id, cardId: c.cardId, start: c.start, end: c.end, hasJson: !!c.params?.json }));
  out.project = { id: project.id, width: project.width, height: project.height, fps: project.fps, duration: project.duration, clips: placed.map((c) => ({ ...c })) };
  check(project.width === PROJECT.width && project.height === PROJECT.height, '项目是 1280×720', [project.width, project.height]);
  check(CLIPS.every((c) => placed.some((p) => p.id === c.id && Math.abs(p.start - c.start) < 1e-6 && Math.abs(p.end - c.start - c.seconds) < 1e-6)), '七张片段摆在预定的位置', placed);
  check(placed.filter((p) => p.cardId === 'lottie').every((p) => p.hasJson), '五份测试素材的 JSON 文本都写进了 json 参数');
  const exportUrlFor = (origin) => `${origin}/?export=1&timeline=${encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(project)))}`;

  // ── 导出页逐帧的 SVG 文本散列 ──
  const work = path.join(TMP, 'work');
  fs.mkdirSync(work, { recursive: true });
  devEditor = await startIsolatedEditor({ port: PORTS.dev, work });
  const devOrigin = devEditor.origin.replace(/\/+$/, '');
  const domByFrame = [];
  const pngDir = path.join(OUT, 'export-png');
  fs.mkdirSync(pngDir, { recursive: true });
  const PIX_FRAMES = [3, 30, 62, 75, 96, 160, 199, 240, 262, 266, 300, 322, 353, 380, 395, 412, 440, 470, 500, 512, 530, 551].filter((f) => f < TOTAL);
  {
    pipeline = new FramePipeline({ root: path.join(work, 'dom-lib'), origin: () => devOrigin, dataRoot: work });
    let bakery = null;
    try {
      bakery = await pipeline.bakery(project);
      const keep = new Set(PIX_FRAMES);
      await bakeFrames(bakery, { out: pngDir, frames: `0-${TOTAL - 1}`, writeFrames: false, quiet: true,
        onFrame: async (f, buf) => { await bakery.page.evaluate(GRAB_SRC); domByFrame[f] = await bakery.page.evaluate(() => window.__pcLottieGrab(null)); if (keep.has(f)) await fsp.writeFile(path.join(pngDir, `${String(f).padStart(6, '0')}.png`), buf); } });
    } finally { await bakery?.close().catch(() => {}); await pipeline.close().catch(() => {}); pipeline = null; }
    const missing = []; for (let f = 0; f < TOTAL; f++) { const c = clipAt(f); if (c && !domByFrame[f]?.[c.id]) missing.push(f); }
    out.exportDom = { frames: domByFrame.filter(Boolean).length, missing: missing.length, distinct: Object.fromEntries(CLIPS.map((c) => [c.name, new Set(domByFrame.map((d) => d?.[c.id]).filter(Boolean)).size])) };
    check(missing.length === 0, '导出页每一帧都读到了在场那张卡的 SVG', missing.slice(0, 20));
    for (const c of CLIPS) check(out.exportDom.distinct[c.name] > 15, `${c.name}:导出页逐帧的画面确实在变`, out.exportDom.distinct[c.name]);
    say('export.dom', out.exportDom);
  }

  // ── stage:在线页面的可见舞台 ──
  const ids = CLIPS.map((c) => c.id);
  const readStage = async () => {
    const f = await frontStage(page);
    if (!f) return null;
    await f.evaluate(GRAB_SRC).catch(() => {});
    return f.evaluate((ids2) => {
      const d = window.__pcStageDiag?.();
      if (!d || !window.__pcLottieGrab) return null;
      const busy = ids2.filter((id) => d.settling.includes(id) || d.suppressed.includes(id) || d.awaiting.includes(id) || d.snapshots.includes(id));
      const cls = ids2.map((id) => document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]:not([data-pc-media])`)?.className ?? '').filter((c) => /pc-(settling|suppressed|awaiting|snapshot)/.test(c));
      return { role: d.role, t: d.t, busy, cls, catchUps: d.catchUps.length, placeholders: d.placeholders ?? [], hashes: window.__pcLottieGrab(ids2) };
    }, ids).catch(() => null);
  };
  const arrive = async (frame) => {
    const sec = frame / FPS;
    await store(page, 'S.actions.pause(); S.actions.seek(args[0]);', sec);
    let last = null;
    return until(`在线舞台到第 ${frame} 帧`, async () => {
      const pd = await P(page, () => window.__pcPreviewDiag?.() ?? null).catch(() => null);
      if (!pd || pd.swapInFlight) return null;
      const s = await readStage();
      if (!s || s.role !== 'front' || Math.abs(s.t - sec) > 1e-6 || s.busy.length || s.cls.length || s.catchUps) { last = null; return null; }
      const c = clipAt(frame);
      if (c && !s.hashes[c.id]) { last = null; return null; }
      const key = JSON.stringify(s.hashes);
      if (last !== key) { last = key; return null; }
      return s;
    }, 30000, 150);
  };
  await delay(3000);
  const rows = [];
  const byFrame = new Map();
  const visit = async (frame, how) => {
    const s = await arrive(frame);
    const c = clipAt(frame);
    const want = c ? domByFrame[frame]?.[c.id] : null;
    const got = s && c ? s.hashes[c.id] : null;
    rows.push({ frame, clip: c?.name, how, same: !!got && got === want });
    if (s && c) check(got === want, `在线舞台:${how}到第 ${frame} 帧(${c.name}),画面和导出页这一帧相同`, { got, want });
    if (got) { if (byFrame.has(frame)) check(byFrame.get(frame) === got, `在线舞台:第 ${frame} 帧,${how}到的和上一次到的相同`); else byFrame.set(frame, got); }
    return got;
  };
  // 往前:每张片段里取几帧;五份测试素材各取一批(0、入点/随机表达式出现的帧附近)
  const rel = [0, 1, 5, 9, 10, 11, 19, 20, 21, 25, 26, 29, 30, 31, 40, 41, 50, 59];
  const forward = [0, 1, 20, 37, 62, 63, 75, 96, 120, 149, 150, 151, 199, 240, 251];
  for (const c of CLIPS.slice(2)) for (const r of rel) forward.push(startFrame(c) + r);
  for (const f of forward) await visit(f, '往前点');
  // 往回、跨片段乱跳
  const back = [...forward].reverse().filter((_, i) => i % 2 === 0);
  for (const f of back) await visit(f, '往回或跨片段点');
  // 一帧一帧挪(拖动):navidad 中间那一段往前挪 30 帧,再往回挪 10 帧;随机顺序文字那份的 30 帧前后一帧一帧挪
  for (let f = 60; f <= 90; f++) await visit(f, '一帧一帧往前挪');
  for (let f = 89; f >= 80; f--) await visit(f, '一帧一帧往回挪');
  const tr = CLIPS.find((c) => c.name === 'textrandom');
  for (let f = startFrame(tr) + 26; f <= startFrame(tr) + 34; f++) await visit(f, '一帧一帧往前挪');
  // 播放:从几个位置各播一段,途中抽样,然后暂停
  const plays = [];
  for (const from of [45, 160, startFrame(CLIPS[2]) + 4, startFrame(CLIPS[6]) + 8]) {
    await arrive(from);
    await store(page, 'S.actions.play();');
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) { const s = await readStage(); if (s) samples.push(s); await delay(60); }
    await store(page, 'S.actions.pause();');
    await delay(400);
    let stop = null;
    await until(`播放后在线舞台停稳(从第 ${from} 帧)`, async () => { const s = await readStage(); if (!s || s.role !== 'front' || s.busy.length || s.cls.length || s.catchUps) return null; if (stop && Math.abs(stop.t - s.t) < 1e-9 && JSON.stringify(stop.hashes) === JSON.stringify(s.hashes)) return s; stop = s; return null; }, 30000, 150);
    const onGrid = (t) => Math.abs(t * FPS - Math.round(t * FPS)) < 1e-4;
    let compared = 0, same = 0, offGrid = 0, noSvg = 0;
    for (const s of samples) {
      if (!onGrid(s.t)) { offGrid++; continue; }
      const f = Math.round(s.t * FPS), c = clipAt(f);
      if (!c) continue;
      if (!s.hashes[c.id] || s.busy.includes(c.id)) { noSvg++; continue; }
      compared++; if (s.hashes[c.id] === domByFrame[f]?.[c.id]) same++;
    }
    const stopFrame = stop ? Math.round(stop.t * FPS) : null, sc = stopFrame === null ? null : clipAt(stopFrame);
    const row = { from, samples: samples.length, advanced: samples.length ? +(samples[samples.length - 1].t - samples[0].t).toFixed(3) : 0, compared, same, offGrid, noSvg, stopFrame,
      stopSame: !!stop && !!sc && onGrid(stop.t) && stop.hashes[sc.id] === domByFrame[stopFrame]?.[sc.id] };
    plays.push(row);
    check(row.advanced > 0.5, `在线舞台:从第 ${from} 帧播放 1.5 秒,时刻确实往前走了`, row);
    check(row.compared > 0 ? row.same === row.compared : true, `在线舞台:从第 ${from} 帧播放,途中落在整帧上的样本画面和导出页相同`, row);
    check(row.stopSame, `在线舞台:从第 ${from} 帧播放后暂停,停下的那一帧(第 ${stopFrame} 帧)画面和导出页相同`, row);
  }
  out.stage = { visited: rows.length, same: rows.filter((r) => r.same).length, perClip: Object.fromEntries(CLIPS.map((c) => [c.name, { visited: rows.filter((r) => r.clip === c.name).length, same: rows.filter((r) => r.clip === c.name && r.same).length }])), plays };
  say('stage', { visited: out.stage.visited, same: out.stage.same });

  // ── pixels:可见舞台的截图 ──
  if (!NO_PIXELS) {
    const stageBox = async () => {
      const f = await frontStage(page);
      const el = f ? await f.frameElement().catch(() => null) : null;
      return el ? await el.boundingBox().catch(() => null) : null;
    };
    // 把视口调到舞台摆放正好是 1:1(舞台宽 = 项目宽):和导出页的 PNG 才能逐像素比。割线法,最多 8 次
    {
      let w = 2400, prev = null, box = await stageBox();
      for (let i = 0; i < 8 && box && Math.abs(box.width - PROJECT.width) > 0.6; i++) {
        const cur = { w, sw: box.width };
        const slope = prev && prev.w !== cur.w ? (cur.sw - prev.sw) / (cur.w - prev.w) : 0.66;
        const next = Math.max(900, Math.min(3600, Math.round(w + (PROJECT.width - box.width) / (slope || 0.66))));
        prev = cur; w = next;
        await page.setViewport({ width: w, height: 1500, deviceScaleFactor: 1 });
        await delay(800);
        box = await stageBox();
      }
      out.viewport = { width: w, stageWidth: box ? +box.width.toFixed(2) : null, stageHeight: box ? +box.height.toFixed(2) : null };
      say('pixels.viewport', out.viewport);
    }
    const shot = async (frame, name) => {
      const s = await arrive(frame);
      if (!s) return null;
      await delay(250);
      const box = await stageBox();
      if (!box || box.width < 10) return null;
      const buf = await page.screenshot({ clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.floor(box.width), height: Math.floor(box.height) } });
      if (name) await fsp.writeFile(path.join(OUT, name + '.png'), buf);
      const c = clipAt(frame);
      return { png: PNG.sync.read(Buffer.from(buf)), box, hash: c ? s.hashes[c.id] : null };
    };
    /** 两张同尺寸截图:不同的像素数、通道最大差、平均差、差超过 48 的像素占比 */
    const cmpPix = (a, b) => {
      if (!a || !b || a.width !== b.width || a.height !== b.height) return { error: 'size' };
      let n = 0, max = 0, sum = 0, bad = 0; const px = a.width * a.height;
      for (let i = 0; i < a.data.length; i += 4) {
        const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
        if (d) n++; if (d > max) max = d; if (d > 48) bad++;
        sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      }
      return { differ: n, max, mad: +(sum / (px * 3)).toFixed(4), bad48: +(bad / px).toFixed(6), frac: +(n / px).toFixed(6) };
    };
    out.pixels = { seqVsJump: [], vsExport: [] };
    // 顺着挪到 对 从别处直接点到。两张的 SVG 文本散列要相同;像素允许差一点点边缘取整(浏览器只重画变了的那一块和整张重画时的取整,
    // 卡片管不到,见 docs/reports/AGENT-rr-lottie.md「还剩的一点差别」):差的像素不超过画面的 0.02%、差超过 48 的像素为 0
    for (const f of [62, 75, 96, 199, 322, 353, 395, 440, 500]) {
      await arrive(Math.max(0, f - 3)); await arrive(f - 2); await arrive(f - 1);
      const seqShot = await shot(f, null);
      await arrive(10 + (f % 7)); // 绕开
      const jumpShot = await shot(f, f % 2 === 0 ? 'stage-' + f : null);
      const d = cmpPix(seqShot?.png, jumpShot?.png);
      const row = { frame: f, clip: clipAt(f)?.name, domSame: !!seqShot?.hash && seqShot.hash === jumpShot?.hash, ...d };
      out.pixels.seqVsJump.push(row);
      check(row.domSame, '在线舞台截图:第 ' + f + ' 帧,两次到达时看得见的 SVG 文本相同', row);
      check(!d.error && d.frac <= 0.0002 && d.bad48 === 0, '在线舞台截图:第 ' + f + ' 帧,一帧一帧挪到的和从别处直接点到的像素相同(差 ≤ 0.02% 且没有差超过 48 的)', row);
    }
    // 舞台摆放是 1:1 时,再和导出页同一帧的 PNG 比。舞台底下是预览用的棋盘格、四角还有画框标记,导出的 PNG 是透明底:
    // 只比导出里完全不透明(不透明度 ≥ 250)的像素——这些像素舞台上看到的就是卡片自己的颜色,逐通道差 ≤ 2 算相同;
    // 半透明的边缘会透出棋盘格,不比。通过线:这些像素里不相同的 ≤ 0.1%、差超过 48 的为 0。
    if (out.viewport.stageWidth && Math.abs(out.viewport.stageWidth - PROJECT.width) <= 0.6) {
      for (const f of PIX_FRAMES) {
        const s = await shot(f, null);
        const ex = PNG.sync.read(fs.readFileSync(path.join(pngDir, String(f).padStart(6, '0') + '.png')));
        if (!s || s.png.width !== ex.width || s.png.height !== ex.height) { out.pixels.vsExport.push({ frame: f, error: 'size', stage: s && [s.png.width, s.png.height], export: [ex.width, ex.height] }); check(false, '在线舞台截图对导出页 PNG:第 ' + f + ' 帧尺寸对不上', out.pixels.vsExport.at(-1)); continue; }
        let opaque = 0, differ = 0, bad = 0, max = 0;
        for (let i = 0; i < ex.data.length; i += 4) {
          if (ex.data[i + 3] < 250) continue;
          opaque++;
          const d = Math.max(Math.abs(ex.data[i] - s.png.data[i]), Math.abs(ex.data[i + 1] - s.png.data[i + 1]), Math.abs(ex.data[i + 2] - s.png.data[i + 2]));
          if (d > 2) differ++; if (d > 48) bad++; if (d > max) max = d;
        }
        const row = { frame: f, clip: clipAt(f)?.name, opaque, differ, bad48: bad, max, frac: opaque ? +(differ / opaque).toFixed(6) : 0 };
        out.pixels.vsExport.push(row);
        check(opaque > 0 && row.frac <= 0.001 && bad === 0, '在线舞台截图对导出页 PNG:第 ' + f + ' 帧相符(不透明处差 > 2 的像素 ≤ 0.1%、没有差超过 48 的)', row);
      }
    } else {
      out.pixels.vsExport = '舞台摆放的宽是 ' + out.viewport.stageWidth + ',不是项目宽 ' + PROJECT.width + ',没有拿截图和导出的 PNG 逐像素比;SVG 文本散列比过了';
      say('pixels.skip-export', out.viewport);
    }
  }
  check(pageErrors.length === 0, '在线页面没有报错、没有 [lottie] 警告', pageErrors.slice(0, 4));
  out.pageErrors = pageErrors.slice(0, 5);
  out.ok = fails.length === 0;
} catch (e) {
  fails.push(`异常:${String(e?.stack ?? e).slice(0, 800)}`);
} finally {
  try { await ctx?.close(); } catch { /* 已关 */ }
  try { await browser?.close(); } catch { /* 已关 */ }
  try { await pipeline?.close(); } catch { /* 已关 */ }
  try { await devEditor?.stop(); } catch { /* 已停 */ }
  try { await hostedProxy?.close(); } catch { /* 已关 */ }
  try { await combo?.close?.(); } catch { /* 已关 */ }
  if (!KEEP) try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 留着 */ }
}
out.fails = fails;
out.seconds = +((Date.now() - started) / 1000).toFixed(1);
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2));
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(fails.length ? 1 : 0);
