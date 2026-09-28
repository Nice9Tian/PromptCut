/**
 * 低内存档「停下追当前一帧」(c10a 契约第 17 节;语义 `product/rendering.md`「停下就精确」、
 * `mechanism/rendering.md`「低内存档」):暂停、点击或拖动松开、播放到头时,在单舞台里把当前这一帧的所有卡活渲一次,
 * 重卡也画。
 *
 * - 画出来之前各层照兜底顺序显示(贴着预渲染小尺寸,没有就是占位符),画好的层替换上去;
 * - 时限 `LOW_MEMORY_SETTLE_MS`(可调的唯一一处),到时限还没画好的层维持占位符,直到下一次停下;
 * - 推帧卡按从入点追到当前帧算,同样受时限;
 * - 用户卡、图卡不追(这台设备渲染不了):有这一帧的预渲染小尺寸就照贴,没有才显示「电脑 + 离线」图标与
 *   「需要本地 PC 渲染辅助」(2026-09-29 用户改语义;显隐由舞台的占位调度管,不是常驻);
 * - 下一次播放回到只贴小尺寸。
 *
 * 这里只放纯的部分(排序、时限驱动、结果形状),舞台一侧的画法在 `StageView` 的 `settleLowMemory`。
 * 不引 editor,Node 单测直接载入。
 */

/** 停下追一帧的时限(毫秒)。机制「低内存档」的 5 秒,可调 */
export const LOW_MEMORY_SETTLE_MS = 5000;
/** 时限的上下界(父页传进来的值夹在这里) */
export const LOW_MEMORY_SETTLE_MAX_MS = 60_000;

/** 一张卡怎么追:直接定位(一次提交就画好)、从入点逐帧推、这台设备渲染不了(不追) */
export type LowMemorySettleKind = "direct" | "catchup" | "unsupported";

export interface LowMemorySettleItem {
  clipId: string;
  kind: LowMemorySettleKind;
  /** 推帧卡要从入点推多少帧(直接定位的是 0) */
  frames: number;
}

/** 一次停下追一帧的结果(舞台 RPC `settleLowMemory` 的回包,父页记进诊断) */
export interface LowMemorySettleResult {
  /** false:被新的跳转 / 播放 / 换项目打断了,或者舞台做不了(`reason`) */
  ok: boolean;
  reason?: "superseded" | "role" | "no-project" | "rpc";
  sec: number;
  timeoutMs: number;
  /** 从开始追到收尾的墙钟 */
  ms: number;
  /** 画好的层,和它画好时离开始多久 */
  drawn: { clipId: string; ms: number }[];
  /** 到时限还没画好、维持占位符的层 */
  timedOut: string[];
  /** 不追的层(用户卡、图卡:贴着预渲染小尺寸,没有才显示「需要本地 PC 渲染辅助」) */
  skipped: string[];
}

/** 父页给的时限:不是正数就用缺省值,超过上界夹到上界 */
export function clampSettleTimeout(ms: unknown): number {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return LOW_MEMORY_SETTLE_MS;
  return Math.min(LOW_MEMORY_SETTLE_MAX_MS, Math.floor(n));
}

/**
 * 这张卡怎么追。`unsupported`(用户卡、图卡)不追;`direct` 帧模式或者播放头就在入点上的,一次提交就画好;
 * 其余从入点逐帧推到当前帧。
 */
export function settleKindOf(o: { unsupported: boolean; frameMode: string | undefined; mountFrame: number; targetFrame: number }): LowMemorySettleItem["kind"] {
  if (o.unsupported) return "unsupported";
  if (o.frameMode === "direct" || o.targetFrame <= o.mountFrame) return "direct";
  return "catchup";
}

/**
 * 追的先后:直接定位的先(一次提交就画好),推帧卡按要推的帧数从少到多 —— 时限之内画好的层尽量多。
 * 同样的按 clipId 定序。`unsupported` 的不进队列,单列出来。
 */
export function orderLowMemorySettle(items: readonly LowMemorySettleItem[]): { queue: LowMemorySettleItem[]; skipped: string[] } {
  const queue = items.filter((it) => it.kind !== "unsupported");
  const skipped = items.filter((it) => it.kind === "unsupported").map((it) => it.clipId).sort();
  const rank = (it: LowMemorySettleItem) => (it.kind === "direct" ? 0 : 1);
  queue.sort((a, b) => rank(a) - rank(b) || a.frames - b.frames || (a.clipId < b.clipId ? -1 : a.clipId > b.clipId ? 1 : 0));
  return { queue, skipped };
}

/** 画一层的结果:画好了、到时限了、被打断了 */
export type DrawOutcome = "drawn" | "timeout" | "aborted";

/**
 * 时限驱动:按 `orderLowMemorySettle` 的先后一层层画(`draw` 自己也看 `deadline`,推帧推到一半到时限就回 `timeout`)。
 * 到时限时还没开始画的层一并记进 `timedOut`;被打断(`aborted()` 或 `draw` 回 `aborted`)时回 `ok: false`,
 * 没画的层同样记进 `timedOut`(舞台一侧它们本来就还盖着)。
 */
export async function runLowMemorySettle(o: {
  sec: number;
  items: readonly LowMemorySettleItem[];
  timeoutMs: number;
  now: () => number;
  draw: (item: LowMemorySettleItem, deadline: number) => Promise<DrawOutcome>;
  aborted?: () => boolean;
}): Promise<LowMemorySettleResult> {
  const started = o.now();
  const timeoutMs = clampSettleTimeout(o.timeoutMs);
  const deadline = started + timeoutMs;
  const { queue, skipped } = orderLowMemorySettle(o.items);
  const drawn: LowMemorySettleResult["drawn"] = [];
  const timedOut: string[] = [];
  const finish = (ok: boolean, rest: LowMemorySettleItem[] = []): LowMemorySettleResult => {
    for (const it of rest) timedOut.push(it.clipId);
    return { ok, ...(ok ? {} : { reason: "superseded" as const }), sec: o.sec, timeoutMs, ms: o.now() - started, drawn, timedOut, skipped };
  };
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (o.aborted?.()) return finish(false, queue.slice(i));
    if (o.now() >= deadline) return finish(true, queue.slice(i));
    const outcome = await o.draw(item, deadline);
    if (outcome === "drawn") drawn.push({ clipId: item.clipId, ms: o.now() - started });
    else if (outcome === "timeout") timedOut.push(item.clipId);
    else return finish(false, queue.slice(i));
  }
  return finish(true);
}
