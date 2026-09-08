import { useMemo, useState } from "react";
import { actions, useStore } from "../../store/project";
import type { Project, TrackClip } from "../../kernel/project";
import { describeEmphasis, EMPHASIS_DEFAULTS, EMPHASIS_LABEL, type ClipEmphasis, type EmphasisKind } from "../../kernel/emphasis";
import { clearDragPayload, MIME_EMPHASIS, setDragPayload } from "../dnd";
import { PreviewCard } from "./PreviewCard";

/**
 * 强调分页:给片段加「阴影」或「描边」。
 *
 * 两种都**沿着画面里不透明部分的边缘**走(CSS drop-shadow 按 alpha 算),所以描的是
 * 文字、图形、抠像的边,不是那个方框 —— 透明底的卡片描出来才好看(kernel/emphasis.ts)。
 *
 * 用法两条:把卡拖到时间轴上某一段上,或者选中片段后点一下。下面列出已经加了强调的片段,
 * 每条都能去掉。粗细和颜色在上面选,选完再拖 / 再点。
 */

/** 粗细:三档就够了,真要精确数值让 Agent 或参数页去调 */
const SIZES: { key: string; label: string; shadow: number; outline: number }[] = [
  { key: "s", label: "细", shadow: 10, outline: 3 },
  { key: "m", label: "中", shadow: 18, outline: 6 },
  { key: "l", label: "粗", shadow: 30, outline: 12 },
];

/** 颜色:黑白之外给一个主题强调色,描边用它做「发光边」很常用 */
const COLORS: { key: string; label: string; css: string }[] = [
  { key: "black", label: "黑", css: "#000000" },
  { key: "white", label: "白", css: "#ffffff" },
  { key: "accent", label: "强调色", css: "var(--ui-accent, #00dbdb)" },
];

/** 卡面上的示意图:一块透明底上的图形 + 该有的阴影 / 描边,一眼看出两者的区别 */
function EmphasisGlyph({ kind, color, size }: { kind: EmphasisKind; color: string; size: number }) {
  // 示意图是 100×100 的坐标系,舞台像素换算过来大约除以 12
  const px = Math.max(1.5, size / 12);
  const filter =
    kind === "shadow"
      ? `drop-shadow(0 ${px}px ${px * 1.6}px ${color})`
      : [0, 45, 90, 135, 180, 225, 270, 315]
          .map((deg) => {
            const a = (deg * Math.PI) / 180;
            return `drop-shadow(${(Math.cos(a) * px).toFixed(2)}px ${(Math.sin(a) * px).toFixed(2)}px 0 ${color})`;
          })
          .join(" ");
  return (
    <svg viewBox="0 0 100 100" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} aria-hidden="true">
      {/* 透明底:格子隐约透出来,说明「底是透的,描的是图形的边」 */}
      <g style={{ filter }}>
        <text x="50" y="46" textAnchor="middle" fontSize="30" fontWeight="700" fill="var(--ui-fg, #fff)">A a</text>
        <circle cx="50" cy="70" r="11" fill="var(--ui-track-video, #4FB3C9)" />
      </g>
    </svg>
  );
}

/** 时间轴上已经加了强调的片段 */
function withEmphasis(p: Project): Array<{ clip: TrackClip; trackName: string }> {
  const out: Array<{ clip: TrackClip; trackName: string }> = [];
  for (const tr of p.tracks) {
    for (const c of tr.clips) if (c.emphasis) out.push({ clip: c, trackName: tr.name });
  }
  return out.sort((a, b) => a.clip.start - b.clip.start);
}

export function EmphasisTab() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const [sizeKey, setSizeKey] = useState("m");
  const [colorKey, setColorKey] = useState("black");
  const [msg, setMsg] = useState<string | null>(null);

  const size = SIZES.find((s) => s.key === sizeKey) ?? SIZES[1];
  const color = COLORS.find((c) => c.key === colorKey) ?? COLORS[0];
  const marked = useMemo(() => withEmphasis(project), [project]);

  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(null), 2600);
  };

  const buildEmphasis = (kind: EmphasisKind): ClipEmphasis => ({
    kind,
    color: color.css,
    size: kind === "shadow" ? size.shadow : size.outline,
    opacity: EMPHASIS_DEFAULTS[kind].opacity,
    dx: EMPHASIS_DEFAULTS[kind].dx,
    dy: kind === "shadow" ? Math.round(size.shadow * 0.45) : 0,
  });

  const clickKind = (kind: EmphasisKind) => {
    const clipId = selection[0];
    if (!clipId) {
      flash(`先在时间轴上选中一个片段,再点${EMPHASIS_LABEL[kind]};也可以直接把卡拖到那一段上`);
      return;
    }
    const r = actions.setClipEmphasis(clipId, buildEmphasis(kind));
    flash(r.ok ? `已加${EMPHASIS_LABEL[kind]}:${describeEmphasis(r.emphasis)}` : (r.error ?? "加不上"));
  };

  const drag = (kind: EmphasisKind) => (e: React.DragEvent) => {
    e.dataTransfer.setData(MIME_EMPHASIS, kind);
    e.dataTransfer.effectAllowed = "copy";
    setDragPayload({ kind: "emphasis", emphasis: buildEmphasis(kind), name: EMPHASIS_LABEL[kind], duration: 0 });
  };

  const nameOf = (c: TrackClip) =>
    c.label || project.media.find((m) => m.id === c.mediaId)?.name || c.cardId || c.id;

  return (
    <div className="flex-1 min-h-0 flex flex-col pc-l-scroll">
      <div className="flex-none px-2 py-2 border-b border-neutral-800 space-y-2">
        <div>
          <div className="text-[11px] text-neutral-500 mb-1.5">粗细</div>
          <div className="flex gap-1">
            {SIZES.map((s) => (
              <button
                key={s.key}
                onClick={() => setSizeKey(s.key)}
                className={`px-2 py-1 rounded text-[11px] border transition-colors ${
                  sizeKey === s.key
                    ? "border-neutral-400 bg-neutral-800 text-neutral-100"
                    : "border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-700"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-neutral-500 mb-1.5">颜色</div>
          <div className="flex gap-1.5 items-center">
            {COLORS.map((c) => (
              <button
                key={c.key}
                title={c.label}
                onClick={() => setColorKey(c.key)}
                className={`w-6 h-6 rounded border transition-colors ${
                  colorKey === c.key ? "border-neutral-300" : "border-neutral-700 hover:border-neutral-500"
                }`}
                style={{ background: c.css }}
              />
            ))}
            <span className="text-[11px] text-neutral-500 ml-1">{color.label}</span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pc-l-scroll">
        <div className="pc-l-grid">
          {(["shadow", "outline"] as const).map((kind) => (
            <PreviewCard
              key={kind}
              attrs={{ "data-pc-emphasis": kind }}
              title={EMPHASIS_LABEL[kind]}
              subtitle={`${kind === "shadow" ? size.shadow : size.outline}px · ${color.label}`}
              preview={<EmphasisGlyph kind={kind} color={color.css} size={kind === "shadow" ? size.shadow : size.outline} />}
              draggable
              onDragStart={drag(kind)}
              onDragEnd={clearDragPayload}
              onClick={() => clickKind(kind)}
              titleAttr={`拖到时间轴上某一段(或选中片段后点一下)。${
                kind === "shadow" ? "阴影落在画面里不透明部分的下方" : "描边沿着不透明部分的边缘走一圈"
              }`}
            />
          ))}
        </div>

        <div className="px-2 pt-2 pb-3">
          <div className="text-[11px] uppercase tracking-wide text-neutral-500 px-1 py-1 flex justify-between">
            <span>已加强调</span>
            <span>({marked.length})</span>
          </div>
          {marked.length === 0 ? (
            <div className="px-1 text-[11.5px] text-neutral-500 leading-relaxed">
              还没有加过。把上面的卡拖到时间轴上任意一段,或选中一段再点卡。
              <br />
              两种都是沿着画面里不透明部分的边缘走的,所以透明底的卡片、抠好的人物效果最明显。
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {marked.map(({ clip, trackName }) => (
                <div key={clip.id} className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5">
                  <span className="flex-1 min-w-0 truncate text-[11.5px] text-neutral-200" title={`${trackName} · ${describeEmphasis(clip.emphasis)}`}>
                    {nameOf(clip)}
                    <span className="text-neutral-500"> · {describeEmphasis(clip.emphasis)}</span>
                  </span>
                  <button
                    type="button"
                    className="shrink-0 px-1.5 py-0.5 rounded text-[11px] border border-neutral-800 text-neutral-400 hover:text-neutral-100 hover:border-neutral-600"
                    onClick={() => {
                      actions.setClipEmphasis(clip.id, null);
                      flash("已去掉强调");
                    }}
                  >
                    去掉
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {msg && <div className="flex-none px-2 py-1.5 text-[11px] text-neutral-400 border-t border-neutral-800">{msg}</div>}
    </div>
  );
}
