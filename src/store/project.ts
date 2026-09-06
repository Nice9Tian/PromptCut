import { useSyncExternalStore } from "react";
import { createEmptyProject, findClip, newId, type MediaAsset, type Project, type Track, type TrackClip, type Transcript } from "../kernel/project";
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

export const actions = {
  /* ---------- 文档 ---------- */
  loadProject(p: Project, filePath: string | null = null) {
    history.length = 0;
    future.length = 0;
    set({ project: p, filePath, dirty: false, t: 0, playing: false, selection: [], playToken: state.playToken + 1 });
  },
  newProject(name?: string) {
    actions.loadProject(createEmptyProject(name));
  },
  setProjectMeta(patch: Partial<Pick<Project, "name" | "width" | "height" | "fps" | "duration" | "themeId">>) {
    setProject({ ...state.project, ...patch });
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
  addTrack(kind: Track["kind"] = "overlay", name?: string): Track {
    const n = state.project.tracks.filter((t) => t.kind === kind).length + 1;
    const track: Track = { id: newId("t"), name: name ?? (kind === "overlay" ? `动效 ${n}` : `视频 ${n}`), kind, clips: [] };
    setProject({ ...state.project, tracks: [...state.project.tracks, track] });
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
  /** 往 overlay 轨加一张卡。不给 trackId 就放第一条 overlay 轨。返回 clip。 */
  addCardClip(cardId: string, start: number, opts: { trackId?: string; duration?: number; params?: Record<string, unknown> } = {}): TrackClip | null {
    const def = getCard(cardId);
    if (!def) return null;
    const p = state.project;
    const track = opts.trackId ? p.tracks.find((t) => t.id === opts.trackId) : p.tracks.find((t) => t.kind === "overlay");
    if (!track) return null;
    const dur = opts.duration ?? 3;
    let clip: TrackClip = { id: newId("c"), cardId, start, end: start + dur, params: opts.params ?? {} };
    clip = placeOrShift(track, clip);
    setProject(updateTrack(p, track.id, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) })));
    set({ selection: [clip.id] });
    return clip;
  },
  /** 往 video 轨加一段素材 */
  addMediaClip(mediaId: string, start: number, opts: { trackId?: string; duration?: number; mediaOffset?: number } = {}): TrackClip | null {
    const p = state.project;
    const media = p.media.find((m) => m.id === mediaId);
    if (!media) return null;
    const track = opts.trackId ? p.tracks.find((t) => t.id === opts.trackId) : p.tracks.find((t) => t.kind === "video");
    if (!track) return null;
    const dur = opts.duration ?? media.duration ?? 5;
    let clip: TrackClip = { id: newId("v"), cardId: "", mediaId, mediaOffset: opts.mediaOffset ?? 0, start, end: start + dur, params: {}, label: media.name };
    clip = placeOrShift(track, clip);
    const duration = Math.max(p.duration, clip.end);
    setProject({ ...updateTrack(p, track.id, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) })), duration });
    set({ selection: [clip.id] });
    return clip;
  },
  /** 移动 / 缩放 clip(可跨轨)。 */
  moveClip(clipId: string, patch: { start?: number; end?: number; trackId?: string }) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return;
    const targetId = patch.trackId ?? hit.track.id;
    const target = p.tracks.find((t) => t.id === targetId);
    if (!target || target.kind !== hit.track.kind) return;
    let clip: TrackClip | null = { ...hit.clip, start: patch.start ?? hit.clip.start, end: patch.end ?? hit.clip.end };
    if (clip.end - clip.start < 0.1) clip.end = clip.start + 0.1;
    clip = resolveOverlap(target, clip);
    if (!clip) return; // 目标位置放不下整段:拒绝移动,不压扁
    const placed = clip;
    let next = updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) }));
    next = updateTrack(next, target.id, (t) => ({ ...t, clips: sortClips([...t.clips, placed]) }));
    setProject(next);
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
    let params: Record<string, unknown> = {};
    if (opts.keepParams) {
      for (const k of Object.keys(def.defaults)) if (k in hit.clip.params) params[k] = hit.clip.params[k];
    }
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
