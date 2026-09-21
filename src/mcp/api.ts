import type { EditorApi } from "../ai/mcpExecutor";
import { visionHandlers } from "./handlers/vision";
import { projectHandlers } from "./handlers/project";
import { clipsHandlers } from "./handlers/clips";
import { layoutHandlers } from "./handlers/layout";
import { partsHandlers } from "./handlers/parts";
import { tracksHandlers } from "./handlers/tracks";
import { effectsHandlers } from "./handlers/effects";
import { audioHandlers } from "./handlers/audio";
import { cardsHandlers } from "./handlers/cards";
import { aiHandlers } from "./handlers/ai";
import { collectHandlers } from "./handlers/collect";
import { playbackHandlers } from "./handlers/playback";
import { systemHandlers } from "./handlers/system";

export const editorApi: EditorApi = {
  ...visionHandlers,
  ...projectHandlers,
  ...clipsHandlers,
  ...layoutHandlers,
  ...partsHandlers,
  ...tracksHandlers,
  ...effectsHandlers,
  ...audioHandlers,
  ...cardsHandlers,
  ...aiHandlers,
  ...collectHandlers,
  ...playbackHandlers,
  ...systemHandlers,
};
