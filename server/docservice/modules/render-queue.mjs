/**
 * 渲染任务队列在文档服务上的模块适配（契约 `docs/plan/render-queue-contract.md` G.4）。
 *
 * - `renderQueueModule(q, { sweepMs })`：把按契约 A.3 接口实现的队列包成一个文档服务模块。
 *   连接的业务角色（发布方 `publisherId`、渲染节点 `node`）记在本模块自己的连接表里，核心只记 principal；
 * - `renderQueuePlaceholder()`：队列还没挂上时占住同一组消息类型，一律回 `queue-unavailable`。
 *
 * 组装层 `service.mjs` 的旧接口 `mountRenderQueue` 用这两个工厂在占位与真队列之间切换。
 */
import { QUEUE_DEFAULTS } from '../../render-queue/constants.mjs';
import { parseInbound, NODE_TYPES, PUBLISHER_TYPES } from '../../render-queue/messages.mjs';

export const RENDER_QUEUE_MODULE = 'render-queue';

/** 交给队列处理的消息类型：按 `messages.mjs` 的出口取，不写死 */
function queueTypes() {
  return [...new Set(['node.hello', 'publisher.hello', ...NODE_TYPES, ...PUBLISHER_TYPES])];
}

const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

const NO_ROLES = () => ({ roles: [], publisherId: null, node: null });

/**
 * @param {{ connect: Function, disconnect: Function, handle: Function, tick: Function, epoch?: string, describe?: Function }} q
 *   契约 A.3 的队列接口，构造时的 `send` 已接到文档服务的 `send`
 * @param {{ sweepMs?: number }} [options] 调 `tick` 的间隔
 */
export function renderQueueModule(q, { sweepMs = QUEUE_DEFAULTS.SWEEP_INTERVAL_MS } = {}) {
  for (const m of ['connect', 'disconnect', 'handle', 'tick']) {
    if (typeof q?.[m] !== 'function') throw new TypeError(`queueInterface.${m} 必须是函数`);
  }
  /** connId → { principal, publisherId, node } */
  const conns = new Map();

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

  return {
    name: RENDER_QUEUE_MODULE,
    types: queueTypes(),
    tickMs: sweepMs,

    connect(ctx, connId, principal) {
      conns.set(connId, { principal, publisherId: null, node: null });
      q.connect(connId, principal);
    },

    disconnect(ctx, connId) {
      const conn = conns.get(connId);
      conns.delete(connId);
      q.disconnect(connId);
      if (conn && (conn.publisherId !== null || conn.node)) {
        ctx.log('role.close', { connId, publisherId: conn.publisherId, nodeId: conn.node?.nodeId ?? null });
      }
    },

    handle(ctx, connId, msg) {
      const conn = conns.get(connId);
      // hello 由队列回 welcome；这里只在消息合法时记下这条连接的角色（队列会用同一套校验）
      if (conn && (msg.type === 'node.hello' || msg.type === 'publisher.hello')) {
        const parsed = parseInbound(msg);
        if (parsed.ok) recordRole(ctx, connId, conn, parsed.type, parsed.body);
      }
      q.handle(connId, msg);
    },

    tick() {
      q.tick();
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
