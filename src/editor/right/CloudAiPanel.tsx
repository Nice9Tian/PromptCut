import React, { useEffect, useMemo, useRef, useState } from "react";
import "./AiPanel.css";
import "./CloudAiPanel.css";
// 公式样式表:LiveMarkdown 用 KaTeX 渲染数学
import "katex/dist/katex.min.css";
import { useCloudChat, type CloudAgentState } from "../../ai/cloud/useCloud";
import { leaveCloudTab } from "../../ai/cloud/tabMode";
import { cloudErrorText } from "../../ai/cloud/cloudApi";
import { setTabBusy, setTabConversation, useAgentTabs } from "../../ai/agentTabs";
import { MAIN_TAB } from "../../ai/liveChat";
import { useInstallJobs } from "../../ai/sttInstallStore";
import { enqueue, getQueue, clear as clearQueue, remove as removeQueued, setPaused as setQueuePaused, useQueue, type QueuedItem } from "../../ai/chatQueue";
import type { AiProvider, ProviderInfo, PublicAiConfig } from "../../ai/types";
import { ChatHistoryDrawer } from "./ChatHistoryDrawer";
import { useViewPrefs, setShowThinking } from "./chat/viewPrefs";
import { ChatHeader } from "./chat/ChatHeader";
import { MessageList } from "./chat/MessageList";
import { ThinkingStrip } from "./chat/ThinkingStrip";
import { QueueList } from "./chat/QueueList";
import { Composer } from "./chat/Composer";
import { CloudModelBar, CLOUD_NO_ATTACH } from "./CloudModelBar";
import { AgentEventLog } from "../sync/AgentEventLog";
import { RemoteAgentsStrip } from "./RemoteAgentsStrip";

/** 从桌面版的 AI 栏嵌进来时,本机一侧要给的几样(在线页面不给) */
export interface CloudDesktopSide {
  providers: ProviderInfo[];
  provider: AiProvider | null;
  config: PublicAiConfig | null;
  /** 云端页里选了本机的某个驱动:回到本机模式 */
  onLeave: (p: AiProvider) => void;
}

/**
 * 「云端」接入方式的一个 AI 助手分页(契约 9.5)。在线浏览器宽屏下它是右侧 AI 栏的全部;桌面版里,
 * 一页选了「云端」就由它接管这一页(`AiPanel` 在那时交给它),选回本机驱动再还给 `AiPanel`。
 *
 * 与本机 Agent 的区别只在「这一轮在哪跑」:消息发到云节点的 Agent 服务(202,这一轮与本页的连接无关),
 * 页面按事件流看进展,断了自动重连补齐;关掉页面、退出软件,云端的这一轮照跑,重新打开自动接上。
 * 对话界面完全由事件重建,页面不存云端对话记录。
 *
 * 这里不碰任何 `/api/*`:模型、对话、工具执行全在云端,页面只打 `/agent/v1/*`。
 */
export function CloudAiPanel(props: {
  tabId?: string;
  active?: boolean;
  hotkeysOff?: boolean;
  cloud: CloudAgentState;
  desktop?: CloudDesktopSide;
  /** 从历史列表点进来的云端对话 */
  initialConversation?: string | null;
}) {
  const tabId = props.tabId ?? MAIN_TAB;
  const active = props.active ?? true;
  const { cloud, desktop } = props;
  const chat = useCloudChat({ tabId, cloud, enabled: true, autoAttach: true, initialConversation: props.initialConversation });
  const { view } = chat;
  const qKey = `cloud:${tabId}`;

  const { tabs } = useAgentTabs();
  const tabTitle = desktop ? (tabs.find((t) => t.id === tabId)?.title ?? "AI 助手") : "云端 Agent";
  // 页签上的「对话 ID」是给本机 Agent 的多 Agent 通信用的;桌面版里这一页选回本机驱动后还要用它,云端的对话 id 不往里写
  useEffect(() => { if (!desktop) setTabConversation(tabId, chat.conversationId); }, [tabId, chat.conversationId, desktop]);
  useEffect(() => { setTabBusy(tabId, view.streaming); }, [tabId, view.streaming]);
  useEffect(() => () => setTabBusy(tabId, false), [tabId]);
  useEffect(() => () => { clearQueue(qKey); }, [qKey]);

  // 创建者关了开关:成员列表通知过来的(`cloud.enabled`)或 info 报的
  const off = !cloud.enabled || chat.info?.enabled === false;
  const offText = cloudErrorText("disabled");

  /* ---------- 草稿、排队、发送 ---------- */
  const [inputText, setInputText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { view: viewMode, showThinking } = useViewPrefs();
  const installJobs = useInstallJobs();
  const queue = useQueue(qKey);

  // 预览右键卡片「引用到 AI」:与本机 AI 栏同一个事件
  useEffect(() => {
    const onQuote = (ev: Event) => {
      if (!active) return;
      const d = (ev as CustomEvent).detail || {};
      const ref = `@卡片 ${d.label || d.cardId || "未命名"}(${d.clipId}) `;
      const ta = textareaRef.current;
      const pos = ta ? (ta.selectionStart ?? ta.value.length) : -1;
      setInputText((prev) => {
        const at = pos >= 0 ? pos : prev.length;
        const before = prev.slice(0, at);
        const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
        return before + lead + ref + prev.slice(at);
      });
    };
    window.addEventListener("pc-quote-clip", onQuote as EventListener);
    return () => window.removeEventListener("pc-quote-clip", onQuote as EventListener);
  }, [active]);

  /** 刚发出去、服务端的 user 事件还没回来的那一小会儿也算忙(免得连发两条撞上「对话还有一轮在进行」) */
  const echoWait = useRef(false);
  const echoTimer = useRef<number | null>(null);
  const [, bump] = useState(0);
  useEffect(() => {
    if (view.streaming && echoWait.current) { echoWait.current = false; bump((n) => n + 1); }
  }, [view.streaming]);
  const busy = () => view.streaming || echoWait.current;
  const markSent = () => {
    echoWait.current = true;
    if (echoTimer.current !== null) window.clearTimeout(echoTimer.current);
    echoTimer.current = window.setTimeout(() => { echoWait.current = false; bump((n) => n + 1); }, 4000);
  };
  useEffect(() => () => { if (echoTimer.current !== null) window.clearTimeout(echoTimer.current); }, []);

  const sendNow = async (text: string): Promise<boolean> => {
    if (off) { return false; }
    markSent();
    const ok = await chat.send(text);
    if (!ok) { echoWait.current = false; bump((n) => n + 1); }
    return ok;
  };

  const handleSend = (text: string) => {
    if (!text.trim()) return;
    if (off) return;
    if (busy()) {
      enqueue(qKey, { text: text.trim() });
    } else {
      void sendNow(text.trim());
    }
    setInputText("");
  };

  // 一轮结束:空闲且没暂停就发队首
  useEffect(() => {
    if (view.streaming || echoWait.current || off) return;
    if (queue.paused || queue.items.length === 0) return;
    const head = queue.items[0];
    removeQueued(qKey, head.id);
    void sendNow(head.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.streaming, queue.items, queue.paused, off]);

  const handleStop = () => {
    if (getQueue(qKey).length > 0) setQueuePaused(qKey, true);
    void chat.abort();
  };
  const insertQueued = async (item: QueuedItem) => {
    removeQueued(qKey, item.id);
    if (view.streaming) {
      await chat.abort();
      // 停止要等服务端收尾的事件回来
      for (let i = 0; i < 40 && chat.store.get().some((m) => m.pending); i++) await new Promise((r) => setTimeout(r, 100));
    }
    void sendNow(item.text);
  };
  const editQueued = (item: QueuedItem) => {
    removeQueued(qKey, item.id);
    setInputText(item.text);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const resumeQueue = () => setQueuePaused(qKey, false);
  const hasDraft = () => inputText.trim().length > 0;

  /* ---------- 消息行的展开状态(同 AiPanel) ---------- */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openRuns, setOpenRuns] = useState<Set<string>>(new Set());
  const handlersRef = useRef({
    toggleTool: (_k: string) => {},
    toggleChip: (_k: string) => {},
    toggleRun: (_k: string) => {},
  });
  handlersRef.current = {
    toggleTool: (key) => setExpanded((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; }),
    toggleChip: (key) => setExpanded((prev) => (prev.has(key) ? new Set() : new Set([key]))),
    toggleRun: (key) => {
      if (openRuns.has(key)) setExpanded(new Set());
      setOpenRuns((prev) => { const n = new Set(prev); if (!n.delete(key)) n.add(key); return n; });
    },
  };
  const rowHandlers = useMemo(() => ({
    toggleTool: (k: string) => handlersRef.current.toggleTool(k),
    toggleChip: (k: string) => handlersRef.current.toggleChip(k),
    toggleRun: (k: string) => handlersRef.current.toggleRun(k),
  }), []);

  /* ---------- 历史列表 ---------- */
  const openHistory = () => { setHistoryOpen(true); void chat.history.refresh(); };
  const historyItems = useMemo(() => {
    // 当前对话刚发出第一条、服务端列表还没刷新时,先把它列进去
    const hit = chat.history.items.some((x) => x.id === chat.conversationId);
    if (hit || chat.messages.length === 0) return chat.history.items;
    const title = chat.messages.find((m) => m.role === "user")?.text.slice(0, 40) || "云端对话";
    return [{ id: chat.conversationId, title, updatedAt: Date.now(), state: view.streaming ? "running" as const : "idle" as const, lastSeq: view.lastSeq }, ...chat.history.items];
  }, [chat.history.items, chat.conversationId, chat.messages, view.streaming, view.lastSeq]);

  const connLabel = view.connection === "live" ? "已连接云端" : view.connection === "connecting" ? "正在连接云端…" : view.connection === "reconnecting" ? "连接中断,重新连接中…" : "未连接云端";

  return (
    <aside className="panel panel-right ai-panel pc-cloud-panel" data-pc="cloud-ai-panel" data-inactive={active ? undefined : "1"} aria-hidden={active ? undefined : true}>
      <ChatHeader
        title={tabTitle}
        mcpConnected={view.connection === "live"}
        statusLabel={connLabel}
        showThinking={showThinking}
        onChangeShowThinking={setShowThinking}
        onOpenHistory={openHistory}
        onOpenSetup={() => {}}
        settingsDisabled="云端 Agent 的模型由托管方配置,这里没有 AI 设置可改"
      />

      {!cloud.available && <div className="ai-banner" data-pc="cloud-unavailable">这个项目所在的托管端没有云端 Agent 服务。</div>}
      {cloud.available && off && <div className="ai-banner" data-pc="cloud-off">{offText}</div>}
      {view.connection === "reconnecting" && (
        <div className="ai-banner pc-cloud-reconnect" data-pc="cloud-reconnecting">
          和云端 Agent 的连接断了,正在重新连接。云端的这一轮仍在继续,连上后会把错过的过程补齐。
        </div>
      )}

      <RemoteAgentsStrip />
      <MessageList
        messages={chat.messages}
        view={viewMode}
        showThinking={showThinking}
        installJobs={installJobs}
        expanded={expanded}
        openRuns={openRuns}
        rowHandlers={rowHandlers}
        onPickExample={setInputText}
      />

      <AgentEventLog />
      <ThinkingStrip messages={chat.messages} streaming={view.streaming} />
      <QueueList tabId={qKey} running={view.streaming} onInsert={insertQueued} onEdit={editQueued} onResume={resumeQueue} hasDraft={hasDraft} />

      {chat.notice && (
        <div className="ai-toast" data-pc="cloud-notice" role="alert" onClick={chat.clearNotice} title="点一下关掉">{chat.notice}</div>
      )}
      <div className="pc-cloud-note" data-pc="cloud-note">在云端运行,关闭后继续;重新打开可接着看</div>

      <Composer
        text={inputText}
        onTextChange={setInputText}
        textareaRef={textareaRef}
        attachments={[]}
        uploading={false}
        onPickFiles={() => {}}
        onRetryAttachment={() => {}}
        onRemoveAttachment={() => {}}
        onSubmit={handleSend}
        onStop={handleStop}
        streaming={view.streaming}
        hotkeysOff={props.hotkeysOff}
        active={active}
        provider={desktop?.provider ?? null}
        providers={desktop?.providers ?? []}
        onSetProvider={() => {}}
        config={desktop?.config ?? null}
        tabId={tabId}
        menu={{
          workflowRoles: [],
          onRunWorkflow: () => {},
          canDiagnose: false,
          onOpenDiagnostics: () => {},
          onNewChat: () => chat.newChat(),
        }}
        cloud={{
          show: true,
          selected: true,
          onSelect: () => {},
          onLeave: (p) => { if (desktop) { leaveCloudTab(tabId); desktop.onLeave(p); } },
          toolbar: <CloudModelBar info={chat.info} model={chat.model} onModel={chat.setModel} disabled={view.streaming} tabId={tabId} />,
          attachReason: CLOUD_NO_ATTACH,
        }}
      />

      <ChatHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        items={[]}
        loading={false}
        query={query}
        onQueryChange={setQuery}
        currentId={chat.conversationId}
        onPick={() => {}}
        onDelete={() => {}}
        onNewChat={() => { chat.newChat(); setHistoryOpen(false); }}
        hideLocal
        cloud={{ items: historyItems, loading: chat.history.loading, currentId: chat.conversationId, onPick: (id) => { chat.openChat(id); setHistoryOpen(false); } }}
      />
    </aside>
  );
}
