import React, { useRef, useLayoutEffect } from "react";
import type { ChatMessage } from "../../../ai/types";
import type { OrchestrationState } from "../../../ai/orchestrateGraph";
import type { useInstallJobs } from "../../../ai/sttInstallStore";
import { UserBubble, type RewindHandlers } from "./UserBubble";
import { AgentBubble } from "./AgentBubble";
import { OrchestrationBlock } from "../OrchestrationBlock";
import { RoleAvatar } from "../RoleAvatar";
import { playEnter } from "../../enterMotion";
import type { ViewMode } from "./viewPrefs";
import "./chat.css";

/** 工具方块 / 工具详情的展开回调。AiPanel 里经 ref 中转,引用永远不变 */
export interface RowHandlers {
  toggleTool: (key: string) => void;
  toggleChip: (key: string) => void;
  toggleRun: (key: string) => void;
}

/** 一条消息里属于它自己的展开状态:key 都以 `<消息id>:` 开头,取出来拼成字符串好做浅比较 */
function keysFor(set: Set<string>, id: string): string {
  const prefix = id + ":";
  const out: string[] = [];
  for (const k of set) if (k.startsWith(prefix)) out.push(k);
  return out.sort().join("|");
}

/** 两轮之间隔了这么久,就在中间插一行时间 */
const TIME_GAP_MS = 5 * 60 * 1000;
/** 一次提交里新冒出来超过这么多条,就当是整段换进来的(打开历史会话),不放入场动画 */
const MAX_ENTER_ROWS = 2;

/**
 * 一条消息大概发生在什么时候。助手消息有 startedAt;用户消息没有,
 * 但它的 id 就是发送那一刻的 Date.now()(分工模式的是 `时间戳-任务id`,parseInt 取得到前缀)。
 * 只认像毫秒时间戳的数,别把随手起的短 id 当成 1970 年。
 */
function timeOf(m: ChatMessage): number | null {
  if (typeof m.startedAt === "number") return m.startedAt;
  const n = parseInt(m.id, 10);
  return Number.isFinite(n) && n > 1e12 ? n : null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 时间分隔行的写法:M月D日 HH:mm */
function formatStamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

interface MessageRowProps {
  m: ChatMessage;
  view: ViewMode;
  showThinking: boolean;
  installJobs: ReturnType<typeof useInstallJobs>;
  expanded: Set<string>;
  openRuns: Set<string>;
  /** 这条消息自己的展开 key(见 keysFor):memo 只看它,别的消息点开点收不牵动这一条 */
  openKeys: string;
  runKeys: string;
  /** 稳定引用的回调(AiPanel 里用 ref 中转),不然每次渲染都是新函数、memo 白做 */
  on: RowHandlers;
  /** 用户气泡上「回退到这里」的回调,同样是稳定引用;不给就不显示回退入口 */
  rewind?: RewindHandlers;
}

/**
 * 一条消息的气泡(连同左边的头像)。
 *
 * 为什么单独成组件并 memo:Agent 一轮几百次工具调用,每个流式片段都 setMessages 一次;
 * 以前整个列表在 AiPanel 里 map 出来,每个片段都把**所有**历史消息重渲一遍(重新 partsOf、
 * renderMarkdown、JSON.stringify),历史到 1200 次工具时实测每片段 114 ms,界面卡死。
 * 流式只换最后一条的对象,其余消息引用不变 —— memo 之后它们一次都不重渲。
 */
const MessageRow = React.memo(function MessageRow(props: MessageRowProps) {
  const { m } = props;
  // 用户消息靠右、不放头像
  if (m.role === "user") {
    return (
      <div className="ai-row ai-row--user" data-pc-msg={m.id}>
        <UserBubble m={m} rewind={props.rewind} />
      </div>
    );
  }
  // Agent 消息靠左:28px 圆形头像 + 气泡。分工模式下有 roleId,头像按角色取色取字;普通对话就是「AI」
  return (
    <div className="ai-row ai-row--assistant" data-pc-msg={m.id}>
      <span className="ai-row-avatar">
        {m.roleId ? <RoleAvatar roleId={m.roleId} size={28} /> : <span className="ai-avatar-ai" aria-hidden="true">AI</span>}
      </span>
      <AgentBubble
        m={m}
        view={props.view}
        showThinking={props.showThinking}
        installJobs={props.installJobs}
        expanded={props.expanded}
        openRuns={props.openRuns}
        on={props.on}
      />
    </div>
  );
}, (a, b) =>
  a.m === b.m && a.view === b.view && a.showThinking === b.showThinking && a.installJobs === b.installJobs &&
  a.openKeys === b.openKeys && a.runKeys === b.runKeys && a.on === b.on && a.rewind === b.rewind
);

export interface MessageListProps {
  messages: ChatMessage[];
  view: ViewMode;
  showThinking: boolean;
  installJobs: ReturnType<typeof useInstallJobs>;
  expanded: Set<string>;
  openRuns: Set<string>;
  rowHandlers: RowHandlers;
  orchestration: OrchestrationState | null;
  /** 空对话时点了示例句:把那句填进输入框 */
  onPickExample: (text: string) => void;
  /** 用户气泡上「回退到这里」的回调(稳定引用,见 UserBubble 的 RewindHandlers);不给就不显示回退入口 */
  rewind?: RewindHandlers;
}

/** 消息滚动区:贴底跟随、编排折叠块的插入位置、两轮之间的时间分隔都在这里 */
export function MessageList(props: MessageListProps) {
  const { messages, view, showThinking, installJobs, expanded, openRuns, rowHandlers, orchestration, onPickExample, rewind } = props;
  const messagesScrollRef = useRef<HTMLDivElement>(null);

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

  /*
   * 新消息淡入、上浮一点(enterMotion)。只给「刚追加进来」的一两条放:第一次渲染时已有的历史、
   * 打开历史会话一口气换进来的整段都不演 —— 几十条一起动既看不清也白花力气。
   * 见过的 id 记下来,之后流式更新、分页切回来都不再放。
   */
  const seenIds = useRef<Set<string> | null>(null);
  useLayoutEffect(() => {
    const seen = seenIds.current;
    if (!seen) {
      seenIds.current = new Set(messages.map((m) => m.id));
      return;
    }
    const fresh: string[] = [];
    for (const m of messages) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      fresh.push(m.id);
    }
    const box = messagesScrollRef.current;
    if (!box || fresh.length === 0 || fresh.length > MAX_ENTER_ROWS) return;
    for (const id of fresh) playEnter(box.querySelector(`[data-pc-msg="${CSS.escape(id)}"]`), "pc-enter-rise");
  }, [messages]);

  // 编排折叠块插在「最后一条用户消息」后面。编排发生在提问之后、角色回复之前，
  // 放这个位置读下来才是「提问 → 怎么分的工 → 各角色的回复」。挂在消息流末尾的话
  // 它会排到自己产出的那些回复下面，因果顺序是反的。
  const lastUserIdx = orchestration ? messages.map((m) => m.role).lastIndexOf("user") : -1;

  /** 到上一条为止最晚的时间点;新一轮(用户消息)离它超过 TIME_GAP_MS 就插时间行 */
  let lastAt: number | null = null;

  return (
    <div className="ai-messages" ref={messagesScrollRef} onScroll={onMessagesScroll}>
      {messages.length === 0 ? (
        <div className="ai-empty-state">
          <button type="button" className="ai-empty-example" onClick={() => onPickExample("时间轴上现在有什么?")}>
            时间轴上现在有什么?
          </button>
          <button type="button" className="ai-empty-example" onClick={() => onPickExample("把 3 到 8 秒做一张金句卡，文字是...")}>
            把 3 到 8 秒做一张金句卡，文字是...
          </button>
          <button type="button" className="ai-empty-example" onClick={() => onPickExample("根据我刚导入的视频做字幕")}>
            根据我刚导入的视频做字幕
          </button>
        </div>
      ) : (
        // 每条消息返回一个数组而不是包一层 Fragment:前后要插时间行、编排块,
        // key 各自独立,插进去不会让 MessageRow 换位置重挂(memo 和展开状态都保得住)
        messages.map((m, i) => {
          const at = timeOf(m);
          const stamp =
            m.role === "user" && at !== null && lastAt !== null && at - lastAt >= TIME_GAP_MS
              ? <div key={`${m.id}:time`} className="ai-time-sep">{formatStamp(at)}</div>
              : null;
          const end = typeof m.finishedAt === "number" ? m.finishedAt : at;
          if (end !== null) lastAt = lastAt === null ? end : Math.max(lastAt, end);
          return [
            stamp,
            <MessageRow
              key={m.id}
              m={m}
              view={view}
              showThinking={showThinking}
              installJobs={installJobs}
              expanded={expanded}
              openRuns={openRuns}
              openKeys={keysFor(expanded, m.id)}
              runKeys={keysFor(openRuns, m.id)}
              on={rowHandlers}
              rewind={rewind}
            />,
            i === lastUserIdx && orchestration
              ? <OrchestrationBlock key={`${m.id}:orch`} state={orchestration} />
              : null,
          ];
        })
      )}
    </div>
  );
}
