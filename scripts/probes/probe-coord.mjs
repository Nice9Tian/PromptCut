/**
 * 跨机探针共用的协调口（`shared-project-probe.mjs` 互联网 / 局域网模式、`render-host-probe.mjs` 跨机模式）。
 * 各角色只经它交换配置与完成信号，不共享文件系统。只用 Node 内置模块。
 *
 * 形状（一个协调口同时答这几条，几个探针可以共用同一个口）：
 *   GET  /healthz                    `{ ok: true, keys: [...] }`
 *   PUT  /kv/<键>                     JSON 请求体，存起来并叫醒在等这个键的
 *   GET  /kv/<键>?wait=<毫秒>         `{ ok: true, value }`；没有就等（至多 60 s），等不到 404
 *   其余路径交给 `extra(req, res, url)`（`render-host-probe` 的 `/configs/*`、`/ready/*`、`/round/*`、`/result/*`、`/state`、`/stop`）；
 *   没有 `extra` 或它不认就 404。
 * 键：`[A-Za-z0-9._-]{1,64}`。协调口不设鉴权，配置里有探针自建项目的口令：只绑在可信网段上，跑完就关。
 */
import http from 'node:http';

const KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_BODY = 4 << 20;

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** 读 JSON 请求体（空体回 `{}`）；超过 4 MiB 或不是 JSON 抛错 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too-large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/**
 * 起协调口。
 * @param {object} o
 * @param {number} o.port 0 取随机端口
 * @param {string} [o.host] 缺省 127.0.0.1；跨机时给 0.0.0.0
 * @param {(req, res, url: URL, send: typeof sendJson) => Promise<boolean> | boolean} [o.extra] 别的路径；认了回 true
 * @returns {Promise<{ server: http.Server, port: number, url: string, kv: Map<string, unknown>, close: () => Promise<void> }>} 绑不上时 reject
 */
export function startCoordServer({ port, host = '127.0.0.1', extra } = {}) {
  const kv = new Map();
  const waiters = new Map();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://coord.local');
      if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true, keys: [...kv.keys()] });
      const m = /^\/kv\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const key = decodeURIComponent(m[1]);
        if (!KEY_RE.test(key)) return sendJson(res, 400, { ok: false, error: 'bad-key' });
        if (req.method === 'PUT') {
          let value;
          try { value = await readJsonBody(req); } catch { return sendJson(res, 400, { ok: false, error: 'bad-json' }); }
          kv.set(key, value);
          for (const w of waiters.get(key) ?? []) w();
          waiters.delete(key);
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'GET') {
          const wait = Math.min(Number(url.searchParams.get('wait') ?? 0) || 0, 60_000);
          if (!kv.has(key) && wait > 0) {
            await new Promise((resolve) => {
              const t = setTimeout(resolve, wait);
              const list = waiters.get(key) ?? [];
              list.push(() => { clearTimeout(t); resolve(); });
              waiters.set(key, list);
            });
          }
          return kv.has(key) ? sendJson(res, 200, { ok: true, value: kv.get(key) }) : sendJson(res, 404, { ok: false, error: 'missing' });
        }
        return sendJson(res, 405, { ok: false });
      }
      if (extra && (await extra(req, res, url, sendJson))) return undefined;
      return sendJson(res, 404, { ok: false, error: 'no-route' });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      return undefined;
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        server, port: actual, kv,
        url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actual}`,
        close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
      });
    });
  });
}

/**
 * 协调口的客户端（KV 那几条）。
 * @param {string} base 形如 `http://192.168.50.96:5409`
 */
export function coordClient(base) {
  const root = String(base).replace(/\/+$/, '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const client = {
    base: root,
    async put(key, value) {
      const res = await fetch(`${root}/kv/${encodeURIComponent(key)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`协调口 PUT ${key} 回 ${res.status}`);
    },
    /** 取一次（最多等 waitMs）；没有回 null */
    async get(key, waitMs = 0) {
      const res = await fetch(`${root}/kv/${encodeURIComponent(key)}?wait=${Math.max(0, waitMs)}`, { signal: AbortSignal.timeout(waitMs + 10_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`协调口 GET ${key} 回 ${res.status}`);
      return (await res.json()).value ?? null;
    },
    /** 等到这个键出现，或者到 deadline（毫秒时间戳）；协调口暂时连不上就隔 500 ms 再试 */
    async take(key, deadline) {
      while (Date.now() < deadline) {
        const wait = Math.max(1, Math.min(30_000, deadline - Date.now()));
        try {
          const v = await client.get(key, wait);
          if (v !== null) return v;
        } catch { await sleep(500); }
      }
      return null;
    },
  };
  return client;
}
