import { motion, useMotionValue, animate } from "motion/react";
import { useEffect, useState } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  title: string;
  rows: string;
  suffix: string;
}

function NumberTicker({ value, duration }: { value: number; duration: number }) {
  const v = useMotionValue(0);
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    const controls = animate(v, value, {
      duration: duration,
      ease: easeExpoOut,
    });
    const unsub = v.on("change", (latest) => {
      setDisplayValue(Math.round(latest));
    });
    return () => {
      controls.stop();
      unsub();
    };
  }, [value, v, duration]);

  return <>{displayValue}</>;
}

function RankBarsCard({ params }: CardProps<Params>) {
  const rowData = params.rows.split("|").map((r) => {
    const [name, val] = r.split(",");
    return { name: name?.trim() || "", value: parseFloat(val) || 0 };
  });

  const maxVal = Math.max(...rowData.map((r) => r.value));
  const validMaxVal = maxVal > 0 ? maxVal : 1;

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="hud-glass flex flex-col gap-8 min-w-[1000px]">
        {params.title && <div className="text-5xl font-bold">{params.title}</div>}
        <div className="flex flex-col gap-6">
          {rowData.map((row, i) => {
            const isFirst = row.value === maxVal && maxVal > 0;
            const widthPct = (row.value / validMaxVal) * 100;
            return (
              <motion.div
                key={i}
                className="flex items-center gap-4"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: i * 0.12, ease: easeExpoOut }}
              >
                <div className="w-44 text-3xl text-right opacity-90 truncate">{row.name}</div>
                <div className="flex-1 h-10 bg-black/20 rounded-full overflow-hidden relative">
                  <motion.div
                    className="absolute left-0 top-0 bottom-0 rounded-full"
                    style={{
                      backgroundColor: isFirst ? accentOf(params) : "rgba(255, 255, 255, 0.4)",
                    }}
                    initial={{ width: "0%" }}
                    animate={{ width: `${widthPct}%` }}
                    transition={{ duration: 0.9, delay: i * 0.12, ease: easeExpoOut }}
                  />
                </div>
                <div
                  className="w-32 text-4xl font-bold font-mono"
                  style={{
                    color: isFirst ? accentOf(params) : "var(--pc-fg, #f3f4f6)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <NumberTicker value={row.value} duration={0.9 + i * 0.12} />
                  {params.suffix && <span className="text-xl ml-1">{params.suffix}</span>}
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export const rankBars: CardDef<Params> = {
  id: "rank-bars",
  name: "排名条",
  description: "柱状条形排名及滚动数值",
  source: "native",
  defaults: {
    ...hudDefaults,
    title: "TOP 渠道转化率",
    rows: "微信,85|抖音,62|小红书,45|快手,30",
    suffix: "%",
  },
  controls: [
    ...hudControls,
    { key: "title", label: "标题", type: "text" },
    { key: "rows", label: "数据行 (名称,数值|名称,数值)", type: "text" },
    { key: "suffix", label: "数值后缀", type: "text" },
  ],
  Component: RankBarsCard,
};
