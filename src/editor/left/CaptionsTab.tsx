import { useEffect, useMemo, useState } from "react";
import { actions, useStore } from "../../store/project";
import type { MediaAsset, Project, TranscriptSegment } from "../../kernel/project";
import { TranscribePanel } from "./TranscribePanel";

/**
 * 素材 → 字幕:一棵两级树。
 * 父节点是「转写来自哪个视频」,子节点才是段落。
 * 这样一次搜索能扫过所有素材,不必先切素材再找;点一段仍然把播放头挪到时间轴上对应位置。
 */

/** 一个素材节点 + 它当前该显示的段落(搜索过后可能只剩命中的那几条) */
interface CaptionNode {
  media: MediaAsset;
  /** 带原始下标:点击定位、调试属性都按原始下标走,不受过滤影响 */
  rows: { seg: TranscriptSegment; index: number }[];
  total: number;
  /** 搜索时这个素材还该不该出现在树里 */
  matched: boolean;
}

export function CaptionsTab({
  search,
  mediaId,
  onPick,
  onGoImport,
}: {
  search: string;
  mediaId: string | null;
  onPick: (id: string | null) => void;
  /** 空态里「前往导入」:切到「视频」分页 */
  onGoImport?: () => void;
}) {
  const project = useStore((s) => s.project);
  const t = useStore((s) => s.t);
  /** 正在重转写的素材:它的段落先让位给 TranscribePanel */
  const [retranscribeId, setRetranscribeId] = useState<string | null>(null);
  /** 手动折叠/展开的记录。浏览态和搜索态各记一份,免得互相干扰 */
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const [searchOpenMap, setSearchOpenMap] = useState<Record<string, boolean>>({});

  const q = search.trim().toLowerCase();
  // 图片没有声音,转写对它没有意义:字幕页只列视频和配乐
  const spoken = useMemo(() => project.media.filter((m) => m.kind !== "image"), [project.media]);

  useEffect(() => {
    // 选中的素材被删了(或者是张图片)就退回第一条
    if (mediaId && !spoken.some((m) => m.id === mediaId)) onPick(spoken[0]?.id ?? null);
  }, [mediaId, spoken, onPick]);

  useEffect(() => {
    // 换搜索词就把手动折叠清掉,否则上一轮折起来的节点会把这一轮的命中藏住
    setSearchOpenMap({});
  }, [q]);

  const nodes = useMemo<CaptionNode[]>(
    () =>
      spoken.map((media) => {
        const segments = media.transcript?.segments ?? [];
        const all = segments.map((seg, index) => ({ seg, index }));
        if (!q) return { media, rows: all, total: segments.length, matched: true };
        // 素材名命中就整份留下,省得用户搜到视频名却看不见它的段落
        const nameHit = media.name.toLowerCase().includes(q);
        const rows = nameHit ? all : all.filter(({ seg }) => seg.text.toLowerCase().includes(q));
        return { media, rows, total: segments.length, matched: nameHit || rows.length > 0 };
      }),
    [spoken, q],
  );

  if (spoken.length === 0) {
    return (
      <div className="pc-l-empty">
        <div>
          <div className="pc-l-empty-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="5" width="18" height="14" />
              <path d="M7 15h7M7 11h4" />
            </svg>
          </div>
          <div className="pc-l-empty-text">
            还没有素材。
            <br />
            先在「视频」分页导入,
            <br />
            再回来转字幕。
          </div>
          {onGoImport && (
            <button type="button" className="pc-l-empty-btn" onClick={onGoImport}>
              前往导入
            </button>
          )}
        </div>
      </div>
    );
  }

  // mediaId 还兼着「导入的 .srt 挂到哪」,没选过就落到第一份有转写的素材上
  const focusId = mediaId ?? spoken.find((m) => m.transcript)?.id ?? spoken[0]?.id ?? null;
  const visible = q ? nodes.filter((n) => n.matched) : nodes;
  const nothingTranscribed = spoken.every((m) => !m.transcript);

  /** 默认只展开当前聚焦的那份;搜索时改成「有命中就展开」,素材和段落再多也不会一屏全铺开 */
  const isOpen = (n: CaptionNode) =>
    q ? (searchOpenMap[n.media.id] ?? n.rows.length > 0) : (openMap[n.media.id] ?? n.media.id === focusId);

  const setOpen = (id: string, open: boolean) => {
    const set = q ? setSearchOpenMap : setOpenMap;
    set((prev) => ({ ...prev, [id]: open }));
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {nothingTranscribed && !q && (
        <div className="flex-none px-2 py-1.5 text-[11px] text-neutral-500 border-b border-neutral-800">
          还没有字幕。点开下面的素材开始转写,或用工具栏的「+」导入 .srt。
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto pc-l-scroll" role="tree">
        {visible.length === 0 ? (
          <div className="p-4 text-center text-xs text-neutral-500">没有匹配的字幕</div>
        ) : (
          visible.map((node) => (
            <MediaNode
              key={node.media.id}
              node={node}
              open={isOpen(node)}
              focused={node.media.id === focusId}
              filtering={q.length > 0}
              project={project}
              t={t}
              retranscribing={retranscribeId === node.media.id}
              onToggle={(open) => {
                // 展开/点父节点也要认领焦点,导入 srt 才知道该挂到谁身上
                onPick(node.media.id);
                setOpen(node.media.id, open);
              }}
              onRetranscribe={() => {
                onPick(node.media.id);
                setRetranscribeId(node.media.id);
                setOpen(node.media.id, true);
              }}
              onCloseTranscribe={() => setRetranscribeId(null)}
              onPickSelf={() => onPick(node.media.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** 一个素材父节点:头一行是视频名 + 段数,展开后是它的段落(或转写面板) */
function MediaNode({
  node,
  open,
  focused,
  filtering,
  project,
  t,
  retranscribing,
  onToggle,
  onRetranscribe,
  onCloseTranscribe,
  onPickSelf,
}: {
  node: CaptionNode;
  open: boolean;
  focused: boolean;
  filtering: boolean;
  project: Project;
  t: number;
  retranscribing: boolean;
  onToggle: (open: boolean) => void;
  onRetranscribe: () => void;
  onCloseTranscribe: () => void;
  onPickSelf: () => void;
}) {
  const { media, rows, total } = node;
  const transcript = media.transcript;
  // 没转写的素材展开就直接给转写面板,原来那个入口不丢
  const showPanel = !transcript || retranscribing;

  const count = filtering && rows.length !== total ? `${rows.length}/${total} 段` : `${total} 段`;

  return (
    <div className="border-b border-neutral-800/60" role="treeitem" aria-expanded={open}>
      <button
        type="button"
        data-pc-caption-media={media.id}
        className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-xs ${
          focused ? "bg-neutral-800/60 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800/40"
        }`}
        onClick={() => onToggle(!open)}
        title={media.name}
      >
        <svg
          className={`shrink-0 text-neutral-500 ${open ? "rotate-90" : ""}`}
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden="true"
        >
          <path d="M3.5 1.5 L7 5 L3.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="shrink-0 text-neutral-500" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M7 15h7M7 11h4" />
          </svg>
        </span>
        <span className="flex-1 truncate">{media.name}</span>
        <span className="shrink-0 tabular-nums text-[10px] text-neutral-500">
          {transcript ? count : "未转写"}
          {media.duration ? ` · ${fmt(media.duration)}` : ""}
        </span>
      </button>

      {open &&
        (showPanel ? (
          <div className="p-2 pl-5">
            <TranscribePanel mediaId={media.id} onClose={onCloseTranscribe} />
          </div>
        ) : (
          <div role="group">
            <div className="flex items-center gap-2 pl-5 pr-2 py-1 text-[10px] text-neutral-500">
              <span className="truncate">
                {transcript.engine} · {transcript.model}
                {transcript.language ? ` · ${transcript.language}` : ""}
              </span>
              <button
                type="button"
                className="ml-auto shrink-0 h-5 px-1.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-600"
                onClick={onRetranscribe}
              >
                重新转写
              </button>
            </div>
            {rows.length === 0 ? (
              <div className="pl-5 pr-2 pb-1.5 text-[11px] text-neutral-600">这份转写里没有匹配的段落</div>
            ) : (
              <div className="pb-1">
                {rows.map(({ seg, index }) => {
                  const tl = timelineTimeOf(project, media.id, seg.start);
                  const active = tl != null && t >= tl && t < tl + Math.max(0.1, seg.end - seg.start);
                  return (
                    <button
                      key={index}
                      type="button"
                      data-pc-caption-seg={index}
                      className={`w-full text-left flex gap-2 pl-5 pr-2 py-1 text-xs ${
                        active ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800/60"
                      } ${tl == null ? "opacity-50" : ""}`}
                      title={tl == null ? "这段素材还没放到时间轴上" : "点一下把播放头挪过去"}
                      onClick={() => {
                        onPickSelf();
                        if (tl != null) actions.seek(tl);
                      }}
                    >
                      <span className="shrink-0 tabular-nums text-neutral-500 w-10">{fmt(seg.start)}</span>
                      <span className="flex-1 whitespace-pre-wrap break-words">{seg.text}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 素材内的秒 → 时间轴上的秒(找引用它的片段,按 mediaOffset 换算);没放上时间轴就返回 null */
function timelineTimeOf(p: Project, mediaId: string, mediaSec: number): number | null {
  for (const tr of p.tracks) {
    for (const c of tr.clips) {
      if (c.mediaId !== mediaId) continue;
      const tl = c.start + (mediaSec - (c.mediaOffset ?? 0));
      if (tl >= c.start - 1e-6 && tl < c.end) return tl;
    }
  }
  return null;
}
