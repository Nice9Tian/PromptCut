import type { Project } from "../kernel/project.ts";
import { normalizeCuts } from "../kernel/cuts.ts";
import { findTabByConversation, getTabs, setScopeByConversation, setTabUnread } from "./agentTabs.ts";

/**
 * 多个 Agent 并行改同一个项目时的「公告板」。
 *
 * 三样东西:
 *   1. 范围声明:每个 Agent 开工先 declare_scope(「剪辑1->序列2」),页签跟着改名;
 *   2. 改动记录:某个 Agent 每做一次时间轴操作,这里算出它碰了哪几条「剪辑->序列」,
 *      记下是谁(对话 ID)、用什么工具、什么时候。别的 Agent 下一次发消息时,这些记录会
 *      拼成一段「其他 Agent 的动态」塞进它的提示词 —— 它才知道有人动了它范围里的东西;
 *   3. 信箱:send_message 把一段话投给另一个 Agent(按对话 ID)。收件那一页空闲时自动
 *      作为一条用户消息发出去;正忙就攒着,跑完再送。
 *
 * 全在浏览器里:所有 Agent 的工具调用都经这个页面的执行器(mcpExecutor)过一遍,
 * 服务端只负责把「这次调用是哪个 Agent 发的」(agent 字段)带过来。
 */

export interface ScopeChange {
  seq: number;
  at: number;
  /** 改动者的对话 ID;不知道是谁(比如 agy 那条路带不上)就是 null */
  agentId: string | null;
  tool: string;
  /** 「剪辑名->序列名」;声明范围时是声明的文字 */
  scopes: string[];
  kind: "change" | "declare";
}

export interface AgentMessage {
  seq: number;
  at: number;
  from: string | null;
  to: string;
  text: string;
  /** 自动投递的层数:A 的消息自动触发 B 跑,B 跑时发给 A 的消息就是下一层。封顶,防止两个 Agent 无限对聊 */
  hops: number;
}

/** 自动投递最多连锁几层;超过就攒在信箱里,等用户下一次发消息时一并带上 */
export const MAX_AUTO_HOPS = 3;

const changes: ScopeChange[] = [];
const inbox: AgentMessage[] = [];
let seq = 0;
/** 每个 Agent 上一次「拿走动态」时的序号:下次只给它看之后发生的 */
const seen = new Map<string, number>();
/** 正在跑的自动投递层数(按对话 ID) */
const runHops = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function subscribeBus(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function cutName(p: Project): string {
  const q = normalizeCuts(p);
  return q.cuts?.find((c) => c.id === q.activeCutId)?.name ?? "剪辑 1";
}

/**
 * 一次工具调用前后,项目里哪些「剪辑->序列」变了。
 *
 * 只看当前剪辑的各条序列:序列的 clips 数组换了引用就算改了(store 每次都产新数组,
 * 引用没变就是没碰)。切了剪辑就整条剪辑算作范围。
 */
export function diffScopes(before: Project, after: Project): string[] {
  const out: string[] = [];
  if ((before.activeCutId ?? null) !== (after.activeCutId ?? null)) {
    out.push(cutName(after));
    return out;
  }
  const name = cutName(after);
  const prev = new Map(before.tracks.map((t) => [t.id, t]));
  for (const t of after.tracks) {
    const b = prev.get(t.id);
    if (!b || b.clips !== t.clips || b.name !== t.name) out.push(`${name}->${t.name}`);
  }
  for (const b of before.tracks) {
    if (!after.tracks.some((t) => t.id === b.id)) out.push(`${name}->${b.name}(已删)`);
  }
  return out;
}

/** 某个 Agent 做了一次时间轴操作:算范围、记一笔。没改到任何序列就不记 */
export function noteToolChange(agentId: string | null, tool: string, before: Project, after: Project): void {
  if (before === after) return;
  let scopes = diffScopes(before, after);
  if (scopes.length === 0) {
    if (tool === "set_theme") scopes = ["全局主题"];
    else return;
  }
  changes.push({ seq: ++seq, at: Date.now(), agentId, tool, scopes, kind: "change" });
  if (changes.length > 500) changes.splice(0, changes.length - 500);
  emit();
}

/* ---------------- 工具:declare_scope / list_agents / send_message / check_messages ---------------- */

export function declareScope(agentId: string | null, args: { scope?: unknown; note?: unknown }): unknown {
  const scope = typeof args?.scope === "string" ? args.scope.trim().slice(0, 120) : "";
  if (!scope) throw new Error("scope 必填,写成「剪辑X->序列X」,多个用逗号分开");
  if (!agentId) {
    return { ok: false, error: "这条调用没带 Agent 对话 ID(可能是走 agy 或外部命令行调的),范围没法记到页签上;别的 Agent 也看不到这次声明" };
  }
  const tab = setScopeByConversation(agentId, scope);
  const note = typeof args?.note === "string" ? args.note.trim().slice(0, 300) : "";
  changes.push({ seq: ++seq, at: Date.now(), agentId, tool: "declare_scope", scopes: [scope + (note ? `(${note})` : "")], kind: "declare" });
  emit();
  const others = listAgentsRaw(agentId).filter((a) => !a.you);
  const clash = others.filter((a) => a.scope && overlaps(a.scope, scope));
  return {
    ok: true,
    you: agentId,
    tab: tab ? tab.title : null,
    otherAgents: others,
    ...(clash.length ? { warning: `范围和 ${clash.map((c) => `${c.id}(${c.scope})`).join("、")} 有重叠,先用 send_message 商量好谁改哪部分` } : {}),
  };
}

function overlaps(a: string, b: string): boolean {
  const norm = (s: string) => s.split(/[,,;;、]/).map((x) => x.trim()).filter(Boolean);
  const xs = norm(a), ys = norm(b);
  return xs.some((x) => ys.some((y) => x === y || x.startsWith(y + "->") || y.startsWith(x + "->")));
}

function listAgentsRaw(agentId: string | null) {
  return getTabs()
    .filter((t) => t.conversationId)
    .map((t) => ({
      id: t.conversationId!,
      title: t.title,
      scope: t.scope,
      busy: t.busy,
      you: t.conversationId === agentId,
      unread: inbox.filter((m) => m.to === t.conversationId).length,
    }));
}

export function listAgents(agentId: string | null): unknown {
  return { you: agentId, agents: listAgentsRaw(agentId) };
}

export function sendMessage(agentId: string | null, args: { to?: unknown; text?: unknown }): unknown {
  const text = typeof args?.text === "string" ? args.text.trim().slice(0, 4000) : "";
  const to = typeof args?.to === "string" ? args.to.trim() : "";
  if (!text) throw new Error("text 必填");
  if (!to) throw new Error("to 必填:收件 Agent 的对话 ID,用 list_agents 查;写 all 就是发给所有其他 Agent");
  const targets = to === "all"
    ? listAgentsRaw(agentId).filter((a) => !a.you).map((a) => a.id)
    : [to];
  if (targets.length === 0) return { ok: false, error: "没有别的 Agent 在跑" };
  const hops = (agentId && runHops.get(agentId)) || 0;
  const delivered: string[] = [];
  const unknown: string[] = [];
  for (const t of targets) {
    if (!findTabByConversation(t)) { unknown.push(t); continue; }
    inbox.push({ seq: ++seq, at: Date.now(), from: agentId, to: t, text, hops: hops + 1 });
    delivered.push(t);
    refreshUnread(t);
  }
  emit();
  if (delivered.length === 0) throw new Error(`没有这个 Agent:${unknown.join("、")}(用 list_agents 看有哪些)`);
  const busyTargets = delivered.filter((t) => findTabByConversation(t)?.busy);
  return {
    ok: true,
    delivered,
    ...(unknown.length ? { unknown } : {}),
    note: busyTargets.length
      ? `${busyTargets.join("、")} 正在跑,消息会在它这一轮结束后自动送到;空闲的那些已经作为一条消息发给它了`
      : hops + 1 >= MAX_AUTO_HOPS
        ? "已经连续互发好几轮了,这条会留在对方信箱里,等用户下一次和它说话时一并带上,不再自动触发它跑"
        : "对方空闲,消息已作为一条用户消息发给它,它会开始处理",
  };
}

/** 自己信箱里还没处理的消息(不取走) */
export function checkMessages(agentId: string | null): unknown {
  if (!agentId) return { ok: false, error: "这条调用没带 Agent 对话 ID" };
  const mine = inbox.filter((m) => m.to === agentId);
  const others = changes.filter((c) => c.agentId !== agentId && c.seq > (seen.get(agentId) ?? 0));
  return { you: agentId, messages: mine.map(({ from, text, at }) => ({ from, text, at: new Date(at).toISOString() })), changes: others.map(fmtChange) };
}

function refreshUnread(conversationId: string) {
  const t = findTabByConversation(conversationId);
  if (t) setTabUnread(t.id, inbox.filter((m) => m.to === conversationId).length);
}

/* ---------------- 投递 / 注入 ---------------- */

/**
 * 取走投给这个 Agent 的消息(它这一页要把它们当一条用户消息发出去)。
 * onlyAuto=true 只取还能自动触发的(层数没到顶);到顶的留着,由 consumeNotes 在用户下次发消息时带上。
 */
export function takeInbox(conversationId: string, onlyAuto: boolean): AgentMessage[] {
  const picked: AgentMessage[] = [];
  for (let i = inbox.length - 1; i >= 0; i--) {
    const m = inbox[i];
    if (m.to !== conversationId) continue;
    if (onlyAuto && m.hops >= MAX_AUTO_HOPS) continue;
    picked.unshift(m);
    inbox.splice(i, 1);
  }
  if (picked.length) {
    refreshUnread(conversationId);
    emit();
  }
  return picked;
}

export function hasAutoDeliverable(conversationId: string): boolean {
  return inbox.some((m) => m.to === conversationId && m.hops < MAX_AUTO_HOPS);
}

/** 这一页开始跑一轮:记下它是第几层自动投递(0 = 用户自己发的) */
export function beginRun(conversationId: string, hops: number): void {
  runHops.set(conversationId, hops);
}

export function endRun(conversationId: string): void {
  runHops.delete(conversationId);
}

function fmtTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function fmtChange(c: ScopeChange): string {
  const who = c.agentId ? `Agent ${c.agentId}` : "某个没带 ID 的 Agent";
  const scopeOf = c.agentId ? findTabByConversation(c.agentId)?.scope : null;
  const whoScope = scopeOf ? `(声明范围「${scopeOf}」)` : "";
  return c.kind === "declare"
    ? `${fmtTime(c.at)} ${who} 声明了修改范围:${c.scopes.join(",")}`
    : `${fmtTime(c.at)} ${who}${whoScope} 用 ${c.tool} 改了 ${c.scopes.join(",")}`;
}

/** 把「来自别的 Agent 的消息」排成一条用户消息的正文 */
export function formatInbound(msgs: AgentMessage[]): string {
  return msgs
    .map((m) => `【来自 Agent ${m.from ?? "未知"} 的消息】\n${m.text}`)
    .join("\n\n");
}

/**
 * 这个 Agent 下一条提示词前面要带的「其他 Agent 的动态」:别人改了什么范围、
 * 信箱里到顶没自动投递的消息。取走即视为已读。
 */
export function consumeNotes(conversationId: string): string {
  const since = seen.get(conversationId) ?? 0;
  const others = changes.filter((c) => c.agentId !== conversationId && c.seq > since);
  const held = takeInbox(conversationId, false);
  seen.set(conversationId, seq);
  if (others.length === 0 && held.length === 0) return "";
  const lines: string[] = ["[其他 Agent 的动态 —— 系统自动附上,不是用户说的话]"];
  lines.push(`你的 Agent 对话 ID:${conversationId}`);
  for (const c of others.slice(-40)) lines.push(`- ${fmtChange(c)}`);
  for (const m of held) lines.push(`- ${fmtTime(m.at)} Agent ${m.from ?? "未知"} 给你的消息:${m.text}`);
  lines.push("[/其他 Agent 的动态]");
  return lines.join("\n");
}

/** 一个 Agent 刚开第一轮时先把序号对齐,免得把它出生前的历史当新闻 */
export function markSeen(conversationId: string): void {
  if (!seen.has(conversationId)) seen.set(conversationId, seq);
}

/** 只给测试用 */
export function _resetBus(): void {
  changes.length = 0;
  inbox.length = 0;
  seq = 0;
  seen.clear();
  runHops.clear();
}

export function getChanges(): readonly ScopeChange[] {
  return changes;
}
