/**
 * 占位组件的**桩**(按 `placeholder/contract.ts` 的 `PlaceholderModule` 实现)。
 *
 * 真的实现(沙漏 + 噪点、零开销)由另一侧交付在 `src/render/placeholder/`;交付之前舞台先用这一份:
 * 静态灰框 + 静态沙漏字符,量不到实体框时只在位置框中心放一个小沙漏徽标。
 * **B 交付后只换 `Stage.tsx` 里那一行 import**,这个文件可以删。
 *
 * 守 contract 的几条:纯渲染(无 state / effect / 计时器 / rAF、不读布局)、`React.memo`、
 * 根元素带 `PLACEHOLDER_ATTR`、`position:absolute` 只按 `geometry` 定位;
 * 样式表不覆盖 `[hidden]` 的 `display:none`;「满 120 ms 才可见」用一条 `pc-ph-` 前缀的 CSS 动画实现
 * (`display` 从 none 切回时 CSS 动画重新开始计时;舞台钉时间按前缀豁免它)。
 */
import { memo } from "react";
import { PLACEHOLDER_ANIMATION_PREFIX, PLACEHOLDER_ATTR, PLACEHOLDER_SHOW_DELAY_MS, type PlaceholderPlaneProps } from "./placeholder/contract";

const BADGE = 28;

export const PlaceholderPlane = memo(function PlaceholderPlane({ clipId, geometry, reason }: PlaceholderPlaneProps) {
  const attrs = { [PLACEHOLDER_ATTR]: "", "data-pc-placeholder-clip": clipId, "data-pc-placeholder-why": reason };
  if (geometry.kind === "badge") {
    const { x, y } = geometry.center;
    return (
      <div {...attrs} className="pc-ph-stub pc-ph-stub-badge"
        style={{ position: "absolute", left: x - BADGE / 2, top: y - BADGE / 2, width: BADGE, height: BADGE }}>
        ⌛
      </div>
    );
  }
  const { left, top, width, height } = geometry.box;
  return (
    <div {...attrs} className="pc-ph-stub pc-ph-stub-solid" style={{ position: "absolute", left, top, width, height }}>
      <span className="pc-ph-stub-glass">⌛</span>
    </div>
  );
});

export const PLACEHOLDER_CSS = [
  `@keyframes ${PLACEHOLDER_ANIMATION_PREFIX}stub-appear { from { opacity: 0; } to { opacity: 1; } }`,
  `.pc-ph-stub { box-sizing: border-box; display: flex; align-items: center; justify-content: center;`,
  `  animation: ${PLACEHOLDER_ANIMATION_PREFIX}stub-appear ${PLACEHOLDER_SHOW_DELAY_MS}ms steps(1, end) both; }`,
  `.pc-ph-stub[hidden] { display: none; }`,
  `.pc-ph-stub-solid { background: rgba(128, 128, 128, 0.45); border: 1px dashed rgba(255, 255, 255, 0.5); }`,
  `.pc-ph-stub-glass { font-size: 32px; line-height: 1; }`,
  `.pc-ph-stub-badge { border-radius: 50%; background: rgba(40, 40, 40, 0.7); font-size: 16px; line-height: 1; }`,
].join("\n");

/** 桩的沙漏本来就不转 */
export const maxAnimated = 0;

/** 每个占位符最多一个合成层(那条出现动画) */
export function layersFor(n: number): number {
  return Math.max(0, n);
}
