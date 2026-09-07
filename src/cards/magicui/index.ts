import type { CardDef, Clip } from "../../kernel/types";
// MagicUI 组件用到的 animate-* 动画 class(shiny-text / marquee / orbit …)。
// 它们在 MagicUI 自己的 Tailwind 主题里,我们这边没有;这里引一次,全站可用,
// 翻译器导入的组件不用改一个 class 名。见该文件头的说明。
import "./vendor/magicui-animations.css";
import { numberTickerCard } from "./number-ticker.card";
import { blurFadeCard } from "./blur-fade.card";
import { animatedCircularProgressBarCard } from "./animated-circular-progress-bar.card";
import { typingAnimationCard } from "./typing-animation.card";
import { wordRotateCard } from "./word-rotate.card";

export const magicuiCards: CardDef<any>[] = [
  numberTickerCard,
  blurFadeCard,
  animatedCircularProgressBarCard,
  typingAnimationCard,
  wordRotateCard,
];

export const magicuiDemoClips: Clip[] = [
  { id: "mu-1", cardId: "mu-number-ticker", start: 0, end: 2, params: {} },
  { id: "mu-2", cardId: "mu-blur-fade", start: 2, end: 4, params: {} },
  { id: "mu-3", cardId: "mu-circular-progress", start: 4, end: 6, params: {} },
  { id: "mu-4", cardId: "mu-typing", start: 6, end: 8, params: {} },
  { id: "mu-5", cardId: "mu-word-rotate", start: 8, end: 10, params: {} },
];
