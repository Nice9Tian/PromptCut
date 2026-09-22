/**
 * K5 第二路：`vtOk = false` 的卡（Motion 的 JS 驱动动画）整场景在后台补跑之后**互换角色**。
 *
 * 为什么非得整场景：`advanceToAsync` 改的是模块级的 `now`、`pinAnimations` 的 `sync` 钉全部动画，
 * 而这类卡的 JS 动画只认全局帧时间戳。单张卡用子树虚拟时间推不动它（那正是 `vtOk` 要测的），
 * 所以只能让后台舞台把整台戏从最早的 `mountFrameOf` 补到 `t`，再把两个 iframe 的身份对调。
 *
 * # 顺序（E0 / K5，一步都不许省）
 *
 *  1. `setRole('back', { job: 'catchup' })`（经 `stageJobs` 的单飞队列：**补跑 > 页面侧测量 > 探针**，
 *     排进去就等于让探针让路）→ `pushProject('back', 当前项目, { reset: true })`
 *     —— 探针可能把后台舞台换成了缩水项目，直接发 `setProject` 会绕过 `stageBridge` 的基线；
 *  2. `render(t, { jump: true, maxCatchUp: Infinity })`（不传 `maxCatchUp` 的话
 *     `DEFAULT_MAX_CATCH_UP = 6000` 会削掉起点）；
 *  3. `setMediaT(t)`，等 `{ type: 'mediaReady' }`，最多 300 ms，超时照样换；
 *  4. **互换**：先在一次 React 提交里对调两个 iframe 的可见性（父页的「当前 front」指针同一刻切过去），
 *     **再** `oldFront.setRole('back')` 并等回包，**最后** `back.setRole('front')`；
 *  5. 对新 `front` 补发 `setPlan`（它作为 `back` 时没有表）/ `setLocalHashes` /
 *     `setSnapshots(new Map(), { reset: true })` / `setPlaying(false)` / `setScrubbing(false)` / `setProxy`；
 *  6. 新 `front` post `{ type: 'settled', sec, clipIds: [] }`（舞台侧在 `setRole('front')` 里做）。
 *
 * # 播放态互换（K3(b)）
 *
 * 目标不是 `store.t` 而是**目标拍 `T`**（= `store.t` + 预估补跑时长，取整到拍格）：(1)(2)(3) 的实参
 * 全部是 `T`（拿 `store.t` 会让互换后新 `front` 的 `mediaT` 偏差约一秒、必走硬 seek）。补完之后对
 * 旧 `front` 发 `pause({ atSec: T })` **武装停**，收到 `frame.sec === T`（按拍序号比，不比浮点）
 * 再做 (4)(5)，(5) 末尾改成 `play(T)` + `setPlaying(true)`。可见舞台先走到了 `T`（回 `passed`）
 * 就重取 `T' = store.t + 上次预估 × 2`，对 `back` 续推（不带 `jump`）再武装一次；两次仍追不上按 K6 降级。
 */
import { getState } from "../store/project";
import type { Project } from "../kernel/project";
import { cardMountedAt } from "../render/frameWindow.mjs";
import { clipWeight, pipelineAt } from "../render/pipelinePlan.mjs";
import type { CardCostRecord } from "../render/cardCostKey.mjs";
import type { StageEvent, StageRpcClient } from "../render/stageRpc";
import { backStage, frontStage, onStageEvent, pushProject } from "./stageBridge";
import { runBackJob } from "./stageJobs";
import { currentCosts, currentPlan, currentTuning, sendPlanTo } from "./planDispatch";
import { clipIdentityOf } from "./costIdentity";
import { deliverSnapshots, markBaselineReset, setExtraSuppressed, suppressedAt } from "./snapshotFeed";

/** K5 (3)：等后台舞台的素材层画出一帧，最多等这么久（真墙钟），超时照样换 */
export const MEDIA_READY_TIMEOUT_MS = 300;
/** K3(b)：没有 `catchUpMs` 时预估的补跑时长 */
export const DEFAULT_CATCHUP_GUESS_MS = 1000;
/** K3(b)：武装停等 `frame(T)` 的兜底 */
export const ARM_WAIT_TIMEOUT_MS = 5000;

export interface SwapHost {
  /**
   * 把「谁是可见舞台」切到另一个 iframe：一次 React 提交里对调可见性，并在 `stageBridge`
   * 里重新登记两个角色。回互换之后的两个客户端。
   *
   * 后台 iframe 只能用 `opacity: 0; pointer-events: none` 藏，**禁止 `display: none` /
   * `visibility: hidden`**：整份 OOPIF 退出渲染树之后 `requestVideoFrameCallback` 不再回调，
   * 第 (3) 步的 `mediaReady` 就只能等到超时。
   */
  swapRoles(): { front: StageRpcClient | null; back: StageRpcClient | null } | null;
  /** 当前实体模式（互换后要对新 `front` 重发 —— 它作为 `back` 时是默认值） */
  proxy(): boolean;
  /** A1 的本地素材哈希表 */
  localHashes(): string[];
}

let host: SwapHost | null = null;
export function setSwapHost(next: SwapHost | null): void {
  host = next;
}

/** 正在跑的那一次（同时只能有一次：后台舞台只有一台） */
let running = false;
/** 上一次的预估补跑时长（K3(b) 第二次翻倍） */
let lastGuessMs = 0;

export function swapInFlight(): boolean {
  return running;
}

/* ------------------------------------------------------------------ 判据 */

/** 这一刻活跃的卡片段 */
function activeCardClips(project: Project, t: number) {
  const out: { id: string; start: number; end: number }[] = [];
  for (const tr of project.tracks) {
    if (tr.hidden) continue;
    for (const clip of tr.clips) {
      if (!clip.cardId && !clip.nodeId) continue;
      if (cardMountedAt(clip, t)) out.push(clip);
    }
  }
  return out;
}

/** clipId → 这张卡的 K1 记录（`costs` 按 `identityKey` 索引，记录里没有 clipId） */
function recordOf(project: Project, clipId: string): CardCostRecord | undefined {
  const key = clipIdentityOf(project).identityKeys[clipId];
  if (!key) return undefined;
  return currentCosts().find((r) => r.identityKey === key);
}

/**
 * 这一刻有没有「判重 + `vtOk = false`」的卡 —— 有就得走第二路（整场景补跑后互换）。
 * 只要有一张，就整场景走（正在自己追的 `vtOk` 卡被整场景结果覆盖，无害）。
 */
export function needsBackCatchUp(project: Project, t: number): string[] {
  const plan = currentPlan();
  const out: string[] = [];
  for (const clip of activeCardClips(project, t)) {
    if (pipelineAt(plan, clip.id, t) !== "heavy") continue;
    if (recordOf(project, clip.id)?.vtOk === true) continue;   // 第一路自己追
    out.push(clip.id);
  }
  return out;
}

/**
 * 播放中要等后台补跑的**轻卡**（K3(b) 的 `vtOk = false` 那一支）。
 *
 * 它在 K2 里判轻（各位置都活渲），但整段 `catchUpMs` 超了一拍预算、又推不动子树虚拟时间，
 * 所以播放头进入它时只能整场景在后台补跑后互换。等待期间它进 `front` 的 `suppressed`（透明）。
 */
export function playingCatchUpTargets(project: Project, t: number): string[] {
  const plan = currentPlan();
  const fps = Math.max(1, project.fps || 30);
  const { frameModes } = clipIdentityOf(project);
  const out: string[] = [];
  for (const clip of activeCardClips(project, t)) {
    if (pipelineAt(plan, clip.id, t) !== "light") continue;
    const record = recordOf(project, clip.id);
    if (record?.vtOk === true) continue;    // 在可见舞台里自己追（K5 第一路的机制）
    if (clipWeight(record, frameModes[clip.id], fps, currentTuning()).tier !== "catchup-b") continue;
    out.push(clip.id);
  }
  return out;
}

/** 这张卡估计要补跑多久（K3(b) 的目标拍 `T` 用） */
function guessCatchUpMs(project: Project, clipIds: readonly string[]): number {
  let worst = 0;
  for (const id of clipIds) worst = Math.max(worst, Number(recordOf(project, id)?.catchUpMs) || 0);
  return worst > 0 ? worst : DEFAULT_CATCHUP_GUESS_MS;
}

/* ------------------------------------------------------------------ 等事件 */

function waitForEvent(match: (e: StageEvent) => boolean, timeoutMs: number): Promise<StageEvent | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (e: StageEvent | null) => {
      if (done) return;
      done = true;
      off();
      window.clearTimeout(timer);
      resolve(e);
    };
    const off = onStageEvent((e) => { if (match(e)) finish(e); });
    const timer = window.setTimeout(() => finish(null), timeoutMs);
  });
}

/* ------------------------------------------------------------------ 主流程 */

interface BackReady {
  back: StageRpcClient;
  /** 后台舞台补到了哪一秒 */
  atSec: number;
}

/**
 * (1)(2)(3)：把后台舞台补到 `targetSec` 并等它的素材层出一帧。
 * 排进 `stageJobs` 的 `catchup` 档 —— 探针整体让路，掐出来的 `'project'` 一律丢弃（E0 的例外）。
 */
async function catchUpBack(project: Project, targetSec: number): Promise<BackReady | null> {
  return await runBackJob("catchup", async (ctx) => {
    const back = ctx.stage;
    if (!back || back === frontStage()) return null;   // legacy 单舞台：没有后台可换
    // (1) 探针可能把它换成了缩水项目，整份重灌并更新 stageBridge 的基线
    await pushProject("back", project, { reset: true });
    if (ctx.signal.aborted) return null;
    // (2) 整场景从最早的 mountFrameOf 补到目标拍。不传 maxCatchUp 会被 6000 ms 削掉起点
    const reply = await back.render(targetSec, { jump: true, maxCatchUp: Infinity });
    if ("aborted" in reply && reply.aborted) return null;
    if (ctx.signal.aborted) return null;
    // (3) 素材层也到位（最多等 300 ms，超时照样换）
    const ready = waitForEvent((e) => e.type === "mediaReady", MEDIA_READY_TIMEOUT_MS);
    await back.setMediaT(targetSec);
    await ready;
    return { back, atSec: targetSec };
  });
}

/** (4)(5)：互换并把新 `front` 该有的状态补齐 */
async function swapAndDress(sec: number, playing: boolean): Promise<StageRpcClient | null> {
  const oldFront = frontStage();
  const swapped = host?.swapRoles();
  if (!swapped?.front) return null;
  const next = swapped.front;
  // 先对调可见性（上一行），**再** oldFront.setRole('back') 并等回包，**最后** back.setRole('front')
  if (oldFront && oldFront !== next) {
    try { await oldFront.setRole("back"); } catch { /* iframe 正在换 */ }
  }
  try { await next.setRole("front"); } catch { return null; }

  /* (5) 它作为 back 时没有表、没有哈希、实体模式是默认值 —— 一条都不能省 */
  const project = getState().project;
  try {
    // 补发分派表:它作为 `back` 时没有(E0 的「角色转正时必须补发」)
    await sendPlanTo("front", { force: true });
    await next.setLocalHashes(host?.localHashes() ?? []);
    if (playing) {
      // 播放态互换：先把三个集合摆好，再 play(T)
      await next.setSuppressed(suppressedAt({ project, t: sec, playing: true }));
      await next.setStreamPlanes([]);
      markBaselineReset("front");
      await deliverSnapshots(next, "front", { project, t: sec, playing: true });
      await next.setScrubbing(false);
      await next.setProxy(host?.proxy() ?? false);
      await next.play(sec);
      await next.setPlaying(true);
    } else {
      // settled 态不挂任何平面，快照基线 reset
      markBaselineReset("front");
      await next.setSnapshots({}, { reset: true });
      await next.setPlaying(false);
      await next.setScrubbing(false);
      await next.setProxy(host?.proxy() ?? false);
    }
  } catch { /* iframe 正在换：下一次 setTime 会把状态重新摆一遍 */ }
  return next;
}

/**
 * 暂停态的第二路（K5）：`setTime(t, { settle: true })` 之后，只要有一张判重卡是
 * `vtOk = false` 就走它。
 */
export async function runSettleSwap(t: number): Promise<boolean> {
  if (running) return false;
  const project = getState().project;
  if (!needsBackCatchUp(project, t).length) return false;
  running = true;
  try {
    const ready = await catchUpBack(project, t);
    if (!ready) return false;
    // 补跑期间用户又动了：这一次作废（新的 setTime 会重新发起）
    if (Math.abs(getState().t - t) > 1e-6 || getState().playing) return false;
    return !!(await swapAndDress(t, false));
  } finally {
    running = false;
  }
}

/**
 * 播放态互换（K3(b)）。目标拍 `T = store.t + 预估补跑时长`，取整到拍格。
 *
 * `back` 补完并 `mediaReady` **之后**才对旧 `front` 武装停 —— 反过来的话可见舞台会在
 * `back` 没就绪时停住，停多久没有上界。武装回 `{ passed: true }`（可见舞台先走到了 `T`）
 * 就重取 `T' = store.t + 上次预估 × 2`、对 `back` 续推（不带 `jump`）再武装一次；
 * 两次仍追不上就不换了（那张卡留在 `suppressed` 里，等 K6 降级后的死素材）。
 */
export async function runPlayingSwap(pendingIds: readonly string[]): Promise<boolean> {
  if (running) return false;
  const project = getState().project;
  if (!pendingIds.length) return false;
  running = true;
  // 等待期间这几张卡进 front 的 suppressed（藏子树、t 冻住 —— 没有平面就是透明）
  setExtraSuppressed(pendingIds);
  try {
    const fps = Math.max(1, project.fps || 30);
    lastGuessMs = guessCatchUpMs(project, pendingIds);
    const beatOf = (sec: number) => Math.round(sec * fps);
    let target = Math.ceil((getState().t + lastGuessMs / 1000) * fps) / fps;
    let ready = await catchUpBack(project, target);
    if (!ready) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const oldFront = frontStage();
      if (!oldFront || !getState().playing) return false;
      const armed = waitForEvent((e) => e.type === "frame" && beatOf(e.sec) >= beatOf(target), ARM_WAIT_TIMEOUT_MS);
      const reply = await oldFront.pause({ atSec: target });
      if (reply.ok && reply.passed) {
        // 可见舞台先走到了 T：重取 T' 并对 back **续推**（不带 jump，从 T 接着推）
        if (attempt >= 1) return false;
        lastGuessMs *= 2;
        target = Math.ceil((getState().t + lastGuessMs / 1000) * fps) / fps;
        const back = backStage();
        if (!back) return false;
        const again = await back.render(target, { maxCatchUp: Infinity });
        if ("aborted" in again && again.aborted) return false;
        const media = waitForEvent((e) => e.type === "mediaReady", MEDIA_READY_TIMEOUT_MS);
        await back.setMediaT(target);
        await media;
        continue;
      }
      if (!reply.ok) return false;
      await armed;
      // 互换之后新 front 的 H(T) 里没有它们(它们判轻),所以这一份要先清掉
      setExtraSuppressed([]);
      return !!(await swapAndDress(target, true));
    }
    return false;
  } finally {
    running = false;
    setExtraSuppressed([]);
  }
}

/** 测试用 */
export function resetStageSwap(): void {
  running = false;
  lastGuessMs = 0;
  host = null;
}
