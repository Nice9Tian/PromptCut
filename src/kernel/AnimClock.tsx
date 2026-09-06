import { useEffect, useRef, type ReactNode } from "react";
import { isExportMode } from "./clock";

/**
 * 动画倍速层(预览用):每帧把容器内所有 Web Animations 的 playbackRate 设为 speed。
 * 导出时不做任何事:动画时间由 ExportView 的 __pcSyncAnims 每帧显式钉住,不靠 playbackRate。
 */
export function AnimClock({ speed = 1, children }: { speed?: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || isExportMode()) return;
    let raf = 0;
    const apply = () => {
      const eff = speed;
      for (const a of el.getAnimations({ subtree: true })) {
        if (a.playbackRate !== eff) a.playbackRate = eff;
      }
      raf = requestAnimationFrame(apply);
    };
    apply();
    return () => cancelAnimationFrame(raf);
  }, [speed]);
  return (
    <div ref={ref} style={{ position: "absolute", inset: 0 }}>
      {children}
    </div>
  );
}
