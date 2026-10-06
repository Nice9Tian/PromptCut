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
 * **预渲染 → 编辑器的转发**：渲染页的素材请求（`/@media/*`、`/api/asset/*`、`/api/media/*`）由预渲染的 Vite 原样转给同一个工作进程里
 * 编辑器的 Vite（`asset-client.ts` 的 `assetProxyPlugin`），浏览器的请求头跟着过去，编辑器那一侧的闸会把它当成浏览器直接发来的而拒掉。
 * 所以预渲染一侧给**放行了的**浏览器请求盖一个通行记号（请求头 `x-pc-page-gate`，值是这个工作进程启动时随机生成的串，
 * 经环境变量 `PROMPTCUT_HOSTED_GATE_PASS` 从编辑器进程传给它起的预渲染进程；页面拿不到它，自己带来的同名头先被摘掉）；
 * 编辑器一侧见到对的记号，只放行素材那三类路径的 GET / HEAD，别的照拒。
 *
 * `PROMPTCUT_PAGE_GATE=log`：只记不拦（定放行表、排查时用）——闸照判、代理照转，把本该拦下的打出来。缺省 `enforce`。
 * 被拦的请求打一行 `[page-gate] deny {…}`（前 50 条逐条，之后每 100 条一行），`render-host.mjs` 原样转出。
 */
import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pageGate, PAGE_GATE_ENV } from './page-gate.mjs';

export const PAGE_GATE_MODE_ENV = 'PROMPTCUT_PAGE_GATE';
/** 预渲染 → 编辑器转发时的通行记号：环境变量名与请求头名 */
export const GATE_PASS_ENV = 'PROMPTCUT_HOSTED_GATE_PASS';
export const GATE_PASS_HEADER = 'x-pc-page-gate';
const digest = (text) => createHash('sha256').update(String(text), 'utf8').digest();
const samePass = (given, pass) => typeof given === 'string' && given !== '' && typeof pass === 'string' && pass !== '' && timingSafeEqual(digest(given), digest(pass));
/** 编辑器一侧凭通行记号放行的：素材那三类路径的只读方法（与 `assetProxyPlugin` 转发的范围相同） */
export function relayAllowed(url, method) {
  const m = String(method || 'GET').toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return false;
  const u = String(url || '').toLowerCase().replace(/\/{2,}/g, '/');
  return u.startsWith('/@media/') || u.startsWith('/api/asset/') || u.startsWith('/api/media/');
}
export const EGRESS_HEADER = Object.freeze(['Connection-Allowlist', '(response-origin)']);
/**
 * 仅供验收（隔离探针的对照段）：设成 1 时不发出口白名单头，只留出口代理这一层——用来单独证明代理这一层自己拦得住
 * （两层都在时浏览器先拦，请求到不了代理）。生产不设；设了也只是少一层，出口仍由代理管。
 */
export const TEST_NO_EGRESS_HEADER_ENV = 'PROMPTCUT_TEST_NO_EGRESS_HEADER';
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

/** 这个进程里装上的闸(一个进程一台 Vite);没装回 null。诊断用 */
let installed = null;
export function hostedGateStatus() {
  if (!installed) return null;
  return { mode: installed.mode, role: installed.role, denied: installed.counts(), egress: installed.proxy ? installed.proxy.stats() : null };
}

/**
 * 装到一台 Vite 开发服务器上（`configureServer` 里调，要排在所有别的中间件之前）。
 * @param {{ middlewares: { use(fn: Function): void }, httpServer?: import('node:http').Server | null }} server
 * @param {{ prerender: boolean, env?: NodeJS.ProcessEnv, write?: (line: string) => void }} o
 */
export async function installHostedGate(server, { prerender, env = process.env, write } = {}) {
  if (!hostedGateWanted(env)) return null;
  const mode = hostedGateMode(env);
  const denyLog = createDenyLog({ ...(write ? { write } : {}), ...(mode === 'log' ? { head: 5000 } : {}) });
  const role = prerender ? 'prerender' : 'editor';
  // 通行记号：编辑器进程先生成（它起的预渲染进程从环境里继承）；预渲染进程只读不生成
  if (!prerender && !env[GATE_PASS_ENV]) env[GATE_PASS_ENV] = randomBytes(24).toString('hex');
  const pass = String(env[GATE_PASS_ENV] ?? '');
  const egressHeader = env[TEST_NO_EGRESS_HEADER_ENV] !== '1';

  server.middlewares.use((req, res, next) => {
    const given = req.headers[GATE_PASS_HEADER];
    delete req.headers[GATE_PASS_HEADER];
    // 编辑器一侧：自己的预渲染进程转来的、已经过了那一侧的闸的素材请求
    if (!prerender && samePass(given, pass) && relayAllowed(req.url, req.method)) return next();
    const verdict = pageGate({ url: req.url, method: req.method, headers: req.headers, prerender });
    if (prerender && verdict.browser && egressHeader) res.setHeader(EGRESS_HEADER[0], EGRESS_HEADER[1]);
    // 只记不拦时把浏览器发来的每一条 /api 请求都记下（放行的也记）：定放行表时看页面实际发了什么
    if (mode === 'log' && verdict.browser && verdict.allow && /^\/+api\//i.test(String(req.url ?? ''))) denyLog.note('seen', { layer: 'page', role, method: req.method, path: String(req.url ?? '').split('?')[0].slice(0, 160), reason: 'allowed' });
    if (verdict.allow) {
      // 预渲染一侧：放行了的浏览器请求盖上通行记号（往编辑器转发时带着）
      if (prerender && verdict.browser && pass) req.headers[GATE_PASS_HEADER] = pass;
      return next();
    }
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
  try { (write ?? ((line) => console.log(line)))(`[page-gate] on ${JSON.stringify({ role, mode, egressProxy: proxy ? proxy.port : null, egressHeader: prerender ? egressHeader : null })}`); } catch { /* 日志出错不影响闸 */ }
  installed = { mode, role, counts: () => denyLog.counts(), proxy };
  return installed;
}
