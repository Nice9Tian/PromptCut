import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  en: string;
  term: string;
  def: string;
}

function TermCard({ params }: CardProps<Params>) {
  const chars = params.def.split("");
  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="hud-glass flex flex-col items-center justify-center text-center max-w-4xl">
        {params.en && (
          <motion.div
            className="text-2xl opacity-60 mb-2 uppercase tracking-widest"
            style={{ fontFamily: "var(--pc-font-mono, ui-monospace, monospace)" }}
            initial={{ y: -20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.25, duration: 0.6, ease: easeExpoOut }}
          >
            {params.en}
          </motion.div>
        )}
        <motion.div
          className="text-[80px] font-bold text-white mb-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, ease: easeExpoOut }}
        >
          {params.term}
        </motion.div>
        <div className="text-[40px] text-gray-400 leading-snug">
          {chars.map((char, i) => (
            <motion.span
              key={i}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: (i * 30) / 1000, duration: 0.1 }}
            >
              {char}
            </motion.span>
          ))}
        </div>
      </div>
    </div>
  );
}

export const termCard: CardDef<Params> = {
  id: "term-card",
  name: "术语解释卡",
  description: "带拼音或英文小注的名词解释",
  source: "native",
  defaults: {
    ...hudDefaults,
    position: "center",
    en: "Terminology",
    term: "术语解释",
    def: "用一句人话来解释复杂的概念",
  },
  controls: [
    ...hudControls,
    { key: "en", label: "英文/拼音", type: "text" },
    { key: "term", label: "术语", type: "text" },
    { key: "def", label: "定义", type: "text" },
  ],
  Component: TermCard,
};
