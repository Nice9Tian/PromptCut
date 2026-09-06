import type { Project } from "../../kernel/project";
import { planPlacement } from "../../store/project";
import { formatTime, snapTime } from "./utils";
import { type DragPayload } from "../dnd";

/**
 * 「这一拖会落成什么样」的完整描述。dragover 时算一次画成落点预览,drop 时再算一次照着落。
 * 两次用的是同一个函数,所以看到的和落下的一定一致。
 */
export interface DropPlan {
  /** 落在已有序列 = 序列 id;落在新序列 = null(看 newTrackIndex) */
  trackId: string | null;
  /** 新序列插在 tracks 数组的第几位(落在已有序列时为 null) */
  newTrackIndex: number | null;
  start: number;
  end: number;
  /** ok = 原位落下;shift = 原位被占,顺延到后面的空档;forbidden = 落不下 */
  status: "ok" | "shift" | "forbidden";
  /** 落点预览上显示的一行说明 */
  hint: string;
  /** 落点预览上显示的名字 */
  label: string;
}

export type DropTarget = { trackId: string } | { newTrackIndex: number };

export function planDrop(
  project: Project,
  payload: DragPayload,
  target: DropTarget,
  rawSec: number,
  opts: { altKey: boolean; pxPerSec: number; t: number },
): DropPlan {
  const dur = Math.max(0.1, payload.duration);
  const start = Math.max(0, snapTime(rawSec, opts.altKey, project, opts.t, undefined, opts.pxPerSec));
  const base = { label: payload.name, trackId: null as string | null, newTrackIndex: null as number | null };

  if ("newTrackIndex" in target) {
    return {
      ...base,
      newTrackIndex: target.newTrackIndex,
      start,
      end: start + dur,
      status: "ok",
      hint: "松手 = 新建一条序列",
    };
  }

  const track = project.tracks.find((t) => t.id === target.trackId);
  if (!track) {
    return { ...base, start, end: start + dur, status: "forbidden", hint: "找不到这条序列" };
  }
  if (track.locked) {
    return { ...base, trackId: track.id, start, end: start + dur, status: "forbidden", hint: "序列已锁定" };
  }

  const placed = planPlacement(track, start, dur);
  return {
    ...base,
    trackId: track.id,
    start: placed.start,
    end: placed.end,
    status: placed.shifted ? "shift" : "ok",
    hint: placed.shifted ? `这里被占用,顺延到 ${formatTime(placed.start)}` : formatTime(placed.start),
  };
}
