import { useState } from "react";
import { Track } from "../../kernel/project";
import { ClipView } from "./ClipView";
import { useTimelineContext } from "./TimelineContext";
import { actions } from "../../store/project";

export function TrackRow({ track }: { track: Track }) {
  const { pxPerSec, draggingTrackId } = useTimelineContext();
  const [dragOver, setDragOver] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    const hasCard = e.dataTransfer.types.includes("application/x-promptcut-card");
    const hasMedia = e.dataTransfer.types.includes("application/x-promptcut-media");
    if (!hasCard && !hasMedia) return;

    e.preventDefault();
    let isForbidden = false;
    if (track.locked) isForbidden = true;
    if (track.kind === "overlay" && !hasCard) isForbidden = true;
    if (track.kind === "video" && !hasMedia) isForbidden = true;

    setDragOver(true);
    setForbidden(isForbidden);
    e.dataTransfer.dropEffect = isForbidden ? "none" : "copy";
  };

  const handleDragLeave = () => {
    setDragOver(false);
    setForbidden(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    setDragOver(false);
    setForbidden(false);
    
    if (track.locked) return;

    const hasCard = e.dataTransfer.types.includes("application/x-promptcut-card");
    const hasMedia = e.dataTransfer.types.includes("application/x-promptcut-media");
    
    if (track.kind === "overlay" && hasCard) {
      const cardId = e.dataTransfer.getData("application/x-promptcut-card");
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const start = Math.max(0, x / pxPerSec);
      actions.addCardClip(cardId, start, { trackId: track.id });
    } else if (track.kind === "video" && hasMedia) {
      const mediaId = e.dataTransfer.getData("application/x-promptcut-media");
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const start = Math.max(0, x / pxPerSec);
      actions.addMediaClip(mediaId, start, { trackId: track.id });
    }
  };

  const isDraggingTarget = draggingTrackId === track.id;

  let bgClass = "bg-neutral-900";
  if (dragOver) {
    bgClass = forbidden ? "bg-red-950 border-red-500 border border-dashed" : "bg-neutral-800 border-blue-500 border border-dashed";
  } else if (isDraggingTarget) {
    bgClass = "bg-neutral-800";
  }

  return (
    <div
      data-track-id={track.id}
      className={`h-10 relative border-b border-neutral-800/50 box-border ${bgClass}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {!track.hidden && track.clips.map((clip) => (
        <ClipView key={clip.id} clip={clip} track={track} />
      ))}
      
      {track.locked && (
        <div className="absolute inset-0 bg-black/20 pointer-events-none z-50 diagonal-stripes" />
      )}
    </div>
  );
}
