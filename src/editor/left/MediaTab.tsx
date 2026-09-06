import { useMemo, useState } from "react";
import { useStore, actions } from "../../store/project";
import { DEFAULT_MEDIA_DUR, type MediaAsset } from "../../kernel/project";
import { clearDragPayload, MIME_MEDIA, setDragPayload } from "../dnd";
import { ContextMenu } from "./ContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";

async function measureVideoDimensions(url: string): Promise<{ width: number; height: number }> {
  if (!url) {
    throw new Error("视频 URL 为空");
  }
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.style.display = "none";
    document.body.appendChild(video);

    let finished = false;
    const cleanup = () => {
      if (!finished) {
        finished = true;
        if (video.parentNode) {
          video.parentNode.removeChild(video);
        }
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("读取视频元数据超时"));
    }, 5000);

    video.onloadedmetadata = () => {
      clearTimeout(timer);
      const width = video.videoWidth;
      const height = video.videoHeight;
      cleanup();
      if (width > 0 && height > 0) {
        resolve({ width, height });
      } else {
        reject(new Error("未能读取到有效的视频尺寸"));
      }
    };

    video.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("加载视频元数据失败"));
    };

    video.src = url;
  });
}

/**
 * 素材 → 视频: 导入进来的素材列表。
 * 支持搜索过滤、拖拽到时间轴、右键菜单（取视频比例作为项目比例、删除素材）。
 */
export function MediaTab({
  search,
  onOpenCaptions,
  kinds,
}: {
  search: string;
  onOpenCaptions: (mediaId: string) => void;
  /** 只显示这些种类的素材(不给就全显示)。视频页给 video/image,配乐页给 audio。 */
  kinds?: MediaAsset["kind"][];
}) {
  const allMedia = useStore((s) => s.project.media);
  const media = useMemo(() => (kinds ? allMedia.filter((m) => kinds.includes(m.kind)) : allMedia), [allMedia, kinds]);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; media: MediaAsset } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ mediaId: string; name: string } | null>(null);

  const filteredMedia = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return media;
    return media.filter((m) => m.name.toLowerCase().includes(q));
  }, [media, search]);

  const handleDragStart = (e: React.DragEvent, m: MediaAsset) => {
    e.dataTransfer.setData(MIME_MEDIA, m.id);
    e.dataTransfer.effectAllowed = "copy";
    setDragPayload({ kind: "media", mediaId: m.id, name: m.name, duration: m.duration ?? DEFAULT_MEDIA_DUR });
  };

  const handleApplyAspectRatio = async (m: MediaAsset) => {
    try {
      let width = m.width;
      let height = m.height;
      if (!width || !height || width <= 0 || height <= 0) {
        const measured = await measureVideoDimensions(m.url);
        width = measured.width;
        height = measured.height;
      }
      if (width > 0 && height > 0) {
        actions.setProjectMeta({ width, height });
      } else {
        alert("未能获取视频的有效分辨率");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`获取视频分辨率失败: ${msg}`);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col pc-l-scroll">
      <div className="flex-1 overflow-y-auto pc-l-scroll py-1">
        {media.length === 0 ? (
          <div className="px-3 py-4 text-xs text-neutral-500">还没有导入的视频。点上面的 + 加进来。</div>
        ) : filteredMedia.length === 0 ? (
          <div className="px-3 py-4 text-xs text-neutral-500">没有匹配的视频</div>
        ) : (
          <div className="px-1">
            {filteredMedia.map((m) => (
              <div
                key={m.id}
                data-pc-media={m.id}
                draggable
                onDragStart={(e) => handleDragStart(e, m)}
                onDragEnd={clearDragPayload}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, media: m });
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
              label: "以视频比例作为项目比例",
              hint:
                ctxMenu.media.width && ctxMenu.media.height && ctxMenu.media.width > 0 && ctxMenu.media.height > 0
                  ? `${ctxMenu.media.width}x${ctxMenu.media.height}`
                  : undefined,
              onClick: () => handleApplyAspectRatio(ctxMenu.media),
            },
            {
              label: "删除素材",
              danger: true,
              onClick: () => setConfirmDelete({ mediaId: ctxMenu.media.id, name: ctxMenu.media.name }),
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
