import type { MediaAsset } from "../kernel/project";

/**
 * 「这一刻该拿哪个地址去播」。
 *
 * 放在 src/render/ 而不是 src/editor/ 是因为舞台 bundle(预览 / 预渲染 / 导出页)
 * 也要 import 它 —— 舞台够不着编辑器那一侧的任何模块。
 *
 * 眼下的规则很短:有 hash 就是 /@media/<hash>,没有(迁移期的老项目)才用 media.url。
 * 地址里不带扩展名 —— 哈希就是身份,Content-Type 由服务端按入库时记下的扩展名给
 * (server/vite-plugin-media.ts 的 resolveHashFile / contentTypeForExt)。
 *
 * TODO(A1 第 5 步):两档(small / original)到位后,这里改成「本地已完整落盘的最高档」:
 * localHashes 里有 tiers.original 就用原片;否则 tiers.small 在就用小分辨率档;
 * 集合为空时也先给 small(打开项目第一帧不能直接拉原片)。换档是槽位级的换段,
 * 只有 live 路的 VideoTrack 从这里取 src,预渲染 / 导出 / see_frames 一律用 media.url。
 */
export function playbackUrl(media: Pick<MediaAsset, "url" | "hash" | "tiers">, localHashes: Set<string> | string[] = []): string {
  // localHashes 现在还没参与判断(只有一档),先把参数形状定下来,免得调用方将来再改一遍
  void localHashes;
  if (media.hash) return `/@media/${media.hash}`;
  return media.url || "";
}

/** 地址里的素材哈希(/@media/<hash> 或 /@media/<hash>.<ext>),不是哈希地址就给 null */
export function hashFromUrl(url: string): string | null {
  const m = /^\/@media\/([0-9a-f]{64})(?:\.[A-Za-z0-9]+)?$/i.exec(String(url || "").split(/[?#]/, 1)[0]);
  return m ? m[1].toLowerCase() : null;
}
