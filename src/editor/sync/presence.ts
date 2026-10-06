/**
 * 页面一侧的在场状态(计划 docs/plan/agent-workflow-plan.md A3 第二阶段;文档服务一侧 server/docservice/modules/presence.mjs)。
 *
 * - **发**:这个页面「正在编辑」的片段(A2 的汇总,src/editor/userEditing.ts)经它自己的文档服务连接 `presence.set`,
 *   同一项目的别的成员(他们的编辑器进程、他们的 Agent)就知道「用户 <成员>正在编辑」。在线页面(浏览器模式,没有本机
 *   编辑器进程)也走这条。不进项目历史,带过期时间(15 秒,页面非空时每 5 秒续一次)。
 * - **收**:别的成员那边的 Agent 声明的范围(`kind: 'agent'`),AI 栏上列出来(RemoteAgentsStrip)。
 *
 * **兼容**:旧版文档服务不认识 `presence.*`,回 `error { reason: 'unsupported' }`:记下这条连接不支持,之后不再发,
 * 不报错、不断线(`markUnsupported`)。
 *
 * 不认识 store 以外的界面;连接由 syncManager 交进来(`setPresenceLink`),免得两边互相引用。
 */
import { useSyncExternalStore } from "react";

interface LinkLike {
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

export interface EditingEntityWire {
  clipId: string;
  kind: "drag" | "text" | "recent";
  remainingMs?: number;
}

export interface RemoteAgent {
  id: string;
  member: string;
  vendor: string | null;
  /** 这是那位成员的云端 Agent(来源身份带 `service: 'agent'`) */
  cloud?: boolean;
  scope: string;
  expiresAt: number;
}

/** 页面「正在编辑」的过期时间:与 A2 服务端看板的续期口径一致(页面每 5 秒心跳一次) */
export const EDITING_TTL_MS = 15_000;

let current: { link: LinkLike; projectId: string; me: string } | null = null;
const unsupported = new WeakSet<LinkLike>();
let lastEditing: { session: string; entities: EditingEntityWire[] } | null = null;
/** 这条连接上有没有发布过(撤销只在发布过时发) */
const published = new WeakSet<LinkLike>();

/** 共享项目 userId 是「用户名@设备」,只取用户名;本机空间是 null */
export function memberOf(userId: unknown): string | null {
  if (typeof userId !== "string" || !userId || userId === "local" || userId === "anonymous") return null;
  const at = userId.indexOf("@");
  return at > 0 ? userId.slice(0, at) : userId;
}

function markReply(link: LinkLike, reply: Record<string, unknown> | null) {
  if (reply && reply.type === "error" && reply.reason === "unsupported") unsupported.add(link);
}

/** syncManager 换了连接(或断开:null)时交进来。`me` 是本页面的 userId(别人的 Agent 与自己的区分开) */
export function setPresenceLink(link: LinkLike | null, projectId: string | null, me: string): void {
  current = link && projectId ? { link, projectId, me } : null;
  remote.clear();
  emit();
  if (current) {
    void refresh();
    if (lastEditing && lastEditing.entities.length) publishEditing(lastEditing.session, lastEditing.entities);
  }
}

/** 页面「正在编辑」的片段(A2 的汇总每次变化、每次心跳调一次);空数组 = 撤掉 */
export function publishEditing(session: string, entities: EditingEntityWire[]): void {
  lastEditing = { session, entities };
  const c = current;
  if (!c || unsupported.has(c.link)) return;
  const link = c.link;
  if (!entities.length) {
    if (!published.has(link)) return;
    published.delete(link);
    link.request({ type: "presence.clear", projectId: c.projectId, session, key: "editing" }, 5000).then((r) => markReply(link, r), () => {});
    return;
  }
  published.add(link);
  link
    .request({ type: "presence.set", projectId: c.projectId, session, key: "editing", ttlMs: EDITING_TTL_MS, data: { v: 1, kind: "editing", session, entities: entities.slice(0, 64) } }, 5000)
    .then((r) => markReply(link, r), () => {});
}

/* ---------------- 收:别的成员那边的 Agent ---------------- */

const remote = new Map<string, RemoteAgent>();
const listeners = new Set<() => void>();
let snapshot: RemoteAgent[] = [];

function emit() {
  const t = Date.now();
  snapshot = [...remote.values()].filter((a) => a.expiresAt > t).sort((a, b) => (a.member + a.id < b.member + b.id ? -1 : 1));
  for (const l of [...listeners]) l();
}

function ingest(e: Record<string, unknown>) {
  const key = typeof e.key === "string" ? e.key : "";
  if (!key.startsWith("agent:")) return;
  const id = key.slice("agent:".length);
  const from = (e.from ?? {}) as Record<string, unknown>;
  const data = e.data as Record<string, unknown> | null;
  if (!data || typeof data.scope !== "string" || !data.scope) {
    remote.delete(id);
    return;
  }
  // 自己这台机器上的 Agent 不算「别的成员」(本机空间里 userId 都是 local)
  if (current && (from.userId === current.me || memberOf(from.userId) === null)) return;
  remote.set(id, {
    id,
    member: memberOf(from.userId) ?? "?",
    vendor: typeof data.vendor === "string" ? data.vendor : null,
    ...(from.service === "agent" ? { cloud: true } : {}),
    scope: data.scope,
    expiresAt: typeof e.expiresAt === "number" ? e.expiresAt : Date.now() + 30 * 60_000,
  });
}

/** syncManager 的旁路消息里 `presence.*` 交到这里 */
export function receivePresence(msg: Record<string, unknown>): void {
  if (!current || (msg.projectId !== undefined && msg.projectId !== current.projectId)) return;
  if (msg.type === "presence.update") {
    ingest(msg);
    emit();
  } else if (msg.type === "presence.state" && Array.isArray(msg.entries)) {
    for (const e of msg.entries) if (e && typeof e === "object") ingest(e as Record<string, unknown>);
    emit();
  }
}

/** 取一次现有的在场状态;连接还没就绪就隔 2 秒再试(最多 15 次),换了连接就停 */
async function refresh() {
  const c = current;
  for (let i = 0; i < 15; i += 1) {
    if (!c || current !== c || unsupported.has(c.link)) return;
    try {
      const reply = await c.link.request({ type: "presence.list", projectId: c.projectId }, 5000);
      markReply(c.link, reply);
      if (current === c) receivePresence(reply);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export function remoteAgents(): RemoteAgent[] {
  return snapshot;
}

export function subscribeRemoteAgents(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useRemoteAgents(): RemoteAgent[] {
  return useSyncExternalStore(subscribeRemoteAgents, remoteAgents, remoteAgents);
}

/** 测试与诊断 */
export function presenceStatus(): { linked: boolean; unsupported: boolean; remote: number } {
  return { linked: !!current, unsupported: !!current && unsupported.has(current.link), remote: snapshot.length };
}
