import { findClip, findSoundAsset, newId, soundAssetFrom, type MediaAsset, type Track, type TrackClip } from "../../kernel/project";
import { stripAudioFxFromCuts, withoutAudioFx } from "../../kernel/cuts";
import type { AudioFxDef, ClipAudioFx } from "../../kernel/audioFx.mjs";

import { state, setProject, updateTrack } from "../core";
import { actions } from "../project";

export const audio = {

  /* ---------- 素材 ---------- */

  /**
   * 「创建为声音」:给一段视频派生出只有声音的那一份素材(素材库里多一条,进配乐页)。
   * 同一段视频只派生一份,再调返回的是同一条。图片没有声音;本来就是声音的原样返回。
   */
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

  /**
   * 把时间轴上的一段视频**就地**转成声音:画面没了,声音照旧(位置、长度、素材内偏移、
   * 淡入淡出全部保留)。素材库里同时会多出那份声音素材,以后能直接再拖。
   */
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
  /* ---------- 音频效果库(项目级,和滤镜库一个路数) ---------- */
  /** 入库;给了 attach 就同一步挂到那一段上(一步撤销,同 addFilter) */
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
  /** 删效果:激活剪辑和停放剪辑里挂着它的段一并摘掉 */
  removeAudioFx(fxId: string) {
    const p = state.project;
    setProject(stripAudioFxFromCuts({
      ...p,
      audioFx: (p.audioFx ?? []).filter((f) => f.id !== fxId),
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.audioFx?.id === fxId ? withoutAudioFx(c) : c)) })),
    }, fxId));
  },
  /** 挂 / 换 / 摘片段上的音频效果(null = 摘掉)。找不到片段返回 false;校验在调用方 */
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
