/**
 * 导出模式的页面时钟量化。
 *
 * 导出脚本每帧推进一格虚拟时间,但 React 提交、rAF 回调落在这一格里的哪个位置,
 * 取决于页面加载时消耗了多少虚拟时间,两次导出不一样。凡是读 performance.now() 或
 * rAF 时间戳的动画(Motion 的帧循环、第三方 rAF 循环)就会跟着差出零点几帧。
 *
 * 这里把两者都钉到当前帧的导出毫秒 window.__pcExportMs:同一帧里不管回调何时跑,
 * 读到的时间都一样,于是逐帧确定。Web Animations / CSS 动画不走这条路,由
 * ExportView 的 __pcSyncAnims 每帧显式钉 currentTime。
 *
 * 只在导出视图里装;__pcExportMs 还没就位(时间轴加载前)时回落到真实时钟。
 */
export function installExportClock(): void {
  const w = window as Window & { __pcExportClockInstalled?: boolean };
  if (w.__pcExportClockInstalled) return;
  w.__pcExportClockInstalled = true;

  const realNow = performance.now.bind(performance);
  performance.now = () => (typeof window.__pcExportMs === "number" ? window.__pcExportMs : realNow());

  const realRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb: FrameRequestCallback) =>
    realRaf((ts) => cb(typeof window.__pcExportMs === "number" ? window.__pcExportMs : ts));
}
