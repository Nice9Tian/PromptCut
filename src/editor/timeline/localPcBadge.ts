/**
 * 时间轴片段的卡名与「需要本地 PC 渲染辅助」徽标的判定(C10 契约第 9 节;2026-09-29 用户定:徽标文字与舞台上
 * `unsupported` 占位符同一句,出现条件也相同)。纯函数,单测直接载入。
 */

/** 卡片段的标签:构建时定义的名字 → 同步表里的名字(`knownCardName` 已按这个顺序取好)→「未知卡片」 */
export const UNKNOWN_CARD_LABEL = "未知卡片";
export function clipCardLabel(knownName: string | null | undefined): string {
  return typeof knownName === "string" ? knownName : UNKNOWN_CARD_LABEL;
}

/** 片段的预渲染结果覆盖了多少(`OnlineSnapshotSource.coverage`);没有在线来源时是 null */
export type ClipCoverage = "none" | "partial" | "full" | null;

/**
 * 徽标出不出。三者同时成立才出:在线浏览器模式;这张卡这台设备跑不了(`unsupportedHere`:构建时的用户卡、图卡、
 * 同步来的用户卡 —— 两边都没有的 id 不算,与桌面一致只标「未知卡片」);它的预渲染结果还没覆盖整段
 * (层表里没有可用的层,或清单里这一档的帧没覆盖整段;低内存档看小尺寸那一层)。覆盖齐了撤掉。
 */
export function showLocalPcBadge(o: { online: boolean; localOnly: boolean; coverage: ClipCoverage }): boolean {
  return o.online && o.localOnly && o.coverage !== "full";
}
