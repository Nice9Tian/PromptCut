import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import "./AiPanel.css";
import "./CloudAiPanel.css";
// 公式样式表:LiveMarkdown 用 KaTeX 渲染数学
import "katex/dist/katex.min.css";
import { useCloudChat, type CloudAgentState } from "../../ai/cloud/useCloud";
import { leaveCloudTab } from "../../ai/cloud/tabMode";
import { CloudError, cloudConversationControlPolicy, cloudErrorText } from "../../ai/cloud/cloudApi";
import { CLOUD_ATTACH_ACCEPT, CLOUD_ATTACH_NEED_TEXT, CLOUD_ATTACH_TITLE, cloudAttachKindOfName, newCloudAttachId, pickSendable } from "../../ai/cloud/attach";
import { setTabBusy, setTabConversation, useAgentTabs } from "../../ai/agentTabs";
import { MAIN_TAB } from "../../ai/liveChat";
import { useInstallJobs } from "../../ai/sttInstallStore";
import { enqueue, getQueue, clear as clearQueue, remove as removeQueued, setPaused as setQueuePaused, useQueue, type QueuedItem } from "../../ai/chatQueue";
import type { AiProvider, ChatAttachment, ProviderInfo, PublicAiConfig } from "../../ai/types";
import { ChatHistoryDrawer } from "./ChatHistoryDrawer";
import { useViewPrefs, setShowThinking } from "./chat/viewPrefs";
import { ChatHeader } from "./chat/ChatHeader";
import { MessageList } from "./chat/MessageList";
import { ThinkingStrip } from "./chat/ThinkingStrip";
import { CloudQueueList, QueueList } from "./chat/QueueList";
import { setAccountAgentEnabled, useSync } from "../sync/syncManager";
import { Composer } from "./chat/Composer";
import { CloudModelBar } from "./CloudModelBar";
import { AgentEventLog } from "../sync/AgentEventLog";
import { RemoteAgentsStrip } from "./RemoteAgentsStrip";
import { ReportDialog } from "./ReportDialog";
import { cloudConversationReport } from "../../ai/cloud/report";
import { CODE_VERSION } from "../../online/buildInfo";
import { acceptCloudConsent, cloudConsentState, refreshCloudConsent, subscribeCloudConsent } from "../../ai/cloud/consent";
import { CloudAgentConsentDialog } from "./CloudAgentConsentDialog";

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

type CloudControlRequest =
  | { kind: "visibility"; target: "shared" | "private"; conversationId: string; requestId: string }
  | { kind: "stop"; runId: string; conversationId: string; requestId: string };

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
  const creator = useSync(state => state.shared?.creator === true);
  const [enabling, setEnabling] = useState(false);
  const consent = useSyncExternalStore(subscribeCloudConsent, cloudConsentState, cloudConsentState);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  useEffect(() => {
    if (!cloud.accountMode || !cloud.available || !cloud.projectId || !consent.accountId || consent.accountId !== cloud.accountId) return;
    let dead = false;
    void refreshCloudConsent().then(accepted => { if (!dead) setConsentOpen(!accepted && cloudConsentState().accepted !== true); },
      error => { if (!dead && cloudConsentState().accepted !== true) setConsentError(error instanceof Error ? error.message : "云端账号暂时不可用。"); });
    return () => { dead = true; };
    // A new account/project binding gets a fresh server result; rejecting does not trigger a loop.
  }, [cloud.accountMode, cloud.available, cloud.projectId, cloud.accountId, consent.accountId, consent.bindingVersion]);
  const consentForUse = async () => {
    if (!cloud.accountMode) return true;
    if (!stillCurrent()) return false;
    const expected = cloud.accountId ? { accountId: cloud.accountId, bindingVersion: consent.bindingVersion } : null;
    if (!expected || consent.accountId !== expected.accountId || cloudConsentState().bindingVersion !== expected.bindingVersion) {
      setConsentError("请先登录当前项目的账号。");
      return false;
    }
    try {
      const accepted = await refreshCloudConsent(expected);
      if (cloudConsentState().accountId !== expected.accountId || cloudConsentState().bindingVersion !== expected.bindingVersion) return false;
      if (!accepted) { setConsentError(null); setConsentOpen(true); }
      return accepted;
    } catch (error) {
      if (!stillCurrent()) return false;
      setConsentError(error instanceof Error ? error.message : "云端账号暂时不可用。");
      setConsentOpen(true);
      return false;
    }
  };
  const acceptConsent = () => { void acceptCloudConsent().then(() => { if (stillCurrent()) { setConsentError(null); setConsentOpen(false); } },
    error => { if (stillCurrent()) setConsentError(error instanceof Error ? error.message : "云端账号暂时不可用。"); }); };
  const chat = useCloudChat({ tabId, cloud, enabled: true, autoAttach: true, initialConversation: props.initialConversation });
  const { view } = chat;
  const [metadataReadyKey, setMetadataReadyKey] = useState("");
  const [controlPending, setControlPending] = useState<CloudControlRequest | null>(null);
  const controlPendingRef = useRef<CloudControlRequest | null>(null);
  const controlInFlightRef = useRef(false);
  const [controlNote, setControlNote] = useState<string | null>(null);
  const qKey = cloud.accountMode ? `cloud:${tabId}:${cloud.accountId ?? "none"}:${consent.bindingVersion}:${cloud.projectId ?? "none"}` : `cloud:${tabId}`;
  const activeKeyRef = useRef(qKey);
  activeKeyRef.current = qKey;
  const stillCurrent = () => activeKeyRef.current === qKey && (!cloud.accountMode ||
    (cloudConsentState().accountId === cloud.accountId && cloudConsentState().bindingVersion === consent.bindingVersion));
  useEffect(() => { if (cloud.accountMode) { setConsentOpen(false); setConsentError(null); } }, [cloud.accountMode, qKey]);

  const { tabs } = useAgentTabs();
  const tabTitle = desktop ? (tabs.find((t) => t.id === tabId)?.title ?? "AI 助手") : "云端 Agent";
  // 页签上的「对话 ID」是给本机 Agent 的多 Agent 通信用的;桌面版里这一页选回本机驱动后还要用它,云端的对话 id 不往里写
  useEffect(() => { if (!desktop) setTabConversation(tabId, chat.conversationId); }, [tabId, chat.conversationId, desktop]);
  const currentMeta = chat.history.items.find(item => item.id === chat.conversationId) ?? null;
  const controlPolicy = cloudConversationControlPolicy({ accountMode: cloud.accountMode, accountId: cloud.accountId,
    creator, conversation: currentMeta, queue: view.queue, senders: view.senders, legacyStreaming: view.streaming });
  const currentRunId = controlPolicy.currentRunId;
  const canStopCurrentRun = controlPolicy.canStop;
  const streaming = controlPolicy.streaming;
  const metadataKey = `${qKey}:${chat.conversationId}`;
  const metadataReady = !cloud.accountMode || metadataReadyKey === metadataKey;
  const creatorReadOnly = controlPolicy.creatorReadOnly;
  const canSwitchVisibility = controlPolicy.canSwitchVisibility;
  useEffect(() => { setTabBusy(tabId, streaming); }, [tabId, streaming]);
  useEffect(() => () => setTabBusy(tabId, false), [tabId]);
  useEffect(() => () => { clearQueue(qKey); }, [qKey]);

  useEffect(() => {
    if (!cloud.accountMode) return;
    let live = true;
    setMetadataReadyKey("");
    setControlNote(null);
    if (controlPendingRef.current?.conversationId !== chat.conversationId) {
      controlPendingRef.current = null;
      setControlPending(null);
    }
    void chat.history.refresh().then(ok => { if (live && ok) setMetadataReadyKey(metadataKey); });
    return () => { live = false; };
  }, [cloud.accountMode, consent.accepted, chat.conversationId, chat.history.refresh, metadataKey]);

  // 新建的云端对话首次落地消息后才出现在服务器列表里；刷新会话元数据时确认其真实所有者与权限。
  useEffect(() => {
    if (!cloud.accountMode || chat.messages.length === 0) return;
    let live = true;
    void chat.history.refresh().then(ok => { if (live && ok) setMetadataReadyKey(metadataKey); });
    return () => { live = false; };
  }, [cloud.accountMode, consent.accepted, chat.conversationId, chat.messages.length, chat.history.refresh, metadataKey]);

  // 创建者关了开关:成员列表通知过来的(`cloud.enabled`)或 info 报的
  const off = !cloud.enabled || chat.info?.enabled === false;
  const offText = cloudErrorText("disabled");

  /* ---------- 草稿、排队、发送 ---------- */
  const [inputText, setInputText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /* 附件:选文件 → 逐个上传到云端这个对话的工作目录(显示上传中)→ 发消息时把传好的带上。失败给出原因,可点一下重试、可移除 */
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 附件占位 id → 原始文件(失败重试用)与进行中的上传(移除时取消) */
  const retryFilesRef = useRef<Map<string, File>>(new Map());
  const uploadsRef = useRef<Map<string, AbortController>>(new Map());
  useEffect(() => {
    if (!cloud.accountMode) return;
    setInputText("");
    setAttachments([]);
    for (const upload of uploadsRef.current.values()) upload.abort();
    uploadsRef.current.clear(); retryFilesRef.current.clear();
  }, [cloud.accountMode, qKey]);
  // 换了对话(新对话、历史里点了别的、进入时自动接上在跑的):附件只在传去的那个对话的工作目录里,不跟过去
  useEffect(() => {
    setAttachments((prev) => {
      const keep = prev.filter((a) => !a.conversationId || a.conversationId === chat.conversationId);
      if (keep.length === prev.length) return prev;
      for (const a of prev) if (!keep.includes(a) && a.id) { uploadsRef.current.get(a.id)?.abort(); uploadsRef.current.delete(a.id); retryFilesRef.current.delete(a.id); }
      return keep;
    });
  }, [chat.conversationId]);
  useEffect(() => () => { for (const ac of uploadsRef.current.values()) ac.abort(); }, []);
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

  const sendNow = async (text: string, files?: ChatAttachment[]): Promise<boolean> => {
    if (off || !stillCurrent() || !controlPolicy.canSend) return false;
    if (!cloud.accountMode) markSent();
    const ok = await chat.send(text, files);
    if (!stillCurrent()) return false;
    if (!ok) { echoWait.current = false; bump((n) => n + 1); }
    return ok;
  };

  const handleSend = async (text: string) => {
    if (creatorReadOnly || !text.trim() && attachments.length === 0) return;
    if (off) return;
    if (!await consentForUse() || !stillCurrent()) return;
    // 还在上传或上传失败的附件这次先不带上,但发送本身不被挡住
    const { usable, skipped } = pickSendable(attachments, chat.conversationId);
    if (!text.trim()) {
      // 服务端不收空消息:只有附件时留在输入框里,等用户写一句话
      chat.notify(skipped > 0 && usable.length === 0 ? `${skipped} 个附件还在上传或上传失败,请等它传好、或重试后再发。` : CLOUD_ATTACH_NEED_TEXT);
      return;
    }
    if (skipped > 0) chat.notify(`${skipped} 个附件还在上传或上传失败,这次没带上。`);
    if (!cloud.accountMode && busy()) {
      enqueue(qKey, { text: text.trim(), ...(usable.length ? { attachments: usable } : {}) });
    } else {
      if (!await sendNow(text.trim(), usable)) return;
    }
    if (stillCurrent()) {
      setInputText(previous => previous === text ? "" : previous);
      setAttachments(previous => previous === attachments ? [] : previous);
    }
  };

  // 一轮结束:空闲且没暂停就发队首
  const flushingRef = useRef(false);
  useEffect(() => {
    if (cloud.accountMode) return;
    if (view.streaming || echoWait.current || off) return;
    if (queue.paused || queue.items.length === 0) return;
    if (flushingRef.current) return;
    const head = queue.items[0];
    flushingRef.current = true;
    void (async () => {
      try {
        if (!await consentForUse() || !stillCurrent()) { setQueuePaused(qKey, true); return; }
        if (await sendNow(head.text, head.attachments)) removeQueued(qKey, head.id);
        else setQueuePaused(qKey, true);
      } finally { flushingRef.current = false; }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.streaming, queue.items, queue.paused, off]);

  const applyCloudControl = async (request: CloudControlRequest) => {
    if (!cloud.accountMode || request.conversationId !== chat.conversationId || controlInFlightRef.current) return;
    if (controlPendingRef.current && controlPendingRef.current.requestId !== request.requestId) return;
    controlInFlightRef.current = true;
    controlPendingRef.current = request;
    setControlPending(request);
    setControlNote(request.kind === "visibility" ? "正在更新对话权限…" : "正在向云端提交停止请求…");
    try {
      if (request.kind === "visibility") await chat.switchVisibility(request.target, request.requestId);
      else await chat.abort(request.runId, request.requestId);
      if (request.conversationId !== chat.conversationId) return;
      const refreshed = await chat.history.refresh();
      if (refreshed) setMetadataReadyKey(metadataKey);
      controlPendingRef.current = null;
      setControlPending(null);
      setControlNote(request.kind === "visibility"
        ? request.target === "private" ? "已切为私有。" : "已切为共有。"
        : "云端已确认停止请求。正在同步对话状态。");
    } catch (error) {
      if (request.conversationId !== chat.conversationId) return;
      // 重读可见性；503/fence pending 时保留原请求号，让用户安全重试同一操作。
      const refreshed = await chat.history.refresh();
      if (refreshed) setMetadataReadyKey(metadataKey);
      const pending = error instanceof CloudError && (error.status >= 500 || error.code === "agent-fence-pending" || error.code === "agent-fence-unavailable");
      if (pending) {
        controlPendingRef.current = request;
        setControlPending(request);
        setControlNote(error instanceof CloudError && error.code === "agent-fence-pending"
          ? "已禁止新访问，相关服务关闭待确认。点击重试会沿用原请求。"
          : "云端尚未确认这项操作。状态已重读；点击重试会沿用原请求。");
      } else {
        controlPendingRef.current = null;
        setControlPending(null);
        setControlNote(error instanceof Error ? error.message : "云端控制请求失败，请重读对话状态。");
      }
    } finally {
      controlInFlightRef.current = false;
    }
  };

  const handleVisibilityToggle = () => {
    const pending = controlPendingRef.current;
    if (pending) {
      if (pending.kind === "visibility" && pending.conversationId === chat.conversationId) void applyCloudControl(pending);
      return;
    }
    if (!canSwitchVisibility || !currentMeta) return;
    void applyCloudControl({ kind: "visibility", target: currentMeta.visibility === "private" ? "shared" : "private",
      conversationId: chat.conversationId, requestId: crypto.randomUUID() });
  };

  const handleStop = () => {
    if (cloud.accountMode) {
      const pending = controlPendingRef.current;
      if (pending) {
        if (pending.kind === "stop" && pending.conversationId === chat.conversationId) void applyCloudControl(pending);
        return;
      }
      if (!canStopCurrentRun || !currentRunId) return;
      void applyCloudControl({ kind: "stop", runId: currentRunId, conversationId: chat.conversationId, requestId: crypto.randomUUID() });
      return;
    }
    if (getQueue(qKey).length > 0) setQueuePaused(qKey, true);
    void chat.abort();
  };
  const insertQueued = async (item: QueuedItem) => {
    if (!await consentForUse() || !stillCurrent()) return;
    if (view.streaming) {
      await chat.abort();
      // 停止要等服务端收尾的事件回来
      for (let i = 0; i < 40 && stillCurrent() && chat.store.get().some((m) => m.pending); i++) await new Promise((r) => setTimeout(r, 100));
    }
    if (!stillCurrent()) return;
    if (await sendNow(item.text, item.attachments)) removeQueued(qKey, item.id);
    else setQueuePaused(qKey, true);
  };
  const editQueued = (item: QueuedItem) => {
    removeQueued(qKey, item.id);
    setInputText(item.text);
    setAttachments(item.attachments ?? []);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const resumeQueue = () => setQueuePaused(qKey, false);
  const hasDraft = () => inputText.trim().length > 0 || attachments.length > 0;

  /** 真正上传:不 await 丢出去跑,跑完回填那张附件卡(保留占位 id,重试与移除还对得上) */
  const runUpload = (id: string, file: File) => {
    if (!stillCurrent()) return;
    const convId = chat.conversationId;
    const ac = new AbortController();
    uploadsRef.current.set(id, ac);
    chat.attach(file, ac.signal).then(
      (info) => {
        if (!stillCurrent()) return;
        uploadsRef.current.delete(id);
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, url: info.url, name: info.name, kind: info.kind, bytes: info.size, ...(info.text !== undefined ? { text: info.text } : {}), conversationId: convId, status: "ready" as const, error: undefined } : a)));
      },
      (err: unknown) => {
        if (!stillCurrent()) return;
        uploadsRef.current.delete(id);
        if (ac.signal.aborted) return;
        const msg = err instanceof CloudError ? err.message : cloudErrorText("network");
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: "error" as const, error: msg } : a)));
      },
    );
  };
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (files.length === 0 || off || creatorReadOnly) return;
    const admitted = await consentForUse();
    if (!stillCurrent()) return;
    for (const file of files) {
      const id = newCloudAttachId();
      retryFilesRef.current.set(id, file);
      setAttachments((prev) => [...prev, { id, url: "", name: file.name, kind: cloudAttachKindOfName(file.name), bytes: file.size,
        srcPath: null, conversationId: chat.conversationId, status: admitted ? "importing" as const : "error" as const,
        ...(!admitted ? { error: "请先确认云端 Agent 告知，再重试上传。" } : {}) }]);
      if (admitted) runUpload(id, file);
    }
  };
  const retryAttachment = (id: string) => {
    const file = retryFilesRef.current.get(id);
    if (!file) return;
    void consentForUse().then(admitted => {
      if (!admitted || !stillCurrent()) return;
      setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: "importing" as const, error: undefined, conversationId: chat.conversationId } : a)));
      runUpload(id, file);
    });
  };
  const removeAttachment = (idx: number) => {
    setAttachments((prev) => {
      const gone = prev[idx];
      if (gone?.id) { uploadsRef.current.get(gone.id)?.abort(); uploadsRef.current.delete(gone.id); retryFilesRef.current.delete(gone.id); }
      return prev.filter((_, i) => i !== idx);
    });
  };

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

  /* ---------- 诊断报告(〔用户 2026-10-07 定〕云端下照常能用) ----------
   * 在页面里由这段云端对话的事件重建出的消息、会话状态与客户端信息生成,不请求任何 `/api/*`,不含票据、委托与模型 Key。
   * 在线页面「保存为文件」是浏览器下载,桌面版沿用本机写盘;提交走与本机相同的收报告地址(没配就置灰并说明)。 */
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagReport, setDiagReport] = useState("");
  const openDiagnostics = () => {
    if (chat.messages.length === 0) return;
    setDiagReport(cloudConversationReport({
      messages: chat.messages,
      conversationId: chat.conversationId,
      projectId: cloud.projectId,
      serviceUrl: cloud.url,
      view,
      info: chat.info,
      model: chat.model,
      notice: chat.notice,
      client: {
        mode: ONLINE_BUILD ? "online" : "desktop",
        userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
        language: typeof navigator === "undefined" ? undefined : navigator.language,
        platform: typeof navigator === "undefined" ? undefined : (navigator as { platform?: string }).platform,
        viewport: typeof window === "undefined" ? null : { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
        codeVersion: CODE_VERSION,
      },
    }));
    setDiagOpen(true);
  };

  /* ---------- 历史列表 ---------- */
  const openHistory = () => { setHistoryOpen(true); void chat.history.refresh(); };
  const historyItems = useMemo(() => {
    // 当前对话刚发出第一条、服务端列表还没刷新时,先把它列进去
    const hit = chat.history.items.some((x) => x.id === chat.conversationId);
    if (hit || chat.messages.length === 0) return chat.history.items;
    const title = chat.messages.find((m) => m.role === "user")?.text.slice(0, 40) || "云端对话";
    return [{ id: chat.conversationId, title, updatedAt: Date.now(), state: streaming ? "running" as const : "idle" as const, lastSeq: view.lastSeq }, ...chat.history.items];
  }, [chat.history.items, chat.conversationId, chat.messages, streaming, view.lastSeq]);

  const connLabel = view.connection === "live" ? "已连接云端" : view.connection === "connecting" ? "正在连接云端…" : view.connection === "reconnecting" ? "连接中断,重新连接中…" : "未连接云端";

  return (
    <aside className="panel panel-right ai-panel pc-cloud-panel" data-pc="cloud-ai-panel" data-cloud-running={streaming ? "1" : "0"} data-cloud-can-stop={canStopCurrentRun ? "1" : "0"} data-inactive={active ? undefined : "1"} aria-hidden={active ? undefined : true}>
      <CloudAgentConsentDialog open={active && consentOpen && cloud.accountMode && Boolean(consent.accountId) && consent.accountId === cloud.accountId} pending={consent.pending} error={consentError}
        onAccept={acceptConsent} onReject={() => { setConsentError(null); setConsentOpen(false); }} />
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
      {cloud.accountMode && cloud.available && off && creator && <button type="button" data-pc="cloud-agent-enable" disabled={enabling}
        onClick={() => { setEnabling(true); void setAccountAgentEnabled(true).catch(error => chat.notify(error instanceof Error ? error.message : '暂时无法开启云端 Agent。')).finally(() => setEnabling(false)); }}>开启云端 Agent</button>}
      {view.connection === "reconnecting" && (
        <div className="ai-banner pc-cloud-reconnect" data-pc="cloud-reconnecting">
          和云端 Agent 的连接断了,正在重新连接。云端的这一轮仍在继续,连上后会把错过的过程补齐。
        </div>
      )}

      {cloud.accountMode && (
        <div className="pc-cloud-controls" data-pc="cloud-conversation-controls" data-visibility={currentMeta?.visibility ?? "unknown"}>
          {!metadataReady ? <span data-pc="cloud-permission-loading">正在读取对话权限…</span> : currentMeta ? <>
            <span className="pc-cloud-access-label" data-pc="cloud-visibility-label">
              {currentMeta.visibility === "private" ? "私有对话" : "共有对话"}{creatorReadOnly ? " · 项目创建者只读" : ""}
            </span>
            {canSwitchVisibility && <button type="button" className="pc-cloud-control-btn" data-pc="cloud-visibility-toggle"
              disabled={controlPending?.kind === "stop"}
              onClick={handleVisibilityToggle}>
              {controlPending?.kind === "visibility"
                ? `重试设为${controlPending.target === "private" ? "私有" : "共有"}`
                : currentMeta.visibility === "private" ? "设为共有" : "设为私有"}
            </button>}
          </> : <span className="pc-cloud-access-label" data-pc="cloud-new-conversation">新云端对话 · 默认共有</span>}
          {controlNote && <span className="pc-cloud-control-note" data-pc="cloud-control-status" role="status">{controlNote}</span>}
          {controlPending?.kind === "stop" && <button type="button" className="pc-cloud-control-btn" data-pc="cloud-stop-retry"
            onClick={() => void applyCloudControl(controlPending)}>重试停止请求</button>}
        </div>
      )}

      <RemoteAgentsStrip />
      <MessageList
        messages={chat.messages}
        senders={view.senders}
        view={viewMode}
        showThinking={showThinking}
        installJobs={installJobs}
        expanded={expanded}
        openRuns={openRuns}
        rowHandlers={rowHandlers}
        onPickExample={setInputText}
      />

      <AgentEventLog />
      <ThinkingStrip messages={chat.messages} streaming={streaming} />
      {cloud.accountMode ? <CloudQueueList queue={view.queue} messages={chat.messages} senders={view.senders} /> :
        <QueueList tabId={qKey} running={view.streaming} onInsert={insertQueued} onEdit={editQueued} onResume={resumeQueue} hasDraft={hasDraft} />}

      {chat.notice && (
        <div className="ai-toast" data-pc="cloud-notice" role="alert" onClick={chat.clearNotice} title="点一下关掉">{chat.notice}</div>
      )}
      <div className="pc-cloud-note" data-pc="cloud-note">{cloud.accountMode && chat.info?.executorMounted !== true ? '消息会持久排队，等待执行服务；重新打开可接着看。' : '在云端运行,关闭后继续;重新打开可接着看'}</div>

      {creatorReadOnly ? <div className="pc-cloud-readonly" data-pc="cloud-readonly-note">
        项目创建者可以查看这段私有对话，但不能发送消息。
        {canStopCurrentRun && <button type="button" className="pc-cloud-control-btn" data-pc="cloud-stop-readonly" onClick={handleStop}>停止当前一轮</button>}
      </div> : !metadataReady ? <div className="pc-cloud-readonly" data-pc="cloud-permission-wait">正在确认对话权限，确认前暂不能发送。</div> : <Composer
        text={inputText}
        onTextChange={setInputText}
        textareaRef={textareaRef}
        attachments={attachments}
        uploading={false}
        onPickFiles={() => fileInputRef.current?.click()}
        onRetryAttachment={(id) => retryAttachment(id)}
        onRemoveAttachment={removeAttachment}
        onSubmit={handleSend}
        onStop={handleStop}
        streaming={streaming}
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
          canDiagnose: chat.messages.length > 0,
          onOpenDiagnostics: openDiagnostics,
          onNewChat: () => chat.newChat(),
        }}
        cloud={{
          show: true,
          selected: true,
          onSelect: () => {},
          onLeave: (p) => { if (desktop) { leaveCloudTab(tabId); desktop.onLeave(p); } },
          toolbar: <CloudModelBar info={chat.info} model={chat.model} onModel={chat.setModel} disabled={streaming} tabId={tabId} />,
          attachTitle: CLOUD_ATTACH_TITLE,
        }}
      />}
      <input type="file" ref={fileInputRef} data-pc="cloud-attach-input" accept={CLOUD_ATTACH_ACCEPT} multiple style={{ display: "none" }} onChange={handleFileChange} />

      <ReportDialog
        open={diagOpen}
        title="云端对话诊断报告"
        label="云端对话诊断"
        hint="含这段云端对话的过程、出错原因和客户端信息;不含票据、委托、模型 Key 或任何凭证"
        text={diagReport}
        onClose={() => setDiagOpen(false)}
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
