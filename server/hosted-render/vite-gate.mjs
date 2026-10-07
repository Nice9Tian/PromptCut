/**
 * 托管方渲染服务工作进程里两台 Vite 的「页面一侧的闸」（契约 `docs/plan/hosted-render-contract.md` 第 7.5 节）。
 * 只在托管方的工作进程里装（环境里有 `PROMPTCUT_RENDER_BROKER`）；桌面版与普通的独立渲染主机不装，行为不变。
 *
 * 要挡的是渲染用的 Chrome 页面里跑的卡片代码（隔离工作进程里是项目带来的代码）。页面边界与管理口仍各自独立：
 *
 *   1. **页面请求闸**（`page-gate.mjs` 的判定，接在这台 Vite 的最前面）：浏览器发来的请求——编辑器的 Vite 一律 403；
 *      预渲染的 Vite 只认同源，`/api/**` 只放行导出页确实要用的几条。WebSocket 升级同样判（浏览器发的升级一律拒：
 *      工作进程没有页面要连它的热更新或本机文档服务）。Node 一侧的调用（不带 `Sec-Fetch-Site` / `Origin`）照旧。
 * 卡片外链照常加载，不设Connection-Allowlist、不启动出口代理、不追加限制WebRTC的Chrome参数。
 * 页面/API闸与管理口认证继续由服务端执行，不能用出网限制替代。
 *
 * **预渲染 → 编辑器的转发**：渲染页的素材请求（`/@media/*`、`/api/asset/*`、`/api/media/*`）由预渲染的 Vite 原样转给同一个工作进程里
 * 编辑器的 Vite（`asset-client.ts` 的 `assetProxyPlugin`），浏览器的请求头跟着过去，编辑器那一侧的闸会把它当成浏览器直接发来的而拒掉。
 * 所以预渲染一侧给**放行了的**浏览器请求盖一个通行记号（请求头 `x-pc-page-gate`，值是这个工作进程启动时随机生成的串，
 * 经环境变量 `PROMPTCUT_HOSTED_GATE_PASS` 从编辑器进程传给它起的预渲染进程；页面拿不到它，自己带来的同名头先被摘掉）；
 * 编辑器一侧见到对的记号，只放行素材那三类路径的 GET / HEAD，别的照拒。
 *
 * **看画面的接口另要口令**（契约第 8a 节）：`/api/vision/**`、`/api/ai/visual**`、`/api/cards/dom`、`/api/cards/layout`（本机 Agent 看画面用的那一批，
 * `look.mjs` 的 `LOOK_WORKER_PREFIXES`）在托管方的工作进程里只认**管理进程转来的**：Node 一侧的请求也要带这个工作进程自己的代理口口令
 * （请求头 `x-pc-look-key`，值是环境里的 `PROMPTCUT_RENDER_BROKER_KEY`；页面读不到环境变量），不带或不对 403。浏览器发来的照旧走上面的页面请求闸
 * （这几条不在放行表里，403）。所以卡片代码即使绕过了浏览器这一层，也没法让工作进程替它渲一帧别的东西。
 *
 * `PROMPTCUT_PAGE_GATE=log`：只记不拦（定放行表、排查时用）——闸照判、请求照转，把本该拦下的打出来。缺省 `enforce`。
 * 被拦的请求打一行 `[page-gate] deny {…}`（前 50 条逐条，之后每 100 条一行），`render-host.mjs` 原样转出。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pageGate, PAGE_GATE_ENV } from './page-gate.mjs';
import { LOOK_KEY_HEADER, LOOK_WORKER_PREFIXES } from './look.mjs';
import { apiPath } from '../http-guard.mjs';

/** 这个工作进程自己的代理口口令（管理进程经环境变量给的；看画面的接口凭它认「管理进程转来的」） */
const LOOK_KEY_ENV = 'PROMPTCUT_RENDER_BROKER_KEY';
/** 是不是看画面那一批接口 */
export function isLookPath(url) {
  const p = apiPath(url);
  return LOOK_WORKER_PREFIXES.some((prefix) => (prefix.endsWith('/') ? p.startsWith(prefix) : p === prefix || p.startsWith(`${prefix}/`)));
}

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
  const lookKey = String(env[LOOK_KEY_ENV] ?? '');

  server.middlewares.use((req, res, next) => {
    // 经典云预渲页也不允许子框架/插件/base 改写；其它资源及网络由浏览器照常加载。
    const pagePath = String(req.url ?? '').split('?')[0];
    if (prerender && (req.headers['sec-fetch-dest'] === 'document' || pagePath === '/' || /\.html$/i.test(pagePath))) {
      res.setHeader('Content-Security-Policy', "frame-src 'none'; object-src 'none'; base-uri 'none'");
    }
    const given = req.headers[GATE_PASS_HEADER];
    delete req.headers[GATE_PASS_HEADER];
    // 编辑器一侧：自己的预渲染进程转来的、已经过了那一侧的闸的素材请求
    if (!prerender && samePass(given, pass) && relayAllowed(req.url, req.method)) return next();
    const verdict = pageGate({ url: req.url, method: req.method, headers: req.headers, prerender });
    // 看画面的接口：Node 一侧的请求也要带这个工作进程自己的口令（只有管理进程有）。编辑器转给预渲染时头跟着过去，两台各核一遍
    if (!verdict.browser && isLookPath(req.url) && !samePass(req.headers[LOOK_KEY_HEADER], lookKey)) {
      denyLog.note(mode === 'log' ? 'would-deny' : 'deny', { layer: 'look', role, method: req.method, path: String(req.url ?? '').split('?')[0].slice(0, 160), reason: 'look-key' });
      if (mode !== 'log') {
        req.resume?.();
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.end(JSON.stringify({ ok: false, error: 'look-key' }));
      }
    }
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

  try { (write ?? ((line) => console.log(line)))(`[page-gate] on ${JSON.stringify({ role, mode, egressProxy: null, egressHeader: false })}`); } catch { /* 日志出错不影响闸 */ }
  installed = { mode, role, counts: () => denyLog.counts(), proxy: null };
  return installed;
}
