export type AiProvider = "claude" | "agy" | "codex" | "api";

export interface AuthInfo {
  loggedIn: boolean | null;
  detail?: string;
  fixHint?: string;
  loginCommand?: string[];
}

export interface ProviderInfo {
  id: AiProvider;
  label: string;
  available: boolean;
  version?: string;
  path?: string;
  note?: string;
  auth?: AuthInfo;
}

export type ApiVendor = "anthropic" | "openai" | "gemini";

export type LoginState = "idle" | "waiting" | "ok" | "timeout" | "failed";

export interface PublicAiConfig {
  version: number;
  defaultProvider: AiProvider | null;
  api: {
    vendor: ApiVendor;
    baseUrl: string;
    model: string;
    maxTokens: number;
    apiKey: { set: boolean; last4: string };
  };
  toolProtocol: boolean;
}

export interface AiConfigPatch {
  defaultProvider?: AiProvider | null;
  api?: {
    vendor?: ApiVendor;
    baseUrl?: string;
    model?: string;
    maxTokens?: number;
    apiKey?: string | null;
  };
  toolProtocol?: boolean;
}

export interface SttInfo {
  engine: string;
  available: boolean;
  hint?: string;
}

export type RunEvent =
  | { type: "run"; runId: string }
  | { type: "session"; sessionId: string }
  | { type: "text"; delta: string }
  | { type: "tool_call"; name: string; input?: unknown }
  | { type: "tool_result"; name: string; ok: boolean; summary?: string; files?: string[] }
  | { type: "status"; text: string }
  | { type: "done"; sessionId?: string; usage?: unknown }
  | { type: "error"; message: string };

export interface ChatAttachment {
  url: string;
  name: string;
  kind: "video" | "srt" | "json" | "other" | "image" | "audio" | "text" | "pdf";
  text?: string;
  durationSec?: number;
  id?: string;
  mime?: string;
  bytes?: number;
  srcPath?: string | null;
  path?: string;
  status?: "importing" | "ready" | "error";
  error?: string;
  jobId?: string;
  conversationId?: string;
}

export interface ToolCallInfo {
  name: string;
  input?: unknown;
  ok?: boolean;
  summary?: string;
  files?: string[];
  expanded?: boolean;
}

/**
 * 一条助手消息里按**发生顺序**排列的片段。
 * 只有 text / tools / statuses 三个数组时,渲染只能把文字全堆在最上面、
 * 工具调用全堆在下面,时序丢失——一轮里有多次工具调用时,用户滚到底只看得见工具块,
 * 看不见回复。parts 保留真实顺序,详细模式按它渲染。
 */
export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "status"; text: string }
  | ({ kind: "tool" } & ToolCallInfo);

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** 纯文字部分的拼接;简洁模式和会话历史都用它 */
  text: string;
  attachments?: ChatAttachment[];
  /** 按发生顺序的片段,渲染以它为准;旧历史里没有时由 text/tools/statuses 兜底 */
  parts?: MessagePart[];
  tools?: ToolCallInfo[];
  statuses?: string[];
  error?: string;
  pending?: boolean;
}

export interface CliSetupJob {
  id: string;
  provider: AiProvider;
  kind: "install" | "login";
  state: "running" | "succeeded" | "failed";
  message: string;
  logs: string[];
  url?: string;
  deviceCode?: string;
}
