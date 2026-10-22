/**
 * 左侧栏的宽度:拖右边那条缝改,记在本机,下次打开还是这个宽度(用户 2026-10-23 定)。
 *
 * 为什么存 localStorage 而不是跟着账号走:这是「这台机器上这块屏幕看着顺手」的事,换一台电脑
 * 屏幕不一样,带过去反而不对。读写都包 try/catch —— 无痕窗口、禁了站点数据的浏览器会直接抛,
 * 抛了就当没存过、用默认宽度,不能让首屏白掉(和 `src/skins/useSkin.ts` 读 `pc.skin` 同一套写法)。
 */
export const SIDE_WIDTH = {
  /** 默认宽度,和原来写死在 CSS 里的 flex-basis 一样 */
  def: 248,
  /** 再窄项目名就只剩两三个字,没意义 */
  min: 190,
  /** 再宽就把右边那排缩略图挤得放不下两格 */
  max: 420,
  key: "pc.start.sideWidth",
} as const;

export function clampSideWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDE_WIDTH.def;
  return Math.min(SIDE_WIDTH.max, Math.max(SIDE_WIDTH.min, Math.round(px)));
}

export function readSideWidth(): number {
  try {
    const saved = localStorage.getItem(SIDE_WIDTH.key);
    if (saved === null) return SIDE_WIDTH.def;
    const n = Number(saved);
    // 存坏了(手改过、旧版本写的别的东西)就退回默认,不要把 NaN 写进样式
    return Number.isFinite(n) ? clampSideWidth(n) : SIDE_WIDTH.def;
  } catch {
    return SIDE_WIDTH.def;
  }
}

export function writeSideWidth(px: number): void {
  try {
    localStorage.setItem(SIDE_WIDTH.key, String(clampSideWidth(px)));
  } catch {
    // 存不了就只在这一次打开期间生效,不报错
  }
}

/** 侧栏收起来没有。和宽度一样记在本机:收起来的人下次打开还是收着的 */
const COLLAPSED_KEY = "pc.start.sideCollapsed";

export function readSideCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSideCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // 同上
  }
}
