// Facade for backward compatibility
// 这里只转出拆分前 project.ts 本来就对外公开的那几个名字(EditorState / planPlacement /
// getState / subscribe / useStore,再加下面拼出来的 actions)。core.ts 里的 state、set、
// setProject、history、future、listeners、emit 等是包内原语,只给 src/store/actions 用,
// 不从这里转出去。
export type { EditorState } from "./core";
export { getState, subscribe, useStore, planPlacement } from "./core";

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
