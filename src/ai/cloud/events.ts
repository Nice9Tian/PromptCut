/**
 * 云端事件流 → 对话消息(契约 2.4 节:「页面的对话界面完全由事件重建,页面不向服务端存对话记录」)。
 *
 * 纯函数,不碰 store、不碰网络:`applyCloudEvents(messages, events)` 按到达顺序把事件折进消息列表,
 * 同一串事件从头折一遍与边收边折得到同一份消息(重连补看、换设备、重新打开都靠这一点)。
 *
 * 一轮 = 一条用户消息(`user` 事件)加一条助手消息;两条的 id 由 `runId` 定,同一个 `runId` 的事件落在同一条助手消息上。
 * 助手消息的形状与桌面本机 Agent 的一样(`parts` 按发生顺序),所以 `MessageList` 等组件原样可用。
 * 不记 `trace`:诊断导出在云端下不提供,tool_result 也不带完整输出。
 */
import type { ChatAttachment, ChatMessage, MessagePart } from "../types.ts";
import { appendTextPart, appendThinkingPart } from "../streamBatch.ts";
import { cloudAttachKind } from "./attach.ts";
import type { CloudEvent, CloudQueueSnapshot } from "./types.ts";

export const userMessageId = (runId: string) => `cu-${runId}`;
export const accountMessageId = (messageId: string) => `cq-${messageId}`;
export const assistantMessageId = (runId: string) => `ca-${runId}`;

/** 每个收尾原因在对话里留给人看的话(契约 7.3 节)。服务端的 `error.message` 优先,没给才用这里的 */
export function cloudErrorMessage(code: string | undefined, message?: string): string {
  if (typeof message === "string" && message) return message;
  switch (code) {
    case "revoked": return "云端 Agent 的这段对话已失效(开关被关、你被移出项目或项目已删除)。已经落地的改动保留在项目里。";
    case "interrupted": return "云端 Agent 服务中断,这一轮没有做完。已经落地的改动保留在项目里。";
    case "model": return "模型调用失败。";
    case "quota-exceeded": return "云端 Agent 的额度已用完。";
    case "limit": return "这一轮达到了轮数或时间上限,已停下。已经落地的改动保留在项目里。";
    case "unavailable": return "云端 Agent 暂时连不上文档服务。";
    default: return "云端 Agent 出错了。";
  }
}

/** 补渲进展(契约 16 节)写成一行状态 */
export function renderStatusText(ev: CloudEvent): string {
  const clips = Array.isArray(ev.clips) ? ev.clips.length : typeof ev.clips === "number" ? ev.clips : 0;
  const done = typeof ev.done === "number" ? ev.done : null;
  const total = typeof ev.total === "number" ? ev.total : null;
  switch (ev.state) {
    case "published": return `已把 ${clips || "改动涉及的"} 个片段交给云端渲染`;
    case "progress": return total !== null ? `云端渲染中:${done ?? 0}/${total}` : "云端渲染中";
    case "done": return "云端渲染完成";
    case "failed": return `云端渲染失败${typeof ev.reason === "string" && ev.reason ? `:${ev.reason}` : ""}`;
    case "unavailable": return "云端渲染暂不可用,画面会在渲染节点恢复后补上";
    default: return "";
  }
}

function completeTool(parts: MessagePart[] | undefined, ev: CloudEvent): MessagePart[] {
  const next = parts ? [...parts] : [];
  const callId = typeof ev.callId === "string" ? ev.callId : undefined;
  const name = String(ev.name ?? "");
  for (let i = next.length - 1; i >= 0; i--) {
    const p = next[i];
    if (p.kind === "tool" && (callId ? p.callId === callId : p.name === name) && p.ok === undefined) {
      next[i] = {
        ...p,
        ok: ev.ok === true,
        summary: typeof ev.summary === "string" ? ev.summary : undefined,
        files: Array.isArray(ev.files) ? (ev.files as string[]) : undefined,
        durationMs: typeof ev.durationMs === "number" ? ev.durationMs : undefined,
      };
      return next;
    }
  }
  next.push({ kind: "tool", name, callId, ok: ev.ok === true, summary: typeof ev.summary === "string" ? ev.summary : undefined });
  return next;
}

function freshAssistant(runId: string, at: number | undefined): ChatMessage {
  return { id: assistantMessageId(runId), role: "assistant", text: "", parts: [], tools: [], statuses: [], pending: true, startedAt: at ?? Date.now() };
}

/** 事件属于哪一轮:没带 `runId` 的挂在最后一条助手消息上 */
function targetIndex(messages: ChatMessage[], runId: string | undefined): number {
  if (runId) {
    const i = messages.findIndex((m) => m.id === assistantMessageId(runId));
    if (i >= 0) return i;
  }
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return i;
  return -1;
}

/** `user` 事件里带的附件(服务端带了才有:`attachments: [{ name, url, kind?, size? }]`):重新打开、换设备时气泡里也看得到名字 */
function userAttachments(ev: CloudEvent): { attachments?: ChatAttachment[] } {
  if (!Array.isArray(ev.attachments)) return {};
  const list: ChatAttachment[] = [];
  for (const a of ev.attachments as unknown[]) {
    const o = a && typeof a === "object" ? (a as Record<string, unknown>) : null;
    const url = o && typeof o.url === "string" ? o.url : "";
    if (!o || !url) continue;
    const name = typeof o.name === "string" && o.name ? o.name : url.slice(url.lastIndexOf("/") + 1);
    list.push({ url, name, kind: cloudAttachKind(o.kind, name), ...(typeof o.size === "number" ? { bytes: o.size } : {}), status: "ready" });
  }
  return list.length ? { attachments: list } : {};
}

/** 折一个事件。不认得的事件原样放过(服务端以后加类型不会让页面坏掉) */
export function applyCloudEvent(messages: ChatMessage[], ev: CloudEvent): ChatMessage[] {
  const runId = typeof ev.runId === "string" ? ev.runId : undefined;

  if (ev.type === "user") {
    if (typeof ev.messageId === 'string' && ev.messageId && typeof ev.prompt === 'string' &&
      Number.isSafeInteger(ev.seq) && Number(ev.seq) > 0 && typeof ev.senderAccountId === 'string' && typeof ev.senderNameAtSend === 'string') {
      const id = accountMessageId(ev.messageId);
      return messages.some(message => message.id === id) ? messages : [...messages, { id, role: 'user', text: ev.prompt }];
    }
    if (!runId || messages.some((m) => m.id === userMessageId(runId))) return messages;
    const at = typeof ev.at === "number" ? ev.at : undefined;
    return [
      ...messages,
      { id: userMessageId(runId), role: "user", text: String(ev.prompt ?? ""), ...userAttachments(ev) },
      freshAssistant(runId, at),
    ];
  }

  const idx = targetIndex(messages, runId);
  if (idx < 0) return messages;
  const m = messages[idx];
  // 每条助手消息记着折到过的最大 seq:同一个事件重复到达(重连交界处、从头重读)只折一次,折函数对重放是幂等的
  const seq = typeof ev.seq === "number" ? ev.seq : null;
  if (seq !== null && seq <= (m.cloudSeq ?? 0)) return messages;
  const set = (patch: Partial<ChatMessage>): ChatMessage[] => {
    const next = messages.slice();
    next[idx] = { ...m, ...patch, ...(seq !== null ? { cloudSeq: seq } : {}) };
    return next;
  };

  switch (ev.type) {
    case "text": {
      const delta = typeof ev.delta === "string" ? ev.delta : typeof ev.text === "string" ? ev.text : "";
      return delta ? set({ text: m.text + delta, parts: appendTextPart(m.parts, delta) }) : messages;
    }
    case "thinking": {
      const delta = typeof ev.delta === "string" ? ev.delta : "";
      return delta ? set({ parts: appendThinkingPart(m.parts, delta) }) : messages;
    }
    case "tool_call": {
      const callId = typeof ev.callId === "string" ? ev.callId : undefined;
      if (callId && m.parts?.some((p) => p.kind === "tool" && p.callId === callId)) return messages;
      const name = String(ev.name ?? "");
      return set({
        tools: [...(m.tools ?? []), { name, input: ev.input, callId, expanded: false }],
        parts: [...(m.parts ?? []), { kind: "tool", name, input: ev.input, callId }],
      });
    }
    case "tool_result": {
      const tools = m.tools ? m.tools.map((t) => ({ ...t })) : [];
      const callId = typeof ev.callId === "string" ? ev.callId : undefined;
      for (let i = tools.length - 1; i >= 0; i--) {
        if ((callId ? tools[i].callId === callId : tools[i].name === ev.name) && tools[i].ok === undefined) {
          tools[i].ok = ev.ok === true;
          tools[i].summary = typeof ev.summary === "string" ? ev.summary : undefined;
          tools[i].files = Array.isArray(ev.files) ? (ev.files as string[]) : undefined;
          tools[i].durationMs = typeof ev.durationMs === "number" ? ev.durationMs : undefined;
          break;
        }
      }
      return set({ tools, parts: completeTool(m.parts, ev) });
    }
    case "progress": {
      const { type: _t, seq: _s, runId: _r, ...rest } = ev;
      return set({ progress: { ...m.progress, ...(rest as object) } as ChatMessage["progress"] });
    }
    case "status": {
      const text = typeof ev.text === "string" ? ev.text : "";
      if (!text) return messages;
      return set({ statuses: [...(m.statuses ?? []), text], parts: [...(m.parts ?? []), { kind: "status", text }] });
    }
    case "render": {
      const text = renderStatusText(ev);
      if (!text) return messages;
      return set({ statuses: [...(m.statuses ?? []), text], parts: [...(m.parts ?? []), { kind: "status", text }], cloudRender: { state: String(ev.state ?? ""), text } });
    }
    case "error": {
      return set({ error: cloudErrorMessage(typeof ev.code === "string" ? ev.code : undefined, typeof ev.message === "string" ? ev.message : undefined), pending: false, outcome: "error", finishedAt: Date.now() });
    }
    case "done": {
      return set({ pending: false, finishedAt: Date.now(), outcome: m.outcome === "error" ? "error" : typeof ev.outcome === "string" ? ev.outcome : m.outcome || "completed", usage: ev.usage });
    }
    case "end": {
      if (m.outcome === "error") return set({ pending: false, finishedAt: m.finishedAt ?? Date.now() });
      // 主人停掉的那一轮没有 done:收尾事件带 `reason: "stopped"`(契约第 20 节)
      const stopped = ev.reason === "stopped";
      return set({ pending: false, finishedAt: m.finishedAt ?? Date.now(), outcome: m.outcome || (stopped ? "aborted" : "completed") });
    }
    default:
      return messages;
  }
}

/** Queue revision is independent from the arrival cursor; all rows are authoritative. */
export function queueSnapshot(ev: CloudEvent, conversationId: string): CloudQueueSnapshot | null {
  if (ev.type !== 'queue.state' || ev.conversationId !== conversationId || !Number.isSafeInteger(ev.queueRevision) || Number(ev.queueRevision) < 0 ||
    !Number.isSafeInteger(ev.aclRevision) || Number(ev.aclRevision) < 0 || !(ev.currentRunId === null || typeof ev.currentRunId === 'string') || !Array.isArray(ev.items)) return null;
  const ids = new Set<string>(); const positions = new Set<number>();
  for (const item of ev.items) {
    if (!item || typeof item.messageId !== 'string' || !item.messageId || ids.has(item.messageId) ||
      !Number.isSafeInteger(item.arrivalSeq) || item.arrivalSeq < 1 || !['queued', 'preparing', 'running', 'done', 'cancelled'].includes(item.state) ||
      !(item.runId === null || typeof item.runId === 'string')) return null;
    ids.add(item.messageId);
    if (item.state === 'queued') {
      if (!Number.isSafeInteger(item.position) || item.position < 1 || positions.has(item.position)) return null;
      positions.add(item.position);
    } else if (item.position !== null) return null;
  }
  if ([...positions].some(value => value > positions.size)) return null;
  const pending = [...ev.items].filter(item => item.state === 'queued').sort((a, b) => a.arrivalSeq - b.arrivalSeq);
  if (pending.some((item, index) => item.position !== index + 1)) return null;
  return { conversationId, queueRevision: Number(ev.queueRevision), aclRevision: Number(ev.aclRevision),
    currentRunId: ev.currentRunId as string | null, items: ev.items.map(item => ({ ...item })) };
}

/** 按顺序折一串事件;文字与思考的增量由调用方先攒批再交进来也一样(这里一条一条折,结果相同) */
export function applyCloudEvents(messages: ChatMessage[], events: Iterable<CloudEvent>): ChatMessage[] {
  let out = messages;
  for (const ev of events) out = applyCloudEvent(out, ev);
  return out;
}

/** 对话里此刻有没有没收尾的一轮 */
export function hasOpenRun(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === "assistant" && m.pending === true);
}

/** 对话标题:第一条用户消息的前 40 个字(服务端没给标题时页面自己这么取,与契约 7.1 节一致) */
export function titleOf(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = (first?.text ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 40) : "云端对话";
}
