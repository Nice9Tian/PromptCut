import type { JSX } from "react";
import { activateTab, addTab, closeTab, useAgentTabs } from "../../ai/agentTabs";
import "./AgentTabs.css";

/**
 * AI 助手面板顶上的分页栏:一页一个 Agent,可以同时跑。
 * 传统式和对话式布局都经 RightPanel 渲染,所以两种布局天然都有它。
 */
export function AgentTabs(): JSX.Element {
  const { tabs, activeId } = useAgentTabs();
  return (
    <div className="pc-agent-tabs" role="tablist" aria-label="Agent 分页">
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === activeId}
          tabIndex={0}
          className={`pc-agent-tab${t.id === activeId ? " is-on" : ""}${t.busy ? " is-busy" : ""}`}
          title={t.scope ? `范围:${t.scope}${t.conversationId ? `\n对话 ID:${t.conversationId}` : ""}` : t.conversationId ? `对话 ID:${t.conversationId}` : "还没开始对话"}
          onClick={() => activateTab(t.id)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activateTab(t.id); } }}
        >
          <span className="pc-agent-tab-dot" aria-hidden="true" />
          <span className="pc-agent-tab-name">{t.title}</span>
          {t.unread > 0 && <span className="pc-agent-tab-badge" title={`${t.unread} 条其他 Agent 的消息待处理`}>{t.unread}</span>}
          {tabs.length > 1 && t.id !== "main" && (
            <button
              type="button"
              className="pc-agent-tab-x"
              aria-label={`关闭 ${t.title}`}
              title={t.busy ? "还在跑,关掉会中断它" : "关闭这一页"}
              onClick={(e) => {
                e.stopPropagation();
                if (t.busy && !confirm(`${t.title} 还在跑,关掉会中断它。确定关闭?`)) return;
                closeTab(t.id);
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button type="button" className="pc-agent-tab-add" title="再开一个 Agent,和现有的并行" aria-label="新开一个 Agent" onClick={() => addTab()}>
        +
      </button>
    </div>
  );
}
