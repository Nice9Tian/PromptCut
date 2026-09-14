import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { ToolCallInfo } from "../../../ai/types";
import { Gif, loadVisualRecord, peekVisualRecord, visualIdOf, type VisualRecord } from "../ToolVisual";
import { usePrerenderBase, withBase } from "../../prerender";
import { KIND_LABEL, toolKind } from "./iconRuns";
import "./agent.css";

/**
 * 一条消息里「看过的图片、做过的看得见的修改」,排成一页页的轮播。
 *
 * 文字回复默认不显示之后,用户靠报告卡知道结论、靠图标知道做了几件事,
 * 但「到底改成什么样了」只有画面说得清。以前这些画面藏在每个操作的详情里,要一个个点开;
 * 这里把一条消息里的画面按操作先后排成一条,拖一下、滚一下就能从头翻到尾。
 *
 * 每页记着自己属于哪个图标:翻到哪一页,那个图标就放大发光;点图标,轮播跳到它的第一页。
 */

/** 拖过这么远就翻页 */
const SWIPE_PX = 40;
/** 甩得够快也翻页(像素 / 毫秒),哪怕没拖满 SWIPE_PX */
const FLING_SPEED = 0.5;
/** 按下之后挪过这么远才算拖动;更短的算点击 */
const DRAG_SLOP = 6;
/** 横向滚轮累计到这么多才翻一页 */
const WHEEL_PX = 60;
/** 翻完一页之后这么久之内的滚轮不算:触控板松手后还有一串惯性事件,不挡的话一甩翻好几页 */
const WHEEL_LOCK_MS = 350;
/** 画框两侧各占这么宽是翻页区 */
const EDGE = 0.22;

/** 老消息的工具结果里只有文件路径:认得出的图片才出页(和操作详情里的判断一致) */
const IMG_RE = /\.(png|jpe?g)$/i;

type DiffRow = NonNullable<VisualRecord["diff"]>[number];

interface PageBase {
  /** 在这条消息里唯一,当 React key */
  id: string;
  /** 这一页属于哪个图标:ToolIcons 里的完整 key */
  runKey: string;
  /** 产出这一页的工具名;说明行按它认动作类别 */
  tool: string;
}

/** 轮播的一页 */
export type ActivityPage =
  /** 一张看过的图。viaPrerender = 可视化记录里的图,地址挂在预渲染进程上,要拼上它的源 */
  | (PageBase & { kind: "image"; src: string; viaPrerender: boolean; label?: string })
  /** 前后两段动图(加卡只有「后」、删卡只有「前」)+ 参数差异 */
  | (PageBase & { kind: "change"; before?: string; after?: string; beforeLabel: string; afterLabel: string; diff: DiffRow[] })
  /** 只有参数差异,没有动图 */
  | (PageBase & { kind: "diff"; diff: DiffRow[] });

/** 轮播的一个来源:一次做完的操作,和它所属图标的完整 key */
export interface ActivitySource {
  runKey: string;
  tool: ToolCallInfo;
}

/** 老消息里的文件路径换成页面能打开的地址(和 ToolDetail 里的拼法一致) */
function legacyUrl(f: string): string {
  return f.startsWith("http") || f.startsWith("data:") ? f : `/@fs/${f.replace(/\\/g, "/").replace(/^\/?/, "")}`;
}

/** 一份可视化记录拆成页:每张图一页;有前后动图的一页「修改」;只有参数差异的一页「差异」 */
function recordPages(out: ActivityPage[], rec: VisualRecord, idBase: string, runKey: string, tool: string) {
  rec.images?.forEach((im, i) => {
    out.push({ kind: "image", id: `${idBase}:i${i}`, runKey, tool, src: im.url, viaPrerender: true, label: im.label });
  });
  if (rec.before || rec.after) {
    out.push({
      kind: "change",
      id: `${idBase}:c`,
      runKey,
      tool,
      before: rec.before?.gif,
      after: rec.after?.gif,
      // 标签和 ToolVisual 里一致:只有「后」是新加的卡(或 get_gif 的整段动效),只有「前」是删掉的卡
      beforeLabel: rec.after ? "修改前" : "删掉的卡片",
      afterLabel: rec.before ? "修改后" : rec.tool === "get_gif" ? "整段动效" : "新加的卡片",
      diff: rec.diff ?? [],
    });
  } else if (rec.diff?.length) {
    out.push({ kind: "diff", id: `${idBase}:d`, runKey, tool, diff: rec.diff });
  }
}

/** 按操作先后收集页面。记录还没取回来的先跳过,取回来之后下一次渲染就出现 */
function pagesOf(sources: ActivitySource[]): ActivityPage[] {
  const out: ActivityPage[] = [];
  sources.forEach(({ runKey, tool }, si) => {
    if (tool.ok === undefined) return;
    const vid = visualIdOf(tool.summary);
    if (vid) {
      const rec = peekVisualRecord(vid);
      if (rec) recordPages(out, rec, `${si}:${vid}`, runKey, tool.name);
      return;
    }
    (tool.files || []).forEach((f, fi) => {
      if (!IMG_RE.test(f)) return;
      const label = f.split(/[\\/]/).pop();
      out.push({ kind: "image", id: `${si}:f${fi}`, runKey, tool: tool.name, src: legacyUrl(f), viaPrerender: false, label });
    });
  });
  return out;
}

/**
 * 从一串操作收集轮播页。可视化记录走 ToolVisual 的模块级缓存,同一个 id 只取一次;
 * 每取回一份就重算一次,页面随记录陆续出现。
 */
export function useActivityPages(sources: ActivitySource[]): ActivityPage[] {
  const [loadedCount, bump] = useReducer((n: number) => n + 1, 0);
  const mounted = useRef(false);
  /** 这个组件已经发起过的 id:取失败的不在这里反复重试 */
  const tried = useRef(new Set<string>());

  const ids: string[] = [];
  const keyBits: string[] = [];
  for (const s of sources) {
    const done = s.tool.ok !== undefined;
    const id = done ? visualIdOf(s.tool.summary) : null;
    if (id && !ids.includes(id)) ids.push(id);
    keyBits.push(`${s.runKey}|${id ?? ""}|${done ? (s.tool.files || []).join(",") : ""}`);
  }
  const idsKey = ids.join(",");
  const sourcesKey = keyBits.join(";");

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    for (const id of ids) {
      if (peekVisualRecord(id) || tried.current.has(id)) continue;
      tried.current.add(id);
      // 取失败就不出页:点开操作清单时 ToolVisual 会再取一次,并把原因写出来
      loadVisualRecord(id).then(() => { if (mounted.current) bump(); }, () => {});
    }
    // ids 由 idsKey 完整决定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  // sources 每次渲染都是新数组,按内容算的 key 记忆,轮播拿到的 pages 引用才稳定
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => pagesOf(sources), [sourcesKey, loadedCount]);
}

/** 说明行左边那句:工具类别 + 这一页是什么 */
function pageCaption(p: ActivityPage): string {
  const kind = KIND_LABEL[toolKind(p.tool)];
  const what =
    p.kind === "image"
      ? p.label || p.tool
      : p.kind === "change"
        ? p.before && p.after
          ? `${p.beforeLabel} → ${p.afterLabel}`
          : p.after
            ? p.afterLabel
            : p.beforeLabel
        : `参数变化 ${p.diff.length} 项`;
  return `${kind} · ${what}`;
}

export function ActivityCarousel(props: {
  pages: ActivityPage[];
  /** 点图标跳页:seq 每点一次加一,跳到 key 所属的第一页 */
  jump?: { key: string; seq: number } | null;
  /** 用户自己翻到某一页时,报上这一页所属的图标 key */
  onFocus?: (runKey: string) => void;
  /** 消息还在跑:停在最后一页的话,新页出来就跟过去 */
  live?: boolean;
}): JSX.Element | null {
  const { pages, jump, onFocus, live } = props;
  const n = pages.length;
  const [index, setIndex] = useState(0);
  /** 拖动中跟手的偏移(px) */
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  /** 鼠标停在哪一侧的翻页区,那一侧的箭头才露出来 */
  const [hover, setHover] = useState<"prev" | "next" | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: number; x: number; y: number; t: number; moved: boolean } | null>(null);
  /**
   * 翻到过的页。「修改」页里的动图只在这些页里挂载:服务端现渲一段动图要几秒到几十秒,
   * 一打开消息就把所有动图全触发,预渲染进程会被压垮。
   */
  const seen = useRef(new Set<string>());
  const base = usePrerenderBase();
  const cur = Math.min(index, Math.max(0, n - 1));

  const go = (i: number, byUser: boolean) => {
    const next = Math.max(0, Math.min(n - 1, i));
    setIndex(next);
    if (byUser && pages[next]) onFocus?.(pages[next].runKey);
  };
  // 原生滚轮监听只挂一次,通过 ref 拿到最新的页码和翻页函数
  const goRef = useRef(go);
  goRef.current = go;
  const curRef = useRef(cur);
  curRef.current = cur;

  // 还在跑、而且停在最后一页:新页出来就跟过去。停在前面的页说明用户在看,不去打扰
  const prevCount = useRef(n);
  useEffect(() => {
    const was = prevCount.current;
    prevCount.current = n;
    if (live && was > 0 && n > was && curRef.current === was - 1) setIndex(n - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);

  // 图标那边点过来:跳到它的第一页
  useEffect(() => {
    if (!jump) return;
    const i = pages.findIndex((p) => p.runKey === jump.key);
    if (i >= 0) setIndex(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.seq]);

  // 触控板 / 鼠标的横向滚动(或 Shift + 滚轮)翻页。
  // React 的 onWheel 是被动监听,拦不住浏览器自己的横向手势(前进后退),所以挂原生的非被动监听
  const hasPages = n > 0;
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    let acc = 0;
    let lockUntil = 0;
    const onWheel = (e: WheelEvent) => {
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (!dx) return; // 竖着滚的归消息列表
      e.preventDefault();
      const now = performance.now();
      if (now < lockUntil) {
        // 惯性还在滚:把锁往后顺延一点,等这串事件停了再接受下一次
        lockUntil = Math.max(lockUntil, now + 120);
        acc = 0;
        return;
      }
      acc += dx * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1);
      if (Math.abs(acc) >= WHEEL_PX) {
        goRef.current(curRef.current + (acc > 0 ? 1 : -1), true);
        acc = 0;
        lockUntil = now + WHEEL_LOCK_MS;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [hasPages]);

  /** 指针落在左右哪一侧的翻页区;到头了那一侧不算 */
  const sideOf = (clientX: number): "prev" | "next" | null => {
    const el = frameRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const f = (clientX - r.left) / Math.max(1, r.width);
    if (f < EDGE && cur > 0) return "prev";
    if (f > 1 - EDGE && cur < n - 1) return "next";
    return null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !n) return;
    // 动图的「重试」这类控件自己处理点击,不当成拖动或翻页
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) {
      if (e.pointerType === "mouse" && !e.buttons) setHover(sideOf(e.clientX));
      return;
    }
    const dx = e.clientX - g.x;
    if (!g.moved) {
      if (Math.abs(dx) < DRAG_SLOP) return;
      // 竖着拖多半是想滚消息列表(触屏),让给浏览器
      if (Math.abs(e.clientY - g.y) > Math.abs(dx)) {
        gesture.current = null;
        return;
      }
      g.moved = true;
      setDragging(true);
      setHover(null);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* 指针已经抬起,捕获不了也无妨 */
      }
    }
    // 两头拖不动:只给三分之一的位移,手感上是「到头了」
    const atEdge = (cur === 0 && dx > 0) || (cur === n - 1 && dx < 0);
    setDrag(atEdge ? dx / 3 : dx);
  };

  const finish = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    const dx = e.clientX - g.x;
    if (g.moved) {
      const speed = Math.abs(dx) / Math.max(1, performance.now() - g.t);
      setDragging(false);
      setDrag(0);
      if (!cancelled && (Math.abs(dx) > SWIPE_PX || (Math.abs(dx) > DRAG_SLOP * 2 && speed > FLING_SPEED))) {
        go(cur + (dx < 0 ? 1 : -1), true);
      }
      return;
    }
    if (cancelled) return;
    // 没拖动 = 点了一下:左右两侧是翻页区,中间不做事
    const side = sideOf(e.clientX);
    if (side === "prev") go(cur - 1, true);
    else if (side === "next") go(cur + 1, true);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    // 编辑台全局也认方向键(挪播放头),画框有焦点时归轮播
    e.preventDefault();
    e.stopPropagation();
    go(cur + (e.key === "ArrowRight" ? 1 : -1), true);
  };

  if (!n) return null;
  const page = pages[cur];
  seen.current.add(page.id);

  return (
    <div className="ai-carousel">
      <div
        ref={frameRef}
        className={`ai-carousel-frame${dragging ? " is-dragging" : ""}`}
        tabIndex={0}
        role="group"
        aria-roledescription="轮播"
        aria-label={`看过的画面和做过的修改,第 ${cur + 1} 页,共 ${n} 页`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
      >
        <div className="ai-carousel-track" style={{ transform: `translateX(calc(${-cur * 100}% + ${drag}px))` }}>
          {pages.map((p, i) => (
            <div key={p.id} className={`ai-carousel-page is-${p.kind}`} aria-hidden={i !== cur}>
              {/* 只挂当前页和左右邻居(拖动时看得见邻居);再远的等翻过去再说 */}
              {Math.abs(i - cur) <= 1 || seen.current.has(p.id) ? (
                <PageBody p={p} base={base} loadGif={seen.current.has(p.id)} />
              ) : null}
            </div>
          ))}
        </div>
        {cur > 0 ? <span className={`ai-carousel-arrow is-prev${hover === "prev" ? " is-on" : ""}`} aria-hidden>‹</span> : null}
        {cur < n - 1 ? <span className={`ai-carousel-arrow is-next${hover === "next" ? " is-on" : ""}`} aria-hidden>›</span> : null}
      </div>
      <div className="ai-carousel-caption">
        <span className="ai-carousel-label" title={pageCaption(page)}>{pageCaption(page)}</span>
        <span className="ai-carousel-count">{cur + 1} / {n}</span>
      </div>
      {n > 1 ? (
        <div className="ai-carousel-dots">
          {pages.map((p, i) => (
            <button
              key={p.id}
              type="button"
              className={`ai-carousel-dot${i === cur ? " is-on" : ""}`}
              aria-label={`第 ${i + 1} 页`}
              aria-current={i === cur ? "true" : undefined}
              onClick={() => go(i, true)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PageBody({ p, base, loadGif }: { p: ActivityPage; base: string; loadGif: boolean }): JSX.Element {
  if (p.kind === "image") {
    return <PageImage key={p.src} src={p.viaPrerender ? withBase(base, p.src) : p.src} label={p.label} />;
  }
  if (p.kind === "diff") {
    return (
      <div className="ai-carousel-diff">
        <DiffList diff={p.diff} />
      </div>
    );
  }
  return (
    <div className="ai-carousel-change">
      <div className="ai-visual-gifs">
        {p.before ? (loadGif ? <Gif src={withBase(base, p.before)} label={p.beforeLabel} /> : <GifSlot label={p.beforeLabel} />) : null}
        {p.before && p.after ? <div className="ai-visual-arrow" aria-hidden>→</div> : null}
        {p.after ? (loadGif ? <Gif src={withBase(base, p.after)} label={p.afterLabel} /> : <GifSlot label={p.afterLabel} />) : null}
      </div>
      {p.diff.length ? <DiffList diff={p.diff} /> : null}
    </div>
  );
}

/** 看过的一张图;取不回来就写一句,不留一块空白 */
function PageImage({ src, label }: { src: string; label?: string }): JSX.Element {
  const [bad, setBad] = useState(false);
  if (bad) return <div className="ai-carousel-note">这张图取不回来了</div>;
  return <img className="ai-carousel-img" src={src} alt={label || "画面"} draggable={false} onError={() => setBad(true)} />;
}

/** 还没翻到的「修改」页:先占好动图的位置,翻到了再换成真的动图 */
function GifSlot({ label }: { label: string }): JSX.Element {
  return (
    <figure className="ai-visual-gif">
      <div className="box" />
      <figcaption>{label}</figcaption>
    </figure>
  );
}

function DiffList({ diff }: { diff: DiffRow[] }): JSX.Element {
  return (
    <ul className="ai-visual-diff">
      {diff.map((d) => (
        <li key={d.key}>
          <span className="k">{d.key}</span>
          <span className="from">{d.from}</span>
          <span className="arrow" aria-hidden>→</span>
          <span className="to">{d.to}</span>
        </li>
      ))}
    </ul>
  );
}
