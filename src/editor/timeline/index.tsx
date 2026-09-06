/**
 * 底部时间轴:多轨、clip 拖动/缩放/跨轨、播放头、吸附、右键菜单、接收左栏拖来的卡片和媒体。
 */
import { useStore, actions, getState } from "../../store/project";
import { TimelineProvider, useTimelineContext } from "./TimelineContext";
import { TrackHeader } from "./TrackHeader";
import { TrackRow } from "./TrackRow";
import { Ruler } from "./Ruler";
import { Playhead } from "./Playhead";
import "./timeline.css";

// 仅供调试和自动化测试使用，不是正式接口
if (typeof window !== "undefined") {
  (window as any).__pcStore = { getState, actions };
}

function TimelineInner() {
  const tracks = useStore((s) => s.project.tracks);
  const duration = useStore((s) => s.project.duration);
  const { scrollRef, trackAreaRef, pxPerSec } = useTimelineContext();
  const t = useStore(s => s.t);
  
  const contentWidth = Math.max(duration, t + 5) * pxPerSec + 200; // Extra padding

  return (
    <div className="flex flex-col h-full bg-neutral-900 border-t border-neutral-800 text-neutral-300 select-none overflow-hidden text-sm relative">
      <div className="flex-1 flex min-h-0 overflow-auto" ref={scrollRef}>
        
        {/* Left Headers Column */}
        <div className="w-[200px] flex-shrink-0 border-r border-neutral-800 sticky left-0 bg-neutral-900 z-30 flex flex-col shadow-[4px_0_12px_rgba(0,0,0,0.5)]">
          <div className="h-8 flex-shrink-0 sticky top-0 bg-neutral-950 border-b border-neutral-800 z-40 flex items-center justify-between px-2">
            <span className="text-xs font-bold text-neutral-500">轨道</span>
          </div>
          <div className="flex-1 flex flex-col">
            {tracks.map((track, i) => (
              <TrackHeader key={track.id} track={track} index={i} />
            ))}
            <div className="p-2 flex gap-2 mt-2">
              <button
                onClick={() => actions.addTrack("overlay")}
                className="flex-1 bg-neutral-800 hover:bg-neutral-700 py-1.5 rounded border border-neutral-700 text-xs font-medium"
              >
                + 动效轨
              </button>
              <button
                onClick={() => actions.addTrack("video")}
                className="flex-1 bg-neutral-800 hover:bg-neutral-700 py-1.5 rounded border border-neutral-700 text-xs font-medium"
              >
                + 视频轨
              </button>
            </div>
          </div>
        </div>

        {/* Tracks Area */}
        <div className="flex-1 relative flex flex-col" ref={trackAreaRef} style={{ minWidth: contentWidth }}>
          <div className="h-8 flex-shrink-0 sticky top-0 bg-neutral-950 border-b border-neutral-800 z-20">
            <Ruler />
          </div>
          <div className="flex-1 relative">
            {tracks.map((track) => (
              <TrackRow key={track.id} track={track} />
            ))}
            <Playhead />
          </div>
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
