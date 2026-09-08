import { motion, useMotionValue, animate } from "motion/react";
import { useEffect, useRef } from "react";
import type { PartDef, PartProps } from "../types";
import { easeExpoOut, accentOf } from "../../cards/native/hud";

/**
 * 柱状排名条:若干项排名数据以横向条形图加跳动数字展示。
 * 从 rank-bars 拆出,不含标题与外壳。
 * 进场:条形从左向右长出,最大值条将以主题色高亮。
 */
interface Params {
  rows: string;
  suffix: string;
  accent: string;
}

function NumberTicker({ value, duration }: { value: number; duration: number }) {
  const v = useMotionValue(0);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const controls = animate(v, value, {
      duration: duration,
      ease: easeExpoOut,
    });
    const unsub = v.on("change", (latest) => {
      if (ref.current) ref.current.textContent = String(Math.round(latest));
    });
    return () => {
      controls.stop();
      unsub();
    };
  }, [value, v, duration]);

  return <span ref={ref}>0</span>;
}

function ChartRankPart({ params, width, height }: PartProps<Params>) {
  const rowData = params.rows.split("|").map((r) => {
    const [name, val] = r.split(",");
    return { name: name?.trim() || "", value: parseFloat(val) || 0 };
  });

  const maxVal = Math.max(...rowData.map((r) => r.value));
  const validMaxVal = maxVal > 0 ? maxVal : 1;

  return (
    <div style={{ position: "absolute", inset: 0, width, height, display: "flex", flexDirection: "column", justifyContent: "center", gap: 24 }}>
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
  );
}

export const chartRank: PartDef<Params> = {
  id: "chart-rank",
  name: "排名条",
  description: "柱状条形排名及滚动数值",
  useWhen: "3 到 5 项比大小、排榜单时用条形图。**部件不会自动排序**,rows 要按数值从大到小传进来;项目名不超过 5 字,超出会被截断;两项对决用 group-versus,时间走势用 chart-growth。",
  tags: ["排名", "条形图", "对比", "榜单"],
  role: "list",
  from: "rank-bars",
  defaults: {
    rows: "微信,85|抖音,62|小红书,45|快手,30",
    suffix: "%",
    accent: "",
  },
  controls: [
    { key: "rows", label: "数据行(名称,数值|名称,数值)", type: "text" },
    { key: "suffix", label: "数值后缀", type: "text" },
    { key: "accent", label: "颜色", type: "color" },
  ],
  defaultFrame: { x: 960, y: 540, w: 1000, h: 600, anchor: [0.5, 0.5] },
  settleMs: (p) => (Math.max(1, p.rows.split("|").filter(Boolean).length) - 1) * 120 + 900,
  after: "hold",
  Component: ChartRankPart,
};
