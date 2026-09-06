import { useEffect, useRef, useState } from "react";
import "./cards";
import { TopBar } from "./editor/TopBar";
import { Preview } from "./editor/Preview";
import { LeftPanel } from "./editor/left";
import { RightPanel } from "./editor/right";
import { TimelineView } from "./editor/timeline";
import { actions, getState } from "./store/project";
import { magicuiDemoClips } from "./cards/magicui";
import { nativeDemoClips } from "./cards/native";
/**
 * 编辑器布局:顶栏 / 左栏 · 预览 · 右栏 / 底部时间轴。
 * 首次打开时把 10 张演示卡铺到第一条动效轨上,方便测试。
 * 主题变量只挂在预览舞台上(Preview.tsx),编辑器自身的界面不读 --pc-*。
 */
export default function Editor() {
  const [footerH, setFooterH] = useState(() => {
    try {
      const v = Number(localStorage.getItem("pc.timeline.h"));
      if (v >= 120) return v;
    } catch {}
    return 224;
  });
  const footerRef = useRef(footerH);
  footerRef.current = footerH;

  useEffect(() => {
    const p = getState().project;
    if (p.tracks.every((t) => t.clips.length === 0)) {
      for (const c of [...magicuiDemoClips, ...nativeDemoClips]) {
        actions.addCardClip(c.cardId, c.start, { duration: c.end - c.start, params: c.params });
      }
      actions.select([]);
    }
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.code === "Space") {
        e.preventDefault();
        actions.togglePlay();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        e.shiftKey ? actions.redo() : actions.undo();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        for (const id of getState().selection) actions.removeClip(id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="h-full flex flex-col bg-neutral-950 text-neutral-100">
      <TopBar />
      <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: "300px 1fr 360px" }}>
        <aside className="min-h-0 border-r border-neutral-800 overflow-hidden">
          <LeftPanel />
        </aside>
        <main className="min-h-0 min-w-0 p-2">
          <Preview />
        </main>
        <aside className="min-h-0 border-l border-neutral-800 overflow-hidden">
          <RightPanel />
        </aside>
      </div>
      <div
        className="h-1.5 shrink-0 cursor-row-resize bg-neutral-800 hover:bg-neutral-600"
        title="拖动调整时间轴高度"
        onPointerDown={(e) => {
          const startY = e.clientY;
          const startH = footerH;
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          const onMove = (ev: PointerEvent) => setFooterH(Math.max(120, Math.min(window.innerHeight * 0.7, startH + (startY - ev.clientY))));
          const onUp = () => {
            el.removeEventListener("pointermove", onMove);
            el.removeEventListener("pointerup", onUp);
            try {
              localStorage.setItem("pc.timeline.h", String(footerRef.current));
            } catch {}
          };
          el.addEventListener("pointermove", onMove);
          el.addEventListener("pointerup", onUp);
        }}
      />
      <footer className="border-t border-neutral-800 overflow-hidden shrink-0" style={{ height: footerH }}>
        <TimelineView />
      </footer>
    </div>
  );
}
