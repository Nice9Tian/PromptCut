import type { CardDef, Clip } from "../../kernel/types";
import { odometer } from "./odometer";
import { blurText } from "./blur-text";
import { ringMetric } from "./ring-metric";
import { checklist } from "./checklist";
import { stepTimeline } from "./step-timeline";
import { textCards } from "./batch-text";
import { dataCards } from "./batch-data";
import { timelineCards } from "./batch-timeline";
import { lottieCard } from "./lottie";
import { particlesCard } from "./particles";

/** 自家用 Motion 写的卡。每张卡一个文件,在这里汇总。 */
export const nativeCards: CardDef<any>[] = [
  lottieCard,
  particlesCard,
  odometer,
  blurText,
  ringMetric,
  checklist,
  stepTimeline,
  ...textCards,
  ...dataCards,
  ...timelineCards,
];

export const nativeDemoClips: Clip[] = [
  { id: "n1", cardId: "odometer", start: 10, end: 12, params: {} },
  { id: "n2", cardId: "blur-text", start: 12, end: 14, params: {} },
  { id: "n3", cardId: "ring-metric", start: 14, end: 16, params: {} },
  { id: "n4", cardId: "checklist", start: 16, end: 18, params: {} },
  { id: "n5", cardId: "step-timeline", start: 18, end: 20, params: {} }
];
