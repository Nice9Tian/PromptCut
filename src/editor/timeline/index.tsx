/**
 * 底部时间轴:多条序列、clip 拖动/缩放/跨序列、播放头、吸附、右键菜单、接收左栏拖来的卡片和媒体。
 * 序列不分种类:同一条序列里卡片段和素材段都能放;**上面那条序列画在上层**,和这里看到的一致。
 */
import { useEffect } from "react";
import { useStore, actions, getState } from "../../store/project";
import { TimelineProvider, useTimelineContext } from "./TimelineContext";
import { TrackHeader } from "./TrackHeader";
import { xOfTime, HEADER_W_MIN, HEADER_W_MAX, TAIL_SLACK_PX, contentEndOf } from "./utils";
import { TrackRow } from "./TrackRow";
import { Ruler, RULER_H } from "./Ruler";
import { InsertZones } from "./InsertZones";
import { NewTrackZone } from "./NewTrackZone";
import { Playhead } from "./Playhead";
import { Toolbar } from "./Toolbar";
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
  const { scrollRef, trackAreaRef, pxPerSec, setDropPlan, headerW, setHeaderW, commitHeaderW, resetHeaderW, trackH } = useTimelineContext();
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
  // 标尺 + 下面的空行 = 正好一行序列高:第一条序列上方空出的就是一个序列的高度。行高比标尺还矮时不留空行
  const topGapH = Math.max(0, trackH - RULER_H);

  return (
    <div data-pc="timeline" className="flex flex-col h-full bg-neutral-900 border-t border-neutral-800 text-neutral-300 select-none overflow-hidden text-sm relative">
      <Toolbar />
      <div className="flex-1 min-h-0 overflow-auto pc-tl-scroll" ref={scrollRef}>
        {/* Keep both sticky columns as tall as the complete scroll content. */}
        <div className="pc-tl-content flex min-h-full min-w-full w-max">
        
        {/* Left Headers Column */}
        <div className="pc-tl-headers relative flex-shrink-0 sticky left-0 bg-neutral-900 z-30 flex flex-col" style={{ width: headerW }}>
          {/* 和标尺等高的空表头:不写字,只占位,让下面的行头和右边的轨道行对齐 */}
          <div className="pc-tl-hdr flex-shrink-0 sticky top-0 bg-neutral-950 z-40" style={{ height: RULER_H }} aria-hidden="true" />
          {/* 标尺下面补一截空行,和标尺合起来正好一个序列高(跟着当前行高);右边轨道区同样补一截 */}
          <div className="pc-tl-toprow flex-shrink-0" style={{ height: topGapH }} aria-hidden="true" />

          {/* 行头自成一层(isolation):拖动中的行头(z-40)只在这一层里压过别的行头,不会盖到上面吸顶的表头 */}
          <div className="flex-1 flex flex-col" style={{ isolation: "isolate" }}>
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
          <div className="pc-tl-header-resize absolute inset-y-0 right-0 w-1.5 z-40">
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
        <div className="pc-tl-tracks flex-1 relative flex flex-col" ref={trackAreaRef} style={{ minWidth: contentWidth }}>
          <div className="flex-shrink-0 sticky top-0 bg-neutral-950 z-20" style={{ height: RULER_H }}>
            <Ruler />
          </div>
          {/* 和左边行头列那截空行等高:片段层(下面 .pc-tl-rows)整体往下让,层内的位置计算都是相对它自己的,不受影响 */}
          <div className="pc-tl-toprow flex-shrink-0" style={{ height: topGapH }} aria-hidden="true" />
          {/*
            片段层自成一层(isolation):选中片段(z-20)、落点预览(z-30)、插入缝(z-40)、拖动中的行(z-40)、锁定遮罩(z-50)
            的 z 只在这一层里比大小,整层排在吸顶的范围条 / 标尺 / 绿条(z-20)和左边行头列(z-30)下面。
            以前这一层不是独立的层叠上下文,选中片段和标尺同为 z-20、DOM 又在后面,竖向滚动时就会盖到标尺上。
            右键菜单因此 portal 到 body(ContextMenu.tsx),不留在这一层里被标尺压住。
          */}
          <div
            className="pc-tl-rows flex-1 relative"
            style={{ isolation: "isolate" }}
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
          <Playhead />
        </div>
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
