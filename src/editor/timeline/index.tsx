/**
 * 底部时间轴:多条序列、clip 拖动/缩放/跨序列、播放头、吸附、右键菜单、接收左栏拖来的卡片和媒体。
 * 序列不分种类:同一条序列里卡片段和素材段都能放,叠放顺序看序列先后。
 */
import { useEffect } from "react";
import { useStore, actions, getState } from "../../store/project";
import { TimelineProvider, useTimelineContext } from "./TimelineContext";
import { TrackHeader } from "./TrackHeader";
import { xOfTime, HEADER_W_MIN, HEADER_W_MAX, TAIL_SLACK_PX, contentEndOf } from "./utils";
import { TrackRow } from "./TrackRow";
import { Ruler } from "./Ruler";
import { RangeBar, RANGE_H } from "./RangeBar";
import { InsertZones } from "./InsertZones";
import { NewTrackZone } from "./NewTrackZone";
import { Playhead } from "./Playhead";
import { Toolbar } from "./Toolbar";
import { CutTabs } from "./CutTabs";
import { Scrollbar } from "./Scrollbar";
import { ResizeHandle } from "../ResizeHandle";
import { IconPlus } from "../../ui/icons";
import "./timeline.css";

// 仅供调试和自动化测试使用，不是正式接口
if (typeof window !== "undefined") {
  (window as any).__pcStore = { getState, actions };
}

function TimelineInner() {
  const tracks = useStore((s) => s.project.tracks);
  const duration = useStore((s) => s.project.duration);
  const durationManual = useStore((s) => s.durationManual);
  const { scrollRef, trackAreaRef, pxPerSec, setDropPlan, headerW, setHeaderW, commitHeaderW, resetHeaderW } = useTimelineContext();
  const t = useStore(s => s.t);
  
  // 播放范围跟着可见内容走。
  //
  // 以前是只涨不跌(Math.max(duration, 内容末尾 + 余量)):删掉片段范围也不缩,
  // 新项目一开就是 30 秒,于是范围里总有一大截空的地方能播出黑屏,看起来还像
  // 有个「最短时长」的限制。现在改成:内容末尾就是范围的上界,手动拖短算截断
  // (允许),拖长会被夹回内容末尾。
  useEffect(() => {
    const contentEnd = contentEndOf(tracks);
    // 空项目没有内容可依,保留文档里那个值,不然时间轴会塌成 0 宽没法往里拖东西。
    const target = contentEnd <= 0
      ? duration
      : durationManual === null
        ? contentEnd
        : Math.min(durationManual, contentEnd);
    if (Math.abs(target - duration) > 1e-6) {
      actions.syncDuration(target);
    }
  }, [tracks, duration, durationManual]);

  // 内容层从 MIN_TIME 起算(0 秒前面那段间距也要占宽度),右边再留一截好拖
  const contentWidth = xOfTime(Math.max(duration, t + 5), pxPerSec) + TAIL_SLACK_PX;

  return (
    <div data-pc="timeline" className="flex flex-col h-full bg-neutral-900 border-t border-neutral-800 text-neutral-300 select-none overflow-hidden text-sm relative">
      <CutTabs />
      <Toolbar />
      <div className="flex-1 flex min-h-0 overflow-auto pc-tl-scroll" ref={scrollRef}>
        
        {/* Left Headers Column */}
        <div className="relative flex-shrink-0 border-r border-neutral-800 sticky left-0 bg-neutral-900 z-30 flex flex-col shadow-[4px_0_12px_rgba(0,0,0,0.5)]" style={{ width: headerW }}>
          <div className="flex-shrink-0 sticky top-0 z-40 bg-neutral-950" style={{ height: RANGE_H }} />
          <div className="pc-tl-hdr flex-shrink-0 sticky bg-neutral-950 z-40" style={{ top: RANGE_H }}>
            序列
          </div>
          <div className="flex-1 flex flex-col">
            {tracks.map((track, i) => (
              <TrackHeader key={track.id} track={track} index={i} />
            ))}
            <div className="pc-tl-addtrack-wrap">
              <button type="button" className="pc-tl-addtrack" onClick={() => actions.addTrack()}>
                <IconPlus size={12} />
                序列
              </button>
            </div>
          </div>
          <div className="absolute inset-y-0 right-0 w-1.5 z-40">
            <ResizeHandle
              axis="x"
              value={headerW}
              min={HEADER_W_MIN}
              max={HEADER_W_MAX}
              onChange={setHeaderW}
              onCommit={commitHeaderW}
              onReset={resetHeaderW}
              title="拖动调整行头宽度,双击复位"
            />
          </div>
        </div>

        {/* Tracks Area */}
        <div className="flex-1 relative flex flex-col" ref={trackAreaRef} style={{ minWidth: contentWidth }}>
          <div className="flex-shrink-0 sticky top-0 z-20" style={{ height: RANGE_H }}>
            <RangeBar />
          </div>
          <div className="flex-shrink-0 sticky bg-neutral-950 z-20" style={{ top: RANGE_H, height: 26 }}>
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
      <Scrollbar />
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
