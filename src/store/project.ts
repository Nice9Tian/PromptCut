import { useSyncExternalStore } from "react";
import { createEmptyProject, DEFAULT_CARD_DUR, DEFAULT_MEDIA_DUR, findClip, newId, type MediaAsset, type Project, type Track, type TrackClip, type Transcript } from "../kernel/project";
import { getCard } from "../kernel/registry";

/**
 * 编辑器状态存储(单例)。所有面板、时间轴、MCP 工具都通过这里读写,不直接改 Project 对象。
 * 用法:const project = useStore(s => s.project);  actions.addClip(...)
 * 每个 action 都是同步的、产生新对象(不可变更新),方便撤销和 React 重渲染。
 */

export interface EditorState {
  project: Project;
  /** 播放头(秒) */
  t: number;
  playing: boolean;
  /** 每次 seek/重播 +1,Stage 用它重新挂载卡片 */
  playToken: number;
  /** 选中的 clip id(可多选,第一个是主选) */
  selection: string[];
  /** 项目文件路径(未保存为 null) */
  filePath: string | null;
  dirty: boolean;
  /** 用户手动拖范围卡标设定的总时长，没设过就是 null */
  durationManual: number | null;
}

type Listener = () => void;

let state: EditorState = {
  project: createEmptyProject(),
  t: 0,
  playing: false,
  playToken: 1,
  selection: [],
  filePath: null,
  dirty: false,
  durationManual: null,
};
const listeners = new Set<Listener>();
const history: Project[] = [];
const future: Project[] = [];

function emit() {
  for (const l of listeners) l();
}

function set(patch: Partial<EditorState>) {
  state = { ...state, ...patch };
  emit();
}

/** 改项目文档(会进撤销栈) */
function setProject(next: Project, opts: { undoable?: boolean } = {}) {
  if (opts.undoable !== false) {
    history.push(state.project);
    if (history.length > 100) history.shift();
    future.length = 0;
  }
  set({ project: next, dirty: true });
}

function updateTrack(p: Project, trackId: string, fn: (t: Track) => Track): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? fn(t) : t)) };
}

function sortClips(clips: TrackClip[]): TrackClip[] {
  return [...clips].sort((a, b) => a.start - b.start);
}

/**
 * 轨内不重叠:把 clip 夹到相邻 clip 之间,时长不变。
 * 空档放不下整段时返回 null(调用方拒绝这次移动),不再把 clip 压扁。
 */
function resolveOverlap(track: Track, clip: TrackClip): TrackClip | null {
  const others = track.clips.filter((c) => c.id !== clip.id);
  let { start, end } = clip;
  const len = Math.max(0.1, end - start);
  const mid = start + len / 2;
  const prev = others.filter((c) => c.end <= mid).sort((a, b) => b.end - a.end)[0];
  const next = others.filter((c) => c.start >= mid).sort((a, b) => a.start - b.start)[0];
  const lo = prev ? prev.end : 0;
  const hi = next ? next.start : Infinity;
  if (hi - lo < len - 1e-6) return null;
  start = Math.max(lo, Math.min(start, hi - len));
  end = start + len;
  return { ...clip, start: Math.max(0, start), end };
}

/** 新增用:原位放不下就往后找第一个放得下的空档(时长不变)。 */
function placeOrShift(track: Track, clip: TrackClip): TrackClip {
  const fit = resolveOverlap(track, clip);
  if (fit) return fit;
  const len = Math.max(0.1, clip.end - clip.start);
  const sorted = [...track.clips].filter((c) => c.id !== clip.id).sort((a, b) => a.start - b.start);
  let cursor = clip.start;
  for (const c of sorted) {
    if (c.end <= cursor) continue;
    if (c.start - cursor >= len) break;
    cursor = Math.max(cursor, c.end);
  }
  return { ...clip, start: cursor, end: cursor + len };
}

/**
 * 落点预演:用和落卡完全相同的规则算一遍新片段会落在哪,但不改文档。
 * 时间轴的落点预览用它,保证「拖动时看到的位置」和松手后真正落下的位置一致。
 * shifted = 原位放不下、被顺延到了后面的空档。
 */
export function planPlacement(track: Track, start: number, dur: number): { start: number; end: number; shifted: boolean } {
  const from = Math.max(0, start);
  const probe: TrackClip = { id: "__probe", cardId: "", start: from, end: from + dur, params: {} };
  const placed = placeOrShift(track, probe);
  return { start: placed.start, end: placed.end, shifted: Math.abs(placed.start - from) > 1e-6 };
}

/**
 * 不指定序列时该落在哪条:挑第一条这个时间段空着的序列(序列不分种类了,所以只看占没占)。
 * 都放不下就用第一条没锁的,由 placeOrShift 往后顺延。
 */
function pickTrack(p: Project, start: number, dur: number): Track | undefined {
  const free = p.tracks.find(
    (t) => !t.locked && !t.clips.some((c) => Math.max(start, c.start) < Math.min(start + dur, c.end)),
  );
  return free ?? p.tracks.find((t) => !t.locked) ?? p.tracks[0];
}

export const actions = {
  /* ---------- 文档 ---------- */
  loadProject(p: Project, filePath: string | null = null) {
    history.length = 0;
    future.length = 0;
    set({ project: p, filePath, dirty: false, t: 0, playing: false, selection: [], playToken: state.playToken + 1, durationManual: null });
  },
  newProject(name?: string) {
    actions.loadProject(createEmptyProject(name));
  },
  setProjectMeta(patch: Partial<Pick<Project, "name" | "width" | "height" | "fps" | "duration" | "themeId">>) {
    setProject({ ...state.project, ...patch });
  },
  setDurationManual(sec: number) {
    const val = Math.max(1, sec);
    setProject({ ...state.project, duration: val });
    set({ durationManual: val });
  },
  syncDuration(sec: number) {
    const val = Math.max(1, sec);
    if (Math.abs(val - state.project.duration) < 1e-6) return;
    setProject({ ...state.project, duration: val }, { undoable: false });
  },
  markSaved(filePath: string | null) {
    set({ filePath, dirty: false });
  },
  undo() {
    const prev = history.pop();
    if (!prev) return;
    future.push(state.project);
    set({ project: prev, dirty: true });
  },
  redo() {
    const next = future.pop();
    if (!next) return;
    history.push(state.project);
    set({ project: next, dirty: true });
  },

  /* ---------- 播放 ---------- */
  seek(t: number) {
    const clamped = Math.max(0, Math.min(state.project.duration, t));
    set({ t: clamped, playToken: state.playToken + 1 });
  },
  /** 播放中每帧推进,不重挂卡片 */
  tick(t: number) {
    set({ t });
  },
  play() {
    set({ playing: true });
  },
  pause() {
    set({ playing: false });
  },
  togglePlay() {
    set({ playing: !state.playing });
  },
  replay() {
    set({ playToken: state.playToken + 1 });
  },

  /* ---------- 选择 ---------- */
  select(ids: string[]) {
    set({ selection: ids });
  },

  /* ---------- 轨道 ---------- */
  /** 加一条序列。opts.index 给了就插在那个位置(时间轴上「拖到序列之间」新建用),不给就加在数组末尾。 */
  addTrack(name?: string, opts: { index?: number } = {}): Track {
    const n = state.project.tracks.length + 1;
    const track: Track = { id: newId("t"), name: name ?? `序列 ${n}`, clips: [] };
    const tracks = [...state.project.tracks];
    const at = opts.index == null ? tracks.length : Math.max(0, Math.min(tracks.length, opts.index));
    tracks.splice(at, 0, track);
    setProject({ ...state.project, tracks });
    return track;
  },
  removeTrack(trackId: string) {
    setProject({ ...state.project, tracks: state.project.tracks.filter((t) => t.id !== trackId) });
  },
  updateTrack(trackId: string, patch: Partial<Pick<Track, "name" | "hidden" | "locked">>) {
    setProject(updateTrack(state.project, trackId, (t) => ({ ...t, ...patch })));
  },
  moveTrack(trackId: string, toIndex: number) {
    const tracks = [...state.project.tracks];
    const i = tracks.findIndex((t) => t.id === trackId);
    if (i < 0) return;
    const [tr] = tracks.splice(i, 1);
    tracks.splice(Math.max(0, Math.min(tracks.length, toIndex)), 0, tr);
    setProject({ ...state.project, tracks });
  },

  /* ---------- clip ---------- */
  /** 往序列里加一张卡。不给 trackId 就挑一条这段时间空着的序列。返回 clip。 */
  addCardClip(cardId: string, start: number, opts: { trackId?: string; duration?: number; params?: Record<string, unknown> } = {}): TrackClip | null {
    const def = getCard(cardId);
    if (!def) return null;
    const p = state.project;
    const track = opts.trackId ? p.tracks.find((t) => t.id === opts.trackId) : p.tracks[0];
    if (!track) return null;
    const dur = opts.duration ?? DEFAULT_CARD_DUR;
    const target = opts.trackId ? track : pickTrack(p, start, dur);
    if (!target) return null;
    // 参数在写入时就展开成完整的一份,不留「空 = 用默认值」这种隐式状态。
    // 调用方(界面、AI)照旧只传要改的项,但存进 clip 的是全量:
    // 存的和渲染的一致,代码页能直接看,导出的项目也不会因为以后调了卡片默认值而变样。
    let clip: TrackClip = { id: newId("c"), cardId, start, end: start + dur, params: { ...def.defaults, ...(opts.params ?? {}) } };
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
  updateClip(clipId: string, patch: Partial<Pick<TrackClip, "fadeIn" | "fadeOut" | "opacity" | "label">>) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
    })));
  },
  /**
   * 把两段相接的素材接成交叉溶解:后一段往前拉出 dur 秒的重叠,两边各加 dur 秒的淡化。
   * 同一条序列内不允许重叠,所以后一段必须落在别的序列上——现有序列都放不下就新建一条。
   * 返回是否成功。
   */
  applyCrossfade(aId: string, bId: string, dur: number): boolean {
    if (!(dur > 0)) return false;
    const A = findClip(state.project, aId);
    const B = findClip(state.project, bId);
    if (!A || !B) return false;

    const len = B.clip.end - B.clip.start;
    const newStart = Math.max(0, B.clip.start - dur);
    const fits = (tr: Track) =>
      !tr.locked &&
      !tr.clips.some((c) => c.id !== bId && Math.max(newStart, c.start) < Math.min(newStart + len, c.end));

    // 优先原地(它自己那条序列放得下就不用挪),其次别的序列,最后新建
    const candidates = [
      ...(B.track.id !== A.track.id && fits(B.track) ? [B.track] : []),
      ...state.project.tracks.filter((t) => t.id !== A.track.id && t.id !== B.track.id && fits(t)),
    ];
    const target = candidates[0] ?? actions.addTrack();

    actions.moveClip(bId, { start: newStart, end: newStart + len, trackId: target.id });
    if (!findClip(state.project, bId)) return false;
    actions.updateClip(aId, { fadeOut: dur });
    actions.updateClip(bId, { fadeIn: dur });
    return true;
  },
  setClipParams(clipId: string, params: Record<string, unknown>, opts: { merge?: boolean } = { merge: true }) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return;
    const merged = opts.merge === false ? params : { ...hit.clip.params, ...params };
    setProject(updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, params: merged } : c)) })));
  },
  /** 换卡片类型(保留时段)。keepParams 为 true 时,保留新卡也有的同名参数。 */
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
    setProject(updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, cardId, params } : c)) })));
  },
  removeClip(clipId: string) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return;
    setProject(updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) })));
    set({ selection: state.selection.filter((id) => id !== clipId) });
  },
  duplicateClip(clipId: string): TrackClip | null {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return null;
    const len = hit.clip.end - hit.clip.start;
    let clip: TrackClip = { ...hit.clip, id: newId("c"), start: hit.clip.end, end: hit.clip.end + len };
    clip = placeOrShift(hit.track, clip);
    setProject(updateTrack(p, hit.track.id, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) })));
    set({ selection: [clip.id] });
    return clip;
  },
  /** 在 t 处把 clip 一切为二 */
  splitClip(clipId: string, t: number): TrackClip | null {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit || t <= hit.clip.start + 0.05 || t >= hit.clip.end - 0.05) return null;
    const left: TrackClip = { ...hit.clip, end: t };
    const right: TrackClip = { ...hit.clip, id: newId("c"), start: t, mediaOffset: (hit.clip.mediaOffset ?? 0) + (t - hit.clip.start) };
    setProject(updateTrack(p, hit.track.id, (t2) => ({ ...t2, clips: sortClips([...t2.clips.filter((c) => c.id !== clipId), left, right]) })));
    return right;
  },

  /* ---------- 素材 ---------- */
  addMedia(asset: Omit<MediaAsset, "id"> & { id?: string }): MediaAsset {
    const m: MediaAsset = { ...asset, id: asset.id ?? newId("m") };
    setProject({ ...state.project, media: [...state.project.media, m] }, { undoable: false });
    return m;
  },
  /** 写入 / 清除素材的语音转文字结果(不进撤销栈) */
  setMediaTranscript(mediaId: string, transcript: Transcript | null) {
    const p = state.project;
    if (!p.media.some((m) => m.id === mediaId)) return;
    setProject(
      { ...p, media: p.media.map((m) => (m.id === mediaId ? { ...m, transcript: transcript ?? undefined } : m)) },
      { undoable: false },
    );
  },
  setMediaPath(mediaId: string, path: string) {
    const p = state.project;
    if (!p.media.some((m) => m.id === mediaId)) return;
    setProject(
      { ...p, media: p.media.map((m) => (m.id === mediaId ? { ...m, path } : m)) },
      { undoable: false },
    );
  },
  removeMedia(mediaId: string) {
    const p = state.project;
    setProject({
      ...p,
      media: p.media.filter((m) => m.id !== mediaId),
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.mediaId !== mediaId) })),
    });
  },
};

export function getState(): EditorState {
  return state;
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: EditorState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}
