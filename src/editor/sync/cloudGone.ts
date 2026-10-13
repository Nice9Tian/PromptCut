import { newProjectId, type Project } from "../../kernel/project";
import type { CollaborationDescriptor, ConvertedFrom } from "./recoveryAssociation";

/** 文档服务签发、客户端核对过的「这个项目已不存在」的证明（`server/recovery/gone-proof.mjs` 的 `verifyGoneProof`） */
export interface GoneProof {
  v: 1; authorityId: string; projectId: string; state: "gone"; tombstoneRevision: number; issuedAt: number; kid: string; signature: string;
}

/**
 * 过期的云端项目 → 独立的本地项目（纯函数，不碰 store、不发请求）。
 *
 * - 只在证明的项目号与文件里记的房间号逐字相同时才转，否则抛错（调用方不该走到这里）；
 * - 内容原样保留：序列、片段、参数、素材表（哈希、路径、名字）、卡片节点、剪辑都不动；
 * - 换一个新的本地项目号：转出来的项目与原云端项目不再是同一个，不借旧云端身份；
 * - 不返回任何协作关联：调用方把关联清掉，多用户协作缺省关。
 */
export function convertGoneProject(
  project: Project,
  descriptor: CollaborationDescriptor,
  proof: GoneProof,
  deps: { newId?: () => string; now?: () => Date } = {},
): { project: Project; from: ConvertedFrom } {
  if (descriptor.version !== 1 || descriptor.where !== "hosted" || !descriptor.roomId || !descriptor.service) throw new Error("只有云端项目才按「已不存在」转成本地项目");
  if (proof?.state !== "gone" || proof.projectId !== descriptor.roomId) throw new Error("「已不存在」的证明与这个项目对不上");
  if (!project || !Array.isArray(project.tracks)) throw new Error("项目内容不可读，没有转换");
  const id = (deps.newId ?? newProjectId)();
  return {
    project: { ...project, id },
    from: { v: 1, roomId: descriptor.roomId, service: descriptor.service, authorityId: proof.authorityId,
      tombstoneRevision: proof.tombstoneRevision, kid: proof.kid, convertedAt: (deps.now?.() ?? new Date()).toISOString() },
  };
}
