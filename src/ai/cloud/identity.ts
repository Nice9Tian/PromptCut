/**
 * 云端 Agent 的身份接口位(契约 `docs/plan/cloud-agent-contract.md` 第 4 节、第 10.4 节)。
 *
 * 页面打 Agent 服务的每个请求都要带文档服务签的「委托票据」(2 分钟),发消息还要带这一轮的「对话委托」(60 分钟)。
 * 怎么向文档服务要这两样,由并行分支 `claude/cloud-agent-auth` 做;这里只留一个可注入的接口,合流后由主会话安排接真的:
 *
 *     setCloudIdentity({ getTicket: () => ..., getGrant: (conversationId) => ... });
 *
 * 没注入时读 `globalThis.__pcCloudIdentity`(探针与手工验证用的替身口子,形状同 `CloudIdentity`);
 * 两处都没有就抛 `CloudIdentityError`,界面显示「云端 Agent 暂时用不了:还没有取得身份证明」,什么请求都不发。
 *
 * 本文件不引 React、不引 `mode.ts`,Node 单测直接用。
 */

export interface CloudIdentity {
  /** 委托票据。每个请求现取一次,不缓存(它只活 2 分钟) */
  getTicket(): Promise<string> | string;
  /** 这个对话下一轮要带的对话委托;云端不要求时可以回 undefined */
  getGrant?(conversationId: string): Promise<string | undefined> | string | undefined;
}

export class CloudIdentityError extends Error {
  readonly code = "no-identity";
  constructor(message = "还没有取得云端 Agent 的身份证明") {
    super(message);
    this.name = "CloudIdentityError";
  }
}

let injected: CloudIdentity | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** 合流后由接真身份的那一处调用;传 null 撤掉。身份就绪(或换了)时通知订阅方:界面据此重新取一次云端的 info 与对话列表 */
export function setCloudIdentity(next: CloudIdentity | null): void {
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
  const stub = (globalThis as Record<string, unknown>).__pcCloudIdentity as CloudIdentity | undefined;
  if (stub && typeof stub.getTicket === "function") return stub;
  throw new CloudIdentityError();
}

export function hasCloudIdentity(): boolean {
  try {
    current();
    return true;
  } catch {
    return false;
  }
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
