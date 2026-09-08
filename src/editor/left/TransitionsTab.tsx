import { useMemo, useState } from "react";
import { actions, useStore } from "../../store/project";
import type { MediaAsset, Project, TrackClip } from "../../kernel/project";
import { PreviewCard } from "./PreviewCard";

/**
 * 转场分页。
 *
 * 这个模型里没有「转场对象」:两段素材在时间上重叠、各自带淡出淡入,就是交叉溶解。
 * 所以这一页做的事是「把两段素材接成一个转场」,而不是往时间轴上丢一个转场片段。
 *
 * 同一条序列内不允许重叠,所以交叉溶解必然发生在两条序列之间——
 * 这里会自动把后一段挪到另一条序列上并往前拉出重叠,再给两边加淡化。
 *
 * 每个衔接点一张方形预览卡(和卡片 / 视频 / 图像同一个 PreviewCard):前后两段素材
 * 的画面叠在一起,悬停时按当前选的时长来回交叉溶解,先看效果再决定加不加。
 */

const DURATIONS = [0.3, 0.5, 1, 1.5, 2];

type Pair = { a: TrackClip; aTrack: string; b: TrackClip; bTrack: string };

/** 时间上相邻(或已重叠)的两段素材,按先后给出 */
function findPairs(p: Project): Pair[] {
  const all: Array<{ clip: TrackClip; trackId: string }> = [];
  for (const tr of p.tracks) {
    for (const c of tr.clips) {
      if (!c.mediaId) continue;
      const m = p.media.find((x) => x.id === c.mediaId);
      if (!m || m.kind === "audio") continue; // 声音不做转场
      all.push({ clip: c, trackId: tr.id });
    }
  }
  all.sort((x, y) => x.clip.start - y.clip.start);
  const pairs: Pair[] = [];
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i];
    const b = all[i + 1];
    // 只认「首尾相接」或已经重叠的:差得太远就不是一个转场点
    if (b.clip.start - a.clip.end > 0.001) continue;
    pairs.push({ a: a.clip, aTrack: a.trackId, b: b.clip, bTrack: b.trackId });
  }
  return pairs;
}

/** 一段素材的静态画面:图片直接放,视频取首帧(不播,转场卡只看溶解) */
function Still({ media, className, style }: { media: MediaAsset | undefined; className?: string; style?: React.CSSProperties }) {
  if (!media) return <div className={className} style={{ ...style, background: "var(--ui-panel-2)" }} />;
  if (media.kind === "image") return <img src={media.url} alt="" draggable={false} className={className} style={style} />;
  return <video src={media.url} muted playsInline preload="metadata" draggable={false} className={className} style={style} />;
}

export function TransitionsTab() {
  const project = useStore((s) => s.project);
  const [dur, setDur] = useState(0.5);
  const [msg, setMsg] = useState<string | null>(null);
  const [hotIndex, setHotIndex] = useState<number | null>(null);

  const pairs = useMemo(() => findPairs(project), [project]);
  const mediaOf = (c: TrackClip) => project.media.find((m) => m.id === c.mediaId);
  const nameOf = (c: TrackClip) => mediaOf(c)?.name ?? "素材";

  const apply = (pair: Pair) => {
    const ok = actions.applyCrossfade(pair.a.id, pair.b.id, dur);
    setMsg(ok ? `已加 ${dur}s 交叉溶解` : "这两段没法重叠(相邻序列被占满了),先手动挪一下");
    window.setTimeout(() => setMsg(null), 2500);
  };

  const clear = (pair: Pair) => {
    actions.updateClip(pair.a.id, { fadeOut: 0 });
    actions.updateClip(pair.b.id, { fadeIn: 0 });
    setMsg("已取消这处转场的淡化");
    window.setTimeout(() => setMsg(null), 2000);
  };

  const layer: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" };

  return (
    <div className="flex-1 min-h-0 flex flex-col pc-l-scroll">
      <div className="flex-none px-2 py-2 border-b border-neutral-800">
        <div className="text-[11px] text-neutral-500 mb-1.5">转场时长</div>
        <div className="flex gap-1">
          {DURATIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDur(d)}
              className={`px-2 py-1 rounded text-[11px] border transition-colors ${
                dur === d
                  ? "border-neutral-400 bg-neutral-800 text-neutral-100"
                  : "border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-700"
              }`}
            >
              {d}s
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pc-l-scroll">
        {pairs.length === 0 && (
          <div className="p-2 text-xs text-neutral-500 leading-relaxed">
            没有找到相接的两段素材。
            <br />
            把两段视频前后接在时间轴上,这里就会列出它们的衔接点。
          </div>
        )}

        {pairs.length > 0 && (
          <div className="pc-l-grid">
            {pairs.map((pair, i) => {
              const has = (pair.a.fadeOut ?? 0) > 0 || (pair.b.fadeIn ?? 0) > 0;
              const existing = (pair.a.fadeOut ?? pair.b.fadeIn ?? 0).toFixed(1);
              const hot = hotIndex === i;
              // 悬停时后一段压在前一段上来回淡入淡出,周期 = 当前选的转场时长(往返各一次)
              const fadeStyle: React.CSSProperties = hot
                ? { ...layer, animation: `pc-xfade ${Math.max(0.3, dur) * 2}s ease-in-out infinite` }
                : { ...layer, opacity: 0 };
              return (
                <PreviewCard
                  key={`${pair.a.id}-${pair.b.id}`}
                  title={`${nameOf(pair.a)} → ${nameOf(pair.b)}`}
                  subtitle={`衔接于 ${pair.a.end.toFixed(1)}s${has ? ` · 已有 ${existing}s 溶解` : ""}`}
                  onHover={(v) => setHotIndex(v ? i : (cur) => (cur === i ? null : cur))}
                  preview={
                    <>
                      <Still media={mediaOf(pair.a)} style={layer} />
                      <Still media={mediaOf(pair.b)} style={fadeStyle} />
                    </>
                  }
                  titleAttr="悬停预览交叉溶解"
                  footer={
                    <div className="pc-pcard-foot">
                      <button
                        className="px-2 py-1 rounded text-[11px] border border-neutral-700 bg-neutral-800 hover:border-neutral-500 text-neutral-200"
                        onClick={() => apply(pair)}
                      >
                        {has ? "重设交叉溶解" : "加交叉溶解"}
                      </button>
                      {has && (
                        <button
                          className="px-2 py-1 rounded text-[11px] border border-neutral-800 hover:border-neutral-600 text-neutral-400"
                          onClick={() => clear(pair)}
                        >
                          取消
                        </button>
                      )}
                    </div>
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      {msg && <div className="flex-none px-2 py-1.5 text-[11px] text-neutral-400 border-t border-neutral-800">{msg}</div>}
    </div>
  );
}
