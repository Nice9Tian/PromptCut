import type { CardDef, CardProps } from "../../kernel/types";
import { TypingAnimation } from "./vendor/typing-animation";

interface Params {
  text: string;
  duration: number;
}

function TypingAnimationCard({ params }: CardProps<Params>) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-transparent px-32">
      <TypingAnimation
        text={params.text}
        duration={params.duration}
        className="font-bold text-white drop-shadow-xl"
        style={{ fontSize: 80, lineHeight: "1.2" }}
      />
    </div>
  );
}

export const typingAnimationCard: CardDef<Params> = {
  id: "mu-typing",
  name: "打字机",
  description: "逐字打印动画",
  source: "magicui",
  defaults: { text: "这是一段打字机测试文字", duration: 150 },
  controls: [
    { key: "text", label: "文本", type: "text" },
    { key: "duration", label: "每字毫秒", type: "number" },
  ],
  Component: TypingAnimationCard,
};
