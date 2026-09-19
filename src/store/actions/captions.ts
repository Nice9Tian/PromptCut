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

export const captions = {
  ensureCaptionTrack(): Track {
    const found = state.project.tracks.find((t) => t.name === CAPTION_TRACK_NAME);
    if (found) return found;
    return actions.addTrack(CAPTION_TRACK_NAME, { index: 0 });
  },
  buildCaptions(mediaId: string): { ok: true; clipId: string; count: number } | { ok: false; reason: string } {
    const p = state.project;
    const media = p.media.find((m) => m.id === mediaId);
    if (!media) return { ok: false, reason: "找不到这份素材" };
    const segments = media.transcript?.segments ?? [];
    if (segments.length === 0) return { ok: false, reason: "这份素材还没有文字稿" };

    const clips = p.tracks.flatMap((t) => t.clips);
    const plan = captionsFromTranscript(clips, mediaId, segments);
    if (plan.lines.length === 0) return { ok: false, reason: "这份素材还没放到时间轴上,先把它拖上去再铺字幕" };

    const track = actions.ensureCaptionTrack();
    // 同一时段已经有字幕卡就复用它(重新转写之后再铺一次是常事,不该越铺越多)
    const exist = track.clips.find((c) => isCaptionClip(c) && Math.max(c.start, plan.from) < Math.min(c.end, plan.to));
    if (exist) {
      const re = captionsFromTranscript(clips, mediaId, segments, { from: exist.start, to: exist.end });
      if (re.lines.length === 0) return { ok: false, reason: "文字稿没有落在那张字幕卡的时段里" };
      actions.setClipParams(exist.id, { lines: formatCaptions(re.lines) });
      return { ok: true, clipId: exist.id, count: re.lines.length };
    }
    const clip = actions.addCardClip(CAPTION_CARD_ID, plan.from, {
      duration: plan.to - plan.from,
      trackId: track.id,
      params: { lines: formatCaptions(plan.lines), showEn: "false" },
    });
    if (!clip) return { ok: false, reason: "建字幕卡失败" };
    return { ok: true, clipId: clip.id, count: plan.lines.length };
  },
  editCaption(clipId: string, index: number, patch: { start?: number; end?: number; zh?: string; en?: string }): number {
    const hit = findClip(state.project, clipId);
    if (!hit || !isCaptionClip(hit.clip)) return -1;
    const lines = captionsOf(hit.clip);
    const res = editCaptionLine(lines, index, patch, hit.clip.end - hit.clip.start);
    if (res.index < 0) return -1;
    actions.setClipParams(clipId, { lines: formatCaptions(res.lines) });
    return res.index;
  },
  removeCaption(clipId: string, index: number): boolean {
    const hit = findClip(state.project, clipId);
    if (!hit || !isCaptionClip(hit.clip)) return false;
    const lines = captionsOf(hit.clip);
    if (index < 0 || index >= lines.length) return false;
    actions.setClipParams(clipId, { lines: formatCaptions(removeCaptionLine(lines, index)) });
    return true;
  },
  addCaption(clipId: string, at: { start: number; end?: number; zh?: string; en?: string }): number {
    const hit = findClip(state.project, clipId);
    if (!hit || !isCaptionClip(hit.clip)) return -1;
    const res = insertCaption(captionsOf(hit.clip), at, hit.clip.end - hit.clip.start);
    if (res.index < 0) return -1;
    actions.setClipParams(clipId, { lines: formatCaptions(res.lines) });
    return res.index;
  },
};
