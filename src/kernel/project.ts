import type { Clip, Timeline } from "./types";

/**
 * 项目文档模型(多轨)。这是编辑器、时间轴、左右栏、MCP 工具、导入导出共用的唯一真源。
 * 保存到磁盘的 .promptcut.json 就是 Project 的 JSON。
 */

export interface MediaAsset {
  id: string;
  kind: "video" | "audio" | "image";
  name: string;
  /** 浏览器里可播的 URL(blob: 或 /media/xxx);保存项目时存相对路径 */
  url: string;
  duration?: number; // 秒
  width?: number;
  height?: number;
}

export type TrackKind = "overlay" | "video";

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  hidden?: boolean;
  locked?: boolean;
  /** 同一轨内 clip 不重叠,按 start 排序 */
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
      { id: "t-video", name: "视频", kind: "video", clips: [] },
      { id: "t-1", name: "动效 1", kind: "overlay", clips: [] },
    ],
  };
}

/**
 * 把多轨项目压平成 Stage 需要的 Timeline(只含 overlay 轨、跳过 hidden 轨)。
 * 轨道顺序 = 叠放顺序:tracks 数组靠后的轨画在上面。
 */
export function flattenOverlay(p: Project): Timeline {
  const clips: Clip[] = [];
  for (const tr of p.tracks) {
    if (tr.kind !== "overlay" || tr.hidden) continue;
    for (const c of tr.clips) clips.push({ id: c.id, cardId: c.cardId, start: c.start, end: c.end, params: c.params });
  }
  return { width: p.width, height: p.height, fps: p.fps, duration: p.duration, clips };
}

/** 某时刻视频轨上该播哪一段(第一条命中的 video 轨) */
export function videoClipAt(p: Project, t: number): { clip: TrackClip; media: MediaAsset } | null {
  for (const tr of p.tracks) {
    if (tr.kind !== "video" || tr.hidden) continue;
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
