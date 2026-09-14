import type { ChatMessage, MessagePart, ToolCallInfo } from "./types.ts";

/**
 * Agent 交给用户看的进度报告(report_progress 工具的参数)。
 *
 * 改版后 Agent 的文字回复默认不显示,用户看到的是它阶段结束 / 任务结束时交上来的三组条目。
 * 界面直接读 tool_call 事件里的 input,不等工具结果 —— 结果只是一句「已记录」。
 * 解析规则和服务端的 server/progress-report.mjs 保持一致:服务端拒收的调用这里也不认。
 * CLI 驱动报回来的 tool_result 分不出拒收(ok 恒为 true),Agent 照着报错重发一次,
 * 界面要是把拒收的那次也画成卡片,用户就会看到两张一样的。
 */
export const REPORT_TOOL = "report_progress";

export interface ProgressReport {
  /** true = 整个任务收尾;false = 阶段小结 */
  final: boolean;
  stage?: string;
  done: string[];
  todo: string[];
  problems: string[];
}

/**
 * 各家报上来的工具名不一样:Claude 带 `mcp__promptcut__` 前缀,别家可能是裸名或 `promptcut.xxx`。
 * 只认「以分隔符 + report_progress 结尾」,免得哪天有个 xxx_report_progress 被误认。
 */
export function isReportTool(name: string | undefined): boolean {
  return !!name && (name === REPORT_TOOL || /(?:__|[.:/])report_progress$/.test(name));
}

/** 和服务端一样的上限:每组最多 8 条、每条 60 个字、阶段名 12 个字 */
const MAX_ITEMS = 8;
const MAX_ITEM_CHARS = 60;
const MAX_STAGE_CHARS = 12;

const clip = (s: string, n: number) => Array.from(s).slice(0, n).join("");
const given = (v: unknown) => v !== undefined && v !== null;

/** 缺省或 null 算空组;不是数组、或者有一条不是字符串,整份不认(返回 null) */
function items(v: unknown): string[] | null {
  if (!given(v)) return [];
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== "string") return null;
    const t = s.trim();
    if (t) out.push(clip(t, MAX_ITEM_CHARS));
  }
  return out.slice(0, MAX_ITEMS);
}

/** input 可能是对象,也可能是还没解析的 JSON 字符串(codex 的 arguments 就是字符串) */
export function parseProgressReport(input: unknown): ProgressReport | null {
  let v = input;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  // has_done / has_todo / has_problem 是给模型自查用的冗余字段,不看
  if (given(o.final) && typeof o.final !== "boolean") return null;
  if (given(o.stage) && typeof o.stage !== "string") return null;
  const done = items(o.done);
  const todo = items(o.todo);
  const problems = items(o.problems);
  if (!done || !todo || !problems) return null;
  // 三组全空、连 final 都没给:参数还没流完整,或者根本不是一份报告
  if (!done.length && !todo.length && !problems.length && typeof o.final !== "boolean") return null;
  const stage = typeof o.stage === "string" ? clip(o.stage.trim(), MAX_STAGE_CHARS) : "";
  return { final: o.final === true, ...(stage ? { stage } : {}), done, todo, problems };
}

/** 一条消息里按先后顺序的报告;旧历史没有 parts 时从 tools 里找 */
export function reportsOf(m: Pick<ChatMessage, "parts" | "tools">): ProgressReport[] {
  const calls: ToolCallInfo[] = m.parts
    ? m.parts.filter((p): p is Extract<MessagePart, { kind: "tool" }> => p.kind === "tool")
    : (m.tools ?? []);
  const out: ProgressReport[] = [];
  for (const t of calls) {
    if (!isReportTool(t.name)) continue;
    const r = parseProgressReport(t.input);
    if (r) out.push(r);
  }
  return out;
}

/** 摘成一句话(换模型 / 回退后的「前情」用):只拼非空的组 */
export function reportText(r: ProgressReport): string {
  const segs: string[] = [];
  if (r.done.length) segs.push(`已完成:${r.done.join("、")}`);
  if (r.todo.length) segs.push(`待办:${r.todo.join("、")}`);
  if (r.problems.length) segs.push(`问题:${r.problems.join("、")}`);
  const body = segs.join(";");
  return r.stage && body ? `[${r.stage}] ${body}` : body;
}
