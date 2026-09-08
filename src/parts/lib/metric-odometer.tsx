import { motion } from "motion/react";
import type { PartDef, PartProps } from "../types";
import { easeExpoOut, accentOf } from "../../cards/native/hud";

/**
 * 翻牌数字:大号的机械滚轮数字加上单位。
 * 从 odometer 拆出,去除了说明小字和玻璃板外壳。
 * 进场:数字轮盘由上往下拨动到位。
 */
interface Params {
  value: number;
  unit: string;
  size: number;
  accent: string;
}

function OdometerWheel({ digit, index }: { digit: string; index: number }) {
  const d = parseInt(digit, 10);
  if (isNaN(d)) return <span className="inline-block">{digit}</span>;

  const numbers = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const targetIndex = 10 + d;

  return (
    <span className="inline-flex relative overflow-hidden" style={{ height: "1em", verticalAlign: "bottom" }}>
      <span className="invisible leading-none">0</span>
      <motion.span
        className="absolute inset-x-0 top-0 flex flex-col"
        initial={{ y: "0em" }}
        animate={{ y: `-${targetIndex}em` }}
        transition={{ duration: 0.8 + index * 0.12, ease: easeExpoOut }}
      >
        {numbers.map((n, i) => (
          <span key={i} className="leading-none text-center h-[1em] block">
            {n}
          </span>
        ))}
      </motion.span>
    </span>
  );
}

function MetricOdometerPart({ params, width, height }: PartProps<Params>) {
  const strValue = String(Math.floor(params.value));

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", width, height }}>
      <div className="flex items-baseline gap-4" style={{ color: accentOf(params) }}>
        <div style={{ fontSize: params.size, fontWeight: "bold", display: "flex", fontFamily: "var(--pc-font-mono, ui-monospace, monospace)" }}>
          {strValue.split("").map((c, i) => (
            <OdometerWheel key={i} digit={c} index={i} />
          ))}
        </div>
        {params.unit && <div style={{ fontSize: params.size * (48/120), fontWeight: 600, opacity: 0.8 }}>{params.unit}</div>}
      </div>
    </div>
  );
}

export const metricOdometer: PartDef<Params> = {
  id: "metric-odometer",
  name: "翻牌数字",
  description: "大数字翻牌效果",
  useWhen: "大整数累计量(播放量、用户数)做成机械滚轮翻牌时使用。只支持非负整数,小数会被截断,也没有涨跌符号;要带正负号或注脚用 metric-stat,百分比进度用 metric-ring。",
  tags: ["数字", "增长", "翻牌", "变化"],
  role: "text",
  from: "odometer",
  defaults: {
    value: 12480,
    unit: "次",
    size: 120,
    accent: "",
  },
  controls: [
    { key: "value", label: "数值", type: "number" },
    { key: "unit", label: "单位", type: "text" },
    { key: "size", label: "字号", type: "number", min: 24, max: 400, step: 4 },
    { key: "accent", label: "颜色", type: "color" },
  ],
  defaultFrame: { x: 960, y: 540, w: 800, h: 200, anchor: [0.5, 0.5] },
  settleMs: (p) => 800 + (String(Math.floor(Number(p.value) || 0)).length - 1) * 120,
  after: "hold",
  Component: MetricOdometerPart,
};
