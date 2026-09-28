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
 * 在线浏览器模式追加的规则(续做:图标在屏幕上的大小):铺满形态里的图标加字按 `--pc-ph-ui-scale` 放大、居中,
 * 放不下就被框裁掉(占位平面本来就 `overflow: hidden`)。变量由舞台按父页的预览缩放设(`placeholderHost.placeholderUiScale`)。
 * 单列一份、只在在线浏览器模式注入:桌面预览舞台注入的样式表与原来逐字相同。小徽标的放大写在组件的内联 `transform` 里。
 */
export const PLACEHOLDER_ONLINE_CSS = `
[data-pc-placeholder-plane][data-pc-placeholder-kind="unsupported"] {
  overflow: hidden;
}
[data-pc-placeholder-plane][data-pc-placeholder-kind="unsupported"] > .pc-ph-unsupported {
  flex: none;
  transform: scale(var(--pc-ph-ui-scale, 1));
  transform-origin: 50% 50%;
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
