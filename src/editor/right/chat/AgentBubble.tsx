import React, { useLayoutEffect, useRef, useState } from "react";
import { playEnter } from "../../enterMotion";
import type { ChatMessage, MessagePart, ToolCallInfo } from "../../../ai/types";
import { RoleName } from "../RoleAvatar";
import { LiveMarkdown } from "../../../ai/Markdown";
import { ToolDetail, ToolIcons } from "./ToolIcons";
import { bareToolName, iconRuns, type IconRun } from "./iconRuns";
import { ActivityCarousel, useActivityPages, type ActivitySource } from "./ActivityCarousel";
import { thinkingSteps } from "../../../ai/thinkingSteps";
import { isReportTool, parseProgressReport, type ProgressReport } from "../../../ai/progressReport";
import { setShowThinking, type ViewMode } from "./viewPrefs";
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
 */
function RawLog({ parts, live }: { parts: MessagePart[]; live: boolean }) {
  const [open, setOpen] = useState(true);
  const items: { kind: "text" | "thinking"; text: string }[] = [];
  for (const p of parts) {
    if (p.kind !== "text" && p.kind !== "thinking") continue;
    const last = items[items.length - 1];
    if (last && last.kind === p.kind) last.text += p.kind === "thinking" ? "\n\n" + p.text : p.text;
    else items.push({ kind: p.kind, text: p.text });
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
          {items.map((it, i) => {
            if (!it.text.trim()) return null;
            // 文字一律走 LiveMarkdown:流式时逐 token 全量解析 Markdown / KaTeX 会把界面卡死
            return it.kind === "text" ? (
              <div key={i} className="ai-message-text">
                <LiveMarkdown text={it.text} live={live} />
              </div>
            ) : (
              <div key={i} className="ai-rawlog-thinking">{it.text}</div>
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
}) {
  const { m, view, showThinking, installJobs, expanded, on } = props;
  const { toggleTool, toggleChip } = on;

  // 「转圈 + 正在做什么」跟着 m.pending 走，不再要求它是最后一条。
  // 分工模式下同一批角色的气泡是同时 pending 的，按「最后一条」判的话
  // 只有最下面那个有动静，上面几个看着像卡死了。
  //
  // 单线模式下同时只可能有一条 pending，两种写法等价；abort() 会把所有
  // pending 一起清掉，不会留下永远转圈的旧气泡。
  const parts = partsOf(m);
  const busyTool = m.pending ? runningTool(parts) : null;
  const live = !!m.pending;
  const simple = view !== "verbose";

  // 简洁模式:切段、分组,顺手收集轮播的来源(每个做完的操作 + 它所属图标的 key,和 ToolIcons 里拼法一致)
  const segments = simple ? segmentsOf(parts) : [];
  const segPrefix = (si: number) => `${m.id}:i${si}`;
  const runsBySeg: IconRun[][] = [];
  const sources: ActivitySource[] = [];
  segments.forEach((s, si) => {
    const runs = iconRuns(s.tools);
    runsBySeg.push(runs);
    for (const run of runs) {
      for (const i of run.items) {
        const t = s.tools[i];
        if (t.ok !== undefined) sources.push({ runKey: `${segPrefix(si)}:${run.key}`, tool: t });
      }
    }
  });
  const pages = useActivityPages(sources);

  /** 轮播翻到的那一页属于哪个图标 */
  const [focusKey, setFocusKey] = useState<string | null>(null);
  /** 点图标让轮播跳页:seq 每点一次加一,同一个图标连点也能跳回它的第一页 */
  const [jump, setJump] = useState<{ key: string; seq: number } | null>(null);

  const onToggleIcon = (key: string) => {
    toggleChip(key);
    if (pages.some((p) => p.runKey === key)) {
      setFocusKey(key);
      setJump((j) => ({ key, seq: (j?.seq ?? 0) + 1 }));
    }
  };

  const hasFinal = parts.some(
    (p) => p.kind === "tool" && isReportTool(p.name) && parseProgressReport(p.input)?.final === true,
  );
  // 正常跑完却没交本轮小结:文字回复又默认不显示,用户会以为它什么都没说。给一句话 + 去看原文的入口
  const noSummary = !live && !m.error && m.outcome !== "aborted" && m.outcome !== "error" && !hasFinal;
  const outcome = live ? null : outcomeText(m);

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
        // 简洁模式:按先后切段,每段是「做了几件事(一排图标)→ 交一份报告(卡片)」。
        // 文字回复不在这里铺 —— 结论看报告卡,原文收进底部的「思考与原文」
        segments.map((s, si) => {
          const last = si === segments.length - 1;
          return (
            <React.Fragment key={si}>
              {s.tools.length > 0 && (
                <ToolIcons
                  tools={s.tools}
                  runs={runsBySeg[si]}
                  keyPrefix={segPrefix(si)}
                  installJobs={installJobs}
                  expanded={expanded}
                  focusKey={focusKey}
                  onToggleIcon={onToggleIcon}
                  onToggleTool={toggleTool}
                />
              )}
              {/* 轮播每条消息只放一个:最后一段的图标之后、本轮小结之前 ——
                  读下来是「做了什么 → 改成什么样 → 结论」 */}
              {last && <ActivityCarousel pages={pages} jump={jump} onFocus={setFocusKey} live={live} />}
              {s.report && <ReportCard r={s.report} enter={live} />}
            </React.Fragment>
          );
        })
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
            return (
              <div key={pidx}>
                <StepStrip steps={thinkingSteps(p.text)} live={live} />
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
      {outcome && <div className="ai-message-outcome">{outcome}</div>}
      {noSummary && (
        <div className="ai-nosummary">
          这一轮没有提交小结
          {!showThinking && (
            <button type="button" className="ai-link-btn" onClick={() => setShowThinking(true)}>
              显示思考
            </button>
          )}
        </div>
      )}

      {simple && showThinking && <RawLog parts={parts} live={live} />}
    </div>
  );
}
