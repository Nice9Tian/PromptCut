import { motion } from "motion/react";
import type { PartDef, PartProps } from "../types";
import { easeExpoOut, accentOf } from "../../cards/native/hud";

/**
 * 步骤时间线:横向伸展的时间线和逐个点亮的步骤圈。
 * 从 step-timeline 拆出,不含外壳玻璃板。
 * 进场:线条展开的同时按顺序点亮圆圈,最后一个圆圈会有循环呼吸动画。
 */
interface Params {
  steps: string;
  stepMs: number;
  accent: string;
}

function ListStepsPart({ params, width, height }: PartProps<Params>) {
  const steps = params.steps.split("|").filter(Boolean);
  const numSteps = steps.length;
  if (numSteps === 0) return null;

  const lineDuration = (numSteps - 1) * (params.stepMs / 1000);
  const padding = 120;
  const innerWidth = width - padding * 2;

  return (
    <div style={{ position: "absolute", inset: 0, width, height, display: "flex", alignItems: "center" }}>
      <div className="relative w-full h-48">
        <div className="absolute top-8 h-4 bg-current opacity-20 rounded" style={{ left: padding, width: innerWidth }} />
        <motion.div
          className="absolute top-8 h-4 origin-left rounded"
          style={{ left: padding, width: innerWidth, backgroundColor: accentOf(params) }}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: lineDuration, ease: "linear" }}
        />

        {steps.map((step, i) => {
          const isLast = i === numSteps - 1;
          const nodeDelay = i * (params.stepMs / 1000);
          const left = padding + (numSteps > 1 ? i * (innerWidth / (numSteps - 1)) : innerWidth / 2);

          return (
            <div
              key={i}
              className="absolute flex flex-col items-center"
              style={{ left, transform: "translateX(-50%)", top: "-12px" }}
            >
              <div className="relative">
                {isLast && (
                  <motion.div
                    className="absolute inset-0"
                    style={{ borderRadius: "50%", backgroundColor: accentOf(params) }}
                    initial={{ scale: 1, opacity: 0 }}
                    animate={{ scale: [1, 2.5], opacity: [0.5, 0] }}
                    transition={{ duration: 1.5, repeat: Infinity, delay: nodeDelay + 0.3 }}
                  />
                )}
                <motion.div
                  className="w-20 h-20 rounded-full border-8 relative z-10 flex items-center justify-center"
                  initial={{ borderColor: "var(--pc-glass-border)", backgroundColor: "transparent", scale: 0.8 }}
                  animate={{ borderColor: accentOf(params), backgroundColor: accentOf(params), scale: 1 }}
                  transition={{ duration: 0.4, delay: nodeDelay, ease: easeExpoOut }}
                >
                  <span className="text-3xl font-bold" style={{ color: "var(--pc-on-accent, #0b1220)" }}>{i + 1}</span>
                </motion.div>
              </div>
              <motion.div
                className="mt-8 text-[56px] font-bold whitespace-nowrap text-center"
                initial={{ opacity: 0.4 }}
                animate={{ opacity: 1, color: accentOf(params) }}
                transition={{ duration: 0.4, delay: nodeDelay }}
              >
                {step}
              </motion.div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const listSteps: PartDef<Params> = {
  id: "list-steps",
  name: "步骤时间线",
  description: "横向时间线依次点亮",
  useWhen: "有先后顺序的步骤或流程时使用。最多 5 步、每步步名不超过 4 字,超了会叠字;这是挂载即播的进场动画、不跟时间轴走,贯穿全片的章节进度用 list-chapters;没有先后关系的并列要点用 list-pins。",
  tags: ["步骤", "流程", "时间线", "顺序"],
  role: "list",
  from: "step-timeline",
  defaults: {
    steps: "选题|脚本|拍摄|剪辑|发布",
    stepMs: 250,
    accent: "",
  },
  controls: [
    { key: "steps", label: "步骤(竖线分隔)", type: "text" },
    { key: "stepMs", label: "步进时间(ms)", type: "number", min: 100, max: 2000, step: 50 },
    { key: "accent", label: "颜色", type: "color" },
  ],
  defaultFrame: { x: 960, y: 540, w: 1500, h: 300, anchor: [0.5, 0.5] },
  settleMs: (p) => (Math.max(1, p.steps.split("|").filter(Boolean).length) - 1) * p.stepMs + 400,
  after: "loop",
  Component: ListStepsPart,
};
