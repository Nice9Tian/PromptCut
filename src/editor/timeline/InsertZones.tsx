import { useStore } from "../../store/project";
import { useDragPayload } from "../dnd";
import { useTimelineContext } from "./TimelineContext";
import { TRACK_H, xOfTime } from "./utils";
import { useDropTarget } from "./useDropTarget";

/**
 * 序列之间的插入缝:拖着卡片 / 素材经过两条序列中间时出现一条蓝线,松手就在那个位置插一条新序列。
 * 只在拖动过程中存在,平时不挡片段的点击和拖动。
 */
export function InsertZones() {
  const tracks = useStore((s) => s.project.tracks);
  const payload = useDragPayload();
  if (!payload) return null;
  return (
    <>
      {tracks.map((t, i) => (
        <InsertZone key={t.id} index={i} />
      ))}
    </>
  );
}

function InsertZone({ index }: { index: number }) {
  const { pxPerSec } = useTimelineContext();
  const { onDragOver, onDragLeave, onDrop, plan } = useDropTarget({ newTrackIndex: index });

  return (
    <div
      data-pc-insert={index}
      className="absolute inset-x-0 z-40"
      style={{ top: Math.max(0, index * TRACK_H - 5), height: 10 }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {plan && (
        <>
          <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-sky-400 pointer-events-none" />
          <div
            className="absolute top-1/2 z-50 flex h-5 -translate-y-1/2 items-center whitespace-nowrap rounded bg-sky-500 px-1.5 text-[10px] text-white pointer-events-none"
            style={{ left: `${xOfTime(plan.start, pxPerSec)}px` }}
          >
            {plan.label} · 新建序列
          </div>
        </>
      )}
    </div>
  );
}
