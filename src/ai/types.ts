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

/** API Key 的两路来源:自定义 API 里自己填的 / Router 分发密文导入的。各自加密、各自成文件,不混用 */
export type KeyKind = "custom" | "router";

/** 一路的连接配置。model 用 | 分隔多个备选,面板输入框旁的模型选择器按它列 */
export interface ApiProfile {
  vendor: ApiVendor;
  baseUrl: string;
  model: string;
}

export interface KeyState { set: boolean; last4: string }

export interface PublicAiConfig {
  version: number;
  defaultProvider: AiProvider | null;
  api: {
    vendor: ApiVendor;
    baseUrl: string;
    model: string;
    maxTokens: number;
    /** 当前生效的那一路的 Key(脱敏) */
    apiKey: KeyState;
    /** 当前生效的是哪一路;没设 Key 时为空串 */
    source: KeyKind | "";
    /** 两路各自的连接配置;上面的 vendor / baseUrl / model 是生效那一路的镜像。老服务端没有这个字段 */
    profiles?: Record<KeyKind, ApiProfile>;
  };
  /** 两路各自存没存 Key */
  keys: Record<KeyKind, KeyState>;
  /** 三家 CLI 各自的可选模型清单,用 | 分隔 */
  cliModels: { claude: string; codex: string; agy: string };
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
    /** 这次的 Key 写进哪一路(缺省 custom);不带 apiKey 时表示切换生效的那一路 */
    source?: KeyKind | "";
    /** 显式改某一路的连接配置,不受 source 影响 */
    profiles?: Partial<Record<KeyKind, Partial<ApiProfile>>>;
  };
  cliModels?: Partial<{ claude: string; codex: string; agy: string }>;
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
  /** 模型的思考过程。和正文分开走,默认不显示,勾了「显示思考」才渲染 */
  | { type: "thinking"; delta: string; round?: number }
  | { type: "tool_call"; name: string; input?: unknown; callId?: string; round?: number }
  | { type: "tool_result"; name: string; ok: boolean; summary?: string; files?: string[]; callId?: string; output?: unknown; durationMs?: number; round?: number }
  | ({ type: "progress" } & RunProgress)
  | { type: "diagnostic"; stage: string; data?: unknown; callId?: string }
  | { type: "status"; text: string }
  | { type: "done"; sessionId?: string; usage?: unknown; outcome?: string; completed?: number; failed?: number }
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
  callId?: string;
  durationMs?: number;
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
  /** 思考片段:和 text 一样按发生顺序插在 parts 里,渲染时由「显示思考」开关决定显不显示 */
  | { kind: "thinking"; text: string }
  | { kind: "status"; text: string }
  | ({ kind: "tool" } & ToolCallInfo);

/**
 * 这条回复实际是拿什么跑出来的。
 *
 * 必须逐条记,不能只记「现在选的是什么」:模型 / 推理档 / 加速档都是**发送那一刻
 * 现读**的(见 modelOptions.readChoice),用户中途换一次,同一段对话里前后几条就
 * 来自不同的模型;分工模式下还会按角色临时改用别家。排查时只看当前选择会认错人。
 */
export interface MessageRuntime {
  provider: AiProvider;
  /** 空 = 用该驱动自己的默认模型 */
  model: string;
  /** 推理强度档;空 = 跟随驱动自己的默认 */
  effort: string;
  /** 加速档(目前只有 Claude Code 有) */
  fast: boolean;
  /** 文本协议模式:工具调用写在回复正文里。工具相关的异常先看这一条 */
  toolProtocol: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /**
   * 分工模式下,这条回复是哪个角色产出的(角色卡的 id,如 director)。
   * 界面用它取头像和角色名;普通对话没有这个字段,退回中性的「AI 助手」。
   */
  roleId?: string;
  /** 纯文字部分的拼接;简洁模式和会话历史都用它 */
  text: string;
  attachments?: ChatAttachment[];
  /** 按发生顺序的片段,渲染以它为准;旧历史里没有时由 text/tools/statuses 兜底 */
  parts?: MessagePart[];
  tools?: ToolCallInfo[];
  statuses?: string[];
  error?: string;
  pending?: boolean;
  startedAt?: number;
  finishedAt?: number;
  progress?: RunProgress;
  outcome?: string;
  usage?: unknown;
  /** 这条回复用的模型/推理档/加速档/文本协议。旧历史里没有,报告里显示为「未记录」 */
  runtime?: MessageRuntime;
  trace?: { at: string; event: RunEvent }[];
  traceTruncated?: boolean;
  traceBytes?: number;
}

export interface RunProgress {
  phase: string;
  text: string;
  round?: number;
  maxRounds?: number;
  completed?: number;
  failed?: number;
  elapsedMs?: number;
  callId?: string;
  jobId?: string;
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
