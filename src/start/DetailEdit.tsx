/**
 * 「详细编辑」:拓展栏「画面」那一段的段头按钮点开它,展开占满整个聊天区(用户 2026-10-23 定)。
 * **输入框留在下面不收** —— 这正是它的用处:在这儿右键一张卡,把它引用进输入框,接着跟 Agent 说
 * 「这一张怎么怎么改」。
 *
 * 形状照软件里的编辑台(用户给的参考图):上面是舞台和一排传输控件,下面是时间轴 —— 一条条序列,
 * 序列上排卡片和素材,左边一列是序列名,右上角是行高(小 / 中 / 大)和缩放。
 *
 * **这一版只跑界面**:舞台是占位色块,时间轴是 `mockTimeline.ts` 里写死的,拖不动也改不了内容;
 * 真接上去时舞台接 `src/render/Stage`、时间轴接 store 里的当前项目(`src/kernel/types.ts` 的 `Timeline`)。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { hueOf } from "./hue";
import { TIMELINE_DURATION, clipsOf, quoteOf, type MockClip } from "./mockTimeline";

/** 行高三档,和软件里「小 / 中 / 大」一致 */
const ROW_H = { 小: 30, 中: 44, 大: 62 } as const;
type RowSize = keyof typeof ROW_H;

const secs = (t: number) => `${t.toFixed(2)} s`;

export function DetailEdit(props: {
  /** 取画面颜色用的种子:项目号或分组号 */
  seed: string;
  /** 进专业模式:切到 PromptCut 本来那套编辑界面(用户 2026-10-23 定名,名词见 `docs/plan/user-decisions-2026-10-23.md`) */
  onPro: () => void;
  onClose: () => void;
  /** 把一张卡引用进输入框 */
  onQuote: (text: string) => void;
}): JSX.Element {
  const clips = clipsOf(props.seed);
  const tracks = Math.max(2, ...clips.map((c) => c.track + 1));

  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [size, setSize] = useState<RowSize>("中");
  const [zoom, setZoom] = useState(1);
  const [picked, setPicked] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ clip: MockClip; x: number; y: number } | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) return;
    timer.current = window.setInterval(() => {
      setAt((t) => {
        const next = t + 0.1;
        if (next >= TIMELINE_DURATION) {
          setPlaying(false);
          return TIMELINE_DURATION;
        }
        return next;
      });
    }, 100);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
      timer.current = null;
    };
  }, [playing]);

  // 菜单开着时:按 Esc、点别处都关掉
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  const hue = hueOf(props.seed);
  /** 一秒多宽(像素):缩放乘上去 */
  const pxPerSec = 46 * zoom;

  return (
    <div className="ps-detail" data-pc="start-detail">
      <header className="ps-detail-head">
        <span className="ps-detail-title">详细编辑</span>
        <span className="ps-detail-sub">右键一张卡可以引用进下面的输入框</span>
        <span className="ps-rail-spacer" />
        {/*
          这一页是「Vibe 模式」——对着 Agent 说话、在这儿看一眼改一眼;
          点这个切到「专业模式」,也就是 PromptCut 本来那套编辑界面(素材库、舞台、时间轴、AI 栏)。
        */}
        <button
          type="button"
          className="ps-pro-btn"
          data-pc="start-enter-pro"
          title="切到 PromptCut 本来那套编辑界面（素材库、舞台、时间轴）"
          onClick={props.onPro}
        >
          进入专业模式
        </button>
        <button type="button" className="ps-ghost-btn" data-pc="start-detail-close" onClick={props.onClose}>
          收起
        </button>
      </header>

      <div className="ps-detail-stage">
        <div
          className="ps-detail-screen"
          style={{ background: `linear-gradient(145deg, hsl(${hue} 52% 38%), hsl(${(hue + 38) % 360} 48% 22%))` }}
        >
          {/* 四个角的取景框,和软件里的舞台一致 */}
          <span className="ps-detail-corner is-tl" aria-hidden="true" />
          <span className="ps-detail-corner is-tr" aria-hidden="true" />
          <span className="ps-detail-corner is-bl" aria-hidden="true" />
          <span className="ps-detail-corner is-br" aria-hidden="true" />
        </div>
      </div>

      <div className="ps-detail-transport">
        <button
          type="button"
          className="ps-detail-play"
          data-pc="start-detail-play"
          aria-label={playing ? "暂停" : "播放"}
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.6 19 12 7 19.4z" /></svg>
          )}
        </button>
        <button type="button" className="ps-ghost-btn" data-pc="start-detail-rewind" onClick={() => { setPlaying(false); setAt(0); }}>
          回到开头
        </button>
        <input
          type="range"
          className="ps-detail-scrub"
          data-pc="start-detail-scrub"
          min={0}
          max={TIMELINE_DURATION}
          step={0.1}
          value={at}
          aria-label="进度"
          onChange={(e) => setAt(Number(e.target.value))}
        />
        <span className="ps-detail-time">{secs(at)} / {secs(TIMELINE_DURATION)}</span>
      </div>

      <div className="ps-detail-tl">
        <div className="ps-detail-tlbar">
          <span className="ps-detail-tltitle">剪辑 1</span>
          <div className="ps-ext-seg" role="group" aria-label="行高">
            {(Object.keys(ROW_H) as RowSize[]).map((s) => (
              <button
                key={s}
                type="button"
                className="ps-ext-seg-btn"
                data-pc="start-detail-rowsize"
                aria-pressed={size === s}
                onClick={() => setSize(s)}
              >
                {s}
              </button>
            ))}
          </div>
          <span className="ps-muted">行高 {ROW_H[size]}px</span>
          <span className="ps-rail-spacer" />
          <label className="ps-detail-zoom">
            缩放
            <input
              type="range"
              min={0.5}
              max={2.5}
              step={0.1}
              value={zoom}
              data-pc="start-detail-zoom"
              aria-label="缩放"
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </label>
        </div>

        <div className="ps-detail-tracks">
          <div className="ps-detail-names">
            {Array.from({ length: tracks }, (_, i) => (
              <div key={i} className="ps-detail-name" style={{ height: ROW_H[size] }}>序列 {i + 1}</div>
            ))}
          </div>
          <div className="ps-detail-lanes" style={{ width: TIMELINE_DURATION * pxPerSec }}>
            {/* 播放头 */}
            <span className="ps-detail-playhead" style={{ left: at * pxPerSec }} aria-hidden="true" />
            {Array.from({ length: tracks }, (_, i) => (
              <div key={i} className="ps-detail-lane" style={{ height: ROW_H[size] }}>
                {clips.filter((c) => c.track === i).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="ps-detail-clip"
                    data-pc="start-detail-clip"
                    data-clip={c.id}
                    data-picked={picked === c.id || undefined}
                    data-kind={c.kind}
                    style={{ left: c.start * pxPerSec, width: Math.max(14, (c.end - c.start) * pxPerSec) }}
                    title={`${c.kind}：${c.name}（${c.start.toFixed(1)}–${c.end.toFixed(1)} s）`}
                    aria-label={`${c.kind} ${c.name}`}
                    onClick={() => setPicked(c.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setPicked(c.id);
                      setMenu({ clip: c, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <span className="ps-detail-clip-name">{c.name}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
        <p className="ps-ext-todo">
          待办：舞台接 src/render/Stage、时间轴接 store 里的当前项目；这一版拖不动、改不了内容。
        </p>
      </div>

      {menu && (
        <div className="ps-menu" role="menu" aria-label={`${menu.clip.name} 的操作`} data-pc="start-detail-menu" style={{ left: menu.x, top: menu.y }}>
          <div className="ps-menu-head">{menu.clip.kind}：{menu.clip.name}</div>
          <button
            type="button"
            className="ps-menu-item"
            data-pc="start-detail-quote"
            onClick={() => {
              props.onQuote(quoteOf(menu.clip));
              setMenu(null);
            }}
          >
            引用到输入框
          </button>
          <button type="button" className="ps-menu-item" title="待办：要接编辑器" onClick={() => setMenu(null)}>
            在编辑器里打开
          </button>
        </div>
      )}
    </div>
  );
}
