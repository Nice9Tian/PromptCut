import { useTimelineContext } from "./TimelineContext";
import { useStore } from "../../store/project";
import { useScrub } from "./useScrub";
import { xOfTime } from "./utils";

export function Ruler() {
  const { pxPerSec } = useTimelineContext();
  const duration = useStore((s) => Math.max(s.project.duration, s.t + 10));
  const startScrub = useScrub();

  const ticks = [];
  // dynamically choose tick interval based on pxPerSec
  let step = 1;
  if (pxPerSec < 20) step = 5;
  if (pxPerSec < 10) step = 10;
  if (pxPerSec > 200) step = 0.5;
  if (pxPerSec > 400) step = 0.1;

  for (let i = 0; i <= duration; i += step) {
    ticks.push(Math.round(i * 1000) / 1000);
  }

  return (
    <div
      data-pc="ruler"
      className="relative h-8 bg-neutral-900 border-b border-neutral-800 cursor-ew-resize overflow-hidden select-none touch-none"
      // 按下即定位,按住可以一路拖(以前只有 onClick,拖不动)
      onPointerDown={(e) => startScrub(e, { jumpToPointer: true })}
      title="按住拖动 = 移动播放头(按 Alt 不吸附)"
    >
      {ticks.map((tick) => {
        const isMajor = Math.abs(tick % Math.max(1, step * 5)) < 1e-6 || tick === 0;
        return (
          <div
            key={tick}
            className="absolute top-0 flex flex-col items-center pointer-events-none"
            style={{ left: `${xOfTime(tick, pxPerSec)}px`, transform: "translateX(-50%)" }}
          >
            <div className={`w-[1px] bg-neutral-600 ${isMajor ? "h-3" : "h-2"}`} />
            {isMajor && <span className="text-[10px] text-neutral-400 mt-1">{tick}s</span>}
          </div>
        );
      })}
    </div>
  );
}
