/**
 * 时钟。
 * 预览:performance.now() 驱动 rAF 自走。
 * 导出:导出脚本每帧显式下发 window.__pcExportMs,页面时钟不可信
 *      (Chrome 虚拟时间在资源加载时会偷偷快进)。任何需要"现在几点"的代码都走 clockNow()。
 */
declare global {
  interface Window {
    __pcExportMs?: number;
    __pcClockRate?: number;
    __pcSetT?: (sec: number, directSec?: number) => void;
    __pcReady?: boolean;
    __pcTimeline?: unknown;
    __pcCardPlan?: () => unknown;
    /** 导出:重新挂载全部卡片(playToken+1) */
    __pcRestartCards?: () => void;
    /** 导出:每帧推进完虚拟时间后,把所有 Web Animations 的 currentTime 钉到导出时间 */
    __pcSyncAnims?: () => void;
    /** 导出:清空动画锚点(正式计帧前调一次) */
    __pcResetAnims?: () => void;
    /** 导出:本帧素材(视频 seek 等)就绪 */
    __pcFrameReady?: () => Promise<void>;
    __pcFrameWorkStatus?: () => { label: string; error?: string }[];
    /**
     * 导出:经 exportClock 包过的 rAF 被注册了多少次。
     * rAF 驱动的 JS 动画(Motion 的 MotionValue)每帧都会重新注册下一帧,停了就不再注册,
     * 所以「这一格内计数没涨」等价于「没有 JS 动画在跑」。document.getAnimations() 看不见这类动画。
     */
    __pcRafCount?: number;
    /** 导出:未被计数的原始 rAF。导出脚本自己等帧用它,免得把 __pcRafCount 顶起来。 */
    __pcRealRaf?: (cb: FrameRequestCallback) => number;
    /**
     * 导出:DOM 变动次数。静态帧判定的主力 —— Motion 的 JS 动画绕开了被替换的 rAF,
     * 但它每帧都要把新值写回 style / 文本节点,这个躲不掉。理由详见 exportClock.ts。
     */
    __pcMutationCount?: number;
    /** 导出:这一帧画面静不静止(静止才敢复用上一帧的截图) */
    __pcStaticProbe?: () => { anims: number; finished: number; raf: number; mut: number; video: boolean; canvas: boolean };
    /** 导出:把 Math.random 的种子拨回起点(每次重挂载卡片时调),让随机效果可复现 */
    __pcResetRandom?: (seed?: number) => void;
    /** 导出:原地换项目,不重新导航。常驻烘焙进程复用同一个页面时用。 */
    __pcLoadProject?: (raw: unknown, options?: { deferCards?: boolean }) => Promise<void>;
    /** Restrict a sparse render to target-frame cards and seek before mounting. */
    __pcSetFrameWindow?: (clipIds: string[] | null, startTime: number, directTime?: number) => void;
    __pcPlanFrameWindow?: (frames: number[], fps: number) => import('../render/frameWindow.mjs').FrameWindow;
    /** Parallel export: every card clip with its frame mode, for choosing safe shard cuts. */
    __pcClipFrameModes?: () => { id: string; start: number; end: number; mode: string | undefined }[];
  }
}

export function isExportMode(): boolean {
  return typeof window.__pcExportMs === "number";
}

export function clockNow(): number {
  const t = window.__pcExportMs;
  return typeof t === "number" ? t : performance.now();
}
