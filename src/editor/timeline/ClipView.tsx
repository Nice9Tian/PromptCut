import { useState } from "react";
import { useTimelineContext } from "./TimelineContext";
import { actions, useStore, getState } from "../../store/project";
import { getCard } from "../../kernel/registry";
import { snapTime, isOccupied, getGap, xOfTime, formatTime, ROW_SIZE_H } from "./utils";
import { ShotMarkers } from "./ShotMarkers";
import { TrackClip, Track } from "../../kernel/project";
import { useDrag } from "./useDrag";
import { ContextMenu } from "./ContextMenu";
import { clipTrackKind } from "../../kernel/trackKind";

export function ClipView({ clip, track }: { clip: TrackClip; track: Track }) {
  const { pxPerSec, trackAreaRef, setDraggingClipId, setDraggingTrackId, rowSize } = useTimelineContext();
  const selection = useStore((s) => s.selection);
  const isSelected = selection.includes(clip.id);
  const cardDef = clip.cardId ? getCard(clip.cardId) : null;
  const label = clip.cardId ? (cardDef ? cardDef.name : "未知卡片") : clip.label;
  // 按素材类型上色:文字 / 视频 / 转场… 各一档,一眼读得出片段是什么
  const trackKind = clipTrackKind(clip, (id) => getState().project.media.find((m) => m.id === id));

  let subtitle = "";
  if (clip.cardId && cardDef) {
    const textControl = cardDef.controls.find((c) => c.type === "text");
    if (textControl) {
      const val = clip.params[textControl.key] ?? cardDef.defaults[textControl.key];
      subtitle = val != null ? String(val).trim() : "";
    }
    if (!subtitle) subtitle = cardDef.description || "";
  } else if (clip.mediaId) {
    subtitle = "时长 " + formatTime(clip.end - clip.start);
  }

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
        
        {rowSize === "small" ? (
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
            { label: "复制", action: () => actions.duplicateClip(clip.id) },
            {
              label: "在播放头处分割",
              action: () => actions.splitClip(clip.id, getState().t),
              disabled: getState().t <= clip.start || getState().t >= clip.end,
            },
            {
              label: "置顶",
              action: () => {
                const tracks = getState().project.tracks;
                if (tracks.length > 0) {
                  const topTrack = tracks[tracks.length - 1]; // later in array = higher z-index
                  actions.moveClip(clip.id, { trackId: topTrack.id });
                }
              }
            },
            {
              label: "置底",
              action: () => {
                const tracks = getState().project.tracks;
                if (tracks.length > 0) {
                  const bottomTrack = tracks[0];
                  actions.moveClip(clip.id, { trackId: bottomTrack.id });
                }
              }
            },
            { label: "删除", action: () => actions.removeClip(clip.id) },
          ]}
        />
      )}
    </>
  );
}
