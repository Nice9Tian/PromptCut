/**
 * 托管方服务（云节点上托管方自带的服务）在界面里的纯逻辑（契约 `docs/plan/hosted-render-contract.md` 第 1.7、3 节）。
 *
 * - 成员列表顶层 `hosted: { render: { available, enabled }, agent: { available, enabled } }`：放本机的项目与没有登记表的
 *   托管端没有这个字段（解析出来是 null）；`enabled` 是本项目对这个服务的开关，记录里没有算开。
 * - 成员列表里 `service` 字段非空的行是托管方的服务：按服务名显示，不看用户名；不是成员、不计入成员数、没有踢人按钮。
 * - 项目设置里每种服务一行勾选，**按服务名渲染**：现在只有 `render`，第四段（云端 Agent）往 `HOSTED_SERVICE_ROWS` 与
 *   `HOSTED_SERVICE_TEXT` 各加一项就多一行。
 *
 * 不引 React、不引同步管理的运行时（只用类型），单测直接 import。
 */
import type { MemberRow } from "./syncManager";

export type HostedServiceName = "render" | "agent";

export interface HostedServiceState {
  available: boolean;
  enabled: boolean;
}

export type HostedView = Partial<Record<HostedServiceName, HostedServiceState>>;

/** 项目设置里出现哪几行、按什么顺序。第四段加 `"agent"` */
export const HOSTED_SERVICE_ROWS: readonly HostedServiceName[] = ["render"];

/** 每种服务在界面上的文案。第四段加 `agent` 时在这里加一项、再把名字加进 `HOSTED_SERVICE_ROWS` */
export const HOSTED_SERVICE_TEXT: Partial<Record<HostedServiceName, { label: string; hint: (enabled: boolean) => string; changed: (enabled: boolean) => string }>> = {
  render: {
    label: "托管方的渲染节点",
    hint: (enabled) => (enabled ? "云节点上托管方的渲染节点为这个项目做预渲染，创建者可以关掉。" : "已关闭：托管方的渲染节点不再为这个项目做预渲染，已经渲好的结果保留。"),
    changed: (enabled) => (enabled ? "创建者打开了托管方的渲染节点。" : "创建者关闭了托管方的渲染节点，它不再为这个项目做预渲染。"),
  },
};

const isServiceName = (v: unknown): v is HostedServiceName => v === "render" || v === "agent";

/** 成员列表消息顶层的 `hosted` → 界面状态；没有或形状不对回 null（放本机的项目、旧托管端） */
export function parseHosted(raw: unknown): HostedView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: HostedView = {};
  for (const name of ["render", "agent"] as const) {
    const s = (raw as Record<string, unknown>)[name];
    if (!s || typeof s !== "object") continue;
    const { available, enabled } = s as Record<string, unknown>;
    if (typeof available !== "boolean" || typeof enabled !== "boolean") continue;
    out[name] = { available, enabled };
  }
  return Object.keys(out).length ? out : null;
}

/** `hosted-service-changed` 通知落到状态上：服务不认识或这个项目没有这项服务就原样返回 */
export function applyHostedChange(hosted: HostedView | null, service: unknown, enabled: unknown): HostedView | null {
  if (!isServiceName(service) || typeof enabled !== "boolean") return hosted;
  const prev = hosted?.[service];
  if (!prev) return hosted;
  return { ...hosted, [service]: { ...prev, enabled } };
}

export interface HostedRow {
  service: HostedServiceName;
  label: string;
  enabled: boolean;
}

/**
 * 项目设置里要显示哪几行：项目放云端、且这台托管端的登记表里有这个服务（`available`）才出现。
 * 放本机的项目、没有登记表的托管端、`available` 为假，都没有这一项。
 */
export function hostedRowsOf(where: "lan" | "hosted" | null | undefined, hosted: HostedView | null): HostedRow[] {
  if (where !== "hosted" || !hosted) return [];
  const rows: HostedRow[] = [];
  for (const service of HOSTED_SERVICE_ROWS) {
    const s = hosted[service];
    const text = HOSTED_SERVICE_TEXT[service];
    if (s?.available && text) rows.push({ service, label: text.label, enabled: s.enabled });
  }
  return rows;
}

/** 成员列表的这一行是不是托管方的服务 */
export const isServiceRow = (row: Pick<MemberRow, "service">): boolean => typeof row.service === "string" && row.service !== "";

/** 服务行显示的名字：按服务名，不看用户名；不认识的服务名给一个通用名 */
export function serviceRowLabel(service: string | undefined): string {
  return (isServiceName(service) && HOSTED_SERVICE_TEXT[service]?.label) || "托管方的服务";
}

/** 成员列表拆成两段：成员（在前，计入成员数）、托管方的服务（在后，不计数、没有踢人按钮） */
export function splitMembers<T extends Pick<MemberRow, "service">>(rows: readonly T[]): { people: T[]; services: T[] } {
  const people: T[] = [];
  const services: T[] = [];
  for (const r of rows) (isServiceRow(r) ? services : people).push(r);
  return { people, services };
}
