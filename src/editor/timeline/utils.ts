import { Project, Track } from "../../kernel/project";

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
