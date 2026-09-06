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
    __pcSetT?: (sec: number) => void;
    __pcReady?: boolean;
  }
}

export function isExportMode(): boolean {
  return typeof window.__pcExportMs === "number";
}

export function clockNow(): number {
  const t = window.__pcExportMs;
  return typeof t === "number" ? t : performance.now();
}
