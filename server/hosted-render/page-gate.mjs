/**
 * 托管方渲染服务工作进程的「页面请求闸」（契约 `docs/plan/hosted-render-contract.md` 第 7.5 节）。
 *
 * 工作进程里有两个本机 HTTP 服务：编辑器的 Vite（一堆 `/api/**`：改卡、读本机文件、导出、Agent……）和预渲染进程的 Vite
 * （渲染用的 Chrome 从它加载导出页与卡片模块）。卡片代码跑在那个 Chrome 页面里，与预渲染 Vite **同源**，与编辑器 Vite、
 * 另一个工作进程的两个 Vite **同站不同源**。现有的同源守卫（`vite-plugin-api-guard.ts`）防的是「别的网页替用户发请求」：
 * 不带 `Origin` 的请求（同源 GET、`no-cors` 的跨源 GET）一律放行。对桌面版这没问题——页面里跑的是用户自己的卡；
 * 托管方的渲染服务里页面跑的是**任意项目带来的代码**，所以另加这一道，只在工作进程里（环境里有 `PROMPTCUT_RENDER_BROKER`）生效：
 *
 *   - 判「是不是浏览器发的」：带 `Sec-Fetch-Site` 或 `Origin` 的就是（Chrome 对回环地址的每个 HTTP 请求都带 `Sec-Fetch-Site`，
 *     页面脚本改不了、去不掉这两个头）。Node 一侧的调用（`render-host.mjs`、编辑器与预渲染进程互相调用、管理进程）都不带，照旧放行；
 *   - **编辑器的 Vite**：浏览器发来的一律 403。工作进程没有编辑器页面，渲染用的 Chrome 也不从这里加载任何东西；
 *   - **预渲染的 Vite**：`Sec-Fetch-Site` 必须是 `same-origin`（页面自己的请求）或 `none`（puppeteer 直接开的导航），
 *     别的源（另一个工作进程的页面、任何别的网页）一律 403；过了这一条，`/api/**` 只放行 `PAGE_API_ALLOW` 里的几条——
 *     导出页渲染时确实要用的——其余 403；非 `/api/**`（模块、样式、素材）照常。
 *
 * **现状：只有这个纯函数与它的单测（HR28），还没有接进 `vite-plugin-api-guard.ts`，对任何进程都不生效。**
 * `PAGE_API_ALLOW` 是按读代码估的，没有在真的渲染里核对过页面实际发哪些请求；接线时先只记不拦跑一遍整套演练，再定这张表。
 */
import { apiPath, isAssetServicePath } from '../http-guard.mjs';

/** 工作进程的记号：管理进程交给它的代理口地址 */
export const PAGE_GATE_ENV = 'PROMPTCUT_RENDER_BROKER';

/**
 * 预渲染页面（导出页）可以请求的 `/api/**`：`[方法, 路径前缀或完整路径, 是不是前缀]`。
 * 这张表按整套演练里页面实际发过的请求定（`hosted-render-probe.mjs` 与隔离探针里没有任何一条被拦的正常请求）；
 * 多一种就回来加并写明谁在用。素材服务的路由（`/api/asset/<ns>/<hash>`，只读方法）另行放行：页面按哈希取素材。
 */
export const PAGE_API_ALLOW = Object.freeze([
  // 导出页取这一趟要渲的项目（`ExportView` 按 id 取预渲染进程备好的那一份）
  Object.freeze({ method: 'GET', path: '/api/export/', prefix: true }),
  // 素材的本机文件（已缓存到这个工作进程数据目录里的那一份），按素材 id 取
  Object.freeze({ method: 'GET', path: '/api/media/file', prefix: true }),
  Object.freeze({ method: 'HEAD', path: '/api/media/file', prefix: true }),
  Object.freeze({ method: 'GET', path: '/api/media/tiers', prefix: true }),
]);

function apiAllowed(method, pathname, allow) {
  for (const rule of allow) {
    if (rule.method !== method) continue;
    if (rule.prefix ? pathname.startsWith(rule.path) : pathname === rule.path) return true;
  }
  return false;
}

/**
 * @param {object} o
 * @param {string} o.url
 * @param {string} o.method
 * @param {Record<string, string | string[] | undefined>} o.headers
 * @param {boolean} o.prerender 这个 Vite 是不是预渲染进程的那一个
 * @returns {{ browser: boolean, allow: boolean, reason?: string }}
 */
export function pageGate({ url, method, headers, prerender, allow = PAGE_API_ALLOW }) {
  const site = String(headers?.['sec-fetch-site'] ?? '').toLowerCase();
  const origin = headers?.origin;
  const browser = site !== '' || (origin !== undefined && origin !== '');
  if (!browser) return { browser: false, allow: true };
  if (!prerender) return { browser: true, allow: false, reason: 'editor-no-pages' };
  if (site !== 'same-origin' && site !== 'none') {
    // 没有 Sec-Fetch-Site 而有 Origin（WebSocket 握手、老浏览器）：Origin 要与 Host 对得上
    const host = headers?.host;
    const same = site === '' && typeof origin === 'string' && (origin === `http://${host}` || origin === `https://${host}`);
    if (!same) return { browser: true, allow: false, reason: 'cross-origin' };
  }
  const pathname = apiPath(url);
  // 开发服务器自带的「在编辑器里打开」：会在这台机器上起一个进程，渲染页用不着
  if (pathname.startsWith('/__open-in-editor') || pathname.startsWith('/__inspect')) return { browser: true, allow: false, reason: 'dev-tool' };
  if (!pathname.startsWith('/api/')) return { browser: true, allow: true };
  const m = String(method || 'GET').toUpperCase();
  if (isAssetServicePath(url) && (m === 'GET' || m === 'HEAD')) return { browser: true, allow: true };
  if (apiAllowed(m, pathname, allow)) return { browser: true, allow: true };
  return { browser: true, allow: false, reason: 'api-not-allowed' };
}
