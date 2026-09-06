import "./debug";
import "./left.css";
import { useState } from "react";
import { LibraryTab } from "./LibraryTab";
import { Inspector } from "./Inspector";

export function LeftPanel() {
  const [ratio, setRatio] = useState(() => {
    try {
      const stored = localStorage.getItem("pc.left.split");
      if (stored !== null) {
        return Math.max(0.2, Math.min(0.85, parseFloat(stored)));
      }
    } catch {}
    return 0.55;
  });

  const handlePointerDown = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLDivElement;
    el.setPointerCapture(e.pointerId);
    
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const parent = el.parentElement;
    if (!parent) return;
    
    let currentRatio = ratio;
    
    const onMove = (moveEvent: PointerEvent) => {
      const rect = parent.getBoundingClientRect();
      const y = moveEvent.clientY - rect.top;
      let newRatio = y / rect.height;
      newRatio = Math.max(0.2, Math.min(0.85, newRatio));
      currentRatio = newRatio;
      setRatio(newRatio);
    };
    
    const onUp = (upEvent: PointerEvent) => {
      el.releasePointerCapture(upEvent.pointerId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      localStorage.setItem("pc.left.split", currentRatio.toString());
    };
    
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };

  return (
    <div data-pc="left" className="h-full flex flex-col min-h-0 overflow-hidden bg-neutral-950 text-neutral-100">
      <div data-pc="library" className="flex flex-col min-h-0 overflow-hidden" style={{ flex: `${ratio} 1 0%` }}>
        <div className="h-8 flex items-center gap-1 px-2 border-b border-neutral-800 text-xs shrink-0">
          <div className="flex h-full items-center text-neutral-100 border-b-2 border-b-neutral-100 px-1">素材</div>
        </div>
        <LibraryTab />
      </div>
      
      <div 
        data-pc="split"
        className="h-1.5 cursor-row-resize bg-neutral-800 hover:bg-neutral-600 shrink-0" 
        title="拖动调整上下比例"
        onPointerDown={handlePointerDown}
      />
      
      <div data-pc="inspector" className="flex flex-col min-h-0 overflow-hidden" style={{ flex: `${1 - ratio} 1 0%` }}>
        <div className="h-8 flex items-center gap-1 px-2 border-b border-neutral-800 text-xs shrink-0">
          <div className="flex h-full items-center text-neutral-100 border-b-2 border-b-neutral-100 px-1">编辑</div>
        </div>
        <Inspector />
      </div>
    </div>
  );
}
