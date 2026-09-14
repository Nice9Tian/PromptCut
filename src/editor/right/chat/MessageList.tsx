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
import type { InboundAgentMessage } from "../../../ai/types";
import { reportsOf } from "../../../ai/progressReport";
import "./chat.css";

/**
 * 合并气泡的上限:一个组最多并这么多轮 / 前几轮合计这么多次操作,够了下一条回复就另起一组。
 * 模型或驱动一直不交本轮小结时(有些 runner、API 模型会漏),不然整段历史会并成一个不收口的组,流式时整组重算
 */
const MAX_GROUP_ROUNDS = 10;
const MAX_GROUP_TOOLS = 120;

const toolCountCache = new WeakMap<ChatMessage, number>();
function toolCount(m: ChatMessage): number {
  let v = toolCountCache.get(m);
  if (v === undefined) {
    v = m.parts ? m.parts.filter((p) => p.kind === "tool").length : (m.tools?.length ?? 0);
    toolCountCache.set(m, v);
  }
  return v;
}

/** 这条回复交没交本轮小结(final 报告)。消息对象不可变,按对象缓存,流式时不用每个片段都把整段历史的报告重新解析一遍 */
const finalCache = new WeakMap<ChatMessage, boolean>();
function hasFinalReport(m: ChatMessage): boolean {
  let v = finalCache.get(m);
  if (v === undefined) {
    v = reportsOf(m).some((r) => r.final);
    finalCache.set(m, v);
  }
  return v;
}

function sameList<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

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
  /** 这条 Agent 回复之前收到的其他 Agent 的消息;每次渲染都是新数组,memo 只看 inboundKey */
  inbound?: InboundAgentMessage[];
  /** 那几条不画出来的用户消息 id 拼起来(连同合并进来的几轮的) */
  inboundKey?: string;
  /** 合并进这个气泡的后续几轮回复(上一轮没交本轮小结就接着累计);memo 按元素逐个比 */
  followers?: ChatMessage[];
  /** followers 各自之前收到的其他 Agent 消息 */
  followerInbound?: (InboundAgentMessage[] | undefined)[];
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
        inbound={props.inbound}
        followers={props.followers}
        followerInbound={props.followerInbound}
      />
    </div>
  );
}, (a, b) =>
  a.m === b.m && a.view === b.view && a.showThinking === b.showThinking && a.installJobs === b.installJobs &&
  a.openKeys === b.openKeys && a.runKeys === b.runKeys && a.on === b.on && a.rewind === b.rewind &&
  a.inboundKey === b.inboundKey && sameList(a.followers, b.followers)
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

  /*
   * 其他 Agent 发来的消息(AiPanel 自动投递时在用户消息上带着 inbound 字段,不靠正文前缀认)不是用户说的话:
   * 不画用户气泡,交给紧跟着的那条 Agent 回复,在它的操作详细预览控件里当「收到消息」展示(行首一个对话图标)。
   * 后面暂时还没有回复可挂的,在原位留一行小字。
   */
  const inboundFor = new Map<string, { list: InboundAgentMessage[]; key: string }>();
  const inboundOnly = new Set<string>();
  const orphanNote = new Map<string, number>();
  {
    let pending: { list: InboundAgentMessage[]; ids: string[] } | null = null;
    const dropPending = () => {
      if (pending) orphanNote.set(pending.ids[pending.ids.length - 1], pending.list.length);
      pending = null;
    };
    for (const m of messages) {
      if (m.role === "user") {
        const got = m.inbound?.length ? m.inbound : null;
        if (!got) {
          dropPending();
          continue;
        }
        inboundOnly.add(m.id);
        pending = pending ? { list: [...pending.list, ...got], ids: [...pending.ids, m.id] } : { list: got, ids: [m.id] };
      } else if (pending) {
        inboundFor.set(m.id, { list: pending.list, key: pending.ids.join(",") });
        pending = null;
      }
    }
    dropPending();
  }

  /*
   * 没交本轮小结的回复,下一轮接着累计在它的气泡里(简洁模式):一组从一条 Agent 回复开始,
   * 后面的回复都并进来,直到某一轮交了 final 报告才收口,再下一条回复另起一组。
   * 分工模式里不同角色的回复不合并;一组并满 MAX_GROUP_ROUNDS 轮或前几轮合计 MAX_GROUP_TOOLS 次操作,下一条另起一组。
   * 中间用户说的话照常在原位置显示;并进去的那几条自己不再画气泡。
   */
  const followersOf = new Map<string, ChatMessage[]>();
  const followerIds = new Set<string>();
  if (view !== "verbose") {
    let leader: ChatMessage | null = null;
    let groupRounds = 0;
    let groupTools = 0;
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      if (leader && (leader.roleId ?? "") === (m.roleId ?? "") && groupRounds < MAX_GROUP_ROUNDS && groupTools < MAX_GROUP_TOOLS) {
        const list = followersOf.get(leader.id) ?? [];
        list.push(m);
        followersOf.set(leader.id, list);
        followerIds.add(m.id);
        groupRounds += 1;
        groupTools += toolCount(m);
      } else {
        leader = m;
        groupRounds = 1;
        groupTools = toolCount(m);
      }
      if (hasFinalReport(m)) leader = null;
    }
  }

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
          const hidden = inboundOnly.has(m.id) || followerIds.has(m.id);
          const at = timeOf(m);
          const stamp =
            !hidden && m.role === "user" && at !== null && lastAt !== null && at - lastAt >= TIME_GAP_MS
              ? <div key={`${m.id}:time`} className="ai-time-sep">{formatStamp(at)}</div>
              : null;
          // 不画出来的(收到的 Agent 消息、并进前面气泡的回复)也照样推进时间点,不然后面会多出时间分隔行
          const end = typeof m.finishedAt === "number" ? m.finishedAt : at;
          if (end !== null) lastAt = lastAt === null ? end : Math.max(lastAt, end);
          // 编排块挂在「最后一条用户消息」后面;那条是收到的 Agent 消息、自己不画时也照样挂,编排进度和错误才看得到
          const orch = i === lastUserIdx && orchestration ? <OrchestrationBlock key={`${m.id}:orch`} state={orchestration} /> : null;
          if (inboundOnly.has(m.id)) {
            const orphan = orphanNote.get(m.id);
            return [
              orphan ? (
                <div key={`${m.id}:inbound`} className="ai-inbound-note">
                  收到 {orphan} 条其他 Agent 的消息,等 Agent 开始处理
                </div>
              ) : null,
              orch,
            ];
          }
          // 并进前面某个气泡的那几轮:自己不画
          if (followerIds.has(m.id)) return orch;
          const followers = followersOf.get(m.id);
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
              inbound={inboundFor.get(m.id)?.list}
              inboundKey={[inboundFor.get(m.id)?.key ?? "", ...(followers ?? []).map((f) => inboundFor.get(f.id)?.key ?? "")].join("|")}
              followers={followers}
              followerInbound={followers?.map((f) => inboundFor.get(f.id)?.list)}
            />,
            orch,
          ];
        })
      )}
    </div>
  );
}
