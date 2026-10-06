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
 *
 * M6a（`docs/plan/auth-contract.md` 第 6 节「队列里的角色限制」）：
 * - `node.hello` 只允许 `role: 'render'` 的连接与 `local` 身份，别的回 `forbidden`。
 *   不带 `scope` 的旧式 principal（测试注入的 `authenticate`、M5 的匿名身份）不受限，行为与 M5 相同；
 * - 按空间起实例时由 `../spaces.mjs` 的外壳包一层，这里不认识空间；
 * - `claimsOf(connId)`：这条连接的节点此刻持有的认领数，成员列表的「渲染中」标签用。
 *
 * M7（`docs/plan/m7-contract.md` 第 13 节裁定）在 `node.hello` 交给队列之前：
 * - D9 render 票据带 `owner: { kind: 'browser' }` 的连接（页面开的纯浏览器节点连接）：profile 固定为 `browser`，
 *   自报别的一律回 `forbidden`；nodeId 已绑在别的 userId 上（队列的 `nodeUserOf`）回 `forbidden`，这条连接不记节点角色；
 * - D10 `environment: { platform, userAgent, renderer, vendor }`（页面报的原始值，`src/editor/pageEnvironment.mjs`）由这里按
 *   `describeEnvironment` 算指纹，写进交给队列的 `envFingerprint`（`node.welcome` 回给页面）：browser 归属的连接一律按它算、
 *   自报的不作数，没报 environment 回 `bad-message`；别的连接只在没自报指纹时按它算；
 * - D14 以 `browser` 报到、报了 environment 而 UA 不是 Chromium 内核：回 `error { reason: 'not-chromium' }`，不当节点。
 */
import { QUEUE_DEFAULTS } from '../../render-queue/constants.mjs';
import { parseInbound, makeMessage, prioritySummaryValue, NODE_TYPES, PUBLISHER_TYPES } from '../../render-queue/messages.mjs';
import { describeEnvironment, isChromiumUserAgent } from '../../render-node/fingerprint.mjs';

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

/** 这个 principal 能不能报到为渲染节点：`render` 角色、`local` 身份，以及不带 `scope` 的旧式身份 */
export function mayRegisterNode(principal) {
  if (!principal || principal.scope === undefined) return true;
  return principal.scope === 'local' || principal.role === 'render';
}

/** render 票据的归属是不是纯浏览器节点（M7 D9：页面签 render 票据时带 `owner: { kind: 'browser' }`） */
export const isBrowserOwned = (principal) => principal?.owner?.kind === 'browser';

/** 页面报的环境原始值每项的长度上限（UA、WebGL 串都远小于它） */
const ENV_FIELD_MAX = 1024;
const ENV_FIELDS = ['platform', 'userAgent', 'renderer', 'vendor'];

/**
 * `node.hello` 的 `environment`（M7 D10）：对象，四项可选、是字符串、各 ≤ 1024 字符；缺的按空串。
 * 不对回 null。
 */
function environmentOf(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const k of ENV_FIELDS) {
    const x = v[k];
    if (x === undefined || x === null) { out[k] = ''; continue; }
    if (typeof x !== 'string' || x.length > ENV_FIELD_MAX) return null;
    out[k] = x;
  }
  return out;
}

/**
 * M7 D9、D10、D14：`node.hello` 交给队列之前在这里定 profile 与指纹。回 `{ msg }`（可能改写过 `envFingerprint`）或
 * `{ error: { reason, detail } }`。
 */
function admitNodeHello(principal, msg, nodeUserOf) {
  const browserOwned = isBrowserOwned(principal);
  if (browserOwned && msg.profile !== 'browser') {
    return { error: { reason: 'forbidden', detail: '纯浏览器节点的连接只能以 browser 报到' } };
  }
  let out = msg;
  if (msg.environment !== undefined && msg.environment !== null) {
    const env = environmentOf(msg.environment);
    if (!env) return { error: { reason: 'bad-message', detail: 'environment 必须是 { platform, userAgent, renderer, vendor } 字符串' } };
    if (msg.profile === 'browser' && !isChromiumUserAgent(env.userAgent)) {
      return { error: { reason: 'not-chromium', detail: '一期只在 Chromium 内核的浏览器上当渲染节点' } };
    }
    const own = msg.envFingerprint;
    if (browserOwned || own === undefined || own === null || own === '') {
      const envFingerprint = describeEnvironment({ platform: env.platform, renderer: env.renderer, vendor: env.vendor, chromeVersion: env.userAgent }).fingerprint;
      out = { ...msg, envFingerprint };
    }
  } else if (browserOwned) {
    return { error: { reason: 'bad-message', detail: '纯浏览器节点要报 environment（页面的原始环境值），指纹由文档服务算' } };
  }
  const bound = typeof nodeUserOf === 'function' && typeof msg.nodeId === 'string' ? nodeUserOf(msg.nodeId) : null;
  if (bound !== null && principal && bound !== principal.userId) {
    return { error: { reason: 'forbidden', detail: '这个 nodeId 属于别的用户' } };
  }
  return { msg: out };
}

/** 队列模块认领的消息类型（按空间起实例的外壳也用它） */
export const RENDER_QUEUE_TYPES = Object.freeze(queueTypes());

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
    // c10a 契约第 17 节:`priority` 可以是 'normal' / 'backfill';摘要只比数(补渲档算 -1)
    for (const t of parsed.body.tasks) pending.set(t.id, { priority: prioritySummaryValue(t.priority), fp: fingerprintOf(t.requires) });
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
      if (msg.type === 'node.hello' && !mayRegisterNode(conn?.principal)) {
        const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
        return reply(ctx, connId, 'error', { reason: 'forbidden', detail: '只有 render 角色的连接能报到为渲染节点' }, reqId);
      }
      if (msg.type === 'node.hello') {
        // M7 D9 / D10 / D14：profile 与凭证绑定、指纹由这里按原始环境值算、非 Chromium 不当节点
        const admitted = admitNodeHello(conn?.principal, msg, typeof q.nodeUserOf === 'function' ? q.nodeUserOf : null);
        if (admitted.error) {
          const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
          ctx.log('role.node-refused', { connId, reason: admitted.error.reason, userId: conn?.principal?.userId ?? null });
          return reply(ctx, connId, 'error', admitted.error, reqId);
        }
        msg = admitted.msg;
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

    /**
     * 立即放回这条连接的节点手里的全部认领（不是 G.3 的模块接口）：逐个替它发 `task.release`，任务当场回到未认领，
     * 不等断线的宽限期。关掉托管方渲染节点的开关时用（`docs/plan/hosted-render-contract.md` 第 3 节）。回放回的条数
     */
    releaseClaims(connId, reason = 'released') {
      const nodeId = conns.get(connId)?.node?.nodeId;
      if (!nodeId || typeof q.describe !== 'function') return 0;
      const d = q.describe();
      const held = (Array.isArray(d?.tasks) ? d.tasks : []).filter((t) => t.state === 'claimed' && t.claim?.nodeId === nodeId);
      for (const t of held) q.handle(connId, { type: 'task.release', id: t.id, token: t.claim.token, reason });
      return held.length;
    },

    /** 这条连接的节点此刻持有的认领数（不是 G.3 的模块接口，给成员列表用） */
    claimsOf(connId) {
      const nodeId = conns.get(connId)?.node?.nodeId;
      if (!nodeId || typeof q.describe !== 'function') return 0;
      const d = q.describe();
      return (Array.isArray(d?.tasks) ? d.tasks : []).filter((t) => t.state === 'claimed' && t.claim?.nodeId === nodeId).length;
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
