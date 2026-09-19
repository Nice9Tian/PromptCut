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

export const playback = {
  seek(t: number) {
    const clamped = Math.max(0, Math.min(state.project.duration, t));
    set({ t: clamped, playToken: state.playToken + 1 });
  },
  tick(t: number) {
    set({ t });
  },
  play() {
    set({ playing: true });
  },
  pause() {
    set({ playing: false });
  },
  togglePlay() {
    set({ playing: !state.playing });
  },
  replay() {
    // 播放范围从最早的卡片开始(和 Preview 的播放循环一致)
    let start = Infinity;
    for (const tr of state.project.tracks) for (const c of tr.clips) start = Math.min(start, c.start);
    set({ t: Number.isFinite(start) ? Math.max(0, start) : 0, playing: true, playToken: state.playToken + 1 });
  },
  setVolume(v: number) {
    const volume = Math.max(0, Math.min(1, v));
    try {
      localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {}
    set({ volume, muted: volume === 0 ? state.muted : false });
  },
  toggleMute() {
    set({ muted: !state.muted });
  },
  select(ids: string[]) {
    set({ selection: ids });
  },
};
