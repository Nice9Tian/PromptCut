/**
 * 文档服务的第二种传输：HTTP 长轮询（契约 `docs/plan/http-transport-contract.md` 第 3～7 节）。
 *
 * 给出口只放行 443 HTTPS、不支持 WebSocket 升级的节点用。与 WebSocket 并存，核心 `router.mjs` 与模块一行不改：
 * 组装层（`service.mjs`）把核心的 `write` / `buffered` / `close` / `drained` 按连接分派给两种传输之一。
 *
 * 四个端点（路径都相对文档服务基址，`prefix` 是基址的路径部分）：
 * - `POST /lp/open`：请求头 `X-Promptcut-Protocols` 就是 WebSocket 的 `Sec-WebSocket-Protocol` 列表，
 *   原样当作 `sec-websocket-protocol` 交给**同一个** `authenticate(req)`（证明、票据、本机声明、限速、回环信任全照旧；
 *   `req.socket` 仍是真实 socket，回环只按对端地址算）。成功回 `sid`（32 字节 CSPRNG，base64url，即这条连接的 bearer 凭证）；
 * - `POST /lp/send`：`Authorization: Bearer <sid>`，体 `{ seq, frames }`，按批次号顺序分发，重发幂等，跳号 409；
 * - `GET /lp/recv?ack=&wait=`：丢掉已确认的出站帧，有帧立即回，没有就挂着（一个会话只一个挂起的 GET，新的替换旧的）；
 * - `POST /lp/close`：关会话。
 *
 * 核心钩子的对应（契约第 4 节）：`write` 追加进出站缓冲并叫醒挂着的 GET；`buffered` 是尚未被 ack 的帧的字节数
 * （含已发出、未确认的）；`close` 标记会话关闭、叫醒挂着的 GET 回 `closed`；每次 GET 的 ack 让缓冲下降后调 `drained`。
 * 所以客户端不来取时，未确认字节涨到高水位就进核心队列，再涨过 `maxPendingBytes` 核心以 1013 关闭（契约第 5 节）。
 *
 * 会话过期（第 6 节）：组装层的心跳每轮调 `sweep()`，既没有挂着的 GET、`idleMs` 内也没来过请求的会话按超时关闭
 * （墓碑 `1006 timeout`）。结束的会话留墓碑 `tombstoneMs`（缺省 2 分钟），之间再来的请求回 410。
 *
 * 连接的登记与注销（`router.connect` / `disconnect`、`conn.*` 日志）由组装层经 `hooks` 做，本文件不碰核心。
 * `sid` 与请求头里的凭证不进日志、不进 URL。只引 Node 内置模块。
 */
import { randomBytes } from 'node:crypto';

export const HTTP_TRANSPORT_DEFAULTS = Object.freeze({
  /** 挂起的 GET 最多等多久（客户端的 `wait` 与它取小） */
  WAIT_MS: 25_000,
  /** `waitMs` 的上限：常见代理与负载均衡的空闲超时是 30～60 s（契约第 11 节） */
  MAX_WAIT_MS: 30_000,
  /** 会话多久没有挂着的 GET、也没来过请求就算过期 */
  IDLE_MS: 60_000,
  /** 结束的会话留墓碑多久（这段时间里再来的请求回 410） */
  TOMBSTONE_MS: 120_000,
  /** 一次 POST /lp/send 的请求体比单帧上限多出的余量 */
  BODY_SLACK_BYTES: 64 * 1024,
  /** 一次 GET 回包里帧的总字节数上限（至少一帧） */
  RECV_MAX_BYTES: 1024 * 1024,
  /** open / close 的请求体上限（本来就只是空或很小的 JSON） */
  SMALL_BODY_BYTES: 4096,
});

export const PROTOCOLS_HEADER = 'x-promptcut-protocols';

const JSON_TYPE = 'application/json; charset=utf-8';
const CORS_METHODS = 'GET, POST, OPTIONS';
const CORS_HEADERS = 'Authorization, Content-Type, X-Promptcut-Protocols';
const CORS_MAX_AGE = '600';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byteLen = (text) => Buffer.byteLength(text, 'utf8');
const positive = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

/** 请求头里的子协议列表（逗号分隔、去空白、去空项；多个同名头拼起来） */
function protocolList(raw) {
  if (raw === undefined) return [];
  const text = Array.isArray(raw) ? raw.join(',') : String(raw);
  return text.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/** `Authorization: Bearer <sid>` 里的 sid；没有或格式不对回 null */
function bearerOf(req) {
  const m = /^Bearer[ \t]+([A-Za-z0-9_-]{16,128})$/.exec(String(req.headers.authorization ?? '').trim());
  return m ? m[1] : null;
}

/** 客户端给的关闭码：只认 1000 与 3000～4999（应用可用的范围），别的记 1000 */
function clientCloseCode(v) {
  return Number.isInteger(v) && (v === 1000 || (v >= 3000 && v <= 4999)) ? v : 1000;
}

/** 关闭原因截到 123 字节以内（与 WebSocket 关闭帧一致） */
function clipReason(v) {
  if (typeof v !== 'string') return '';
  let s = v;
  while (byteLen(s) > 123) s = s.slice(0, -1);
  return s;
}

/**
 * 读请求体，最多 `limit` 字节。超了回 `{ tooLarge: true }`（剩下的字节丢弃，不再累积）。
 * 客户端中途断开回 `{ aborted: true }`。
 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      resolve({ tooLarge: true });
      return;
    }
    const chunks = [];
    let size = 0;
    let over = false;
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        settle({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(over ? { tooLarge: true } : { text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => settle({ aborted: true }));
    req.on('aborted', () => settle({ aborted: true }));
  });
}

/**
 * @param {object} options
 * @param {string} [options.prefix] 基址的路径部分（不带结尾斜杠；根路径是空串）。端点是 `<prefix>/lp/<名>`
 * @param {string} [options.protocol] 列表第一项必须是它，缺省 `promptcut.v1`
 * @param {(req: object) => object | null} options.authenticate 与 WebSocket 握手同一个
 * @param {object} options.hooks 组装层给的接线：
 *   - `canOpen()` → null（可以建）| `'closing'` | `'full'`
 *   - `nextConnId()` → 与 WebSocket 连接同一个编号序列
 *   - `opened(connId, principal, req)`：会话已建好（`write` 已可用），组装层登记进核心、打 `conn.open`
 *   - `ended(connId, code, reason)`：会话已结束（延到下一轮事件循环调，同 WebSocket 的 `close` 事件是异步的），
 *     组装层 `router.disconnect`、打 `conn.close`
 *   - `timedOut(connId)`：过期时先调（组装层打 `conn.timeout`）
 *   - `dispatch(connId, text)`、`drained(connId)`：核心的同名入口
 *   - `log(event, fields)`
 * @param {number} [options.maxFrameBytes] 单帧上限（= WebSocket 的 `maxPayload`）
 * @param {number} [options.waitMs]
 * @param {number} [options.idleMs]
 * @param {number} [options.tombstoneMs]
 * @param {string[]} [options.corsOrigins] 允许跨源的 Origin（契约 3.6），缺省空：不回任何 CORS 头
 * @param {() => number} [options.now]
 */
export function createHttpTransport({
  prefix = '',
  protocol = 'promptcut.v1',
  authenticate,
  hooks,
  maxFrameBytes = 1024 * 1024,
  waitMs,
  idleMs,
  tombstoneMs,
  corsOrigins = [],
  now = Date.now,
} = /** @type {any} */ ({})) {
  if (typeof authenticate !== 'function') throw new TypeError('createHttpTransport: authenticate 必须是函数');
  if (!isObj(hooks)) throw new TypeError('createHttpTransport: 要给 hooks');
  const base = String(prefix).replace(/\/+$/, '');
  const lpRoot = `${base}/lp/`;
  const waitCap = Math.min(positive(waitMs, HTTP_TRANSPORT_DEFAULTS.WAIT_MS), HTTP_TRANSPORT_DEFAULTS.MAX_WAIT_MS);
  const idle = positive(idleMs, HTTP_TRANSPORT_DEFAULTS.IDLE_MS);
  const tombTtl = positive(tombstoneMs, HTTP_TRANSPORT_DEFAULTS.TOMBSTONE_MS);
  const maxFrame = positive(maxFrameBytes, 1024 * 1024);
  const maxSendBody = maxFrame + HTTP_TRANSPORT_DEFAULTS.BODY_SLACK_BYTES;
  const corsSet = new Set(Array.isArray(corsOrigins) ? corsOrigins.filter((o) => typeof o === 'string' && o !== '') : []);
  const log = (event, fields) => { try { hooks.log?.(event, fields); } catch { /* 日志出错不影响传输 */ } };

  /** sid → 会话（开着的，和已关闭、等客户端取走剩余帧的） */
  const bySid = new Map();
  /** connId → 开着的会话（核心里还登记着的） */
  const byConn = new Map();
  /** sid → { code, reason, until }：刚结束的会话 */
  const tombs = new Map();
  const counters = { opened: 0, expired: 0, superseded: 0 };
  let shuttingDown = false;

  // ---------- 回包 ----------

  function corsFor(req) {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !corsSet.has(origin)) return null;
    return { 'access-control-allow-origin': origin, vary: 'Origin' };
  }

  function sendJson(res, status, body, cors) {
    if (res.headersSent || res.writableEnded) return;
    const headers = { 'content-type': JSON_TYPE, 'cache-control': 'no-store', ...(cors ?? {}) };
    if (shuttingDown) headers.connection = 'close';
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  // ---------- 会话 ----------

  function newSession(connId) {
    let sid;
    do sid = randomBytes(32).toString('base64url'); while (bySid.has(sid) || tombs.has(sid));
    return {
      sid,
      connId,
      /** 出站缓冲：`{ seq, data, bytes }`，按序号递增；被 ack 的从头上丢掉 */
      out: [],
      outBytes: 0,
      nextOut: 1,
      /** 已收的入站批次号 */
      inSeq: 0,
      /** 挂着的 GET：`{ res, cors, timer }` */
      waiter: null,
      wakeQueued: false,
      lastSeen: now(),
      open: true,
      closed: null,
      closedAt: 0,
    };
  }

  function toTomb(s) {
    if (!bySid.has(s.sid)) return;
    bySid.delete(s.sid);
    const c = s.closed ?? { code: 1006, reason: '' };
    tombs.set(s.sid, { code: c.code, reason: c.reason, until: now() + tombTtl });
    s.out = [];
    s.outBytes = 0;
  }

  /** 这一次回包带哪些帧：从缓冲头起，总字节不超过上限（至少一帧）；`all` 表示剩下的都带上了 */
  function takeFrames(s) {
    const frames = [];
    let size = 0;
    for (const f of s.out) {
      if (frames.length > 0 && size + f.bytes > HTTP_TRANSPORT_DEFAULTS.RECV_MAX_BYTES) break;
      frames.push({ seq: f.seq, data: f.data });
      size += f.bytes;
    }
    return { frames, all: frames.length === s.out.length };
  }

  /** 立即回一次 recv：带上缓冲里的帧；会话已关闭且剩下的都带上了，就带 `closed` 并转成墓碑 */
  function respondRecv(s, res, cors) {
    s.lastSeen = now();
    const { frames, all } = takeFrames(s);
    const closed = !s.open && all ? s.closed : null;
    sendJson(res, 200, { ok: true, frames, closed }, cors);
    if (closed) toTomb(s);
  }

  function clearWaiter(s) {
    const w = s.waiter;
    if (!w) return null;
    s.waiter = null;
    clearTimeout(w.timer);
    return w;
  }

  /** 有新帧或会话关了：叫醒挂着的 GET。同一轮里连写几条时攒成一次回包 */
  function wake(s, immediate = false) {
    if (!s.waiter) return;
    if (immediate) {
      const w = clearWaiter(s);
      respondRecv(s, w.res, w.cors);
      return;
    }
    if (s.wakeQueued) return;
    s.wakeQueued = true;
    setImmediate(() => {
      s.wakeQueued = false;
      const w = clearWaiter(s);
      if (w) respondRecv(s, w.res, w.cors);
    });
  }

  /**
   * 结束一个开着的会话：记下关闭码，叫醒挂着的 GET（回剩下的帧与 `closed`），下一轮事件循环再让组装层注销
   * （模块的 `ctx.close` 可能正处在它自己的处理函数里，和 WebSocket 一样异步注销更稳）。回注销完成的 Promise。
   */
  function endSession(s, code, reason) {
    if (!s.open) return Promise.resolve();
    s.open = false;
    s.closed = { code, reason };
    s.closedAt = now();
    wake(s, true);
    return new Promise((resolve) => {
      setImmediate(() => {
        if (byConn.get(s.connId) === s) byConn.delete(s.connId);
        try {
          hooks.ended(s.connId, code, reason);
        } catch (err) {
          log('conn.error', { connId: s.connId, message: String(err?.message ?? err) });
        }
        resolve();
      });
    });
  }

  /** 按 `Authorization` 找会话；找不到时已经回了 404 / 410，返回 null */
  function sessionOf(req, res, cors) {
    const sid = bearerOf(req);
    const s = sid ? bySid.get(sid) : undefined;
    if (s) return s;
    const tomb = sid ? tombs.get(sid) : undefined;
    if (tomb) {
      sendJson(res, 410, { ok: false, error: 'session-closed', code: tomb.code, reason: tomb.reason }, cors);
      return null;
    }
    sendJson(res, 404, { ok: false, error: 'no-session' }, cors);
    return null;
  }

  // ---------- 端点 ----------

  async function onOpen(req, res, cors) {
    if (hooks.canOpen() !== null) return sendJson(res, 503, { ok: false, error: 'unavailable' }, cors);
    const offered = protocolList(req.headers[PROTOCOLS_HEADER]);
    if (offered.length === 0 || offered[0] !== protocol) return sendJson(res, 400, { ok: false, error: 'bad-protocols' }, cors);
    const body = await readBody(req, HTTP_TRANSPORT_DEFAULTS.SMALL_BODY_BYTES);
    if (body.aborted) return undefined;
    if (body.tooLarge) return sendJson(res, 413, { ok: false, error: 'too-large' }, cors);
    // 读请求体期间可能开始关停或连接数满了
    if (hooks.canOpen() !== null) return sendJson(res, 503, { ok: false, error: 'unavailable' }, cors);
    // 同一个请求对象，只把子协议列表放进 WebSocket 握手的那个头；socket、url、其余头都不变
    const headers = { ...req.headers, 'sec-websocket-protocol': offered.join(', ') };
    const authReq = Object.create(req, { headers: { value: headers, enumerable: true, writable: true, configurable: true } });
    let principal;
    try {
      principal = authenticate(authReq);
    } catch {
      principal = null;
    }
    if (!principal || typeof principal.userId !== 'string') return sendJson(res, 401, { ok: false, error: 'unauthorized' }, cors);
    const s = newSession(hooks.nextConnId());
    bySid.set(s.sid, s);
    byConn.set(s.connId, s);
    counters.opened += 1;
    try {
      hooks.opened(s.connId, principal, authReq);
    } catch (err) {
      bySid.delete(s.sid);
      byConn.delete(s.connId);
      log('http.error', { stage: 'open', message: String(err?.message ?? err) });
      return sendJson(res, 500, { ok: false, error: 'internal' }, cors);
    }
    return sendJson(res, 200, {
      ok: true, sid: s.sid, protocol, transport: 'http', waitMs: waitCap, idleMs: idle, maxFrameBytes: maxFrame,
    }, cors);
  }

  async function onSend(req, res, cors) {
    const s = sessionOf(req, res, cors);
    if (!s) return undefined;
    s.lastSeen = now();
    const body = await readBody(req, maxSendBody);
    if (body.aborted) return undefined;
    s.lastSeen = now();
    if (body.tooLarge) {
      sendJson(res, 413, { ok: false, error: 'too-large' }, cors);
      if (s.open) endSession(s, 1009, 'too-large');
      return undefined;
    }
    if (!s.open) return sendJson(res, 410, { ok: false, error: 'session-closed', code: s.closed.code, reason: s.closed.reason }, cors);
    let msg;
    try {
      msg = JSON.parse(body.text);
    } catch {
      msg = null;
    }
    if (!isObj(msg) || !Number.isSafeInteger(msg.seq) || msg.seq < 1 || !Array.isArray(msg.frames) || msg.frames.some((f) => typeof f !== 'string')) {
      return sendJson(res, 400, { ok: false, error: 'bad-request' }, cors);
    }
    // 重发：已经收过的批次不再分发，照样回成功
    if (msg.seq <= s.inSeq) return sendJson(res, 200, { ok: true, ack: s.inSeq }, cors);
    if (msg.seq !== s.inSeq + 1) return sendJson(res, 409, { ok: false, error: 'out-of-order', expect: s.inSeq + 1 }, cors);
    if (msg.frames.some((f) => byteLen(f) > maxFrame)) {
      sendJson(res, 413, { ok: false, error: 'too-large' }, cors);
      endSession(s, 1009, 'too-large');
      return undefined;
    }
    s.inSeq = msg.seq;
    for (const text of msg.frames) {
      if (!s.open) break;
      hooks.dispatch(s.connId, text);
    }
    return sendJson(res, 200, { ok: true, ack: s.inSeq }, cors);
  }

  function onRecv(req, res, cors, url) {
    const s = sessionOf(req, res, cors);
    if (!s) return;
    s.lastSeen = now();
    const ack = Number(url.searchParams.get('ack') ?? 0);
    const lastOut = s.nextOut - 1;
    if (!Number.isSafeInteger(ack) || ack < 0 || ack > lastOut) {
      sendJson(res, 400, { ok: false, error: 'bad-ack', last: lastOut }, cors);
      return;
    }
    const rawWait = Number(url.searchParams.get('wait') ?? waitCap);
    const wait = Number.isFinite(rawWait) && rawWait >= 0 ? Math.min(rawWait, waitCap) : waitCap;

    // 新的 GET 替换旧的（客户端超时重连后旧请求可能还挂在这里）
    const old = clearWaiter(s);
    if (old) {
      counters.superseded += 1;
      sendJson(old.res, 200, { ok: true, frames: [], closed: null, superseded: true }, old.cors);
    }

    // 丢掉已确认的帧；缓冲下降了就让核心接着写积压的消息
    let dropped = false;
    while (s.out.length > 0 && s.out[0].seq <= ack) {
      s.outBytes -= s.out.shift().bytes;
      dropped = true;
    }
    if (dropped && s.open) {
      try {
        hooks.drained(s.connId);
      } catch (err) {
        log('conn.error', { connId: s.connId, message: String(err?.message ?? err) });
      }
    }

    if (s.out.length > 0 || !s.open || wait === 0) {
      respondRecv(s, res, cors);
      return;
    }
    const w = { res, cors, timer: null };
    w.timer = setTimeout(() => {
      if (s.waiter !== w) return;
      s.waiter = null;
      respondRecv(s, res, cors);
    }, wait);
    w.timer.unref?.();
    s.waiter = w;
    res.on('close', () => {
      if (s.waiter !== w) return;
      clearWaiter(s);
      s.lastSeen = now();
    });
  }

  async function onClose(req, res, cors) {
    const s = sessionOf(req, res, cors);
    if (!s) return undefined;
    const body = await readBody(req, HTTP_TRANSPORT_DEFAULTS.SMALL_BODY_BYTES);
    let msg = null;
    if (body.text) {
      try { msg = JSON.parse(body.text); } catch { msg = null; }
    }
    const code = clientCloseCode(isObj(msg) ? msg.code : undefined);
    const reason = clipReason(isObj(msg) ? msg.reason : '');
    const ended = s.open ? endSession(s, code, reason) : Promise.resolve();
    // 客户端自己关的：剩下的帧它不要了，立刻转墓碑
    toTomb(s);
    sendJson(res, 200, { ok: true }, cors);
    return ended;
  }

  /**
   * 处理一个 HTTP 请求。是 `<prefix>/lp/…` 的就接手并回 true，别的回 false、什么都不动。
   */
  function handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return false;
    }
    if (!url.pathname.startsWith(lpRoot)) return false;
    const cors = corsFor(req);
    const name = url.pathname.slice(lpRoot.length);
    if (req.method === 'OPTIONS') {
      // 预检不做任何会话操作；名单为空（或 Origin 不在名单里）时不回任何 CORS 头
      const headers = { 'cache-control': 'no-store', ...(cors ?? {}) };
      if (cors) {
        headers['access-control-allow-methods'] = CORS_METHODS;
        headers['access-control-allow-headers'] = CORS_HEADERS;
        headers['access-control-max-age'] = CORS_MAX_AGE;
      }
      res.writeHead(204, headers);
      res.end();
      return true;
    }
    const routes = { open: 'POST', send: 'POST', recv: 'GET', close: 'POST' };
    if (!Object.hasOwn(routes, name)) {
      sendJson(res, 404, { ok: false, error: 'not-found' }, cors);
      return true;
    }
    if (req.method !== routes[name]) {
      sendJson(res, 405, { ok: false, error: 'method' }, cors);
      return true;
    }
    if (shuttingDown && name === 'open') {
      sendJson(res, 503, { ok: false, error: 'unavailable' }, cors);
      return true;
    }
    const fail = (err) => {
      log('http.error', { stage: name, message: String(err?.message ?? err) });
      sendJson(res, 500, { ok: false, error: 'internal' }, cors);
    };
    try {
      let r;
      if (name === 'open') r = onOpen(req, res, cors);
      else if (name === 'send') r = onSend(req, res, cors);
      else if (name === 'recv') r = onRecv(req, res, cors, url);
      else r = onClose(req, res, cors);
      if (r && typeof r.then === 'function') r.then(undefined, fail);
    } catch (err) {
      fail(err);
    }
    return true;
  }

  return {
    handle,

    /** 核心的 `write`：追加进出站缓冲，叫醒挂着的 GET。会话不在或已关闭回 false（丢弃） */
    write(connId, text) {
      const s = byConn.get(connId);
      if (!s || !s.open) return false;
      const bytes = byteLen(text);
      s.out.push({ seq: s.nextOut, data: text, bytes });
      s.nextOut += 1;
      s.outBytes += bytes;
      wake(s);
      return true;
    },

    /** 核心的 `buffered`：尚未被 ack 的帧的字节数 */
    buffered(connId) {
      return byConn.get(connId)?.outBytes ?? 0;
    },

    /** 核心的 `close`（背压 1013、踢人 4003……）与组装层的 `closeConn` */
    close(connId, code, reason) {
      const s = byConn.get(connId);
      if (!s || !s.open) return false;
      endSession(s, code, reason);
      return true;
    },

    /** 这个连接是不是本传输的（核心里还登记着） */
    has(connId) {
      return byConn.has(connId);
    },

    /** 开着的会话数（计入 `maxConnections`） */
    size() {
      return byConn.size;
    },

    connIds() {
      return [...byConn.keys()];
    },

    /**
     * 心跳时调：过期的会话按超时关闭（墓碑 1006 timeout）；已关闭而客户端一直不来取的，过 `idleMs` 转墓碑；
     * 过期的墓碑删掉。
     */
    sweep() {
      const t = now();
      for (const s of [...bySid.values()]) {
        if (s.open) {
          if (s.waiter || t - s.lastSeen < idle) continue;
          counters.expired += 1;
          try { hooks.timedOut?.(s.connId); } catch { /* 日志出错不影响 */ }
          endSession(s, 1006, 'timeout');
          toTomb(s);
        } else if (!s.waiter && t - s.closedAt >= idle) {
          toTomb(s);
        }
      }
      for (const [sid, tomb] of tombs) {
        if (tomb.until <= t) tombs.delete(sid);
      }
    },

    /** 关停：所有开着的会话以 `code` 关闭，挂着的 GET 立刻回 `closed`；回全部注销完成的 Promise */
    closeAll(code, reason) {
      shuttingDown = true;
      const done = [];
      for (const s of [...bySid.values()]) {
        if (s.open) done.push(endSession(s, code, reason));
        const w = clearWaiter(s);
        if (w) respondRecv(s, w.res, w.cors);
      }
      return Promise.all(done).then(() => {});
    },

    /** `/healthz` 的 `transports` 里本传输的几项 */
    stats() {
      return { http: byConn.size, httpOpened: counters.opened, httpExpired: counters.expired, httpSuperseded: counters.superseded };
    },
  };
}
