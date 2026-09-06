import { useState } from "react";
import { useTimelineContext } from "./TimelineContext";
import { useStore, actions, getState } from "../../store/project";
import { snapTime } from "./utils";

export function Playhead() {
  const t = useStore((s) => s.t);
  const { pxPerSec } = useTimelineContext();
  const [dragT, setDragT] = useState<number | null>(null);

  const displayT = dragT !== null ? dragT : t;
  const left = displayT * pxPerSec;

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let startX = e.clientX;
    let startT = displayT;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      let newT = startT + dx / pxPerSec;
      const state = getState();
      newT = snapTime(newT, ev.altKey, state.project, state.t, undefined, pxPerSec);
      setDragT(Math.max(0, newT));
    };

    const onUp = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.releasePointerCapture(e.pointerId);
      
      const finalDx = ev.clientX - startX;
      let newT = startT + finalDx / pxPerSec;
      const state = getState();
      newT = snapTime(newT, ev.altKey, state.project, state.t, undefined, pxPerSec);
      setDragT(null);
      actions.seek(Math.max(0, newT));
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className="absolute top-0 bottom-0 z-40 flex justify-center cursor-ew-resize w-[9px]"
      style={{ left: `${left}px`, transform: "translateX(-50%)" }}
      onPointerDown={handlePointerDown}
    >
      <div className="absolute top-0 bottom-0 w-[1px] bg-red-500 pointer-events-none" />
      <div className="absolute top-0 w-3 h-3 bg-red-500 clip-playhead pointer-events-none" style={{ clipPath: "polygon(0 0, 100% 0, 50% 100%)" }} />
    </div>
  );
}
