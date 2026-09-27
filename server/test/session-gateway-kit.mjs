/**
 * 仅供测试与本机验证，生产代码不得引用。
 *
 * 会话网关：一个**测试用的最小会话服务端桩**，照契约 `docs/plan/http-transport-contract.md` 第 3、4.1、4.2、5、16 节
 * 与测试方 `server/test/ht-kit.mjs` 的假设（H3～H6）讲会话，在它背后为每个会话开一条旧式（不带会话项）的 WebSocket
 * 连到真的文档服务。这样客户端会话层（`server/render-node/session-link.mjs`）能在服务端会话层（`claude/http-transport`）
 * 合入之前对着真的业务模块测「传输断了接续、两边补发、核心不见断开」。它不是服务端会话层的实现，也不替代它。
 *
 *   - 建会话：列表里有 `promptcut.session.new`，去掉它把其余项原样交给上游握手；上游连上才回 101，
 *     随后发 `session.welcome { sid, resumed: false, ack: 0, retainMs, transport: 'ws' }`；上游握手被拒就回 401。
 *   - 接续：`promptcut.session.<sid>.<ack>`：先接受升级，会话在就挂上（旧传输以 4009 关）、按 ack 释放、发 welcome
 *     （`resumed: true`、`ack` 为已收全的客户端最大 seq）再按原 seq 补发；不在：结束过（墓碑）以 4410 关，否则 4404。
 *   - 序号与确认：两个方向照第 3.3 节；控制消息 `session.ack`、`session.close`；跳号 1002 `bad-seq`。
 *   - 传输断开：脱开，保留 `retainMs`，期满结束会话（关上游、立墓碑）。上游关了：会话以上游的关闭码结束。
 *
 * 只引 Node 内置模块与 `../docservice/ws.mjs`；上游用 Node 内置的 `WebSocket`。
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { acceptUpgrade, rejectUpgrade } from '../docservice/ws.mjs';

const PROTOCOL = 'promptcut.v1';
const SESSION_NEW = 'promptcut.session.new';
const SESSION_PREFIX = 'promptcut.session.';

/**
 * @param {object} o
 * @param {() => string} o.upstream  上游文档服务的 WebSocket 地址（函数：测试可以中途换）
 * @param {number} [o.retainMs]
 * @param {number} [o.ackDelayMs]
 * @param {number} [o.ackEvery]
 * @param {(event: string, fields?: object) => void} [o.log]
 */
export async function startSessionGateway({ upstream, retainMs = 60_000, ackDelayMs = 1000, ackEvery = 32, log = () => {}, port = 0, host = '127.0.0.1' } = {}) {
  const sessions = new Map();
  const tombstones = new Map();
  const stats = { opened: 0, resumed: 0, expired: 0, superseded: 0, badSeq: 0, fromClient: 0, toClient: 0 };
  const upstreamOf = typeof upstream === 'function' ? upstream : () => upstream;

  function end(s, code, reason, { closeUpstream = true } = {}) {
    if (s.ended) return;
    s.ended = true;
    sessions.delete(s.sid);
    tombstones.set(s.sid, { code, reason });
    clearTimeout(s.retainTimer);
    clearTimeout(s.ackTimer);
    if (s.ws) { try { s.ws.close(code, reason); } catch { /* 已关 */ } }
    s.ws = null;
    if (closeUpstream) { try { s.up.close(1000, 'session-ended'); } catch { /* 已关 */ } }
    log('gw.end', { code, reason });
  }

  function sendAck(s) {
    clearTimeout(s.ackTimer);
    s.ackTimer = null;
    if (s.ws && s.inUnacked > 0) {
      s.ws.send(JSON.stringify({ type: 'session.ack', ack: s.inAck }));
      s.inUnacked = 0;
    }
  }

  function write(s, entry) {
    if (!s.ws) return;
    const msg = s.inAck > 0 ? { ...entry.msg, ack: s.inAck } : entry.msg;
    s.ws.send(JSON.stringify(msg));
    if (s.inAck > 0) { s.inUnacked = 0; clearTimeout(s.ackTimer); s.ackTimer = null; }
    stats.toClient++;
  }

  function onPeerAck(s, n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > s.outSeq) {
      stats.badSeq++;
      end(s, 1002, 'bad-seq');
      return false;
    }
    while (s.outBuf.length && s.outBuf[0].seq <= n) s.outBuf.shift();
    return true;
  }

  function attach(s, ws, resumed) {
    if (s.ws) {
      stats.superseded++;
      const old = s.ws;
      s.ws = null;
      try { old.close(4009, 'superseded'); } catch { /* 已关 */ }
    }
    clearTimeout(s.retainTimer);
    s.retainTimer = null;
    s.ws = ws;
    ws.send(JSON.stringify({ type: 'session.welcome', sid: s.sid, resumed, ack: s.inAck, retainMs, transport: 'ws' }));
    s.inUnacked = 0;
    for (const entry of [...s.outBuf]) write(s, entry);
    ws.on('message', (text) => {
      if (s.ws !== ws || s.ended) return;
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type.startsWith('session.')) {
        if (msg.type === 'session.ack') onPeerAck(s, msg.ack);
        else if (msg.type === 'session.close') end(s, 1000, 'closed');
        return;
      }
      if (msg.ack !== undefined && !onPeerAck(s, msg.ack)) return;
      if (!Number.isSafeInteger(msg.seq) || msg.seq > s.inAck + 1) { stats.badSeq++; end(s, 1002, 'bad-seq'); return; }
      if (msg.seq <= s.inAck) return;
      s.inAck = msg.seq;
      const { seq: _s, ack: _a, ...body } = msg;
      stats.fromClient++;
      try { s.up.send(JSON.stringify(body)); } catch { /* 上游在关 */ }
      s.inUnacked++;
      if (s.inUnacked >= ackEvery) sendAck(s);
      else if (!s.ackTimer) s.ackTimer = setTimeout(() => sendAck(s), ackDelayMs);
    });
    ws.on('close', () => {
      if (s.ws !== ws || s.ended) return;
      s.ws = null;
      log('gw.detach', {});
      s.retainTimer = setTimeout(() => { stats.expired++; end(s, 1006, 'timeout'); }, retainMs);
    });
  }

  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const items = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    if (items[0] !== PROTOCOL) { rejectUpgrade(socket, 400, 'Bad Request'); return; }
    const resumeItem = items.find((p) => p.startsWith(SESSION_PREFIX) && p !== SESSION_NEW);
    if (resumeItem) {
      if (items.length !== 2) { rejectUpgrade(socket, 400, 'Bad Request'); return; }
      const rest = resumeItem.slice(SESSION_PREFIX.length);
      const i = rest.lastIndexOf('.');
      const sid = rest.slice(0, i);
      const ack = Number(rest.slice(i + 1));
      const ws = acceptUpgrade(req, socket, head, { maxPayload: 16 * 1024 * 1024, protocol: PROTOCOL });
      if (!ws) return;
      ws.on('close', () => {});
      const s = sessions.get(sid);
      if (!s) {
        const t = tombstones.get(sid);
        if (t) ws.close(4410, `${t.code} ${t.reason}`);
        else ws.close(4404, 'no-session');
        return;
      }
      if (!onPeerAck(s, ack)) { ws.close(4410, '1002 bad-seq'); return; }
      stats.resumed++;
      log('gw.resume', {});
      attach(s, ws, true);
      return;
    }
    if (!items.includes(SESSION_NEW)) { rejectUpgrade(socket, 400, 'Bad Request'); return; }
    const upItems = items.filter((p) => p !== SESSION_NEW);
    const up = new WebSocket(upstreamOf(), upItems);
    let settled = false;
    const s = { sid: randomBytes(32).toString('base64url'), up, ws: null, outSeq: 0, outBuf: [], inAck: 0, inUnacked: 0, ackTimer: null, retainTimer: null, ended: false };
    up.addEventListener('message', (e) => {
      if (s.ended) return;
      let msg;
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      s.outSeq += 1;
      const entry = { seq: s.outSeq, msg: { ...msg, seq: s.outSeq } };
      s.outBuf.push(entry);
      write(s, entry);
    });
    up.addEventListener('open', () => {
      settled = true;
      const ws = acceptUpgrade(req, socket, head, { maxPayload: 16 * 1024 * 1024, protocol: PROTOCOL });
      if (!ws) { try { up.close(); } catch { /* 已关 */ } return; }
      sessions.set(s.sid, s);
      stats.opened++;
      log('gw.open', {});
      attach(s, ws, false);
    });
    const upGone = (code, reason) => {
      if (!settled) {
        settled = true;
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      end(s, code === 1006 || code === 1005 ? 1001 : code, reason || 'upstream-closed', { closeUpstream: false });
    };
    up.addEventListener('close', (e) => upGone(e.code, e.reason));
    up.addEventListener('error', () => upGone(1006, ''));
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    port: server.address().port,
    url: `ws://${host}:${server.address().port}/`,
    stats,
    sessions,
    /** 服务端主动结束某个会话（测 4003 等） */
    endAll(code, reason) { for (const s of [...sessions.values()]) end(s, code, reason); },
    close() {
      for (const s of [...sessions.values()]) end(s, 1001, 'server shutting down');
      return new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
    },
  };
}
