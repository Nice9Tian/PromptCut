// Facade for backward compatibility
import { projectTools } from "./tools/project.mjs";
import { clipsTools } from "./tools/clips.mjs";
import { layoutTools } from "./tools/layout.mjs";
import { tracksTools } from "./tools/tracks.mjs";
import { partsTools } from "./tools/parts.mjs";
import { effectsTools } from "./tools/effects.mjs";
import { cutsTools } from "./tools/cuts.mjs";
import { audioTools } from "./tools/audio.mjs";
import { aiTools } from "./tools/ai.mjs";
import { cardsTools } from "./tools/cards.mjs";
import { visionTools } from "./tools/vision.mjs";
import { collectTools } from "./tools/collect.mjs";
import { browserTools } from "./tools/browser.mjs";
import { agentTools } from "./tools/agent.mjs";
import { coreTools } from "./tools/core.mjs";

export const tools = [
  ...projectTools,
  ...clipsTools,
  ...layoutTools,
  ...tracksTools,
  ...partsTools,
  ...effectsTools,
  ...cutsTools,
  ...audioTools,
  ...aiTools,
  ...cardsTools,
  ...visionTools,
  ...collectTools,
  ...browserTools,
  ...agentTools,
  ...coreTools,
];
