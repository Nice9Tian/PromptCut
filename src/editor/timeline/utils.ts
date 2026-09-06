import { Project, Track } from "../../kernel/project";

/** 轨道行高(px)。轨道行、左侧行头、新建轨落区、插入缝都按它算,改这里就整体改。 */
export const TRACK_H = 40;

/** 左侧行头列宽(px) */
export const HEADER_W = 200;

/**
 * 0 秒前面留的一点间距(px,和缩放无关)。纯粹是留白,不代表时间——时间没有负数。
 * 有它 0 秒的片段和播放头才不会贴死在行头上。
 */
export const GUTTER_PX = 24;

/** 时间 ↔ 内容层像素。所有换算都走这两个函数,不要再直接乘 pxPerSec。 */
export function xOfTime(t: number, pxPerSec: number): number {
  return GUTTER_PX + t * pxPerSec;
}

export function timeOfX(x: number, pxPerSec: number): number {
  return (x - GUTTER_PX) / pxPerSec;
}

export function isOccupied(track: Track, clipId: string, start: number, end: number) {
  return track.clips.some(
    (c) => c.id !== clipId && Math.max(start, c.start) < Math.min(end, c.end)
  );
}

export function getGap(track: Track, clipId: string, projectDuration: number) {
  const others = track.clips.filter((c) => c.id !== clipId);
  const currentClip = track.clips.find(c => c.id === clipId);
  if (!currentClip) return { start: 0, end: projectDuration };
  
  let gapStart = 0;
  let gapEnd = projectDuration;
  
  for (const c of others) {
    if (c.end <= currentClip.start) gapStart = Math.max(gapStart, c.end);
    if (c.start >= currentClip.end) gapEnd = Math.min(gapEnd, c.start);
  }
  return { start: gapStart, end: gapEnd };
}

export function snapTime(
  time: number,
  altKey: boolean,
  project: Project,
  t: number,
  ignoreClipId?: string,
  pxPerSec: number = 100
) {
  if (altKey) return time;
  const threshold = 10 / pxPerSec; // snap within 10 pixels
  const snapPoints = [0, t];
  const maxSec = Math.max(project.duration, time + 10);
  for (let i = 1; i <= Math.ceil(maxSec); i++) snapPoints.push(i);
  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const c of track.clips) {
      if (c.id === ignoreClipId) continue;
      snapPoints.push(c.start, c.end);
    }
  }
  let best = time;
  let minDiff = threshold;
  for (const p of snapPoints) {
    const diff = Math.abs(p - time);
    if (diff < minDiff) {
      best = p;
      minDiff = diff;
    }
  }
  return best;
}

export function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
}
