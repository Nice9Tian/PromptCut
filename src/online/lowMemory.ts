/**
 * 低内存档的判定与设备设置(`docs/plan/c10a-contract.md` 第 8 节;语义 `product/platforms.md`「面向的平台」)。
 *
 * # 判定〔契约第 8 节,阈值是策略值,真机校准〕
 *
 *   lowMemory = override ?? (deviceMemory <= 4 || (coarsePointer && maxTouchPoints >= 2 && max(screen.width, screen.height) <= 1600))
 *
 * - `coarsePointer` 取 `matchMedia('(pointer: coarse)')` 或 `matchMedia('(any-pointer: coarse)')`;**不看 UA**(iPad 常报桌面 UA)。
 * - `override` 是设备设置「显示档:自动 / 低内存 / 普通」,存在页面本地(`localStorage`)。
 *   改了之后**下次载入时生效**;从低内存切到普通要提示一次(`setDisplayTier` 回 `notice`)。
 * - 运行中出现 `webglcontextlost`,或连续 3 次视频解码失败:本次会话改按低内存档运行,并提示一次
 *   (`noteRuntimeTrouble`)。会话内的改判记在 `sessionStorage`,同一个标签页刷新之后仍按低内存档。
 * - **只在在线模式里判**;桌面运行环境恒为普通档 —— 调用方把 `online`(`src/online/mode.ts` 的 `ONLINE`)传进来。
 *
 * 本文件不 import `./mode.ts`:那个模块读 `import.meta.env`,Node 的单测里没有它;判定要能注入桩单测。
 */

export type DisplayTier = "auto" | "low" | "normal";

/** 判定要读的几样设备信息(单测注入桩) */
export interface DeviceProbe {
  /** `navigator.deviceMemory`(GiB);iOS 上没有 */
  deviceMemory?: number;
  /** `(pointer: coarse)` 或 `(any-pointer: coarse)` */
  coarsePointer: boolean;
  /** `navigator.maxTouchPoints` */
  maxTouchPoints: number;
  /** `screen.width` / `screen.height`(CSS 像素) */
  screenWidth: number;
  screenHeight: number;
}

/** 阈值(策略值,真机校准;契约第 8 节) */
export const LOW_MEMORY_DEVICE_GIB = 4;
export const LOW_MEMORY_TOUCH_POINTS = 2;
export const LOW_MEMORY_SCREEN_MAX = 1600;
/** 连续这么多次视频解码失败就改按低内存档 */
export const DECODE_FAILURES_TO_DOWNGRADE = 3;

/** 设备设置存在页面本地的键 */
export const DISPLAY_TIER_KEY = "pc.device.displayTier";
/** 本次会话改按低内存档(运行中出事了)的键 */
export const SESSION_DOWNGRADE_KEY = "pc.session.lowMemory";

/** 表 C 的文案(照抄,`docs/plan/c10a-contract.md` 第 14 节) */
export const LOW_MEMORY_TEXT = {
  enter: "当前是低内存档：播放时只看预渲染小尺寸和素材小尺寸；停下时再把这一帧画精确，可能要等几秒；这台设备不做预渲染、也不当渲染节点，修改后由渲染节点重渲。",
  downgraded: "这台设备内存吃紧，已改用低内存档。",
  awaitingUploader: "等待上传方",
} as const;

/** 切到普通档的提示(契约第 8 节只说「要提示」,没给字;见报告) */
export const TO_NORMAL_NOTICE = "改为普通档后，下次载入页面时生效。这台设备内存不够时可能卡顿或关掉页面。";
/** 其余切换也是下次载入生效 */
export const NEXT_LOAD_NOTICE = "显示档已保存，下次载入页面时生效。";

/**
 * 纯判定:给设备信息与覆盖值,回是不是低内存档。
 * `override` 是 `'low'` / `'normal'` 时直接照它;`'auto'` / 缺省按规则判。
 */
export function judgeLowMemory(probe: DeviceProbe, override: DisplayTier = "auto"): boolean {
  if (override === "low") return true;
  if (override === "normal") return false;
  const mem = probe.deviceMemory;
  if (typeof mem === "number" && Number.isFinite(mem) && mem <= LOW_MEMORY_DEVICE_GIB) return true;
  const longSide = Math.max(Number(probe.screenWidth) || 0, Number(probe.screenHeight) || 0);
  return !!probe.coarsePointer && (Number(probe.maxTouchPoints) || 0) >= LOW_MEMORY_TOUCH_POINTS && longSide > 0 && longSide <= LOW_MEMORY_SCREEN_MAX;
}

type MatchMediaFn = (query: string) => { matches: boolean };
interface ProbeEnv {
  navigator?: { deviceMemory?: unknown; maxTouchPoints?: unknown };
  matchMedia?: MatchMediaFn;
  screen?: { width?: unknown; height?: unknown };
}

/** 从浏览器读设备信息;读不到的项按「不像手机」给(普通档) */
export function probeDevice(env: ProbeEnv = globalThis as unknown as ProbeEnv): DeviceProbe {
  const nav = env.navigator ?? {};
  const mm = typeof env.matchMedia === "function" ? env.matchMedia : null;
  const query = (q: string) => { try { return !!mm?.(q)?.matches; } catch { return false; } };
  const mem = typeof nav.deviceMemory === "number" ? nav.deviceMemory : undefined;
  return {
    deviceMemory: mem,
    coarsePointer: query("(pointer: coarse)") || query("(any-pointer: coarse)"),
    maxTouchPoints: Number(nav.maxTouchPoints) || 0,
    screenWidth: Number(env.screen?.width) || 0,
    screenHeight: Number(env.screen?.height) || 0,
  };
}

interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
const safeStore = (pick: () => KV | undefined): KV | null => { try { return pick() ?? null; } catch { return null; } };
const local = (): KV | null => safeStore(() => (globalThis as unknown as { localStorage?: KV }).localStorage);
const session = (): KV | null => safeStore(() => (globalThis as unknown as { sessionStorage?: KV }).sessionStorage);

const isTier = (v: unknown): v is DisplayTier => v === "auto" || v === "low" || v === "normal";

/** 设备设置「显示档」;没设过是 `auto` */
export function readDisplayTier(store: KV | null = local()): DisplayTier {
  try {
    const v = store?.getItem(DISPLAY_TIER_KEY);
    return isTier(v) ? v : "auto";
  } catch {
    return "auto";
  }
}

/**
 * 存设备设置。**下次载入时生效**(本次会话的判定在页面载入时定下,见 `lowMemoryMode`)。
 * `current` 是本次会话生效的判定;从低内存切到普通(新设置判出来不是低内存)回 `TO_NORMAL_NOTICE`,其余回 `NEXT_LOAD_NOTICE`。
 */
export function setDisplayTier(next: DisplayTier, current: boolean, probe: DeviceProbe = probeDevice(), store: KV | null = local()): { notice: string } {
  try {
    if (next === "auto") store?.removeItem(DISPLAY_TIER_KEY);
    else store?.setItem(DISPLAY_TIER_KEY, next);
  } catch { /* 存不下:本次照旧 */ }
  const after = judgeLowMemory(probe, next);
  return { notice: current && !after ? TO_NORMAL_NOTICE : NEXT_LOAD_NOTICE };
}

/* ------------------------------------------------------------------ 本次会话的判定 */

let decided: boolean | null = null;
let downgraded = false;
let downgradeNoticeShown = false;
let decodeFailures = 0;
const listeners = new Set<(low: boolean) => void>();

/**
 * 本次会话是不是低内存档。第一次调用时定下(载入时判一次,改设置下次载入生效);
 * 运行中改判(`noteRuntimeTrouble`)之后恒为 true。桌面运行环境(`online = false`)恒为 false。
 */
export function lowMemoryMode(online: boolean, deps: { probe?: DeviceProbe; override?: DisplayTier; session?: KV | null } = {}): boolean {
  if (!online) return false;
  if (decided === null) {
    const sess = deps.session !== undefined ? deps.session : session();
    let fromSession = false;
    try { fromSession = sess?.getItem(SESSION_DOWNGRADE_KEY) === "1"; } catch { fromSession = false; }
    decided = fromSession || judgeLowMemory(deps.probe ?? probeDevice(), deps.override ?? readDisplayTier());
    if (fromSession) downgraded = true;
  }
  return decided || downgraded;
}

/** 本次会话是运行中改判成低内存档的(不是载入时判出来的) */
export function downgradedThisSession(): boolean {
  return downgraded;
}

/** 低内存档变了(运行中改判)时通知;回退订 */
export function onLowMemoryChange(cb: (low: boolean) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * 运行中出事了:`webglcontextlost` 一次即改判;`decode-failure` 连续 `DECODE_FAILURES_TO_DOWNGRADE` 次改判,
 * 中间有一次 `decode-ok` 就清零。只在在线模式里改判。回的是这一次要不要给用户提示(每个会话只提示一次)。
 */
export function noteRuntimeTrouble(kind: "webglcontextlost" | "decode-failure" | "decode-ok", online: boolean, sess: KV | null = session()): { downgradedNow: boolean; notice: string | null } {
  if (!online) return { downgradedNow: false, notice: null };
  if (kind === "decode-ok") { decodeFailures = 0; return { downgradedNow: false, notice: null }; }
  if (kind === "decode-failure") {
    decodeFailures++;
    if (decodeFailures < DECODE_FAILURES_TO_DOWNGRADE) return { downgradedNow: false, notice: null };
  }
  const wasLow = decided === true || downgraded;
  downgraded = true;
  try { sess?.setItem(SESSION_DOWNGRADE_KEY, "1"); } catch { /* 存不下:本页照样按低内存档 */ }
  if (wasLow) return { downgradedNow: false, notice: null };
  for (const l of [...listeners]) { try { l(true); } catch { /* 一个订阅者坏了不影响别人 */ } }
  if (downgradeNoticeShown) return { downgradedNow: true, notice: null };
  downgradeNoticeShown = true;
  return { downgradedNow: true, notice: LOW_MEMORY_TEXT.downgraded };
}

/** 测试用:清掉本次会话的判定 */
export function resetLowMemoryForTest(): void {
  decided = null;
  downgraded = false;
  downgradeNoticeShown = false;
  decodeFailures = 0;
  listeners.clear();
}
