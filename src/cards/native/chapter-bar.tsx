import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  chapters: string;
  showProgress: string;
  progMode: string;
  progAccent: string;
  progAlpha: number;
}

function ChapterBarCard({ params, t = 0, duration = 6 }: CardProps<Params>) {
  const rawChapters = params.chapters.split("|").filter(Boolean);
  const chaps = rawChapters.map((raw) => {
    const lastSpace = raw.lastIndexOf(" ");
    const name = raw.substring(0, lastSpace).trim();
    const start = parseFloat(raw.substring(lastSpace + 1));
    return { name, start };
  });

  let curIdx = 0;
  for (let i = 0; i < chaps.length; i++) {
    if (t >= chaps[i].start) {
      curIdx = i;
    }
  }

  const curStart = chaps[curIdx]?.start ?? 0;
  const nextStart = curIdx < chaps.length - 1 ? chaps[curIdx + 1].start : duration;
  let progress = (t - curStart) / (nextStart - curStart);
  if (isNaN(progress)) progress = 0;
  progress = Math.max(0, Math.min(1, progress));

  const pAccent = params.progAccent && params.progAccent.trim() ? params.progAccent : accentOf(params);

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`} style={{ alignItems: "flex-start", paddingTop: "80px" }}>
      <motion.div
        className="hud-glass"
        style={{ padding: "20px 32px", display: "flex", gap: "32px", borderRadius: "100px", alignItems: "center" }}
        initial={{ y: -120, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.8, ease: easeExpoOut }}
      >
        {chaps.map((chap, i) => {
          const isPast = i < curIdx;
          const isCur = i === curIdx;
          
          let color = "var(--pc-fg-faint)";
          if (isCur) color = accentOf(params);
          else if (isPast) color = "var(--pc-fg-muted)";

          return (
            <div key={i} className="relative px-8 py-4 rounded-full text-[48px] font-bold" style={{ zIndex: 1 }}>
              {isCur && (
                <motion.div
                  layoutId="chapter-bg"
                  className="absolute inset-0"
                  style={{ backgroundColor: accentOf(params), opacity: 0.18, zIndex: -1, borderRadius: "9999px" }}
                  transition={{ duration: 0.4, ease: easeExpoOut }}
                />
              )}
              {isCur && params.showProgress === "true" && params.progMode === "fill" && (
                <div
                  className="absolute inset-0 rounded-full overflow-hidden"
                  style={{ zIndex: -1 }}
                >
                  <div
                    className="absolute inset-y-0 left-0"
                    style={{
                      backgroundColor: pAccent,
                      opacity: params.progAlpha,
                      width: `${progress * 100}%`,
                    }}
                  />
                </div>
              )}
              {isCur && params.showProgress === "true" && params.progMode === "line" && (
                <div
                  className="absolute bottom-0 left-0 h-2"
                  style={{
                    backgroundColor: pAccent,
                    opacity: params.progAlpha,
                    width: "100%",
                    transform: `scaleX(${progress})`,
                    transformOrigin: "left",
                    zIndex: -1
                  }}
                />
              )}
              <span style={{ color, position: "relative", zIndex: 1 }}>{chap.name}</span>
            </div>
          );
        })}
      </motion.div>
    </div>
  );
}

export const chapterBar: CardDef<Params> = {
  id: "chapter-bar",
  name: "章节导航",
  description: "常驻顶部的章节进度",
  source: "native",
  defaults: {
    ...hudDefaults,
    position: "center",
    chapters: "选题 0|脚本 2|剪辑 4",
    showProgress: "true",
    progMode: "fill",
    progAccent: "",
    progAlpha: 0.45,
  },
  controls: [
    ...hudControls,
    { key: "chapters", label: "章节(名称 秒)", type: "text" },
    { key: "showProgress", label: "显示进度", type: "select", options: [{ value: "true", label: "是" }, { value: "false", label: "否" }] },
    { key: "progMode", label: "进度模式", type: "select", options: [{ value: "fill", label: "填充" }, { value: "line", label: "底线" }] },
    { key: "progAccent", label: "进度颜色", type: "color" },
    { key: "progAlpha", label: "进度透明度", type: "number", step: 0.1 },
  ],
  Component: ChapterBarCard,
};
