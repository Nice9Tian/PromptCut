import { EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { timelineDigest } from "../../editor/right/toolEcho";
import { generateVoice, getVoiceConfig } from "../../ai/voice";
import { importAudioFromServer } from "../../editor/io";

import { clipGuard, audioFxTools, measureAudio } from "../common";

export const audioHandlers = {
  listAudioFx: () => audioFxTools.listAudioFx(),
  createAudioFx: (args) => { const r = audioFxTools.createAudioFx(args); clipGuard.noteMutation(); return r; },
  updateAudioFx: (args) => { const r = audioFxTools.updateAudioFx(args); clipGuard.noteMutation(); return r; },
  removeAudioFx: (args) => { const r = audioFxTools.removeAudioFx(args); clipGuard.noteMutation(); return r; },
  applyAudioFx: (args) => { const r = audioFxTools.applyAudioFx(args); clipGuard.noteMutation(); return r; },
  measureAudio: (args) => measureAudio(args),
  setClipVolume: (args) => {
    const result = actions.setClipVolume(String(args.clipId), args.volume);
    if (!result.ok) throw new Error(result.error);
    clipGuard.noteMutation();
    return { ...result, timeline: timelineDigest(getState().project) };
  },
  separateAudio: (args) => {
    const result = actions.separateAudio(String(args.clipId));
    if (!result.ok) throw new Error(result.error);
    clipGuard.noteMutation();
    return { ...result, timeline: timelineDigest(getState().project) };
  },
  createAudio: (args) => {
    const mediaId = args.mediaId ? String(args.mediaId) : "";
    const clipId = args.clipId ? String(args.clipId) : "";
    if (!mediaId && !clipId) throw new Error("给 mediaId(素材库里派生一份声音)或 clipId(把时间轴上这一段就地转成声音)");
    if (mediaId && clipId) throw new Error("mediaId 和 clipId 只给一个:给 clipId 就是把那一段转成声音,顺带也会在素材库留一份");
    if (clipId) {
      const r = actions.convertClipToAudio(clipId);
      if (!r.ok) throw new Error(r.error);
      clipGuard.noteMutation();
      const p = getState().project;
      const m = p.media.find((x) => x.id === r.mediaId);
      return {
        ok: true, clipId, mediaId: r.mediaId, name: m?.name,
        note: r.already ? "这段本来就是声音,没动" : "这段现在只剩声音(画面没了),位置、长度、淡入淡出都留着;素材库里也多了这份声音",
        timeline: timelineDigest(p),
      };
    }
    const r = actions.audioFromVideo(mediaId);
    if (!r.ok) throw new Error(r.error);
    return {
      ok: true, mediaId: r.media.id, name: r.media.name, created: r.created,
      note: r.created
        ? "素材库里多了一份只有声音的素材(和源视频同一个文件,没转码),add_clip 传这个 mediaId 就是纯音频段"
        : "这段视频的声音素材早就派生过了,直接用这个 mediaId",
    };
  },

  voiceList: async () => {
    const { config, presets } = await getVoiceConfig();
    return {
      provider: config.provider,
      apiKeySet: config.apiKey.set,
      defaults: { minimax: config.minimax, kling: config.kling, vidu: config.vidu },
      systemVoices: presets.systemVoices,
      customVoices: config.customVoices.map((v) => ({ provider: v.provider, voiceId: v.voiceId, name: v.name, kind: v.kind, note: v.note })),
      textLimits: presets.textLimits,
      hint: config.apiKey.set
        ? "voice_generate 的 voiceId 从 systemVoices / customVoices 里挑(customVoices 要配对 provider)。"
        : "还没配 API Key,voice_generate 会失败。告诉用户去「配音设置」(开始页的配音卡、编辑台顶栏都能打开)里填 API Key。",
    };
  },

  voiceGenerate: async (args) => {
    if (!args.text || !String(args.text).trim()) throw new Error("text 不能是空的");
    const r = await generateVoice({
      text: args.text, provider: args.provider, voiceId: args.voiceId,
      speed: args.speed, emotion: args.emotion, name: args.name,
    });
    const mediaId = await importAudioFromServer({ url: r.url, path: r.path, name: r.name });
    const media = getState().project.media.find((m) => m.id === mediaId);
    let clipId: string | undefined;
    if (typeof args.start === "number") {
      const clip = actions.addMediaClip(mediaId, Math.max(0, args.start), { trackId: args.trackId });
      if (!clip) throw new Error(`语音已进素材库(mediaId ${mediaId}),但放上时间轴失败 —— trackId 不对?`);
      clipId = clip.id;
    }
    return {
      mediaId, name: r.name, duration: media?.duration, clipId,
      provider: r.provider, model: r.model, voiceId: r.voiceId, chars: r.chars,
      hint: clipId
        ? "已进素材库并放到时间轴。下一段的 start 接在这段 start + duration 后面。"
        : "已进素材库(没放时间轴)。要上时间轴就传 start 再生成,或者用户可以自己从素材库拖。",
    };
  },
} satisfies Partial<EditorApi>;
