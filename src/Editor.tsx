import { useEffect, useMemo, useRef, useState } from "react";
import "./cards";
import { TopBar } from "./editor/TopBar";
import { Preview } from "./editor/Preview";
import { ProbeGate } from "./editor/ProbeGate";
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
import { useSideVisible } from "./editor/dock/railStore";
import { RailBar } from "./editor/dock/RailBar";
import "./editor/shell.css";
import { StatusBar } from "./editor/StatusBar";
import { DependencyPrompt } from "./editor/DependencyPrompt";
import { motion } from "motion/react";
import { MediaMigrationDialog } from "./editor/MediaMigrationDialog";
import { SyncOverlays } from "./editor/sync/SyncOverlays";
import { isJoinPage, startSync } from "./editor/sync/syncManager";

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
  // 两侧整列显不显示(侧边自由布局,editor/dock/):传统式两侧永远都在(拖空的 rail 也留着当落点);
  // 对话式下 rail 只放 AI 类项(剧本 / Agent),哪一侧一个都没有,那一侧整列不显示
  const showLeft = useSideVisible("left", layoutMode);
  const showRight = useSideVisible("right", layoutMode);
  const gridRef = useRef<HTMLDivElement>(null);
  /** 这一行里能分的总宽度(拿不到就退回窗口宽) */
  const room = () => gridRef.current?.clientWidth ?? window.innerWidth;

  const drawerW = usePanelSize("pc.left.drawerW", DEFAULT_DRAWER_W, MIN_DRAWER_W);
  const panelW = usePanelSize("pc.right.panelW", DEFAULT_PANEL_W, MIN_PANEL_W);
  const footer = usePanelSize("pc.timeline.h", DEFAULT_FOOTER_H, MIN_FOOTER_H);

  // 宽度按侧记,不跟着项走:左侧用 drawerW、右侧用 panelW,不管那一侧此刻放的是分区还是 Agent
  const leftCol = RAIL_W + (leftCollapsed ? 0 : drawerW.value);
  const rightCol = RAIL_W + (rightCollapsed ? 0 : panelW.value);

  // 可用宽度变小(窗口拉窄、上次存的宽度放不下)时收缩面板,给预览留住 MIN_PREVIEW_W。
  // 只收左抽屉宽 drawerW 和右面板宽 panelW:rail 宽固定,也不会替用户自动收起面板;
  // 已经收起、或者整列不显示的那一侧不占宽,不计入总宽,也不参与收缩;显示着的几块按比例收。
  // (对话式下左侧通常整列不显示,于是只按需收 panelW,和以前一样)
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const clamp = () => {
      const leftOpen = showLeft && !leftCollapsed;
      const rightOpen = showRight && !rightCollapsed;
      const room = el.clientWidth - MIN_PREVIEW_W - (showLeft ? HANDLE_W + RAIL_W : 0) - (showRight ? HANDLE_W + RAIL_W : 0);
      const total = (leftOpen ? drawerW.value : 0) + (rightOpen ? panelW.value : 0);
      if (room <= 0 || total <= room) return;
      const scale = room / total;
      if (leftOpen) drawerW.set(Math.max(MIN_DRAWER_W, Math.floor(drawerW.value * scale)));
      if (rightOpen) panelW.set(Math.max(MIN_PANEL_W, Math.floor(panelW.value * scale)));
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
  }, [showLeft, showRight, drawerW.value, panelW.value, drawerW.set, panelW.set, leftCollapsed, rightCollapsed]);

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
    // C6.5:页面用 WebSocket 接本机文档服务并挂上 store(src/editor/sync/syncManager.ts);无头实例、只读查看、连不上时不接
    void startSync();
    const p = getState().project;
    // 无头实例(?headless=1,scripts/headless.mjs 开的页面)不塞演示卡:
    // 那会把一份空快照悄悄变成 10 张演示卡,合并回去时全算成 agent 新加的。
    // ?join= 加入已有本机项目的页面也不塞:内容以文档服务为准,塞了就成了往别人的项目里加 10 张卡
    const headless = new URLSearchParams(location.search).has("headless");
    if (!headless && !isJoinPage() && p.tracks.every((t) => t.clips.length === 0)) {
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
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        // 按着 Shift 时 e.key 是大写的 "Z",所以按小写比
        e.preventDefault();
        e.shiftKey ? actions.redo() : actions.undo();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        actions.redo();
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
  // 这里用 `{showLeft && …}` / `{!isChat && …}` 逐个开关:JSX 的兄弟槽位是定长的,false 也占位,
  // 所以右栏在两种模式下始终是同一个槽位,组件实例得以保留。
  // 所有页面(分区、剧本、各 AiPanel)都渲染在 RightPanel 里(dock/DockPages),左栏只是 rail + 宿主,卸载了也不连累页面。
  return (
    <div data-pc="editor" className="h-full min-h-0 flex flex-col" style={{ backgroundColor: "var(--ui-bg)", color: "var(--ui-fg)" }}>
      <MediaMigrationDialog />
      <SyncOverlays />
      <TopBar />
      <DependencyPrompt />
      <div className="flex-1 min-h-0 flex flex-col" style={{ padding: "var(--ui-gap)" }}>
        <div
          ref={gridRef}
          className="flex-1 min-h-0 grid pc-editor-grid"
          style={
            {
              // 列数跟着左侧整列显不显示走(5 列 / 3 列);右侧整列不显示时它那两列宽 0,但槽位还在
              gridTemplateColumns: [
                ...(showLeft ? [`${leftCol}px`, `${HANDLE_W}px`] : []),
                "minmax(0, 1fr)",
                `${showRight ? HANDLE_W : 0}px`,
                `${showRight ? rightCol : 0}px`,
              ].join(" "),
              // 抽屉 / AI 面板卡片按这两个宽度定死(left.css / chat.css):收起展开过渡时列宽在变、卡片宽不变,
              // 被列裁掉一截而不是逐帧挤窄 —— 瀑布流、消息区都不用跟着每帧重排
              "--pc-left-drawer-w": `${drawerW.value}px`,
              "--pc-right-panel-w": `${panelW.value}px`,
            } as React.CSSProperties
          }
        >
          {/* 左栏按「左侧整列显不显示」开关(对话式下左侧有 Agent / 剧本时也会出现);槽位定长,右栏的槽位不受影响。
              左栏卸载时它的宿主会先把页面节点收回停车位,页面本身挂在 RightPanel 里,不跟着卸载 */}
          {showLeft && (
            <motion.aside
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, delay: 0, ease: [0.16, 1, 0.3, 1] }}
              className="min-h-0 overflow-hidden bg-transparent"
            >
              <LeftPanel />
            </motion.aside>
          )}
          {showLeft && (
            <ResizeHandle
              axis="x"
              value={drawerW.value}
              min={MIN_DRAWER_W}
              max={() => room() - RAIL_W - (showRight ? rightCol + HANDLE_W : 0) - MIN_PREVIEW_W - HANDLE_W}
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
            {/*
              K1 的加载遮罩(ProbeGate)。和 <Preview /> 同一层渲,自己 position: fixed 盖住
              整个编辑器界面 —— **不另起 iframe**,两个舞台 iframe 照常由 Preview 挂(E1),
              探针跑在后台那一个上。legacy 下、以及成本记录全命中时它回 null,一帧都不出现。
            */}
            <ProbeGate />
          </motion.main>
          {/*
            右栏拖杆两种布局都要有:对话式下右栏就是 AI 面板,没有拖杆就等于宽度写死。
            可让出的空间 = 总宽 − 右 rail − 预览最小宽 − 这根拖杆,左侧整列显示着的话再扣掉左侧整列(leftCol,已含左 rail)和左边那根拖杆。
            这根拖杆只改 panelW,右 rail 的宽度 RAIL_W 不跟着变。右侧整列不显示时它不可拖。
          */}
          <ResizeHandle
            axis="x"
            value={panelW.value}
            min={MIN_PANEL_W}
            max={() => room() - RAIL_W - (showLeft ? leftCol + HANDLE_W : 0) - MIN_PREVIEW_W - HANDLE_W}
            invert
            onChange={panelW.set}
            onCommit={panelW.commit}
            onReset={panelW.reset}
            title="拖动调整右栏宽度,双击复位"
            disabled={rightCollapsed || !showRight}
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
            className="pc-editor-bottom shrink-0 flex flex-col relative"
            style={{ marginLeft: RAIL_W + (leftCollapsed ? HANDLE_W : 0), marginRight: RAIL_W + (rightCollapsed ? HANDLE_W : 0) }}
          >
            {/*
              两侧 rail 在时间轴旁边的那一截(剪辑组和排在它后面的项):贴在时间轴卡片外侧的 rail 列里,
              顶边 = 卡片顶边(让过上面那根 HANDLE_W 高的拖杆)。水平位置用 right/left: 100% 再让出收起时多出来的那个 HANDLE_W,
              正好落回上面 rail 的那一列
            */}
            <div className="pc-rail-tail-slot is-left" style={{ top: HANDLE_W, right: `calc(100% + ${leftCollapsed ? HANDLE_W : 0}px)`, width: RAIL_W }}>
              <RailBar side="left" part="tail" />
            </div>
            {showRight && (
              <div className="pc-rail-tail-slot is-right" style={{ top: HANDLE_W, left: `calc(100% + ${rightCollapsed ? HANDLE_W : 0}px)`, width: RAIL_W }}>
                <RailBar side="right" part="tail" />
              </div>
            )}
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
