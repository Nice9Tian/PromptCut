import { useState } from "react";
import { Track } from "../../kernel/project";
import { actions } from "../../store/project";
import { ContextMenu } from "./ContextMenu";
import { useTimelineContext } from "./TimelineContext";
import { useReorderDrag, useRowOffset } from "./useReorder";

export function TrackHeader({ track, index }: { track: Track; index: number }) {
  const { trackH } = useTimelineContext();
  const { start: startReorder } = useReorderDrag();
  const offset = useRowOffset(index, track.id);
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(track.name);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  
  const handleDoubleClick = () => setIsEditing(true);
  const handleBlur = () => {
    setIsEditing(false);
    if (name.trim() !== track.name) {
      actions.updateTrack(track.id, { name: name.trim() || track.name });
    }
  };
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleBlur();
    if (e.key === "Escape") {
      setIsEditing(false);
      setName(track.name);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <>
      <div
        data-pc-track-header={track.id}
        className={`border-b border-neutral-800 flex items-center px-2 gap-2 group select-none touch-none ${
          offset.dragging
            ? "z-40 bg-neutral-800 shadow-[0_6px_16px_rgba(0,0,0,0.55)] cursor-grabbing relative"
            : "hover:bg-neutral-800 cursor-grab"
        }`}
        style={{
          height: trackH,
          transform: offset.y ? `translateY(${offset.y}px)` : undefined,
          transition: offset.animated ? "transform 150ms cubic-bezier(0.2, 0, 0, 1)" : "none",
        }}
        title="按住上下拖 = 调整序列顺序"
        onContextMenu={handleContextMenu}
        onPointerDown={(e) => startReorder(e, index, track.id)}
      >
        <div className="text-neutral-500 px-1 flex-shrink-0">≡</div>
        <div className="flex-1 overflow-hidden" onDoubleClick={handleDoubleClick}>
          {isEditing ? (
            <input
              autoFocus
              className="w-full bg-neutral-950 text-white outline-none px-1 text-xs"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
            />
          ) : (
            <div className="truncate text-xs font-medium">{track.name}</div>
          )}
        </div>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            className={`w-5 h-5 flex items-center justify-center rounded ${track.hidden ? "text-red-400" : "text-neutral-400 hover:text-white"}`}
            onClick={() => actions.updateTrack(track.id, { hidden: !track.hidden })}
            title="隐藏"
          >
            {track.hidden ? "👁‍🗨" : "👁"}
          </button>
          <button
            className={`w-5 h-5 flex items-center justify-center rounded ${track.locked ? "text-red-400" : "text-neutral-400 hover:text-white"}`}
            onClick={() => actions.updateTrack(track.id, { locked: !track.locked })}
            title="锁定"
          >
            {track.locked ? "🔒" : "🔓"}
          </button>
        </div>
      </div>
      
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: "删除序列",
              action: () => actions.removeTrack(track.id),
            },
          ]}
        />
      )}
    </>
  );
}
