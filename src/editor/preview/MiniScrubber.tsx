/**
 * 迷你控制进度条组件。
 * 对话式布局下显示在控制栏下方，直观展示卡片和素材片段分布情况。
 * 支持点击及拖动实现视频定位（seek）。
 */
import React, { useRef } from "react";
import { useStore, actions } from "../../store/project";

export function MiniScrubber() {
  const project = useStore((s) => s.project);
  const t = useStore((s) => s.t);
  const duration = project.duration || 1;
  const barRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    const el = barRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);

    const update = (evt: PointerEvent | React.PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
      actions.seek(pct * duration);
    };

    update(e);

    const onMove = (evt: PointerEvent) => update(evt);
    const onUp = (evt: PointerEvent) => {
      update(evt);
      el.releasePointerCapture(evt.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };

  return (
    <div
      style={{
        height: 12,
        background: "var(--ui-panel)",
        borderBottom: "none",
        borderTop: "1px solid var(--ui-border)",
        display: "flex",
        alignItems: "center",
        padding: "0 6px",
      }}
    >
      <div
        ref={barRef}
        onPointerDown={handlePointerDown}
        style={{
          position: "relative",
          flex: 1,
          height: 6,
          background: "var(--ui-bg)",
          borderRadius: 3,
          cursor: "pointer",
          overflow: "hidden",
        }}
      >
        {/* 渲染片段分布 */}
        {project.tracks.map((track) =>
          track.clips.map((clip) => {
            const isMedia = !!clip.mediaId;
            return (
              <div
                key={clip.id}
                style={{
                  position: "absolute",
                  left: `${(clip.start / duration) * 100}%`,
                  width: `${((clip.end - clip.start) / duration) * 100}%`,
                  height: "100%",
                  background: isMedia ? "var(--ui-border-strong)" : "var(--ui-accent)",
                  opacity: 0.8,
                }}
              />
            );
          })
        )}
        {/* 渲染播放头位置 */}
        <div
          style={{
            position: "absolute",
            left: `${(t / duration) * 100}%`,
            top: 0,
            bottom: 0,
            width: 2,
            background: "var(--ui-fg)",
            transform: "translateX(-50%)",
            pointerEvents: "none",
          }}
        />
      </div>
    </div>
  );
}
