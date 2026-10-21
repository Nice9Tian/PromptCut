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
import type { CloudEvent, CloudQueueSnapshot, CloudQueueItem, CloudAcceptedBinding, CloudRunBinding, CloudAccountMessage } from "./types.ts";

export const userMessageId = (runId: string) => `cu-${runId}`;
export const accountMessageId = (messageId: string) => `cq-${messageId}`;
export const assistantMessageId = (runId: string) => `ca-${runId}`;

/** 每个收尾原因在对话里留给人看的话(契约 7.3 节)。服务端的 `error.message` 优先,没给才用这里的 */
export function cloudErrorMessage(code: string | undefined, message?: string): string {
  // 没带 code 的 error 是模型调用那一路抛的(账号运行器不给模型错误打 code);带 code 的(额度、开关、轮数上限……)服务端已写好话
  if (typeof message === "string" && message) return friendlyErrorMessage(message, code === undefined || code === "model");
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

/** 给人看的原因最长这么多个字:模型网关回来的原文可能带整段报文 */
const REASON_MAX = 80;

/** 去掉密钥、令牌、请求号、网址这类不该给用户看的东西,压成一行并截短 */
export function shortReason(raw: string): string {
  const text = raw
    .replace(/\(?\s*(?:request[ _-]?id|req[ _-]?id|trace[ _-]?id)\s*[:=]\s*[\w.-]+\s*\)?/gi, "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "")
    .replace(/\b(?:sk|pk|key|tok|token|api)[-_][A-Za-z0-9_-]{8,}/gi, "")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text;
}

/**
 * 服务端的 `error.message` 变成给人看的话(出错留痕,语义 product/agent.md)。
 * 模型网关的报错形如 `openai HTTP 403: token quota is not enough, ...`,原文是英文又带请求号和金额,用户读不懂也无从下手。
 * 已经是中文的话(服务端自己写的「已失效」「中断」等)原样放过;不认得的英文报错压成一句短原因,不带密钥、请求号、网址。
 */
export function friendlyErrorMessage(message: string, model = false): string {
  const http = /\bHTTP\s+(\d{3})\b/i.exec(message);
  const status = http ? Number(http[1]) : 0;
  const quota = /quota|insufficient[ _-]?(?:funds|balance|credit)|out of credit|billing|balance/i.test(message);
  if (/[一-鿿]/.test(message) && !quota) {
    const said = shortReason(message);
    if (!said) return model ? "模型调用失败。" : "云端 Agent 出错了。";
    return model && !said.startsWith("模型") ? `模型调用失败:${said}` : said;
  }
  if (quota && (!status || status === 402 || status === 403 || status === 429)) return "模型服务的额度不够,这一轮没有执行(需要托管方充值)。已经落地的改动保留在项目里。";
  if (status === 401 || (status === 403 && /api[ _-]?key|unauthori[sz]ed|forbidden|permission|invalid.*(?:key|token)/i.test(message))) {
    return "模型服务拒绝了云端 Agent 的凭证,这一轮没有执行(需要托管方检查模型配置)。";
  }
  if (status === 429) return "模型服务太忙(请求过于频繁),这一轮没有执行,请稍后再试。";
  if (status === 404) return "托管方配置的模型找不到,这一轮没有执行(需要托管方检查模型配置)。";
  if (status >= 500) return `模型服务暂时出了故障(HTTP ${status}),这一轮没有执行,请稍后再试。`;
  if (/timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|network|socket hang up/i.test(message)) {
    return "连不上模型服务(网络超时或被断开),这一轮没有执行,请稍后再试。";
  }
  const reason = shortReason(message);
  if (http) return reason ? `模型调用失败(HTTP ${status}):${reason}` : `模型调用失败(HTTP ${status})。`;
  if (model) return reason ? `模型调用失败:${reason}` : "模型调用失败。";
  return reason ? `云端 Agent 出错了:${reason}` : "云端 Agent 出错了。";
}

/** 文档服务签的强制终态原因(账本 `outcome.reason`)→ 对话里留给人看的话;没有对应的返回 null */
function forcedStopReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case "worker-failed": return "云端执行这一轮的进程出了故障,这一轮没有做完。已经落地的改动保留在项目里。";
    case "agent-disabled": return "项目创建者已关闭云端 Agent,这一轮已停止。已经落地的改动保留在项目里。";
    case "member-revoked": return "你已不在这个项目里,这一轮已停止。已经落地的改动保留在项目里。";
    case "credential-revoked": return "你的登录已失效,这一轮已停止。已经落地的改动保留在项目里。";
    case "private": return "这个对话被切成了私有,这一轮已停止。已经落地的改动保留在项目里。";
    default: return null;
  }
}

/** 预渲染重试进展(契约 16 节)写成一行状态 */
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
    // 「生成轨道流」关着:托管渲染节点不为这个项目产流(product/rendering.md「谁产流与托管方开关」),云端没有渲
    case "off": return "这个项目没开「生成轨道流」,云端不为预览生成轨道流;重卡会在打开项目的设备上生成(Agent 看画面照常由云端渲染)";
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

const acceptedKeys = ['projectId', 'conversationId', 'messageId', 'senderAccountId'] as const;
const runKeys = [...acceptedKeys, 'runId', 'runGrantId', 'instanceId', 'instanceGeneration', 'serviceKid'] as const;
const pendingSettlementText = '执行已结束，等待云端确认关闭与结算。';
function acceptedBinding(ev: CloudEvent): CloudAcceptedBinding | null {
  if (acceptedKeys.some(key => typeof ev[key] !== 'string' || !ev[key])) return null;
  return Object.fromEntries(acceptedKeys.map(key => [key, ev[key]])) as unknown as CloudAcceptedBinding;
}
function runBinding(ev: CloudEvent): CloudRunBinding | null {
  const accepted = acceptedBinding(ev);
  if (!accepted || !Number.isSafeInteger(ev.seq) || Number(ev.seq) < 1 ||
    !Number.isSafeInteger(ev.instanceGeneration) || Number(ev.instanceGeneration) < 1 ||
    ['runId', 'runGrantId', 'instanceId', 'serviceKid'].some(key => typeof ev[key] !== 'string' || !ev[key])) return null;
  return Object.fromEntries(runKeys.map(key => [key, ev[key]])) as unknown as CloudRunBinding;
}
function sameBinding(a: CloudAcceptedBinding, b: CloudAcceptedBinding, keys: readonly (keyof CloudRunBinding)[]): boolean {
  return keys.every(key => (a as CloudRunBinding)[key] === (b as CloudRunBinding)[key]);
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
      const accepted = acceptedBinding(ev);
      const message: CloudAccountMessage = { id, role: 'user', text: ev.prompt,
        ...(accepted ? { cloudAccepted: accepted, ...userAttachments(ev) } : {}) };
      return messages.some(message => message.id === id) ? messages : [...messages, message];
    }
    if (acceptedKeys.some(key => ev[key] !== undefined) || ev.runGrantId !== undefined || ev.instanceId !== undefined) return messages;
    if (!runId || messages.some((m) => m.id === userMessageId(runId))) return messages;
    const at = typeof ev.at === "number" ? ev.at : undefined;
    return [
      ...messages,
      { id: userMessageId(runId), role: "user", text: String(ev.prompt ?? ""), ...userAttachments(ev) },
      freshAssistant(runId, at),
    ];
  }

  const binding = runBinding(ev);
  if (ev.type === 'run' && binding) {
    const userIndex = messages.findIndex(m => m.id === accountMessageId(binding.messageId) && m.role === 'user');
    const accepted = userIndex >= 0 ? (messages[userIndex] as CloudAccountMessage).cloudAccepted : undefined;
    if (!accepted || !sameBinding(accepted, binding, acceptedKeys)) return messages;
    // A repeated run row cannot reset the assistant or adopt another grant.
    if (messages.some(m => m.id === assistantMessageId(binding.runId))) return messages;
    const assistant: CloudAccountMessage = { ...freshAssistant(binding.runId, typeof ev.at === 'number' ? ev.at : undefined),
      cloudRun: binding, cloudAcceptedMessageId: accountMessageId(binding.messageId), cloudSeq: Number(ev.seq) };
    return [...messages.slice(0, userIndex + 1), assistant, ...messages.slice(userIndex + 1)];
  }
  // Account events never borrow an unrelated last assistant. A partial binding
  // is rejected too; it cannot turn a malformed v2 row into legacy behavior.
  const accountEvent = acceptedKeys.some(key => ev[key] !== undefined) ||
    ['runGrantId', 'instanceId', 'instanceGeneration', 'serviceKid'].some(key => ev[key] !== undefined);
  const idx = accountEvent ? (binding ? messages.findIndex(m => m.id === assistantMessageId(binding.runId)) : -1) : targetIndex(messages, runId);
  if (idx < 0) return messages;
  const m = messages[idx] as CloudAccountMessage;
  if (accountEvent || m.cloudRun) {
    if (!binding || !m.cloudRun || !sameBinding(m.cloudRun, binding, runKeys)) return messages;
  }
  // 每条助手消息记着折到过的最大 seq:同一个事件重复到达(重连交界处、从头重读)只折一次,折函数对重放是幂等的
  const seq = typeof ev.seq === "number" ? ev.seq : null;
  if (seq !== null && seq <= (m.cloudSeq ?? 0)) return messages;
  const set = (patch: Partial<CloudAccountMessage>): ChatMessage[] => {
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
      if (m.cloudRun) return set({ error: cloudErrorMessage(typeof ev.code === 'string' ? ev.code : undefined,
        typeof ev.message === 'string' ? ev.message : undefined), pending: true });
      return set({ error: cloudErrorMessage(typeof ev.code === "string" ? ev.code : undefined, typeof ev.message === "string" ? ev.message : undefined), pending: false, outcome: "error", finishedAt: Date.now() });
    }
    case 'runner_done':
    case "done": {
      if (m.cloudRun) return set({ pending: true, cloudSettlement: 'pending',
        progress: { ...m.progress, phase: 'settlement-pending', text: pendingSettlementText },
        ...(m.cloudSettlement === 'pending' ? {} : { statuses: [...(m.statuses ?? []), pendingSettlementText],
          parts: [...(m.parts ?? []), { kind: 'status', text: pendingSettlementText }] }) });
      if (ev.type === 'runner_done') return messages;
      return set({ pending: false, finishedAt: Date.now(), outcome: m.outcome === "error" ? "error" : typeof ev.outcome === "string" ? ev.outcome : m.outcome || "completed", usage: ev.usage });
    }
    case "end": {
      if (m.cloudRun) return set({ pending: true, cloudSettlement: 'pending',
        progress: { ...m.progress, phase: 'settlement-pending', text: pendingSettlementText },
        ...(m.cloudSettlement === 'pending' ? {} : { statuses: [...(m.statuses ?? []), pendingSettlementText],
          parts: [...(m.parts ?? []), { kind: 'status', text: pendingSettlementText }] }) });
      if (m.outcome === "error") return set({ pending: false, finishedAt: m.finishedAt ?? Date.now() });
      // 主人停掉的那一轮没有 done:收尾事件带 `reason: "stopped"`(契约第 20 节)
      const stopped = ev.reason === "stopped";
      return set({ pending: false, finishedAt: m.finishedAt ?? Date.now(), outcome: m.outcome || (stopped ? "aborted" : "completed") });
    }
    default:
      return messages;
  }
}

/** 队列行里的终态:形状不对就当没有 */
function outcomeOf(value: unknown): CloudQueueItem['outcome'] {
  const o = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!o || typeof o.status !== 'string' || !/^[a-z-]{1,32}$/.test(o.status)) return null;
  return { status: o.status, reason: typeof o.reason === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(o.reason) ? o.reason : null };
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
    currentRunId: ev.currentRunId as string | null, items: ev.items.map(item => ({ ...item, outcome: outcomeOf(item.outcome) })) };
}

/** 文档服务签的终态 → 这一轮在对话里怎么收尾 */
function settledPatch(m: CloudAccountMessage, item: CloudQueueItem): Partial<CloudAccountMessage> {
  const status = item.outcome?.status ?? (item.state === 'done' ? 'done' : 'interrupted');
  const base = { pending: false, cloudSettlement: undefined, finishedAt: m.finishedAt ?? Date.now() };
  if (status === 'done') {
    const outcome = m.outcome === 'error' ? 'error' : m.outcome && m.outcome !== 'completed' ? m.outcome : 'completed';
    return { ...base, outcome, progress: { ...m.progress, phase: 'completed', text: '云端已确认这一轮结束。' } as ChatMessage['progress'] };
  }
  if (status === 'cancelled') return { ...base, outcome: 'aborted', progress: { ...m.progress, phase: 'paused', text: '已停止' } as ChatMessage['progress'] };
  const error = m.error ?? (forcedStopReason(item.outcome?.reason)
    ?? (status === 'failed' ? '云端 Agent 这一轮执行失败了,没有做完。已经落地的改动保留在项目里。'
    : cloudErrorMessage('interrupted')));
  return { ...base, outcome: 'error', error, progress: { ...m.progress, phase: 'paused', text: error } as ChatMessage['progress'] };
}

/**
 * 账号模式下一轮跑完只到「执行已结束，等待云端确认关闭与结算」(`runner_done`):事件流里没有结算事件,
 * 结清与否只在 `queue.state` 里——文档服务把这条消息记成 `done` / `cancelled` 并给出终态。据它把还挂着的那一轮收掉,
 * 否则界面会一直读秒「正在思考」(2026-10-17 实跑)。已经收掉的、队列里还没结清的不动;同一份快照折几次结果相同。
 */
export function settleFromQueue(messages: ChatMessage[], queue: CloudQueueSnapshot | null): ChatMessage[] {
  if (!queue) return messages;
  let next: ChatMessage[] | null = null;
  for (const item of queue.items) {
    if ((item.state !== 'done' && item.state !== 'cancelled') || (item.runId && queue.currentRunId === item.runId)) continue;
    const cur: ChatMessage[] = next ?? messages;
    const idx = item.runId ? cur.findIndex(m => m.id === assistantMessageId(item.runId as string)) : -1;
    if (idx < 0) {
      // 这一轮在第一个事件之前就失败或中断了(任务进程起不来、领到就死)：流里没有它的任何事件，只有队列里的终态。
      // 在那条用户消息后面补一条失败的回复，写上原因；不补的话用户什么都看不到(2026-10-19 在线实测：账本记了 failed / worker-failed，页面空白)。
      const status = item.outcome?.status;
      if (status !== 'failed' && status !== 'interrupted') continue;
      const id = item.runId ? assistantMessageId(item.runId) : `ca-q-${item.messageId}`;
      if (cur.some(m => m.id === id)) continue;
      const userIndex = cur.findIndex(m => m.id === accountMessageId(item.messageId) && m.role === 'user');
      if (userIndex < 0) continue;
      const failed: CloudAccountMessage = { id, role: 'assistant', text: '', parts: [], tools: [], statuses: [], pending: false,
        ...settledPatch({ id, role: 'assistant', text: '', pending: true } as CloudAccountMessage, item) };
      next = [...cur.slice(0, userIndex + 1), failed, ...cur.slice(userIndex + 1)];
      continue;
    }
    const m = cur[idx] as CloudAccountMessage;
    if (!m.cloudRun || m.pending !== true) continue;
    next = cur === messages ? messages.slice() : cur;
    next[idx] = { ...m, ...settledPatch(m, item) };
  }
  return next ?? messages;
}

/**
 * 对话空闲(没有在跑的一轮)时排在第一位的那条消息马上就要开始,不算「排队」:界面不把它列进队列,
 * 只在它自己的气泡下写一行「已发出，等待云端开始处理…」(`sendState: "accepted"`);开始跑了、或前面有别人的一轮在跑时去掉这行。
 * 前面有一轮在跑时照旧显示排在第几(2026-10-08 用户定「界面显示排在第几」)。同一份快照折几次结果相同。
 */
export function isIdleHead(queue: CloudQueueSnapshot | null | undefined, item: CloudQueueItem): boolean {
  return Boolean(queue && !queue.currentRunId && item.state === "queued" && item.position === 1);
}
export function markWaitingFromQueue(messages: ChatMessage[], queue: CloudQueueSnapshot | null): ChatMessage[] {
  if (!queue) return messages;
  const waiting = new Set(queue.items.filter((item) => isIdleHead(queue, item)).map((item) => accountMessageId(item.messageId)));
  let next: ChatMessage[] | null = null;
  messages.forEach((m, i) => {
    if (m.role !== "user" || !m.id.startsWith("cq-")) return;
    const want = waiting.has(m.id) ? "accepted" : undefined;
    if (m.sendState === want) return;
    next ??= messages.slice();
    const { sendState: _drop, ...rest } = m;
    next[i] = want ? { ...rest, sendState: want } : rest;
  });
  return next ?? messages;
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
