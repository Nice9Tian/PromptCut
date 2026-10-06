/**
 * 托管方服务（云节点上托管方自带的服务）在界面里的纯逻辑（契约 `docs/plan/hosted-render-contract.md` 第 1.7、3 节）。
 *
 * - 成员列表顶层 `hosted: { render: { available, enabled }, agent: { available, enabled } }`：放本机的项目与没有登记表的
 *   托管端没有这个字段（解析出来是 null）；`enabled` 是本项目对这个服务的开关，记录里没有算开。
 * - 成员列表里 `service` 字段非空的行是托管方的服务：按服务名显示，不看用户名；不是成员、不计入成员数、没有踢人按钮。
 * - 项目设置里每种服务一行勾选，**按服务名渲染**：现在只有 `render`，第四段（云端 Agent）往 `HOSTED_SERVICE_ROWS` 与
 *   `HOSTED_SERVICE_TEXT` 各加一项就多一行。
 *
 * - 代成员进项目的服务连接（云端 Agent）不另起一行：归在那位成员的行里，`conns` 里那一项带 `service: 'agent'`，界面在这位成员下
 *   显示「〈成员名〉的云端 Agent」（`cloudAgentConns`、`cloudAgentLabel`；契约 `docs/plan/cloud-agent-contract.md` 第 5 节）。
 *   项目设置里 `agent` 一行就是「云端 Agent」开关。
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

/** 项目设置里出现哪几行、按什么顺序 */
export const HOSTED_SERVICE_ROWS: readonly HostedServiceName[] = ["render", "agent"];

export interface HostedServiceText {
  label: string;
  /** 勾选行下面的一行说明 */
  hint: (enabled: boolean) => string;
  /** 别的成员收到「创建者改了开关」时的提示；空串表示这个方向不提示（两个开关同一个规矩：只在关闭时提示，打开时不提示，〔用户 2026-10-07 定〕） */
  changed: (enabled: boolean) => string;
  /** 创建者确认弹窗里的一句话(`enabled` 是要改成的状态) */
  confirm: (enabled: boolean) => string;
}

/** 每种服务在界面上的文案。加服务时在这里加一项、再把名字加进 `HOSTED_SERVICE_ROWS` */
export const HOSTED_SERVICE_TEXT: Partial<Record<HostedServiceName, HostedServiceText>> = {
  render: {
    label: "托管方的渲染节点",
    hint: (enabled) => (enabled ? "云节点上托管方的渲染节点为这个项目做预渲染，创建者可以关掉。" : "已关闭：托管方的渲染节点不再为这个项目做预渲染，已经渲好的结果保留。"),
    // 与云端 Agent 同一个规矩：只在关闭时给别的成员气泡，打开时不提示〔用户 2026-10-07 定〕
    changed: (enabled) => (enabled ? "" : "创建者关闭了托管方的渲染节点，它不再为这个项目做预渲染。"),
    confirm: (enabled) => (enabled ? "打开后，托管方的渲染节点会为这个项目做预渲染。" : "关闭后，托管方的渲染节点不再为这个项目做预渲染，已经渲好的结果保留。"),
  },
  agent: {
    label: "云端 Agent",
    hint: (enabled) => (enabled ? "成员可以在 AI 栏里选「云端」，让云节点上的 Agent 代自己改项目，关掉软件也会继续。创建者可以关掉。" : "已关闭：成员不能再用云端 Agent，进行中的云端对话已被停下；已经落地的改动保留。"),
    // 只有关闭时给别的成员一条气泡，打开时不提示（空串就不弹）〔用户 2026-10-07 定〕
    changed: (enabled) => (enabled ? "" : "创建者关闭了云端 Agent，进行中的云端对话已被停下。"),
    confirm: (enabled) => (enabled ? "打开后，成员可以在 AI 栏里选「云端」，让云节点上的 Agent 代自己改项目。" : "关闭后，成员不能再用云端 Agent，进行中的云端对话会被立刻停下；已经落地的改动保留。"),
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

/** 这位成员名下代他进项目的云端 Agent 连接(成员列表行的 `conns` 里带 `service: 'agent'` 的那几项) */
export function cloudAgentConns<T extends { role: string; service?: string }>(conns: readonly T[]): T[] {
  return conns.filter((c) => c.service === "agent");
}

/** 云端 Agent 的署名:「〈成员名〉的云端 Agent」(操作记录、覆盖提示、成员列表都用这一处) */
export const cloudAgentLabel = (name: string): string => `${name}的云端 Agent`;

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

/* ---------------------------------------------------------------------------------------------
 * 成员列表的计数口径〔用户 2026-10-07 定〕：「成员：N 人 · Agent：M 个」
 *
 * - 人数只算真人在线的：这一行有任何一条不是「云端 Agent」的连接（页面、本机 Agent、渲染进程都说明他的设备在线）才算；
 * - 成员本人不在线、只有他的云端 Agent 连着：这一行照常显示并标「离线，Agent 在跑」，不计入人数、计入 Agent 数；
 * - Agent 数 = 本机 Agent（每个对话一条连接）加云端 Agent（每位成员最多一个，实例里有多条连接也只算一个）；
 * - 托管方的服务行（渲染节点）不进任何一个数（`splitMembers` 已把它们分开）。
 * ------------------------------------------------------------------------------------------- */

type CountRow = Pick<MemberRow, "conns">;

/** 这一行的成员此刻是不是真人在线 */
export function isPersonOnline(row: CountRow): boolean {
  return row.conns.some((c) => c.service !== "agent");
}

/** 这位成员本人不在线、只有他的云端 Agent 连着 */
export function isCloudAgentOnly(row: CountRow): boolean {
  return row.conns.length > 0 && !isPersonOnline(row) && cloudAgentConns(row.conns).length > 0;
}

/** 本机 Agent 的数量(这一行里 `role: 'agent'` 且不是云端 Agent 的连接) */
export function localAgentCount(row: CountRow): number {
  return row.conns.filter((c) => c.role === "agent" && c.service !== "agent").length;
}

/** 顶栏成员数与 Agent 数。`people` 是 `splitMembers` 分出来的成员行 */
export function memberCounts(people: readonly CountRow[]): { people: number; agents: number } {
  let online = 0;
  let agents = 0;
  for (const r of people) {
    if (isPersonOnline(r)) online++;
    agents += localAgentCount(r) + (cloudAgentConns(r.conns).length > 0 ? 1 : 0);
  }
  return { people: online, agents };
}

/** 顶栏按钮上的字。自己总是在线的，所以人数至少 1 */
export function memberCountLabel(people: readonly CountRow[]): string {
  const c = memberCounts(people);
  return `成员：${Math.max(1, c.people)} 人 · Agent：${c.agents} 个`;
}
