/**
 * 自定义横向滚动条:接管时间轴底部的横向滚动，隐藏原生横条而保留竖条(通过 timeline.css 的 .pc-tl-scroll 规则)。
 * - 条身代表整个总时长 (duration)。
 * - 滑块代表当前可视时间区间。
 * - 拖动滑块中间 = 平移(只改 scrollLeft)。
 * - 拖动滑块两端把手 = 缩放(改 pxPerSec)，双击滑块或条身复位。
 */
import { useEffect, useState, useRef } from "react";
import { useStore } from "../../store/project";
import { useTimelineContext } from "./TimelineContext";
import { timeOfX, xOfTime } from "./utils";

export function Scrollbar() {
  const { scrollRef, headerW, pxPerSec, setPxPerSec } = useTimelineContext();
  const duration = useStore((s) => s.project.duration);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewW, setViewW] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      setScrollLeft(el.scrollLeft);
      setViewW(el.clientWidth - headerW);
    };
    update();
    el.addEventListener("scroll", update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [scrollRef, headerW]);

  const visStart = Math.max(0, timeOfX(scrollLeft, pxPerSec));
  const visEnd = timeOfX(scrollLeft + viewW, pxPerSec);
  
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const leftPct = duration > 0 ? clamp(visStart / duration) : 0;
  const widthPct = duration > 0 ? clamp((visEnd - visStart) / duration) : 1;
  const minWidthPx = 24;

  const trackRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ pxPerSec, viewW });
  stateRef.current = { pxPerSec, viewW };

  const handleDrag = (e: React.PointerEvent, mode: "pan" | "left" | "right") => {
    e.preventDefault();
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const trackW = trackRef.current!.getBoundingClientRect().width;
    const initialVisStart = visStart;
    const initialVisEnd = visEnd;
    const initialSpan = visEnd - visStart;

    try { el.setPointerCapture(e.pointerId); } catch {}

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dTime = (dx / trackW) * duration;
      const currentPxPerSec = stateRef.current.pxPerSec;
      const currentViewW = stateRef.current.viewW;
      const scroller = scrollRef.current;
      if (!scroller) return;

      if (mode === "pan") {
        const newScrollLeft = xOfTime(initialVisStart + dTime, currentPxPerSec);
        scroller.scrollLeft = Math.max(0, Math.min(newScrollLeft, scroller.scrollWidth - scroller.clientWidth));
      } else if (mode === "right") {
        const newSpan = Math.max(0.1, initialSpan + dTime);
        const newPxPerSec = Math.max(10, Math.min(1000, currentViewW / newSpan));
        setPxPerSec(newPxPerSec);
        const target = xOfTime(initialVisStart, newPxPerSec);
        window.setTimeout(() => {
          if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, target);
        }, 0);
      } else if (mode === "left") {
        const newSpan = Math.max(0.1, initialSpan - dTime);
        const newPxPerSec = Math.max(10, Math.min(1000, currentViewW / newSpan));
        setPxPerSec(newPxPerSec);
        const target = xOfTime(initialVisEnd - newSpan, newPxPerSec);
        window.setTimeout(() => {
          if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, target);
        }, 0);
      }
    };

    const onUp = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      try { el.releasePointerCapture(ev.pointerId); } catch {}
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const handleDoubleClick = () => {
    setPxPerSec(100);
    window.setTimeout(() => {
      if (scrollRef.current) scrollRef.current.scrollLeft = 0;
    }, 0);
  };

  return (
    <div className="shrink-0 h-[12px] bg-neutral-950 flex" style={{ paddingLeft: headerW }}>
      <div 
        ref={trackRef} 
        className="flex-1 relative mx-1 my-0.5 bg-neutral-900 rounded-full cursor-pointer"
        onDoubleClick={handleDoubleClick}
      >
        <div
          className="absolute top-0 bottom-0 bg-neutral-700 hover:bg-neutral-600 rounded-full flex items-center justify-between"
          style={{
            left: `${leftPct * 100}%`,
            width: `max(${minWidthPx}px, ${widthPct * 100}%)`,
          }}
          onPointerDown={(e) => handleDrag(e, "pan")}
          onDoubleClick={(e) => { e.stopPropagation(); handleDoubleClick(); }}
        >
          {/* 左把手 */}
          <div
            className="w-2.5 h-full cursor-ew-resize shrink-0 rounded-l-full hover:bg-neutral-500 transition-colors"
            onPointerDown={(e) => {
              e.stopPropagation();
              handleDrag(e, "left");
            }}
          />
          {/* 中间空白区域用于拖拽 */}
          <div className="flex-1 h-full cursor-grab active:cursor-grabbing" />
          {/* 右把手 */}
          <div
            className="w-2.5 h-full cursor-ew-resize shrink-0 rounded-r-full hover:bg-neutral-500 transition-colors"
            onPointerDown={(e) => {
              e.stopPropagation();
              handleDrag(e, "right");
            }}
          />
        </div>
      </div>
    </div>
  );
}
