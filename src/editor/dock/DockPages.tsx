import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAgentTabs } from "../../ai/agentTabs";
import { useLayoutMode } from "../layoutMode";
import { onCaptionsRequest } from "../left/captionsBus";
import { LibrarySection } from "../left/LibrarySection";
// 必须静态导入:AnimationsSection → cardGroups → CardCell → previewZoom → prewarmBoxes,window.__pcPreviewBoxes 靠这条链挂上
import { AnimationsSection } from "../left/AnimationsSection";
import { EffectsSection } from "../left/EffectsSection";
import { EditSection } from "../left/EditSection";
import { CaptionsSection } from "../left/CaptionsSection";
import { AiPanel } from "../right/AiPanel";
import { ScriptPage } from "../right/chat/ScriptPage";
import { AgentAttentionTracker } from "./agentAttention";
import { DockPageContext } from "./dockSide";
import { pageNode, placePages, registerDockPark, releasePageNodes } from "./pageNodes";
import { SECTION_IDS, agentItem, effectiveActive, sideOf, type ItemId, type SectionId } from "./railLayout";
import { activateRailItem, useRailLayout } from "./railStore";
import "../left/left.css";
import "./dock.css";

// 页面内容只在自己的 props 变了才重渲:rail 上点一下只改选中项,不该把所有分区和所有 AiPanel 都重渲一遍
const LibraryPage = memo(LibrarySection);
const AnimationsPage = memo(AnimationsSection);
const EffectsPage = memo(EffectsSection);
const EditPage = memo(EditSection);
const CaptionsPage = memo(CaptionsSection);
const ScriptPageMemo = memo(ScriptPage);
const AgentPage = memo(AiPanel);

const goImport = () => activateRailItem("library", { expand: true });

/**
 * 所有页面(五个分区、剧本页、每个 Agent 分页的 AiPanel)统一在这里各渲染一次,createPortal 进各自固定的节点(pageNodes)。
 * 这个组件挂在 RightPanel 里 —— RightPanel 在 Editor 网格里永远占同一个兄弟槽位、从不卸载,
 * 所以这里的 React 树从不因为拖动、切换、收起、换布局模式而改变:portal 的 key 是项 id,容器节点按 id 固定。
 * 两侧宿主(DockHost)只挪 DOM 节点,正在跑的 AI 对话、分区的滚动位置 / 搜索词 / 草稿都不受影响。
 *
 * 挂载时机:剧本页和 AiPanel 一开始就挂(对话要在后台照跑);分区在传统式布局下一开始就挂(和改版前左栏五个分区常驻一致),
 * 对话式布局下一个都不挂(rail 只放剧本 / Agent,分区不会显示,照旧不去跑素材库、卡片预览那一套),
 * 切回传统式才挂,挂上之后再也不卸载。
 */
export function DockPages({ mcpConnected }: { mcpConnected: boolean }) {
  const layout = useRailLayout();
  const mode = useLayoutMode();
  const { tabs } = useAgentTabs();

  // 字幕分区聚焦哪份素材:时间轴 / 素材库右键「转写字幕」经 captionsBus 设进来
  const [captionMediaId, setCaptionMediaId] = useState<string | null>(null);
  const [revealToken, setRevealToken] = useState(0);
  useEffect(
    () =>
      onCaptionsRequest((id) => {
        activateRailItem("captions", { expand: true });
        setCaptionMediaId(id);
        setRevealToken((n) => n + 1);
      }),
    [],
  );

  const [mountedSections, setMountedSections] = useState<ReadonlySet<SectionId>>(() => new Set());
  // 不能按「这一侧显示着」判断:对话式下某一侧只要有 AI 项就算显示,隐藏的分区会在后台被提前挂上
  const due: SectionId[] = mode === "chat" ? [] : SECTION_IDS.filter((id) => !!sideOf(layout, id));
  let sections = mountedSections;
  if (due.some((id) => !mountedSections.has(id))) {
    sections = new Set([...mountedSections, ...due]);
    // 渲染期间补登记(React 允许组件在渲染里更新自己的 state),这一轮就按新集合画
    setMountedSections(sections);
  }

  const parkRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = parkRef.current;
    return el ? registerDockPark(el) : undefined;
  }, []);

  // 编辑台整个卸载(回首页)时把节点表清空:模块级的节点表还拿着旧页面子树,不清就一直占着。
  // 只在卸载时跑 —— 不能并进下面那个每次提交都跑的 effect,那样每次渲染都会删光节点、所有页面重挂载。
  // (main.tsx 不包 StrictMode,不会有「挂上立刻假卸载」把节点删掉的情况)
  useLayoutEffect(() => () => releasePageNodes(new Set()), []);

  const keep = new Set<ItemId>([...sections, "script", ...tabs.map((t) => agentItem(t.id))]);
  useLayoutEffect(() => {
    // 关掉的 Agent:portal 已在这次提交里卸载,节点一起扔掉;新挂上的页交给 placePages 摆到宿主里
    releasePageNodes(keep);
    placePages();
  });

  const shown = (id: ItemId) => {
    const side = sideOf(layout, id);
    return !!side && effectiveActive(layout, side, mode) === id;
  };
  const portal = (id: ItemId, content: ReactNode) =>
    createPortal(<DockPageContext.Provider value={id}>{content}</DockPageContext.Provider>, pageNode(id), id);
  const section = (id: SectionId, content: ReactNode) => (sections.has(id) ? portal(id, content) : null);

  return (
    <>
      {/* 停车位:宿主没挂载的一侧(对话式下整列不显示)的页面节点停在这里,不脱离文档 */}
      <div ref={parkRef} className="pc-dock-park" data-pc-dock-park="" aria-hidden="true" style={{ display: "none" }} />
      {/* rail 上 Agent 项的「跑完 / 中断,等你查看」标记 */}
      <AgentAttentionTracker />
      {section("library", <LibraryPage />)}
      {section("animations", <AnimationsPage />)}
      {section("effects", <EffectsPage />)}
      {section("edit", <EditPage />)}
      {section(
        "captions",
        <CaptionsPage mediaId={captionMediaId} onPick={setCaptionMediaId} revealToken={revealToken} onGoImport={goImport} />,
      )}
      {portal("script", <ScriptPageMemo active={shown("script")} />)}
      {/* 多 Agent 分页:每页一个 AiPanel 实例都挂着(对话在后台照跑),只显示各侧选中的那一页 */}
      {tabs.map((t) => portal(agentItem(t.id), <AgentPage tabId={t.id} active={shown(agentItem(t.id))} mcpConnected={mcpConnected} />))}
    </>
  );
}
