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

export const properties = {
  setClipParts(clipId: string, parts: PartInstance[]) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!parts.length) {
          const { parts: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, parts };
      }),
    })));
    return true;
  },
  setClipEmphasis(clipId: string, emphasis: Partial<ClipEmphasis> | null): { ok: boolean; emphasis: ClipEmphasis | null; error?: string } {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return { ok: false, emphasis: null, error: `找不到片段 ${clipId}` };
    const next = emphasis ? normalizeEmphasis(emphasis) : null;
    if (emphasis && !next) return { ok: false, emphasis: null, error: "强调只有 shadow(阴影)和 outline(描边)两种" };
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!next) {
          // 去掉时把键删掉,而不是留个 undefined —— 存进 .proc 会多一行没用的
          const { emphasis: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, emphasis: next };
      }),
    })));
    return { ok: true, emphasis: next };
  },
  setClipMotion(clipId: string, motion: ClipMotion | undefined) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!motion) {
          const { motion: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, motion };
      }),
    })));
    return true;
  },
  setClipFrame(clipId: string, frame: ClipFrame | undefined) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        if (!frame) {
          const { frame: _drop, ...rest } = c;
          return rest;
        }
        return { ...c, frame };
      }),
    })));
    return true;
  },
};
