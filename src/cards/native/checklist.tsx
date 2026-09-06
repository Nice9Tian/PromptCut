import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  items: string;
  stepMs: number;
}

function CheckItem({ text, i, stepMs, accent }: { text: string; i: number; stepMs: number; accent: string }) {
  const rowDelay = i * (stepMs / 1000);
  const tickDelay = rowDelay + 0.15;

  return (
    <motion.div
      className="flex items-center gap-6"
      initial={{ opacity: 0, x: -40 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.6, delay: rowDelay, ease: easeExpoOut }}
    >
      <div className="relative w-20 h-20 flex items-center justify-center">
        {/* Empty circle */}
        <div className="absolute inset-0 rounded-full border-4 border-current opacity-30" />
        {/* Solid circle */}
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{ backgroundColor: accent }}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ duration: 0.4, delay: tickDelay, ease: easeExpoOut }}
        />
        <svg
          viewBox="0 0 24 24"
          className="w-12 h-12 relative z-10"
          style={{ color: "var(--pc-on-accent, #0b1220)" }}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <motion.path
            d="M5 13l4 4L19 7"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.4, delay: tickDelay + 0.1, ease: easeExpoOut }}
          />
        </svg>
      </div>
      <div className="text-[72px] font-bold">{text}</div>
    </motion.div>
  );
}

function ChecklistCard({ params }: CardProps<Params>) {
  const items = params.items.split("|").filter(Boolean);
  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="hud-glass flex flex-col gap-8">
        {items.map((item, i) => (
          <CheckItem key={i} text={item} i={i} stepMs={params.stepMs} accent={accentOf(params)} />
        ))}
      </div>
    </div>
  );
}

export const checklist: CardDef<Params> = {
  id: "checklist",
  name: "清单打勾",
  description: "逐条划入并打勾",
  source: "native",
  defaults: {
    ...hudDefaults,
    items: "选题定方向|脚本写钩子|镜头列清单|剪辑控节奏",
    stepMs: 260,
  },
  controls: [
    ...hudControls,
    { key: "items", label: "条目(竖线分隔)", type: "text" },
    { key: "stepMs", label: "行间隔(ms)", type: "number" },
  ],
  Component: ChecklistCard,
};
