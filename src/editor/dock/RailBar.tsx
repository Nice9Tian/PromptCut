import type { ComponentType, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { closeTab, useAgentTabs } from "../../ai/agentTabs";
import { MAIN_TAB } from "../../ai/liveChat";
import { useScript } from "../../ai/script";
import { IconBubblePlus } from "../../ui/icons";
import { useLayoutMode } from "../layoutMode";
import { RailIconAnimations, RailIconCaptions, RailIconEdit, RailIconEffects, RailIconLibrary } from "../left/railIcons";
import { IconScript, glyphOf, shortLabel, tabTooltip } from "../right/chat/RightRail";
import { useRailCollapsed } from "../sideRails";
import { useAgentAttentionMap } from "./agentAttention";
import { beginRailPointer } from "./railDrag";
import { agentIdOf, effectiveActive, isSectionItem, plusAnchor, visibleItems, type ItemId, type SectionId, type Side } from "./railLayout";
import { addAgentOnSide, clickRailItem, useRailLayout } from "./railStore";
import "../right/chat/chat.css";
import "./dock.css";

/** Agent 项悬停说明末尾补一行状态 */
const AGENT_STATE_TIP: Record<"busy" | "done" | "interrupted" | "idle", string> = {
  busy: "正在运行",
  done: "已完成,等你查看",
  interrupted: "已中断,等你查看",
  idle: "",
};

const SECTION_META: Record<SectionId, { label: string; Icon: ComponentType }> = {
  library: { label: "素材库", Icon: RailIconLibrary },
  animations: { label: "动画", Icon: RailIconAnimations },
  effects: { label: "特效", Icon: RailIconEffects },
  edit: { label: "编辑", Icon: RailIconEdit },
  captions: { label: "字幕", Icon: RailIconCaptions },
};

/**
 * 一条竖向 rail(左右共用)。项的顺序、在哪一侧、选中哪一项都来自 railStore;对话式布局下只画 AI 类项(剧本 / Agent)。
 *
 *   点另一项 = 切过去并展开这一侧;点这一侧此刻选中的项 = 收起 / 展开(sideRails)。
 *   按住拖动超过 4px = 拖动(railDrag.ts),可以在同一条 rail 里调顺序,也可以拖到另一条 rail。
 *   「+」(新 Agent 分页)不是可拖的项:画在这一侧最后一个 Agent 项正下方,这一侧没有 Agent 就不画。
 *   项之间不画分隔线,只靠 4px 间距;拖空的 rail 仍然 64px 宽、占满高度,当落点用。
 *
 * 钩子:nav `data-pc="left-rail" | "right-rail"` + `data-pc-dock-rail=<side>`,列表 `data-pc-dock-list=<side>`,
 * 每项外层 `.pc-dock-slot[data-pc-dock-item=<ItemId>]`,里面的按钮照旧 `data-pc-rail=<分区 | script>` / `data-pc-agent-tab=<tabId>`,
 * 「+」`data-pc="agent-tab-add"` + `data-pc-dock-add=<side>`。
 */
export function RailBar({ side }: { side: Side }) {
  const layout = useRailLayout();
  const mode = useLayoutMode();
  const collapsed = useRailCollapsed(side);
  const { tabs } = useAgentTabs();
  const script = useScript();
  const attention = useAgentAttentionMap();

  const items = visibleItems(layout[side], mode);
  const active = effectiveActive(layout, side, mode);
  const anchor = plusAnchor(items);

  const renderSlot = (id: ItemId): ReactNode => {
    const on = id === active;
    const expanded = on ? !collapsed : undefined;
    const handlers = {
      onClick: () => clickRailItem(side, id),
      onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => beginRailPointer(e, id),
    };

    if (isSectionItem(id)) {
      const { label, Icon } = SECTION_META[id];
      return (
        <div key={id} className="pc-dock-slot" data-pc-dock-item={id}>
          <button
            type="button"
            data-pc-rail={id}
            className={`pc-rail-item${on ? " is-on" : ""}`}
            aria-pressed={on}
            aria-expanded={expanded}
            title={on ? (collapsed ? `展开「${label}」` : `收起「${label}」`) : label}
            {...handlers}
          >
            <Icon />
            <span>{label}</span>
          </button>
        </div>
      );
    }

    if (id === "script") {
      return (
        <div key={id} className="pc-dock-slot" data-pc-dock-item={id}>
          <button
            type="button"
            data-pc-rail="script"
            className={`pc-rail-item${on ? " is-on" : ""}`}
            aria-current={on ? "page" : undefined}
            aria-expanded={expanded}
            title={script ? `剧本已写 ${script.length} 字，每轮都会附给 AI` : "写下这条片子要讲什么，AI 每轮都会照着它做"}
            {...handlers}
          >
            <IconScript />
            <span>剧本</span>
            {script && <i className="pc-rr-dot" aria-hidden="true" />}
          </button>
        </div>
      );
    }

    const tabId = agentIdOf(id);
    const index = tabs.findIndex((t) => t.id === tabId);
    const t = tabs[index];
    if (!t) return null;
    const closable = tabs.length > 1 && t.id !== MAIN_TAB;
    // 跑的时候头像背景流光;跑完 / 中断且用户还没看这一页时一个小点(蓝 / 黄),见 agentAttention.tsx
    const state = t.busy ? "busy" : attention.get(t.id) ?? "idle";
    const stateTip = AGENT_STATE_TIP[state];
    return (
      <div key={id} className="pc-dock-slot pc-rr-tab" data-pc-dock-item={id}>
        <button
          type="button"
          aria-pressed={on}
          aria-expanded={expanded}
          className={`pc-rail-item pc-rr-agent${on ? " is-on" : ""}${t.busy ? " is-busy" : ""}`}
          data-pc-agent-tab={t.id}
          data-pc-agent-state={state}
          title={stateTip ? `${tabTooltip(t)}\n${stateTip}` : tabTooltip(t)}
          {...handlers}
        >
          <span className="pc-rr-glyph" aria-hidden="true">{glyphOf(t, index)}</span>
          <span className="pc-rr-label">{shortLabel(t.title)}</span>
          {(state === "done" || state === "interrupted") && <i className={`pc-rr-state is-${state}`} aria-hidden="true" />}
          {t.unread > 0 && (
            <b className="pc-rr-badge" title={`${t.unread} 条其他 Agent 的消息待处理`}>{t.unread}</b>
          )}
        </button>
        {closable && (
          <button
            type="button"
            className="pc-rr-x"
            aria-label={`关闭 ${t.title}`}
            title={t.busy ? "还在跑,关掉会中断它" : "关闭这一页"}
            onClick={() => {
              if (t.busy && !confirm(`${t.title} 还在跑,关掉会中断它。确定关闭?`)) return;
              closeTab(t.id);
            }}
          >
            ×
          </button>
        )}
      </div>
    );
  };

  // 「+」和各项放在同一个带 key 的数组里:新开一页后它挪到新项下面是移动,不是卸载重建
  const children: ReactNode[] = [];
  items.forEach((id, i) => {
    children.push(renderSlot(id));
    if (i === anchor) {
      children.push(
        <button
          key="+"
          type="button"
          className="pc-rail-item pc-dock-add"
          data-pc="agent-tab-add"
          data-pc-dock-add={side}
          title="新助手分页"
          aria-label="新助手分页"
          onClick={() => addAgentOnSide(side)}
        >
          <IconBubblePlus />
        </button>,
      );
    }
  });

  return (
    <nav
      className={`pc-rail pc-rail--${side} pc-dock-rail`}
      data-pc={`${side}-rail`}
      data-pc-dock-rail={side}
      aria-label={side === "left" ? "左栏分区" : "右栏分页"}
    >
      <div className="pc-dock-rail-list" data-pc-dock-list={side}>
        {children}
      </div>
    </nav>
  );
}
