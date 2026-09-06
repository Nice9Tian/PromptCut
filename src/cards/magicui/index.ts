import type { CardDef, Clip } from "../../kernel/types";
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
