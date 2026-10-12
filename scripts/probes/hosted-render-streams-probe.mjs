/**
 * 云端的渲染服务按项目的「生成轨道流」产流(任务书 `docs/plan/render-refactor-task.md`「甲三」的验收;契约 `docs/plan/hosted-render-contract.md` 第 3.1 节)。
 *
 *   node scripts/probes/hosted-render-streams-probe.mjs [--dist <在线构建目录>] [--base-port 27620] [--out <目录>] [--keep-temp] [--verbose]
 *        端口(整段 +0～+19,都只绑 127.0.0.1):+0 编辑器页的源、+1 / +2 两个舞台的源、+3 文档服务、+4 素材服务、
 *        +10～+12 渲染服务的常驻工作进程(编辑器与两个舞台端口)、+13～+15 隔离工作进程(这支探针不起它)、+16 管理进程的诊断与代理口。
 *
 * 隔离的托管组合,角色都在本机:
 *   - 文档服务 + 素材服务:进程内的托管组合(本机信任关着、带集群令牌,与云节点同样的配置),经本机托管代理 `lib/hosted-proxy.mjs` 开三个同站跨源的源;
 *   - 托管方的渲染服务:真的管理进程 `server/hosted-render/main.mjs`(`PROMPTCUT_RENDER_STREAMS=1`,即部署模板的配置)与它起的常驻工作进程;
 *     并发压到 1(「手里有认领时关掉」那一步要它一次只拿一个任务);用测试指纹,与本机桌面的不同;
 *   - 甲:在线构建的页面(项目一的成员,进项目走「刷新后回到项目」那条产品路径),既是清单计划的发布方,也是观看的一方;
 *   - 创建者:本进程里的一条连接,照页面的同一个创建者操作(`shared.admin { op: 'set-hosted-option' }`)开、关这一项
 *     (界面上那一行的走查在 `hosted-stream-entry-probe.mjs`);
 *   - 项目二:另一个项目,这一项一直开着,由本进程扮成员发清单计划(「别的项目不受影响」)。
 *
 * 用的卡是画布卡 `r6-canvas`(审阅表 `canvasHeavy`):浏览器节点做不了它的快照与流,所以这张卡的任务只可能由渲染服务做,
 * 不会和页面自己的浏览器节点抢。
 *
 * 断言(任一不成立退出码 1):
 *   S 起来    渲染服务以能产流的方式起:`/status` 的 `streams` 为真,工作进程报 `capabilities.streams` 与 `transcode`
 *   A 缺省关  新建的项目:成员列表里 `hosted.render.streams` 是 false,渲染服务给工作进程的清单里这个项目 `streams: false`;
 *             甲加一张重卡 → 清单计划由渲染服务认领并切分,快照任务全部做完(照常);队列里这个项目一条流任务都没有;
 *             层表里有这张卡的快照层、没有它的流;甲的在线来源里没有这张卡的流
 *   B 打开    创建者打开:成员列表、渲染服务的清单跟着变;项目下一次发清单计划(探针让甲改一下项目名)时,切出渲染服务自己的那一份流任务
 *             (三个:分段 0～7、8～15、16～16),渲染服务认领其中一个
 *   C 再关    手里正有一个流任务时创建者关掉:手里的那个照做完(没有放回),渲染服务与这个项目的连接没断;之后一段时间(≥ 15 秒)里剩下的
 *             两个流任务一直是 open、没有被认领;这期间这个项目新发的清单计划照常被认领、切分(不切流);已经产出的那一段的流清单还在内容库里,
 *             层表里这条流的那一行还在。同一段时间里项目二(这一项开着)的流任务照常被认领并做完
 *   D 再打开  创建者再打开:剩下的两个流任务被认领并做完,三份流清单与它们的块都在
 *   E 播放    甲的在线来源认出这条流(选中的候选是渲染服务的指纹),播放时舞台上是流在画:包裹层被抑制、流播放器在出帧且跟着播放头、
 *             快照平面不是每拍在换;截图与同一帧的精确活渲相符,与往后 2 秒的明显不同
 *   F 页面    没有未捕获的错误;整个过程渲染服务没有失败的任务
 * 局限(如实):创建者打开这一项之后,要等这个项目**下一次发清单计划**(项目有任何改动、或清单变了)才会切出渲染服务自己的那一份流任务 ——
 *   同一版项目的清单计划已经做完,页面重发同一个结果键队列不会重切。B 里所以让甲改了一次项目名。见报告「没做成的」。
 * 耗时只记录。不打印私钥、口令、票据。
 * 输出:过程写 stderr;stdout 最后一行一行 JSON `{ ok, fails, ... }`;截图在 `--out/`。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawn, spawnSync } from 'node:child_process';
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
import { viteBin, portFree } from './m8/procs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const KEEP = argv.includes('--keep-temp');
const VERBOSE = argv.includes('--verbose');
const BASE = Number(arg('--base-port', 27620));
const PORTS = { editor: BASE, stageA: BASE + 1, stageB: BASE + 2, doc: BASE + 3, asset: BASE + 4, worker: BASE + 10, iso: BASE + 13, status: BASE + 16 };
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const ORIGINS = proxyOrigins(PORTS.editor);
const SITE = ORIGINS.editor;
const HOSTED = `${SITE}/hosted/`;
const DOC_DIRECT = `http://127.0.0.1:${PORTS.doc}`;
const DOC_WS = `ws://127.0.0.1:${PORTS.doc}`;
const STATUS = `http://127.0.0.1:${PORTS.status}`;
const EDITOR = `${SITE}/editor`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hosted-streams-'));
const OUT = path.resolve(arg('--out', path.join(TMP, 'out')));
fs.mkdirSync(OUT, { recursive: true });
const HOSTED_DATA = path.join(TMP, 'hosted');
const RENDER_SECRETS = path.join(TMP, 'render-secrets');
const RENDER_DATA = path.join(TMP, 'render');
const deadline = Date.now() + 45 * 60_000;
process.env.NODE_OPTIONS = dnsShim.withLocalhostDns(process.env.NODE_OPTIONS);
/** 渲染服务报的环境指纹:与本机桌面的、与页面的都不同 */
const HOST_FP = process.env.PROMPTCUT_TEST_ENV_FINGERPRINT || '7e57c10d000a3001';

/** 项目一:1280×720、30 fps。画布卡从第 12 帧起、占 240 帧(全局 12～251,分段 0～16:三个流任务 0～7、8～15、16～16;四个快照任务) */
const PROJECT = { width: 1280, height: 720, fps: 30, duration: 10 };
const FPS = PROJECT.fps;
const CLIP = { start: 0.4, duration: 8.0 };
const SEG = 15;
const STREAM_SPANS = [[0, 7], [8, 15], [16, 16]];
/** 「再关」之后看多久没有新的流认领 */
const WATCH_MS = 15_000;

const fails = [];
const out = { ok: false, run: RUN, site: SITE, out: OUT, hostFingerprint: HOST_FP, steps: {}, timings: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 700)}`)); return !!cond; };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function until(label, fn, timeoutMs, everyMs = 300) {
  const end = Math.min(Date.now() + timeoutMs, deadline);
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { v = null; if (VERBOSE) say('wait-error', { label, message: String(e?.message ?? e) }); }
    if (v) return v;
    if (Date.now() > end) { fails.push(`超时:${label}`); return null; }
    await delay(everyMs);
  }
}

/* ================================================================== 托管组合、代理、渲染服务 */

let combo = null, hostedProxy = null, supervisor = null;
const supLogs = [];

async function startLocalSite() {
  for (const p of [PORTS.editor, PORTS.stageA, PORTS.stageB, PORTS.doc, PORTS.asset, PORTS.worker, PORTS.worker + 1, PORTS.worker + 2, PORTS.status]) {
    if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  }
  let dist = arg('--dist', null);
  if (!dist) {
    dist = path.join(TMP, 'dist-online');
    say('local.build-online', { dist });
    const b = spawnSync(process.execPath, [viteBin(), 'build', '--mode', 'online', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    if (b.status !== 0) throw new Error(`在线构建失败:${String(b.stderr).slice(-600)}`);
  }
  dist = path.resolve(dist);
  const { startHostedCombo } = await import('../../server/hosted/combo.mjs');
  fs.mkdirSync(HOSTED_DATA, { recursive: true });
  combo = await startHostedCombo({
    dataDir: HOSTED_DATA, docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    // 与云节点同样的配置:本机信任关着(回环不算本机),成员与服务都得交凭证
    trustLoopback: false, clusterToken: randomBytes(32).toString('base64url'),
    docPublicUrl: `ws://pc.localhost:${PORTS.editor}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`,
    log: (event, fields) => { if (VERBOSE) say(`hosted.${event}`, fields); },
  });
  const { runKeygen } = await import('../../server/hosted-render/keygen.mjs');
  const gen = runKeygen(['--hosted-data', HOSTED_DATA, '--secrets', RENDER_SECRETS, '--instance-name', '托管方的渲染节点(探针)']);
  say('keygen', { kid: gen.kid });
  hostedProxy = await startHostedProxy({ dist, basePort: PORTS.editor, docPort: PORTS.doc, assetPort: PORTS.asset, policy: 'full' });
  say('local.up', { site: SITE, doc: PORTS.doc, asset: PORTS.asset, dist });
  return dist;
}

function startSupervisor(dist) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^PROMPTCUT_RENDER_/.test(k) && k !== 'PROMPTCUT_RENDER_SKIP_CHECKS') delete env[k];
  Object.assign(env, {
    PROMPTCUT_RENDER_DOC_URL: DOC_WS,
    PROMPTCUT_RENDER_SECRETS: RENDER_SECRETS,
    PROMPTCUT_RENDER_DATA: RENDER_DATA,
    PROMPTCUT_RENDER_PORT: String(PORTS.worker),
    PROMPTCUT_RENDER_ISO_PORT: String(PORTS.iso),
    PROMPTCUT_RENDER_STATUS_PORT: String(PORTS.status),
    // 一次只拿一个任务:「手里有认领时关掉」那一步靠它
    PROMPTCUT_RENDER_MAX_CONCURRENT: '1',
    PROMPTCUT_RENDER_SAMPLE_MS: '2000',
    PROMPTCUT_RENDER_MEM_LOW: '256M',
    // 这支探针不放用户卡,不起隔离工作进程
    PROMPTCUT_RENDER_USER_CARDS: 'off',
    PROMPTCUT_RENDER_LOOK: 'off',
    // 与在线页面同一个提交的核对:读这份在线构建里嵌的代码版本
    PROMPTCUT_RENDER_EDITOR_DIR: dist,
    // 部署模板写的就是 1:以能产轨道流的方式起
    PROMPTCUT_RENDER_STREAMS: '1',
    PROMPTCUT_TEST_ENV_FINGERPRINT: HOST_FP,
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'hosted-render', 'main.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let tail = '';
  const take = (chunk) => {
    const lines = (tail + chunk.toString()).split('\n');
    tail = lines.pop() ?? '';
    for (const line of lines) {
      let j = null;
      try { j = JSON.parse(line); } catch { /* 不是 JSON 的行 */ }
      if (j) supLogs.push(j);
      while (supLogs.length > 4000) supLogs.shift();
      if (VERBOSE || (j && !['worker.line'].includes(j.event))) process.stderr.write(`[render] ${line.slice(0, 500)}\n`);
    }
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  supervisor = { child, exited };
  return supervisor;
}
async function stopSupervisor() {
  const s = supervisor;
  if (!s || s.child.exitCode !== null) return;
  try { if (s.child.connected) s.child.send({ type: 'shutdown' }); else s.child.kill('SIGTERM'); } catch { /* 已经没了 */ }
  const done = await Promise.race([s.exited.then(() => true), delay(40_000).then(() => false)]);
  if (!done) { const { killTree } = await import('../../server/hosted-render/worker.mjs'); killTree(s.child.pid); }
}
const status = async () => (await fetch(`${STATUS}/status`, { signal: AbortSignal.timeout(5000) })).json();
const nodeOf = (s, projectId) => (s?.queue?.nodes ?? []).find((n) => n.projectId === projectId) ?? null;
const listedOf = (s, projectId) => (s?.projects ?? []).find((p) => p.projectId === projectId) ?? null;

/** 托管组合里这个项目的队列任务(本进程里直接看) */
function queueTasks(projectId) {
  const mods = combo.service.describe().modules ?? {};
  for (const d of Object.values(mods)) {
    const tasks = d?.spaces?.[projectId]?.tasks;
    if (Array.isArray(tasks)) return tasks;
  }
  return [];
}
const streamTasks = (projectId) => queueTasks(projectId).filter((t) => t.id.startsWith('stream:'));
const snapTasks = (projectId) => queueTasks(projectId).filter((t) => t.id.startsWith('snapshot:'));
const planTasks = (projectId) => queueTasks(projectId).filter((t) => t.id.startsWith('plan:'));
const briefTasks = (tasks) => tasks.map((t) => `${t.id.slice(0, 8)}…${t.id.slice(-6)}=${t.state}${t.lastError ? `(${t.lastError})` : ''}`);

/* ================================================================== 本进程里的成员连接(创建者、项目二的成员) */

let reqSeq = 0;
function connect(protocols) {
  const ws = new WebSocket(DOC_WS, protocols);
  const all = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    all.push(msg);
    while (all.length > 2000) all.shift();
    for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('连接失败')), { once: true });
  });
  const c = {
    ws, all, opened,
    send: (m) => ws.send(JSON.stringify(m)),
    ask(message, ms = 15_000) {
      const reqId = `hrs-${++reqSeq}`;
      const got = new Promise((resolve, reject) => {
        const w = { match: (m) => m?.reqId === reqId, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`${message.type} 没有回应`)); } }, ms).unref?.();
      });
      c.send({ ...message, reqId });
      return got;
    },
    close() { try { ws.close(); } catch { /* 已关 */ } },
  };
  return c;
}
async function joinAs(M, proj, { username, as = 'member', device }) {
  const protocols = await M.buildAuthProtocols({ base: DOC_WS, projectId: proj.projectId, username, deviceId: `hrs-${RUN}-${device}`.padEnd(20, '0').slice(0, 48), deviceName: device, as,
    password: as === 'creator' ? proj.creatorPassword : proj.password, role: 'page' });
  const c = connect(protocols);
  await c.opened;
  return c;
}
/** 创建者操作:取挑战、按创建者口令算证明、发 `shared.admin`(与页面的 `adminOp` 同一条路) */
async function adminOp(M, c, proj, op, fields = {}) {
  const ch = await c.ask({ type: 'shared.challenge' });
  if (ch.type !== 'shared.challenge.ok') return ch;
  const key = await M.deriveKey(proj.creatorPassword, ch.salt, ch.kdf);
  const m = await M.adminProof({ key, projectId: proj.projectId, username: proj.creator, op, nonce: ch.nonce });
  return c.ask({ type: 'shared.admin', op, ...fields, proof: { nonce: ch.nonce, m } });
}
const setStreams = (M, c, proj, enabled) => adminOp(M, c, proj, 'set-hosted-option', { service: 'render', option: 'streams', enabled });
const hostedOf = async (c) => (await c.ask({ type: 'shared.members' }))?.hosted ?? null;

async function makeProject(M, label) {
  const name = `甲三-${label}-${RUN}`;
  const creatorPassword = `c-${randomBytes(9).toString('base64url')}`;
  const password = `p-${randomBytes(9).toString('base64url')}`;
  const made = await M.createSharedProject({ base: DOC_DIRECT, name, mode: 'free', creator: { username: 'hrs-creator', password: creatorPassword }, password });
  return { projectId: made.projectId, name, creator: 'hrs-creator', creatorPassword, password };
}
/** 以这条连接的身份放一版项目内容,回 `{ ok, rev }` */
async function putProject(c, docId, body) {
  await c.ask({ type: 'project.open', projectId: docId }).catch(() => null);
  const r = await c.ask({ type: 'project.op', projectId: docId, opId: randomBytes(16).toString('base64url'), session: `s-${RUN}`, ops: [{ op: 'set', path: '', value: body }] }, 20_000);
  return { ok: r.type === 'project.op.ok', rev: r.rev ?? null, type: r.type };
}

/* ================================================================== 页面(照 browser-stream-e2e-probe.mjs) */

const EVAL_TIMEOUT_MS = 30_000;
const P = (page, fn, ...a) => Promise.race([page.evaluate(fn, ...a), delay(EVAL_TIMEOUT_MS).then(() => { throw new Error('页面 30 秒没应答'); })]);
const store = (page, src, ...a) => P(page, (s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
const onlineDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcOnlineSnapshots?.() ?? null)); } catch { return null; } }).catch(() => null);
const planDiag = (page) => P(page, () => { try { return JSON.parse(JSON.stringify(window.__pcPlanPublisher?.() ?? null)); } catch { return null; } }).catch(() => null);
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
    return { t: diag?.t ?? null, clip, tracks, origin: location.origin, swaps: window.__hrsSwaps ?? null };
  }, id).catch(() => null);
}
async function stageShot(page, name) {
  const f = await visibleStage(page);
  const el = f ? await f.frameElement().catch(() => null) : null;
  const box = el ? await el.boundingBox().catch(() => null) : null;
  if (!box || box.width < 10) return null;
  const file = path.join(OUT, `${name}.png`);
  const buf = await page.screenshot({ path: file, clip: { x: Math.round(box.x), y: Math.round(box.y), width: Math.floor(box.width), height: Math.floor(box.height) } });
  return { file, png: PNG.sync.read(Buffer.from(buf)) };
}
/** 两张图的差:平均绝对差(每通道,0～255)、差得多的像素占比(任一通道差 > 48) */
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
/** 画面里有颜色的像素占比(画布卡画的是一圈彩色的点;舞台背景是灰的棋盘格) */
function colorfulOf(png) {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 90) n++;
  }
  return +(n / (png.width * png.height)).toFixed(5);
}
async function liveShot(page, id, sec, name) {
  await store(page, `S.actions.pause(); return true;`);
  await delay(500);
  let ok = null, last = null;
  for (let round = 0; round < 5 && !ok; round++) {
    await pauseAt(page, sec);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !ok) {
      const s = await stageState(page, id);
      last = s ? { t: s.t, tracks: s.tracks.length, clip: { suppressed: s.clip.suppressed, snapshot: s.clip.snapshot, placeholder: s.clip.placeholder } } : null;
      if (s && Math.abs((s.t ?? -1) - sec) <= 0.5 / FPS && !s.tracks.length && s.clip.wrapper && !s.clip.suppressed && !s.clip.snapshot && !s.clip.placeholder) ok = s;
      else await delay(100);
    }
  }
  if (!ok) { fails.push(`等不到:暂停在 ${sec.toFixed(3)} 秒后追到精确活渲 :: ${JSON.stringify(last).slice(0, 400)}`); return null; }
  await delay(250);
  return stageShot(page, name);
}
const drawing = (s, key = null) => {
  const t = s?.clip?.stream;
  return t && typeof t.lastDrawn === 'number' && s.clip.suppressed && (!key || t.key === key) ? t : null;
};
async function watchSwaps(page, id) {
  for (const f of stageFrames(page)) {
    await f.evaluate((cid) => {
      if (window.__hrsObserver) window.__hrsObserver.disconnect();
      window.__hrsSwaps = 0;
      window.__hrsObserver = new MutationObserver((list) => {
        for (const m of list) {
          const plane = m.target instanceof Element ? m.target.closest('[data-pc-snapshot-plane]') : null;
          if (plane?.parentElement?.getAttribute('data-pc-clip') === cid && m.type === 'childList') window.__hrsSwaps++;
        }
      });
      window.__hrsObserver.observe(document.documentElement, { subtree: true, childList: true });
    }, id).catch(() => {});
  }
}
/** 播一段、边播边采样(同 e2e 探针):回流在画的样本、跨过的帧数、快照平面变动的次数 */
async function playAndSample(page, id, { from, to, key = null }) {
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
  return { from, samples, drawn, first, last, frames: first && last ? Math.round((last.t - first.t) * FPS) : 0,
    swaps: swaps0 !== null && typeof lastState?.swaps === 'number' ? lastState.swaps - swaps0 : null };
}
function checkStreamPlaying(who, r, { key }) {
  const a = r.first?.clip.stream, b = r.last?.clip.stream;
  const brief = { samples: r.samples.length, drawn: r.drawn.length, frames: r.frames, swaps: r.swaps, tFrom: r.first?.t ?? null, tTo: r.last?.t ?? null,
    track: b ? { key: String(b.key).slice(0, 12), pushed: b.pushed, decoder: b.decoder, drawnFrom: a.drawn, drawnTo: b.drawn, lastFrom: a.lastDrawn, lastTo: b.lastDrawn, errors: b.errors, lastError: b.lastError } : null,
    origin: r.last?.origin ?? null };
  check(r.drawn.length >= 8 && r.frames >= 15, `${who}:播放中这条流在画的时间够长(≥ 15 帧)`, brief);
  if (!a || !b) return brief;
  check(b.key === key, `${who}:舞台上画的就是这条流(轨道的键 = 层表里渲染服务那个候选的结果键)`, { track: String(b.key).slice(0, 12), expect: String(key).slice(0, 12) });
  check(b.pushed === true, `${who}:流的字节是父页推给舞台的`, brief.track);
  check(b.drawn - a.drawn >= r.frames * 0.6 && b.lastDrawn > a.lastDrawn, `${who}:流播放器在出帧(画过的帧数跟着播放头涨)`, brief);
  check(Math.abs(b.lastDrawn - Math.round(r.last.t * FPS)) <= 3, `${who}:画着的那一帧跟着播放头(差不超过 3 帧)`, { lastDrawn: b.lastDrawn, stageFrame: Math.round(r.last.t * FPS) });
  check((b.errors ?? 0) === 0, `${who}:流播放器没有报错`, brief.track);
  check(r.drawn.every((s) => s.clip.suppressed), `${who}:播放中包裹层一直被抑制`, r.drawn.filter((s) => !s.clip.suppressed).length);
  const withSlot = r.drawn.filter((s) => s.clip.placeholder);
  brief.placeholderEarly = withSlot.filter((s) => s.t <= r.from + 0.7).length;
  check(withSlot.every((s) => s.t <= r.from + 0.7), `${who}:起播 0.7 秒之后没有占位符`, withSlot.filter((s) => s.t > r.from + 0.7).map((s) => s.t));
  // 垫着的是海报:播 frames 帧只换约 frames / 15 次(一摘一挂算两次变动);每拍换的话是 frames × 2 次上下
  check(typeof r.swaps === 'number' && r.swaps <= (Math.ceil(r.frames / SEG) + 2) * 2, `${who}:不是快照在换(播 ${r.frames} 帧,快照平面只变动了 ${r.swaps} 次)`, { swaps: r.swaps, frames: r.frames });
  return brief;
}
/**
 * 播放中截一张、同时记下流播放器正画着第几帧,再与那一帧的精确活渲、往后 2 秒的精确活渲比。
 * 画布卡的点每帧转约 4 个像素(半径 120 的圈上每秒 1 弧度),截图那一下前后最多差 2 帧,所以「相符」的线比 e2e 探针的 DOM 卡宽:
 * 差得多的像素 ≤ 1%;对照(2 秒后:转了约 115 度、颜色也换了)至少 2%、且至少是它的两倍。
 */
async function comparePixels(page, id, { from, name, key, until: untilSec }) {
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
      const s = await stageShot(page, `${name}-stream`);
      const after = await stageState(page, id);
      const ta = drawing(after, key);
      if (!s || !ta || after.clip.placeholder) { res.rejects.push({ shot: !!s, drawing: !!ta, t: after?.t ?? null }); continue; }
      const near = (st, t) => Math.abs(t.lastDrawn - Math.round((st.t ?? 0) * FPS)) <= 3;
      if (!near(before, tb) || !near(after, ta) || ta.lastDrawn < tb.lastDrawn) { res.rejects.push({ stale: [tb.lastDrawn, before.t, ta.lastDrawn, after.t] }); continue; }
      if (ta.lastDrawn - tb.lastDrawn <= 2) { shot = s; frame = Math.round((tb.lastDrawn + ta.lastDrawn) / 2); res.f0 = tb.lastDrawn; res.f1 = ta.lastDrawn; }
      else res.rejects.push({ frames: ta.lastDrawn - tb.lastDrawn });
    }
  }
  if (!check(!!shot, `${name}:播放中截到流在画的一帧`, res)) { await pauseAt(page, from).catch(() => {}); return res; }
  res.frame = frame;
  res.rejects = res.rejects.slice(-6);
  const same = await liveShot(page, id, frame / FPS, `${name}-live-same`);
  const far = await liveShot(page, id, (frame + 2 * FPS) / FPS, `${name}-live-far`);
  if (!check(!!same && !!far, `${name}:截到精确活渲的两张参照`, { same: !!same, far: !!far })) return res;
  res.same = diffOf(shot.png, same.png);
  res.far = diffOf(shot.png, far.png);
  res.colorful = { stream: colorfulOf(shot.png), live: colorfulOf(same.png) };
  check(res.same.bad <= 0.01 && res.same.mad <= 2.5, `${name}:流的画面与同一帧的精确活渲相符(差得多的像素 ≤ 1%、平均差 ≤ 2.5)`, res.same);
  check(res.far.bad >= 0.02 && res.far.bad >= res.same.bad * 2, `${name}:与往后 2 秒的精确活渲比,差明显更大(对照)`, { same: res.same, far: res.far });
  check(res.colorful.stream > 0.005 && Math.abs(res.colorful.stream - res.colorful.live) <= 0.006, `${name}:流的画面里那一圈彩色的点在,多少与活渲的相当`, res.colorful);
  return res;
}

let browser = null;
const LAUNCH_ARGS = ['--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--site-per-process', '--window-position=-32000,-32000'];
async function openMember({ projectId, name, username, password, deviceId }) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.message ?? e).slice(0, 240)));
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.25 });
  await plantResume(page, await resumeRecord({ base: HOSTED, derivationBase: `${DOC_DIRECT}/`, projectId, name, username, password, deviceId }));
  await page.goto(EDITOR, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const entered = await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 120_000 }).then(() => true, () => false);
  if (!check(entered, `${username} 进入项目(刷新后回到项目那条路)`)) throw new Error(`${username} 没进去`);
  await until(`${username} 的页面双舞台握上手`, async () => P(page, () => { const d = window.__pcPreviewDiag?.(); return d?.dual && d.onlineStages?.handshake === 'ok'; }), 120_000, 500);
  return { ctx, page };
}

/* ================================================================== 主流程 */

let creator1 = null, creator2 = null, chk = null;
async function main() {
  const t0 = Date.now();
  const dist = await startLocalSite();
  const health = await (await fetch(`${SITE}/hosted/healthz`)).json().catch(() => null);
  if (!check(health?.ok, '托管端 /hosted/healthz', health)) throw new Error('托管端不通');
  const { frameCode } = await import('../../server/frame-code.mjs');
  const codeVersion = frameCode(ROOT);
  const embedded = fs.readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js')).some((f) => fs.readFileSync(path.join(dist, 'assets', f), 'utf8').includes(codeVersion));
  if (!check(embedded, '在线构建嵌的代码版本与本进程算的一致(--dist 要是当前这份源码构建的)', { codeVersion: codeVersion.slice(0, 12) })) throw new Error('在线构建不是这份源码的');

  const auth = await import('../../server/auth/client.mjs');
  const M = {
    createSharedProject: auth.createSharedProject, buildAuthProtocols: auth.buildAuthProtocols, deriveKey: auth.deriveKey, adminProof: auth.adminProof,
    wsBaseOf: (await import('../../server/auth/route.mjs')).wsBaseOf,
    normalizeEntry: (await import('../../server/auth/shared-config.mjs')).normalizeEntry, sharedProtocols: (await import('../../server/auth/shared-config.mjs')).sharedProtocols,
    createWsEndpoint: (await import('../../server/render-node/ws-transport.mjs')).createWsEndpoint, createContentClient: (await import('../../server/render-node/content-client.mjs')).createContentClient,
    manifestMatches: (await import('../../server/artifact-transfer.mjs')).manifestMatches, resultKeyOf: (await import('../../server/render-node/fingerprint.mjs')).resultKeyOf,
    clipsPlanTaskOf: (await import('../../server/render-queue/messages.mjs')).clipsPlanTaskOf,
  };

  /* -------------------------------------------------------------- S 渲染服务起来 */
  startSupervisor(dist);
  const ready = await Promise.race([
    until('渲染服务就绪(控制连接连上、工作进程交过诊断)', async () => { const s = await status(); return s.directory?.connected && s.worker?.ready && s.queue ? s : null; }, 300_000, 1000),
    supervisor.exited.then((code) => { throw new Error(`渲染服务退出了(退出码 ${code})`); }),
  ]);
  if (!ready) throw new Error('渲染服务没起来');
  out.timings.serviceUpMs = Date.now() - t0;
  out.steps.S = { streams: ready.streams, capabilities: ready.queue.capabilities, envFingerprint: ready.queue.envFingerprint, maxConcurrent: ready.queue.maxConcurrent,
    warnings: (ready.selfcheck?.warnings ?? []).map((w) => w.reason), codeVersion: ready.codeVersion ?? null };
  say('service.ready', out.steps.S);
  check(ready.streams === true, 'S:渲染服务以能产流的方式起(/status 的 streams 为真)', { streams: ready.streams });
  check(ready.queue.capabilities?.streams === true && ready.queue.capabilities?.transcode === true, 'S:工作进程报能产流、能转码(探到了 H.264 编码器)', ready.queue.capabilities);
  check(ready.queue.envFingerprint === HOST_FP, 'S:渲染服务用上了测试指纹', { envFingerprint: ready.queue.envFingerprint });
  check(ready.queue.maxConcurrent === 1, 'S:并发 1', { maxConcurrent: ready.queue.maxConcurrent });

  /* -------------------------------------------------------------- A 新建的项目:这一项是关的 */
  const P1 = await makeProject(M, '一');
  creator1 = await joinAs(M, P1, { username: P1.creator, as: 'creator', device: 'creator-1' });
  const seedDoc = `seed-${P1.projectId.slice(-8)}`;
  const seeded = await putProject(creator1, P1.projectId, { version: 1, id: seedDoc, name: P1.name, ...PROJECT, themeId: 'midnight', media: [], tracks: [{ id: 't-1', name: '序列 1', clips: [] }] });
  check(seeded.ok, '替创建者写进空项目', seeded);
  const A = (out.steps.A = {});
  A.hosted = await hostedOf(creator1);
  check(A.hosted?.render?.available === true && A.hosted.render.enabled === true && A.hosted.render.streams === false, 'A:新建的项目,成员列表里渲染节点开着、「生成轨道流」是关的', A.hosted);
  const joined = await until('渲染服务连进项目一', async () => { const s = await status(); return nodeOf(s, P1.projectId)?.connected ? s : null; }, 60_000, 300);
  A.listed = listedOf(joined, P1.projectId);
  check(A.listed?.streams === false, 'A:渲染服务给工作进程的清单里,这个项目 streams: false', A.listed);

  // 核对用的连接(创建者,render 角色):内容库、素材票据
  const chkEntry = M.normalizeEntry({ url: M.wsBaseOf(HOSTED), projectId: P1.projectId, username: P1.creator, password: P1.creatorPassword, as: 'creator', role: 'render', deviceId: `hrs-chk-${RUN}`.padEnd(16, '0'), deviceName: '甲三探针 核对' });
  chk = M.createWsEndpoint({ url: chkEntry.url, protocols: M.sharedProtocols(chkEntry, { role: 'render' }), log: () => {} });
  await new Promise((r) => { if (chk.connected) r(); else chk.onOpen(r); });
  const content = M.createContentClient(chk);
  const assetAuth = () => new Promise((resolve) => {
    const reqId = `tk-${RUN}-${Math.random().toString(36).slice(2)}`;
    chk.onMessage((msg) => { if (msg?.reqId === reqId) resolve(msg?.type === 'auth.ticket.ok' ? { Authorization: `Bearer ${msg.ticket}` } : {}); });
    chk.send({ type: 'auth.ticket', kind: 'asset', access: 'r', reqId });
  });
  const getManifest = async (resultKey, from, to) => (await content.get('render-manifest', `${resultKey}:${from}-${to}`).catch(() => null))?.body ?? null;

  const { page } = await openMember({ projectId: P1.projectId, name: P1.name, username: 'hrs-jia', password: P1.password, deviceId: `hrs-jia-${RUN}`.padEnd(16, '0') });
  const clipId = await store(page, `
    const c = S.actions.addClipOnNewTrack({ index: 0, cardId: 'r6-canvas', start: args[0].start, duration: args[0].duration });
    S.actions.seek(args[0].start + args[0].duration + 1);
    return c.id;`, CLIP);
  const docId = await store(page, `return S.getState().project.id;`);
  out.clip = clipId;
  const layerKey = `layers:${docId}`;
  const layerMap = async () => (await content.get('snapshot-manifest', layerKey).catch(() => null))?.body ?? null;
  const streamRow = (map) => (map?.streams ?? []).find((r) => r.topClipId === clipId) ?? null;
  const briefRow = (row) => row && { kind: row.kind, plane: row.plane, contentKey: String(row.contentKey).slice(0, 12), firstSegment: row.firstSegment, lastSegment: row.lastSegment,
    candidates: (row.candidates ?? []).map((c) => ({ envFingerprint: c.envFingerprint, resultKey: String(c.resultKey).slice(0, 12) })) };

  const tOff = Date.now();
  const listed = await until('A:甲的清单计划里有这张卡', async () => { const d = await planDiag(page); return d?.lastClips?.includes(clipId) ? d : null; }, 240_000, 500);
  A.plan = listed && { lastClips: listed.lastClips.length, last: String(listed.last).slice(0, 40) };
  if (!check(!!listed, 'A:甲把这张画布卡判成重卡、发了清单计划', await planDiag(page))) throw new Error('页面没有把这张卡列进清单计划');
  const snapsDone = await until('A:这张卡的快照任务由渲染服务全部做完', async () => {
    const snaps = snapTasks(P1.projectId);
    return snaps.length >= 4 && snaps.every((t) => t.state === 'done') && planTasks(P1.projectId).every((t) => t.state === 'done') ? snaps : null;
  }, 600_000, 500);
  out.timings.snapshotsMs = Date.now() - tOff;
  const sA = await status();
  const nA = nodeOf(sA, P1.projectId);
  A.node = nA && { claimed: nA.claimed, completed: nA.completed, dedup: nA.dedup, plans: nA.plans, failed: nA.failed, released: nA.released };
  A.queue = { snapshots: briefTasks(snapTasks(P1.projectId)), streams: briefTasks(streamTasks(P1.projectId)), plans: planTasks(P1.projectId).length };
  say('A.rendered', { ms: out.timings.snapshotsMs, node: A.node, streams: A.queue.streams.length });
  check(!!snapsDone && (nA?.plans ?? 0) >= 1 && (nA?.completed ?? 0) >= 4 && (nA?.failed ?? 0) === 0, 'A:清单计划由渲染服务切分,快照任务照常做完,没有失败', A.node);
  check(streamTasks(P1.projectId).length === 0, 'A:这一项关着:队列里这个项目一条流任务都没有(渲染服务没切自己的那一份)', A.queue.streams);
  const mapA = await layerMap();
  A.layerMap = { v: mapA?.v ?? null, layers: (mapA?.layers ?? []).map((l) => l.clipId), streams: (mapA?.streams ?? []).length };
  check((mapA?.layers ?? []).some((l) => l.clipId === clipId), 'A:层表里有这张卡的快照层', A.layerMap);
  check(!streamRow(mapA), 'A:层表里没有这张卡的流', { row: briefRow(streamRow(mapA)) });
  const diagA = await onlineDiag(page);
  check(!(diagA?.streams ?? []).some((x) => x.clipId === clipId), 'A:甲的在线来源里没有这张卡的流', (diagA?.streams ?? []).map((x) => x.clipId));

  /* -------------------------------------------------------------- B 创建者打开 */
  const B = (out.steps.B = {});
  // 项目二:另一个项目,这一项先打开(C 那一步用)
  const P2 = await makeProject(M, '二');
  creator2 = await joinAs(M, P2, { username: P2.creator, as: 'creator', device: 'creator-2' });
  const on2 = await setStreams(M, creator2, P2, true);
  check(on2.type === 'shared.admin.ok', '项目二的创建者打开「生成轨道流」', { type: on2.type, reason: on2.reason });

  const tOn = Date.now();
  const on1 = await setStreams(M, creator1, P1, true);
  check(on1.type === 'shared.admin.ok' && on1.op === 'set-hosted-option', 'B:创建者打开「生成轨道流」(shared.admin 回 ok)', { type: on1.type, reason: on1.reason });
  B.hosted = await hostedOf(creator1);
  check(B.hosted?.render?.streams === true && B.hosted.render.enabled === true, 'B:成员列表里这一项变成开', B.hosted);
  const seenOn = await until('B:渲染服务的清单里项目一变成 streams: true', async () => { const s = await status(); return listedOf(s, P1.projectId)?.streams === true ? s : null; }, 30_000, 100);
  out.timings.onSeenByServiceMs = Date.now() - tOn;
  check(!!seenOn && listedOf(seenOn, P2.projectId) === null || listedOf(seenOn, P2.projectId)?.streams === true, 'B:项目二(还没人进,或已经在清单里)不受影响', listedOf(seenOn, P2.projectId));
  await delay(2500);
  B.beforeEdit = { streams: streamTasks(P1.projectId).length };
  check(B.beforeEdit.streams === 0, 'B(局限,见文件头):只打开、项目没有新的清单计划时,还没有流任务', B.beforeEdit);
  // 项目下一次发清单计划:让甲改一下项目名(内容键不变,快照任务都去重)
  const plansBefore = planTasks(P1.projectId).length;
  await store(page, `S.actions.setProjectMeta({ name: args[0] }); return true;`, `${P1.name}-开`);
  const tSplit = Date.now();
  const issued = await until('B:新的清单计划切出渲染服务自己的那一份流任务(三个)', async () => (streamTasks(P1.projectId).length >= 3 ? streamTasks(P1.projectId) : null), 180_000, 100);
  B.issued = { ms: Date.now() - tSplit, plans: planTasks(P1.projectId).length - plansBefore, streams: briefTasks(streamTasks(P1.projectId)) };
  if (!check(!!issued && issued.length === 3, 'B:切出三个流任务(分段 0～7、8～15、16～16)', B.issued)) throw new Error('没有切出流任务');
  check(STREAM_SPANS.every(([f, t]) => issued.some((x) => x.id.endsWith(`:${f}-${t}`))), 'B:流任务的分段范围对', issued.map((x) => x.id.slice(-8)));

  /* -------------------------------------------------------------- C 手里有一个流任务时再关 */
  const C = (out.steps.C = {});
  const held = await until('C:渲染服务认领了一个流任务', async () => streamTasks(P1.projectId).find((t) => t.state === 'claimed') ?? null, 180_000, 50);
  if (!held) throw new Error('渲染服务没有认领流任务');
  const releasedBefore = nodeOf(await status(), P1.projectId)?.released ?? 0;
  const tOffAgain = Date.now();
  const off1 = await setStreams(M, creator1, P1, false);
  C.offAfterClaimMs = Date.now() - tOffAgain;
  check(off1.type === 'shared.admin.ok', 'C:创建者关掉(shared.admin 回 ok)', { type: off1.type, reason: off1.reason });
  C.heldId = `${held.id.slice(0, 15)}…${held.id.slice(-6)}`;
  C.heldNode = held.claim?.nodeId ?? null;
  check(/^hosted-render:/.test(String(C.heldNode)), 'C:认领它的是托管方的渲染节点', { nodeId: C.heldNode });
  // 关的那一刻别的两个都还没被认领(并发 1)
  const others = streamTasks(P1.projectId).filter((t) => t.id !== held.id);
  check(others.length === 2 && others.every((t) => t.state === 'open'), 'C:关的那一刻另外两个流任务还是 open', briefTasks(others));
  await until('C:渲染服务的清单里项目一变回 streams: false', async () => (listedOf(await status(), P1.projectId)?.streams === false), 30_000, 100);
  const heldDone = await until('C:手里的那个流任务照做完', async () => { const t = streamTasks(P1.projectId).find((x) => x.id === held.id); return t?.state === 'done' ? t : (t?.state === 'failed' ? (fails.push(`C:手里的流任务失败了 ${t.lastError}`), t) : null); }, 300_000, 100);
  const tHeldDone = Date.now();
  C.heldMs = tHeldDone - tOffAgain;
  check(heldDone?.state === 'done' && heldDone.attempts <= 1, 'C:关掉之后手里的那个流任务没有被放回,照做完了', heldDone && { state: heldDone.state, attempts: heldDone.attempts, lastError: heldDone.lastError });

  // 同一段时间里:项目二(这一项开着)照常产流;项目一新发的清单计划照常被认领、切分(不切流)
  const doc2 = 'hrs-p2-doc';
  const body2 = { id: doc2, name: P2.name, width: 1280, height: 720, fps: FPS, duration: 2, themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
    tracks: [{ id: 'tr-1', name: 'tr-1', hidden: false, clips: [{ id: 'clip-p2', kind: 'card', cardId: 'r6-canvas', start: 0, end: 2, params: { probeSalt: RUN } }] }] };
  const put2 = await putProject(creator2, doc2, body2);
  check(put2.ok && Number.isSafeInteger(put2.rev), '项目二:写进一版项目', put2);
  await until('渲染服务连进项目二', async () => (nodeOf(await status(), P2.projectId)?.connected ? true : null), 60_000, 300);
  const hello = await creator2.ask({ type: 'publisher.hello', publisherId: `hrs-pub-${RUN}` });
  const plan2 = M.clipsPlanTaskOf({ projectId: doc2, projectRev: put2.rev, clips: ['clip-p2'], codeVersion });
  const pub2 = await creator2.ask({ type: 'task.publish', tasks: [plan2] });
  check(hello.type === 'publisher.welcome' && pub2.type === 'task.published', '项目二:发布清单计划', { hello: hello.type, publish: pub2.type });
  const t2 = Date.now();
  const done2 = await until('C:项目二的流任务与快照任务都做完', async () => {
    const st = streamTasks(P2.projectId), sn = snapTasks(P2.projectId);
    return st.length >= 1 && sn.length >= 1 && [...st, ...sn].every((t) => t.state === 'done') ? { st, sn } : null;
  }, 300_000, 300);
  C.project2 = { ms: Date.now() - t2, listed: listedOf(await status(), P2.projectId), streams: briefTasks(streamTasks(P2.projectId)), snapshots: snapTasks(P2.projectId).length };
  check(!!done2 && C.project2.listed?.streams === true, 'C:别的项目不受影响:项目二(这一项开着)的流任务在这段时间里照常被认领并做完', C.project2);

  const plansBeforeOff = planTasks(P1.projectId).length;
  const nBefore = nodeOf(await status(), P1.projectId);
  await store(page, `S.actions.setProjectMeta({ name: args[0] }); return true;`, `${P1.name}-关`);
  const replanned = await until('C:关着时项目一新发的清单计划照常被认领并切分', async () => {
    const plans = planTasks(P1.projectId);
    return plans.length > plansBeforeOff && plans.every((t) => t.state === 'done') ? nodeOf(await status(), P1.projectId) : null;
  }, 120_000, 300);
  C.replan = replanned && { plans: replanned.plans, plansBefore: nBefore?.plans ?? null, streams: streamTasks(P1.projectId).length };
  check(!!replanned && streamTasks(P1.projectId).length === 3, 'C:关着时的清单计划照常做(快照这一路照常),没有再切出流任务', C.replan);

  // 从手里那个做完算起,至少看 WATCH_MS:剩下的两个一直 open
  const left = WATCH_MS - (Date.now() - tHeldDone);
  if (left > 0) await delay(left);
  const sC = await status();
  const nC = nodeOf(sC, P1.projectId);
  const restNow = streamTasks(P1.projectId).filter((t) => t.id !== held.id);
  C.watchedMs = Date.now() - tHeldDone;
  C.rest = briefTasks(restNow);
  C.node = nC && { connected: nC.connected, claimed: nC.claimed, released: nC.released, held: nC.held?.length ?? 0, running: nC.running?.length ?? 0, failed: nC.failed };
  check(restNow.length === 2 && restNow.every((t) => t.state === 'open' && t.attempts === 0 && !t.claim), `C:再关之后 ${Math.round(C.watchedMs / 1000)} 秒里,剩下的两个流任务一直没有被认领`, C.rest);
  check(nC?.connected === true && listedOf(sC, P1.projectId)?.streams === false, 'C:渲染服务与这个项目的连接没断(只关这一项不断开服务)', { node: C.node, listed: listedOf(sC, P1.projectId) });
  check((nC?.released ?? 0) === releasedBefore, 'C:没有放回任何认领', { released: nC?.released, before: releasedBefore });
  // 已经产出的保留:那一段的流清单在内容库里;层表里这条流的那一行还在(候选是渲染服务的指纹)
  const mapC = await layerMap();
  const rowC = streamRow(mapC);
  C.row = briefRow(rowC);
  const candC = rowC?.candidates?.find((c) => c.envFingerprint === HOST_FP) ?? null;
  check(!!rowC && rowC.kind === 'card' && !!candC && candC.resultKey === M.resultKeyOf(rowC.contentKey, HOST_FP), 'C:层表里这条流的那一行还在,候选是渲染服务的指纹(结果键 = 内容键 × 渲染服务的指纹)', C.row);
  const heldSpan = STREAM_SPANS.find(([f, t]) => held.id.endsWith(`:${f}-${t}`));
  const keptManifest = candC && heldSpan ? await getManifest(candC.resultKey, heldSpan[0], heldSpan[1]) : null;
  C.kept = keptManifest && { range: keptManifest.range, segments: Object.keys(keptManifest.segments ?? {}).length };
  check(!!keptManifest && M.manifestMatches(keptManifest, { kind: 'stream', resultKey: candC.resultKey, range: { from: heldSpan[0], to: heldSpan[1] } }), 'C:已经产出的那一段保留着(内容库里有它的流清单)', C.kept);
  say('C.done', { heldMs: C.heldMs, watchedMs: C.watchedMs, rest: C.rest, node: C.node, project2: C.project2.ms });

  /* -------------------------------------------------------------- D 再打开 */
  const D = (out.steps.D = {});
  const tOn2 = Date.now();
  const on1b = await setStreams(M, creator1, P1, true);
  check(on1b.type === 'shared.admin.ok', 'D:创建者再打开', { type: on1b.type, reason: on1b.reason });
  const allDone = await until('D:剩下的两个流任务被认领并做完', async () => { const st = streamTasks(P1.projectId); return st.length === 3 && st.every((t) => t.state === 'done') ? st : null; }, 300_000, 200);
  D.ms = Date.now() - tOn2;
  D.streams = briefTasks(streamTasks(P1.projectId));
  check(!!allDone, 'D:再打开之后,剩下的流任务被渲染服务认领并做完', D.streams);
  const mapD = await layerMap();
  const rowD = streamRow(mapD);
  const cand = rowD?.candidates?.find((c) => c.envFingerprint === HOST_FP) ?? null;
  const hostKey = cand?.resultKey ?? null;
  D.row = briefRow(rowD);
  check(!!rowD && rowD.firstSegment === 0 && rowD.lastSegment === 16 && rowD.candidates.every((c) => c.envFingerprint === HOST_FP), 'D:层表里这条流:分段 0～16,候选只有渲染服务(画布卡浏览器做不了)', D.row);
  const authHeaders = await assetAuth();
  const blocks = [];
  let manifestsOk = 0;
  for (const [from, to] of STREAM_SPANS) {
    const m = hostKey ? await getManifest(hostKey, from, to) : null;
    const segs = Object.keys(m?.segments ?? {}).map(Number).sort((x, y) => x - y);
    const inits = Object.keys(m?.inits ?? {});
    if (m && M.manifestMatches(m, { kind: 'stream', resultKey: hostKey, range: { from, to } }) && segs.length === to - from + 1 && inits.length >= 1 && m.header?.kind === 'card' && m.header.clipIds?.join() === clipId) manifestsOk++;
    for (const id of inits) blocks.push({ hash: m.inits[id].hash, bytes: m.inits[id].bytes });
    for (const n of segs) blocks.push({ hash: m.segments[n].hash, bytes: m.segments[n].bytes, encoder: m.segments[n].encoder });
  }
  const uniq = [...new Map(blocks.map((b) => [b.hash, b])).values()];
  let complete = 0, hashOk = 0;
  for (const b of uniq) {
    const c = await (await fetch(`${SITE}/media/api/asset/px/${b.hash}/chunks`, { headers: authHeaders })).json().catch(() => null);
    if (c?.complete) complete++;
    const body = Buffer.from(await (await fetch(`${SITE}/media/api/asset/px/${b.hash}`, { headers: authHeaders })).arrayBuffer());
    if (sha256(body) === b.hash && body.length === b.bytes) hashOk++;
  }
  D.manifests = manifestsOk;
  D.blocks = { count: uniq.length, bytes: uniq.reduce((s, b) => s + b.bytes, 0), complete, hashOk, encoders: [...new Set(blocks.map((b) => b.encoder).filter(Boolean))] };
  check(manifestsOk === 3, 'D:内容库里三份流清单都在(过 manifestMatches、分段齐)', { manifestsOk });
  check(uniq.length >= 18 && complete === uniq.length && hashOk === uniq.length, 'D:素材服务 px 里开头文件与 17 个分段都 complete,取回的字节哈希与清单一致', D.blocks);

  /* -------------------------------------------------------------- E 在线页面播放时贴上 */
  const E = (out.steps.E = {});
  await pauseAt(page, 0.9);
  const readyE = await until('E:甲认出这条流、播放头附近的分段就绪', async () => { const d = await onlineDiag(page); const s = (d?.streams ?? []).find((x) => x.clipId === clipId); return s && s.ready >= 2 ? { d, s } : null; }, 90_000, 300);
  E.ready = readyE && { kind: readyE.s.kind, ready: readyE.s.ready, envFingerprint: readyE.s.envFingerprint, resultKey: String(readyE.s.resultKey).slice(0, 12), stale: readyE.d.staleStreams };
  check(!!readyE && readyE.s.resultKey === hostKey && readyE.s.envFingerprint === HOST_FP && readyE.d.staleStreams.length === 0, 'E:甲的在线来源里有这条流,选中的是渲染服务产的那一份,没有过期的', E.ready ?? (await onlineDiag(page))?.streams);
  const play = await playAndSample(page, clipId, { from: 0.9, to: 2.6, key: hostKey });
  E.play = checkStreamPlaying('E', play, { key: hostKey });
  E.pixels = await comparePixels(page, clipId, { from: 0.9, name: 'e-jia', key: hostKey, until: 2.8 });
  await pauseAt(page, CLIP.start + CLIP.duration + 1);

  /* -------------------------------------------------------------- F 收尾 */
  const sF = await status();
  const nF = nodeOf(sF, P1.projectId), nF2 = nodeOf(sF, P2.projectId);
  out.steps.F = { pageErrors: page.errors.slice(0, 5), node1: nF && { claimed: nF.claimed, completed: nF.completed, dedup: nF.dedup, plans: nF.plans, failed: nF.failed, released: nF.released, lost: nF.lost },
    node2: nF2 && { claimed: nF2.claimed, completed: nF2.completed, plans: nF2.plans, failed: nF2.failed }, codeVersion: sF.codeVersion ?? null };
  check(page.errors.length === 0, 'F:页面没有未捕获的错误', out.steps.F.pageErrors);
  check((nF?.failed ?? 1) === 0 && (nF2?.failed ?? 1) === 0, 'F:整个过程渲染服务没有失败的任务', { node1: out.steps.F.node1, node2: out.steps.F.node2 });
  check(sF.codeVersion?.match !== false, 'F:渲染服务与在线页面是同一个代码版本', sF.codeVersion);
  out.timings.totalMs = Date.now() - t0;
}

let exitCode = 1;
try {
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 900_000, args: [...PROBE_CHROME_ARGS, ...LAUNCH_ARGS] });
  await main();
  out.ok = fails.length === 0;
  exitCode = out.ok ? 0 : 1;
} catch (e) {
  fails.push(`异常:${String(e?.stack ?? e).slice(0, 900)}`);
  out.lastRenderLogs = supLogs.filter((l) => l.event !== 'worker.line').slice(-12);
} finally {
  try { chk?.close(); } catch { /* 已关 */ }
  try { creator1?.close(); } catch { /* 已关 */ }
  try { creator2?.close(); } catch { /* 已关 */ }
  try { await browser?.close(); } catch { /* 已关 */ }
  try { await stopSupervisor(); } catch { /* 已停 */ }
  try { await hostedProxy?.close(); } catch { /* 已关 */ }
  try { await combo?.close?.(); } catch { /* 已关 */ }
  if (!KEEP) { try { fs.rmSync(path.join(TMP, 'hosted'), { recursive: true, force: true }); fs.rmSync(RENDER_SECRETS, { recursive: true, force: true }); fs.rmSync(RENDER_DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* 有文件还被占着,留给系统清 */ } }
  else out.tmp = TMP;
}
out.fails = fails;
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(exitCode);
