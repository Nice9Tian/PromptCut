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
 *   PROMPTCUT_RENDER_MEM_LOW          背压的可用内存线，本机可用内存低于它就暂停认领，缺省 2G
 *   PROMPTCUT_RENDER_USER             工作进程用的系统用户（只在有 systemd 时经 --uid 生效）；空表示与管理进程同一用户
 *   PROMPTCUT_RENDER_CGROUP           auto（缺省：有 systemd 与 cgroup v2 就用）| off
 *   PROMPTCUT_RENDER_USER_CARDS       isolated | off（第 5 批才实现隔离工作进程；现在两种取值下常驻工作进程都不同步卡）
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
import { runSelfcheck, SELFCHECK_EXIT } from './selfcheck.mjs';
import {
  LIMIT_DEFAULTS, cgroupSupport, workerCommand, memAvailable, treeRss, createBackpressure, createOomTracker, parseBytes,
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
  for (const e of check.errors) {
    const line = `${JSON.stringify({ t: new Date().toISOString(), event: 'selfcheck.error', ...e })}\n`;
    process.stdout.write(line);
    process.stderr.write(line);
  }
  for (const w of check.warnings) log('selfcheck.warn', w);
  log('selfcheck', { ok: check.ok, errors: check.errors.map((e) => e.reason), warnings: check.warnings.map((w) => w.reason), ...check.info });
  if (!check.ok) return SELFCHECK_EXIT;
  if (argv.includes('--check')) return 0;

  const key = readServiceKeyFile(config.secretsDir);
  const support = config.cgroup === 'off' ? { ok: false, reason: 'disabled' } : cgroupSupport();
  const memoryMaxBytes = parseBytes(config.memoryMax);
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
  let report = null; // 工作进程最近一次交来的诊断
  let reportAt = 0;
  let brokerPort = config.statusPort;
  const workerEnv = () => {
    const e = { ...env };
    for (const k of Object.keys(e)) if (/^PROMPTCUT_RENDER_/.test(k) || k === 'PROMPTCUT_CLUSTER_TOKEN' || k === 'PROMPTCUT_SHARED_CONFIG') delete e[k];
    Object.assign(e, {
      PROMPTCUT_RENDER_BROKER: `http://127.0.0.1:${brokerPort}`,
      PROMPTCUT_RENDER_BROKER_KEY: brokerKey,
      // 常驻工作进程绝不同步任何项目的卡（契约第 7.5 节）：它不执行任何项目带来的代码
      PROMPTCUT_CARD_SYNC: '0',
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
  const backpressure = createBackpressure({ memLowBytes: config.memLowBytes });
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
    return { docUrl: config.docUrl, paused: backpressure.paused, projects: picked.projects, waiting: picked.waiting };
  };

  async function sample() {
    const healthMs = await timedHealth(config.healthUrl);
    const workerRss = worker.pid ? treeRss(worker.pid) : null;
    readings = { memAvailable: memAvailable(), healthMs, load1: os.loadavg()[0], workerRss, at: Date.now() };
    const before = backpressure.paused;
    const state = backpressure.sample(readings);
    if (state.paused !== before) log(state.paused ? 'render.backpressure' : 'render.backpressure-clear', { reasons: state.reasons, ...readings });
    // 内存看护：没有 cgroup 时它是唯一的硬上限
    if (workerRss !== null && memoryMaxBytes !== null && workerRss > memoryMaxBytes && worker.running) {
      const o = oom.note();
      log('render.memory-exceeded', { workerRss, max: memoryMaxBytes, count: o.count });
      if (o.degrade && concurrency !== 1) { concurrency = 1; log('render.degraded', { concurrency, reason: 'oom' }); }
      worker.kill('oom');
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
        limits: { maxConcurrent: config.maxConcurrent, maxProjects: config.maxProjects, memoryMax: config.memoryMax, memoryHigh: config.memoryHigh, cpuQuota: config.cpuQuota, cgroup: support.ok ? 'systemd-scope' : `none:${support.reason}` },
        readings,
        backpressure: { paused: backpressure.paused, reasons: backpressure.reasons },
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

  directory.start();
  worker.start();
  const sampler = setInterval(() => { void sample().catch((err) => log('render.sample-error', { message: String(err?.message ?? err) })); }, config.sampleMs);

  // ---------- 退出
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log('stop', { signal });
    clearInterval(sampler);
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
  process.on('exit', () => { try { worker.killSync(); } catch { /* 已经没了 */ } });
  return null;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const code = await main();
  if (code !== null) process.exit(code);
}
