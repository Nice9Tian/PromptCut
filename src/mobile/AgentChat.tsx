/**
 * 手机版 Agent 分页里一个会话的对话页(演示稿的 Agent 页:创造力、消息、操作卡片、引用标记条、输入框)。
 *
 * 业务和桌面右栏的云端对话页(`editor/right/CloudAiPanel.tsx`)是同一套:`useCloudChat` 管事件流和发送,
 * 告知确认、对话权限、停止、共有 / 私有、开始页(`useStartPage`)都沿用桌面的做法;只是画法换成演示稿的样子,
 * 并且「引用」不再往输入框里插文字,而是放在输入框上方的标记条里,发送时由 `agentView.withQuotes` 带上。
 * 手机版暂不放的:附件、模型与思考强度下拉、历史对话列表、删除对话、诊断报告(演示稿里没有这些入口,见任务报告)。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react";
import "katex/dist/katex.min.css";
import { useCloudChat, type CloudAgentState } from "../ai/cloud/useCloud";
import { CloudError, cloudConversationControlPolicy, cloudErrorText } from "../ai/cloud/cloudApi";
import { acceptCloudConsent, cloudConsentState, refreshCloudConsent, subscribeCloudConsent } from "../ai/cloud/consent";
import { setTabBusy, setTabConversation, setTabCreativity, useAgentTabs } from "../ai/agentTabs";
import { CREATIVITY_HINT, CREATIVITY_LABEL, CREATIVITY_LEVELS, projectCreativity } from "../kernel/creativity.mjs";
import { useStore } from "../store/project";
import { setAccountAgentEnabled, useSync } from "../editor/sync/syncManager";
import { CloudAgentConsentDialog } from "../editor/right/CloudAgentConsentDialog";
import { EMPTY_EXAMPLE } from "../editor/right/chat/MessageList";
import { useStartPage } from "../editor/right/chat/StartHero";
import { Icon } from "./icons";
import { useToast } from "./ui";
import { AgentRound, QuoteBar, StartHero, UserBubble } from "./agentParts";
import { addQuote, isUserBubble, ordinals, withQuotes, type QuoteRef } from "./agentView";

/** 演示稿输入框上方那排快捷提问:点一下把这句话放进输入框(不直接发送) */
const QUICKS = ["把开头的标题做得更大气一点", "给第二段加一个转场", "配一段轻松的背景音乐", "把整体节奏剪快一点"] as const;
const QUICK_LABEL = ["标题更大气", "加转场", "配乐", "剪快点"] as const;

const PLACEHOLDER = "告诉 Agent 你想怎么改…";

export function AgentChat(props: {
  tabId: string;
  /** 这一页此刻是不是用户看着的那一页(分页开着、会话标签选中) */
  shown: boolean;
  cloud: CloudAgentState;
  /** 各会话此刻有几条消息(关会话前判断要不要确认) */
  counts: MutableRefObject<Map<string, number>>;
}) {
  const { tabId, shown, cloud, counts } = props;
  const toast = useToast();
  const creator = useSync((s) => s.shared?.creator === true);
  const consent = useSyncExternalStore(subscribeCloudConsent, cloudConsentState, cloudConsentState);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const chat = useCloudChat({ tabId, cloud, enabled: true, autoAttach: true });
  const { view } = chat;
  const { tabs } = useAgentTabs();
  const tab = tabs.find((t) => t.id === tabId);
  const isDraft = tab?.draft === true;
  const projectLevel = useStore((s) => projectCreativity(s.project));
  const level = tab?.creativity ?? projectLevel;

  const qKey = cloud.accountMode ? `cloud:${tabId}:${cloud.accountId ?? "none"}:${consent.bindingVersion}:${cloud.projectId ?? "none"}` : `cloud:${tabId}`;
  const keyRef = useRef(qKey);
  keyRef.current = qKey;
  const stillCurrent = () => keyRef.current === qKey && (!cloud.accountMode ||
    (cloudConsentState().accountId === cloud.accountId && cloudConsentState().bindingVersion === consent.bindingVersion));

  /* ---------- 告知确认(同桌面) ---------- */
  useEffect(() => {
    if (!shown || !cloud.accountMode || !cloud.available || !cloud.projectId || !consent.accountId || consent.accountId !== cloud.accountId) return;
    let dead = false;
    void refreshCloudConsent().then(
      (accepted) => { if (!dead) setConsentOpen(!accepted && cloudConsentState().accepted !== true); },
      (error) => { if (!dead && cloudConsentState().accepted !== true) setConsentError(error instanceof Error ? error.message : "云端账号暂时不可用。"); },
    );
    return () => { dead = true; };
  }, [shown, cloud.accountMode, cloud.available, cloud.projectId, cloud.accountId, consent.accountId, consent.bindingVersion]);
  useEffect(() => { if (cloud.accountMode) { setConsentOpen(false); setConsentError(null); } }, [cloud.accountMode, qKey]);
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
  const acceptConsent = () => {
    void acceptCloudConsent().then(
      () => { if (stillCurrent()) { setConsentError(null); setConsentOpen(false); } },
      (error) => { if (stillCurrent()) setConsentError(error instanceof Error ? error.message : "云端账号暂时不可用。"); },
    );
  };

  /* ---------- 会话状态:对话号、忙不忙、权限 ---------- */
  useEffect(() => { setTabConversation(tabId, chat.conversationId); }, [tabId, chat.conversationId, isDraft]);
  const currentMeta = chat.history.items.find((item) => item.id === chat.conversationId) ?? null;
  const policy = cloudConversationControlPolicy({
    accountMode: cloud.accountMode, accountId: cloud.accountId, creator, conversation: currentMeta,
    queue: view.queue, senders: view.senders, legacyStreaming: view.streaming,
  });
  const streaming = policy.streaming;
  const currentRunId = policy.currentRunId;
  const creatorReadOnly = policy.creatorReadOnly;
  useEffect(() => { setTabBusy(tabId, streaming); }, [tabId, streaming, isDraft]);
  useEffect(() => () => setTabBusy(tabId, false), [tabId]);

  const [metadataReadyKey, setMetadataReadyKey] = useState("");
  const metadataKey = `${qKey}:${chat.conversationId}:${cloud.enabled ? "on" : "off"}:${chat.info?.enabled === false ? "off" : "on"}`;
  const metadataReady = !cloud.accountMode || chat.history.loaded || metadataReadyKey === metadataKey;
  useEffect(() => {
    if (!cloud.accountMode) return;
    let live = true;
    setMetadataReadyKey("");
    void chat.history.refresh(false, 2000).then((ok) => { if (live && ok) setMetadataReadyKey(metadataKey); });
    return () => { live = false; };
  }, [cloud.accountMode, consent.accepted, chat.conversationId, chat.history.refresh, metadataKey]);
  const hasMessages = chat.messages.length > 0;
  useEffect(() => {
    if (!cloud.accountMode || !hasMessages) return;
    let live = true;
    void chat.history.refresh().then((ok) => { if (live && ok) setMetadataReadyKey(metadataKey); });
    return () => { live = false; };
  }, [cloud.accountMode, consent.accepted, chat.conversationId, hasMessages, chat.history.refresh, metadataKey]);
  useEffect(() => { counts.current.set(tabId, chat.messages.length); }, [counts, tabId, chat.messages.length]);
  useEffect(() => () => { counts.current.delete(tabId); }, [counts, tabId]);

  const off = !cloud.enabled || chat.info?.enabled === false;
  const [enabling, setEnabling] = useState(false);

  /* ---------- 输入框、引用标记条、开始页 ---------- */
  const [inputText, setInputText] = useState("");
  const [quotes, setQuotes] = useState<QuoteRef[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const focusInput = () => requestAnimationFrame(() => taRef.current?.focus());
  const start = useStartPage(tabId, inputText, setInputText, focusInput, hasMessages);
  useEffect(() => {
    if (!cloud.accountMode) return;
    setInputText("");
    setQuotes([]);
  }, [cloud.accountMode, qKey]);
  // 输入框随内容长高(最多约五行)
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [inputText, shown]);
  // 选中一项后点「引用」(或预览右键「引用到 AI」):同一个 `pc-quote-clip` 事件,放进标记条而不是输入框
  useEffect(() => {
    if (!shown) return;
    const onQuote = (ev: Event) => {
      const d = ((ev as CustomEvent).detail || {}) as { clipId?: unknown; label?: unknown; cardId?: unknown };
      const id = typeof d.clipId === "string" ? d.clipId : "";
      if (!id) return;
      const label = typeof d.label === "string" && d.label ? d.label : typeof d.cardId === "string" && d.cardId ? d.cardId : "未命名";
      setQuotes((prev) => addQuote(prev, { id, label }));
      focusInput();
    };
    window.addEventListener("pc-quote-clip", onQuote as EventListener);
    return () => window.removeEventListener("pc-quote-clip", onQuote as EventListener);
  }, [shown]);

  /* ---------- 发送与停止 ---------- */
  const sendNow = async (text: string, staged: string | null): Promise<boolean> => {
    if (off || !stillCurrent() || !policy.canSend || view.revoked) {
      if (staged) chat.failStaged(staged, "现在不能在这个对话里发消息。");
      return false;
    }
    const ok = await chat.send(text, undefined, staged ?? undefined);
    return stillCurrent() && ok;
  };
  const stick = useRef(true);
  const handleSend = async () => {
    const body = inputText.trim();
    if (!body) { taRef.current?.focus(); return; }
    if (creatorReadOnly || view.revoked) return;
    if (off) { chat.notify(cloudErrorText("disabled")); return; }
    // 开始页上点发送:这时才建第一个会话,这条消息在里面发出去
    start.commit();
    const text = withQuotes(body, quotes);
    const sentQuotes = quotes;
    const sentInput = inputText;
    stick.current = true;
    if (cloud.accountMode) {
      // 账号模式:点发送当场在对话里出气泡、清空输入框(乐观显示);没发出去时气泡标「没有发出去」,原文放回输入框
      const staged = chat.stage(text);
      setInputText((prev) => (prev === sentInput ? "" : prev));
      setQuotes((prev) => (prev === sentQuotes ? [] : prev));
      const restore = () => {
        if (!stillCurrent()) return;
        setInputText((prev) => prev || body);
        setQuotes((prev) => (prev.length ? prev : sentQuotes));
      };
      if (!await consentForUse() || !stillCurrent()) {
        if (staged) chat.failStaged(staged, "使用云端 Agent 前,请先阅读并确认告知。");
        restore();
        return;
      }
      if (!await sendNow(text, staged)) restore();
      return;
    }
    if (!await consentForUse() || !stillCurrent()) return;
    if (view.streaming) { toast("上一轮还在进行,等它结束再发"); return; }
    if (!await sendNow(text, null)) return;
    if (stillCurrent()) {
      setInputText((prev) => (prev === sentInput ? "" : prev));
      setQuotes((prev) => (prev === sentQuotes ? [] : prev));
    }
  };
  /** 同一个操作重试时沿用请求号(云端 503 一类可以安全重试) */
  const reqRef = useRef<{ key: string; id: string } | null>(null);
  const requestId = (key: string) => {
    if (reqRef.current?.key !== key) reqRef.current = { key, id: crypto.randomUUID() };
    return reqRef.current.id;
  };
  const handleStop = async () => {
    if (!cloud.accountMode) { void chat.abort(); return; }
    if (!policy.canStop || !currentRunId) { toast("只能停止自己发起的任务"); return; }
    try {
      await chat.abort(currentRunId, requestId(`stop:${currentRunId}`));
      reqRef.current = null;
      void chat.history.refresh();
    } catch (error) {
      if (stillCurrent()) chat.notify(error instanceof Error ? error.message : "停止请求没有成功,可以再点一次。");
    }
  };
  const toggleVisibility = async () => {
    if (!policy.canSwitchVisibility || !currentMeta) return;
    const target = currentMeta.visibility === "private" ? "shared" : "private";
    try {
      await chat.switchVisibility(target, requestId(`vis:${chat.conversationId}:${target}`));
      reqRef.current = null;
      await chat.history.refresh();
      if (stillCurrent()) toast(target === "private" ? "已切为私有" : "已切为共有");
    } catch (error) {
      if (stillCurrent()) chat.notify(error instanceof CloudError ? error.message : "暂时没能切换,可以再点一次。");
    }
  };

  /* ---------- 消息列表:贴底跟随 ---------- */
  const listRef = useRef<HTMLDivElement>(null);
  const onScroll = () => {
    const el = listRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  const rounds = useMemo(() => ordinals(chat.messages), [chat.messages]);
  const latestAssistant = useMemo(() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) if (chat.messages[i].role === "assistant") return chat.messages[i].id;
    return null;
  }, [chat.messages]);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && shown && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => { if (shown) { stick.current = true; const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; } }, [shown]);

  const queued = view.queue?.items.filter((i) => i.state === "queued").length ?? 0;
  const who = tab?.title ?? "Agent";
  const canSend = inputText.trim().length > 0;
  const stopMode = streaming && !canSend;
  const placeholder = quotes.length ? `@${quotes[0].label} 想怎么改?` : PLACEHOLDER;
  const visLabel = view.revoked ? "已无读取权限" : !metadataReady ? "" : currentMeta ? `${currentMeta.visibility === "private" ? "私有对话" : "共有对话"}${creatorReadOnly ? " · 创建者只读" : ""}` : "新对话 · 默认共有";
  const empty = !start.draft && !hasMessages;

  return (
    <div className="achat" data-pcm="agent-chat" data-tab={tabId} data-shown={shown ? "1" : "0"} style={shown ? undefined : { display: "none" }}>
      <CloudAgentConsentDialog open={shown && consentOpen && cloud.accountMode && Boolean(consent.accountId) && consent.accountId === cloud.accountId}
        pending={consent.pending} error={consentError} onAccept={acceptConsent} onReject={() => { setConsentError(null); setConsentOpen(false); }} />

      <div className="chat-info" data-pcm="chat-info">
        <span>创造力</span>
        <div className="level" data-pcm="creativity">
          {CREATIVITY_LEVELS.map((lv) => (
            <button key={lv} type="button" className={lv === level ? "on" : undefined} data-l={CREATIVITY_LABEL[lv]} disabled={streaming}
              title={`${CREATIVITY_LABEL[lv]}:${CREATIVITY_HINT[lv]}`} onClick={() => setTabCreativity(tabId, lv)}>{CREATIVITY_LABEL[lv]}</button>
          ))}
        </div>
        <span className="spacer" />
        {visLabel && (policy.canSwitchVisibility
          ? <button type="button" className="chip" data-pcm="vis-chip" title="点一下切换共有 / 私有" onClick={() => void toggleVisibility()}>{visLabel}</button>
          : <span className="chip" data-pcm="vis-chip">{visLabel}</span>)}
      </div>

      {!cloud.available && <div className="note" data-pcm="agent-note">这个项目所在的托管端没有云端 Agent 服务。</div>}
      {cloud.available && off && <div className="note" data-pcm="agent-note">{cloudErrorText("disabled")}
        {cloud.accountMode && creator && <button type="button" className="btn" disabled={enabling} data-pcm="agent-enable"
          onClick={() => { setEnabling(true); void setAccountAgentEnabled(true).catch((e) => chat.notify(e instanceof Error ? e.message : "暂时无法开启云端 Agent。")).finally(() => setEnabling(false)); }}>开启云端 Agent</button>}
      </div>}
      {view.connection === "reconnecting" && <div className="note" data-pcm="agent-note">和云端 Agent 的连接断了,正在重新连接。云端的这一轮仍在继续,连上后会把错过的过程补齐。</div>}
      {chat.notice && <div className="note warn" data-pcm="agent-notice" role="alert" onClick={chat.clearNotice}>{chat.notice}</div>}

      <div className="msgs" ref={listRef} onScroll={onScroll} data-pcm="chat-msgs">
        {start.draft ? (
          <StartHero animated={start.animated} onPickPreset={start.pickPreset} />
        ) : empty ? (
          <div className="empty" data-pcm="agent-empty">
            <div className="hint">这是一个新对话。想让我做点什么?</div>
            <button type="button" className="preset" data-pcm="agent-empty-example" onClick={() => { setInputText(EMPTY_EXAMPLE); focusInput(); }}>{EMPTY_EXAMPLE}</button>
          </div>
        ) : chat.messages.map((m) => (isUserBubble(m)
          ? <UserBubble key={m.id} m={m} />
          : m.role === "assistant" ? <AgentRound key={m.id} m={m} ordinal={rounds.get(m.id) ?? 1} open={m.id === latestAssistant} who={who} /> : null))}
        {queued > 0 && <div className="queue-note" data-pcm="queue-note">有 {queued} 条消息在排队,前面的做完就轮到</div>}
      </div>

      {creatorReadOnly ? (
        <div className="composer" data-pcm="agent-composer"><div className="note">项目创建者可以查看这段私有对话,但不能发送消息。</div></div>
      ) : (
        <div className="composer" data-pcm="agent-composer" data-guide={start.guide ?? undefined}>
          <QuoteBar quotes={quotes} onRemove={(id) => setQuotes((prev) => prev.filter((q) => q.id !== id))} />
          {!start.draft && (
            <div className="quicks" data-pcm="quicks">
              {QUICKS.map((q, i) => <button key={q} type="button" onClick={() => { setInputText(q); focusInput(); }}>{QUICK_LABEL[i]}</button>)}
            </div>
          )}
          <div className="in-row">
            <textarea ref={taRef} rows={1} data-pcm="chat-input" value={inputText} placeholder={placeholder} disabled={Boolean(view.revoked)}
              aria-label="告诉 Agent 你想怎么改"
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void handleSend(); } }} />
            <button type="button" className={`send${stopMode ? " is-stop" : ""}`} data-pcm={stopMode ? "chat-stop" : "chat-send"} aria-label={stopMode ? "停止" : "发送"}
              onClick={() => (stopMode ? void handleStop() : void handleSend())}><Icon name={stopMode ? "stop" : "send"} /></button>
          </div>
        </div>
      )}
    </div>
  );
}
