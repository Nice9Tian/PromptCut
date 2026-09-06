import { useEffect, useState } from "react";
import { actions, useStore } from "../../store/project";
import type { Project } from "../../kernel/project";
import { TranscribePanel } from "./TranscribePanel";

/**
 * 素材 → 字幕: 某个素材的语音转文字结果。
 * 支持按文本搜索字幕片段，点一段把播放头挪到时间轴上对应的位置。
 */
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
  const [transcribing, setTranscribing] = useState(false);

  const media = project.media.find((m) => m.id === mediaId) ?? project.media[0] ?? null;
  useEffect(() => {
    // 选中的素材被删了就退回第一条
    if (mediaId && !project.media.some((m) => m.id === mediaId)) onPick(project.media[0]?.id ?? null);
  }, [mediaId, project.media, onPick]);

  if (project.media.length === 0) {
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

  const transcript = media?.transcript;

  const filteredSegments = transcript?.segments
    ? transcript.segments
        .map((seg, originalIndex) => ({ seg, originalIndex }))
        .filter(({ seg }) => {
          if (!search.trim()) return true;
          return seg.text.toLowerCase().includes(search.trim().toLowerCase());
        })
    : [];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 选哪条素材 */}
      {project.media.length > 1 && (
        <div className="flex-none flex gap-1 overflow-x-auto px-2 py-1.5 border-b border-neutral-800 pc-l-scroll">
          {project.media.map((m) => (
            <button
              key={m.id}
              data-pc-caption-media={m.id}
              className={`shrink-0 max-w-[140px] truncate rounded px-1.5 h-6 text-[11px] border ${
                m.id === media?.id
                  ? "border-neutral-500 bg-neutral-800 text-neutral-100"
                  : "border-neutral-800 text-neutral-400 hover:text-neutral-200 hover:border-neutral-700"
              }`}
              onClick={() => onPick(m.id)}
              title={m.name}
            >
              {m.transcript ? "✓ " : ""}
              {m.name}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto pc-l-scroll">
        {!media ? null : !transcript || transcribing ? (
          <div className="p-2">
            <TranscribePanel mediaId={media.id} onClose={() => setTranscribing(false)} />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-neutral-500 border-b border-neutral-800">
              <span className="text-neutral-300">{transcript.segments.length} 段</span>
              <span className="truncate">
                {transcript.engine} · {transcript.model}
                {transcript.language ? ` · ${transcript.language}` : ""}
              </span>
              <button
                className="ml-auto shrink-0 h-5 px-1.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-600"
                onClick={() => setTranscribing(true)}
              >
                重新转写
              </button>
            </div>
            {filteredSegments.length === 0 ? (
              <div className="p-4 text-center text-xs text-neutral-500">没有匹配的字幕</div>
            ) : (
              <div className="py-1">
                {filteredSegments.map(({ seg, originalIndex }) => {
                  const tl = timelineTimeOf(project, media.id, seg.start);
                  const active = tl != null && t >= tl && t < tl + Math.max(0.1, seg.end - seg.start);
                  return (
                    <button
                      key={originalIndex}
                      data-pc-caption-seg={originalIndex}
                      className={`w-full text-left flex gap-2 px-2 py-1 text-xs ${
                        active ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800/60"
                      } ${tl == null ? "opacity-50" : ""}`}
                      title={tl == null ? "这段素材还没放到时间轴上" : "点一下把播放头挪过去"}
                      onClick={() => {
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
          </>
        )}
      </div>
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
