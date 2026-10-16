import type { Project } from "../../kernel/project";
// @ts-expect-error Browser-safe format validation, also used by the server.
import { parseCollaboration } from "../../../server/recovery/descriptor.mjs";
import { convertGoneProject, type GoneProof } from "./cloudGone";
// @ts-expect-error Browser-safe proof verification
import { queryGone } from "../../../server/recovery/gone-proof.mjs";

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

/**
 * 账号云端项目另存为 .proc / .procp 时的云端关联记号（10-14 第 3.4 节）
 */
export interface CloudProjectAssociation {
  accountProject: true;
  projectId: string;
  docServiceUrl: string;
  origin?: string;
  savedRev: number;
  savedAt: string;
}

export function parseCloudAssociation(value: unknown): CloudProjectAssociation | null {
  const v = value as Partial<CloudProjectAssociation> | null;
  if (!v || typeof v !== "object" || v.accountProject !== true || typeof v.projectId !== "string" || !v.projectId) return null;
  if (typeof v.docServiceUrl !== "string" || !v.docServiceUrl) return null;
  const savedRev = Number.isSafeInteger(v.savedRev) ? Number(v.savedRev) : 1;
  const savedAt = typeof v.savedAt === "string" ? v.savedAt : new Date().toISOString();
  return {
    accountProject: true,
    projectId: v.projectId,
    docServiceUrl: v.docServiceUrl,
    origin: typeof v.origin === "string" ? v.origin : v.docServiceUrl,
    savedRev,
    savedAt,
  };
}

let loadedCloudAssoc: { contentId: string; assoc: CloudProjectAssociation } | null = null;
let activeCloudAssoc: CloudProjectAssociation | null = null;

export function noteLoadedCloudAssociation(project: Pick<Project, "id">, value: unknown) {
  const assoc = parseCloudAssociation(value);
  loadedCloudAssoc = assoc && project.id ? { contentId: project.id, assoc } : null;
}

export function takeLoadedCloudAssociation(project: Pick<Project, "id">): CloudProjectAssociation | null {
  const value = loadedCloudAssoc && loadedCloudAssoc.contentId === project.id ? loadedCloudAssoc.assoc : null;
  loadedCloudAssoc = null;
  activeCloudAssoc = value;
  return value;
}

export function currentCloudAssociation(): CloudProjectAssociation | null {
  return activeCloudAssoc;
}

export function setCloudAssociation(value: CloudProjectAssociation | null) {
  activeCloudAssoc = value;
}

/**
 * 账号云端项目另存为 .proc / .procp 后的重开四规则（10-14 第 3.4 节）：
 * 1. 没登录：提示登录，不直接当本地项目打开，也不抹掉关联；
 * 2. 登录的账号不是成员：提示没有权限，不打开项目；
 * 3. 云端项目已删：凭已删证明（goneProof）转成独立本地项目打开；
 * 4. 有权限且有离线修改：打开并连回云端项目，把离线修改合回云端（生成新的历史序号）。
 */
export async function handleCloudAssociationReopen(
  project: Project,
  assoc: CloudProjectAssociation,
  options: {
    account?: { id: string; name: string } | null;
    client?: {
      account?: { id: string; name: string } | null;
      session: (projectId: string) => Promise<any>;
      join?: (projectId: string, requestId?: string) => Promise<any>;
    };
    queryGone?: (descriptor: CollaborationDescriptor) => Promise<GoneProof | null>;
    isOfflineModified?: boolean;
    cloudProject?: Project;
    toast?: (msg: string, tone?: "info" | "warn", duration?: number) => void;
    enterProject?: (options: any) => Promise<void>;
  } = {},
): Promise<{ status: "opened" | "merged" | "converted" | "login-required" | "forbidden"; project?: Project }> {
  const toast = options.toast ?? (() => {});
  // 1. 规则 1：未登录
  let account = options.account;
  let client = options.client;
  if (account === undefined) {
    try {
      const flow = await import("./accountMoveFlow.ts");
      const c = await flow.accountCloud();
      if (c) {
        client = c.client;
        account = await flow.accountCloudLogin(c);
      }
    } catch {}
  }

  if (!account) {
    toast("需要登录网站账号以核对云端权限。", "warn", 10_000);
    setCloudAssociation(assoc);
    return { status: "login-required" };
  }

  // 2. 核对成员权限与状态
  let session: any = null;
  const descriptor: CollaborationDescriptor = {
    version: 1,
    roomId: assoc.projectId,
    where: "hosted",
    service: assoc.docServiceUrl,
  };

  if (client) {
    try {
      session = await client.session(assoc.projectId);
    } catch (error: any) {
      const status = error?.status;
      const code = error?.code;
      // 规则 3：云端项目已被创建者删除
      if (status === 404 || code === "project-gone" || code === "no-project") {
        const query = options.queryGone ?? ((d: CollaborationDescriptor) => queryGone(d));
        let proof: GoneProof | null = null;
        try { proof = await query(descriptor); } catch {}
        if (proof) {
          const converted = convertGoneProject(project, descriptor, proof);
          setCloudAssociation(null);
          publishGoneConversion({ projectId: converted.project.id!, name: converted.project.name, from: converted.from });
          toast("这个云端项目已在云端被删除，已转为普通本地项目打开。", "info", 8000);
          return { status: "converted", project: converted.project };
        }
      }
      // 规则 2：已登录但不是该项目成员
      if (status === 403 || code === "not-listed" || code === "banned" || code === "forbidden") {
        toast("当前账号不是这个云端项目的成员，无法打开。", "warn", 10_000);
        return { status: "forbidden" };
      }
    }
  }

  if (!session && !options.client) {
    toast("当前账号不是这个云端项目的成员，无法打开。", "warn", 10_000);
    return { status: "forbidden" };
  }

  // 规则 4：有权限。检查是否有离线修改
  const isOfflineModified = options.isOfflineModified ?? (
    ((project as any).rev !== undefined && (project as any).rev > assoc.savedRev) ||
    (options.cloudProject && JSON.stringify(project) !== JSON.stringify(options.cloudProject))
  );

  if (options.enterProject && client) {
    await options.enterProject({
      client,
      origin: assoc.origin || assoc.docServiceUrl,
      projectId: assoc.projectId,
      name: project.name,
      initial: project,
      firstSession: session,
    });
  }

  if (isOfflineModified) {
    toast("已连回云端项目，离线修改已合并同步。", "info", 6000);
    return { status: "merged", project };
  }

  return { status: "opened", project };
}


