/**
 * 底部时间轴:多条序列、clip 拖动/缩放/跨序列、播放头、吸附、右键菜单、接收左栏拖来的卡片和媒体。
 * 序列不分种类:同一条序列里卡片段和素材段都能放,叠放顺序看序列先后。
 */
import { useStore, actions, getState } from "../../store/project";
import { TimelineProvider, useTimelineContext } from "./TimelineContext";
import { TrackHeader } from "./TrackHeader";
import { xOfTime } from "./utils";
import { TrackRow } from "./TrackRow";
import { Ruler } from "./Ruler";
import { RangeBar, RANGE_H } from "./RangeBar";
import { InsertZones } from "./InsertZones";
import { NewTrackZone } from "./NewTrackZone";
import { Playhead } from "./Playhead";
import "./timeline.css";

// 仅供调试和自动化测试使用，不是正式接口
if (typeof window !== "undefined") {
  (window as any).__pcStore = { getState, actions };
}

function TimelineInner() {
  const tracks = useStore((s) => s.project.tracks);
  const duration = useStore((s) => s.project.duration);
  const { scrollRef, trackAreaRef, pxPerSec, setDropPlan } = useTimelineContext();
  const t = useStore(s => s.t);
  
  // 内容层从 MIN_TIME 起算(0 秒前面那段间距也要占宽度),右边再留一截好拖
  const contentWidth = xOfTime(Math.max(duration, t + 5), pxPerSec) + 200;

  return (
    <div className="flex flex-col h-full bg-neutral-900 border-t border-neutral-800 text-neutral-300 select-none overflow-hidden text-sm relative">
      <div className="flex-1 flex min-h-0 overflow-auto" ref={scrollRef}>
        
        {/* Left Headers Column */}
        <div className="w-[200px] flex-shrink-0 border-r border-neutral-800 sticky left-0 bg-neutral-900 z-30 flex flex-col shadow-[4px_0_12px_rgba(0,0,0,0.5)]">
          <div className="flex-shrink-0 sticky top-0 z-40 bg-neutral-950" style={{ height: RANGE_H }} />
          <div
            className="h-8 flex-shrink-0 sticky bg-neutral-950 border-b border-neutral-800 z-40 flex items-center justify-between px-2"
            style={{ top: RANGE_H }}
          >
            <span className="text-xs font-bold text-neutral-500">序列</span>
          </div>
          <div className="flex-1 flex flex-col">
            {tracks.map((track, i) => (
              <TrackHeader key={track.id} track={track} index={i} />
            ))}
            <div className="p-2 mt-2">
              <button
                onClick={() => actions.addTrack()}
                className="w-full bg-neutral-800 hover:bg-neutral-700 py-1.5 rounded border border-neutral-700 text-xs font-medium"
              >
                ＋ 序列
              </button>
            </div>
          </div>
        </div>

        {/* Tracks Area */}
        <div className="flex-1 relative flex flex-col" ref={trackAreaRef} style={{ minWidth: contentWidth }}>
          <div className="flex-shrink-0 sticky top-0 z-20" style={{ height: RANGE_H }}>
            <RangeBar />
          </div>
          <div className="h-8 flex-shrink-0 sticky bg-neutral-950 border-b border-neutral-800 z-20" style={{ top: RANGE_H }}>
            <Ruler />
          </div>
          <div
            className="flex-1 relative"
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setDropPlan(null);
            }}
          >
            {tracks.map((track, i) => (
              <TrackRow key={track.id} track={track} index={i} />
            ))}
            <NewTrackZone />
            <InsertZones />
          </div>
          <Playhead top={RANGE_H} />
        </div>

      </div>
    </div>
  );
}

export function TimelineView() {
  return (
    <TimelineProvider>
      <TimelineInner />
    </TimelineProvider>
  );
}
