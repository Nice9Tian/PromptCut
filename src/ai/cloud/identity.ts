/**
 * 云端 Agent 的身份接口位(契约 `docs/plan/cloud-agent-contract.md` 第 4 节、第 10.4 节)。
 *
 * 页面打 Agent 服务的每个请求都要带文档服务签的「委托票据」(2 分钟),发消息还要带这一轮的「对话委托」(60 分钟)。
 * 两样都在页面自己到文档服务的那条连接上要(`auth.ticket { kind: 'delegate', audience: 'agent', conversation? }`):
 * 同步管理(`src/editor/sync/syncManager.ts`)接上共享项目时调 `setCloudIdentity` 注入,离开时撤掉。在线页面与桌面版同一条路。
 *
 * **只有这一个来源**:没有任何全局变量的回退口子(生产构建里不留后门,守门单测 CAU-ID-02)。没注入就抛 `CloudIdentityError`,
 * 界面显示「云端 Agent 暂时用不了:还没有取得身份证明」,什么请求都不发。
 *
 * 文档服务拒签时(项目关了开关回 `service-disabled`)实现方抛 `CloudDelegationError`,接口层据此显示「项目创建者已关闭云端 Agent」。
 *
 * 本文件不引 React、不引 `mode.ts`,Node 单测直接用。
 */

export interface CloudIdentity {
  /** 委托票据。每个请求现取一次,不缓存(它只活 2 分钟) */
  getTicket(): Promise<string> | string;
  /** 这个对话下一轮要带的对话委托(每发一条消息取一张新的) */
  getGrant?(conversationId: string): Promise<string | undefined> | string | undefined;
}

/** Account-v2 delegates come only from the current doc session, never auth.ticket. */
export function accountCloudIdentity(options: {
  projectId: string;
  isCurrent: () => boolean;
  session: () => Promise<{ projectId: string; agentDelegationTicket: string }>;
}): CloudIdentity {
  return { async getTicket() {
    if (!options.isCurrent()) throw new CloudIdentityError();
    const value = await options.session();
    if (!options.isCurrent() || value.projectId !== options.projectId || !/^[A-Za-z0-9_-]{43}$/.test(value.agentDelegationTicket)) throw new CloudIdentityError();
    return value.agentDelegationTicket;
  } };
}

export class CloudIdentityError extends Error {
  readonly code = "no-identity";
  constructor(message = "还没有取得云端 Agent 的身份证明") {
    super(message);
    this.name = "CloudIdentityError";
  }
}

/** 文档服务不肯签委托(`code` 是它回的原因,如 `service-disabled`、`forbidden`、`closed`) */
export class CloudDelegationError extends Error {
  readonly code: string;
  constructor(reason: string) {
    super(`文档服务没有签发云端 Agent 的委托(${reason})`);
    this.name = "CloudDelegationError";
    this.code = reason;
  }
}

let injected: CloudIdentity | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** 同步管理接上共享项目时调用;传 null 撤掉。身份就绪(或换了)时通知订阅方:界面据此重新取一次云端的 info 与对话列表 */
export function setCloudIdentity(next: CloudIdentity | null): void {
  if (injected === next) return;
  injected = next;
  version++;
  for (const l of [...listeners]) l();
}

export function subscribeCloudIdentity(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function cloudIdentityVersion(): number {
  return version;
}

function current(): CloudIdentity {
  if (injected) return injected;
  throw new CloudIdentityError();
}

export function hasCloudIdentity(): boolean {
  return injected !== null;
}

export async function cloudTicket(): Promise<string> {
  const t = await current().getTicket();
  if (typeof t !== "string" || !t) throw new CloudIdentityError("文档服务没有给出云端 Agent 的委托票据");
  return t;
}

export async function cloudGrant(conversationId: string): Promise<string | undefined> {
  const id = current();
  if (typeof id.getGrant !== "function") return undefined;
  const g = await id.getGrant(conversationId);
  return typeof g === "string" && g ? g : undefined;
}
