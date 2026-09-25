/**
 * Agent 服务端到文档服务的连接与项目副本（C6.5 设计稿 `docs/plan/c65-design.md` 第 5 节，`cloud-task.md` D1）。
 *
 * - **一个对话一条连接**：写入身份（`actor`）只取连接的 principal（`auth-contract.md` 第 6 节），对话号是握手时定的，
 *   所以要让每个对话的写入都记成「agent + 它自己的对话号」，每个对话得有自己的一条 `agent` 角色连接。
 *   凭证由调用方按对话号给（`protocolsFor(n)`）：本机 `local` 空间是 `promptcut.role.agent.<n>`，局域网主机上
 *   创建者自己的项目再加 `promptcut.tenant.<projectId>`，共享项目（托管端、局域网成员）是页面签发的连接票据。
 * - **一份副本**：所有对话读同一份项目副本（设计稿第 5 节）。第一条连上的对话连接兼做「订阅」：发 `project.open`，
 *   收 `project.state` 与别人的 `project.ops`；各对话自己的提交由执行器在拿到 `project.op.ok` 后交给副本。
 *   两路（订阅连接上的广播、各对话连接上的 ok）可能交错到达，副本按 `rev` 排队、连续才应用、重复的丢掉；
 *   缺口超过 `gapTimeoutMs` 或应用失败就重新 `project.open`。
 * - 应用操作用文档服务同一份引擎（`../docservice/json-ops.mjs`），副本与文档服务的真身逐字节相同。
 *
 * 只依赖 Node 内置能力与本仓库的 `json-ops.mjs`；WebSocket 实现可注入（缺省用全局 `WebSocket`）。
 */
import { applyOps } from '../docservice/json-ops.mjs';

export const AGENT_LINK_DEFAULTS = Object.freeze({
  /** 一次请求（提交、事件、内容库）等回包的上限 */
  requestTimeoutMs: 15_000,
  /** 副本收到的版本有缺口时，最多等这么久，还不连续就重新打开 */
  gapTimeoutMs: 2_000,
  /** 订阅连接断开后的重连间隔（逐次加长，封顶最后一个） */
  reconnectMs: [200, 500, 1000, 2000, 5000],
  /** 副本记住最近多少次提交的摘要（opId、写入身份），给页面侧工具的写入归属用 */
  historyKeep: 1000,
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function linkError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * 项目副本：按 `rev` 顺序应用操作。
 * 状态：`hasState`（收到过 `project.state`）、`hasBody`（文档服务里这个项目有真身）、`rev`、`project`。
 */
class Replica {
  constructor({ gapTimeoutMs, historyKeep, onResync, log }) {
    this.gapTimeoutMs = gapTimeoutMs;
    this.historyKeep = historyKeep;
    this.onResync = onResync;
    this.log = log;
    this.hasState = false;
    this.hasBody = false;
    this.rev = 0;
    this.project = null;
    /** rev → { ops, meta }：比当前版本新、还不连续的 */
    this.buffered = new Map();
    /** 最近的提交摘要：{ rev, opId, actor, session } */
    this.history = [];
    this.gapTimer = null;
    this.waiters = new Set();
    this.resyncing = false;
  }

  /** 整份换成 `project.state` 给的内容 */
  setState(rev, project) {
    this.hasState = true;
    this.resyncing = false;
    this.hasBody = project !== null && project !== undefined;
    this.project = this.hasBody ? project : null;
    this.rev = rev;
    for (const r of [...this.buffered.keys()]) if (r <= rev) this.buffered.delete(r);
    this.drain();
    this.notify();
  }

  /** 一次提交落地了（别人的广播，或自己的 ok）；`ops` 为 null 表示没带操作（大的根替换），要重新打开 */
  offer(rev, ops, meta = {}) {
    if (!Number.isSafeInteger(rev)) return;
    if (this.hasState && rev <= this.rev) return;
    if (!this.buffered.has(rev)) this.buffered.set(rev, { ops, meta });
    if (!this.hasState || this.resyncing) return;
    this.drain();
    this.notify();
  }

  drain() {
    while (this.buffered.has(this.rev + 1)) {
      const next = this.rev + 1;
      const { ops, meta } = this.buffered.get(next);
      this.buffered.delete(next);
      if (!Array.isArray(ops)) return this.resync('远端的提交没带操作（大的根替换）');
      let root;
      try {
        root = applyOps(this.project, ops).root;
      } catch (err) {
        return this.resync(`远端操作在副本上落不下去：${err?.message ?? err}`);
      }
      this.project = root;
      this.hasBody = true;
      this.rev = next;
      this.history.push({ rev: next, opId: meta.opId ?? null, actor: meta.actor ?? null, session: meta.session ?? meta.actor?.session ?? null });
      if (this.history.length > this.historyKeep) this.history.splice(0, this.history.length - this.historyKeep);
    }
    clearTimeout(this.gapTimer);
    this.gapTimer = null;
    if (this.buffered.size > 0) {
      this.gapTimer = setTimeout(() => {
        this.gapTimer = null;
        if (this.buffered.size > 0) this.resync(`版本有缺口：副本在 ${this.rev}，收到了 ${[...this.buffered.keys()].sort((a, b) => a - b).join(', ')}`);
      }, this.gapTimeoutMs);
      this.gapTimer.unref?.();
    }
  }

  resync(reason) {
    this.log('agent.replica.resync', { reason, rev: this.rev });
    this.resyncing = true;
    clearTimeout(this.gapTimer);
    this.gapTimer = null;
    this.onResync(reason);
  }

  /** 版本号到 `rev`（或以上）时 resolve；超时 resolve false */
  waitRev(rev, timeoutMs) {
    if (this.hasState && this.rev >= rev) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = {
        check: () => {
          if (this.hasState && this.rev >= rev) {
            clearTimeout(w.timer);
            this.waiters.delete(w);
            resolve(true);
          }
        },
        timer: setTimeout(() => {
          this.waiters.delete(w);
          resolve(false);
        }, timeoutMs),
      };
      w.timer.unref?.();
      this.waiters.add(w);
    });
  }

  notify() {
    for (const w of [...this.waiters]) w.check();
  }

  /** 这个 opId 落地的版本；副本里没有回 null */
  revOfOpId(opId) {
    for (let i = this.history.length - 1; i >= 0; i -= 1) if (this.history[i].opId === opId) return this.history[i].rev;
    return null;
  }

  /** (from, to] 之间每一版的摘要；缺了（太久远）回 null */
  between(from, to) {
    const out = this.history.filter((h) => h.rev > from && h.rev <= to);
    return out.length === to - from ? out : null;
  }

  dispose() {
    clearTimeout(this.gapTimer);
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters.clear();
  }
}

/**
 * @param {object} options
 * @param {string} options.url 文档服务的 WebSocket 地址
 * @param {string} options.projectId
 * @param {(conversation: number) => Promise<string[]> | string[]} options.protocolsFor 这个对话的连接用的子协议（含 `promptcut.v1`）
 * @param {typeof WebSocket} [options.WebSocketImpl]
 * @param {(event: string, fields?: object) => void} [options.log]
 */
export function createAgentLink({
  url,
  projectId,
  protocolsFor,
  WebSocketImpl = globalThis.WebSocket,
  log = () => {},
  requestTimeoutMs = AGENT_LINK_DEFAULTS.requestTimeoutMs,
  gapTimeoutMs = AGENT_LINK_DEFAULTS.gapTimeoutMs,
  reconnectMs = AGENT_LINK_DEFAULTS.reconnectMs,
  historyKeep = AGENT_LINK_DEFAULTS.historyKeep,
} = {}) {
  if (typeof url !== 'string' || !url) throw new TypeError('createAgentLink: url 必须是字符串');
  if (typeof projectId !== 'string' || !projectId) throw new TypeError('createAgentLink: projectId 必须是字符串');
  if (typeof protocolsFor !== 'function') throw new TypeError('createAgentLink: protocolsFor 必须是函数');
  if (typeof WebSocketImpl !== 'function') throw new TypeError('createAgentLink: 没有可用的 WebSocket 实现');
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响连接 */ } };

  let closed = false;
  /** 对话号 → 连接 */
  const conns = new Map();
  /** 兼做订阅的那条连接的对话号 */
  let feedConv = null;
  let reqSeq = 0;
  const listeners = new Set();
  /** 分片接收中的 project.state */
  let partial = null;
  let stateWaiters = [];

  const replica = new Replica({
    gapTimeoutMs,
    historyKeep,
    log: say,
    onResync: () => openFeed(),
  });

  function emit(message, conversation) {
    for (const cb of [...listeners]) {
      try { cb(message, conversation); } catch (err) { say('agent.link.listener-error', { message: String(err?.message ?? err) }); }
    }
  }

  function resolveStateWaiters() {
    const ws = stateWaiters;
    stateWaiters = [];
    for (const w of ws) { clearTimeout(w.timer); w.resolve(); }
  }

  function onFeedMessage(msg) {
    switch (msg.type) {
      case 'project.state':
        if (msg.projectId !== undefined && msg.projectId !== projectId) return;
        if (msg.project === undefined && Number.isSafeInteger(msg.parts)) {
          partial = { rev: msg.rev, count: msg.parts, chunks: [] };
          return;
        }
        partial = null;
        replica.setState(msg.rev, msg.project ?? null);
        resolveStateWaiters();
        return;
      case 'project.state.part':
        if (partial && msg.rev === partial.rev) partial.chunks[msg.index] = msg.data;
        return;
      case 'project.state.end': {
        const part = partial;
        if (!part || msg.rev !== part.rev) return;
        partial = null;
        let project;
        try {
          if (part.chunks.length !== part.count || part.chunks.some((c) => typeof c !== 'string')) throw new Error('分片不全');
          project = JSON.parse(part.chunks.join(''));
        } catch (err) {
          say('agent.replica.state-broken', { message: String(err?.message ?? err) });
          openFeed();
          return;
        }
        replica.setState(part.rev, project);
        resolveStateWaiters();
        return;
      }
      case 'project.ops':
        if (msg.projectId !== undefined && msg.projectId !== projectId) return;
        replica.offer(msg.rev, msg.resync ? null : (Array.isArray(msg.ops) ? msg.ops : null), { opId: msg.opId, actor: msg.actor, session: msg.session });
        return;
      default:
    }
  }

  function openFeed() {
    if (closed || feedConv === null) return;
    const conn = conns.get(feedConv);
    if (!conn || conn.state !== 'open') return;
    partial = null;
    conn.sendRaw({ type: 'project.open', projectId });
  }

  function makeConn(n) {
    const conn = {
      n,
      state: 'idle',
      ws: null,
      opening: null,
      waiters: new Map(),
      retry: 0,
      retryTimer: null,
      sendRaw(message) {
        if (conn.state !== 'open' || !conn.ws) return false;
        try {
          conn.ws.send(JSON.stringify(message));
          return true;
        } catch {
          return false;
        }
      },
    };

    conn.open = () => {
      if (closed) return Promise.reject(linkError('closed', '到文档服务的连接已关闭'));
      if (conn.state === 'open') return Promise.resolve();
      if (conn.opening) return conn.opening;
      conn.state = 'connecting';
      conn.opening = (async () => {
        let protocols;
        try {
          protocols = await protocolsFor(n);
        } catch (err) {
          conn.state = 'idle';
          conn.opening = null;
          throw linkError('no-credential', `对话 ${n} 拿不到连接文档服务的凭证：${err?.message ?? err}`);
        }
        await new Promise((resolve, reject) => {
          let ws;
          try {
            ws = new WebSocketImpl(url, protocols);
          } catch (err) {
            reject(linkError('connect-failed', `连不上文档服务：${err?.message ?? err}`));
            return;
          }
          conn.ws = ws;
          let opened = false;
          ws.addEventListener('open', () => {
            if (conn.ws !== ws) return;
            opened = true;
            conn.state = 'open';
            conn.retry = 0;
            say('agent.link.open', { conversation: n });
            resolve();
            if (feedConv === n) openFeed();
          });
          ws.addEventListener('message', (e) => {
            if (conn.ws !== ws) return;
            let msg;
            try { msg = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)); } catch { return; }
            if (!isObj(msg)) return;
            const waiter = msg.reqId !== undefined ? conn.waiters.get(msg.reqId) : undefined;
            if (waiter && waiter.accept(msg)) {
              conn.waiters.delete(msg.reqId);
              clearTimeout(waiter.timer);
              waiter.resolve(msg);
              return;
            }
            if (feedConv === n) onFeedMessage(msg);
            emit(msg, n);
          });
          const down = () => {
            if (conn.ws !== ws) return;
            conn.ws = null;
            conn.state = 'idle';
            conn.opening = null;
            for (const [reqId, w] of conn.waiters) {
              clearTimeout(w.timer);
              w.reject(linkError('disconnected', '到文档服务的连接断了'));
              conn.waiters.delete(reqId);
            }
            if (!opened) {
              reject(linkError('connect-failed', '连不上文档服务（握手被拒或网络不通）'));
              return;
            }
            say('agent.link.close', { conversation: n });
            if (feedConv === n && !closed) {
              // 订阅连接断了：副本在重新 open 之前不再可信
              replica.hasState = false;
              const delays = reconnectMs;
              const wait = delays[Math.min(conn.retry, delays.length - 1)];
              conn.retry += 1;
              conn.retryTimer = setTimeout(() => { conn.retryTimer = null; conn.open().catch(() => {}); }, wait);
              conn.retryTimer.unref?.();
            }
          };
          ws.addEventListener('close', down);
          ws.addEventListener('error', down);
        });
        conn.opening = null;
      })();
      conn.opening.catch(() => { conn.opening = null; });
      return conn.opening;
    };

    /**
     * 发一个请求，等同一 `reqId` 的回包。`accept(msg)` 判断这条是不是它的终结回包（缺省任何同 reqId 的都算）。
     */
    conn.request = async (message, accept = () => true) => {
      await conn.open();
      const reqId = `agent${n}#${++reqSeq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          conn.waiters.delete(reqId);
          reject(linkError('timeout', `${message.type} 在 ${requestTimeoutMs} ms 内没有回包`));
        }, requestTimeoutMs);
        timer.unref?.();
        conn.waiters.set(reqId, { resolve, reject, timer, accept });
        if (!conn.sendRaw({ ...message, reqId })) {
          clearTimeout(timer);
          conn.waiters.delete(reqId);
          reject(linkError('disconnected', '到文档服务的连接没就绪'));
        }
      });
    };

    conn.close = () => {
      clearTimeout(conn.retryTimer);
      const ws = conn.ws;
      conn.ws = null;
      conn.state = 'closed';
      for (const w of conn.waiters.values()) { clearTimeout(w.timer); w.reject(linkError('closed', '连接已关闭')); }
      conn.waiters.clear();
      try { ws?.close(); } catch { /* 已经断了 */ }
    };
    return conn;
  }

  function conversation(n) {
    if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('对话号必须是正整数');
    let conn = conns.get(n);
    if (!conn) {
      conn = makeConn(n);
      conns.set(n, conn);
      if (feedConv === null) feedConv = n;
    }
    return conn;
  }

  return {
    projectId,
    url,
    replica,

    /** 取某个对话的连接（没有就建，用到时才连） */
    conversation,

    /**
     * 等副本就绪（收到过 `project.state`）。副本就绪之前，订阅连接要先连上。
     * 超时抛 `code: 'not-ready'`。
     */
    async ready(timeoutMs = requestTimeoutMs) {
      if (closed) throw linkError('closed', '到文档服务的连接已关闭');
      if (feedConv === null) throw linkError('not-ready', '还没有任何对话连接');
      if (replica.hasState && !replica.resyncing) return;
      await conns.get(feedConv).open();
      if (replica.hasState && !replica.resyncing) return;
      await new Promise((resolve, reject) => {
        const w = { resolve, timer: setTimeout(() => {
          stateWaiters = stateWaiters.filter((x) => x !== w);
          reject(linkError('not-ready', `${timeoutMs} ms 内没有拿到项目 ${projectId} 的内容`));
        }, timeoutMs) };
        w.timer.unref?.();
        stateWaiters.push(w);
      });
    },

    /** 订阅各连接上收到的、不是请求回包的消息（`project.overwritten` 等）；回退订函数 */
    onMessage(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    /** 诊断 */
    describe() {
      return {
        url, projectId, feedConv,
        conversations: [...conns.values()].map((c) => ({ conversation: c.n, state: c.state })),
        replica: { hasState: replica.hasState, hasBody: replica.hasBody, rev: replica.rev, buffered: replica.buffered.size },
      };
    },

    close() {
      if (closed) return;
      closed = true;
      for (const conn of conns.values()) conn.close();
      conns.clear();
      replica.dispose();
      for (const w of stateWaiters) clearTimeout(w.timer);
      stateWaiters = [];
    },
  };
}

/** 只给测试:单独验副本的排队与重开 */
export { Replica as AgentReplica };
