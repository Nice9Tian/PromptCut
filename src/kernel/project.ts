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

export interface MediaAsset {
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
      clips.push({ id: c.id, cardId: c.cardId, start: c.start, end: c.end, params: c.params });
    }
  }
  return { width: p.width, height: p.height, fps: p.fps, duration: p.duration, clips };
}

/** 某时刻该播哪一段素材(按序列顺序找第一条命中的素材段) */
export function videoClipAt(p: Project, t: number): { clip: TrackClip; media: MediaAsset } | null {
  for (const tr of p.tracks) {
    if (tr.hidden) continue;
    const c = tr.clips.find((c) => t >= c.start && t < c.end && c.mediaId);
    if (c) {
      const media = p.media.find((m) => m.id === c.mediaId);
      if (media) return { clip: c, media };
    }
  }
  return null;
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
