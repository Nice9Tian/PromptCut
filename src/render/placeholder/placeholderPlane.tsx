import { memo } from "react";
import type { CSSProperties } from "react";
import { UNSUPPORTED_TEXT, type PlaceholderPlaneProps } from "./contract";

/**
 * 占位平面。沙漏形态:solid 铺噪点、沙漏居中;badge 只有 28×28 的沙漏徽标。
 * `unsupported`(本机渲染不了的卡):不是「正在加载」,换成静止的「电脑 + 离线」图标加一行字,不铺噪点、不转。
 * 沙漏是否静止由舞台给外面的槽位加 `data-pc-placeholder-static` 决定(contract 的 `PLACEHOLDER_STATIC_ATTR`)。
 */
export const PlaceholderPlane = memo(function PlaceholderPlane({ clipId, geometry, reason }: PlaceholderPlaneProps) {
  const solid = geometry.kind === "solid";
  if (reason === "unsupported") {
    const style: CSSProperties = solid
      ? { position: "absolute", left: geometry.box.left, top: geometry.box.top, width: geometry.box.width, height: geometry.box.height }
      : { position: "absolute", left: geometry.center.x, top: geometry.center.y, transform: "translate(-50%, -50%)" };
    return <div data-pc-placeholder-plane="" data-pc-placeholder-kind={solid ? "unsupported" : "unsupported-badge"}
      data-pc-placeholder-clip={clipId} data-pc-placeholder-reason={reason}
      role="status" aria-label={UNSUPPORTED_TEXT} style={style}>
      <span className="pc-ph-unsupported">
        <svg className="pc-ph-offline" viewBox="0 0 32 28" aria-hidden="true">
          <rect x="3" y="3" width="26" height="17" rx="2" fill="none" stroke="#e8edf2" strokeWidth="2" />
          <path d="M12 25h8M16 20v5" stroke="#e8edf2" strokeWidth="2" strokeLinecap="round" />
          <path d="M11 8l10 8M21 8l-10 8" stroke="#f0a35e" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
        <span className="pc-ph-unsupported-text">{UNSUPPORTED_TEXT}</span>
      </span>
    </div>;
  }
  const style: CSSProperties = solid
    ? { position: "absolute", left: geometry.box.left, top: geometry.box.top, width: geometry.box.width, height: geometry.box.height }
    : { position: "absolute", left: geometry.center.x - 14, top: geometry.center.y - 14, width: 28, height: 28 };
  return <div data-pc-placeholder-plane="" data-pc-placeholder-kind={geometry.kind}
    data-pc-placeholder-clip={clipId} data-pc-placeholder-reason={reason}
    role="status" aria-label="系统正在加载" style={style}>
    <span className="pc-ph-center" aria-hidden="true">
      <svg className="pc-ph-hourglass" viewBox="0 0 28 28" aria-hidden="true">
        <path d="M7 4h14M7 24h14M9 5c0 4 1 5 5 9-4 4-5 5-5 9m10-18c0 4-1 5-5 9 4 4 5 5 5 9" fill="none" stroke="#e8edf2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10.5 8h7L14 12zM11 21h6l-3-3z" fill="#e8edf2" />
      </svg>
    </span>
  </div>;
});
