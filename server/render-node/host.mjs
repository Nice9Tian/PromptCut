/**
 * 独立渲染主机的节点编排(M6b,契约 `docs/plan/render-host-contract.md` 第 2、3 节)。
 *
 * 独立渲染主机就是只开 `render` 连接的设备:配置里每个共享项目一条连接、一个节点(`profile: 'host'`),
 * 所有节点共用同一个预渲染执行器,并发总数不超过 `maxConcurrent`(缺省 1,上限 4)。
 *
 *   parseHostConfig(raw)  规整配置(M6a 的形状:一项或数组),另取 `maxConcurrent`(不合格抛 bad-host-config)
 *   loadHostConfig(env)   读 `PROMPTCUT_SHARED_CONFIG` 指的文件,再经 parseHostConfig
 *   createRenderHost(…)   按配置每项调一次 `connect(entry)` 拿 { endpoint, executor, sink },
 *                         每条连接上起一个 `createLocalNode`(`profile: 'host'`),由调用方按节拍调 `tick()`
 *
 * # 并发总数
 *
 * 每个节点的会话各自只看自己的持有数,所以另加一道全局闸:每个节点的 `isIdle()` 回
 * 「全部节点的持有数 + 在飞的认领数 < maxConcurrent」。在飞的认领在包过的 `send` 里记(发 `task.claim` 时记上,
 * 收到同 id 的 `task.claimed` / `task.claim-rejected`、不带 reqId 的 `error`、重新报到或断线时清掉),
 * 与 `session.mjs` 的在飞规则一致。`tick()` 按顺序逐个节点推进,`send` 是同步的,前一个节点刚发的认领
 * 在后一个节点判闲时已经算进去,所以任何时刻持有 + 在飞都不超过上限。
 *
 * # 不认领 `plan`
 *
 * 节点侧过滤 `filter.mjs` 规则 6:`profile: 'host'` 的节点见到 `plan` 直接跳过,不发认领(契约第 3、4 节)。
 * `plan` 留给发布方自己的节点。主机也不发布任何 `plan`。
 *
 * # 闲时门槛
 *
 * 主机没有页面、没有播放:只要全局闸有空位就认领(契约第 3 节「闲时门槛」),不看执行器的 `isIdle`。
 *
 * # 退出
 *
 * `shutdown(reason)`:每个节点 `yieldAll(reason)`(持有的一律 `task.release`,在飞的认领回来即放回)
 * 再 `stop()`;调用方随后关连接。队列收到 `task.release` 立即把任务放回 `open`,不必等断线的宽限期。
 *
 * 除 `loadHostConfig` 读一次配置文件外(经 `../auth/shared-config.mjs`),本模块不开计时器、不碰网络:
 * 端点、执行器、产物库都由调用方注入(预渲染进程里是 `vite-plugin-frames.ts` 的 `startHostNode`)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLocalNode } from './local-node.mjs';
import { normalizeEntry, SHARED_CONFIG_ENV } from '../auth/shared-config.mjs';
import { localDeviceInfo } from '../auth/device.mjs';

/** 主机并发总数的上限(契约第 2 节) */
export const HOST_MAX_CONCURRENT = 4;
/** 环境变量覆盖配置里的并发数(`scripts/render-host.mjs --max-concurrent`) */
export const HOST_CONCURRENCY_ENV = 'PROMPTCUT_HOST_MAX_CONCURRENT';
/** 与 PC 节点相同的能力(契约第 3 节 `node.hello`) */
export const HOST_CAPABILITIES = Object.freeze({ userCards: true, graphCards: false });

function badHost(detail) {
  const err = new Error(`独立渲染主机配置:${detail}`);
  err.code = 'bad-host-config';
  return err;
}

/**
 * 校验并发数(契约第 2 节;集成裁定 2026-09-26,契约第 6 节):不给(undefined / null)是 1;1～4 的整数照收;
 * 其余一律是配置错误 `code: 'bad-host-config'` —— 超过 4 报错、不截断;0、负数、小数、字符串都报错。
 */
export function hostMaxConcurrent(value) {
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw badHost('maxConcurrent 要是 1～4 的整数');
  if (value > HOST_MAX_CONCURRENT) throw badHost(`maxConcurrent 上限 ${HOST_MAX_CONCURRENT}(给了 ${value})`);
  return value;
}

/**
 * 解析主机配置(文件内容 JSON.parse 之后):一项或数组(M6a 契约第 11 节),每项规整见 `normalizeEntry`
 * (缺字段、格式不对、空数组抛 `code: 'bad-shared-config'`,错误信息里没有口令与 K)。
 * 主机只开 `render` 连接:某项给了 `role` 且不是 `render` 抛 `bad-host-config`。
 * `maxConcurrent` 可写在任意一项上,取各项最大值,缺省 1;任一项的值不合格(含超过 4)抛 `bad-host-config`。
 * @param {unknown} raw
 * @param {{ device?: { deviceId: string, deviceName: string } }} [options] 缺省设备信息(同 `normalizeEntry` 第二个参数)
 * @returns {{ entries: object[], maxConcurrent: number }}
 */
export function parseHostConfig(raw, { device } = {}) {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) {
    const err = new Error(`${SHARED_CONFIG_ENV}:配置是空数组`);
    err.code = 'bad-shared-config';
    throw err;
  }
  const entries = list.map((item) => (device ? normalizeEntry(item, device) : normalizeEntry(item)));
  for (const [i, item] of list.entries()) {
    if (item.role !== undefined && item.role !== 'render') throw badHost(`第 ${i} 项的 role 要是 'render'(主机只开 render 连接)`);
  }
  const given = list.filter((item) => item.maxConcurrent !== undefined && item.maxConcurrent !== null).map((item) => hostMaxConcurrent(item.maxConcurrent));
  return { entries, maxConcurrent: given.length ? Math.max(...given) : 1 };
}

/**
 * 读主机配置:`PROMPTCUT_SHARED_CONFIG` 指的文件,内容见 `parseHostConfig`;读不了、不是 JSON 抛 `bad-shared-config`。
 * `PROMPTCUT_HOST_MAX_CONCURRENT`(`render-host --max-concurrent`)设了就优先,同样要 1～4 的整数,否则 `bad-host-config`。
 * 没设环境变量回 null。
 * @returns {null | { entries: object[], maxConcurrent: number }}
 */
export function loadHostConfig(env = process.env) {
  const file = env[SHARED_CONFIG_ENV];
  if (!file) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    const e = new Error(`${SHARED_CONFIG_ENV}:读不了配置文件(${err?.code ?? 'bad-json'})`);
    e.code = 'bad-shared-config';
    throw e;
  }
  const parsed = parseHostConfig(raw, { device: localDeviceInfo(env) });
  const override = env[HOST_CONCURRENCY_ENV];
  if (override !== undefined && override !== '') {
    if (!/^\d+$/.test(String(override))) throw badHost(`${HOST_CONCURRENCY_ENV} 要是 1～4 的整数`);
    parsed.maxConcurrent = hostMaxConcurrent(Number(override));
  }
  return parsed;
}

const emptyStats = () => ({ claimed: 0, completed: 0, dedup: 0, failed: 0, lost: 0, discarded: 0, released: 0 });

/**
 * @param {object} options
 * @param {object[]} options.entries  规整过的配置项(`loadHostConfig().entries`),每项要有 `projectId`
 * @param {(entry: object, index: number) => { endpoint: object, executor: object, sink: object }} options.connect
 *   每项调一次:到那个项目文档服务的 `render` 连接(`createWsEndpoint` 的形状;有 `onOpen` / `onClose` 就挂上,
 *   没有就当已连上),以及这个项目用的执行器与产物库
 * @param {(entry: object, index: number) => string} options.nodeIdOf  每个节点的 id
 * @param {string} options.envFingerprint
 * @param {string} options.codeVersion  一个主机实例只有一个代码版本(契约第 3 节〔裁〕)
 * @param {number} [options.maxConcurrent]  并发总数,缺省 1,上限 4
 * @param {object} [options.capabilities]  缺省 `HOST_CAPABILITIES`
 * @param {() => number} options.now
 * @param {() => number} [options.random]
 * @param {object} [options.constants]
 * @param {(event: object) => void} [options.onEvent]  local-node 的事件,多带 `projectId`、`index`
 */
export function createRenderHost({
  entries,
  connect,
  nodeIdOf,
  envFingerprint,
  codeVersion,
  maxConcurrent = 1,
  capabilities = HOST_CAPABILITIES,
  now,
  random,
  constants,
  onEvent = () => {},
}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError('createRenderHost:entries 至少一项');
  if (typeof connect !== 'function') throw new TypeError('createRenderHost:connect 必须是函数');
  const cap = hostMaxConcurrent(maxConcurrent);
  let version = codeVersion;
  let stopped = false;

  const emit = (event) => { try { onEvent(event); } catch { /* 诊断回调出错不影响节点 */ } };

  /** 全部节点的持有数 + 在飞的认领数 */
  const busy = () => members.reduce((n, m) => n + (m.local ? m.local.session.held().length : 0) + (m.inflight !== null ? 1 : 0), 0);

  const members = entries.map((entry, index) => {
    const wired = connect(entry, index);
    const endpoint = wired?.endpoint;
    if (!endpoint || typeof endpoint.send !== 'function' || typeof endpoint.onMessage !== 'function') {
      throw new TypeError(`createRenderHost:第 ${index} 项的 endpoint 不对`);
    }
    const m = {
      index,
      projectId: entry.projectId ?? null,
      nodeId: nodeIdOf ? nodeIdOf(entry, index) : `host-${index}`,
      endpoint,
      executor: wired.executor,
      sink: wired.sink,
      local: null,
      inflight: null,
      started: false,
      stats: emptyStats(),
      seen: new Set(),
    };
    // 包一层 send:记在飞的认领、放回数
    m.ep = {
      send(message) {
        if (message?.type === 'task.claim') m.inflight = message.id;
        else if (message?.type === 'node.hello') m.inflight = null;
        else if (message?.type === 'task.release') m.stats.released++;
        return endpoint.send(message);
      },
      onMessage: (handler) => endpoint.onMessage(handler),
    };
    endpoint.onMessage((message) => {
      switch (message?.type) {
        case 'task.claimed':
          m.stats.claimed++;
          if (m.inflight === message.id) m.inflight = null;
          break;
        case 'task.claim-rejected':
          if (m.inflight === message.id) m.inflight = null;
          break;
        case 'error':
          if (message.reqId === undefined) m.inflight = null;
          break;
        case 'task.opened':
          if (message.task?.id != null) m.seen.add(message.task.id);
          break;
        case 'queue.snapshot':
          for (const task of message.tasks ?? []) if (task?.id != null) m.seen.add(task.id);
          break;
        default:
          break;
      }
    });
    if (typeof endpoint.onOpen === 'function') endpoint.onOpen(() => open(m));
    if (typeof endpoint.onClose === 'function') endpoint.onClose(() => { m.started = false; m.inflight = null; });
    return m;
  });

  function build(m) {
    m.local?.stop();
    m.local = createLocalNode({
      nodeId: m.nodeId,
      node: { profile: 'host', envFingerprint, codeVersions: [version], capabilities, maxConcurrent: cap },
      endpoint: m.ep,
      now,
      ...(random ? { random } : {}),
      ...(constants ? { constants } : {}),
      isIdle: () => busy() < cap,
      maxConcurrent: cap,
      codeVersion: version,
      executor: m.executor,
      sink: m.sink,
      onEvent: (event) => {
        const type = event?.type;
        if (type === 'completed') m.stats.completed++;
        else if (type === 'dedup') m.stats.dedup++;
        else if (type === 'failed') m.stats.failed++;
        else if (type === 'lost') m.stats.lost++;
        else if (type === 'discarded') m.stats.discarded++;
        emit({ ...event, projectId: m.projectId, index: m.index });
      },
    });
  }

  /** (重)连上就报到,接续本实例仍持有的认领(G.7 约定写法) */
  function open(m) {
    if (stopped || !m.local) return;
    m.inflight = null;
    m.local.start(m.local.session.held().map(({ id, token }) => ({ id, token })));
    m.started = true;
  }

  return {
    /** 起全部节点;已经连上的(或没有连接状态的,如进程内环回)立即报到 */
    start() {
      stopped = false;
      for (const m of members) {
        build(m);
        if (m.endpoint.connected === true || (typeof m.endpoint.onOpen !== 'function' && m.endpoint.closed !== true)) open(m);
      }
    },
    /** 一拍:逐个节点续约、认领 */
    tick() {
      if (stopped) return;
      for (const m of members) if (m.started && m.local) m.local.tick();
    },
    /** 代码版本变了:全部让掉、按新版本重新报到 */
    setCodeVersion(next) {
      if (next === version) return false;
      version = next;
      for (const m of members) {
        try { m.local?.yieldAll('code-changed'); } catch { /* 连接坏了 */ }
        build(m);
        if (m.started) { m.started = false; open(m); }
      }
      return true;
    },
    /** 退出:让掉全部认领、停节点。回让掉的条数 */
    shutdown(reason = 'shutdown') {
      let released = 0;
      for (const m of members) {
        try { released += m.local?.yieldAll(reason) ?? 0; } catch { /* 连接坏了:队列按断线回收 */ }
        try { m.local?.stop(); } catch { /* 已停 */ }
        m.started = false;
      }
      stopped = true;
      return released;
    },
    /** 还没落定的执行(`shutdown` 之后等它们收尾) */
    async settled() { await Promise.all(members.map((m) => m.local?.settled())); },
    running: () => members.flatMap((m) => m.local?.running() ?? []),
    busy,
    get maxConcurrent() { return cap; },
    get codeVersion() { return version; },
    /** 契约第 3 节「诊断」的 `nodes` 一项一个节点 */
    nodes() {
      return members.map((m) => ({
        projectId: m.projectId,
        nodeId: m.nodeId,
        connected: m.endpoint.connected === true || (m.endpoint.connected === undefined && m.endpoint.closed !== true),
        claimed: m.stats.claimed,
        completed: m.stats.completed,
        dedup: m.stats.dedup,
        failed: m.stats.failed,
        lost: m.stats.lost,
        discarded: m.stats.discarded,
        released: m.stats.released,
        seen: m.seen.size,
        held: m.local ? m.local.session.held().map(({ id }) => id) : [],
        running: m.local ? m.local.running() : [],
        ...(typeof m.endpoint.stats === 'function' ? { transport: m.endpoint.stats() } : {}),
      }));
    },
  };
}

/** `scripts/render-host.mjs` 的命令行参数(契约第 2 节);放在这里是因为 `server/**` 不许引 `scripts/`(单测要用) */
export function renderHostArgs(argv) {
  const opts = { port: 5400, config: null, data: null, maxConcurrent: null, streams: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} 要跟一个值`); return v; };
    if (a === '--port') opts.port = Number(next());
    else if (a === '--config') opts.config = next();
    else if (a === '--data') opts.data = next();
    else if (a === '--max-concurrent') opts.maxConcurrent = Number(next());
    else if (a === '--streams') opts.streams = true;
    else if (a === '--verbose') opts.verbose = true;
    else throw new Error(`不认识的参数 ${a}`);
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65533) throw new Error('--port 不对');
  if (opts.maxConcurrent !== null && !(Number.isInteger(opts.maxConcurrent) && opts.maxConcurrent >= 1 && opts.maxConcurrent <= 4)) {
    throw new Error('--max-concurrent 要是 1～4 的整数');
  }
  return opts;
}

/** `scripts/render-host.mjs` 给编辑器子进程设的环境变量(契约第 2 节) */
export function renderHostEnv(base, { config, data, streams, maxConcurrent }) {
  const env = { ...base };
  for (const key of ['PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_HEADLESS', 'PROMPTCUT_PUSH', 'PROMPTCUT_ROLE']) delete env[key];
  const tmp = path.join(data, 'tmp');
  Object.assign(env, {
    PROMPTCUT_QUEUE_NODE: '1',
    PROMPTCUT_NODE_PROFILE: 'host',
    PROMPTCUT_SHARED_CONFIG: path.resolve(config),
    PROMPTCUT_STREAMS: streams ? '1' : '0',
    PROMPTCUT_EXPORT_DIR: data,
    PROMPTCUT_DATA_DIR: path.join(data, 'data'),
    TEMP: tmp, TMP: tmp, TMPDIR: tmp,
  });
  if (maxConcurrent !== null && maxConcurrent !== undefined) env.PROMPTCUT_HOST_MAX_CONCURRENT = String(maxConcurrent);
  else delete env.PROMPTCUT_HOST_MAX_CONCURRENT;
  return env;
}
