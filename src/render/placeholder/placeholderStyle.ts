import { NOISE_TILE } from "./noise";

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
  background-image: ${NOISE_TILE};
  background-repeat: repeat;
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
  transform-origin: 50% 50%;
  animation: pc-ph-turn 1800ms ease-in-out infinite;
}
[data-pc-placeholder-static] .pc-ph-hourglass,
[data-pc-placeholder-plane][data-pc-placeholder-static] .pc-ph-hourglass {
  animation: none;
}
@keyframes pc-ph-reveal { from { opacity: 0; } to { opacity: 1; } }
@keyframes pc-ph-turn { from { transform: rotate(0deg); } to { transform: rotate(180deg); } }
`;
