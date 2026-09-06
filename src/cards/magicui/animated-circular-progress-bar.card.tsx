import { useEffect, useState } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { AnimatedCircularProgressBar } from "./vendor/animated-circular-progress-bar";

interface Params {
  value: number;
  label: string;
  accent: string;
}

function AnimatedCircularProgressBarCard({ params }: CardProps<Params>) {
  const [currentValue, setCurrentValue] = useState(0);

  useEffect(() => {
    let rAF: number;
    const startTime = performance.now();
    const duration = 1200;

    const tick = (now: number) => {
      const elapsed = Math.max(0, now - startTime);
      let p = Math.min(1, elapsed / duration);
      // easeOut cubic
      p = 1 - Math.pow(1 - p, 3);
      setCurrentValue(params.value * p);

      if (p < 1) {
        rAF = requestAnimationFrame(tick);
      } else {
        setCurrentValue(params.value);
      }
    };
    rAF = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rAF);
  }, [params.value]);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-transparent">
      <AnimatedCircularProgressBar
        max={100}
        min={0}
        value={currentValue}
        gaugePrimaryColor={params.accent}
        gaugeSecondaryColor="rgba(255,255,255,0.2)"
        className="text-white drop-shadow-lg"
        style={{ width: 420, height: 420, fontSize: 96 }}
      />
      <p className="mt-16 text-6xl font-bold text-white drop-shadow-md">
        {params.label}
      </p>
    </div>
  );
}

export const animatedCircularProgressBarCard: CardDef<Params> = {
  id: "mu-circular-progress",
  name: "环形进度",
  description: "环形进度条动画",
  source: "magicui",
  defaults: { value: 75, label: "加载中", accent: "#3b82f6" },
  controls: [
    { key: "value", label: "目标值", type: "number" },
    { key: "label", label: "说明文字", type: "text" },
    { key: "accent", label: "主色", type: "color" },
  ],
  Component: AnimatedCircularProgressBarCard,
};
