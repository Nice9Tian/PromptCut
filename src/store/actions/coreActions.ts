import { useSyncExternalStore } from "react";
import { createEmptyProject, DEFAULT_CARD_DUR, DEFAULT_MEDIA_DUR, findClip, findSoundAsset, newId, newProjectId, soundAssetFrom, type MediaAsset, type Project, type Track, type TrackClip, type Transcript, type Shots, type Subjects } from "../../kernel/project";
import { getCard } from "../../kernel/registry";
import { cloneCardClipInstance } from "../../kernel/cardAuthoring.mjs";
import { normalizeEmphasis, type ClipEmphasis } from "../../kernel/emphasis";
import {
  CAPTION_CARD_ID,
  CAPTION_TRACK_NAME,
  captionsFromTranscript,
  captionsOf,
  editCaption as editCaptionLine,
  formatCaptions,
  insertCaption,
  isCaptionClip,
  removeCaption as removeCaptionLine,
} from "../../kernel/captions";
import type { ClipFrame, ClipMotion, PartInstance } from "../../kernel/types";
import {
  normalizeCuts, switchCut as switchCutPure, addCut as addCutPure, renameCut as renameCutPure,
  removeCut as removeCutPure, stripMediaFromCuts, stripFilterFromCuts, withoutFilter, stripAudioFxFromCuts, withoutAudioFx,
} from "../../kernel/cuts";
import type { ClipFilter, FilterDef } from "../../kernel/filters.mjs";
import type { AudioFxDef, ClipAudioFx } from "../../kernel/audioFx.mjs";
import type { ClipPixelMap, PixelMapDef } from "../../kernel/pixelMap.mjs";
import {
  checkCrossfade, checkFade, clampDur, fadeOwner, groupOf, timingLock,
  transitionsOf, transitionsOfClip, type Transition, type TransitionKind,
} from "../../kernel/transitions";

import {
  VOLUME_KEY,
  readVolume,
  state,
  listeners,
  history,
  future,
  emit,
  set,
  setProject,
  clearTransitionFades,
  updateTrack,
  pruneCardNodes,
  shiftClipsBy,
  sortClips,
  resolveOverlap,
  placeOrShift,
  planPlacement,
  pickTrack,
  getState,
  subscribe,
  useStore
} from "../core";
import { actions } from "../project";

export const coreActions = {
  loadProject(p: Project, filePath: string | null = null) {
    history.length = 0;
    future.length = 0;
    // 所有加载路径的唯一入口,在这里把项目补成多剪辑形状:老文件没有 cuts 就补成默认三条。
    // 顺带兜住身份:定制卡的归属认 project.id,哪条路进来的项目都得有一个(见 Project.id)
    const normalized = normalizeCuts(p.id ? p : { ...p, id: newProjectId() });
    // lastCamera3dFov 跟着项目走,换项目要清掉,否则三维视角会串味
    set({ project: normalized, filePath, dirty: false, t: 0, playing: false, selection: [], playToken: state.playToken + 1, durationManual: null, lastCamera3dFov: null });
  },
  newProject(name?: string) {
    actions.loadProject(createEmptyProject(name));
  },
  markSaved(filePath: string | null) {
    set({ filePath, dirty: false });
  },
  undo() {
    const prev = history.pop();
    if (!prev) return;
    future.push(state.project);
    set({ project: prev, dirty: true });
  },
  redo() {
    const next = future.pop();
    if (!next) return;
    history.push(state.project);
    set({ project: next, dirty: true });
  },
};
