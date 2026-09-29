/**
 * 父页一侧:此刻哪些「这台设备跑不了的片段」**已确认**这一帧没有可贴的预渲染结果(C10 契约第 9 节;刚打开页面时不闪图标)。
 *
 * 在线浏览器模式下用户卡、图卡本机跑不了(`snapshotFeed.localOnlyOf`)。舞台上它们贴不上快照 / 流时:
 *   - 父页已确认这一帧没有可贴的结果 → 「需要本地 PC 渲染辅助」图标(`unsupported`);
 *   - 其余(层表没取到、清单没到、字节在路上)→ 普通加载占位(`awaiting` 沙漏),暂停时也一样。
 * 「确认」由在线来源判(`OnlineSnapshotSource.frameConfirmedMissing`:层表已取到、没有可用的层;或这一帧所在那一段的清单
 * 已取到、这一帧不在里面)。这里只按当前时刻挑出在场的片段、换算本地帧(口径同舞台:含 LEAD,本地帧 = round((t − start) × fps))。
 * 纯函数,单测直接载入。
 */
import { cardMountedAt } from "../render/frameWindow.mjs";

export interface LocalOnlyMissingInput {
  /** 项目里的片段(已按轨道展开;隐藏轨道的片段调用方先去掉) */
  clips: Iterable<{ id: string; start: number; end: number }>;
  /** 此刻(秒) */
  t: number;
  fps: number;
  /** 这台设备跑不了的片段 */
  localOnly: ReadonlySet<string>;
  /** 在线来源的判定;没有在线来源时传 null(什么都确认不了) */
  confirm: ((clipId: string, localFrame: number) => boolean) | null;
}

/** 此刻在场、已确认这一帧没有可贴结果的片段 id(按 id 排好) */
export function localOnlyMissingAt(o: LocalOnlyMissingInput): string[] {
  if (!o.localOnly.size || !o.confirm) return [];
  const fps = Math.max(1, Number(o.fps) || 30);
  const out: string[] = [];
  for (const c of o.clips) {
    if (!o.localOnly.has(c.id)) continue;
    if (!cardMountedAt(c, o.t)) continue;
    const localFrame = Math.round((o.t - c.start) * fps);
    if (o.confirm(c.id, localFrame)) out.push(c.id);
  }
  return out.sort();
}
