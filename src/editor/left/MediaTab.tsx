import { useState } from "react";
import { useStore, actions } from "../../store/project";
import { DEFAULT_MEDIA_DUR, type MediaAsset } from "../../kernel/project";
import { clearDragPayload, MIME_MEDIA, setDragPayload } from "../dnd";
import { ContextMenu } from "./ContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * 素材 → 视频:导入进来的素材列表。拖到时间轴落成素材段(拖放契约见 EDITOR-DESIGN.md),
 * 右键删除。转写和字幕不在这里,点「字幕」按钮跳到字幕分页。
 */
export function MediaTab({ onOpenCaptions }: { onOpenCaptions: (mediaId: string) => void }) {
  const media = useStore((s) => s.project.media);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; mediaId: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ mediaId: string; name: string } | null>(null);

  const handleDragStart = (e: React.DragEvent, m: MediaAsset) => {
    e.dataTransfer.setData(MIME_MEDIA, m.id);
    e.dataTransfer.effectAllowed = "copy";
    setDragPayload({ kind: "media", mediaId: m.id, name: m.name, duration: m.duration ?? DEFAULT_MEDIA_DUR });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col pc-l-scroll">
      <div className="flex-1 overflow-y-auto pc-l-scroll py-1">
        {media.length === 0 ? (
          <div className="px-3 py-4 text-xs text-neutral-500">还没有导入的视频。用顶栏的「导入视频」加进来。</div>
        ) : (
          <div className="px-1">
            {media.map((m) => (
              <div
                key={m.id}
                data-pc-media={m.id}
                draggable
                onDragStart={(e) => handleDragStart(e, m)}
                onDragEnd={clearDragPayload}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, mediaId: m.id, name: m.name });
                }}
                className="flex items-center gap-2 px-2 py-1 rounded hover:bg-neutral-800 cursor-grab text-xs"
              >
                <div className="flex-1 truncate text-neutral-200">{m.name}</div>
                <div className="text-neutral-500 tabular-nums shrink-0">
                  {m.duration != null ? `${Math.floor(m.duration / 60)}:${(m.duration % 60).toFixed(1).padStart(4, "0")}` : "—"}
                </div>
                <button
                  data-pc="transcribe-btn"
                  title={m.transcript ? `已转写 · ${m.transcript.segments.length} 段` : "去字幕分页转写"}
                  className={`shrink-0 px-1 h-5 rounded text-[10px] border ${
                    m.transcript
                      ? "border-indigo-600/50 text-indigo-400 hover:bg-indigo-900/40"
                      : "border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600"
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenCaptions(m.id);
                  }}
                >
                  {m.transcript ? `✓ ${m.transcript.segments.length}段` : "字幕"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={[
            {
              label: "删除素材",
              danger: true,
              onClick: () => setConfirmDelete({ mediaId: ctxMenu.mediaId, name: ctxMenu.name }),
            },
          ]}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          open={true}
          title="删除素材"
          message={`确定删除「${confirmDelete.name}」?\n时间轴上引用它的片段会一起删除。`}
          onConfirm={() => {
            actions.removeMedia(confirmDelete.mediaId);
            setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
