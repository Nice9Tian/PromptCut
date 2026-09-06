import { useState } from "react";
import { Track } from "../../kernel/project";
import { actions } from "../../store/project";
import { ContextMenu } from "./ContextMenu";

export function TrackHeader({ track, index }: { track: Track; index: number }) {
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

  // HTML5 DnD for reordering
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("application/x-promptcut-track", track.id);
    e.dataTransfer.effectAllowed = "move";
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-promptcut-track")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData("application/x-promptcut-track");
    if (draggedId && draggedId !== track.id) {
      actions.moveTrack(draggedId, index);
    }
  };

  return (
    <>
      <div
        className="h-10 border-b border-neutral-800 flex items-center px-2 gap-2 group hover:bg-neutral-800"
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <div className="text-neutral-500 cursor-grab px-1 select-none flex-shrink-0">≡</div>
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
              label: "删除轨道",
              action: () => actions.removeTrack(track.id),
            },
          ]}
        />
      )}
    </>
  );
}
