import { useState, useMemo } from "react";
import { useStore, actions } from "../../store/project";
import { allCards } from "../../kernel/registry";
import { CardCell } from "./CardCell";
import { ContextMenu } from "./ContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { TranscribePanel } from "./TranscribePanel";

export function LibraryTab() {
  const [search, setSearch] = useState("");
  const project = useStore(s => s.project);
  
  const cards = useMemo(() => {
    const q = search.toLowerCase();
    const all = allCards().filter(c => 
      c.name.toLowerCase().includes(q) || 
      c.description.toLowerCase().includes(q) || 
      c.id.toLowerCase().includes(q)
    );
    
    const magic = all.filter(c => c.source === "magicui");
    const native = all.filter(c => c.source === "native");
    return { magic, native, empty: all.length === 0 };
  }, [search]);

  const [ctxMenu, setCtxMenu] = useState<{ x: number, y: number, mediaId: string, name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ mediaId: string, name: string } | null>(null);
  const [openTranscribeId, setOpenTranscribeId] = useState<string | null>(null);

  const handleMediaDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData("application/x-promptcut-media", id);
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col pc-l-scroll">
      <div className="flex-none p-2 border-b border-neutral-800">
        <div className="relative">
          <input
            data-pc="search"
            className="w-full h-7 px-2 rounded bg-neutral-900 border border-neutral-800 text-xs text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-neutral-600 pr-6"
            placeholder="搜索卡片…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button
              className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-neutral-500 hover:text-neutral-300"
              onClick={() => setSearch("")}
            >
              ✕
            </button>
          )}
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto pc-l-scroll pb-4">
        {cards.empty && (
          <div className="p-4 text-center text-xs text-neutral-500">没有匹配的卡片</div>
        )}
        
        {cards.magic.length > 0 && (
          <div className="mb-2">
            <div className="text-[11px] uppercase tracking-wide text-neutral-500 px-2 py-1 flex justify-between">
              <span>Magic UI</span>
              <span>({cards.magic.length})</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 px-2">
              {cards.magic.map(def => <CardCell key={def.id} def={def} />)}
            </div>
          </div>
        )}
        
        {cards.native.length > 0 && (
          <div className="mb-2">
            <div className="text-[11px] uppercase tracking-wide text-neutral-500 px-2 py-1 flex justify-between">
              <span>自家</span>
              <span>({cards.native.length})</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 px-2">
              {cards.native.map(def => <CardCell key={def.id} def={def} />)}
            </div>
          </div>
        )}
        
        <div className="mt-4 border-t border-neutral-800/50 pt-2">
          <div className="text-[11px] uppercase tracking-wide text-neutral-500 px-2 py-1 flex justify-between">
            <span>媒体</span>
            <span>({project.media.length})</span>
          </div>
          <div className="px-1">
            {project.media.length === 0 ? (
              <div className="px-2 text-xs text-neutral-600">还没有导入的视频</div>
            ) : (
              project.media.map(m => (
                <div key={m.id}>
                  <div
                    data-pc-media={m.id}
                    draggable
                    onDragStart={(e) => handleMediaDragStart(e, m.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtxMenu({ x: e.clientX, y: e.clientY, mediaId: m.id, name: m.name });
                    }}
                    className="flex items-center gap-2 px-2 py-1 rounded hover:bg-neutral-800 cursor-grab text-xs"
                  >
                    <div className="flex-1 truncate text-neutral-200">{m.name}</div>
                    <div className="text-neutral-500 tabular-nums shrink-0">
                      {m.duration != null ? `${Math.floor(m.duration / 60)}:${(m.duration % 60).toFixed(1).padStart(4, '0')}` : '—'}
                    </div>
                    <button
                      data-pc="transcribe-btn"
                      title={m.transcript ? `已转写 · ${m.transcript.segments.length} 段` : "转写"}
                      className={`shrink-0 px-1 h-5 rounded text-[10px] border ${
                        m.transcript
                          ? "border-indigo-600/50 text-indigo-400 hover:bg-indigo-900/40"
                          : "border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenTranscribeId(openTranscribeId === m.id ? null : m.id);
                      }}
                    >
                      {m.transcript ? `✓ ${m.transcript.segments.length}段` : "转写"}
                    </button>
                  </div>
                  {openTranscribeId === m.id && (
                    <div className="px-2">
                      <TranscribePanel
                        mediaId={m.id}
                        onClose={() => setOpenTranscribeId(null)}
                      />
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={[
            {
              label: "删除素材",
              danger: true,
              onClick: () => {
                setConfirmDelete({ mediaId: ctxMenu.mediaId, name: ctxMenu.name });
              }
            }
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
