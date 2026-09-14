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
import { useRailCollapsed, isRailCollapsed, subscribeRails, RAIL_W } from "./editor/sideRails";
import "./editor/shell.css";
import { StatusBar } from "./editor/StatusBar";
import { DependencyPrompt } from "./editor/DependencyPrompt";
import { motion } from "motion/react";
import { MediaMigrationDialog } from "./editor/MediaMigrationDialog";

/** 拖杆宽度(px),和 ResizeHandle 里的 w-2 对应 */
const HANDLE_W = 8;
const DEFAULT_DRAWER_W = 240;
const DEFAULT_PANEL_W = 360;
const DEFAULT_FOOTER_H = 272;
const MIN_DRAWER_W = 200;
const MIN_PANEL_W = 280;
const MIN_PREVIEW_W = 320;
const MIN_FOOTER_H = 120;
/** 收起 / 展开两侧面板时列宽过渡的时长,和 shell.css 里 .pc-editor-grid[data-pc-rail-anim] 一致 */
const RAIL_ANIM_MS = 220;

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
  const leftCollapsed = useRailCollapsed("left");
  const rightCollapsed = useRailCollapsed("right");
  const gridRef = useRef<HTMLDivElement>(null);
  /** 这一行里能分的总宽度(拿不到就退回窗口宽) */
  const room = () => gridRef.current?.clientWidth ?? window.innerWidth;

  const drawerW = usePanelSize("pc.left.drawerW", DEFAULT_DRAWER_W, MIN_DRAWER_W);
  const panelW = usePanelSize("pc.right.panelW", DEFAULT_PANEL_W, MIN_PANEL_W);
  const footer = usePanelSize("pc.timeline.h", DEFAULT_FOOTER_H, MIN_FOOTER_H);

  const leftCol = RAIL_W + (leftCollapsed ? 0 : drawerW.value);
  const rightCol = RAIL_W + (rightCollapsed ? 0 : panelW.value);

  // 可用宽度变小(窗口拉窄、上次存的宽度放不下)时收缩面板,给预览留住 MIN_PREVIEW_W。
  // 只收左抽屉宽 drawerW 和 AI 面板宽 panelW:rail 宽固定,也不会替用户自动收起面板;
  // 已经收起的那一侧不占抽屉 / 面板宽,不计入总宽,也不参与收缩。
  // chat 模式下没有左栏,右侧展开时才按需收 panelW,绝不动 drawerW;classic 模式按比例收两侧展开着的那几块。
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const clamp = () => {
      if (layoutMode === "chat") {
        if (rightCollapsed) return;
        const maxPanel = el.clientWidth - MIN_PREVIEW_W - HANDLE_W - RAIL_W;
        if (maxPanel > 0 && panelW.value > maxPanel) {
          panelW.set(Math.max(MIN_PANEL_W, maxPanel));
        }
        return;
      }
      const room = el.clientWidth - MIN_PREVIEW_W - HANDLE_W * 2 - RAIL_W * 2;
      const total = (leftCollapsed ? 0 : drawerW.value) + (rightCollapsed ? 0 : panelW.value);
      if (room <= 0 || total <= room) return;
      const scale = room / total;
      if (!leftCollapsed) drawerW.set(Math.max(MIN_DRAWER_W, Math.floor(drawerW.value * scale)));
      if (!rightCollapsed) panelW.set(Math.max(MIN_PANEL_W, Math.floor(panelW.value * scale)));
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
  }, [layoutMode, drawerW.value, panelW.value, drawerW.set, panelW.set, leftCollapsed, rightCollapsed]);

  // 收起 / 展开两侧面板时,给网格挂 data-pc-rail-anim 一小会儿:列宽、抽屉 / 面板卡片走过渡(shell.css、left.css、chat.css)。
  // 必须在 sideRails 发通知的当下同步挂上,不能等 Editor 自己的 effect:同一次提交里别的布局效应会先读布局
  // (比如消息区贴底要读 scrollHeight),新列宽早被算过一遍,过渡就起不来了。
  // 直接写 DOM 属性,不为了一个动画开关把整个编辑器重渲两遍。
  useEffect(() => {
    let last = `${isRailCollapsed("left")}|${isRailCollapsed("right")}`;
    let timer = 0;
    const off = subscribeRails(() => {
      const now = `${isRailCollapsed("left")}|${isRailCollapsed("right")}`;
      const el = gridRef.current;
      if (now === last || !el) return;
      last = now;
      el.dataset.pcRailAnim = "";
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        delete el.dataset.pcRailAnim;
      }, RAIL_ANIM_MS + 100);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, []);

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
    <div data-pc="editor" className="h-full min-h-0 flex flex-col" style={{ backgroundColor: "var(--ui-bg)", color: "var(--ui-fg)" }}>
      <MediaMigrationDialog />
      <TopBar />
      <DependencyPrompt />
      <div className="flex-1 min-h-0 flex flex-col" style={{ padding: "var(--ui-gap)" }}>
        <div
          ref={gridRef}
          className="flex-1 min-h-0 grid pc-editor-grid"
          style={
            {
              gridTemplateColumns: isChat
                ? `minmax(0, 1fr) ${HANDLE_W}px ${rightCol}px`
                : `${leftCol}px ${HANDLE_W}px minmax(0, 1fr) ${HANDLE_W}px ${rightCol}px`,
              // 抽屉 / AI 面板卡片按这两个宽度定死(left.css / chat.css):收起展开过渡时列宽在变、卡片宽不变,
              // 被列裁掉一截而不是逐帧挤窄 —— 瀑布流、消息区都不用跟着每帧重排
              "--pc-left-drawer-w": `${drawerW.value}px`,
              "--pc-right-panel-w": `${panelW.value}px`,
            } as React.CSSProperties
          }
        >
          {!isChat && (
            <motion.aside
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, delay: 0, ease: [0.16, 1, 0.3, 1] }}
              className="min-h-0 overflow-hidden bg-transparent"
            >
              <LeftPanel />
            </motion.aside>
          )}
          {!isChat && (
            <ResizeHandle
              axis="x"
              value={drawerW.value}
              min={MIN_DRAWER_W}
              max={() => room() - RAIL_W - rightCol - MIN_PREVIEW_W - HANDLE_W * 2}
              onChange={drawerW.set}
              onCommit={drawerW.commit}
              onReset={drawerW.reset}
              title="拖动调整左栏宽度,双击复位"
              disabled={leftCollapsed}
            />
          )}
          <motion.main
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, delay: 0.04, ease: [0.16, 1, 0.3, 1] }}
            className="min-h-0 min-w-0 pc-card-surface flex flex-col"
          >
            <Preview />
          </motion.main>
          {/*
            右栏拖杆两种布局都要有:对话式下右栏就是 AI 面板,没有拖杆就等于宽度写死。
            可让出的空间两种模式不一样——传统式要扣掉左侧整列(leftCol,已含左 rail)和两根拖杆,对话式只有这一根。
            这根拖杆只改 panelW,右 rail 的宽度 RAIL_W 不跟着变,所以两种模式都还要再扣一个 RAIL_W。
          */}
          <ResizeHandle
            axis="x"
            value={panelW.value}
            min={MIN_PANEL_W}
            max={() =>
              isChat
                ? room() - RAIL_W - MIN_PREVIEW_W - HANDLE_W
                : room() - RAIL_W - leftCol - MIN_PREVIEW_W - HANDLE_W * 2
            }
            invert
            onChange={panelW.set}
            onCommit={panelW.commit}
            onReset={panelW.reset}
            title="拖动调整右栏宽度,双击复位"
            disabled={rightCollapsed}
          />
          <motion.aside
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
            className="min-h-0 overflow-hidden bg-transparent"
          >
            <RightPanel />
          </motion.aside>
        </div>
        {!isChat && (
          /*
           * 时间轴卡片左右避开两侧 rail:左边对齐素材库抽屉卡、右边对齐 AI 面板卡,rail 那一列一直通到底。
           * 某一侧收起时抽屉 / 面板没了,上方卡片边缘就是 rail 后面那条 8px 缝的另一侧,再让出一个 HANDLE_W 才对得齐预览卡。
           * 拖杆和卡片一起包进来,纵向拖杆的 hover 线也跟着缩进。
           */
          <div
            className="pc-editor-bottom shrink-0 flex flex-col"
            style={{ marginLeft: RAIL_W + (leftCollapsed ? HANDLE_W : 0), marginRight: RAIL_W + (rightCollapsed ? HANDLE_W : 0) }}
          >
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
            <motion.footer
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, delay: 0.12, ease: [0.16, 1, 0.3, 1] }}
              className="pc-card-surface shrink-0 flex flex-col" style={{ height: footer.value }}
            >
              <TimelineView />
            </motion.footer>
          </div>
        )}
      </div>
      <StatusBar />
    </div>
  );
}
