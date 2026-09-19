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

export const audio = {
  setClipVolume(clipId: string, volume: number) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return { ok: false, error: "找不到片段" };
    if (hit.track.locked) return { ok: false, error: "请先解锁序列" };
    const media = p.media.find((m) => m.id === hit.clip.mediaId);
    if (!media || (media.kind !== "video" && media.kind !== "audio")) return { ok: false, error: "只能调整音频或视频片段的音量" };
    if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 1) return { ok: false, error: "音量必须是 0 到 1 之间的数字" };
    if (volume !== (hit.clip.audioVolume ?? 1)) {
      setProject(updateTrack(p, hit.track.id, (track) => ({
        ...track, clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, audioVolume: volume } : clip),
      })));
    }
    return { ok: true, clipId, volume, muted: !!(hit.clip.audioMuted || hit.track.muted), hidden: !!hit.track.hidden };
  },
  separateAudio(clipId: string) {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return { ok: false, error: "找不到视频片段" };
    if (hit.track.locked) return { ok: false, error: "请先解锁序列" };
    const src = p.media.find((m) => m.id === hit.clip.mediaId);
    if (!src || src.kind !== "video") return { ok: false, error: "只能分离视频片段的音频" };
    if (hit.clip.audioMuted) return { ok: false, error: "此视频已静音或已分离音频" };
    const media = findSoundAsset(p, src.id) ?? soundAssetFrom(src, newId("m"));
    const audio: TrackClip = {
      id: newId("c"), cardId: "", mediaId: media.id, params: {}, label: media.name,
      start: hit.clip.start, end: hit.clip.end, mediaOffset: hit.clip.mediaOffset,
      opacity: hit.clip.opacity, fadeIn: hit.clip.fadeIn, fadeOut: hit.clip.fadeOut, audioVolume: hit.clip.audioVolume,
      // 挂着的音频效果跟着声音走:分离出来的那段就是原来出声的那段
      ...(hit.clip.audioFx ? { audioFx: hit.clip.audioFx } : null),
    };
    const track: Track = { id: newId("t"), name: media.name, muted: hit.track.muted, hidden: hit.track.hidden, clips: [audio] };
    const tracks = p.tracks.map((t) => t.id === hit.track.id
      ? { ...t, clips: t.clips.map((c) => c.id === clipId ? { ...c, audioMuted: true } : c) } : t);
    tracks.splice(p.tracks.indexOf(hit.track) + 1, 0, track);
    setProject({ ...p, tracks, media: p.media.includes(media) ? p.media : [...p.media, media] });
    return { ok: true, clipId, audioClipId: audio.id, trackId: track.id, mediaId: media.id };
  },
  audioFromVideo(mediaId: string): { ok: true; media: MediaAsset; created: boolean } | { ok: false; error: string } {
    const p = state.project;
    const src = p.media.find((m) => m.id === mediaId);
    if (!src) return { ok: false, error: `找不到素材 ${mediaId}` };
    if (src.kind === "image") return { ok: false, error: `「${src.name}」是图片,没有声音` };
    if (src.kind === "audio") return { ok: true, media: src, created: false };
    const had = findSoundAsset(p, mediaId);
    if (had) return { ok: true, media: had, created: false };
    const media = soundAssetFrom(src, newId("m"));
    // 素材库的增删和 addMedia 一样不进撤销栈:撤销管的是时间轴,不是素材柜
    setProject({ ...p, media: [...p.media, media] }, { undoable: false });
    return { ok: true, media, created: true };
  },
  convertClipToAudio(clipId: string): { ok: true; mediaId: string; created: boolean; already?: boolean } | { ok: false; error: string } {
    const hit = findClip(state.project, clipId);
    if (!hit) return { ok: false, error: `找不到片段 ${clipId}` };
    if (!hit.clip.mediaId) return { ok: false, error: "这段是卡片,不是素材,没有声音可转" };
    const r = actions.audioFromVideo(hit.clip.mediaId);
    if (!r.ok) return r;
    if (r.media.id === hit.clip.mediaId) return { ok: true, mediaId: r.media.id, created: false, already: true };
    const p = state.project; // audioFromVideo 已经写过一次,这里要拿新的
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      // 名字也跟着换:时间轴上还挂着「访谈.mp4」会让人以为画面还在
      clips: t.clips.map((c) => (c.id === clipId ? { ...c, mediaId: r.media.id, label: r.media.name } : c)),
    })));
    return { ok: true, mediaId: r.media.id, created: r.created };
  },
  addAudioFx(def: AudioFxDef, attach?: { clipId: string; fx: ClipAudioFx }) {
    const p = state.project;
    let tracks = p.tracks;
    if (attach) {
      const hit = findClip(p, attach.clipId);
      if (hit) tracks = updateTrack(p, hit.track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === attach.clipId ? { ...c, audioFx: attach.fx } : c)) })).tracks;
    }
    setProject({ ...p, tracks, audioFx: [...(p.audioFx ?? []), def] });
  },
  updateAudioFx(fxId: string, def: AudioFxDef) {
    setProject({ ...state.project, audioFx: (state.project.audioFx ?? []).map((f) => (f.id === fxId ? def : f)) });
  },
  removeAudioFx(fxId: string) {
    const p = state.project;
    setProject(stripAudioFxFromCuts({
      ...p,
      audioFx: (p.audioFx ?? []).filter((f) => f.id !== fxId),
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.audioFx?.id === fxId ? withoutAudioFx(c) : c)) })),
    }, fxId));
  },
  setClipAudioFx(clipId: string, fx: ClipAudioFx | null): boolean {
    const p = state.project;
    const hit = findClip(p, clipId);
    if (!hit) return false;
    setProject(updateTrack(p, hit.track.id, (t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id !== clipId ? c : fx ? { ...c, audioFx: fx } : withoutAudioFx(c))),
    })));
    return true;
  },
};
