/**
 * 托管方渲染服务的控制连接（契约 `docs/plan/hosted-render-contract.md` 第 1.2、1.3、2 节）。管理进程用。
 *
 * 凭服务私钥握手（每次建连现取挑战），连上就 `hosted.watch`；之后：
 * - 收 `hosted.projects { full: true }` 整份替换本地清单（**对账的唯一依据**），收 `hosted.project` 逐条改；
 * - 每 `rewatchMs`（60 s）主动重发一次 `hosted.watch` 兜底；
 * - `ticket(projectId)`：发 `hosted.ticket` 要一张进这个项目的连接票据；连接没连上、被拒、超时都抛错（`code` 是原因）；
 * - 断线按退避重连（0.5 s 起、翻倍、封顶 30 s）。断着的时候清单保持最后一次的样子（已有的数据连接照常干活），但要不到新票据。
 * 私钥、签名、票据不进日志。只用 Node 内置的 `WebSocket` 与 `fetch`（都能注入）。
 */
import { buildServiceProtocols } from '../auth/service-identity.mjs';

export const DIRECTORY_DEFAULTS = Object.freeze({ REWATCH_MS: 60_000, TICKET_TIMEOUT_MS: 10_000, BACKOFF_MIN_MS: 500, BACKOFF_MAX_MS: 30_000 });

/**
 * @param {object} options
 * @param {string} options.url 文档服务的本机地址（`ws://127.0.0.1:8787`）
 * @param {{ service, kid, priv, instanceId, instanceName }} options.key
 * @param {(event: string, fields?: object) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {typeof globalThis.WebSocket} [options.WebSocket]
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {number} [options.rewatchMs]
 * @param {(protocols) => Promise<string[]>} [options.protocols] 测试用：换掉握手子协议的取法
 */
export function createDirectory({
  url, key, log = () => {}, now = Date.now, WebSocket: WS = globalThis.WebSocket, fetch: fetchImpl = globalThis.fetch,
  rewatchMs = DIRECTORY_DEFAULTS.REWATCH_MS, ticketTimeoutMs = DIRECTORY_DEFAULTS.TICKET_TIMEOUT_MS, protocols,
} = {}) {
  /** projectId → { projectId, enabled, active, members, hosted, since }；`since` 是它变成 active 的时刻（排队用） */
  const projects = new Map();
  /** reqId → { resolve, reject, timer } */
  const waiting = new Map();
  const listeners = new Set();
  let ws = null;
  let connected = false;
  let stopped = true;
  let backoff = DIRECTORY_DEFAULTS.BACKOFF_MIN_MS;
  let retryTimer = null;
  let rewatchTimer = null;
  let seq = 0;
  let syncedAt = null;
  let opens = 0;
  let lastClose = null;

  const notify = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* 监听出错不影响连接 */ } } };

  function put(item) {
    const prev = projects.get(item.projectId);
    const since = item.active === true ? (prev?.active === true ? prev.since : now()) : null;
    projects.set(item.projectId, {
      projectId: item.projectId, enabled: item.enabled === true, active: item.active === true, members: item.members === true,
      hosted: item.hosted ?? null, since,
    });
  }

  function onMessage(msg) {
    if (msg?.type === 'hosted.projects' && Array.isArray(msg.projects)) {
      const keep = new Set(msg.projects.map((p) => p.projectId));
      for (const id of [...projects.keys()]) if (!keep.has(id)) projects.delete(id);
      for (const item of msg.projects) put(item);
      syncedAt = now();
      notify();
      return;
    }
    if (msg?.type === 'hosted.project' && typeof msg.projectId === 'string') {
      if (msg.removed === true) projects.delete(msg.projectId);
      else put(msg);
      notify();
      return;
    }
    const w = typeof msg?.reqId === 'string' ? waiting.get(msg.reqId) : undefined;
    if (!w) return;
    waiting.delete(msg.reqId);
    clearTimeout(w.timer);
    if (msg.type === 'error') w.reject(Object.assign(new Error(`目录拒绝：${msg.reason}`), { code: msg.reason }));
    else w.resolve(msg);
  }

  function request(message, timeoutMs = ticketTimeoutMs) {
    return new Promise((resolve, reject) => {
      if (!connected || !ws) {
        reject(Object.assign(new Error('控制连接没连上'), { code: 'directory-offline' }));
        return;
      }
      const reqId = `dir-${++seq}`;
      const timer = setTimeout(() => {
        waiting.delete(reqId);
        reject(Object.assign(new Error('目录没有应答'), { code: 'directory-timeout' }));
      }, timeoutMs);
      timer.unref?.();
      waiting.set(reqId, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ ...message, reqId })); } catch (err) {
        waiting.delete(reqId);
        clearTimeout(timer);
        reject(Object.assign(new Error('控制连接发不出去'), { code: 'directory-offline', cause: err }));
      }
    });
  }

  const watch = () => { try { ws?.send(JSON.stringify({ type: 'hosted.watch' })); } catch { /* 断了，等重连 */ } };

  function failWaiting(code) {
    for (const [reqId, w] of waiting) {
      clearTimeout(w.timer);
      w.reject(Object.assign(new Error('控制连接断了'), { code }));
      waiting.delete(reqId);
    }
  }

  function schedule() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, backoff);
    retryTimer.unref?.();
    backoff = Math.min(backoff * 2, DIRECTORY_DEFAULTS.BACKOFF_MAX_MS);
  }

  async function connect() {
    if (stopped || ws) return;
    let list;
    try {
      list = typeof protocols === 'function' ? await protocols() : await buildServiceProtocols({ base: url, key, fetch: fetchImpl });
    } catch (err) {
      log('directory.connect-failed', { stage: 'challenge', reason: String(err?.code ?? err?.message ?? err) });
      schedule();
      return;
    }
    if (stopped) return;
    let sock;
    try { sock = new WS(url, list); } catch (err) {
      log('directory.connect-failed', { stage: 'open', reason: String(err?.message ?? err) });
      schedule();
      return;
    }
    ws = sock;
    sock.addEventListener('open', () => {
      if (ws !== sock) return;
      connected = true;
      opens += 1;
      backoff = DIRECTORY_DEFAULTS.BACKOFF_MIN_MS;
      log('directory.open', { opens });
      watch();
      notify();
    });
    sock.addEventListener('message', (e) => {
      if (ws !== sock) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      onMessage(msg);
    });
    sock.addEventListener('close', (e) => {
      if (ws !== sock) return;
      ws = null;
      const was = connected;
      connected = false;
      lastClose = { code: e?.code ?? null, reason: String(e?.reason ?? '') };
      failWaiting('directory-offline');
      log(was ? 'directory.close' : 'directory.connect-failed', { stage: 'handshake', ...lastClose });
      notify();
      schedule();
    });
    sock.addEventListener('error', () => { /* close 随后就到 */ });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void connect();
      rewatchTimer = setInterval(() => { if (connected) watch(); }, rewatchMs);
      rewatchTimer.unref?.();
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      clearInterval(rewatchTimer);
      failWaiting('directory-stopped');
      const sock = ws;
      ws = null;
      connected = false;
      try { sock?.close(); } catch { /* 已关 */ }
    },
    get connected() { return connected; },
    /** 清单的快照（数组） */
    list: () => [...projects.values()].map((p) => ({ ...p })),
    get(projectId) { const p = projects.get(projectId); return p ? { ...p } : null; },
    /** 要一张进这个项目的连接票据 */
    async ticket(projectId) {
      const r = await request({ type: 'hosted.ticket', projectId });
      if (r.type !== 'hosted.ticket.ok' || typeof r.ticket !== 'string') throw Object.assign(new Error('目录回包不对'), { code: 'directory-bad-reply' });
      return { ticket: r.ticket, exp: r.exp };
    },
    /** 立刻重取一份完整清单 */
    rewatch: watch,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    status: () => ({ connected, opens, syncedAt, projects: projects.size, lastClose }),
  };
}
