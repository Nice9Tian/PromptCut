import { useState } from "react";
import { useTimelineContext } from "./TimelineContext";
import { actions, useStore, getState } from "../../store/project";
import { getCard } from "../../kernel/registry";
import { snapTime, isOccupied, getGap, xOfTime } from "./utils";
import { TrackClip, Track } from "../../kernel/project";
import { useDrag } from "./useDrag";
import { ContextMenu } from "./ContextMenu";

export function ClipView({ clip, track }: { clip: TrackClip; track: Track }) {
  const { pxPerSec, trackAreaRef, setDraggingClipId, setDraggingTrackId } = useTimelineContext();
  const selection = useStore((s) => s.selection);
  const isSelected = selection.includes(clip.id);
  const cardDef = clip.cardId ? getCard(clip.cardId) : null;
  const label = clip.cardId ? (cardDef ? cardDef.name : "未知卡片") : clip.label;

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
    "absolute top-1 bottom-1 rounded flex items-center px-2 text-xs text-white overflow-hidden select-none border",
    track.locked ? "" : "cursor-pointer",
    isSelected ? "border-white z-20 shadow-[0_0_0_1px_rgba(255,255,255,1)]" : "border-black/20 z-10",
    // 颜色分的是片段类型(卡片 / 素材),序列本身不再分种类
    clip.mediaId ? "bg-emerald-600 hover:bg-emerald-500" : "bg-blue-600 hover:bg-blue-500",
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
        
        <span className="truncate pointer-events-none font-medium drop-shadow-md">{label}</span>
        
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
