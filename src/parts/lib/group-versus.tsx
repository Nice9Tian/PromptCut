import { motion } from "motion/react";
import type { PartDef, PartProps } from "../types";
import { easeExpoOut, accentOf } from "../../cards/native/hud";
import "../../cards/native/hud.css";

/**
 * A/B 对比面板。
 * 从 versus-card 拆出来的组合部件。包含左右两张卡片和中间的 VS 徽章。
 * 进场: 两侧卡片从外向内滑入(0.5s)，然后中间的徽章弹缩出现(延时 0.3s + 0.6s)。可以高亮胜出者并让另一侧变暗。
 */
interface Params {
  aKicker: string;
  aTitle: string;
  aSub: string;
  aAccent: string;
  bKicker: string;
  bTitle: string;
  bSub: string;
  winner: string;
  accent: string;
}

function GroupVersusPart({ params, width, height }: PartProps<Params>) {
  const winner = params.winner;
  const isAWinner = winner === "a";
  const isBWinner = winner === "b";
  const dimOpacity = 0.5;

  const aColor = params.aAccent && params.aAccent.trim() ? params.aAccent : accentOf(params);
  const bColor = accentOf(params);

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", width, height }}>
      <div className="flex items-center justify-center gap-12 relative w-full h-full p-8">
        {/* Card A */}
        <motion.div
          className="hud-glass flex-1 flex flex-col items-center text-center justify-center gap-4 py-16 h-full"
          initial={{ opacity: 0, x: -100 }}
          animate={{ opacity: isBWinner ? dimOpacity : 1, x: 0, scale: isAWinner ? 1.04 : 1 }}
          transition={{ duration: 0.5, ease: easeExpoOut }}
          style={{
            borderColor: isAWinner ? aColor : "var(--pc-glass-border, rgba(255,255,255,0.14))",
            borderWidth: isAWinner ? "2px" : "var(--pc-border-width, 1px)",
          }}
        >
          <div className="text-xl tracking-widest opacity-80 uppercase font-mono">{params.aKicker}</div>
          <div className="text-[72px] font-bold leading-tight my-2">{params.aTitle}</div>
          <div className="text-2xl opacity-60">{params.aSub}</div>
        </motion.div>

        {/* VS Badge */}
        <motion.div
          className="absolute left-1/2 top-1/2 w-28 h-28 rounded-full bg-black/60 border border-white/20 flex items-center justify-center text-4xl font-bold font-mono italic z-10 backdrop-blur-md"
          initial={{ opacity: 0, scale: 0, x: "-50%", y: "-50%" }}
          animate={{ opacity: 1, scale: 1, x: "-50%", y: "-50%" }}
          transition={{ duration: 0.6, delay: 0.3, type: "spring", bounce: 0.5 }}
        >
          VS
        </motion.div>

        {/* Card B */}
        <motion.div
          className="hud-glass flex-1 flex flex-col items-center text-center justify-center gap-4 py-16 h-full"
          initial={{ opacity: 0, x: 100 }}
          animate={{ opacity: isAWinner ? dimOpacity : 1, x: 0, scale: isBWinner ? 1.04 : 1 }}
          transition={{ duration: 0.5, ease: easeExpoOut }}
          style={{
            borderColor: isBWinner ? bColor : "var(--pc-glass-border, rgba(255,255,255,0.14))",
            borderWidth: isBWinner ? "2px" : "var(--pc-border-width, 1px)",
          }}
        >
          <div className="text-xl tracking-widest opacity-80 uppercase font-mono">{params.bKicker}</div>
          <div className="text-[72px] font-bold leading-tight my-2">{params.bTitle}</div>
          <div className="text-2xl opacity-60">{params.bSub}</div>
        </motion.div>
      </div>
    </div>
  );
}

export const groupVersus: PartDef<Params> = {
  id: "group-versus",
  name: "对比卡",
  description: "左右对比面板，可高亮胜出者",
  useWhen: "两个方案 / 两条路线做对照(「相比」「而不是」「区别在于」「vs」),可高亮胜出的一方;3 项以上比大小用 chart-rank,单个数字用 metric-stat。",
  tags: ["对比","versus","左右","对照"],
  role: "group",
  from: "versus-card",
  defaults: {
    aKicker: "OPTION A",
    aTitle: "传统方案",
    aSub: "开发成本高，周期长",
    aAccent: "",
    bKicker: "OPTION B",
    bTitle: "我们的方案",
    bSub: "开箱即用，降本增效",
    winner: "b",
    accent: "",
  },
  controls: [
    { key: "aKicker", label: "A侧小字", type: "text" },
    { key: "aTitle", label: "A侧大字", type: "text" },
    { key: "aSub", label: "A侧说明", type: "text" },
    { key: "aAccent", label: "A侧独立主色", type: "color" },
    { key: "bKicker", label: "B侧小字", type: "text" },
    { key: "bTitle", label: "B侧大字", type: "text" },
    { key: "bSub", label: "B侧说明", type: "text" },
    {
      key: "winner",
      label: "胜出方",
      type: "select",
      options: [
        { value: "none", label: "无" },
        { value: "a", label: "A胜出" },
        { value: "b", label: "B胜出" },
      ],
    },
    { key: "accent", label: "主色/B侧颜色", type: "color" },
  ],
  defaultFrame: { x: 960, y: 540, w: 1200, h: 600, anchor: [0.5, 0.5] },
  settleMs: () => 900,
  after: "hold",
  Component: GroupVersusPart,
};
