import { createContext, useContext, useState, useRef, useEffect, type ReactNode } from "react";
import type React from "react";
import { useStore } from "../../store/project";
import { useDragPayload } from "../dnd";
import { HEADER_W, timeOfX, xOfTime } from "./utils";
import type { DropPlan } from "./dropPlan";
import type { ReorderState } from "./useReorder";

interface TimelineContextState {
  pxPerSec: number;
  setPxPerSec: (val: number) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  trackAreaRef: React.RefObject<HTMLDivElement | null>;
  draggingClipId: string | null;
  setDraggingClipId: (id: string | null) => void;
  draggingTrackId: string | null;
  setDraggingTrackId: (id: string | null) => void;
  /** 左栏拖进来时的落点预演(没在拖 = null);轨道行和新建轨落区共用同一份 */
  dropPlan: DropPlan | null;
  setDropPlan: React.Dispatch<React.SetStateAction<DropPlan | null>>;
  /** 正在拖行头换序(没在换 = null);行头和轨道行按它一起平移 */
  reorder: ReorderState | null;
  setReorder: React.Dispatch<React.SetStateAction<ReorderState | null>>;
}

const TimelineContext = createContext<TimelineContextState | null>(null);

export function TimelineProvider({ children }: { children: ReactNode }) {
  const [pxPerSec, setPxPerSec] = useState(100);
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackAreaRef = useRef<HTMLDivElement>(null);
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);
  const [dropPlan, setDropPlan] = useState<DropPlan | null>(null);
  const [reorder, setReorder] = useState<ReorderState | null>(null);

  // 拖动一结束(松手、按 Esc、拖出窗口)就把落点预演清掉,免得预览留在屏幕上
  const dragPayload = useDragPayload();
  useEffect(() => {
    if (!dragPayload) setDropPlan(null);
  }, [dragPayload]);

  // 拖着卡片 / 素材贴近左右边缘时自动横向滚动(HTML5 拖放自己不会滚,不然只能落在当前视野里)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !dragPayload) return;
    const EDGE = 60; // 触发自动滚动的边缘宽度(px)
    const MAX = 18; // 每帧最多滚多少 px
    let vx = 0;
    let raf = 0;
    const step = () => {
      if (vx) el.scrollLeft += vx;
      raf = requestAnimationFrame(step);
    };
    const onOver = (e: DragEvent) => {
      const r = el.getBoundingClientRect();
      const inner = r.left + HEADER_W; // 行头列不算轨道区
      if (e.clientX < inner + EDGE) {
        vx = -Math.min(MAX, Math.ceil(((inner + EDGE - e.clientX) / EDGE) * MAX));
      } else if (e.clientX > r.right - EDGE) {
        vx = Math.min(MAX, Math.ceil(((e.clientX - (r.right - EDGE)) / EDGE) * MAX));
      } else {
        vx = 0;
      }
    };
    el.addEventListener("dragover", onOver);
    raf = requestAnimationFrame(step);
    return () => {
      el.removeEventListener("dragover", onOver);
      cancelAnimationFrame(raf);
    };
  }, [dragPayload]);

  // Zooming
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const pointerX = e.clientX - rect.left + el.scrollLeft - 200; // 200 is header width
        if (pointerX < 0) return;
        
        const timeAtPointer = timeOfX(pointerX, pxPerSec);
        const delta = e.deltaY < 0 ? 1.2 : 0.8;
        const newPxPerSec = Math.max(10, Math.min(1000, pxPerSec * delta));
        
        setPxPerSec(newPxPerSec);
        
        const newScrollLeft = xOfTime(timeAtPointer, newPxPerSec) - (e.clientX - rect.left - 200);
        setTimeout(() => {
           if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, newScrollLeft);
        }, 0);
      }
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [pxPerSec]);
  
  // Middle mouse pan
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let isPanning = false;
    let startX = 0;
    let startScrollLeft = 0;

    const handlePointerDown = (e: PointerEvent) => {
      if (e.button === 1) { // Middle click
        if ((e.target as HTMLElement).closest("[data-clip-id]")) return;
        isPanning = true;
        startX = e.clientX;
        startScrollLeft = el.scrollLeft;
        el.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    };
    const handlePointerMove = (e: PointerEvent) => {
      if (isPanning) {
        el.scrollLeft = startScrollLeft - (e.clientX - startX);
      }
    };
    const handlePointerUp = (e: PointerEvent) => {
      if (isPanning) {
        isPanning = false;
        el.releasePointerCapture(e.pointerId);
      }
    };

    el.addEventListener("pointerdown", handlePointerDown);
    el.addEventListener("pointermove", handlePointerMove);
    el.addEventListener("pointerup", handlePointerUp);
    return () => {
      el.removeEventListener("pointerdown", handlePointerDown);
      el.removeEventListener("pointermove", handlePointerMove);
      el.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  // Auto scroll for playhead
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  useEffect(() => {
    if (playing && scrollRef.current) {
       const pos = xOfTime(t, pxPerSec);
       const el = scrollRef.current;
       if (pos > el.scrollLeft + el.clientWidth - 200 - 50) {
           el.scrollLeft = pos - el.clientWidth + 200 + 50;
       }
    }
  }, [t, playing, pxPerSec]);

  return (
    <TimelineContext.Provider value={{ pxPerSec, setPxPerSec, scrollRef, trackAreaRef, draggingClipId, setDraggingClipId, draggingTrackId, setDraggingTrackId, dropPlan, setDropPlan, reorder, setReorder }}>
      {children}
    </TimelineContext.Provider>
  );
}

export function useTimelineContext() {
  return useContext(TimelineContext)!;
}
