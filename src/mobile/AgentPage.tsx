/**
 * 手机版 Agent 分页(语义 `workflow/editing.md`「手机版界面」「AI 栏的 Agent 标签」;演示稿 `prototypes/mobile-ui-demo/` 的 Agent 页)。
 *
 * 上面一排对话标签(Agent 1、Agent 2……,每个都能关,「+」新开)+ 当前会话的对话页。标签清单和桌面共用 `src/ai/agentTabs.ts`:
 * 按项目分开、标记是「项目ID_AgentID」;本项目一个会话都没有时只有一项「开始」,对话页是开始页(预设 + 输入框,刚进项目时带引导动画),
 * 用户点发送才建第一个会话(Agent 1)。每个会话各挂一份 `AgentChat`(切标签不卸载,后台的对话照跑)。
 */
import "../ai/agentTabsProject";
import { useRef } from "react";
import { addTab, closeTab, activateTab, useAgentTabs } from "../ai/agentTabs";
import { useCloudAgent, useCloudNotices } from "../ai/cloud/useCloud";
import { Icon } from "./icons";
import { useConfirm } from "./ui";
import { AgentChat } from "./AgentChat";

export function AgentPage({ active }: { active: boolean }) {
  const cloud = useCloudAgent();
  useCloudNotices(cloud, cloud.available);
  const { tabs, activeId } = useAgentTabs();
  const confirm = useConfirm();
  const counts = useRef(new Map<string, number>());

  const close = (id: string, title: string) => {
    if ((counts.current.get(id) ?? 0) === 0) { closeTab(id); return; }
    // 手机版没有历史对话列表:关掉之后这段对话在手机上就看不到了(云端仍留着,桌面版的历史里找得到),所以先问一声
    confirm({ text: `关闭「${title}」?这段对话在手机上不再显示,仍保存在云端的对话历史里(桌面版可以打开)。`, ok: "关闭", danger: true, run: () => closeTab(id) });
  };

  return (
    <div className="agent-page" data-pcm="agent-page">
      <div className="chat-top" data-pcm="chat-top">
        <div className="atabs" data-pcm="atabs">
          {tabs.map((t) => (
            <div key={t.id} role="tab" aria-selected={t.id === activeId} className={`atab${t.id === activeId ? " on" : ""}`} data-pcm="atab" data-draft={t.draft ? "1" : undefined}
              onClick={() => activateTab(t.id)}>
              {t.busy && <i className="dot run" aria-hidden="true" />}
              <span className="nm">{t.draft ? "开始" : t.title}</span>
              {t.draft
                ? <span className="x-gap" />
                : <span className="x" role="button" aria-label={`关闭 ${t.title}`} data-pcm="atab-close" onClick={(e) => { e.stopPropagation(); close(t.id, t.title); }}>✕</span>}
            </div>
          ))}
        </div>
        <button type="button" className="icon-btn" data-pcm="atab-new" title="新对话" aria-label="新对话" onClick={() => { const t = addTab(); activateTab(t.id); }}><Icon name="plus" /></button>
      </div>
      {tabs.map((t) => <AgentChat key={t.id} tabId={t.id} shown={active && t.id === activeId} cloud={cloud} counts={counts} />)}
    </div>
  );
}
