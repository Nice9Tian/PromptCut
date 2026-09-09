import { useSyncExternalStore } from "react";
import { useTimelineContext } from "./TimelineContext";
import { useStore } from "../../store/project";
import { useScrub } from "./useScrub";
import { getCoverage, subscribeCoverage, type CoverageSegment } from "../preview/bakeCoverage";
import { xOfTime } from "./utils";

/** 进度条高度(px)。够看见、又不抢时间轴的地方 */
export const RENDER_H = 5;

/**
 * 预渲染进度条(AE 顶上那条)。紧贴在时间标尺下面。
 *
 * # 两种颜色说的是两件事
 *
 * **黄 = 低帧率那一档已经有了。** 拖过去立刻有画面,但看到的那一刻最多和播放头差 0.25 秒
 * (0.25 秒一格,约 4 帧/秒)。这一档先把整条片子铺满 —— 成本只有原始帧率的零头。
 *
 * **绿 = 原始帧率那一档也有了。** 那一段是逐帧精确的。低帧率全部铺完之后才开始烘它。
 *
 * **空白 = 什么都没有,拖过去要等它现烘(一张约 4 秒)。**
 *
 * 两档分开画而不是合成一个百分比,是因为它们对用户的意义完全不同:黄的地方"能看但不准",
 * 绿的地方"就是这一帧"。合成一条就把这个区别抹掉了 —— 而这个区别正是用户要看的。
 *
 * # 画法上的两条硬要求
 *
 * 1. **画的是真实覆盖的时间段,不是百分比。** 段的算法在 bakeCoverage.ts:一个烘好的时刻
 *    覆盖到同一张卡的下一个时刻为止。百分比进度条做不到这件事 —— 它能显示 90%,
 *    而用户偏偏拖到剩下那 10% 里,一样干等,条却是满的。
 * 2. **宁可少画不能多画。** 多画一格就是骗人:那儿明明要等五秒,条却是有色的。
 *
 * 数据来自 `bakeCoverage` 那个模块级小仓库,预烘每烘完一批就发一次。
 * 预烘只在预览面板切到「3D」页时才跑,所以**没开过 3D 页的话这条是空的** ——
 * 空着是诚实的:那时确实一段都没预渲染。已经烘过的部分在切回 2D 页之后仍然显示,
 * 因为仓库是模块级的,不随组件卸载清空。
 */
export function RenderBar() {
  const { pxPerSec } = useTimelineContext();
  const duration = useStore((s) => Math.max(s.project.duration, s.t + 10));
  const startScrub = useScrub();
  /*
   * 订阅模块级仓库。用 useSyncExternalStore 而不是自己 useState + useEffect:
   * 它保证并发渲染下读到的值和订阅到的是同一份,不会出现"画面用的是旧值"。
   */
  const cov = useSyncExternalStore(subscribeCoverage, getCoverage, getCoverage);

  const x0 = xOfTime(0, pxPerSec);
  const width = Math.max(0, xOfTime(duration, pxPerSec) - x0);

  const band = (segs: CoverageSegment[], cls: string) =>
    segs.map((seg, i) => {
      const left = xOfTime(seg.start, pxPerSec);
      const w = xOfTime(seg.end, pxPerSec) - left;
      // 缩得很小时一段可能不足 1px。给它兜个底,不然整条看着像没烘
      if (w <= 0) return null;
      return <div key={`${cls}-${seg.start}-${i}`} className={cls} style={{ left, width: Math.max(1, w) }} />;
    });

  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  const title = cov.coarseTotal === 0
    ? "预渲染:还没开始。切到预览面板的「3D」页会在空闲时自动预渲染"
    : [
        `低帧率(黄)${cov.coarseBaked}/${cov.coarseTotal}(${pct(cov.coarseBaked, cov.coarseTotal)}%)—— 拖过去立刻有画面,最多差 0.25 秒`,
        `原始帧率(绿)${cov.fullBaked}/${cov.fullTotal}(${pct(cov.fullBaked, cov.fullTotal)}%)—— 逐帧精确`,
        `空白 = 要等它现烘(一张约 4 秒)。已占 ${(cov.bytes / 1048576).toFixed(1)}MB`,
      ].join("\n");

  return (
    <div
      data-pc="render-bar"
      className="pc-tl-renderbar relative overflow-hidden select-none touch-none cursor-ew-resize"
      style={{ height: RENDER_H }}
      // 和标尺一样能拖播放头:它紧贴在标尺下面,点到这几个像素上却没反应会让人以为界面卡了
      onPointerDown={(e) => startScrub(e, { jumpToPointer: true })}
      title={title}
    >
      {/* 底槽:整条片子的长度,标出"还有多少没预渲染" */}
      <div className="pc-tl-renderbar-track absolute top-0 bottom-0" style={{ left: x0, width }} />
      {/* 先铺黄的(低帧率),再把绿的(原始帧率)盖在上面 —— 绿的一定落在黄的之内 */}
      {band(cov.coarse, "pc-tl-renderbar-coarse absolute top-0 bottom-0")}
      {band(cov.full, "pc-tl-renderbar-done absolute top-0 bottom-0")}
      {/*
        正在烘的那一刻单独标一下。它还没进任何一档的覆盖(还没烘完),
        但用户看得见"进度正卡在这儿",而不是对着一条不动的条猜是不是死了。
      */}
      {cov.bakingAt !== null && (
        <div
          className="pc-tl-renderbar-now absolute top-0 bottom-0"
          style={{ left: xOfTime(cov.bakingAt, pxPerSec) }}
        />
      )}
    </div>
  );
}
