/**
 * 文档服务的组装层：HTTP 与 WebSocket 升级、建连鉴权、心跳、`/healthz`、诊断，以及旧接口 `mountRenderQueue` 的外观。
 *
 * 语义见 `docs/semantics/architecture/document-service.md`，契约见 `docs/plan/render-queue-contract.md` G.4。
 * 文档服务是通用的文本 / JSON 分发中心：
 * - 传输在 `ws.mjs`；
 * - 通用核心在 `router.mjs`（连接登记、信封解析、按类型路由、模块挂载），不认识任何业务；
 * - 业务都是挂上来的模块（`modules/`）：渲染任务队列、服务地址登记，以后还可以挂与渲染无关的文本处理模块。
 *
 * 这一版还没有项目文档、操作日志、`projectRev` / `cardRev`、锁和内容库（`docs/plan/cloud-task.md` 第 6 步）。
 * `principal` 由 `authenticate` 钩子在建连时给出（集群令牌见 `auth.mjs`），缺省是匿名；消息里自报的一律不认。
 *
 * 渲染任务队列的旧接口保留：创建时挂一个占位模块（队列消息一律回 `queue-unavailable`），
 * `mountRenderQueue(q)` 把占位换成真队列，它返回的卸载函数再换回占位。
 */
import { createServer } from 'node:http';
import { acceptUpgrade, rejectUpgrade, CLOSE } from './ws.mjs';
import { createRouter } from './router.mjs';
import { PROTOCOL, offeredProtocols } from './auth.mjs';
import { QUEUE_DEFAULTS } from '../render-queue/constants.mjs';
import { renderQueueModule, renderQueuePlaceholder, RENDER_QUEUE_MODULE } from './modules/render-queue.mjs';

export const DOCSERVICE_DEFAULTS = Object.freeze({
  /** 单条消息上限。这条连接只传小消息（document-service.md「职责」） */
  MAX_PAYLOAD: 1024 * 1024,
  MAX_CONNECTIONS: 256,
  /** 每隔这么久 ping 一次；上一轮的 ping 没等到 pong 就断开 */
  HEARTBEAT_MS: 30_000,
});

const ANONYMOUS = Object.freeze({ userId: 'anonymous', tenantId: null });

/** 缺省日志：一行一条 JSON，写 stdout（PM2 会收走） */
function jsonLog(event, fields) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

/**
 * @param {object} [options]
 * @param {(req: import('node:http').IncomingMessage) => ({ userId: string, tenantId?: string | null } | null)} [options.authenticate]
 *   建连时定 principal；返回 null 拒绝（401）。缺省所有人都是匿名用户。集群令牌鉴权用 `auth.mjs` 的 `createClusterAuth`。
 * @param {string} [options.path] 接受 WebSocket 的路径，缺省 `/`
 * @param {number} [options.maxPayload]
 * @param {number} [options.maxConnections]
 * @param {number} [options.heartbeatMs]
 * @param {number} [options.sweepMs] `mountRenderQueue` 挂上的队列调 `tick` 的间隔，缺省 `QUEUE_DEFAULTS.SWEEP_INTERVAL_MS`
 * @param {object[]} [options.modules] 创建时挂上的模块（契约 G.3）
 * @param {boolean} [options.autoTick] 缺省 true；false 时不起模块计时器，由调用方手动 `tick()`
 * @param {string} [options.protocol] 客户端给了这个子协议时握手回显它，缺省 `promptcut.v1`
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
    modules = [],
    autoTick = true,
    protocol = PROTOCOL,
    now = Date.now,
    log = jsonLog,
  } = options;

  const startedAt = now();
  /** connId → { ws, alive }：传输与心跳的状态；连接身份在核心里 */
  const sockets = new Map();
  /** 模块名 → { mod, timer }，按挂载顺序 */
  const mounted = new Map();
  let seq = 0;
  let closing = false;

  const router = createRouter({
    now,
    log,
    write(connId, text) {
      sockets.get(connId)?.ws.send(text);
    },
  });

  /** 挂一个模块：核心做冲突检查与 connect，这里按 `tickMs` 起计时器 */
  function mount(mod) {
    const unmountCore = router.mount(mod);
    let timer = null;
    if (autoTick && typeof mod.tick === 'function' && Number.isFinite(mod.tickMs) && mod.tickMs > 0) {
      timer = setInterval(() => router.tick(mod.name), mod.tickMs);
      timer.unref?.();
    }
    const record = { mod, timer };
    mounted.set(mod.name, record);
    let done = false;
    return function unmount() {
      if (done) return;
      done = true;
      clearInterval(record.timer);
      if (mounted.get(mod.name) === record) mounted.delete(mod.name);
      unmountCore();
    };
  }

  /**
   * 队列槽位：`placeholder` 时挂的是占位模块，`real` 时是真队列。
   * `modules` 选项里自带同名模块时不挂占位，槽位算作已挂真队列。
   */
  let queueSlot = null;
  if (modules.some((m) => m?.name === RENDER_QUEUE_MODULE)) {
    queueSlot = { kind: 'real', unmount: null };
  } else {
    queueSlot = { kind: 'placeholder', unmount: mount(renderQueuePlaceholder()) };
  }
  for (const mod of modules) {
    const unmount = mount(mod);
    if (mod.name === RENDER_QUEUE_MODULE) queueSlot.unmount = unmount;
  }

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
    if (sockets.size >= maxConnections) return rejectUpgrade(socket, 503, 'Service Unavailable');
    let principal;
    try {
      principal = authenticate(req);
    } catch {
      principal = null;
    }
    if (!principal || typeof principal.userId !== 'string') return rejectUpgrade(socket, 401, 'Unauthorized');
    // 只回显约定的子协议，客户端给的其它项（包括令牌那一项）一律不回
    const echo = offeredProtocols(req).includes(protocol) ? protocol : undefined;
    const ws = acceptUpgrade(req, socket, head, { maxPayload, protocol: echo });
    if (!ws) return;
    open(ws, { userId: principal.userId, tenantId: typeof principal.tenantId === 'string' ? principal.tenantId : null });
  });

  function open(ws, principal) {
    const connId = `conn-${++seq}`;
    const conn = { ws, alive: true };
    sockets.set(connId, conn);
    log('conn.open', { connId, remote: ws.remoteAddress, userId: principal.userId });
    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (text) => {
      conn.alive = true;
      router.dispatch(connId, text);
    });
    ws.on('close', ({ code, reason }) => {
      sockets.delete(connId);
      router.disconnect(connId);
      log('conn.close', { connId, code, reason });
    });
    router.connect(connId, principal, { remote: ws.remoteAddress, connectedAt: now() });
  }

  function health() {
    const core = router.health();
    const out = {
      ok: true,
      service: 'promptcut-docservice',
      uptimeMs: now() - startedAt,
      connections: core.connections,
      protocol,
      modules: core.modules,
    };
    for (const [k, v] of Object.entries(core)) {
      if (!Object.hasOwn(out, k)) out[k] = v;
    }
    return out;
  }

  const heartbeat = setInterval(() => {
    for (const [connId, conn] of sockets) {
      if (!conn.alive) {
        log('conn.timeout', { connId });
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

    /** 模块之外往连接上发消息（如 createRenderQueue 的 `send`）。连接已断就丢弃 */
    send(connId, message) {
      router.send(connId, message);
    },

    /** 挂一个模块（契约 G.3），返回卸载函数。类型或字段与已挂模块冲突时抛错、不挂 */
    mount,

    /** 同步调一个（按名）或全部模块的 tick；`autoTick: false` 时测试用它驱动时钟 */
    tick(name) {
      router.tick(name);
    },

    /**
     * 挂上渲染任务队列。`queueInterface` 要有契约 A.3 的 `connect` / `disconnect` / `handle` / `tick`，
     * 且构造时的 `send` 已接到本服务的 `send`。已有的连接会立刻按各自的 principal `connect` 进去。
     * 返回卸下函数：卸下时对所有连接调 `disconnect`，已记的角色清空，队列消息重新回 `queue-unavailable`。
     */
    mountRenderQueue(queueInterface) {
      if (queueSlot.kind === 'real') throw new Error('渲染任务队列已经挂上了');
      const mod = renderQueueModule(queueInterface, { sweepMs });
      queueSlot.unmount();
      let unmountReal;
      try {
        unmountReal = mount(mod);
      } catch (err) {
        queueSlot = { kind: 'placeholder', unmount: mount(renderQueuePlaceholder()) };
        throw err;
      }
      const slot = { kind: 'real', unmount: unmountReal };
      queueSlot = slot;
      log('queue.mount', { epoch: queueInterface.epoch ?? null });
      return () => {
        if (queueSlot !== slot) return;
        unmountReal();
        queueSlot = { kind: 'placeholder', unmount: mount(renderQueuePlaceholder()) };
        log('queue.unmount', {});
      };
    },

    /** 诊断：每条连接的身份与各模块给的字段，以及各模块的 describe */
    describe() {
      return {
        ...health(),
        conns: [...sockets.keys()].map((id) => router.describeConn(id)).filter(Boolean),
        modules: Object.fromEntries(router.modules().map((name) => {
          const mod = mounted.get(name)?.mod;
          return [name, mod?.describe?.() ?? null];
        })),
      };
    },

    /** 停止监听，给所有连接发 1001 后关掉 */
    close() {
      closing = true;
      clearInterval(heartbeat);
      for (const record of mounted.values()) clearInterval(record.timer);
      for (const conn of sockets.values()) conn.ws.close(CLOSE.GOING_AWAY, 'server shutting down');
      const done = new Promise((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      return done;
    },
  };
}
