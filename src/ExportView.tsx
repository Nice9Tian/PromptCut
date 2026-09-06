import { useEffect, useState } from "react";
import { Stage } from "./kernel/Stage";
import type { Timeline } from "./kernel/types";
import { demoTimeline } from "./demo";
import "./cards";

/**
 * 导出视图(?export=1)。导出脚本的每帧顺序:
 *   1. page.evaluate(window.__pcSetT(sec))  → 写 __pcExportMs、setT 触发 React 重渲染
 *   2. 推进 CDP 虚拟时间 1/fps
 *   3. 截图
 * 页面挂载后把 window.__pcReady 置 true,脚本等它。
 * 时间轴可由 ?timeline=<url> 指定(JSON),默认用 demo。
 */
export default function ExportView() {
  const [t, setT] = useState(0);
  const [timeline, setTimeline] = useState<Timeline | null>(null);

  useEffect(() => {
    const url = new URLSearchParams(location.search).get("timeline");
    (url ? fetch(url).then((r) => r.json()) : Promise.resolve(demoTimeline)).then((tl: Timeline) => {
      setTimeline(tl);
      window.__pcExportMs = 0;
      window.__pcSetT = (sec: number) => {
        window.__pcExportMs = sec * 1000;
        setT(sec);
      };
      // 实测 CSS 动画钟相对页面时钟的快慢,写进 __pcClockRate(AnimClock 每帧用它校正 playbackRate)
      let raf0: number | null = null;
      const p0 = performance.now();
      const tick = (rafTs: number) => {
        if (raf0 === null) raf0 = rafTs;
        else if (rafTs - raf0 > 50) {
          const r = (performance.now() - p0) / (rafTs - raf0);
          if (Number.isFinite(r) && r > 0.01 && r < 100) window.__pcClockRate = r;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      window.__pcReady = true;
    });
  }, []);

  if (!timeline) return null;
  return (
    <div style={{ width: timeline.width, height: timeline.height, overflow: "hidden", background: "transparent" }}>
      <Stage timeline={timeline} t={t} playToken={1} />
    </div>
  );
}
