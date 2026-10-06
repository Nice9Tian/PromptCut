/**
 * 云端 Agent 在哪、能不能用(契约 9.5、10.1、10.4 节)。
 *
 * - 在线页面:同源的 `/agent/v1`(经 nginx 的 `/agent/`),一直「在」;开关看成员列表回包里的 `hosted.agent.enabled`,没有就当开着,
 *   真正的开关状态由 `GET /v1/info` 的 `enabled` 说了算;
 * - 桌面版:地址与开关都由文档服务下发(成员列表回包顶层 `hosted.agent: { available, enabled, url }`),
 *   `syncManager` 收到后调 `setHostedAgent` 记下;放本机的项目没有这个字段,所以「云端」一项出不来;
 * - 合流前的可注入来源:`setCloudAgentSource(fn)` 或 `globalThis.__pcCloudAgent`(探针与手工验证用);
 *   它只在文档服务没给时才用,文档服务给了的以文档服务为准。
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
let source: (() => Partial<HostedAgentInfo> | null | undefined) | null = null;
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

export function setCloudAgentSource(fn: (() => Partial<HostedAgentInfo> | null | undefined) | null): void {
  source = fn;
  bump();
}

export function subscribeCloudAgent(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function cloudAgentVersion(): number {
  return version;
}

function injected(): Partial<HostedAgentInfo> | null {
  try {
    const v = source ? source() : ((globalThis as Record<string, unknown>).__pcCloudAgent as Partial<HostedAgentInfo> | undefined);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

const trimUrl = (u: string) => u.replace(/\/+$/, "");

/**
 * 纯判定。`projectId` 是此刻连着的共享项目(没连共享项目给 null);`online` 是在线页面。
 * 桌面版:要连着托管端的共享项目、文档服务报了 `available` 才算;在线页面:地址固定,`available` 恒真。
 */
export function resolveCloudAgent(o: { projectId: string | null; hostedWhere: boolean; online: boolean; origin?: string }): CloudAgentAvailability {
  const mine = reported && o.projectId && reported.projectId === o.projectId ? reported.info : null;
  if (o.online) {
    const origin = o.origin ?? (typeof location !== "undefined" ? location.origin : "");
    return { available: true, enabled: mine ? mine.enabled : true, url: `${origin}${ONLINE_AGENT_PATH}` };
  }
  if (mine) {
    return mine.available && mine.url ? { available: true, enabled: mine.enabled, url: trimUrl(mine.url) } : CLOUD_OFF;
  }
  // 文档服务没给:只有可注入的来源(合流前验证用)能让「云端」出现,而且也只在连着托管端的共享项目时
  if (!o.projectId || !o.hostedWhere) return CLOUD_OFF;
  const inj = injected();
  if (inj && inj.available === true && typeof inj.url === "string" && inj.url) {
    return { available: true, enabled: inj.enabled !== false, url: trimUrl(inj.url) };
  }
  return CLOUD_OFF;
}
