import type { Project } from "../../kernel/project";
// @ts-expect-error Browser-safe format validation, also used by the server.
import { parseCollaboration } from "../../../server/recovery/descriptor.mjs";

export interface CollaborationDescriptor {
  version: number;
  roomId?: string;
  service?: string;
  where?: "lan" | "hosted";
  hint?: string;
  [key: string]: unknown;
}
let pending: { contentId: string; descriptor: CollaborationDescriptor | null } | null = null;
let active: CollaborationDescriptor | null = null;
let recovering = false;

/** 只校验、不记:文件里的协作关联写坏了就抛错(打开文件时先于一切副作用调用) */
export function checkAssociation(value: unknown): void { parseCollaboration(value); }
export function noteLoadedAssociation(project: Project, value: unknown) {
  pending = { contentId: project.id!, descriptor: parseCollaboration(value) as CollaborationDescriptor | null };
}
export function takeLoadedAssociation(project: Project): CollaborationDescriptor | null {
  const value = pending && pending.contentId === project.id ? pending.descriptor : null;
  pending = null; active = value; recovering = !!value;
  return value;
}
export function currentAssociation(): CollaborationDescriptor | null { return active; }
export function setAssociation(value: CollaborationDescriptor | null, restoring = false) { active = value; recovering = !!value && restoring; }
export function isRecoveringAssociation(): boolean { return recovering; }

/**
 * 「过期的云端项目转成了本地项目」的出处记录（随 `.proc` 的壳保存，只供提示与追溯）：
 * 原来的房间号、协作服务地址，以及文档服务那份「已不存在」证明里的签发方、墓碑版本、钥匙号。
 * 不含任何账号凭证，也不是恢复关联：带着它的文件重开就是一个普通的本地项目，不再去连旧云端。
 */
export interface ConvertedFrom {
  v: 1;
  roomId: string;
  service: string;
  authorityId: string;
  tombstoneRevision: number;
  kid: string;
  convertedAt: string;
}
export function parseConvertedFrom(value: unknown): ConvertedFrom | null {
  const v = value as Partial<ConvertedFrom> | null;
  if (!v || typeof v !== "object" || v.v !== 1 || typeof v.roomId !== "string" || !/^sp_[a-z2-7]{26}$/.test(v.roomId) ||
    typeof v.service !== "string" || v.service.length > 2048 || typeof v.authorityId !== "string" || v.authorityId.length > 128 ||
    !Number.isSafeInteger(v.tombstoneRevision) || typeof v.kid !== "string" || v.kid.length > 128 ||
    typeof v.convertedAt !== "string" || v.convertedAt.length > 64) return null;
  return { v: 1, roomId: v.roomId, service: v.service, authorityId: v.authorityId, tombstoneRevision: v.tombstoneRevision!, kid: v.kid, convertedAt: v.convertedAt };
}
let convertedFrom: { contentId: string; info: ConvertedFrom } | null = null;
/** 载入文件、或刚转换完时记下；换了别的项目（项目号不同）就不再回这一份 */
export function noteConvertedFrom(project: Pick<Project, "id">, value: unknown) {
  const info = parseConvertedFrom(value);
  convertedFrom = info && project.id ? { contentId: project.id, info } : null;
}
export function convertedFromOf(project: Pick<Project, "id">): ConvertedFrom | null {
  return convertedFrom && convertedFrom.contentId === project.id ? convertedFrom.info : null;
}

/** 转换完成的通知：保存落点与草稿归属据此清掉（原文件保留），界面据此提示一次。 */
export interface GoneConversion { projectId: string; name: string; from: ConvertedFrom }
const goneListeners = new Set<(event: GoneConversion) => void>();
let goneNotices: GoneConversion[] = [];
export function onGoneConversion(listener: (event: GoneConversion) => void): () => void {
  goneListeners.add(listener); return () => { goneListeners.delete(listener); };
}
export function publishGoneConversion(event: GoneConversion) {
  goneNotices = [...goneNotices, event];
  for (const listener of [...goneListeners]) { try { listener(event); } catch { /* 一个订阅者出错不挡别的 */ } }
}
/** 界面取走还没提示过的那几条（每条只提示一次） */
export function takeGoneNotices(): GoneConversion[] { const out = goneNotices; goneNotices = []; return out; }
