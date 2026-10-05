import { NOISE_TILE } from "./noise";

/**
 * 性能降级开关:P4 曾按熔断协议打开(每拍主线程 p90 超标),用户接受起播 +2.5 ms 后关回,恢复噪点与转动。打开时降级为
 * **极简静态占位符** —— 纯色底 + 静止沙漏,不铺噪点、不转。120 ms 出现延迟仍保留(只跑一次的 opacity 动画)。
 * `index.ts` 的 `maxAnimated` / `layersFor` 跟着它走。
 */
export const PERF_DEGRADED = false;

const NOISE_RULES = PERF_DEGRADED ? "" : `
[data-pc-placeholder-plane][data-pc-placeholder-kind="solid"] {
  background-image: ${NOISE_TILE};
  background-repeat: repeat;
}`;

const TURN_RULES = PERF_DEGRADED ? "" : `
[data-pc-placeholder-plane] .pc-ph-hourglass {
  transform-origin: 50% 50%;
  animation: pc-ph-turn 1800ms ease-in-out infinite;
}
[data-pc-placeholder-static] .pc-ph-hourglass,
[data-pc-placeholder-plane][data-pc-placeholder-static] .pc-ph-hourglass {
  animation: none;
}
@keyframes pc-ph-turn { from { transform: rotate(0deg); } to { transform: rotate(180deg); } }`;

/**
 * 在线浏览器模式追加的规则:「需要本地 PC 渲染辅助」图标的三种排法(舞台按预览缩放、这一层的缩放与框挑一种,
 * `placeholderFit.ts`,组件写在根元素的 `data-pc-placeholder-layout` 上)。放大倍数写在组件的内联 `transform` 里。
 * 单列一份、只在在线浏览器模式注入(`unsupported` 只在这个模式下出现)。
 *   - `row`    图标加一行字(基础样式里的写法,这里不用再写);
 *   - `column` 图标在上、字在下;
 *   - `icon`   只留图标,字藏起来(`aria-label` 照旧是全文)。
 * 铺满形态里,图标加字的外框与徽标形态同样大(内边距 6/10),居中,放不下被框裁掉(`overflow: hidden`)。
 */
export const PLACEHOLDER_ONLINE_CSS = `
[data-pc-placeholder-plane][data-pc-placeholder-kind="unsupported"] {
  overflow: hidden;
}
[data-pc-placeholder-plane][data-pc-placeholder-kind="unsupported"] > .pc-ph-unsupported {
  flex: none;
  flex-direction: row;
  padding: 6px 10px;
  transform-origin: 50% 50%;
}
[data-pc-placeholder-plane][data-pc-placeholder-layout="column"] > .pc-ph-unsupported,
[data-pc-placeholder-plane][data-pc-placeholder-layout="column"] .pc-ph-unsupported {
  flex-direction: column;
  gap: 4px;
}
[data-pc-placeholder-plane][data-pc-placeholder-kind="unsupported-badge"][data-pc-placeholder-layout="column"] {
  padding: 6px 10px;
}
[data-pc-placeholder-plane][data-pc-placeholder-layout="icon"] .pc-ph-unsupported-text {
  display: none;
}`;

export const PLACEHOLDER_CSS = `
[data-pc-placeholder-plane] {
  position: absolute;
  box-sizing: border-box;
  overflow: hidden;
  animation: pc-ph-reveal 120ms steps(1, end) 1;
}
[data-pc-placeholder-plane][data-pc-placeholder-kind="unsupported"] {
  background: #30343d;
  display: flex;
  align-items: center;
  justify-content: center;
}
[data-pc-placeholder-plane][data-pc-placeholder-kind="unsupported-badge"] {
  background: #30343d;
  border-radius: 14px;
  padding: 6px 10px;
  overflow: visible;
}
[data-pc-placeholder-plane] .pc-ph-unsupported {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 6px;
}
[data-pc-placeholder-plane][data-pc-placeholder-kind="unsupported-badge"] .pc-ph-unsupported {
  flex-direction: row;
  padding: 0;
}
[data-pc-placeholder-plane] .pc-ph-offline {
  display: block;
  width: 32px;
  height: 28px;
  flex: none;
}
[data-pc-placeholder-plane] .pc-ph-unsupported-text {
  color: #e8edf2;
  font: 500 14px/1.3 system-ui, sans-serif;
  white-space: nowrap;
}
[data-pc-placeholder-plane][data-pc-placeholder-kind="solid"] {
  background-color: #30343d;
}
[data-pc-placeholder-plane][data-pc-placeholder-kind="badge"] {
  border-radius: 50%;
  background: #30343d;
}
[data-pc-placeholder-plane] .pc-ph-center {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 28px;
  height: 28px;
  transform: translate(-50%, -50%);
}
[data-pc-placeholder-plane] .pc-ph-hourglass {
  display: block;
  width: 28px;
  height: 28px;
}${NOISE_RULES}${TURN_RULES}
@keyframes pc-ph-reveal { from { opacity: 0; } to { opacity: 1; } }
`;
