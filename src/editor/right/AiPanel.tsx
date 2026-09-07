import React, { useRef, useState, useEffect, useLayoutEffect } from "react";
import "./AiPanel.css";
// 公式样式表:renderMarkdown 用 KaTeX 渲染数学,样式在这里一次性引入
import "katex/dist/katex.min.css";
import { useAiChat } from "../../ai/useAiChat";
import { renderMarkdown } from "../../ai/Markdown";
import type { ChatAttachment, ChatMessage, MessagePart, ToolCallInfo } from "../../ai/types";
import { conversationReport, copyDebugReport } from "../../ai/debug";
import { AiSetupDialog } from "./AiSetupDialog";
import { useChatHistory } from "../../ai/useChatHistory";
import { SttInstallProgress } from "./SttInstallProgress";
import { useInstallJobs, matchInstallJob } from "../../ai/sttInstallStore";
import { useToolbarLayout, MORE_KEY } from "./useToolbarLayout";
import { isTeamMode, setTeamMode, subscribeTeamMode } from "../../ai/teamMode";
import { RoleHeader } from "./RoleAvatar";
import { OrchestrationBlock } from "./OrchestrationBlock";
import { ToolbarOverflowMenu } from "./ToolbarOverflowMenu";
import { IconHistory, IconSettings } from "../../ui/icons";
import type { OverflowEntry } from "./ToolbarOverflowMenu";
import { ChatHistoryDrawer } from "./ChatHistoryDrawer";
import { ScriptDialog } from "./ScriptDialog";
import { ModelBar } from "./ModelBar";
import { useScript } from "../../ai/script";
import {
  kindOfName,
  newAttachmentId,
  pickSrcPath,
  acceptAttr,
  importByPath,
  uploadFile,
  waitForJob,
} from "../../ai/attachments";

/** 按附件种类返回展示图标 */
function attachIcon(kind?: string): string {
  switch (kind) {
    case "image": return "🖼";
    case "video": return "🎥";
    case "audio": return "🎵";
    case "pdf": return "📕";
    case "srt": return "💬";
    case "json": return "📋";
    case "text": return "📝";
    default: return "📎";
  }
}

/** 显示模式:简洁只看回复,详细连每一步工具调用一起看 */
type ViewMode = "simple" | "verbose";
const VIEW_KEY = "aiViewMode";
/** 「显示思考」是长期偏好,记在本地;默认关——思考是过程,不是结论 */
const THINKING_KEY = "aiShowThinking";

/**
 * 取一条消息的有序片段。新消息自带 parts;旧会话历史里没有,
 * 就按「文字 → 状态 → 工具」的老顺序兜底,保证读得出来。
 */
function partsOf(m: ChatMessage): MessagePart[] {
  if (m.parts && m.parts.length > 0) return m.parts;
  const legacy: MessagePart[] = [];
  if (m.text) legacy.push({ kind: "text", text: m.text });
  for (const s of m.statuses || []) legacy.push({ kind: "status", text: s });
  for (const t of m.tools || []) legacy.push({ kind: "tool", ...t });
  return legacy;
}

/** 顶栏上的一个控件。栏上和「⋯」菜单里渲染的是同一个 node */
type ToolbarControl = OverflowEntry;

/**
 * 顶栏放不下时往「⋯」菜单里收的顺序:排在前面的先收。
 * provider 不在表里——当前用哪个驱动是这个面板的身份,再窄也留在栏上。
 */
const OVERFLOW_ORDER = ["diag", "thinking", "team", "view", "new", "script", "auto"] as const;

/**
 * 小方块的颜色分类。
 *
 * 按「这一步对项目做了什么」分,不是按工具名字母序 —— 用户扫一眼要能看出
 * 哪几下是在删东西。读取类故意用最淡的颜色:它们数量最多但最不值得注意,
 * 满屏一样亮的话反而看不见真正的动作。
 */
type ToolKind = "add" | "remove" | "edit" | "read" | "job";

function toolKind(name: string): ToolKind {
  if (/^(remove|delete|clear)_/.test(name)) return "remove";
  if (/^(add|create|import|insert)_/.test(name)) return "add";
  if (/^(set|update|move|rename|reorder|split|trim)_/.test(name)) return "edit";
  if (/^(list|get|read|detect|search|find)_/.test(name)) return "read";
  return "job";
}

const KIND_LABEL: Record<ToolKind, string> = {
  add: "新增",
  remove: "删除",
  edit: "修改",
  read: "读取",
  job: "处理",
};

/** 简洁模式的一段:要么是一段文字,要么是连续的一串工具调用 */
type SimpleBlock =
  | { kind: "text"; text: string }
  | { kind: "tools"; tools: ToolCallInfo[] };

/**
 * 把有序片段折成简洁模式要显示的块:相邻的文字并成一段,相邻的工具并成一排方块。
 * 这样方块正好把 AI 每次开口说的话隔开,读起来是「说一句 → 做几件事 → 再说一句」。
 * status 片段在简洁模式里不显示(它们是过程噪音,详细模式仍然有)。
 */
function simpleBlocks(parts: MessagePart[]): SimpleBlock[] {
  const out: SimpleBlock[] = [];
  for (const p of parts) {
    if (p.kind === "text") {
      const last = out[out.length - 1];
      if (last?.kind === "text") last.text += p.text;
      else out.push({ kind: "text", text: p.text });
    } else if (p.kind === "tool") {
      const last = out[out.length - 1];
      if (last?.kind === "tools") last.tools.push(p);
      else out.push({ kind: "tools", tools: [p] });
    }
  }
  return out;
}

/** 正在执行、还没有结果的那个工具(有就说明这一刻在跑它) */
function runningTool(parts: MessagePart[]): ToolCallInfo | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.kind === "tool") return p.ok === undefined ? p : null;
  }
  return null;
}

/** 一条没跑完的消息:优先用内核报上来的进度,没有就退回「正在思考 / 正在执行 X」 */
function activityText(m: ChatMessage, busyTool: ToolCallInfo | null): string {
  if (m.progress?.text) return m.progress.text;
  return busyTool ? `正在执行 ${busyTool.name}` : "正在思考";
}

/** 进度里的轮次和成败,单独放一行小字;没有轮次信息(CLI 驱动)就不显示 */
function progressMeta(m: ChatMessage): string | null {
  const p = m.progress;
  if (!p?.round) return null;
  const bits = [`第 ${p.round}/${p.maxRounds ?? "?"} 轮`];
  if (p.completed || p.failed) bits.push(`成功 ${p.completed ?? 0}·失败 ${p.failed ?? 0}`);
  if (p.elapsedMs) bits.push(`${Math.floor(p.elapsedMs / 1000)} 秒`);
  return bits.join(" · ");
}

/**
 * 跑完之后的结论。completed 不显示(正常结束不用多说一句),
 * 其余几种都要让用户看见:停下来的原因不同,该做的事也不同。
 */
const OUTCOME_TEXT: Record<string, string> = {
  stalled: "检测到重复操作没有进展,已停下来。上面的总结说明了做到哪一步。",
  round_limit: "已达到本次模型往返轮数上限。已完成的修改保留,可以补充要求后继续。",
  aborted: "已由你停止。已完成的修改保留。",
};
function outcomeText(m: ChatMessage): string | null {
  if (!m.outcome || m.outcome === "completed" || m.outcome === "error") return null;
  return OUTCOME_TEXT[m.outcome] || `本次执行结束于:${m.outcome}`;
}

export function AiPanel(props: { mcpConnected: boolean; hotkeysOff?: boolean; mock?: boolean; openSetupSignal?: number }) {
  // ?aimock=1 给界面自测用:走内置假流,不需要装好任何模型后端
  const mock = props.mock ?? (() => {
    try {
      return new URLSearchParams(location.search).has("aimock");
    } catch {
      return false;
    }
  })();
  const { messages, providers, sttInfo, provider, setProvider, streaming, send, runWorkflow, workflowRoles, abort, newChat, error, setMessages, login, loginState, setupJobs, cancelSetup, install, installState, installError, config, saveConfig, setupOpen, openSetup, closeSetup, orchestration } = useAiChat({ mock });
  const history = useChatHistory({ provider, messages, sessionId: undefined });
  const installJobs = useInstallJobs();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);
  const script = useScript();
  const [inputText, setInputText] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  const [view, setView] = useState<ViewMode>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "verbose" ? "verbose" : "simple";
    } catch {
      return "simple";
    }
  });
  const [showThinking, setShowThinking] = useState(() => {
    try {
      return localStorage.getItem(THINKING_KEY) === "1";
    } catch {
      return false;
    }
  });
  /** 展开的工具详情,键是 `消息id:片段序号`。纯界面状态,不写进消息里 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());


  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 附件占位 id → 原始 File,失败重试时要用 */
  const retryFilesRef = useRef<Map<string, File>>(new Map());
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (props.openSetupSignal && props.openSetupSignal > 0) {
      openSetup();
    }
  }, [props.openSetupSignal, openSetup]);

  /**
   * 贴底跟随。
   *
   * 原来是在内容长出来之后才量「离底部还有多远」——那时候 scrollHeight 已经包含
   * 新内容了,只要这一批比阈值高,就会被判成「用户自己滚上去了」,于是再也不跟随。
   * 所以要在**内容变化之前**就把「当时在不在底部」记下来:onScroll 里维护 stickRef,
   * 那是用户最后一次表态。
   *
   * 不贴底时什么都不做 —— 内容追加在下方,scrollTop 不动,看的那一段就不动,
   * 相对位置自然保住,不会弹跳。
   */
  const stickRef = useRef(true);
  const BOTTOM_SLACK = 40;

  const onMessagesScroll = () => {
    const el = messagesScrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
  };

  // 用 layout 效果:在浏览器绘制这一帧之前就挪好,不会看到先跳后回的闪动。
  // 不给依赖数组 —— 流式输出每来一段都是一次提交,每次提交都要重新贴住。
  useLayoutEffect(() => {
    if (!stickRef.current) return;
    const el = messagesScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    const onAiError = (e: any) => setToast(e.detail);
    window.addEventListener("ai-chat-error", onAiError);
    return () => window.removeEventListener("ai-chat-error", onAiError);
  }, []);

  // 预览窗口右键卡片时会在 window 上派发 pc-quote-clip,把引用插进输入框
  useEffect(() => {
    const onQuote = (ev: Event) => {
      const d = (ev as CustomEvent).detail || {};
      const label = d.label || d.cardId || "未命名";
      const ref = `@卡片 ${label}(${d.clipId})`;
      const ta = textareaRef.current;
      const pos = ta ? (ta.selectionStart ?? ta.value.length) : -1;
      setInputText((prev) => {
        const at = pos >= 0 ? pos : prev.length;
        const before = prev.slice(0, at);
        const after = prev.slice(at);
        // 前面不是空白也不是开头,就补一个空格,免得和上一个词粘在一起
        const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
        const inserted = lead + ref + " ";
        // 重渲染之后再摆光标,让它停在引用之后
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          const caret = before.length + inserted.length;
          el.setSelectionRange(caret, caret);
        });
        return before + inserted + after;
      });
    };
    window.addEventListener("pc-quote-clip", onQuote as EventListener);
    return () => window.removeEventListener("pc-quote-clip", onQuote as EventListener);
  }, []);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const handleSend = () => {
    const pInfo = providers.find(p => p.id === provider);
    // 假流不经过任何后端,别拿登录状态挡它
    if (!mock && pInfo && pInfo.auth?.loggedIn === false) {
      setShowLoginPrompt(true);
      return;
    }
    setShowLoginPrompt(false);
    if (!inputText.trim() && attachments.length === 0) return;
    // 还在导入或导入失败的附件这次先不带上,但发送本身任何时候都不许被挡住
    const usable = attachments.filter((a) => a.status !== "importing" && a.status !== "error");
    const skipped = attachments.length - usable.length;
    if (skipped > 0) setToast(`${skipped} 个附件还在导入或导入失败,这次没带上`);
    send(inputText.trim(), usable);
    setInputText("");
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "36px";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (props.hotkeysOff) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  };

  /** 真正干活的后台导入：不 await 直接丢出去跑,跑完再回填那张卡片 */
  const runImport = (placeholderId: string, file: File, srcPath: string | null) => {
    const cid = history.conversationId;
    (async () => {
      let job: any;
      if (srcPath) {
        const init = await importByPath(cid, srcPath, file.name);
        job = init.status === "importing" ? await waitForJob(init.id) : init;
      } else {
        job = await uploadFile(cid, file);
      }
      setAttachments((prev) =>
        prev.map((a) => {
          if (a.id !== placeholderId) return a;
          if (job.status === "ready") {
            // 保留占位卡片的 id,这样重试和删除还能对得上
            return { ...a, ...job.attachment, id: placeholderId, status: "ready" as const };
          }
          return { ...a, status: "error" as const, error: job.error || job.attachment?.error || "导入失败", jobId: job.id };
        }),
      );
    })().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setAttachments((prev) => prev.map((a) => (a.id === placeholderId ? { ...a, status: "error" as const, error: msg } : a)));
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    for (const file of files) {
      const placeholderId = newAttachmentId();
      const srcPath = pickSrcPath(file);
      // 先把占位卡片插进去,这一步之前不许有任何 await,输入区一秒都不能卡
      retryFilesRef.current.set(placeholderId, file);
      setAttachments((prev) => [
        ...prev,
        { id: placeholderId, url: "", name: file.name, kind: kindOfName(file.name), bytes: file.size, srcPath, status: "importing" as const },
      ]);
      runImport(placeholderId, file, srcPath);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  const changeView = (next: ViewMode) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* 隐私模式下写不了,忽略 */
    }
  };

  const changeShowThinking = (next: boolean) => {
    setShowThinking(next);
    try {
      localStorage.setItem(THINKING_KEY, next ? "1" : "0");
    } catch {
      /* 隐私模式下写不了,忽略 */
    }
  };

  const toggleIn = (set: Set<string>, apply: (s: Set<string>) => void) => (key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    apply(next);
  };
  const toggleTool = toggleIn(expanded, setExpanded);

  // 顶栏按实测宽度排布:窄了先换行、再收文字,还不够就把低优先级的收进「⋯」
  // 分工模式的开关放在 ai/teamMode 里:编排器那边也要读它,放这儿会变成两份状态
  const [teamMode, setTeamModeState] = useState(isTeamMode);
  useEffect(() => subscribeTeamMode(setTeamModeState), []);

  /*
   * 没配 API 直连时的降级说明，折在勾选框的 tooltip 里，不再单独占一条横幅。
   *
   * 这个降级的实际后果是「该并行的偶尔没并行」：不阻断操作、不产生错误结果，
   * 用户甚至察觉不到——本来就没人知道那一次「本可以更快」。横幅是界面上最重的
   * 一档提示，该留给「挡住你做事」或「结果可能是错的」。拿它说一件「有时会慢
   * 一点」的事，代价是用户学会忽略横幅，等哪天编排真失败了那条也会被一起忽略。
   *
   * 能跑的和不能跑的要分清：/api/ai/plan 没 API 会退回 CLI，编排照跑；
   * API-only 的只有前面那道 triage 闸，它必须比 manager 便宜才有存在意义。
   * 闸不可用时退回 looseTriage：一处并列词 + 句子不太短就编排（a12fb7c 放宽的，
   * 原来的门槛实测会让 CLI 用户的分工模式静默失效）。所以提示语别说得太保守，
   * 门槛其实相当低——说成「只认明显多步」会让用户以为自己那句话不够格。
   */
  const teamModeHint = config && !config.api.apiKey.set
    ? "复杂请求先由制片主管拆成多个任务,能并行的同时跑。没配「API 直连」时,判断值不值得分工的那道闸用不了,改用本地规则:句子里出现「然后」「分别」「同时」这类词就分工,看不出多步的按单线处理。"
    : "复杂请求先由制片主管拆成多个任务,能并行的同时跑。简单提问会自动跳过,不多花这道工序";

  // 编排折叠块插在「最后一条用户消息」后面。编排发生在提问之后、角色回复之前，
  // 放这个位置读下来才是「提问 → 怎么分的工 → 各角色的回复」。挂在消息流末尾的话
  // 它会排到自己产出的那些回复下面，因果顺序是反的。
  const lastUserIdx = orchestration ? messages.map((m) => m.role).lastIndexOf("user") : -1;

  const controlsRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const toolbar = useToolbarLayout(controlsRef, measureRef, OVERFLOW_ORDER);

  /**
   * 把这段对话连同每一步的执行事件复制成一份 JSON,出问题时直接贴给别人看。
   * 密钥和模型私有思考在 conversationReport 里已经剔掉,这里不用再处理。
   */
  const copyDiagnostics = async () => {
    if (messages.length === 0) return setToast("还没有对话可以导出");
    try {
      await copyDebugReport(conversationReport(messages, provider, config));
      const truncated = messages.some((m) => m.traceTruncated);
      setToast(truncated ? "诊断报告已复制(过大的事件已截断)" : "诊断报告已复制到剪贴板");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "复制失败");
    }
  };

  if (providers.length > 0 && !providers.some(p => p.available)) {
    return (
      <aside className="panel panel-right ai-panel">
        <div className="ai-panel-header">
          <div className="ai-panel-title">AI 助手</div>
          <button className="ai-gear-btn" title="AI 设置" aria-label="AI 设置" onClick={openSetup}><span aria-hidden="true">⚙</span><span>AI 设置</span></button>
        </div>
        <div className="ai-empty-state">
          没找到 Claude Code / agy / Codex,装好任意一个后重启本地服务
        </div>
        <AiSetupDialog
          open={setupOpen}
          onClose={() => closeSetup()}
          providers={providers}
          stt={sttInfo || undefined}
          current={provider}
          onChoose={(id) => closeSetup(id)}
          onLogin={login}
          loginState={loginState}
          setupJobs={setupJobs}
          onCancelSetup={cancelSetup}
          onInstall={install}
          installState={installState}
          installError={installError}
          config={config}
          onSaveConfig={saveConfig}
        />
      </aside>
    );
  }

  /**
   * 顶栏控件。列成数组是为了让「留在栏上」还是「收进 ⋯ 菜单」由测量结果决定,
   * 两处渲染的是同一个 node,行为完全一致。data-key 供镜像行按 key 索引宽度。
   * 以后加按钮:往这里加一项,再在 OVERFLOW_ORDER 里排个位置就行。
   */
  const controls: ToolbarControl[] = [
    {
      key: "view",
      label: "显示模式",
      showLabel: true,
      node: (
        <div className="ai-mode-toggle" role="group" aria-label="显示模式" key="view" data-key="view">
          <button className={view === "simple" ? "is-on" : ""} onClick={() => changeView("simple")} title="只看 AI 的回复">
            简洁
          </button>
          <button className={view === "verbose" ? "is-on" : ""} onClick={() => changeView("verbose")} title="连每一步操作一起看">
            详细
          </button>
        </div>
      ),
    },
    {
      key: "thinking",
      label: "显示思考",
      node: (
        <label
          key="thinking"
          data-key="thinking"
          className="ai-thinking-toggle"
          title="显示模型的思考过程(有的驱动方式不产出思考,勾了也不会有内容)"
        >
          <input
            type="checkbox"
            checked={showThinking}
            onChange={(e) => changeShowThinking(e.target.checked)}
          />
          <span className="ai-btn-label">显示思考</span>
        </label>
      ),
    },
    {
      key: "team",
      label: "分工模式",
      node: (
        <label
          key="team"
          data-key="team"
          className="ai-thinking-toggle"
          title={teamModeHint}
        >
          <input
            type="checkbox"
            checked={teamMode}
            onChange={(e) => setTeamMode(e.target.checked)}
          />
          <span className="ai-btn-label">分工模式</span>
        </label>
      ),
    },
    {
      key: "diag",
      label: "复制诊断报告",
      node: (
        <button
          key="diag"
          data-key="diag"
          className="ai-gear-btn"
          title="把这段对话和每一步执行事件复制成 JSON(不含密钥)"
          aria-label="复制诊断报告"
          onClick={copyDiagnostics}
          disabled={messages.length === 0}
        >
          <span aria-hidden="true">⎘</span><span className="ai-btn-label">诊断</span>
        </button>
      ),
    },
    {
      key: "provider",
      label: "驱动方式",
      showLabel: true,
      node: (
        <select
          key="provider"
          data-key="provider"
          className="ai-provider-select"
          aria-label="AI 驱动方式"
          value={provider || ""}
          onChange={e => setProvider(e.target.value as any)}
        >
          {providers.map(p => (
            <option key={p.id} value={p.id} disabled={!p.available} title={p.available ? "" : "未安装"}>
              {p.label || (p.id === "claude" ? "Claude Code" : p.id === "agy" ? "Antigravity" : p.id === "codex" ? "Codex" : p.id)}
            </option>
          ))}
        </select>
      ),
    },
    {
      key: "script",
      label: "剧本",
      node: (
        <button
          key="script"
          data-key="script"
          className="ai-new-chat-btn"
          title={script ? `剧本已写 ${script.length} 字，每轮都会附给 AI` : "写下这条片子要讲什么，AI 每轮都会照着它做"}
          onClick={() => setScriptOpen(true)}
        >
          剧本{script ? " ●" : ""}
        </button>
      ),
    },
    {
      key: "auto",
      label: "一键配特效",
      node: (
        <button
          key="auto"
          data-key="auto"
          className="ai-new-chat-btn"
          title={`依次跑：${workflowRoles.map((r) => r.name).join(" → ")}`}
          disabled={streaming}
          onClick={() => void runWorkflow()}
        >
          一键配特效
        </button>
      ),
    },
    {
      key: "new",
      label: "新对话",
      node: (
        <button key="new" data-key="new" className="ai-new-chat-btn" onClick={() => { newChat(); history.startNewChat(); }}>
          新对话
        </button>
      ),
    },
  ];

  return (
    <aside className="panel panel-right ai-panel">
      <div className="ai-panel-header">
        <div className="ai-panel-title">
          <span>AI 助手</span>
          <div
            className={`ai-status-dot ${props.mcpConnected ? "is-connected" : ""}`}
            title={props.mcpConnected ? "已连接编辑台 MCP" : "未连接编辑台 MCP"}
          />
          <span className="ai-status-text">{props.mcpConnected ? "已连接" : "未连接"}</span>
        </div>
        {/* 标题行右侧两个图标钮(配色诊断与修正 v2):历史对话、AI 设置。它们不再挤在胶囊行里 */}
        <div className="ai-title-actions">
          <button
            type="button"
            className="ai-icon-btn"
            title="历史对话"
            aria-label="历史对话"
            onClick={() => {
              setHistoryOpen(true);
              history.refresh();
            }}
          >
            <IconHistory size={13} />
          </button>
          <button type="button" className="ai-icon-btn" title="AI 设置" aria-label="AI 设置" onClick={openSetup}>
            <IconSettings size={13} />
          </button>
        </div>
        <div
          className={`ai-panel-controls${toolbar.compact ? " is-compact" : ""}`}
          ref={controlsRef}
          data-rows={toolbar.rows}
        >
          {controls.filter(c => !toolbar.hidden.has(c.key)).map(c => c.node)}
          <ToolbarOverflowMenu entries={controls.filter(c => toolbar.hidden.has(c.key))} />
        </div>
        {/*
          量宽度用的镜像行:始终渲染全部控件(包括此刻待在「⋯」菜单里的),
          所以面板一变宽就知道谁放得回去。它 aria-hidden + inert,不进无障碍树、
          不抢焦点,position:absolute 不占布局。
        */}
        <div
          className={`ai-panel-controls ai-toolbar-measure${toolbar.compact ? " is-compact" : ""}`}
          ref={measureRef}
          aria-hidden="true"
          inert
        >
          {controls.map(c => c.node)}
          <button type="button" className="ai-gear-btn ai-more-btn" data-key={MORE_KEY}>
            <span aria-hidden="true">⋯</span>
          </button>
        </div>
      </div>

      {(() => {
        const pInfo = providers.find(p => p.id === provider);
        if (!pInfo) return null;
        if (pInfo.auth?.loggedIn === false) {
          const st = provider ? loginState[provider] : undefined;
          return (
            <div className="ai-banner">
              <span>{showLoginPrompt ? "请先登录再发送" : `${pInfo.label} 还没登录`}</span>
              <button 
                className="ai-banner-btn" 
                onClick={() => { if(provider) login(provider); setShowLoginPrompt(false); }}
                disabled={st === "waiting"}
              >
                {st === "waiting" ? "登录窗口已打开,等你完成…" : st === "timeout" ? "登录超时,可以再试一次" : "去登录"}
              </button>
            </div>
          );
        }
        if (pInfo.auth?.loggedIn === null && pInfo.auth.fixHint) {
          return (
            <div className="ai-banner">
              {pInfo.auth.fixHint}
            </div>
          );
        }
        return null;
      })()}


      <div className="ai-messages" ref={messagesScrollRef} onScroll={onMessagesScroll}>
        {messages.length === 0 ? (
          <div className="ai-empty-state">
            <div className="ai-empty-example" onClick={() => setInputText("时间轴上现在有什么?")}>
              时间轴上现在有什么?
            </div>
            <div className="ai-empty-example" onClick={() => setInputText("把 3 到 8 秒做一张金句卡，文字是...")}>
              把 3 到 8 秒做一张金句卡，文字是...
            </div>
            <div className="ai-empty-example" onClick={() => setInputText("根据我刚导入的视频做字幕")}>
              根据我刚导入的视频做字幕
            </div>
          </div>
        ) : (
          messages.map((m, i) => {
            // 「转圈 + 正在做什么」跟着 m.pending 走，不再要求它是最后一条。
            // 分工模式下同一批角色的气泡是同时 pending 的，按「最后一条」判的话
            // 只有最下面那个有动静，上面几个看着像卡死了。
            //
            // 单线模式下同时只可能有一条 pending，两种写法等价；abort() 会把所有
            // pending 一起清掉(useAiChat.ts:335)，不会留下永远转圈的旧气泡。
            const parts = partsOf(m);
            /** 简洁模式下把几段思考按顺序拼起来一次显示;详细模式仍按原位置逐段渲染 */
            const thinkingText = parts
              .filter((p) => p.kind === "thinking")
              .map((p) => (p as { text: string }).text)
              .join("\n\n");
            const busyTool = m.pending ? runningTool(parts) : null;

            /** 一个工具片段:标题行 + 可展开的入参 / 结果 / 文件 */
            const renderTool = (t: ToolCallInfo, key: string) => {
              const open = expanded.has(key);
              const done = t.ok !== undefined;
              // 装引擎要下好几百 MB、可能跑几分钟。折成一行「stt_install ✓」的话,
              // 用户看到的就是聊天框里一个转圈的小字,不知道在干什么、还要多久。
              // 这里换成带进度的控件,和启动时那个缺依赖提示用的是同一个。
              const installJob = t.name === "stt_install" ? matchInstallJob(t, installJobs) : undefined;
              if (installJob) {
                return <SttInstallProgress key={key} job={installJob} compact />;
              }
              return (
                <div key={key} className="ai-tool-block">
                  <div
                    className={`ai-tool-chip ${t.ok === true ? "ok" : t.ok === false ? "err" : ""}`}
                    onClick={() => toggleTool(key)}
                  >
                    {done ? (t.ok ? "✓" : "✗") : <span className="ai-spinner" aria-hidden />}
                    <span className="ai-tool-name">{t.name}</span>
                    <span className="ai-tool-caret">{open ? "▾" : "▸"}</span>
                  </div>
                  {open && (
                    <div className="ai-tool-detail">
                      <div className="ai-tool-label">入参</div>
                      <pre className="ai-tool-pre">{JSON.stringify(t.input || {}, null, 2)}</pre>
                      {t.summary ? (
                        <>
                          <div className="ai-tool-label">结果</div>
                          <pre className="ai-tool-pre wrap">{t.summary}</pre>
                        </>
                      ) : null}
                      {t.files && t.files.length > 0 ? (
                        <div className="ai-tool-files">
                          {t.files.map((f, fidx) => {
                            const lower = f.toLowerCase();
                            const isImg =
                              lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg");
                            if (!isImg) {
                              return (
                                <div key={fidx} className="ai-tool-file">
                                  {f}
                                </div>
                              );
                            }
                            const url =
                              f.startsWith("http") || f.startsWith("data:")
                                ? f
                                : `/@fs/${f.replace(/\\/g, "/").replace(/^\/?/, "")}`;
                            return (
                              <div key={fidx}>
                                <img
                                  src={url}
                                  className="ai-tool-img"
                                  alt={f}
                                  onError={(e) => {
                                    e.currentTarget.style.display = "none";
                                    if (e.currentTarget.nextSibling) return;
                                    const span = document.createElement("div");
                                    span.className = "ai-tool-file";
                                    span.textContent = f;
                                    e.currentTarget.parentElement?.appendChild(span);
                                  }}
                                />
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            };

            // 返回数组而不是包一层 Fragment：只为了在某条消息后面多插一个块，
            // 就把整个气泡往里缩一级、几百行全部重新缩进，blame 会脏得看不出改了什么。
            return [
              <div key={m.id} className={`ai-message ${m.role}`}>
                {/*
                  这条回复是哪个角色产出的。普通对话没有 roleId 就不显示——
                  每条回复顶上都挂一个「AI 助手」只是噪音，反而让分工模式下
                  真正的角色名不显眼。
                */}
                {m.roleId && <RoleHeader roleId={m.roleId} />}
                {m.attachments && m.attachments.length > 0 && (
                  <div className="ai-message-attach">[附件: {m.attachments.map((a) => a.name).join(", ")}]</div>
                )}

                {view === "verbose" && m.role === "assistant" ? (
                  // 详细模式:按真实发生顺序渲染,文字和工具交错,回复不会被工具块埋掉
                  parts.map((p, pidx) => {
                    if (p.kind === "text") {
                      if (!p.text) return null;
                      return (
                        <div key={pidx} className="ai-message-text">
                          {renderMarkdown(p.text)}
                        </div>
                      );
                    }
                    if (p.kind === "status") {
                      return (
                        <div key={pidx} className="ai-tool-chip info">
                          信息: {p.text}
                        </div>
                      );
                    }
                    if (p.kind === "thinking") {
                      return showThinking ? (
                        <div key={pidx} className="ai-thinking">
                          <div className="ai-thinking-head">思考</div>
                          {p.text}
                        </div>
                      ) : null;
                    }
                    return renderTool(p, `${m.id}:${pidx}`);
                  })
                ) : (
                  // 简洁模式:只给回复正文;做过的操作折成一行,想看再展开
                  <>
                    {/* 勾了「显示思考」的话简洁模式也要看得到,否则等于开关在这个模式下失灵。
                        这里按发生顺序拼成一段放在回复之前——先想后答,读起来是顺的。 */}
                    {showThinking && thinkingText && (
                      <div className="ai-thinking">
                        <div className="ai-thinking-head">思考</div>
                        {thinkingText}
                      </div>
                    )}
                    {m.role === "user" ? (
                      <div className="ai-message-text">{renderMarkdown(m.text)}</div>
                    ) : (
                      // 按发生顺序铺:说一句 → 做几件事(一排小方块)→ 再说一句。
                      // 方块自然把每次返回的句子隔开,也让用户看见条目在往外冒,
                      // 不会以为卡住了。
                      simpleBlocks(parts).map((b, bi) => {
                        if (b.kind === "text") {
                          return b.text.trim() ? (
                            <div key={bi} className="ai-message-text">{renderMarkdown(b.text)}</div>
                          ) : null;
                        }
                        return (
                          <div key={bi} className="ai-chiprow">
                            {b.tools.map((t, ti) => {
                              const key = `${m.id}:c${bi}:${ti}`;
                              // 装引擎那种几分钟的活儿不折成方块,它有自己的进度条
                              const job = t.name === "stt_install" ? matchInstallJob(t, installJobs) : undefined;
                              if (job) return <SttInstallProgress key={key} job={job} compact />;
                              const state = t.ok === undefined ? "run" : t.ok ? "ok" : "err";
                              return (
                                <button
                                  key={key}
                                  type="button"
                                  className={`ai-chip ai-chip--${toolKind(t.name)} is-${state}${expanded.has(key) ? " is-open" : ""}`}
                                  title={`${KIND_LABEL[toolKind(t.name)]}：${t.name}${t.ok === false ? "（失败）" : t.ok === undefined ? "（进行中）" : ""}`}
                                  aria-label={`${t.name} ${state === "err" ? "失败" : state === "run" ? "进行中" : "成功"}`}
                                  onClick={() => toggleTool(key)}
                                />
                              );
                            })}
                            {/* 点开的那几个把完整详情摊在这一排下面 */}
                            {b.tools.map((t, ti) => {
                              const key = `${m.id}:c${bi}:${ti}`;
                              return expanded.has(key) ? (
                                <div key={`d${key}`} className="ai-chip-detail">{renderTool(t, key)}</div>
                              ) : null;
                            })}
                          </div>
                        );
                      })
                    )}
                  </>
                )}

                {m.pending && (
                  <div className="ai-activity" role="status" aria-live="polite">
                    <span className="ai-spinner" aria-hidden />
                    <span className="ai-activity-text">{activityText(m, busyTool)}</span>
                    <span className="ai-activity-dots" aria-hidden>
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                )}
                {m.pending && progressMeta(m) && (
                  <div className="ai-activity-meta">{progressMeta(m)}</div>
                )}

                {m.error && <div className="ai-message-error">{m.error}</div>}
                {!m.pending && outcomeText(m) && (
                  <div className="ai-message-outcome">{outcomeText(m)}</div>
                )}
              </div>,
              i === lastUserIdx && orchestration
                ? <OrchestrationBlock key={`${m.id}:orch`} state={orchestration} />
                : null,
            ];
          })
        )}
      </div>

      {toast && <div className="ai-toast">{toast}</div>}
      {error && <div className="ai-toast" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{error}</div>}

      <div className="ai-input-area">
        {attachments.length > 0 && (
          <div className="ai-attachments">
            {attachments.map((a, idx) => (
              <div
                key={a.id || idx}
                className={`ai-attachment-chip${a.status === "importing" ? " is-importing" : ""}${a.status === "error" ? " is-error" : ""}`}
                title={a.status === "error" ? (a.error || "导入失败") : a.name}
                onClick={() => {
                  if (a.status !== "error") return;
                  // 失败的卡片点一下重试:先变回导入中,再重新走一遍导入
                  const f = retryFilesRef.current.get(a.id || "");
                  if (!f) return;
                  setAttachments((prev) => prev.map((x) => (x.id === a.id ? { ...x, status: "importing" as const, error: undefined } : x)));
                  runImport(a.id!, f, a.srcPath ?? null);
                }}
              >
                {a.status === "importing" ? <span className="ai-spinner" aria-hidden /> : attachIcon(a.kind)}
                {" "}
                {a.name}
                {a.status === "importing" ? " · 导入中…" : a.status === "error" ? " · 导入失败,点击重试" : ""}
                <span className="ai-attachment-remove" onClick={(e) => { e.stopPropagation(); removeAttachment(idx); }}>✕</span>
              </div>
            ))}
          </div>
        )}
        
        <ModelBar provider={provider} config={config} disabled={streaming} />
        <div className="ai-input-row">
          <button className="ai-plus-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            +
          </button>
          <input 
            type="file" 
            ref={fileInputRef} 
            multiple
            accept={acceptAttr()}
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
          <textarea
            ref={textareaRef}
            className="ai-textarea"
            value={inputText}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            placeholder={uploading ? "正在导入..." : "给 AI 发消息..."}
            disabled={uploading}
          />
          <button className="ai-send-btn" onClick={streaming ? abort : handleSend}>
            {streaming ? "■" : "↑"}
          </button>
        </div>
      </div>
      
      <AiSetupDialog
        open={setupOpen}
        onClose={() => closeSetup()}
        providers={providers}
        stt={sttInfo || undefined}
        current={provider}
        onChoose={(id) => closeSetup(id)}
        onLogin={login}
        loginState={loginState}
          setupJobs={setupJobs}
          onCancelSetup={cancelSetup}
        onInstall={install}
        installState={installState}
        installError={installError}
        config={config}
        onSaveConfig={saveConfig}
      />
      <ScriptDialog open={scriptOpen} onClose={() => setScriptOpen(false)} />
      <ChatHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        items={history.history}
        loading={history.loading}
        query={history.query}
        onQueryChange={history.setQuery}
        currentId={history.conversationId}
        onPick={async (id) => {
          const loaded = await history.openChat(id);
          if (loaded) setMessages(loaded);
          setHistoryOpen(false);
        }}
        onDelete={(id) => history.removeChat(id)}
      />
    </aside>
  );
}
