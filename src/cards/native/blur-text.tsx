import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  text: string;
  staggerMs: number;
}

function parseText(chunk: string, accent: string) {
  const parts = chunk.split(/(\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("*") && part.endsWith("*")) {
      return (
        <span key={i} style={{ color: accent }}>
          {part.slice(1, -1)}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function BlurTextCard({ params }: CardProps<Params>) {
  const chunks = params.text.split("|");
  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="hud-glass" data-theme={params.theme}>
        <div className="text-[80px] font-bold leading-tight flex flex-wrap gap-x-4">
          {chunks.map((chunk, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, filter: "blur(12px)", y: 12 }}
              animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
              transition={{
                duration: 0.8,
                delay: i * (params.staggerMs / 1000),
                ease: easeExpoOut,
              }}
            >
              {parseText(chunk, params.accent)}
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}

export const blurText: CardDef<Params> = {
  id: "blur-text",
  name: "模糊浮现",
  description: "词块逐个模糊浮现",
  source: "native",
  defaults: {
    ...hudDefaults,
    text: "走心的句子|从虚焦里|*慢慢浮现*",
    staggerMs: 220,
  },
  controls: [
    ...hudControls,
    { key: "text", label: "文字", type: "text" },
    { key: "staggerMs", label: "字间距(ms)", type: "number" },
  ],
  Component: BlurTextCard,
};
