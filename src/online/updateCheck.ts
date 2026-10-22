/**
 * 在线浏览器的新版本检查（语义 `docs/semantics/product/platforms.md` 与 `docs/semantics/mechanism/platforms.md`「在线浏览器」的「新版本提示」）：
 * - 在线构建产出 `<base>version.json`（内容 `{ "codeVersion": "<值>" }`，与页面里的 `CODE_VERSION` 同源），nginx 回 `Cache-Control: no-store`；
 * - 编辑器页（不含舞台、导出页）切回前台时（`visibilitychange` 且 `visibilityState === "visible"`）、以及在前台时每 10 分钟取一次
 *   （`fetch(url, { cache: "no-store" })`）；启动时不取，在后台时不取；
 * - 取到的 `codeVersion` 与本页自己的代码版本（`src/online/buildInfo.ts` 的 `CODE_VERSION`）不同 → 状态变为「有新版本」并通知订阅者；
 *   相同 → 没有新版本；
 * - 本页代码版本为 `null`（开发构建）时永远不取、不提示；
 * - 取失败（网络抛错、非 2xx、回落成 `index.html` 等非 JSON 正文、`codeVersion` 缺失或不是非空字符串）→ 本次忽略，状态不变
 *   （既不挂出提示，也不撤掉已挂出的提示）；
 * - 同一时刻只发一个请求；
 * - 对外提供可直接交给 React `useSyncExternalStore(subscribe, getState)` 的订阅接口。
 *
 * 层级约束：属于 `src/online/`（与 render 同层），不引用 `src/editor/`，不静态引用 `./mode`，不直接读 `import.meta.env`。
 */
import { CODE_VERSION } from "./buildInfo.ts";

/** 版本文件名（相对在线构建的 `base`，即 `/editor/version.json`） */
export const VERSION_FILE = "version.json";

/** 在前台时周期检查新版本的间隔：10 分钟 */
export const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** 可见性来源（浏览器里为 `document`，单测可注入假实现） */
export interface VisibilitySource {
  readonly visibilityState?: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** 新版本检查的对外状态（状态未变时 `getState()` 返回同一个对象引用） */
export interface UpdateCheckState {
  /** 是否检测到与本页不同的新版本 */
  readonly hasUpdate: boolean;
  /** 本页自己的代码版本（开发构建为 `null`） */
  readonly currentVersion: string | null;
  /** 检测到新版本时的远端代码版本；未检测到新版本时为 `null` */
  readonly latestVersion: string | null;
}

/** `startUpdateCheck` 的可注入环境参数 */
export interface UpdateCheckEnv {
  /** 在线构建的 `base`（缺省 `"/editor/"`），请求 `<base>version.json` */
  base?: string;
  /** 本页自己的代码版本（缺省取 `buildInfo.ts` 的 `CODE_VERSION`）；为 `null` 时永远不查、不提示 */
  codeVersion?: string | null;
  /** 自定义 `fetch`（缺省取全局 `fetch`） */
  fetch?: typeof globalThis.fetch;
  /** `fetch` 的别名，兼容 `stageOrigins.ts` 的注入命名 */
  fetchImpl?: typeof globalThis.fetch;
  /** 可见性来源（缺省取全局 `document`） */
  visibility?: VisibilitySource | null;
  /** 前台定时检查间隔毫秒数（缺省 `UPDATE_CHECK_INTERVAL_MS`，即 10 分钟） */
  intervalMs?: number;
  /** 自定义 `setInterval`（缺省取全局 `setInterval`） */
  setInterval?: (callback: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>;
  /** 自定义 `clearInterval`（缺省取全局 `clearInterval`） */
  clearInterval?: (id: any) => void;
}

/** `startUpdateCheck` 返回的控制器，可直接配合 `useSyncExternalStore` 使用 */
export interface UpdateCheckController {
  /** 读取当前状态；状态未变时返回同一个对象引用 */
  getState: () => Readonly<UpdateCheckState>;
  /** 订阅状态变化；返回取消订阅函数 */
  subscribe: (listener: () => void) => () => void;
  /** 停止监听 `visibilitychange` 与定时器；之后不再发请求、不再更新状态 */
  stop: () => void;
}

/**
 * 解析 `version.json` 的正文或对象，取出合法的非空字符串 `codeVersion`；
 * 非 JSON（例如 nginx `try_files` 回落的 `index.html`）、不是对象、缺字段或空字符串一律返回 `null`。
 */
export function parseVersionJson(input: unknown): string | null {
  let parsed: unknown = input;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = (parsed as { codeVersion?: unknown }).codeVersion;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 启动在线新版本检查。
 * - 启动时不发请求；
 * - 切回前台（`visibilitychange` 且 `visibilityState === "visible"`）时检查一次；
 * - 在前台时每 `intervalMs`（缺省 10 分钟）检查一次，在后台时计时器到点也不发请求；
 * - `codeVersion` 为 `null` 时不挂监听、不起计时器、永远不发请求。
 */
export function startUpdateCheck(env: UpdateCheckEnv = {}): UpdateCheckController {
  const rawSelf = env.codeVersion !== undefined ? env.codeVersion : CODE_VERSION;
  const selfVersion = typeof rawSelf === "string" && rawSelf.trim().length > 0 ? rawSelf.trim() : null;
  const base = env.base ?? "/editor/";
  const url = `${base.replace(/\/?$/, "/")}${VERSION_FILE}`;
  const fetchFn = env.fetch ?? env.fetchImpl ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
  const visibility: VisibilitySource | null =
    env.visibility !== undefined
      ? env.visibility
      : typeof document !== "undefined" && document && typeof document.addEventListener === "function"
        ? document
        : null;
  const intervalMs = env.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  const setIntervalFn = env.setInterval ?? globalThis.setInterval.bind(globalThis);
  const clearIntervalFn = env.clearInterval ?? globalThis.clearInterval.bind(globalThis);

  let state: Readonly<UpdateCheckState> = Object.freeze({
    hasUpdate: false,
    currentVersion: selfVersion,
    latestVersion: null,
  });
  const listeners = new Set<() => void>();
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const applyRemoteVersion = (remoteVersion: string) => {
    if (stopped || !selfVersion) return;
    const nextHasUpdate = remoteVersion !== selfVersion;
    const nextLatest = nextHasUpdate ? remoteVersion : null;
    if (state.hasUpdate === nextHasUpdate && state.latestVersion === nextLatest) return;
    state = Object.freeze({
      hasUpdate: nextHasUpdate,
      currentVersion: selfVersion,
      latestVersion: nextLatest,
    });
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* 订阅方抛错不影响其它订阅方 */
      }
    }
  };

  const checkOnce = (): void => {
    if (stopped || !selfVersion || !fetchFn || inFlight) return;
    inFlight = (async () => {
      try {
        const res = await fetchFn(url, { cache: "no-store" });
        if (!res || !res.ok) return;
        const text = await res.text();
        const remoteVersion = parseVersionJson(text);
        if (!remoteVersion) return;
        applyRemoteVersion(remoteVersion);
      } catch {
        /* 网络失败或解析失败：忽略本次，状态不变 */
      } finally {
        inFlight = null;
      }
    })();
  };

  const isVisible = (): boolean => (visibility?.visibilityState ?? "visible") === "visible";

  const onVisibilityChange = (): void => {
    if (stopped) return;
    if (isVisible()) checkOnce();
  };

  const onTick = (): void => {
    if (stopped) return;
    if (isVisible()) checkOnce();
  };

  let timerId: ReturnType<typeof globalThis.setInterval> | null = null;
  if (selfVersion !== null) {
    visibility?.addEventListener("visibilitychange", onVisibilityChange);
    timerId = setIntervalFn(onTick, intervalMs);
  }

  const getState = (): Readonly<UpdateCheckState> => state;

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (selfVersion !== null) {
      visibility?.removeEventListener("visibilitychange", onVisibilityChange);
      if (timerId !== null) {
        clearIntervalFn(timerId);
        timerId = null;
      }
    }
  };

  return { getState, subscribe, stop };
}
