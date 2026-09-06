import { useEffect, useRef, type ReactNode } from "react";

/**
 * 动画钟校正层。
 * 无头 Chrome 虚拟时间下,CSS 动画 / Web Animations 的时钟和虚拟时钟不同步
 * (导出脚本实测比值后写入 window.__pcClockRate)。这里每帧扫容器内所有动画,
 * 把 playbackRate 拉到 speed * rate,让 Motion、Magic UI、纯 CSS 动画不改代码就能逐帧导出。
 * 预览时 rate 为空 = 1,只负责倍速。
 */
export function AnimClock({ speed = 1, children }: { speed?: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const apply = () => {
      const eff = speed * (window.__pcClockRate ?? 1);
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
