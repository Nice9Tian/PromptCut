import { useStore } from "../../store/project";
import { useDragPayload } from "../dnd";
import { useTimelineContext } from "./TimelineContext";
import { DropGhost } from "./DropGhost";
import { TRACK_H, xOfTime } from "./utils";
import { useDropTarget } from "./useDropTarget";

/**
 * 最下面那条常驻的「新建序列落区」:把卡片或素材拖到这里松手 = 自动新建一条序列,
 * 片段就落在松手的那个时间点上。没在拖的时候它只是一行提示。
 */
export function NewTrackZone() {
  const trackCount = useStore((s) => s.project.tracks.length);
  const payload = useDragPayload();
  const { pxPerSec } = useTimelineContext();
  const { onDragOver, onDragLeave, onDrop, plan } = useDropTarget({ newTrackIndex: trackCount });

  const tone = plan
    ? "border-sky-400 bg-sky-400/10"
    : payload
      ? "border-neutral-500 bg-neutral-800/40"
      : "border-neutral-800 bg-transparent";

  return (
    <div
      data-pc="new-track-zone"
      className={`relative my-1 rounded border border-dashed transition-colors ${tone}`}
      style={{ height: TRACK_H - 8 }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {!plan && (
        <div
          className="absolute inset-y-0 flex items-center text-[11px] text-neutral-500 pointer-events-none"
          style={{ left: xOfTime(0, pxPerSec) }}
        >
          {payload ? "松手 = 新建一条序列,片段落在这个时间点" : "把卡片 / 素材拖到这里 = 新建一条序列"}
        </div>
      )}
      {plan && <DropGhost plan={plan} />}
    </div>
  );
}
