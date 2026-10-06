#!/usr/bin/env node
/**
 * 托管方渲染服务的管理进程（契约 `docs/plan/hosted-render-contract.md` 第 7 节）。PM2 里的 `promptcut-render`。
 *
 *   node server/hosted-render/main.mjs            常驻
 *   node server/hosted-render/main.mjs --check    只做启动自检，打结果后退出（0 过，78 不过）
 *
 * 它持服务私钥、连目录（控制连接）、起并看护工作进程（`scripts/render-host.mjs` 的代理模式）、管背压与内存上限、
 * 比代码版本、给诊断。它不引 Vite、不跑任何卡片代码；工作进程里没有私钥，只经本机代理口拿两分钟的连接票据。
 *
 * 环境变量（都有缺省；PM2 配置由部署脚本生成，不含任何秘密）：
 *   PROMPTCUT_RENDER_DOC_URL          文档服务的本机地址，缺省 ws://127.0.0.1:8787（直连，不经 nginx）
 *   PROMPTCUT_RENDER_SECRETS          私钥目录，缺省 /var/lib/promptcut/render-secrets
 *   PROMPTCUT_RENDER_DATA             工作进程的数据目录，缺省 /var/lib/promptcut/render。Vite 的依赖预构建缓存也放这里（`<数据目录>/vite-cache`，
 *                                     经 PROMPTCUT_VITE_CACHE_DIR 交给工作进程）：发布目录属 root、工作进程以服务用户跑时检出目录它写不了
 *   PROMPTCUT_RENDER_PORT             工作进程的端口（另占 +1、+2），缺省 5400
 *   PROMPTCUT_RENDER_STATUS_PORT      管理进程的诊断与代理口（只绑回环），缺省 5399
 *   PROMPTCUT_RENDER_MAX_CONCURRENT   并发任务数 1～4，缺省 2
 *   PROMPTCUT_RENDER_MAX_PROJECTS     同时连着的项目数，缺省 16
 *   PROMPTCUT_RENDER_MEMORY_MAX / _MEMORY_HIGH   内存硬上限与节流线，缺省 6G / 5G
 *   PROMPTCUT_RENDER_CPU_QUOTA        缺省 400%
 *   PROMPTCUT_RENDER_LOAD_HIGH        背压的 1 分钟负载线，缺省等于这台机器的核数（8 核就是 8）
 *   PROMPTCUT_RENDER_MEM_LOW          背压的可用内存线，本机可用内存低于它就暂停认领，缺省 2G
 *   PROMPTCUT_RENDER_USER             工作进程用的系统用户（只在有 systemd 时经 --uid 生效）；空表示与管理进程同一用户
 *   PROMPTCUT_RENDER_CGROUP           auto（缺省：有 systemd 与 cgroup v2 就用）| off
 *   PROMPTCUT_RENDER_USER_CARDS       isolated（缺省）| off。isolated：内容库里有卡片源码的项目由按项目隔离的工作进程做（契约第 7.5 节）；
 *                                     off：不起隔离工作进程，含用户卡的任务渲染服务不认领（常驻工作进程两种取值下都不同步卡）
 *   PROMPTCUT_RENDER_ISO_PORT         隔离工作进程的端口（另占 +1、+2），缺省 PROMPTCUT_RENDER_PORT + 10。它的数据目录是 <PROMPTCUT_RENDER_DATA>/iso
 *   PROMPTCUT_RENDER_ISO_IDLE_MS / _ISO_SLICE_MS   测试与演练用：隔离工作进程闲置多久结束（缺省 60000）、另有项目在等时一个项目最多连续做多久（缺省 300000）
 *   PROMPTCUT_PAGE_GATE               log：工作进程的页面请求闸与出口代理只记不拦（排查用；缺省 enforce）。不是 PROMPTCUT_RENDER_ 开头，原样传给工作进程
 *   PROMPTCUT_RENDER_EDITOR_DIR       在线页面构建所在目录（比代码版本用），缺省 /opt/promptcut-hosted/editor
 *   PROMPTCUT_RENDER_EXPECT_CODE_VERSION   直接给应该一致的代码版本（取不到在线页面构建时用）
 *   PROMPTCUT_RENDER_AGENT_STATUS_URL      云端 Agent 服务的诊断口（回 { codeVersion }）；没配就不比
 *   PROMPTCUT_RENDER_DOC_HEALTH_URL   背压用的文档服务自检地址，缺省由 DOC_URL 推出 http://…/healthz
 *   PROMPTCUT_RENDER_STREAMS          1 开轨道流（缺省不开）
 *   PROMPTCUT_RENDER_VERBOSE          1 把工作进程的输出原样转出来
 *   PROMPTCUT_RENDER_REPORT_TIMEOUT_MS  工作进程起来后这么久没交过诊断（或中途停交）就结束它重起，缺省 180000
 *   测试用：PROMPTCUT_RENDER_SAMPLE_MS（采样间隔）、PROMPTCUT_RENDER_SKIP_CHECKS（逗号分隔，跳过自检里的 chrome / ffmpeg）、
 *   PROMPTCUT_TEST_ENV_FINGERPRINT（原样传给工作进程，本机演练里让它的指纹与本机桌面不同）
 *
 * 日志：一行一条 JSON 写 stdout（PM2 收走）；自检不过另写 stderr。不记私钥、签名、票据。
 * 退出：SIGINT / SIGTERM → 工作进程放回认领后退出 → 退出码 0。自检不过：退出码 78。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readServiceKeyFile } from '../auth/service-identity.mjs';
import { createDirectory } from './directory.mjs';
import { createBroker, selectProjects } from './broker.mjs';
import { createWorker } from './worker.mjs';
import { createIsolation, isolationCandidates, isoNodeIdFor, wipeDir, leftoverCount, ISOLATION_DEFAULTS } from './isolation.mjs';
import { HOSTED_WORKER_ENV } from './source-gate.mjs';
import { runSelfcheck, SELFCHECK_EXIT } from './selfcheck.mjs';
import {
  LIMIT_DEFAULTS, cgroupSupport, workerCommand, memAvailable, measureTrees, createMemoryWatch, createBackpressure, createOomTracker, parseBytes, loadHighFor, machineCores,
} from './limits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

const intOf = (raw, fallback, min, max) => {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw Object.assign(new Error(`配置不对：${raw}`), { code: 'bad-config' });
  return n;
};

/** 读环境变量成配置；不合格抛 `code: 'bad-config'` */
export function renderServiceConfig(env = process.env) {
  const docUrl = env.PROMPTCUT_RENDER_DOC_URL || 'ws://127.0.0.1:8787';
  const u = new URL(docUrl);
  if (!['ws:', 'wss:'].includes(u.protocol)) throw Object.assign(new Error('PROMPTCUT_RENDER_DOC_URL 要是 ws:// 或 wss://'), { code: 'bad-config' });
  const health = env.PROMPTCUT_RENDER_DOC_HEALTH_URL || `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}${u.pathname.replace(/\/+$/, '')}/healthz`;
  const memoryMax = env.PROMPTCUT_RENDER_MEMORY_MAX || LIMIT_DEFAULTS.memoryMax;
  const memoryHigh = env.PROMPTCUT_RENDER_MEMORY_HIGH || LIMIT_DEFAULTS.memoryHigh;
  if (parseBytes(memoryMax) === null || parseBytes(memoryHigh) === null) throw Object.assign(new Error('内存上限写法不对（如 6G、512M）'), { code: 'bad-config' });
  return {
    docUrl,
    healthUrl: health,
    secretsDir: env.PROMPTCUT_RENDER_SECRETS || '/var/lib/promptcut/render-secrets',
    dataDir: path.resolve(env.PROMPTCUT_RENDER_DATA || '/var/lib/promptcut/render'),
    viteCacheDir: path.join(path.resolve(env.PROMPTCUT_RENDER_DATA || '/var/lib/promptcut/render'), 'vite-cache'),
    reportTimeoutMs: intOf(env.PROMPTCUT_RENDER_REPORT_TIMEOUT_MS, 180_000, 5000, 3_600_000),
    port: intOf(env.PROMPTCUT_RENDER_PORT, 5400, 1, 65533),
    isoPort: intOf(env.PROMPTCUT_RENDER_ISO_PORT, Math.min(65533, intOf(env.PROMPTCUT_RENDER_PORT, 5400, 1, 65533) + 10), 1, 65533),
    isoDataDir: path.join(path.resolve(env.PROMPTCUT_RENDER_DATA || '/var/lib/promptcut/render'), 'iso'),
    isoIdleMs: intOf(env.PROMPTCUT_RENDER_ISO_IDLE_MS, ISOLATION_DEFAULTS.IDLE_MS, 1000, 3_600_000),
    isoSliceMs: intOf(env.PROMPTCUT_RENDER_ISO_SLICE_MS, ISOLATION_DEFAULTS.SLICE_MS, 1000, 86_400_000),
    statusPort: intOf(env.PROMPTCUT_RENDER_STATUS_PORT, 5399, 0, 65535),
    maxConcurrent: intOf(env.PROMPTCUT_RENDER_MAX_CONCURRENT, LIMIT_DEFAULTS.maxConcurrent, 1, 4),
    maxProjects: intOf(env.PROMPTCUT_RENDER_MAX_PROJECTS, LIMIT_DEFAULTS.maxProjects, 1, 1000),
    memoryMax,
    memoryHigh,
    cpuQuota: env.PROMPTCUT_RENDER_CPU_QUOTA || LIMIT_DEFAULTS.cpuQuota,
    memLowBytes: (() => {
      if (!env.PROMPTCUT_RENDER_MEM_LOW) return LIMIT_DEFAULTS.memLowBytes;
      const n = parseBytes(env.PROMPTCUT_RENDER_MEM_LOW);
      if (n === null) throw Object.assign(new Error('PROMPTCUT_RENDER_MEM_LOW 写法不对（如 2G、512M）'), { code: 'bad-config' });
      return n;
    })(),
    // 背压的负载线：缺省按核数（`limits.mjs` 的 `loadHighFor`），给了就用给的
    loadHigh: env.PROMPTCUT_RENDER_LOAD_HIGH ? intOf(env.PROMPTCUT_RENDER_LOAD_HIGH, null, 1, 4096) : null,
    user: env.PROMPTCUT_RENDER_USER || '',
    cgroup: env.PROMPTCUT_RENDER_CGROUP === 'off' ? 'off' : 'auto',
    userCards: env.PROMPTCUT_RENDER_USER_CARDS === 'off' ? 'off' : 'isolated',
    editorDir: env.PROMPTCUT_RENDER_EDITOR_DIR || '/opt/promptcut-hosted/editor',
    expectCodeVersion: env.PROMPTCUT_RENDER_EXPECT_CODE_VERSION || '',
    agentStatusUrl: env.PROMPTCUT_RENDER_AGENT_STATUS_URL || '',
    streams: env.PROMPTCUT_RENDER_STREAMS === '1',
    verbose: env.PROMPTCUT_RENDER_VERBOSE === '1',
    sampleMs: intOf(env.PROMPTCUT_RENDER_SAMPLE_MS, LIMIT_DEFAULTS.sampleMs, 200, 600_000),
    skipChecks: String(env.PROMPTCUT_RENDER_SKIP_CHECKS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

/**
 * 交给工作进程的环境里不带的变量：管理进程自己的配置（`PROMPTCUT_RENDER_*`）、集群令牌、共享项目配置、上一层给的工作进程种类，
 * 以及**名字像秘密的**（令牌、密钥、口令、凭证、cookie）。页面里的卡片代码本来就读不到进程的环境变量；这一条是纵深——
 * 工作进程（与它起的 Vite、Chrome）的环境里不该躺着节点上别的服务的凭证。按名字判，不看值。
 */
const SECRET_NAME_RE = /(^|_)(TOKEN|TOKENS|SECRET|SECRETS|KEY|KEYS|APIKEY|PASSWORD|PASSWD|PASS|CREDENTIAL|CREDENTIALS|COOKIE|COOKIES)(_|$)/i;
export function scrubWorkerEnv(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (/^PROMPTCUT_RENDER_/.test(k) || /^PROMPTCUT_HOSTED_/.test(k) || k === 'PROMPTCUT_CLUSTER_TOKEN' || k === 'PROMPTCUT_SHARED_CONFIG' || k === 'PROMPTCUT_CARD_SYNC' || k === 'PROMPTCUT_CARD_OVERRIDES' || SECRET_NAME_RE.test(k)) delete out[k];
  }
  return out;
}

/**
 * 在线页面的构建里有没有嵌着这个代码版本：页面发布的清单计划把它写进 `requires.codeVersion`（`src/online/buildInfo.ts`），
 * 是 64 位十六进制串，原样出现在某个脚本里。回 true / false；目录不在、读不了回 null（没法比）。
 */
export function editorHasCodeVersion(editorDir, version) {
  if (!editorDir || !/^[0-9a-f]{64}$/.test(String(version))) return null;
  const files = [];
  const walk = (dir, depth) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory() && depth < 3) walk(abs, depth + 1);
      else if (ent.isFile() && /\.(m?js|html)$/.test(ent.name)) files.push(abs);
    }
  };
  try { walk(editorDir, 0); } catch { return null; }
  if (files.length === 0) return null;
  for (const file of files) {
    try { if (fs.readFileSync(file, 'utf8').includes(version)) return true; } catch { /* 读不了的跳过 */ }
  }
  return false;
}

/**
 * 代码版本对不对得上（契约第 7.4 节，「不能静默」）：自己的（工作进程报的 `frameCode`）对在线页面的、对 Agent 服务的。
 * 回 `{ self, editor, agent, expect, match }`；`editor` 是 `'same' | 'different' | 'unknown'`，`match` 只在确实不一致时为 false。
 */
export function compareCodeVersions({ self, editorDir, expect, agentVersion }) {
  if (!self) return { self: null, editor: 'unknown', agent: 'unknown', expect: expect || null, match: null };
  let editor = 'unknown';
  if (expect) editor = expect === self ? 'same' : 'different';
  else {
    const has = editorHasCodeVersion(editorDir, self);
    if (has !== null) editor = has ? 'same' : 'different';
  }
  const agent = !agentVersion ? 'unknown' : agentVersion === self ? 'same' : 'different';
  return { self, editor, agent, expect: expect || null, match: editor === 'different' || agent === 'different' ? false : (editor === 'same' || agent === 'same' ? true : null) };
}

/**
 * 工作进程的输出里「队列节点没起成」的那一行（`[queue-node] queue.skip {"reason":…}`，`vite-plugin-frames.ts` 打的）。
 * 认得出就回原因（`no-environment`：探不出渲染环境，多半是 Chrome 开不了页），否则回 null。
 */
export function queueSkipReason(line) {
  const m = /\[queue-node\]\s+queue\.skip\b(.*)$/.exec(String(line));
  if (!m) return null;
  const r = /"reason"\s*:\s*"([^"]+)"/.exec(m[1]) ?? /\breason=([\w-]+)/.exec(m[1]);
  return r ? r[1] : 'unknown';
}

/**
 * 工作进程是不是「起来了却不干活」：进程在、也打过就绪，但从没交过诊断（队列节点没起成，例如开 Chrome 探环境时卡住），
 * 或者交到一半停了。代理模式下它每秒对一次账、顺带交一次诊断，所以超过 `limitMs` 没有就结束它重起。
 */
export function reportStale({ running, ready, startedAt, reportAt, now, limitMs }) {
  if (!running || !ready || !Number.isFinite(startedAt)) return false;
  return now - Math.max(startedAt, reportAt || 0) > limitMs;
}

async function timedHealth(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    await res.arrayBuffer().catch(() => null);
    return res.ok ? Date.now() - started : null;
  } catch {
    return null;
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let config;
  try {
    config = renderServiceConfig(env);
  } catch (err) {
    const line = `${JSON.stringify({ t: new Date().toISOString(), event: 'config.error', reason: String(err?.code ?? 'bad-config'), detail: String(err?.message ?? err) })}\n`;
    process.stdout.write(line);
    process.stderr.write(line);
    return SELFCHECK_EXIT;
  }

  // ---------- 自检
  const skip = new Set(config.skipChecks);
  const check = await runSelfcheck(config, {
    ...(skip.has('chrome') ? { chrome: async () => ({ ok: true, version: 'skipped', cjk: true, noSandbox: null }) } : {}),
    ...(skip.has('ffmpeg') ? { ffmpeg: () => ({ ok: true, h264: true, version: 'skipped' }) } : {}),
    ...(config.cgroup === 'off' ? { cgroup: () => ({ ok: false, reason: 'disabled' }) } : {}),
  });
  // 每项失败只记一行，写 stderr（PM2 的错误日志、部署脚本的输出里都看得到）；stdout 的 `selfcheck` 汇总里有全部 reason 与说明。
  // 原来 stdout、stderr 各写一遍，两路合在一起看（容器、`2>&1`）就是同一条记两遍
  for (const e of check.errors) process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), event: 'selfcheck.error', ...e })}\n`);
  for (const w of check.warnings) log('selfcheck.warn', w);
  log('selfcheck', { ok: check.ok, errors: check.errors.map((e) => e.reason), ...(check.errors.length ? { errorDetails: check.errors } : {}), warnings: check.warnings.map((w) => w.reason), ...check.info });
  if (!check.ok) return SELFCHECK_EXIT;
  if (argv.includes('--check')) return 0;

  const key = readServiceKeyFile(config.secretsDir);
  const support = config.cgroup === 'off' ? { ok: false, reason: 'disabled' } : cgroupSupport();
  const memoryMaxBytes = parseBytes(config.memoryMax);
  // 内存看护的判定（量法与 cgroup 的关系见 limits.mjs 的 createMemoryWatch）
  const memoryWatch = createMemoryWatch({ max: memoryMaxBytes });
  let memoryFailLogAt = 0;
  let concurrency = config.maxConcurrent;

  // ---------- 目录
  const directory = createDirectory({ url: config.docUrl, key, log });

  // ---------- 工作进程
  /**
   * 队列节点没起成（工作进程打了 `queue.skip`）不能静默：它会一直不交诊断、靠看护反复重起。每次都明说一条（同时写 stderr），
   * 状态里留着最近一次（`environment`）。最常见的是 `no-environment`：工作进程里的 Chrome 开不了页。
   */
  let environment = { ok: true, reason: null, at: null, count: 0, worker: null };
  const noteSkip = (text, which) => {
    const reason = queueSkipReason(text);
    if (!reason) return;
    environment = { ok: false, reason, at: Date.now(), count: environment.count + 1, worker: which };
    const detail = reason === 'no-environment'
      ? '工作进程探不出渲染环境（Chrome 起不来或开不了受帧控制的页）：它一个任务也接不了。看它的输出里紧挨着的报错；Chrome 的要求见启动自检的 chrome-frame 一项'
      : '工作进程的队列节点没起成：它一个任务也接不了';
    const out = `${JSON.stringify({ t: new Date().toISOString(), event: 'render.no-environment', reason, worker: which, count: environment.count, detail })}\n`;
    process.stdout.write(out);
    process.stderr.write(out);
  };
  const brokerKey = randomBytes(32).toString('base64url');
  let stopping = false;
  let report = null; // 工作进程最近一次交来的诊断
  let reportAt = 0;
  let brokerPort = config.statusPort;
  const isoEnabled = config.userCards === 'isolated';
  const workerEnv = () => {
    const e = scrubWorkerEnv(env);
    Object.assign(e, {
      PROMPTCUT_RENDER_BROKER: `http://127.0.0.1:${brokerPort}`,
      PROMPTCUT_RENDER_BROKER_KEY: brokerKey,
      [HOSTED_WORKER_ENV]: 'resident',
      // 常驻工作进程绝不同步任何项目的卡（契约第 7.5 节）：它不执行任何项目带来的代码
      PROMPTCUT_CARD_SYNC: '0',
      // 内容库里有卡片源码的项目它连着但不认领，报给管理进程交给隔离工作进程；off 时照旧（它认领得了的照认领）
      ...(isoEnabled ? { PROMPTCUT_HOSTED_HOLD_CARDS: '1' } : {}),
      // Vite 的依赖预构建缓存放数据目录下（检出目录对工作进程的用户可能只读）
      PROMPTCUT_VITE_CACHE_DIR: config.viteCacheDir,
    });
    return e;
  };
  const worker = createWorker({
    command() {
      const args = [path.join(ROOT, 'scripts', 'render-host.mjs'), '--port', String(config.port), '--data', config.dataDir, '--max-concurrent', String(concurrency),
        ...(config.streams ? ['--streams'] : []), ...(config.verbose ? ['--verbose'] : [])];
      const built = workerCommand({
        node: process.execPath, args, support, user: config.user,
        limits: { memoryMax: config.memoryMax, memoryHigh: config.memoryHigh, cpuQuota: config.cpuQuota },
      });
      log('worker.command', { mode: built.mode, concurrency });
      return { cmd: built.cmd, args: built.args, env: workerEnv(), cwd: ROOT };
    },
    log,
    // 每次起之前先清上一轮留下的进程树（记号与 pid 记在这里）；结束时整棵树一起走，见 worker.mjs 文件头
    treeFile: path.join(config.dataDir, 'worker-tree.json'),
    onLine(line) {
      if (!line.trim()) return;
      process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event: 'worker.line', line: line.slice(0, 2000) })}\n`);
      noteSkip(line, 'resident');
    },
  });

  // ---------- 背压、内存看护、代码版本
  const backpressure = createBackpressure({ memLowBytes: config.memLowBytes, ...(config.loadHigh !== null ? { loadHigh: config.loadHigh } : {}) });
  const oom = createOomTracker();
  let readings = { memAvailable: null, healthMs: null, load1: null, workerRss: null, at: null };
  let codeVersion = compareCodeVersions({ self: null });
  let codeWarnAt = 0;
  let agentVersion = null;
  let agentAt = 0;
  let quotaUntil = null;

  const heldByProject = () => Object.fromEntries((report?.queue?.nodes ?? []).map((n) => [n.projectId, (n.held?.length ?? 0) + (n.running?.length ?? 0)]));
  const listing = () => {
    const picked = selectProjects({ directory: directory.list(), held: heldByProject(), maxProjects: config.maxProjects, instanceId: key.instanceId });
    // 隔离工作进程在跑时占一个并发名额：常驻的压到「总数 - 1」，两者合起来不超过第 4 节的并发上限
    return { docUrl: config.docUrl, paused: backpressure.paused, limit: isolation?.active ? Math.max(0, concurrency - 1) : concurrency, projects: picked.projects, waiting: picked.waiting };
  };

  // ---------- 隔离工作进程（契约第 7.5 节，方案 A）
  /*
   * 内容库里有卡片源码的项目，常驻工作进程连着但不认领（它不执行任何项目带来的代码），由这里起一个**只做这一个项目**的工作进程：
   *   - 同一时刻最多一个；口令每一轮现生成，代理口凭它只给这一个项目的清单与票据（`broker.mjs`）；
   *   - 自己的数据目录（`<数据目录>/iso`）与端口，开卡片同步，报 `userCards: true`，并发 1；
   *   - 闲置 `isoIdleMs`（60 s）结束；几个项目在等时每个最多 `isoSliceMs`（5 分钟）一换；
   *   - **每一轮前后都把数据目录整个清空**：装进来的卡（改动层）、帧库、临时目录、Chrome 的用户数据目录、Vite 的依赖缓存全在里面；
   *   - 结束时带走整棵进程树（`worker.mjs`）。
   * 检出目录与常驻工作进程共用、不另拷：卡片同步只写数据目录下的改动层，Vite 的缓存、导出目录、临时目录也都指到了数据目录，
   * 检出目录里一个文件都不写；部署时它属 root、工作进程的用户只读。另拷一份只多出每一轮几秒的拷贝与一份磁盘，挡不住别的东西
   * （Windows 上还不能给副本链 node_modules）。`isolation.mjs` 的 `prepareCheckout` 留着没用。
   */
  let isoKey = null;
  let isoReport = null;
  let isoReportAt = 0;
  let isoProc = null;
  const isoLog = (event, fields = {}) => log(event, { worker: 'isolated', ...fields });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** 清空隔离工作进程的数据目录；刚结束的进程可能还握着文件（Windows），重试几次。回清完后剩下的项数（0 = 干净） */
  async function wipeIso() {
    let last = null;
    for (let i = 0; i < 20; i += 1) {
      try {
        wipeDir(config.isoDataDir);
        // 管理进程以 root 跑、工作进程以服务用户跑时：目录属主跟数据目录走，工作进程才写得了
        if (process.platform !== 'win32') { try { const st = fs.statSync(config.dataDir); fs.chownSync(config.isoDataDir, st.uid, st.gid); } catch { /* 不是 root：本来就是同一个用户 */ } }
        return leftoverCount(config.isoDataDir);
      } catch (err) {
        last = err;
        if (err?.code === 'iso-not-ours') throw err;
        await sleep(500);
      }
    }
    throw last ?? new Error('清不掉隔离工作进程的数据目录');
  }
  const isolation = !isoEnabled ? null : createIsolation({
    nodeIdOf: (projectId) => isoNodeIdFor(key.instanceId, projectId),
    idleMs: config.isoIdleMs,
    sliceMs: config.isoSliceMs,
    log: isoLog,
    runner: {
      async prepare() {
        isoReport = null;
        isoReportAt = 0;
        isoKey = randomBytes(32).toString('base64url');
        const left = await wipeIso();
        if (left !== 0) throw new Error(`数据目录没清干净（还剩 ${left} 项）`);
      },
      start(projectId) {
        const myKey = isoKey;
        isoProc = createWorker({
          restart: false,
          log: isoLog,
          treeFile: path.join(config.dataDir, 'iso-worker-tree.json'),
          command() {
            const args = [path.join(ROOT, 'scripts', 'render-host.mjs'), '--port', String(config.isoPort), '--data', config.isoDataDir, '--max-concurrent', '1',
              ...(config.verbose ? ['--verbose'] : [])];
            const built = workerCommand({
              node: process.execPath, args, support, user: config.user,
              limits: { memoryMax: config.memoryMax, memoryHigh: config.memoryHigh, cpuQuota: config.cpuQuota },
            });
            const e = scrubWorkerEnv(env);
            Object.assign(e, {
              PROMPTCUT_RENDER_BROKER: `http://127.0.0.1:${brokerPort}`,
              PROMPTCUT_RENDER_BROKER_KEY: myKey,
              [HOSTED_WORKER_ENV]: 'isolated',
              PROMPTCUT_VITE_CACHE_DIR: path.join(config.isoDataDir, 'vite-cache'),
            });
            isoLog('worker.command', { mode: built.mode, projectId, port: config.isoPort });
            return { cmd: built.cmd, args: built.args, env: e, cwd: ROOT };
          },
          onLine(line) {
            if (!line.trim()) return;
            process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event: 'worker.line', worker: 'isolated', line: line.slice(0, 2000) })}\n`);
            noteSkip(line, 'isolated');
          },
        });
        isoProc.start();
      },
      async stop() {
        const p = isoProc;
        // 口令先作废：这一轮的工作进程从此要不到票据、交不了诊断
        isoKey = null;
        if (p) await p.stop();
      },
      async cleanup() {
        try { isoProc?.killSync(); } catch { /* 已经没了 */ }
        isoProc = null;
        isoReport = null;
        const left = await wipeIso();
        if (left !== 0) throw new Error(`数据目录没清干净（还剩 ${left} 项）`);
      },
      exited: () => !isoProc || !isoProc.running,
    },
  });
  const isoListing = () => ({ docUrl: config.docUrl, paused: backpressure.paused, limit: 1, projects: isolation?.listing() ?? [], waiting: [] });
  function isoTick() {
    if (!isolation || stopping) return;
    const dir = directory.list();
    // 背压暂停时不新起（已经在跑的照旧，它自己不认领新的）
    const candidates = backpressure.paused && !isolation.active ? [] : isolationCandidates({ directory: dir, residentNodes: report?.queue?.nodes ?? [] });
    isolation.tick({
      candidates,
      eligible: (projectId) => dir.some((p) => p.projectId === projectId && p.enabled && p.active),
      report: isoReport ? { at: isoReportAt, queue: isoReport.queue } : null,
    });
  }

  async function sample() {
    const healthMs = await timedHealth(config.healthUrl);
    // 内存：量两棵工作进程树各自占的物理内存（不重复计共享页，口径见 limits.mjs），上限管的是合起来的（契约第 4 节）
    const [residentMem, isoMem] = measureTrees([worker.pid ?? null, isoProc?.pid ?? null]);
    const mem = memoryWatch.judge({ resident: residentMem, iso: isoMem });
    const workerRss = mem.total;
    const isoRss = Number.isFinite(isoMem?.bytes) ? isoMem.bytes : null;
    readings = { memAvailable: memAvailable(), healthMs, load1: os.loadavg()[0], workerRss, isoRss, residentRss: Number.isFinite(residentMem?.bytes) ? residentMem.bytes : null, memoryMethods: mem.methods, at: Date.now() };
    const before = backpressure.paused;
    const state = backpressure.sample(readings);
    if (state.paused !== before) log(state.paused ? 'render.backpressure' : 'render.backpressure-clear', { reasons: state.reasons, ...readings });
    // 量不了：不当成 0、也不当成超限，这一拍不判；记一条（连着量不了时每分钟最多一条）
    if (mem.verdict === 'unmeasured' && Date.now() - memoryFailLogAt >= 60_000) {
      memoryFailLogAt = Date.now();
      log('render.memory-unmeasured', { failures: mem.failures, detail: '这一拍量不了工作进程树的内存，没有判超限' });
    }
    // 内存看护：没有独立 cgroup 时它是唯一的硬上限；有 cgroup 时内核先动手，这里放宽一档兜底（不会双杀，见 createMemoryWatch）
    if (mem.verdict === 'over') {
      const o = oom.note();
      log('render.memory-exceeded', { workerRss, isoRss, max: memoryMaxBytes, limit: mem.limit, count: o.count, victim: mem.victim, methods: mem.methods });
      if (o.degrade && concurrency !== 1) { concurrency = 1; log('render.degraded', { concurrency, reason: 'oom' }); }
      // 合起来超限：隔离工作进程在跑就先结束它（跑的是项目带来的代码），常驻的留着；只有常驻的在跑才结束常驻的
      if (mem.victim === 'isolated') void isolation?.stop('oom');
      else worker.kill('oom');
    }
    // 起来了却不交诊断：结束重起
    const ws = worker.status();
    if (reportStale({ running: ws.running, ready: ws.ready, startedAt: ws.startedAt, reportAt, now: Date.now(), limitMs: config.reportTimeoutMs })) {
      log('render.worker-stalled', { pid: ws.pid, reportAgeMs: reportAt ? Date.now() - reportAt : null, limitMs: config.reportTimeoutMs });
      report = null;
      worker.kill('stalled');
    }
    // 产物到了容量上限：工作进程已暂停认领，这里明说一次
    const quota = report?.queue?.quotaPausedUntil ?? null;
    if (quota !== quotaUntil) {
      quotaUntil = quota;
      if (quota) log('render.quota', { until: quota, detail: '素材服务回 507 service-quota：渲染服务的产物到了容量上限，暂停认领 10 分钟' });
      else log('render.quota-clear', {});
    }
    // 代码版本：与在线页面、Agent 服务的不一致要明说
    if (config.agentStatusUrl && Date.now() - agentAt > 5 * 60_000) {
      agentAt = Date.now();
      try {
        const res = await fetch(config.agentStatusUrl, { signal: AbortSignal.timeout(3000) });
        agentVersion = (await res.json())?.codeVersion ?? null;
      } catch { agentVersion = null; }
    }
    const self = report?.queue?.codeVersion ?? null;
    if (self && (codeVersion.self !== self || Date.now() - codeWarnAt > 10 * 60_000)) {
      codeVersion = compareCodeVersions({ self, editorDir: config.editorDir, expect: config.expectCodeVersion, agentVersion });
      if (codeVersion.match === false) {
        codeWarnAt = Date.now();
        log('render.code-mismatch', { ...codeVersion, self: self.slice(0, 12), detail: '渲染服务与在线页面（或 Agent 服务）不是同一个提交：它们发的任务这台一个也认领不了' });
        log('selfcheck.warn', { reason: 'code-version', detail: `在线页面 ${codeVersion.editor}，Agent 服务 ${codeVersion.agent}` });
      } else if (codeWarnAt === 0) {
        codeWarnAt = Date.now();
        log('render.code-version', { ...codeVersion, self: self.slice(0, 12) });
      }
    }
  }

  // ---------- 代理口与诊断口
  const startedAt = Date.now();
  const broker = createBroker({
    key: brokerKey,
    listing,
    // 隔离工作进程：口令每一轮都换，没在跑时不在表里；凭它只看得到、只要得到它那一个项目
    clients: () => (isoKey && isolation?.active ? [{ name: 'isolated', key: isoKey, listing: isoListing, report(body) { isoReport = body; isoReportAt = Date.now(); } }] : []),
    ticket: (projectId) => directory.ticket(projectId),
    report(body) { report = body; reportAt = Date.now(); },
    log,
    status() {
      const l = listing();
      return {
        service: key.service, kid: key.kid, instanceId: key.instanceId, pid: process.pid, uptimeMs: Date.now() - startedAt,
        directory: { ...directory.status(), list: directory.list().map(({ since, hosted, ...rest }) => rest) },
        projects: l.projects, waiting: l.waiting,
        worker: { ...worker.status(), concurrency, mode: support.ok ? 'cgroup' : 'in-process', reportAgeMs: reportAt ? Date.now() - reportAt : null },
        queue: report?.queue ?? null,
        userCards: config.userCards,
        isolation: !isolation ? { enabled: false } : {
          enabled: true, port: config.isoPort, ...isolation.status(),
          worker: isoProc ? isoProc.status() : null,
          reportAgeMs: isoReportAt ? Date.now() - isoReportAt : null,
          queue: isoReport?.queue ?? null,
          dataLeft: isolation.active ? null : leftoverCount(config.isoDataDir),
        },
        limits: { maxConcurrent: config.maxConcurrent, maxProjects: config.maxProjects, memoryMax: config.memoryMax, memoryHigh: config.memoryHigh, cpuQuota: config.cpuQuota, cgroup: support.ok ? 'systemd-scope' : `none:${support.reason}` },
        readings,
        backpressure: { paused: backpressure.paused, reasons: backpressure.reasons, loadHigh: config.loadHigh ?? loadHighFor(machineCores()) },
        quotaPausedUntil: quotaUntil,
        degraded: oom.degraded,
        codeVersion,
        environment,
        selfcheck: { ok: check.ok, warnings: check.warnings, info: check.info },
      };
    },
  });
  try {
    const addr = await broker.listen(config.statusPort);
    brokerPort = addr.port;
  } catch (err) {
    const line = `${JSON.stringify({ t: new Date().toISOString(), event: 'config.error', reason: 'listen', detail: String(err?.code ?? err?.message ?? err) })}\n`;
    process.stdout.write(line);
    process.stderr.write(line);
    return 1;
  }
  log('listen', { role: 'hosted-render', statusPort: brokerPort, workerPort: config.port, docUrl: config.docUrl, service: key.service, kid: key.kid, cgroup: support.ok ? 'systemd-scope' : `none:${support.reason}`, node: process.version });

  // 上一次没来得及清的（管理进程自己被杀）：起任何工作进程之前先把隔离工作进程的数据目录清空
  if (isolation) { try { await wipeIso(); } catch (err) { log('isolation.cleanup-failed', { message: String(err?.message ?? err), at: 'startup' }); } }
  directory.start();
  worker.start();
  const isoTimer = setInterval(() => { try { isoTick(); } catch (err) { log('isolation.error', { message: String(err?.message ?? err) }); } }, 1000);
  isoTimer.unref?.();
  const sampler = setInterval(() => { void sample().catch((err) => log('render.sample-error', { message: String(err?.message ?? err) })); }, config.sampleMs);

  // ---------- 退出
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log('stop', { signal });
    clearInterval(sampler);
    clearInterval(isoTimer);
    if (isolation) { try { await isolation.stop('shutdown'); } catch { /* 下面的 exit 钩子再兜一层 */ } }
    await worker.stop();
    directory.stop();
    await broker.close();
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    try { process.on(sig, () => { void stop(sig); }); } catch { /* 这个平台没有这个信号 */ }
  }
  process.on('message', (m) => { if (m?.type === 'shutdown') void stop('ipc'); });
  // 不管怎么退出（包括没走到 stop 的异常退出）：最后一步把工作进程整棵树带走，不留占着端口的孤儿
  process.on('exit', () => { try { worker.killSync(); } catch { /* 已经没了 */ } try { isoProc?.killSync(); } catch { /* 已经没了 */ } });
  return null;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const code = await main();
  if (code !== null) process.exit(code);
}
