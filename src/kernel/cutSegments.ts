/**
 * 剪辑段:放在一条剪辑序列里、引用另一条剪辑的片段(`product/project-model.md`「剪辑」「片段」)。
 *
 * # 存法
 *
 * 剪辑段是一个普通的 `TrackClip`,只是既没有 `cardId`(空串)也没有 `mediaId`,而是带着
 * `cutId`(引用哪条剪辑)和 `cutOffset`(从被引用剪辑的哪一秒开始,缺省 0)。框、淡入淡出、
 * 不透明度、独立静音(`audioMuted`)、音量(`audioVolume`)和素材段同名同义。
 * 引用而不是复制:被引用剪辑改了,引用它的各处画面与声音一起变。
 *
 * 0.7.18 及更早的页面读到它:`flattenOverlay` 跳过没有 `cardId` 的段、`videoLayersAt` 跳过没有
 * `mediaId` 的段,所以只是不画、不出声,字段原样保留(Argon 审核意见第 3 节决定 7 核对过)。
 *
 * # 画面怎么出(`mechanism/rendering.md`「剪辑段」)
 *
 * 渲染侧不把剪辑段拆成一堆普通片段,而是把它当成一张「卡」:`flattenOverlay` 把它交成
 * `cardId: CUT_SEGMENT_CARD` 的时间轴片段,带上被引用剪辑的子项目(`cut` 字段)。舞台给它一个
 * 普通的卡片包裹层(框、不透明度、淡入淡出、层序都和卡片一样),包裹层里再挂一个嵌套的场景,
 * 按 `cutOffset + (t − 段起点)` 渲被引用剪辑的整帧。预览、导出、预渲染、Agent 看画面走的都是
 * 同一份 `FrameScene` / `Stage`,所以同一时刻同一帧。
 *
 * # 声音怎么出
 *
 * 声音那边没有「嵌套的场景」可挂,所以按时间把被引用剪辑里出声的片段平移、裁到段的窗口里,
 * 拼成一份只给混音用的项目(`audioProjectOf`)。每层剪辑段的淡入淡出写成包络(`cutEnv`),
 * 由 `opacityAt` 和各个混音器乘上去。
 *
 * 纯函数,不碰 store。node 里能直接测(`cutSegments.test.mjs`)。
 */
import type { Cut, Project, Track, TrackClip } from "./project.ts";
import type { Transition } from "./transitions.ts";

/** 时间轴(`Timeline`)里剪辑段用的卡片 id。注册表里没有这张卡,舞台按 `clip.cut` 认它 */
export const CUT_SEGMENT_CARD = "@cut";

/** 停放的剪辑缺 duration 时的兜底,和 `cuts.ts` 的新剪辑默认时长同一个数 */
const FALLBACK_CUT_DURATION = 30;

/** 嵌套深度的硬上限。正常的项目远到不了(防环之后深度就是剪辑数),这里只防坏数据把渲染拖死 */
export const MAX_CUT_DEPTH = 32;

/** 一层剪辑段的包络(父剪辑的时间):窗口外是 0,窗口内是不透明度 × 淡入 × 淡出 */
export interface CutEnvelope {
  start: number;
  end: number;
  fadeIn?: number;
  fadeOut?: number;
  /** 只给画面用;声音那份包络不带它(段的不透明度不是音量) */
  opacity?: number;
}

/** 这一段是剪辑段吗 */
export function isCutSegment(c: { cutId?: unknown } | null | undefined): boolean {
  return !!c && typeof c.cutId === "string" && c.cutId.length > 0;
}

/** 当前激活的剪辑 id(没有 cuts 的老项目返回 undefined) */
export function activeCutIdOf(p: Pick<Project, "cuts" | "activeCutId">): string | undefined {
  const cuts = Array.isArray(p.cuts) ? p.cuts : [];
  if (!cuts.length) return undefined;
  return p.activeCutId && cuts.some((c) => c.id === p.activeCutId) ? p.activeCutId : cuts[0].id;
}

export interface CutContent {
  id: string;
  name: string;
  tracks: Track[];
  duration: number;
  transitions: Transition[];
}

/**
 * 一条剪辑的内容。激活那条在 `Project.tracks` 上,停放的在各自条目里(`kernel/cuts.ts` 的存法)。
 * 找不到、或停放条目没带 tracks(坏数据)时返回 null —— 调用方按「悬空引用」处理,不抛。
 */
export function cutContent(p: Project, cutId: string): CutContent | null {
  const cuts = Array.isArray(p.cuts) ? p.cuts : [];
  const entry = cuts.find((c) => c.id === cutId);
  if (!entry) return null;
  if (cutId === activeCutIdOf(p)) {
    return { id: entry.id, name: entry.name, tracks: p.tracks, duration: p.duration, transitions: Array.isArray(p.transitions) ? p.transitions : [] };
  }
  if (!Array.isArray(entry.tracks)) return null;
  return {
    id: entry.id, name: entry.name, tracks: entry.tracks,
    duration: typeof entry.duration === "number" && entry.duration > 0 ? entry.duration : FALLBACK_CUT_DURATION,
    transitions: Array.isArray(entry.transitions) ? entry.transitions : [],
  };
}

/** 一条剪辑的总时长(素材库显示的、拖进来时剪辑段的默认长度)。找不到返回 0 */
export function cutDuration(p: Project, cutId: string): number {
  return cutContent(p, cutId)?.duration ?? 0;
}

/** 一组序列里直接引用到的剪辑 id(去重、按出现顺序) */
export function segmentTargets(tracks: readonly Track[] | undefined): string[] {
  const out: string[] = [];
  for (const tr of tracks ?? []) for (const c of tr.clips ?? []) {
    if (isCutSegment(c) && !out.includes(c.cutId!)) out.push(c.cutId!);
  }
  return out;
}

/** 这组序列里有没有剪辑段(没有就什么都不用展开,调用方原样返回) */
export function hasCutSegments(tracks: readonly Track[] | undefined): boolean {
  for (const tr of tracks ?? []) for (const c of tr.clips ?? []) if (isCutSegment(c)) return true;
  return false;
}

/** 引用图:每条剪辑直接引用了哪些剪辑 */
export function cutEdges(p: Project): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const c of Array.isArray(p.cuts) ? p.cuts : []) {
    const content = cutContent(p, c.id);
    edges.set(c.id, content ? segmentTargets(content.tracks) : []);
  }
  return edges;
}

/** 从 `from` 出发(含它自己引用的、它引用的再引用的……任意深度)能走到的剪辑 id。不含 `from` 本身,除非成环 */
export function reachableCuts(p: Project, from: string, edges: Map<string, string[]> = cutEdges(p)): Set<string> {
  const seen = new Set<string>();
  const stack = [...(edges.get(from) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of edges.get(id) ?? []) if (!seen.has(next)) stack.push(next);
  }
  return seen;
}

/**
 * 把剪辑 `child` 放进剪辑 `host` 会不会循环引用:放进自己,或 `child` 已经(任意深度)引用了 `host`。
 * 会的话返回给人看的原因,不会返回 null。拖放、Agent 工具、文档写入三处共用这一条判断。
 */
export function cutCycleReason(p: Project, hostCutId: string, childCutId: string): string | null {
  const name = (id: string) => (Array.isArray(p.cuts) ? p.cuts.find((c) => c.id === id)?.name : undefined) ?? id;
  if (hostCutId === childCutId) return `不能把剪辑「${name(childCutId)}」放进它自己`;
  const edges = cutEdges(p);
  const reach = reachableCuts(p, childCutId, edges);
  if (reach.has(hostCutId)) {
    const direct = (edges.get(childCutId) ?? []).includes(hostCutId);
    return direct
      ? `剪辑「${name(childCutId)}」已经引用了「${name(hostCutId)}」,再放进来会循环引用`
      : `剪辑「${name(childCutId)}」间接引用了「${name(hostCutId)}」,再放进来会循环引用`;
  }
  return null;
}

/** 项目里现有的循环引用(协作合并可能造出来):每个环报一次,给检查和修复用 */
export function cutCycles(p: Project): string[][] {
  const edges = cutEdges(p);
  const out: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 0) visit(next);
      else if (s === 1) out.push(stack.slice(stack.indexOf(next)));
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of edges.keys()) if ((state.get(id) ?? 0) === 0) visit(id);
  return out;
}

/** 直接引用了剪辑 `cutId` 的那些剪辑,各自哪几段 */
export function cutReferences(p: Project, cutId: string): { cutId: string; name: string; clipIds: string[] }[] {
  const out: { cutId: string; name: string; clipIds: string[] }[] = [];
  for (const c of Array.isArray(p.cuts) ? p.cuts : []) {
    const content = cutContent(p, c.id);
    if (!content) continue;
    const clipIds = content.tracks.flatMap((tr) => tr.clips.filter((cl) => cl.cutId === cutId).map((cl) => cl.id));
    if (clipIds.length) out.push({ cutId: c.id, name: c.name, clipIds });
  }
  return out;
}

/* ───────────────────── 删除:连同引用它的剪辑段 ───────────────────── */

/** 去掉一组片段,连带清掉引用它们的转场并把另一头的淡化擦干净(和 store 的 removeClip 同一个规矩) */
function dropClips(tracks: Track[], transitions: Transition[], ids: Set<string>): { tracks: Track[]; transitions: Transition[] } {
  if (!ids.size) return { tracks, transitions };
  const doomed = transitions.filter((tr) => ids.has(tr.aId) || (tr.bId !== undefined && ids.has(tr.bId)));
  let next = tracks.map((t) => (t.clips.some((c) => ids.has(c.id)) ? { ...t, clips: t.clips.filter((c) => !ids.has(c.id)) } : t));
  const clear = (clipId: string | undefined, side: "fadeIn" | "fadeOut") => {
    if (!clipId || ids.has(clipId)) return;
    next = next.map((t) => (t.clips.some((c) => c.id === clipId) ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, [side]: 0 } : c)) } : t));
  };
  for (const tr of doomed) {
    if (tr.kind === "crossfade") { clear(tr.aId, "fadeOut"); clear(tr.bId, "fadeIn"); }
    else clear(tr.aId, tr.kind === "fadeIn" ? "fadeIn" : "fadeOut");
  }
  return { tracks: next, transitions: doomed.length ? transitions.filter((tr) => !doomed.includes(tr)) : transitions };
}

/**
 * 把所有剪辑(激活的和停放的)里引用 `cutId` 的剪辑段删掉,连带它们的转场。
 * 删剪辑本身由 `kernel/cuts.ts` 的 `removeCut` 做;它先调这里。
 */
export function stripCutReferences(p: Project, cutId: string): Project {
  const hit = (tracks: Track[] | undefined) => new Set((tracks ?? []).flatMap((t) => t.clips.filter((c) => c.cutId === cutId).map((c) => c.id)));
  let next = p;
  const activeIds = hit(p.tracks);
  if (activeIds.size) {
    const r = dropClips(p.tracks, Array.isArray(p.transitions) ? p.transitions : [], activeIds);
    next = { ...next, tracks: r.tracks, ...(p.transitions || r.transitions.length ? { transitions: r.transitions } : {}) };
  }
  if (Array.isArray(p.cuts) && p.cuts.some((c) => c.tracks && hit(c.tracks).size)) {
    next = {
      ...next,
      cuts: p.cuts.map((c) => {
        const ids = hit(c.tracks);
        if (!ids.size || !c.tracks) return c;
        const r = dropClips(c.tracks, c.transitions ?? [], ids);
        return { ...c, tracks: r.tracks, transitions: r.transitions };
      }),
    };
  }
  return next;
}

/* ───────────────────── 渲染:子项目与时间轴片段 ───────────────────── */

/** 渲染用的子项目额外带一条路径(从根剪辑起经过的剪辑 id),防环用。只在内存里,不落盘 */
export type CutRenderProject = Project & { cutPath?: readonly string[] };

/** 时间轴(`Timeline`)里剪辑段片段带的东西 */
export interface CutSegmentRender {
  cutId: string;
  /**
   * 时间轴片段起点对应被引用剪辑的哪一秒。没有预卷时就是 `cutOffset`;有预卷时是 `cutOffset − 预卷`
   * (时间轴片段的起点也提前了同样多,所以「父时间 t ↔ 被引用剪辑 offset + (t − 片段起点)」不变)。
   */
  offset: number;
  /** 剪辑段在父剪辑上真正露出来的起点(秒)。预卷那一截在它之前:嵌套场景照常推进,画面不露 */
  from: number;
  /** 被引用剪辑此刻的总时长:`offset + 本地时间` 超出它的部分透明无声 */
  duration: number;
  /** 被引用剪辑的子项目(tracks 换成它的内容,其余项目级字段照旧) */
  project: CutRenderProject;
  /** 推帧口径:子项目里没有要按历史推进的卡就是 direct,随机跳转不用从段起点推 */
  frameMode: "direct" | "stateful";
}

/** 只是给子项目「哪些项目级字段一样」做比对的列表;改了就重建子项目 */
const SUB_DEPS = ["width", "height", "fps", "themeId", "camera3dFov", "media", "filters", "pixelMaps", "audioFx", "cardNodes", "style", "glRoute", "id", "name"] as const;

const subMemo = new WeakMap<object, Map<string, { deps: unknown[]; sub: CutRenderProject }>>();

/**
 * 剪辑 `cutId` 的渲染子项目。`path` 是从根到父剪辑的路径;`cutId` 已经在路径上(成环)、
 * 找不到(悬空引用)、或太深,返回 null —— 调用方跳过这一段,不抛、不白屏。
 *
 * 按 `p.cuts` 的对象引用记忆化:同一份项目反复问(FrameScene 每个片段都会拿裁剪版项目调一次
 * `flattenOverlay`)拿到的是同一个子项目对象,舞台的 memo 不白算。
 */
export function cutSubProject(p: CutRenderProject, cutId: string): CutRenderProject | null {
  if (!Array.isArray(p.cuts)) return null;
  const root = activeCutIdOf(p);
  const path = p.cutPath ?? (root ? [root] : []);
  if (path.includes(cutId) || path.length >= MAX_CUT_DEPTH) return null;
  const key = `${path.join(">")}>${cutId}`;
  const deps = SUB_DEPS.map((k) => (p as unknown as Record<string, unknown>)[k]);
  // 激活剪辑的内容在 p.tracks 上:被引用的不会是根(成环),但可能是路径上的父剪辑引用了「此刻的激活剪辑」以外的
  // 任何一条 —— 那些都在 cuts 里。所以键只看 cuts 的引用与项目级字段。
  let byKey = subMemo.get(p.cuts);
  if (!byKey) { byKey = new Map(); subMemo.set(p.cuts, byKey); }
  const hit = byKey.get(key);
  if (hit && hit.deps.every((d, i) => d === deps[i])) return hit.sub;
  const content = cutContent(p, cutId);
  if (!content) return null;
  const { _cardRender: _drop, cutPath: _path, ...rest } = p as CutRenderProject & { _cardRender?: unknown };
  const sub: CutRenderProject = {
    ...rest,
    tracks: content.tracks,
    duration: content.duration,
    transitions: content.transitions,
    activeCutId: cutId,
    // 子项目里「激活」的就是被引用的这条:它的条目不带内容(内容在 tracks 上),和 cuts.ts 的存法一致
    cuts: p.cuts.map((c) => (c.id === cutId ? { id: c.id, name: c.name } : c)) as Cut[],
    cutPath: [...path, cutId],
  };
  byKey.set(key, { deps, sub });
  return sub;
}

/* 卡片查表由注册表在加载时注入:kernel 里的这个模块不能反过来 import 注册表(注册表 import 了 frameMode,环)。 */
type CardLookup = (id: string) => { frameMode?: unknown; need_prerendering?: unknown; defaults?: Record<string, unknown> } | undefined;
type ModeOf = (clip: TrackClip) => "direct" | "stateful";
let modeOfClip: ModeOf | null = null;
/** 注册表装好以后告诉这里怎么算一张卡的推帧口径(`registry.ts` 调) */
export function setCutClipFrameMode(fn: ModeOf | null): void {
  modeOfClip = fn;
}
export type { CardLookup };

const modeMemo = new WeakMap<object, "direct" | "stateful">();
/** 子项目的推帧口径:有任何一段卡(或嵌套的剪辑段)要按历史推进就是 stateful。查不了卡时保守地算 stateful */
export function cutFrameMode(sub: CutRenderProject): "direct" | "stateful" {
  const hit = modeMemo.get(sub);
  if (hit) return hit;
  let mode: "direct" | "stateful" = "direct";
  outer: for (const tr of sub.tracks) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (isCutSegment(c)) {
        const inner = cutSubProject(sub, c.cutId!);
        if (inner && cutFrameMode(inner) === "stateful") { mode = "stateful"; break outer; }
        continue;
      }
      if (!c.cardId && !c.nodeId) continue; // 素材段是直接按时刻取的
      if (!modeOfClip || modeOfClip(c) !== "direct") { mode = "stateful"; break outer; }
    }
  }
  modeMemo.set(sub, mode);
  return mode;
}

/** 和 `render/frameWindow.mjs` 的 `CARD_MOUNT_LEAD` 同一个数:卡片提前这么多挂载 */
const MOUNT_LEAD = 0.05;

/**
 * 要正确画出子项目在 τ 时刻的样子,最早得从子项目的哪一秒开始往后推(≤ τ)。
 * 此刻挂着的、要按历史推进的卡,得从它自己的起点推;嵌套的剪辑段按它的时间轴片段起点(含它自己的预卷)算。
 */
export function cutHistoryStart(sub: CutRenderProject, tau: number): number {
  let h = tau;
  for (const tr of sub.tracks) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (isCutSegment(c)) {
        const inner = cutSubProject(sub, c.cutId!);
        if (!inner || cutFrameMode(inner) === "direct") continue;
        const mount = c.start - cutPreroll(sub, c, inner);
        if (tau >= mount - MOUNT_LEAD && tau < c.end) h = Math.min(h, mount);
        continue;
      }
      if (!c.cardId && !c.nodeId) continue;
      if (!(tau >= c.start - MOUNT_LEAD && tau < c.end)) continue;
      if (modeOfClip && modeOfClip(c) === "direct") continue;
      h = Math.min(h, c.start);
    }
  }
  return h;
}

/**
 * 剪辑段的预卷(秒):`cutOffset > 0` 时,被引用剪辑里在 `cutOffset` 那一刻已经播了一半的、要按历史推进的卡,
 * 得从它们自己的起点推过来才对得上。做法是把时间轴片段的起点往前挪这么多(嵌套场景从更早处开始推,
 * 画面在真正的起点之前不露)。挪不到 0 之前:段贴着时间轴开头时预卷截到段起点为止。
 */
export function cutPreroll(p: CutRenderProject, clip: TrackClip, sub: CutRenderProject | null = cutSubProject(p, clip.cutId!)): number {
  if (!sub || cutFrameMode(sub) === "direct") return 0;
  const offset = Math.max(0, clip.cutOffset ?? 0);
  if (offset <= 0) return 0;
  const need = offset - cutHistoryStart(sub, offset);
  return Math.max(0, Math.min(need, clip.start));
}

/** 剪辑段在 `flattenOverlay` 里交出去的那份渲染信息;悬空、成环返回 null */
export function cutSegmentRender(p: CutRenderProject, clip: TrackClip): CutSegmentRender | null {
  if (!isCutSegment(clip)) return null;
  const sub = cutSubProject(p, clip.cutId!);
  if (!sub) return null;
  const pre = cutPreroll(p, clip, sub);
  return { cutId: clip.cutId!, offset: Math.max(0, clip.cutOffset ?? 0) - pre, from: clip.start, duration: sub.duration, project: sub, frameMode: cutFrameMode(sub) };
}

/* ───────────────────── 包络 ───────────────────── */

/** 一层包络在 t 时刻的值 */
export function envelopeAt(e: CutEnvelope, t: number, withOpacity = true): number {
  if (t < e.start || t >= e.end) return 0;
  let a = withOpacity ? e.opacity ?? 1 : 1;
  const fin = e.fadeIn ?? 0;
  const fout = e.fadeOut ?? 0;
  if (fin > 0 && t < e.start + fin) a *= (t - e.start) / fin;
  if (fout > 0 && t > e.end - fout) a *= (e.end - t) / fout;
  return Math.max(0, Math.min(1, a));
}

/* ───────────────────── 声音:把剪辑段平移展开 ───────────────────── */

/** 展开出来的片段身上的记号:原片段 id、经过的剪辑段 id(外层在前) */
export interface CutAudioOrigin {
  clipId: string;
  segments: string[];
}

const audioMemo = new WeakMap<object, Project>();

/**
 * 只给混音用的项目:激活剪辑里的每个剪辑段,换成被引用剪辑里出声的片段(素材段、带声音的卡片段、音效),
 * 平移到段的时间上、裁到段的窗口里;嵌套的剪辑段递归展开。展开出来的片段放在各自新的序列里
 * (同一个剪辑段的不同子序列在时间上会重叠),序列 id、片段 id 都带上剪辑段的路径前缀,不和原有的撞。
 *
 * - 音量 = 子片段自己的音量 × 每一层剪辑段的音量(`audioVolume`);
 * - 静音:任何一层剪辑段静音、所在序列静音,展开出来的就静音;
 * - 淡入淡出:子片段自己的(按它原来的起止)和每一层剪辑段的,都写进 `cutEnv`(不带段的不透明度 —— 那是画面的);
 * - 被引用剪辑事后变短:窗口截到它的总时长为止,超出的部分没有声音。
 *
 * 没有剪辑段的项目原样返回同一个对象(老项目的混音一个字节不变)。
 */
export function audioProjectOf(p: Project): Project {
  if (!hasCutSegments(p.tracks)) return p;
  const hit = audioMemo.get(p);
  if (hit) return hit;
  const tracks: Track[] = [];
  for (const tr of p.tracks) {
    const plain = tr.clips.filter((c) => !isCutSegment(c));
    tracks.push(plain.length === tr.clips.length ? tr : { ...tr, clips: plain });
    for (const seg of tr.clips) {
      if (!isCutSegment(seg)) continue;
      tracks.push(...expandSegmentAudio(p, seg, tr, [], []));
    }
  }
  const out = { ...p, tracks };
  audioMemo.set(p, out);
  return out;
}

function expandSegmentAudio(p: CutRenderProject, seg: TrackClip, hostTrack: Track, prefix: string[], outer: CutEnvelope[]): Track[] {
  const sub = cutSubProject(p, seg.cutId!);
  if (!sub) return [];
  const offset = Math.max(0, seg.cutOffset ?? 0);
  const shift = seg.start - offset; // 子剪辑时间 τ ↔ 父时间 τ + shift
  const w0 = seg.start;
  const w1 = Math.min(seg.end, sub.duration + shift);
  if (!(w1 > w0)) return [];
  const env: CutEnvelope = { start: seg.start, end: seg.end, ...(seg.fadeIn ? { fadeIn: seg.fadeIn } : {}), ...(seg.fadeOut ? { fadeOut: seg.fadeOut } : {}) };
  const envs = [...outer, env];
  const path = [...prefix, seg.id];
  const segVolume = seg.audioVolume ?? 1;
  const segMuted = !!seg.audioMuted || !!hostTrack.muted;
  const out: Track[] = [];
  for (const child of sub.tracks) {
    if (child.hidden) continue;
    const clips: TrackClip[] = [];
    const nested: Track[] = [];
    for (const c of child.clips) {
      if (isCutSegment(c)) {
        // 嵌套的剪辑段:先把它自己平移、裁到这一层的窗口,再递归
        const s = c.start + shift, e = c.end + shift;
        const a = Math.max(s, w0), b = Math.min(e, w1);
        if (!(b > a)) continue;
        const moved: TrackClip = {
          ...c, start: a, end: b, cutOffset: Math.max(0, c.cutOffset ?? 0) + (a - s),
          fadeIn: undefined, fadeOut: undefined,
          audioVolume: (c.audioVolume ?? 1) * segVolume,
          audioMuted: !!c.audioMuted || segMuted || !!child.muted,
        };
        // 内层段自己的淡化按它原来的起止,写成包络,和外层的一起乘
        const ownEnv: CutEnvelope = { start: s, end: e, ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}), ...(c.fadeOut ? { fadeOut: c.fadeOut } : {}) };
        nested.push(...expandSegmentAudio(sub, moved, { ...child, muted: false }, path, [...envs, ownEnv]));
        continue;
      }
      const s = c.start + shift, e = c.end + shift;
      const a = Math.max(s, w0), b = Math.min(e, w1);
      if (!(b > a)) continue;
      const own: CutEnvelope = { start: s, end: e, ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}), ...(c.fadeOut ? { fadeOut: c.fadeOut } : {}) };
      const isMedia = !!c.mediaId;
      const moved: TrackClip = {
        ...c,
        id: `${path.join("/")}/${c.id}`,
        // 素材段裁到窗口(素材内偏移跟着走);卡片段的声音和它的源时钟绑在起点上,不裁,只靠包络在窗口外归零
        start: isMedia ? a : s,
        end: isMedia ? b : e,
        ...(isMedia ? { mediaOffset: (c.mediaOffset ?? 0) + (a - s) } : {}),
        fadeIn: undefined,
        fadeOut: undefined,
        audioVolume: (c.audioVolume ?? 1) * segVolume,
        ...(segMuted || child.muted ? { audioMuted: true } : {}),
        // 外层各段的包络、子片段自己按原起止的淡化、这一层的窗口(被引用剪辑变短时截到它的总时长)
        cutEnv: [...envs, own, { start: w0, end: w1 }],
        cutOrigin: { clipId: c.id, segments: path },
      };
      clips.push(moved);
    }
    if (clips.length) out.push({ ...child, id: `${path.join("/")}/${child.id}`, muted: false, clips });
    out.push(...nested);
  }
  return out;
}
