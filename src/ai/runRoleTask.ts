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
}): Promise<string> {
  const { provider, prompt, roleId, hooks, signal } = opts;
  const msgId = hooks.createMessage(roleId);

  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // 故意不传 sessionId：每个并行任务要一个干净的会话，否则几段对话会
    // 交错进同一个上下文，CLI 驱动尤其明显。
    body: JSON.stringify({ provider, prompt }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`角色 ${roleId} 的请求失败（HTTP ${res.status}）`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let failed: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const { events, rest } = parseSseChunks(buffer, decoder.decode(value, { stream: true }));
    buffer = rest;

    for (const ev of events as RunEvent[]) {
      if (ev.type === "text" && ev.delta) {
        hooks.updateMessage(msgId, (m) => ({
          ...m, text: m.text + ev.delta, parts: appendText(m.parts, ev.delta),
        }));
      } else if (ev.type === "tool_call") {
        hooks.updateMessage(msgId, (m) => ({
          ...m,
          tools: [...(m.tools ?? []), { name: ev.name!, input: ev.input, callId: ev.callId }],
          parts: [...(m.parts ?? []), { kind: "tool", name: ev.name!, input: ev.input, callId: ev.callId }],
        }));
      } else if (ev.type === "tool_result") {
        hooks.updateMessage(msgId, (m) => {
          const tools = [...(m.tools ?? [])];
          for (let i = tools.length - 1; i >= 0; i--) {
            if ((ev.callId ? tools[i].callId === ev.callId : tools[i].name === ev.name) && tools[i].ok === undefined) {
              tools[i] = { ...tools[i], ok: ev.ok, summary: ev.summary };
              break;
            }
          }
          return { ...m, tools };
        });
      } else if (ev.type === "error" && ev.message) {
        failed = ev.message;
      }
    }
  }

  hooks.updateMessage(msgId, (m) => ({
    ...m, pending: false, finishedAt: Date.now(),
    ...(failed ? { error: failed, outcome: "error" } : { outcome: "completed" }),
  }));

  if (failed) throw new Error(failed);
  return msgId;
}
