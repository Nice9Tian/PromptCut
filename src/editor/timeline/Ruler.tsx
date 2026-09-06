import { useTimelineContext } from "./TimelineContext";
import { useStore } from "../../store/project";
import { useScrub } from "./useScrub";
import { xOfTime } from "./utils";

/**
 * 时间标尺(配色诊断与修正 v2 整屏):26 高,主刻度每 5 格一条 L4 竖线并标秒数,
 * 次刻度 L3 竖线。数字用次文字色,不再是弱文字——它是读时间用的。
 */
export function Ruler() {
  const { pxPerSec } = useTimelineContext();
  const duration = useStore((s) => Math.max(s.project.duration, s.t + 10));
  const startScrub = useScrub();

  let step = 1;
  if (pxPerSec < 10) step = 10;
  else if (pxPerSec < 20) step = 5;
  else if (pxPerSec <= 200) step = 1;
  else if (pxPerSec <= 400) step = 0.5;
  else step = 0.1;

  // 防止 duration 被内容撑得极大(几万秒)生成数万个刻度节点卡死页面:超 1200 个就往上一档跳
  while (duration / step > 1200) {
    if (step === 1) step = 2;
    else if (step === 2) step = 5;
    else if (step === 5) step = 10;
    else if (step === 10) step = 30;
    else if (step === 30) step = 60;
    else step *= 2;
  }

  const ticks: number[] = [];
  for (let i = 0; i <= duration; i += step) ticks.push(Math.round(i * 1000) / 1000);

  return (
    <div
      data-pc="ruler"
      className="pc-tl-ruler relative cursor-ew-resize overflow-hidden select-none touch-none"
      onPointerDown={(e) => startScrub(e, { jumpToPointer: true })}
      title="按住拖动 = 移动播放头(按 Alt 不吸附)"
    >
      {ticks.map((tick) => {
        const isMajor = Math.abs(tick % Math.max(1, step * 5)) < 1e-6 || tick === 0;
        return (
          <div
            key={tick}
            className="absolute bottom-0 flex flex-col items-start pointer-events-none"
            style={{ left: `${xOfTime(tick, pxPerSec)}px`, height: isMajor ? "100%" : "40%" }}
          >
            <div className={`pc-tl-tick flex-1${isMajor ? " is-major" : ""}`} />
            {isMajor && (
              <span className="pc-tl-tick-label absolute" style={{ left: 5, bottom: 5 }}>
                {tick}s
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
