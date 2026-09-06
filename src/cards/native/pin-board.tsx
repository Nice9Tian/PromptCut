import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  title: string;
  subtitle: string;
  items: string;
  stepMs: number;
}

function PinBoardCard({ params }: CardProps<Params>) {
  const accent = accentOf(params);
  const items = params.items.split("|").filter(Boolean);
  
  return (
    <div className={`hud-wrapper ${params.position === "left" ? "hud-corner-bl" : getPositionClass(params.position)}`}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2 mb-4">
          <motion.div 
            className="text-[32px] font-light tracking-widest text-white uppercase"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: easeExpoOut }}
          >
            {params.title}
          </motion.div>
          <motion.div 
            className="text-[48px] font-bold"
            style={{ color: accent }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.6, ease: easeExpoOut }}
          >
            {params.subtitle}
          </motion.div>
        </div>
        <div className="flex flex-col gap-4 items-start">
          {items.map((item, i) => (
            <motion.div
              key={i}
              className="bg-[#111] text-white px-8 py-4 rounded-xl text-[36px] font-medium shadow-2xl border border-white/10"
              initial={{ opacity: 0, scale: 1.15, y: -10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ 
                delay: 0.3 + (i * params.stepMs) / 1000, 
                type: "spring",
                stiffness: 400,
                damping: 20
              }}
            >
              {item}
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}

export const pinBoard: CardDef<Params> = {
  id: "pin-board",
  name: "要点钉板",
  description: "逐条打出的要点板",
  source: "native",
  defaults: {
    ...hudDefaults,
    position: "left",
    title: "SUMMARY",
    subtitle: "核心要点总结",
    items: "第一点核心优势|第二点不可替代|第三点极速交付",
    stepMs: 200,
  },
  controls: [
    ...hudControls,
    { key: "title", label: "小标题", type: "text" },
    { key: "subtitle", label: "副标题", type: "text" },
    { key: "items", label: "要点(用|分隔)", type: "text" },
    { key: "stepMs", label: "间隔(ms)", type: "number" },
  ],
  Component: PinBoardCard,
};
