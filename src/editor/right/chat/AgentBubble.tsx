import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { playEnter } from "../../enterMotion";
import type { ChatMessage, MessagePart, ToolCallInfo } from "../../../ai/types";
import { RoleName } from "../RoleAvatar";
import { LiveMarkdown } from "../../../ai/Markdown";
import { ToolDetail, ToolIcons, type ExtraIcon } from "./ToolIcons";
import { bareToolName, iconRuns, type IconRun } from "./iconRuns";
import { OpDetailPreview, SUMMARY_TONE_TEXT, useDetailPages, type DetailItem, type SummaryTone } from "./OpDetailPreview";
import type { InboundAgentMessage } from "../../../ai/types";
import { thinkingSteps } from "../../../ai/thinkingSteps";
import { isReportTool, parseProgressReport, type ProgressReport } from "../../../ai/progressReport";
import type { ViewMode } from "./viewPrefs";
import { useInstallJobs } from "../../../ai/sttInstallStore";
import "./agent.css";

/**
 * 取一条消息的有序片段。新消息自带 parts;旧会话历史里没有,
 * 就按「文字 → 状态 → 工具」的老顺序兜底,保证读得出来。
 */
export function partsOf(m: ChatMessage): MessagePart[] {
  if (m.parts && m.parts.length > 0) return m.parts;
  const legacy: MessagePart[] = [];
  if (m.text) legacy.push({ kind: "text", text: m.text });
  for (const s of m.statuses || []) legacy.push({ kind: "status", text: s });
  for (const t of m.tools || []) legacy.push({ kind: "tool", ...t });
  return legacy;
}

/**
 * 思考里那些步骤名,做成一条走马灯。
 *
 * 为什么不是纯文本:模型经中转站发回来的 `<think>` 里装的常常不是思维链,而是一句话的
 * 步骤名(「**Clarifying article link and scope**」)。原样铺在气泡里会把正文顶开,
 * 用户读一半被一段英文打断;藏进「显示思考」开关里又等于没有,他不知道它在忙什么。
 * 折中:只把步骤名抽出来排成一行行,最后一条在消息还没结束时带呼吸动画 ——
 * 一眼能看出「还在走、走到哪一步」,又不抢正文的位置。
 *
 * 现在只有详细模式还用它;简洁模式的「当前一步」挪到了输入框上方的 ThinkingStrip。
 */
export function StepStrip({ steps, live }: { steps: string[]; live: boolean }) {
  if (!steps.length) return null;
  return (
    <div className="ai-steps">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <div key={i} className={"ai-step" + (live && last ? " is-live" : " is-done")}>
            <span className="ai-step-dot" />
            <span className="ai-step-label">{s}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 正在执行、还没有结果的那个工具(有就说明这一刻在跑它) */
export function runningTool(parts: MessagePart[]): ToolCallInfo | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.kind === "tool") return p.ok === undefined ? p : null;
  }
  return null;
}

/** 一条没跑完的消息:优先用内核报上来的进度,没有就退回「正在思考 / 正在执行 X」 */
export function activityText(m: ChatMessage, busyTool: ToolCallInfo | null): string {
  if (m.progress?.text) return m.progress.text;
  return busyTool ? `正在执行 ${bareToolName(busyTool.name)}` : "正在思考";
}

/** 进度里的轮次和成败,单独放一行小字;没有轮次信息(CLI 驱动)就不显示 */
export function progressMeta(m: ChatMessage): string | null {
  const p = m.progress;
  if (!p?.round) return null;
  // maxRounds 为 null 是「不限轮次」(深度自主 + 自主轮次填 0):Infinity 过一趟 JSON 就是 null。
  // 写成「第 12/? 轮」会让人以为丢了信息,其实是本来就没有分母
  const bits = [p.maxRounds ? `第 ${p.round}/${p.maxRounds} 轮` : `第 ${p.round} 轮(不限)`];
  if (p.completed || p.failed) bits.push(`成功 ${p.completed ?? 0}·失败 ${p.failed ?? 0}`);
  if (p.elapsedMs) bits.push(`${Math.floor(p.elapsedMs / 1000)} 秒`);
  return bits.join(" · ");
}

/**
 * 跑完之后的结论。completed 不显示(正常结束不用多说一句),
 * 其余几种都要让用户看见:停下来的原因不同,该做的事也不同。
 * 用户自己停的只写「已停止」:是他按的,不用解释。
 */
export const OUTCOME_TEXT: Record<string, string> = {
  stalled: "检测到重复操作没有进展,已停下来。上面的总结说明了做到哪一步。",
  round_limit: "已达到本次模型往返轮数上限。已完成的修改保留,可以补充要求后继续。",
  aborted: "已停止",
};
export function outcomeText(m: ChatMessage): string | null {
  if (!m.outcome || m.outcome === "completed" || m.outcome === "error") return null;
  return OUTCOME_TEXT[m.outcome] || `本次执行结束于:${m.outcome}`;
}

/** 简洁模式的一段:几次操作,结尾可能跟着一份报告 */
export interface Segment {
  /** 这一段的操作,不含报告工具本身 */
  tools: ToolCallInfo[];
  /** 结尾那次 report_progress 的参数;这一段没以报告收尾,或参数解析不出来时为 null */
  report: ProgressReport | null;
}

/**
 * 按 parts 的先后把消息切段:遇到一次报告工具调用就「结一段」。
 *
 * 读下来是「做了几件事(图标)→ 交一份阶段小结(卡片)→ 再做几件事 → 本轮小结」。
 * 报告卡的数据直接取调用参数,不等工具结果 —— 结果只是一句「已记录」。
 * 最后一次报告之后还有操作的话,它们单独成一段,没有卡片。
 */
export function segmentsOf(parts: MessagePart[]): Segment[] {
  const out: Segment[] = [];
  let tools: ToolCallInfo[] = [];
  for (const p of parts) {
    if (p.kind !== "tool") continue;
    if (isReportTool(p.name)) {
      out.push({ tools, report: parseProgressReport(p.input) });
      tools = [];
    } else {
      tools.push(p);
    }
  }
  if (tools.length) out.push({ tools, report: null });
  return out;
}

/**
 * 一轮回复切好的段和每段的图标分组。消息对象不可变,按对象缓存:
 * 合并了好几轮的气泡在流式时只有正在跑的那一轮对象会变,别的轮次不用每个片段都重新切一遍。
 */
const roundCache = new WeakMap<ChatMessage, { segments: Segment[]; runs: IconRun[][] }>();
function roundCalc(m: ChatMessage): { segments: Segment[]; runs: IconRun[][] } {
  let v = roundCache.get(m);
  if (!v) {
    const segments = segmentsOf(partsOf(m));
    v = { segments, runs: segments.map((s) => iconRuns(s.tools)) };
    roundCache.set(m, v);
  }
  return v;
}

const REPORT_GROUPS = [
  { field: "done", label: "已完成", mark: "✓", cls: "is-done" },
  { field: "todo", label: "待办", mark: "○", cls: "is-todo" },
  { field: "problems", label: "问题", mark: "!", cls: "is-problem" },
] as const;

/**
 * 一份报告卡。
 *
 * Agent 的文字回复默认不显示之后,这就是用户读到的「结论」。阶段卡紧凑、退一档;
 * 本轮小结多一圈半透明强调色描边,醒目一点。三组条目空的不显示,全空写一句,别留个空壳。
 */
export function ReportCard({ r, enter }: { r: ProgressReport; enter?: boolean }) {
  const groups = REPORT_GROUPS.filter((g) => r[g.field].length > 0);
  const ref = useRef<HTMLDivElement>(null);
  // 流式里刚交上来的报告淡入(enterMotion);历史里的、分页切回来重新显示的不演。只在挂上来那一刻看一次
  useLayoutEffect(() => {
    if (enter) playEnter(ref.current, "pc-enter-rise");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} className={`ai-report${r.final ? " is-final" : ""}`}>
      <div className="ai-report-head">{r.final ? "本轮小结" : r.stage ? `阶段 · ${r.stage}` : "阶段小结"}</div>
      {groups.length ? (
        groups.map((g) => (
          <div key={g.field} className={`ai-report-group ${g.cls}`}>
            <div className="ai-report-label">
              <span className="ai-report-mark" aria-hidden>{g.mark}</span>
              {g.label}
            </div>
            <ul className="ai-report-list">
              {r[g.field].map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        ))
      ) : (
        <div className="ai-report-empty">(没有可汇报的内容)</div>
      )}
    </div>
  );
}

/**
 * 「思考与原文」:打开「显示思考」时气泡底部的一块。
 *
 * 文字回复默认不显示了(结论看报告卡),但排查时还得看得到它说了什么、想了什么。
 * 按发生顺序铺:相邻的文字并成一段、相邻的思考并成一段,读起来是「想 → 说 → 再想」。
 * 能折起来:原文往往很长,看完就收,不用去顶栏把开关关掉。
 * 合并了几轮的气泡按轮分节(sections):只在同一轮里并段,只有正在跑的那一轮按流式解析 ——
 * 不然整组几百轮的原文并成一段,每 250ms 整个重新解析一遍。
 */
function RawLog({ sections }: { sections: { key: string; parts: MessagePart[]; live: boolean }[] }) {
  const [open, setOpen] = useState(true);
  const items: { key: string; kind: "text" | "thinking"; text: string; live: boolean }[] = [];
  for (const sec of sections) {
    let local = 0;
    let last: (typeof items)[number] | null = null;
    for (const p of sec.parts) {
      if (p.kind !== "text" && p.kind !== "thinking") continue;
      if (last && last.kind === p.kind) last.text += p.kind === "thinking" ? "\n\n" + p.text : p.text;
      else {
        last = { key: `${sec.key}:${local++}`, kind: p.kind, text: p.text, live: sec.live };
        items.push(last);
      }
    }
  }
  if (!items.some((it) => it.text.trim())) return null;
  return (
    <div className="ai-rawlog">
      <button type="button" className="ai-rawlog-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden>{open ? "▾" : "▸"}</span>
        思考与原文
      </button>
      {open && (
        <div className="ai-rawlog-body">
          {items.map((it) => {
            if (!it.text.trim()) return null;
            // 文字一律走 LiveMarkdown:流式时逐 token 全量解析 Markdown / KaTeX 会把界面卡死
            return it.kind === "text" ? (
              <div key={it.key} className="ai-message-text">
                <LiveMarkdown text={it.text} live={it.live} />
              </div>
            ) : (
              <div key={it.key} className="ai-rawlog-thinking">{it.text}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AgentBubble(props: {
  m: ChatMessage;
  view: ViewMode;
  showThinking: boolean;
  installJobs: ReturnType<typeof useInstallJobs>;
  expanded: Set<string>;
  /** 旧的「×N 折叠 / 摊开」用的。图标改成每个最多叠 5 个之后不再读它,留着是为了 MessageList 不用改 */
  openRuns?: Set<string>;
  on: { toggleTool: (key: string) => void; toggleChip: (key: string) => void; toggleRun: (key: string) => void };
  /** 这条回复之前收到的其他 Agent 的消息(MessageList 从那条不画出来的用户消息里拆出来的) */
  inbound?: InboundAgentMessage[];
  /**
   * 合并进这个气泡的后续几轮回复(MessageList 算好的):上一轮没交本轮小结,下一轮的图标就接着累计在这个气泡里,
   * 交了本轮小结才另起一个气泡。只在简洁模式合并;中间用户说的话照常在原位置显示。
   */
  followers?: ChatMessage[];
  /** followers 各自之前收到的其他 Agent 消息,和 followers 一一对应 */
  followerInbound?: (InboundAgentMessage[] | undefined)[];
}) {
  const { m, view, showThinking, installJobs, expanded, on } = props;
  const { toggleTool } = on;

  const simple = view !== "verbose";
  // 这个气泡装的几轮:自己 + 合并进来的后续几轮(只在简洁模式合并)
  const rounds: { m: ChatMessage; inbound?: InboundAgentMessage[] }[] = [
    { m, inbound: props.inbound },
    ...(simple ? (props.followers ?? []).map((f, i) => ({ m: f, inbound: props.followerInbound?.[i] })) : []),
  ];
  const latest = rounds[rounds.length - 1].m;

  // 「转圈 + 正在做什么」跟着 pending 走，不再要求它是最后一条。
  // 分工模式下同一批角色的气泡是同时 pending 的，按「最后一条」判的话
  // 只有最下面那个有动静，上面几个看着像卡死了。
  //
  // 单线模式下同时只可能有一条 pending，两种写法等价；abort() 会把所有
  // pending 一起清掉，不会留下永远转圈的旧气泡。合并了几轮的气泡看其中正在跑的那一轮。
  const parts = partsOf(m);
  const pendingRound = rounds.find((r) => r.m.pending)?.m ?? null;
  const busyTool = pendingRound ? runningTool(partsOf(pendingRound)) : null;
  const live = !!pendingRound;

  // 简洁模式:把几轮排成「排组」。每轮的段和图标分组按轮缓存(roundCalc),只有正在跑的那一轮重算。
  //   - 上一轮正常收尾(没出错、没被停)、这一轮也没收到其他 Agent 的消息:这一轮的第一段续在上一排最后那段里
  //     (那段没交小结的话),图标接着累计在同一排;
  //   - 否则另起一排:收到消息的行首一个对话图标;出错 / 被停的那一轮,自己的报错和「已停止」留在它那一排后面。
  // 每段一排图标,段尾是小结图标,小结的颜色看它自己那一轮。排完再按排的顺序出操作详细预览控件的项(key 和 ToolIcons 里拼法一致)
  type RowSeg = { tools: ToolCallInfo[]; report: ProgressReport | null; runs: IconRun[]; tone: SummaryTone | null };
  const rows: {
    prefix: string;
    inbound: InboundAgentMessage[] | null;
    inboundIcon: ExtraIcon | null;
    segs: RowSeg[];
    notes: { key: string; error?: string; outcome: string | null }[];
  }[] = [];
  if (simple) {
    let prevClean = false;
    rounds.forEach((r, ri) => {
      const calc = roundCalc(r.m);
      const inbound = r.inbound?.length ? r.inbound : null;
      const stitch = ri > 0 && prevClean && !inbound && rows.length > 0;
      const row = stitch
        ? rows[rows.length - 1]
        : {
            prefix: r.m.id,
            inbound,
            inboundIcon: inbound
              ? { key: `${r.m.id}:in`, className: "ai-op--agent", label: `收到 ${inbound.length} 条其他 Agent 的消息`, count: inbound.length }
              : null,
            segs: [] as RowSeg[],
            notes: [] as { key: string; error?: string; outcome: string | null }[],
          };
      if (!stitch) rows.push(row);
      calc.segments.forEach((s, si) => {
        // 小结的颜色:它自己那一轮出错收尾(那一轮最后一段的小结)是红,报了问题是黄,否则绿
        const tone: SummaryTone | null = s.report
          ? si === calc.segments.length - 1 && (r.m.error || r.m.outcome === "error")
            ? "err"
            : s.report.problems.length
              ? "warn"
              : "ok"
          : null;
        const last = row.segs[row.segs.length - 1];
        if (si === 0 && stitch && last && !last.report) {
          const tools = last.tools.concat(s.tools);
          row.segs[row.segs.length - 1] = { tools, report: s.report, runs: iconRuns(tools), tone };
        } else {
          row.segs.push({ tools: s.tools, report: s.report, runs: calc.runs[si], tone });
        }
      });
      // 前几轮自己的报错 / 结局留在它那一排后面;最后一轮的照旧放在气泡最下面
      const out = r.m.pending ? null : outcomeText(r.m);
      if (ri < rounds.length - 1 && (r.m.error || out)) row.notes.push({ key: r.m.id, error: r.m.error, outcome: out });
      prevClean = !r.m.error && (!r.m.outcome || r.m.outcome === "completed");
    });
  }
  const items: DetailItem[] = [];
  for (const row of rows) {
    if (row.inbound) items.push({ type: "inbound", key: `${row.prefix}:in`, messages: row.inbound });
    row.segs.forEach((seg, si) => {
      for (const run of seg.runs) {
        const tools = run.items.map((i) => seg.tools[i]);
        // 装引擎在图标行里有自己的进度条,不进操作详细预览
        if (bareToolName(tools[0].name) === "stt_install") continue;
        items.push({ type: "run", key: `${row.prefix}:i${si}:${run.key}`, tools });
      }
      if (seg.report && seg.tone) items.push({ type: "report", key: `${row.prefix}:i${si}:report`, report: seg.report, tone: seg.tone });
    });
  }
  const pages = useDetailPages(items);

  /** 操作详细预览控件此刻显示的那一项 */
  const [focusKey, setFocusKey] = useState<string | null>(null);
  /** 用户在这个气泡里点过图标 / 翻过页:之后当前项的图标强调色描边 + 略放大;没点过、消息在跑时只发光 */
  const [interacted, setInteracted] = useState(false);
  /** 点图标让控件跳页:seq 每点一次加一,同一个图标连点也能跳回它的第一页 */
  const [jump, setJump] = useState<{ key: string; seq: number } | null>(null);

  // 点图标不在图标下面摊开任何清单(所有详细内容都在操作详细预览控件里):只让控件跳到它那一项
  const onToggleIcon = (key: string) => {
    setInteracted(true);
    setFocusKey(key);
    setJump((j) => ({ key, seq: (j?.seq ?? 0) + 1 }));
  };
  const onPage = useCallback((key: string, byUser: boolean) => {
    setFocusKey(key);
    if (byUser) setInteracted(true);
  }, []);
  const selectedKey = interacted ? focusKey : null;
  const glowKey = !interacted && live ? focusKey : null;
  const reportIcon = (prefix: string, seg: { report: ProgressReport | null; tone: SummaryTone | null }, si: number): ExtraIcon | null => {
    const { report, tone } = seg;
    if (!report || !tone) return null;
    const title = report.final ? "本轮小结" : report.stage ? `阶段 · ${report.stage}` : "阶段小结";
    return { key: `${prefix}:i${si}:report`, className: `ai-op--summary tone-${tone}`, label: `${title}:${SUMMARY_TONE_TEXT[tone]}` };
  };

  // 出错 / 结局看最后一轮
  const outcome = live ? null : outcomeText(latest);

  return (
    <div className="ai-message assistant">
      {/*
        这条回复是哪个角色产出的。普通对话没有 roleId 就不显示——
        每条回复顶上都挂一个「AI 助手」只是噪音，反而让分工模式下
        真正的角色名不显眼。
      */}
      {m.roleId && <div className="pc-role-header"><RoleName roleId={m.roleId} /></div>}
      {m.attachments && m.attachments.length > 0 && (
        <div className="ai-message-attach">[附件: {m.attachments.map((a) => a.name).join(", ")}]</div>
      )}

      {simple ? (
        // 简洁模式:按先后切段,每段一排图标(收到的 Agent 消息在最前,小结在段尾)。
        // 文字回复不在这里铺;所有详细内容(画面、操作、小结、收到的消息)都在最下面那个操作详细预览控件里,一个气泡只放一个
        <>
          {rows.map((row) => (
            <React.Fragment key={row.prefix}>
              {row.segs.length === 0 && row.inboundIcon ? (
                <ToolIcons
                  tools={[]}
                  runs={[]}
                  keyPrefix={`${row.prefix}:i0`}
                  installJobs={installJobs}
                  lead={row.inboundIcon}
                  selectedKey={selectedKey}
                  focusKey={glowKey}
                  onToggleIcon={onToggleIcon}
                />
              ) : null}
              {row.segs.map((seg, si) => (
                <ToolIcons
                  key={si}
                  tools={seg.tools}
                  runs={seg.runs}
                  keyPrefix={`${row.prefix}:i${si}`}
                  installJobs={installJobs}
                  lead={si === 0 ? row.inboundIcon : null}
                  tail={reportIcon(row.prefix, seg, si)}
                  selectedKey={selectedKey}
                  focusKey={glowKey}
                  onToggleIcon={onToggleIcon}
                />
              ))}
              {row.notes.map((note) => (
                <React.Fragment key={note.key}>
                  {note.error ? <div className="ai-message-error">{note.error}</div> : null}
                  {note.outcome ? <div className="ai-message-outcome">{note.outcome}</div> : null}
                </React.Fragment>
              ))}
            </React.Fragment>
          ))}
          <OpDetailPreview pages={pages} items={items} jump={jump} onPage={onPage} live={live} />
        </>
      ) : (
        // 详细模式:按真实发生顺序渲染,工具行、状态、步骤交错;报告工具那一行换成报告卡。
        // 文字和思考原文和简洁模式一样,只在「显示思考」打开时出现
        parts.map((p, pidx) => {
          if (p.kind === "text") {
            if (!showThinking || !p.text) return null;
            return (
              <div key={pidx} className="ai-message-text">
                <LiveMarkdown text={p.text} live={live} />
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
            // 步骤条一直显示。这些「**Clarifying article link and scope**」之类本来就是
            // 进度,不该被「显示思考」藏起来 —— 藏了用户就不知道它在干什么;
            // 而原样铺成文字又会把正文顶开。完整原文仍归那个开关管。
            // 两样都没有就不出这一层:气泡靠 gap 排间距,空的 div 也会平白多占一道 gap
            const steps = thinkingSteps(p.text);
            if (!steps.length && !showThinking) return null;
            return (
              <div key={pidx} className="ai-thinking-part">
                <StepStrip steps={steps} live={live} />
                {showThinking && (
                  <div className="ai-thinking">
                    <div className="ai-thinking-head">思考</div>
                    {p.text}
                  </div>
                )}
              </div>
            );
          }
          if (isReportTool(p.name)) {
            const r = parseProgressReport(p.input);
            // 参数解析不出来就退回普通工具行,至少原始数据还看得到
            if (r) return <ReportCard key={pidx} r={r} enter={live} />;
          }
          const key = `${m.id}:${pidx}`;
          return <ToolDetail key={key} t={p as ToolCallInfo} open={expanded.has(key)} installJobs={installJobs} onToggle={() => toggleTool(key)} />;
        })
      )}

      {/* 「正在做什么」和下面那行轮次小字包成一块:气泡里各块之间只靠 gap 隔开,这两行要贴得比 gap 近 */}
      {pendingRound && (
        <div className="ai-activity-block">
          <div className="ai-activity" role="status" aria-live="polite">
            <span className="ai-spinner" aria-hidden />
            <span className="ai-activity-text">{activityText(pendingRound, busyTool)}</span>
            <span className="ai-activity-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          </div>
          {progressMeta(pendingRound) && <div className="ai-activity-meta">{progressMeta(pendingRound)}</div>}
        </div>
      )}

      {latest.error && <div className="ai-message-error">{latest.error}</div>}
      {outcome && <div className="ai-message-outcome">{outcome}</div>}

      {simple && showThinking && <RawLog sections={rounds.map((r) => ({ key: r.m.id, parts: partsOf(r.m), live: !!r.m.pending }))} />}
    </div>
  );
}
