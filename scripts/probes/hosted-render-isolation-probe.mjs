#!/usr/bin/env node
/**
 * 托管方渲染服务「按项目隔离地执行项目带来的卡片代码」的验收探针（契约 `docs/plan/hosted-render-contract.md` 第 7.5、10.2 节；
 * 任务书 `docs/plan/sound-online-render-task.md` 第 23 条与文末「越权探测卡」一节）。用断言，不靠推断。
 *
 *   node scripts/probes/hosted-render-isolation-probe.mjs [--base-port 5800] [--doc-port 8770] [--asset-port 8771]
 *        [--keep-temp] [--verbose] [--mem-low 256M] [--memory-max 32G] [--time-scale 1] [--no-proxy-only]
 *
 * 端口（都只绑 127.0.0.1）：`--base-port` +0/+1/+2 常驻工作进程、+3/+4/+5 隔离工作进程、+6 管理进程的诊断与代理口、
 * +7 收集站（TCP 与 UDP；它就是「测试专用的外部地址」）；`--doc-port` / `--asset-port` 本机隔离的托管组合。全部数据在一个临时目录里，结束时删掉。
 * 不连任何远端；探针放的全是**只属于测试的假凭证**（`PROBE-FAKE-…` 的占位字符串），不用任何真实凭证、真实项目、真实外部地址。
 * `--time-scale`：等待时限的倍数（慢机器、核数少的容器上放大）；不给时按核数自动取（4 核及以下 2 倍）。
 *
 * 夹具是「越权探测卡」（`fixtures/render-isolation/`，防御性测试夹具、只读只报告）：
 *   overreach-probe.tsx + overreach-probe-lib.ts   用户卡：按固定清单逐项尝试，结果打进页面日志，探针从工作进程的输出里取回
 *   overreach-graph.tsx                            图卡形态（同一份清单）
 *   overreach-marker-jia.tsx                       只有项目甲才有的一张卡（验「乙的页面里没有甲的代码」）
 *   overreach-node-side.css / .ts                  Node 一侧处理时的读盘写法（预期被同步文件预检整份拒掉）
 *
 * # 布置
 *
 * 本机隔离的托管组合（不信回环，与云节点同样的配置）+ 渲染服务（管理进程、常驻工作进程；用户卡走隔离工作进程）。两个项目甲、乙，
 * 各自的成员由本进程扮演。**事先放好的假凭证**（每一处一个不同的串，探针记着「值 → 放在哪」）：
 *   F1 服务私钥目录里的一个假私钥文件         F2 登记表旁（托管数据目录的 secrets/ 下）的一个文件
 *   F3 管理进程的环境变量里（两个：一个名字像秘密、一个不像）   F4 工作目录以外的一个临时文件
 *   F5 别的工作进程（常驻）的数据目录里的一个文件   F6 项目乙的内容里（项目文档）   F7 项目乙的素材里（素材服务 media 里的一块）
 *   F8 项目乙的卡片源码里（内容库 card-source）   另：项目甲自己的记号卡里有一个记号（甲读得到是应该的；乙的页面里不该有）
 *
 * # 验收标准（每条一行「过 / 不过」；stdout 最后一行是 JSON `{ ok, pass, fails, checks, residual, … }`；退出码 0 过、1 不过、2 起不来）
 *
 * **核心项：下面 B～G 任何一条带回了假凭证，或 H、I 不成立 = 任务书第三段的核心项不过。**
 *
 * A 前提（不成立则后面的「读不到」没有意义）
 *   A1 两个项目的越权探测卡都真的在隔离工作进程里被渲了：任务由 `hosted-render-iso:` 节点认领并做完、层表与产物入库；
 *      探针取回了甲、乙各至少一份结果对象，清单里的每一项都有记录（读到了什么 / 被拒 / 报错）。
 *   A2 常驻工作进程对这两个项目一个任务也没认领（它不同步卡、不执行项目带来的代码）；它报 `userCards: false`，隔离工作进程报 `true`。
 *   A3 对照：探测卡读自己项目的东西是通的（同源取模块 200；经工作进程取自己项目的一块素材，内容对）——「读不到」不是探针瞎了。
 * B 页面上的全局对象：取回的全部内容里没有任何假凭证，没有票据形状的串（`v1.<…>.<…>`），没有代理口口令的环境变量名对应的值。
 * C 本机存储：`localStorage` / `sessionStorage` / `indexedDB` / `cookie` / Cache 里没有假凭证；渲染用的 Chrome 的用户数据目录在隔离工作进程
 *   自己的数据目录里（换项目时随目录清空）。
 * D 父页面与同源的别的窗口：导出页自己就是顶层、没有 `opener`、没有别的框架；同源广播频道里听不到东西。
 * E 本机回环地址与工作进程自己的接口——
 *   E1 自己这台预渲染 Vite 的 `/api/**`（队列诊断、卡片、项目、配置、放回认领……）：清单里每一条都被页面请求闸拒掉（403）；WebSocket 升级被拒。
 *   E2 管理进程的状态口与代理口、常驻工作进程的 Vite、自己这棵树里编辑器的 Vite、文档服务与素材服务的本机端口：
 *      带跨源读取的请求读不到任何内容；不带的（`no-cors`）拿到的只是不可读的空壳；WebSocket 连不上；
 *      并且出口限制的两层至少有一层留下了拦截记录（浏览器的出口白名单：页面日志里的 `ERR_NETWORK_ACCESS_REVOKED`，请求没有离开浏览器；
 *      或出口代理的拒绝记录，请求止于代理），代理确实在用且只把请求转给这台预渲染 Vite 自己；管理进程没有收到任何浏览器发来的请求。
 *   E3 云厂商元数据地址 `169.254.169.254`：页面读不到任何内容（同样被出口限制拦下，没有连出去）。
 * F 测试专用的外部地址（收集站）：fetch / POST / sendBeacon / 图片 / WebSocket / 子框架导航 / 预取 / WebRTC 探路之后，收集站 0 条 TCP 连接、0 个 HTTP 请求、0 个 UDP 包。
 * G Node 一侧处理时读工作目录以外的文件——
 *   G1 经开发服务器的各种取文件写法（`/@fs/…`、`?raw`、`?url`、`?inline`、`?import&raw`、带多余 `?` 的、`..` 穿越、编码过的穿越、
 *      运行时 `import()`、`file://`）：F1、F2、F4、F5 所在的文件一个都读不到。
 *   G2 同步文件预检：`overreach-node-side.css` 与 `.ts`（`@import` / `@reference` / `@source` / `@plugin` / `@config` / `url(?inline)` /
 *      越界的导入、`import.meta.glob`、`new URL`、带变量的动态导入）被整份拒掉——卡片同步记「被拒」、改动层里没有这两个文件、
 *      「在 Node 里被执行过」的记号没有出现在任何输出里。
 * H 别的项目：甲的结果里没有乙的内容（F6）、乙的卡片源码（F8）；乙的素材（F7）见下面「残余面」第 1 条的判法。
 * I 换项目：渲完甲换去渲乙之前，隔离工作进程结束、整棵进程树不剩、数据目录清空（管理进程的记录与磁盘上都是空的）；
 *   乙那一轮的改动层里只有乙的卡；乙的页面里没有甲的卡片代码（甲的记号卡没有载入、取不到它的文件、清单里没有它）。
 * J 渲染身份不能改项目：以渲染服务的身份提交一次编辑、写卡片源码，被拒，项目版本号不变。
 * P 对照段（只留出口代理一层）：两层出口限制都在时浏览器先拦，请求到不了代理。所以另起一轮，用仅供验收的开关不发出口白名单头
 *   （`PROMPTCUT_TEST_NO_EGRESS_HEADER=1`），同一张探测卡再渲一遍：每个目的地在出口代理的拒绝记录里都有、页面仍然读不到任何内容、
 *   收集站仍然是 0——证明代理这一层自己拦得住。`--no-proxy-only` 跳过这一段。
 * K 代理口：不带口令要清单 401；浏览器形状的请求（带 `Sec-Fetch-Site`）连状态口也 403；状态口的输出里没有任何假凭证与票据。
 *
 * # 残余面（如实记录，不算失败；写进结果的 `residual`）
 *   1. 素材按哈希寻址：同一台素材服务上，任何有效票据都能按哈希读块（`auth-contract.md` 第 8 节的既有裁定）。探针先以甲的成员身份
 *      直接试一次读乙的那一块：读得到，说明这是成员本来就有的能力，探测卡经工作进程读到同一块不算隔离失败（记在残余面里）；
 *      读不到，则探测卡也必须读不到（算进 H）。乙的哈希是探针交给探测卡的最坏情况——真实情况下甲无从得知。
 *   2. 外传：隔离工作进程里的卡片代码**带不走本项目的内容**到任何外部地址（F 成立即是）；这比「卡片作者本来就是本项目成员」要求的更严。
 *   3. 环境变量：名字不像秘密的那一个（F3 的第二个）会被工作进程继承——页面读不到进程环境变量，Node 一侧又过不了同步文件预检，所以带不回来；
 *      名字像秘密的那一个根本不传给工作进程。
 *   4. 图卡：见结果里的 `graph` 一项（渲染节点有没有对图卡的 `card()` 求值）。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import：不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startHostedCombo, hostedPaths } from '../../server/hosted/combo.mjs';
import { runKeygen } from '../../server/hosted-render/keygen.mjs';
import { killTree, treeAlive } from '../../server/hosted-render/worker.mjs';
import { createSharedProject, buildAuthProtocols, ticketProtocols } from '../../server/auth/client.mjs';
import { readServiceKeyFile, buildServiceProtocols } from '../../server/auth/service-identity.mjs';
import { clipsPlanTaskOf } from '../../server/render-queue/messages.mjs';
import { createAssetClient } from '../../server/asset-store/client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'scripts', 'probes', 'fixtures', 'render-isolation');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const flag = (name) => argv.includes(name);
const BASE = Number(arg('--base-port', 5800));
const PORTS = { worker: BASE, iso: BASE + 3, status: BASE + 6, collector: BASE + 7, doc: Number(arg('--doc-port', 8770)), asset: Number(arg('--asset-port', 8771)) };
const KEEP = flag('--keep-temp');
const VERBOSE = flag('--verbose');
const MEM_LOW = String(arg('--mem-low', '256M'));
const MEMORY_MAX = String(arg('--memory-max', '32G'));
const CORES = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const SCALE = Number(arg('--time-scale', CORES <= 4 ? 2 : 1)) || 1;
const T = (ms) => Math.round(ms * SCALE);
const FPS = 30;
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-render-iso-'));
const DOC_WS = `ws://127.0.0.1:${PORTS.doc}`;
const STATUS = `http://127.0.0.1:${PORTS.status}`;
const COLLECTOR = `http://127.0.0.1:${PORTS.collector}`;
const METADATA = 'http://169.254.169.254/latest/meta-data/';
const HOSTED_DATA = path.join(TMP, 'hosted');
const RENDER_SECRETS = path.join(TMP, 'render-secrets');
const RENDER_DATA = path.join(TMP, 'render');
const ISO_DATA = path.join(RENDER_DATA, 'iso');
const OUTSIDE_DIR = path.join(TMP, 'outside');
const PRERENDER_LOG = path.join(TMP, 'prerender.log');

/* ------------------------------------------------------------------ 记分 */
const fails = [];
const checks = [];
const residual = [];
/** 假凭证：值 → 放在哪。**值不打印**，比对时只报标签 */
const fakes = new Map();
const fake = (label) => { const v = `PROBE-FAKE-${label}-${randomBytes(9).toString('hex')}`; fakes.set(v, label); return v; };
const scrub = (s) => { let o = String(s).replace(/v1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'v1.***'); for (const [v, label] of fakes) o = o.split(v).join(`<${label}>`); return o; };
const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s === undefined ? '' : scrub(s.length > 360 ? `${s.slice(0, 360)}…` : s); };
const check = (id, label, ok, detail) => {
  const line = `${ok ? '  过' : '不过'}  ${id} ${label}${detail === undefined || detail === '' ? '' : `  〔${short(detail)}〕`}`;
  console.log(line);
  checks.push({ id, ok: !!ok, label, ...(detail === undefined ? {} : { detail: short(detail) }) });
  if (!ok) fails.push(`${id} ${label}`);
  return !!ok;
};
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);
/** 一段文字里出现了哪些假凭证（回标签；`allow` 里的标签不算） */
const fakesIn = (text, allow = []) => [...fakes].filter(([v, label]) => !allow.includes(label) && String(text).includes(v)).map(([, label]) => label);
const TICKET_RE = /v1\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/;

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

/* ------------------------------------------------------------------ 收集站（测试专用的外部地址） */
const collector = { tcp: 0, http: [], udp: 0 };
const collectorSrv = http.createServer((req, res) => {
  collector.http.push(`${req.method} ${String(req.url).slice(0, 80)}`);
  res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' });
  res.end('collected');
});
collectorSrv.on('connection', () => { collector.tcp += 1; });
collectorSrv.on('upgrade', (req, socket) => { collector.http.push(`UPGRADE ${String(req.url).slice(0, 80)}`); socket.destroy(); });
const collectorUdp = dgram.createSocket('udp4');
collectorUdp.on('message', () => { collector.udp += 1; });

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
      const reqId = `iso-${++reqSeq}`;
      c.send({ ...message, reqId });
      return c.next((m) => m?.reqId === reqId, ms);
    },
    close() { try { ws.close(); } catch { /* 已关 */ } },
  };
  return c;
}
async function joinAs(proj, username, as = 'member') {
  const protocols = await buildAuthProtocols({
    base: DOC_WS, projectId: proj.projectId, username, deviceId: `iso-${RUN}-${username}`.padEnd(20, '0').slice(0, 48), deviceName: username, as,
    password: as === 'creator' ? proj.creatorPassword : proj.password, role: 'page',
  });
  const c = connect(protocols);
  await c.opened;
  return c;
}
async function makeProject(label, creator, slug) {
  const creatorPassword = `c-${randomBytes(9).toString('base64url')}`;
  const password = `p-${randomBytes(9).toString('base64url')}`;
  const name = `iso-${slug}-${RUN}`;
  const made = await createSharedProject({ base: DOC_WS, name, mode: 'free', creator: { username: creator, password: creatorPassword }, password });
  const proj = { label, projectId: made.projectId, name, creator, creatorPassword, password, slug, docId: `iso-probe-${slug}` };
  proj.conn = await joinAs(proj, creator, 'creator');
  return proj;
}
const putCard = async (proj, key, source) => {
  const r = await proj.conn.ask({ type: 'content.put', kind: 'card-source', key, body: source.replace(/\r\n/g, '\n') });
  if (r.type !== 'content.stored') throw new Error(`content.put ${key}：${JSON.stringify(r).slice(0, 200)}`);
};
async function putProject(proj, project) {
  const r = await proj.conn.ask({ type: 'project.op', projectId: proj.docId, opId: `op-${RUN}-${++reqSeq}`, session: `s-${RUN}-${proj.slug}`, ops: [{ op: 'set', path: '', value: project }] }, 20_000);
  if (r.type !== 'project.op.ok') throw new Error(`project.op 被拒：${JSON.stringify(r).slice(0, 300)}`);
  return r.rev;
}
function queueTasks(projectId) {
  const mods = combo.service.describe().modules ?? {};
  for (const d of Object.values(mods)) {
    const tasks = d?.spaces?.[projectId]?.tasks;
    if (Array.isArray(tasks)) return tasks;
  }
  return [];
}
async function publishPlan(proj, { rev, clips, codeVersion }) {
  const known = new Set(queueTasks(proj.projectId).map((t) => t.id));
  if (!proj.publisher) {
    const hello = await proj.conn.ask({ type: 'publisher.hello', publisherId: `iso-pub-${RUN}-${proj.slug}` });
    if (hello.type !== 'publisher.welcome') throw new Error(`publisher.hello：${JSON.stringify(hello).slice(0, 200)}`);
    proj.publisher = true;
  }
  const task = clipsPlanTaskOf({ projectId: proj.docId, projectRev: rev, clips, codeVersion });
  const r = await proj.conn.ask({ type: 'task.publish', tasks: [task] });
  if (r.type !== 'task.published') throw new Error(`task.publish：${JSON.stringify(r).slice(0, 300)}`);
  return { planId: task.id, known };
}
async function waitRendered(proj, { planId, known }, ms = 420_000) {
  const mine = (t) => t.id === planId || !known.has(t.id);
  return waitFor(() => {
    const tasks = queueTasks(proj.projectId).filter(mine);
    const fine = tasks.filter((t) => !t.id.startsWith('plan:'));
    const plan = tasks.find((t) => t.id === planId);
    if (!plan || plan.state !== 'done' || fine.length === 0) return null;
    if (fine.some((t) => t.state === 'open' || t.state === 'claimed')) return null;
    return { tasks: fine.length, done: fine.filter((t) => t.state === 'done').length, failed: fine.filter((t) => t.state === 'failed').length, claimedBy: [...new Set(tasks.map((t) => t.claimedBy ?? t.nodeId ?? t.holder ?? null).filter(Boolean))], sample: fine.slice(0, 2).map((t) => ({ id: String(t.id).slice(0, 60), state: t.state, requires: t.requires })) };
  }, ms, `项目${proj.label}的计划与细任务做完`, 300);
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
    // 两个工作进程合起来的内存上限：管理进程自己量进程树的常驻内存（没有 cgroup 时），Windows 上工作集把共享页重复计入，
    // 两棵树空着就量出 7 GB 上下；演练不验内存上限（那是整套演练 limits 一步的事），放宽到不触发
    PROMPTCUT_RENDER_MEMORY_MAX: MEMORY_MAX, PROMPTCUT_RENDER_MEMORY_HIGH: MEMORY_MAX,
    PROMPTCUT_RENDER_EDITOR_DIR: path.join(TMP, 'no-editor'),
    // 换项目快一点：闲置 8 s 就结束这一轮（生产缺省 60 s）
    PROMPTCUT_RENDER_ISO_IDLE_MS: String(T(8000)),
    // 预渲染进程的全部输出（含渲染页的页面日志）追加进这个文件：探针从这里取回越权探测卡的结果对象
    PROMPTCUT_PRERENDER_LOG: PRERENDER_LOG,
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
      if (VERBOSE || (j && !['worker.line'].includes(j.event))) process.stderr.write(`[render] ${scrub(line.slice(0, 500))}\n`);
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

/* ------------------------------------------------------------------ 取回结果对象 */
const prerenderText = () => { try { return fs.readFileSync(PRERENDER_LOG, 'utf8').replace(/@\d{13} /g, ''); } catch { return ''; } };
/** 页面日志里的 `OVERREACH-RESULT <tag> <run> <i>/<n> <base64>`：按出现顺序拼回各份结果对象 */
function reportsFrom(text) {
  const out = [];
  let cur = null;
  for (const m of text.matchAll(/OVERREACH-RESULT (\S+) (\S+) (\d+)\/(\d+) ([A-Za-z0-9+/=]+)/g)) {
    const [, tag, , i, n, b64] = m;
    if (Number(i) === 1) cur = { tag, n: Number(n), parts: [] };
    if (!cur || cur.tag !== tag) continue;
    cur.parts[Number(i) - 1] = b64;
    if (Number(i) === cur.n) {
      try { out.push({ ...JSON.parse(Buffer.from(cur.parts.join(''), 'base64').toString('utf8')), raw: Buffer.from(cur.parts.join(''), 'base64').toString('utf8') }); } catch { out.push({ tag, broken: true, items: {}, raw: '' }); }
      cur = null;
    }
  }
  return out;
}
const listDir = (dir) => { const out = []; const walk = (d, rel) => { let items = []; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of items) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r); } }; walk(dir, ''); return out.sort(); };

/* ------------------------------------------------------------------ 项目内容 */
function projectOf(proj, clips, extra = {}) {
  return {
    id: proj.docId, name: `隔离探针 · 项目${proj.label}`, width: 1920, height: 1080, fps: FPS, duration: 2,
    themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {}, ...extra,
    tracks: clips.map((c, i) => ({ id: `tr-${i}`, name: `tr-${i}`, hidden: false, clips: [{ id: c.id, kind: 'card', cardId: c.cardId, start: 0, end: 2, params: c.params ?? {} }] })),
  };
}

/* ------------------------------------------------------------------ 主流程 */
const out = { ok: false, run: RUN, platform: process.platform, cores: CORES, timeScale: SCALE, ports: PORTS };

async function main() {
  for (const d of [HOSTED_DATA, OUTSIDE_DIR, RENDER_DATA]) fs.mkdirSync(d, { recursive: true });
  await new Promise((resolve, reject) => { collectorSrv.once('error', reject); collectorSrv.listen(PORTS.collector, '127.0.0.1', resolve); });
  await new Promise((resolve) => collectorUdp.bind(PORTS.collector, '127.0.0.1', resolve));
  say('start', { tmp: TMP, ports: PORTS, timeScale: SCALE });

  combo = await startHostedCombo({
    dataDir: HOSTED_DATA, docPort: PORTS.doc, assetPort: PORTS.asset, host: '127.0.0.1',
    trustLoopback: false, clusterToken: randomBytes(32).toString('base64url'),
    assetPublicUrl: `http://127.0.0.1:${PORTS.asset}/api/asset`,
    log: (event, fields) => { if (VERBOSE || /error|reject|revoked/.test(event)) say(`hosted.${event}`, fields); },
  });
  runKeygen(['--hosted-data', HOSTED_DATA, '--secrets', RENDER_SECRETS, '--instance-name', '托管方的渲染节点（隔离探针）']);

  // ---------- 假凭证
  const F = {
    keydir: fake('F1-KEYDIR'), registry: fake('F2-REGISTRY'), envSecret: fake('F3-ENV-SECRETNAME'), envPlain: fake('F3-ENV-PLAINNAME'),
    outside: fake('F4-OUTSIDE'), resident: fake('F5-RESIDENT-DATA'), yiContent: fake('F6-YI-CONTENT'), yiAsset: fake('F7-YI-ASSET'), yiCard: fake('F8-YI-CARD'),
  };
  fakes.set('PROBE-FAKE-JIA-CARD-CODE-7d1f0c', 'JIA-MARKER-CARD');
  fakes.set('PROBE-FAKE-NODE-EXEC-MARK', 'NODE-SIDE-EXECUTED');
  out.fakeCredentials = [...fakes.values()];
  const files = {
    keydir: path.join(RENDER_SECRETS, 'probe-fake-private-key.pem'),
    registry: path.join(path.dirname(hostedPaths(HOSTED_DATA).servicesFile), 'probe-fake-next-to-registry.json'),
    outside: path.join(OUTSIDE_DIR, 'probe-fake-outside.json'),
    resident: path.join(RENDER_DATA, 'probe-fake-resident-data.json'),
  };
  fs.writeFileSync(files.keydir, `-----BEGIN PROBE FAKE KEY-----\n${F.keydir}\n-----END PROBE FAKE KEY-----\n`);
  fs.writeFileSync(files.registry, JSON.stringify({ fake: F.registry }));
  fs.writeFileSync(files.outside, JSON.stringify({ secret: F.outside }));
  fs.writeFileSync(files.resident, JSON.stringify({ secret: F.resident }));

  startSupervisor({ PROBE_FAKE_MANAGER_TOKEN: F.envSecret, PROBE_FAKE_MANAGER_NOTE: F.envPlain });
  const ready = await Promise.race([
    waitFor(async () => { const s = await status(); return s.directory?.connected && s.worker?.ready && s.queue ? s : null; }, 300_000, '渲染服务就绪', 1000),
    supervisor.exited.then((code) => { throw new Error(`渲染服务退出了（退出码 ${code}）`); }),
  ]);
  const codeVersion = ready.queue.codeVersion;
  out.codeVersion = String(codeVersion).slice(0, 12);
  out.residentCapabilities = ready.queue.capabilities;
  say('ready', { codeVersion: out.codeVersion, isolation: ready.isolation?.enabled, userCards: ready.userCards });

  // ---------- 两个项目与夹具
  const jia = await makeProject('甲', 'alice', 'jia');
  const yi = await makeProject('乙', 'bob', 'yi');
  const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  const posix = (p) => p.replace(/\\/g, '/');
  const outsideAbs = posix(files.outside);
  // 从用户卡目录走到那个文件的相对路径（盘符不同时相对路径不存在，就用足够多的 ..）
  const relToOutside = `${'../'.repeat(16)}${outsideAbs.replace(/^[A-Za-z]:\//, '').replace(/^\//, '')}`;
  const fillNodeSide = (text) => text.replaceAll('__OUTSIDE_DIR_REL__', relToOutside.replace(/\/[^/]+$/, '')).replaceAll('__OUTSIDE_REL__', relToOutside)
    .replaceAll('__OUTSIDE_DIR__', posix(OUTSIDE_DIR)).replaceAll('__OUTSIDE__', outsideAbs);
  const probeCard = read('overreach-probe.tsx');
  const probeLib = read('overreach-probe-lib.ts');
  for (const proj of [jia, yi]) {
    await putCard(proj, 'src/cards/user/overreach-probe.tsx', probeCard);
    await putCard(proj, 'src/cards/user/overreach-probe-lib.ts', probeLib);
  }
  await putCard(jia, 'src/cards/user/overreach-marker-jia.tsx', read('overreach-marker-jia.tsx'));
  await putCard(jia, 'src/cards/user/overreach-graph.tsx', read('overreach-graph.tsx'));
  await putCard(jia, 'src/cards/user/overreach-node-side.css', fillNodeSide(read('overreach-node-side.css')));
  await putCard(jia, 'src/cards/user/overreach-node-side.ts', fillNodeSide(read('overreach-node-side.ts')));
  // 乙独有的一张卡，源码里带 F8（甲不该读到）
  await putCard(yi, 'src/cards/user/overreach-yi-only.tsx', read('overreach-marker-jia.tsx').replaceAll('overreach-marker-jia', 'overreach-yi-only').replaceAll('overreachMarkerJia', 'overreachYiOnly')
    .replaceAll('marker-jia', 'yi-only').replaceAll('PROBE-FAKE-JIA-CARD-CODE-7d1f0c', F.yiCard));
  // 乙的素材：一块带 F7 的字节，凭乙的成员票据写进素材服务
  const yiTicket = await yi.conn.ask({ type: 'auth.ticket', kind: 'asset', access: 'rw' });
  const yiAssets = createAssetClient({ base: `http://127.0.0.1:${PORTS.asset}/api/asset`, ticket: async () => yiTicket.ticket });
  const yiBlob = await yiAssets.put('media', Buffer.from(`probe asset of project yi ${F.yiAsset}\n`), { ext: 'txt' });
  // 甲自己的一块素材（对照：探测卡读自己项目的素材应该读得到）
  const OWN_MARK = `PROBE-OWN-JIA-ASSET-${randomBytes(6).toString('hex')}`;
  const jiaRw = await jia.conn.ask({ type: 'auth.ticket', kind: 'asset', access: 'rw' });
  const jiaBlob = await createAssetClient({ base: `http://127.0.0.1:${PORTS.asset}/api/asset`, ticket: async () => jiaRw.ticket }).put('media', Buffer.from(`probe asset of project jia ${OWN_MARK}\n`), { ext: 'txt' });
  // 残余面 1 的判法：甲的成员凭自己的票据能不能直接按哈希读到乙的这一块
  const jiaTicket = await jia.conn.ask({ type: 'auth.ticket', kind: 'asset', access: 'r' });
  const direct = await fetch(`http://127.0.0.1:${PORTS.asset}/api/asset/media/${yiBlob.hash}`, { headers: { authorization: `Bearer ${jiaTicket.ticket}` } });
  const memberCanReadByHash = direct.status === 200 && (await direct.text()).includes(F.yiAsset);
  out.memberCanReadOtherProjectBlobByHash = memberCanReadByHash;

  const ctxOf = (tag, other) => ({
    tag,
    ...(tag === 'jia' ? { ownAssetHash: jiaBlob.hash } : {}),
    loopback: {
      managerStatus: `${STATUS}/status`, managerBroker: `${STATUS}/projects`,
      residentEditor: `http://127.0.0.1:${PORTS.worker}/api/frames/queue`, residentStage: `http://127.0.0.1:${PORTS.worker + 1}/`,
      ownEditor: `http://127.0.0.1:${PORTS.iso}/api/frames/queue`, ownEditorCards: `http://127.0.0.1:${PORTS.iso}/api/cards/sync/status`,
      docService: `http://127.0.0.1:${PORTS.doc}/healthz`, assetService: `http://127.0.0.1:${PORTS.asset}/api/asset/media/${other.hash ?? '0'.repeat(64)}`,
    },
    collector: COLLECTOR, metadata: METADATA,
    outsideFiles: [files.outside, files.keydir, files.registry, files.resident],
    other: { projectId: other.projectId, docId: other.docId, assetHash: other.hash },
    foreignCardFiles: other.cardFiles,
  });
  const jiaProject = projectOf(jia, [
    { id: 'clip-probe', cardId: 'overreach-probe', params: { ctx: ctxOf('jia', { projectId: yi.projectId, docId: yi.docId, hash: yiBlob.hash, cardFiles: ['src/cards/user/overreach-yi-only.tsx'] }) } },
    { id: 'clip-marker', cardId: 'overreach-marker-jia' },
    { id: 'clip-graph', cardId: 'overreach-graph', params: { ctx: ctxOf('jia', { projectId: yi.projectId, docId: yi.docId, hash: yiBlob.hash, cardFiles: [] }) } },
    { id: 'clip-builtin', cardId: 'r6-stateful' },
  ]);
  const yiProject = projectOf(yi, [
    { id: 'clip-probe', cardId: 'overreach-probe', params: { ctx: ctxOf('yi', { projectId: jia.projectId, docId: jia.docId, cardFiles: ['src/cards/user/overreach-marker-jia.tsx', 'src/cards/user/overreach-graph.tsx'] }) } },
    { id: 'clip-yi-only', cardId: 'overreach-yi-only' },
  ], { name: `隔离探针 · 项目乙 ${F.yiContent}`, notes: F.yiContent });
  const jiaRev = await putProject(jia, jiaProject);
  const yiRev = await putProject(yi, yiProject);

  // ---------- 渲甲
  say('render', { project: '甲' });
  const isoSeen = { profileDirs: new Set(), overlayJia: new Set(), overlayYi: new Set(), isoPids: new Set(), cardSync: {} };
  const watcher = setInterval(async () => {
    try {
      const s = await status();
      const cur = s.isolation?.current?.projectId;
      if (s.isolation?.worker?.pid) isoSeen.isoPids.add(s.isolation.worker.pid);
      const overlay = listDir(path.join(ISO_DATA, 'data', 'card-overrides'));
      if (cur === jia.projectId) for (const f of overlay) isoSeen.overlayJia.add(f);
      if (cur === yi.projectId) for (const f of overlay) isoSeen.overlayYi.add(f);
      for (const name of (() => { try { return fs.readdirSync(path.join(ISO_DATA, 'tmp')); } catch { return []; } })()) if (/chrome|puppeteer/i.test(name)) isoSeen.profileDirs.add(name);
      for (const cs of s.isolation?.queue?.cardSync ?? []) if (cs?.projectId) isoSeen.cardSync[cs.projectId] = cs;
      if (s.isolation?.queue) isoSeen.lastIsoQueue = s.isolation.queue;
    } catch { /* 这一拍没问到 */ }
  }, 400);

  const jiaPlan = await publishPlan(jia, { rev: jiaRev, clips: jiaProject.tracks.flatMap((t) => t.clips.map((c) => c.id)), codeVersion });
  let jiaDone = null;
  try { jiaDone = await waitRendered(jia, jiaPlan); } catch (err) { out.jiaError = String(err?.message ?? err); }
  const sJia = await status();
  const residentJia = (sJia.queue?.nodes ?? []).find((n) => n.projectId === jia.projectId) ?? null;
  const isoJia = (sJia.isolation?.queue?.nodes ?? isoSeen.lastIsoQueue?.nodes ?? []).find((n) => n.projectId === jia.projectId) ?? null;
  out.jia = { done: jiaDone, resident: residentJia && { claimed: residentJia.claimed, hold: residentJia.hold, cards: residentJia.cards, pending: residentJia.pending }, iso: isoJia && { nodeId: isoJia.nodeId, claimed: isoJia.claimed, completed: isoJia.completed, failed: isoJia.failed }, isoCapabilities: (sJia.isolation?.queue ?? isoSeen.lastIsoQueue)?.capabilities ?? null, pageGate: (sJia.isolation?.queue ?? isoSeen.lastIsoQueue)?.pageGate ?? null };
  const jiaMap = await jia.conn.ask({ type: 'content.get', kind: 'snapshot-manifest', key: `layers:${jia.docId}` });

  // ---------- 渲乙（隔离工作进程要先结束甲那一轮、清空，再为乙起）
  say('render', { project: '乙' });
  const markSwitch = supLogs.length;
  const yiPlan = await publishPlan(yi, { rev: yiRev, clips: yiProject.tracks.flatMap((t) => t.clips.map((c) => c.id)), codeVersion });
  let gap = null;
  try {
    gap = await waitFor(async () => {
      const s = await status();
      // 两轮之间：没有在跑的隔离工作进程，磁盘上数据目录是空的
      if (!s.isolation?.current && s.isolation?.lastRun?.projectId === jia.projectId) return { dataLeft: s.isolation.dataLeft, lastRun: s.isolation.lastRun, onDisk: listDir(ISO_DATA).filter((f) => f !== '.promptcut-render-iso') };
      if (s.isolation?.current?.projectId === yi.projectId) return { missed: true, lastRun: s.isolation.lastRun };
      return null;
    }, 180_000, '隔离工作进程结束甲那一轮', 100);
  } catch (err) { out.switchError = String(err?.message ?? err); }
  let yiDone = null;
  try { yiDone = await waitRendered(yi, yiPlan); } catch (err) { out.yiError = String(err?.message ?? err); }
  const sYi = await status();
  const residentYi = (sYi.queue?.nodes ?? []).find((n) => n.projectId === yi.projectId) ?? null;
  const isoYi = (sYi.isolation?.queue?.nodes ?? isoSeen.lastIsoQueue?.nodes ?? []).find((n) => n.projectId === yi.projectId) ?? null;
  out.yi = { done: yiDone, resident: residentYi && { claimed: residentYi.claimed, hold: residentYi.hold, cards: residentYi.cards }, iso: isoYi && { nodeId: isoYi.nodeId, claimed: isoYi.claimed, completed: isoYi.completed, failed: isoYi.failed } };
  await delay(1500);
  clearInterval(watcher);

  // ---------- 取回结果对象
  const text = prerenderText();
  const reports = reportsFrom(text);
  const jiaReports = reports.filter((r) => r.tag === 'jia');
  const yiReports = reports.filter((r) => r.tag === 'yi');
  const graphReports = reports.filter((r) => /-graph$/.test(r.tag));
  out.reports = { jia: jiaReports.length, yi: yiReports.length, graph: graphReports.length, broken: reports.filter((r) => r.broken).length };
  const all = [...jiaReports, ...yiReports, ...graphReports];
  const itemsOf = (rs, prefix) => rs.flatMap((r) => Object.entries(r.items ?? {}).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ tag: r.tag, name: k, ...v })));
  const denied = (it) => it.ok === false || /^(403|404|401|400|500|502) /.test(it.got ?? '');
  const opaque = (it) => /^0 opaque/.test(it.got ?? '');
  const gateLines = [...text.matchAll(/\[page-gate\] (deny|would-deny|source-rejected|on) (\{.*\})/g)].map((m) => { try { return { kind: m[1], ...JSON.parse(m[2]) }; } catch { return { kind: m[1] }; } });
  const egressTo = new Set(gateLines.filter((l) => l.layer === 'egress').map((l) => String(l.to)));
  out.pageGate = { lines: gateLines.length, egressDestinations: [...egressTo].sort(), pageDenied: gateLines.filter((l) => l.layer === 'page').length, mode: gateLines.find((l) => l.kind === 'on')?.mode ?? null };

  /* ---- A */
  const isoDid = (node) => !!node && /^hosted-render-iso:/.test(String(node.nodeId)) && node.claimed > 0 && node.failed === 0;
  check('A1', '甲的任务由隔离工作进程（hosted-render-iso: 节点）认领并做完', !!jiaDone && jiaDone.done === jiaDone.tasks && jiaDone.failed === 0 && isoDid(isoJia), { done: jiaDone, iso: out.jia.iso, error: out.jiaError });
  check('A1', '乙的任务由隔离工作进程认领并做完', !!yiDone && yiDone.done === yiDone.tasks && yiDone.failed === 0 && isoDid(isoYi), { done: yiDone, iso: out.yi.iso, error: out.yiError });
  check('A1', '甲渲完后层表入库', jiaMap.type === 'content.item' && !jiaMap.missing && (jiaMap.body?.layers?.length ?? 0) > 0, { type: jiaMap.type, missing: jiaMap.missing, layers: jiaMap.body?.layers?.length });
  check('A1', '取回了甲、乙各至少一份结果对象，没有拼坏的', jiaReports.length >= 1 && yiReports.length >= 1 && out.reports.broken === 0, out.reports);
  const itemCount = jiaReports[0] ? Object.keys(jiaReports[0].items).length : 0;
  check('A1', '结果对象里固定清单的每一类都有记录（全局对象、存储、窗口、本机接口、回环、元数据、别的项目、收集站、工作目录以外的文件）',
    ['globals.', 'storage.', 'window.', 'self.', 'loopback.', 'metadata.', 'other.', 'collector.', 'outside['].every((p) => itemsOf(jiaReports.slice(0, 1), p).length > 0), { items: itemCount });
  check('A2', '常驻工作进程对甲、乙一个任务也没认领（搁着、报「有卡片代码」）', residentJia?.claimed === 0 && residentJia?.hold === true && residentJia?.cards?.state === 'some' && residentYi?.claimed === 0 && residentYi?.hold === true, { jia: out.jia.resident, yi: out.yi.resident });
  check('A2', '常驻工作进程不报 userCards，隔离工作进程报', out.residentCapabilities?.userCards === false && out.jia.isoCapabilities?.userCards === true, { resident: out.residentCapabilities, iso: out.jia.isoCapabilities });
  const own = itemsOf(all, 'other.overlayListing');
  check('A3', '对照：探测卡读自己这台预渲染 Vite 上的普通模块是通的（200），不是探针瞎了', own.length > 0 && own.every((it) => /^200 /.test(it.got ?? '')), own.slice(0, 1).map((it) => String(it.got).slice(0, 80)));
  const ownAsset = itemsOf(jiaReports.concat(graphReports), 'own.asset');
  check('A3', '对照：探测卡读自己项目的素材是通的（经工作进程凭本项目的票据取回，内容对）', ownAsset.length > 0 && ownAsset.every((it) => (it.got ?? '').includes(OWN_MARK)), ownAsset.slice(0, 1));

  /* ---- B～H：取回来的全部内容里有没有假凭证 */
  const rawAll = all.map((r) => r.raw).join('\n');
  // 甲的记号卡是甲自己的代码：甲的结果里出现它是应该的；乙的素材按残余面 1 判
  const allowJia = ['JIA-MARKER-CARD', ...(memberCanReadByHash ? ['F7-YI-ASSET'] : [])];
  const hitJia = [...new Set(jiaReports.concat(graphReports).flatMap((r) => fakesIn(r.raw, allowJia)))];
  const hitYi = [...new Set(yiReports.flatMap((r) => fakesIn(r.raw, ['F6-YI-CONTENT', 'F7-YI-ASSET', 'F8-YI-CARD'])))];
  check('B', '页面全局对象：没有假凭证、没有票据形状的串', itemsOf(all, 'globals.').every((it) => fakesIn(it.got ?? '').length === 0 && !TICKET_RE.test(it.got ?? '')), itemsOf(all, 'globals.').filter((it) => it.name !== 'globals.dump').slice(0, 4));
  check('C', 'localStorage / sessionStorage / indexedDB / cookie / Cache：没有假凭证', itemsOf(all, 'storage.').every((it) => fakesIn(it.got ?? '', ['JIA-MARKER-CARD']).length === 0 && !TICKET_RE.test(it.got ?? '')), itemsOf(all, 'storage.').slice(0, 5));
  check('C', '渲染用的 Chrome 的用户数据目录在隔离工作进程自己的数据目录里（随换项目清空）', isoSeen.profileDirs.size > 0, [...isoSeen.profileDirs].slice(0, 3));
  const win = Object.fromEntries(itemsOf(jiaReports.slice(0, 1), 'window.').map((it) => [it.name, it.got ?? it.err]));
  check('D', '父页面与同源的别的窗口：导出页自己就是顶层、没有 opener、没有别的框架可读', win['window.isTop'] === 'true' && win['window.opener'] === 'null' && itemsOf(all, 'window.').every((it) => fakesIn(it.got ?? '').length === 0), win);
  const selfItems = itemsOf(all, 'self.');
  const gated = (it) => it.ok === false || /^403 \S+ .*"error":"page-gate"/.test(it.got ?? '');
  check('E1', '自己这台预渲染 Vite 的 /api/**（清单里每一条，含写方法）与开发服务器的内部口：都被页面请求闸拒掉（403 page-gate）；WebSocket 升级被拒', selfItems.length >= 14 && selfItems.every(gated), selfItems.filter((it) => !gated(it)).slice(0, 4).concat(selfItems.slice(0, 2)));
  const loop = itemsOf(all, 'loopback.');
  // 子框架去打开别的源：载入了也读不到里面（跨源），或者载入的是出口代理的拒绝页
  const frameBlind = (it) => /\.frame$/.test(it.name) && /^(error|超时|load \(读不到\)|load\s*$|load egress blocked)/.test(it.got ?? '');
  const loopRead = loop.filter((it) => !denied(it) && !opaque(it) && !frameBlind(it));
  check('E2', '管理进程的状态口与代理口、常驻工作进程、自己的编辑器 Vite、文档服务、素材服务：页面读不到任何内容，WebSocket 连不上', loop.length > 0 && loopRead.length === 0, loopRead.slice(0, 4).concat(loop.slice(0, 3)));
  /*
   * 两层出口限制谁先拦下都算：浏览器按文档执行的出口白名单（页面日志里是 `ERR_NETWORK_ACCESS_REVOKED`，请求没有离开浏览器），
   * 或出口代理的拒绝记录（请求止于代理）。再核对代理确实在用（渲染页自己的请求都经它转）、它没有把任何请求转给别的目的地。
   */
  const revoked = (text.match(/ERR_NETWORK_ACCESS_REVOKED/g) ?? []).length;
  const egressStats = out.jia.pageGate?.egress ?? null;
  out.pageGate.revokedByAllowlist = revoked;
  out.pageGate.proxy = egressStats;
  check('E2', '出口限制生效：每一次向别的目的地的尝试都被浏览器的出口白名单或出口代理拦下；代理在用，且只把请求转给这台预渲染 Vite 自己',
    revoked + gateLines.filter((l) => l.layer === 'egress').length > 0 && (egressStats?.forwarded ?? 0) > 0, { revokedByAllowlist: revoked, deniedAtProxy: gateLines.filter((l) => l.layer === 'egress').length, proxy: egressStats });
  check('E2', '管理进程没有收到任何浏览器发来的请求', !supLogs.some((l) => l.event === 'broker.browser-refused'), supLogs.filter((l) => l.event === 'broker.browser-refused').length);
  const meta = itemsOf(all, 'metadata.');
  check('E3', '云厂商元数据地址：页面读不到任何内容（被出口限制拦下，没有连出去）', meta.length > 0 && meta.every((it) => it.ok === false), meta.slice(0, 2));
  check('F', '收集站（测试专用的外部地址）：0 条 TCP 连接、0 个 HTTP 请求、0 个 UDP 包', collector.tcp === 0 && collector.http.length === 0 && collector.udp === 0, { tcp: collector.tcp, http: collector.http.slice(0, 4), udp: collector.udp, attempts: itemsOf(all, 'collector.').length });
  const outside = itemsOf(all, 'outside[');
  const outsideHit = outside.filter((it) => fakesIn(`${it.got ?? ''}${it.err ?? ''}`).length > 0);
  // 回 200 的只能是开发服务器对「不认识的路径」统一回的首页（路径里的 .. 被浏览器先折掉了），不是那个文件
  const outside200 = outside.filter((it) => it.ok && /^200 /.test(it.got ?? '') && !/^200 \S+ <!doctype html>/i.test(it.got ?? ''));
  check('G1', '经开发服务器的各种取文件写法：工作目录以外的四个文件（私钥目录、登记表旁、临时文件、常驻工作进程的数据目录）一个都读不到', outside.length >= 40 && outsideHit.length === 0 && outside200.length === 0,
    outsideHit.concat(outside200).slice(0, 3).concat([{ attempts: outside.length, statuses: [...new Set(outside.map((it) => (it.ok ? String(it.got).slice(0, 3) : 'err')))] }]));
  const jiaSync = isoSeen.cardSync[jia.projectId] ?? null;
  const rejected = (jiaSync?.notices ?? []).filter((n) => /reject/i.test(String(n.type)) && /overreach-node-side/.test(String(n.key))).map((n) => n.key);
  const rejectedInLog = ['overreach-node-side.css', 'overreach-node-side.ts'].filter((f) => new RegExp(`(rejected|预检不过)[^\\n]{0,400}${f.replace('.', '\\.')}|${f.replace('.', '\\.')}[^\\n]{0,400}(rejected|预检不过)`).test(text));
  check('G2', '同步文件预检：overreach-node-side.css 与 .ts 被整份拒掉（卡片同步记被拒）', new Set([...rejected.map((k) => path.posix.basename(k)), ...rejectedInLog]).size === 2, { notices: (jiaSync?.notices ?? []).map((n) => `${n.type}:${path.posix.basename(String(n.key))}`), inLog: rejectedInLog });
  check('G2', '改动层里没有这两个文件；「在 Node 里被执行过」的记号没有出现在任何输出里', ![...isoSeen.overlayJia].some((f) => /overreach-node-side/.test(f)) && isoSeen.overlayJia.size > 0 && !text.includes('OVERREACH-NODE-SIDE-EXECUTED') && !supLogs.some((l) => JSON.stringify(l).includes('OVERREACH-NODE-SIDE-EXECUTED')), [...isoSeen.overlayJia]);
  check('H', '甲的结果里没有任何不该有的假凭证（节点上的、工作目录以外的、乙的内容与卡片源码）', hitJia.length === 0, hitJia);
  check('H', '乙的结果里没有任何不该有的假凭证（节点上的、工作目录以外的、甲的记号卡）', hitYi.length === 0, hitYi);
  check('H', '取回的全部内容里没有票据形状的串', !TICKET_RE.test(rawAll), '');
  const logsText = `${text}\n${supLogs.map((l) => JSON.stringify(l)).join('\n')}`;
  // 节点上的假凭证（F1～F5）在任何输出里都不该有。乙的东西（F6～F8）只会出现在乙自己那一轮的输出里——渲乙的页面地址里带着乙的项目内容，
  // 这份日志是探针要来的全量输出；所以只核对「乙那一轮开始之前」的输出里没有乙的东西
  const NODE_LEVEL = ['F1-KEYDIR', 'F2-REGISTRY', 'F3-ENV-SECRETNAME', 'F3-ENV-PLAINNAME', 'F4-OUTSIDE', 'F5-RESIDENT-DATA', 'NODE-SIDE-EXECUTED'];
  const inLogs = fakesIn(logsText).filter((label) => NODE_LEVEL.includes(label));
  const beforeYi = text.slice(0, Math.max(0, text.indexOf(yi.docId)));
  const yiBeforeItsTurn = fakesIn(beforeYi).filter((label) => ['F6-YI-CONTENT', 'F8-YI-CARD', ...(memberCanReadByHash ? [] : ['F7-YI-ASSET'])].includes(label));
  check('H', '工作进程与管理进程的全部输出里没有节点上的假凭证（环境变量里的两个、私钥目录、登记表旁、工作目录以外、常驻工作进程的数据目录）', inLogs.length === 0, inLogs);
  check('H', '乙那一轮开始之前的全部输出里没有乙的内容与卡片源码', text.includes(yi.docId) && yiBeforeItsTurn.length === 0, yiBeforeItsTurn);

  /* ---- I */
  const ended = supLogs.slice(markSwitch).filter((l) => l.event === 'isolation.ended' && l.projectId === jia.projectId).at(-1) ?? supLogs.filter((l) => l.event === 'isolation.ended' && l.projectId === jia.projectId).at(-1);
  check('I', '换项目之前：甲那一轮结束并清空（管理进程记 cleaned），两轮之间磁盘上数据目录是空的', ended?.cleaned === true && !!gap && (gap.missed === true ? gap.lastRun?.cleaned === true : gap.dataLeft === 0 && gap.onDisk.length === 0), { ended: ended && { reason: ended.reason, cleaned: ended.cleaned, worked: ended.worked }, gap });
  const pidsAlive = [...isoSeen.isoPids].filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  await stopIsoWait();
  const pidsAfter = [...isoSeen.isoPids].filter((pid) => treeAlive(pid).length > 0);
  check('I', '隔离工作进程每一轮各是一个新进程，结束后进程树不剩', isoSeen.isoPids.size >= 2 && pidsAfter.length === 0, { rounds: isoSeen.isoPids.size, aliveBeforeStop: pidsAlive.length, aliveAfter: pidsAfter });
  const yiOverlay = [...isoSeen.overlayYi];
  check('I', '乙那一轮的改动层里只有乙的卡（没有甲的任何文件）', yiOverlay.length > 0 && !yiOverlay.some((f) => /marker-jia|overreach-graph|node-side/.test(f)), yiOverlay);
  const yiMarkers = itemsOf(yiReports, 'other.loadedMarkers');
  const yiForeign = itemsOf(yiReports, 'other.card ');
  const yiListing = itemsOf(yiReports, 'other.overlayListing');
  check('I', '乙的页面里没有甲的卡片代码：甲的记号卡没有载入、取不到它的文件、用户卡清单里没有它',
    yiMarkers.length > 0 && yiMarkers.every((it) => !/marker-jia|overreach-graph/.test(it.got ?? '')) && yiForeign.length > 0 && yiForeign.every((it) => denied(it) || !/overreachMarkerJia|overreachGraph/.test(it.got ?? ''))
    && yiListing.every((it) => !/marker-jia|overreach-graph/.test(it.got ?? '')), { markers: yiMarkers[0]?.got, foreign: yiForeign.map((it) => `${it.name}=${String(it.got ?? it.err).slice(0, 40)}`) });

  /* ---- J */
  const key = readServiceKeyFile(RENDER_SECRETS);
  const control = connect(await buildServiceProtocols({ base: DOC_WS, key }));
  await control.opened;
  const tk = await control.ask({ type: 'hosted.ticket', projectId: jia.projectId });
  const data = connect(ticketProtocols(tk.ticket));
  await data.opened;
  const before = await jia.conn.ask({ type: 'project.open', projectId: jia.docId });
  const outcome = async (message) => { const m = await data.ask(message); return m.type === 'error' ? `error:${m.reason}` : m.type; };
  const edit = await outcome({ type: 'project.op', projectId: jia.docId, opId: `iso-evil-${RUN}`, session: 's-iso', ops: [{ op: 'set', path: '/name', value: 'changed-by-render' }] });
  const cardPut = await outcome({ type: 'content.put', kind: 'card-source', key: 'src/cards/user/by-render.tsx', body: 'x' });
  const after = await jia.conn.ask({ type: 'project.open', projectId: jia.docId });
  check('J', '以渲染身份提交编辑、写卡片源码都被拒，项目版本号不变', edit === 'error:forbidden' && cardPut === 'error:forbidden' && before.rev === after.rev, { edit, cardPut, revBefore: before.rev, revAfter: after.rev });
  data.close();
  control.close();

  /* ---- K */
  const noKey = await fetch(`${STATUS}/projects`).then((r) => r.status).catch(() => 0);
  const asBrowser = await fetch(`${STATUS}/status`, { headers: { 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:1' } }).then((r) => r.status).catch(() => 0);
  const statusText = JSON.stringify(await status());
  check('K', '代理口：不带口令要清单 401；浏览器形状的请求连状态口也 403；状态口的输出里没有假凭证与票据', noKey === 401 && asBrowser === 403 && fakesIn(statusText).length === 0 && !TICKET_RE.test(statusText), { noKey, asBrowser, fakes: fakesIn(statusText) });

  /* ---- P 对照段：只留出口代理一层（不发出口白名单头），同一张探测卡再渲一遍 */
  if (!flag('--no-proxy-only')) {
    say('proxy-only', {});
    await stopSupervisor();
    const mark = prerenderText().length;
    const supMark = supLogs.length;
    const collectorBefore = { tcp: collector.tcp, http: collector.http.length, udp: collector.udp };
    startSupervisor({ PROBE_FAKE_MANAGER_TOKEN: F.envSecret, PROBE_FAKE_MANAGER_NOTE: F.envPlain, PROMPTCUT_TEST_NO_EGRESS_HEADER: '1' });
    await waitFor(async () => { const s = await status(); return s.directory?.connected && s.worker?.ready && s.queue ? s : null; }, 300_000, '渲染服务就绪（对照段）', 1000);
    const bing = await makeProject('丙', 'carol', 'bing');
    await putCard(bing, 'src/cards/user/overreach-probe.tsx', probeCard);
    await putCard(bing, 'src/cards/user/overreach-probe-lib.ts', probeLib);
    const bingProject = projectOf(bing, [{ id: 'clip-probe', cardId: 'overreach-probe', params: { ctx: ctxOf('bing', { projectId: yi.projectId, docId: yi.docId, cardFiles: [] }) } }]);
    const bingRev = await putProject(bing, bingProject);
    const bingPlan = await publishPlan(bing, { rev: bingRev, clips: ['clip-probe'], codeVersion });
    let bingDone = null;
    try { bingDone = await waitRendered(bing, bingPlan); } catch (err) { out.bingError = String(err?.message ?? err); }
    await delay(1500);
    const part = prerenderText().slice(mark);
    const bingReports = reportsFrom(part).filter((r) => r.tag === 'bing');
    const bingLoop = itemsOf(bingReports, 'loopback.').concat(itemsOf(bingReports, 'metadata.'));
    const bingRead = bingLoop.filter((it) => !denied(it) && !opaque(it) && !frameBlind(it));
    const partGate = [...part.matchAll(/\[page-gate\] (deny|on) (\{.*\})/g)].map((m) => { try { return { kind: m[1], ...JSON.parse(m[2]) }; } catch { return { kind: m[1] }; } });
    const proxyDenied = partGate.filter((l) => l.kind === 'deny' && l.layer === 'egress');
    const headerOff = partGate.some((l) => l.kind === 'on' && l.role === 'prerender' && l.egressHeader === false);
    const revokedP = (part.match(/ERR_NETWORK_ACCESS_REVOKED/g) ?? []).length;
    out.proxyOnly = { done: bingDone, reports: bingReports.length, headerOff, revokedByAllowlist: revokedP, deniedAtProxy: proxyDenied.length, destinations: [...new Set(proxyDenied.map((l) => String(l.to)))].sort(),
      collector: { tcp: collector.tcp - collectorBefore.tcp, http: collector.http.length - collectorBefore.http, udp: collector.udp - collectorBefore.udp } };
    check('P', '对照段成立：出口白名单头确实没发、探测卡照样渲完并交回结果', headerOff && revokedP === 0 && !!bingDone && bingDone.failed === 0 && bingReports.length >= 1, { headerOff, revokedP, done: bingDone, reports: bingReports.length, error: out.bingError });
    const wantDest = [STATUS, `http://127.0.0.1:${PORTS.worker}`, `http://127.0.0.1:${PORTS.iso}`, `http://127.0.0.1:${PORTS.doc}`, `http://127.0.0.1:${PORTS.asset}`, COLLECTOR, 'http://169.254.169.254'];
    const missed = wantDest.filter((d) => !out.proxyOnly.destinations.includes(d));
    check('P', '只靠出口代理一层：管理进程、常驻工作进程、自己的编辑器 Vite、文档服务、素材服务、元数据地址、收集站——每个目的地在代理的拒绝记录里都有，请求止于代理', missed.length === 0, { missed, seen: out.proxyOnly.destinations });
    check('P', '只靠出口代理一层：页面仍然读不到任何内容，收集站仍然 0 条 TCP 连接、0 个 HTTP 请求、0 个 UDP 包', bingLoop.length > 0 && bingRead.length === 0 && out.proxyOnly.collector.tcp === 0 && out.proxyOnly.collector.http === 0 && out.proxyOnly.collector.udp === 0
      && fakesIn(bingReports.map((r) => r.raw).join('\n')).length === 0, { read: bingRead.slice(0, 3), collector: out.proxyOnly.collector });
    check('P', '对照段里管理进程同样没有收到任何浏览器发来的请求', !supLogs.slice(supMark).some((l) => l.event === 'broker.browser-refused'), '');
  }

  /* ---- 残余面与图卡 */
  const assetItems = itemsOf(jiaReports, 'other.asset.');
  const cardGotYiAsset = assetItems.some((it) => (it.got ?? '').includes(F.yiAsset));
  residual.push({ id: 1, what: '素材按哈希寻址', memberCanReadOtherProjectBlobByHash: memberCanReadByHash, cardReadIt: cardGotYiAsset, routes: assetItems.map((it) => `${it.name}=${short(it.got ?? it.err).slice(0, 60)}`) });
  if (!memberCanReadByHash) check('H', '乙的素材：甲的成员直接读不到，探测卡也读不到', !cardGotYiAsset, assetItems.slice(0, 3));
  residual.push({ id: 2, what: '外传本项目内容', collector: { tcp: collector.tcp, http: collector.http.length, udp: collector.udp }, note: '隔离工作进程的渲染页连不上任何外部地址，本项目的内容也带不走' });
  residual.push({ id: 3, what: '名字不像秘密的环境变量会被工作进程继承', inResults: fakesIn(rawAll).includes('F3-ENV-PLAINNAME'), inLogs: fakesIn(logsText).includes('F3-ENV-PLAINNAME') });
  const graphEvaluated = /OVERREACH-GRAPH-EVALUATED/.test(text);
  out.graph = { cardEvaluated: graphEvaluated, reports: graphReports.length, loadedWithUserCards: itemsOf(jiaReports, 'other.loadedMarkers').some((it) => /overreach-graph/.test(it.got ?? '')), resultsClean: graphReports.every((r) => fakesIn(r.raw, allowJia).length === 0) };
  residual.push({ id: 4, what: '图卡', ...out.graph });
  out.sample = Object.fromEntries(Object.entries(jiaReports[0]?.items ?? {}).map(([k, v]) => [k, scrub(String(v.ok ? v.got : `✗ ${v.err}`).slice(0, 90))]));
}

/** 等隔离工作进程闲置结束（两轮都做完之后），好核对进程树 */
async function stopIsoWait() {
  try { await waitFor(async () => { const s = await status(); return !s.isolation?.current ? s : null; }, 120_000, '隔离工作进程闲置结束', 500); } catch { /* 核对那一条会不过 */ }
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
  try { collectorSrv.close(); collectorSrv.closeAllConnections?.(); collectorUdp.close(); } catch { /* 已关 */ }
  // 自己起的进程与端口都要收干净
  out.leftover = { ports: [] };
  for (const port of [PORTS.worker, PORTS.worker + 1, PORTS.worker + 2, PORTS.iso, PORTS.iso + 1, PORTS.iso + 2, PORTS.status, PORTS.doc, PORTS.asset]) {
    const busy = await new Promise((resolve) => { const s = http.createServer(); s.once('error', () => resolve(true)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(false))); });
    if (busy) out.leftover.ports.push(port);
  }
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* 有文件还被占着，留给系统清 */ } } else out.tmp = TMP;
}
out.pass = checks.filter((c) => c.ok).length;
out.fails = fails;
out.checks = checks;
out.residual = residual;
process.stdout.write(`${scrub(JSON.stringify(out))}\n`);
process.exit(exitCode);
