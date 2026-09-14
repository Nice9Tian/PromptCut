import { useTimelineContext } from "./TimelineContext";
import { useStore } from "../../store/project";
import { useScrub } from "./useScrub";
import { xOfTime } from "./utils";

/** 播放头上的时间标签:0:00.0 这种「分:秒.十分之一秒」,读起来比纯秒数快 */
function stamp(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/**
 * 播放头:2px 主文字色竖线贯穿所有轨,卡尺里一个圆形把手,顶上一枚圆角胶囊时间标签。
 * 线和把手的颜色走 --ui-fg(skins.css 映射),把手的圆形和标签胶囊在 timeline.css。
 */
export function Playhead({ top = 0 }: { top?: number }) {
  const t = useStore((s) => s.t);
  const { pxPerSec } = useTimelineContext();
  const startScrub = useScrub();

  return (
    <div
      data-pc="playhead"
      // z 必须低于左侧序列栏(那一栏是 sticky z-30)。原来是 z-40,横向滚动时
      // 播放头会画到贴住左边的序列栏上面去,红线和时间气泡直接穿过行头。
      // z-20 仍然高于轨道行(auto),也因为在 DOM 里排在标尺之后而盖得住标尺。
      className="absolute bottom-0 z-20 flex justify-center cursor-ew-resize w-[11px] touch-none"
      style={{ left: `${xOfTime(t, pxPerSec)}px`, top, transform: "translateX(-50%)" }}
      onPointerDown={(e) => startScrub(e, { jumpToPointer: false })}
      title="拖动 = 移动播放头(按 Alt 不吸附)"
    >
      <div className="absolute top-0 bottom-0 w-[2px] bg-white pointer-events-none" />
      {/* 抓手:卡尺那一格里的圆形把手,拖它最顺手;圆形由 timeline.css 的 .clip-playhead 画 */}
      <div className="clip-playhead absolute top-[14px] w-[12px] h-[12px] bg-white pointer-events-none" />
      <span className="pc-tl-playhead-label">{stamp(t)}</span>
    </div>
  );
}
