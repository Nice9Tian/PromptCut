import { AnimatePresence, motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  lines: string;
  showEn: string;
  strokeOn: string;
  strokeW: number;
  strokeColor: string;
}

function parseLines(raw: string) {
  const parts = raw.split(/\n|\/\//).map((s) => s.trim()).filter(Boolean);
  return parts.map((p) => {
    const [startStr, endStr, zh, en] = p.split("|");
    return { start: parseFloat(startStr), end: parseFloat(endStr), zh: zh || "", en: en || "" };
  });
}

function genTextShadow(w: number, color: string) {
  let shadow = [];
  const steps = 12;
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const x = Math.round(Math.cos(angle) * w * 10) / 10;
    const y = Math.round(Math.sin(angle) * w * 10) / 10;
    shadow.push(`${x}px ${y}px 0 ${color}`);
  }
  return shadow.join(", ");
}

function CaptionTrackCard({ params, t = 0 }: CardProps<Params>) {
  const lines = parseLines(params.lines);
  const curIdx = lines.findIndex((l) => t >= l.start && t < l.end);
  const curLine = curIdx >= 0 ? lines[curIdx] : null;

  if (!curLine) {
    return <div className={`hud-wrapper ${getPositionClass(params.position)}`} style={{ alignItems: "flex-end", paddingBottom: "120px" }} />;
  }

  const zhParts = curLine.zh.split("*");
  const strokeStyle = params.strokeOn === "true" ? { textShadow: genTextShadow(params.strokeW, params.strokeColor) } : {};

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`} style={{ alignItems: "flex-end", paddingBottom: "120px" }}>
      <AnimatePresence mode="wait">
        <motion.div
          key={curIdx}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="flex flex-col items-center"
        >
          <div className="text-[56px] text-white text-center font-bold tracking-wide" style={strokeStyle}>
            {zhParts.map((part, i) => {
              if (i % 2 === 1) {
                return (
                  <span key={i} style={{ color: accentOf(params) }}>
                    {part}
                  </span>
                );
              }
              return <span key={i}>{part}</span>;
            })}
          </div>
          {params.showEn === "true" && curLine.en && (
            <div className="text-[32px] text-[#a0aab4] text-center mt-4">
              {curLine.en}
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

export const captionTrack: CardDef<Params> = {
  id: "caption-track",
  name: "常驻双语字幕",
  description: "根据时间显示双语字幕",
  source: "native",
  defaults: {
    ...hudDefaults,
    position: "bottom",
    lines: "0|2|好内容的核心是*选题精准*|A sharp topic beats everything else\n2|4|脚本要在前三秒*钩住观众*|Hook your viewer in the first three seconds\n4|6|剪辑节奏决定*完播率*|Editing pace drives completion rate",
    showEn: "true",
    strokeOn: "true",
    strokeW: 4,
    strokeColor: "#000000",
  },
  controls: [
    ...hudControls,
    { key: "lines", label: "字幕(起|止|中|英)", type: "text" },
    { key: "showEn", label: "显示英文", type: "select", options: [{ value: "true", label: "是" }, { value: "false", label: "否" }] },
    { key: "strokeOn", label: "开启描边", type: "select", options: [{ value: "true", label: "是" }, { value: "false", label: "否" }] },
    { key: "strokeW", label: "描边宽度", type: "number" },
    { key: "strokeColor", label: "描边颜色", type: "color" },
  ],
  Component: CaptionTrackCard,
};
