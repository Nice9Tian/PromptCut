import { memo } from "react";
import type { CSSProperties } from "react";
import type { PlaceholderPlaneProps } from "./contract";

/** The stage may mark instances beyond maxAnimated with data-pc-placeholder-static. */
export const PlaceholderPlane = memo(function PlaceholderPlane({ clipId, geometry, reason }: PlaceholderPlaneProps) {
  const solid = geometry.kind === "solid";
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
