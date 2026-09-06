import type { ChatMessage, PublicAiConfig, RunEvent } from './types';

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

export function conversationReport(messages: ChatMessage[], provider: string | null, config?: PublicAiConfig | null): string {
  return JSON.stringify(redactDebug({
    format: 'PromptCut conversation debug v1', exportedAt: new Date().toISOString(), provider,
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
