/**
 * M7 纯浏览器节点的本机端到端(`docs/plan/m7-contract.md` 第 2～5 节;分支 `claude/rq-m7-node` 的验收):
 * 在线构建的编辑页(普通档、两个跨源舞台)在闲时当纯浏览器节点,连本机托管组合的真队列,认领一段 light 快照任务,
 * 在后台舞台逐帧生成快照、推素材服务(`snap` 原尺寸 + `px` 小尺寸)、清单写内容库、`task.complete`。
 *
 *   node scripts/probes/m7-node-probe.mjs [--dist <在线构建目录>] [--base-port 5780] [--out <目录>] [--keep-temp]
 *        端口:+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务(都只绑 127.0.0.1)
 *
 * 本机替身(与阿里云同形,照 `c10-browser-probe.mjs`):托管组合 + 共用的本机托管代理 `lib/hosted-proxy.mjs` 开三个源(同站跨源:pc.localhost / s1.pc.localhost / s2.pc.localhost,带策略头与 `/media-s/`),
 * `/editor/runtime-config.json` 给两个舞台源。项目由探针经 `shared/create` 直接在托管端建(自由进入)。
 *
 * 切分方:本进程里的一个 pc 档渲染节点(`createLocalNode`,真会话、真切分 `splitPlan`),凭创建者的 render 凭证连同一个托管端。
 * 它的执行器只算计划(片段 → 卡片计划,按片段清单出键)、不渲染;重度策略只收 `medium`(plan 是 medium),切出的细任务一律
 * 标 `light` —— 于是它只切分、不认领细任务(契约 D15「切分方只切分」的测试替身做法),浏览器可做的卡由队列给的浏览器指纹另出一份。
 * 内容键带本轮的随机串,不会撞上别的锁。
 *
 * 流程:建项目 → 起切分方 → 成员(Chrome 无头,普通档)凭项目名 + 口令进入 → 页面加一张重卡(`probe-slow-stepped`,每帧烧 40 ms)
 * → 页面测完、当节点报到(拿到指纹)、发清单计划 → 切分方认领计划、双份出键 → 页面认领浏览器那一份(light)→ 逐帧生成快照、推送、完成。
 *
 * 判据:页面 `__pcBrowserNode()` 的 completed ≥ 1、推了块;内容库里有这一段的清单(过 `manifestMatches`、两档齐、结果键 = 内容键 × 浏览器指纹);
 * 素材服务上每块都 complete、取回来的 HTML 的 sha256 与清单一致;页面内快照库有 snap/ 与 px/ 块;切分方一个细任务都没认领;
 * 队列里这一段 `done`、另一份(切分方指纹那一份)作废(`superseded`)。
 * 不打印令牌、口令。输出:过程写 stderr;stdout 最后一行一行 JSON `{ ok, fails, … }`。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import { spawnSync } from 'node:child_process';
import crypto, { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import './lib/localhost-dns.cjs'; // Node 这边也认得 *.localhost(托管组合对外说的是 pc.localhost)
import { startHostedProxy, proxyOrigins } from './lib/hosted-proxy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const KEEP = argv.includes('--keep-temp');
const BASE = Number(arg('--base-port', 5780));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4 };
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const ORIGINS = proxyOrigins(PORTS.editor); // 编辑器页 pc.localhost:<端口>,舞台 s1./s2.pc.localhost:<端口+1/+2>(同站跨源)
const SITE = ORIGINS.editor;
const STAGE_ORIGINS = ORIGINS.stages;
const HOSTED = `${SITE}/hosted/`;
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
const EDITOR = `${SITE}/editor`;
const SPLITTER_FP = '5b1177e5b1177e50';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-m7-node-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'shots')));
fs.mkdirSync(OUT, { recursive: true });
const deadline = Date.now() + 30 * 60_000;

const fails = [];
const out = { ok: false, run: RUN, site: SITE, out: OUT, steps: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 600)}`)); return !!cond; };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

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
function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

/* ================================================================== 托管组合 + 三个源的仿 nginx 代理(照 c10-browser-probe) */

let combo = null;
let hostedProxy = null;
async function startLocalSite() {
  for (const p of Object.values(PORTS)) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
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
    dataDir: path.join(TMP, 'hosted'), docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    docPublicUrl: `ws://pc.localhost:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {},
  });
  // 共用的本机托管代理(`lib/hosted-proxy.mjs`,full 策略:同站跨源的三个源、策略头、`/media-s/`、运行配置)
  hostedProxy = await startHostedProxy({ dist: DIST, basePort: PORTS.editor, docPort: PORTS.doc, assetPort: PORTS.asset, policy: 'full' });
  say('local.up', { site: SITE, stages: STAGE_ORIGINS, doc: PORTS.doc, asset: PORTS.asset, dist: DIST });
  return DIST;
}

/* ================================================================== 切分方(本进程里的 pc 节点:只切分、不认领细任务) */

const splitterLog = [];
async function startSplitter({ projectId, creator, codeVersion }) {
  const [{ normalizeEntry, sharedProtocols }, { createWsEndpoint }, { createLocalNode }, { createProjectClient }, { wsBaseOf }] = await Promise.all([
    import('../../server/auth/shared-config.mjs'), import('../../server/render-node/ws-transport.mjs'), import('../../server/render-node/local-node.mjs'),
    import('../../server/render-node/project-client.mjs'), import('../../server/auth/route.mjs'),
  ]);
  const entry = normalizeEntry({ url: wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render',
    deviceId: `m7n-split-${RUN}`.padEnd(16, '0'), deviceName: 'm7-node-probe 切分方' });
  const ep = createWsEndpoint({ url: entry.url, protocols: sharedProtocols(entry, { role: 'render' }), log: () => {} });
  const projects = createProjectClient(ep);
  const events = [];
  const node = createLocalNode({
    nodeId: `m7n-splitter-${RUN}`,
    node: { profile: 'pc', envFingerprint: SPLITTER_FP, codeVersions: [codeVersion], capabilities: { transcode: false, streams: false, userCards: false, graphCards: false },
      // 只收 medium:plan 是 medium,切出的细任务一律 light —— 只切分、不认领细任务
      weightPolicy: { pc: ['medium'] } },
    endpoint: ep, now: Date.now, projects: [projectId], codeVersion,
    executor: {
      async plan(planTask) {
        const { projectId: pid, projectRev } = planTask.source;
        const project = await projects.get(pid, projectRev);
        // 这一版在托管端没有快照(页面还没传上来):不可重试地失败,等页面下一版计划
        if (!project) throw Object.assign(new Error(`第 ${projectRev} 版没有项目快照`), { retryable: false });
        const fps = Number(project.fps) || 30;
        const clips = new Set(planTask.input?.clips ?? []);
        const cardPlan = [];
        for (const tr of project.tracks ?? []) for (const c of tr.clips ?? []) {
          if (!clips.has(c.id) || !c.cardId) continue;
          const first = Math.round(c.start * fps);
          const count = Math.max(1, Math.round((c.end - c.start) * fps));
          const key = `m7n-${RUN}-${c.id}`;
          cardPlan.push({ clipId: c.id, cardId: c.cardId, snapshotKey: key, contentKey: key, tier: 'shared', start: c.start, end: c.end, count,
            sampling: { firstFrame: first, phase: { numerator: 0, denominator: 1 } }, compositing: 'independent',
            capabilities: { compositing: 'independent', canvasHeavy: false } });
        }
        splitterLog.push({ at: Date.now(), plan: planTask.id, rev: projectRev, cards: cardPlan.map((c) => ({ clipId: c.clipId, count: c.count })) });
        return { entryKey: `m7n-${RUN}`, cardPlan, prerenderSet: new Set(cardPlan.map((c) => c.clipId)), weightOf: () => ({ class: 'light', estMs: null }) };
      },
      async render() { throw Object.assign(new Error('切分方不渲染'), { retryable: true }); },
    },
    sink: { has: async () => false, put: async () => ({ complete: false }) },
    onEvent: (e) => { events.push({ at: Date.now(), ...e, results: undefined }); if (events.length > 200) events.shift(); },
  });
  ep.onOpen(() => node.start());
  const timer = setInterval(() => node.tick(), 250);
  return {
    events, node,
    stop() { clearInterval(timer); try { node.stop(); } catch { /* 已停 */ } try { ep.close(); } catch { /* 已关 */ } },
  };
}

/* ================================================================== 页面 */

let browser = null;
const P = (page, fn, ...a) => page.evaluate(fn, ...a);
const shot = async (page, name) => { const f = path.join(OUT, `${name}.png`); await page.screenshot({ path: f }).catch(() => {}); return f; };
async function typeInto(page, sel, text) {
  await page.waitForSelector(sel, { visible: true, timeout: 20_000 });
  await page.click(sel);
  await page.$eval(sel, (el) => el.select());
  await page.keyboard.press('Backspace');
  if (text) await page.type(sel, text, { delay: 5 });
}
const nodeDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcBrowserNode?.() ?? null)); } catch { return null; } }).catch(() => null);

let splitter = null;
try {
  const DIST = await startLocalSite();
  const health = await (await fetch(`${SITE}/hosted/healthz`)).json().catch(() => null);
  if (!check(health?.ok, '托管端 /hosted/healthz', health)) throw new Error('托管端不通');
  // 代码版本:在线构建嵌的那一份(同一套算法,同一份源码)
  const { frameCode } = await import('../../server/frame-code.mjs');
  const codeVersion = frameCode(ROOT);
  const embedded = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => f.endsWith('.js')).some((f) => fs.readFileSync(path.join(DIST, 'assets', f), 'utf8').includes(codeVersion));
  check(embedded, '在线构建嵌的代码版本与本进程算的一致', { codeVersion: codeVersion.slice(0, 12) });

  /* ---------------------------------------------------------------- 0. 建项目、起切分方 */
  const { createSharedProject } = await import('../../server/auth/client.mjs');
  const projName = `m7节点-${RUN}`;
  const creator = { username: 'm7-creator', password: `pw-${randomBytes(6).toString('hex')}` };
  const projectPassword = `pp-${randomBytes(6).toString('hex')}`;
  const made = await createSharedProject({ base: DOC_DIRECT, name: projName, mode: 'free', creator, password: projectPassword });
  // 在线页面只加入、不新建(dce4b22b):项目要先有内容才进得去,替创建者写进一份空项目
  const { seedSharedProject } = await import('./lib-seed.mjs');
  const seeded = await seedSharedProject({ base: DOC_DIRECT, projectId: made.projectId, creator, name: projName });
  check(seeded.ok, '替创建者写进空项目', seeded);
  out.steps.project = { projectId: made.projectId, name: projName };
  splitter = await startSplitter({ projectId: made.projectId, creator, codeVersion });
  say('splitter.up', { fp: SPLITTER_FP });

  /* ---------------------------------------------------------------- 1. 成员进入(普通档) */
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  browser = await puppeteer.launch({
    headless: true, protocolTimeout: 900_000, defaultViewport: { width: 1600, height: 1000 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-gpu'],
  });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  const assetReqs = [];
  page.on('request', (r) => {
    let u;
    try { u = new URL(r.url()); } catch { return; }
    const i = u.pathname.indexOf('/media/api/asset/');
    if (i < 0) return;
    const rest = u.pathname.slice(i + '/media/api/asset/'.length).split('/');
    assetReqs.push({ method: r.method(), ns: rest[0], hash: (rest[1] ?? '').slice(0, 12), sub: rest[2] ?? '' });
  });
  await page.evaluateOnNewDocument(() => {
    if (window.top !== window) return;
    window.__pcLongTasks = [];
    try { new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__pcLongTasks.push({ at: e.startTime, ms: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch { /* 没有 */ }
  });
  await page.goto(EDITOR, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 60_000 });
  await typeInto(page, '[data-pc="join-name"]', projName);
  await typeInto(page, '[data-pc="join-username"]', 'm7-member');
  await typeInto(page, '[data-pc="join-password"]', projectPassword);
  await page.click('[data-pc="join-submit"]');
  const entered = await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 120_000 }).then(() => true, () => false);
  if (!check(entered, '成员进入项目')) throw new Error('成员没进去');
  await until('成员页双舞台握上手', async () => P(page, () => { const d = window.__pcPreviewDiag?.(); return d?.dual && d.onlineStages?.handshake === 'ok'; }), 120_000, 500);

  /* ---------------------------------------------------------------- 2. 加一张重卡,等测完、节点报到 */
  const clipId = await P(page, () => {
    const S = window.__pcStore;
    const c = S.actions.addClipOnNewTrack({ index: 0, cardId: 'probe-slow-stepped', start: 0, duration: 1 });
    S.actions.setClipParams(c.id, { burnMs: 40, label: 'm7' });
    S.actions.seek(0.5);
    return c.id;
  });
  out.steps.clip = clipId;
  const ready = await until('页面当节点、报到拿到指纹', async () => { const d = await nodeDiag(page); return d?.ready === 'ready' && d.envFingerprint ? d : null; }, 240_000, 500);
  check(ready?.eligibility?.ok, '当节点的条件成立(在线构建、普通档双舞台、Chromium、成员、测量落定)', ready?.eligibility);
  out.steps.ready = ready && { envFingerprint: ready.envFingerprint, codeVersion: ready.codeVersion?.slice(0, 12), nodeId: ready.nodeId, eligibility: ready.eligibility };
  say('node.ready', out.steps.ready ?? {});
  // 从节点报到起算主文档长任务(契约 M7-A12:生成快照期间主文档长任务 0)
  await P(page, () => { window.__pcLongTasks.length = 0; });

  /* ---------------------------------------------------------------- 3. 清单计划 → 切分 → 认领 → 完成 */
  const t0 = Date.now();
  const done = await until('页面节点完成一段', async () => { const d = await nodeDiag(page); return d?.counters?.completed >= 1 ? d : null; }, 600_000, 1000);
  const diag = done ?? (await nodeDiag(page));
  out.steps.node = diag;
  out.steps.completeMs = done ? Date.now() - t0 : null;
  const plan = await P(page, () => window.__pcPlanPublisher?.() ?? null).catch(() => null);
  out.steps.plan = plan && { last: plan.last, log: plan.log };
  out.steps.splitter = { log: splitterLog, events: splitter.events.slice(-40) };
  check(plan?.log?.some((l) => l.ok && l.node === 'ready'), '清单计划等节点报到完(node=ready)才发', plan?.log);
  check(splitterLog.length >= 1 && splitterLog.some((s) => s.cards.some((c) => c.clipId === clipId)), '切分方认领了页面的清单计划、列着这张卡', splitterLog);
  check(diag?.counters?.claims >= 1 && diag?.counters?.completed >= 1, '页面节点认领并完成至少一段', diag?.counters);
  check((diag?.upload?.pushed ?? 0) >= 2, '页面推了块(snap + px)', diag?.upload);
  check((diag?.stage?.smallFrames ?? 0) >= 1, '舞台出了小尺寸', diag?.stage);
  const fineByText = splitter.events.filter((e) => (e.type === 'completed' || e.type === 'failed' || e.type === 'dedup') && String(e.id).startsWith('snapshot:'));
  check(fineByText.length === 0, '切分方一个细任务都没做(只切分)', fineByText.slice(-5));
  // D12:本页完成的那一份认定活着,切分方那一份被作废(task.failed superseded 推给发布方)
  const online = await P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcOnlineSnapshots?.() ?? null)); } catch { return null; } }).catch(() => null);
  out.steps.online = online && { aliveKeys: online.aliveKeys, deadKeys: online.deadKeys, layers: online.layers };
  check((online?.aliveKeys ?? 0) >= 1 && (online?.deadKeys ?? 0) >= 1, '在线来源认定:浏览器那份活着、切分方那份作废(superseded)', out.steps.online);

  /* ---------------------------------------------------------------- 4. 内容库清单、素材服务上的块、页面内快照库 */
  const { normalizeEntry, sharedProtocols } = await import('../../server/auth/shared-config.mjs');
  const { createWsEndpoint } = await import('../../server/render-node/ws-transport.mjs');
  const { wsBaseOf } = await import('../../server/auth/route.mjs');
  const { createContentClient } = await import('../../server/render-node/content-client.mjs');
  const { manifestMatches } = await import('../../server/artifact-transfer.mjs');
  const { resultKeyOf } = await import('../../server/render-node/fingerprint.mjs');
  const chkEntry = normalizeEntry({ url: wsBaseOf(HOSTED), projectId: made.projectId, username: creator.username, password: creator.password, as: 'creator', role: 'page',
    deviceId: `m7n-chk-${RUN}`.padEnd(16, '0'), deviceName: 'm7-node-probe 核对' });
  const chk = createWsEndpoint({ url: chkEntry.url, protocols: sharedProtocols(chkEntry, { role: 'page' }), log: () => {} });
  await new Promise((r) => { if (chk.connected) r(); else chk.onOpen(r); });
  const content = createContentClient(chk);
  const fp = diag?.envFingerprint;
  const contentKey = `m7n-${RUN}-${clipId}`;
  const resultKey = fp ? resultKeyOf(contentKey, fp) : null;
  const item = resultKey ? await content.get('snapshot-manifest', `${resultKey}:0-29`).catch((e) => ({ error: String(e?.message ?? e) })) : null;
  const m = item?.body ?? null;
  check(m && manifestMatches(m, { kind: 'snapshot', resultKey, range: { from: 0, to: 29 } }), '内容库里有这一段的清单(过 manifestMatches,结果键 = 内容键 × 浏览器指纹)', { resultKey: resultKey?.slice(0, 12), item: item?.error ?? (m ? { v: m.v, frames: m.frames?.length, small: m.small?.length } : null) });
  check(m?.frames?.length === 30 && m?.small?.length === 30, '清单两档齐:30 帧原尺寸 + 30 帧小尺寸', { frames: m?.frames?.length, small: m?.small?.length });
  // 素材服务:按清单逐块问 chunks,取回 HTML 对哈希(凭核对连接现签的只读票据)
  const tk = await new Promise((resolve) => {
    const reqId = `tk-${RUN}`;
    chk.onMessage((msg) => { if (msg?.reqId === reqId) resolve(msg); });
    chk.send({ type: 'auth.ticket', kind: 'asset', access: 'r', reqId });
  });
  const auth = tk?.type === 'auth.ticket.ok' ? { Authorization: `Bearer ${tk.ticket}` } : {};
  let complete = 0, hashOk = 0;
  for (const [f, hash] of (m?.frames ?? []).slice(0, 30)) {
    const c = await (await fetch(`${SITE}/media/api/asset/snap/${hash}/chunks`, { headers: auth })).json().catch(() => null);
    if (c?.complete) complete++;
    if (f < 3) {
      const body = Buffer.from(await (await fetch(`${SITE}/media/api/asset/snap/${hash}`, { headers: auth })).arrayBuffer());
      if (sha256(body) === hash) hashOk++;
    }
  }
  let smallComplete = 0;
  for (const [, hash] of (m?.small ?? [])) {
    const c = await (await fetch(`${SITE}/media/api/asset/px/${hash}/chunks`, { headers: auth })).json().catch(() => null);
    if (c?.complete) smallComplete++;
  }
  check(complete === 30 && hashOk === 3 && smallComplete === 30, '素材服务上每块都 complete,取回的 HTML 哈希与清单一致', { complete, hashOk, smallComplete });
  const l2 = await P(page, () => new Promise((resolve) => {
    const r = indexedDB.open('promptcut-l2');
    r.onerror = () => resolve(null);
    r.onsuccess = () => {
      const db = r.result;
      const q = db.transaction('snapshots').objectStore('snapshots').getAllKeys();
      q.onsuccess = () => { const keys = q.result.map(String); db.close(); resolve({ snap: keys.filter((k) => k.startsWith('snap/')).length, px: keys.filter((k) => k.startsWith('px/')).length }); };
      q.onerror = () => { db.close(); resolve(null); };
    };
  })).catch(() => null);
  check(l2 && l2.snap >= 30 && l2.px >= 30, '页面内快照库有自产的 snap/ 与 px/ 块', l2);
  // 小尺寸看一眼(第一帧的 WebP 写到输出目录)
  if (m?.small?.[0]) {
    const webp = Buffer.from(await (await fetch(`${SITE}/media/api/asset/px/${m.small[0][1]}`, { headers: auth })).arrayBuffer());
    fs.writeFileSync(path.join(OUT, 'small-frame-0.webp'), webp);
    out.steps.smallFirst = { bytes: webp.length, riff: webp.subarray(0, 4).toString('latin1'), webp: webp.subarray(8, 12).toString('latin1') };
    check(out.steps.smallFirst.riff === 'RIFF' && out.steps.smallFirst.webp === 'WEBP', '小尺寸是 WebP', out.steps.smallFirst);
  }
  const longTasks = await P(page, () => window.__pcLongTasks.slice()).catch(() => []);
  // M7-A12(生成快照期间主文档长任务 0)只记不判:长任务受机器忙闲影响,带耗时门槛的项在笔记本判(verification.md「性能基准机」)
  out.steps.page = { longTasks: longTasks.length, worst: longTasks.sort((a, b) => b.ms - a.ms).slice(0, 3), errors: pageErrors.slice(0, 5), assetWrites: assetReqs.filter((a) => a.method === 'PUT').length };
  await shot(page, 'm7-node-after');

  /* ---------------------------------------------------------------- 5. 让路(D8):生成快照中开始播放 → 当前帧做完放回一次;停下后恢复、做完 */
  const clip2 = await P(page, () => {
    const S = window.__pcStore;
    const c = S.actions.addClipOnNewTrack({ index: 0, cardId: 'probe-slow-stepped', start: 0, duration: 2 });
    S.actions.setClipParams(c.id, { burnMs: 40, label: 'm7-yield' });
    S.actions.seek(1.5);
    return c.id;
  });
  const baking = await until('第二张卡开始生成快照(做了至少 2 帧)', async () => {
    const d = await nodeDiag(page);
    const h = d?.holding?.[0];
    return d?.state === 'baking' && h && h.done >= 2 && h.of === 60 ? d : null;
  }, 300_000, 200);
  const before = baking?.counters ?? null;
  await P(page, () => { const S = window.__pcStore; S.actions.seek(0); S.actions.play(); });
  const released = await until('播放开始后放回一次', async () => { const d = await nodeDiag(page); return (d?.counters?.released?.['yield-play'] ?? 0) >= 1 ? d : null; }, 60_000, 100);
  await delay(2500);
  const during = await nodeDiag(page);
  await P(page, () => window.__pcStore.actions.pause());
  const after = await until('停下后恢复认领、做完第二张卡', async () => { const d = await nodeDiag(page); return d?.counters?.completed >= 2 ? d : null; }, 600_000, 1000);
  out.steps.yield = {
    clip: clip2,
    before: before && { claims: before.claims, bakedFrames: before.bakedFrames },
    released: released && { released: released.counters.released, claims: released.counters.claims, bakedFrames: released.counters.bakedFrames },
    during: during && { claims: during.counters.claims, bakedFrames: during.counters.bakedFrames, state: during.state, idle: during.idle },
    after: after && { claims: after.counters.claims, completed: after.counters.completed, bakedFrames: after.counters.bakedFrames, failed: after.counters.failed },
  };
  check(released && released.counters.released['yield-play'] === 1, 'D8:播放开始后放回恰好一次(reason yield-play)', out.steps.yield.released);
  check(released && before && released.counters.bakedFrames - before.bakedFrames <= 1, 'D8:放回之前至多再做完当前这一帧', out.steps.yield);
  check(during && released && during.counters.claims === released.counters.claims && during.counters.bakedFrames === released.counters.bakedFrames,
    'D8:播放期间不认领、不生成快照', out.steps.yield.during);
  check(after && after.counters.failed === 0, '停下后恢复认领并做完(不计失败)', out.steps.yield.after);
  // 重新认领同一段只补缺的帧:两段一共 30 + 60 帧,放回前做过的不重做
  check(after && after.counters.bakedFrames === 90, '重新认领同一段只补缺的帧(两段共生成 90 帧)', out.steps.yield.after);
  try { chk.close(); } catch { /* 已关 */ }
  out.ok = fails.length === 0;
} catch (e) {
  fails.push(`异常:${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  try { splitter?.stop(); } catch { /* 已停 */ }
  try { await browser?.close(); } catch { /* 已关 */ }
  try { await hostedProxy?.close(); } catch { /* 已关 */ }
  try { await combo?.close?.(); } catch { /* 已关 */ }
  if (!KEEP) try { fs.rmSync(path.join(TMP, 'hosted'), { recursive: true, force: true }); } catch { /* 留着 */ }
}
out.fails = fails;
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(fails.length ? 1 : 0);
