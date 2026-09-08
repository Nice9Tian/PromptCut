import { motion } from "motion/react";
import type { PartDef, PartProps } from "../types";
import { easeExpoOut } from "../../cards/native/hud";
import "../../cards/native/hud.css";

/**
 * 术语卡:带拼音或英文小注的名词解释。从 term-card 拆出。
 * 英文小注强制大写，定义文本逐字淡入。
 */
interface Params {
  en: string;
  term: string;
  def: string;
}

function TermPart({ params }: PartProps<Params>) {
  const chars = params.def.split("");
  return (
    <div
      className="hud-glass"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        boxSizing: "border-box",
      }}
    >
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
  );
}

export const textTerm: PartDef<Params> = {
  id: "text-term",
  name: "术语解释卡",
  description: "带英文小注的大术语与逐字释义",
  useWhen: "口播下定义、解释专业概念或名词时使用，包含顶部大写英文小注、超大术语名以及逐字打字淡入的解释文本；单纯大标题用 text-title，段落正文用 text-body。",
  tags: ["术语", "定义", "名词", "解释", "概念"],
  role: "text",
  from: "term-card",
  defaults: {
    en: "Terminology",
    term: "术语解释",
    def: "用一句人话来解释复杂的概念",
  },
  controls: [
    { key: "en", label: "英文小注", type: "text" },
    { key: "term", label: "术语", type: "text", required: true },
    { key: "def", label: "定义", type: "text", required: true },
  ],
  defaultFrame: { x: 360, y: 240, w: 1200, h: 560 },
  settleMs: (p) => Math.max(850, p.def.length * 30 + 100),
  after: "hold",
  Component: TermPart,
};
