import { useMemo, useState } from "react";
import { useTimelineContext } from "./TimelineContext";
import { actions, useStore, getState } from "../../store/project";
import { getCard } from "../../kernel/registry";
import { snapTime, isOccupied, getGap, xOfTime, formatTime, ROW_SIZE_H } from "./utils";
import { ShotMarkers } from "./ShotMarkers";
import { TrackClip, Track } from "../../kernel/project";
import { useDrag } from "./useDrag";
import { ContextMenu } from "./ContextMenu";
import { clipTrackKind } from "../../kernel/trackKind";
import { describeTransition, timingLock, transitionsOfClip } from "../../kernel/transitions";
import { describeEmphasis } from "../../kernel/emphasis";
import { requestCaptions } from "../left/captionsBus";
import { CaptionLines } from "./CaptionLines";
import { captionsOf, isCaptionClip } from "../../kernel/captions";

export function ClipView({ clip, track }: { clip: TrackClip; track: Track }) {
  const { pxPerSec, trackAreaRef, setDraggingClipId, setDraggingTrackId, rowSize } = useTimelineContext();
  const selection = useStore((s) => s.selection);
  const isSelected = selection.includes(clip.id);
  const cardDef = clip.cardId ? getCard(clip.cardId) : null;
  const label = clip.cardId ? (cardDef ? cardDef.name : "未知卡片") : clip.label;
  // 按素材类型上色:文字 / 视频 / 转场… 各一档,一眼读得出片段是什么
  const trackKind = clipTrackKind(clip, (id) => getState().project.media.find((m) => m.id === id));
  // 这一段是不是「有画面的素材」:只有它能转成声音(卡片、图片、已经是声音的都不行)
  const canBecomeAudio = !!clip.mediaId && getState().project.media.find((m) => m.id === clip.mediaId)?.kind === "video";

  // 字幕卡不走「标题 + 副标题」那一套:它的内容是一条条字幕,直接在色块里画出来
  const isCaption = isCaptionClip(clip);
  const capCount = useMemo(() => (isCaption ? captionsOf(clip).length : 0), [isCaption, clip.params?.lines]);

  let subtitle = "";
  if (isCaption) {
    subtitle = capCount > 0 ? `${capCount} 条字幕` : "还没有字幕,右键素材去转写";
  } else if (clip.cardId && cardDef) {
    const textControl = cardDef.controls.find((c) => c.type === "text");
    if (textControl) {
      const val = clip.params[textControl.key] ?? cardDef.defaults[textControl.key];
      subtitle = val != null ? String(val).trim() : "";
    }
    if (!subtitle) subtitle = cardDef.description || "";
  } else if (clip.mediaId) {
    subtitle = "时长 " + formatTime(clip.end - clip.start);
  }

  // 挂在这段上的转场:画出淡化区间、右键能删,而且它锁着这段的时间关系(单独拖会被 store 挡回来,整组一起走)
  const allTransitions = useStore((s) => s.project.transitions);
  const myTransitions = useMemo(() => transitionsOfClip(getState().project, clip.id), [allTransitions, clip.id]);
  const lock = myTransitions.length > 0 ? timingLock(getState().project, clip.id) : null;

  const [dragState, setDragState] = useState<{ start: number; end: number; trackId: string; forbidden: boolean } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const displayStart = dragState ? dragState.start : clip.start;
  const displayEnd = dragState ? dragState.end : clip.end;

  const dragRef = useDrag(
    (e) => {
      if (track.locked) return;
      if (!e.shiftKey) {
        if (!selection.includes(clip.id)) actions.select([clip.id]);
      } else {
        actions.select([...selection, clip.id]);
      }
      setDraggingClipId(clip.id);
      setDraggingTrackId(track.id);
    },
    (e, delta, rawEvent) => {
      if (track.locked) return;
      const state = getState();
      const tDelta = delta.x / pxPerSec;
      const originalDur = clip.end - clip.start;
      
      let newStartRaw = clip.start + tDelta;
      let newStart = snapTime(newStartRaw, rawEvent.altKey, state.project, state.t, clip.id, pxPerSec);
      let newEnd = newStart + originalDur;

      let newTrackId = track.id;
      if (trackAreaRef.current) {
        const elements = document.elementsFromPoint(rawEvent.clientX, rawEvent.clientY);
        const row = elements.find((el) => el.hasAttribute("data-track-id"));
        if (row) {
          const hoverTrackId = row.getAttribute("data-track-id")!;
          const hoverTrack = state.project.tracks.find((t) => t.id === hoverTrackId);
          if (hoverTrack && !hoverTrack.locked) {
            newTrackId = hoverTrackId;
          }
        }
      }

      setDraggingTrackId(newTrackId);

      let forbidden = false;
      if (newTrackId !== track.id) {
        const targetTrack = state.project.tracks.find((t) => t.id === newTrackId);
        if (targetTrack) {
          forbidden = isOccupied(targetTrack, clip.id, newStart, newEnd);
        }
      } else {
        const gap = getGap(track, clip.id, Math.max(state.project.duration, 10000));
        if (newStart < gap.start) {
          newStart = gap.start;
          newEnd = newStart + originalDur;
        }
        if (newEnd > gap.end) {
          newEnd = gap.end;
          newStart = newEnd - originalDur;
        }
      }

      setDragState({ start: newStart, end: newEnd, trackId: newTrackId, forbidden });
    },
    (e) => {
      if (track.locked) return;
      setDraggingClipId(null);
      setDraggingTrackId(null);
      setDragState((prev) => {
        if (prev) {
          if (!prev.forbidden) {
            actions.moveClip(clip.id, { start: prev.start, end: prev.end, trackId: prev.trackId });
          }
        }
        return null;
      });
    }
  );

  const resizeLeftRef = useDrag(
    (e) => {
      if (track.locked) return;
      e.stopPropagation();
    },
    (e, delta, rawEvent) => {
      if (track.locked) return;
      const state = getState();
      const tDelta = delta.x / pxPerSec;
      const newStartRaw = clip.start + tDelta;
      let newStart = snapTime(newStartRaw, rawEvent.altKey, state.project, state.t, clip.id, pxPerSec);
      
      const gap = getGap(track, clip.id, Math.max(state.project.duration, 10000));
      newStart = Math.max(gap.start, Math.min(newStart, clip.end - 0.1));
      
      setDragState({ start: newStart, end: clip.end, trackId: track.id, forbidden: false });
    },
    () => {
      if (track.locked) return;
      setDragState((prev) => {
        if (prev) actions.moveClip(clip.id, { start: prev.start, end: prev.end });
        return null;
      });
    }
  );

  const resizeRightRef = useDrag(
    (e) => {
      if (track.locked) return;
      e.stopPropagation();
    },
    (e, delta, rawEvent) => {
      if (track.locked) return;
      const state = getState();
      const tDelta = delta.x / pxPerSec;
      const newEndRaw = clip.end + tDelta;
      let newEnd = snapTime(newEndRaw, rawEvent.altKey, state.project, state.t, clip.id, pxPerSec);
      
      const gap = getGap(track, clip.id, Math.max(state.project.duration, 10000));
      newEnd = Math.min(gap.end, Math.max(newEnd, clip.start + 0.1));
      
      setDragState({ start: clip.start, end: newEnd, trackId: track.id, forbidden: false });
    },
    () => {
      if (track.locked) return;
      setDragState((prev) => {
        if (prev) actions.moveClip(clip.id, { start: prev.start, end: prev.end });
        return null;
      });
    }
  );

  const handleContextMenu = (e: React.MouseEvent) => {
    if (track.locked) return;
    e.preventDefault();
    e.stopPropagation();
    actions.select([clip.id]);
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const isCrossTrackDrag = dragState && dragState.trackId !== track.id;

  const clipClasses = [
    "pc-clip absolute top-1 bottom-1 rounded flex items-center px-2 text-xs overflow-hidden select-none border",
    track.locked ? "" : "cursor-pointer",
    isSelected ? "is-selected z-20" : "z-10",
    dragState?.forbidden ? "bg-red-500/50 border-red-500 border-dashed" : "",
  ].join(" ");

  // 计算跨轨拖动时的垂直偏移量，视觉上把色块移到目标轨道
  let translateY = 0;
  if (isCrossTrackDrag && trackAreaRef.current) {
     const targetTrackEl = trackAreaRef.current.querySelector(`[data-track-id="${dragState.trackId}"]`);
     const originalTrackEl = trackAreaRef.current.querySelector(`[data-track-id="${track.id}"]`);
     if (targetTrackEl && originalTrackEl) {
        translateY = targetTrackEl.getBoundingClientRect().top - originalTrackEl.getBoundingClientRect().top;
     }
  }

  return (
    <>
      <div
        ref={dragRef}
        data-clip-id={clip.id}
        data-track-kind={trackKind}
        className={clipClasses}
        style={{
          left: `${xOfTime(displayStart, pxPerSec)}px`,
          width: `${(displayEnd - displayStart) * pxPerSec}px`,
          transform: `translateY(${translateY}px)`,
          transition: dragState ? 'none' : 'width 0.1s, left 0.1s',
        }}
        onContextMenu={handleContextMenu}
      >
        <div
          ref={resizeLeftRef}
          className={`absolute left-0 top-0 bottom-0 w-2 z-30 ${track.locked ? "" : "cursor-col-resize hover:bg-white/30"}`}
        />
        
        {isCaption && capCount > 0 ? (
          // 字幕卡:色块里画出一条条字幕,点它跳过去、拖它挪时间、双击改字
          <CaptionLines clip={clip} height={ROW_SIZE_H[rowSize]} />
        ) : rowSize === "small" ? (
          <span className="truncate pointer-events-none font-medium drop-shadow-md w-full">{label}</span>
        ) : (
          <div className="flex flex-col items-start justify-center overflow-hidden pointer-events-none min-w-0 w-full leading-tight">
            <span className="truncate font-medium drop-shadow-md w-full">{label}</span>
            {subtitle && (
              <span className={`truncate text-[10px] opacity-70 w-full ${rowSize === 'large' ? 'mt-0.5' : ''}`}>
                {subtitle}
              </span>
            )}
          </div>
        )}
        
        {/* 转场:两端的淡化区间铺一层渐变,成组的再挂一个链条角标 —— 一眼看出这段被绑着 */}
        {(clip.fadeIn ?? 0) > 0 && (
          <div className="pc-clip-fade is-in" style={{ width: (clip.fadeIn ?? 0) * pxPerSec }} aria-hidden="true" />
        )}
        {(clip.fadeOut ?? 0) > 0 && (
          <div className="pc-clip-fade is-out" style={{ width: (clip.fadeOut ?? 0) * pxPerSec }} aria-hidden="true" />
        )}
        {lock && (
          <span className="pc-clip-link" title={lock.message}>
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4.6 7.4L7.4 4.6M5 2.6l.9-.9a2.3 2.3 0 013.3 3.3l-.9.9M7 9.4l-.9.9a2.3 2.3 0 01-3.3-3.3l.9-.9" />
            </svg>
          </span>
        )}

        {/* 镜头切换标记画在文字之上、把手之下:把手要能拖，标记只是看的 */}
        <ShotMarkers clip={clip} rowHeight={ROW_SIZE_H[rowSize]} />

        <div
          ref={resizeRightRef}
          className={`absolute right-0 top-0 bottom-0 w-2 z-30 ${track.locked ? "" : "cursor-col-resize hover:bg-white/30"}`}
        />
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            // 转场在最上面:被绑住的时候用户第一件想做的事就是解开它
            ...myTransitions.map((tr) => ({
              label: `删除转场:${describeTransition(getState().project, tr)}`,
              action: () => actions.removeTransition(tr.id),
            })),
            ...(clip.emphasis
              ? [{ label: `去掉强调:${describeEmphasis(clip.emphasis)}`, action: () => actions.setClipEmphasis(clip.id, null) }]
              : []),
            { label: "复制", action: () => actions.duplicateClip(clip.id) },
            // 只要声音:画面没了,位置、长度、素材内偏移、淡入淡出都留着;素材库里同时多一份声音素材
            ...(canBecomeAudio ? [{ label: "转换为声音", action: () => actions.convertClipToAudio(clip.id) }] : []),
            // 有声音的素材段可以直接去转写(图片没有声音,不给这一项)
            ...(() => {
              const media = clip.mediaId ? getState().project.media.find((m) => m.id === clip.mediaId) : null;
              if (!media || media.kind === "image") return [];
              return [{
                label: media.transcript ? `查看字幕(${media.transcript.segments.length} 段)` : "转写字幕",
                action: () => requestCaptions(media.id),
              }];
            })(),
            {
              label: lock ? "在播放头处分割(先删转场)" : "在播放头处分割",
              action: () => actions.splitClip(clip.id, getState().t),
              disabled: !!lock || getState().t <= clip.start || getState().t >= clip.end,
            },
            {
              label: "置顶",
              action: () => {
                const tracks = getState().project.tracks;
                // 最上面那条序列就是最上层(和时间轴上看到的一致)
                if (tracks.length > 0) actions.moveClip(clip.id, { trackId: tracks[0].id });
              }
            },
            {
              label: "置底",
              action: () => {
                const tracks = getState().project.tracks;
                if (tracks.length > 0) actions.moveClip(clip.id, { trackId: tracks[tracks.length - 1].id });
              }
            },
            { label: "删除", action: () => actions.removeClip(clip.id) },
          ]}
        />
      )}
    </>
  );
}
