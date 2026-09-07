import { useEffect, useMemo, useRef, useState } from "react";
import "./cards";
import { TopBar } from "./editor/TopBar";
import { Preview } from "./editor/Preview";
import { LeftPanel } from "./editor/left";
import { RightPanel } from "./editor/right";
import { TimelineView } from "./editor/timeline";
import { ResizeHandle } from "./editor/ResizeHandle";
import { actions, getState } from "./store/project";
import { magicuiDemoClips } from "./cards/magicui";
import { nativeDemoClips } from "./cards/native";
import { useSkin } from "./skins/useSkin";
import { useLayoutMode } from "./editor/layoutMode";
import "./editor/shell.css";
import { StatusBar } from "./editor/StatusBar";
import { DependencyPrompt } from "./editor/DependencyPrompt";
import { motion } from "motion/react";

/** 拖杆宽度(px),和 ResizeHandle 里的 w-1.5 / h-1.5 对应 */
const HANDLE_W = 6;
const DEFAULT_LEFT_W = 300;
const DEFAULT_RIGHT_W = 360;
const DEFAULT_FOOTER_H = 224;
const MIN_LEFT_W = 200;
const MIN_RIGHT_W = 240;
const MIN_PREVIEW_W = 320;
const MIN_FOOTER_H = 120;

/**
 * 面板尺寸:拖动时改 state,松手才写 localStorage(拖一次不写几百条)。
 */
function usePanelSize(key: string, initial: number, min: number) {
  const [value, setValue] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key));
      if (Number.isFinite(v) && v >= min) return v;
    } catch {}
    return initial;
  });
  const latest = useRef(value);
  latest.current = value;
  const api = useMemo(
    () => ({
      set: setValue,
      commit() {
        try {
          localStorage.setItem(key, String(Math.round(latest.current)));
        } catch {}
      },
      reset() {
        setValue(initial);
        try {
          localStorage.setItem(key, String(initial));
        } catch {}
      },
    }),
    [key, initial],
  );
  return { value, ...api };
}

/**
 * 编辑器布局:支持「传统式」(左栏/预览/右栏/底部时间轴)与「对话式」(预览+AI助手栏)两种模式。
 * 左右栏和时间轴都能拖着改大小(双击复位)。
 * 首次打开时把 10 张演示卡铺到第一条动效轨上,方便测试。
 * 主题变量只挂在预览舞台上(Preview.tsx),编辑器自身的界面不读 --pc-*。
 */
export default function Editor() {
  useSkin(); // mount data-skin
  const layoutMode = useLayoutMode();
  const gridRef = useRef<HTMLDivElement>(null);
  /** 这一行里能分的总宽度(拿不到就退回窗口宽) */
  const room = () => gridRef.current?.clientWidth ?? window.innerWidth;

  const left = usePanelSize("pc.left.w", DEFAULT_LEFT_W, MIN_LEFT_W);
  const right = usePanelSize("pc.right.w", DEFAULT_RIGHT_W, MIN_RIGHT_W);
  const footer = usePanelSize("pc.timeline.h", DEFAULT_FOOTER_H, MIN_FOOTER_H);

  // 可用宽度变小(窗口拉窄、上次存的宽度放不下)时收缩面板,给预览留住 MIN_PREVIEW_W。
  // chat 模式下没有左栏,只在必要时收缩 right 且绝不动 left;classic 模式按比例收两侧。
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const clamp = () => {
      if (layoutMode === "chat") {
        const maxRight = el.clientWidth - MIN_PREVIEW_W - HANDLE_W;
        if (maxRight > 0 && right.value > maxRight) {
          right.set(Math.max(MIN_RIGHT_W, maxRight));
        }
        return;
      }
      const room = el.clientWidth - MIN_PREVIEW_W - HANDLE_W * 2;
      const total = left.value + right.value;
      if (room <= 0 || total <= room) return;
      const scale = room / total;
      left.set(Math.max(MIN_LEFT_W, Math.floor(left.value * scale)));
      right.set(Math.max(MIN_RIGHT_W, Math.floor(right.value * scale)));
    };
    clamp();
    const ro = new ResizeObserver(clamp);
    ro.observe(el);
    // 两条路都留着:窗口缩放走 resize 事件,布局本身变宽变窄走 ResizeObserver
    window.addEventListener("resize", clamp);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", clamp);
    };
  }, [layoutMode, left.value, right.value, left.set, right.set]);

  useEffect(() => {
    const p = getState().project;
    // 无头实例(?headless=1,scripts/headless.mjs 开的页面)不塞演示卡:
    // 那会把一份空快照悄悄变成 10 张演示卡,合并回去时全算成 agent 新加的
    const headless = new URLSearchParams(location.search).has("headless");
    if (!headless && p.tracks.every((t) => t.clips.length === 0)) {
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

  const isChat = layoutMode === "chat";

  // 两种布局共用同一棵元素树,只把左栏、两个横向把手和时间轴按模式开关。
  // 不能写成 `isChat ? <整棵 A> : <整棵 B>`:那样 React 认为右栏换了位置,
  // 会把 RightPanel 连同里面的 AiPanel 卸载重建——正在跑的对话会当场断掉
  // (运行中的回复丢失、runId 丢了连「停止」都点不了)。
  // 这里用 `{!isChat && …}` 逐个开关:JSX 的兄弟槽位是定长的,false 也占位,
  // 所以右栏在两种模式下始终是同一个槽位,组件实例得以保留。
  return (
    <div data-pc="editor" className="h-full flex flex-col bg-neutral-950 text-neutral-100">
      <TopBar />
      <DependencyPrompt />
      <div
        ref={gridRef}
        className="flex-1 min-h-0 grid"
        style={{
          gridTemplateColumns: isChat
            ? `minmax(0, 1fr) ${HANDLE_W}px ${right.value}px`
            : `${left.value}px ${HANDLE_W}px minmax(0, 1fr) ${HANDLE_W}px ${right.value}px`,
        }}
      >
        {!isChat && (
          <motion.aside
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, delay: 0, ease: [0.16, 1, 0.3, 1] }}
            className="min-h-0 border-r border-neutral-800 overflow-hidden"
          >
            <LeftPanel />
          </motion.aside>
        )}
        {!isChat && (
          <ResizeHandle
            axis="x"
            value={left.value}
            min={MIN_LEFT_W}
            max={() => room() - right.value - MIN_PREVIEW_W - HANDLE_W * 2}
            onChange={left.set}
            onCommit={left.commit}
            onReset={left.reset}
            title="拖动调整左栏宽度,双击复位"
          />
        )}
        <motion.main
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, delay: 0.04, ease: [0.16, 1, 0.3, 1] }}
          className="min-h-0 min-w-0 p-2"
        >
          <Preview />
        </motion.main>
        {/*
          右栏拖杆两种布局都要有:对话式下右栏就是 AI 面板,没有拖杆就等于宽度写死。
          可让出的空间两种模式不一样——传统式要扣掉左栏和两根拖杆,对话式只有这一根。
        */}
        <ResizeHandle
          axis="x"
          value={right.value}
          min={MIN_RIGHT_W}
          max={() =>
            isChat
              ? room() - MIN_PREVIEW_W - HANDLE_W
              : room() - left.value - MIN_PREVIEW_W - HANDLE_W * 2
          }
          invert
          onChange={right.set}
          onCommit={right.commit}
          onReset={right.reset}
          title="拖动调整右栏宽度,双击复位"
        />
        <motion.aside
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
          className="min-h-0 border-l border-neutral-800 overflow-hidden"
        >
          <RightPanel />
        </motion.aside>
      </div>
      {!isChat && (
        <ResizeHandle
          axis="y"
          value={footer.value}
          min={MIN_FOOTER_H}
          max={() => window.innerHeight * 0.7}
          invert
          onChange={footer.set}
          onCommit={footer.commit}
          onReset={footer.reset}
          title="拖动调整时间轴高度,双击复位"
        />
      )}
      {!isChat && (
        <motion.footer
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, delay: 0.12, ease: [0.16, 1, 0.3, 1] }}
          className="border-t border-neutral-800 overflow-hidden shrink-0 flex flex-col" style={{ height: footer.value }}
        >
          <TimelineView />
        </motion.footer>
      )}
      <StatusBar />
    </div>
  );
}
