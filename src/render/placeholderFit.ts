/**
 * 占位符在屏幕上多大(纯函数,单测直接载入;product/rendering.md「兜底顺序」)。
 *
 * 舞台 iframe 按项目分辨率(1920×1080)画,父页用 CSS `scale(预览缩放)` 把它缩到预览框里;包裹层自己还可能有
 * `frame.scale`。占位组件按舞台像素画,不补偿的话 27% 预览下沙漏只剩七八个屏幕像素。这里算出组件在包裹层坐标里该放大多少:
 *
 *   - **沙漏**(普通加载占位,徽标与铺满两种形态中间那个):屏幕上保持原大小(约 28 像素)—— 只抵消预览缩放,
 *     **不**抵消这一层自己的缩放(语义:占位符继承该层的坐标、旋转、缩放和层级);噪点照旧铺满实体框,不缩放。
 *   - **「需要本地 PC 渲染辅助」图标**(`unsupported`,在线浏览器模式):屏幕上的目标大小同时抵消预览缩放和这一层的缩放
 *     (片段缩小了图标也看得清),并按放得下的程度换排法:横排(图标加一行字)→ 竖排(图标在上、字在下)→ 只留图标
 *     (字藏起来,`aria-label` 照旧是全文)→ 图标都放不下时按框等比缩小。
 *
 * 两种都**不超出这一层的框**(徽标形态看位置框,铺满形态看实体框;四周留一点边距),所以相邻两个小片段的图标不会叠在一起。
 * 坐标一律是包裹层的本地像素(舞台像素 × 这一层的缩放之前)。
 */

/** 框的宽高(包裹层本地像素) */
export interface FitBox { width: number; height: number }

/** 「需要本地 PC 渲染辅助」图标的排法 */
export type UnsupportedLayout = "row" | "column" | "icon";

/**
 * 组件该怎么放:`scale` 是组件在包裹层坐标里的放大倍数(1 = 按舞台像素原样画);`layout` 只有图标有。
 * 同样的输入回同样的数,缓存由 `placeholderHost.placeholderFitFor` 管。
 */
export interface PlaceholderFit {
  scale: number;
  layout?: UnsupportedLayout;
}

/**
 * 三种排法未放大时的外框(舞台像素,和 `placeholderStyle.ts` 的样式对得上):
 *   横排  内边距 6/10 + 图标 32×28 + 间距 6 + 一行 14px 字(约 140 宽、18 高)→ 198 × 40;
 *   竖排  图标在上、字在下:宽 = 字宽 140 + 20,高 = 6 + 28 + 4 + 18 + 6 → 160 × 62;
 *   只留图标  52 × 40。
 */
export const UNSUPPORTED_SIZES: Readonly<Record<UnsupportedLayout, { w: number; h: number }>> = Object.freeze({
  row: Object.freeze({ w: 198, h: 40 }),
  column: Object.freeze({ w: 160, h: 62 }),
  icon: Object.freeze({ w: 52, h: 40 }),
});
/** 沙漏(徽标形态的圆、铺满形态中间那个)未放大时的边长(舞台像素) */
export const HOURGLASS_SIZE = 28;
/** 离框边至少留这么多屏幕像素(框太小时改按框短边的 `FIT_MARGIN_RATIO`,取小的那个) */
export const FIT_MARGIN_PX = 4;
export const FIT_MARGIN_RATIO = 0.08;
/** 缩到最小也不小于这个倍数(框几乎是 0 时不画成 0) */
export const FIT_MIN_SCALE = 0.05;
/** 预览缩放的倒数夹在这个范围里(坏值当 1) */
export const VIEW_INVERSE_MIN = 1 / 8;
export const VIEW_INVERSE_MAX = 16;

const positive = (v: unknown, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

/** 抵消预览缩放要放大多少:`1 / 预览缩放`,夹在 [1/8, 16];不是正的有限数时回 1 */
export function viewInverse(viewScale: unknown): number {
  const s = Number(viewScale);
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.min(VIEW_INVERSE_MAX, Math.max(VIEW_INVERSE_MIN, 1 / s));
}

/** 框里能用的宽高(扣掉边距;`perScreenPx` = 一个屏幕像素是几个本地像素) */
function available(box: FitBox, perScreenPx: number): { w: number; h: number } {
  const W = Math.max(0, Number(box?.width) || 0), H = Math.max(0, Number(box?.height) || 0);
  const m = Math.min(FIT_MARGIN_PX * perScreenPx, FIT_MARGIN_RATIO * Math.min(W, H));
  return { w: Math.max(0, W - 2 * m), h: Math.max(0, H - 2 * m) };
}

/**
 * 沙漏放多大:屏幕上保持原大小(只抵消预览缩放),放不进框就按框缩小。
 * `layerScale` 只用来把屏幕像素的边距换成本地像素,不参与放大倍数。
 */
export function hourglassFit(o: { box: FitBox; viewScale: unknown; layerScale?: unknown }): PlaceholderFit {
  const k = viewInverse(o.viewScale);
  const perScreenPx = viewInverse(o.viewScale) / positive(o.layerScale, 1);
  const a = available(o.box, perScreenPx);
  const fit = Math.min(a.w / HOURGLASS_SIZE, a.h / HOURGLASS_SIZE);
  return { scale: Math.max(FIT_MIN_SCALE, Math.min(k, fit)) };
}

/**
 * 「需要本地 PC 渲染辅助」图标怎么放:目标倍数抵消预览缩放和这一层的缩放;按横排 → 竖排 → 只留图标的次序挑第一个放得下的;
 * 都放不下就只留图标、按框等比缩小。
 */
export function unsupportedFit(o: { box: FitBox; viewScale: unknown; layerScale?: unknown }): PlaceholderFit {
  const k = viewInverse(o.viewScale) / positive(o.layerScale, 1);
  const a = available(o.box, k);
  for (const layout of ["row", "column", "icon"] as const) {
    const size = UNSUPPORTED_SIZES[layout];
    if (size.w * k <= a.w && size.h * k <= a.h) return { scale: k, layout };
  }
  const icon = UNSUPPORTED_SIZES.icon;
  return { scale: Math.max(FIT_MIN_SCALE, Math.min(a.w / icon.w, a.h / icon.h)), layout: "icon" };
}
