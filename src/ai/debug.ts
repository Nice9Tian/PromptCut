import type { ChatMessage, MessageRuntime, PublicAiConfig, RunEvent } from './types';

// Redact structured secrets and common pasted credentials; never include API
// headers, raw settings files, or provider reasoning channels in an export.
export function redactDebug(value: unknown): unknown {
  const secret = /^(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|cookie|set-cookie)$/i;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
      .replace(/([?&](?:key|api_key|access_token|refresh_token)=)[^&\s]+/gi, '$1[REDACTED]');
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, secret.test(k) ? '[REDACTED]' : walk(x)]));
    return v;
  };
  return walk(value);
}

export function recordTrace(message: ChatMessage, event: RunEvent): ChatMessage {
  const trace = message.trace || [];
  if ((trace.length >= 2000 || (message.traceBytes || 0) >= 1500000) && event.type !== 'done' && event.type !== 'error') return { ...message, traceTruncated: true };
  const serialized = JSON.stringify(redactDebug(event));
  // Huge project/video results should not fill localStorage or freeze the UI.
  const safeEvent: RunEvent = serialized.length > 32000
    ? { type: 'diagnostic', stage: 'large_event_truncated', data: { originalType: event.type, chars: serialized.length, preview: serialized.slice(0, 32000) } }
    : JSON.parse(serialized);
  const last = trace.at(-1);
  if (safeEvent.type === 'text' && last?.event.type === 'text' && last.event.delta.length < 8000) {
    return { ...message, traceBytes: (message.traceBytes || 0) + serialized.length, trace: [...trace.slice(0, -1), { ...last, event: { type: 'text', delta: last.event.delta + safeEvent.delta } }] };
  }
  return { ...message, traceBytes: (message.traceBytes || 0) + Math.min(serialized.length, 32000), trace: [...trace, { at: new Date().toISOString(), event: safeEvent }], traceTruncated: message.traceTruncated || serialized.length > 32000 };
}

/** 同一套设置压成一行,用来数「这段对话里前后到底用过几种配置」 */
function runtimeKey(r: MessageRuntime): string {
  return [r.provider, r.model || '(默认)', r.effort || '(默认)', r.fast ? 'fast' : '-', r.toolProtocol ? 'textproto' : '-'].join(' / ');
}

/**
 * 一句人话描述这条回复用的是什么，放进报告顶上，省得从几百行 JSON 里翻。
 */
function describeRuntime(r: MessageRuntime): string {
  const bits = [r.provider, `模型 ${r.model || '默认'}`, `思考 ${r.effort || '默认'}`];
  if (r.fast) bits.push('加速');
  if (r.toolProtocol) bits.push('文本协议模式');
  return bits.join('，');
}

export function conversationReport(messages: ChatMessage[], provider: string | null, config?: PublicAiConfig | null): string {
  /*
   * 每条回复自己带 runtime。只报「当前选的是什么」会看错人：模型、思考档、加速档
   * 都是发送那一刻现读的，用户聊到一半换一次，前后几条就来自不同的模型；分工模式
   * 下还会按角色临时改用别家。中途换过就在这里直接点出来。
   */
  const used = new Map<string, MessageRuntime>();
  let unrecorded = 0;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    if (m.runtime) used.set(runtimeKey(m.runtime), m.runtime);
    else unrecorded++;
  }
  const distinct = [...used.values()];

  return JSON.stringify(redactDebug({
    format: 'PromptCut conversation debug v2', exportedAt: new Date().toISOString(), provider,
    runtime: {
      switchedMidConversation: distinct.length > 1,
      summary: distinct.length === 0
        ? '这段对话里没有一条记了运行配置（0.2.9 之前的旧历史）'
        : distinct.length === 1
          ? `全程一套配置：${describeRuntime(distinct[0])}`
          : `⚠ 中途换过配置，共 ${distinct.length} 套，逐条见 messages[].runtime`,
      used: distinct.map((r) => ({ ...r, 说明: describeRuntime(r) })),
      // 旧历史里的回复没有这个字段，说清楚是「没记」而不是「没换过」
      unrecordedAssistantMessages: unrecorded,
      textProtocolEverUsed: distinct.some((r) => r.toolProtocol),
    },
    api: provider === 'api' ? { vendor: config?.api.vendor, model: config?.api.model, maxTokens: config?.api.maxTokens } : undefined,
    note: '包含可见对话和执行事件；不包含密钥或模型私有思考。大输出和过长事件会标明截断。', messages,
  }), null, 2);
}

export async function copyDebugReport(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return; } catch { /* WebView/permissions fallback. */ }
  const field = document.createElement('textarea');
  field.value = text; field.style.position = 'fixed'; field.style.opacity = '0';
  document.body.appendChild(field); field.select();
  try { if (!document.execCommand('copy')) throw new Error('自动复制失败，请手动复制下面的内容。'); }
  finally { field.remove(); }
}
