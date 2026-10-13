/**
 * root 这一侧的任务槽：把槽调度（`account-slot-scheduler.mjs`）要的那组口子
 * `current / open / bind / close / forcedClose / retire / observeFailure` 接到 root 的发布器
 * （`server/hosted/deploy/agent-run-scope-publisher.mjs`）和到任务进程的指令通道（`account-worker-control-client.mjs`）。
 *
 * 这个文件里没有任何只能在 Linux 上跑的调用：看操作系统的那一半（systemd 单元、cgroup、root 所有的记录文件）
 * 由调用方经 `io` 和 `host` 交进来——生产上是 `account-root-main.mjs` 给的真东西（`createAgentScopeRuntime` 与 systemctl），
 * 测试给受控的。所以这里的次序和判断在哪台机器上都验得到。
 *
 * 它不判断任何权限、不产生任何证明：分配、终态是文档服务签的，意向是任务进程签的，发布器各自验签；
 * 进程组是不是真的空了由发布器对着原来那个 cgroup 看。这里只是把东西按次序递过去。
 *
 * 另有两个纯函数：`validateRootConfiguration`（root 入口的配置）和 `workerSettingsFor`（给某一代任务进程写的设置）。
 */
import path from 'node:path';
import { digestOf } from '../account/ledger.mjs';
import { agentScopeRef } from '../account/agent-run-scope-doc.mjs';
import { validateAgentScopeExpected, validateAgentScopeReservation } from '../hosted/agent-run-scope-schema.mjs';
import { validateAccountToolSettings } from './account-tool-settings.mjs';

const fail = code => { throw Object.assign(new Error(code), { status: 503, code }); };
const exact = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const absolute = value => typeof value === 'string' && path.posix.isAbsolute(value) && path.posix.normalize(value) === value;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const pin = value => typeof value === 'string' && /^[A-Fa-f0-9:]{64,95}$/.test(value);
const port = value => Number.isInteger(value) && value >= 1 && value <= 65535;
const loopback = value => { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === '127.0.0.1' && u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password && port(Number(u.port)); } catch { return false; } };
const delay = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
const RETIREMENT = 'promptcut.agent-run-scope.unassigned-retirement.v1';

/**
 * root 入口的配置（一份 root 所有的 JSON，路径都是这台 Linux 上的绝对路径）：
 *   v: 1
 *   master      { origin, fingerprint256 }          Agent 主服务的内部口（`PROMPTCUT_AGENT_INTERNAL_PORT`）与主服务证书的指纹
 *   controller  { keyFile, certFile, caFile }       root 那张证书：连主服务的内部口、连各任务进程的指令口都用它
 *   pollMs      可不写，缺省 500
 *   worker      各槽的任务进程共用的设置：
 *       doc         { origin, fingerprint256, keyFile, certFile, caFile }   文档服务的内部口与任务证书
 *       dataDir     各代共用、长期保留的数据目录（和主服务的 PROMPTCUT_AGENT_SHARED_DATA 是同一个）
 *       stateRoot   每一代自己的状态目录的上级（任务进程的用户可写）；实际用 <stateRoot>/<槽>/epoch-<n>/
 *       modelConfigDir / look / runAssets / tools   可不写，含义见 `account-task-worker-config.mjs`（`tools` 是工具要的节点依赖：
 *                   ffmpeg、各感知包的 Python 与权重目录、无头浏览器；只写节点上真有的，写了但路径不在任务进程会拒绝启动）
 *   slots[]     每个槽：
 *       publisher           发布器的配置（`createAgentScopeRuntime` 认的那一份：v、expected、registryDir、identity、runtimeAdapter、configuredAnchorDigest）
 *       workerSettingsFile  给这一槽的任务进程写设置的固定位置（单元里的 PROMPTCUT_AGENT_WORKER_SETTINGS 指向它）
 *       identity            { keyFile, certFile, caFile }   任务进程核身份那个口的服务端证书（端口取自 publisher.identity.origin）
 *       controlPort         可不写：文档服务回连任务进程的本机控制口，缺省由系统分配
 * 只核形状、路径和互相对不对得上；发布器的那一份由发布器自己再核一遍。
 */
export function validateRootConfiguration(config) {
  if (!exact(config, ['v', 'master', 'controller', 'worker', 'slots'], ['pollMs']) || config.v !== 1 ||
      !exact(config.master, ['origin', 'fingerprint256']) || !loopback(config.master.origin) || !pin(config.master.fingerprint256) ||
      !exact(config.controller, ['keyFile', 'certFile', 'caFile']) || Object.values(config.controller).some(v => !absolute(v)) ||
      (config.pollMs !== undefined && (!Number.isInteger(config.pollMs) || config.pollMs < 50 || config.pollMs > 60_000)) ||
      !Array.isArray(config.slots) || !config.slots.length || config.slots.length > 64) fail('root-configuration');
  const w = config.worker;
  // `tools` 一节和任务进程用同一张名单核(`account-tool-settings.mjs`):键写错了在这里就拒绝并指出是哪个键,
  // 不然 root 起得来、每一代任务进程都拒绝启动,整台节点的云端任务都起不来
  if (w && typeof w === 'object' && w.tools !== undefined) {
    try { validateAccountToolSettings(w.tools === null ? [] : w.tools); }
    catch (error) { throw Object.assign(new Error('root-configuration-worker-tools'), { status: 503, code: 'root-configuration-worker-tools', key: error?.key ?? null, detail: String(error?.message ?? '').slice(0, 200) }); }
  }
  if (!exact(w, ['doc', 'dataDir', 'stateRoot'], ['modelConfigDir', 'look', 'runAssets', 'tools']) || !absolute(w.dataDir) || !absolute(w.stateRoot) ||
      w.dataDir === w.stateRoot || (w.modelConfigDir !== undefined && !absolute(w.modelConfigDir)) ||
      !exact(w.doc, ['origin', 'fingerprint256', 'keyFile', 'certFile', 'caFile']) || !loopback(w.doc.origin) || !pin(w.doc.fingerprint256) ||
      ['keyFile', 'certFile', 'caFile'].some(key => !absolute(w.doc[key]))) fail('root-configuration-worker');
  const seen = new Set();
  for (const slot of config.slots) {
    if (!exact(slot, ['publisher', 'workerSettingsFile', 'identity'], ['controlPort']) || !absolute(slot.workerSettingsFile) ||
        !exact(slot.identity, ['keyFile', 'certFile', 'caFile']) || Object.values(slot.identity).some(v => !absolute(v)) ||
        (slot.controlPort !== undefined && !port(slot.controlPort)) ||
        !exact(slot.publisher, ['v', 'expected', 'registryDir', 'identity', 'runtimeAdapter', 'configuredAnchorDigest']) || slot.publisher.v !== 1 ||
        !absolute(slot.publisher.registryDir) || !exact(slot.publisher.identity, ['origin', 'keyFile', 'certFile', 'caFile']) ||
        !loopback(slot.publisher.identity.origin) || (slot.publisher.configuredAnchorDigest !== null && !hash(slot.publisher.configuredAnchorDigest)))
      fail('root-configuration-slot');
    const expected = validateAgentScopeExpected(slot.publisher.expected);
    // 一个槽一份：登记目录、单元、设置文件、身份口、槽号都不许和别的槽重
    for (const id of [`key:${expected.authorityId}:${expected.slotId}`, `unit:${expected.unit}`, `dir:${slot.publisher.registryDir}`,
      `settings:${slot.workerSettingsFile}`, `origin:${new URL(slot.publisher.identity.origin).port}`,
      ...(slot.controlPort !== undefined ? [`origin:${slot.controlPort}`] : [])]) {
      if (seen.has(id)) fail('root-configuration-slot-duplicate'); seen.add(id);
    }
    // 设置文件不放进登记目录（那里只许有发布器自己的记录），也不放进任务进程可写的目录
    if (path.posix.dirname(slot.workerSettingsFile) === slot.publisher.registryDir ||
        [w.dataDir, w.stateRoot].some(dir => slot.workerSettingsFile === dir || slot.workerSettingsFile.startsWith(`${dir}/`) ||
          slot.publisher.registryDir === dir || slot.publisher.registryDir.startsWith(`${dir}/`))) fail('root-configuration-slot-path');
  }
  return config;
}

/** 给某个槽的某一代任务进程写的设置（`account-task-worker-config.mjs` 认的那个形状）。纯计算；
 * 写盘之前由调用方再用 `validateWorkerSettings` 核一遍（它按本机的路径规则核，所以只在节点上核得过）。 */
export function workerSettingsFor({ config, slot, reservation }) {
  const expected = validateAgentScopeExpected(slot.publisher.expected), r = validateAgentScopeReservation(reservation, expected);
  const stateDir = path.posix.join(config.worker.stateRoot, expected.slotId, `epoch-${r.epoch}`);
  return { v: 1, expected, reservation: r,
    rootRecordFile: path.posix.join(slot.publisher.registryDir, `epoch-${r.epoch}.json`),
    identity: { ...slot.identity, port: Number(new URL(slot.publisher.identity.origin).port) },
    doc: { ...config.worker.doc }, master: { ...config.master },
    journalFile: path.posix.join(stateDir, 'journal.sqlite'), dataDir: config.worker.dataDir, stateDir: path.posix.join(stateDir, 'state'),
    ...(config.worker.modelConfigDir ? { modelConfigDir: config.worker.modelConfigDir } : {}),
    ...(slot.controlPort !== undefined ? { controlPort: slot.controlPort } : {}),
    ...(config.worker.look ? { look: structuredClone(config.worker.look) } : {}),
    ...(config.worker.runAssets ? { runAssets: structuredClone(config.worker.runAssets) } : {}),
    ...(config.worker.tools ? { tools: structuredClone(config.worker.tools) } : {}) };
}

/**
 * 一个槽的适配。
 * @param {object} o
 * @param {object} o.expected 这个槽的 `expected`（发布器配置里的那一份）
 * @param {() => string | null} o.anchorDigest 这个槽配置的锚点摘要（还没初始化过就是 null）
 * @param {object} o.io 发布器看系统、读写记录用的那组函数（Linux 上是 `createAgentScopeRuntime` 的返回值）
 * @param {(input: object) => Promise<object>} o.publish 发布器的事务（`publishAgentScope`）
 * @param {(record: object) => object} o.connect 连到这一代任务进程的指令通道，回 `createWorkerControlClient` 那样的对象
 * @param {object} o.host 这一代主进程的状况，由调用方看系统后回答：
 *        alive(record) → boolean   这一代的主进程此刻还在不在
 *        stop(record)              不商量，让这一代的主进程停下（只动主进程；整组进程由发布器关）
 * @param {number} [o.watchMs] 多久看一次主进程还在不在
 */
export function createRootSlotAdapter({ expected, anchorDigest, io, publish, connect, host, watchMs = 500, stopWaitMs = 10_000, log = () => {} } = {}) {
  const e = validateAgentScopeExpected(expected);
  if (typeof anchorDigest !== 'function' || typeof publish !== 'function' || typeof connect !== 'function' ||
      typeof io?.read !== 'function' || typeof host?.alive !== 'function' || typeof host.stop !== 'function' ||
      !Number.isInteger(watchMs) || watchMs < 10 || !Number.isInteger(stopWaitMs) || stopWaitMs < 0) fail('root-slot-configuration');
  const say = (event, fields = {}) => { try { log(event, { slotId: e.slotId, ...fields }); } catch { /* 日志不影响槽 */ } };
  /** 这个进程里开出来、还连着的那一代（没有就是空：上一个 root 进程留下的一代在这里没有通道） */
  let attached = null;
  async function head() {
    const current = await io.read('current.json');
    if (!current) return null;
    const record = await io.read(`epoch-${current.epoch}.json`);
    if (!record) fail('root-slot-record-missing');
    return { current, record };
  }
  const run = (mode, extra = {}) => publish({ expected: e, mode, configuredAnchorDigest: mode === 'initialize' ? null : anchorDigest(), io, ...extra });
  const detach = () => { const old = attached; attached = null; if (old) { old.gone = true; old.client.stop(); } };
  async function waitGone(record, limitMs) {
    const deadline = Date.now() + limitMs;
    while (await host.alive(record)) { if (Date.now() >= deadline) return false; await delay(Math.min(watchMs, 100)); }
    return true;
  }
  return {
    slotId: e.slotId,
    async current() {
      const now = await head();
      return now ? { rootScopeRef: agentScopeRef(now.record), phase: now.current.phase } : null;
    },
    async open() {
      detach();
      const before = await head();
      // 还没初始化过的槽不由调度顺手初始化：初始化产生的锚点摘要要先配进文档服务，否则这一代进程登记不上。
      if (!before || anchorDigest() === null) fail('root-slot-not-initialized');
      await run('start');
      const { record } = await head(), client = connect(record), state = { epoch: record.epoch, client, gone: false };
      attached = state;
      // 主进程还在不在：隔一会儿看一次系统。看到不在了，结算结果的那条长挂也就不再问了。
      const exited = (async () => {
        for (;;) {
          if (state.gone) return { epoch: record.epoch, observed: false };
          let alive = true;
          try { alive = await host.alive(record); } catch (error) { say('root.slot.watch.pending', { epoch: record.epoch, code: error?.code ?? 'unavailable' }); }
          if (!alive) { state.gone = true; return { epoch: record.epoch, observed: true }; }
          await delay(watchMs);
        }
      })();
      say('root.slot.opened', { epoch: record.epoch });
      return { rootScopeRef: agentScopeRef(record), worker: {
        prepare: task => client.prepare(task), start: () => client.start(),
        settlement: client.settlement({ gone: () => state.gone }), exited,
        alive: () => !state.gone,
        async stop() { try { await host.stop(record); } finally { if (await waitGone(record, stopWaitMs)) state.gone = true; } } } };
    },
    bind: assignment => run('bind', { assignment }),
    async close({ terminal, intent }) { const result = await run('close', { terminal, intent }); detach(); say('root.slot.closed', { how: 'normal' }); return result; },
    async forcedClose({ terminal }) { const result = await run('forced-close', { terminal, intent: null }); detach(); say('root.slot.closed', { how: 'forced' }); return result; },
    async retire({ reason }) {
      const now = await head();
      if (!now) fail('root-slot-record-missing');
      const terminal = { v: 1, protocol: RETIREMENT, authorityId: e.authorityId, slotId: e.slotId, epoch: now.record.epoch,
        recordDigest: digestOf(now.record), reason };
      const result = await run('retire', { terminal, intent: null }); detach(); say('root.slot.closed', { how: 'retired', reason }); return result;
    },
    /**
     * 初始化这个槽（只在部署时由人跑一次，调度不调它）：开第一代，随即按「没领过任务」退掉，回锚点摘要。
     * 锚点摘要要配进文档服务和 root 入口的配置，之后调度才开得了第二代。第一代从没被叫去领取过，所以文档服务那边
     * 不可能有它的任何授权，退掉是安全的。已经初始化过的槽原样回它的摘要与现状，不再动它——只有一种例外：
     * 上一次初始化开了第一代、还没来得及退就断了（现状停在第 1 代、`ready`），这一次把它退掉。
     */
    async bootstrap() {
      let now = await head(), initialized = false;
      if (!now) {
        if (anchorDigest() !== null) fail('root-slot-anchor-without-registry');
        await run('initialize'); initialized = true; now = await head();
      }
      const anchor = await io.read('anchor.json');
      if (!anchor || !now) fail('root-slot-record-missing');
      const digest = digestOf(anchor);
      if (anchorDigest() !== null && anchorDigest() !== digest) fail('root-slot-anchor-mismatch');
      if (now.current.epoch === 1 && now.current.phase === 'ready') {
        if (await host.alive(now.record)) { /* 发布器关的时候会停整组进程，这里不用先停 */ }
        await publish({ expected: e, mode: 'retire', configuredAnchorDigest: digest, io, intent: null, terminal: { v: 1, protocol: RETIREMENT,
          authorityId: e.authorityId, slotId: e.slotId, epoch: 1, recordDigest: digestOf(now.record), reason: 'registration-failed' } });
        now = await head();
      }
      detach();
      return { slotId: e.slotId, authorityId: e.authorityId, initialized, anchorDigest: digest, epoch: now.current.epoch, phase: now.current.phase };
    },
    /**
     * 写下「主进程不在了」的观察。这一步只动主进程；它还不是关闭，之后凭文档服务据这份观察签的强制终态由发布器去关整组进程。
     */
    async observeFailure() {
      const now = await head();
      if (!now) fail('root-slot-record-missing');
      // 调度只在它已经判定这一代不行了的时候才来写这份观察（进程自己没了、领取或开跑的结果不明、放弃了正常结算、
      // 上一个 root 进程留下的）。主进程还活着就先让它停下，停不下来就如实报「还活着」，下一轮再来。
      if (await host.alive(now.record)) {
        say('root.slot.main.stop', { epoch: now.record.epoch, attached: attached?.epoch === now.record.epoch });
        await host.stop(now.record);
        if (!await waitGone(now.record, stopWaitMs)) fail('agent-scope-main-still-live');
      }
      if (attached && attached.epoch === now.record.epoch) attached.gone = true;
      return run('observe-failure');
    },
    describe: () => ({ slotId: e.slotId, attachedEpoch: attached?.epoch ?? null }),
  };
}
