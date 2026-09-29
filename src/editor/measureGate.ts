/**
 * 测量的开工门(在线浏览器模式;C10 契约第 9 节「识别」的配套)。
 *
 * 在线页面打开后,内容库里同步来的用户卡要等卡片源码第一次同步完(`sync/onlineCardSources.ts`)才认得出来。在那之前它们
 * 被当成未知 id,测量(`probeRunner.ts` 的常驻探针、低内存档的界限搜索)可能在后台舞台上把它测一次、记一条成本记录。
 * 所以在线页面的测量等这道门:卡片源码第一次同步完成(成功,或者回了失败)就开;一直没回音时最多等
 * `MEASURE_GATE_MAX_MS`,照常开始。开了就不再关。
 *
 * 桌面运行环境(不是在线页面)一开始就是开的,测量照旧。Node 单测里 `onlinePage()` 恒为 false,同样是开的。
 */
import { onlinePage } from "../online/pageFlag";

/** 卡片源码第一次同步最多等这么久(毫秒),过了照常开始测量 */
export const MEASURE_GATE_MAX_MS = 10_000;

export type MeasureGateReason = "desktop" | "synced" | "failed" | "timeout";

type Timer = ReturnType<typeof setTimeout>;
let state: "unset" | "held" | "open" = "unset";
let timer: Timer | null = null;
let waiters: Array<() => void> = [];
const diag = { heldAt: null as number | null, openedAt: null as number | null, reason: null as MeasureGateReason | null };
/** 单测可以换掉计时与时钟 */
let clock: { now: () => number; setTimer: (fn: () => void, ms: number) => Timer; clearTimer: (t: Timer) => void } = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t),
};

function open(reason: MeasureGateReason): void {
  if (state === "open") return;
  state = "open";
  if (timer !== null) clock.clearTimer(timer);
  timer = null;
  diag.openedAt = clock.now();
  diag.reason = reason;
  const list = waiters;
  waiters = [];
  for (const w of list) { try { w(); } catch { /* 等门的一方坏了不影响别人 */ } }
}

function init(): void {
  if (state !== "unset") return;
  if (onlinePage()) holdMeasureForCardSources();
  else open("desktop");
}

/**
 * 关门等卡片源码(在线页面的 `Preview` 在开始同步卡片源码时叫;门已经开过就什么都不做)。
 * 从这一刻起最多等 `maxMs`,过了自己开。
 */
export function holdMeasureForCardSources(maxMs: number = MEASURE_GATE_MAX_MS): void {
  if (state !== "unset") return;
  state = "held";
  diag.heldAt = clock.now();
  timer = clock.setTimer(() => { timer = null; open("timeout"); }, Math.max(0, maxMs));
}

/** 卡片源码第一次同步有了结果:`ok` 为 true 是同步完了,false 是回了失败。两种都开门 */
export function releaseMeasureGate(ok: boolean): void {
  if (state === "unset") state = "held";
  open(ok ? "synced" : "failed");
}

/** 门开了没有(第一次问时按是不是在线页面定初值) */
export function measureGateOpen(): boolean {
  init();
  return state === "open";
}

/** 等到门开(已经开着就马上回) */
export function whenMeasureGateOpen(): Promise<void> {
  init();
  if (state === "open") return Promise.resolve();
  return new Promise((resolve) => { waiters.push(resolve); });
}

/** 诊断、探针用 */
export function measureGateDiag() {
  return { state, heldAt: diag.heldAt, openedAt: diag.openedAt, reason: diag.reason, waitedMs: diag.openedAt !== null && diag.heldAt !== null ? diag.openedAt - diag.heldAt : null };
}

/** 单测用:回到刚载入的样子,可换掉计时与时钟 */
export function resetMeasureGate(next?: Partial<typeof clock>): void {
  if (timer !== null) clock.clearTimer(timer);
  timer = null;
  state = "unset";
  waiters = [];
  diag.heldAt = null;
  diag.openedAt = null;
  diag.reason = null;
  clock = {
    now: next?.now ?? (() => Date.now()),
    setTimer: next?.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimer: next?.clearTimer ?? ((t) => clearTimeout(t)),
  };
}
