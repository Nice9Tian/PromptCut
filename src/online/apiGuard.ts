/**
 * 在线浏览器模式的 `/api/*` 守卫（C10a 契约 `docs/plan/c10a-contract.md` 第 2 节「在线页面不请求 `/api/*`」）。
 *
 * 在线页面没有编辑器进程，`/api/*` 是桌面运行环境（本机 dev server、桌面版）才有的接口。在线构建里
 * 该隐藏或改走在线替代的入口按契约逐个处理；这里是最后一道：`ONLINE` 下凡是发往同源 `/api/` 的请求，
 * 在浏览器里就地拒掉，一个字节都不发出去，并记下来让漏网的调用在测试里暴露：
 *
 * - `fetch`：回一个被拒的 Promise（TypeError，调用方的「连不上」分支照常接住）；
 * - `EventSource`、`XMLHttpRequest.open`：抛 TypeError；
 * - `navigator.sendBeacon`：回 false。
 *
 * 每个被拒的地址记进 `window.__pcApiBlocked`（去掉查询串，最多 200 条），同一路径只在控制台警告一次。
 * 探针与测试读它断言「一条都没有」或「都被拦下了」。
 *
 * 判定只看路径：同源、路径以 `/api/` 开头，或以构建的 `base`（在线构建是 `/editor/`）加 `api/` 开头
 * （相对地址 `api/x` 在 `/editor/` 页面上会解析到 `/editor/api/x`）。别的源（素材服务、托管端）不管。
 *
 * 本文件不引 `mode.ts`：由 `main.tsx` 在 `ONLINE` 时调 `installApiGuard()`；判定函数在 Node 单测里也能直接用。
 */

export interface ApiGuardOptions {
  /** 页面地址（相对地址按它解析）；缺省 `location.href` */
  href?: string;
  /** 构建的 base（`import.meta.env.BASE_URL`），缺省 `/` */
  base?: string;
}

/** 这个地址是不是同源的 `/api/*`；是的话回去掉查询串的路径，不是回 null */
export function apiPathOf(input: unknown, { href, base = "/" }: ApiGuardOptions = {}): string | null {
  let raw: string;
  if (typeof input === "string") raw = input;
  else if (input instanceof URL) raw = input.href;
  else if (input && typeof input === "object" && typeof (input as { url?: unknown }).url === "string") raw = (input as { url: string }).url;
  else return null;
  const page = href ?? (typeof location !== "undefined" ? location.href : "http://localhost/");
  let u: URL;
  try {
    u = new URL(raw, page);
  } catch {
    return null;
  }
  const pageOrigin = new URL(page).origin;
  if (u.origin !== pageOrigin) return null;
  const b = base.endsWith("/") ? base : `${base}/`;
  if (u.pathname.startsWith("/api/") || u.pathname === "/api" || (b !== "/" && u.pathname.startsWith(`${b}api/`))) return u.pathname;
  return null;
}

const MAX_RECORDS = 200;

type GuardWindow = Window & { __pcApiBlocked?: string[]; __pcApiGuard?: boolean };

/** 装上守卫（幂等）。回被拒地址的记录数组（与 `window.__pcApiBlocked` 同一个） */
export function installApiGuard(options: ApiGuardOptions = {}): string[] {
  const w = window as GuardWindow;
  const blocked = (w.__pcApiBlocked ??= []);
  if (w.__pcApiGuard) return blocked;
  w.__pcApiGuard = true;
  const warned = new Set<string>();
  const base = options.base ?? "/";
  const check = (input: unknown): string | null => apiPathOf(input, { base, href: options.href });
  const refuse = (path: string, via: string): TypeError => {
    if (blocked.length < MAX_RECORDS) blocked.push(path);
    if (!warned.has(path)) {
      warned.add(path);
      console.warn(`[online] 在线浏览器模式不请求编辑器进程的接口，已拦下 ${via} ${path}`);
    }
    return new TypeError(`在线浏览器模式不请求 ${path}（c10a-contract.md 第 2 节）`);
  };

  const origFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = check(input);
    if (path) return Promise.reject(refuse(path, "fetch"));
    return origFetch(input, init);
  }) as typeof window.fetch;

  if (typeof window.EventSource === "function") {
    const Orig = window.EventSource;
    const Guarded = function (this: unknown, url: string | URL, init?: EventSourceInit) {
      const path = check(url);
      if (path) throw refuse(path, "EventSource");
      return new Orig(url, init);
    } as unknown as typeof EventSource;
    Guarded.prototype = Orig.prototype;
    Object.assign(Guarded, { CONNECTING: Orig.CONNECTING, OPEN: Orig.OPEN, CLOSED: Orig.CLOSED });
    window.EventSource = Guarded;
  }

  if (typeof window.XMLHttpRequest === "function") {
    const open = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      const path = check(url);
      if (path) throw refuse(path, "XMLHttpRequest");
      return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof open;
  }

  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      const path = check(url);
      if (path) {
        refuse(path, "sendBeacon");
        return false;
      }
      return beacon(url, data);
    };
  }
  return blocked;
}
