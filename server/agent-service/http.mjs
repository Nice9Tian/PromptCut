/**
 * 托管档 Agent 服务的 HTTP 接口(契约 `docs/plan/cloud-agent-contract.md` 第 2.3、2.4 节)。
 *
 * `/healthz`、`info`、发消息(202,一轮与连接无关)、事件流(先补发再接实时)、停止、对话的列取改删、用量查询。
 * 丙块在甲块的基础上只追加了接口与字段(对话的取、改标题、删,`/v1/usage`,`info` 与列表项多出的字段),已有的没有改。
 *
 * 身份只来自 `authenticate(req)`:回 `{ projectId, userId, username?, deviceName?, creator?, mode?, access? }` 或 null。
 * URL 与请求体里没有项目与成员的字段,页面自报不了。乙块接上之前 `authenticate` 由测试替身给;没给时一律 401。
 * 本文件不引用 `src/`。
 */
import { AgentServiceError, CONVERSATION_ID_RE, ownerKeyOf } from '../agent/service/create-agent-service.mjs';

const MAX_BODY = 256 * 1024;
const PING_MS = 15_000;
const MAX_STREAMS = 200;
const MAX_STREAMS_PER_OWNER = 8;

function sendJson(res, status, body, extra = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new AgentServiceError('too-large', '请求体超过 256 KiB', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const data = text ? JSON.parse(text) : {};
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('不是对象');
        resolve(data);
      } catch {
        reject(new AgentServiceError('bad-request', '请求体不是 JSON 对象'));
      }
    });
    req.on('error', () => reject(new AgentServiceError('bad-request', '请求读不完')));
  });
}

/**
 * @param {object} o
 * @param {ReturnType<import('../agent/service/create-agent-service.mjs').createHostedAgentService>} o.service
 * @param {(req: import('node:http').IncomingMessage) => Promise<object | null> | object | null} [o.authenticate]
 * @param {string} [o.version]
 * @param {() => object} [o.info] `GET /v1/info` 里项目开关、模型清单这些(后面的块接上之前给缺省)
 */
export function createAgentHttp({ service, authenticate = null, version = 'dev', info = () => ({}), log = () => {} }) {
  // 跨源:在线页面同源,桌面版的页面从本机源来(契约第 10.4 节)。鉴权只看票据,不收不发 Cookie
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
  };

  async function identityOf(req) {
    if (typeof authenticate !== 'function') return null;
    try {
      const id = await authenticate(req);
      return id && typeof id.projectId === 'string' && typeof id.userId === 'string' ? id : null;
    } catch {
      return null;
    }
  }

  /** 同时开着的事件流:全节点与每个主人各有上限(契约第 11 节),超了回 busy */
  let streams = 0;
  const streamsByOwner = new Map();

  function events(req, res, identity, conversationId, after) {
    const owner = ownerKeyOf(identity);
    if (streams >= MAX_STREAMS || (streamsByOwner.get(owner) ?? 0) >= MAX_STREAMS_PER_OWNER) {
      return sendJson(res, 429, { ok: false, code: 'busy', message: '同时打开的对话窗口太多,请关掉几个再试。' }, CORS);
    }
    let unsubscribe = null;
    let ping = null;
    const write = (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* 对端走了 */ } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...CORS });
    res.flushHeaders?.();
    unsubscribe = service.subscribe(identity, conversationId, after, write);
    if (!unsubscribe) {
      // 还没有这个对话(或不是这位成员在这个项目里的):一条说明后结束,形状与「没有事件」相同
      write({ type: 'end', state: 'none', seq: 0 });
      res.end();
      return undefined;
    }
    streams += 1;
    streamsByOwner.set(owner, (streamsByOwner.get(owner) ?? 0) + 1);
    ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 对端走了 */ } }, PING_MS);
    ping.unref?.();
    // 流断开只是没人看了:这一轮不停(契约第 2.4 节)
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearInterval(ping);
      unsubscribe?.();
      streams -= 1;
      const left = (streamsByOwner.get(owner) ?? 1) - 1;
      if (left > 0) streamsByOwner.set(owner, left); else streamsByOwner.delete(owner);
    };
    req.on('close', release);
    res.on('close', release);
    return undefined;
  }

  /** 处理一个请求。路径不认得回 404 */
  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://agent.invalid');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
      if (pathname === '/healthz') {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'bad-request', message: 'GET only' }, CORS);
        return sendJson(res, 200, { ok: true, version }, CORS);
      }
      if (!pathname.startsWith('/v1/')) return sendJson(res, 404, { ok: false, code: 'not-found', message: 'not found' }, CORS);

      const identity = await identityOf(req);
      if (!identity) return sendJson(res, 401, { ok: false, code: 'unauthorized', message: 'unauthorized' }, CORS);

      if (pathname === '/v1/info' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, ...(await service.info(identity)), ...info(identity) }, CORS);
      }
      if (pathname === '/v1/conversations' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, items: service.conversations(identity) }, CORS);
      }
      if (pathname === '/v1/usage' && req.method === 'GET') {
        const since = Number(url.searchParams.get('since'));
        return sendJson(res, 200, { ok: true, ...service.usage(identity, Number.isFinite(since) && since > 0 ? since : null) }, CORS);
      }
      const one = /^\/v1\/conversations\/([^/]+)$/.exec(pathname);
      if (one) {
        const conversationId = decodeURIComponent(one[1]);
        if (!CONVERSATION_ID_RE.test(conversationId)) throw new AgentServiceError('bad-request', '对话 id 不合法');
        // 不存在的、别人的,一律 404,不区分
        const missing = () => sendJson(res, 404, { ok: false, code: 'not-found', message: 'not found' }, CORS);
        if (req.method === 'GET') {
          const meta = service.conversation(identity, conversationId);
          return meta ? sendJson(res, 200, { ok: true, meta }, CORS) : missing();
        }
        if (req.method === 'PATCH') {
          const body = await readBody(req);
          if (typeof body.title !== 'string') throw new AgentServiceError('bad-request', '要给 title');
          return service.rename(identity, conversationId, body.title) ? sendJson(res, 200, { ok: true }, CORS) : missing();
        }
        if (req.method === 'DELETE') {
          return service.remove(identity, conversationId) ? sendJson(res, 200, { ok: true }, CORS) : missing();
        }
      }
      const m = /^\/v1\/conversations\/([^/]+)\/(messages|events|abort)$/.exec(pathname);
      if (m) {
        const conversationId = decodeURIComponent(m[1]);
        if (!CONVERSATION_ID_RE.test(conversationId)) throw new AgentServiceError('bad-request', '对话 id 不合法');
        if (m[2] === 'messages' && req.method === 'POST') {
          const body = await readBody(req);
          // 这些桌面字段云端不收(契约第 2.3 节);`__` 开头的是进程内测试用的,不从网络收。
          // `grant` 是这一轮的对话委托(契约第 4.2 节):只进内存,不落盘、不进日志
          const { prompt, grant, model, effort, creativity, script, library, pageState } = body;
          const out = await service.send(identity, conversationId, { prompt, grant, model, effort, creativity, script, library, pageState });
          return sendJson(res, 202, { ok: true, ...out }, CORS);
        }
        if (m[2] === 'events' && req.method === 'GET') {
          const after = Number(url.searchParams.get('after') ?? 0);
          return events(req, res, identity, conversationId, Number.isSafeInteger(after) ? after : 0);
        }
        if (m[2] === 'abort' && req.method === 'POST') {
          return sendJson(res, 200, service.abort(identity, conversationId), CORS);
        }
      }
      return sendJson(res, 404, { ok: false, code: 'not-found', message: 'not found' }, CORS);
    } catch (err) {
      if (err instanceof AgentServiceError) return sendJson(res, err.status, { ok: false, code: err.code, message: err.message }, CORS);
      log('agent.http.error', { path: pathname, message: String(err?.message ?? err).slice(0, 200) });
      return sendJson(res, 500, { ok: false, code: 'unavailable', message: '服务内部错误' }, CORS);
    }
  }

  return { handle };
}
