#!/usr/bin/env node
/**
 * 托管方的渲染节点（隔离工作进程）能不能载入、渲染用 remotion 式的框架写的用户卡
 * （任务书 `docs/plan/render-refactor-task.md`「丙」第 7 条第二处；框架合入时（「乙」）没有在真的隔离工作进程里验）。
 *
 *   node scripts/probes/hosted-render-remotion-probe.mjs [--base-port 7450] [--doc-port 7458] [--asset-port 7459] [--keep-temp] [--verbose] [--time-scale 1]
 *
 * 端口（都只绑 127.0.0.1）：`--base-port` +0/+1/+2 常驻工作进程、+3/+4/+5 隔离工作进程、+6 管理进程的状态口；`--doc-port` / `--asset-port`
 * 本机隔离的托管组合。全部数据在一个临时目录里，结束时删掉。不连任何远端、不用任何真实凭证。
 *
 * 搭法照 `hosted-render-isolation-probe.mjs`（同一套：本机隔离的托管组合 + 渲染服务 + 一个共享项目，成员由本进程扮演），只留渲染这一条：
 *   - 项目里放两张用框架写的用户卡：测试夹具里的示例卡 `rs-title-reveal`（原样），和一张探针卡 `rs-hosted-mark`
 *     （引用 `../../kernel/remotionStyle`，顶层有一个常量对象，渲染时画一个色块（位置由 interpolate、颜色由 random 算出）和一行字（顶层对象是只读就画成绿色，不是就画成红色））；
 *   - 经文档服务把卡的源码 `content.put` 进内容库，项目放上两个片段，发清单计划，等渲染服务做完。
 *
 * # 验收（每条「过 / 不过」；stdout 最后一行是 JSON `{ ok, pass, fails, checks, ... }`；退出码 0 过、1 不过、2 起不来）
 *
 * H1 前提：两张卡的源码过了渲染服务装同步文件前的预检（卡片同步没有记「被拒」）；清单计划做完、没有失败的细任务；经管理进程的「看画面」（`/look`）要三帧，
 *    每一帧都由隔离工作进程（不是常驻的）出、回了图、画面不是空的。
 *    （remotion 式的卡不出预渲染结果，托管节点渲它的路就是「看画面」。）
 * H2 页面请求闸没有拦框架的文件：渲染页的日志里没有一条针对 `/src/kernel/remotionStyle/` 的拒绝；整段渲染里页面一侧的拒绝为 0（读不到框架就是模块载入失败，卡片出不来）。
 * H3 卡真的在隔离工作进程的页面里执行了（量看画面回来的图）：探针卡的色块在每个 t 上都在、颜色与位置和本进程里用同一套框架算的相同，三个 t 上位置各不相同；
 *    标签是绿色，说明卡里读到的顶层常量对象是只读（载入时锁只读那一句在隔离工作进程里也接上了）。
 * 记录（不当通过条件）：层表里有哪些片段。现状是声明成 motion 式的对照卡有层，两张 remotion 式的卡没有预渲染结果（画面当场算）。
 *
 * 单元对照：同时直接调页面请求闸的纯函数 `pageGate`，框架的每个文件作为页面自己的请求（`Sec-Fetch-Site: same-origin`）放行，作为别的源的请求拒绝。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import：不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startHostedCombo, hostedPaths } from '../../server/hosted/combo.mjs';
import { runKeygen } from '../../server/hosted-render/keygen.mjs';
import { killTree } from '../../server/hosted-render/worker.mjs';
import { createSharedProject, buildAuthProtocols } from '../../server/auth/client.mjs';
import { clipsPlanTaskOf } from '../../server/render-queue/messages.mjs';
import { pageGate } from '../../server/hosted-render/page-gate.mjs';
import { readServiceKeyFile } from '../../server/auth/service-identity.mjs';
import { signLookRequest, LOOK_AUTH_HEADER } from '../../server/hosted-render/look.mjs';
import { Easing, interpolate, random } from '../../src/kernel/remotionStyle/index.ts';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const flag = (name) => argv.includes(name);
const BASE = Number(arg('--base-port', 7450));
const PORTS = { worker: BASE, iso: BASE + 3, status: BASE + 6, doc: Number(arg('--doc-port', BASE + 8)), asset: Number(arg('--asset-port', BASE + 9)) };
const KEEP = flag('--keep-temp');
const WATCH_ISO = flag('--watch-iso');
const VERBOSE = flag('--verbose');
const CORES = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const SCALE = Number(arg('--time-scale', CORES <= 4 ? 2 : 1)) || 1;
const T = (ms) => Math.round(ms * SCALE);
const FPS = 30;
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-render-rs-'));
const DOC_WS = `ws://127.0.0.1:${PORTS.doc}`;
const STATUS = `http://127.0.0.1:${PORTS.status}`;
const HOSTED_DATA = path.join(TMP, 'hosted');
const RENDER_SECRETS = path.join(TMP, 'render-secrets');
const RENDER_DATA = path.join(TMP, 'render');
const PRERENDER_LOG = path.join(TMP, 'prerender.log');
const AGENT_SECRETS = path.join(TMP, 'agent-secrets');
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'hosted-render-remotion-probe')));
fs.mkdirSync(OUT, { recursive: true });
if ([5190, 5191, 5192, 5198, 5199, 5200, 5203, 5204, 5205, 5210, 5211, 5212].some((p) => p >= BASE && p <= BASE + 9) || (BASE >= 5800 && BASE < 6000)) {
  console.log(JSON.stringify({ ok: false, fails: ['这一段端口是用户常驻或别的探针占的，换一个'] }));
  process.exit(2);
}

const fails = [];
const checks = [];
const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s === undefined ? '' : (s.length > 400 ? `${s.slice(0, 400)}…` : s).replace(/v1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'v1.***'); };
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

/* ------------------------------------------------------------------ 卡片源码 */
const EXAMPLE = fs.readFileSync(path.join(ROOT, 'server', 'test', 'fixtures', 'remotion-style', 'rs-title-reveal.tsx'), 'utf8').replace(/\r\n/g, '\n');
const markCard = ({ id, mode, top, square }) => `/** 探针卡：用框架写，渲染时画一个色块和一行字（顶层对象是只读就画成绿色，不是就画成红色） */
import type { CardDef, CardProps } from "../../kernel/types";
import { Easing, interpolate, random, tween } from "../../kernel/remotionStyle";

interface Params { seed: number; label: string }

const CONFIG = { ease: Easing.out(Easing.cubic), span: 400 };

function HostedMark({ params, t = 0 }: CardProps<Params>) {
  const x = interpolate(t, [0, 1], [0, CONFIG.span], { easing: CONFIG.ease });
  const r = random(params.seed, 1);
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      ${square}
      <div style={{ position: "absolute", left: 100, top: ${top}, color: Object.isFrozen(CONFIG) ? "#00ff66" : "#ff3344", fontSize: 72, fontWeight: 800 }}>{params.label}</div>
    </div>
  );
}

export const hostedMark: CardDef<Params> = {
  id: "${id}",
  name: "托管渲染探针卡",
  description: "用框架写的探针卡：一个色块从左往右移，渲染时画色块和字",
  source: "user",
  useWhen: "探针用，不用于真实项目。",
  tags: ["探针"],
  frameMode: "${mode}",
  defaults: { seed: 5, label: "HOSTED-RS" },
  controls: [
    { key: "seed", label: "种子", type: "number", min: 0, max: 9999, step: 1 },
    { key: "label", label: "文字", type: "text" },
  ],
  Component: HostedMark,
  lifecycle: { settleMs: 1200, after: "hold", exit: ["fade"] },
};
`;

const SQUARE = '<div style={{ position: "absolute", left: 100 + x, top: 400, width: 220, height: 220, borderRadius: 24, background: "hsl(" + Math.round(r * 360) + ", 80%, 60%)", opacity: tween(t, { duration: 0.4 }) }} />';
const MARK_CARD = markCard({ id: 'rs-hosted-mark', mode: 'direct', top: 700, square: SQUARE });
// 对照：同一张卡声明成 motion 式（不是 remotion 式，载入时不锁只读），标签画在更下面；标签要画成红色，证明「绿色」不是白给的
const CONTROL_CARD = markCard({ id: 'rs-hosted-control', mode: 'stateful', top: 880, square: '' });

/* ------------------------------------------------------------------ 成员一侧的连接（照 hosted-render-isolation-probe） */
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
    ws, all, opened,
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
      const reqId = `rs-${++reqSeq}`;
      c.send({ ...message, reqId });
      return c.next((m) => m?.reqId === reqId, ms);
    },
    close() { try { ws.close(); } catch { /* 已关 */ } },
  };
  return c;
}
const putCard = async (conn, key, source) => {
  const r = await conn.ask({ type: 'content.put', kind: 'card-source', key, body: source.replace(/\r\n/g, '\n') });
  if (r.type !== 'content.stored') throw new Error(`content.put ${key}：${JSON.stringify(r).slice(0, 200)}`);
};
let combo = null;
function queueTasks(projectId) {
  const mods = combo.service.describe().modules ?? {};
  for (const d of Object.values(mods)) {
    const tasks = d?.spaces?.[projectId]?.tasks;
    if (Array.isArray(tasks)) return tasks;
  }
  return [];
}

/* ------------------------------------------------------------------ 渲染服务 */
let supervisor = null;
const supLogs = [];
function startSupervisor() {
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
    PROMPTCUT_RENDER_EDITOR_DIR: path.join(TMP, 'no-editor'),
    PROMPTCUT_RENDER_LOOK_SERVICES: hostedPaths(HOSTED_DATA).servicesFile,
    PROMPTCUT_RENDER_ISO_IDLE_MS: String(T(8000)),
    // 预渲染进程的全部输出（含渲染页的页面日志与 [page-gate] 的拒绝行）追加进这个文件
    PROMPTCUT_PRERENDER_LOG: PRERENDER_LOG,
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
      if (VERBOSE || (j && !['worker.line'].includes(j.event))) process.stderr.write(`[render] ${line.slice(0, 400)}\n`);
    }
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  supervisor = { child, exited: new Promise((resolve) => child.once('exit', (code) => resolve(code))) };
}
async function stopSupervisor() {
  const s = supervisor;
  if (!s || s.child.exitCode !== null) return;
  try { if (s.child.connected) s.child.send({ type: 'shutdown' }); else s.child.kill('SIGTERM'); } catch { /* 已经没了 */ }
  const done = await Promise.race([s.exited.then(() => true), delay(40_000).then(() => false)]);
  if (!done) killTree(s.child.pid);
}
const prerenderText = () => { try { return fs.readFileSync(PRERENDER_LOG, 'utf8').replace(/@\d{13} /g, ''); } catch { return ''; } };

/* ------------------------------------------------------------------ 排障：--watch-iso 盯隔离工作进程的目录（只读） */
// 每 300 毫秒看一次 render/iso 下有什么、记号在不在，变了就记一行；管理进程报 isolation.stop 之后每秒列一次命令行里带本次临时目录的进程
const isoWatch = { events: [], procs: [], timer: null };
function startIsoWatch() {
  if (!WATCH_ISO) return;
  const dir = path.join(RENDER_DATA, 'iso');
  let last = null;
  let seenLogs = 0, lastProc = 0, stopped = false;
  const needle = path.basename(TMP);
  const psCommand = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" + needle + "*' } | ForEach-Object { '' + $_.ProcessId + '|' + $_.Name + '|' + $_.CommandLine.Substring(0, [Math]::Min(140, $_.CommandLine.Length)) }";
  isoWatch.timer = setInterval(() => {
    let names = null;
    try { names = fs.readdirSync(dir); } catch { names = null; }
    const key = names === null ? 'absent' : (names.includes('.promptcut-render-iso') ? 'marker' : 'NO-marker') + ':' + names.length + ':' + names.slice(0, 6).join(',');
    if (key !== last) { last = key; isoWatch.events.push({ at: new Date().toISOString(), iso: key }); say('iso-watch', { iso: key }); }
    for (; seenLogs < supLogs.length; seenLogs++) {
      const l = supLogs[seenLogs];
      if (/^isolation\.|^worker\.(exit|start)/.test(l.event ?? '')) isoWatch.events.push({ at: l.t, event: l.event, worker: l.worker, reason: l.reason, cleaned: l.cleaned, message: l.message });
      if (l.event === 'isolation.stop') stopped = true;
    }
    if (stopped && Date.now() - lastProc > 1000 && isoWatch.procs.length < 14) {
      lastProc = Date.now();
      const r = spawnSync('powershell', ['-NoProfile', '-Command', psCommand], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      isoWatch.procs.push({ at: new Date().toISOString(), iso: last, procs: String(r.stdout ?? '').split(/\r?\n/).filter(Boolean) });
    }
  }, 300);
}

/* ------------------------------------------------------------------ 主流程 */
const out = { ok: false, run: RUN, platform: process.platform, cores: CORES, ports: PORTS };

async function main() {
  for (const d of [HOSTED_DATA, RENDER_DATA]) fs.mkdirSync(d, { recursive: true });
  say('start', { tmp: TMP, ports: PORTS });
  combo = await startHostedCombo({
    dataDir: HOSTED_DATA, docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    trustLoopback: false, clusterToken: randomBytes(32).toString('base64url'),
    assetPublicUrl: `http://127.0.0.1:${PORTS.asset}/api/asset`,
    log: (event, fields) => { if (VERBOSE || /error|reject|revoked/.test(event)) say(`hosted.${event}`, fields); },
  });
  runKeygen(['--hosted-data', HOSTED_DATA, '--secrets', RENDER_SECRETS, '--instance-name', '托管方的渲染节点（框架探针）']);
  // 看画面的口子：探针持一把登记过的 agent 服务私钥扮演云端 Agent 服务
  runKeygen(['--hosted-data', HOSTED_DATA, '--secrets', AGENT_SECRETS, '--service', 'agent', '--instance-name', '云端 Agent（框架探针扮演）']);
  startIsoWatch();
  startSupervisor();
  const ready = await Promise.race([
    waitFor(async () => { const s = await status(); return s.directory?.connected && s.worker?.ready && s.queue ? s : null; }, 300_000, '渲染服务就绪', 1000),
    supervisor.exited.then((code) => { throw new Error(`渲染服务退出了（退出码 ${code}）`); }),
  ]);
  const codeVersion = ready.queue.codeVersion;
  out.codeVersion = String(codeVersion).slice(0, 12);
  say('ready', { codeVersion: out.codeVersion, isolation: ready.isolation?.enabled, userCards: ready.userCards });

  // ---------- 项目与卡
  const creatorPassword = `c-${randomBytes(9).toString('base64url')}`;
  const password = `p-${randomBytes(9).toString('base64url')}`;
  const name = `rs-hosted-${RUN}`;
  const made = await createSharedProject({ base: DOC_WS, name, mode: 'free', creator: { username: 'alice', password: creatorPassword }, password });
  const protocols = await buildAuthProtocols({
    base: DOC_WS, projectId: made.projectId, username: 'alice', deviceId: `rs-${RUN}-alice`.padEnd(20, '0').slice(0, 48), deviceName: 'alice', as: 'creator', password: creatorPassword, role: 'page',
  });
  const conn = connect(protocols);
  await conn.opened;
  const docId = `rs-probe-${RUN}`;
  await putCard(conn, 'src/cards/user/rs-title-reveal.tsx', EXAMPLE);
  await putCard(conn, 'src/cards/user/rs-hosted-mark.tsx', MARK_CARD);
  await putCard(conn, 'src/cards/user/rs-hosted-control.tsx', CONTROL_CARD);
  const clips = [
    { id: 'clip-example', cardId: 'rs-title-reveal', params: { text: '框架卡在托管节点上' } },
    { id: 'clip-mark', cardId: 'rs-hosted-mark' },
    { id: 'clip-control', cardId: 'rs-hosted-control' },
  ];
  const project = {
    id: docId, name: '框架探针', width: 1920, height: 1080, fps: FPS, duration: 2,
    themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
    tracks: clips.map((c, i) => ({ id: `tr-${i}`, name: `tr-${i}`, hidden: false, clips: [{ id: c.id, kind: 'card', cardId: c.cardId, start: 0, end: 2, params: c.params ?? {} }] })),
  };
  const put = await conn.ask({ type: 'project.op', projectId: docId, opId: `op-${RUN}-1`, session: `s-${RUN}`, ops: [{ op: 'set', path: '', value: project }] }, 20_000);
  if (put.type !== 'project.op.ok') throw new Error(`project.op 被拒：${JSON.stringify(put).slice(0, 300)}`);

  // 先看画面、后发清单计划：看画面起的隔离工作进程闲置结束时（Windows 上偶发清理不干净），再起第二轮会失败，所以把要紧的放在第一轮里
  // ---------- 「看画面」：框架卡（remotion 式的卡不出预渲染结果，在托管节点上经这一路渲）经管理进程的 /look 要几帧
  say('look');
  const agentKey = readServiceKeyFile(AGENT_SECRETS);
  const look = async (t) => {
    const msg = { projectId: made.projectId, path: '/api/vision/snapshot', body: { project, t }, cards: Object.fromEntries(['rs-title-reveal.tsx', 'rs-hosted-mark.tsx', 'rs-hosted-control.tsx'].map((f) => [`src/cards/user/${f}`, null])), timeoutMs: 170_000 };
    const text = JSON.stringify(msg);
    const res = await fetch(`${STATUS}/look`, { method: 'POST', headers: { 'content-type': 'application/json', [LOOK_AUTH_HEADER]: signLookRequest(agentKey, text) }, body: text, signal: AbortSignal.timeout(T(240_000)) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const lookBefore = (await status()).look ?? null;
  const TIMES = [0.5, 0.8, 1.6];
  const looks = [];
  for (const t of TIMES) {
    let got = null;
    // 503「渲染服务现在忙」是暂时性的（上一轮还在让出资源、或看画面的请求排满），重试加退避，不算结果
    for (let attempt = 0; attempt < 12; attempt++) {
      try { got = await look(t); out.lookError = undefined; } catch (err) { out.lookError = String(err?.message ?? err); }
      if (got?.status !== 503) break;
      say('look.busy', { t, attempt });
      await delay(T(5000));
    }
    const b64 = got?.json?.__image?.base64 ?? null;
    let png = null, inkPx = 0, file = null;
    if (b64) {
      const buf = Buffer.from(b64, 'base64');
      file = path.join(OUT, `look-t${String(Math.round(t * 100)).padStart(3, '0')}.png`);
      fs.writeFileSync(file, buf);
      png = PNG.sync.read(buf);
      const bg = [png.data[0], png.data[1], png.data[2]];
      for (let i = 0; i < png.data.length; i += 4) if (png.data[i] !== bg[0] || png.data[i + 1] !== bg[1] || png.data[i + 2] !== bg[2]) inkPx++;
    }
    looks.push({ png, t, status: got?.status ?? null, ok: got?.json?.ok ?? null, image: png ? `${png.width}x${png.height}` : null, inkPixels: inkPx, file, error: got?.json?.error ?? out.lookError });
    say('look.done', { ...looks.at(-1), png: undefined });
  }
  await delay(2500); // 页面日志落进文件有一点延迟
  const sLook = await status();
  out.look = { looks: looks.map(({ png: _png, ...rest }) => rest), byWorker: sLook.look?.byWorker ?? null, byWorkerBefore: lookBefore?.byWorker ?? null };
  const isoDelta = (sLook.look?.byWorker?.isolated ?? 0) - (lookBefore?.byWorker?.isolated ?? 0);
  const residentDelta = (sLook.look?.byWorker?.resident ?? 0) - (lookBefore?.byWorker?.resident ?? 0);

  // ---------- 发清单计划，等渲染
  say('render');
  const known = new Set(queueTasks(made.projectId).map((t) => t.id));
  const hello = await conn.ask({ type: 'publisher.hello', publisherId: `rs-pub-${RUN}` });
  if (hello.type !== 'publisher.welcome') throw new Error(`publisher.hello：${JSON.stringify(hello).slice(0, 200)}`);
  const plan = clipsPlanTaskOf({ projectId: docId, projectRev: put.rev, clips: clips.map((c) => c.id), codeVersion });
  const pub = await conn.ask({ type: 'task.publish', tasks: [plan] });
  if (pub.type !== 'task.published') throw new Error(`task.publish：${JSON.stringify(pub).slice(0, 300)}`);
  const mine = (t) => t.id === plan.id || !known.has(t.id);
  // 计划做完（框架卡多半被判轻、不出细任务，所以细任务可以是 0 个）；有细任务的要等它们都落定
  let done = null;
  try {
    done = await waitFor(() => {
      const tasks = queueTasks(made.projectId).filter(mine);
      const fine = tasks.filter((t) => !t.id.startsWith('plan:'));
      const p = tasks.find((t) => t.id === plan.id);
      if (!p || (p.state !== 'done' && p.state !== 'failed')) return null;
      if (fine.some((t) => t.state === 'open' || t.state === 'claimed')) return null;
      return { plan: p.state, tasks: fine.length, done: fine.filter((t) => t.state === 'done').length, failed: fine.filter((t) => t.state === 'failed').length };
    }, 420_000, '计划与细任务做完', 300);
    // 记号行是页面渲染时写的日志，落进文件有一点延迟
    await waitFor(() => /RS-HOSTED-MARK/.test(prerenderText()), 30_000, '页面日志里出现探针卡的记号', 500).catch(() => {});
  } catch (err) { out.renderError = String(err?.message ?? err); }
  const map = await conn.ask({ type: 'content.get', kind: 'snapshot-manifest', key: `layers:${docId}` });
  const s0 = await status();
  const cardSync = s0.isolation?.queue?.cardSync ?? [];
  out.cardSync = cardSync.map((c) => ({ projectId: c.projectId, state: c.state, rejected: c.rejected, installed: c.installed, errors: c.errors?.slice?.(0, 3) }));
  out.plan = done;

  /* ---- H1 */
  const text = prerenderText();
  const rejectedSync = /source-rejected|被拒|rejected/i.test(JSON.stringify(out.cardSync));
  check('H1', '两张框架卡的源码过了装同步文件前的预检（卡片同步没有记「被拒」）', !rejectedSync, out.cardSync);
  check('H1', '清单计划做完、没有失败的细任务（对照卡是 motion 式，会出一个）', !!done && done.plan === 'done' && done.failed === 0, { done, error: out.renderError });
  check('H1', '看画面的几帧都由隔离工作进程出（不是常驻的）、回了图', looks.every((l) => l.status === 200 && l.ok === true && l.image) && isoDelta === TIMES.length && residentDelta === 0, { looks: looks.map((l) => ({ t: l.t, status: l.status, image: l.image, error: l.error })), isoDelta, residentDelta });
  check('H1', '画面不是空的：每一帧都有画出来的像素', looks.every((l) => l.inkPixels > 2000), looks.map((l) => ({ t: l.t, ink: l.inkPixels })));
  const resident = (sLook.queue?.nodes ?? []).find((n) => n.projectId === made.projectId) ?? null;
  check('H1', '常驻工作进程没有认领（它不执行项目带来的卡片代码）', !resident || resident.claimed === 0, resident && { claimed: resident.claimed, hold: resident.hold });

  /* ---- H2 */
  const gateLines = [...text.matchAll(/\[page-gate\] (deny|would-deny|source-rejected|on) (\{.*\})/g)].map((m) => { try { return { kind: m[1], ...JSON.parse(m[2]) }; } catch { return { kind: m[1], raw: m[2] }; } });
  const pageDenied = gateLines.filter((l) => l.layer === 'page');
  const aboutFramework = gateLines.filter((l) => /remotionStyle/.test(JSON.stringify(l)));
  out.pageGate = { lines: gateLines.length, pageDenied: pageDenied.length, aboutFramework: aboutFramework.length, mode: gateLines.find((l) => l.kind === 'on')?.mode ?? null, sample: pageDenied.slice(0, 3) };
  check('H2', '页面请求闸没有拦框架的文件：日志里没有针对 /src/kernel/remotionStyle/ 的拒绝', aboutFramework.length === 0, aboutFramework.slice(0, 3));
  check('H2', '整段渲染里页面一侧的拒绝为 0', pageDenied.length === 0, pageDenied.slice(0, 3));
  check('H2', '页面请求闸确实开着（日志里有 [page-gate] on 一行）', out.pageGate.mode !== null, out.pageGate.mode);

  /* ---- H3：画面里量。页面里算出来的色块位置、颜色、标签颜色，和本进程里用同一套框架算的比 */
  const ease = Easing.out(Easing.cubic);
  const hsl = (h, sat, lig) => { const k = (n) => (n + h / 30) % 12; const a = sat * Math.min(lig, 1 - lig); const f = (n) => lig - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)); return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)); };
  const near = (px, rgb, tol) => Math.abs(px[0] - rgb[0]) <= tol && Math.abs(px[1] - rgb[1]) <= tol && Math.abs(px[2] - rgb[2]) <= tol;
  /** 这个颜色的像素的包围盒（图是 768 宽，舞台是 1920 宽） */
  const boxOf = (png, rgb, tol, yMin = 0, yMax = 1e9) => {
    let x0 = 1e9, x1 = -1, n = 0;
    for (let y = Math.max(0, yMin); y < Math.min(png.height, yMax); y++) for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (near([png.data[i], png.data[i + 1], png.data[i + 2]], rgb, tol)) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; }
    }
    return { n, left: x0, right: x1 };
  };
  const hue = Math.round(random(5, 1) * 360);
  const blue = hsl(hue, 0.8, 0.6);
  const rows = [];
  for (const l of looks) {
    if (!l.png) { rows.push({ t: l.t, error: 'no image' }); continue; }
    const scale = l.png.width / 1920;
    const x = interpolate(l.t, [0, 1], [0, 400], { easing: ease });
    const wantLeft = (100 + x) * scale;
    const box = boxOf(l.png, blue, 10);
    const split = Math.round(800 * scale); // 上半是探针卡的标签（舞台 y 700～772），下半是对照卡的标签（y 880～）
    const green = boxOf(l.png, [0, 255, 102], 6, 0, split);
    const red = boxOf(l.png, [255, 51, 68], 6, 0, split);
    const ctlRed = boxOf(l.png, [255, 51, 68], 6, split);
    const ctlGreen = boxOf(l.png, [0, 255, 102], 6, split);
    rows.push({ t: l.t, wantLeft: +wantLeft.toFixed(1), gotLeft: box.left, squarePixels: box.n, labelGreen: green.n, labelRed: red.n, controlRed: ctlRed.n, controlGreen: ctlGreen.n });
  }
  out.measured = rows;
  check('H3', '探针卡在隔离工作进程的页面里画出来了：每一帧都找得到它的色块（颜色由 random(种子, 序号) 算出，和本进程里用同一套框架算的相同）', rows.every((r) => r.squarePixels > 800), rows);
  check('H3', '色块的位置是 interpolate 在这个 t 上算的（左边缘和本进程里用同一套框架算的相差不超过 2 个像素）；三个 t 上位置各不相同', rows.every((r) => Math.abs(r.gotLeft - r.wantLeft) <= 2) && new Set(rows.map((r) => r.gotLeft)).size === rows.length, rows);
  check('H3', '标签是绿色：Object.isFrozen(顶层的常量对象) 为真，载入时锁只读那一句在隔离工作进程里也接上了（没锁住会是红色）', rows.every((r) => r.labelGreen > 150 && r.labelRed === 0), rows);
  check('H3', '对照：声明成 motion 式的同一张卡（不锁只读）的标签是红色——这套量法分得出锁与没锁', rows.every((r) => r.controlRed > 150 && r.controlGreen === 0), rows.map((r) => ({ t: r.t, controlRed: r.controlRed, controlGreen: r.controlGreen })));

  /* ---- 记录：层表 */
  const layerIds = (map.body?.layers ?? []).map((l) => l.clipId);
  out.layers = { type: map.type, missing: map.missing, clipIds: layerIds };
  // 只记录，不当通过条件（以后「戊」改了谁出预渲染结果，这里的数字会跟着变）：现状是声明成 motion 式的对照卡有层，两张 remotion 式的卡没有
  out.layers.note = layerIds.length === 0 ? '层表里没有层' : `层表里的片段：${layerIds.join('、')}`;

  /* ---- 单元对照：页面请求闸的纯函数 */
  const files = fs.readdirSync(path.join(ROOT, 'src', 'kernel', 'remotionStyle')).filter((f) => /\.(ts|mjs)$/.test(f) && !/\.test\./.test(f));
  const verdicts = files.map((f) => {
    const url = `/src/kernel/remotionStyle/${f}`;
    const own = pageGate({ url, method: 'GET', headers: { 'sec-fetch-site': 'same-origin', host: '127.0.0.1:1' }, prerender: true });
    const foreign = pageGate({ url, method: 'GET', headers: { 'sec-fetch-site': 'cross-site', host: '127.0.0.1:1' }, prerender: true });
    return { f, own: own.allow, foreign: foreign.allow };
  });
  out.pageGateUnit = verdicts;
  check('H2', '（单元对照）页面请求闸：框架的每个文件作为页面自己的请求放行、作为别的源的请求拒绝', verdicts.length >= 6 && verdicts.every((v) => v.own === true && v.foreign === false), verdicts);
}

let exitCode = 1;
try {
  await main();
  out.ok = fails.length === 0;
  exitCode = out.ok ? 0 : 1;
} catch (err) {
  fails.push(`起不来或中途出错：${String(err?.stack ?? err?.message ?? err).slice(0, 600)}`);
  exitCode = 2;
} finally {
  try { await stopSupervisor(); } catch { /* 已停 */ }
  try { await combo?.close(); } catch { /* 已关 */ }
  out.leftover = { ports: [] };
  for (const port of [PORTS.worker, PORTS.worker + 1, PORTS.worker + 2, PORTS.iso, PORTS.iso + 1, PORTS.iso + 2, PORTS.status, PORTS.doc, PORTS.asset]) {
    const busy = await new Promise((resolve) => { const sv = http.createServer(); sv.once('error', () => resolve(true)); sv.listen(port, '127.0.0.1', () => sv.close(() => resolve(false))); });
    if (busy) out.leftover.ports.push(port);
  }
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* 有文件还被占着，留给系统清 */ } } else out.tmp = TMP;
}
if (isoWatch.timer) clearInterval(isoWatch.timer);
if (WATCH_ISO) out.isoWatch = { events: isoWatch.events, procs: isoWatch.procs };
out.pass = checks.filter((c) => c.ok).length;
out.fails = fails;
out.checks = checks;
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(exitCode);
