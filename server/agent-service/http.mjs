/**
 * 托管档 Agent 服务的 HTTP 接口(契约 `docs/plan/cloud-agent-contract.md` 第 2.3、2.4 节)。
 *
 * 这一块(甲)做了:`/healthz`、发消息(202,一轮与连接无关)、事件流(先补发再接实时)、停止、对话列表、`info`。
 * 对话的改名与删除、用量查询属于后面的块。
 *
 * 身份只来自 `authenticate(req)`:回 `{ projectId, userId, username?, deviceName?, creator?, mode?, access? }` 或 null。
 * URL 与请求体里没有项目与成员的字段,页面自报不了。乙块接上之前 `authenticate` 由测试替身给;没给时一律 401。
 * 本文件不引用 `src/`。
 */
import { AgentServiceError, CONVERSATION_ID_RE } from '../agent/service/create-agent-service.mjs';

const MAX_BODY = 256 * 1024;
const PING_MS = 15_000;

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
export function createAgentHttp({ service, authenticate = null, version = 'dev', info = () => ({ enabled: true, models: [], defaultModel: null }), log = () => {} }) {
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

  function events(req, res, identity, conversationId, after) {
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
      return;
    }
    ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 对端走了 */ } }, PING_MS);
    ping.unref?.();
    // 流断开只是没人看了:这一轮不停(契约第 2.4 节)
    req.on('close', () => { clearInterval(ping); unsubscribe?.(); });
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
        const running = service.conversations(identity).filter((c) => c.state === 'running').map((c) => c.id);
        return sendJson(res, 200, { ok: true, ...info(identity), limits: { rounds: 24, runMs: service.limits.runMs }, running }, CORS);
      }
      if (pathname === '/v1/conversations' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, items: service.conversations(identity) }, CORS);
      }
      const m = /^\/v1\/conversations\/([^/]+)\/(messages|events|abort)$/.exec(pathname);
      if (m) {
        const conversationId = decodeURIComponent(m[1]);
        if (!CONVERSATION_ID_RE.test(conversationId)) throw new AgentServiceError('bad-request', '对话 id 不合法');
        if (m[2] === 'messages' && req.method === 'POST') {
          const body = await readBody(req);
          // 这些桌面字段云端不收(契约第 2.3 节);`__` 开头的是进程内测试用的,不从网络收
          const { prompt, model, effort, creativity, script, library, pageState } = body;
          const out = await service.send(identity, conversationId, { prompt, model, effort, creativity, script, library, pageState });
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
