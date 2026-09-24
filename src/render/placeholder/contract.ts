/**
 * 占位平面的交接接口(预览兜底任务的 P0 定稿)。
 *
 * 兜底顺序走到尽头时,预览在该卡的位置上显示「沙漏 + 噪点」占位符,代替透明
 * (语义见 `docs/semantics/architecture/rendering.md`「兜底顺序」)。两边各管一半:
 *
 *   - **舞台一侧**(Stage / StageView / streamPlayer 等):决定哪张卡、什么时候显示,算几何,
 *     负责截图 / 墨迹采样 / 像素扫描的排除、动画钉时的豁免、命中测试;
 *   - **占位组件一侧**(`src/render/placeholder/` 下除本文件外的实现):长什么样、怎么做到几乎零开销。
 *
 * 本文件只放两边都要认的类型、常量和两个纯函数;改它要两边同时知道,不单方面改。
 *
 * # 挂在哪里
 *
 * 占位平面是包裹层 `[data-pc-clip]` 的**兄弟平面**(和快照平面、流平面同级),所以坐标、旋转、缩放、
 * 三维透视、不透明度、层级全部从包裹层继承。它**只在人看的预览里挂**:导出页、预渲染进程、
 * Agent 的查询渲染、后台舞台都不挂,样式表也不注入。
 *
 * # 显隐
 *
 * 舞台一侧只用 `setPlaceholderShown` 切换(`hidden` 属性 = `display:none`),不经 React 提交。
 * 占位组件一侧的样式表保证:**从变为显示那一刻起满 `PLACEHOLDER_SHOW_DELAY_MS` 才真正可见**
 * (纯 CSS 实现;`display` 从 none 切回时 CSS 动画会重新开始计时),更短的空档用户看不到它。
 */

/** 占位平面元素上的标记属性。截图、墨迹采样、像素扫描都跳过带它的节点;命中测试点中它算点中所在的卡 */
export const PLACEHOLDER_ATTR = "data-pc-placeholder-plane";

/** 来不及的状态持续满这么久才显示占位符(防抖,已定,不可改) */
export const PLACEHOLDER_SHOW_DELAY_MS = 120;

/** 占位组件自己的 CSS 动画名 / WAAPI 动画 id 一律以它开头;动画钉时只按 `isPlaceholderAnimation` 豁免 */
export const PLACEHOLDER_ANIMATION_PREFIX = "pc-ph-";

/**
 * 为什么显示占位符(诊断用,也可以决定视觉上的细微差别;不要求长相随它变)。
 *
 *   - `no-data`      T1:兜底链尽头,这一层还没有任何预渲染结果;
 *   - `over-budget`  T1:流超出解码器预算、换帧预算也装不下快照;
 *   - `awaiting`     T2:这一帧的快照还没到;
 *   - `catching-up`  T3 / T4:不可见地追帧,或等后台舞台补跑后互换。
 */
export type PlaceholderReason = "no-data" | "over-budget" | "awaiting" | "catching-up";

/** 矩形,相对包裹层,舞台像素 */
export interface PlaceholderBox { left: number; top: number; width: number; height: number }

/**
 * 几何,由舞台一侧给出:
 *   - `solid`:量得到实体框 —— 噪点铺满实体框,沙漏居中;
 *   - `badge`:量不到实体框 —— **只**在位置框中心显示一个小沙漏徽标,不铺噪点(已定,不可改)。
 *     `center` 是位置框中心,相对包裹层、舞台像素。
 */
export type PlaceholderGeometry =
  | { kind: "solid"; box: PlaceholderBox }
  | { kind: "badge"; center: { x: number; y: number } };

export interface PlaceholderPlaneProps {
  clipId: string;
  geometry: PlaceholderGeometry;
  reason: PlaceholderReason;
}

/**
 * 占位组件一侧交付的模块必须满足的形状(`src/render/placeholder/index.ts` 导出这些名字)。
 *
 * - `PlaceholderPlane`:纯渲染 —— 无 state、无 effect、无计时器、无 rAF、不读布局;props 不变不重渲染
 *   (React.memo)。根元素必须带 `PLACEHOLDER_ATTR`,并用 `position:absolute` 只按 `geometry` 定位。
 *   返回值是 React 元素,这里写成 `unknown` 以免本文件依赖 React。
 * - `PLACEHOLDER_CSS`:整张样式表(噪点贴图内联),舞台启动时注入一次;不得覆盖 `[hidden]` 的 `display:none`。
 * - `maxAnimated`:同屏超过这么多个占位符时,多出来的沙漏改为静止(仍然显示,不透明化)。
 * - `layersFor(n)`:同屏 n 个占位符时预计新增的合成层数(实测得出,舞台一侧做上限保护用)。
 */
export interface PlaceholderModule {
  PlaceholderPlane: (props: PlaceholderPlaneProps) => unknown;
  PLACEHOLDER_CSS: string;
  maxAnimated: number;
  layersFor(n: number): number;
}

/** 这个 Animation 是不是占位符自己的(CSS 动画看 `animationName`,WAAPI 看 `id`) */
export function isPlaceholderAnimation(a: { id?: string; animationName?: string }): boolean {
  const name = a.animationName ?? a.id ?? "";
  return typeof name === "string" && name.startsWith(PLACEHOLDER_ANIMATION_PREFIX);
}

/** 舞台一侧切换显隐的唯一入口:不经 React 提交,只动 `hidden` 属性 */
export function setPlaceholderShown(el: { hidden: boolean }, on: boolean): void {
  if (el.hidden === on) el.hidden = !on;
}
