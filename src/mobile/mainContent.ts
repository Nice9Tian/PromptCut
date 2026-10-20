/**
 * 手机版缩略时间轴的「主要内容」(语义 `workflow/editing.md`「手机版界面」;术语 `glossary.md`「主要内容」)。
 *
 * 第一版的取法(任务书 `docs/plan/mobile-online-task.md`「设计决定」2):当前剪辑的主轨(最底下那条放着视频 / 图片 / 剪辑段的序列)
 * 上的段,包括视频段、图片段、剪辑段,按时间顺序。交叉溶解会把后一段挪到别的序列上(`kernel/transitions.ts`),
 * 这种被主轨上的段溶解过去的后一段也算主要内容,不然加了转场它就从缩略时间轴上消失了。
 *
 * TODO(用户 2026-10-20,演示稿 `prototypes/mobile-ui-demo/index.html` 的 `mainClips()`):要有自动判断「主要内容」的算法,
 * 按内容判断哪些片段算主要内容;现在先按主轨取。
 *
 * 纯函数:只读 Project,不碰 store。
 */
import { isImageMedia, type MediaAsset, type Project, type Track, type TrackClip } from "../kernel/project.ts";
import { transitionsOf, timingLock, type Transition } from "../kernel/transitions.ts";

export type ClipKind = "video" | "image" | "audio" | "cut" | "card";

function mediaOf(p: Project, clip: TrackClip): MediaAsset | undefined {
  return clip.mediaId ? p.media.find((m) => m.id === clip.mediaId) : undefined;
}

export function clipKind(p: Project, clip: TrackClip): ClipKind {
  if (clip.cutId) return "cut";
  const m = mediaOf(p, clip);
  if (m) return m.kind === "audio" ? "audio" : isImageMedia(m) ? "image" : "video";
  return "card";
}

/** 能当主要内容的段:视频段、图片段、剪辑段 */
export function isMainKind(p: Project, clip: TrackClip): boolean {
  const k = clipKind(p, clip);
  return k === "video" || k === "image" || k === "cut";
}

/** 主轨:最底下(tracks 的最后一条)那条放着主要内容的序列;都没有就是最底下那条 */
export function mainTrackOf(p: Project): Track | undefined {
  for (let i = p.tracks.length - 1; i >= 0; i--) {
    if (p.tracks[i].clips.some((c) => isMainKind(p, c))) return p.tracks[i];
  }
  return p.tracks[p.tracks.length - 1];
}

export function mainClipsOf(p: Project): TrackClip[] {
  const track = mainTrackOf(p);
  if (!track) return [];
  const picked = new Map<string, TrackClip>();
  for (const c of track.clips) if (isMainKind(p, c)) picked.set(c.id, c);
  // 被溶解过去的后一段(可能在别的序列上)也算
  const all = new Map(p.tracks.flatMap((t) => t.clips.map((c) => [c.id, c] as const)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const tr of transitionsOf(p)) {
      if (tr.kind !== "crossfade" || !tr.bId || !picked.has(tr.aId) || picked.has(tr.bId)) continue;
      const b = all.get(tr.bId);
      if (b && isMainKind(p, b)) { picked.set(b.id, b); grew = true; }
    }
  }
  return [...picked.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * 两段主要内容之间的转场:先认两段之间的交叉溶解,再认前一段的淡出、后一段的淡入。没有就是 null(缩略时间轴上画「＋」)。
 */
export function boundaryTransition(p: Project, a: TrackClip, b: TrackClip): Transition | null {
  const list = transitionsOf(p);
  return (
    list.find((tr) => tr.kind === "crossfade" && tr.aId === a.id && tr.bId === b.id) ??
    list.find((tr) => tr.kind === "fadeOut" && tr.aId === a.id) ??
    list.find((tr) => tr.kind === "fadeIn" && tr.aId === b.id) ??
    null
  );
}

/** 片段在界面上叫什么:显示名 → 素材名 → 剪辑名 → 卡片 id */
export function clipName(p: Project, clip: TrackClip, cardName?: (cardId: string) => string | undefined): string {
  if (clip.label) return clip.label;
  const m = mediaOf(p, clip);
  if (m) return m.name;
  if (clip.cutId) return p.cuts?.find((c) => c.id === clip.cutId)?.name ?? "剪辑段";
  return cardName?.(clip.cardId) ?? clip.cardId ?? "片段";
}

export interface ReorderPlan {
  /** 要挪的段和它的新起点(时长不变) */
  moves: { id: string; start: number }[];
}

/**
 * 主要内容换顺序:按新顺序依次排,保留原来每个位置之间的空档(第 k 段的新起点 = 原来第 k 个位置的起点 + 前面几段时长之差)。
 * 只算,不改;放不下(和主轨上别的段撞了)或有转场锁着(相对时间是转场的一部分,`kernel/transitions.ts`)时回 `{ error }`。
 */
export function planReorder(p: Project, order: string[]): ReorderPlan | { error: string } {
  const main = mainClipsOf(p);
  const byId = new Map(main.map((c) => [c.id, c]));
  if (order.length !== main.length || order.some((id) => !byId.has(id))) return { error: "主要内容变了，请重试。" };
  const moves: { id: string; start: number }[] = [];
  let shift = 0;
  order.forEach((id, k) => {
    const slot = main[k];
    const c = byId.get(id)!;
    const start = slot.start + shift;
    shift += (c.end - c.start) - (slot.end - slot.start);
    if (Math.abs(start - c.start) > 1e-6) moves.push({ id, start });
  });
  if (!moves.length) return { moves };
  if (moves.some((m) => timingLock(p, m.id))) return { error: "有转场的段要先删掉转场，才能换顺序。" };
  const track = mainTrackOf(p)!;
  const moved = new Set(moves.map((m) => m.id));
  const companions = new Set(track.clips.filter((c) => c.soundEffect?.sourceClipId && moved.has(c.soundEffect.sourceClipId)).map((c) => c.id));
  const placed = track.clips
    .filter((c) => !companions.has(c.id))
    .map((c) => {
      const m = moves.find((x) => x.id === c.id);
      return m ? { start: m.start, end: m.start + (c.end - c.start) } : { start: c.start, end: c.end };
    })
    .sort((a, b) => a.start - b.start);
  if (placed.some((c, i) => c.start < -1e-6 || (i > 0 && c.start < placed[i - 1].end - 1e-6))) return { error: "主轨上放不下新的顺序。" };
  return { moves };
}

/** 主要内容的总时长(各段时长之和,缩略时间轴标题行写它) */
export function mainTotal(clips: TrackClip[]): number {
  return clips.reduce((s, c) => s + (c.end - c.start), 0);
}

/**
 * 缩略卡等宽:当前帧标记落在第 i 张卡内的比例 f,换成项目时间。落在两卡之间(转场标记处)取下一段开头。
 * `pos` 是标记在卡序列里的位置:整数部分是第几张卡,小数部分是卡内比例;超出末尾回最后一段的结尾。
 */
export function timeAtCardPos(clips: TrackClip[], pos: number): number {
  if (!clips.length) return 0;
  if (pos <= 0) return clips[0].start;
  const i = Math.floor(pos);
  if (i >= clips.length) return clips[clips.length - 1].end;
  const c = clips[i];
  return c.start + (pos - i) * (c.end - c.start);
}

/** 反过来:项目时间 → 卡序列里的位置。落在两段之间的空档里算下一段开头,落在最后一段之后算末尾 */
export function cardPosAtTime(clips: TrackClip[], t: number): number {
  if (!clips.length) return 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (t < c.start) return i;
    if (t < c.end - 1e-9) return i + (t - c.start) / Math.max(1e-6, c.end - c.start);
  }
  return clips.length;
}
