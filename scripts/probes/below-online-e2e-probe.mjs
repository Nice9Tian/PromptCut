/**
 * 在线页面读依赖下层的流的整条链(任务书 `docs/plan/render-refactor-task.md`「戊二」的第四块「下层四」)。
 *
 *   node scripts/probes/below-online-e2e-probe.mjs [--dist <在线构建目录>] [--base-port 27180] [--out <目录>] [--keep-temp] [--no-video]
 *        端口(整段 +0～+9):+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务、+5～+7 桌面编辑器(及它的舞台端口)。都只绑 127.0.0.1。
 *
 * 角色都在本机,页面用**在线构建**(隔离的跨源舞台也在链路里),骨架照 `browser-stream-e2e-probe.mjs`:
 *   - 文档服务 + 素材服务:进程内的托管组合,经本机托管代理开三个同站跨源的源;
 *   - 切分方:真的桌面预渲染进程(队列模式、测试指纹、流开着、**认领细任务** —— 依赖下层的流只能由它产);
 *   - 甲:在线页面,建场景、播放、暂停、拖动、改下层;
 *   - 乙:另一个浏览器里的在线页面,甲那边的流产完(并改过一次)之后才进来。
 *
 * 场景(1280×720、30 fps、3 秒):最上面一张毛玻璃卡(里程表 `odometer`,审阅表里依赖下层;第 6 帧入场,不在分段边界上),
 * 压在一张会动的卡(粒子 `particles`)和一段视频(去掉颜色只留明暗的测试图样)上。
 * 在线页面里一张卡判不判重由测量定,里程表测出来是轻卡;探针在测量落定后把它那条成本记录(页面内快照库的 `costs` 表)标成人工钉重
 * (`pinnedHeavy`,判重的现成口子)再刷新页面。下面那张卡不动它(照测量的结果;多半是轻卡,一直活渲)。
 *
 * 断言(任一不成立退出码 1):
 *   A 产      甲的清单计划里有毛玻璃卡;切分方按**自己的指纹**出这种流的任务并自己做完(稀疏、满密度);甲的浏览器节点一个这种任务都没碰;
 *             层表里有这张卡的一行:`kind: below`、`plane: stage`、候选只有切分方的指纹、带输入签名;流清单每段齐、满密度、头里 `kind: below`
 *   B 就绪    甲的在线来源认出这条流(`kind: below`,选中的是切分方那一份),分段就绪,没有过期的
 *   C 播放    甲播放:舞台诊断里这张卡的轨道 `plane: "stage"`、`kind: "below"`、`fits: true`,字节是父页推的,在出帧、跟着播放头;包裹层被抑制;
 *             父页发的流平面带 `plane: stage`;画布挂在舞台根下,不在包裹层里
 *   D 拖动    按住标尺拖到若干帧(跨分段、分段的第一帧和上一段的最后一帧、往回):每一帧流画出这一帧(满密度)、卡被抑制、没有占位符和快照;
 *             截图记下来,和 E 的参照比
 *   E 像素    参照是**精确活渲**:这张卡还没钉重(轻卡,一直活渲)时,同一个场景停在每一帧截的图(旧的一版在甲那里截,改过下层的一版在乙钉重之前截)。
 *             拖动时贴流的那一张只看毛玻璃卡那一块:与同一帧的参照的平均差在编码误差的量级(≤ 4,满分 255),比它与前一帧、后一帧的参照都像,
 *             比它与隔 8 帧的参照明显更像。另外记一个数(不判):同一帧钉重以后停下追到的活渲与贴流那一张的差 —— 重卡停下追帧走的是另一条路,
 *             入场动画没放完的帧上它比轻卡时的活渲多走一帧(`main` 上就有,`docs/reports/AGENT-rr-below-paste.md` 第 7 节第 3 条)
 *   F 暂停    播放中暂停:停下的那一刻卡还贴着流(抑制、舞台平面),随后追到精确活渲、不再抑制
 *   G 改下层  甲把下面那张卡的参数改一处:父页当场不再发旧流的流平面(记毫秒),在线来源把旧流撤了,舞台上没有旧键的轨道;
 *             切分方按新的一版重产,层表换成新的一行(内容键、签名都换了),甲认出新流并贴它;像素同 E 那样比(新流对新一版的活渲)
 *   H 后来的  乙后进来(同样把这张卡钉重、刷新):不等任何人,直接认出这条流、贴它(`plane: stage`、`kind: below`、`fits: true`),像素同 E
 *   I 没有页面错误
 * 耗时只记录。不打印令牌、口令。输出:过程写 stderr;stdout 最后一行一行 JSON `{ ok, fails, ... }`;截图在 `--out/`。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawnSync } from 'node:child_process';
import crypto, { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PNG } from 'pngjs';
import dnsShim from './lib/localhost-dns.cjs';
import { startHostedProxy, proxyOrigins } from './lib/hosted-proxy.mjs';
import { resumeRecord, plantResume } from './lib/online-resume-entry.mjs';
import { startQueueEditor, viteBin, portFree } from './m8/procs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const KEEP = argv.includes('--keep-temp');
const WITH_VIDEO = !argv.includes('--no-video');
const BASE = Number(arg('--base-port', 27180));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4, desk: BASE + 5 };
const BAND = [BASE, BASE + 9];
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const ORIGINS = proxyOrigins(PORTS.editor);
const SITE = ORIGINS.editor;
const HOSTED = `${SITE}/hosted/`;
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
const EDITOR = `${SITE}/editor`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-below-online-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'out')));
fs.mkdirSync(OUT, { recursive: true });
const deadline = Date.now() + 60 * 60_000;
process.env.NODE_OPTIONS = dnsShim.withLocalhostDns(process.env.NODE_OPTIONS);

const PROJECT = { width: 1280, height: 720, fps: 30, duration: 3 };
const FPS = PROJECT.fps, SEG = 15;
const DURATION = PROJECT.duration;
/** 毛玻璃卡的第一帧(0.2 秒):这条流的分段从它起数 */
const GLASS_START = 0.2, FIRST = Math.round(GLASS_START * FPS);
const TOTAL = DURATION * FPS;
const LAST_SEGMENT = Math.floor((TOTAL - 1 - FIRST) / SEG);
/** 里程表按 1920×1080 设计:小画幅时整张卡按比例缩 */
const GLASS_FRAME = { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: PROJECT.width / 1920 };
const MOVER_PARAMS = { color: '#30ff60', quantity: 120, speed: 1.5, size: 4, links: 'yes', seed: 3 };
const MOVER_EDIT = { color: '#ff5a30' };
/** 拖动落的帧:分段中间、分段的最后一帧(20)和下一段的第一帧(21)、再往后两段、往回 */
const DRAG = [28, 20, 21, 47, 66, 36];
const FAR = 8;

const fails = [];
const out = { ok: false, run: RUN, site: SITE, out: OUT, video: WITH_VIDEO };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 700)}`)); return !!cond; };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
const short = (k) => String(k ?? '').slice(0, 12);

async function until(label, fn, timeoutMs, everyMs = 300, quiet = false) {
  const end = Math.min(Date.now() + timeoutMs, deadline);
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) { if (!quiet) fails.push(`超时:${label}`); return null; }
    await delay(everyMs);
  }
}

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
  say('local.up', { site: SITE, stages: ORIGINS.stages, dist });
  return dist;
}

/** 给刚建好的共享项目写进一份空项目(替创建者的桌面版) */
async function seedProject({ projectId, creator, name }) {
  const { buildAuthProtocols } = await import('../../server/auth/client.mjs');
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId, username: creator.username, deviceId: 'blo-seed-node-0001', deviceName: 'probe-seed', as: 'creator', password: creator.password, role: 'page' });
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
    const body = { version: 1, id: `seed-${projectId.slice(-8)}`, name, ...PROJECT, themeId: 'dark', media: [], tracks: [{ id: 't-1', name: '序列 1', clips: [] }] };
    const seeded = await ask({ type: 'project.op', projectId, opId: randomBytes(16).toString('base64url'), ops: [{ op: 'set', path: '', value: body }] });
    const bad = (m) => /error|reject/i.test(String(m?.type ?? ''));
    return { ok: !bad(opened) && !bad(seeded) };
  } finally { ws.close(); }
}

/* ================================================================== 页面 */

const EVAL_TIMEOUT_MS = 30_000;
const P = (page, fn, ...a) => Promise.race([page.evaluate(fn, ...a), delay(EVAL_TIMEOUT_MS).then(() => { throw new Error('页面 30 秒没应答'); })]);
const store = (page, src, ...a) => P(page, (s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
const nodeDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcBrowserNode?.() ?? null)); } catch { return null; } }).catch(() => null);
const onlineDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcOnlineSnapshots?.() ?? null)); } catch { return null; } }).catch(() => null);
const parentDiag = (page) => P(page, () => {
  const d = window.__pcPreviewDiag?.();
  return d ? { suppressed: d.suppressed, heavy: d.snapshotFeed?.heavy ?? [], scrub: d.snapshotFeed?.scrub ?? [], streams: d.snapshotFeed?.streams ?? [], staleBelow: d.snapshotFeed?.staleBelow ?? [],
    picks: (d.snapshotFeed?.picks ?? []).map((p) => p.clipId), settled: d.snapshotFeed?.settled ?? [], settledAll: !!d.snapshotFeed?.settledAll } : null;
}).catch(() => null);
/** 父页这一刻给这张卡发的流平面(按当前播放头现算的那一份,`snapshotFeedDebug` 的 `streams`) */
const planeOf = (p, id) => (p?.streams ?? []).find((x) => (x.clipIds ?? []).join() === id) ?? null;
const storeT = (page) => store(page, `return S.getState().t;`);
const frameOf = (t) => Math.floor(t * FPS + 1e-6);
const playFrom = (page, t) => store(page, `S.actions.pause(); S.actions.seek(args[0]); S.actions.play(); return true;`, t);
const pauseAt = (page, t) => store(page, `S.actions.pause(); S.actions.seek(args[0]); return true;`, t);
const stageFrames = (page) => page.frames().filter((f) => /[?&]stage=1/.test(f.url()));
async function visibleStage(page) {
  for (const f of stageFrames(page)) {
    const el = await f.frameElement().catch(() => null);
    const vis = el ? await el.evaluate((e) => { const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5 && e.getBoundingClientRect().width > 10; }).catch(() => false) : false;
    if (vis) return f;
  }
  return stageFrames(page)[0] ?? null;
}
/** 可见舞台此刻的样子:这张卡的包裹层、它的流轨道(种类、平面、对不对得上)、画布挂在哪、舞台的时刻 */
async function stageState(page, id) {
  const f = await visibleStage(page);
  if (!f) return null;
  return f.evaluate((cid) => {
    const diag = window.__pcStageDiag?.() ?? null;
    const tracks = (diag?.streams?.tracks ?? []).map((t) => ({ id: t.id, key: t.key ?? null, clips: String(t.id).split('#')[0].split(','), pushed: !!t.pushed, drawn: t.drawn, lastDrawn: t.lastDrawn,
      level: t.level ?? null, stale: !!t.stale, plane: t.plane ?? null, kind: t.kind ?? null, fits: t.fits ?? null, decoder: t.decoder, errors: t.errors, lastError: t.lastError || null, bound: t.bound ?? null }));
    const w = document.querySelector(`[data-pc-clip="${cid}"]:not([data-pc-media])`);
    let clip = { wrapper: false };
    if (w) {
      const snap = w.querySelector(':scope > [data-pc-snapshot-plane]');
      const slot = w.querySelector(':scope > [data-pc-placeholder-slot]');
      const planes = [...document.querySelectorAll('[data-pc-group-plane]')];
      const visible = (el) => { const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
      clip = { wrapper: true, suppressed: w.classList.contains('pc-suppressed'), snapshot: !!snap && snap.childElementCount > 0 && getComputedStyle(snap).visibility !== 'hidden',
        placeholder: !!slot && !slot.hidden, canvasInWrapper: !!w.querySelector(':scope > canvas[data-pc-stream-plane]'),
        stagePlanes: planes.length, stagePlaneShown: planes.some(visible), stream: tracks.find((t) => t.clips.includes(cid)) ?? null };
    }
    const cards = [...document.querySelectorAll('[data-pc-clip]:not([data-pc-media])')].map((el) => {
      const slot = el.querySelector(':scope > [data-pc-placeholder-slot]');
      const snap = el.querySelector(':scope > [data-pc-snapshot-plane]');
      return { id: el.getAttribute('data-pc-clip'), suppressed: el.classList.contains('pc-suppressed'), placeholder: !!slot && !slot.hidden,
        snapshot: !!snap && snap.childElementCount > 0 && getComputedStyle(snap).visibility !== 'hidden' };
    });
    return { t: diag?.t ?? null, clip, cards, tracks, origin: location.origin };
  }, id).catch(() => null);
}
async function stageShot(page, name) {
  const f = await visibleStage(page);
  const el = f ? await f.frameElement().catch(() => null) : null;
  const box = el ? await el.boundingBox().catch(() => null) : null;
  if (!box || box.width < 10) return null;
  const file = name ? path.join(OUT, `${name}.png`) : undefined;
  const buf = await page.screenshot({ ...(file ? { path: file } : {}), clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.floor(box.width), height: Math.floor(box.height) } });
  return PNG.sync.read(Buffer.from(buf));
}
/** 两张图在 `rect`(占画面的比例 `{ x, y, w, h }`,缺省整幅)里的平均绝对差(每通道,0～255) */
function meanDiff(a, b, rect = null) {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const x0 = rect ? Math.max(0, Math.floor(rect.x * w)) : 0, y0 = rect ? Math.max(0, Math.floor(rect.y * h)) : 0;
  const x1 = rect ? Math.min(w, Math.ceil((rect.x + rect.w) * w)) : w, y1 = rect ? Math.min(h, Math.ceil((rect.y + rect.h) * h)) : h;
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * a.width + x) * 4, j = (y * b.width + x) * 4;
    sum += Math.abs(a.data[i] - b.data[j]) + Math.abs(a.data[i + 1] - b.data[j + 1]) + Math.abs(a.data[i + 2] - b.data[j + 2]);
    n += 3;
  }
  return n ? +(sum / n).toFixed(3) : null;
}

/** 页面内快照库的成本记录(`src/online/l2.ts` 的 `costs` 表):读全部的键;`pin` 给了就把这些身份的记录标成人工钉重 */
const costRecords = (page, pin = null) => P(page, async (pinKeys) => {
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open('promptcut-l2'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try {
    if (!db.objectStoreNames.contains('costs')) return [];
    const all = await new Promise((resolve, reject) => { const r = db.transaction('costs', 'readonly').objectStore('costs').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    if (pinKeys) {
      const tx = db.transaction('costs', 'readwrite');
      for (const row of all) if (pinKeys.includes(row.record?.identityKey)) tx.objectStore('costs').put({ ...row, record: { ...row.record, pinnedHeavy: true } });
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    }
    return all.map((row) => ({ identityKey: row.record?.identityKey ?? null, stepMs: row.record?.stepMs ?? null, pinnedHeavy: row.record?.pinnedHeavy === true || (!!pinKeys && pinKeys.includes(row.record?.identityKey)) }));
  } finally { db.close(); }
}, pin);

let browserA = null, browserB = null, editor = null, chk = null;
const LAUNCH_ARGS = ['--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--site-per-process', '--window-position=-32000,-32000'];

async function enter(page, who) {
  await page.goto(EDITOR, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const entered = await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 120_000 }).then(() => true, () => false);
  if (!check(entered, `${who} 进入项目`)) throw new Error(`${who} 没进去`);
  await until(`${who} 的页面双舞台握上手`, async () => P(page, () => { const d = window.__pcPreviewDiag?.(); return d?.dual && d.onlineStages?.handshake === 'ok'; }), 120_000, 500);
  await until(`${who} 测完(加载遮罩退下)`, () => P(page, () => !document.querySelector('[data-pc="probe-gate"]')), 300_000, 300);
}
async function openMember(browser, { projectId, name, username, password, deviceId }) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.message ?? e).slice(0, 240)));
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.25 });
  await plantResume(page, await resumeRecord({ base: HOSTED, derivationBase: `${DOC_DIRECT}/`, projectId, name, username, password, deviceId }));
  await enter(page, username);
  return { ctx, page };
}

/** 等这张卡停下追到精确活渲(不抑制、没有快照、没有占位符),截一张 */
async function liveShot(page, id, frame, name = null) {
  await store(page, `S.actions.pause(); return true;`);
  await delay(300);
  // 停在这一帧的起点(和按住标尺拖到这一帧时播放头落的时刻相同):轨道流每一帧是按帧的起点渲的,活渲的卡按播放头的时刻画
  const sec = frame / FPS;
  let ok = null, last = null;
  for (let round = 0; round < 5 && !ok; round++) {
    await pauseAt(page, sec);
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000 && !ok) {
      const s = await stageState(page, id);
      last = s ? { t: s.t, clip: { suppressed: s.clip.suppressed, snapshot: s.clip.snapshot, placeholder: s.clip.placeholder } } : null;
      // 场上每张卡都是活渲(下面那张卡要是判重,停下以后同样要追上)
      const live = s && s.cards.length > 0 && s.cards.every((c) => !c.suppressed && !c.snapshot && !c.placeholder);
      // 判重的卡停下以后先不可见地追帧,追上了父页才记进 `settled`(这之前包裹层不抑制、但子树还藏着)
      const p = live ? await parentDiag(page) : null;
      const caught = !!p && (p.heavy.length === 0 || p.settledAll || p.heavy.every((h) => p.settled.includes(h)));
      if (s && frameOf(s.t ?? -1) === frame && s.clip.wrapper && live && caught) ok = s;
      else await delay(100);
    }
  }
  if (!ok) { fails.push(`等不到:停在第 ${frame} 帧后追到精确活渲 :: ${JSON.stringify(last).slice(0, 300)}`); return null; }
  await delay(450);
  return stageShot(page, name);
}
/** 一组帧的精确活渲(这张卡是轻卡时截;停在每一帧、等场上的卡都活渲着、视频落位) */
async function liveRefs(page, id, frames, tag) {
  const refs = new Map();
  for (const f of [...new Set(frames)].filter((x) => x >= 0 && x < TOTAL).sort((x, y) => x - y)) {
    const png = await liveShot(page, id, f, KEEP_REFS.has(f) ? `${tag}-ref-${f}` : null);
    if (png) refs.set(f, png);
  }
  return refs;
}
const KEEP_REFS = new Set([28, 40, 66]);
/** 比像素要的帧:每个要比的帧、它的前一帧后一帧、隔 `FAR` 帧的那一帧 */
const refFramesFor = (frames) => frames.flatMap((f) => [f - 1, f, f + 1, f + FAR < TOTAL - 1 ? f + FAR : f - FAR]);

/** 这一刻这张卡是不是它的流在画(舞台平面、种类对得上) */
const drawing = (s, key = null) => {
  const t = s?.clip?.stream;
  return t && typeof t.lastDrawn === 'number' && s.clip.suppressed && (!key || t.key === key) ? t : null;
};
const trackBrief = (t) => t && { key: short(t.key), plane: t.plane, kind: t.kind, fits: t.fits, level: t.level, pushed: t.pushed, lastDrawn: t.lastDrawn, drawn: t.drawn, errors: t.errors, lastError: t.lastError };

/** 播一段、边播边采样;回 `{ samples, drawn }`(`drawn`:这张卡的流在画的样本)。播完不停 */
async function playAndSample(page, id, { from, to, key }) {
  await playFrom(page, from);
  const samples = [];
  const t0 = Date.now();
  let started = false;
  while (Date.now() - t0 < 25_000) {
    const s = await stageState(page, id);
    if (!s) { await delay(40); continue; }
    if (!started) { if ((s.t ?? -1) >= from - 0.05 && (s.t ?? 99) <= from + 0.6) started = true; else { await delay(20); continue; } }
    if ((s.t ?? 0) >= to) break;
    samples.push(s);
    await delay(40);
  }
  const drawn = samples.filter((s) => { const t = drawing(s, key); return t && t.lastDrawn <= Math.round((s.t ?? 0) * FPS) + 3; });
  return { samples, drawn };
}
/** 播放时这条流在画:舞台平面、种类 below、对得上、父页推的字节、跟着播放头;包裹层抑制着、画布不在包裹层里 */
function checkPlaying(who, r, key) {
  const a = r.drawn[0]?.clip.stream, b = r.drawn[r.drawn.length - 1]?.clip.stream;
  const last = r.drawn[r.drawn.length - 1] ?? null;
  const brief = { samples: r.samples.length, drawn: r.drawn.length, from: trackBrief(a), to: trackBrief(b), tTo: last?.t ?? null };
  check(r.drawn.length >= 6, `${who}:播放中这条流在画的样本够多`, brief);
  if (!a || !b) return brief;
  check(b.key === key, `${who}:舞台上画的就是这条流`, brief.to);
  check(r.drawn.every((s) => s.clip.stream.plane === 'stage' && s.clip.stream.kind === 'below' && s.clip.stream.fits === true), `${who}:舞台诊断里这条轨道 plane: stage、kind: below、fits: true`, brief.to);
  check(b.pushed === true, `${who}:流的字节是父页推给舞台的`, brief.to);
  check(b.drawn > a.drawn && b.lastDrawn > a.lastDrawn && Math.abs(b.lastDrawn - Math.round(last.t * FPS)) <= 3, `${who}:流播放器在出帧、画着的那一帧跟着播放头`, brief);
  check((b.errors ?? 0) === 0, `${who}:流播放器没有报错`, brief.to);
  check(r.drawn.every((s) => s.clip.suppressed && !s.clip.canvasInWrapper && s.clip.stagePlaneShown), `${who}:包裹层一直被抑制,画布挂在舞台根下(不在包裹层里)、露着`,
    r.drawn.filter((s) => !(s.clip.suppressed && !s.clip.canvasInWrapper && s.clip.stagePlaneShown)).slice(0, 2).map((s) => s.clip));
  const late = r.drawn.filter((s) => s.clip.placeholder && s.t > (r.drawn[0].t ?? 0) + 0.7);
  check(late.length === 0, `${who}:起播 0.7 秒之后没有占位符`, late.map((s) => s.t));
  check(r.drawn.filter((s) => s.clip.snapshot).length === 0, `${who}:流在画的时候没有快照露着`);
  return brief;
}

/* ================================================================== 开跑 */

try {
  const dist = await startLocalSite();
  const health = await (await fetch(`${SITE}/hosted/healthz`)).json().catch(() => null);
  if (!check(health?.ok, '托管端 /hosted/healthz', health)) throw new Error('托管端不通');
  const { frameCode } = await import('../../server/frame-code.mjs');
  const codeVersion = frameCode(ROOT);
  const embedded = fs.readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js')).some((f) => fs.readFileSync(path.join(dist, 'assets', f), 'utf8').includes(codeVersion));
  if (!check(embedded, '在线构建嵌的代码版本与本进程算的一致(--dist 要是当前这份源码构建的)', { codeVersion: codeVersion.slice(0, 12) })) throw new Error('在线构建不是这份源码的');

  const M = {
    createSharedProject: (await import('../../server/auth/client.mjs')).createSharedProject, wsBaseOf: (await import('../../server/auth/route.mjs')).wsBaseOf,
    normalizeEntry: (await import('../../server/auth/shared-config.mjs')).normalizeEntry, sharedProtocols: (await import('../../server/auth/shared-config.mjs')).sharedProtocols,
    createWsEndpoint: (await import('../../server/render-node/ws-transport.mjs')).createWsEndpoint, createContentClient: (await import('../../server/render-node/content-client.mjs')).createContentClient,
    manifestMatches: (await import('../../server/artifact-transfer.mjs')).manifestMatches, resultKeyOf: (await import('../../server/render-node/fingerprint.mjs')).resultKeyOf,
    createAssetClient: (await import('../../server/asset-store/client.mjs')).createAssetClient,
  };
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  const launch = () => puppeteer.launch({ headless: true, protocolTimeout: 900_000, args: [...PROBE_CHROME_ARGS, ...LAUNCH_ARGS] });
  [browserA, browserB] = await Promise.all([launch(), launch()]);

  const t0 = Date.now();
  const deskFp = crypto.createHash('sha256').update(`blo-desk-${RUN}`).digest('hex').slice(0, 16);

  /* ---------------------------------------------------------------- 0. 建项目、起桌面预渲染进程当切分方(认领细任务、流开着) */
  const projName = `下层四-${RUN}`;
  const creator = { username: 'blo-creator', password: `pw-${randomBytes(6).toString('hex')}` };
  const projectPassword = `pp-${randomBytes(6).toString('hex')}`;
  const made = await M.createSharedProject({ base: DOC_DIRECT, name: projName, mode: 'free', creator, password: projectPassword });
  const projectId = made.projectId;
  check((await seedProject({ projectId, creator, name: projName })).ok, '替创建者写进空项目');
  const editorDir = path.join(OUT, 'editor');
  for (const d of ['card-overrides', 'projects', 'work']) fs.mkdirSync(path.join(editorDir, d), { recursive: true });
  const sharedConfig = path.join(editorDir, 'shared.json');
  const deskDevice = `blo-desk-${RUN}`.padEnd(16, '0');
  fs.writeFileSync(sharedConfig, JSON.stringify([{ url: M.wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render', deviceId: deskDevice, deviceName: '下层四探针 桌面' }]));
  editor = await startQueueEditor({ port: PORTS.desk, dir: editorDir, sharedConfig, fakeFingerprint: deskFp, band: BAND, extraEnv: {
    PROMPTCUT_CARD_OVERRIDES: path.join(editorDir, 'card-overrides'), PROMPTCUT_PROJECTS_DIR: path.join(editorDir, 'projects'), PROMPTCUT_WORK_DIR: path.join(editorDir, 'work'),
    PROMPTCUT_DEVICE_ID: deskDevice, PROMPTCUT_DEVICE_NAME: '下层四探针 桌面', PROMPTCUT_STREAMS: '1', PROMPTCUT_NO_PORT_FILE: '1' } });
  const deskQueue = await editor.waitActive();
  check(deskQueue.envFingerprint === deskFp, '桌面预渲染进程用上了测试指纹', { envFingerprint: deskQueue.envFingerprint });
  const deskStreams = (await editor.diagnostics().catch(() => null))?.streams ?? null;
  check(deskStreams?.enabled === true, '切分方的流开关开着', deskStreams && { enabled: deskStreams.enabled });
  out.desk = { envFingerprint: deskFp, upMs: Date.now() - t0 };
  say('desk.up', out.desk);

  // 核对用的连接(创建者,render 角色):内容库、票据
  const chkEntry = M.normalizeEntry({ url: M.wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render',
    deviceId: `blo-chk-${RUN}`.padEnd(16, '0'), deviceName: '下层四探针 核对' });
  chk = M.createWsEndpoint({ url: chkEntry.url, protocols: M.sharedProtocols(chkEntry, { role: 'render' }), log: () => {} });
  await new Promise((r) => { if (chk.connected) r(); else chk.onOpen(r); });
  const content = M.createContentClient(chk);
  const ticket = (access) => new Promise((resolve) => {
    const reqId = `tk-${RUN}-${Math.random().toString(36).slice(2)}`;
    chk.onMessage((msg) => { if (msg?.reqId === reqId) resolve(msg?.type === 'auth.ticket.ok' ? msg.ticket : null); });
    chk.send({ type: 'auth.ticket', kind: 'asset', access, reqId });
  });
  const getManifest = async (resultKey, from, to) => (await content.get('render-manifest', `${resultKey}:${from}-${to}`).catch(() => null))?.body ?? null;
  const spansOf = (row) => { const o = []; for (let f = 0; f <= row.lastSegment; f += row.segmentsPerTask) o.push([f, Math.min(row.lastSegment, f + row.segmentsPerTask - 1)]); return o; };

  /* ---------------------------------------------------------------- 1. 甲进入;素材、下层、毛玻璃卡 */
  const a = await openMember(browserA, { projectId, name: projName, username: 'blo-jia', password: projectPassword, deviceId: `blo-jia-${RUN}`.padEnd(16, '0') });
  const pageA = a.page;
  let videoClip = null;
  if (WITH_VIDEO) {
    // 在线页面不能导入素材(由桌面版导入):探针替上传方把视频按内容哈希放进素材服务,再在项目里登记这条素材
    const { findFfmpeg } = await import('../../server/bakery/ffmpeg.mjs');
    const ffmpeg = await findFfmpeg();
    const file = path.join(TMP, `below-${RUN}.mp4`);
    const ff = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${PROJECT.width}x${PROJECT.height}:rate=${FPS}:duration=${DURATION + 1}`,
      '-vf', 'format=gray,format=yuv420p', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(FPS), '-crf', '18', '-movflags', '+faststart', file], { encoding: 'utf8', windowsHide: true });
    if (ff.status !== 0) throw new Error(`ffmpeg 出视频失败:${String(ff.stderr).slice(-300)}`);
    const bytes = fs.readFileSync(file);
    const assets = M.createAssetClient({ base: `${SITE}/media/api/asset`, ticket: () => ticket('rw') });
    const put = await assets.put('media', bytes, { ext: 'mp4' });
    out.videoAsset = { hash: short(put.hash), size: put.size };
    videoClip = await store(pageA, `
      const m = S.actions.addMedia({ kind: 'video', name: args[0].name, url: '/@media/' + args[0].hash, hash: args[0].hash, ext: 'mp4', tiers: { original: args[0].hash }, duration: args[0].duration });
      const c = S.actions.addClipOnNewTrack({ index: 0, mediaId: m.id, start: 0, duration: args[0].duration });
      return c ? c.id : null;`, { name: `below-${RUN}.mp4`, hash: put.hash, duration: DURATION });
    check(!!videoClip, '甲的项目里加上了视频片段(素材在素材服务上)', out.videoAsset);
  }
  const moverId = await store(pageA, `
    const c = S.actions.addClipOnNewTrack({ index: 0, cardId: 'particles', start: 0, duration: args[0] });
    S.actions.setClipParams(c.id, args[1]);
    S.actions.seek(args[0] + 1);
    return c.id;`, DURATION, MOVER_PARAMS);
  // 下层测完(成本记录落进页面内的库、数目稳定)再加毛玻璃卡:新多出来的那条记录就是它的
  const stable = async (page, min) => {
    let prev = -1, since = Date.now();
    return until('成本记录落定', async () => {
      const rows = await costRecords(page);
      if (rows.length !== prev) { prev = rows.length; since = Date.now(); return null; }
      return rows.length >= min && Date.now() - since > 4000 ? rows : null;
    }, 240_000, 500);
  };
  const before = (await stable(pageA, 1)) ?? [];
  const glassId = await store(pageA, `
    const c = S.actions.addClipOnNewTrack({ index: 0, cardId: 'odometer', start: args[0], duration: args[1] });
    S.actions.setClipParams(c.id, { position: 'left', value: 86420, label: '下层四探针' });
    S.actions.setClipFrame(c.id, args[2]);
    return c.id;`, GLASS_START, DURATION - GLASS_START, GLASS_FRAME);
  const afterGlass = (await stable(pageA, before.length + 1)) ?? [];
  const glassKeys = afterGlass.map((r) => r.identityKey).filter((k) => k && !before.some((b) => b.identityKey === k));
  out.costs = { before: before.length, after: afterGlass.length, glass: glassKeys.map(short), glassStepMs: afterGlass.find((r) => glassKeys.includes(r.identityKey))?.stepMs ?? null };
  if (!check(glassKeys.length === 1, '毛玻璃卡的成本记录认出来了(加它之后新多出来的那一条)', out.costs)) throw new Error('认不出毛玻璃卡的成本记录');
  const docId = await store(pageA, `return S.getState().project.id;`);
  const order = await store(pageA, `return S.getState().project.tracks.map((t) => t.clips.map((c) => c.id));`);
  out.scene = { glassId, moverId, videoClip, order };
  check(order[0]?.[0] === glassId && order[1]?.[0] === moverId, '序列从上到下:毛玻璃卡、会动的卡、(视频)', order);
  // 钉重之前(毛玻璃卡是轻卡,一直活渲):截旧的一版的参照
  // 先刷新一次:参照要在「按最后的参数从头挂载」的页面上截(边加卡边改参数的那一页里,粒子是按改之前的参数起的头)
  await enter(pageA, 'blo-jia(刷新,截参照)');
  const lightBefore = await parentDiag(pageA);
  check(!!lightBefore, '读得到父页的诊断', lightBefore);
  const refsOld = await liveRefs(pageA, glassId, refFramesFor(DRAG), 'old');
  out.refsOld = { frames: refsOld.size, heavyThen: (await (async () => { await pauseAt(pageA, 1); await delay(300); return (await parentDiag(pageA))?.heavy ?? null; })()) };
  check(out.refsOld.heavyThen && !out.refsOld.heavyThen.includes(glassId), '截参照的时候毛玻璃卡是轻卡(活渲)', out.refsOld);
  // 钉成重卡(人工钉重的现成口子),刷新后生效:已有记录的卡不再测
  await costRecords(pageA, glassKeys);
  await enter(pageA, 'blo-jia(刷新)');
  await pauseAt(pageA, 1);
  const heavyA = await until('甲的分派表里毛玻璃卡判重', async () => { const p = await parentDiag(pageA); return p?.heavy.includes(glassId) ? p : null; }, 120_000, 500);
  check(!!heavyA, 'A:甲这一页里毛玻璃卡判重', heavyA?.heavy);
  out.heavy = heavyA?.heavy ?? null;
  const nodeA = await until('甲的节点状态落定', async () => { const d = await nodeDiag(pageA); return d && (d.ready === 'ready' || d.eligibility?.ok === false) ? d : null; }, 240_000, 500);
  const fpA = nodeA?.envFingerprint ?? null;
  say('jia.ready', { heavy: out.heavy, fp: fpA });

  /* ---------------------------------------------------------------- 2. A 产:清单计划 → 切分方出这种流、自己产 */
  const layerKey = `layers:${docId}`;
  const rowNow = async (id = glassId) => {
    const body = (await content.get('snapshot-manifest', layerKey).catch(() => null))?.body ?? null;
    return { body, row: (body?.streams ?? []).find((r) => r.topClipId === id) ?? null };
  };
  const briefRow = (row) => row && { topClipId: row.topClipId, kind: row.kind, plane: row.plane, clipIds: row.clipIds, contentKey: short(row.contentKey),
    candidates: (row.candidates ?? []).map((c) => ({ envFingerprint: c.envFingerprint, resultKey: short(c.resultKey) })), originFrame: row.originFrame ?? null, lastSegment: row.lastSegment, segmentsPerTask: row.segmentsPerTask, inputSig: row.inputSig ?? null };
  /** 等层表里出现这张卡的(不同于 `notKey` 的)一行,并且它的流清单每段都是满密度 */
  const waitRow = (label, notKey = null) => until(label, async () => {
    const x = await rowNow();
    if (!x.row || x.row.contentKey === notKey) return null;
    const cand = x.row.candidates[0];
    const manifests = [];
    for (const [from, to] of spansOf(x.row)) {
      const m = await getManifest(cand.resultKey, from, to);
      if (!m || Object.keys(m.segments ?? {}).length !== to - from + 1) return null;
      if (!Object.values(m.segments).every((seg) => seg.stride === 1)) return null;
      manifests.push(m);
    }
    return { ...x, cand, manifests };
  }, 360_000, 1000);
  const tProduce = Date.now();
  const got1 = await waitRow('A:层表里出现毛玻璃卡的流,流清单满密度齐');
  const row1 = got1?.row ?? null;
  out.produce = { ms: got1 ? Date.now() - tProduce : null, row: briefRow(row1) };
  say('below.produced', out.produce);
  if (!check(!!row1, 'A:层表里有毛玻璃卡的一行', (await rowNow()).body?.streams?.map(briefRow))) throw new Error('层表里没有这条流');
  const key1 = got1.cand.resultKey;
  check(row1.kind === 'below' && row1.plane === 'stage' && row1.clipIds.join() === glassId && /^s1-/.test(row1.inputSig ?? ''), 'A:这一行是依赖下层的流(kind below、舞台坐标、成员只有目标卡),带输入签名', out.produce.row);
  check(row1.candidates.length === 1 && row1.candidates[0].envFingerprint === deskFp && key1 === M.resultKeyOf(row1.contentKey, deskFp), 'A:候选只有切分方自己的指纹,结果键 = 内容键 × 切分方的指纹', out.produce.row);
  check(row1.originFrame === FIRST && row1.lastSegment === LAST_SEGMENT, `A:这一行的第一帧是毛玻璃卡的第一帧(第 ${FIRST} 帧),分段 0～${LAST_SEGMENT}`, out.produce.row);
  check(got1.manifests.every((m, i) => { const [from, to] = spansOf(row1)[i]; return M.manifestMatches(m, { kind: 'stream', resultKey: key1, range: { from, to } }) && m.header?.kind === 'below' && m.header?.plane === 'stage' && m.header.clipIds?.join() === glassId; }),
    'A:流清单过 manifestMatches,头里 kind below、plane stage', got1.manifests.map((m) => m.header && { kind: m.header.kind, plane: m.header.plane, tight: m.header.tight ?? null }));
  const tight = got1.manifests[0]?.header?.tight ?? got1.manifests[0]?.header?.bound ?? null;
  out.tight = tight;
  check(!!tight && tight.w * tight.h < PROJECT.width * PROJECT.height * 0.8, 'A:流只含目标卡改动的那一块(收紧矩形比整个画面小)', tight);
  const deskQ = await editor.queue().catch(() => null);
  out.desk.stats = deskQ?.stats ?? null;
  check(deskQ && deskQ.stats.planSplit >= 1 && deskQ.stats.completed >= 2, 'A:切分方切了清单计划,自己做完了流任务(稀疏、满密度)', deskQ?.stats);
  const diagA = await nodeDiag(pageA);
  out.jia = { envFingerprint: fpA, counters: diagA?.counters ?? null };
  check((diagA?.counters?.streamTasks ?? 0) === 0 && fpA !== deskFp, 'A:甲的浏览器节点没有做过流任务(这种流它认领不了)', { fpA, counters: diagA?.counters ?? null });
  // 层表里别的行(下面那张卡如果判重,会有它的单卡流)只记录
  out.otherRows = ((await rowNow()).body?.streams ?? []).filter((r) => r.topClipId !== glassId).map(briefRow);
  // 毛玻璃卡那一块占画面的比例(比像素只看这一块,四周各留一点)
  const region = tight ? { x: tight.x / PROJECT.width, y: tight.y / PROJECT.height, w: tight.w / PROJECT.width, h: tight.h / PROJECT.height } : null;

  /* ---------------------------------------------------------------- 3. B 就绪(甲) */
  await pauseAt(pageA, (30 + 0.5) / FPS);
  const readyOf = (page, key, label) => until(label, async () => {
    const d = await onlineDiag(page);
    const s = (d?.streams ?? []).find((x) => x.clipId === glassId);
    return s && (!key || s.resultKey === key) && s.ready >= 2 ? { s, d } : null;
  }, 120_000, 300);
  const readyA = await readyOf(pageA, key1, 'B:甲认出这条流、播放头附近的分段就绪');
  out.ready = readyA && { kind: readyA.s.kind, ready: readyA.s.ready, envFingerprint: readyA.s.envFingerprint, resultKey: short(readyA.s.resultKey), stale: readyA.d.staleStreams, tier: readyA.d.tier };
  check(!!readyA && readyA.s.kind === 'below' && readyA.s.envFingerprint === deskFp && readyA.d.staleStreams.length === 0, 'B:甲的在线来源里这条流 kind below,选中的是切分方那一份,没有过期的', out.ready ?? (await onlineDiag(pageA))?.streams);

  /* ---------------------------------------------------------------- 4. C 播放(甲);F 播放中暂停 */
  const playA = await playAndSample(pageA, glassId, { from: 0.5, to: 2.0, key: key1 });
  const parentPlaying = await parentDiag(pageA);
  await store(pageA, `S.actions.pause(); return true;`);
  // F:暂停的那一刻(还没追上活渲)卡仍贴着流
  const atPause = await stageState(pageA, glassId);
  out.playJia = checkPlaying('C 甲', playA, key1);
  check(planeOf(parentPlaying, glassId)?.plane === 'stage' && planeOf(parentPlaying, glassId)?.key === short(key1) && parentPlaying.suppressed.includes(glassId) && !parentPlaying.picks.includes(glassId),
    'C:父页发的流平面带 plane: stage,这张卡被抑制,没有选它的快照', parentPlaying && { streams: parentPlaying.streams, suppressed: parentPlaying.suppressed, picks: parentPlaying.picks });
  const pauseFrame = frameOf(await storeT(pageA));
  const settled = await until('F:暂停以后追到精确活渲', async () => { const s = await stageState(pageA, glassId); return s && s.clip.wrapper && !s.clip.suppressed && !s.clip.placeholder ? s : null; }, 20_000, 60);
  out.pause = { frame: pauseFrame, atPause: atPause && { suppressed: atPause.clip.suppressed, track: trackBrief(atPause.clip.stream), stagePlaneShown: atPause.clip.stagePlaneShown }, settled: !!settled };
  check(!!atPause?.clip?.stream && atPause.clip.stream.plane === 'stage' && atPause.clip.stream.kind === 'below' && atPause.clip.stream.fits === true, 'F:暂停的那一刻这张卡的流轨道还在(舞台平面、kind below)', out.pause.atPause);
  check(!!settled, 'F:暂停以后追到精确活渲,不再抑制', out.pause);

  /* ---------------------------------------------------------------- 5. D 拖动;E 像素 */
  const ruler = await P(pageA, () => {
    const el = document.querySelector('[data-pc="ruler"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const ticks = [...el.querySelectorAll('.pc-tl-tick.is-major')].map((t) => {
      const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec((t.querySelector('.pc-tl-tick-label')?.textContent ?? '').trim());
      return m ? { sec: Number(m[1]) * 60 + Number(m[2]), x: t.getBoundingClientRect().left } : null;
    }).filter(Boolean);
    const head = document.querySelector('[data-pc="playhead"]')?.getBoundingClientRect() ?? null;
    return { y: r.top + r.height / 2, ticks, headX: head ? head.left + head.width / 2 : null };
  });
  if (!ruler || ruler.ticks.length < 2) throw new Error('量不到标尺的刻度');
  const tk0 = ruler.ticks[0], tk1 = ruler.ticks[ruler.ticks.length > 2 ? 2 : 1];
  const pxPerSec = (tk1.x - tk0.x) / (tk1.sec - tk0.sec);
  let xZero = tk0.x - tk0.sec * pxPerSec;
  out.ruler = { pxPerSec: +pxPerSec.toFixed(2), framePx: +(pxPerSec / FPS).toFixed(2) };
  check(pxPerSec / FPS >= 2, '标尺上一帧至少 2 像素(指针落得准)', out.ruler);
  // 落在这一帧里最靠左的那个像素:下层是活渲的(按播放头的时刻画),离帧的起点越近,和「这一帧的精确活渲」越可比
  const xOf = (frame) => Math.ceil(xZero + (frame / FPS) * pxPerSec + 0.15);
  const moveToFrame = async (page, frame, down) => {
    let landed = null;
    for (const dx of [0, 1, -1, 2, -2, 3, -3]) {
      await page.mouse.move(xOf(frame) + dx, ruler.y);
      if (down && landed === null) await page.mouse.down();
      const end = Date.now() + 600;
      while (Date.now() < end && frameOf(await storeT(page)) !== frame) await delay(30);
      landed = frameOf(await storeT(page));
      if (landed === frame) { if (dx) xZero += dx; break; }
    }
    return landed;
  };
  /** 按住标尺依次拖到 `frames`,每一帧等流画出它、核状态、截图;回 `Map<帧, { png, state }>` */
  async function dragThrough(page, who, frames, key, tag) {
    const shots = new Map();
    const steps = [];
    await pauseAt(page, (frames[0] + 10.5) / FPS);
    await delay(600);
    await page.keyboard.down('Alt');   // 不吸附:落在哪一帧由坐标定
    try {
      for (let i = 0; i < frames.length; i++) {
        const target = frames[i];
        const landed = await moveToFrame(page, target, i === 0);
        const step = { target, landed };
        steps.push(step);
        if (!check(landed === target, `${who}:拖动第 ${i} 步落在第 ${target} 帧`, { landed })) continue;
        const s = await until(`${who}:拖到第 ${target} 帧,流画出这一帧`, async () => {
          const st = await stageState(page, glassId);
          const t = st?.clip?.stream;
          // 抑制着才是在贴流(停着没被抑制时这一帧也会先解好,那不算)
          return t && t.key === key && t.lastDrawn === target && !t.stale && frameOf(st.t ?? -1) === target && st.clip.suppressed ? st : null;
        }, 15_000, 20);
        step.offset = +(((await storeT(page)) * FPS) - target).toFixed(2);
        const p = await parentDiag(page);
        if (s) {
          const t = s.clip.stream;
          step.track = trackBrief(t);
          check(s.clip.suppressed && s.clip.stagePlaneShown && !s.clip.canvasInWrapper, `${who}:拖到第 ${target} 帧:卡被抑制,舞台根下的流平面露着`, s.clip);
          check(t.plane === 'stage' && t.kind === 'below' && t.fits === true && t.level === 'dense', `${who}:拖到第 ${target} 帧:轨道 plane stage、kind below、fits,贴的是满密度的这一帧`, step.track);
          check(!s.clip.placeholder && !s.clip.snapshot, `${who}:拖到第 ${target} 帧:没有占位符、没有快照`, s.clip);
          check((t.errors ?? 0) === 0, `${who}:拖到第 ${target} 帧:解码没有报错`, step.track);
        }
        check(!!p && p.suppressed.includes(glassId) && planeOf(p, glassId)?.plane === 'stage' && planeOf(p, glassId)?.key === short(key) && !p.picks.includes(glassId) && p.staleBelow.length === 0,
          `${who}:拖到第 ${target} 帧:父页抑制这张卡、发它的流平面(舞台坐标)、不选它的快照`, p && { suppressed: p.suppressed, streams: p.streams, picks: p.picks, staleBelow: p.staleBelow });
        await delay(120);
        const png = await stageShot(page, `${tag}-drag-${target}-stream`);
        if (png) shots.set(target, png);
      }
    } finally {
      await page.mouse.up();
      await page.keyboard.up('Alt');
    }
    return { shots, steps };
  }
  /**
   * 贴流的那一张对精确活渲(`refs`:这张卡是轻卡时停在每一帧截的)。只看毛玻璃卡那一块。
   * 另记(不判)`settle`:这一页此刻(卡钉重着)停在同一帧追到的活渲与贴流那一张的差。
   */
  /** 这一页此刻(卡钉重着)停在每一帧追到的活渲 */
  async function settledShots(page, shots, tag) {
    const m = new Map();
    for (const [frame] of shots) { const png = await liveShot(page, glassId, frame, `${tag}-settled-${frame}`); if (png) m.set(frame, png); }
    return m;
  }
  /** 入场动画放完以后的帧才按阈值判(毛玻璃卡第 6 帧入场);入场动画里的帧只记数、只判「比隔几帧的像」 */
  const SETTLED_FROM = 26;
  async function comparePixels(page, who, shots, refs, tag, settledMap = null) {
    const rows = [];
    const settledAll = settledMap ?? await settledShots(page, shots, tag);
    for (const [frame, png] of shots) {
      const farFrame = frame + FAR < TOTAL - 1 ? frame + FAR : frame - FAR;
      const same = refs.get(frame), prev = refs.get(frame - 1), next = refs.get(frame + 1), far = refs.get(farFrame);
      if (!same || !prev || !next || !far) continue;
      const settled = settledAll.get(frame) ?? null;
      rows.push({ frame, same: meanDiff(png, same, region), prev: meanDiff(png, prev, region), next: meanDiff(png, next, region), far: meanDiff(png, far, region),
        whole: meanDiff(png, same), settle: settled ? meanDiff(png, settled, region) : null, settleVsRef: settled ? meanDiff(settled, same, region) : null });
    }
    const worst = rows.length ? Math.max(...rows.map((r) => r.same)) : null;
    check(rows.length === shots.size && rows.length > 0, `${who}:每一帧都有精确活渲的参照`, { rows: rows.length, shots: shots.size });
    // 贴流的画面里:毛玻璃那一层是编码过的(H.264、上下拼合 alpha);参照里它是当场画的。差在编码误差的量级
    // 阈值 7:预览里活渲的毛玻璃(按预览的缩放光栅模糊)和按原尺寸渲出来的流本来就差四五级(`AGENT-rr-below-paste.md` 第 7 节第 4 条),不是编码误差
    const after = rows.filter((r) => r.frame >= SETTLED_FROM);
    check(after.length > 0 && after.every((r) => r.same <= 7), `${who}:贴流的画面与同一帧的精确活渲相符(入场动画放完以后的帧,毛玻璃卡那一块平均差 ≤ 7,满分 255)`, rows);
    // 下层在动(粒子、视频):贴的确实是这一帧 —— 比前一帧、后一帧的参照都像(差比最小的只多出 5% 以内算它最像),比隔几帧的更像
    check(after.every((r) => r.same <= Math.min(r.prev, r.next) * 1.05 + 0.05), `${who}:贴流的画面最像同一帧的精确活渲(比前一帧、后一帧都像;入场动画放完以后的帧)`, rows);
    check(rows.every((r) => r.far > r.same), `${who}:与隔 ${FAR} 帧的精确活渲比,差更大(对照)`, rows);
    return { rows, worst };
  }
  const dragA = await dragThrough(pageA, 'D 甲', DRAG, key1, 'jia');
  out.dragJia = dragA.steps;
  out.pixelsJia = await comparePixels(pageA, 'E 甲', dragA.shots, refsOld, 'jia');
  say('jia.pixels', { rows: out.pixelsJia.rows });

  /* ---------------------------------------------------------------- 6. G 改下层:旧流当场撤下,新流到了再贴 */
  // 停在卡上、按住标尺(拖动态:这张卡贴着旧流),这时改下面那张卡的一个参数
  await pauseAt(pageA, (50 + 0.5) / FPS);
  await delay(500);
  await pageA.keyboard.down('Alt');
  const gFrame = 40;
  let edit = null;
  try {
    const landed = await moveToFrame(pageA, gFrame, true);
    check(landed === gFrame, `G:按着标尺停在第 ${gFrame} 帧`, { landed });
    await until('G:改之前这张卡贴着旧流', async () => { const s = await stageState(pageA, glassId); return s?.clip?.stream?.key === key1 && s.clip.stream.lastDrawn === gFrame && s.clip.suppressed ? s : null; }, 15_000, 30);
    const oldShot = await stageShot(pageA, 'jia-edit-old-stream');
    // 在页面里改、当场量:从改完到父页不再发旧流的流平面
    edit = await P(pageA, async (spec) => {
      const S = window.__pcStore;
      const feed = () => window.__pcPreviewDiag?.().snapshotFeed ?? null;
      const hadBefore = (feed()?.streams ?? []).some((p) => (p.clipIds ?? []).includes(spec.glassId) && p.plane === 'stage');
      const t0 = performance.now();
      S.actions.setClipParams(spec.moverId, spec.patch);
      let goneMs = null, staleSeen = false;
      while (performance.now() - t0 < 5000) {
        const f = feed();
        const has = (f?.streams ?? []).some((p) => (p.clipIds ?? []).includes(spec.glassId));
        staleSeen = staleSeen || (f?.staleBelow ?? []).includes(spec.glassId);
        if (!has) { goneMs = performance.now() - t0; break; }
        await new Promise((r) => setTimeout(r, 4));
      }
      return { hadBefore, goneMs: goneMs === null ? null : Math.round(goneMs), staleSeen };
    }, { moverId, glassId, patch: MOVER_EDIT });
    const tEdited = Date.now();
    const withdrawn = await until('G:在线来源把旧流撤了', async () => { const d = await onlineDiag(pageA); return d && !(d.streams ?? []).some((x) => x.resultKey === key1) ? d : null; }, 10_000, 30);
    const gone = await until('G:舞台上没有旧键的轨道', async () => { const s = await stageState(pageA, glassId); return s && !s.tracks.some((t) => t.key === key1) ? s : null; }, 10_000, 30);
    // 舞台那一侧:从页面里改完(上面那一段返回)到探针读到「旧键的轨道没了」,含探针自己一来一回的耗时,只记录
    out.edit = { ...edit, sourceStale: withdrawn?.staleStreams ?? null, stageGone: !!gone, stageGoneWithinMs: gone ? Date.now() - tEdited : null, clipAfter: gone && { suppressed: gone.clip.suppressed, placeholder: gone.clip.placeholder, snapshot: gone.clip.snapshot } };
    check(edit?.hadBefore === true && edit.goneMs !== null && edit.goneMs <= 1000 && edit.staleSeen === true, 'G:改之前父页在发这条流;改下层以后当场不再发、认它过期(1 秒以内;实测毫秒记在结果里)', edit);
    check(!!withdrawn && withdrawn.staleStreams.includes(glassId), 'G:在线来源认出旧流过期、不再列它', withdrawn && { stale: withdrawn.staleStreams, streams: withdrawn.streams.map((x) => short(x.resultKey)) });
    check(!!gone, 'G:舞台上旧流的轨道关掉了', (await stageState(pageA, glassId))?.tracks.map(trackBrief));
    out.edit.oldShot = !!oldShot;
  } finally {
    await pageA.mouse.up();
    await pageA.keyboard.up('Alt');
  }
  // 旧流不再回来:马上播一小段,舞台上没有旧键的轨道
  const playOld = await playAndSample(pageA, glassId, { from: 0.5, to: 1.3, key: key1 });
  await store(pageA, `S.actions.pause(); return true;`);
  check(playOld.samples.length >= 4 && playOld.samples.every((s) => !s.tracks.some((t) => t.key === key1)), 'G:改动之后播放,旧流没有再贴上来', { samples: playOld.samples.length, old: playOld.samples.filter((s) => s.tracks.some((t) => t.key === key1)).length });
  await pauseAt(pageA, DURATION + 1);   // 停到片尾之外:甲闲下来,新一版的任务照常走
  const NEW_A = [gFrame, 28, 66], NEW_B = [28, 21, 66];
  let newDrag = null, newSettled = null;
  const tNew = Date.now();
  const got2 = await waitRow('G:层表换成新一版的流,流清单满密度齐', row1.contentKey);
  const row2 = got2?.row ?? null;
  const key2 = got2?.cand?.resultKey ?? null;
  out.reissue = { ms: got2 ? Date.now() - tNew : null, row: briefRow(row2) };
  say('below.reissued', out.reissue);
  if (check(!!row2 && key2 !== key1 && row2.kind === 'below' && row2.inputSig !== row1.inputSig && /^s1-/.test(row2.inputSig ?? '') && row2.candidates.every((c) => c.envFingerprint === deskFp),
    'G:层表换成新的一行(内容键、结果键、输入签名都换了;候选仍只有切分方)', { old: briefRow(row1), now: briefRow(row2) })) {
    await pauseAt(pageA, (30 + 0.5) / FPS);
    const readyA2 = await readyOf(pageA, key2, 'G:甲认出新流、分段就绪');
    check(!!readyA2 && readyA2.d.staleStreams.length === 0, 'G:甲的在线来源换成新流,没有过期的', readyA2 && { resultKey: short(readyA2.s.resultKey), stale: readyA2.d.staleStreams });
    const playNew = await playAndSample(pageA, glassId, { from: 0.5, to: 1.8, key: key2 });
    await store(pageA, `S.actions.pause(); return true;`);
    out.playNew = checkPlaying('G 甲·新流', playNew, key2);
    // 新流的拖动截图、停下的活渲都在乙进来之前截(乙进来以后它测出的成本记录会经共享记录传给甲,甲这张卡就不再判重);参照等乙截了再比
    newDrag = await dragThrough(pageA, 'G 甲·新流', NEW_A, key2, 'jia-new');
    newSettled = await settledShots(pageA, newDrag.shots, 'jia-new');
  }

  /* ---------------------------------------------------------------- 7. H 乙后进来,直接贴 */
  const deskBefore = (await editor.queue().catch(() => null))?.stats ?? null;
  const b = await openMember(browserB, { projectId, name: projName, username: 'blo-yi', password: projectPassword, deviceId: `blo-yi-${RUN}`.padEnd(16, '0') });
  const pageB = b.page;
  await until('乙收到这张卡', () => store(pageB, `return S.getState().project.tracks.some((t) => t.clips.some((c) => c.id === args[0]));`, glassId), 60_000, 300);
  check(await store(pageB, `return S.getState().project.tracks.some((t) => t.clips.some((c) => c.id === args[0] && c.params && c.params.color === args[1]));`, moverId, MOVER_EDIT.color), '乙拿到的是改过下层的那一版');
  // 乙这台浏览器自己测出来也是轻卡:先趁它是轻卡截新一版的参照(甲的新流、乙自己都拿它比),再把这张卡(同一个卡片身份)钉重、刷新
  await until('乙测出毛玻璃卡的成本记录', async () => ((await costRecords(pageB)).some((r) => glassKeys.includes(r.identityKey)) ? true : null), 240_000, 500);
  const refsNew = await liveRefs(pageB, glassId, refFramesFor([...NEW_A, ...NEW_B]), 'new');
  await pauseAt(pageB, 1);
  await delay(300);
  const heavyThenB = (await parentDiag(pageB))?.heavy ?? null;
  out.refsNew = { frames: refsNew.size, heavyThen: heavyThenB };
  check(heavyThenB && !heavyThenB.includes(glassId), '乙截参照的时候毛玻璃卡是轻卡(活渲)', out.refsNew);
  if (newDrag) {
    const dragNew = newDrag;
    out.dragNew = dragNew.steps;
    out.pixelsNew = await comparePixels(pageA, 'G 甲·新流', dragNew.shots, refsNew, 'jia-new', newSettled);
    say('jia.pixels-new', { rows: out.pixelsNew.rows });
    // 新流画的是新的一版:拿改之前的参照比,差明显更大
    const vsOld = [...dragNew.shots].filter(([f]) => refsOld.has(f)).map(([f, png]) => ({ frame: f, vsNew: meanDiff(png, refsNew.get(f), region), vsOld: meanDiff(png, refsOld.get(f), region) }));
    out.newVsOld = vsOld;
    check(vsOld.length > 0 && vsOld.every((r) => r.vsOld > r.vsNew * 1.2 + 0.2), 'G:新流贴的是改过以后的画面(拿改之前的精确活渲比,差明显更大)', vsOld);
  }
  await costRecords(pageB, glassKeys);
  const tEnter = Date.now();
  await enter(pageB, 'blo-yi(刷新)');
  await pauseAt(pageB, 1);
  const heavyB = await until('乙的分派表里毛玻璃卡判重', async () => { const p = await parentDiag(pageB); return p?.heavy.includes(glassId) ? p : null; }, 120_000, 500);
  check(!!heavyB, 'H:乙这一页里毛玻璃卡判重', heavyB?.heavy);
  const wantKey = key2 ?? key1;
  await pauseAt(pageB, (30 + 0.5) / FPS);
  const readyB = await readyOf(pageB, wantKey, 'H:乙认出这条流、分段就绪');
  out.yi = { readyMs: readyB ? Date.now() - tEnter : null, ready: readyB && { kind: readyB.s.kind, resultKey: short(readyB.s.resultKey), envFingerprint: readyB.s.envFingerprint, ready: readyB.s.ready, stale: readyB.d.staleStreams } };
  check(!!readyB && readyB.s.kind === 'below' && readyB.s.envFingerprint === deskFp && readyB.d.staleStreams.length === 0, 'H:乙后进来就认出切分方产的这条流(kind below),没有过期的', out.yi.ready ?? (await onlineDiag(pageB))?.streams);
  const rowB = (await rowNow()).row;
  check(rowB?.contentKey === (row2 ?? row1).contentKey, 'H:乙进来没有让这条流重产(层表里还是那一行)', { now: briefRow(rowB) });
  const playB = await playAndSample(pageB, glassId, { from: 0.5, to: 2.0, key: wantKey });
  await store(pageB, `S.actions.pause(); return true;`);
  out.playYi = checkPlaying('H 乙', playB, wantKey);
  check(new Set(ORIGINS.stages).has(playB.drawn[0]?.origin ?? playB.samples[0]?.origin), 'H:乙的舞台在自己的源上(跨源、隔离的那一种)', { origin: playB.samples[0]?.origin ?? null });
  const dragB = await dragThrough(pageB, 'H 乙', NEW_B, wantKey, 'yi');
  out.dragYi = dragB.steps;
  out.pixelsYi = await comparePixels(pageB, 'H 乙', dragB.shots, key2 ? refsNew : refsOld, 'yi');
  say('yi.pixels', { rows: out.pixelsYi.rows });
  const deskAfter = (await editor.queue().catch(() => null))?.stats ?? null;
  out.desk.duringYi = deskBefore && deskAfter ? { completed: deskAfter.completed - deskBefore.completed, planSplit: deskAfter.planSplit - deskBefore.planSplit } : null;
  const stagePx = hostedProxy.requests.filter((r) => r.role !== 'editor' && /\/px\//.test(r.path));
  check(stagePx.length === 0, '两个舞台的源一次都没请求过 px/(流的字节只由编辑器页取)', stagePx.slice(0, 3));

  /* ---------------------------------------------------------------- 8. I 页面错误 */
  out.pageErrors = { jia: pageA.errors.slice(0, 5), yi: pageB.errors.slice(0, 5) };
  check(pageA.errors.length === 0 && pageB.errors.length === 0, 'I:两个页面都没有未捕获的错误', out.pageErrors);
  out.ms = Date.now() - t0;
  out.ok = fails.length === 0;
} catch (e) {
  fails.push(`异常:${String(e?.stack ?? e).slice(0, 800)}`);
} finally {
  try { chk?.close(); } catch { /* 已关 */ }
  try { await browserA?.close(); } catch { /* 已关 */ }
  try { await browserB?.close(); } catch { /* 已关 */ }
  try { await editor?.stop(); } catch { /* 已停 */ }
  try { await hostedProxy?.close(); } catch { /* 已关 */ }
  try { await combo?.close?.(); } catch { /* 已关 */ }
  if (!KEEP) try { fs.rmSync(path.join(TMP, 'hosted'), { recursive: true, force: true }); } catch { /* 留着 */ }
}
out.fails = fails;
out.ok = fails.length === 0;
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(fails.length ? 1 : 0);
