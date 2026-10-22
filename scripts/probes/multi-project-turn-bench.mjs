#!/usr/bin/env node
/**
 * 多项目模式「一轮最多连做 K 个」的实测（主会话 2026-10-22：K 量出来定）。不是验收探针，只出数字。
 *
 *   node scripts/probes/multi-project-turn-bench.mjs --base-port 5880 --doc-port 5888 --asset-port 5889 [--turns 1,2,4,8] [--requests 6] [--time-scale 3]
 *
 * 本机隔离的托管组合 + 真的渲染服务（同 `hosted-render-queue-probe.mjs` 的布置）。两个都带用户卡的项目甲、乙。
 * 每个 K（`PROMPTCUT_RENDER_TURN`）重起一次管理进程，然后：
 *   1. 甲先登记 N 个看画面请求，紧接着乙登记 N 个（一个一个登记，渲染服务按收到的先后排）；
 *   2. 记每个请求从登记到出结果的时间、一共换了几次装、每次换装的时间（上一轮结束 → 下一轮就绪）、每个请求真正渲的时间；
 *   3. 「另一个项目要等多久」：乙的第一个请求从登记到出结果（甲那一轮先做，乙要等它做完再换装）。
 * stdout 最后一行是 JSON：每个 K 一行数字。退出码 0 跑完、2 起不来。
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-render-turn-'));
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
/** 状态口；机器满载时管理进程一时答得慢，按退避再问两次（暂时性故障不算结果） */
const status = async () => {
  for (let i = 0; ; i += 1) {
    try { return await (await fetch(`${STATUS}/status`, { signal: AbortSignal.timeout(T(5000)) })).json(); } catch (err) { if (i >= 2) throw err; await delay(1000 * (i + 1)); }
  }
};

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
    PROMPTCUT_RENDER_STREAMS: '1',
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
function look(proj, label, { signal, run } = {}) {
  const started = Date.now();
  const post = client.forProject(proj.projectId, { cards: () => ({ [CARD_KEY]: null }), ...(run ? { run } : {}) });
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

const TURNS = String(arg('--turns', '1,2,4,8')).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
const N = Number(arg('--requests', 6)) || 6;
const out = { run: RUN, platform: process.platform, cores: CORES, timeScale: SCALE, requestsPerProject: N, results: [] };

async function main() {
  for (const d of [HOSTED_DATA, RENDER_DATA]) fs.mkdirSync(d, { recursive: true });
  combo = await startHostedCombo({
    dataDir: HOSTED_DATA, docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    trustLoopback: false, clusterToken: randomBytes(32).toString('base64url'),
    assetPublicUrl: `http://127.0.0.1:${PORTS.asset}/api/asset`,
    log: (event, fields) => { if (VERBOSE || /error|reject|revoked/.test(event)) say(`hosted.${event}`, fields); },
  });
  runKeygen(['--hosted-data', HOSTED_DATA, '--secrets', RENDER_SECRETS, '--instance-name', '托管方的渲染节点（K 实测）']);
  runKeygen(['--hosted-data', HOSTED_DATA, '--secrets', AGENT_SECRETS, '--service', 'agent', '--instance-name', '云端 Agent（K 实测扮演）']);
  client = createLookClient({ url: STATUS, key: readServiceKeyFile(AGENT_SECRETS), log: (event, fields) => { clientLogs.push({ event, ...fields }); } });
  let jia = null, yi = null;
  for (const K of TURNS) {
    const mark = supLogs.length;
    startSupervisor({ PROMPTCUT_RENDER_TURN: String(K) });
    await waitReady(`渲染服务就绪（K=${K}）`);
    if (!jia) {
      jia = await makeProject('甲', 'alice', 'jia', '#ff0000', [255, 0, 0]);
      yi = await makeProject('乙', 'bob', 'yi', '#00ff00', [0, 255, 0]);
    }
    await waitFor(async () => { const s = await status(); return [jia, yi].every((p) => (s.queue?.nodes ?? []).some((n) => n.projectId === p.projectId)) ? s : null; }, 60_000, '常驻工作进程连上两个项目', 500);
    const reqs = [];
    const t0 = Date.now();
    for (const [proj, tag] of [...Array.from({ length: N }, (_, i) => [jia, `甲${i + 1}`]), ...Array.from({ length: N }, (_, i) => [yi, `乙${i + 1}`])]) {
      const before = supLogs.filter((l) => l.event === 'look.queued').length;
      const at = Date.now();
      const r = look(proj, tag);
      r.registeredAt = at;
      reqs.push(r);
      await waitFor(() => supLogs.filter((l) => l.event === 'look.queued').length > before, 20_000, `${tag} 登记`, 30);
    }
    const done = [];
    for (const r of reqs) done.push(await r.promise);
    const end = Date.now();
    const logs = supLogs.slice(mark);
    const starts = logs.filter((l) => l.event === 'isolation.start' && Date.parse(l.t) >= t0);
    const readies = logs.filter((l) => l.event === 'isolation.ready' && Date.parse(l.t) >= t0);
    const ended = logs.filter((l) => l.event === 'isolation.ended' && Date.parse(l.t) >= t0);
    // 一次换装：上一轮结束（ended） → 下一轮就绪（ready）
    const switches = [];
    for (const r of readies) {
      const prev = ended.filter((e) => Date.parse(e.t) <= Date.parse(r.t)).at(-1);
      if (prev) switches.push(Date.parse(r.t) - Date.parse(prev.t));
    }
    const lookDone = logs.filter((l) => l.event === 'look.done' && l.state === 'done' && Date.parse(l.t) >= t0);
    const renderMs = lookDone.map((l) => l.ms - l.queuedMs).filter((x) => Number.isFinite(x));
    const wait = (r) => (r.done ? r.started + r.ms - r.registeredAt : null);
    const yi1 = reqs.find((r) => r.label === '乙1');
    const order = [...done].sort((a, b) => (a.started + a.ms) - (b.started + b.ms)).map((r) => r.label);
    const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
    const row = {
      K, ok: done.every((r) => r.ok === true), makespanMs: end - t0, loads: starts.length, switchMs: switches, switchMedianMs: med(switches),
      renderMedianMs: med(renderMs), yiFirstWaitMs: wait(yi1), maxWaitMs: Math.max(...reqs.map(wait)), meanWaitMs: Math.round(reqs.reduce((n, r) => n + wait(r), 0) / reqs.length), order,
    };
    out.results.push(row);
    console.log(`[TURN] K=${K}：总用时 ${row.makespanMs} ms；装了 ${row.loads} 次；换装（上一轮结束→下一轮就绪）中位 ${row.switchMedianMs} ms ${JSON.stringify(switches)}；渲一帧中位 ${row.renderMedianMs} ms；乙的第一个等了 ${row.yiFirstWaitMs} ms；最长等 ${row.maxWaitMs} ms；平均等 ${row.meanWaitMs} ms；次序 ${order.join(' ')}`);
    await stopSupervisor();
  }
}

try {
  await main();
} catch (err) {
  out.error = String(err?.stack ?? err?.message ?? err).slice(0, 600);
} finally {
  try { await stopSupervisor(); } catch { /* 已停 */ }
  try { await combo?.close(); } catch { /* 已关 */ }
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* 留给系统清 */ } }
}
process.stdout.write(`${JSON.stringify(out)}
`);
process.exit(out.error ? 2 : 0);
