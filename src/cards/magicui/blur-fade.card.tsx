import type { CardDef, CardProps } from "../../kernel/types";
import { BlurFade } from "./vendor/blur-fade";

interface Params {
  text: string;
  accent: string;
  position: "center" | "bottom";
}

function BlurFadeCard({ params }: CardProps<Params>) {
  const isBottom = params.position === "bottom";
  return (
    <div className={`absolute inset-0 flex ${isBottom ? 'items-end pb-32' : 'items-center'} justify-center bg-transparent`}>
      <BlurFade startImmediately={true} delay={0} yOffset={20}>
        <h2 className="text-[96px] font-bold drop-shadow-xl" style={{ color: params.accent }}>
          {params.text}
        </h2>
      </BlurFade>
    </div>
  );
}

export const blurFadeCard: CardDef<Params> = {
  id: "mu-blur-fade",
  name: "模糊浮现",
  description: "文字从模糊中浮现",
  source: "magicui",
  defaults: { text: "你好世界", accent: "#ffffff", position: "center" },
  controls: [
    { key: "text", label: "文本", type: "text" },
    { key: "accent", label: "主色", type: "color" },
    {
      key: "position",
      label: "位置",
      type: "select",
      options: [
        { value: "center", label: "居中" },
        { value: "bottom", label: "底部" },
      ],
    },
  ],
  Component: BlurFadeCard,
};
