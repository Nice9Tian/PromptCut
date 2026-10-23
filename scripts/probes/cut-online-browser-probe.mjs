/**
 * 在线浏览器替剪辑段里的重卡产轨道流(〔裁〕R02:2026-10-22 用户定「产。根据要求，剪辑卡就是在时间轴中的卡片。所以重卡也产流。」)——
 * 本机端到端探针。
 *
 *   node scripts/probes/cut-online-browser-probe.mjs [--dist <在线构建目录>] [--base-port 5910] [--out <目录>] [--keep-temp]
 *        端口(整段 +0～+9):+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务、+5～+7 桌面编辑器(及它的舞台端口)。都只绑 127.0.0.1。
 *        `--dist` 不给就在临时目录现建一份(`vite build --mode online`);给的话要是当前这份源码构建的(探针核对嵌进去的代码版本)。
 *
 * 骨架照 `cut-online-e2e-probe.mjs`,只有一处不同:切分方(真的桌面预渲染进程)**只切分、不认领细任务**(`PROMPTCUT_TEST_PLAN_ONLY=1`,
 * 同 `browser-stream-node-probe.mjs`)。所以剪辑段里那张卡的流只能由在线页面当浏览器节点产 —— 改之前切分方不给浏览器出剪辑段里的卡
 * (`solo: 'flat'` 只出切分方自己那一份),这条流就一直产不出来。
 *
 * 场景(1280×720、30 fps、10 秒):剪辑「里」上一张 `punch-pill`;剪辑「中」上一个剪辑段引用「里」;激活剪辑上一个剪辑段 S
 * (第 0.2～2.2 秒)引用「中」—— 两层嵌套。被测的是摊平视图里的虚拟片段 V = `<S>~<「中」里那个段>~<pill>`,加 S 之后把它钉重、刷新。
 *
 * 断言(任一不成立退出码 1):
 *   A 产     页面当上浏览器节点(拿到指纹、探到编码器);层表里 V 一行普通单卡流(`kind: card`、`plane: local`、没有 `streamKind`),
 *            候选里有**页面的指纹**,结果键 = 内容键 × 页面的指纹;流清单每段齐、满密度、编码器是浏览器的(`webcodecs-avc`)
 *   B 谁产的 页面的节点认领并完成了流任务、没有失败;切分方一个细任务都没做(它只切分)
 *   C 播放   页面认出这条流、整段就绪,父页判重并发它的流平面;播放中 V 的嵌套包裹层(`data-pc-flat-clip`)被抑制、舞台上画的是这条流
 *   D 像素   播放中截一帧(读出流正画着第几帧;剪辑段 S 自己做完段级的后台补跑、V 的流画布露着的时候),暂停在同一帧追到精确活渲再截,
 *            各做一次 3×3 均值模糊后比(`blurDiffOf`)。浏览器这条取像素的路(快照包进 SVG 画成位图)出的字和可见舞台活渲的字本来就有
 *            差别(抗锯齿、字的基线差几个像素),所以拿**顶层同一张卡**(对照卡 T,改动之前就有的路)由浏览器产的流当基准:
 *            V 与活渲的差不比 T 与活渲的差大(剪辑段没有多出误差),两者都在 3/255 以内;与刚入场那一帧的活渲比明显更大(对照)
 *   E 没有页面错误
 * 截图:`play-stream.png`(播放中贴流)、`live-same.png`(同一帧的精确活渲)、`live-far.png`。
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
const BASE = Number(arg('--base-port', 5910));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4, desk: BASE + 5 };
const BAND = [BASE, BASE + 9];
if ([5190, 5191, 5192].some((p) => p >= BAND[0] && p <= BAND[1])) { console.error('这一段碰到了用户常驻的端口'); process.exit(2); }
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const ORIGINS = proxyOrigins(PORTS.editor);
const SITE = ORIGINS.editor;
const HOSTED = `${SITE}/hosted/`;
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
const EDITOR = `${SITE}/editor`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cut-online-browser-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'out')));
fs.mkdirSync(OUT, { recursive: true });
const deadline = Date.now() + 60 * 60_000;
process.env.NODE_OPTIONS = dnsShim.withLocalhostDns(process.env.NODE_OPTIONS);

const PROJECT = { width: 1280, height: 720, fps: 30, duration: 10 };
const FPS = PROJECT.fps, SEG = 15;
const DURATION = PROJECT.duration;
/** 剪辑段 S 的第一帧(0.2 秒,第 6 帧)与长度(2 秒):这条流的分段从它起数,0～3 */
const S_START = 0.2, S_LEN = 2, FIRST = Math.round(S_START * FPS);
const LAST_SEGMENT = Math.floor((Math.round((S_START + S_LEN) * FPS) - 1 - FIRST) / SEG);
const INNER = { text: '浏览器替剪辑段产流' };
/** 顶层对照卡 T 的起点(第 4 秒;S 在 0.2～2.2 秒) */
const T_START = 4;
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
  const protocols = await buildAuthProtocols({ base: DOC_DIRECT, projectId, username: creator.username, deviceId: 'cob-seed-node-0001', deviceName: 'probe-seed', as: 'creator', password: creator.password, role: 'page' });
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
  return d ? { suppressed: d.suppressed, heavy: d.snapshotFeed?.heavy ?? [], streams: d.snapshotFeed?.streams ?? [], ready: d.snapshotFeed?.ready ?? [] } : null;
}).catch(() => null);
const planeOf = (p, id) => (p?.streams ?? []).find((x) => (x.clipIds ?? []).join() === id) ?? null;
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
    const segId = String(cid).includes('~') ? String(cid).split('~')[0] : null;
    const seg = segId ? document.querySelector(`[data-pc-clip="${CSS.escape(segId)}"]:not([data-pc-media])`) : null;
    const diag = window.__pcStageDiag?.() ?? null;
    const tracks = (diag?.streams?.tracks ?? []).map((t) => ({ id: t.id, key: t.key ?? null, clips: String(t.id).split('#')[0].split(','), pushed: !!t.pushed, drawn: t.drawn, lastDrawn: t.lastDrawn,
      plane: t.plane ?? null, kind: t.kind ?? null, errors: t.errors, lastError: t.lastError || null }));
    const w = document.querySelector(`[data-pc-flat-clip="${CSS.escape(cid)}"]`) ?? document.querySelector(`[data-pc-clip="${CSS.escape(cid)}"]:not([data-pc-media])`);
    let clip = { wrapper: false };
    if (w) {
      const slot = w.querySelector(':scope > [data-pc-placeholder-slot]');
      const canvas = w.querySelector(':scope > canvas[data-pc-stream-plane]');
      clip = { wrapper: true, flat: w.getAttribute('data-pc-flat-clip'), suppressed: w.classList.contains('pc-suppressed'), placeholder: !!slot && !slot.hidden,
        canvasInWrapper: !!canvas, canvasShown: !!canvas && canvas.getBoundingClientRect().width > 0, stream: tracks.find((t) => t.clips.includes(cid)) ?? null };
    }
    const segSlot = seg?.querySelector(':scope > [data-pc-placeholder-slot]');
    return { t: diag?.t ?? null, clip, tracks, origin: location.origin, seg: seg ? { suppressed: seg.classList.contains('pc-suppressed'), placeholder: !!segSlot && !segSlot.hidden } : null };
  }, id).catch(() => null);
}
async function stageShot(page, name) {
  const f = await visibleStage(page);
  const el = f ? await f.frameElement().catch(() => null) : null;
  const box = el ? await el.boundingBox().catch(() => null) : null;
  if (!box || box.width < 10) return null;
  const file = path.join(OUT, `${name}.png`);
  const buf = await page.screenshot({ path: file, clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.floor(box.width), height: Math.floor(box.height) } });
  return PNG.sync.read(Buffer.from(buf));
}
/** 两张图的差:平均绝对差(每通道,0～255)、差得多的像素占比(任一通道差 > 48) */
function diffOf(a, b) {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  let sum = 0, bad = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * a.width + x) * 4, j = (y * b.width + x) * 4;
    const d0 = Math.abs(a.data[i] - b.data[j]), d1 = Math.abs(a.data[i + 1] - b.data[j + 1]), d2 = Math.abs(a.data[i + 2] - b.data[j + 2]);
    sum += d0 + d1 + d2;
    if (d0 > 48 || d1 > 48 || d2 > 48) bad++;
  }
  return { mad: +(sum / (w * h * 3)).toFixed(3), bad: +(bad / (w * h)).toFixed(5), w, h };
}

/**
 * 先各自做一次 3×3 的均值模糊再比(`diffOf` 同一个口径)。可见舞台里活渲的字是按预览缩放当场光栅化的(LCD 次像素抗锯齿,字边带彩边),
 * 流是后台舞台生成快照画成的位图(灰度抗锯齿):两者在字形边缘上逐像素差得多,但字形、位置一样。模糊一下把字边的抗锯齿差抹平,
 * 内容不对(画错了帧、缺了东西、错了位)照样差得多。原始的差也记下来。
 */
function blurDiffOf(a, b) {
  const blur = (p) => {
    const o = { width: p.width, height: p.height, data: Buffer.alloc(p.data.length) };
    for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) for (let c = 0; c < 3; c++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || xx < 0 || yy >= p.height || xx >= p.width) continue;
        sum += p.data[(yy * p.width + xx) * 4 + c]; n++;
      }
      o.data[(y * p.width + x) * 4 + c] = Math.round(sum / n);
    }
    return o;
  };
  return diffOf(blur(a), blur(b));
}

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

let browserA = null, editor = null, chk = null;
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

const drawing = (s, key = null) => {
  const t = s?.clip?.stream;
  return t && typeof t.lastDrawn === 'number' && s.clip.suppressed && (!key || t.key === key) ? t : null;
};
const trackBrief = (t) => t && { key: short(t.key), plane: t.plane, kind: t.kind, pushed: t.pushed, lastDrawn: t.lastDrawn, drawn: t.drawn, errors: t.errors, lastError: t.lastError };

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

/** 暂停在 `sec`、等这张卡追到精确活渲(不抑制、没有占位符),截一张 */
async function liveShot(page, id, sec, name) {
  await store(page, `S.actions.pause(); return true;`);
  await delay(500);
  let ok = null, last = null;
  for (let round = 0; round < 5 && !ok; round++) {
    await pauseAt(page, sec);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !ok) {
      const s = await stageState(page, id);
      last = s ? { t: s.t, clip: { suppressed: s.clip.suppressed, placeholder: s.clip.placeholder } } : null;
      if (s && Math.abs((s.t ?? -1) - sec) <= 0.5 / FPS && s.clip.wrapper && !s.clip.suppressed && !s.clip.placeholder && !s.seg?.suppressed) ok = s;
      else await delay(100);
    }
  }
  if (!ok) { fails.push(`等不到:暂停在 ${sec.toFixed(3)} 秒后追到精确活渲 :: ${JSON.stringify(last).slice(0, 400)}`); return null; }
  await delay(250);
  return stageShot(page, name);
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
    resultKeyOf: (await import('../../server/render-node/fingerprint.mjs')).resultKeyOf,
  };
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  browserA = await puppeteer.launch({ headless: true, protocolTimeout: 900_000, args: [...PROBE_CHROME_ARGS, ...LAUNCH_ARGS] });

  const t0 = Date.now();
  const deskFp = crypto.createHash('sha256').update(`cob-desk-${RUN}`).digest('hex').slice(0, 16);

  /* ---------------------------------------------------------------- 0. 建项目、起桌面预渲染进程当切分方(只切分) */
  const projName = `浏览器替剪辑段产流-${RUN}`;
  const creator = { username: 'cob-creator', password: `pw-${randomBytes(6).toString('hex')}` };
  const projectPassword = `pp-${randomBytes(6).toString('hex')}`;
  const made = await M.createSharedProject({ base: DOC_DIRECT, name: projName, mode: 'free', creator, password: projectPassword });
  const projectId = made.projectId;
  check((await seedProject({ projectId, creator, name: projName })).ok, '替创建者写进空项目');
  const editorDir = path.join(TMP, 'editor');
  for (const d of ['card-overrides', 'projects', 'work']) fs.mkdirSync(path.join(editorDir, d), { recursive: true });
  const sharedConfig = path.join(editorDir, 'shared.json');
  const deskDevice = `cob-desk-${RUN}`.padEnd(16, '0');
  fs.writeFileSync(sharedConfig, JSON.stringify([{ url: M.wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render', deviceId: deskDevice, deviceName: '浏览器替剪辑段产流探针 桌面' }]));
  editor = await startQueueEditor({ port: PORTS.desk, dir: editorDir, sharedConfig, fakeFingerprint: deskFp, band: BAND, extraEnv: {
    PROMPTCUT_CARD_OVERRIDES: path.join(editorDir, 'card-overrides'), PROMPTCUT_PROJECTS_DIR: path.join(editorDir, 'projects'), PROMPTCUT_WORK_DIR: path.join(editorDir, 'work'),
    PROMPTCUT_DEVICE_ID: deskDevice, PROMPTCUT_DEVICE_NAME: '浏览器替剪辑段产流探针 桌面', PROMPTCUT_STREAMS: '1', PROMPTCUT_TEST_PLAN_ONLY: '1', PROMPTCUT_NO_PORT_FILE: '1' } });
  const deskQueue = await editor.waitActive();
  check(deskQueue.envFingerprint === deskFp, '桌面预渲染进程用上了测试指纹', { envFingerprint: deskQueue.envFingerprint });
  out.desk = { envFingerprint: deskFp, upMs: Date.now() - t0 };
  say('desk.up', out.desk);

  const chkEntry = M.normalizeEntry({ url: M.wsBaseOf(HOSTED), projectId, username: creator.username, password: creator.password, as: 'creator', role: 'render',
    deviceId: `cob-chk-${RUN}`.padEnd(16, '0'), deviceName: '浏览器替剪辑段产流探针 核对' });
  chk = M.createWsEndpoint({ url: chkEntry.url, protocols: M.sharedProtocols(chkEntry, { role: 'render' }), log: () => {} });
  await new Promise((r) => { if (chk.connected) r(); else chk.onOpen(r); });
  const content = M.createContentClient(chk);
  const getManifest = async (resultKey, from, to) => (await content.get('render-manifest', `${resultKey}:${from}-${to}`).catch(() => null))?.body ?? null;
  const spansOf = (row) => { const o = []; for (let f = 0; f <= row.lastSegment; f += row.segmentsPerTask) o.push([f, Math.min(row.lastSegment, f + row.segmentsPerTask - 1)]); return o; };

  /* ---------------------------------------------------------------- 1. 甲进入;两层嵌套的剪辑与剪辑段 S;V 钉重 */
  const a = await openMember(browserA, { projectId, name: projName, username: 'cob-jia', password: projectPassword, deviceId: `cob-jia-${RUN}`.padEnd(16, '0') });
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
    const c = S.actions.addClipOnNewTrack({ index: 0, cardId: 'punch-pill', start: 0, duration: args[0] });
    S.actions.setClipParams(c.id, args[1]);
    const mid = S.actions.addCut('中', { switchTo: true });
    const seg = S.actions.addCutSegment(inner.id, 0, { newTrackIndex: 0, duration: args[0] });
    S.actions.switchCut(A);
    return { A, inner: inner.id, mid: mid.id, innerClip: c.id, midSeg: seg.id };`, DURATION, INNER);
  check(!!cuts?.A && !!cuts.innerClip && !!cuts.midSeg, '建好两层嵌套的剪辑(「里」上一张卡,「中」引用「里」)', cuts);
  const before = (await stable(pageA, 0)) ?? [];
  const sId = await store(pageA, `const c = S.actions.addCutSegment(args[0], args[1], { newTrackIndex: 0, duration: args[2] }); return c.id;`, cuts.mid, S_START, S_LEN);
  const vId = [sId, cuts.midSeg, cuts.innerClip].join(FLAT_SEP);
  const afterS = (await stable(pageA, before.length + 1)) ?? [];
  const fresh = afterS.filter((r) => r.identityKey && !before.some((b) => b.identityKey === r.identityKey));
  const vKeys = fresh.map((r) => r.identityKey);
  out.costs = { before: before.length, after: afterS.length, fresh: fresh.map((r) => ({ key: short(r.identityKey), stepMs: r.stepMs })) };
  if (!check(vKeys.length === 1, '剪辑段里那张卡的成本记录认出来了', out.costs)) throw new Error('认不出那张卡的成本记录');
  const docId = await store(pageA, `return S.getState().project.id;`);
  out.scene = { sId, vId, ...cuts };
  say('scene', out.scene);
  await costRecords(pageA, vKeys);
  await enter(pageA, 'cob-jia(刷新,钉重生效)');
  // 停在剪辑段外面,页面闲着:浏览器节点才认领
  await pauseAt(pageA, DURATION - 0.5);
  const nodeA = await until('A:甲当上浏览器节点(拿到指纹、探到编码器)', async () => { const d = await nodeDiag(pageA); return d?.ready === 'ready' && d.envFingerprint && d.streams?.capable ? d : null; }, 240_000, 500);
  const jiaFp = nodeA?.envFingerprint ?? null;
  out.jia = { envFingerprint: jiaFp, encoder: nodeA?.streams?.encoder ?? null };

  /* ---------------------------------------------------------------- 2. A 产:层表里 V 一行,候选是页面的指纹 */
  const layerKey = `layers:${docId}`;
  const rowNow = async (id = vId) => {
    const body = (await content.get('snapshot-manifest', layerKey).catch(() => null))?.body ?? null;
    return { body, row: (body?.streams ?? []).find((r) => r.topClipId === id) ?? null };
  };
  const briefRow = (row) => row && { topClipId: row.topClipId, kind: row.kind, plane: row.plane, streamKind: row.streamKind ?? null, clipIds: row.clipIds, contentKey: short(row.contentKey),
    candidates: (row.candidates ?? []).map((c) => ({ envFingerprint: c.envFingerprint, resultKey: short(c.resultKey) })), originFrame: row.originFrame ?? null, lastSegment: row.lastSegment, inputSig: row.inputSig ?? null };
  const tProduce = Date.now();
  const got = await until('A:层表里出现 V 的流,候选里有页面的指纹,流清单满密度齐', async () => {
    const x = await rowNow();
    const cand = (x.row?.candidates ?? []).find((c) => c.envFingerprint === jiaFp);
    if (!x.row || !cand) return null;
    const manifests = [];
    for (const [from, to] of spansOf(x.row)) {
      const m = await getManifest(cand.resultKey, from, to);
      if (!m || Object.keys(m.segments ?? {}).length !== to - from + 1 || !Object.values(m.segments).every((seg) => seg.stride === 1)) return null;
      manifests.push(m);
    }
    return { ...x, cand, manifests };
  }, 900_000, 1500);
  const row = got?.row ?? null;
  out.produce = { ms: got ? Date.now() - tProduce : null, row: briefRow(row), all: ((await rowNow()).body?.streams ?? []).map(briefRow) };
  say('produced', out.produce);
  if (!check(!!row, 'A:层表里有 V 的一行、候选里有页面的指纹(页面替剪辑段里的卡产了流)', out.produce)) throw new Error('页面没有产出 V 的流');
  const key = got.cand.resultKey;
  check(row.kind === 'card' && row.plane === 'local' && (row.clipIds ?? []).join() === vId && !('streamKind' in row) && /^s1-/.test(row.inputSig ?? ''),
    'A:这一行是普通单卡流(kind card、plane local、成员只有 V、带输入签名、没有 streamKind)', out.produce.row);
  check(key === M.resultKeyOf(row.contentKey, jiaFp), 'A:结果键 = 内容键 × 页面的指纹', { key: short(key), contentKey: short(row.contentKey) });
  check(row.originFrame === FIRST && row.lastSegment === LAST_SEGMENT, `A:第一帧是 S 的第一帧(第 ${FIRST} 帧),分段 0～${LAST_SEGMENT}`, out.produce.row);
  const encoders = [...new Set(got.manifests.flatMap((m) => Object.values(m.inits ?? {}).map((i) => i?.encoder?.name ?? i?.encoder ?? null)))];
  out.produce.encoders = encoders;
  check(encoders.length > 0 && encoders.every((e) => String(e).includes('webcodecs')), 'A:流是浏览器压的(编码器 webcodecs)', encoders);

  /* ---------------------------------------------------------------- 3. B 谁产的 */
  const nodeAfter = await nodeDiag(pageA);
  const deskDiag = await editor.diagnostics().catch(() => null);
  out.who = { node: nodeAfter && { counters: nodeAfter.counters, failed: nodeAfter.counters?.failed ?? null }, deskTasks: deskDiag?.queue?.counters ?? deskDiag?.queue?.tasks ?? null };
  check((nodeAfter?.counters?.streamTasks ?? 0) >= 1 && (nodeAfter?.counters?.failed ?? 0) === 0, 'B:页面的节点认领并完成了流任务、没有失败', out.who.node);
  // 切分方自己那一份(它能产流时成对出的另一份,候选里另一个指纹)一个分段都没有:它只切分
  const deskCand = (row.candidates ?? []).find((c) => c.envFingerprint === deskFp) ?? null;
  const deskManifests = [];
  if (deskCand) for (const [from, to] of spansOf(row)) deskManifests.push(await getManifest(deskCand.resultKey, from, to));
  out.who.deskCandidate = deskCand && { resultKey: short(deskCand.resultKey), manifests: deskManifests.map((m) => (m ? Object.keys(m.segments ?? {}).length : null)) };
  check(deskManifests.every((m) => m === null), 'B:切分方自己那一份一个分段都没有产(它只切分,流全是页面产的)', out.who.deskCandidate);

  /* ---------------------------------------------------------------- 4. C 播放 */
  await pauseAt(pageA, 0.5);
  const ready = await until('C:页面认出这条流、整段就绪、父页判重并发它的流平面', async () => {
    const d = await onlineDiag(pageA);
    const s = (d?.streams ?? []).find((x) => x.clipId === vId);
    if (!(s && s.resultKey === key && s.ready >= LAST_SEGMENT + 1)) return null;
    const p = await parentDiag(pageA);
    return p?.heavy.includes(vId) && planeOf(p, vId)?.key === short(key) ? { s, d, p } : null;
  }, 180_000, 300);
  out.ready = ready && { ready: ready.s.ready, envFingerprint: ready.s.envFingerprint, staleStreams: ready.d.staleStreams, plane: planeOf(ready.p, vId) };
  check(!!ready && ready.s.envFingerprint === jiaFp && ready.d.staleStreams.length === 0, 'C:在线来源选中页面产的那一份,没有过期的', out.ready);
  const play = await playAndSample(pageA, vId, { from: 0.3, to: 1.9, key });
  await store(pageA, `S.actions.pause(); return true;`);
  const a0 = play.drawn[0]?.clip.stream, b0 = play.drawn.at(-1)?.clip.stream;
  out.play = { samples: play.samples.length, drawn: play.drawn.length, from: trackBrief(a0), to: trackBrief(b0),
    segSuppressed: play.samples.filter((x) => x.seg?.suppressed).length, visible: play.drawn.filter((x) => !x.seg?.suppressed && x.clip.canvasShown).length };
  check(play.drawn.length >= 6 && b0?.key === key && b0.pushed === true && (b0.errors ?? 0) === 0 && b0.lastDrawn > a0.lastDrawn, 'C:播放中舞台上画的是这条流(父页推的字节、跟着播放头、不报错)', out.play);
  check(play.drawn.every((s) => s.clip.suppressed && !!s.clip.flat && s.clip.canvasInWrapper), 'C:V 的嵌套包裹层(data-pc-flat-clip)一直被抑制,流平面在包裹层里', out.play);

  /* ---------------------------------------------------------------- 5. D 像素(剪辑段里的 V,和顶层同一张卡 T 对照) */
  /**
   * 播放中截一帧流在画的样子、暂停在同一帧截精确活渲,比(各做一次 3×3 均值模糊,`blurDiffOf`);再和这张卡刚入场那一帧的活渲比(对照)。
   * 剪辑段里的卡另要等剪辑段 S 自己做完段级的后台补跑(整段被抑制、露它的占位时,V 的流被 S 盖着)。
   */
  async function pixelCheck(id, k, { from, last, first, name }) {
    let shot = null, frame = null;
    const res = { tries: 0, rejected: [] };
    const watchPlaceholder = async () => { for (const f of stageFrames(pageA)) await f.evaluate((cid) => {
      window.__cobPh ??= {};
      if (window.__cobPh[cid]) return;
      window.__cobPh[cid] = { shown: 0 };
      new MutationObserver((list) => { for (const m of list) {
        const el = m.target;
        const owner = el instanceof Element ? el.parentElement : null;
        if (el instanceof Element && el.hasAttribute('data-pc-placeholder-slot') && !el.hidden && (owner?.getAttribute('data-pc-flat-clip') === cid || owner?.getAttribute('data-pc-clip') === cid)) window.__cobPh[cid].shown++;
      } }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
    }, id).catch(() => {}); };
    const shownCount = async () => { let n = 0; for (const f of stageFrames(pageA)) n += await f.evaluate((cid) => window.__cobPh?.[cid]?.shown ?? 0, id).catch(() => 0); return n; };
    for (let round = 0; round < 8 && !shot; round++) {
      await playFrom(pageA, from);
      await watchPlaceholder();
      const tStart = Date.now();
      let started = false;
      while (Date.now() - tStart < 10_000 && !shot) {
        const s0 = await stageState(pageA, id);
        if (!started) { if (s0 && (s0.t ?? -1) >= from - 0.05 && (s0.t ?? 99) <= from + 0.6) started = true; else { await delay(20); continue; } }
        const tb = drawing(s0, k);
        if (!tb || s0.clip.placeholder || !s0.clip.canvasShown || s0.seg?.suppressed || (s0.t ?? 0) < from + 0.25) { await delay(40); continue; }
        if ((s0.t ?? 0) > last) break;
        res.tries++;
        const ph0 = await shownCount();
        const img = await stageShot(pageA, `${name}-stream-try${res.tries}`);
        const s1 = await stageState(pageA, id);
        const ph1 = await shownCount();
        const ta = drawing(s1, k);
        if (img && ta && !s1.clip.placeholder && s1.clip.canvasShown && !s1.seg?.suppressed && ph1 === ph0 && ta.lastDrawn >= tb.lastDrawn && ta.lastDrawn - tb.lastDrawn <= 2) {
          shot = img; frame = Math.round((tb.lastDrawn + ta.lastDrawn) / 2); res.f0 = tb.lastDrawn; res.f1 = ta.lastDrawn; res.shotFile = `${name}-stream-try${res.tries}.png`;
        } else res.rejected.push({ try: res.tries, placeholderShown: ph1 - ph0, drawing: !!ta, placeholder: !!s1?.clip?.placeholder, segSuppressed: !!s1?.seg?.suppressed, canvasShown: !!s1?.clip?.canvasShown, frames: [tb.lastDrawn, ta?.lastDrawn ?? null] });
      }
    }
    if (check(!!shot, `D:${name} 播放中截到流在画的一帧`, res)) {
      res.frame = frame;
      const same = await liveShot(pageA, id, frame / FPS, `${name}-live-same`);
      // 对照取这张卡刚入场的那一帧(入场之后药丸是静止的)
      const far = await liveShot(pageA, id, first / FPS, `${name}-live-far`);
      if (check(!!same && !!far, `D:${name} 截到精确活渲的两张参照`, { same: !!same, far: !!far })) {
        res.raw = { same: diffOf(shot, same), far: diffOf(shot, far) };
        res.same = blurDiffOf(shot, same);
        res.far = blurDiffOf(shot, far);
        check(res.far.bad >= res.same.bad * 4 + 0.002 && res.far.mad >= res.same.mad * 2, `D:${name} 与刚入场那一帧的活渲比,差明显更大(对照)`, { same: res.same, far: res.far });
      }
    }
    return res;
  }
  out.pixels = { v: await pixelCheck(vId, key, { from: 0.6, last: 2.0, first: FIRST, name: 'cut' }) };

  // 对照卡 T:顶层同一张卡(同样的参数、同样 2 秒长,成本身份相同,已经钉重),同样由页面当浏览器节点产流 —— 这是改动之前就有的路
  const tId = await store(pageA, `const c = S.actions.addClipOnNewTrack({ index: 0, cardId: 'punch-pill', start: args[0], duration: args[1] }); S.actions.setClipParams(c.id, args[2]); return c.id;`, T_START, S_LEN, INNER);
  await pauseAt(pageA, DURATION - 0.5);
  const gotT = await until('D:层表里出现顶层对照卡 T 的流(页面的指纹,满密度齐)', async () => {
    const x = await rowNow(tId);
    const cand = (x.row?.candidates ?? []).find((c) => c.envFingerprint === jiaFp);
    if (!x.row || !cand) {
      // 成本身份没认出来时钉一下(同一张卡、同样长,一般已经钉过)
      const fresh = (await costRecords(pageA)).filter((r) => r.identityKey && !r.pinnedHeavy).map((r) => r.identityKey);
      if (fresh.length) { await costRecords(pageA, fresh); await enter(pageA, 'cob-jia(刷新,对照卡钉重生效)'); await pauseAt(pageA, DURATION - 0.5); }
      return null;
    }
    for (const [from, to] of spansOf(x.row)) {
      const m = await getManifest(cand.resultKey, from, to);
      if (!m || Object.keys(m.segments ?? {}).length !== to - from + 1 || !Object.values(m.segments).every((seg) => seg.stride === 1)) return null;
    }
    return { ...x, cand };
  }, 600_000, 1500);
  if (check(!!gotT, 'D:顶层对照卡 T 也由页面产了流', { tId })) {
    await pauseAt(pageA, T_START + 0.3);
    await until('D:对照卡 T 的流就绪、父页判重发平面', async () => { const p = await parentDiag(pageA); return p?.heavy.includes(tId) && planeOf(p, tId)?.key === short(gotT.cand.resultKey); }, 120_000, 300);
    out.pixels.top = await pixelCheck(tId, gotT.cand.resultKey, { from: T_START + 0.4, last: T_START + 1.8, first: Math.round(T_START * FPS), name: 'top' });
    const v = out.pixels.v, t = out.pixels.top;
    if (v?.same && t?.same) {
      out.pixels.compare = { cut: v.same, top: t.same };
      check(v.same.mad <= t.same.mad * 1.25 + 0.3 && v.same.bad <= t.same.bad * 1.5 + 0.002,
        'D:剪辑段里的卡由浏览器产的流,和顶层同一张卡由浏览器产的流,与各自的精确活渲差得一样多(同一条取像素的路,剪辑段没有多出误差)', out.pixels.compare);
      check(t.same.mad <= 3 && v.same.mad <= 3, 'D:两条流与精确活渲的平均差都在 3/255 以内(3×3 模糊后)', out.pixels.compare);
    }
  }

  /* ---------------------------------------------------------------- 6. E 页面错误 */
  out.pageErrors = pageA.errors.slice(0, 5);
  check(pageA.errors.length === 0, 'E:页面没有未捕获的错误', out.pageErrors);
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
