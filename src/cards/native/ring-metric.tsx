import { motion, useMotionValue, animate } from "motion/react";
import { useEffect, useState } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  value: number;
  label: string;
}

function RingMetricCard({ params }: CardProps<Params>) {
  const v = useMotionValue(0);
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    const controls = animate(v, params.value, {
      duration: 1.5,
      ease: easeExpoOut,
    });
    const unsub = v.on("change", (latest) => {
      setDisplayValue(Math.round(latest));
    });
    return () => {
      controls.stop();
      unsub();
    };
  }, [params.value, v]);

  const size = 480;
  const strokeWidth = 32;
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const targetOffset = circumference * (1 - Math.min(100, Math.max(0, params.value)) / 100);

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="hud-glass flex flex-col items-center gap-6">
        <div className="relative" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="transform -rotate-90">
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="transparent"
              stroke="currentColor"
              strokeWidth={strokeWidth}
              className="opacity-10"
            />
            <motion.circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="transparent"
              stroke={accentOf(params)}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              initial={{ strokeDashoffset: circumference }}
              animate={{ strokeDashoffset: targetOffset }}
              transition={{ duration: 1.5, ease: easeExpoOut }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[100px] font-bold" style={{ fontFamily: "var(--pc-font-mono, ui-monospace, monospace)" }}>
              {displayValue}
              <span className="text-5xl ml-2">%</span>
            </span>
          </div>
        </div>
        <div className="text-4xl opacity-80 mt-4">{params.label}</div>
      </div>
    </div>
  );
}

export const ringMetric: CardDef<Params> = {
  id: "ring-metric",
  name: "环形指标",
  description: "环形进度与数字同步增加",
  source: "native",
  defaults: {
    ...hudDefaults,
    value: 75,
    label: "完播率",
  },
  controls: [
    ...hudControls,
    { key: "value", label: "数值(0-100)", type: "number" },
    { key: "label", label: "说明", type: "text" },
  ],
  Component: RingMetricCard,
};
