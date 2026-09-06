import { useTimelineContext } from "./TimelineContext";
import { useStore } from "../../store/project";
import { useScrub } from "./useScrub";
import { xOfTime } from "./utils";

/**
 * 播放头。竖线从卡尺一直贯到最后一条轨,抓手(三角)落在卡尺里,
 * 所以卡尺和竖线之间没有拖不动的空档:卡尺上按下能拖,竖线上按下也能拖。
 */
export function Playhead({ top = 0 }: { top?: number }) {
  const t = useStore((s) => s.t);
  const { pxPerSec } = useTimelineContext();
  const startScrub = useScrub();

  return (
    <div
      data-pc="playhead"
      className="absolute bottom-0 z-40 flex justify-center cursor-ew-resize w-[11px] touch-none"
      style={{ left: `${xOfTime(t, pxPerSec)}px`, top, transform: "translateX(-50%)" }}
      onPointerDown={(e) => startScrub(e, { jumpToPointer: false })}
      title="拖动 = 移动播放头(按 Alt 不吸附)"
    >
      <div className="absolute top-0 bottom-0 w-[1px] bg-red-500 pointer-events-none" />
      {/* 抓手:卡尺那一格里的三角,拖它最顺手 */}
      <div
        className="clip-playhead absolute top-0 w-[11px] h-4 bg-red-500 pointer-events-none"
        style={{ clipPath: "polygon(0 0, 100% 0, 50% 100%)" }}
      />
    </div>
  );
}
