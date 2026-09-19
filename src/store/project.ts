// Facade for backward compatibility
export type { EditorState } from "./core";
export { getState, subscribe, useStore } from "./core";
export * from "./core";

import { coreActions } from "./actions/coreActions";
import { projectMeta } from "./actions/projectMeta";
import { playback } from "./actions/playback";
import { tracks } from "./actions/tracks";
import { clips } from "./actions/clips";
import { media } from "./actions/media";
import { effects } from "./actions/effects";
import { audio } from "./actions/audio";
import { captions } from "./actions/captions";
import { cuts } from "./actions/cuts";
import { properties } from "./actions/properties";

export const actions = {
  ...coreActions,
  ...projectMeta,
  ...playback,
  ...tracks,
  ...clips,
  ...media,
  ...effects,
  ...audio,
  ...captions,
  ...cuts,
  ...properties,
};
