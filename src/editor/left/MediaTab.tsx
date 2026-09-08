import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, actions } from "../../store/project";
import { DEFAULT_MEDIA_DUR, type MediaAsset } from "../../kernel/project";
import { clearDragPayload, MIME_MEDIA, setDragPayload } from "../dnd";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { PreviewCard } from "./PreviewCard";

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

async function measureImageDimensions(url: string): Promise<{ width: number; height: number }> {
  if (!url) {
    throw new Error("图片 URL 为空");
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error("读取图片尺寸超时")), 5000);
    img.onload = () => {
      clearTimeout(timer);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      } else {
        reject(new Error("未能读取到有效的图片尺寸"));
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error("加载图片失败"));
    };
    img.src = url;
  });
}

/** 空态和「没有匹配的…」里的称呼跟着分页走,免得配乐页也说「视频」 */
const KIND_NOUN: Record<MediaAsset["kind"], string> = { video: "视频", audio: "配乐", image: "图像" };

function fmtDur(sec: number | undefined): string {
  if (sec == null) return "—";
  return `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, "0")}`;
}

/**
 * 视频 / 图像的方形预览卡。视频:平时停在首帧,悬停时静音循环播,底边一条强调色
 * 进度条跟着播放位置走(只看不拖);图像:整张铺满。拖到时间轴、右键菜单都挂在卡上。
 */
function MediaCard({
  m,
  onDragStart,
  onDragEnd,
  onContextMenu,
}: {
  m: MediaAsset;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hot, setHot] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (hot) {
      v.currentTime = 0;
      // 自动播放被浏览器拒了就算了,首帧还在
      v.play().catch(() => {});
    } else {
      v.pause();
      // 回到首帧:下次悬停从头看,不悬停时卡上也是可辨认的一帧
      try { v.currentTime = 0; } catch { /* 还没加载出元数据 */ }
      setProgress(null);
    }
  }, [hot]);

  const preview =
    m.kind === "image" ? (
      <img src={m.url} alt="" draggable={false} />
    ) : (
      <video
        ref={videoRef}
        src={m.url}
        muted
        loop
        playsInline
        preload="metadata"
        draggable={false}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          if (hot && el.duration > 0) setProgress(el.currentTime / el.duration);
        }}
      />
    );

  const subtitle =
    m.kind === "image"
      ? m.width && m.height ? `${m.width}×${m.height}` : undefined
      : `${fmtDur(m.duration)}${m.transcript ? ` · 字幕 ${m.transcript.segments.length} 段` : ""}`;

  return (
    <PreviewCard
      attrs={{ "data-pc-media": m.id }}
      title={m.name}
      subtitle={subtitle}
      preview={preview}
      progress={m.kind === "video" && hot ? (progress ?? 0) : null}
      onHover={setHot}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onContextMenu={onContextMenu}
      titleAttr={m.kind === "video" ? "悬停预览;拖动 = 拖到时间轴;右键 = 更多" : "拖动 = 拖到时间轴;右键 = 更多"}
    />
  );
}

/**
 * 素材 → 视频 / 图像 / 配乐: 导入进来的素材列表(同一个组件按 kinds 过滤出三个分页)。
 * 视频和图像是方形预览卡网格,配乐是一行一条。支持搜索过滤、拖拽到时间轴、
 * 右键菜单(转写字幕、取素材比例作为项目比例、删除素材)。
 */
export function MediaTab({
  search,
  onOpenCaptions,
  kinds,
}: {
  search: string;
  onOpenCaptions: (mediaId: string) => void;
  /** 只显示这些种类的素材(不给就全显示)。视频页给 video,图像页给 image,配乐页给 audio。 */
  kinds?: MediaAsset["kind"][];
}) {
  const noun = kinds && kinds.length === 1 ? KIND_NOUN[kinds[0]] : "素材";
  const allMedia = useStore((s) => s.project.media);
  const media = useMemo(() => (kinds ? allMedia.filter((m) => kinds.includes(m.kind)) : allMedia), [allMedia, kinds]);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; media: MediaAsset } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(null), 3000);
  };
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

  const openMenu = (e: React.MouseEvent, m: MediaAsset) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, media: m });
  };

  const handleApplyAspectRatio = async (m: MediaAsset) => {
    try {
      let width = m.width;
      let height = m.height;
      if (!width || !height || width <= 0 || height <= 0) {
        // 图片得用 <img> 量,拿 <video> 读它只会报「加载视频元数据失败」
        const measured = m.kind === "image" ? await measureImageDimensions(m.url) : await measureVideoDimensions(m.url);
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

  /** 右键菜单的项:转写、创建为声音(有声音的才有)、取比例(有画面的才有)、删除 */
  const menuItems = (m: MediaAsset): ContextMenuItem[] => [
    ...(m.kind === "image"
      ? []
      : [
          {
            label: m.transcript ? "查看字幕" : "转写字幕",
            hint: m.transcript ? `${m.transcript.segments.length} 段` : undefined,
            onClick: () => onOpenCaptions(m.id),
          },
        ]),
    // 视频派生出「只要声音」的一份:同一个文件、不转码,拖到时间轴上就是纯音频段
    ...(m.kind === "video"
      ? [
          {
            label: "创建为声音",
            hint: "配乐页",
            onClick: () => {
              const r = actions.audioFromVideo(m.id);
              flash(r.ok ? (r.created ? `已创建「${r.media.name}」,在配乐页` : `「${r.media.name}」早就建过了,在配乐页`) : r.error);
            },
          },
        ]
      : []),
    ...(m.kind === "audio"
      ? []
      : [
          {
            label: m.kind === "image" ? "以图片比例作为项目比例" : "以视频比例作为项目比例",
            hint: m.width && m.height && m.width > 0 && m.height > 0 ? `${m.width}x${m.height}` : undefined,
            onClick: () => handleApplyAspectRatio(m),
          },
        ]),
    {
      label: "删除素材",
      danger: true,
      onClick: () => setConfirmDelete({ mediaId: m.id, name: m.name }),
    },
  ];

  // 视频和图像是卡片网格;配乐没有画面,还是一行一条
  const grid = !kinds || kinds.some((k) => k !== "audio");

  return (
    <div className="flex-1 min-h-0 flex flex-col pc-l-scroll">
      <div className="flex-1 overflow-y-auto pc-l-scroll py-1">
        {media.length === 0 ? (
          <div className="pc-l-empty">
            <div>
              <div className="pc-l-empty-icon" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="5" width="18" height="14" />
                  <path d="M10 9l5 3-5 3z" />
                </svg>
              </div>
              <div className="pc-l-empty-text">
                还没有导入的{noun}。
                <br />
                点上面的导入按钮加进来。
              </div>
            </div>
          </div>
        ) : filteredMedia.length === 0 ? (
          <div className="px-3 py-4 text-xs text-neutral-500">没有匹配的{noun}</div>
        ) : grid ? (
          <div className="pc-l-grid">
            {filteredMedia.map((m) =>
              m.kind === "audio" ? (
                <AudioRow key={m.id} m={m} onDragStart={(e) => handleDragStart(e, m)} onContextMenu={(e) => openMenu(e, m)} />
              ) : (
                <MediaCard
                  key={m.id}
                  m={m}
                  onDragStart={(e) => handleDragStart(e, m)}
                  onDragEnd={clearDragPayload}
                  onContextMenu={(e) => openMenu(e, m)}
                />
              ),
            )}
          </div>
        ) : (
          <div className="px-1">
            {filteredMedia.map((m) => (
              <AudioRow key={m.id} m={m} onDragStart={(e) => handleDragStart(e, m)} onContextMenu={(e) => openMenu(e, m)} />
            ))}
          </div>
        )}
      </div>

      {msg && <div className="flex-none px-2 py-1.5 text-[11px] text-neutral-400 border-t border-neutral-800">{msg}</div>}

      {ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={menuItems(ctxMenu.media)} onClose={() => setCtxMenu(null)} />}

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

/** 配乐一行:名字 + 时长(+ 已有字幕的段数)。转写入口在右键菜单里 */
function AudioRow({ m, onDragStart, onContextMenu }: { m: MediaAsset; onDragStart: (e: React.DragEvent) => void; onContextMenu: (e: React.MouseEvent) => void }) {
  return (
    <div
      data-pc-media={m.id}
      draggable
      onDragStart={onDragStart}
      onDragEnd={clearDragPayload}
      onContextMenu={onContextMenu}
      className="flex items-center gap-2 px-2 py-1 rounded hover:bg-neutral-800 cursor-grab text-xs"
      title="拖动 = 拖到时间轴;右键 = 转写字幕 / 删除"
    >
      <div className="flex-1 truncate text-neutral-200">{m.name}</div>
      {m.transcript && <div className="text-indigo-400 text-[10px] shrink-0">字幕 {m.transcript.segments.length} 段</div>}
      <div className="text-neutral-500 tabular-nums shrink-0">{fmtDur(m.duration)}</div>
    </div>
  );
}
