/** 云端 Agent 服务的接口形状(契约 2.3、2.4 节);以 `server/agent-service/http.mjs` 的实际回包为准,只多不少地容错 */

export interface CloudModelChoice {
  id: string;
  label?: string;
}

export interface CloudInfo {
  enabled: boolean;
  /** 托管方配置的模型;一个或没有时界面不给选 */
  models: CloudModelChoice[];
  defaultModel: string | null;
  /** 这位成员在这个项目里还在跑的对话 id */
  running: string[];
  limits: { rounds?: number; runMs?: number };
  usage?: { tokens?: number; limitTokens?: number | null };
}

export type CloudChatState = "idle" | "running" | "interrupted" | "failed" | "revoked";

export interface CloudChatItem {
  id: string;
  title: string;
  /** 毫秒;服务端没给时是 0 */
  updatedAt: number;
  state: CloudChatState;
  lastSeq: number;
  startedOn?: string | null;
  reason?: string | null;
}

/** 事件流里的一个事件(契约 2.4 节);字段按类型取 */
export interface CloudEvent {
  type: string;
  seq?: number;
  runId?: string;
  [k: string]: unknown;
}

/** 页面状态:发消息时带上的播放头与选区(契约 9.4) */
export interface CloudPageState {
  t: number;
  selection: string[];
}

export interface CloudSendBody {
  prompt: string;
  model?: string;
  effort?: string;
  creativity?: string | null;
  script?: string;
  library?: unknown[];
  pageState?: CloudPageState;
  /** 已经传到这个对话工作目录里的附件(`POST …/attachments` 回包里的 `url`);服务端只认工作目录里真有的 */
  attachments?: { url: string }[];
}
