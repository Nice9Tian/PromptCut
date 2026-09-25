/**
 * 独立渲染主机的探针(M6b,契约 `docs/plan/render-host-contract.md` 第 5 节「探针」与 H 系列的判法)。
 *
 * 几个角色各是一个进程,经 `--state <目录>` 里的文件协调(缺省 `<系统临时目录>/pc-render-host-probe`)。
 * 每个角色最后一行打一行 JSON,`ok` 为假时退出码 1。
 *
 * ## --role creator
 *
 *   node scripts/probes/render-host-probe.mjs --role creator [--port 5400] [--state <目录>]
 *        [--rounds "r1:host-a,host-b;r2:host-c,host-bad"] [--hold-min 30] [--timeout-min 20]
 *
 *   1. 起一个编辑器(队列模式,`PROMPTCUT_QUEUE_NODE=1`,只绑回环):它挂着局域网模式的文档服务与素材服务,
 *      预渲染进程就是本机 PC 节点;
 *   2. 在本机文档服务上建一个自由进入的共享项目(本机回环才能建),写出配置文件:
 *      `creator.json`(本机 PC 节点以创建者身份进入,`role: 'render'`)、`host-a.json`、`host-b.json`、`host-c.json`
 *      (成员 `host-*`,口令对)、`host-bad.json`(口令错:没有这个项目的有效凭证);
 *      本机 PC 节点的 `PROMPTCUT_SHARED_CONFIG` 在编辑器起来时就指向 `creator.json`,预渲染进程第一次打 `/api/frames/*`
 *      (建完项目之后)才读它;
 *   3. 按 `--rounds` 一轮一轮来:等这一轮列出的主机都报「起来了」(`<名>.ready`),以本机节点身份发布一个项目的 `plan`
 *      (推镜像 → preload;每轮的卡片参数带不同的盐,结果键全新),等细任务全部落定、清单拉取完,写 `round-<轮>.json`;
 *   4. 全部轮次做完后保持(等 `<state>/stop` 或 `--hold-min` 到),供 `check`、`auth-check` 用,然后关编辑器。
 *
 * ## --role host
 *
 *   node scripts/probes/render-host-probe.mjs --role host --config <文件> --name host-a --round r1 [--port 5403]
 *        [--state <目录>] [--code-version <串>] [--expect-claims none] [--expect-handshake 401|101] [--timeout-min 20]
 *
 *   先用配置做一次原始握手记下状态码(`handshake`:101 或 401),再起 `scripts/render-host.mjs`(IPC 通道),
 *   起来后写 `<名>.ready`,等创建者写出 `round-<轮>.json`,读一次诊断,经 IPC 让它退出(让掉认领),记退出码。
 *   `--code-version` 设 `PROMPTCUT_TEST_CODE_VERSION`(测试开关:主机对外报的代码版本,H2 用)。
 *   输出 `{ ok, name, round, projectId, claimed, completed, dedup, seen, connected, opens, handshake, codeVersion, envFingerprint, exitCode, fails }`。
 *
 * ## --role check
 *
 *   node scripts/probes/render-host-probe.mjs --role check --round r1 [--port 5403] [--state <目录>] [--hosts host-a,host-b]
 *
 *   - 每个细任务恰好一次 `task.done`(本机 PC 节点作为发布方收到的次数):`duplicateDone`、`missingDone`;
 *   - 各节点完成数(完成 + 去重完成)之和等于任务数:本机 PC 按任务 id 数,主机取各自的结果文件;
 *   - 同指纹下与本机单机重渲逐帧比较:另起一个普通模式的编辑器(不走队列、空帧库),preload 同一份项目,
 *     逐个比较这一版的快照文件。`identical` 按「逐字节相同,或只差 `style` 属性里声明的先后」判
 *     (跨进程的声明顺序不确定,M5b 报告疑点 3,确定化排在 M6c;声明先后不影响像素),`identicalBytes` 是严格逐字节。
 *
 * ## --role auth-check
 *
 *   node scripts/probes/render-host-probe.mjs --role auth-check --config <文件> [--rate-limit]
 *
 *   用一份成员配置核对能跨机验的几项(H4、H7、H8 的一部分):错口令握手 401、对口令 101、`auth.ticket` 取素材票据、
 *   素材服务「不带票据」与「带票据」的读(非回环来源才要票据;本机跑时标 `loopback: true`,不带票据的那一项不判)。
 *   `--rate-limit`:同一来源连错 5 次后口令对也 401(本机回环不计数,只在别的机器上判)。
 *
 * 端口:编辑器另占「端口 +1」「端口 +2」当舞台端口。本机跑时 creator 5400、主机 5403 / 5406、check 5403(主机退出之后)。
 * 凭证只写在 state 目录的配置文件里,不打到输出里。
 */
import { spawn, fork } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const ROLE = arg('--role', null);
const STATE = path.resolve(arg('--state', path.join(os.tmpdir(), 'pc-render-host-probe')));
const TIMEOUT_MS = Number(arg('--timeout-min', 20)) * 60_000;
const FPS = 30;

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return cond; };

const json = async (url, init = {}) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
  const body = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, body };
};
const postJson = (url, body, timeoutMs) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs });

async function until(label, fn, timeoutMs = 120_000, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await delay(everyMs);
  }
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
};
const exists = (file) => fsSync.existsSync(file);

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}
function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGKILL');
}
const exited = (child, ms = 20_000) => new Promise((resolve) => {
  if (!child || child.exitCode !== null) return resolve(child?.exitCode ?? null);
  const t = setTimeout(() => resolve(null), ms);
  t.unref?.();
  child.once('exit', (code) => { clearTimeout(t); resolve(code); });
});
const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

/** 探针子进程的公共环境:不带集群令牌、不连外面的文档服务、临时目录放在这个实例自己的目录下(不写公共的 port.json) */
function baseEnv(dir, extra = {}) {
  const env = { ...process.env };
  for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_NODE_PROFILE', 'PROMPTCUT_SHARED_CONFIG',
    'PROMPTCUT_HOST_MAX_CONCURRENT', 'PROMPTCUT_TEST_CODE_VERSION', 'PROMPTCUT_PUSH', 'PROMPTCUT_HEADLESS', 'PROMPTCUT_ROLE', 'PROMPTCUT_ASSET_URL']) delete env[key];
  const tmp = path.join(dir, 'tmp');
  fsSync.mkdirSync(tmp, { recursive: true });
  fsSync.mkdirSync(path.join(dir, 'data'), { recursive: true });
  return { ...env, PROMPTCUT_EXPORT_DIR: dir, PROMPTCUT_DATA_DIR: path.join(dir, 'data'), PROMPTCUT_STREAMS: '0', TEMP: tmp, TMP: tmp, TMPDIR: tmp, ...extra };
}

/** 起一个编辑器,等它和预渲染进程都起来;回 { child, editor, prerender, log } */
async function startEditor(port, env, label) {
  for (const p of [port, port + 1, port + 2]) check(await portFree(p), `[${label}] 端口 ${p} 空着`);
  if (fails.length) return null;
  const child = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  const log = [];
  const keep = (c) => { log.push(c.toString()); if (log.length > 600) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const editor = `http://127.0.0.1:${port}`;
  const prerender = await until(`[${label}] 预渲染进程就绪`, async () => {
    const info = await json(`${editor}/api/prerender/info`, { timeoutMs: 3000 });
    return info.body?.ready && info.body.url ? info.body.url : null;
  }, 240_000);
  return { child, editor, prerender, log };
}

/* ------------------------------------------------------------------ 探针项目 */

/**
 * 3 秒 = 90 帧,同 queue-mode-probe:两张共享档卡各切两段、一张本地档卡一段。`salt` 写进两张卡的 params(内容键含 params),
 * 每轮结果键全新;`r6-stateful` 的内容键不含 params,同一空间里第二轮起按设计去重。
 */
function probeProject(salt) {
  return {
    id: 'render-host-probe', name: '独立渲染主机探针', width: 1920, height: 1080, fps: FPS, duration: 3,
    themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
    tracks: [
      { id: 'tr-1', name: 'tr-1', hidden: false, clips: [{ id: 'clip-stateful', kind: 'card', cardId: 'r6-stateful', start: 0, end: 3, params: {} }] },
      { id: 'tr-2', name: 'tr-2', hidden: false, clips: [{ id: 'clip-canvas', kind: 'card', cardId: 'r6-canvas', start: 0, end: 3, params: { probeSalt: salt } }] },
      { id: 'tr-3', name: 'tr-3', hidden: false, clips: [{ id: 'clip-unknown', kind: 'card', cardId: 'r6-unknown', start: 1, end: 3, params: { probeSalt: salt } }] },
    ],
  };
}

/** 推镜像 → preload(保活)直到 ready;回 { key, status, preloadMs } */
async function preloadProject({ editor, prerender }, session, project, label) {
  const pushed = await postJson(`${editor}/api/data/project`, { session, localRev: 1, project });
  check(pushed.ok, `[${label}] 项目推进镜像`, pushed.body);
  await until(`[${label}] 预渲染进程手里有这一版项目`, async () => (await json(`${prerender}/api/data/project?session=${session}&localRev=1`)).ok || null, 30_000);
  const started = Date.now();
  const first = await postJson(`${prerender}/api/frames/preload`, { session, localRev: 1 }, 120_000);
  check(first.ok, `[${label}] preload 开跑`, first.body);
  const ready = await until(`[${label}] 后台那一趟跑完`, async () => {
    const status = await postJson(`${prerender}/api/frames/preload`, { session, localRev: 1 }, 120_000);
    return status.body?.status === 'ready' || status.body?.status === 'error' ? status.body : null;
  }, TIMEOUT_MS, 2000);
  check(ready?.status === 'ready', `[${label}] 后台那一趟以 ready 结束`, ready);
  return { key: first.body?.key ?? null, status: ready?.status ?? null, preloadMs: Date.now() - started };
}

/* ================================================================== creator */

async function runCreator() {
  const port = Number(arg('--port', 5400));
  const holdMs = Number(arg('--hold-min', 30)) * 60_000;
  const rounds = String(arg('--rounds', 'r1:host-a,host-b')).split(';').filter(Boolean).map((part) => {
    const [name, hosts = ''] = part.split(':');
    return { name, hosts: hosts.split(',').filter(Boolean) };
  });
  const stamp = Date.now().toString(36);
  await fs.rm(STATE, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await fs.mkdir(STATE, { recursive: true });
  const dir = path.join(STATE, 'creator');
  const creatorConfig = path.join(STATE, 'creator.json');
  const env = baseEnv(dir, { PROMPTCUT_QUEUE_NODE: '1', PROMPTCUT_SHARED_CONFIG: creatorConfig });
  const out = { role: 'creator', port, state: STATE, rounds: [] };
  let started = null;
  try {
    started = await startEditor(port, env, 'creator');
    if (!started?.prerender) return out;
    const docUrl = `ws://127.0.0.1:${port}/docservice`;
    const { createSharedProject } = await import('../../server/auth/client.mjs');
    const secret = () => randomBytes(12).toString('base64url');
    const creatorPw = secret();
    const projectPw = secret();
    const project = await createSharedProject({ base: docUrl, name: `rhp-${stamp}`, mode: 'free', creator: { username: 'creator', password: creatorPw }, password: projectPw });
    out.projectId = project.projectId;
    const devId = (tag) => `rhp-${tag}-${stamp}`.replace(/[^A-Za-z0-9_-]/g, '-').padEnd(16, '0').slice(0, 64);
    const entry = (username, extra) => ({ url: docUrl, projectId: project.projectId, username, deviceId: devId(username), deviceName: `${username} (probe)`, as: 'member', role: 'render', password: projectPw, ...extra });
    await writeJson(creatorConfig, [entry('creator', { as: 'creator', password: creatorPw, deviceName: 'creator PC (probe)' })]);
    const configs = {};
    for (const name of ['host-a', 'host-b', 'host-c']) { configs[name] = path.join(STATE, `${name}.json`); await writeJson(configs[name], [entry(name)]); }
    configs['host-bad'] = path.join(STATE, 'host-bad.json');
    await writeJson(configs['host-bad'], [entry('host-bad', { password: `${projectPw}-wrong` })]);
    configs['member'] = path.join(STATE, 'member.json');
    await writeJson(configs.member, [entry('auth-probe', { role: 'page' })]);
    await writeJson(path.join(STATE, 'state.json'), { phase: 'waiting-hosts', port, editor: started.editor, prerender: started.prerender, projectId: project.projectId, docUrl, configs, stamp, library: path.join(dir, 'frame-library') });

    // 本机 PC 节点:第一次打 /api/frames/* 才建管线、读 creator.json、起节点
    const diagnostics = async () => (await json(`${started.prerender}/api/frames/diagnostics`)).body ?? {};
    const active = await until('[creator] 本机节点报到', async () => (await diagnostics()).queue?.active === true || null, 240_000, 1000);
    const d0 = await diagnostics();
    out.pc = { mode: d0.queue?.mode ?? null, nodeId: d0.queue?.nodeId ?? null, envFingerprint: d0.queue?.envFingerprint ?? null, codeVersion: d0.queue?.codeVersion ?? null };
    if (!active) { out.queueLog = started.log.join('').split('\n').filter((l) => l.includes('[queue-node]')).slice(-10); return out; }

    for (const round of rounds) {
      const r = { round: round.name, hosts: round.hosts };
      out.rounds.push(r);
      await writeJson(path.join(STATE, 'state.json'), { ...(await readJson(path.join(STATE, 'state.json'))), phase: `waiting-hosts:${round.name}` });
      const readyHosts = await until(`[creator] ${round.name} 的主机都起来了`, async () => round.hosts.every((h) => exists(path.join(STATE, `${h}.ready`))) || null, TIMEOUT_MS, 1000);
      if (!readyHosts) break;
      const before = await diagnostics();
      const publishedBefore = new Set((before.queue?.published ?? []).map((p) => p.planId));
      const appliedBefore = (before.queue?.stats?.applied ?? 0) + (before.queue?.stats?.applyErrors ?? 0);
      const projectJson = probeProject(`${round.name}-${stamp}`);
      const session = `rhp-${round.name}-${stamp}`;
      const pre = await preloadProject(started, session, projectJson, `creator:${round.name}`);
      Object.assign(r, { session, entryKey: pre.key, preloadMs: pre.preloadMs });
      const settled = await until(`[creator] ${round.name} 的 plan 切分完、细任务都落定`, async () => {
        const q = (await diagnostics()).queue;
        const mine = (q?.published ?? []).find((p) => !publishedBefore.has(p.planId));
        const derived = mine ? q.plans?.[mine.planId] : null;
        if (!Array.isArray(derived)) return null;
        const states = derived.map((id) => q.tasks?.[id]?.state ?? 'pending');
        return states.every((s) => s === 'done' || s === 'failed') ? { planId: mine.planId, derived, states, q } : null;
      }, TIMEOUT_MS, 2000);
      if (!settled) break;
      // task.done 的清单在后台串行拉取:等本轮的都拉完(或出错)
      await until(`[creator] ${round.name} 的清单拉取完`, async () => {
        const s = (await diagnostics()).queue?.stats ?? {};
        return (s.applied ?? 0) + (s.applyErrors ?? 0) - appliedBefore >= settled.derived.length || null;
      }, 120_000, 1000);
      const q = (await diagnostics()).queue;
      const inRound = (ids) => (ids ?? []).filter((id) => settled.derived.includes(id));
      Object.assign(r, {
        planId: settled.planId, derived: settled.derived, tasks: settled.derived.length,
        done: settled.states.filter((s) => s === 'done').length,
        failed: settled.derived.filter((id, i) => settled.states[i] === 'failed').map((id) => ({ id, error: q.tasks?.[id]?.error ?? null })),
        doneCounts: Object.fromEntries(settled.derived.map((id) => [id, q.doneCounts?.[id] ?? 0])),
        planDoneCount: q.doneCounts?.[settled.planId] ?? 0,
        pc: { nodeId: q.local?.nodeId, claimed: inRound(q.local?.claimed), completed: inRound(q.local?.completed), dedup: inRound(q.local?.dedup), failed: inRound(q.local?.failed), planClaimed: (q.local?.claimed ?? []).includes(settled.planId) },
        stats: q.stats, project: projectJson, library: path.join(dir, 'frame-library'),
      });
      check(r.failed.length === 0, `[creator] ${round.name} 没有细任务失败`, r.failed);
      await writeJson(path.join(STATE, `round-${round.name}.json`), r);
    }
    await writeJson(path.join(STATE, 'state.json'), { ...(await readJson(path.join(STATE, 'state.json'))), phase: 'holding' });
    const deadline = Date.now() + holdMs;
    while (Date.now() < deadline && !exists(path.join(STATE, 'stop'))) await delay(1000);
    out.auth = started.log.join('').split('\n').filter((l) => l.includes('auth.reject')).slice(-10).map((l) => l.replace(/^.*auth\.reject/, 'auth.reject').trim());
  } catch (error) {
    fails.push(`creator 出错:${error?.stack || error}`);
  } finally {
    if (started?.child) { killTree(started.child); await exited(started.child); }
    try { await writeJson(path.join(STATE, 'state.json'), { ...(await readJson(path.join(STATE, 'state.json'))), phase: 'stopped' }); } catch { /* 没写出过 */ }
  }
  return out;
}

/* ================================================================== host */

/** 用配置的第一项做一次原始握手,回 HTTP 状态码(101 / 401 / …);101 的连接立即关掉 */
async function handshakeStatus(entry) {
  const { sharedProtocols } = await import('../../server/auth/shared-config.mjs');
  const protocols = await sharedProtocols(entry, { role: 'render' })();
  const u = new URL(entry.url);
  return new Promise((resolve) => {
    const sock = net.connect(Number(u.port || 80), u.hostname);
    sock.on('error', () => resolve(null));
    let buf = '';
    sock.on('connect', () => {
      sock.write([`GET ${u.pathname || '/'} HTTP/1.1`, `Host: ${u.host}`, 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Protocol: ${protocols.join(', ')}`, '', ''].join('\r\n'));
    });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) { resolve(Number(m[1])); sock.destroy(); }
    });
    setTimeout(() => { resolve(null); sock.destroy(); }, 10_000).unref?.();
  });
}

async function runHost() {
  const port = Number(arg('--port', 5403));
  const name = arg('--name', 'host');
  const round = arg('--round', 'r1');
  const configFile = path.resolve(arg('--config', path.join(STATE, `${name}.json`)));
  const codeVersion = arg('--code-version', null);
  const expectClaims = arg('--expect-claims', null);
  const expectHandshake = arg('--expect-handshake', null);
  const out = { ok: false, name, round, port, projectId: null, claimed: null, completed: null, dedup: null, seen: null, connected: null, opens: null,
    handshake: null, codeVersion: null, envFingerprint: null, codeVersionOverride: codeVersion !== null, exitCode: null, released: null };
  let child = null;
  try {
    const { loadHostConfig } = await import('../../server/render-node/host.mjs');
    const config = loadHostConfig({ PROMPTCUT_SHARED_CONFIG: configFile });
    out.projectId = config.entries[0].projectId;
    out.handshake = await handshakeStatus(config.entries[0]);
    if (expectHandshake) check(String(out.handshake) === expectHandshake, `[${name}] 握手 ${expectHandshake}`, out.handshake);
    else check(out.handshake === 101, `[${name}] 握手 101`, out.handshake);

    for (const p of [port, port + 1, port + 2]) check(await portFree(p), `[${name}] 端口 ${p} 空着`);
    if (fails.length) return out;
    const dir = path.join(STATE, name);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    const env = { ...process.env };
    for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_QUEUE_NODE', 'PROMPTCUT_SHARED_CONFIG', 'PROMPTCUT_TEST_CODE_VERSION']) delete env[key];
    if (codeVersion) env.PROMPTCUT_TEST_CODE_VERSION = codeVersion;
    child = fork(path.join(ROOT, 'scripts', 'render-host.mjs'), ['--config', configFile, '--port', String(port), '--data', dir],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    const lines = [];
    let exitLine = null;
    const keep = (c) => {
      for (const line of c.toString().split('\n')) {
        if (!line.trim()) continue;
        lines.push(line); if (lines.length > 300) lines.shift();
        if (line.startsWith('[render-host] exit ')) { try { exitLine = JSON.parse(line.slice('[render-host] exit '.length)); } catch { /* 半行 */ } }
      }
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const ready = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 300_000);
      child.on('message', (m) => { if (m?.type === 'ready') { clearTimeout(t); resolve(m); } });
      child.once('exit', () => { clearTimeout(t); resolve(null); });
    });
    if (!check(ready, `[${name}] render-host 起来了`, lines.slice(-8))) return out;
    await writeJson(path.join(STATE, `${name}.ready`), { name, port, at: Date.now(), queue: ready.queue });
    const editor = `http://127.0.0.1:${port}`;
    await until(`[${name}] 等创建者做完 ${round}`, async () => exists(path.join(STATE, `round-${round}.json`)) || exists(path.join(STATE, 'stop')) || null, TIMEOUT_MS, 1000);
    const q = (await json(`${editor}/api/frames/queue`)).body;
    const n = q?.nodes?.[0] ?? {};
    Object.assign(out, { claimed: n.claimed ?? null, completed: n.completed ?? null, dedup: n.dedup ?? null, failed: n.failed ?? null, lost: n.lost ?? null,
      seen: n.seen ?? null, connected: n.connected ?? null, opens: n.opens ?? null, connectFailed: n.connectFailed ?? null, assetBase: n.assetBase ?? null,
      codeVersion: q?.codeVersion ?? null, envFingerprint: q?.envFingerprint ?? null, maxConcurrent: q?.maxConcurrent ?? null, profile: q?.profile ?? null });
    check(q?.profile === 'host', `[${name}] 诊断里 profile 是 host`, q?.profile);
    if (expectClaims === 'none') check(out.claimed === 0, `[${name}] 认领 0 次`, out.claimed);
    if (codeVersion) check(out.codeVersion === codeVersion, `[${name}] 对外报的代码版本是测试开关给的`, out.codeVersion);
    child.send({ type: 'shutdown' });
    out.exitCode = await exited(child, 60_000);
    out.released = exitLine?.released ?? null;
    check(out.exitCode === 0, `[${name}] render-host 退出码 0`, { exitCode: out.exitCode, tail: lines.slice(-5) });
  } catch (error) {
    fails.push(`host 出错:${error?.stack || error}`);
  } finally {
    if (child && child.exitCode === null) { killTree(child); await exited(child); }
  }
  out.ok = fails.length === 0;
  try { await writeJson(path.join(STATE, `${name}.result.json`), { ...out, fails }); } catch { /* state 目录没了 */ }
  return out;
}

/* ================================================================== check */

async function snapshotTree(library, dirs) {
  const files = new Map();
  const walk = async (dir) => {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await walk(file);
      else if (/\.(html|json)$/.test(item.name)) files.set(path.relative(library, file).replaceAll('\\', '/'), await fs.readFile(file));
    }
  };
  for (const d of dirs) await walk(path.join(library, d));
  return files;
}
const topDirs = async (library) => {
  const out = [];
  for (const tier of ['controls-html', 'controls-local']) {
    for (const item of await fs.readdir(path.join(library, tier), { withFileTypes: true }).catch(() => [])) if (item.isDirectory()) out.push(`${tier}/${item.name}`);
  }
  return out;
};
const sortStyles = (html) => html.replace(/style="([^"]*)"/g, (_, s) => 'style="' + s.split(';').map((x) => x.trim()).filter(Boolean).sort().join(';') + '"');

async function runCheck() {
  const port = Number(arg('--port', 5403));
  const round = arg('--round', 'r1');
  const hosts = String(arg('--hosts', '')).split(',').filter(Boolean);
  const out = { role: 'check', round, ok: false };
  let started = null;
  try {
    const r = await readJson(path.join(STATE, `round-${round}.json`));
    out.tasks = r.tasks;
    out.done = r.done;
    const counts = Object.values(r.doneCounts);
    out.duplicateDone = counts.reduce((n, c) => n + Math.max(0, c - 1), 0);
    out.missingDone = counts.filter((c) => c === 0).length;
    out.planDoneCount = r.planDoneCount;
    const byNode = { pc: r.pc.completed.length + r.pc.dedup.length };
    const hostNames = hosts.length ? hosts : (r.hosts ?? []);
    for (const h of hostNames) {
      const res = await readJson(path.join(STATE, `${h}.result.json`)).catch(() => null);
      check(res, `结果文件 ${h}.result.json 在`);
      byNode[h] = res ? (res.completed ?? 0) + (res.dedup ?? 0) : null;
      out[`claimed:${h}`] = res?.claimed ?? null;
    }
    out.completedByNode = byNode;
    out.sumCompleted = Object.values(byNode).reduce((n, v) => n + (v ?? 0), 0);
    out.pcPlanClaimed = r.pc.planClaimed;
    check(out.tasks > 0, '切出了细任务', out.tasks);
    check(out.done === out.tasks, '细任务全部 done', { tasks: out.tasks, done: out.done });
    check(out.duplicateDone === 0, 'duplicateDone = 0', r.doneCounts);
    check(out.missingDone === 0, '每个细任务都收到了 task.done', r.doneCounts);
    check(out.sumCompleted === out.tasks, '各节点完成数之和 = 任务数', { byNode, tasks: out.tasks });
    check(r.pc.planClaimed === true, 'plan 由发布方自己的 PC 节点认领');

    // 单机重渲:普通模式、空帧库,同一份项目
    const dir = path.join(STATE, `check-${round}`);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    started = await startEditor(port, baseEnv(dir, { PROMPTCUT_PUSH: '0' }), `check:${round}`);
    if (!started?.prerender) return out;
    const pre = await preloadProject(started, `rhp-check-${round}`, r.project, `check:${round}`);
    check(pre.key === r.entryKey, '单机重渲的 entry.key 与创建者那一版相同', { single: pre.key, creator: r.entryKey });
    const library = path.join(dir, 'frame-library');
    const dirs = await topDirs(library);
    const a = await snapshotTree(library, dirs);
    const b = await snapshotTree(r.library, dirs);
    const differences = [];
    let styleOrderOnly = 0;
    for (const rel of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      const x = a.get(rel), y = b.get(rel);
      if (x && y && x.equals(y)) continue;
      const orderOnly = !!(x && y && rel.endsWith('.html') && sortStyles(x.toString('utf8')) === sortStyles(y.toString('utf8')));
      if (orderOnly) { styleOrderOnly++; continue; }
      differences.push({ file: rel, reason: !x ? 'only-in-creator' : !y ? 'only-in-single' : 'bytes' });
    }
    out.compared = { dirs: dirs.length, singleFiles: a.size, creatorFiles: b.size, htmlFiles: [...a.keys()].filter((k) => k.endsWith('.html')).length };
    out.styleOrderOnly = styleOrderOnly;
    out.differentFrames = differences.length;
    out.differences = differences.slice(0, 20);
    out.identicalBytes = differences.length === 0 && styleOrderOnly === 0;
    out.identical = differences.length === 0;
    check(out.compared.htmlFiles > 0, '单机重渲的帧库里有快照', out.compared);
    check(out.identical, '与单机重渲逐帧相同(忽略 style 声明先后)', out.differences);
  } catch (error) {
    fails.push(`check 出错:${error?.stack || error}`);
  } finally {
    if (started?.child) { killTree(started.child); await exited(started.child); }
  }
  out.ok = fails.length === 0;
  return out;
}

/* ================================================================== auth-check */

async function runAuthCheck() {
  const configFile = path.resolve(arg('--config', path.join(STATE, 'member.json')));
  const out = { role: 'auth-check', ok: false };
  try {
    const { loadSharedConfig, sharedProtocols } = await import('../../server/auth/shared-config.mjs');
    const entry = loadSharedConfig({ PROMPTCUT_SHARED_CONFIG: configFile })[0];
    const host = new URL(entry.url).hostname;
    out.loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    out.projectId = entry.projectId;
    out.wrongPassword = await handshakeStatus({ ...entry, password: `${entry.password}-wrong`, key: null });
    check(out.wrongPassword === 401, '错口令握手 401', out.wrongPassword);
    out.rightPassword = await handshakeStatus(entry);
    check(out.rightPassword === 101, '对口令握手 101', out.rightPassword);

    // 素材票据:凭证明进入(page 角色)后 auth.ticket 取一张 rw 票据
    const { createWsEndpoint } = await import('../../server/render-node/ws-transport.mjs');
    const { createTicketSource } = await import('../../server/auth/ticket-source.mjs');
    const ep = createWsEndpoint({ url: entry.url, protocols: sharedProtocols(entry, { role: 'page' }) });
    try {
      await until('auth-check 连上', async () => ep.connected || null, 20_000, 100);
      const ticket = await createTicketSource(ep, { access: 'rw' })();
      out.ticket = typeof ticket === 'string' && ticket.startsWith('v1.');
      check(out.ticket, 'auth.ticket 取到素材票据');
      const u = new URL(entry.url);
      const assetBase = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}/api/asset`;
      const probeHash = randomBytes(32).toString('hex');
      const noTicket = await fetch(`${assetBase}/media/${probeHash}`, { method: 'HEAD' }).then((r) => r.status, () => null);
      const withTicket = await fetch(`${assetBase}/media/${probeHash}`, { method: 'HEAD', headers: { Authorization: `Bearer ${ticket}` } }).then((r) => r.status, () => null);
      out.assetNoTicket = noTicket;
      out.assetWithTicket = withTicket;
      check(withTicket !== 401 && withTicket !== 403 && withTicket !== null, '带票据读素材不被拒(不存在的哈希回 404)', withTicket);
      if (!out.loopback) check(noTicket === 401, '非回环来源不带票据读素材 401', noTicket);
    } finally {
      ep.close();
    }
    if (args.includes('--rate-limit')) {
      for (let i = 0; i < 5; i++) await handshakeStatus({ ...entry, password: `wrong-${i}`, key: null });
      out.afterFiveWrong = await handshakeStatus(entry);
      if (!out.loopback) check(out.afterFiveWrong === 401, '连错 5 次后口令对也 401(冷却)', out.afterFiveWrong);
    }
  } catch (error) {
    fails.push(`auth-check 出错:${error?.stack || error}`);
  }
  out.ok = fails.length === 0;
  return out;
}

/* ================================================================== 入口 */

let result;
if (ROLE === 'creator') result = await runCreator();
else if (ROLE === 'host') result = await runHost();
else if (ROLE === 'check') result = await runCheck();
else if (ROLE === 'auth-check') result = await runAuthCheck();
else { fails.push(`--role 要是 creator / host / check / auth-check,收到 ${ROLE}`); result = {}; }
const line = { ...result, ok: fails.length === 0, fails };
console.log(JSON.stringify(line));
process.exit(line.ok ? 0 : 1);
