/**
 * 本页产流(任务书 `docs/plan/render-refactor-task.md`「甲二」:线上没有能切分的节点时,在线页面自己产单卡轨道流,不经过任务队列)的端到端验收。
 *
 *   node scripts/probes/page-stream-probe.mjs [--dist <在线构建目录>] [--base-port 27740] [--out <目录>] [--keep-temp] [--only solo|splitter|desk|mask|slow]
 *        端口(整段 +0～+9):+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务、+5～+7 桌面编辑器(及它的舞台端口)。都只绑 127.0.0.1。
 *
 * 角色都在本机,页面用**在线构建**(进项目走「刷新后回到项目」那条产品路径,`lib/online-resume-entry.mjs`):
 *   - 文档服务 + 素材服务:进程内的托管组合,经本机托管代理 `lib/hosted-proxy.mjs` 开三个同站跨源的源;
 *   - 在线页面:甲、乙各在一个浏览器里(同一个浏览器里只有一个标签页在前台);
 *   - 桌面预渲染进程(`m8/procs.mjs` 的 `startQueueEditor`:队列模式、测试指纹),只在点名的步骤里起。
 *
 * 五场,各用一个新项目(`--only` 只跑一场)。前三场的卡是进了编辑才加的:空项目里加第一张卡,加载遮罩照样出现一轮(「打开项目的第一轮」
 * 按「有卡片段的第一轮」算),所以这张卡的稀疏版在测量时就由本页产了(`pageStreams.ts` 的 `measure()`),满密度那一趟才走下面说的等待与让路。
 * 后两场(`mask`、`slow`)是「在线页面打开项目、测量时就产稀疏版」(`docs/semantics/mechanism/rendering.md`「测量」)的验收,见各自的说明。
 *
 *   solo      只有文档服务、素材服务和在线页面,没有桌面、没有渲染主机。
 *     一  甲自己产出流:清单计划发出去没人认领,等满等待时间才动手;内容库里有流清单(过桌面的 `manifestMatches`,满密度),素材服务 `px` 里
 *         开头文件与分段都在;层表由本页写了 `streams` 那一行(候选是甲的指纹,结果键 = 内容键 × 甲的指纹);甲的节点一个队列任务都没认领过;
 *         播放时舞台上是流在画、不是快照在换;像素与同一帧的精确活渲相符
 *     让路  产到一半开始播放:当前帧做完就停(播放期间一帧不产、不重新开工),停下后接着做(已推完的分段不重做);拖动时间轴同样
 *     二  乙(第二个在线页面)打开同一个项目:直接贴上这条流,不重产(没有起编码器、没有送帧、没有推块);
 *         再让一个桌面预渲染进程连上来(能产流、不是只切分):它认领那份清单计划、切分,但这条流不重产(先查到了、拉回本机、锁到甲的指纹上,
 *         切分照锁只出一份,由在线页面的节点去重即完成);桌面把这条流拉回了流库,它自己的页面会话打开这一版时收到的流层就是这个键,
 *         分段读口取得到、字节与素材服务上的相同(「能拉回去播」)
 *   splitter  先有能切分的节点在线(桌面预渲染进程,只切分),页面再进来加卡:页面不走本页产流这条路(一次都没开工、没写层表),流经队列产出来
 *   desk      素材服务里已经有这条流(先由桌面产好:一个不当节点的页面加卡,桌面认领计划、自己产流、推素材服务),桌面下线后页面打开项目:
 *             直接贴,不产 —— 没有起编码器、没有往素材服务推任何块;播放时画的就是桌面产的那条流。页面一侧算的内容键与桌面写进层表的相同
 *
 *   mask      项目里先有三张判重的内置卡(由一个不当节点的页面加好),电脑身份的页面甲再打开它:
 *     一  加载遮罩下,每测完一张卡紧接着产它的稀疏版:遮罩撤下的那一刻三条流的稀疏版都在内容库与素材服务里(每个分段一张、带位置矩形),
 *         层表里有本页的三行;这些都发生在清单计划发出去之前,甲的节点一个队列任务都没认领
 *     二  进编辑时已经能贴:马上播放,舞台上画的是这些流;逐张截图比像素 —— 稀疏段贴的是分段第一帧那一张(与分段第一帧的精确活渲相符,
 *         与这一帧自己的精确活渲差得更多)
 *     三  播放中不产(一帧不送、不开工),保活在发:render 连接上发出 `node.active { busy: 'play' }`
 *     四  停下以后:稀疏的都落定了满密度才开始;最后满密度齐、位置矩形还在
 *     五  乙(第二个页面)后进来:遮罩下先查到这三条流已经有了,直接用甲产的,不起编码器、不推块;播放时画的就是甲产的流
 *   slow      项目里一张快的重卡、一张人为拖慢的重卡(稀疏版一趟要一分钟):遮罩等稀疏版满 50 秒(墙上时钟,从第一次等稀疏版起算)就撤下、
 *             照样进编辑;没产完的闲时接着产(已推完的分段不重做);稀疏的都齐了以后满密度才开始
 *
 * 任一断言不成立退出码 1。耗时只记录。不打印令牌、口令。
 * 输出:过程写 stderr;stdout 最后一行一行 JSON `{ ok, fails, scenes: { solo, splitter, desk, mask, slow } }`;截图在 `--out/<场>/`。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import { spawnSync } from 'node:child_process';
import crypto, { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PNG } from 'pngjs';
import dnsShim from './lib/localhost-dns.cjs'; // Node 这边也认得 *.localhost(托管组合对外说的是 pc.localhost)
import { startHostedProxy, proxyOrigins } from './lib/hosted-proxy.mjs';
import { resumeRecord, plantResume } from './lib/online-resume-entry.mjs';
import { startQueueEditor, viteBin, portFree } from './m8/procs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const KEEP = argv.includes('--keep-temp');
const ONLY = arg('--only', null);
const BASE = Number(arg('--base-port', 27740));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4, desk: BASE + 5 };
const BAND = [BASE, BASE + 9];
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const ORIGINS = proxyOrigins(PORTS.editor);
const SITE = ORIGINS.editor;
const HOSTED = `${SITE}/hosted/`;
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
const EDITOR = `${SITE}/editor`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-page-stream-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'out')));
fs.mkdirSync(OUT, { recursive: true });
const deadline = Date.now() + 75 * 60_000;
process.env.NODE_OPTIONS = dnsShim.withLocalhostDns(process.env.NODE_OPTIONS);

/**
 * 探针项目:1280×720、30 fps。卡从第 12 帧起(不是 15 的倍数),占 132 帧(项目的第 12～143 帧)。
 * 分段从这条流自己的第一帧(第 12 帧)起数:0～8,第 8 段只有 12 帧;两段任务 0～7 与 8～8。
 */
const PROJECT = { width: 1280, height: 720, fps: 30, duration: 8 };
const FPS = PROJECT.fps;
const CLIP = { start: 0.4, duration: 4.4 };
/** 这条流自己的第一帧、它一共多少帧 */
const ORIGIN_FRAME = Math.round(CLIP.start * 30);
const STREAM_FRAMES = Math.round(CLIP.duration * 30);
const SEG = 15;
const TOTAL = Math.round((CLIP.start + CLIP.duration) * FPS);
const LABEL = 'solo';
/** 不当节点的页面报的浏览器(非 Chromium 内核:`browserNodeEligibility` 回 `not-chromium`) */
const NON_NODE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';
/** 与 `src/online/pageStreams.ts` 的 `PAGE_STREAM_WAIT_MS` 同值:计划发出去没人认领,等这么久才自己产 */
const WAIT_MS = 5000;

const fails = [];
const out = { ok: false, run: RUN, site: SITE, out: OUT, scenes: {} };
let tag = '';
const check = (cond, label, extra) => { if (!cond) fails.push(`${tag}${label}` + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 700)}`)); return !!cond; };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
let debugProbe = null;

async function until(label, fn, timeoutMs, everyMs = 300) {
  const end = Math.min(Date.now() + timeoutMs, deadline);
  let last = 0;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) { fails.push(`${tag}超时:${label}`); return null; }
    if (process.env.PROBE_DEBUG && Date.now() - last > 15_000) { last = Date.now(); say('waiting', { label, v: debugProbe ? await debugProbe().catch((e) => String(e?.message ?? e)) : null }); }
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
  say('local.up', { site: SITE, stages: ORIGINS.stages, doc: PORTS.doc, asset: PORTS.asset, dist });
  return dist;
}

/** 给刚建好的共享项目写进一份空项目(替创建者的桌面版) */
async function seedProject({ projectId, creator, name, duration = PROJECT.duration }) {
  const { buildAuthProtocols } = await import('../../server/auth/client.mjs');
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId, username: creator.username, deviceId: 'psp-seed-node-0001', deviceName: 'probe-seed', as: 'creator', password: creator.password, role: 'page' });
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
    const body = { version: 1, id: `seed-${projectId.slice(-8)}`, name, ...PROJECT, duration, themeId: 'midnight', media: [], tracks: [{ id: 't-1', name: '序列 1', clips: [] }] };
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
/** 本页产流的状态,连同同一刻的几样(在不在播、送过几帧、起过几个编码器) */
const pageStreams = (page) => P(page, () => {
  try {
    const d = window.__pcBrowserNode?.();
    if (!d) return null;
    const ps = d.pageStreams;
    return JSON.parse(JSON.stringify({ ...ps, at: Date.now(), playing: !!window.__pcStore?.getState?.().playing, frames: d.streams?.frames ?? null, encoders: d.streams?.encoders ?? null,
      segments: d.streams?.segments ?? null, resumedSegments: d.streams?.resumedSegments ?? null, idle: d.idle, nodeState: d.state, claims: d.counters?.claims ?? null }));
  } catch { return null; }
}).catch(() => null);
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
async function stageState(page, id) {
  const f = await visibleStage(page);
  if (!f) return null;
  return f.evaluate((cid) => {
    const diag = window.__pcStageDiag?.() ?? null;
    const tracks = (diag?.streams?.tracks ?? []).map((t) => ({ id: t.id, key: t.key ?? null, clips: String(t.id).split('#')[0].split(','), pushed: !!t.pushed, drawn: t.drawn, lastDrawn: t.lastDrawn,
      decoder: t.decoder, errors: t.errors, lastError: t.lastError || null }));
    const w = document.querySelector(`[data-pc-clip="${cid}"]:not([data-pc-media])`);
    let clip = { wrapper: false };
    if (w) {
      const snap = w.querySelector(':scope > [data-pc-snapshot-plane]');
      const slot = w.querySelector(':scope > [data-pc-placeholder-slot]');
      clip = { wrapper: true, suppressed: w.classList.contains('pc-suppressed'), snapshot: !!snap && snap.childElementCount > 0,
        snapshotHidden: !!snap && getComputedStyle(snap).visibility === 'hidden', placeholder: !!slot && !slot.hidden,
        stream: tracks.find((t) => t.clips.includes(cid)) ?? null };
    }
    return { t: diag?.t ?? null, clip, tracks, origin: location.origin, swaps: window.__pspSwaps ?? null };
  }, id).catch(() => null);
}
async function stageShot(page, dir, name) {
  const f = await visibleStage(page);
  const el = f ? await f.frameElement().catch(() => null) : null;
  const box = el ? await el.boundingBox().catch(() => null) : null;
  if (!box || box.width < 10) return null;
  const file = path.join(dir, `${name}.png`);
  const buf = await page.screenshot({ path: file, clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.floor(box.width), height: Math.floor(box.height) } });
  return { file, png: PNG.sync.read(Buffer.from(buf)) };
}
function diffOf(a, b) {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  let sum = 0, bad = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * a.width + x) * 4, j = (y * b.width + x) * 4;
      const d0 = Math.abs(a.data[i] - b.data[j]), d1 = Math.abs(a.data[i + 1] - b.data[j + 1]), d2 = Math.abs(a.data[i + 2] - b.data[j + 2]);
      sum += d0 + d1 + d2;
      if (d0 > 48 || d1 > 48 || d2 > 48) bad++;
    }
  }
  return { mad: +(sum / (w * h * 3)).toFixed(3), bad: +(bad / (w * h)).toFixed(5), w, h };
}
/** 画面里橙块的像素占比(探针卡的块是 #f97316) */
function orangeOf(png) {
  let orange = 0;
  for (let i = 0; i < png.data.length; i += 4) { const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2]; if (r > 200 && g > 80 && g < 160 && b < 90) orange++; }
  return +(orange / (png.width * png.height)).toFixed(5);
}
/** 暂停在 `sec`、等这张卡追到精确活渲,截一张 */
/* 停着时这张卡的流轨道可能还留着(「暂停和拖动贴流」之后:播放头下这一帧先解好、留着等换满密度);判据看包裹层没被抑制(画的是活渲)。
 * 调用处都在这条流补成满密度以后,轨道就算露出来也是这一帧自己的画面。`allowTrack: false` 可以要求轨道已经撤掉 */
async function liveShot(page, id, sec, dir, name, { allowTrack = true } = {}) {
  await store(page, `S.actions.pause(); return true;`);
  await delay(500);
  let ok = null, last = null;
  for (let round = 0; round < 5 && !ok; round++) {
    await pauseAt(page, sec);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !ok) {
      const s = await stageState(page, id);
      last = s ? { t: s.t, tracks: s.tracks.map((x) => x.clips.join()), own: !!s.clip.stream, clip: { suppressed: s.clip.suppressed, snapshot: s.clip.snapshot, placeholder: s.clip.placeholder } } : null;
      // 这张卡自己没有流的轨道在(别的卡的轨道不管:几张卡的项目里,播放头不在的那几张的轨道可以留着)
      if (s && Math.abs((s.t ?? -1) - sec) <= 0.5 / FPS && (allowTrack || !s.clip.stream) && s.clip.wrapper && !s.clip.suppressed && !s.clip.snapshot && !s.clip.placeholder) ok = s;
      else await delay(100);
    }
  }
  if (!ok) { fails.push(`${tag}等不到:暂停在 ${sec.toFixed(3)} 秒后追到精确活渲 :: ${JSON.stringify(last).slice(0, 400)}`); return null; }
  await delay(250);
  return stageShot(page, dir, name);
}
const drawing = (s, key = null) => {
  const t = s?.clip?.stream;
  return t && typeof t.lastDrawn === 'number' && s.clip.suppressed && (!key || t.key === key) ? t : null;
};
/** 播放中截一张流在画的帧,与那一帧的精确活渲、往后 2 秒的精确活渲比(通过线同 `browser-stream-e2e-probe.mjs`) */
async function comparePixels(page, id, { from, name, dir, key, until: untilSec = from + 1.4 }) {
  const res = { name, tries: 0, rejects: [] };
  let shot = null, frame = null;
  for (let round = 0; round < 10 && !shot; round++) {
    await playFrom(page, from);
    const t0 = Date.now();
    let started = false;
    while (Date.now() - t0 < 12_000 && !shot) {
      const before = await stageState(page, id);
      if (!started) { if (before && (before.t ?? -1) >= from - 0.05 && (before.t ?? 99) <= from + 0.6) started = true; else { await delay(20); continue; } }
      const tb = drawing(before, key);
      if (!tb || before.clip.placeholder || (before.t ?? 0) < from + 0.25) { await delay(40); continue; }
      if ((before.t ?? 0) > untilSec) break;
      res.tries++;
      const s = await stageShot(page, dir, `${name}-stream`);
      const after = await stageState(page, id);
      const ta = drawing(after, key);
      if (!s || !ta || after.clip.placeholder) { res.rejects.push({ shot: !!s, drawing: !!ta, placeholder: !!after?.clip?.placeholder, t: after?.t ?? null }); continue; }
      const near = (st, t) => Math.abs(t.lastDrawn - Math.round((st.t ?? 0) * FPS)) <= 3;
      if (!near(before, tb) || !near(after, ta) || ta.lastDrawn < tb.lastDrawn) { res.rejects.push({ stale: [tb.lastDrawn, before.t, ta.lastDrawn, after.t] }); continue; }
      if (ta.lastDrawn - tb.lastDrawn <= 3) { shot = s; frame = Math.round((tb.lastDrawn + ta.lastDrawn) / 2); res.f0 = tb.lastDrawn; res.f1 = ta.lastDrawn; }
      else res.rejects.push({ frames: ta.lastDrawn - tb.lastDrawn });
    }
  }
  if (!check(!!shot, `${name}:播放中截到流在画的一帧`, res)) { await pauseAt(page, from).catch(() => {}); return res; }
  res.frame = frame;
  res.rejects = res.rejects.slice(-6);
  const same = await liveShot(page, id, frame / FPS, dir, `${name}-live-same`);
  const far = await liveShot(page, id, (frame + 2 * FPS) / FPS, dir, `${name}-live-far`);
  if (!check(!!same && !!far, `${name}:截到精确活渲的两张参照`, { same: !!same, far: !!far })) return res;
  res.same = diffOf(shot.png, same.png);
  res.far = diffOf(shot.png, far.png);
  res.orange = { stream: orangeOf(shot.png), live: orangeOf(same.png) };
  check(res.same.mad <= 1.5 && res.same.bad <= 0.002, `${name}:流的画面与同一帧的精确活渲相符(平均差 ≤ 1.5、差得多的像素 ≤ 0.2%)`, res.same);
  check(res.far.bad >= 0.004 && res.far.bad >= res.same.bad * 4 + 0.002, `${name}:与往后 2 秒的精确活渲比,差明显更大(对照)`, { same: res.same, far: res.far });
  check(res.orange.stream > 0.02 && Math.abs(res.orange.stream - res.orange.live) <= 0.004, `${name}:流的画面里橙块在(不透明),大小与活渲的相同`, res.orange);
  return res;
}
async function watchSwaps(page, id) {
  for (const f of stageFrames(page)) {
    await f.evaluate((cid) => {
      if (window.__pspObserver) window.__pspObserver.disconnect();
      window.__pspSwaps = 0;
      window.__pspObserver = new MutationObserver((list) => {
        for (const m of list) {
          const plane = m.target instanceof Element ? m.target.closest('[data-pc-snapshot-plane]') : null;
          if (plane?.parentElement?.getAttribute('data-pc-clip') === cid && m.type === 'childList') window.__pspSwaps++;
        }
      });
      window.__pspObserver.observe(document.documentElement, { subtree: true, childList: true });
    }, id).catch(() => {});
  }
}
async function playAndSample(page, id, { from, to, key = null }) {
  const res = { from };
  await watchSwaps(page, id);
  await playFrom(page, from);
  const samples = [];
  const t0 = Date.now();
  let swaps0 = null, started = false;
  while (Date.now() - t0 < 25_000) {
    const s = await stageState(page, id);
    if (!s) { await delay(40); continue; }
    if (!started) { if ((s.t ?? -1) >= from - 0.05 && (s.t ?? 99) <= from + 0.6) started = true; else { await delay(20); continue; } }
    if ((s.t ?? 0) >= to) break;
    if (swaps0 === null && drawing(s, key)) swaps0 = s.swaps;
    samples.push(s);
    await delay(45);
  }
  const lastState = await stageState(page, id);
  await pauseAt(page, from);
  const drawn = samples.filter((s) => { const t = drawing(s, key); return t && t.lastDrawn <= Math.round((s.t ?? 0) * FPS) + 3; });
  const first = drawn[0] ?? null, last = drawn[drawn.length - 1] ?? null;
  return { ...res, samples, drawn, first, last, frames: first && last ? Math.round((last.t - first.t) * FPS) : 0,
    swaps: swaps0 !== null && typeof lastState?.swaps === 'number' ? lastState.swaps - swaps0 : null };
}
/** 「这条流在画、不是快照在换」;`who` 是断言的前缀 */
function checkStreamPlaying(who, r, { key }) {
  const a = r.first?.clip.stream, b = r.last?.clip.stream;
  const brief = { samples: r.samples.length, drawn: r.drawn.length, frames: r.frames, swaps: r.swaps, tFrom: r.first?.t ?? null, tTo: r.last?.t ?? null,
    track: b ? { key: String(b.key).slice(0, 12), pushed: b.pushed, decoder: b.decoder, drawnFrom: a.drawn, drawnTo: b.drawn, lastFrom: a.lastDrawn, lastTo: b.lastDrawn, errors: b.errors, lastError: b.lastError } : null };
  check(r.drawn.length >= 8 && r.frames >= 15, `${who}:播放中这条流在画的时间够长(≥ 15 帧)`, brief);
  if (!a || !b) return brief;
  check(b.key === key, `${who}:舞台上画的就是这条流(轨道的键 = 这条流的结果键)`, { track: String(b.key).slice(0, 12), expect: String(key).slice(0, 12) });
  check(b.pushed === true, `${who}:流的字节是父页推给舞台的`, brief.track);
  check(b.drawn - a.drawn >= r.frames * 0.6 && b.lastDrawn > a.lastDrawn, `${who}:流播放器在出帧(画过的帧数跟着播放头涨)`, brief);
  check(Math.abs(b.lastDrawn - Math.round(r.last.t * FPS)) <= 3, `${who}:画着的那一帧跟着播放头(差不超过 3 帧)`, { lastDrawn: b.lastDrawn, stageFrame: Math.round(r.last.t * FPS) });
  check((b.errors ?? 0) === 0, `${who}:流播放器没有报错`, brief.track);
  check(r.drawn.every((s) => s.clip.suppressed), `${who}:播放中包裹层一直被抑制`, r.drawn.filter((s) => !s.clip.suppressed).length);
  // 这张卡没有快照(没有任何节点产过):起播的头 500 毫秒舞台给这一层盖「等快照」的沙漏,流在下面照画(已知,见 `browser-stream-task.md`)
  const withSlot = r.drawn.filter((s) => s.clip.placeholder);
  brief.placeholderEarly = withSlot.filter((s) => s.t <= r.from + 0.7).length;
  check(withSlot.every((s) => s.t <= r.from + 0.7), `${who}:起播 0.7 秒之后没有占位符`, withSlot.filter((s) => s.t > r.from + 0.7).map((s) => s.t));
  // 不是快照在换:播 `frames` 帧,快照平面的变动不超过每个分段一摘一挂
  check(typeof r.swaps === 'number' && r.swaps <= (Math.ceil(r.frames / SEG) + 2) * 2, `${who}:不是快照在换(播 ${r.frames} 帧,快照平面只变动了 ${r.swaps} 次)`, { swaps: r.swaps, frames: r.frames });
  return brief;
}

/** 编辑器页的源往素材服务写块的请求(上传走 PUT / POST;`px/` 是流与小尺寸那一类) */
const editorPxWrites = () => hostedProxy.requests.filter((r) => r.role === 'editor' && (r.method === 'PUT' || r.method === 'POST') && /\/px\//.test(r.path));

let browserA = null, browserB = null, editor = null, chk = null;
const LAUNCH_ARGS = ['--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--site-per-process', '--window-position=-32000,-32000'];

async function openMember(browser, { projectId, name, username, password, deviceId, userAgent = null, before = null }) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  if (before) await before(page);
  page.on('dialog', (d) => void d.accept());
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.message ?? e).slice(0, 240)));
  if (userAgent) await page.setUserAgent(userAgent);
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.25 });
  await plantResume(page, await resumeRecord({ base: HOSTED, derivationBase: `${DOC_DIRECT}/`, projectId, name, username, password, deviceId }));
  await page.goto(EDITOR, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const entered = await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 120_000 }).then(() => true, () => false);
  if (!check(entered, `${username} 进入项目(刷新后回到项目那条路)`)) throw new Error(`${username} 没进去`);
  await until(`${username} 的页面双舞台握上手`, async () => P(page, () => { const d = window.__pcPreviewDiag?.(); return d?.dual && d.onlineStages?.handshake === 'ok'; }), 120_000, 500);
  return { ctx, page };
}
const addCard = (page, clip = CLIP, label = LABEL, burnMs = 40) => store(page, `
  const c = S.actions.addClipOnNewTrack({ index: 0, cardId: 'probe-slow-stepped', start: args[0].start, duration: args[0].duration });
  S.actions.setClipParams(c.id, { burnMs: args[2], label: args[1] });
  S.actions.seek(args[0].start + args[0].duration + 1);
  // 取消选中:选中框是编辑器叠在舞台上的,截图比像素时会被算进去
  S.actions.select([]);
  return c.id;`, clip, label, burnMs);
const nodeReady = (page, who) => until(`${who} 当节点、报到拿到指纹、探到编码器`, async () => { const d = await nodeDiag(page); return d?.ready === 'ready' && d.envFingerprint && d.streams?.capable ? d : null; }, 240_000, 500);

/** 建一个项目、写进空项目、开一条核对用的连接(创建者,render 角色:读内容库、签素材票据) */
async function newProject(M, scene, { duration } = {}) {
  const projName = `本页产流-${scene}-${RUN}`;
  const creator = { username: 'psp-creator', password: `pw-${randomBytes(6).toString('hex')}` };
  const projectPassword = `pp-${randomBytes(6).toString('hex')}`;
  const made = await M.createSharedProject({ base: DOC_DIRECT, name: projName, mode: 'free', creator, password: projectPassword });
  const projectId = made.projectId;
  check((await seedProject({ projectId, creator, name: projName, duration })).ok, '替创建者写进空项目');
  const chkEntry = M.normalizeEntry({ url: M.wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render',
    deviceId: `psp-chk-${scene}-${RUN}`.padEnd(16, '0'), deviceName: '本页产流探针 核对' });
  chk = M.createWsEndpoint({ url: chkEntry.url, protocols: M.sharedProtocols(chkEntry, { role: 'render' }), log: () => {} });
  await new Promise((r) => { if (chk.connected) r(); else chk.onOpen(r); });
  const content = M.createContentClient(chk);
  const ticket = () => new Promise((resolve) => {
    const reqId = `tk-${RUN}-${Math.random().toString(36).slice(2)}`;
    chk.onMessage((msg) => { if (msg?.reqId === reqId) resolve(msg?.type === 'auth.ticket.ok' ? { Authorization: `Bearer ${msg.ticket}` } : {}); });
    chk.send({ type: 'auth.ticket', kind: 'asset', access: 'r', reqId });
  });
  const getManifest = async (resultKey, from, to) => (await content.get('render-manifest', `${resultKey}:${from}-${to}`).catch(() => null))?.body ?? null;
  const member = (browser, username, extra = {}) => openMember(browser, { projectId, name: projName, username, password: projectPassword, deviceId: `psp-${username}-${scene}-${RUN}`.slice(0, 40).padEnd(16, '0'), ...extra });
  return { projectId, projName, creator, projectPassword, content, ticket, getManifest, member };
}
const spansOf = (row) => { const o = []; for (let f = 0; f <= row.lastSegment; f += row.segmentsPerTask) o.push([f, Math.min(row.lastSegment, f + row.segmentsPerTask - 1)]); return o; };
const briefRow = (row) => row && { topClipId: row.topClipId, kind: row.kind, plane: row.plane, contentKey: String(row.contentKey).slice(0, 12),
  candidates: (row.candidates ?? []).map((c) => ({ envFingerprint: c.envFingerprint, resultKey: String(c.resultKey).slice(0, 12) })), originFrame: row.originFrame ?? null, firstSegment: row.firstSegment ?? null, lastSegment: row.lastSegment,
  segmentsPerTask: row.segmentsPerTask, inputSig: row.inputSig ?? null };
const rowOf = async (content, docId, clipId) => {
  const body = (await content.get('snapshot-manifest', `layers:${docId}`).catch(() => null))?.body ?? null;
  return { body, row: (body?.streams ?? []).find((r) => r.topClipId === clipId) ?? null };
};
/** 这条流(某个结果键)的清单与块:每份清单都在、满密度、块都在素材服务上且哈希对 */
async function verifyStream(P0, M, row, resultKey, { encoder = null } = {}) {
  const auth = await P0.ticket();
  const blocks = [];
  let manifestsOk = 0;
  const strides = new Set(), encoders = new Set();
  for (const [from, to] of spansOf(row)) {
    const m = await P0.getManifest(resultKey, from, to);
    const segs = Object.keys(m?.segments ?? {}).map(Number).sort((x, y) => x - y);
    const inits = Object.keys(m?.inits ?? {});
    for (const n of segs) { strides.add(m.segments[n].stride); encoders.add(m.segments[n].encoder); }
    const ok = !!m && M.manifestMatches(m, { kind: 'stream', resultKey, range: { from, to } }) && segs.length === to - from + 1 && segs[0] === from && inits.length >= 1
      && segs.every((n) => m.segments[n].stride === 1 && m.segments[n].samples === Math.min(SEG, STREAM_FRAMES - n * SEG) && (!encoder || m.segments[n].encoder === encoder));
    if (ok) manifestsOk++;
    for (const id of inits) blocks.push({ hash: m.inits[id].hash, bytes: m.inits[id].bytes });
    for (const n of segs) blocks.push({ hash: m.segments[n].hash, bytes: m.segments[n].bytes, segment: n });
  }
  const uniq = [...new Map(blocks.map((b) => [b.hash, b])).values()];
  let complete = 0, hashOk = 0;
  for (const b of uniq) {
    const c = await (await fetch(`${SITE}/media/api/asset/px/${b.hash}/chunks`, { headers: auth })).json().catch(() => null);
    if (c?.complete) complete++;
    const body = Buffer.from(await (await fetch(`${SITE}/media/api/asset/px/${b.hash}`, { headers: auth })).arrayBuffer());
    if (sha256(body) === b.hash && (b.bytes == null || body.length === b.bytes)) hashOk++;
  }
  return { manifests: spansOf(row).length, manifestsOk, blocks: uniq, count: uniq.length, bytes: uniq.reduce((s, b) => s + (b.bytes ?? 0), 0), complete, hashOk, strides: [...strides], encoders: [...encoders] };
}

async function startDesk(P0, M, dir, scene, { planOnly, streams }) {
  const deskFp = crypto.createHash('sha256').update(`psp-desk-${RUN}-${scene}`).digest('hex').slice(0, 16);
  const editorDir = path.join(dir, 'editor');
  for (const d of ['card-overrides', 'projects', 'work']) fs.mkdirSync(path.join(editorDir, d), { recursive: true });
  const sharedConfig = path.join(editorDir, 'shared.json');
  const deskDevice = `psp-desk-${scene}-${RUN}`.padEnd(16, '0');
  fs.writeFileSync(sharedConfig, JSON.stringify([{ url: M.wsBaseOf(HOSTED), projectId: P0.projectId, username: P0.creator.username, password: P0.creator.password, as: 'creator', role: 'render', deviceId: deskDevice, deviceName: '本页产流探针 桌面' }]));
  await until('桌面编辑器的端口空着', async () => (await Promise.all([0, 1, 2].map((d) => portFree(PORTS.desk + d)))).every(Boolean), 30_000, 500);
  const t0 = Date.now();
  editor = await startQueueEditor({ port: PORTS.desk, dir: editorDir, sharedConfig, fakeFingerprint: deskFp, band: BAND, extraEnv: {
    PROMPTCUT_CARD_OVERRIDES: path.join(editorDir, 'card-overrides'), PROMPTCUT_PROJECTS_DIR: path.join(editorDir, 'projects'), PROMPTCUT_WORK_DIR: path.join(editorDir, 'work'),
    PROMPTCUT_DEVICE_ID: deskDevice, PROMPTCUT_DEVICE_NAME: '本页产流探针 桌面', PROMPTCUT_NO_PORT_FILE: '1',
    ...(planOnly ? { PROMPTCUT_TEST_PLAN_ONLY: '1' } : {}), PROMPTCUT_STREAMS: streams ? '1' : '0' } });
  const q = await editor.waitActive();
  check(q.envFingerprint === deskFp, '桌面预渲染进程用上了测试指纹', { envFingerprint: q.envFingerprint });
  say('desk.up', { scene, ms: Date.now() - t0, planOnly, streams });
  return { deskFp, upMs: Date.now() - t0 };
}
async function stopDesk() { try { await editor?.stop(); } catch { /* 已停 */ } editor = null; }

/** 订阅桌面预渲染进程某个页面会话的就绪索引(SSE),收到的消息攒在 `messages` 里 */
function watchReady(base, session) {
  const messages = [];
  const req = http.get(`${base}/api/frames/ready?session=${encodeURIComponent(session)}`, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      for (;;) {
        const at = buf.indexOf('\n\n');
        if (at < 0) break;
        const block = buf.slice(0, at);
        buf = buf.slice(at + 2);
        for (const line of block.split('\n')) if (line.startsWith('data: ')) { try { messages.push(JSON.parse(line.slice(6))); } catch { /* 半行 */ } }
      }
    });
  });
  req.on('error', () => {});
  return { messages, close: () => req.destroy() };
}

/* ================================================================== 第一场:solo */

async function sceneSolo(M) {
  tag = '[solo] ';
  const R = {};
  out.scenes.solo = R;
  const dir = path.join(OUT, 'solo');
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  let ctxA = null, ctxB = null, sse = null;
  try {
    const P0 = await newProject(M, 'solo');
    /* ---------------- 一:甲自己产 */
    const a = await P0.member(browserA, 'psp-jia');
    ctxA = a.ctx;
    const pageA = a.page;
    debugProbe = async () => ({ ps: await pageStreams(pageA), plan: await P(pageA, () => { const p = window.__pcPlanPublisher?.(); return p ? { last: p.last, log: (p.log ?? []).slice(-2) } : null; }) });
    const clipId = await addCard(pageA);
    R.clip = clipId;
    const docId = await store(pageA, `return S.getState().project.id;`);
    const ready = await nodeReady(pageA, '甲');
    const fpA = ready?.envFingerprint ?? null;
    R.jia = { envFingerprint: fpA, encoder: ready?.streams && { probe: ready.streams.probe, mode: ready.streams.mode } };
    // 这张卡是空项目里的第一张:遮罩那一轮里它的稀疏版在测量时就由本页产了(不等计划、不问切分方)
    const measured = await until('甲在测量时把这张卡的稀疏版产完', async () => { const s = await pageStreams(pageA); return s && (s.measure?.results?.ok ?? 0) >= 1 ? s : null; }, 180_000, 100);
    R.measure = measured && { ...measured.measure, log: undefined, planId: String(measured.planId).slice(0, 24), claims: measured.claims };
    check(!!measured && measured.measure.produced === 2 && measured.claims === 0, '一:测量时本页产了这条流稀疏的两段,没有认领过队列任务', R.measure);
    // 等的那一段:计划发出去、队列里是 open、满密度的还没开工
    const isPlan = (s) => !!s && String(s.planId ?? '').startsWith('plan:');
    const denseRunning = (s) => isPlan(s) && s.state === 'producing' && !!s.running && !String(s.running.id).endsWith(':sparse');
    const waiting = await until('甲的清单计划发出去了,本页在等有没有切分方', async () => { const s = await pageStreams(pageA); return isPlan(s) && s.streams.length >= 1 ? s : null; }, 120_000, 100);
    R.plan = waiting && { planId: String(waiting.planId).slice(0, 40), streams: waiting.streams.length, skipped: waiting.skipped, firstSeen: { state: waiting.state, planState: waiting.planState, waitedMs: waiting.waitedMs } };
    check(!!waiting && waiting.streams.length === 1 && waiting.streams[0].clipId === clipId, '一:本页算出这张卡的单卡流(一条)', waiting?.streams);
    check(!!waiting && (waiting.state !== 'producing' || waiting.waitedMs >= WAIT_MS), '一:没等满等待时间不动手', R.plan?.firstSeen);
    const started = await until('甲开始自己产满密度的一趟', async () => { const s = await pageStreams(pageA); return denseRunning(s) ? s : null; }, 120_000, 50);
    check(!!started && started.jobs.filter((j) => j.pass === 'sparse').every((j) => j.state === 'have'), '一:稀疏的两段先查查到(测量时产的),不重产', started?.jobs);
    R.start = started && { waitedMs: started.waitedMs, planState: started.planState, starts: started.counters.starts, rowsWritten: started.counters.rowsWritten };
    check(!!started && started.waitedMs >= WAIT_MS && started.planState === 'open', `一:计划发出去 ${WAIT_MS} 毫秒以上仍是 open(没人认领),本页才开工`, R.start);
    check(!!started && started.counters.rowsWritten >= 1, '一:开工前本页把自己的那一行写进了层表', R.start);
    say('jia.started', { ...R.start });

    /* ---------------- 让路:播放 */
    const before = await until('产了几帧(让路前)', async () => { const s = await pageStreams(pageA); return s?.state === 'producing' && s.frames >= (started?.frames ?? 0) + 6 ? s : null; }, 120_000, 50);
    const tPlay = Date.now();
    await playFrom(pageA, 0.5);
    const tPlayed = Date.now();
    const released = await until('播放开始后本页停手', async () => { const s = await pageStreams(pageA); return s && !s.running ? s : null; }, 5000, 25);
    const duringPlay = [];
    for (let i = 0; i < 12; i++) { const s = await pageStreams(pageA); if (s) duringPlay.push({ playing: s.playing, frames: s.frames, running: !!s.running, starts: s.counters.starts, state: s.state }); await delay(200); }
    const stillPlaying = duringPlay.filter((s) => s.playing);
    R.yieldPlay = { framesBefore: before?.frames ?? null, playCallMs: tPlayed - tPlay, releaseMs: released ? released.at - tPlayed : null, framesAtRelease: released?.frames ?? null, yields: released?.counters.yields ?? null, aborts: released?.counters.aborts ?? null,
      samples: duringPlay.length, playingSamples: stillPlaying.length, framesDuring: [...new Set(stillPlaying.map((s) => s.frames))], startsDuring: [...new Set(stillPlaying.map((s) => s.starts))] };
    check(!!released && (released.counters.yields.play ?? 0) === 1, '让路:播放开始,本页产流让路一次(原因 play)', released?.counters);
    check(!!released && !!before && released.frames - before.frames <= 2, '让路:播放开始后至多再做完当前这一帧', { before: before?.frames, atRelease: released?.frames });
    check(stillPlaying.length >= 6 && stillPlaying.every((s) => !s.running && s.frames === released?.frames && s.starts === released?.counters.starts), '让路:播放期间本页一帧不产、不重新开工', R.yieldPlay);
    await pauseAt(pageA, CLIP.start + CLIP.duration + 1);
    const resumed = await until('停下后本页接着产', async () => { const s = await pageStreams(pageA); return s?.state === 'producing' && s.frames > (released?.frames ?? 0) ? s : null; }, 60_000, 50);
    R.yieldPlay.resumed = resumed && { starts: resumed.counters.starts, frames: resumed.frames, resumedSegments: resumed.resumedSegments };
    check(!!resumed && resumed.counters.starts === (released?.counters.starts ?? 0) + 1, '让路:播放停下后本页接着产同一段', R.yieldPlay.resumed);

    /* ---------------- 让路:拖动时间轴(真的鼠标按下、移动、松开) */
    const ruler = await pageA.$('[data-pc="ruler"]');
    const box = ruler ? await ruler.boundingBox() : null;
    if (check(!!box, '让路:找到时间轴标尺')) {
      // 等至少推完两个分段再拖:让路之后回来,这两段不该重做
      const b2 = await until('推完了两个分段(拖动前)', async () => { const s = await pageStreams(pageA); return s?.state === 'producing' && s.segments >= (started?.segments ?? 0) + 2 && s.frames > (resumed?.frames ?? 0) + 3 ? s : null; }, 180_000, 50);
      const y = box.y + box.height / 2;
      await pageA.mouse.move(box.x + 60, y);
      await pageA.mouse.down();
      await pageA.mouse.move(box.x + 90, y, { steps: 3 });
      const rel = await until('拖动开始后本页停手', async () => { const s = await pageStreams(pageA); return s && !s.running ? s : null; }, 5000, 25);
      const during = [];
      for (let i = 0; i < 8; i++) { await pageA.mouse.move(box.x + 90 + i * 6, y); const s = await pageStreams(pageA); if (s) during.push({ frames: s.frames, running: !!s.running, starts: s.counters.starts }); await delay(200); }
      await pageA.mouse.up();
      R.yieldDrag = { framesBefore: b2?.frames ?? null, segmentsBefore: b2?.segments ?? null, framesAtRelease: rel?.frames ?? null, yields: rel?.counters.yields ?? null, framesDuring: [...new Set(during.map((s) => s.frames))], runningDuring: during.filter((s) => s.running).length };
      check(!!rel && (rel.counters.yields.drag ?? 0) === 1, '让路:拖动开始,本页产流让路一次(原因 drag)', rel?.counters);
      check(during.length >= 6 && during.every((s) => !s.running && s.frames === rel?.frames && s.starts === rel?.counters.starts), '让路:拖动期间本页一帧不产、不重新开工', R.yieldDrag);
      await pauseAt(pageA, CLIP.start + CLIP.duration + 1);
    }

    /* ---------------- 一(续):产完 */
    const tDone = Date.now();
    const done = await until('甲把这条流产完', async () => { const s = await pageStreams(pageA); return s?.state === 'done' ? s : null; }, 900_000, 250);
    const diagA = await nodeDiag(pageA);
    R.produce = { ms: done ? Date.now() - t0 : null, sinceYieldsMs: Date.now() - tDone, jobs: done?.jobs.map((j) => ({ id: j.id.slice(0, 20) + j.id.slice(-4), state: j.state })), counters: done?.counters,
      node: diagA && { claims: diagA.counters.claims, completed: diagA.counters.completed, streamTasks: diagA.counters.streamTasks, dedup: diagA.counters.dedup },
      streams: diagA?.streams && { encoders: diagA.streams.encoders, frames: diagA.streams.frames, blank: diagA.streams.blank, segments: diagA.streams.segments, inits: diagA.streams.inits, bytes: diagA.streams.bytes, resumedSegments: diagA.streams.resumedSegments,
        pixelsMs: diagA.streams.pixelsMs, encodeMs: diagA.streams.encodeMs }, stageFrameMs: diagA?.stage?.frameMs ?? null, lastError: done?.lastError ?? null };
    say('jia.produced', { ms: R.produce.ms, counters: done?.counters });
    check(!!done && done.jobs.length === 4 && done.jobs.every((j) => j.state === (j.pass === 'sparse' ? 'have' : 'produced')) && done.counters.produced === 4 && done.counters.failed === 0,
      '一:这条流的两段都由本页产完(稀疏两段在测量时、满密度两段在闲时),没有做不成的', done?.jobs.map((j) => ({ pass: j.pass, state: j.state })));
    check(diagA?.counters?.claims === 0 && diagA.counters.streamTasks === 0 && diagA.counters.completed === 0, '一:甲的节点一个队列任务都没认领过(这条流不是经队列产的)', R.produce.node);
    check(done?.planState === 'open', '一:清单计划一直没人认领(线上没有能切分的节点)', { planState: done?.planState });
    check((diagA?.streams?.resumedSegments ?? 0) >= 1, '让路:让路之前推完的分段没有重做', R.produce.streams);
    const key1 = done?.streams[0]?.streamKey ?? null, ck1 = done?.streams[0]?.contentKey ?? null;
    check(!!key1 && key1 === M.resultKeyOf(ck1, fpA), '一:结果键 = 内容键 × 甲的指纹', { key: String(key1).slice(0, 12) });
    // 层表与清单
    const got = await until('层表里有这张卡的流', async () => { const x = await rowOf(P0.content, docId, clipId); return x.row ? x : null; }, 30_000, 500);
    const row1 = got?.row ?? null;
    R.layerMap = { v: got?.body?.v ?? null, layers: (got?.body?.layers ?? []).length, streams: (got?.body?.streams ?? []).length, row: briefRow(row1) };
    if (!check(got?.body?.v === 3 && got.body.kind === 'layer-map' && !!row1, '一:内容库里的层表(v 3)由本页写了 streams,有这张卡的一行', R.layerMap)) throw new Error('层表里没有这条流');
    check(row1.kind === 'card' && row1.plane === 'local' && row1.clipIds.join() === clipId && row1.contentKey === ck1 && /^s1-/.test(row1.inputSig ?? ''), '一:这一行是这张卡的单卡流,内容键与本页算的相同,带输入签名', R.layerMap.row);
    check(row1.candidates.length === 1 && row1.candidates[0].envFingerprint === fpA && row1.candidates[0].resultKey === key1, '一:候选只有甲的指纹,结果键就是甲产的那条流', R.layerMap.row);
    check(row1.originFrame === ORIGIN_FRAME && !('firstSegment' in row1) && row1.lastSegment === 8 && row1.segmentsPerTask === 8,
      '一:这一行带着这条流的第一帧(第 12 帧),分段从它起数 0～8,每份清单 8 段(与队列那条路同一种切法);行里不写 firstSegment', R.layerMap.row);
    const v1 = await verifyStream(P0, M, row1, key1, { encoder: 'webcodecs-avc' });
    R.stream = { ...v1, blocks: undefined };
    check(v1.manifestsOk === v1.manifests && v1.manifests === 2, '一:内容库 render-manifest 里两份流清单(过 manifestMatches、分段齐、webcodecs-avc、满密度)', R.stream);
    check(v1.count >= 10 && v1.complete === v1.count && v1.hashOk === v1.count, '一:素材服务 px 里开头文件与 9 个分段都 complete,取回的字节哈希与清单一致', R.stream);

    /* ---------------- 一(续):甲自己播 */
    await pauseAt(pageA, 0.6);
    const readyA = await until('甲认出自己产的流、分段就绪', async () => { const d = await onlineDiag(pageA); const s = (d?.streams ?? []).find((x) => x.clipId === clipId); return s && s.ready >= 2 ? s : null; }, 90_000, 300);
    check(!!readyA && readyA.resultKey === key1, '一:甲的就绪索引里选中的是自己产的那条流', readyA && { resultKey: String(readyA.resultKey).slice(0, 12), ready: readyA.ready });
    const playA = await playAndSample(pageA, clipId, { from: 0.6, to: 2.1, key: key1 });
    R.playJia = checkStreamPlaying('一 甲', playA, { key: key1 });
    R.pixels = await comparePixels(pageA, clipId, { from: 0.6, name: 'solo-jia', dir, key: key1, until: 2.2 });
    await pauseAt(pageA, CLIP.start + CLIP.duration + 1);
    const pushedA = (await nodeDiag(pageA))?.upload ?? null;

    /* ---------------- 二:乙打开同一个项目 */
    const writesBeforeYi = editorPxWrites().length;
    const b = await P0.member(browserB, 'psp-yi');
    ctxB = b.ctx;
    const pageB = b.page;
    await until('乙收到这张卡', () => store(pageB, `return S.getState().project.tracks.some((t) => t.clips.some((c) => c.id === args[0]));`, clipId), 60_000, 300);
    const readyB = await nodeReady(pageB, '乙');
    const fpB = readyB?.envFingerprint ?? null;
    const doneB = await until('乙查完这条流(先查)', async () => { const s = await pageStreams(pageB); return s?.state === 'done' ? s : null; }, 180_000, 250);
    const diagB = await nodeDiag(pageB);
    R.yi = { envFingerprint: fpB, sameFingerprintAsJia: fpB === fpA, state: doneB?.state ?? null, waitedMs: doneB?.waitedMs ?? null, jobs: doneB?.jobs.map((j) => ({ state: j.state, via: String(j.via).slice(0, 12) })), counters: doneB?.counters,
      streams: diagB?.streams && { encoders: diagB.streams.encoders, frames: diagB.streams.frames, segments: diagB.streams.segments, inits: diagB.streams.inits }, upload: diagB?.upload && { pushed: diagB.upload.pushed, bytes: diagB.upload.bytes },
      pxWrites: editorPxWrites().length - writesBeforeYi };
    say('yi.checked', { ...R.yi });
    check(!!doneB && doneB.jobs.length === 4 && doneB.jobs.every((j) => (j.state === 'have' || j.state === 'elsewhere') && j.via === key1), '二:乙查到这条流已经有了(稀疏、满密度各两段都是),用的就是甲产的那一条', R.yi.jobs);
    check(!!doneB && doneB.counters.starts === 0 && doneB.counters.produced === 0, '二:乙没有重产(一次都没开工)', doneB?.counters);
    check(diagB?.streams?.encoders === 0 && diagB.streams.frames === 0 && diagB.streams.segments === 0 && diagB.streams.inits === 0, '二:乙没有起编码器、没有送帧、没有推分段', R.yi.streams);
    check((diagB?.upload?.pushed ?? -1) === 0 && R.yi.pxWrites === 0, '二:乙没有往素材服务推任何块', { upload: R.yi.upload, pxWrites: R.yi.pxWrites });
    await pauseAt(pageB, 0.6);
    const readyB2 = await until('乙认出这条流、分段就绪', async () => { const d = await onlineDiag(pageB); const s = (d?.streams ?? []).find((x) => x.clipId === clipId); return s && s.ready >= 2 ? s : null; }, 90_000, 300);
    check(!!readyB2 && readyB2.resultKey === key1, '二:乙的就绪索引里选中的就是甲产的那条流', readyB2 && { resultKey: String(readyB2.resultKey).slice(0, 12) });
    const playB = await playAndSample(pageB, clipId, { from: 0.6, to: 2.1, key: key1 });
    R.playYi = checkStreamPlaying('二 乙', playB, { key: key1 });
    await pauseAt(pageB, CLIP.start + CLIP.duration + 1);

    /* ---------------- 二(续):桌面预渲染进程连上来(能产流,不是只切分) */
    const framesBefore = { a: (await nodeDiag(pageA))?.streams?.frames ?? null, b: (await nodeDiag(pageB))?.streams?.frames ?? null, encA: (await nodeDiag(pageA))?.streams?.encoders ?? null };
    const dedupBefore = ((await nodeDiag(pageA))?.counters?.dedup ?? 0) + ((await nodeDiag(pageB))?.counters?.dedup ?? 0);
    const desk = await startDesk(P0, M, dir, 'solo', { planOnly: false, streams: true });
    const deskStreams0 = (await editor.diagnostics().catch(() => null))?.streams ?? null;
    check(deskStreams0?.enabled === true, '二:桌面的流开关开着(它是能产流的切分方)', deskStreams0 && { enabled: deskStreams0.enabled });
    const split = await until('桌面认领清单计划、切分', async () => { const q = await editor.queue(); return q?.stats?.planSplit >= 1 ? q : null; }, 600_000, 500);
    const locked = await until('桌面查到这条流已经有了、拉回本机、记下锁', async () => { const d = await editor.diagnostics(); return (d?.foreignStreams?.locks ?? []).some(([k]) => k === ck1) ? d : null; }, 120_000, 500);
    const lock = (locked?.foreignStreams?.locks ?? []).find(([k]) => k === ck1) ?? null;
    R.desk = { ...desk, planSplit: split?.stats?.planSplit ?? null, lock: lock && { contentKey: String(lock[0]).slice(0, 12), envFingerprint: lock[1] }, last: locked?.foreignStreams?.last ?? null };
    check(!!lock && lock[1] === fpA, '二:桌面算出的内容键与页面算的相同,这条流锁在甲的指纹上', R.desk);
    // 切分给浏览器出的那一份(键相同)由在线页面的节点去重即完成
    const deduped = await until('在线页面的节点认领桌面切出的流任务、去重即完成', async () => {
      const n = ((await nodeDiag(pageA))?.counters?.dedup ?? 0) + ((await nodeDiag(pageB))?.counters?.dedup ?? 0);
      return n - dedupBefore >= 2 ? n : null;
    }, 180_000, 500);
    await delay(3000);
    const deskD = await editor.diagnostics().catch(() => null);
    const deskQ = deskD?.queue ?? null;
    const mineStream = (list) => (list ?? []).filter((id) => String(id).startsWith('stream:'));
    const framesAfter = { a: (await nodeDiag(pageA))?.streams?.frames ?? null, b: (await nodeDiag(pageB))?.streams?.frames ?? null, encA: (await nodeDiag(pageA))?.streams?.encoders ?? null };
    R.desk.after = { stats: deskQ?.stats ?? null, streamClaimed: mineStream(deskQ?.local?.claimed).length, streamCompleted: mineStream(deskQ?.local?.completed).length, producer: deskD?.streams?.stats ?? null,
      streamKeys: (deskD?.streams?.streams ?? []).map((s) => ({ key: String(s.streamKey).slice(0, 12), segments: Object.keys(s.segments ?? {}).length })), dedupByPages: deduped ? deduped - dedupBefore : null, framesBefore, framesAfter };
    say('desk.after', R.desk.after);
    check(mineStream(deskQ?.local?.claimed).length === 0 && (deskD?.streams?.stats?.segments ?? -1) === 0, '二:桌面没有重产这条流(没认领流任务,生产者一个分段都没产)', R.desk.after);
    check(!!deduped, '二:桌面切出的这条流的任务(照锁只出浏览器那一份)由在线页面的节点去重即完成', R.desk.after);
    check(framesAfter.a === framesBefore.a && framesAfter.b === framesBefore.b && framesAfter.encA === framesBefore.encA, '二:在线页面也没有重产(没有再送帧、没有再起编码器)', { framesBefore, framesAfter });
    const row2 = (await rowOf(P0.content, docId, clipId)).row;
    R.desk.row = briefRow(row2);
    check(!!row2 && row2.contentKey === ck1 && row2.candidates.some((c) => c.resultKey === key1) && row2.candidates.every((c) => c.envFingerprint !== desk.deskFp), '二:桌面写的层表里这一行仍指向甲产的那条流,不列桌面自己的指纹', R.desk.row);
    // 「能拉回去播」:桌面的流库里有这条流;它自己的页面会话打开这一版,收到的流层就是这个键;分段读口取得到、字节相同
    const base = await editor.prerender();
    const session = `psp-${RUN}`;
    sse = watchReady(base, session);
    const projectJson = await store(pageA, `return JSON.parse(JSON.stringify(S.getState().project));`);
    const pre = await fetch(`${base}/api/frames/preload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: projectJson, session, localRev: 1 }) }).then((r) => r.status, () => null);
    const layer = await until('桌面的页面会话收到这条流的层', async () => {
      const hit = [...sse.messages].reverse().find((m) => m?.type === 'layer' && m.kind === 'stream' && m.clipId === clipId);
      return hit && hit.key === key1 && (hit.ranges ?? []).some(([f, t]) => f <= 0 && t >= 8) ? hit : null;
    }, 300_000, 500);
    const streamLayers = sse.messages.filter((m) => m?.type === 'layer' && m.kind === 'stream' && m.clipId === clipId).map((m) => ({ key: String(m.key).slice(0, 12), ranges: m.ranges }));
    const man = await fetch(`${base}/api/frames/stream/${key1}/manifest`).then((r) => (r.ok ? r.json() : null), () => null);
    const segNames = Object.keys(man?.segments ?? {}).map(Number).sort((x, y) => x - y);
    let bytesOk = 0;
    for (const n of segNames) {
      const want = v1.blocks.find((x) => x.segment === n)?.hash ?? null;
      const file = man.segments[n]?.file ?? null;
      const buf = file ? await fetch(`${base}/api/frames/stream/${key1}/seg/${file}`).then(async (r) => (r.ok ? Buffer.from(await r.arrayBuffer()) : null), () => null) : null;
      if (buf && want && sha256(buf) === want) bytesOk++;
    }
    R.desk.play = { preload: pre, layer: layer && { key: String(layer.key).slice(0, 12), ranges: layer.ranges }, streamLayers: streamLayers.slice(-3), manifestSegments: segNames.length, bytesOk,
      producerAfter: (await editor.diagnostics().catch(() => null))?.streams?.stats ?? null };
    check(pre === 200 && !!layer, '二:桌面自己的页面会话打开这一版,收到的流层就是甲产的那条(键相同,分段 0～8 就绪)', R.desk.play);
    check(streamLayers.every((l) => l.key === String(key1).slice(0, 12)), '二:桌面没有给这张卡发过别的键的流层(它没有按自己的指纹另起一条)', streamLayers.slice(-4));
    check(segNames.length === 9 && bytesOk === 9, '二:桌面的分段读口取得到这条流的 9 个分段,字节与素材服务上的相同', { segments: segNames.length, bytesOk });
    check((R.desk.play.producerAfter?.segments ?? -1) === 0, '二:打开之后桌面的生产者仍然一个分段都没产', R.desk.play.producerAfter);

    R.pageErrors = { jia: pageA.errors.slice(0, 5), yi: pageB.errors.slice(0, 5) };
    check(pageA.errors.length === 0 && pageB.errors.length === 0, '两个页面都没有未捕获的错误', R.pageErrors);
    R.uploadJia = pushedA && { pushed: pushedA.pushed, bytes: pushedA.bytes, failed: pushedA.failed };
    R.ms = Date.now() - t0;
  } catch (e) {
    fails.push(`${tag}异常:${String(e?.stack ?? e).slice(0, 800)}`);
    try { if (debugProbe) R.atFailure = await debugProbe(); } catch { /* 页面不在了 */ }
  } finally {
    debugProbe = null;
    try { sse?.close(); } catch { /* 已关 */ }
    try { chk?.close(); } catch { /* 已关 */ }
    chk = null;
    try { await ctxA?.close(); } catch { /* 已关 */ }
    try { await ctxB?.close(); } catch { /* 已关 */ }
    await stopDesk();
    say('scene.done', { scene: 'solo', ms: Date.now() - t0, fails: fails.length });
  }
}

/* ================================================================== 第二场:splitter(先有能切分的节点在线) */

async function sceneSplitter(M) {
  tag = '[splitter] ';
  const R = {};
  out.scenes.splitter = R;
  const dir = path.join(OUT, 'splitter');
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  let ctxA = null;
  try {
    const P0 = await newProject(M, 'splitter');
    // 只切分、自己不产流:流只能由在线页面的节点经队列产
    R.desk = await startDesk(P0, M, dir, 'splitter', { planOnly: true, streams: false });
    const a = await P0.member(browserA, 'psp-jia');
    ctxA = a.ctx;
    const pageA = a.page;
    debugProbe = async () => ({ ps: await pageStreams(pageA), desk: (await editor.queue().catch(() => null))?.stats ?? null });
    const clipId = await addCard(pageA);
    const docId = await store(pageA, `return S.getState().project.id;`);
    const ready = await nodeReady(pageA, '甲');
    const fpA = ready?.envFingerprint ?? null;
    // 从加卡起一直看着:稀疏版在测量时由本页产(那一趟不问有没有切分方);清单计划那一份记账下,本页一次都不许开工
    const seen = { states: new Set(), planStates: new Set(), starts: 0, running: 0, samples: 0, dense: 0 };
    const look = (s) => {
      if (!s) return;
      seen.samples++; seen.planStates.add(s.planState); seen.starts = Math.max(seen.starts, s.counters.starts);
      const plan = String(s.planId ?? '').startsWith('plan:');
      if (plan) seen.states.add(s.state);
      if (s.running && plan) seen.running++;
      if (s.running && !String(s.running.id).endsWith(':sparse')) seen.dense++;
    };
    const doneQueue = await until('这条流经队列产出来(甲的节点做完两个流任务)', async () => {
      look(await pageStreams(pageA));
      const d = await nodeDiag(pageA);
      return d?.counters?.streamTasks >= 2 && d.state !== 'baking' ? d : null;
    }, 900_000, 200);
    // 做完之后再看一阵:过了等待时间也不开工
    for (let i = 0; i < 40; i++) { look(await pageStreams(pageA)); await delay(200); }
    const last = await pageStreams(pageA);
    const deskQ = await editor.queue().catch(() => null);
    R.page = { envFingerprint: fpA, samples: seen.samples, states: [...seen.states], planStates: [...seen.planStates], starts: seen.starts, runningSamples: seen.running, denseSamples: seen.dense,
      measure: last?.measure && { ...last.measure, log: undefined }, counters: last?.counters ?? null, streams: last?.streams?.length ?? null,
      node: doneQueue?.counters && { claims: doneQueue.counters.claims, completed: doneQueue.counters.completed, streamTasks: doneQueue.counters.streamTasks }, ms: Date.now() - t0 };
    R.desk.stats = deskQ?.stats ?? null;
    say('splitter.done', R.page);
    check(!!doneQueue && doneQueue.counters.streamTasks >= 2 && doneQueue.counters.failed === 0, '三:这条流经队列产出来(桌面切分,甲的节点认领并完成流任务)', doneQueue?.counters);
    check((deskQ?.stats?.planSplit ?? 0) >= 1, '三:桌面认领并切分了甲的清单计划', deskQ?.stats);
    const atMeasure = last?.measure?.produced ?? -1;
    check(seen.samples >= 30 && seen.running === 0 && seen.dense === 0 && !seen.states.has('producing'), '三:清单计划发出去以后页面没有走本页产流这条路(一次都没开工;满密度的一帧没产)', R.page);
    check(atMeasure >= 1 && last?.counters?.produced === atMeasure && last.counters.starts === atMeasure, '三:本页自己产的只有测量时那一趟稀疏版(开工次数 = 测量时产的段数)', { atMeasure, counters: last?.counters });
    check(last?.state === 'taken' && (last.planState === 'done' || last.planState === 'claimed'), '三:本页看到的是「有切分方接了活」', last && { state: last.state, planState: last.planState });
    const row = (await rowOf(P0.content, docId, clipId)).row;
    R.row = briefRow(row);
    check(!!row && last?.streams?.[0]?.contentKey === row.contentKey && row.candidates.some((c) => c.envFingerprint === fpA && c.resultKey === last.streams[0].streamKey),
      '三:同一条流,页面一侧算的内容键、结果键与切分方写进层表的相同', { row: R.row, page: last?.streams?.[0] && { contentKey: String(last.streams[0].contentKey).slice(0, 12), streamKey: String(last.streams[0].streamKey).slice(0, 12) } });
    check(pageA.errors.length === 0, '页面没有未捕获的错误', pageA.errors.slice(0, 5));
  } catch (e) {
    fails.push(`${tag}异常:${String(e?.stack ?? e).slice(0, 800)}`);
    try { if (debugProbe) R.atFailure = await debugProbe(); } catch { /* 页面不在了 */ }
  } finally {
    debugProbe = null;
    try { chk?.close(); } catch { /* 已关 */ }
    chk = null;
    try { await ctxA?.close(); } catch { /* 已关 */ }
    await stopDesk();
    say('scene.done', { scene: 'splitter', ms: Date.now() - t0, fails: fails.length });
  }
}

/* ================================================================== 第三场:desk(素材服务里已经有桌面产好的流) */

async function sceneDesk(M) {
  tag = '[desk] ';
  const R = {};
  out.scenes.desk = R;
  const dir = path.join(OUT, 'desk');
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  let ctxX = null, ctxY = null;
  try {
    const P0 = await newProject(M, 'desk');
    // 桌面能产流、认领细任务;加卡的页面不当节点(报非 Chromium 内核),所以这条流只能由桌面产
    const desk = await startDesk(P0, M, dir, 'desk', { planOnly: false, streams: true });
    const x = await P0.member(browserB, 'psp-bing', { userAgent: NON_NODE_UA });
    ctxX = x.ctx;
    const pageX = x.page;
    const clipId = await addCard(pageX);
    const docId = await store(pageX, `return S.getState().project.id;`);
    const notNode = await until('丙不当节点', async () => { const d = await nodeDiag(pageX); return d && d.eligibility?.ok === false ? d : null; }, 120_000, 500);
    check(notNode?.eligibility?.reason === 'not-chromium', '四(准备):加卡的页面不当节点', notNode?.eligibility);
    debugProbe = async () => ({ desk: (await editor?.queue().catch(() => null))?.stats ?? null, row: briefRow((await rowOf(P0.content, docId, clipId)).row) });
    const produced = await until('桌面把这条流产好、推到素材服务(满密度)', async () => {
      const { row } = await rowOf(P0.content, docId, clipId);
      const cand = row?.candidates.find((c) => c.envFingerprint === desk.deskFp);
      if (!cand) return null;
      for (const [from, to] of spansOf(row)) {
        const m = await P0.getManifest(cand.resultKey, from, to);
        const segs = Object.keys(m?.segments ?? {});
        if (segs.length !== to - from + 1 || segs.some((n) => m.segments[n].stride !== 1)) return null;
      }
      return { row, cand };
    }, 900_000, 1000);
    if (!check(!!produced, '四(准备):桌面产好了这条流,层表里有它的那一行')) throw new Error('桌面没有产出流');
    const rowD = produced.row, keyD = produced.cand.resultKey;
    const vD = await verifyStream(P0, M, rowD, keyD);
    R.desk = { ...desk, row: briefRow(rowD), stream: { ...vD, blocks: undefined }, ms: Date.now() - t0 };
    say('desk.produced', R.desk);
    check(vD.manifestsOk === vD.manifests && vD.complete === vD.count && vD.hashOk === vD.count, '四(准备):桌面产的流清单齐、满密度,块都在素材服务上', R.desk.stream);
    check(!vD.encoders.includes('webcodecs-avc'), '四(准备):这条流是桌面用 ffmpeg 压的(不是浏览器压的)', vD.encoders);
    // 桌面下线、加卡的页面关掉:线上只剩文档服务与素材服务
    await stopDesk();
    try { await ctxX.close(); } catch { /* 已关 */ }
    ctxX = null;

    const writesBefore = editorPxWrites().length;
    const y = await P0.member(browserA, 'psp-ding');
    ctxY = y.ctx;
    const pageY = y.page;
    debugProbe = async () => ({ ps: await pageStreams(pageY) });
    await until('丁收到这张卡', () => store(pageY, `return S.getState().project.tracks.some((t) => t.clips.some((c) => c.id === args[0]));`, clipId), 60_000, 300);
    const ready = await nodeReady(pageY, '丁');
    const fpY = ready?.envFingerprint ?? null;
    // 等它过了等待时间、把该查的查完(状态落在 done 或 taken)
    const settled = await until('丁的本页产流落定(不产)', async () => { const s = await pageStreams(pageY); return s && s.streams.length >= 1 && (s.state === 'done' || s.state === 'taken') && s.waitedMs >= WAIT_MS + 3000 ? s : null; }, 180_000, 250);
    for (let i = 0; i < 20; i++) await delay(200);
    const last = await pageStreams(pageY);
    const diagY = await nodeDiag(pageY);
    R.page = { envFingerprint: fpY, state: last?.state ?? null, planState: last?.planState ?? null, waitedMs: last?.waitedMs ?? null, jobs: last?.jobs.map((j) => ({ state: j.state, via: j.via ? String(j.via).slice(0, 12) : null })), counters: last?.counters ?? null,
      streams: diagY?.streams && { encoders: diagY.streams.encoders, frames: diagY.streams.frames, segments: diagY.streams.segments, inits: diagY.streams.inits }, upload: diagY?.upload && { pushed: diagY.upload.pushed, bytes: diagY.upload.bytes },
      pxWrites: editorPxWrites().length - writesBefore, node: diagY?.counters && { claims: diagY.counters.claims, streamTasks: diagY.counters.streamTasks } };
    say('ding.settled', R.page);
    check(!!settled, '四:页面打开项目后本页产流落定在「不产」', last && { state: last.state, planState: last.planState });
    check(last?.streams?.[0]?.contentKey === rowD.contentKey, '四:页面一侧算的内容键与桌面写进层表的相同(同一条流)', { page: String(last?.streams?.[0]?.contentKey).slice(0, 12), desk: String(rowD.contentKey).slice(0, 12) });
    check(last?.counters?.starts === 0 && last.counters.produced === 0, '四:页面没有产(一次都没开工)', last?.counters);
    check(diagY?.streams?.encoders === 0 && diagY.streams.frames === 0 && diagY.streams.segments === 0 && diagY.streams.inits === 0, '四:页面没有起编码器、没有送帧、没有推这条流的分段', R.page.streams);
    check((diagY?.upload?.pushed ?? -1) === 0 && R.page.pxWrites === 0, '四:页面没有往素材服务推任何块', { upload: R.page.upload, pxWrites: R.page.pxWrites });
    if (last?.state === 'done') check(last.jobs.every((j) => j.state === 'elsewhere' && j.via === keyD), '四:先查查到的就是桌面产的那一条', R.page.jobs);
    // 直接贴:播放时画的就是桌面产的那条流
    await pauseAt(pageY, 0.6);
    const readyY = await until('丁认出桌面产的流、分段就绪', async () => { const d = await onlineDiag(pageY); const s = (d?.streams ?? []).find((z) => z.clipId === clipId); return s && s.ready >= 2 ? s : null; }, 90_000, 300);
    check(!!readyY && readyY.resultKey === keyD && readyY.envFingerprint === desk.deskFp, '四:丁的就绪索引里选中的是桌面产的那条流', readyY && { resultKey: String(readyY.resultKey).slice(0, 12), envFingerprint: readyY.envFingerprint });
    const playY = await playAndSample(pageY, clipId, { from: 0.6, to: 2.1, key: keyD });
    R.play = checkStreamPlaying('四 丁', playY, { key: keyD });
    R.pixels = await comparePixels(pageY, clipId, { from: 0.6, name: 'desk-ding', dir, key: keyD, until: 2.2 });
    const after = await nodeDiag(pageY);
    check(after?.streams?.encoders === 0 && (after?.upload?.pushed ?? -1) === 0, '四:播完之后页面仍然没有起过编码器、没有推过块', after?.streams && { encoders: after.streams.encoders, pushed: after.upload?.pushed });
    check(pageY.errors.length === 0, '页面没有未捕获的错误', pageY.errors.slice(0, 5));
    R.ms = Date.now() - t0;
  } catch (e) {
    fails.push(`${tag}异常:${String(e?.stack ?? e).slice(0, 800)}`);
    try { if (debugProbe) R.atFailure = await debugProbe(); } catch { /* 页面不在了 */ }
  } finally {
    debugProbe = null;
    try { chk?.close(); } catch { /* 已关 */ }
    chk = null;
    try { await ctxX?.close(); } catch { /* 已关 */ }
    try { await ctxY?.close(); } catch { /* 已关 */ }
    await stopDesk();
    say('scene.done', { scene: 'desk', ms: Date.now() - t0, fails: fails.length });
  }
}

/* ================================================================== 第四、五场:打开项目、测量时就产稀疏版 */

/** 与 `src/online/pageStreams.ts` 的 `MEASURE_SPARSE_MAX_MS` 同值:遮罩等稀疏版最多这么久 */
const MASK_SPARSE_MS = 50_000;

/**
 * 页面一建好就装上:页面里每 100 毫秒记一次「遮罩在不在、本页产流到哪了」(只在有变化时记一条),render 连接上发出的 `node.active` 记在 `acts` 里。
 * 时刻都是页面里的 `Date.now()`,与 `pageStreams` 的时钟同一个。
 */
async function instrument(page) {
  const acts = [];
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameSent', (e) => {
    const text = String(e?.response?.payloadData ?? '');
    if (!text.includes('"node.active"')) return;
    try { const m = JSON.parse(text); if (m?.type === 'node.active') acts.push({ at: Date.now(), busy: m.busy ?? null }); } catch { /* 不是整条 JSON */ }
  });
  await page.evaluateOnNewDocument(() => {
    if (window.top !== window) return;
    const log = [];
    let last = '';
    window.__pspMaskLog = log;
    setInterval(() => {
      try {
        const d = window.__pcBrowserNode?.();
        const ps = d?.pageStreams ?? null;
        const jobs = {};
        for (const j of ps?.jobs ?? []) { const k = `${j.pass}:${j.state}`; jobs[k] = (jobs[k] ?? 0) + 1; }
        const row = {
          mask: !!document.querySelector('[data-pc="probe-gate"]'), state: ps?.state ?? null, plan: ps?.planId ? String(ps.planId).slice(0, 8) : null,
          running: ps?.running ? (String(ps.running.id).endsWith(':sparse') ? 'sparse' : 'dense') : null, jobs,
          m: ps ? { calls: ps.measure.calls, results: ps.measure.results, startedAt: ps.measure.startedAt, produced: ps.measure.produced, have: ps.measure.have, elsewhere: ps.measure.elsewhere, left: ps.measure.left } : null,
          segments: d?.streams?.segments ?? null, encoders: d?.streams?.encoders ?? null, claims: d?.counters?.claims ?? null, playing: !!window.__pcStore?.getState?.().playing,
        };
        const text = JSON.stringify(row);
        if (text === last) return;
        last = text;
        log.push({ at: Date.now(), frames: d?.streams?.frames ?? null, ...row });
        if (log.length > 4000) log.splice(0, 1000);
      } catch { /* 页面还没起来 */ }
    }, 100);
  });
  return { acts };
}
const maskLog = (page) => P(page, () => JSON.parse(JSON.stringify(window.__pspMaskLog ?? []))).catch(() => []);
/** 等遮罩出现过、又撤下;回 { log, shownAt, goneAt } */
async function waitMaskGone(page, who, timeoutMs) {
  return until(`${who} 的加载遮罩出现过又撤下`, async () => {
    const log = await maskLog(page);
    const first = log.findIndex((e) => e.mask);
    if (first < 0) return null;
    let lastOn = -1;
    for (let i = log.length - 1; i >= 0; i--) if (log[i].mask) { lastOn = i; break; }
    const gone = log[lastOn + 1];
    // 遮罩撤下后稳了半秒才算(两轮测量之间它会闪一下不在)
    return gone && Date.now() - gone.at >= 500 && !log.slice(lastOn + 1).some((e) => e.mask) ? { log, shownAt: log[first].at, goneAt: gone.at, atGone: gone } : null;
  }, timeoutMs, 200);
}
/** 这条流此刻在内容库里的清单:每份任务范围一份;回各分段的密度、有没有位置矩形 */
async function manifestState(P0, row, resultKey) {
  const segs = {};
  let manifests = 0;
  for (const [from, to] of spansOf(row)) {
    const m = await P0.getManifest(resultKey, from, to);
    if (!m) continue;
    manifests++;
    for (const n of Object.keys(m.segments ?? {})) segs[n] = { stride: m.segments[n].stride, samples: m.segments[n].samples, box: m.segments[n].box ?? (('box' in m.segments[n]) ? null : undefined) };
  }
  const list = Object.values(segs);
  return { manifests, want: row.lastSegment + 1, have: list.length, sparse: list.filter((x) => x.stride > 1).length, dense: list.filter((x) => x.stride === 1).length,
    boxed: list.filter((x) => x.box && x.box.w > 0 && x.box.h > 0).length, strides: [...new Set(list.map((x) => x.stride))] };
}
/** 准备:一个不当节点的页面(报非 Chromium 内核)把卡加好、关掉。它照常测量,但不产流 */
async function seedCards(P0, cards) {
  const x = await P0.member(browserB, 'psp-seed', { userAgent: NON_NODE_UA });
  const ids = [];
  try {
    for (const c of cards) ids.push(await addCard(x.page, { start: c.start, duration: c.duration }, c.label, c.burnMs ?? 40));
    const docId = await store(x.page, `return S.getState().project.id;`);
    const rev = await until('加的卡都被文档服务确认', () => P(x.page, (n) => { const p = window.__pcStore?.getState?.().project; return p && p.tracks.flatMap((t) => t.clips).filter((c) => c.cardId === 'probe-slow-stepped').length === n; }, cards.length), 60_000, 300);
    await delay(2500);
    const d = await nodeDiag(x.page);
    check(d?.eligibility?.reason === 'not-chromium' && (d?.streams?.frames ?? 0) === 0, '(准备)加卡的页面不当节点、一帧没产', d && { eligibility: d.eligibility, frames: d.streams?.frames, measureSparse: d.measureSparse });
    return { ids, docId, ok: !!rev };
  } finally { try { await x.ctx.close(); } catch { /* 已关 */ } }
}

async function sceneMask(M) {
  tag = '[mask] ';
  const R = {};
  out.scenes.mask = R;
  const dir = path.join(OUT, 'mask');
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  let ctxA = null, ctxB = null;
  try {
    const P0 = await newProject(M, 'mask');
    // 三张卡一前一后排开(各 2 秒 = 60 帧 = 4 个分段,一份任务),互不重叠
    const CARDS = [{ start: 0.4, duration: 2, label: 'aa' }, { start: 2.6, duration: 2, label: 'bb' }, { start: 4.8, duration: 2, label: 'cc' }];
    const seeded = await seedCards(P0, CARDS);
    const [clipA, , clipC] = seeded.ids;
    R.clips = seeded.ids;

    /* ---------------- 一:甲打开项目,遮罩下产稀疏版 */
    let instA = null;
    const a = await P0.member(browserA, 'psp-jia', { before: async (page) => { instA = await instrument(page); } });
    ctxA = a.ctx;
    const pageA = a.page;
    debugProbe = async () => ({ ps: await pageStreams(pageA), log: (await maskLog(pageA)).slice(-3) });
    const gone = await waitMaskGone(pageA, '甲', 600_000);
    if (!gone) throw new Error('甲的遮罩没有撤下');
    // 进编辑的那一刻马上播放:播放时不产,稀疏版就一直是稀疏版,好比像素
    await playFrom(pageA, CARDS[0].start);
    const tPlay = Date.now();
    const atGone = gone.atGone;
    const masked = gone.log.filter((e) => e.mask);
    const diag0 = await nodeDiag(pageA);
    const fpA = diag0?.envFingerprint ?? null;
    R.maskJia = { maskMs: gone.goneAt - gone.shownAt, sparseStartedAfterMaskMs: atGone.m?.startedAt ? atGone.m.startedAt - gone.shownAt : null, atGone: { ...atGone, jobs: undefined }, framesUnderMask: masked.length ? [masked[0].frames, masked[masked.length - 1].frames] : null,
      plansUnderMask: [...new Set(masked.map((e) => e.plan))], envFingerprint: fpA, measureSparse: diag0?.measureSparse ?? null };
    say('mask.gone', R.maskJia);
    check(atGone.m?.calls === 3 && atGone.m.results?.ok === 3 && atGone.m.produced === 3 && atGone.m.left === 0, '一:遮罩下三张卡各调了一次、稀疏版都产完(每条流一份任务)', atGone.m);
    check(masked.some((e) => e.running === 'sparse') && !gone.log.some((e) => e.running === 'dense'), '一:遮罩下在产的是稀疏的一趟,满密度的一帧没产', { sparse: masked.filter((e) => e.running === 'sparse').length });
    check(masked.every((e) => !e.plan || e.plan.startsWith('measure')) && atGone.claims === 0, '一:这些都发生在清单计划发出去之前(不等计划),甲的节点没有认领过队列任务', R.maskJia.plansUnderMask);
    check(atGone.frames === 12 * SEG && atGone.encoders === 3, '一:遮罩下送进编码器 3 条流 × 4 个分段 × 15 个样本(每段只向舞台取一帧)', { frames: atGone.frames, encoders: atGone.encoders, segments: atGone.segments });
    // 内容库与素材服务:遮罩撤下时三条流的稀疏版都在(此刻在播放,本页不会接着产,看到的就是遮罩下产的)
    const ps0 = await pageStreams(pageA);
    const rows = {};
    for (const id of seeded.ids) rows[id] = (await rowOf(P0.content, seeded.docId, id)).row;
    const keyOf = (id) => rows[id]?.candidates.find((c) => c.envFingerprint === fpA)?.resultKey ?? null;
    R.sparse = {};
    for (const id of seeded.ids) R.sparse[id] = rows[id] ? { key: String(keyOf(id)).slice(0, 12), originFrame: rows[id].originFrame, ...(await manifestState(P0, rows[id], keyOf(id))) } : null;
    check(seeded.ids.every((id) => rows[id] && keyOf(id)), '一:层表里有本页的三行(候选是甲的指纹)', Object.fromEntries(seeded.ids.map((id) => [id, briefRow(rows[id])])));
    check(seeded.ids.every((id) => { const x = R.sparse[id]; return x && x.want === 4 && x.have === 4 && x.sparse === 4 && x.dense === 0 && x.boxed === 4 && x.strides.join() === String(SEG); }),
      '一:三条流的清单都在内容库里:每个分段都是稀疏版(每段一张)、都带位置矩形', R.sparse);
    const up0 = diag0?.upload ?? null;
    check((up0?.pushed ?? 0) >= 12 && (up0?.failed ?? 1) === 0, '一:分段与开头文件都推到了素材服务', up0 && { pushed: up0.pushed, failed: up0.failed });
    void ps0;

    /* ---------------- 二:进编辑时已经能贴;稀疏段贴的是分段第一帧 */
    const keyA = keyOf(clipA);
    const atEnter = ((await onlineDiag(pageA))?.streams ?? []).filter((x) => seeded.ids.includes(x.clipId) && x.ready >= 4).length;
    const readyA = await until('甲认出自己产的流、分段就绪', async () => { const d = await onlineDiag(pageA); const list = (d?.streams ?? []).filter((x) => seeded.ids.includes(x.clipId) && x.ready >= 4); return list.length === 3 ? list : null; }, 20_000, 100);
    R.ready = { readyStreamsAtFirstLook: atEnter, firstLookAfterGoneMs: tPlay - gone.goneAt, ms: Date.now() - tPlay, streams: (readyA ?? []).map((x) => ({ clipId: x.clipId, ready: x.ready, key: String(x.resultKey).slice(0, 12) })) };
    check(!!readyA && readyA.every((x) => x.resultKey === keyOf(x.clipId)), '二:进编辑后在线来源认的就是本页产的三条流(分段都就绪)', R.ready);
    // 播放中截图:每张记下截图前后舞台的时刻,两头落在同一个分段、离分段第一帧够远的才要
    const origin = Math.round(CARDS[0].start * FPS);
    const shots = [];
    for (let round = 0; round < 12 && shots.length < 3; round++) {
      await playFrom(pageA, CARDS[0].start);
      const tr = Date.now();
      while (Date.now() - tr < 2600 && shots.length < 3) {
        const before = await stageState(pageA, clipA);
        const tb = drawing(before, keyA);
        const fb = Math.round((before?.t ?? -1) * FPS) - origin;
        if (!tb || before.clip.placeholder || fb < 0 || fb >= 60 || fb % SEG < 7 || fb % SEG > 11 || shots.some((x) => x.seg === Math.floor(fb / SEG))) { await delay(15); continue; }
        const shot = await stageShot(pageA, dir, `mask-sparse-${shots.length}`);
        const after = await stageState(pageA, clipA);
        const fa = Math.round((after?.t ?? -1) * FPS) - origin;
        if (!shot || !drawing(after, keyA) || after.clip.placeholder || Math.floor(fa / SEG) !== Math.floor(fb / SEG)) continue;
        shots.push({ shot, seg: Math.floor(fb / SEG), fb, fa, lastDrawn: [tb.lastDrawn, drawing(after, keyA).lastDrawn] });
      }
    }
    // 保活要播满一个间隔(队列给的是 10 秒):接着循环播放,同时看本页有没有在产
    const framesAtPlay = (await nodeDiag(pageA))?.streams?.frames ?? null;
    const during = [];
    while (Date.now() - tPlay < 14_000) {
      if (!(await store(pageA, `return S.getState().playing;`))) await playFrom(pageA, CARDS[0].start);
      const s = await pageStreams(pageA);
      if (s) during.push({ playing: s.playing, frames: s.frames, running: !!s.running, starts: s.counters.starts });
      await delay(250);
    }
    const playActs = instA.acts.filter((x) => x.at >= tPlay);
    const nodeAfterPlay = await nodeDiag(pageA);
    R.play = { ms: Date.now() - tPlay, samples: during.length, playingSamples: during.filter((x) => x.playing).length, framesDuring: [...new Set(during.map((x) => x.frames))], runningSamples: during.filter((x) => x.running).length,
      startsDuring: [...new Set(during.map((x) => x.starts))], nodeActive: { all: instA.acts.length, busyAll: [...new Set(instA.acts.map((x) => x.busy))], duringPlay: playActs.map((x) => ({ afterMs: x.at - tPlay, busy: x.busy })), counter: nodeAfterPlay?.counters?.active ?? null } };
    say('mask.play', R.play);
    check(during.filter((x) => x.playing).length >= 12 && during.every((x) => !x.running && x.frames === framesAtPlay && x.starts === 3), '三:播放中本页不产(一帧不送、不开工)', R.play);
    check(playActs.some((x) => x.busy === 'play'), '三:播放中保活在发(render 连接上发出 node.active { busy: "play" })', R.play.nodeActive);
    /* ---------------- 四:停下以后,稀疏的都落定了满密度才开始;最后满密度齐、位置矩形还在 */
    await pauseAt(pageA, 7.5);
    const tIdle = Date.now();
    const doneA = await until('甲把三条流补成满密度', async () => { const s = await pageStreams(pageA); return s?.state === 'done' && String(s.planId).startsWith('plan:') ? s : null; }, 900_000, 250);
    const logA = await maskLog(pageA);
    const firstDense = logA.find((e) => e.running === 'dense') ?? null;
    R.dense = { ms: Date.now() - tIdle, firstDenseAfterGoneMs: firstDense ? firstDense.at - gone.goneAt : null, jobsAtFirstDense: firstDense?.jobs ?? null, jobs: doneA?.jobs.map((j) => ({ pass: j.pass, state: j.state })), counters: doneA?.counters, planState: doneA?.planState ?? null };
    check(!!firstDense && firstDense.at > gone.goneAt && !firstDense.mask && !firstDense.playing, '四:满密度的一趟在进编辑、停下之后才开始(闲时)', firstDense && { afterGoneMs: firstDense.at - gone.goneAt, playing: firstDense.playing });
    check(!!firstDense && !firstDense.jobs['sparse:todo'] && (firstDense.jobs['sparse:have'] ?? 0) === 3, '四:满密度开始时稀疏的三段都已落定(先查查到测量时产的,不重产)', firstDense?.jobs);
    check(!!doneA && doneA.jobs.length === 6 && doneA.jobs.every((j) => j.state === (j.pass === 'sparse' ? 'have' : 'produced')) && doneA.counters.failed === 0, '四:满密度三段由本页闲时产完', R.dense.jobs);
    R.denseManifests = {};
    for (const id of seeded.ids) R.denseManifests[id] = await manifestState(P0, rows[id], keyOf(id));
    check(seeded.ids.every((id) => { const x = R.denseManifests[id]; return x.have === 4 && x.dense === 4 && x.boxed === 4; }), '四:三条流都补成满密度,稀疏那一趟量的位置矩形还在', R.denseManifests);
    const nodeA = await nodeDiag(pageA);
    check(nodeA?.counters?.claims === 0, '四:全程没有经过任务队列(线上没有能切分的节点)', nodeA?.counters && { claims: nodeA.counters.claims });

    // 比像素(参照在满密度补齐以后截:停在稀疏段上时流的轨道留着等换满密度,`liveShot` 等的是轨道撤掉):稀疏段贴的是分段第一帧那一张
    R.pixels = [];
    if (check(shots.length >= 2, '二:播放中截到稀疏流在画的帧(至少两个分段)', shots.map((x) => ({ seg: x.seg, fb: x.fb, fa: x.fa })))) {
      for (const [i, x] of shots.entries()) {
        const first = origin + x.seg * SEG, own = origin + x.fa;
        // 几张卡的项目里停着时这张卡的流轨道留着(包裹层没被抑制,画的是活渲;这时流已经是满密度,就算露出来也是这一帧自己的画面)
        const liveFirst = await liveShot(pageA, clipA, first / FPS, dir, `mask-live-first-${i}`, { allowTrack: true });
        const liveOwn = await liveShot(pageA, clipA, own / FPS, dir, `mask-live-own-${i}`, { allowTrack: true });
        if (!check(!!liveFirst && !!liveOwn, `二:截到第 ${i} 张的两张精确活渲参照`)) continue;
        const dFirst = diffOf(x.shot.png, liveFirst.png), dOwn = diffOf(x.shot.png, liveOwn.png);
        R.pixels.push({ seg: x.seg, frameAtShot: [origin + x.fb, own], segmentFirstFrame: first, lastDrawn: x.lastDrawn, vsSegmentFirst: dFirst, vsOwnFrame: dOwn, orange: orangeOf(x.shot.png) });
        check(dFirst.mad <= 1.5 && dFirst.bad <= 0.002, `二:第 ${i} 张(分段 ${x.seg})画面与分段第一帧的精确活渲相符`, dFirst);
        check(dOwn.bad >= dFirst.bad * 3 + 0.001, `二:第 ${i} 张与它自己那一帧(晚 ${x.fa % SEG} 帧)的精确活渲差得更多:贴的是分段第一帧,不是这一帧`, { first: dFirst, own: dOwn });
      }
    }


    /* ---------------- 五:乙后进来,直接用甲产的 */
    const writesBefore = editorPxWrites().length;
    let instB = null;
    const b = await P0.member(browserB, 'psp-yi', { before: async (page) => { instB = await instrument(page); } });
    ctxB = b.ctx;
    const pageB = b.page;
    const goneB = await waitMaskGone(pageB, '乙', 600_000);
    await playFrom(pageB, CARDS[2].start);
    const diagB = await nodeDiag(pageB);
    R.yi = { sameFingerprintAsJia: diagB?.envFingerprint === fpA, maskMs: goneB ? goneB.goneAt - goneB.shownAt : null, atGone: goneB && { ...goneB.atGone, jobs: undefined },
      streams: diagB?.streams && { encoders: diagB.streams.encoders, frames: diagB.streams.frames, segments: diagB.streams.segments, inits: diagB.streams.inits }, upload: diagB?.upload && { pushed: diagB.upload.pushed }, pxWrites: editorPxWrites().length - writesBefore };
    say('mask.yi', R.yi);
    const mB = goneB?.atGone?.m ?? null;
    check(!!mB && mB.calls === 3 && mB.results?.ok === 3 && mB.produced === 0 && mB.have + mB.elsewhere === 3, '五:乙在遮罩下先查到三条流都已经有了(甲产的),一段没产', mB);
    check(diagB?.streams?.encoders === 0 && diagB.streams.frames === 0 && (diagB?.upload?.pushed ?? -1) === 0 && R.yi.pxWrites === 0, '五:乙没有起编码器、没有送帧、没有往素材服务推任何块', R.yi);
    const keyC = keyOf(clipC);
    const readyB = await until('乙认出甲产的流、分段就绪', async () => { const d = await onlineDiag(pageB); const x = (d?.streams ?? []).find((z) => z.clipId === clipC); return x && x.ready >= 4 ? x : null; }, 60_000, 200);
    check(!!readyB && readyB.resultKey === keyC, '五:乙的就绪索引里选中的就是甲产的那条流', readyB && { resultKey: String(readyB.resultKey).slice(0, 12) });
    const playB = await playAndSample(pageB, clipC, { from: CARDS[2].start + 0.2, to: CARDS[2].start + 1.6, key: keyC });
    R.playYi = checkStreamPlaying('五 乙', playB, { key: keyC });
    await pauseAt(pageB, 7.5);
    void instB;
    R.pageErrors = { jia: pageA.errors.slice(0, 5), yi: pageB.errors.slice(0, 5) };
    check(pageA.errors.length === 0 && pageB.errors.length === 0, '两个页面都没有未捕获的错误', R.pageErrors);
    R.ms = Date.now() - t0;
  } catch (e) {
    fails.push(`${tag}异常:${String(e?.stack ?? e).slice(0, 800)}`);
    try { if (debugProbe) R.atFailure = await debugProbe(); } catch { /* 页面不在了 */ }
  } finally {
    debugProbe = null;
    try { chk?.close(); } catch { /* 已关 */ }
    chk = null;
    try { await ctxA?.close(); } catch { /* 已关 */ }
    try { await ctxB?.close(); } catch { /* 已关 */ }
    say('scene.done', { scene: 'mask', ms: Date.now() - t0, fails: fails.length });
  }
}

async function sceneSlow(M) {
  tag = '[slow] ';
  const R = {};
  out.scenes.slow = R;
  const dir = path.join(OUT, 'slow');
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  let ctxA = null;
  try {
    const P0 = await newProject(M, 'slow', { duration: 24 });
    // 拖慢的那张:舞台里每推一帧烧 80 毫秒,600 帧 = 40 个分段(5 份任务);稀疏版每个分段要推 15 帧(实测一段两秒多),一趟一分半,超过 50 秒。
    // 后加的排在前面(先测):快的那张先测、先产完,遮罩最后等的是慢的那张
    const CARDS = [{ start: 3, duration: 20, label: 'slow', burnMs: 80 }, { start: 0.4, duration: 2, label: 'fast' }];
    const seeded = await seedCards(P0, CARDS);
    const [slowId, fastId] = seeded.ids;
    R.clips = { slow: slowId, fast: fastId };
    let inst = null;
    const a = await P0.member(browserA, 'psp-jia', { before: async (page) => { inst = await instrument(page); } });
    ctxA = a.ctx;
    const pageA = a.page;
    debugProbe = async () => ({ ps: await pageStreams(pageA), log: (await maskLog(pageA)).slice(-3) });
    const gone = await waitMaskGone(pageA, '甲', 900_000);
    if (!gone) throw new Error('甲的遮罩没有撤下');
    const atGone = gone.atGone;
    const startedAt = atGone.m?.startedAt ?? null;
    const diag0 = await nodeDiag(pageA);
    const fpA = diag0?.envFingerprint ?? null;
    const entered = await pageA.$('[data-pc="members-button"]').then((el) => !!el, () => false);
    R.mask = { maskMs: gone.goneAt - gone.shownAt, sparseWaitMs: startedAt ? gone.goneAt - startedAt : null, atGone: { ...atGone, jobs: undefined }, measureLog: (await pageStreams(pageA))?.measure?.log ?? null, entered };
    say('slow.gone', R.mask);
    check(atGone.m?.results?.deadline === 1 && atGone.m.left >= 1, '到时了:慢的那张卡的稀疏版没产完,那一次以「到时」收场', atGone.m);
    check(atGone.m?.results?.ok === 1, '快的那张卡的稀疏版在遮罩下产完了', atGone.m);
    check(R.mask.sparseWaitMs !== null && R.mask.sparseWaitMs >= MASK_SPARSE_MS - 300 && R.mask.sparseWaitMs <= MASK_SPARSE_MS + 10_000,
      `遮罩从第一次等稀疏版起满 ${MASK_SPARSE_MS / 1000} 秒就撤下(实测 ${R.mask.sparseWaitMs} 毫秒;慢的那张拖不住它)`, { sparseWaitMs: R.mask.sparseWaitMs });
    check(entered, '50 秒到了照样进编辑(编辑界面在、遮罩不在)');
    const rowSlow = await until('层表里有慢的那张卡的一行', async () => (await rowOf(P0.content, seeded.docId, slowId)).row, 30_000, 500);
    const keySlow = rowSlow?.candidates.find((c) => c.envFingerprint === fpA)?.resultKey ?? null;
    const m0 = rowSlow ? await manifestState(P0, rowSlow, keySlow) : null;
    R.atGone = { segmentsPushed: atGone.segments, manifest: m0 };
    check(!!m0 && m0.have < m0.want && m0.dense === 0, '进编辑时慢的那条流的稀疏版只有一部分(整份任务做完才写清单)', m0);
    /* 之后闲时补齐;稀疏的都齐了以后满密度才开始 */
    const firstDense = await until('稀疏的补齐、满密度的一趟开始', async () => { const log = await maskLog(pageA); return log.find((e) => e.running === 'dense') ?? null; }, 900_000, 500);
    const logA = await maskLog(pageA);
    const afterGone = logA.filter((e) => e.at >= gone.goneAt);
    const sparseAfter = afterGone.filter((e) => e.running === 'sparse');
    const m1 = rowSlow ? await manifestState(P0, rowSlow, keySlow) : null;
    const d1 = await nodeDiag(pageA);
    R.idle = { firstDenseAfterGoneMs: firstDense ? firstDense.at - gone.goneAt : null, sparseSamplesAfterGone: sparseAfter.length, jobsAtFirstDense: firstDense?.jobs ?? null, manifestAtFirstDense: m1,
      resumedSegments: d1?.streams?.resumedSegments ?? null, counters: (await pageStreams(pageA))?.counters ?? null, nodeActive: [...new Set(inst.acts.map((x) => x.busy))] };
    say('slow.idle', R.idle);
    check(sparseAfter.some((e) => String(e.plan ?? '').startsWith('plan:')) && sparseAfter.every((e) => !e.mask), '没产完的稀疏版进编辑以后闲时接着产(清单计划那一份记账下)', { samples: sparseAfter.length, plans: [...new Set(sparseAfter.map((e) => e.plan))] });
    check(!!firstDense && !firstDense.jobs['sparse:todo'], '稀疏的都落定了满密度才开始', firstDense?.jobs);
    check(!!firstDense && !logA.some((e) => e.running === 'dense' && e.at < firstDense.at) && !logA.filter((e) => e.at < firstDense.at).some((e) => (e.jobs['dense:produced'] ?? 0) > 0), '在那之前满密度的一段都没产', firstDense && { at: firstDense.at - gone.goneAt });
    check(!!m1 && m1.have === m1.want && m1.boxed === m1.want && m1.sparse + m1.dense === m1.want && m1.sparse >= m1.want - 8, '满密度开始时慢的那条流稀疏版 40 个分段都在(带位置矩形)', m1);
    // 到时的那一刻正做着的那份任务里已经推完的分段(推了的总数 − 快的那条 4 段 − 已经写进清单的):回来只补缺的
    const partial = Math.max(0, (atGone.segments ?? 0) - 4 - (m0?.have ?? 0));
    R.idle.partialAtDeadline = partial;
    if (partial > 0) check((d1?.streams?.resumedSegments ?? 0) >= partial, '遮罩下推完的分段没有重做(到时那一份任务回来只补缺的)', { partial, resumedSegments: d1?.streams?.resumedSegments });
    else say('slow.note', { note: '到时的那一刻正做着的那份任务一个分段都还没推完,没有可留的;「不重做」这一条这一遍没有测到' });
    check(d1?.counters?.claims === 0, '全程没有经过任务队列', d1?.counters && { claims: d1.counters.claims });
    check(pageA.errors.length === 0, '页面没有未捕获的错误', pageA.errors.slice(0, 5));
    R.ms = Date.now() - t0;
  } catch (e) {
    fails.push(`${tag}异常:${String(e?.stack ?? e).slice(0, 800)}`);
    try { if (debugProbe) R.atFailure = await debugProbe(); } catch { /* 页面不在了 */ }
  } finally {
    debugProbe = null;
    try { chk?.close(); } catch { /* 已关 */ }
    chk = null;
    try { await ctxA?.close(); } catch { /* 已关 */ }
    say('scene.done', { scene: 'slow', ms: Date.now() - t0, fails: fails.length });
  }
}

/* ================================================================== 开跑 */

try {
  const dist = await startLocalSite();
  const health = await (await fetch(`${SITE}/hosted/healthz`)).json().catch(() => null);
  if (!check(health?.ok, '托管端 /hosted/healthz', health)) throw new Error('托管端不通');
  const { frameCode, captureCode } = await import('../../server/frame-code.mjs');
  const codeVersion = frameCode(ROOT);
  const bundle = fs.readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dist, 'assets', f), 'utf8'));
  check(bundle.some((js) => js.includes(codeVersion)), '在线构建嵌的代码版本与本进程算的一致(--dist 要是当前这份源码构建的)', { codeVersion: codeVersion.slice(0, 12) });
  check(bundle.some((js) => js.includes(captureCode(ROOT))), '在线构建嵌了截图代码的指纹(本页算流的键要它)');
  check(fs.existsSync(path.join(dist, 'stage.html')), '在线构建里有舞台入口 stage.html');

  const M = {
    createSharedProject: (await import('../../server/auth/client.mjs')).createSharedProject, wsBaseOf: (await import('../../server/auth/route.mjs')).wsBaseOf,
    normalizeEntry: (await import('../../server/auth/shared-config.mjs')).normalizeEntry, sharedProtocols: (await import('../../server/auth/shared-config.mjs')).sharedProtocols,
    createWsEndpoint: (await import('../../server/render-node/ws-transport.mjs')).createWsEndpoint, createContentClient: (await import('../../server/render-node/content-client.mjs')).createContentClient,
    manifestMatches: (await import('../../server/artifact-transfer.mjs')).manifestMatches, resultKeyOf: (await import('../../server/render-node/fingerprint.mjs')).resultKeyOf,
  };
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  const launch = () => puppeteer.launch({ headless: true, protocolTimeout: 900_000, args: [...PROBE_CHROME_ARGS, ...LAUNCH_ARGS] });
  [browserA, browserB] = await Promise.all([launch(), launch()]);

  const scenes = { solo: sceneSolo, splitter: sceneSplitter, desk: sceneDesk, mask: sceneMask, slow: sceneSlow };
  for (const name of ONLY ? ONLY.split(',') : ['solo', 'splitter', 'desk', 'mask', 'slow']) {
    if (!scenes[name]) throw new Error(`不认识的场:${name}`);
    await scenes[name](M);
  }
  tag = '';
  out.ok = fails.length === 0;
} catch (e) {
  fails.push(`异常:${String(e?.stack ?? e).slice(0, 800)}`);
} finally {
  try { await browserA?.close(); } catch { /* 已关 */ }
  try { await browserB?.close(); } catch { /* 已关 */ }
  await stopDesk();
  try { await hostedProxy?.close(); } catch { /* 已关 */ }
  try { await combo?.close?.(); } catch { /* 已关 */ }
  if (!KEEP) try { fs.rmSync(path.join(TMP, 'hosted'), { recursive: true, force: true }); } catch { /* 留着 */ }
}
out.fails = fails;
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(fails.length ? 1 : 0);
