/**
 * 缩略时间轴(语义 `workflow/editing.md`「手机版界面」;演示稿第四、九轮):只放主要内容,各卡等宽、标时长,
 * 正中固定一条当前帧标记,卡在下面滚动。按住左右拖 = 滚动 = 调整当前时间;点卡选中(再点取消);先选中再长按拖动 = 换顺序;
 * 点转场 ◇ 和点卡同一个动作(原地选中);没有转场的「＋」打开卡片库转场分类。
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { Project, TrackClip } from "../kernel/project";
import type { Transition } from "../kernel/transitions";
import { boundaryTransition, cardPosAtTime, clipKind, mainTotal, timeAtCardPos } from "./mainContent";
import { Icon } from "./icons";
import { fmtDur, tint } from "./ui";

/** 长按多久才算拿起来换顺序 */
const LIFT_MS = 350;

export function ThumbStrip(props: {
  project: Project;
  clips: TrackClip[];
  t: number;
  playing: boolean;
  /** 选中的缩略卡(片段 id)或转场(转场 id) */
  selected: string | null;
  onSelect: (sel: { clipId: string } | { transition: Transition } | null) => void;
  onReorder: (order: string[]) => void;
  onScrub: (t: number) => void;
  onAddMedia: () => void;
  onAddTransition: (a: TrackClip, b: TrackClip) => void;
}) {
  const { project, clips, selected } = props;
  const sc = useRef<HTMLDivElement>(null);
  /** 自己设的滚动位置(跟着当前时间走),滚动事件看到它就不回头改时间 */
  const progSl = useRef(0);
  const suppressClick = useRef(false);
  const dragging = useRef(false);

  const blocks = () => [...(sc.current?.querySelectorAll<HTMLElement>(".mblock") ?? [])];
  /** 当前帧标记(正中)落在卡序列里的位置:整数部分第几张,小数部分卡内比例 */
  const posFromScroll = (): number => {
    const el = sc.current!;
    const x = el.scrollLeft + el.clientWidth / 2;
    const bl = blocks();
    for (let i = 0; i < bl.length; i++) {
      const l = bl[i].offsetLeft, r = l + bl[i].offsetWidth;
      if (x < l) return i;
      if (x < r) return i + (x - l) / (r - l);
    }
    return bl.length;
  };
  const scrollForPos = (pos: number): number => {
    const el = sc.current!;
    const bl = blocks();
    if (!bl.length) return 0;
    const i = Math.min(Math.floor(pos), bl.length - 1);
    const f = pos >= bl.length ? 1 : pos - i;
    return bl[i].offsetLeft + f * bl[i].offsetWidth - el.clientWidth / 2;
  };

  // 播放、点刻度、切换剪辑时,缩略时间轴跟着当前时间走(手指按着的时候不动)
  useLayoutEffect(() => {
    const el = sc.current;
    if (!el || !el.clientWidth || dragging.current) return;
    const want = scrollForPos(cardPosAtTime(clips, props.t));
    if (Math.abs(el.scrollLeft - want) < 1) return;
    el.scrollLeft = want;
    progSl.current = el.scrollLeft;
  });

  useEffect(() => {
    const el = sc.current;
    if (!el) return;
    const onScroll = () => {
      if (!el.clientWidth || Math.abs(el.scrollLeft - progSl.current) < 1.5) return;
      progSl.current = el.scrollLeft;
      props.onScrub(timeAtCardPos(clips, posFromScroll()));
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  });

  const onPointerDown = (e: React.PointerEvent) => {
    const el = sc.current!;
    const target = (e.target as HTMLElement).closest<HTMLElement>(".mblock, .mark.has");
    const isBlock = !!target?.classList.contains("mblock");
    const id = target?.dataset.id ?? null;
    const x0 = e.clientX, sl0 = el.scrollLeft;
    let mode: "pending" | "scroll" | "reorder" = "pending";
    let timer = 0;
    dragging.current = true;
    if (isBlock && id && selected === id) {
      timer = window.setTimeout(() => { if (mode === "pending") { mode = "reorder"; target!.classList.add("lift"); } }, LIFT_MS);
    }
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (mode === "pending" && Math.abs(dx) > 6) { window.clearTimeout(timer); mode = "scroll"; }
      if (mode === "scroll") el.scrollLeft = sl0 - dx;
      else if (mode === "reorder") target!.style.transform = `translateX(${dx}px)`;
    };
    const end = (ev: PointerEvent) => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      dragging.current = false;
      if (mode !== "pending") { suppressClick.current = true; window.setTimeout(() => { suppressClick.current = false; }, 0); }
      if (mode === "reorder" && id) {
        const cx = target!.getBoundingClientRect().left + target!.offsetWidth / 2;
        target!.classList.remove("lift");
        target!.style.transform = "";
        const sibs = blocks().filter((b) => b !== target);
        let idx = 0;
        sibs.forEach((s, i) => { const r = s.getBoundingClientRect(); if (cx > r.left + r.width / 2) idx = i + 1; });
        const order = clips.map((c) => c.id).filter((x) => x !== id);
        order.splice(idx, 0, id);
        if (order.join() !== clips.map((c) => c.id).join()) props.onReorder(order);
      } else if (mode === "pending" && ev.type === "pointerup" && target && id) {
        if (isBlock) props.onSelect(selected === id ? null : { clipId: id });
        else {
          const k = Number(target.dataset.k);
          const tr = boundaryTransition(project, clips[k], clips[k + 1]);
          if (tr) props.onSelect(selected === tr.id ? null : { transition: tr });
        }
      }
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const total = Math.round(mainTotal(clips) * 10) / 10;
  return (
    <>
      <div className="mainhead"><b>缩略时间轴</b><span data-pcm="main-sum">{clips.length ? `${clips.length} 段 · 共 ${fmtDur(total)}` : "还没有内容，点 ＋ 添加素材"}</span></div>
      <div className="mainstrip" data-pcm="main-strip">
        <div className="cf-line" title="当前帧" data-pcm="frame-line" />
        <div
          ref={sc}
          className="strip-scroll"
          onPointerDown={onPointerDown}
          onClickCapture={(e) => { if (suppressClick.current) { e.stopPropagation(); e.preventDefault(); } }}
        >
          <div className="sp-l" />
          <button type="button" className="madd" aria-label="添加素材" title="添加素材" data-pcm="main-add" onClick={props.onAddMedia}><Icon name="plus" /></button>
          {clips.map((c, i) => {
            const tr = i < clips.length - 1 ? boundaryTransition(project, c, clips[i + 1]) : null;
            const muted = !!c.audioMuted;
            return [
              <div
                key={c.id}
                className={selected === c.id ? "mblock sel" : "mblock"}
                data-id={c.id}
                data-kind={clipKind(project, c)}
                data-pcm="mblock"
                style={{ background: `linear-gradient(135deg, ${tint(c.mediaId ?? c.cutId ?? c.id)}, var(--shade-art))` }}
              >
                <span className="no">{i + 1}</span>
                <span className="du">{fmtDur(c.end - c.start)}{muted && <Icon name="mute" />}</span>
              </div>,
              i < clips.length - 1 && (
                tr
                  ? <button key={`m-${c.id}`} type="button" className={selected === tr.id ? "mark has sel" : "mark has"} data-id={tr.id} data-k={i} data-pcm="mark" title="转场">◇</button>
                  : <button key={`m-${c.id}`} type="button" className="mark" data-k={i} data-pcm="mark-add" title="添加转场" onClick={() => props.onAddTransition(c, clips[i + 1])}>＋</button>
              ),
            ];
          })}
          <div className="sp-r" />
        </div>
      </div>
    </>
  );
}
