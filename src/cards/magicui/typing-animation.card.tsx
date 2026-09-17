import type { CardDef, CardProps } from "../../kernel/types";
import { TypingAnimation } from "./vendor/typing-animation";

interface Params {
  text: string;
  duration: number;
}

function TypingAnimationCard({ params }: CardProps<Params>) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-transparent px-32" style={{ fontFamily: "var(--pc-font, system-ui, sans-serif)" }}>
      <TypingAnimation
        text={params.text}
        duration={params.duration}
        className="font-bold"
        style={{ fontSize: 80, lineHeight: "1.2", color: "var(--pc-fg, #f3f4f6)", textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))" }}
      />
    </div>
  );
}

export const typingAnimationCard: CardDef<Params> = {
  id: "mu-typing",
  name: "打字机",
  description: "逐字打印动画",
  useWhen: "逐字打印一行普通文字。**播放时长等于字数乘以每字毫秒数**(默认 120ms,20 字就要 2.4 秒),clip 给短了会打不完。要终端/代码风格用 terminal-3d。",
  tags: ["打字机","逐字","文字"],
  source: "magicui",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  // 全仓唯一一张「某些参数下动态推导会翻成 direct」的卡:text 为空串、或 duration 为 0 时
  // timing() 算出 settleMs: 0 且 lifecycle.after 是 hold,旧推导会判 direct。但 vendor 的
  // TypingAnimation 是从挂载起跑 rAF 的(见 vendor/typing-animation.tsx:第 0 帧显示空串),
  // 那两种参数下也必须推一帧才出画面,推导判 direct 本身就是错的。固化成 stateful 更保守也更正确。
  frameMode: "stateful",
  defaults: { text: "这是一段打字机测试文字", duration: 120 },
  controls: [
    { key: "text", label: "文本", type: "text" },
    { key: "duration", label: "每字毫秒", type: "number" },
  ],
  parts: [
    { id: "text", label: "文字", role: "text", params: ["text", "duration"], enterMs: 0, settleMs: 1320 },
  ],
  lifecycle: { settleMs: 1320, after: "hold", exit: ["fade"] },
  timing: (p) => {
    const settle = p.text.length * p.duration;
    return { settleMs: settle, parts: { text: { settleMs: settle } } };
  },
  Component: TypingAnimationCard,
};
