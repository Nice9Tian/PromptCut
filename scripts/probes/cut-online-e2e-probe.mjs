/**
 * 在线页面贴剪辑段里那张卡自己的流、被引用剪辑改过之后不贴旧流的端到端探针(逐卡口径:`docs/semantics/mechanism/rendering.md`
 * 「剪辑段」、`docs/archive/agent-reports/AGENT-cut-flatten.md`「设计」;用户 2026-10-21 定 —— 剪辑段里的卡和没有剪辑段时一样,重卡各自走轨道流)。
 *
 *   node scripts/probes/cut-online-e2e-probe.mjs [--dist <在线构建目录>] [--base-port 5410] [--out <目录>] [--keep-temp]
 *        端口(整段 +0～+9):+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务、+5～+7 桌面编辑器(及它的舞台端口)。都只绑 127.0.0.1。
 *        `--dist` 不给就在临时目录现建一份(`vite build --mode online`);给的话要是当前这份源码构建的(探针核对嵌进去的代码版本)。
 *
 * 骨架照 `below-online-e2e-probe.mjs`(角色都在本机,页面用**在线构建**,隔离的跨源舞台也在链路里):
 *   - 文档服务 + 素材服务:进程内的托管组合,经本机托管代理开三个同站跨源的源;
 *   - 切分方:真的桌面预渲染进程(队列模式、测试指纹、流开着、认领细任务 —— 剪辑段里的卡的流(`solo: 'flat'`)只能由它产,浏览器节点不产);
 *   - 甲:在线页面,建场景、播放、改被引用剪辑。
 *
 * 场景(1280×720、30 fps、10 秒):剪辑「里」上一张 `punch-pill`(文字 v1);剪辑「中」上一个剪辑段引用「里」;激活剪辑上一个剪辑段 S
 * (第 0.2～2.2 秒)引用「中」—— 两层嵌套。被测的是摊平视图里的虚拟片段 V = `<S 的 id>~<「中」里那个段的 id>~<pill 的片段 id>`
 * (`src/kernel/cutFlatten.mjs`)。加 S 之后新多出来的成本记录就是这张卡的(成本键是卡自己的,`cardCostKey` 剥掉了 `flat`),
 * 落定后把它标成人工钉重(`pinnedHeavy`)再刷新页面。
 *
 * 断言(任一不成立退出码 1):
 *   A 层表   层表里 V 一行:`kind: card`、`plane: local`、成员只有 V、带输入签名(`s1-`)、**没有 `streamKind`**;第一帧是 S 的第一帧;
 *            流清单每段齐、满密度;层表里没有以 S 本身为顶的行
 *   B 就绪   在线来源认出这条流(切分方那一份、没有过期的);父页就绪索引里 V 有流层;V 判重、父页发它的流平面;S 本身不判重
 *   C 播放   播放中嵌套包裹层 `[data-pc-flat-clip="V"]` 被抑制、舞台上画的是这条流(父页推的字节、跟着播放头、不报错)
 *   D 改动   在页面里改「里」那张卡的文字(两层深):父页当场(≤ 1 秒)不再发旧流的流平面;随后 V 不再判重(照旧活渲;要等分派表按新身份重算,毫秒只记录);在线来源撤掉旧流
 *            (签名对不上,列进 `staleStreams`);舞台上没有旧键的轨道;随后播放,旧流没有再贴上来
 *   E 新流   新身份测出来后钉重;切分方按新的一版重产:层表换成新的一行(内容键、结果键、签名都换了,仍没有 `streamKind`);
 *            甲认出新流、贴它
 *   G 长剪辑段  再加一个 8 秒的剪辑段 L(第 1～9 秒,引用「中」;16 段,超出在线来源的取数窗口):L 里那张卡(虚拟片段 VL)同样
 *            各自出一条单卡流:钉重后层表里 VL 一行(没有 `streamKind`,分段 0～15),播放头停在 L 头上时在线来源按窗口认出就绪的分段、
 *            父页判重发平面,开播 1.5 秒之内 VL 就贴着流在画。逐卡口径下没有「整段就绪、字节只取窗口」那一条(上一轮剪辑段级流特有),不验
 *   F 没有页面错误
 * 截图:`play-v1.png`(贴旧流播放中)、`after-edit-live.png`(改完、活渲)、`play-v2.png`(贴新流播放中)、`play-long.png`(长剪辑段里的卡开播不久贴流)。
 * 耗时只记录。不打印令牌、口令。过程写 stderr;stdout 最后一行一行 JSON `{ ok, fails, ... }`。
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
const BASE = Number(arg('--base-port', 5410));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4, desk: BASE + 5 };
const BAND = [BASE, BASE + 9];
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const ORIGINS = proxyOrigins(PORTS.editor);
const SITE = ORIGINS.editor;
const HOSTED = `${SITE}/hosted/`;
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
const EDITOR = `${SITE}/editor`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cut-online-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'out')));
fs.mkdirSync(OUT, { recursive: true });
const deadline = Date.now() + 60 * 60_000;
process.env.NODE_OPTIONS = dnsShim.withLocalhostDns(process.env.NODE_OPTIONS);

const PROJECT = { width: 1280, height: 720, fps: 30, duration: 10 };
const FPS = PROJECT.fps, SEG = 15;
const DURATION = PROJECT.duration;
/** 剪辑段 S 的第一帧(0.2 秒,第 6 帧)与长度(2 秒):这条流的分段从它起数,0～3;播放头停在 0.5 秒时四段都在在线来源的取数窗口里 */
const S_START = 0.2, S_LEN = 2, FIRST = Math.round(S_START * FPS);
const TOTAL = DURATION * FPS;
const LAST_SEGMENT = Math.floor((Math.round((S_START + S_LEN) * FPS) - 1 - FIRST) / SEG);
/** 长剪辑段 L(G 那一步):第 1～9 秒,8 秒 = 240 帧,分段 0～15。在线来源的取数窗口(往回 1 段、往前 2 秒)装不下整段 */
const L_START = 1, L_LEN = 8, L_FIRST = Math.round(L_START * FPS), L_LAST_SEGMENT = Math.floor((Math.round((L_START + L_LEN) * FPS) - 1 - L_FIRST) / SEG);
/** 被引用剪辑「里」上的那张卡的参数:改之前、改之后(两层深:「里」被「中」引用,「中」被激活剪辑上的剪辑段引用) */
const INNER_V1 = { text: '剪辑段签名 v1' }, INNER_V2 = { text: '剪辑段签名 v2' };
/** 摊平视图里虚拟片段 id 的分隔符(`src/kernel/cutFlatten.mjs` 的 `FLAT_SEP`) */
const FLAT_SEP = '~';

const fails = [];
const out = { ok: false, run: RUN, site: SITE, out: OUT };
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
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId, username: creator.username, deviceId: 'cso-seed-node-0001', deviceName: 'probe-seed', as: 'creator', password: creator.password, role: 'page' });
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
  return d ? { suppressed: d.suppressed, heavy: d.snapshotFeed?.heavy ?? [], scrub: d.snapshotFeed?.scrub ?? [], streams: d.snapshotFeed?.streams ?? [], staleBelow: d.snapshotFeed?.staleBelow ?? [], ready: d.snapshotFeed?.ready ?? [],
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
/**
 * 可见舞台此刻的样子:这张卡的包裹层、它的流轨道(种类、平面、对不对得上)、画布挂在哪、舞台的时刻。
 * 剪辑段里的卡(虚拟片段 id)的包裹层在嵌套场景里,挂的是 `data-pc-flat-clip="<虚拟 id>"`(`src/render/Stage.tsx`)
 */
async function stageState(page, id) {
  const f = await visibleStage(page);
  if (!f) return null;
  return f.evaluate((cid) => {
    const diag = window.__pcStageDiag?.() ?? null;
    const tracks = (diag?.streams?.tracks ?? []).map((t) => ({ id: t.id, key: t.key ?? null, clips: String(t.id).split('#')[0].split(','), pushed: !!t.pushed, drawn: t.drawn, lastDrawn: t.lastDrawn,
      level: t.level ?? null, stale: !!t.stale, plane: t.plane ?? null, kind: t.kind ?? null, fits: t.fits ?? null, decoder: t.decoder, errors: t.errors, lastError: t.lastError || null, bound: t.bound ?? null }));
    const w = document.querySelector(`[data-pc-flat-clip="${CSS.escape(cid)}"]`) ?? document.querySelector(`[data-pc-clip="${CSS.escape(cid)}"]:not([data-pc-media])`);
    let clip = { wrapper: false };
    if (w) {
      const snap = w.querySelector(':scope > [data-pc-snapshot-plane]');
      const slot = w.querySelector(':scope > [data-pc-placeholder-slot]');
      const planes = [...document.querySelectorAll('[data-pc-group-plane]')];
      const visible = (el) => { const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
      clip = { wrapper: true, flat: w.getAttribute('data-pc-flat-clip'), suppressed: w.classList.contains('pc-suppressed'), snapshot: !!snap && snap.childElementCount > 0 && getComputedStyle(snap).visibility !== 'hidden',
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

/** 播放时这条流在画:包裹层被抑制、舞台上画的是这条流(父页推的字节)、跟着播放头、不报错 */
function checkPlaying(who, r, key) {
  const a = r.drawn[0]?.clip.stream, b = r.drawn[r.drawn.length - 1]?.clip.stream;
  const last = r.drawn[r.drawn.length - 1] ?? null;
  const brief = { samples: r.samples.length, drawn: r.drawn.length, from: trackBrief(a), to: trackBrief(b), tTo: last?.t ?? null };
  check(r.drawn.length >= 6, `${who}:播放中这条流在画的样本够多`, brief);
  if (!a || !b) return brief;
  check(b.key === key, `${who}:舞台上画的就是这条流`, brief.to);
  check(b.pushed === true, `${who}:流的字节是父页推给舞台的`, brief.to);
  // 双舞台:停下补跑后可见的舞台会换成另一台(各有各的流播放器和计数),按舞台分开看计数在不在涨
  const origins = [...new Set(r.drawn.map((s) => s.origin))];
  const perStage = origins.map((o) => { const xs = r.drawn.filter((s) => s.origin === o); return { origin: o, n: xs.length, from: xs[0].clip.stream.drawn, to: xs.at(-1).clip.stream.drawn, resets: xs.filter((s, i) => i && s.clip.stream.drawn < xs[i - 1].clip.stream.drawn).length }; });
  brief.perStage = perStage;
  check(perStage.every((x) => x.resets === 0) && perStage.some((x) => x.n >= 3 && x.to > x.from) && b.lastDrawn > a.lastDrawn && Math.abs(b.lastDrawn - Math.round(last.t * FPS)) <= 3, `${who}:流播放器在出帧(同一台舞台上计数只涨不回)、画着的那一帧跟着播放头`, brief);
  check((b.errors ?? 0) === 0, `${who}:流播放器没有报错`, brief.to);
  check(r.drawn.every((s) => s.clip.suppressed && !!s.clip.flat), `${who}:这张卡的嵌套包裹层(data-pc-flat-clip)一直被抑制`);
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
  };
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  browserA = await puppeteer.launch({ headless: true, protocolTimeout: 900_000, args: [...PROBE_CHROME_ARGS, ...LAUNCH_ARGS] });

  const t0 = Date.now();
  const deskFp = crypto.createHash('sha256').update(`cso-desk-${RUN}`).digest('hex').slice(0, 16);

  /* ---------------------------------------------------------------- 0. 建项目、起桌面预渲染进程当切分方 */
  const projName = `剪辑段签名-${RUN}`;
  const creator = { username: 'cso-creator', password: `pw-${randomBytes(6).toString('hex')}` };
  const projectPassword = `pp-${randomBytes(6).toString('hex')}`;
  const made = await M.createSharedProject({ base: DOC_DIRECT, name: projName, mode: 'free', creator, password: projectPassword });
  const projectId = made.projectId;
  check((await seedProject({ projectId, creator, name: projName })).ok, '替创建者写进空项目');
  const editorDir = path.join(TMP, 'editor');
  for (const d of ['card-overrides', 'projects', 'work']) fs.mkdirSync(path.join(editorDir, d), { recursive: true });
  const sharedConfig = path.join(editorDir, 'shared.json');
  const deskDevice = `cso-desk-${RUN}`.padEnd(16, '0');
  fs.writeFileSync(sharedConfig, JSON.stringify([{ url: M.wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render', deviceId: deskDevice, deviceName: '剪辑段签名探针 桌面' }]));
  editor = await startQueueEditor({ port: PORTS.desk, dir: editorDir, sharedConfig, fakeFingerprint: deskFp, band: BAND, extraEnv: {
    PROMPTCUT_CARD_OVERRIDES: path.join(editorDir, 'card-overrides'), PROMPTCUT_PROJECTS_DIR: path.join(editorDir, 'projects'), PROMPTCUT_WORK_DIR: path.join(editorDir, 'work'),
    PROMPTCUT_DEVICE_ID: deskDevice, PROMPTCUT_DEVICE_NAME: '剪辑段签名探针 桌面', PROMPTCUT_STREAMS: '1', PROMPTCUT_NO_PORT_FILE: '1' } });
  const deskQueue = await editor.waitActive();
  check(deskQueue.envFingerprint === deskFp, '桌面预渲染进程用上了测试指纹', { envFingerprint: deskQueue.envFingerprint });
  const deskStreams = (await editor.diagnostics().catch(() => null))?.streams ?? null;
  check(deskStreams?.enabled === true, '切分方的流开关开着', deskStreams && { enabled: deskStreams.enabled });
  out.desk = { envFingerprint: deskFp, upMs: Date.now() - t0 };
  say('desk.up', out.desk);

  const chkEntry = M.normalizeEntry({ url: M.wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render',
    deviceId: `cso-chk-${RUN}`.padEnd(16, '0'), deviceName: '剪辑段签名探针 核对' });
  chk = M.createWsEndpoint({ url: chkEntry.url, protocols: M.sharedProtocols(chkEntry, { role: 'render' }), log: () => {} });
  await new Promise((r) => { if (chk.connected) r(); else chk.onOpen(r); });
  const content = M.createContentClient(chk);
  const getManifest = async (resultKey, from, to) => (await content.get('render-manifest', `${resultKey}:${from}-${to}`).catch(() => null))?.body ?? null;
  const spansOf = (row) => { const o = []; for (let f = 0; f <= row.lastSegment; f += row.segmentsPerTask) o.push([f, Math.min(row.lastSegment, f + row.segmentsPerTask - 1)]); return o; };

  /* ---------------------------------------------------------------- 1. 甲进入;两层嵌套的剪辑与剪辑段 S */
  const a = await openMember(browserA, { projectId, name: projName, username: 'cso-jia', password: projectPassword, deviceId: `cso-jia-${RUN}`.padEnd(16, '0') });
  const pageA = a.page;
  const stable = async (page, min) => {
    let prev = -1, since = Date.now();
    return until('成本记录落定', async () => {
      const rows = await costRecords(page);
      if (rows.length !== prev) { prev = rows.length; since = Date.now(); return null; }
      return rows.length >= min && Date.now() - since > 4000 ? rows : null;
    }, 240_000, 500);
  };
  const cuts = await store(pageA, `
    const inner = S.actions.addCut('里', { switchTo: false });
    const A = S.getState().project.activeCutId;
    S.actions.switchCut(inner.id);
    // 「里」上只放这一张卡:加 S 之后新多出来的成本记录就只有它的,钉重钉的就是它
    const c = S.actions.addClipOnNewTrack({ index: 0, cardId: 'punch-pill', start: 0, duration: args[0] });
    S.actions.setClipParams(c.id, args[1]);
    const mid = S.actions.addCut('中', { switchTo: true });
    const seg = S.actions.addCutSegment(inner.id, 0, { newTrackIndex: 0, duration: args[0] });
    S.actions.switchCut(A);
    return { A, inner: inner.id, mid: mid.id, innerClip: c.id, midSeg: seg.id };`, DURATION, INNER_V1);
  check(!!cuts?.A && !!cuts.innerClip && !!cuts.midSeg, '建好两层嵌套的剪辑(「里」上一张卡,「中」引用「里」)', cuts);
  /** 剪辑段 `segId`(激活剪辑上、引用「中」)里那张 pill 在摊平视图里的虚拟片段 id */
  const flatIdOf = (segId) => [segId, cuts.midSeg, cuts.innerClip].join(FLAT_SEP);
  const before = (await stable(pageA, 0)) ?? [];
  const sId = await store(pageA, `const c = S.actions.addCutSegment(args[0], args[1], { newTrackIndex: 0, duration: args[2] }); return c.id;`, cuts.mid, S_START, S_LEN);
  const vId = flatIdOf(sId);
  const afterS = (await stable(pageA, before.length + 1)) ?? [];
  const fresh = afterS.filter((r) => r.identityKey && !before.some((b) => b.identityKey === r.identityKey));
  const vKeys = fresh.map((r) => r.identityKey);
  out.costs = { before: before.length, after: afterS.length, fresh: fresh.map((r) => ({ key: short(r.identityKey), stepMs: r.stepMs })) };
  if (!check(vKeys.length === 1, '剪辑段里那张卡的成本记录认出来了(加 S 之后新多出来的正好一条:卡自己的成本键,段本身没有)', out.costs)) throw new Error('认不出那张卡的成本记录');
  const docId = await store(pageA, `return S.getState().project.id;`);
  out.scene = { sId, vId, ...cuts, order: await store(pageA, `return S.getState().project.tracks.map((t) => t.clips.map((c) => c.id));`) };
  say('scene', out.scene);
  await costRecords(pageA, vKeys);
  await enter(pageA, 'cso-jia(刷新,钉重生效)');
  await pauseAt(pageA, 0.5);
  const nodeA = await until('甲的节点状态落定', async () => { const d = await nodeDiag(pageA); return d && (d.ready === 'ready' || d.eligibility?.ok === false) ? d : null; }, 240_000, 500);
  out.jiaFp = nodeA?.envFingerprint ?? null;

  /* ---------------------------------------------------------------- 2. A 层表 */
  const layerKey = `layers:${docId}`;
  const rowNow = async (id = vId) => {
    const body = (await content.get('snapshot-manifest', layerKey).catch(() => null))?.body ?? null;
    return { body, row: (body?.streams ?? []).find((r) => r.topClipId === id) ?? null };
  };
  const briefRow = (row) => row && { topClipId: row.topClipId, kind: row.kind, plane: row.plane, streamKind: row.streamKind ?? null, clipIds: row.clipIds, contentKey: short(row.contentKey),
    candidates: (row.candidates ?? []).map((c) => ({ envFingerprint: c.envFingerprint, resultKey: short(c.resultKey) })), originFrame: row.originFrame ?? null, lastSegment: row.lastSegment, inputSig: row.inputSig ?? null };
  const waitRow = (label, notKey = null, id = vId, dense = true, timeoutMs = 480_000) => until(label, async () => {
    const x = await rowNow(id);
    if (!x.row || x.row.contentKey === notKey) return null;
    const cand = x.row.candidates[0];
    for (const [from, to] of spansOf(x.row)) {
      const m = await getManifest(cand.resultKey, from, to);
      if (!m || Object.keys(m.segments ?? {}).length !== to - from + 1) return null;
      if (dense && !Object.values(m.segments).every((seg) => seg.stride === 1)) return null;
    }
    return { ...x, cand };
  }, timeoutMs, 1000);
  /** 逐卡口径的单卡流那一行:kind card、plane local、成员只有这张虚拟卡、带输入签名、没有 streamKind */
  const soloRowOk = (row, id) => !!row && row.kind === 'card' && row.plane === 'local' && (row.clipIds ?? []).join() === id && !('streamKind' in row) && /^s1-/.test(row.inputSig ?? '');
  const tProduce = Date.now();
  const got1 = await waitRow('A:层表里出现那张卡(虚拟片段)的流,流清单满密度齐');
  const row1 = got1?.row ?? null;
  const allRows = () => rowNow().then((x) => (x.body?.streams ?? []).map(briefRow));
  out.produce = { ms: got1 ? Date.now() - tProduce : null, row: briefRow(row1), all: await allRows() };
  say('flat.produced', out.produce);
  if (!check(!!row1, 'A:层表里有那张卡(虚拟片段)的一行', out.produce.all)) throw new Error('层表里没有那张卡的流');
  const key1 = got1.cand.resultKey;
  check(soloRowOk(row1, vId), 'A:这一行是普通单卡流(kind card、plane local、成员只有虚拟片段、带输入签名、没有 streamKind)', out.produce.row);
  check(row1.originFrame === FIRST && row1.lastSegment === LAST_SEGMENT, `A:这一行的第一帧是 S 的第一帧(第 ${FIRST} 帧),分段 0～${LAST_SEGMENT}`, out.produce.row);
  check(out.produce.all.every((r) => r.streamKind === null && r.topClipId !== sId), 'A:层表里没有带 streamKind 的行,也没有以 S 本身为顶的行', out.produce.all);

  /* ---------------------------------------------------------------- 3. B 就绪 */
  await pauseAt(pageA, 0.5);
  const readyOf = (id, key, label, minReady) => until(label, async () => {
    const d = await onlineDiag(pageA);
    const s = (d?.streams ?? []).find((x) => x.clipId === id);
    if (!(s && s.resultKey === key && s.ready >= minReady)) return null;
    const p = await parentDiag(pageA);
    return p?.heavy.includes(id) && planeOf(p, id)?.key === short(key) ? { s, d, p } : null;
  }, 180_000, 300);
  const ready1 = await readyOf(vId, key1, 'B:甲认出这条流、整段就绪、父页判重并发它的流平面', LAST_SEGMENT + 1);
  const layer1 = ready1?.p.ready.find((r) => r.clipId === vId)?.kinds.find((k) => k.kind === 'stream') ?? null;
  out.ready = ready1 && { ready: ready1.s.ready, envFingerprint: ready1.s.envFingerprint, staleStreams: ready1.d.staleStreams, layer: layer1, heavy: ready1.p.heavy, plane: planeOf(ready1.p, vId) };
  check(!!ready1 && ready1.s.envFingerprint === deskFp && ready1.d.staleStreams.length === 0, 'B:在线来源选中切分方那一份,没有过期的', out.ready);
  check(!!layer1 && layer1.key === short(key1), 'B:父页就绪索引里虚拟片段有这条流的流层', ready1?.p.ready);
  check(!!ready1 && !ready1.p.heavy.includes(sId) && planeOf(ready1.p, vId)?.plane !== 'stage', 'B:判重的是虚拟片段、不是 S 本身;流平面挂在包裹层里(不是舞台根)', out.ready);

  /* ---------------------------------------------------------------- 4. C 播放 */
  const play1 = await playAndSample(pageA, vId, { from: 0.3, to: 1.9, key: key1 });
  await stageShot(pageA, 'play-v1');
  await store(pageA, `S.actions.pause(); return true;`);
  out.play1 = checkPlaying('C 甲·旧流', play1, key1);

  /* ---------------------------------------------------------------- 5. D 改被引用剪辑(两层深) */
  await pauseAt(pageA, 1.0);
  const keysBeforeEdit = (await costRecords(pageA)).map((r) => r.identityKey);
  const had = await until('D:改之前父页在发那张卡的旧流平面', async () => { const p = await parentDiag(pageA); return planeOf(p, vId)?.key === short(key1) && p.heavy.includes(vId) ? p : null; }, 20_000, 100);
  const edit = await P(pageA, async (spec) => {
    const S = window.__pcStore;
    const feed = () => window.__pcPreviewDiag?.().snapshotFeed ?? null;
    const hadBefore = (feed()?.streams ?? []).some((p) => (p.clipIds ?? []).includes(spec.vId));
    const t0 = performance.now();
    S.actions.switchCut(spec.inner);
    S.actions.setClipParams(spec.innerClip, spec.patch);
    S.actions.switchCut(spec.A);
    S.actions.seek(1.0);
    // 分开记:旧流平面不再发(planeGoneMs)、这张卡不再判重(heavyGoneMs);两样都到了才算 goneMs
    let planeGoneMs = null, heavyGoneMs = null, heavyAfter = null, ticks = 0;
    const samples = [];
    while (performance.now() - t0 < 5000) {
      const f = feed();
      const ms = performance.now() - t0;
      const has = (f?.streams ?? []).some((p) => (p.clipIds ?? []).includes(spec.vId));
      const heavy = (f?.heavy ?? []).includes(spec.vId);
      if (ticks++ % 25 === 0) samples.push({ ms: Math.round(ms), plane: has, heavy });
      if (f && !has && planeGoneMs === null) planeGoneMs = ms;
      if (f && !heavy && heavyGoneMs === null) heavyGoneMs = ms;
      if (planeGoneMs !== null && heavyGoneMs !== null) { heavyAfter = f.heavy; break; }
      await new Promise((r) => setTimeout(r, 4));
    }
    const r = (x) => (x === null ? null : Math.round(x));
    return { hadBefore, planeGoneMs: r(planeGoneMs), heavyGoneMs: r(heavyGoneMs), goneMs: planeGoneMs === null || heavyGoneMs === null ? null : r(Math.max(planeGoneMs, heavyGoneMs)), heavyAfter, samples: samples.slice(0, 20) };
  }, { vId, inner: cuts.inner, innerClip: cuts.innerClip, A: cuts.A, patch: INNER_V2 });
  out.edit = { ...edit, hadPlane: !!had };
  // 「当场不再贴旧流」看的是旧流平面:父页按就绪索引发平面,在线来源一拿到新项目就撤层(签名对不上),平面当场没了。
  // 不再判重(heavy)要等分派表按新的成本身份重算(新身份先测一次),和顶层卡改参数是同一条路;只记毫秒、要求 5 秒内落下,不当 1 秒闸门
  check(!!had && edit?.hadBefore === true && edit.planeGoneMs !== null && edit.planeGoneMs <= 1000, 'D:改之前父页在发旧流;改被引用剪辑以后当场(≤ 1 秒)不再发旧流的平面(实测毫秒记在结果里)', out.edit);
  check(edit?.heavyGoneMs !== null, 'D:随后那张卡不再判重(新身份还没钉重,照旧活渲;毫秒只记录)', out.edit);
  const withdrawn = await until('D:在线来源撤掉旧流', async () => { const d = await onlineDiag(pageA); return d && !(d.streams ?? []).some((x) => x.resultKey === key1) ? d : null; }, 15_000, 50);
  out.edit.withdrawn = withdrawn && { staleStreams: withdrawn.staleStreams, streams: (withdrawn.streams ?? []).map((s) => ({ clipId: s.clipId, resultKey: short(s.resultKey) })) };
  check(!!withdrawn && (withdrawn.staleStreams ?? []).includes(vId), 'D:在线来源认出旧流过期(签名对不上,列进 staleStreams)、不再列它', out.edit.withdrawn);
  const live = await until('D:舞台上没有旧键的轨道,那张卡照旧活渲(不抑制、没有占位符)', async () => {
    const s = await stageState(pageA, vId);
    return s && !s.tracks.some((t) => t.key === key1) && s.clip.wrapper && !s.clip.suppressed && !s.clip.placeholder ? s : null;
  }, 20_000, 100);
  out.edit.stage = live && { flat: live.clip.flat, suppressed: live.clip.suppressed, placeholder: live.clip.placeholder, tracks: live.tracks.map(trackBrief) };
  check(!!live, 'D:舞台上旧流的轨道关掉了,那张卡活渲着', out.edit.stage ?? (await stageState(pageA, vId))?.clip);
  await delay(800);
  await stageShot(pageA, 'after-edit-live');
  const playOld = await playAndSample(pageA, vId, { from: 0.3, to: 1.3, key: key1 });
  await store(pageA, `S.actions.pause(); return true;`);
  check(playOld.samples.length >= 4 && playOld.samples.every((s) => !s.tracks.some((t) => t.key === key1)), 'D:改动之后播放,旧流没有再贴上来',
    { samples: playOld.samples.length, old: playOld.samples.filter((s) => s.tracks.some((t) => t.key === key1)).length });

  /* ---------------------------------------------------------------- 6. E 新流 */
  // 改过之后那张卡的成本身份换了(参数进成本键):新身份测出来、又没被判重时,同样钉重、刷新,切分方才会为它重产。
  // 层表先换了就不用钉
  out.edit.newCostKeys = [];
  await until('E:那张卡重新判重(层表换行,或新身份测出来后钉重)', async () => {
    const x = await rowNow();
    if (x.row && x.row.contentKey !== row1.contentKey) return true;
    const fresh = (await costRecords(pageA)).filter((r) => r.identityKey && !keysBeforeEdit.includes(r.identityKey) && !r.pinnedHeavy).map((r) => r.identityKey);
    if (fresh.length) {
      out.edit.newCostKeys.push(...fresh.map(short));
      await costRecords(pageA, fresh);
      await enter(pageA, 'cso-jia(刷新,那张卡的新身份钉重生效)');
      await pauseAt(pageA, DURATION + 1);
    }
    return null;
  }, 300_000, 2000);
  await pauseAt(pageA, DURATION + 1);
  const tNew = Date.now();
  const got2 = await waitRow('E:层表换成新一版的流,流清单满密度齐', row1.contentKey);
  const row2 = got2?.row ?? null;
  const key2 = got2?.cand?.resultKey ?? null;
  out.reissue = { ms: got2 ? Date.now() - tNew : null, row: briefRow(row2) };
  say('flat.reissued', out.reissue);
  if (check(!!row2 && key2 !== key1 && soloRowOk(row2, vId) && row2.inputSig !== row1.inputSig,
    'E:层表换成新的一行(内容键、结果键、输入签名都换了;仍是普通单卡流,没有 streamKind)', { old: briefRow(row1), now: briefRow(row2) })) {
    await pauseAt(pageA, 0.5);
    const ready2 = await readyOf(vId, key2, 'E:甲认出新流、整段就绪、父页判重并发新流的平面', LAST_SEGMENT + 1);
    out.ready2 = ready2 && { ready: ready2.s.ready, staleStreams: ready2.d.staleStreams, plane: planeOf(ready2.p, vId) };
    check(!!ready2 && ready2.d.staleStreams.length === 0, 'E:新流就绪,没有过期的', out.ready2);
    const play2 = await playAndSample(pageA, vId, { from: 0.3, to: 1.9, key: key2 });
    await stageShot(pageA, 'play-v2');
    await store(pageA, `S.actions.pause(); return true;`);
    out.play2 = checkPlaying('E 甲·新流', play2, key2);
  }

  /* ---------------------------------------------------------------- 6b. G 长剪辑段:里面的卡同样各自出流、贴得上 */
  const beforeL = (await stable(pageA, 0)) ?? [];
  const lId = await store(pageA, `const c = S.actions.addCutSegment(args[0], args[1], { newTrackIndex: 0, duration: args[2] }); return c.id;`, cuts.mid, L_START, L_LEN);
  const vlId = flatIdOf(lId);
  const afterL = (await stable(pageA, beforeL.length + 1)) ?? [];
  const freshL = afterL.filter((r) => r.identityKey && !beforeL.some((b) => b.identityKey === r.identityKey));
  const lKeys = freshL.map((r) => r.identityKey);
  out.long = { lId, vlId, costs: freshL.map((r) => ({ key: short(r.identityKey), stepMs: r.stepMs })) };
  if (check(lKeys.length >= 1, 'G:长剪辑段 L 里那张卡的成本记录认出来了(露出窗口长短不同,和 S 里那张不是同一个成本键)', out.long)) {
    await costRecords(pageA, lKeys);
    await enter(pageA, 'cso-jia(刷新,L 里那张卡钉重生效)');
    await pauseAt(pageA, DURATION + 1);
    const tL = Date.now();
    const gotL = await waitRow('G:层表里出现 L 里那张卡的流,流清单每段都齐', null, vlId, false, 600_000);
    out.long.produceMs = gotL ? Date.now() - tL : null;
    out.long.row = briefRow(gotL?.row ?? null);
    if (check(!!gotL && soloRowOk(gotL.row, vlId) && gotL.row.lastSegment === L_LAST_SEGMENT && gotL.row.originFrame === L_FIRST,
      `G:L 里那张卡一行普通单卡流(没有 streamKind),第一帧 ${L_FIRST},分段 0～${L_LAST_SEGMENT}`, out.long.row)) {
      const keyL = gotL.cand.resultKey;
      check(keyL !== key2, 'G:L 里那张卡的流和 S 里那张不是同一条(各实例各一行)', { keyL: short(keyL), key2: short(key2) });
      // 播放头停在 L 的头上:在线来源照普通单卡流按窗口取字节,窗口里的分段就绪就判重、发平面
      await pauseAt(pageA, L_START + 0.05);
      const readyL = await readyOf(vlId, keyL, 'G:在线来源认出 L 里那张卡的流(窗口里的分段就绪)、父页判重并发它的流平面', 1);
      out.long.ready = readyL && { ready: readyL.s.ready, segments: L_LAST_SEGMENT + 1, staleStreams: readyL.d.staleStreams, plane: planeOf(readyL.p, vlId) };
      check(!!readyL && readyL.d.staleStreams.length === 0, 'G:L 里那张卡的流就绪,没有过期的', out.long.ready);
      const playL = await playAndSample(pageA, vlId, { from: L_START + 0.05, to: L_START + 1.6, key: keyL });
      await stageShot(pageA, 'play-long');
      await store(pageA, `S.actions.pause(); return true;`);
      const firstT = playL.drawn[0]?.t ?? null;
      out.long.play = { samples: playL.samples.length, drawn: playL.drawn.length, firstDrawnT: firstT, track: trackBrief(playL.drawn.at(-1)?.clip.stream) };
      check(playL.drawn.length >= 6 && firstT !== null && firstT <= L_START + 1.5, 'G:开播 1.5 秒之内 L 里那张卡就贴着流在画', out.long.play);
      check(playL.drawn.every((x) => (x.clip.stream.errors ?? 0) === 0 && !!x.clip.flat), 'G:L 里那张卡的流播放器没有报错、画在嵌套包裹层里', out.long.play);
    }
  }

  /* ---------------------------------------------------------------- 7. F 页面错误 */
  out.pageErrors = pageA.errors.slice(0, 5);
  check(pageA.errors.length === 0, 'F:页面没有未捕获的错误', out.pageErrors);
  out.ms = Date.now() - t0;
} catch (e) {
  fails.push(`异常:${String(e?.stack ?? e).slice(0, 800)}`);
} finally {
  try { chk?.close(); } catch { /* 已关 */ }
  try { await browserA?.close(); } catch { /* 已关 */ }
  try { await editor?.stop(); } catch { /* 已停 */ }
  try { await hostedProxy?.close(); } catch { /* 已关 */ }
  try { await combo?.close?.(); } catch { /* 已关 */ }
  if (!KEEP) for (const d of ['hosted', 'editor', 'dist-online']) try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch { /* 留着 */ }
}
out.fails = fails;
out.ok = fails.length === 0;
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(fails.length ? 1 : 0);
