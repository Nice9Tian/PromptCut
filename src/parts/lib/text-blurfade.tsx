import type { PartDef, PartProps } from "../types";
import { BlurFade } from "../../cards/magicui/vendor/blur-fade";
import { accentOf } from "../../cards/native/hud";

/**
 * 模糊浮现文字:从 mu-blur-fade 拆出。
 * 复用 Magic UI 的 BlurFade，支持自定义文字和主题色，在部件框内居中。
 */
interface Params {
  text: string;
  accent: string;
}

function BlurFadePart({ params }: PartProps<Params>) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        fontFamily: "var(--pc-font, system-ui, sans-serif)",
      }}
    >
      <BlurFade startImmediately={true} delay={0} yOffset={20}>
        <h2
          className="text-[96px] font-bold"
          style={{
            color: accentOf(params),
            textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))",
            margin: 0,
          }}
        >
          {params.text}
        </h2>
      </BlurFade>
    </div>
  );
}

export const textBlurfade: PartDef<Params> = {
  id: "text-blurfade",
  name: "模糊浮现(整体)",
  description: "文字整体从模糊中浮现",
  useWhen: "Magic UI 的整块模糊浮现，适合展示较短的标题或单句；要词块逐个浮现的节奏感请用 text-blur。",
  tags: ["浮现", "模糊", "文字"],
  role: "text",
  from: "mu-blur-fade",
  defaults: {
    text: "你好世界",
    accent: "",
  },
  controls: [
    { key: "text", label: "文本", type: "text", required: true },
    { key: "accent", label: "主色(留空用主题色)", type: "color" },
  ],
  defaultFrame: { x: 360, y: 440, w: 1200, h: 200 },
  settleMs: () => 400,
  after: "hold",
  Component: BlurFadePart,
};
