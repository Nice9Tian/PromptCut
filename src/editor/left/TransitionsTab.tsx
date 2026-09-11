import { useMemo, useState } from "react";
import { actions, useStore } from "../../store/project";
import type { MediaAsset, Project, TrackClip } from "../../kernel/project";
import {
  describeTransition, transitionsOf, transitionsOfClip, TRANSITION_LABEL,
  type TransitionKind,
} from "../../kernel/transitions";
import { clearDragPayload, MIME_TRANSITION, setDragPayload } from "../dnd";
import { PreviewCard } from "./PreviewCard";
import { FiltersSection } from "./FiltersSection";

/**
 * 转场分页。
 *
 * 转场是**对象**:加一处就在项目里落一条记录,把它引用的片段绑成一组 —— 那几段的相对
 * 时间关系锁住,想单独挪、改长度、切开,得先删转场(规矩在 kernel/transitions.ts)。
 *
 * 这一页三件事:
 *   1. 上面三张卡是转场本身,拖到时间轴上 —— 拖到两段首尾相接处 = 交叉溶解,
 *      拖到一段的开头 / 结尾 = 淡入 / 淡出。选中片段时点一下也能直接加;
 *   2. 中间列出**已有的转场**,每条都能删(删完那几段就解锁);
 *   3. 下面照旧列出时间轴上首尾相接的接缝,一键接成交叉溶解。
 *
 * 同一条序列内不允许重叠,所以交叉溶解会把后一段往前拉、必要时挪到另一条序列;
 * 删转场时再尽量放回去。
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
      if (!m) continue;
      // 声音也算:两段音乐重叠 + 各自淡化就是听得见的交叉淡入淡出,和画面同一套做法
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

/** 一段素材的静态画面:图片直接放,视频取首帧,声音没有画面就给一块底色(转场卡只看溶解,不播) */
function Still({ media, style }: { media: MediaAsset | undefined; style?: React.CSSProperties }) {
  if (!media) return <div style={{ ...style, background: "var(--ui-panel-2)" }} />;
  if (media.kind === "audio") {
    return (
      <div style={{ ...style, background: "var(--ui-panel-2)", display: "grid", placeItems: "center", color: "var(--ui-fg-faint)", fontSize: 10 }}>
        声音
      </div>
    );
  }
  if (media.kind === "image") return <img src={media.url} alt="" draggable={false} style={style} />;
  return <video src={media.url} muted playsInline preload="metadata" draggable={false} style={style} />;
}

const layer: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" };

/** 三张转场卡的示意图:两块色带 + 渐变,一眼看出是「叠着化过去」还是「从黑里出来」 */
function TransitionGlyph({ kind }: { kind: TransitionKind }) {
  const A = "var(--ui-accent)";
  const B = "var(--ui-track-video, #4FB3C9)";
  if (kind === "crossfade") {
    return (
      <svg viewBox="0 0 100 100" style={{ ...layer }} aria-hidden="true">
        <rect x="6" y="26" width="52" height="48" rx="4" fill={B} opacity="0.85" />
        <rect x="42" y="26" width="52" height="48" rx="4" fill={A} opacity="0.85" />
        <defs>
          <linearGradient id="pc-xf" x1="0" x2="1">
            <stop offset="0%" stopColor="#000" stopOpacity="0.55" />
            <stop offset="50%" stopColor="#000" stopOpacity="0" />
            <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
          </linearGradient>
        </defs>
        <rect x="42" y="26" width="16" height="48" fill="url(#pc-xf)" />
      </svg>
    );
  }
  const dir = kind === "fadeIn" ? { x1: "0", x2: "1" } : { x1: "1", x2: "0" };
  return (
    <svg viewBox="0 0 100 100" style={{ ...layer }} aria-hidden="true">
      <defs>
        <linearGradient id={`pc-${kind}`} {...dir}>
          <stop offset="0%" stopColor={A} stopOpacity="0.05" />
          <stop offset="100%" stopColor={A} stopOpacity="0.95" />
        </linearGradient>
      </defs>
      <rect x="6" y="26" width="88" height="48" rx="4" fill={`url(#pc-${kind})`} />
    </svg>
  );
}

const KIND_HINT: Record<TransitionKind, string> = {
  crossfade: "拖到两段首尾相接的地方;两段会绑成一组",
  fadeIn: "拖到一段的开头(或选中片段后点一下)",
  fadeOut: "拖到一段的结尾(或选中片段后点一下)",
};

export function TransitionsTab() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const [dur, setDur] = useState(0.5);
  const [msg, setMsg] = useState<string | null>(null);
  const [hotIndex, setHotIndex] = useState<number | null>(null);

  const pairs = useMemo(() => findPairs(project), [project]);
  const transitions = transitionsOf(project);
  const mediaOf = (c: TrackClip) => project.media.find((m) => m.id === c.mediaId);
  const nameOf = (c: TrackClip) => mediaOf(c)?.name ?? "素材";

  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(null), 2600);
  };

  const apply = (pair: Pair) => {
    const r = actions.addTransition({ kind: "crossfade", clipId: pair.a.id, otherClipId: pair.b.id, dur });
    flash(r.ok ? `已加 ${dur}s 交叉溶解,这两段现在是一组` : r.error);
  };

  /** 点卡片:淡入淡出加在选中的片段上;交叉溶解要两段,让用户去拖或用下面的接缝列表 */
  const clickKind = (kind: TransitionKind) => {
    if (kind === "crossfade") {
      flash("交叉溶解要两段:把这张卡拖到时间轴上两段相接的地方,或用下面的接缝列表");
      return;
    }
    const clipId = selection[0];
    if (!clipId) {
      flash(`先在时间轴上选中一个片段,再点${TRANSITION_LABEL[kind]};也可以直接把卡拖到片段的${kind === "fadeIn" ? "开头" : "结尾"}`);
      return;
    }
    const r = actions.addTransition({ kind, clipId, dur });
    flash(r.ok ? `已加 ${dur}s ${TRANSITION_LABEL[kind]}` : r.error);
  };

  const drop = (kind: TransitionKind) => (e: React.DragEvent) => {
    e.dataTransfer.setData(MIME_TRANSITION, kind);
    e.dataTransfer.effectAllowed = "copy";
    setDragPayload({ kind: "transition", transition: kind, name: TRANSITION_LABEL[kind], duration: dur });
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

      <div className="flex-1 overflow-y-auto pc-l-scroll">
        {/* 三张转场卡:拖到时间轴上 */}
        <div className="pc-l-grid">
          {(["crossfade", "fadeIn", "fadeOut"] as const).map((kind) => (
            <PreviewCard
              key={kind}
              attrs={{ "data-pc-transition": kind }}
              title={TRANSITION_LABEL[kind]}
              subtitle={`${dur}s`}
              preview={<TransitionGlyph kind={kind} />}
              draggable
              onDragStart={drop(kind)}
              onDragEnd={clearDragPayload}
              onClick={() => clickKind(kind)}
              titleAttr={KIND_HINT[kind]}
            />
          ))}
        </div>

        {/* 已经加上的转场:每条都能删,删完那几段就解锁 */}
        {transitions.length > 0 && (
          <div className="px-2 pt-2">
            <div className="text-[11px] uppercase tracking-wide text-neutral-500 px-1 py-1 flex justify-between">
              <span>已有转场</span>
              <span>({transitions.length})</span>
            </div>
            <div className="flex flex-col gap-1">
              {transitions.map((tr) => (
                <div key={tr.id} className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5">
                  <span className="flex-1 min-w-0 truncate text-[11.5px] text-neutral-200" title={describeTransition(project, tr)}>
                    {describeTransition(project, tr)}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 px-1.5 py-0.5 rounded text-[11px] border border-neutral-800 text-neutral-400 hover:text-neutral-100 hover:border-neutral-600"
                    title="删掉这处转场,相关片段解锁"
                    onClick={() => {
                      const r = actions.removeTransition(tr.id);
                      flash(r.ok ? `已删掉转场${r.note ? `(${r.note})` : ",相关片段解锁了"}` : r.error);
                    }}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 滤镜库:项目级,Agent 建的和以后人建的都在这里,能挂到选中的片段上复用 */}
        <FiltersSection flash={flash} />

        {/* 时间轴上首尾相接的接缝:一键接成交叉溶解 */}
        <div className="px-2 pt-2 pb-3">
          <div className="text-[11px] uppercase tracking-wide text-neutral-500 px-1 py-1">相接的两段</div>
          {pairs.length === 0 ? (
            <div className="px-1 text-[11.5px] text-neutral-500 leading-relaxed">
              没有找到相接的两段素材。
              <br />
              把两段视频前后接在时间轴上,这里就会列出它们的衔接点。
            </div>
          ) : (
            <div className="pc-l-grid" style={{ padding: "4px 0" }}>
              {pairs.map((pair, i) => {
                const has = transitionsOfClip(project, pair.a.id).some((tr) => tr.kind === "crossfade" && tr.bId === pair.b.id);
                const hot = hotIndex === i;
                // 悬停时后一段在前一段上来回淡入淡出,周期 = 当前选的转场时长(往返各一次)
                const fadeStyle: React.CSSProperties = hot
                  ? { ...layer, animation: `pc-xfade ${Math.max(0.3, dur) * 2}s ease-in-out infinite` }
                  : { ...layer, opacity: 0 };
                return (
                  <PreviewCard
                    key={`${pair.a.id}-${pair.b.id}`}
                    title={`${nameOf(pair.a)} → ${nameOf(pair.b)}`}
                    subtitle={has ? `已是一组 · ${pair.a.end.toFixed(1)}s` : `衔接于 ${pair.a.end.toFixed(1)}s`}
                    onHover={(v) => setHotIndex(v ? i : (cur) => (cur === i ? null : cur))}
                    preview={
                      <>
                        <Still media={mediaOf(pair.a)} style={layer} />
                        <Still media={mediaOf(pair.b)} style={fadeStyle} />
                      </>
                    }
                    titleAttr={has ? "这两段已经用交叉溶解绑成一组" : "悬停预览交叉溶解;点下面的按钮加上"}
                    footer={
                      <div className="pc-pcard-foot">
                        <button
                          className="px-2 py-1 rounded text-[11px] border border-neutral-700 bg-neutral-800 hover:border-neutral-500 text-neutral-200 disabled:opacity-40"
                          disabled={has}
                          onClick={() => apply(pair)}
                        >
                          {has ? "已加转场" : "加交叉溶解"}
                        </button>
                      </div>
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {msg && <div className="flex-none px-2 py-1.5 text-[11px] text-neutral-400 border-t border-neutral-800">{msg}</div>}
    </div>
  );
}
