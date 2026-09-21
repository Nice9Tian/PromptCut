import { DEFAULT_CARD_DUR, DEFAULT_MEDIA_DUR, findClip, newId, type Track, type TrackClip } from "../../kernel/project";
import { getCard } from "../../kernel/registry";
import { cloneCardClipInstance } from "../../kernel/cardAuthoring.mjs";
import type { PartInstance } from "../../kernel/types";
import { fadeOwner, groupOf, timingLock, transitionsOf, transitionsOfClip } from "../../kernel/transitions";

import {
  state, set,
  setProject,
  clearTransitionFades,
  updateTrack,
  pruneCardNodes,
  shiftClipsBy,
  sortClips,
  resolveOverlap,
  placeOrShift, pickTrack
} from "../core";

export const clips = {

  /* ---------- clip ---------- */
  /** 往序列里加一张卡。不给 trackId 就挑一条这段时间空着的序列。返回 clip。 */
  addCardClip(cardId: string, start: number, opts: { trackId?: string; duration?: number; params?: Record<string, unknown>; parts?: PartInstance[] } = {}): TrackClip | null {
    const def = getCard(cardId);
    if (!def) return null;
    // 音频图卡拖进时间轴是个既无声又无画的空片段(没有 nodeId,消费方只看节点):
    // 它只能经 apply_card 挂到片段上。
    if (def.kind === "audio") throw new Error("音频图卡请用 apply_card");
    const p = state.project;
    const track = opts.trackId ? p.tracks.find((t) => t.id === opts.trackId) : p.tracks[0];
    if (!track) return null;
    const dur = opts.duration ?? DEFAULT_CARD_DUR;
    const target = opts.trackId ? track : pickTrack(p, start, dur);
    if (!target) return null;
    // 参数在写入时就展开成完整的一份,不留「空 = 用默认值」这种隐式状态。
    // 调用方(界面、AI)照旧只传要改的项,但存进 clip 的是全量:
    // 存的和渲染的一致,代码页能直接看,导出的项目也不会因为以后调了卡片默认值而变样。
    let clip: TrackClip = { id: newId("c"), cardId, start, end: start + dur, params: { ...def.defaults, ...(opts.params ?? {}) }, ...(opts.parts?.length ? { parts: opts.parts } : {}) };
    clip = placeOrShift(target, clip);
    setProject(updateTrack(p, target.id, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) })));
    set({ selection: [clip.id] });
    return clip;
  },
  /** 往序列里加一段素材。不给 trackId 就挑一条这段时间空着的序列。 */
  addMediaClip(mediaId: string, start: number, opts: { trackId?: string; duration?: number; mediaOffset?: number } = {}): TrackClip | null {
    const p = state.project;
    const media = p.media.find((m) => m.id === mediaId);
    if (!media) return null;
    const track = opts.trackId ? p.tracks.find((t) => t.id === opts.trackId) : p.tracks[0];
    if (!track) return null;
    const dur = opts.duration ?? media.duration ?? DEFAULT_MEDIA_DUR;
    const target = opts.trackId ? track : pickTrack(p, start, dur);
    if (!target) return null;
    let clip: TrackClip = { id: newId("v"), cardId: "", mediaId, mediaOffset: opts.mediaOffset ?? 0, start, end: start + dur, params: {}, label: media.name };
    clip = placeOrShift(target, clip);
    const duration = Math.max(p.duration, clip.end);
    setProject({ ...updateTrack(p, target.id, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) })), duration });
    set({ selection: [clip.id] });
    return clip;
  },
  /**
   * 新建一条序列,并把片段直接落上去。一次手势 = 一步撤销(时间轴上「拖到序列之间」和「拖到新建落区」用)。
   * 新序列是空的,所以片段一定落在 start 上,不会被顺延。
   */
  addClipOnNewTrack(spec: { index?: number; cardId?: string; mediaId?: string; start: number; duration?: number }): TrackClip | null {
    const p = state.project;
    const start = Math.max(0, spec.start);
    let clip: TrackClip;
    const isCard = !!spec.cardId;
    if (isCard) {
      if (!getCard(spec.cardId!)) return null;
      const dur = spec.duration ?? DEFAULT_CARD_DUR;
      clip = { id: newId("c"), cardId: spec.cardId!, start, end: start + dur, params: {} };
    } else {
      const media = p.media.find((m) => m.id === spec.mediaId);
      if (!media) return null;
      const dur = spec.duration ?? media.duration ?? DEFAULT_MEDIA_DUR;
      clip = { id: newId("v"), cardId: "", mediaId: media.id, mediaOffset: 0, start, end: start + dur, params: {}, label: media.name };
    }
    const track: Track = { id: newId("t"), name: `序列 ${p.tracks.length + 1}`, clips: [clip] };
    const tracks = [...p.tracks];
    const at = spec.index == null ? tracks.length : Math.max(0, Math.min(tracks.length, spec.index));
    tracks.splice(at, 0, track);
    setProject({ ...p, tracks, duration: isCard ? p.duration : Math.max(p.duration, clip.end) });
    set({ selection: [clip.id] });
    return clip;
  },
  /** 移动 / 缩放 clip(可跨序列)。 */
  moveClip(clipId: string, patch: { start?: number; end?: number; trackId?: string }) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return;
    /*
     * 挂着转场的片段:相对关系是转场的一部分,不许单独动。
     * 允许的只有「整组一起平移」—— 那不改相对关系,转场照旧成立。
     * 改长度、换序列都会把转场弄坏,直接拒绝(要改先删转场)。
     */
    if (timingLock(p, clipId)) {
      const wantStart = patch.start ?? hit.clip.start;
      // 只给 start:意思是「把这段挪到这儿」,时长不变(单独修边本来就会被下面拒掉,
      // 按修边理解等于永远拒绝,那 Agent 就没法平移整组了)
      const wantEnd = patch.end ?? (patch.start !== undefined ? wantStart + (hit.clip.end - hit.clip.start) : hit.clip.end);
      const lenChanged = Math.abs(wantEnd - wantStart - (hit.clip.end - hit.clip.start)) > 1e-3;
      const trackChanged = !!patch.trackId && patch.trackId !== hit.track.id;
      if (lenChanged || trackChanged) return;
      const dt = wantStart - hit.clip.start;
      if (Math.abs(dt) < 1e-6) return;
      const next = shiftClipsBy(p, groupOf(p, clipId).members, dt);
      if (next) setProject(next);
      return;
    }
    const targetId = patch.trackId ?? hit.track.id;
    const target = p.tracks.find((t) => t.id === targetId);
    if (!target || target.locked) return;
    let clip: TrackClip | null = { ...hit.clip, start: patch.start ?? hit.clip.start, end: patch.end ?? hit.clip.end };
    if (clip.end - clip.start < 0.1) clip.end = clip.start + 0.1;
    clip = resolveOverlap(target, clip);
    if (!clip) return; // 目标位置放不下整段:拒绝移动,不压扁
    const placed = clip;
    let next = updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) }));
    next = updateTrack(next, target.id, (t) => ({ ...t, clips: sortClips([...t.clips, placed]) }));
    setProject(next);
  },
  /**
   * 改片段自身的属性(不是卡片参数):淡入淡出、整体不透明度、显示名。
   * 两段素材重叠 + 各自淡化 = 交叉溶解,所以「转场」不需要单独的对象,改这几个字段就够。
   */
  updateClip(clipId: string, patch: Partial<Pick<TrackClip, "fadeIn" | "fadeOut" | "opacity" | "label">>): { ok: boolean; blocked?: ("fadeIn" | "fadeOut")[] } {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return { ok: false };
    // 转场管着的淡化不许直接改:那是转场的时长,改了两边就对不上。要改先删转场再重加
    const blocked: ("fadeIn" | "fadeOut")[] = [];
    const clean: typeof patch = { ...patch };
    for (const side of ["fadeIn", "fadeOut"] as const) {
      if (clean[side] !== undefined && fadeOwner(p, clipId, side)) {
        blocked.push(side);
        delete clean[side];
      }
    }
    if (Object.keys(clean).length === 0) return { ok: blocked.length === 0, ...(blocked.length ? { blocked } : {}) };
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id === clipId ? { ...c, ...clean } : c)),
    })));
    return { ok: true, ...(blocked.length ? { blocked } : {}) };
  },
  removeClip(clipId: string) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return;
    // 片段没了,引用它的转场也就没了意义:一并撤掉,并把另一头的淡化擦干净,
    // 免得留下一段「无缘无故淡出」的画面
    const doomed = transitionsOfClip(p, clipId);
    let next = updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) }));
    for (const tr of doomed) next = clearTransitionFades(next, tr);
    if (doomed.length) next = { ...next, transitions: transitionsOf(next).filter((tr) => !doomed.includes(tr)) };
    setProject(pruneCardNodes(next));
    set({ selection: state.selection.filter((id) => id !== clipId) });
  },
  duplicateClip(clipId: string): TrackClip | null {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return null;
    const len = hit.clip.end - hit.clip.start;
    let clip: TrackClip = { ...hit.clip, id: newId("c"), start: hit.clip.end, end: hit.clip.end + len, ...(hit.clip.parts ? { parts: JSON.parse(JSON.stringify(hit.clip.parts)) } : {}) };
    clip = placeOrShift(hit.track, clip);
    const cloned = cloneCardClipInstance(p, hit.clip.id, clip.id, hit.clip.nodeId);
    if (cloned.nodeId !== hit.clip.nodeId) clip = { ...clip, nodeId: cloned.nodeId };
    setProject(updateTrack(cloned.project, hit.track.id, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) })));
    set({ selection: [clip.id] });
    return clip;
  },
  /** 在 t 处把 clip 一切为二 */
  splitClip(clipId: string, t: number): TrackClip | null {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit || t <= hit.clip.start + 0.05 || t >= hit.clip.end - 0.05) return null;
    // 切开会凭空多出一段,转场两头就对不上了 —— 先删转场
    if (timingLock(p, clipId)) return null;
    const left: TrackClip = { ...hit.clip, end: t };
    let right: TrackClip = { ...hit.clip, id: newId("c"), start: t, mediaOffset: (hit.clip.mediaOffset ?? 0) + (t - hit.clip.start), ...(hit.clip.parts ? { parts: JSON.parse(JSON.stringify(hit.clip.parts)) } : {}) };
    const cloned = cloneCardClipInstance(p, hit.clip.id, right.id, hit.clip.nodeId, t - hit.clip.start);
    if (cloned.nodeId !== hit.clip.nodeId) right = { ...right, nodeId: cloned.nodeId };
    setProject(updateTrack(cloned.project, hit.track.id, (t2) => ({ ...t2, clips: sortClips([...t2.clips.filter((c) => c.id !== clipId), left, right]) })));
    return right;
  },

  setClipParams(clipId: string, params: Record<string, unknown>, opts: { merge?: boolean } = { merge: true }) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return;
    const merged = opts.merge === false ? params : { ...hit.clip.params, ...params };
    setProject(updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, params: merged } : c)) })));
  },
  setClipCard(clipId: string, cardId: string, opts: { keepParams?: boolean } = {}) {
    const p = state.project;
    const hit = findClip(p, clipId);
    const def = getCard(cardId);
    if (!hit || !def) return;
    // 同样写全:先铺新卡的默认值,再把旧卡里同名的参数覆盖上去
    const kept: Record<string, unknown> = {};
    if (opts.keepParams) {
      for (const k of Object.keys(def.defaults)) if (k in hit.clip.params) kept[k] = hit.clip.params[k];
    }
    const params: Record<string, unknown> = { ...def.defaults, ...kept };
    // 换成别的卡时部件树跟着丢:parts 只属于组合卡,留着会让舞台继续画旧的部件、面板还当它是组合卡
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        const { parts: _parts, ...rest } = c;
        return cardId === "composite" ? { ...c, cardId, params } : { ...rest, cardId, params };
      }),
    })));
  },
};
