import { NOISE_TILE } from "./noise";

/**
 * 性能降级开关(P4 熔断协议):集成进舞台后每拍主线程 p90 超标,一次修复重试后仍超,按协议降级为
 * **极简静态占位符** —— 纯色底 + 静止沙漏,不铺噪点、不转。120 ms 出现延迟仍保留(只跑一次的 opacity 动画)。
 * 恢复噪点和转动:改成 `false`,并把 `index.ts` 的 `maxAnimated` / `layersFor` 改回。
 */
export const PERF_DEGRADED = true;

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
