#!/usr/bin/env node
/**
 * 托管方渲染服务「云端排队」的验收探针（0.7.18 第 3 项里「云端一次只有一个活跃项目并排队」那一半；验收映射 RS18-queue，
 * `docs/plan/account-binding-task.md`「新增验收映射」里不依赖本地节点的各条）。用断言，不靠推断。
 *
 *   node scripts/probes/hosted-render-queue-probe.mjs [--base-port 28100] [--doc-port 28110] [--asset-port 28111]
 *        [--idle-ms 300000] [--keep-temp] [--verbose] [--mem-low 256M] [--time-scale 1] [--skip-retry]
 *
 * 端口（都只绑 127.0.0.1）：`--base-port` +0/+1/+2 常驻工作进程、+3/+4/+5 隔离工作进程、+6 管理进程的诊断与代理口；
 * `--doc-port` / `--asset-port` 本机隔离的托管组合。全部数据在一个临时目录里，结束时删掉。不连任何远端、不连节点。
 * `--idle-ms`：隔离工作进程空闲多久才让位。**缺省就是生产的五分钟**（整趟约十几分钟）；调试时可以给小的（如 20000），那样验的是
 * 「满了配置的时长才让位」这条判据，不是五分钟这个数。
 *
 * # 布置
 *
 * 本机隔离的托管组合 + 渲染服务（管理进程、常驻工作进程、隔离工作进程）。三个项目甲、乙、丙，**都带用户卡**（一张把舞台涂成一种颜色的卡，
 * 三个项目颜色不同：拿回来的图中心是什么颜色，就知道渲的是哪个项目）。探针持一把登记过的 agent 服务私钥，用 Agent 服务真正用的那个
 * 客户端（`server/agent-service/look-client.mjs`）要画面。
 *
 * # 验收（每条一行「过 / 不过」；stdout 最后一行是 JSON `{ ok, pass, fails, checks, timings, … }`；退出码 0 过、1 不过、2 起不来）
 *
 * Q1 单活跃项目、排队不拒
 *   Q1a 甲要一帧：隔离工作进程为它起来、出图（颜色是甲的）。
 *   Q1b 甲装着时乙要一帧：不被拒、没有「忙 / 已满」，登记在队列里等着（状态口：排着 1 个，原因是「隔离工作进程装着别的项目」）；
 *       整个等待期间隔离工作进程装着的始终只有甲一个项目，乙的内容没有被转给任何工作进程。
 *   Q1c 乙排着时甲再要一帧：照常出（排在前面的乙不挡它）。
 *   Q1d 撤回：乙另一条请求登记后被调用方撤回，队列里不留它，原来那条还排着。
 * Q2 看画面优先于预渲染任务：丙先发了预渲染计划在等，乙后来才要看画面；甲让位后下一轮装的是乙（不是先来的丙）。
 * Q3 让位要满时长：从甲最后一次出图算起，不到 `--idle-ms` 不让位（乙在排队、丙有任务等着也一样）；到了才结束，结束原因是空闲。
 * Q4 轮到了照常出图：乙的那一帧在甲让位后出来，颜色是乙的；由隔离工作进程出；调用方从头到尾只是在等，没有收到任何错误。
 * Q5 重启后排着的请求还在
 *   Q5a 乙装着时甲又要一帧（排着）；这时把管理进程连同工作进程整棵树强行结束（不走收尾）。盘上队列目录里留着这条请求。
 *   Q5b 再起管理进程，这次把背压的可用内存线调到机器够不着的高度（模拟内存吃紧）：它把那条请求接回队列（状态口：接回 1 条），
 *       因背压排着（原因记的是背压），不回「忙」，也不为它新起隔离工作进程；调用方那一侧只是连不上了一阵、接着在问。
 *   Q5c 正常收尾这个管理进程、按正常的线再起：请求第二次接回来，隔离工作进程为甲起来，出图（颜色是甲的）。调用方拿到了图。
 * Q6 预渲染任务不丢：丙的计划一直在文档服务的队列里；看画面的都做完、装着的项目闲满时长让位后，隔离工作进程为丙起来把它做完。
 * Q7 重试到头的结局（`--skip-retry` 跳过）：把「渲染这一段每次最多等多久」调成 1 毫秒重起管理进程，再要一帧：每次都到时限，
 *     试 1 + 3 次后调用方收到明确的「这次没看成」，不挂着；日志里有三次重试。
 * Q8 收尾：探针起的进程都没了，端口都放了。
 *
 * 没有在这支探针里验的（单测 `server/test/hosted-render-queue.test.mjs` 里有）：产物到了容量上限（素材服务回 507）时排着等；
 * 落盘失败时退回只在内存里排；调用方很久没来问的请求被撤掉；隔离工作进程起不来时的重试。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import：不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startHostedCombo, hostedPaths } from '../../server/hosted/combo.mjs';
import { runKeygen } from '../../server/hosted-render/keygen.mjs';
import { killTree } from '../../server/hosted-render/worker.mjs';
import { createSharedProject, buildAuthProtocols } from '../../server/auth/client.mjs';
import { readServiceKeyFile } from '../../server/auth/service-identity.mjs';
import { clipsPlanTaskOf } from '../../server/render-queue/messages.mjs';
import { LOOK_ERRORS } from '../../server/hosted-render/look.mjs';
import { createLookClient } from '../../server/agent-service/look-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const flag = (name) => argv.includes(name);
const BASE = Number(arg('--base-port', 28100));
const PORTS = { worker: BASE, iso: BASE + 3, status: BASE + 6, doc: Number(arg('--doc-port', BASE + 10)), asset: Number(arg('--asset-port', BASE + 11)) };
const KEEP = flag('--keep-temp');
const VERBOSE = flag('--verbose');
const MEM_LOW = String(arg('--mem-low', '256M'));
const IDLE_MS = Number(arg('--idle-ms', 300_000));
const CORES = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const SCALE = Number(arg('--time-scale', CORES <= 4 ? 2 : 1)) || 1;
const T = (ms) => Math.round(ms * SCALE);
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-render-queue-'));
const DOC_WS = `ws://127.0.0.1:${PORTS.doc}`;
const STATUS = `http://127.0.0.1:${PORTS.status}`;
const HOSTED_DATA = path.join(TMP, 'hosted');
const RENDER_SECRETS = path.join(TMP, 'render-secrets');
const RENDER_DATA = path.join(TMP, 'render');
const QUEUE_DIR = path.join(RENDER_DATA, 'look-queue');
const AGENT_SECRETS = path.join(TMP, 'agent-secrets');
const CARD_KEY = 'src/cards/user/look-solid.tsx';
const CARD_SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'probes', 'fixtures', 'cloud-look', 'look-solid.tsx'), 'utf8').replace(/\r\n/g, '\n');

/* ------------------------------------------------------------------ 记分 */
const fails = [];
const checks = [];
const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s === undefined ? '' : (s.length > 420 ? `${s.slice(0, 420)}…` : s); };
const check = (id, label, ok, detail) => {
  console.log(`${ok ? '  过' : '不过'}  ${id} ${label}${detail === undefined || detail === '' ? '' : `  〔${short(detail)}〕`}`);
  checks.push({ id, ok: !!ok, label, ...(detail === undefined ? {} : { detail: short(detail) }) });
  if (!ok) fails.push(`${id} ${label}`);
  return !!ok;
};
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
async function waitFor(fn, ms, what, every = 250) {
  const until = Date.now() + T(ms);
  for (;;) {
    let last = null;
    try { last = await fn(); } catch (err) { if (VERBOSE) say('wait-error', { what, message: String(err?.message ?? err) }); }
    if (last) return last;
    if (Date.now() > until) throw new Error(`等「${what}」超时（${T(ms)} ms）`);
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
  const c = {
    ws, opened,
    send: (m) => ws.send(JSON.stringify(m)),
    next(match, ms = 15_000) {
      const hit = all.find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('等消息超时')); } }, T(ms)).unref?.();
      });
    },
    async ask(message, ms = 15_000) {
      const reqId = `rq-${++reqSeq}`;
      c.send({ ...message, reqId });
      return c.next((m) => m?.reqId === reqId, ms);
    },
    close() { try { ws.close(); } catch { /* 已关 */ } },
  };
  return c;
}
async function makeProject(label, creator, slug, color, rgb) {
  const creatorPassword = `c-${randomBytes(9).toString('base64url')}`;
  const password = `p-${randomBytes(9).toString('base64url')}`;
  const made = await createSharedProject({ base: DOC_WS, name: `queue-${slug}-${RUN}`, mode: 'free', creator: { username: creator, password: creatorPassword }, password });
  const proj = { label, projectId: made.projectId, slug, docId: `queue-probe-${slug}`, color, rgb };
  const protocols = await buildAuthProtocols({
    base: DOC_WS, projectId: proj.projectId, username: creator, deviceId: `rq-${RUN}-${creator}`.padEnd(20, '0').slice(0, 48), deviceName: creator, as: 'creator', password: creatorPassword, role: 'page',
  });
  proj.conn = connect(protocols);
  await proj.conn.opened;
  const put = await proj.conn.ask({ type: 'content.put', kind: 'card-source', key: CARD_KEY, body: CARD_SOURCE });
  if (put.type !== 'content.stored') throw new Error(`content.put：${JSON.stringify(put).slice(0, 200)}`);
  proj.project = {
    id: proj.docId, name: `排队探针 · 项目${label}`, width: 1920, height: 1080, fps: 30, duration: 2,
    themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
    tracks: [{ id: 'tr-0', name: 'tr-0', hidden: false, clips: [{ id: 'clip-solid', kind: 'card', cardId: 'look-solid', start: 0, end: 2, params: { color } }] }],
  };
  const r = await proj.conn.ask({ type: 'project.op', projectId: proj.docId, opId: `op-${RUN}-${++reqSeq}`, session: `s-${RUN}-${slug}`, ops: [{ op: 'set', path: '', value: proj.project }] }, 20_000);
  if (r.type !== 'project.op.ok') throw new Error(`project.op 被拒：${JSON.stringify(r).slice(0, 300)}`);
  proj.rev = r.rev;
  return proj;
}
function queueTasks(projectId) {
  for (const d of Object.values(combo.service.describe().modules ?? {})) {
    const tasks = d?.spaces?.[projectId]?.tasks;
    if (Array.isArray(tasks)) return tasks;
  }
  return [];
}

/* ------------------------------------------------------------------ 托管组合与渲染服务 */
let combo = null;
let supervisor = null;
const supLogs = [];
function startSupervisor(extraEnv = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^PROMPTCUT_RENDER_/.test(k) && k !== 'PROMPTCUT_RENDER_SKIP_CHECKS') delete env[k];
  Object.assign(env, {
    PROMPTCUT_RENDER_DOC_URL: DOC_WS,
    PROMPTCUT_RENDER_SECRETS: RENDER_SECRETS,
    PROMPTCUT_RENDER_DATA: RENDER_DATA,
    PROMPTCUT_RENDER_PORT: String(PORTS.worker),
    PROMPTCUT_RENDER_ISO_PORT: String(PORTS.iso),
    PROMPTCUT_RENDER_STATUS_PORT: String(PORTS.status),
    PROMPTCUT_RENDER_MAX_CONCURRENT: '2',
    PROMPTCUT_RENDER_SAMPLE_MS: '2000',
    PROMPTCUT_RENDER_MEM_LOW: MEM_LOW,
    PROMPTCUT_RENDER_EDITOR_DIR: path.join(TMP, 'no-editor'),
    PROMPTCUT_RENDER_LOOK_SERVICES: hostedPaths(HOSTED_DATA).servicesFile,
    PROMPTCUT_RENDER_ISO_IDLE_MS: String(IDLE_MS),
    PROMPTCUT_NO_PORT_FILE: '1',
    ...extraEnv,
  });
  if (!env.PROMPTCUT_TEST_ENV_FINGERPRINT && process.platform === 'win32') env.PROMPTCUT_TEST_ENV_FINGERPRINT = '7e57c10d00000002';
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'hosted-render', 'main.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let tail = '';
  const take = (chunk) => {
    const lines = (tail + chunk.toString()).split('\n');
    tail = lines.pop() ?? '';
    for (const line of lines) {
      let j = null;
      try { j = JSON.parse(line); } catch { /* 不是 JSON 的行 */ }
      if (j) supLogs.push(j); else if (line.trim()) supLogs.push({ event: 'raw', line });
      if (VERBOSE || (j && /^(look\.|isolation\.(start|ready|stop|ended|rotate)|render\.backpressure|listen|stop)/.test(j.event))) process.stderr.write(`[render] ${line.slice(0, 400)}\n`);
    }
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  supervisor = { child, exited: new Promise((resolve) => child.once('exit', (code) => resolve(code))) };
}
async function stopSupervisor({ hard = false } = {}) {
  const s = supervisor;
  if (!s || s.child.exitCode !== null) return;
  if (hard) { killTree(s.child.pid); await Promise.race([s.exited, delay(15_000)]); return; }
  try { if (s.child.connected) s.child.send({ type: 'shutdown' }); else s.child.kill('SIGTERM'); } catch { /* 已经没了 */ }
  const done = await Promise.race([s.exited.then(() => true), delay(60_000).then(() => false)]);
  if (!done) killTree(s.child.pid);
}
const waitReady = (what, need = (s) => s.directory?.connected && s.worker?.ready && s.queue) => Promise.race([
  waitFor(async () => { const s = await status(); return need(s) ? s : null; }, 300_000, what, 1000),
  supervisor.exited.then((code) => { throw new Error(`渲染服务退出了（退出码 ${code}）`); }),
]);
const portFree = (port) => new Promise((resolve) => { const s = http.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });

/* ------------------------------------------------------------------ 看画面 */
const timings = [];
let client = null;
const clientLogs = [];
/** 以 Agent 服务的身份为这个项目要一帧；回 `{ ok, rgb, ms }` 或 `{ error }`，不抛 */
function look(proj, label, { signal } = {}) {
  const started = Date.now();
  const post = client.forProject(proj.projectId, { cards: () => ({ [CARD_KEY]: null }) });
  const rec = { label, project: proj.label, started, done: false };
  rec.promise = post('/api/vision/snapshot', { project: proj.project, t: 1 }, { signal }).then((data) => {
    let rgb = null;
    try {
      const png = PNG.sync.read(Buffer.from(data.__image.base64, 'base64'));
      const i = (Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4;
      rgb = [png.data[i], png.data[i + 1], png.data[i + 2]];
    } catch { rgb = null; }
    return { ok: data?.ok === true, rgb, note: data?.note ?? null };
  }, (err) => ({ error: String(err?.message ?? err) })).then((out) => {
    Object.assign(rec, out, { done: true, ms: Date.now() - started });
    timings.push({ label, project: proj.label, ms: rec.ms, ok: rec.ok === true, over5min: rec.ms > 5 * 60_000, ...(rec.error ? { error: rec.error.slice(0, 60) } : {}) });
    say('look.result', { label, project: proj.label, ms: rec.ms, ok: rec.ok === true, rgb: rec.rgb, error: rec.error });
    return rec;
  });
  return rec;
}
const near = (rgb, want) => Array.isArray(rgb) && rgb.every((v, i) => Math.abs(v - want[i]) <= 8);
/** 一边等一边记：隔离工作进程每一拍装着的是谁 */
const seen = [];
let watcher = null;
function watch() {
  watcher = setInterval(async () => {
    try {
      const s = await status();
      seen.push({ at: Date.now(), cur: s.isolation?.current?.projectId ?? null, phase: s.isolation?.current?.phase ?? null, listed: (s.isolation?.queue?.nodes ?? []).map((n) => n.projectId), queued: s.look?.queue?.queued ?? null, blocked: s.look?.queue?.blocked ?? null, waiting: s.isolation?.waiting ?? [] });
    } catch { /* 这一拍没问到（管理进程在重启） */ }
  }, 500);
}

const out = { ok: false, run: RUN, platform: process.platform, cores: CORES, timeScale: SCALE, ports: PORTS, idleMs: IDLE_MS, realIdle: IDLE_MS === 300_000 };

async function main() {
  for (const d of [HOSTED_DATA, RENDER_DATA]) fs.mkdirSync(d, { recursive: true });
  say('start', { tmp: TMP, ports: PORTS, idleMs: IDLE_MS });
  combo = await startHostedCombo({
    dataDir: HOSTED_DATA, docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    trustLoopback: false, clusterToken: randomBytes(32).toString('base64url'),
    assetPublicUrl: `http://127.0.0.1:${PORTS.asset}/api/asset`,
    log: (event, fields) => { if (VERBOSE || /error|reject|revoked/.test(event)) say(`hosted.${event}`, fields); },
  });
  runKeygen(['--hosted-data', HOSTED_DATA, '--secrets', RENDER_SECRETS, '--instance-name', '托管方的渲染节点（排队探针）']);
  runKeygen(['--hosted-data', HOSTED_DATA, '--secrets', AGENT_SECRETS, '--service', 'agent', '--instance-name', '云端 Agent（排队探针扮演）']);
  client = createLookClient({ url: STATUS, key: readServiceKeyFile(AGENT_SECRETS), log: (event, fields) => { clientLogs.push({ event, ...fields }); if (VERBOSE) say(event, fields); } });

  startSupervisor();
  const ready = await waitReady('渲染服务就绪');
  const codeVersion = ready.queue.codeVersion;
  say('ready', { codeVersion: String(codeVersion).slice(0, 12), isolation: ready.isolation?.enabled });

  const jia = await makeProject('甲', 'alice', 'jia', '#ff0000', [255, 0, 0]);
  const yi = await makeProject('乙', 'bob', 'yi', '#00ff00', [0, 255, 0]);
  const bing = await makeProject('丙', 'carol', 'bing', '#0000ff', [0, 0, 255]);
  const nameOf = (id) => [jia, yi, bing].find((p) => p.projectId === id)?.label ?? (id ? '别的' : null);
  await waitFor(async () => { const s = await status(); return [jia, yi, bing].every((p) => (s.queue?.nodes ?? []).some((n) => n.projectId === p.projectId)) ? s : null; }, 60_000, '常驻工作进程连上三个项目', 500);
  watch();

  /* ---- Q1a 甲要一帧 */
  const a1 = await look(jia, '甲-1').promise;
  const s1 = await status();
  check('Q1a', '甲要一帧：隔离工作进程为它起来、出图，颜色是甲的', a1.ok === true && near(a1.rgb, jia.rgb) && s1.isolation?.current?.projectId === jia.projectId && (s1.look?.byWorker?.isolated ?? 0) === 1 && (s1.look?.byWorker?.resident ?? 0) === 0,
    { ms: a1.ms, rgb: a1.rgb, error: a1.error, iso: nameOf(s1.isolation?.current?.projectId), byWorker: s1.look?.byWorker });

  /* ---- Q2 的布置：丙先发预渲染计划（带用户卡，要隔离工作进程做），在等 */
  const hello = await bing.conn.ask({ type: 'publisher.hello', publisherId: `rq-pub-${RUN}` });
  if (hello.type !== 'publisher.welcome') throw new Error(`publisher.hello：${JSON.stringify(hello).slice(0, 200)}`);
  const plan = clipsPlanTaskOf({ projectId: bing.docId, projectRev: bing.rev, clips: ['clip-solid'], codeVersion });
  const pub = await bing.conn.ask({ type: 'task.publish', tasks: [plan] });
  if (pub.type !== 'task.published') throw new Error(`task.publish：${JSON.stringify(pub).slice(0, 300)}`);
  const bingPublishedAt = Date.now();
  await waitFor(async () => ((await status()).isolation?.waiting ?? []).includes(bing.projectId), 30_000, '丙的预渲染任务进了等的名单', 500);

  /* ---- Q1b 甲装着时乙要一帧：排着 */
  const markB = seen.length;
  const b1 = look(yi, '乙-1');
  const yiQueuedAt = Date.now();
  const sB = await waitFor(async () => { const s = await status(); return s.look?.queue?.queued === 1 && s.look.queue.blocked?.['iso-other-project'] === 1 ? s : null; }, 20_000, '乙的请求排进队列', 300).catch(() => null);
  await delay(3000);
  const sB2 = await status();
  check('Q1b', '甲装着时乙要一帧：不被拒，登记在队列里等着（排着 1 个，原因是隔离工作进程装着别的项目）；调用方没有收到任何错误', !!sB && b1.done === false && sB2.look?.queue?.queued === 1 && sB2.isolation?.current?.projectId === jia.projectId && (sB2.look?.refused ?? 0) === 0 && (sB2.look?.failed ?? 0) === 0,
    { queued: sB2.look?.queue?.queued, blocked: sB2.look?.queue?.blocked, iso: nameOf(sB2.isolation?.current?.projectId), refused: sB2.look?.refused, failed: sB2.look?.failed, clientDone: b1.done, clientError: b1.error });

  /* ---- Q1c 乙排着时甲再要一帧 */
  const a2 = await look(jia, '甲-2').promise;
  const jiaLastAt = Date.now();
  check('Q1c', '乙排着时甲再要一帧：照常出（排在前面的乙不挡它），乙还排着', a2.ok === true && near(a2.rgb, jia.rgb) && b1.done === false, { ms: a2.ms, rgb: a2.rgb, error: a2.error, yiDone: b1.done });

  /* ---- Q1d 撤回 */
  const ac = new AbortController();
  const b2 = look(yi, '乙-撤回', { signal: ac.signal });
  await waitFor(async () => ((await status()).look?.queue?.queued === 2), 15_000, '乙的第二条请求排进队列', 200).catch(() => null);
  const sD0 = await status();
  ac.abort(new Error('调用方这一轮被停掉'));
  await b2.promise;
  const sD = await waitFor(async () => { const s = await status(); return s.look?.queue?.queued === 1 ? s : null; }, 15_000, '撤回后队列里只剩一条', 200).catch(() => null);
  check('Q1d', '撤回：乙另一条请求登记后被调用方撤回，队列里不留它，原来那条还排着', sD0.look?.queue?.queued === 2 && !!sD && (sD.look?.queue?.cancelled ?? 0) === 1 && b1.done === false && !!b2.error,
    { before: sD0.look?.queue?.queued, after: sD?.look?.queue?.queued, cancelled: sD?.look?.queue?.cancelled });

  /* ---- Q3 / Q2 / Q4：等甲让位 */
  say('wait-yield', { idleMs: IDLE_MS });
  const b1r = await Promise.race([b1.promise, delay(IDLE_MS + T(300_000)).then(() => null)]);
  const yiDoneAt = Date.now();
  const window1 = seen.slice(markB).filter((x) => x.at <= yiDoneAt);
  const jiaEnded = supLogs.filter((l) => l.event === 'isolation.ended' && l.projectId === jia.projectId).at(-1) ?? null;
  const jiaStop = supLogs.filter((l) => l.event === 'isolation.stop' && l.projectId === jia.projectId).at(-1) ?? null;
  const jiaStopAt = jiaStop ? Date.parse(jiaStop.t) : null;
  const heldFor = jiaStopAt ? jiaStopAt - jiaLastAt : null;
  const startsAfter = supLogs.filter((l) => l.event === 'isolation.start' && Date.parse(l.t) >= (jiaStopAt ?? Infinity)).map((l) => nameOf(l.projectId));
  // 等待期间：装着的始终只有甲；工作进程的清单里从来没有同时出现两个项目
  const curs = [...new Set(window1.filter((x) => x.at < (jiaStopAt ?? yiDoneAt)).map((x) => nameOf(x.cur)))];
  const multi = seen.filter((x) => new Set(x.listed).size > 1).length;
  check('Q1b', '乙等着的整个期间隔离工作进程装着的始终只有甲一个项目（任何一拍都没有同时装两个）', curs.length === 1 && curs[0] === '甲' && multi === 0, { curs, ticks: window1.length, multiProjectTicks: multi });
  check('Q3', `让位要满时长：从甲最后一次出图算起满 ${IDLE_MS} ms 才让位（乙在排队、丙有预渲染任务等着也不提前）；结束原因是空闲`, heldFor !== null && heldFor >= IDLE_MS && heldFor <= IDLE_MS + T(45_000) && jiaEnded?.reason === 'idle',
    { heldForMs: heldFor, idleMs: IDLE_MS, reason: jiaEnded?.reason, yiWaitedMs: (jiaStopAt ?? 0) - yiQueuedAt, bingWaitedMs: (jiaStopAt ?? 0) - bingPublishedAt });
  check('Q2', '看画面优先于预渲染任务：丙先发了预渲染计划、乙后来才要看画面；甲让位后下一轮装的是乙，不是先来的丙', startsAfter[0] === '乙' && bingPublishedAt < yiQueuedAt, { startsAfterJia: startsAfter, bingBeforeYiMs: yiQueuedAt - bingPublishedAt });
  const sY = await status();
  const yiLog = supLogs.filter((l) => l.event === 'look.done' && l.projectId === yi.projectId && l.state === 'done').at(-1) ?? null;
  check('Q4', '轮到了照常出图：乙的那一帧在甲让位后出来，颜色是乙的，由隔离工作进程出；调用方从头到尾只是在等', b1r?.ok === true && near(b1r.rgb, yi.rgb) && yiLog?.worker === 'isolated' && yiLog.attempts === 0 && (sY.look?.failed ?? 0) === 0,
    { ms: b1r?.ms, rgb: b1r?.rgb, error: b1r?.error, queuedMs: yiLog?.queuedMs, worker: yiLog?.worker, attempts: yiLog?.attempts, failed: sY.look?.failed });

  /* ---- Q5 重启 */
  say('restart', {});
  const a3 = look(jia, '甲-3（跨两次重启）');
  await waitFor(async () => { const s = await status(); return s.look?.queue?.queued === 1 && s.isolation?.current?.projectId === yi.projectId ? s : null; }, 20_000, '甲的请求排进队列（乙装着）', 300);
  const onDisk0 = fs.readdirSync(QUEUE_DIR).filter((n) => n.endsWith('.req.json'));
  const bodyOnDisk = onDisk0.length === 1 ? JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, onDisk0[0]), 'utf8')) : null;
  await stopSupervisor({ hard: true });
  await delay(1500);
  const onDisk1 = fs.readdirSync(QUEUE_DIR).filter((n) => n.endsWith('.req.json'));
  check('Q5a', '乙装着时甲又要一帧（排着）；管理进程连同工作进程整棵树被强行结束后，盘上队列目录里留着这条请求（项目是甲的）', onDisk0.length === 1 && onDisk1.length === 1 && bodyOnDisk?.projectId === jia.projectId && bodyOnDisk?.body?.project?.id === jia.docId && a3.done === false,
    { before: onDisk0.length, after: onDisk1.length, projectOnDisk: nameOf(bodyOnDisk?.projectId), clientDone: a3.done });

  // 再起：背压的可用内存线调到够不着的高度（模拟内存吃紧）
  const markP = supLogs.length;
  startSupervisor({ PROMPTCUT_RENDER_MEM_LOW: '4096G' });
  await waitReady('渲染服务（内存吃紧）起来', (s) => s.directory?.connected && s.backpressure?.paused === true && s.look?.queue?.queued === 1);
  await delay(T(12_000));
  const sP = await status();
  const loaded1 = supLogs.slice(markP).find((l) => l.event === 'look.requests.loaded') ?? null;
  const startedWhilePaused = supLogs.slice(markP).filter((l) => l.event === 'isolation.start').length;
  check('Q5b', '再起的管理进程把那条请求接回队列；内存吃紧（背压暂停）时它排着等、原因记的是背压，不回忙、不为它新起隔离工作进程；调用方只是在等', loaded1?.restored === 1 && sP.backpressure?.paused === true && sP.look?.queue?.queued === 1 && sP.look.queue.blocked?.backpressure === 1
    && (sP.look?.refused ?? 0) === 0 && (sP.look?.failed ?? 0) === 0 && startedWhilePaused === 0 && a3.done === false,
    { loaded: loaded1 && { restored: loaded1.restored, results: loaded1.results }, paused: sP.backpressure?.paused, reasons: sP.backpressure?.reasons, queue: { queued: sP.look?.queue?.queued, blocked: sP.look?.queue?.blocked }, isoStarts: startedWhilePaused, clientDone: a3.done, clientError: a3.error });

  // 正常收尾、按正常的线再起
  const markN = supLogs.length;
  await stopSupervisor();
  const onDisk2 = fs.readdirSync(QUEUE_DIR).filter((n) => n.endsWith('.req.json'));
  startSupervisor();
  await waitReady('渲染服务第二次重启后就绪');
  const a3r = await Promise.race([a3.promise, delay(T(300_000)).then(() => null)]);
  const loaded2 = supLogs.slice(markN).find((l) => l.event === 'look.requests.loaded') ?? null;
  const jiaLog = supLogs.slice(markN).filter((l) => l.event === 'look.done' && l.projectId === jia.projectId).at(-1) ?? null;
  const firstStart = supLogs.slice(markN).find((l) => l.event === 'isolation.start');
  const reconnects = clientLogs.filter((l) => l.event === 'agent.look.reconnected').length;
  check('Q5c', '正常收尾后再起：请求第二次接回来，隔离工作进程先为甲（要看画面的）起来、出图，颜色是甲的；调用方拿到了图，中间只是重连', onDisk2.length === 1 && loaded2?.restored === 1 && a3r?.ok === true && near(a3r.rgb, jia.rgb)
    && jiaLog?.restored === true && jiaLog.worker === 'isolated' && nameOf(firstStart?.projectId) === '甲' && reconnects >= 2,
    { onDiskAfterGracefulStop: onDisk2.length, loaded: loaded2 && { restored: loaded2.restored }, ms: a3r?.ms, rgb: a3r?.rgb, error: a3r?.error, restored: jiaLog?.restored, firstStart: nameOf(firstStart?.projectId), reconnects });
  const jiaLast2 = Date.now();

  /* ---- Q6 预渲染任务不丢 */
  say('wait-prerender', { idleMs: IDLE_MS });
  let bingDone = null;
  try {
    bingDone = await waitFor(() => {
      const tasks = queueTasks(bing.projectId);
      const p = tasks.find((t) => t.id === plan.id);
      const fine = tasks.filter((t) => !t.id.startsWith('plan:'));
      if (!p || p.state !== 'done' || fine.length === 0 || fine.some((t) => t.state === 'open' || t.state === 'claimed')) return null;
      return { tasks: fine.length, done: fine.filter((t) => t.state === 'done').length, failed: fine.filter((t) => t.state === 'failed').length };
    }, IDLE_MS + 420_000, '丙的计划与细任务做完', 500);
  } catch (err) { out.bingError = String(err?.message ?? err); }
  const bingStart = supLogs.filter((l) => l.event === 'isolation.start' && l.projectId === bing.projectId).at(-1) ?? null;
  const sBing = await status();
  const isoBing = (sBing.isolation?.queue?.nodes ?? []).find((n) => n.projectId === bing.projectId) ?? (sBing.isolation?.lastQueue?.nodes ?? []).find((n) => n.projectId === bing.projectId) ?? null;
  check('Q6', '预渲染任务不丢：丙的计划等过了三个看画面的项目轮次和两次重启；装着的项目闲满时长让位后，隔离工作进程为丙起来把它做完', !!bingDone && bingDone.failed === 0 && bingDone.done === bingDone.tasks && !!bingStart && Date.parse(bingStart.t) - jiaLast2 >= IDLE_MS && (isoBing?.completed ?? 0) >= 1,
    { ...bingDone, error: out.bingError, waitedMs: Date.now() - bingPublishedAt, startedAfterIdleMs: bingStart ? Date.parse(bingStart.t) - jiaLast2 : null, isoCompleted: isoBing?.completed });

  /* ---- Q7 重试到头 */
  if (!flag('--skip-retry')) {
    say('retry', {});
    const markR = supLogs.length;
    await stopSupervisor();
    startSupervisor({ PROMPTCUT_RENDER_LOOK_ATTEMPT_MS: '1' });
    await waitReady('渲染服务（每次只等 1 毫秒）就绪');
    const r = await Promise.race([look(bing, '丙-重试到头').promise, delay(T(300_000)).then(() => null)]);
    const retries = supLogs.slice(markR).filter((l) => l.event === 'look.retry');
    const doneR = supLogs.slice(markR).filter((l) => l.event === 'look.done').at(-1) ?? null;
    check('Q7', '重试到头：每次都到时限，试 1 + 3 次后调用方收到明确的「这次没看成」，不挂着；日志里有三次重试', r?.error === LOOK_ERRORS.timeout && retries.length === 3 && retries.every((x) => x.why === 'timeout') && doneR?.attempts === 4 && doneR.state === 'failed',
      { error: r?.error, ms: r?.ms, retries: retries.map((x) => x.why), attempts: doneR?.attempts, state: doneR?.state });
  }
  out.lookStatus = (({ served, failed, refused, retried, over5min, byWorker, queue }) => ({ served, failed, refused, retried, over5min, byWorker, queue }))((await status()).look ?? {});
}

let exitCode = 1;
try {
  await main();
  exitCode = 0;
} catch (err) {
  fails.push(`起不来或中途出错：${String(err?.stack ?? err?.message ?? err).slice(0, 600)}`);
  exitCode = 2;
} finally {
  if (watcher) clearInterval(watcher);
  try { await stopSupervisor(); } catch { /* 已停 */ }
  try { await combo?.close(); } catch { /* 已关 */ }
  await delay(1000);
  const busy = [];
  for (const port of [PORTS.worker, PORTS.worker + 1, PORTS.worker + 2, PORTS.iso, PORTS.iso + 1, PORTS.iso + 2, PORTS.status, PORTS.doc, PORTS.asset]) if (!(await portFree(port))) busy.push(port);
  check('Q8', '收尾：探针起的进程都没了，端口都放了', busy.length === 0 && supervisor?.child.exitCode !== null, { busyPorts: busy });
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* 有文件还被占着，留给系统清 */ } } else out.tmp = TMP;
}
if (exitCode === 0 && fails.length > 0) exitCode = 1;
out.ok = exitCode === 0;
out.pass = checks.filter((c) => c.ok).length;
out.fails = fails;
out.checks = checks;
// 端到端耗时：每一次看画面都列出来，超过五分钟的单独标（`render-scheduling-supplement.md` 第 4.1 节；只记录，不当通过条件）
out.timings = timings;
out.over5min = timings.filter((t) => t.over5min).map((t) => `${t.label} ${t.ms} ms`);
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(exitCode);
