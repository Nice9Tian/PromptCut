#!/usr/bin/env node
/**
 * 托管方渲染服务的本机整套演练(契约 `docs/plan/hosted-render-contract.md` 第 10.2～10.4 节;任务书
 * `sound-online-render-task.md` 第 23 条里本机能验的各项)。**一条命令**起隔离的托管组合 + 渲染服务 + 发任务 + 断言产物入库,
 * 不依赖浏览器观察端:成员一侧由本进程扮演(Node 里的 WebSocket),发布的是在线页面那种带片段清单的计划任务。
 *
 *   node scripts/probes/hosted-render-probe.mjs [--steps work,late,forbidden,switch,kill,limits,load,delete]
 *        [--base-port 5730] [--doc-port 8794] [--asset-port 8795] [--keep-temp] [--verbose] [--memory-step-max 150M] [--mem-low 256M]
 *        `--mem-low`:演练时背压的可用内存线(生产缺省 2G;开发机上常年可用内存不到 2 GB,照缺省会一直暂停认领,所以演练缺省放到 256M)
 *
 * 端口(都只绑 127.0.0.1):`--base-port` +0/+1/+2 渲染服务的工作进程(编辑器与两个舞台端口)、+6 管理进程的诊断与代理口;
 * `--doc-port` / `--asset-port` 托管组合的文档服务与素材服务。全部数据在一个临时目录里,结束时删掉(`--keep-temp` 保留)。
 *
 * 环境变量(都可不设):
 *   PROMPTCUT_TEST_ENV_FINGERPRINT   原样传给渲染服务:让它报这个环境指纹。在 Windows 开发机上不设时探针自己给一个
 *                                    (`7e57c10d00000001`),使它与本机桌面的指纹不同;Linux 上不设就用真实指纹
 *   PROMPTCUT_RENDER_SKIP_CHECKS     原样传给渲染服务(如 `ffmpeg`:机器上没有 ffmpeg 时跳过那一项自检)
 *   PC_CHROME_ARGS                   原样传给预渲染的 Chrome(排查用)
 *   需要:Node ≥ 22.18;仓库的依赖已装(vite、puppeteer 与它的 chrome-headless-shell);Linux 上要中文字体与 ffmpeg(自检会查)。
 *   root 或容器里 Chrome 自动带 --no-sandbox;没有 systemd 时自检报 no-cgroup 告警并继续。
 *
 * 步骤(缺省全跑,顺序固定;每步的判据):
 *   work       新建项目、成员进入,**不做任何配置**:5 s 内渲染服务连进这个项目;发一个清单计划 → 被 `service:render` 认领并切分,
 *              细任务全部 done;内容库里有这一版的层表(`snapshot-manifest` 的 `layers:<项目文档 id>`),素材服务的 `snap` / `px` 里有新块;
 *              成员列表里有 `service: 'render'` 一行
 *   late       发布方走了(成员全部断开)之后才上线的另一位成员:不发任何任务,直接取得到层表与清单里的块
 *   forbidden  用渲染服务的身份提交一次编辑(`project.op`)被拒,项目版本号不变;写卡片源码、给自己签 page 票据同样被拒
 *   switch     创建者关掉开关:5 s 内渲染服务断开这个项目,之后发的计划它不认领;再打开:连回来并认领
 *   kill       结束工作进程整棵树 → 管理进程把它重新拉起、对账、恢复接活(再发一个计划能做完);结束管理进程 → 工作进程自己退出,
 *              探针(扮 PM2)重起管理进程后恢复接活
 *   limits     并发:一个计划切出多段,全程同时持有的认领不超过并发上限;内存:把硬上限调到 `--memory-step-max`,
 *              管理进程量到超限、结束工作进程(`worker.exit` 的 reason 是 `oom`)、退避重起,10 分钟内第 3 次时并发降到 1(`render.degraded`)
 *   load       渲染进行中与空闲时,文档服务 `/healthz` 往返时延的对比(本机数字只作参考)
 *   delete     创建者删项目:渲染服务断开,目录里没有这个项目
 *
 * 输出:过程写 stderr(一行一条 JSON);stdout 最后一行是结果,形如
 *   {"ok":true,"fails":[],"platform":"linux","steps":{"work":{"ok":true,"joinMs":812,"planMs":15320,"tasks":5,"done":5,"layers":3,"snapBlobs":…,"pxBlobs":…},…},"selfcheck":{…},"envFingerprint":"…","codeVersion":"…"}
 * `ok` 为 true 且 `fails` 为空才算过;退出码 0 过、1 不过、2 起不来。不打印私钥、口令、票据。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startHostedCombo, hostedPaths } from '../../server/hosted/combo.mjs';
import { runKeygen } from '../../server/hosted-render/keygen.mjs';
import { killTree } from '../../server/hosted-render/worker.mjs';
import { createSharedProject, buildAuthProtocols, deriveKey, adminProof, ticketProtocols } from '../../server/auth/client.mjs';
import { readServiceKeyFile, buildServiceProtocols } from '../../server/auth/service-identity.mjs';
import { clipsPlanTaskOf } from '../../server/render-queue/messages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const flag = (name) => argv.includes(name);
const ALL_STEPS = ['work', 'late', 'forbidden', 'switch', 'kill', 'limits', 'load', 'delete'];
const STEPS = String(arg('--steps', ALL_STEPS.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
const BASE = Number(arg('--base-port', 5730));
const PORTS = { worker: BASE, status: BASE + 6, doc: Number(arg('--doc-port', 8794)), asset: Number(arg('--asset-port', 8795)) };
const KEEP = flag('--keep-temp');
const VERBOSE = flag('--verbose');
const MEMORY_STEP_MAX = String(arg('--memory-step-max', '150M'));
const MEM_LOW = String(arg('--mem-low', '256M'));
const MAX_CONCURRENT = 2;
const FPS = 30;
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hosted-render-'));
const DOC_WS = `ws://127.0.0.1:${PORTS.doc}`;
const DOC_HTTP = `http://127.0.0.1:${PORTS.doc}`;
const STATUS = `http://127.0.0.1:${PORTS.status}`;
const DOC_ID = 'hosted-render-probe';

const fails = [];
const out = { ok: false, run: RUN, platform: process.platform, ports: PORTS, steps: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 500)}`)); return !!cond; };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);

async function waitFor(fn, ms, what, every = 250) {
  const until = Date.now() + ms;
  let last;
  for (;;) {
    try { last = await fn(); } catch (err) { last = null; if (VERBOSE) say('wait-error', { what, message: String(err?.message ?? err) }); }
    if (last) return last;
    if (Date.now() > until) throw new Error(`等「${what}」超时(${ms} ms)`);
    await delay(every);
  }
}
const status = async () => (await fetch(`${STATUS}/status`, { signal: AbortSignal.timeout(5000) })).json();

/* ------------------------------------------------------------------ 成员一侧的连接 */

let reqSeq = 0;
function connect(protocols) {
  const ws = new WebSocket(DOC_WS, protocols);
  const all = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    all.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('连接失败')), { once: true });
  });
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }), { once: true }));
  const c = {
    ws, all, opened, closed,
    send: (m) => ws.send(JSON.stringify(m)),
    next(match, ms = 10_000) {
      const hit = all.find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('等消息超时')); } }, ms).unref?.();
      });
    },
    async ask(message, ms = 10_000) {
      const reqId = `hrp-${++reqSeq}`;
      c.send({ ...message, reqId });
      return c.next((m) => m?.reqId === reqId, ms);
    },
    close() { try { ws.close(); } catch { /* 已关 */ } },
  };
  return c;
}

const device = (name) => ({ deviceId: `hrp-${RUN}-${name}`.padEnd(20, '0').slice(0, 48), deviceName: name });

async function joinAs(proj, { username, as = 'member', name }) {
  const dev = device(name ?? username);
  const protocols = await buildAuthProtocols({
    base: DOC_WS, projectId: proj.projectId, username, deviceId: dev.deviceId, deviceName: dev.deviceName, as,
    password: as === 'creator' ? proj.creatorPassword : proj.password, role: 'page',
  });
  const c = connect(protocols);
  await c.opened;
  return c;
}

/** 创建者操作:取挑战、按创建者口令算证明、发 shared.admin */
async function adminOp(c, proj, op, fields = {}) {
  const ch = await c.ask({ type: 'shared.challenge' });
  if (ch.type !== 'shared.challenge.ok') return ch;
  const key = await deriveKey(proj.creatorPassword, ch.salt, ch.kdf);
  const m = await adminProof({ key, projectId: proj.projectId, username: proj.creator, op, nonce: ch.nonce });
  return c.ask({ type: 'shared.admin', op, ...fields, proof: { nonce: ch.nonce, m } });
}

/** 3 秒 = 90 帧:两张共享档的探针卡(同 render-host-probe 的项目);`salt` 进 params,每轮内容键全新 */
function probeProject(salt, extraClips = 0) {
  const tracks = [
    { id: 'tr-1', name: 'tr-1', hidden: false, clips: [{ id: 'clip-stateful', kind: 'card', cardId: 'r6-stateful', start: 0, end: 3, params: {} }] },
    { id: 'tr-2', name: 'tr-2', hidden: false, clips: [{ id: 'clip-canvas', kind: 'card', cardId: 'r6-canvas', start: 0, end: 3, params: { probeSalt: salt } }] },
  ];
  for (let i = 0; i < extraClips; i += 1) {
    tracks.push({ id: `tr-x${i}`, name: `tr-x${i}`, hidden: false, clips: [{ id: `clip-x${i}`, kind: 'card', cardId: 'r6-canvas', start: 0, end: 3, params: { probeSalt: `${salt}-x${i}` } }] });
  }
  return {
    id: DOC_ID, name: '托管方渲染服务探针', width: 1920, height: 1080, fps: FPS, duration: 3,
    themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
    tracks,
  };
}
const clipIdsOf = (project) => project.tracks.flatMap((t) => t.clips.map((c) => c.id));

/* ------------------------------------------------------------------ 托管组合与渲染服务 */

let combo = null;
let supervisor = null;
const supLogs = [];
const HOSTED_DATA = path.join(TMP, 'hosted');
const RENDER_SECRETS = path.join(TMP, 'render-secrets');
const RENDER_DATA = path.join(TMP, 'render');

function startSupervisor(extraEnv = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^PROMPTCUT_RENDER_/.test(k) && k !== 'PROMPTCUT_RENDER_SKIP_CHECKS') delete env[k];
  Object.assign(env, {
    PROMPTCUT_RENDER_DOC_URL: DOC_WS,
    PROMPTCUT_RENDER_SECRETS: RENDER_SECRETS,
    PROMPTCUT_RENDER_DATA: RENDER_DATA,
    PROMPTCUT_RENDER_PORT: String(PORTS.worker),
    PROMPTCUT_RENDER_STATUS_PORT: String(PORTS.status),
    PROMPTCUT_RENDER_MAX_CONCURRENT: String(MAX_CONCURRENT),
    PROMPTCUT_RENDER_SAMPLE_MS: '2000',
    PROMPTCUT_RENDER_MEM_LOW: MEM_LOW,
    PROMPTCUT_RENDER_EDITOR_DIR: path.join(TMP, 'no-editor'),
    ...extraEnv,
  });
  if (!env.PROMPTCUT_TEST_ENV_FINGERPRINT && process.platform === 'win32') env.PROMPTCUT_TEST_ENV_FINGERPRINT = '7e57c10d00000001';
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'hosted-render', 'main.mjs')], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let tail = '';
  const take = (chunk) => {
    const lines = (tail + chunk.toString()).split('\n');
    tail = lines.pop() ?? '';
    for (const line of lines) {
      let j = null;
      try { j = JSON.parse(line); } catch { /* 不是 JSON 的行 */ }
      if (j) supLogs.push(j);
      if (VERBOSE || (j && !['worker.line'].includes(j.event))) process.stderr.write(`[render] ${line.slice(0, 600)}\n`);
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
  const done = await Promise.race([s.exited.then(() => true), delay(30_000).then(() => false)]);
  if (!done) killTree(s.child.pid);
}

/** 渲染服务就绪:控制连接连上、工作进程起来并交过诊断 */
const waitReady = (ms = 300_000) => waitFor(async () => {
  const s = await status();
  return s.directory?.connected && s.worker?.ready && s.queue ? s : null;
}, ms, '渲染服务就绪', 1000);

/** 渲染服务在这个项目里的节点(从它的诊断里看) */
const nodeOf = (s, projectId) => (s.queue?.nodes ?? []).find((n) => n.projectId === projectId) ?? null;
const waitJoined = (projectId, ms = 10_000) => waitFor(async () => { const n = nodeOf(await status(), projectId); return n?.connected ? n : null; }, ms, '渲染服务连进项目', 200);
const waitLeft = (projectId, ms = 10_000) => waitFor(async () => (nodeOf(await status(), projectId) ? null : true), ms, '渲染服务离开项目', 200);

/** 托管组合里这个项目的队列任务(本进程里直接看) */
function queueTasks(projectId) {
  const mods = combo.service.describe().modules ?? {};
  for (const d of Object.values(mods)) {
    const tasks = d?.spaces?.[projectId]?.tasks;
    if (Array.isArray(tasks)) return tasks;
  }
  return [];
}

/** 以成员身份放一版项目内容,回版本号 */
async function putProject(c, project) {
  const r = await c.ask({ type: 'project.op', projectId: DOC_ID, opId: `op-${RUN}-${++reqSeq}`, session: `s-${RUN}`, ops: [{ op: 'set', path: '', value: project }] }, 20_000);
  if (r.type !== 'project.op.ok') throw new Error(`project.op 被拒:${JSON.stringify(r).slice(0, 300)}`);
  return r.rev;
}

/** 发布之前队列里已有的任务 id(之后新出现的就是这一个计划切出来的;各步骤顺序执行,不会交叠) */
const knownTasks = new Set();
/** 以成员身份发一个清单计划;回任务 id */
async function publishPlan(c, { rev, clips, codeVersion }) {
  knownTasks.clear();
  for (const t of queueTasks(ctx.proj.projectId)) knownTasks.add(t.id);
  if (!c.publisher) {
    const hello = await c.ask({ type: 'publisher.hello', publisherId: `hrp-pub-${RUN}-${++reqSeq}` });
    if (hello.type !== 'publisher.welcome') throw new Error(`publisher.hello:${JSON.stringify(hello).slice(0, 200)}`);
    c.publisher = true;
  }
  const task = clipsPlanTaskOf({ projectId: DOC_ID, projectRev: rev, clips, codeVersion });
  const r = await c.ask({ type: 'task.publish', tasks: [task] });
  if (r.type !== 'task.published') throw new Error(`task.publish:${JSON.stringify(r).slice(0, 300)}`);
  return task.id;
}

/** 等这一版的计划与它切出的细任务全部做完;回 { tasks, done, failed, maxClaimed, ms } */
async function waitRendered(projectId, rev, planId, ms = 240_000, onTick = null) {
  const started = Date.now();
  let maxClaimed = 0;
  const mine = (t) => t.id === planId || !knownTasks.has(t.id);
  const result = await waitFor(async () => {
    const tasks = queueTasks(projectId).filter(mine);
    const fine = tasks.filter((t) => !t.id.startsWith('plan:'));
    maxClaimed = Math.max(maxClaimed, tasks.filter((t) => t.state === 'claimed').length);
    if (onTick) await onTick(tasks);
    const plan = tasks.find((t) => t.id === planId);
    if (!plan || plan.state !== 'done' || fine.length === 0) return null;
    if (fine.some((t) => t.state === 'open' || t.state === 'claimed')) return null;
    return { tasks: fine.length, done: fine.filter((t) => t.state === 'done').length, failed: fine.filter((t) => t.state === 'failed').length };
  }, ms, '计划与细任务做完', 200);
  return { ...result, maxClaimed, ms: Date.now() - started };
}

const layerMapOf = async (c) => c.ask({ type: 'content.get', kind: 'snapshot-manifest', key: `layers:${DOC_ID}` });
async function blobCounts() {
  const inv = await combo.inventory();
  return { snap: inv.assets.snap.count, px: inv.assets.px.count, media: inv.assets.media.count, bytes: inv.assets.snap.bytes + inv.assets.px.bytes };
}

/* ------------------------------------------------------------------ 步骤 */

const ctx = { proj: null, creator: null, codeVersion: null, rev: null, salt: 0 };

async function stepWork() {
  const r = {};
  const name = `hrp-${RUN}`;
  const creatorPassword = `c-${randomBytes(9).toString('base64url')}`;
  const password = `p-${randomBytes(9).toString('base64url')}`;
  const made = await createSharedProject({ base: DOC_WS, name, mode: 'free', creator: { username: 'alice', password: creatorPassword }, password });
  ctx.proj = { projectId: made.projectId, name, creator: 'alice', creatorPassword, password };
  const before = await blobCounts();
  const t0 = Date.now();
  ctx.creator = await joinAs(ctx.proj, { username: 'alice', as: 'creator' });
  const node = await waitJoined(ctx.proj.projectId, 10_000);
  r.joinMs = Date.now() - t0;
  check(r.joinMs <= 5000, 'work:新建项目后渲染服务 5 s 内连进来', { joinMs: r.joinMs });
  r.nodeId = node.nodeId;

  const project = probeProject(`${RUN}-${++ctx.salt}`);
  ctx.rev = await putProject(ctx.creator, project);
  const planId = await publishPlan(ctx.creator, { rev: ctx.rev, clips: clipIdsOf(project), codeVersion: ctx.codeVersion });
  const done = await waitRendered(ctx.proj.projectId, ctx.rev, planId);
  Object.assign(r, { planMs: done.ms, tasks: done.tasks, done: done.done, failed: done.failed });
  check(done.done === done.tasks && done.failed === 0, 'work:细任务全部 done', done);

  const s = await status();
  const n = nodeOf(s, ctx.proj.projectId);
  // 认领数含计划本身;完成数不含按结果键去重的(dedup 另计)
  Object.assign(r, { claimed: n?.claimed ?? 0, completed: n?.completed ?? 0, dedup: n?.dedup ?? 0, lost: n?.lost ?? 0 });
  check((n?.claimed ?? 0) >= done.tasks + 1 && (n?.failed ?? 0) === 0, 'work:计划与细任务都是渲染服务认领的', { claimed: n?.claimed, failed: n?.failed, tasks: done.tasks });

  const map = await layerMapOf(ctx.creator);
  r.layers = Array.isArray(map.body?.layers) ? map.body.layers.length : 0;
  check(map.type === 'content.item' && !map.missing && r.layers > 0, 'work:内容库里有这一版的层表', { type: map.type, missing: map.missing, layers: r.layers });
  const after = await blobCounts();
  r.snapBlobs = after.snap - before.snap;
  r.pxBlobs = after.px - before.px;
  r.bytes = after.bytes - before.bytes;
  check(r.snapBlobs + r.pxBlobs > 0, 'work:素材服务里有新产物', { before, after });
  check(after.media === before.media, 'work:没有写素材原件', { before: before.media, after: after.media });

  const members = await ctx.creator.ask({ type: 'shared.members' });
  const row = (members.devices ?? []).find((d) => d.service === 'render');
  check(!!row && row.creator === false, 'work:成员列表里有 service: render 一行', members.devices);
  check(members.hosted?.render?.available === true && members.hosted?.render?.enabled === true, 'work:成员列表顶层 hosted.render', members.hosted);
  return r;
}

async function stepLate() {
  const r = {};
  // 发布方(创建者,唯一的成员)走掉;之后另一位成员才上线,不发任何任务
  ctx.creator.close();
  await delay(1500);
  const late = await joinAs(ctx.proj, { username: 'late-bob', name: 'late' });
  const map = await layerMapOf(late);
  r.layers = Array.isArray(map.body?.layers) ? map.body.layers.length : 0;
  check(map.type === 'content.item' && !map.missing && r.layers > 0, 'late:之后上线的成员直接取得到层表', { type: map.type, missing: map.missing });
  const list = await late.ask({ type: 'content.list', kind: 'snapshot-manifest' });
  r.manifests = list.items?.length ?? 0;
  check(r.manifests > 1, 'late:内容库里有各段的清单', { manifests: r.manifests });
  // 取一个清单,核对它指的块在素材服务里(凭这位成员自己的只读票据)
  const ticket = await late.ask({ type: 'auth.ticket', kind: 'asset', access: 'r' });
  const keys = (list.items ?? []).map((i) => i.key).filter((k) => !k.startsWith('layers:'));
  let fetched = 0;
  let missing = 0;
  for (const key of keys.slice(0, 3)) {
    const item = await late.ask({ type: 'content.get', kind: 'snapshot-manifest', key });
    const hashes = [...new Set(JSON.stringify(item.body ?? {}).match(/\b[0-9a-f]{64}\b/g) ?? [])].slice(0, 6);
    for (const hash of hashes) {
      let ok = false;
      for (const ns of ['snap', 'px']) {
        const res = await fetch(`http://127.0.0.1:${PORTS.asset}/api/asset/${ns}/${hash}`, { method: 'HEAD', headers: { authorization: `Bearer ${ticket.ticket}` } });
        if (res.status === 200) { ok = true; break; }
      }
      if (ok) fetched += 1; else missing += 1;
    }
  }
  r.blobsChecked = fetched + missing;
  r.blobsFound = fetched;
  check(fetched > 0, 'late:清单里的块在素材服务里取得到', { fetched, missing });
  const pending = queueTasks(ctx.proj.projectId).filter((t) => t.state === 'open' || t.state === 'claimed').length;
  r.pendingTasks = pending;
  check(pending === 0, 'late:这位成员没有发任何任务,队列里也没有待做的', { pending });
  late.close();
  ctx.creator = await joinAs(ctx.proj, { username: 'alice', as: 'creator' });
  await waitJoined(ctx.proj.projectId, 15_000);
  return r;
}

async function stepForbidden() {
  const r = {};
  // 探针手里有这把服务私钥(它自己生成的):像渲染服务那样握手、要票据、进项目,然后试着改项目
  const key = readServiceKeyFile(RENDER_SECRETS);
  const control = connect(await buildServiceProtocols({ base: DOC_WS, key }));
  await control.opened;
  const t = await control.ask({ type: 'hosted.ticket', projectId: ctx.proj.projectId });
  check(t.type === 'hosted.ticket.ok', 'forbidden:要得到服务票据', { type: t.type, reason: t.reason });
  const data = connect(ticketProtocols(t.ticket));
  await data.opened;
  const before = await ctx.creator.ask({ type: 'project.open', projectId: DOC_ID });
  const outcome = async (message) => { const m = await data.ask(message); return m.type === 'error' ? `error:${m.reason}` : m.type; };
  r.edit = await outcome({ type: 'project.op', projectId: DOC_ID, opId: `evil-${RUN}`, session: 's-evil', ops: [{ op: 'set', path: '/name', value: 'hacked' }] });
  r.cardSource = await outcome({ type: 'content.put', kind: 'card-source', key: 'src/cards/user/evil.card.tsx', body: { source: 'x' } });
  r.pageTicket = await outcome({ type: 'auth.ticket', kind: 'conn', role: 'page' });
  r.announce = await outcome({ type: 'project.announce', projectId: DOC_ID, digest: 'a'.repeat(64) });
  r.read = await outcome({ type: 'project.open', projectId: DOC_ID });
  for (const k of ['edit', 'cardSource', 'pageTicket', 'announce']) check(r[k] === 'error:forbidden', `forbidden:${k} 被拒`, r[k]);
  check(r.read === 'project.state', 'forbidden:读项目是允许的', r.read);
  const after = await ctx.creator.ask({ type: 'project.open', projectId: DOC_ID });
  r.revBefore = before.rev;
  r.revAfter = after.rev;
  check(before.rev === after.rev && !JSON.stringify(after).includes('hacked'), 'forbidden:项目版本号与内容不变', { before: before.rev, after: after.rev });
  data.close();
  control.close();
  return r;
}

async function stepSwitch() {
  const r = {};
  const off = await adminOp(ctx.creator, ctx.proj, 'set-hosted-service', { service: 'render', enabled: false });
  check(off.type === 'shared.admin.ok', 'switch:关开关', off);
  const t0 = Date.now();
  await waitLeft(ctx.proj.projectId, 10_000);
  r.offMs = Date.now() - t0;
  check(r.offMs <= 5000, 'switch:关掉后 5 s 内断开', { offMs: r.offMs });
  const project = probeProject(`${RUN}-${++ctx.salt}`);
  const rev = await putProject(ctx.creator, project);
  const planId = await publishPlan(ctx.creator, { rev, clips: clipIdsOf(project), codeVersion: ctx.codeVersion });
  await delay(8000);
  const plan = queueTasks(ctx.proj.projectId).find((t) => t.id === planId);
  r.planStateWhileOff = plan?.state ?? null;
  check(plan?.state === 'open', 'switch:关着的时候发的计划没人认领', { state: plan?.state });
  const members = await ctx.creator.ask({ type: 'shared.members' });
  check(members.hosted?.render?.enabled === false && !(members.devices ?? []).some((d) => d.service === 'render'), 'switch:成员列表反映关着', members.hosted);

  const on = await adminOp(ctx.creator, ctx.proj, 'set-hosted-service', { service: 'render', enabled: true });
  check(on.type === 'shared.admin.ok', 'switch:再打开', on);
  const t1 = Date.now();
  await waitJoined(ctx.proj.projectId, 15_000);
  r.onMs = Date.now() - t1;
  const done = await waitRendered(ctx.proj.projectId, rev, planId);
  r.afterOn = { tasks: done.tasks, done: done.done, ms: done.ms };
  check(done.done === done.tasks && done.tasks > 0, 'switch:再打开后把之前发的计划做完', done);
  ctx.rev = rev;
  return r;
}

async function renderOnce(label) {
  const project = probeProject(`${RUN}-${++ctx.salt}`);
  const rev = await putProject(ctx.creator, project);
  const planId = await publishPlan(ctx.creator, { rev, clips: clipIdsOf(project), codeVersion: ctx.codeVersion });
  const done = await waitRendered(ctx.proj.projectId, rev, planId);
  check(done.done === done.tasks && done.tasks > 0, `${label}:恢复后能把新计划做完`, done);
  ctx.rev = rev;
  return done;
}

async function stepKill() {
  const r = {};
  // 1. 结束工作进程整棵树:管理进程自己的看护把它拉起
  const s0 = await status();
  const pid = s0.worker.pid;
  const starts = s0.worker.starts;
  killTree(pid);
  const t0 = Date.now();
  await waitFor(async () => { const s = await status(); return s.worker.starts > starts && s.worker.ready && s.worker.pid !== pid ? s : null; }, 300_000, '工作进程被重新拉起', 1000);
  await waitJoined(ctx.proj.projectId, 60_000);
  r.workerRestartMs = Date.now() - t0;
  const exit = supLogs.filter((l) => l.event === 'worker.exit').at(-1);
  r.workerExit = exit ? { code: exit.code, signal: exit.signal, reason: exit.reason } : null;
  r.afterWorkerKill = await renderOnce('kill-worker');

  // 2. 结束管理进程(不给它收尾的机会):工作进程发现管理进程没了自己退出;探针扮 PM2 把管理进程重起
  const oldWorker = (await status()).worker.pid;
  const sup = supervisor;
  killTree(sup.child.pid);
  await sup.exited;
  const t1 = Date.now();
  startSupervisor();
  await waitReady(300_000);
  await waitJoined(ctx.proj.projectId, 60_000);
  r.supervisorRestartMs = Date.now() - t1;
  r.oldWorkerGone = await waitFor(async () => { try { process.kill(oldWorker, 0); return null; } catch { return true; } }, 60_000, '旧的工作进程退出', 500).catch(() => false);
  check(r.oldWorkerGone === true, 'kill:管理进程没了之后旧的工作进程自己退出', { oldWorker });
  r.afterSupervisorKill = await renderOnce('kill-supervisor');
  return r;
}

async function stepLimits() {
  const r = {};
  // 并发:一个计划切出多段,全程同时持有的认领不超过上限
  const project = probeProject(`${RUN}-${++ctx.salt}`, 4);
  const rev = await putProject(ctx.creator, project);
  const planId = await publishPlan(ctx.creator, { rev, clips: clipIdsOf(project), codeVersion: ctx.codeVersion });
  let maxBusy = 0;
  let lastStatusAt = 0;
  const done = await waitRendered(ctx.proj.projectId, rev, planId, 300_000, async () => {
    if (Date.now() - lastStatusAt < 500) return;
    lastStatusAt = Date.now();
    try { const s = await status(); maxBusy = Math.max(maxBusy, (s.queue?.nodes ?? []).reduce((n, x) => n + (x.held?.length ?? 0), 0)); } catch { /* 这一拍没问到 */ }
  });
  r.concurrency = { limit: MAX_CONCURRENT, tasks: done.tasks, done: done.done, maxClaimedInQueue: done.maxClaimed, maxHeldByService: maxBusy, ms: done.ms };
  check(done.tasks > MAX_CONCURRENT, 'limits:任务数多于并发上限(这一步才有意义)', done);
  check(done.maxClaimed <= MAX_CONCURRENT && maxBusy <= MAX_CONCURRENT, 'limits:同时持有的认领不超过并发上限', r.concurrency);
  check(done.done === done.tasks, 'limits:超出并发的任务排队做完,没有失败', done);
  ctx.rev = rev;

  // 内存:硬上限调到很小,管理进程量到超限 → 结束工作进程 → 退避重起 → 第 3 次并发降到 1
  await stopSupervisor();
  const mark = supLogs.length;
  startSupervisor({ PROMPTCUT_RENDER_MEMORY_MAX: MEMORY_STEP_MAX, PROMPTCUT_RENDER_MEMORY_HIGH: MEMORY_STEP_MAX });
  const since = () => supLogs.slice(mark);
  const t0 = Date.now();
  let degraded = false;
  try {
    await waitFor(() => since().some((l) => l.event === 'render.degraded'), 240_000, '三次超限后并发降级', 500);
    degraded = true;
  } catch { degraded = false; }
  const exceeded = since().filter((l) => l.event === 'render.memory-exceeded');
  const oomExits = since().filter((l) => l.event === 'worker.exit' && l.reason === 'oom');
  const restarts = since().filter((l) => l.event === 'worker.restart-in').map((l) => l.ms);
  r.memory = { max: MEMORY_STEP_MAX, exceeded: exceeded.length, firstRss: exceeded[0]?.workerRss ?? null, oomExits: oomExits.length, restartBackoffMs: restarts.slice(0, 4), degraded, ms: Date.now() - t0 };
  check(exceeded.length >= 1 && oomExits.length >= 1, 'limits:超过内存硬上限时工作进程被结束(reason: oom)', r.memory);
  check(restarts.length >= 1 && restarts[0] >= 1000, 'limits:按退避重起', restarts);
  check(degraded, 'limits:10 分钟内第 3 次超限,并发降到 1', r.memory);
  const s = await status().catch(() => null);
  r.memory.statusDegraded = s?.degraded ?? null;
  r.memory.docserviceOk = (await fetch(`${DOC_HTTP}/healthz`).then((x) => x.ok).catch(() => false));
  check(r.memory.docserviceOk, 'limits:期间文档服务不受影响', {});
  // 换回正常上限
  await stopSupervisor();
  startSupervisor();
  await waitReady(300_000);
  await waitJoined(ctx.proj.projectId, 60_000);
  return r;
}

async function healthSamples(n, gapMs = 100) {
  const xs = [];
  for (let i = 0; i < n; i += 1) {
    const t = performance.now();
    try { const res = await fetch(`${DOC_HTTP}/healthz`, { signal: AbortSignal.timeout(5000) }); await res.arrayBuffer(); xs.push(performance.now() - t); } catch { xs.push(5000); }
    await delay(gapMs);
  }
  return xs;
}
const summarize = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: Math.round(s.at(-1) * 10) / 10 };
};

async function stepLoad() {
  const r = {};
  r.idle = summarize(await healthSamples(40));
  const project = probeProject(`${RUN}-${++ctx.salt}`, 4);
  const rev = await putProject(ctx.creator, project);
  const planId = await publishPlan(ctx.creator, { rev, clips: clipIdsOf(project), codeVersion: ctx.codeVersion });
  const busy = [];
  let sampling = true;
  const sampler = (async () => { while (sampling) busy.push(...await healthSamples(5)); })();
  const done = await waitRendered(ctx.proj.projectId, rev, planId, 300_000);
  sampling = false;
  await sampler;
  r.rendering = summarize(busy);
  r.renderMs = done.ms;
  r.tasks = done.tasks;
  check(busy.length >= 5, 'load:渲染期间采到了样本', { n: busy.length });
  check(r.rendering.p95 < 500, 'load:满载时文档服务自检的 p95 低于背压线 500 ms', r.rendering);
  r.backpressure = (await status()).backpressure;
  ctx.rev = rev;
  return r;
}

async function stepDelete() {
  const r = {};
  const del = await adminOp(ctx.creator, ctx.proj, 'delete');
  check(del.type === 'shared.admin.ok', 'delete:删项目', del);
  const t0 = Date.now();
  await waitLeft(ctx.proj.projectId, 10_000);
  r.leftMs = Date.now() - t0;
  check(r.leftMs <= 5000, 'delete:删项目后 5 s 内断开', { leftMs: r.leftMs });
  const s = await waitFor(async () => { const x = await status(); return x.directory.list.some((p) => p.projectId === ctx.proj.projectId) ? null : x; }, 5000, '目录里没有这个项目');
  r.directoryProjects = s.directory.list.length;
  return r;
}

const RUNNERS = { work: stepWork, late: stepLate, forbidden: stepForbidden, switch: stepSwitch, kill: stepKill, limits: stepLimits, load: stepLoad, delete: stepDelete };

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  for (const s of STEPS) if (!RUNNERS[s]) { console.error(`不认识的步骤 ${s}(可选:${ALL_STEPS.join(',')})`); process.exit(2); }
  fs.mkdirSync(HOSTED_DATA, { recursive: true });
  say('start', { tmp: TMP, ports: PORTS, steps: STEPS });
  combo = await startHostedCombo({
    dataDir: HOSTED_DATA, docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    // 与云节点同样的配置:本机信任关着(回环不算本机),所以成员与服务都得交凭证
    trustLoopback: false, clusterToken: randomBytes(32).toString('base64url'),
    assetPublicUrl: `http://127.0.0.1:${PORTS.asset}/api/asset`,
    log: (event, fields) => { if (VERBOSE || /error|reject|revoked/.test(event)) say(`hosted.${event}`, fields); },
  });
  const gen = runKeygen(['--hosted-data', HOSTED_DATA, '--secrets', RENDER_SECRETS, '--instance-name', '托管方的渲染节点(探针)']);
  say('keygen', { kid: gen.kid, registry: path.relative(TMP, gen.registry) });
  check(fs.existsSync(hostedPaths(HOSTED_DATA).servicesFile), 'setup:登记表在托管数据目录里');

  startSupervisor();
  let ready;
  try {
    ready = await Promise.race([waitReady(), supervisor.exited.then((code) => { throw new Error(`渲染服务退出了(退出码 ${code})`); })]);
  } catch (err) {
    out.selfcheck = supLogs.filter((l) => /^selfcheck/.test(l.event));
    throw err;
  }
  ctx.codeVersion = ready.queue.codeVersion;
  out.envFingerprint = ready.queue.envFingerprint;
  out.codeVersion = String(ctx.codeVersion).slice(0, 12);
  out.selfcheck = { warnings: ready.selfcheck.warnings.map((w) => w.reason), ...ready.selfcheck.info };
  out.limits = ready.limits;
  out.capabilities = ready.queue.capabilities ?? null;
  say('ready', { envFingerprint: out.envFingerprint, codeVersion: out.codeVersion, selfcheck: out.selfcheck, workerMode: ready.worker.mode });
  check(ready.queue.nodes.length === 0, 'setup:没有项目时渲染服务一个连接也不开', ready.queue.nodes.length);

  for (const name of STEPS) {
    if (name !== 'work' && !ctx.proj) { fails.push(`${name}:要先跑 work`); continue; }
    const before = fails.length;
    const t0 = Date.now();
    say('step', { name });
    try {
      out.steps[name] = { ok: true, ...(await RUNNERS[name]()), ms: Date.now() - t0 };
    } catch (err) {
      fails.push(`${name}:${String(err?.message ?? err)}`);
      out.steps[name] = { ok: false, error: String(err?.message ?? err), ms: Date.now() - t0 };
    }
    if (fails.length > before) out.steps[name].ok = false;
    say('step-done', { name, ...out.steps[name] });
  }
}

let exitCode = 1;
try {
  await main();
  out.ok = fails.length === 0;
  exitCode = out.ok ? 0 : 1;
} catch (err) {
  fails.push(`起不来:${String(err?.message ?? err)}`);
  exitCode = 2;
} finally {
  try { ctx.creator?.close(); } catch { /* 已关 */ }
  try { await stopSupervisor(); } catch { /* 已停 */ }
  try { await combo?.close(); } catch { /* 已关 */ }
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* 有文件还被占着,留给系统清 */ } }
  else out.tmp = TMP;
}
out.fails = fails;
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(exitCode);
