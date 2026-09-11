import { useSyncExternalStore } from "react";
import { createEmptyProject, DEFAULT_CARD_DUR, DEFAULT_MEDIA_DUR, findClip, findSoundAsset, newId, soundAssetFrom, type MediaAsset, type Project, type Track, type TrackClip, type Transcript, type Shots, type Subjects } from "../kernel/project";
import { getCard } from "../kernel/registry";
import { normalizeEmphasis, type ClipEmphasis } from "../kernel/emphasis";
import {
  CAPTION_CARD_ID,
  CAPTION_TRACK_NAME,
  captionsFromTranscript,
  captionsOf,
  editCaption as editCaptionLine,
  formatCaptions,
  insertCaption,
  isCaptionClip,
  removeCaption as removeCaptionLine,
} from "../kernel/captions";
import type { ClipFrame, ClipMotion, PartInstance } from "../kernel/types";
import {
  normalizeCuts, switchCut as switchCutPure, addCut as addCutPure, renameCut as renameCutPure,
  removeCut as removeCutPure, stripMediaFromCuts,
} from "../kernel/cuts";
import {
  checkCrossfade, checkFade, clampDur, fadeOwner, groupOf, timingLock,
  transitionsOf, transitionsOfClip, type Transition, type TransitionKind,
} from "../kernel/transitions";

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
  /**
   * 上一次用过的三维视角。关掉三维(camera3dFov 被抹掉)时记在这儿,再打开就回到那个值。
   *
   * **不落盘**:存盘结果要和从没开过三维一样。放在 store 而不是模块变量,是因为模块变量
   * 跨项目存活 —— A 项目调过 60、关掉,再打开一个从没开过三维的 B 项目,B 会莫名其妙拿到 60。
   * 挂在这儿,loadProject 顺手清掉就干净了。
   */
  lastCamera3dFov: number | null;
  /** 预览总音量 0–1(只影响预览,不写进项目;导出由 ffmpeg 合成原音) */
  volume: number;
  /** 预览静音开关,和 volume 分开记,取消静音能回到原音量 */
  muted: boolean;
}

type Listener = () => void;

/** 预览音量记在本机,跟项目无关 */
const VOLUME_KEY = "pc.volume";
function readVolume(): number {
  try {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY) ?? "");
    if (Number.isFinite(v)) return Math.max(0, Math.min(1, v));
  } catch {}
  return 0.7;
}

let state: EditorState = {
  project: createEmptyProject(),
  t: 0,
  playing: false,
  playToken: 1,
  selection: [],
  filePath: null,
  dirty: false,
  durationManual: null,
  lastCamera3dFov: null,
  volume: readVolume(),
  muted: false,
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

/** 把一条转场写下的淡化擦掉(片段可能已经不在了,擦不到就跳过) */
function clearTransitionFades(p: Project, tr: Transition): Project {
  const clear = (clipId: string | undefined, side: "fadeIn" | "fadeOut") => {
    if (!clipId) return;
    p = {
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? { ...c, [side]: 0 } : c)),
      })),
    };
  };
  if (tr.kind === "crossfade") {
    clear(tr.aId, "fadeOut");
    clear(tr.bId, "fadeIn");
  } else {
    clear(tr.aId, tr.kind === "fadeIn" ? "fadeIn" : "fadeOut");
  }
  return p;
}

function updateTrack(p: Project, trackId: string, fn: (t: Track) => Track): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? fn(t) : t)) };
}

/**
 * 把一组片段整体平移 dt 秒。轨内不能重叠、不能被推到 0 之前 —— 有一处放不下就整组不动
 * (返回 null),不做「挪一半」这种半吊子结果。组内的相对关系原样保留,所以转场不会散。
 */
function shiftClipsBy(p: Project, ids: string[], dt: number): Project | null {
  const set = new Set(ids);
  let found = 0;
  const tracks = p.tracks.map((t) => ({
    ...t,
    clips: sortClips(
      t.clips.map((c) => {
        if (!set.has(c.id)) return c;
        found++;
        return { ...c, start: c.start + dt, end: c.end + dt };
      }),
    ),
  }));
  if (found !== set.size) return null;
  for (const t of tracks) {
    for (let i = 0; i < t.clips.length; i++) {
      if (t.clips[i].start < -1e-6) return null;
      if (i > 0 && t.clips[i].start < t.clips[i - 1].end - 1e-6) return null;
    }
  }
  return { ...p, tracks };
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
    // 所有加载路径的唯一入口,在这里把项目补成多剪辑形状:老文件没有 cuts 就补成默认三条
    const normalized = normalizeCuts(p);
    // lastCamera3dFov 跟着项目走,换项目要清掉,否则三维视角会串味
    set({ project: normalized, filePath, dirty: false, t: 0, playing: false, selection: [], playToken: state.playToken + 1, durationManual: null, lastCamera3dFov: null });
  },
  newProject(name?: string) {
    actions.loadProject(createEmptyProject(name));
  },
  setProjectMeta(patch: Partial<Pick<Project, "name" | "width" | "height" | "fps" | "duration" | "themeId" | "camera3dFov">>) {
    setProject({ ...state.project, ...patch });
  },
  /** 记住关三维之前用的视角(不落盘,换项目自动清)。见 EditorState.lastCamera3dFov */
  rememberCamera3dFov(fov: number | null) {
    set({ lastCamera3dFov: fov });
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

  /* ---------- 剪辑(多条时间轴) ---------- */
  /**
   * 切到另一条剪辑。当前的 tracks / duration / 播放头存回它的条目,目标的换进来。
   * 进撤销栈(整份 project 一起,撤销就是切回去);选中清空、停播、总时长手动值清掉 —— 这些都是
   * 上一条剪辑的东西。播放头用目标上次离开时的。
   */
  switchCut(cutId: string) {
    const { project, t } = switchCutPure(state.project, cutId, state.t);
    if (project === state.project) return;
    setProject(project);
    set({ t, playing: false, selection: [], playToken: state.playToken + 1, durationManual: null });
  },
  /** 新建一条剪辑,默认切过去(和剪辑软件新建序列的习惯一致) */
  addCut(name?: string, opts: { switchTo?: boolean } = {}) {
    const { project, cut } = addCutPure(state.project, name);
    setProject(project);
    if (opts.switchTo !== false) actions.switchCut(cut.id);
    return cut;
  },
  renameCut(cutId: string, name: string) {
    setProject(renameCutPure(state.project, cutId, name));
  },
  /** 删一条剪辑。删激活那条会先切到相邻的;最后一条不能删(纯逻辑里会抛) */
  removeCut(cutId: string) {
    const { project, switchedTo, t } = removeCutPure(state.project, cutId, state.t);
    setProject(project);
    if (switchedTo) set({ t, playing: false, selection: [], playToken: state.playToken + 1, durationManual: null });
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
  /**
   * 重播:回到开头从头播一遍。
   *
   * 以前这里只加 playToken —— 那只是让「当前时刻活跃的卡片」重新挂载一次,
   * 用来重看入场动画。可播放到头时循环会 pause 并把 t 停在 duration,
   * 而 Stage 取的是 t >= start && t < end,末尾一个活跃 clip 都没有,
   * 于是「播完按重播」= 让零个卡片重新挂载 = 画面纹丝不动,按钮像是坏的。
   *
   * 传统式下用户会顺手把播放头拖回去所以不容易撞上;对话式没有时间轴,
   * 只有一条细的 MiniScrubber,播完就只能按这个按钮 —— 于是问题就显出来了。
   *
   * 「在当前位置重看一遍入场动画」这个能力没丢:seek 本身就会加 playToken,
   * 点一下进度条即可。
   */
  replay() {
    set({ t: 0, playing: true, playToken: state.playToken + 1 });
  },
  /** 预览音量 0–1;调到非 0 顺手取消静音,和播放器习惯一致 */
  setVolume(v: number) {
    const volume = Math.max(0, Math.min(1, v));
    try {
      localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {}
    set({ volume, muted: volume === 0 ? state.muted : false });
  },
  toggleMute() {
    set({ muted: !state.muted });
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
  updateTrack(trackId: string, patch: Partial<Pick<Track, "name" | "hidden" | "locked" | "muted">>) {
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
  addCardClip(cardId: string, start: number, opts: { trackId?: string; duration?: number; params?: Record<string, unknown>; parts?: PartInstance[] } = {}): TrackClip | null {
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
  /**
   * 给一段加 / 去掉强调(阴影、描边)。传 null 就是去掉。
   * 参数在 kernel/emphasis.ts 里补全和夹范围,kind 不认识就当没设。
   */
  setClipEmphasis(clipId: string, emphasis: Partial<ClipEmphasis> | null): { ok: boolean; emphasis: ClipEmphasis | null; error?: string } {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return { ok: false, emphasis: null, error: `找不到片段 ${clipId}` };
    const next = emphasis ? normalizeEmphasis(emphasis) : null;
    if (emphasis && !next) return { ok: false, emphasis: null, error: "强调只有 shadow(阴影)和 outline(描边)两种" };
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!next) {
          // 去掉时把键删掉,而不是留个 undefined —— 存进 .proc 会多一行没用的
          const { emphasis: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, emphasis: next };
      }),
    })));
    return { ok: true, emphasis: next };
  },

  /**
   * 绑定 / 解绑一条运动轨迹。传 undefined 就是解绑。
   *
   * 和 updateClip 分开而不是并进它的 patch:motion 是一坨逐帧数据,不是
   * 淡入淡出那种一眼看完的标量,混在同一个 patch 里会让「随手改个不透明度」
   * 和「换掉整条轨迹」长得一模一样。
   */
  setClipMotion(clipId: string, motion: ClipMotion | undefined) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!motion) {
          const { motion: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, motion };
      }),
    })));
    return true;
  },
  /**
   * 设 / 清卡片的框(位置、尺寸、锚点、缩放、旋转)。传 undefined 就是清掉,恢复铺满全屏。
   * 传进来的 frame 是**完整的局部坐标**,不做合并 —— 合并(只改传了的字段)和 world→local
   * 换算都在调用方(kernel/layout.ts 的 framePatchFromArgs)做完了,这里只负责存。
   * 和 motion 一样单独一个 action,不并进 updateClip 的 patch。
   */
  setClipFrame(clipId: string, frame: ClipFrame | undefined) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!frame) {
          const { frame: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, frame };
      }),
    })));
    return true;
  },
  /**
   * 把两段相接的素材接成交叉溶解:后一段往前拉出 dur 秒的重叠,两边各加 dur 秒的淡化。
   * 同一条序列内不允许重叠,所以后一段必须落在别的序列上——现有序列都放不下就新建一条。
   * 返回是否成功。
   */
  /**
   * 老名字,留着给已有调用方用:现在等价于 addTransition({ kind: "crossfade" })。
   * 一定要走那条路 —— 只有它会写下转场记录,把两段绑成一组;光设 fadeIn / fadeOut
   * 的话谁都能随手挪走其中一段,溶解就悄悄散了。
   */
  applyCrossfade(aId: string, bId: string, dur: number): boolean {
    return actions.addTransition({ kind: "crossfade", clipId: aId, otherClipId: bId, dur }).ok;
  },

  /* ---------- 转场:加了就把相关片段绑成一组(规矩在 kernel/transitions.ts) ---------- */

  /**
   * 加一处转场。
   *
   *   - crossfade:要两段首尾相接的片段。同一条序列内不能重叠,所以会把后一段往前拉出
   *     重叠、必要时挪到另一条序列(挪之前的位置记在 prevB 里,删转场时放回去);
   *   - fadeIn / fadeOut:只认一段,分别写在它的头和尾。
   *
   * 整件事一次 setProject 落地 —— 撤销一步就能全撤,不会留下「挪了但没绑」的半截状态。
   */
  addTransition(args: { kind: TransitionKind; clipId: string; otherClipId?: string; dur?: number }):
    { ok: true; transition: Transition } | { ok: false; error: string } {
    const p = state.project;
    const dur = clampDur(args.dur, args.kind === "crossfade" ? 0.5 : 0.6);

    if (args.kind === "fadeIn" || args.kind === "fadeOut") {
      const chk = checkFade(p, args.clipId, args.kind, dur);
      if (!chk.ok) return chk;
      const tr: Transition = { id: newId("tx"), kind: args.kind, aId: args.clipId, dur: chk.dur };
      const hit = findClip(p, args.clipId)!;
      const next = updateTrack(p, hit.track.id, (t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === args.clipId ? { ...c, [args.kind]: chk.dur } : c)),
      }));
      setProject({ ...next, transitions: [...transitionsOf(next), tr] });
      return { ok: true, transition: tr };
    }

    if (!args.otherClipId) return { ok: false, error: "交叉溶解要两段:clipId 和 otherClipId" };
    const chk = checkCrossfade(p, args.clipId, args.otherClipId, dur);
    if (!chk.ok) return chk;
    const { a, b } = chk;
    const aTrack = findClip(p, a.id)!.track;
    const bTrack = findClip(p, b.id)!.track;
    const len = b.end - b.start;
    const newStart = Math.max(0, b.start - chk.dur);
    const fits = (tr: Track) =>
      !tr.locked && tr.id !== aTrack.id &&
      !tr.clips.some((c) => c.id !== b.id && Math.max(newStart, c.start) < Math.min(newStart + len, c.end) - 1e-6);

    // 先原地(后一段本来就不在前一段那条序列上、且挪过去放得下),再找别的,最后新建一条
    const target = [bTrack, ...p.tracks.filter((t) => t.id !== bTrack.id)].find(fits);
    const newTrack: Track | null = target ? null : { id: newId("t"), name: `序列 ${p.tracks.length + 1}`, clips: [] };
    const targetId = target?.id ?? newTrack!.id;

    const movedB: TrackClip = { ...b, start: newStart, end: newStart + len, fadeIn: chk.dur };
    let tracks = p.tracks.map((t) => {
      let clips = t.clips.filter((c) => c.id !== b.id);
      if (t.id === aTrack.id) clips = clips.map((c) => (c.id === a.id ? { ...c, fadeOut: chk.dur } : c));
      if (t.id === targetId) clips = sortClips([...clips, movedB]);
      return { ...t, clips };
    });
    if (newTrack) tracks = [...tracks, { ...newTrack, clips: [movedB] }];

    const tr: Transition = {
      id: newId("tx"), kind: "crossfade", aId: a.id, bId: b.id, dur: chk.dur,
      prevB: { start: b.start, trackId: bTrack.id },
    };
    setProject({ ...p, tracks, transitions: [...transitionsOf(p), tr] });
    return { ok: true, transition: tr };
  },

  /**
   * 删一处转场:淡化擦掉、记录去掉,交叉溶解还会尽量把后一段放回加转场之前的位置
   * (那儿被占了就留在原地,返回 note 说明)。删完这几段就自由了。
   */
  removeTransition(transitionId: string): { ok: true; note?: string } | { ok: false; error: string } {
    const p = state.project;
    const tr = transitionsOf(p).find((x) => x.id === transitionId);
    if (!tr) return { ok: false, error: `找不到转场 ${transitionId}` };
    let next = clearTransitionFades(p, tr);
    let note: string | undefined;
    if (tr.kind === "crossfade" && tr.bId && tr.prevB) {
      const hit = findClip(next, tr.bId);
      if (hit) {
        const len = hit.clip.end - hit.clip.start;
        const home = next.tracks.find((t) => t.id === tr.prevB!.trackId);
        const free = home && !home.locked && !home.clips.some(
          (c) => c.id !== tr.bId && Math.max(tr.prevB!.start, c.start) < Math.min(tr.prevB!.start + len, c.end) - 1e-6,
        );
        if (free) {
          const moved: TrackClip = { ...hit.clip, start: tr.prevB.start, end: tr.prevB.start + len };
          next = {
            ...next,
            tracks: next.tracks.map((t) => {
              let clips = t.clips.filter((c) => c.id !== tr.bId);
              if (t.id === home!.id) clips = sortClips([...clips, moved]);
              return { ...t, clips };
            }),
          };
        } else {
          note = "后一段原来的位置被占了,留在当前位置(两段现在还重叠着,可以自己挪开)";
        }
      }
    }
    setProject({ ...next, transitions: transitionsOf(next).filter((x) => x.id !== transitionId) });
    return { ok: true, ...(note ? { note } : {}) };
  },

  setClipParams(clipId: string, params: Record<string, unknown>, opts: { merge?: boolean } = { merge: true }) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return;
    const merged = opts.merge === false ? params : { ...hit.clip.params, ...params };
    setProject(updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, params: merged } : c)) })));
  },
  /**
   * 字幕专用序列:有就用,没有就建一条。
   *
   * 建在**最上面**(tracks[0]):时间轴上靠上的序列画在上层,字幕本来就该压在画面之上 ——
   * 以前用 addTrack 追加到末尾,叠放顺序翻正之后那等于把字幕塞到了所有画面底下。
   */
  ensureCaptionTrack(): Track {
    const found = state.project.tracks.find((t) => t.name === CAPTION_TRACK_NAME);
    if (found) return found;
    return actions.addTrack(CAPTION_TRACK_NAME, { index: 0 });
  },
  /**
   * 一键把某份素材的文字稿铺成字幕轨:字幕序列 → 一张 caption-track 卡 → 灌进 lines。
   *
   * 以前只有 AI 走 auto_workflow / fill_captions 能铺字幕,人在界面上转写完就没有下一步了。
   * 时段按这份素材在时间轴上真正铺开的范围算(认 mediaOffset,素材被挪过、修过头也对得上)。
   * 已经有一张覆盖同一段时间的字幕卡就往那张里灌,不再多建一张。
   */
  buildCaptions(mediaId: string): { ok: true; clipId: string; count: number } | { ok: false; reason: string } {
    const p = state.project;
    const media = p.media.find((m) => m.id === mediaId);
    if (!media) return { ok: false, reason: "找不到这份素材" };
    const segments = media.transcript?.segments ?? [];
    if (segments.length === 0) return { ok: false, reason: "这份素材还没有文字稿" };

    const clips = p.tracks.flatMap((t) => t.clips);
    const plan = captionsFromTranscript(clips, mediaId, segments);
    if (plan.lines.length === 0) return { ok: false, reason: "这份素材还没放到时间轴上,先把它拖上去再铺字幕" };

    const track = actions.ensureCaptionTrack();
    // 同一时段已经有字幕卡就复用它(重新转写之后再铺一次是常事,不该越铺越多)
    const exist = track.clips.find((c) => isCaptionClip(c) && Math.max(c.start, plan.from) < Math.min(c.end, plan.to));
    if (exist) {
      const re = captionsFromTranscript(clips, mediaId, segments, { from: exist.start, to: exist.end });
      if (re.lines.length === 0) return { ok: false, reason: "文字稿没有落在那张字幕卡的时段里" };
      actions.setClipParams(exist.id, { lines: formatCaptions(re.lines) });
      return { ok: true, clipId: exist.id, count: re.lines.length };
    }
    const clip = actions.addCardClip(CAPTION_CARD_ID, plan.from, {
      duration: plan.to - plan.from,
      trackId: track.id,
      params: { lines: formatCaptions(plan.lines), showEn: "false" },
    });
    if (!clip) return { ok: false, reason: "建字幕卡失败" };
    return { ok: true, clipId: clip.id, count: plan.lines.length };
  },
  /**
   * 改字幕卡里的一条字幕(挪位置、修边、改文字)。
   *
   * 字幕存在卡片的 lines 参数里(`起|止|中|英` 一行一条),所以这三个动作都是
   * 「解析 → 在 kernel/captions 里算 → 写回同一个字符串」。时间会被夹在左右邻居之间,
   * 不会拖出一条压着别人的字幕。返回改完之后它排到第几位,-1 = 没改成。
   */
  editCaption(clipId: string, index: number, patch: { start?: number; end?: number; zh?: string; en?: string }): number {
    const hit = findClip(state.project, clipId);
    if (!hit || !isCaptionClip(hit.clip)) return -1;
    const lines = captionsOf(hit.clip);
    const res = editCaptionLine(lines, index, patch, hit.clip.end - hit.clip.start);
    if (res.index < 0) return -1;
    actions.setClipParams(clipId, { lines: formatCaptions(res.lines) });
    return res.index;
  },
  /** 删掉一条字幕 */
  removeCaption(clipId: string, index: number): boolean {
    const hit = findClip(state.project, clipId);
    if (!hit || !isCaptionClip(hit.clip)) return false;
    const lines = captionsOf(hit.clip);
    if (index < 0 || index >= lines.length) return false;
    actions.setClipParams(clipId, { lines: formatCaptions(removeCaptionLine(lines, index)) });
    return true;
  },
  /** 在字幕卡里插一条(start 是相对卡片起点的秒);挤不下返回 -1 */
  addCaption(clipId: string, at: { start: number; end?: number; zh?: string; en?: string }): number {
    const hit = findClip(state.project, clipId);
    if (!hit || !isCaptionClip(hit.clip)) return -1;
    const res = insertCaption(captionsOf(hit.clip), at, hit.clip.end - hit.clip.start);
    if (res.index < 0) return -1;
    actions.setClipParams(clipId, { lines: formatCaptions(res.lines) });
    return res.index;
  },
  /** 换卡片类型(保留时段)。keepParams 为 true 时,保留新卡也有的同名参数。 */
  /**
   * 组合卡的部件实例树:整棵替换。树的增删改移在 kernel/parts.ts 里算好(纯函数、已校验),这里只负责存。
   * 空数组 = 清掉字段。
   */
  setClipParts(clipId: string, parts: PartInstance[]) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!parts.length) {
          const { parts: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, parts };
      }),
    })));
    return true;
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
    setProject(next);
    set({ selection: state.selection.filter((id) => id !== clipId) });
  },
  duplicateClip(clipId: string): TrackClip | null {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return null;
    const len = hit.clip.end - hit.clip.start;
    let clip: TrackClip = { ...hit.clip, id: newId("c"), start: hit.clip.end, end: hit.clip.end + len, ...(hit.clip.parts ? { parts: JSON.parse(JSON.stringify(hit.clip.parts)) } : {}) };
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
    // 切开会凭空多出一段,转场两头就对不上了 —— 先删转场
    if (timingLock(p, clipId)) return null;
    const left: TrackClip = { ...hit.clip, end: t };
    const right: TrackClip = { ...hit.clip, id: newId("c"), start: t, mediaOffset: (hit.clip.mediaOffset ?? 0) + (t - hit.clip.start), ...(hit.clip.parts ? { parts: JSON.parse(JSON.stringify(hit.clip.parts)) } : {}) };
    setProject(updateTrack(p, hit.track.id, (t2) => ({ ...t2, clips: sortClips([...t2.clips.filter((c) => c.id !== clipId), left, right]) })));
    return right;
  },

  /* ---------- 素材 ---------- */

  /**
   * 「创建为声音」:给一段视频派生出只有声音的那一份素材(素材库里多一条,进配乐页)。
   * 同一段视频只派生一份,再调返回的是同一条。图片没有声音;本来就是声音的原样返回。
   */
  separateAudio(clipId: string) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return { ok: false, error: "找不到视频片段" };
    if (hit.track.locked) return { ok: false, error: "请先解锁序列" };
    const src = p.media.find((m) => m.id === hit.clip.mediaId);
    if (!src || src.kind !== "video") return { ok: false, error: "只能分离视频片段的音频" };
    if (hit.clip.audioMuted) return { ok: false, error: "此视频已静音或已分离音频" };
    const media = findSoundAsset(p, src.id) ?? soundAssetFrom(src, newId("m"));
    const audio: TrackClip = {
      id: newId("c"), cardId: "", mediaId: media.id, params: {}, label: media.name,
      start: hit.clip.start, end: hit.clip.end, mediaOffset: hit.clip.mediaOffset,
      opacity: hit.clip.opacity, fadeIn: hit.clip.fadeIn, fadeOut: hit.clip.fadeOut,
    };
    const track: Track = { id: newId("t"), name: media.name, muted: hit.track.muted, hidden: hit.track.hidden, clips: [audio] };
    const tracks = p.tracks.map((t) => t.id === hit.track.id
      ? { ...t, clips: t.clips.map((c) => c.id === clipId ? { ...c, audioMuted: true } : c) } : t);
    tracks.splice(p.tracks.indexOf(hit.track) + 1, 0, track);
    setProject({ ...p, tracks, media: p.media.includes(media) ? p.media : [...p.media, media] });
    return { ok: true, clipId, audioClipId: audio.id, trackId: track.id, mediaId: media.id };
  },

  audioFromVideo(mediaId: string): { ok: true; media: MediaAsset; created: boolean } | { ok: false; error: string } {
    const p = state.project;
    const src = p.media.find((m) => m.id === mediaId);
    if (!src) return { ok: false, error: `找不到素材 ${mediaId}` };
    if (src.kind === "image") return { ok: false, error: `「${src.name}」是图片,没有声音` };
    if (src.kind === "audio") return { ok: true, media: src, created: false };
    const had = findSoundAsset(p, mediaId);
    if (had) return { ok: true, media: had, created: false };
    const media = soundAssetFrom(src, newId("m"));
    // 素材库的增删和 addMedia 一样不进撤销栈:撤销管的是时间轴,不是素材柜
    setProject({ ...p, media: [...p.media, media] }, { undoable: false });
    return { ok: true, media, created: true };
  },

  /**
   * 把时间轴上的一段视频**就地**转成声音:画面没了,声音照旧(位置、长度、素材内偏移、
   * 淡入淡出全部保留)。素材库里同时会多出那份声音素材,以后能直接再拖。
   */
  convertClipToAudio(clipId: string): { ok: true; mediaId: string; created: boolean; already?: boolean } | { ok: false; error: string } {
    const hit = findClip(state.project, clipId);
    if (!hit) return { ok: false, error: `找不到片段 ${clipId}` };
    if (!hit.clip.mediaId) return { ok: false, error: "这段是卡片,不是素材,没有声音可转" };
    const r = actions.audioFromVideo(hit.clip.mediaId);
    if (!r.ok) return r;
    if (r.media.id === hit.clip.mediaId) return { ok: true, mediaId: r.media.id, created: false, already: true };
    const p = state.project; // audioFromVideo 已经写过一次,这里要拿新的
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      // 名字也跟着换:时间轴上还挂着「访谈.mp4」会让人以为画面还在
      clips: t.clips.map((c) => (c.id === clipId ? { ...c, mediaId: r.media.id, label: r.media.name } : c)),
    })));
    return { ok: true, mediaId: r.media.id, created: r.created };
  },
  addMedia(asset: Omit<MediaAsset, "id"> & { id?: string }): MediaAsset {
    const m: MediaAsset = { ...asset, id: asset.id ?? newId("m") };
    setProject({ ...state.project, media: [...state.project.media, m] }, { undoable: false });
    return m;
  },
  /** 写入 / 清除素材的语音转文字结果(不进撤销栈) */
  setMediaShots(mediaId: string, shots: Shots | null) {
    const p = state.project;
    setProject(
      { ...p, media: p.media.map((m) => (m.id === mediaId ? { ...m, shots: shots ?? undefined } : m)) },
      { undoable: false },
    );
  },
  /** 写入 / 清除素材的主体检测结果(不进撤销栈,和镜头识别同一个道理) */
  setMediaSubjects(mediaId: string, subjects: Subjects | null) {
    const p = state.project;
    // 素材可能在检测跑完之前就被删了。不查一下的话 map 空转一圈、
    // setProject 白发一次通知,还会把「素材已经不在了」这件事藏起来。
    if (!p.media.some((m) => m.id === mediaId)) return;
    setProject(
      { ...p, media: p.media.map((m) => (m.id === mediaId ? { ...m, subjects: subjects ?? undefined } : m)) },
      { undoable: false },
    );
  },
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
    // 素材是项目级的:激活剪辑和停放剪辑里引用它的段都要清,不然切过去会出现指向已删素材的段
    setProject(stripMediaFromCuts({
      ...p,
      media: p.media.filter((m) => m.id !== mediaId),
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.mediaId !== mediaId) })),
    }, mediaId));
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
