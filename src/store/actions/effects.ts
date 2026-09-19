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

export const effects = {
  addFilter(def: FilterDef, attach?: { clipId: string; filter: ClipFilter }) {
    const p = state.project;
    let tracks = p.tracks;
    if (attach) {
      const hit = findClip(p, attach.clipId);
      if (hit) tracks = updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === attach.clipId ? { ...c, filter: attach.filter } : c)) })).tracks;
    }
    setProject({ ...p, tracks, filters: [...(p.filters ?? []), def] });
  },
  updateFilter(filterId: string, def: FilterDef) {
    setProject({ ...state.project, filters: (state.project.filters ?? []).map((f) => (f.id === filterId ? def : f)) });
  },
  removeFilter(filterId: string) {
    const p = state.project;
    setProject(stripFilterFromCuts({
      ...p,
      filters: (p.filters ?? []).filter((f) => f.id !== filterId),
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.filter?.id === filterId ? withoutFilter(c) : c)) })),
    }, filterId));
  },
  setClipFilter(clipId: string, filter: ClipFilter | null): boolean {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id !== clipId ? c : filter ? { ...c, filter } : withoutFilter(c))),
    })));
    return true;
  },
  addPixelMap(def: PixelMapDef, attach?: { clipId: string; pixelMap: ClipPixelMap }) {
    const p = state.project;
    let tracks = p.tracks;
    if (attach) {
      const hit = findClip(p, attach.clipId);
      if (hit) tracks = updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => c.id === attach.clipId ? { ...c, pixelMap: attach.pixelMap } : c) })).tracks;
    }
    setProject({ ...p, tracks, pixelMaps: [...(p.pixelMaps ?? []), def] });
  },
  updatePixelMap(id: string, def: PixelMapDef) {
    setProject({ ...state.project, pixelMaps: (state.project.pixelMaps ?? []).map((x) => x.id === id ? def : x) });
  },
  removePixelMap(id: string) {
    const p = state.project;
    setProject({ ...p, pixelMaps: (p.pixelMaps ?? []).filter((x) => x.id !== id), tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => c.pixelMap?.id === id ? (() => { const { pixelMap, ...rest } = c; return rest; })() : c) })) });
  },
  setClipPixelMap(clipId: string, pixelMap: ClipPixelMap | null): boolean {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => c.id === clipId ? (pixelMap ? { ...c, pixelMap } : (() => { const { pixelMap: _, ...rest } = c; return rest; })()) : c) })));
    return true;
  },
  addTransition(args: { kind: TransitionKind; clipId: string; otherClipId?: string; dur?: number }):
    { ok: true; transition: Transition } | { ok: false; error: string } {
    const p = state.project;
    const dur = clampDur(args.dur, args.kind === "crossfade" ? 0.5 : 0.6);

    if (args.kind === "fadeIn" || args.kind === "fadeOut") {
      const chk = checkFade(p, args.clipId, args.kind, dur);
      if (!chk.ok) return chk;
      const tr: Transition = { id: newId("tx"), kind: args.kind, aId: args.clipId, dur: chk.dur };
      const hit = findClip(p, args.clipId)!;
      const next = updateTrack(p, hit.track.id, (t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === args.clipId ? { ...c, [args.kind]: chk.dur } : c)),
      }));
      setProject({ ...next, transitions: [...transitionsOf(next), tr] });
      return { ok: true, transition: tr };
    }

    if (!args.otherClipId) return { ok: false, error: "交叉溶解要两段:clipId 和 otherClipId" };
    const chk = checkCrossfade(p, args.clipId, args.otherClipId, dur);
    if (!chk.ok) return chk;
    const { a, b } = chk;
    const aTrack = findClip(p, a.id)!.track;
    const bTrack = findClip(p, b.id)!.track;
    const len = b.end - b.start;
    const newStart = Math.max(0, b.start - chk.dur);
    const fits = (tr: Track) =>
      !tr.locked && tr.id !== aTrack.id &&
      !tr.clips.some((c) => c.id !== b.id && Math.max(newStart, c.start) < Math.min(newStart + len, c.end) - 1e-6);

    // 先原地(后一段本来就不在前一段那条序列上、且挪过去放得下),再找别的,最后新建一条
    const target = [bTrack, ...p.tracks.filter((t) => t.id !== bTrack.id)].find(fits);
    const newTrack: Track | null = target ? null : { id: newId("t"), name: `序列 ${p.tracks.length + 1}`, clips: [] };
    const targetId = target?.id ?? newTrack!.id;

    const movedB: TrackClip = { ...b, start: newStart, end: newStart + len, fadeIn: chk.dur };
    let tracks = p.tracks.map((t) => {
      let clips = t.clips.filter((c) => c.id !== b.id);
      if (t.id === aTrack.id) clips = clips.map((c) => (c.id === a.id ? { ...c, fadeOut: chk.dur } : c));
      if (t.id === targetId) clips = sortClips([...clips, movedB]);
      return { ...t, clips };
    });
    if (newTrack) tracks = [...tracks, { ...newTrack, clips: [movedB] }];

    const tr: Transition = {
      id: newId("tx"), kind: "crossfade", aId: a.id, bId: b.id, dur: chk.dur,
      prevB: { start: b.start, trackId: bTrack.id },
    };
    setProject({ ...p, tracks, transitions: [...transitionsOf(p), tr] });
    return { ok: true, transition: tr };
  },
  removeTransition(transitionId: string): { ok: true; note?: string } | { ok: false; error: string } {
    const p = state.project;
    const tr = transitionsOf(p).find((x) => x.id === transitionId);
    if (!tr) return { ok: false, error: `找不到转场 ${transitionId}` };
    let next = clearTransitionFades(p, tr);
    let note: string | undefined;
    if (tr.kind === "crossfade" && tr.bId && tr.prevB) {
      const hit = findClip(next, tr.bId);
      if (hit) {
        const len = hit.clip.end - hit.clip.start;
        const home = next.tracks.find((t) => t.id === tr.prevB!.trackId);
        const free = home && !home.locked && !home.clips.some(
          (c) => c.id !== tr.bId && Math.max(tr.prevB!.start, c.start) < Math.min(tr.prevB!.start + len, c.end) - 1e-6,
        );
        if (free) {
          const moved: TrackClip = { ...hit.clip, start: tr.prevB.start, end: tr.prevB.start + len };
          next = {
            ...next,
            tracks: next.tracks.map((t) => {
              let clips = t.clips.filter((c) => c.id !== tr.bId);
              if (t.id === home!.id) clips = sortClips([...clips, moved]);
              return { ...t, clips };
            }),
          };
        } else {
          note = "后一段原来的位置被占了,留在当前位置(两段现在还重叠着,可以自己挪开)";
        }
      }
    }
    setProject({ ...next, transitions: transitionsOf(next).filter((x) => x.id !== transitionId) });
    return { ok: true, ...(note ? { note } : {}) };
  },
  applyCrossfade(aId: string, bId: string, dur: number): boolean {
    return actions.addTransition({ kind: "crossfade", clipId: aId, otherClipId: bId, dur }).ok;
  },
};
