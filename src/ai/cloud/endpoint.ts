/**
 * 云端 Agent 在哪、能不能用(契约 9.5、10.1、10.4 节)。
 *
 * 地址与开关都由文档服务下发(成员列表回包顶层 `hosted.agent: { available, enabled, url }`),`syncManager` 收到后调
 * `setHostedAgent` 记下;开关变了的通知(`hosted-service-changed`)调 `setHostedAgentEnabled`。**只有这一个来源**,没有全局变量的回退口子。
 *
 * - 桌面版:放本机的项目没有这个字段,所以「云端」一项出不来;
 * - 在线页面:成员列表还没到的那一小会儿先按同源的 `/agent/v1`(经 nginx 的 `/agent/`)、开着算;到了之后以它为准——
 *   地址用它给的 `url`(托管端没配公网地址时仍是同源的那个),`available` 为假(这台托管端没有云端 Agent)时界面说明用不了。
 *
 * 本文件不引 React、不引 `mode.ts`(在线与否由调用方传进来),Node 单测直接用。
 */

export interface HostedAgentInfo {
  available: boolean;
  enabled: boolean;
  url: string | null;
}

export interface CloudAgentAvailability {
  /** 这个项目背后有云端 Agent 服务(「云端」一项该不该出现) */
  available: boolean;
  /** 创建者没关开关(关着时「云端」一项在、置灰、写原因) */
  enabled: boolean;
  /** Agent 服务的 `/v1` 根地址,不带末尾斜杠 */
  url: string | null;
}

export const CLOUD_OFF: CloudAgentAvailability = Object.freeze({ available: false, enabled: false, url: null });

/** 在线页面里 Agent 服务的路径(与页面同源) */
export const ONLINE_AGENT_PATH = "/agent/v1";

interface Reported {
  projectId: string;
  info: HostedAgentInfo;
}

let reported: Reported | null = null;
const listeners = new Set<() => void>();
let version = 0;

function bump() {
  version++;
  for (const l of [...listeners]) l();
}

/** 文档服务在成员列表回包里报的 `hosted.agent`(`projectId` 是它属于哪个项目,换了项目就不再算数) */
export function setHostedAgent(projectId: string, raw: unknown): void {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const next: Reported | null = r
    ? { projectId, info: { available: r.available === true, enabled: r.enabled !== false, url: typeof r.url === "string" && r.url ? r.url : null } }
    : null;
  if (JSON.stringify(next) === JSON.stringify(reported)) return;
  reported = next;
  bump();
}

/** 创建者开关变了的通知(`shared.notice { event: 'hosted-service-changed', service: 'agent', enabled }`) */
export function setHostedAgentEnabled(projectId: string, enabled: boolean): void {
  if (!reported || reported.projectId !== projectId || reported.info.enabled === enabled) return;
  reported = { projectId, info: { ...reported.info, enabled } };
  bump();
}

export function clearHostedAgent(): void {
  if (reported === null) return;
  reported = null;
  bump();
}

export function subscribeCloudAgent(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function cloudAgentVersion(): number {
  return version;
}

const trimUrl = (u: string) => u.replace(/\/+$/, "");

/**
 * 纯判定。`projectId` 是此刻连着的共享项目(没连共享项目给 null);`online` 是在线页面。
 * 桌面版:要连着托管端的共享项目、文档服务报了 `available` 与地址才算。在线页面:文档服务报之前先按同源地址、开着算;报了以它为准。
 */
export function resolveCloudAgent(o: { projectId: string | null; hostedWhere: boolean; online: boolean; origin?: string }): CloudAgentAvailability {
  const mine = reported && o.projectId && reported.projectId === o.projectId ? reported.info : null;
  if (o.online) {
    const origin = o.origin ?? (typeof location !== "undefined" ? location.origin : "");
    const sameOrigin = `${origin}${ONLINE_AGENT_PATH}`;
    if (!mine) return { available: true, enabled: true, url: sameOrigin };
    return mine.available ? { available: true, enabled: mine.enabled, url: mine.url ? trimUrl(mine.url) : sameOrigin } : CLOUD_OFF;
  }
  if (!o.projectId || !o.hostedWhere || !mine) return CLOUD_OFF;
  return mine.available && mine.url ? { available: true, enabled: mine.enabled, url: trimUrl(mine.url) } : CLOUD_OFF;
}
