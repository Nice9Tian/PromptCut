import { useEffect } from "react";
import "./cards";
import { TopBar } from "./editor/TopBar";
import { Preview } from "./editor/Preview";
import { LeftPanel } from "./editor/left";
import { RightPanel } from "./editor/right";
import { TimelineView } from "./editor/timeline";
import { actions, getState } from "./store/project";
import { magicuiDemoClips } from "./cards/magicui";
import { nativeDemoClips } from "./cards/native";
import { themeStyle } from "./themes";
import { useStore } from "./store/project";

/**
 * 编辑器布局:顶栏 / 左栏 · 预览 · 右栏 / 底部时间轴。
 * 首次打开时把 10 张演示卡铺到第一条动效轨上,方便测试。
 */
export default function Editor() {
  const themeId = useStore((s) => s.project.themeId);

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
    <div className="h-full flex flex-col bg-neutral-950 text-neutral-100" style={themeStyle(themeId)}>
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
      <footer className="h-56 border-t border-neutral-800 overflow-hidden">
        <TimelineView />
      </footer>
    </div>
  );
}
