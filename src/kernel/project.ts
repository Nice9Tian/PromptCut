import type { Clip, Timeline } from "./types";

/**
 * 项目文档模型(多轨)。这是编辑器、时间轴、左右栏、MCP 工具、导入导出共用的唯一真源。
 * 保存到磁盘的 .promptcut.json 就是 Project 的 JSON。
 */

/** 语音转文字的一段 */
export interface TranscriptSegment {
  start: number; // 秒(素材内时间)
  end: number;
  text: string;
}

export interface Transcript {
  engine: string; // "faster-whisper" | "whisper"
  model: string;
  language?: string;
  createdAt: string; // ISO
  segments: TranscriptSegment[];
}

export type TransitionKind = "cut" | "dissolve";

/** 一次转场。硬切的 start/end 几乎相等；溶解是整段渐变的起止 */
export interface ShotTransition {
  kind: TransitionKind;
  start: number;
  end: number;
  /** 置信度最高的那一帧的时间，画标记时对准它 */
  time: number;
  confidence: number;
  /** 缩略图文件名。溶解有两张（渐变前后各一），时间轴上叠着画 */
  thumbs?: string[];
}

/** 镜头划分结果，由镜头识别工具写入 */
export interface Shots {
  /** transnetv2 认得溶解；scdet 是没装拓展时的兜底，只认硬切 */
  engine: "transnetv2" | "scdet";
  createdAt: string;
  transitions: ShotTransition[];
  shots: { start: number; end: number; inTransition: TransitionKind | null; outTransition: TransitionKind | null }[];
}

export interface MediaAsset {
  /** 镜头切换识别结果(可选,由 detect_shots 写入) */
  shots?: Shots;
  /** 语音转文字结果(可选,由 STT 工具写入) */
  transcript?: Transcript;
  id: string;
  kind: "video" | "audio" | "image";
  name: string;
  /** 浏览器里可播的 URL(blob: 或 /media/xxx);保存项目时存相对路径 */
  url: string;
  /** 服务端可读的绝对磁盘路径，由导入时上传得到，可能不存在 */
  path?: string;
  duration?: number; // 秒
  width?: number;
  height?: number;
}

/**
 * 序列(以前分「动效轨 / 视频轨」两种,现在不分了):
 * 一条序列里既能放卡片段(cardId),也能放素材段(mediaId),不重叠、按 start 排序。
 * 叠放顺序看数组:靠后的画在上面。旧项目文件里的 kind 字段读进来就忽略掉。
 */
export interface Track {
  id: string;
  name: string;
  hidden?: boolean;
  locked?: boolean;
  /** 同一条序列内 clip 不重叠,按 start 排序 */
  clips: TrackClip[];
}

/** 轨道上的一段。overlay 轨用 cardId+params;video 轨用 mediaId(+ 素材内偏移)。 */
export interface TrackClip extends Clip {
  mediaId?: string;
  /** 视频段从素材的第几秒开始播(默认 0) */
  mediaOffset?: number;
  label?: string;
  /**
   * 淡入 / 淡出时长(秒)。两段素材在时间上重叠、各自带上淡出淡入,就是交叉溶解——
   * 转场不是独立的对象,而是「重叠 + 淡化」的结果,所以不用往模型里塞 transition 类型。
   * 同一条序列内不允许重叠,所以交叉溶解必然发生在两条序列之间。
   */
  fadeIn?: number;
  fadeOut?: number;
  /** 整体不透明度(0-1,默认 1)。音频段用它当音量。 */
  opacity?: number;
}

export interface Project {
  version: 1;
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number; // 秒
  themeId: string;
  media: MediaAsset[];
  tracks: Track[];
}

/** 新拖上时间轴的卡片默认时长(秒);落点预览和真正落卡用的是同一个值 */
export const DEFAULT_CARD_DUR = 3;

/** 素材没有时长信息时,视频段的兜底时长(秒) */
export const DEFAULT_MEDIA_DUR = 5;

export function createEmptyProject(name = "未命名"): Project {
  return {
    version: 1,
    name,
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 30,
    themeId: "midnight",
    media: [],
    tracks: [
      { id: "t-1", name: "序列 1", clips: [] },
      { id: "t-2", name: "序列 2", clips: [] },
    ],
  };
}

/**
 * 把项目压平成 Stage 需要的 Timeline(所有序列里的卡片段,跳过 hidden 的序列)。
 * 序列顺序 = 叠放顺序:tracks 数组靠后的画在上面。素材段(有 mediaId)不进舞台,走视频层。
 */
export function flattenOverlay(p: Project): Timeline {
  const clips: Clip[] = [];
  for (const tr of p.tracks) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (!c.cardId) continue; // 素材段交给视频层
      // motion 必须带过来:它是**播放时**才用得上的东西,漏在这里的话
      // 绑定看起来存下了、时间轴上也显示绑了,可预览和导出都一动不动。
      clips.push({
        id: c.id, cardId: c.cardId, start: c.start, end: c.end, params: c.params,
        ...(c.motion ? { motion: c.motion } : null),
      });
    }
  }
  return { width: p.width, height: p.height, fps: p.fps, duration: p.duration, clips };
}

/** 某时刻该播哪一段素材(按序列顺序找第一条命中的素材段) */
/** 片段在 t 时刻的不透明度:淡入淡出算进去。超出区间返回 0。 */
export function opacityAt(clip: TrackClip, t: number): number {
  if (t < clip.start || t >= clip.end) return 0;
  let a = clip.opacity ?? 1;
  const fin = clip.fadeIn ?? 0;
  const fout = clip.fadeOut ?? 0;
  if (fin > 0 && t < clip.start + fin) a *= (t - clip.start) / fin;
  if (fout > 0 && t > clip.end - fout) a *= (clip.end - t) / fout;
  return Math.max(0, Math.min(1, a));
}

/**
 * 某时刻画面上的所有素材层,按序列顺序排(数组靠后 = 画在上面),带算好的不透明度。
 * 两段重叠且各自带淡化时,这里会同时返回它们 —— 交叉溶解就是这么来的。
 * 音频段不在其中(它们走 audioClipsAt)。
 */
export function videoLayersAt(
  p: Project,
  t: number,
): Array<{ clip: TrackClip; media: MediaAsset; opacity: number }> {
  const layers: Array<{ clip: TrackClip; media: MediaAsset; opacity: number }> = [];
  for (const tr of p.tracks) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (!c.mediaId || t < c.start || t >= c.end) continue;
      const media = p.media.find((m) => m.id === c.mediaId);
      if (!media || media.kind === "audio") continue;
      const opacity = opacityAt(c, t);
      if (opacity <= 0) continue;
      layers.push({ clip: c, media, opacity });
    }
  }
  return layers;
}

/** 某时刻该出声的所有音频段(opacity 当音量用) */
export function audioClipsAt(
  p: Project,
  t: number,
): Array<{ clip: TrackClip; media: MediaAsset; volume: number }> {
  const out: Array<{ clip: TrackClip; media: MediaAsset; volume: number }> = [];
  for (const tr of p.tracks) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (!c.mediaId || t < c.start || t >= c.end) continue;
      const media = p.media.find((m) => m.id === c.mediaId);
      if (!media || media.kind !== "audio") continue;
      out.push({ clip: c, media, volume: opacityAt(c, t) });
    }
  }
  return out;
}

/**
 * 某时刻最上面那一层画面。只认视频/图片——以前它把音频段也当画面返回,
 * 拖一首曲子进序列就会让 <video> 去 seek 一个 mp3。
 */
export function videoClipAt(p: Project, t: number): { clip: TrackClip; media: MediaAsset } | null {
  const layers = videoLayersAt(p, t);
  if (layers.length === 0) return null;
  const top = layers[layers.length - 1];
  return { clip: top.clip, media: top.media };
}

export function findClip(p: Project, clipId: string): { track: Track; clip: TrackClip; index: number } | null {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}

let seq = 0;
export function newId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}
