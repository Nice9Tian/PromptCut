import { useState } from "react";
import { actions, getState, useStore } from "../../store/project";
import { useTimelineContext } from "./TimelineContext";
import { formatTime, timeOfX, xOfTime } from "./utils";

/** 范围条高度(px) */
export const RANGE_H = 20;

/**
 * 时间轴顶部的「开始 — 结束」范围卡标(参考剪映的做法,不做封面那一块)。
 * 左边一枚卡标钉在 0,右边一枚是总时长——右边这枚可以拖,拖完才写进文档(一次拖动 = 一步撤销)。
 */
export function RangeBar() {
  const { pxPerSec, trackAreaRef } = useTimelineContext();
  const duration = useStore((s) => s.project.duration);
  const [dragEnd, setDragEnd] = useState<number | null>(null);

  const shown = dragEnd ?? duration;
  const x0 = xOfTime(0, pxPerSec);
  const x1 = xOfTime(shown, pxPerSec);

  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // 没有捕获也能拖
    }
    const secAt = (clientX: number) => {
      const left = trackAreaRef.current?.getBoundingClientRect().left ?? 0;
      // 总时长至少 1 秒,按 0.1 秒对齐
      return Math.max(1, Math.round(timeOfX(clientX - left, pxPerSec) * 10) / 10);
    };
    setDragEnd(secAt(e.clientX));
    const onMove = (ev: PointerEvent) => setDragEnd(secAt(ev.clientX));
    const onUp = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      const next = secAt(ev.clientX);
      setDragEnd(null);
      if (Math.abs(next - getState().project.duration) > 1e-6) actions.setProjectMeta({ duration: next });
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  return (
    <div data-pc="range-bar" className="relative select-none bg-neutral-950" style={{ height: RANGE_H }}>
      {/* 范围本身 */}
      <div
        className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-neutral-700"
        style={{ left: x0, width: Math.max(0, x1 - x0) }}
      />
      {/* 开始卡标:钉在 0 */}
      <div
        data-pc="range-start"
        className="absolute top-1/2 -translate-y-1/2 flex h-[15px] items-center rounded border border-neutral-700 bg-neutral-800 px-1 text-[10px] text-neutral-300 tabular-nums pointer-events-none"
        style={{ left: x0 }}
        title="开始"
      >
        {formatTime(0)}
      </div>
      {/* 结束卡标:拖它改总时长 */}
      <div
        data-pc="range-end"
        className="absolute top-1/2 -translate-y-1/2 flex h-[15px] -translate-x-full items-center gap-1 rounded border border-neutral-600 bg-neutral-800 px-1 text-[10px] text-neutral-200 tabular-nums cursor-ew-resize touch-none hover:border-neutral-400"
        style={{ left: x1 }}
        title="拖动 = 调整总时长"
        onPointerDown={startDrag}
      >
        <span className="text-neutral-500">‖</span>
        {formatTime(shown)}
      </div>
    </div>
  );
}
