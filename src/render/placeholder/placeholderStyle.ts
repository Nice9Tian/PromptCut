import { NOISE_TILE } from "./noise";

export const PLACEHOLDER_CSS = `
[data-pc-placeholder-plane] {
  position: absolute;
  box-sizing: border-box;
  overflow: hidden;
  pointer-events: none;
  animation: pc-ph-reveal 120ms steps(1, end) 1;
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
[data-pc-placeholder-plane][data-pc-placeholder-static] .pc-ph-hourglass {
  animation: none;
}
@keyframes pc-ph-reveal { from { opacity: 0; } to { opacity: 1; } }
@keyframes pc-ph-turn { from { transform: rotate(0deg); } to { transform: rotate(180deg); } }
`;
