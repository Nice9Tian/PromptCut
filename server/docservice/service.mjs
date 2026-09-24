/**
 * 文档服务骨架：WebSocket 长连接、消息解析、连接身份记录，以及渲染任务队列的挂载点 `mountRenderQueue`。
 *
 * 语义见 `docs/semantics/architecture/document-service.md`。这一版只有骨架：还没有项目文档、操作日志、
 * `projectRev` / `cardRev`、锁和内容库（`docs/plan/cloud-task.md` 第 6 步），也还没有真正的鉴权——
 * `principal` 由 `authenticate` 钩子给出，缺省是匿名。
 *
 * 连接身份分两层：
 * - **principal**（哪个用户、哪个租户）在建连时由服务端定，消息里自报的一律不认；
 * - **角色**在连接发 hello 之后才有：`publisher.hello` 之后是发布方（页面、Agent），`node.hello` 之后是
 *   渲染节点，一条连接可以两者都是（`docs/plan/render-queue-contract.md` A.5）。
 *
 * 渲染任务队列按契约 A.3 的接口挂进来：队列只经 `send(connId, message)` 往外发，服务把 WebSocket 上
 * 属于队列的消息交给 `handle`，连接建立、断开时调 `connect` / `disconnect`，并按 `SWEEP_INTERVAL_MS` 驱动 `tick`。
 */
import { createServer } from 'node:http';
import { acceptUpgrade, rejectUpgrade, CLOSE } from './ws.mjs';
import { QUEUE_DEFAULTS } from '../render-queue/constants.mjs';
import { parseInbound, NODE_TYPES, PUBLISHER_TYPES } from '../render-queue/messages.mjs';

/** 交给渲染任务队列处理的消息类型 */
const QUEUE_TYPES = new Set(['node.hello', 'publisher.hello', ...NODE_TYPES, ...PUBLISHER_TYPES]);

export const DOCSERVICE_DEFAULTS = Object.freeze({
  /** 单条消息上限。这条连接只传小消息（document-service.md「职责」） */
  MAX_PAYLOAD: 1024 * 1024,
  MAX_CONNECTIONS: 256,
  /** 每隔这么久 ping 一次；上一轮的 ping 没等到 pong 就断开 */
  HEARTBEAT_MS: 30_000,
});

const ANONYMOUS = Object.freeze({ userId: 'anonymous', tenantId: null });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

/** 缺省日志：一行一条 JSON，写 stdout（PM2 会收走） */
function jsonLog(event, fields) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

/**
 * @param {object} [options]
 * @param {(req: import('node:http').IncomingMessage) => ({ userId: string, tenantId?: string | null } | null)} [options.authenticate]
 *   建连时定 principal；返回 null 拒绝（401）。缺省所有人都是匿名用户。
 * @param {string} [options.path] 接受 WebSocket 的路径，缺省 `/`
 * @param {number} [options.maxPayload]
 * @param {number} [options.maxConnections]
 * @param {number} [options.heartbeatMs]
 * @param {number} [options.sweepMs] 挂上队列后调 `tick` 的间隔，缺省 `QUEUE_DEFAULTS.SWEEP_INTERVAL_MS`
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 */
export function createDocService(options = {}) {
  const {
    authenticate = () => ANONYMOUS,
    path = '/',
    maxPayload = DOCSERVICE_DEFAULTS.MAX_PAYLOAD,
    maxConnections = DOCSERVICE_DEFAULTS.MAX_CONNECTIONS,
    heartbeatMs = DOCSERVICE_DEFAULTS.HEARTBEAT_MS,
    sweepMs = QUEUE_DEFAULTS.SWEEP_INTERVAL_MS,
    now = Date.now,
    log = jsonLog,
  } = options;

  const startedAt = now();
  /** connId → 连接记录 */
  const conns = new Map();
  let seq = 0;
  let queue = null;
  let sweepTimer = null;
  let closing = false;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(health()));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (closing) return rejectUpgrade(socket, 503, 'Service Unavailable');
    if (url.pathname !== path) return rejectUpgrade(socket, 404, 'Not Found');
    if (conns.size >= maxConnections) return rejectUpgrade(socket, 503, 'Service Unavailable');
    let principal;
    try {
      principal = authenticate(req);
    } catch {
      principal = null;
    }
    if (!principal || typeof principal.userId !== 'string') return rejectUpgrade(socket, 401, 'Unauthorized');
    const ws = acceptUpgrade(req, socket, head, { maxPayload });
    if (!ws) return;
    open(ws, { userId: principal.userId, tenantId: typeof principal.tenantId === 'string' ? principal.tenantId : null });
  });

  function open(ws, principal) {
    const connId = `conn-${++seq}`;
    const conn = {
      connId, ws, principal,
      remote: ws.remoteAddress,
      connectedAt: now(),
      alive: true,
      publisherId: null,
      node: null,
    };
    conns.set(connId, conn);
    log('conn.open', { connId, remote: conn.remote, userId: principal.userId });
    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (text) => {
      conn.alive = true;
      onMessage(conn, text);
    });
    ws.on('close', ({ code, reason }) => {
      conns.delete(connId);
      queue?.disconnect(connId);
      log('conn.close', { connId, code, reason, publisherId: conn.publisherId, nodeId: conn.node?.nodeId ?? null });
    });
    queue?.connect(connId, principal);
  }

  function reply(conn, message) {
    conn.ws.send(JSON.stringify(message));
  }

  function error(conn, reason, detail, reqId) {
    const msg = { type: 'error', reason, detail };
    if (reqId !== undefined) msg.reqId = reqId;
    reply(conn, msg);
  }

  function onMessage(conn, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return error(conn, 'bad-message', '不是合法的 JSON');
    }
    const reqId = isObj(msg) && isReqId(msg.reqId) ? msg.reqId : undefined;
    if (!isObj(msg) || typeof msg.type !== 'string') return error(conn, 'bad-message', '消息必须是带 type 字段的对象', reqId);
    if (QUEUE_TYPES.has(msg.type)) return toQueue(conn, msg, reqId);
    return error(conn, 'unsupported', `文档服务骨架还不支持 ${msg.type}`, reqId);
  }

  function toQueue(conn, msg, reqId) {
    if (!queue) return error(conn, 'queue-unavailable', '渲染任务队列还没有挂上', reqId);
    // hello 由队列回 welcome；这里只在消息合法时记下这条连接的角色（队列会用同一套校验）
    if (msg.type === 'node.hello' || msg.type === 'publisher.hello') {
      const parsed = parseInbound(msg);
      if (parsed.ok) recordRole(conn, parsed.type, parsed.body);
    }
    queue.handle(conn.connId, msg);
  }

  function recordRole(conn, type, body) {
    if (type === 'publisher.hello') {
      conn.publisherId = body.publisherId;
      log('role.publisher', { connId: conn.connId, publisherId: body.publisherId, userId: conn.principal.userId });
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
    log('role.node', { connId: conn.connId, nodeId: body.nodeId, profile: body.profile, userId: conn.principal.userId });
  }

  function rolesOf(conn) {
    const roles = [];
    if (conn.publisherId !== null) roles.push('publisher');
    if (conn.node) roles.push('node');
    return roles;
  }

  function health() {
    const list = [...conns.values()];
    return {
      ok: true,
      service: 'promptcut-docservice',
      uptimeMs: now() - startedAt,
      queue: queue !== null,
      connections: list.length,
      publishers: list.filter((c) => c.publisherId !== null).length,
      nodes: list.filter((c) => c.node).length,
    };
  }

  const heartbeat = setInterval(() => {
    for (const conn of conns.values()) {
      if (!conn.alive) {
        log('conn.timeout', { connId: conn.connId });
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    server,

    /** 开始监听，返回实际地址（port 传 0 时由系统分配） */
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },

    /** 渲染任务队列往外发消息走这里（createRenderQueue 的 `send`）。连接已断就丢弃 */
    send(connId, message) {
      const conn = conns.get(connId);
      if (conn) reply(conn, message);
    },

    /**
     * 挂上渲染任务队列。`queueInterface` 要有契约 A.3 的 `connect` / `disconnect` / `handle` / `tick`，
     * 且构造时的 `send` 已接到本服务的 `send`。已有的连接会立刻按各自的 principal `connect` 进去。
     * 返回卸下函数：卸下时对所有连接调 `disconnect`，已记的角色清空。
     */
    mountRenderQueue(queueInterface) {
      if (queue) throw new Error('渲染任务队列已经挂上了');
      for (const m of ['connect', 'disconnect', 'handle', 'tick']) {
        if (typeof queueInterface?.[m] !== 'function') throw new TypeError(`queueInterface.${m} 必须是函数`);
      }
      queue = queueInterface;
      for (const conn of conns.values()) queue.connect(conn.connId, conn.principal);
      sweepTimer = setInterval(() => queue?.tick(), sweepMs);
      sweepTimer.unref?.();
      log('queue.mount', { epoch: queueInterface.epoch ?? null });
      const mounted = queueInterface;
      return () => {
        if (queue !== mounted) return;
        clearInterval(sweepTimer);
        sweepTimer = null;
        for (const conn of conns.values()) {
          queue.disconnect(conn.connId);
          conn.publisherId = null;
          conn.node = null;
        }
        queue = null;
        log('queue.unmount', {});
      };
    },

    /** 诊断：每条连接的身份与角色 */
    describe() {
      return {
        ...health(),
        conns: [...conns.values()].map((c) => ({
          connId: c.connId,
          remote: c.remote,
          principal: { ...c.principal },
          connectedAt: c.connectedAt,
          roles: rolesOf(c),
          publisherId: c.publisherId,
          node: c.node ? structuredClone(c.node) : null,
        })),
      };
    },

    /** 停止监听，给所有连接发 1001 后关掉 */
    close() {
      closing = true;
      clearInterval(heartbeat);
      clearInterval(sweepTimer);
      for (const conn of conns.values()) conn.ws.close(CLOSE.GOING_AWAY, 'server shutting down');
      const done = new Promise((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      return done;
    },
  };
}
