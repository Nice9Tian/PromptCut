/**
 * 「详细编辑」:拓展栏「画面」那一段的段头按钮点开它,展开占满整个聊天区(用户 2026-10-23 定)。
 * **输入框留在下面不收** —— 这正是它的用处:在这儿右键一张卡,把它引用进输入框,接着跟 Agent 说
 * 「这一张怎么怎么改」。
 *
 * 形状照软件里的编辑台(用户给的参考图):上面是舞台和一排传输控件,下面是时间轴 —— 一条条序列,
 * 序列上排卡片和素材,左边一列是序列名,右上角是行高(小 / 中 / 大)和缩放。
 *
 * 2026-10-23 接上业务层:舞台是这个项目的真画面(`VibeStage.tsx`),时间轴读 store 里当前项目的当前剪辑
 * (`Project.tracks`)。**只看不改**(用户定):点选、拖播放头、播放暂停都行,片段拖不动、改不了;要自己动手就「进入传统式」。
 * 引用进输入框的写法和编辑器「引用到 AI」同一个(`@卡片 名字(片段 id)`,`src/mobile/agentView.ts` 的 `quoteToken`),Agent 认得。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { TrackClip } from "../kernel/project";
import { getCard } from "../kernel/registry";
import { listCuts } from "../kernel/cuts";
import { actions, useStore } from "../store/project";
import { clipKind, clipName } from "../mobile/mainContent";
import { quoteToken } from "../mobile/agentView";
import { VibeStage } from "./VibeStage";

/** 行高三档,和软件里「小 / 中 / 大」一致 */
const ROW_H = { 小: 30, 中: 44, 大: 62 } as const;
type RowSize = keyof typeof ROW_H;

const secs = (t: number) => `${t.toFixed(2)} s`;
const cardName = (id: string) => getCard(id)?.name;

const KIND_WORD: Record<ReturnType<typeof clipKind>, string> = { video: "素材", image: "素材", audio: "声音", cut: "剪辑", card: "卡片" };

export function DetailEdit(props: {
  /**
   * 切到**传统式**:打开编辑界面(左栏 + 预览 + 时间轴 + AI 栏,`workflow/editing.md`「编辑界面」)。
   * 用户 2026-10-23 裁定:不另起「专业模式」这个名字,就用语义里已有的「传统式」。
   */
  onPro: () => void;
  onClose: () => void;
  /** 把一张卡引用进输入框 */
  onQuote: (text: string) => void;
}): JSX.Element {
  const project = useStore((s) => s.project);
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  const duration = Math.max(0.1, project.duration);
  const tracks = project.tracks;
  const cutName = listCuts(project).find((c) => c.active)?.name ?? "剪辑 1";

  const [size, setSize] = useState<RowSize>("中");
  const [zoom, setZoom] = useState(1);
  const [picked, setPicked] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ clip: TrackClip; label: string; kind: string; x: number; y: number } | null>(null);
  const menuBox = useRef<HTMLDivElement>(null);

  // 菜单开着时:按 Esc、点别处都关掉
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    // 点在菜单自己里面不算「点别处」:不然按下那一刻菜单就没了,菜单项的点击永远到不了
    const onDown = (e: PointerEvent) => { if (!menuBox.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  /** 一秒多宽(像素):按片长铺满一屏左右,再乘缩放 */
  const pxPerSec = Math.max(4, Math.min(120, 690 / duration)) * zoom;

  return (
    <div className="ps-detail" data-pc="start-detail">
      <header className="ps-detail-head">
        <span className="ps-detail-title">详细编辑</span>
        <span className="ps-detail-sub">只看不改；右键一张卡可以引用进下面的输入框</span>
        <span className="ps-rail-spacer" />
        {/*
          这一页属于「Vibe 模式」——对着 Agent 说话、在这儿看一眼;
          点这个切到「传统式」,也就是打开编辑界面自己动手(`user-workflow.md`「工作方式」)。
        */}
        <button type="button" className="ps-mode-btn" data-pc="start-enter-traditional" title="打开编辑界面自己动手：左栏 + 预览 + 时间轴 + AI 栏" onClick={props.onPro}>
          进入传统式
        </button>
        <button type="button" className="ps-ghost-btn" data-pc="start-detail-close" onClick={props.onClose}>
          收起
        </button>
      </header>

      <div className="ps-detail-stage">
        <VibeStage className="ps-detail-screen" pc="start-detail-stage" />
      </div>

      <div className="ps-detail-transport">
        <button type="button" className="ps-detail-play" data-pc="start-detail-play" aria-label={playing ? "暂停" : "播放"} onClick={() => actions.togglePlay()}>
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.6 19 12 7 19.4z" /></svg>
          )}
        </button>
        <button type="button" className="ps-ghost-btn" data-pc="start-detail-rewind" onClick={() => { actions.pause(); actions.seek(0); }}>
          回到开头
        </button>
        <input type="range" className="ps-detail-scrub" data-pc="start-detail-scrub" min={0} max={duration} step={0.05}
          value={Math.min(t, duration)} aria-label="进度" onChange={(e) => actions.seek(Number(e.target.value))} />
        <span className="ps-detail-time">{secs(t)} / {secs(project.duration)}</span>
      </div>

      <div className="ps-detail-tl">
        <div className="ps-detail-tlbar">
          <span className="ps-detail-tltitle">{cutName}</span>
          <div className="ps-ext-seg" role="group" aria-label="行高">
            {(Object.keys(ROW_H) as RowSize[]).map((s) => (
              <button key={s} type="button" className="ps-ext-seg-btn" data-pc="start-detail-rowsize" aria-pressed={size === s} onClick={() => setSize(s)}>
                {s}
              </button>
            ))}
          </div>
          <span className="ps-muted">行高 {ROW_H[size]}px</span>
          <span className="ps-rail-spacer" />
          <label className="ps-detail-zoom">
            缩放
            <input type="range" min={0.5} max={2.5} step={0.1} value={zoom} data-pc="start-detail-zoom" aria-label="缩放" onChange={(e) => setZoom(Number(e.target.value))} />
          </label>
        </div>

        {tracks.length === 0 ? (
          <p className="ps-ext-todo" data-pc="start-detail-empty">这个剪辑里还没有序列。跟 Agent 说一句，它会把片子排上来。</p>
        ) : (
          <div className="ps-detail-tracks">
            <div className="ps-detail-names">
              {tracks.map((tr) => (
                <div key={tr.id} className="ps-detail-name" style={{ height: ROW_H[size] }} title={tr.name}>{tr.name}</div>
              ))}
            </div>
            <div className="ps-detail-lanes" style={{ width: duration * pxPerSec }}>
              {/* 播放头 */}
              <span className="ps-detail-playhead" style={{ left: Math.min(t, duration) * pxPerSec }} aria-hidden="true" />
              {tracks.map((tr) => (
                <div key={tr.id} className="ps-detail-lane" style={{ height: ROW_H[size] }} data-hidden={tr.hidden || undefined}>
                  {tr.clips.map((c) => {
                    const label = clipName(project, c, cardName);
                    const kind = KIND_WORD[clipKind(project, c)];
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className="ps-detail-clip"
                        data-pc="start-detail-clip"
                        data-clip={c.id}
                        data-picked={picked === c.id || undefined}
                        data-kind={kind === "卡片" ? "卡片" : "素材"}
                        style={{ left: c.start * pxPerSec, width: Math.max(14, (c.end - c.start) * pxPerSec) }}
                        title={`${kind}：${label}（${c.start.toFixed(1)}–${c.end.toFixed(1)} s）`}
                        aria-label={`${kind} ${label}`}
                        onClick={() => { setPicked(c.id); actions.seek(c.start); }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setPicked(c.id);
                          setMenu({ clip: c, label, kind, x: e.clientX, y: e.clientY });
                        }}
                      >
                        <span className="ps-detail-clip-name">{label}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {menu && (
        <div ref={menuBox} className="ps-menu" role="menu" aria-label={`${menu.label} 的操作`} data-pc="start-detail-menu" style={{ left: menu.x, top: menu.y }}>
          <div className="ps-menu-head">{menu.kind}：{menu.label}</div>
          <button type="button" className="ps-menu-item" data-pc="start-detail-quote"
            onClick={() => { props.onQuote(quoteToken({ id: menu.clip.id, label: menu.label })); setMenu(null); }}>
            引用到输入框
          </button>
          <button type="button" className="ps-menu-item" onClick={() => { setMenu(null); actions.select([menu.clip.id]); props.onPro(); }}>
            在传统式里打开
          </button>
        </div>
      )}
    </div>
  );
}
