/**
 * 并行跑一个角色任务：直接对 /api/ai/chat 说话，不走 useAiChat 的 send()。
 *
 * 为什么另起一条路而不复用 send()：send() 用**单个** abortControllerRef 和
 * **单个** sessionId。两个任务同时调它，后一个会把前一个的中止控制器覆盖掉
 * （前一个就再也停不下来），而共用一个 CLI 会话还会让两段对话交错进同一个
 * 上下文里。并发是分工模式的全部意义，这两条都不能忍。
 *
 * 所以每个任务：自己的 AbortController、**不传 sessionId**（让服务端开新会话）、
 * 自己的消息气泡。代价是任务之间不共享上下文——这正是我们要的，
 * 它们本来就是互不依赖才被排进同一批的。
 */
import type { ChatMessage, MessagePart, RunEvent } from "./types";
import { parseSseChunks } from "./sse";

export interface RoleTaskHooks {
  /** 建一条属于这个角色的空气泡，返回它的 id */
  createMessage: (roleId: string) => string;
  /** 往那条气泡里追加内容 */
  updateMessage: (id: string, patch: (m: ChatMessage) => ChatMessage) => void;
}

/** 往有序片段里追加文字（接在末尾的文字片段后面，不新开一段） */
function appendText(parts: MessagePart[] | undefined, delta: string): MessagePart[] {
  const next = parts ? [...parts] : [];
  const last = next[next.length - 1];
  if (last && last.kind === "text") next[next.length - 1] = { ...last, text: last.text + delta };
  else next.push({ kind: "text", text: delta });
  return next;
}

/** 从后往前找到那次还没有结果的调用，把结果盖上去 */
function stampLast<T extends { name: string; callId?: string; ok?: boolean; summary?: string }>(
  list: T[],
  callId: string | undefined,
  name: string | undefined,
  ok: boolean | undefined,
  summary: string | undefined,
): T[] {
  const next = [...list];
  for (let i = next.length - 1; i >= 0; i--) {
    const hit = callId ? next[i].callId === callId : next[i].name === name;
    if (hit && next[i].ok === undefined) {
      next[i] = { ...next[i], ok, summary };
      break;
    }
  }
  return next;
}

/** parts 是个联合类型，只能盖 kind === "tool" 的那些 */
function stampLastPart(
  parts: MessagePart[],
  callId: string | undefined,
  name: string | undefined,
  ok: boolean | undefined,
  summary: string | undefined,
): MessagePart[] {
  const tools = parts.filter((p) => p.kind === "tool");
  const stamped = stampLast(tools, callId, name, ok, summary);
  let k = 0;
  return parts.map((p) => (p.kind === "tool" ? stamped[k++] : p));
}

/**
 * 发一个角色任务并把流式结果写进它自己的气泡。
 * 出错就抛——编排器接住后会把这个任务标成 error，并跳过依赖它的下游。
 */
export async function runRoleTask(opts: {
  provider: string;
  prompt: string;
  roleId: string;
  hooks: RoleTaskHooks;
  signal?: AbortSignal;
  /** 发起这次分工的那一页的对话 ID:带上它,角色调 declare_scope 之类的工具才记得到页签上 */
  conversationId?: string;
}): Promise<string> {
  const { provider, prompt, roleId, hooks, signal, conversationId } = opts;
  const msgId = hooks.createMessage(roleId);

  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // 故意不传 sessionId：每个并行任务要一个干净的会话，否则几段对话会
    // 交错进同一个上下文，CLI 驱动尤其明显。
    body: JSON.stringify({ provider, prompt, conversationId }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`角色 ${roleId} 的请求失败（HTTP ${res.status}）`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let failed: string | null = null;
  // 文字增量攒一小会儿再写进气泡(同 useAiChat 的 DELTA_FLUSH_MS):逐 token 写的话,
  // 几个角色并行时每秒上百次重渲染,人这边点什么都卡。别的事件到来前先把攒着的写掉,保证先后顺序
  const TEXT_FLUSH_MS = 80;
  let queuedText = "";
  let textTimer: ReturnType<typeof setTimeout> | null = null;
  const flushText = () => {
    if (textTimer !== null) {
      clearTimeout(textTimer);
      textTimer = null;
    }
    if (!queuedText) return;
    const delta = queuedText;
    queuedText = "";
    hooks.updateMessage(msgId, (m) => ({ ...m, text: m.text + delta, parts: appendText(m.parts, delta) }));
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const { events, rest } = parseSseChunks(buffer, decoder.decode(value, { stream: true }));
      buffer = rest;

      for (const ev of events as RunEvent[]) {
        if (ev.type === "text" && ev.delta) {
          queuedText += ev.delta;
          if (textTimer === null) textTimer = setTimeout(flushText, TEXT_FLUSH_MS);
          continue;
        }
        flushText();
        if (ev.type === "tool_call") {
          hooks.updateMessage(msgId, (m) => ({
            ...m,
            tools: [...(m.tools ?? []), { name: ev.name!, input: ev.input, callId: ev.callId }],
            parts: [...(m.parts ?? []), { kind: "tool", name: ev.name!, input: ev.input, callId: ev.callId }],
          }));
        } else if (ev.type === "tool_result") {
          // tools 和 parts **两处都要打**。气泡上那排小方块是按 parts 渲染的
          // （见 chat/AgentBubble.tsx 的 segmentsOf(parts)），只更新 tools 的话方块会
          // 永远停在「进行中」——本机端到端跑的时候就是这个样子，工具其实早就
          // 返回了，界面上却像是卡住了。
          hooks.updateMessage(msgId, (m) => ({
            ...m,
            tools: stampLast(m.tools ?? [], ev.callId, ev.name, ev.ok, ev.summary),
            parts: stampLastPart(m.parts ?? [], ev.callId, ev.name, ev.ok, ev.summary),
          }));
        } else if (ev.type === "error" && ev.message) {
          failed = ev.message;
        }
      }
    }
  } finally {
    // 被中止(reader.read 抛错)时也把已经收到的文字落进气泡,并清掉计时器
    flushText();
  }

  hooks.updateMessage(msgId, (m) => ({
    ...m, pending: false, finishedAt: Date.now(),
    ...(failed ? { error: failed, outcome: "error" } : { outcome: "completed" }),
  }));

  if (failed) throw new Error(failed);
  return msgId;
}
