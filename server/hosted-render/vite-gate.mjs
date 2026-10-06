/**
 * 托管方渲染服务工作进程里两台 Vite 的「页面一侧的闸」（契约 `docs/plan/hosted-render-contract.md` 第 7.5 节）。
 * 只在托管方的工作进程里装（环境里有 `PROMPTCUT_RENDER_BROKER`）；桌面版与普通的独立渲染主机不装，行为不变。
 *
 * 要挡的是渲染用的 Chrome 页面里跑的卡片代码（隔离工作进程里是项目带来的代码）。三层，各自独立：
 *
 *   1. **页面请求闸**（`page-gate.mjs` 的判定，接在这台 Vite 的最前面）：浏览器发来的请求——编辑器的 Vite 一律 403；
 *      预渲染的 Vite 只认同源，`/api/**` 只放行导出页确实要用的几条。WebSocket 升级同样判（浏览器发的升级一律拒：
 *      工作进程没有页面要连它的热更新或本机文档服务）。Node 一侧的调用（不带 `Sec-Fetch-Site` / `Origin`）照旧。
 *   2. **出口代理**（只在预渲染的 Vite 里起）：渲染用的 Chrome 经它出网（`--proxy-server` 加 `--proxy-bypass-list=<-loopback>`，
 *      回环地址也不绕过），代理只转发到**这台预渲染 Vite 自己**，别的目的地一律 403、CONNECT 一律拒。于是页面里的代码连不上：
 *      管理进程的状态口与代理口、别的工作进程的 Vite、自己这棵树里编辑器的 Vite 与舞台端口、文档服务与素材服务的本机端口、
 *      云厂商的元数据地址、任何外部地址。Chrome 另带 `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`（WebRTC 不许绕过代理发 UDP）。
 *   3. **出口白名单头**：预渲染 Vite 的每个响应带 `Connection-Allowlist: (response-origin)`（与在线舞台同一条，`src/online/stagePolicy.mjs`）：
 *      文档只能连它自己的源，WebRTC 整个拦下。它是浏览器按文档执行的，第 2 层是浏览器进程级的，互为兜底。
 *
 * `PROMPTCUT_PAGE_GATE=log`：只记不拦（定放行表、排查时用）——闸照判、代理照转，把本该拦下的打出来。缺省 `enforce`。
 * 被拦的请求打一行 `[page-gate] deny {…}`（前 50 条逐条，之后每 100 条一行），`render-host.mjs` 原样转出。
 */
import http from 'node:http';
import net from 'node:net';
import { pageGate, PAGE_GATE_ENV } from './page-gate.mjs';

export const PAGE_GATE_MODE_ENV = 'PROMPTCUT_PAGE_GATE';
export const EGRESS_HEADER = Object.freeze(['Connection-Allowlist', '(response-origin)']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export const hostedGateWanted = (env = process.env) => !!String(env?.[PAGE_GATE_ENV] ?? '').trim();
export const hostedGateMode = (env = process.env) => (String(env?.[PAGE_GATE_MODE_ENV] ?? '').trim() === 'log' ? 'log' : 'enforce');

/** 拦截记录：前 `head` 条逐条打，之后每 `every` 条打一条；`counts()` 给诊断 */
export function createDenyLog({ write = (line) => console.log(line), head = 50, every = 100, tag = '[page-gate]' } = {}) {
  let total = 0;
  const byReason = {};
  return {
    note(kind, fields) {
      total += 1;
      byReason[fields.reason ?? kind] = (byReason[fields.reason ?? kind] ?? 0) + 1;
      if (total <= head || total % every === 0) {
        try { write(`${tag} ${kind} ${JSON.stringify({ n: total, ...fields })}`); } catch { /* 日志出错不影响闸 */ }
      }
    },
    counts: () => ({ total, byReason: { ...byReason } }),
  };
}

/**
 * 出口代理：一个最小的 HTTP 正向代理，只转发到 `allowed()` 回的那个端口上的回环地址。
 * @param {object} o
 * @param {() => number | null} o.allowedPort 这台预渲染 Vite 此刻监听的端口（还没监听回 null）
 * @param {'enforce' | 'log'} [o.mode]
 * @param {(kind: string, fields: object) => void} [o.note]
 * @returns {Promise<{ port: number, close(): Promise<void>, stats(): object }>}
 */
export function startEgressProxy({ allowedPort, mode = 'enforce', note = () => {}, host = '127.0.0.1' }) {
  const stats = { forwarded: 0, denied: 0, connects: 0 };
  const targetOf = (hostname, port) => {
    const own = allowedPort();
    return own !== null && LOOPBACK_HOSTS.has(String(hostname).toLowerCase()) && Number(port) === own;
  };
  const server = http.createServer((req, res) => {
    let u = null;
    try { u = new URL(req.url ?? ''); } catch { u = null; }
    const ok = !!u && u.protocol === 'http:' && targetOf(u.hostname, u.port || 80);
    if (!ok) {
      stats.denied += 1;
      note(mode === 'log' ? 'would-deny' : 'deny', { layer: 'egress', method: req.method, to: u ? `${u.protocol}//${u.host}` : String(req.url).slice(0, 80), reason: 'egress' });
      if (mode !== 'log' || !u || u.protocol !== 'http:') {
        req.resume();
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
        return res.end('egress blocked');
      }
    } else stats.forwarded += 1;
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const up = http.request({ host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || 80), method: req.method, path: `${u.pathname}${u.search}`, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.statusMessage, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502, { connection: 'close' }); res.end(); });
    res.on('close', () => { if (!res.writableEnded) up.destroy(); });
    req.pipe(up);
  });
  // CONNECT（https、wss，以及经代理的 ws）：渲染页用不着任何隧道
  server.on('connect', (req, socket) => {
    stats.connects += 1;
    const [h, p] = String(req.url ?? '').split(/:(?=\d+$)/);
    stats.denied += 1;
    note(mode === 'log' ? 'would-deny' : 'deny', { layer: 'egress', method: 'CONNECT', to: String(req.url).slice(0, 80), reason: targetOf(h, p) ? 'tunnel' : 'egress' });
    if (mode !== 'log') { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const up = net.connect(Number(p), String(h).replace(/^\[|\]$/g, ''), () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(socket); socket.pipe(up); });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* 已关 */ } });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve({
        port: server.address().port,
        stats: () => ({ ...stats }),
        close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections?.(); }),
      });
    });
  });
}

/** 渲染用的 Chrome 要带的参数（追加到 `PC_CHROME_ARGS`，`server/bakery/chrome.mjs` 每次启动现读） */
export function egressChromeArgs(proxyPort) {
  return [`--proxy-server=http://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
}

/**
 * 装到一台 Vite 开发服务器上（`configureServer` 里调，要排在所有别的中间件之前）。
 * @param {{ middlewares: { use(fn: Function): void }, httpServer?: import('node:http').Server | null }} server
 * @param {{ prerender: boolean, env?: NodeJS.ProcessEnv, write?: (line: string) => void }} o
 */
export async function installHostedGate(server, { prerender, env = process.env, write } = {}) {
  if (!hostedGateWanted(env)) return null;
  const mode = hostedGateMode(env);
  const denyLog = createDenyLog(write ? { write } : {});
  const role = prerender ? 'prerender' : 'editor';

  server.middlewares.use((req, res, next) => {
    const verdict = pageGate({ url: req.url, method: req.method, headers: req.headers, prerender });
    if (prerender && verdict.browser) res.setHeader(EGRESS_HEADER[0], EGRESS_HEADER[1]);
    if (verdict.allow) return next();
    denyLog.note(mode === 'log' ? 'would-deny' : 'deny', { layer: 'page', role, method: req.method, path: String(req.url ?? '').split('?')[0].slice(0, 160), reason: verdict.reason, site: req.headers['sec-fetch-site'] ?? null });
    if (mode === 'log') return next();
    req.resume?.();
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ ok: false, error: 'page-gate', reason: verdict.reason }));
  });

  // 浏览器发来的 WebSocket 升级：一律拒（Chrome 的 WebSocket 握手必带 Origin，页面脚本去不掉）
  server.httpServer?.prependListener('upgrade', (req, socket) => {
    const browser = !!req.headers.origin || !!req.headers['sec-fetch-site'];
    if (!browser) return;
    denyLog.note(mode === 'log' ? 'would-deny' : 'deny', { layer: 'page', role, method: 'UPGRADE', path: String(req.url ?? '').split('?')[0].slice(0, 160), reason: 'websocket' });
    if (mode !== 'log') { try { socket.destroy(); } catch { /* 已关 */ } }
  });

  let proxy = null;
  if (prerender) {
    proxy = await startEgressProxy({
      mode,
      note: (kind, fields) => denyLog.note(kind, fields),
      allowedPort: () => { const a = server.httpServer?.address?.(); return a && typeof a === 'object' ? a.port : null; },
    });
    const extra = egressChromeArgs(proxy.port).join(' ');
    env.PC_CHROME_ARGS = env.PC_CHROME_ARGS ? `${env.PC_CHROME_ARGS} ${extra}` : extra;
    server.httpServer?.once('close', () => { void proxy.close(); });
  }
  try { (write ?? ((line) => console.log(line)))(`[page-gate] on ${JSON.stringify({ role, mode, egressProxy: proxy ? proxy.port : null })}`); } catch { /* 日志出错不影响闸 */ }
  return { mode, role, counts: () => denyLog.counts(), proxy };
}
