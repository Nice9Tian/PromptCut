/**
 * 渲染任务队列在文档服务上的模块适配（契约 `docs/plan/render-queue-contract.md` G.4、H.3）。
 *
 * - `renderQueueModule(q, { sweepMs })`：把按契约 A.3 接口实现的队列包成一个文档服务模块。
 *   连接的业务角色（发布方 `publisherId`、渲染节点 `node`）记在本模块自己的连接表里，核心只记 principal；
 * - `renderQueuePlaceholder()`：队列还没挂上时占住同一组消息类型，一律回 `queue-unavailable`。
 *
 * 组装层 `service.mjs` 的旧接口 `mountRenderQueue` 用这两个工厂在占位与真队列之间切换。
 *
 * C6.1（H.3）在这里加两件事，队列本体 `server/render-queue/` 不改：
 * - **合并键**：队列经 `send` 发出的 `task.opened`、`task.taken`、`task.closed` 带 `coalesceKey: 'task:<id>'`，
 *   同一任务在慢连接上积压的状态变化只留最新一条。队列的 `send` 由调用方接到组装层的 `service.send`，
 *   组装层再交给本模块的 `outbound(connId, message)` 定发送选项（见下）；
 * - **摘要订阅**：`queue.watch { projects: 'all', mode: 'summary' }` 由本模块处理、不交给队列。
 *   订阅频道 `queue-summary:all`，每次 `tick` 算一遍各项目的计数，变了才发布，带 `coalesceKey: 'queue-summary'`。
 *   摘要订阅的连接不收单任务增量：本模块替它向队列发 `queue.watch { projects: [] }`（队列收空数组），
 *   队列就不再给它发任何增量；那一次的 `queue.snapshot` 回包由 `outbound` 吞掉。
 */
import { QUEUE_DEFAULTS } from '../../render-queue/constants.mjs';
import { parseInbound, makeMessage, NODE_TYPES, PUBLISHER_TYPES } from '../../render-queue/messages.mjs';

export const RENDER_QUEUE_MODULE = 'render-queue';

/** 摘要频道（H.3）：前缀由本模块声明，核心只认字符串 */
const SUMMARY_PREFIX = 'queue-summary';
const SUMMARY_CHANNEL = `${SUMMARY_PREFIX}:all`;
const SUMMARY_KEY = 'queue-summary';
/** 切到摘要时替连接向队列发的 `queue.watch` 用的 reqId；它的回包由 `outbound` 吞掉，不会到客户端 */
const SILENT_WATCH_REQ = '\u0000summary-switch';

/** 交给队列处理的消息类型：按 `messages.mjs` 的出口取，不写死 */
function queueTypes() {
  return [...new Set(['node.hello', 'publisher.hello', ...NODE_TYPES, ...PUBLISHER_TYPES])];
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

const NO_ROLES = () => ({ roles: [], publisherId: null, node: null });

/** 按合并键的消息：取任务 id（H.3）；其余消息返回 null，不带键 */
function coalesceIdOf(message) {
  switch (message.type) {
    case 'task.opened':
      return isObj(message.task) && typeof message.task.id === 'string' ? message.task.id : null;
    case 'task.taken':
    case 'task.closed':
      return typeof message.id === 'string' ? message.id : null;
    default:
      return null;
  }
}

/** 任务的指纹分组键：`requires.envFingerprint`，没有（或不是非空字符串）记在 `''` 下 */
function fingerprintOf(requires) {
  const fp = isObj(requires) ? requires.envFingerprint : undefined;
  return typeof fp === 'string' ? fp : '';
}

/**
 * @param {{ connect: Function, disconnect: Function, handle: Function, tick: Function, epoch?: string, describe?: Function }} q
 *   契约 A.3 的队列接口，构造时的 `send` 已接到文档服务的 `send`
 * @param {{ sweepMs?: number }} [options] 调 `tick` 的间隔
 */
export function renderQueueModule(q, { sweepMs = QUEUE_DEFAULTS.SWEEP_INTERVAL_MS } = {}) {
  for (const m of ['connect', 'disconnect', 'handle', 'tick']) {
    if (typeof q?.[m] !== 'function') throw new TypeError(`queueInterface.${m} 必须是函数`);
  }
  /** connId → { principal, publisherId, node, summary } */
  const conns = new Map();
  /** 订阅了摘要的连接 */
  const summaryConns = new Set();
  /** 上一次发布到摘要频道的 `projects`（JSON）；没有订阅者时清空，重新有人订阅后的第一次 tick 一定发 */
  let lastSummary = null;

  /**
   * 任务 id → { priority, fp }：摘要要的优先级与指纹。`q.describe()` 里没有这两项，发布时从入站
   * `task.publish` 记下来；以队列回包 `task.published` 里 `created: true` 的为准（过了 TTL 重建的任务会换新值）。
   * 每次算摘要时按 `describe()` 里还在的任务修剪。
   */
  const infos = new Map();
  let infosPrunedAt = 0;
  /** 正在交给队列的一次发布：{ connId, pending: Map<id, info> }；队列同步处理，处理完就清掉 */
  let publishing = null;
  /** 正在替连接发的静默 `queue.watch`：{ connId } */
  let silencing = null;

  function recordRole(ctx, connId, conn, type, body) {
    if (type === 'publisher.hello') {
      conn.publisherId = body.publisherId;
      ctx.log('role.publisher', { connId, publisherId: body.publisherId, userId: conn.principal.userId });
      return;
    }
    conn.node = {
      nodeId: body.nodeId,
      profile: body.profile,
      envFingerprint: body.envFingerprint,
      capabilities: body.capabilities,
      codeVersions: body.codeVersions,
      maxConcurrent: body.maxConcurrent,
    };
    ctx.log('role.node', { connId, nodeId: body.nodeId, profile: body.profile, userId: conn.principal.userId });
  }

  function rolesOf(conn) {
    const roles = [];
    if (conn.publisherId !== null) roles.push('publisher');
    if (conn.node) roles.push('node');
    return roles;
  }

  function reply(ctx, connId, type, fields, reqId) {
    ctx.send(connId, makeMessage(q.epoch ?? null, type, fields, reqId));
  }

  // ---------- 摘要（H.3） ----------

  /** 按 `q.describe()` 算各项目的计数；只列有 open 或 claimed 任务的项目，按 projectId 升序 */
  function summarize() {
    const d = typeof q.describe === 'function' ? q.describe() : { tasks: [] };
    const tasks = Array.isArray(d?.tasks) ? d.tasks : [];
    const byProject = new Map();
    const alive = new Set();
    for (const t of tasks) {
      alive.add(t.id);
      if (t.state !== 'open' && t.state !== 'claimed') continue;
      let p = byProject.get(t.projectId);
      if (!p) {
        p = { projectId: t.projectId, open: 0, claimed: 0, topPriority: null, fps: new Map() };
        byProject.set(t.projectId, p);
      }
      if (t.state === 'claimed') {
        p.claimed += 1;
        continue;
      }
      p.open += 1;
      const info = infos.get(t.id);
      if (info && (p.topPriority === null || info.priority > p.topPriority)) p.topPriority = info.priority;
      const fp = info ? info.fp : '';
      p.fps.set(fp, (p.fps.get(fp) ?? 0) + 1);
    }
    for (const id of infos.keys()) if (!alive.has(id)) infos.delete(id);
    infosPrunedAt = infos.size;
    const projects = [...byProject.values()]
      .sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0))
      .map((p) => ({
        projectId: p.projectId,
        open: p.open,
        claimed: p.claimed,
        topPriority: p.topPriority,
        openByFingerprint: Object.fromEntries([...p.fps.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))),
      }));
    return projects;
  }

  function summaryMessage(ctx, projects, reqId) {
    return makeMessage(q.epoch ?? null, 'queue.summary', { at: ctx.now(), projects }, reqId);
  }

  function publishSummary(ctx) {
    if (summaryConns.size === 0) {
      lastSummary = null;
      // 没人订阅摘要时不必每次都算；登记的发布信息多出不少时顺手修剪一次，免得只增不减
      if (infos.size > infosPrunedAt * 2 + 1024) summarize();
      return;
    }
    const projects = summarize();
    const json = JSON.stringify(projects);
    if (json === lastSummary) return;
    lastSummary = json;
    ctx.publish(SUMMARY_CHANNEL, summaryMessage(ctx, projects), { coalesceKey: SUMMARY_KEY });
  }

  function watchSummary(ctx, connId, conn, msg) {
    const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
    if (msg.projects !== 'all') {
      return reply(ctx, connId, 'error', { reason: 'bad-message', detail: "摘要订阅的 projects 必须是 'all'" }, reqId);
    }
    if (!conn?.node) return reply(ctx, connId, 'error', { reason: 'not-registered' }, reqId);
    // 纯浏览器只见本人任务，摘要会泄露别人的项目
    if (conn.node.profile === 'browser') return reply(ctx, connId, 'error', { reason: 'forbidden' }, reqId);

    // 让队列停发单任务增量：替它 watch 一个空的项目列表，回包由 outbound 吞掉
    silencing = { connId };
    try {
      q.handle(connId, { type: 'queue.watch', projects: [], reqId: SILENT_WATCH_REQ });
    } finally {
      silencing = null;
    }
    ctx.subscribe(connId, SUMMARY_CHANNEL);
    conn.summary = true;
    summaryConns.add(connId);
    ctx.send(connId, summaryMessage(ctx, summarize(), reqId));
  }

  function leaveSummary(ctx, connId, conn) {
    if (!conn?.summary) return;
    conn.summary = false;
    summaryConns.delete(connId);
    ctx.unsubscribe(connId, SUMMARY_CHANNEL);
  }

  // ---------- 发布信息（摘要的优先级与指纹） ----------

  function handlePublish(connId, msg) {
    const parsed = parseInbound(msg);
    if (!parsed.ok) return q.handle(connId, msg);
    const pending = new Map();
    for (const t of parsed.body.tasks) pending.set(t.id, { priority: t.priority, fp: fingerprintOf(t.requires) });
    publishing = { connId, pending, seen: false };
    try {
      q.handle(connId, msg);
    } finally {
      const done = publishing;
      publishing = null;
      // 队列的 send 没接到本模块（没看到回包）时的兜底：还没登记过的 id 按这次发布记
      if (!done.seen) {
        for (const [id, info] of done.pending) if (!infos.has(id)) infos.set(id, info);
      }
    }
  }

  return {
    name: RENDER_QUEUE_MODULE,
    types: queueTypes(),
    channels: [SUMMARY_PREFIX],
    tickMs: sweepMs,

    connect(ctx, connId, principal) {
      conns.set(connId, { principal, publisherId: null, node: null, summary: false });
      q.connect(connId, principal);
    },

    disconnect(ctx, connId) {
      const conn = conns.get(connId);
      conns.delete(connId);
      summaryConns.delete(connId);
      q.disconnect(connId);
      if (conn && (conn.publisherId !== null || conn.node)) {
        ctx.log('role.close', { connId, publisherId: conn.publisherId, nodeId: conn.node?.nodeId ?? null });
      }
    },

    handle(ctx, connId, msg) {
      const conn = conns.get(connId);
      if (msg.type === 'queue.watch') {
        if (msg.mode === 'summary') return watchSummary(ctx, connId, conn, msg);
        if (msg.mode !== undefined && msg.mode !== 'full') {
          const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
          return reply(ctx, connId, 'error', { reason: 'bad-message', detail: "mode 只能是 'full' 或 'summary'" }, reqId);
        }
        // 全量 watch：以最后一条为准，合法的话先退订摘要，再照旧交给队列
        if (conn?.summary && parseInbound(msg).ok) leaveSummary(ctx, connId, conn);
        return q.handle(connId, msg);
      }
      // hello 由队列回 welcome；这里只在消息合法时记下这条连接的角色（队列会用同一套校验）
      if (conn && (msg.type === 'node.hello' || msg.type === 'publisher.hello')) {
        const parsed = parseInbound(msg);
        if (parsed.ok) recordRole(ctx, connId, conn, parsed.type, parsed.body);
      }
      if (msg.type === 'task.publish') return handlePublish(connId, msg);
      q.handle(connId, msg);
    },

    tick(ctx) {
      q.tick();
      publishSummary(ctx);
    },

    /**
     * 组装层的旧接口 `service.send`（队列的 `send`）经这里定发送选项：返回 `{ coalesceKey? }`；
     * 返回 null 表示这条不发（替连接发的静默 watch 的回包）。不是 G.3 的模块接口，只给组装层的外观用。
     */
    outbound(connId, message) {
      if (!isObj(message)) return {};
      if (silencing && silencing.connId === connId && message.type === 'queue.snapshot' && message.reqId === SILENT_WATCH_REQ) {
        return null;
      }
      if (publishing && publishing.connId === connId && message.type === 'task.published' && Array.isArray(message.results)) {
        publishing.seen = true;
        for (const r of message.results) {
          if (!isObj(r) || r.created !== true) continue;
          const info = publishing.pending.get(r.id);
          if (info) infos.set(r.id, info);
        }
      }
      const id = coalesceIdOf(message);
      return id === null ? {} : { coalesceKey: `task:${id}` };
    },

    describeConn(connId) {
      const conn = conns.get(connId);
      if (!conn) return NO_ROLES();
      return {
        roles: rolesOf(conn),
        publisherId: conn.publisherId,
        node: conn.node ? structuredClone(conn.node) : null,
      };
    },

    health() {
      const list = [...conns.values()];
      return {
        queue: true,
        publishers: list.filter((c) => c.publisherId !== null).length,
        nodes: list.filter((c) => c.node).length,
        epoch: q.epoch ?? null,
      };
    },

    describe() {
      return typeof q.describe === 'function' ? q.describe() : { epoch: q.epoch ?? null };
    },
  };
}

/** 队列还没挂上时的占位：认领队列的全部类型，一律回 `queue-unavailable` */
export function renderQueuePlaceholder() {
  return {
    name: RENDER_QUEUE_MODULE,
    types: queueTypes(),

    handle(ctx, connId, msg) {
      const out = { type: 'error', reason: 'queue-unavailable', detail: '渲染任务队列还没有挂上' };
      if (isReqId(msg.reqId)) out.reqId = msg.reqId;
      ctx.send(connId, out);
    },

    describeConn: NO_ROLES,

    health() {
      return { queue: false, publishers: 0, nodes: 0 };
    },

    describe() {
      return null;
    },
  };
}
