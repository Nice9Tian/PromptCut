import { useMemo, useState } from "react";
import { actions, useStore } from "../../store/project";
import type { Project, TrackClip } from "../../kernel/project";

/**
 * 转场分页。
 *
 * 这个模型里没有「转场对象」:两段素材在时间上重叠、各自带淡出淡入,就是交叉溶解。
 * 所以这一页做的事是「把两段素材接成一个转场」,而不是往时间轴上丢一个转场片段。
 *
 * 同一条序列内不允许重叠,所以交叉溶解必然发生在两条序列之间——
 * 这里会自动把后一段挪到另一条序列上并往前拉出重叠,再给两边加淡化。
 */

const DURATIONS = [0.3, 0.5, 1, 1.5, 2];

/** 时间上相邻(或已重叠)的两段素材,按先后给出 */
function findPairs(p: Project): Array<{ a: TrackClip; aTrack: string; b: TrackClip; bTrack: string }> {
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
  const pairs: Array<{ a: TrackClip; aTrack: string; b: TrackClip; bTrack: string }> = [];
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i];
    const b = all[i + 1];
    // 只认「首尾相接」或已经重叠的:差得太远就不是一个转场点
    if (b.clip.start - a.clip.end > 0.001) continue;
    pairs.push({ a: a.clip, aTrack: a.trackId, b: b.clip, bTrack: b.trackId });
  }
  return pairs;
}

export function TransitionsTab() {
  const project = useStore((s) => s.project);
  const [dur, setDur] = useState(0.5);
  const [msg, setMsg] = useState<string | null>(null);

  const pairs = useMemo(() => findPairs(project), [project]);
  const nameOf = (c: TrackClip) => project.media.find((m) => m.id === c.mediaId)?.name ?? "素材";

  const apply = (pair: { a: TrackClip; aTrack: string; b: TrackClip; bTrack: string }) => {
    const ok = actions.applyCrossfade(pair.a.id, pair.b.id, dur);
    setMsg(ok ? `已加 ${dur}s 交叉溶解` : "这两段没法重叠(相邻序列被占满了),先手动挪一下");
    window.setTimeout(() => setMsg(null), 2500);
  };

  const clear = (pair: { a: TrackClip; b: TrackClip }) => {
    actions.updateClip(pair.a.id, { fadeOut: 0 });
    actions.updateClip(pair.b.id, { fadeIn: 0 });
    setMsg("已取消这处转场的淡化");
    window.setTimeout(() => setMsg(null), 2000);
  };

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

      <div className="flex-1 overflow-y-auto pc-l-scroll p-2 space-y-2">
        {pairs.length === 0 && (
          <div className="text-xs text-neutral-500 leading-relaxed">
            没有找到相接的两段素材。
            <br />
            把两段视频前后接在时间轴上,这里就会列出它们的衔接点。
          </div>
        )}

        {pairs.map((pair, i) => {
          const has = (pair.a.fadeOut ?? 0) > 0 || (pair.b.fadeIn ?? 0) > 0;
          return (
            <div key={i} className="rounded border border-neutral-800 bg-neutral-900 p-2">
              <div className="text-xs text-neutral-200 truncate">
                {nameOf(pair.a)} → {nameOf(pair.b)}
              </div>
              <div className="text-[11px] text-neutral-500 tabular-nums mt-0.5">
                衔接于 {pair.a.end.toFixed(1)}s
                {has && ` · 已有 ${(pair.a.fadeOut ?? pair.b.fadeIn ?? 0).toFixed(1)}s 交叉溶解`}
              </div>
              <div className="flex gap-1.5 mt-2">
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
            </div>
          );
        })}
      </div>

      {msg && <div className="flex-none px-2 py-1.5 text-[11px] text-neutral-400 border-t border-neutral-800">{msg}</div>}
    </div>
  );
}
