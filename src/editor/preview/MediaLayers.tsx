import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AudioFxDef } from "../../kernel/audioFx.mjs";
import { releasePreviewAudio, routePreviewAudio } from "../../audio/previewAudio";
import { CARD_AUDIO_SAMPLE_RATE, acquireCardAudioClipUrl, cardAudioNodeOf, generatedCardAudioClipsAt, getCardAudioEpoch, subscribeCardAudioEpoch } from "../../audio/cardAudio";
import { audioClipsAt, isImageMedia, nextVideoLayerAfter, videoLayersAt, type MediaAsset, type Project, type TrackClip } from "../../kernel/project";
import { isScrubbing, subscribeScrub } from "../timeline/useScrub";
import { driveMedia, releaseMedia, targetTimeOf } from "../../render/mediaDrive";
import { VideoTrack } from "../../render/VideoTrack";
import { playbackUrl } from "../../render/mediaTier";

/**
 * 预览里的素材层:画面(视频/图片)和声音(配乐、旁白)。
 *
 * 画面层可以同时有多条——两段素材在时间上重叠、各自带淡入淡出,就是交叉溶解。
 * 时间轴上靠上的序列画在上面(videoLayersAt 已经按「最后一个 = 最上层」给好了顺序)。
 * 声音层每段一个 <audio>,音量走 opacityAt,所以音频段的淡入淡出同样有效。
 *
 * **E7 第 1 条之后画面层不在这个文件里**:`VideoTrack` 搬到了 `src/render/VideoTrack.tsx`
 * (舞台和主文档共用同一份),元素驱动搬到了 `src/render/mediaDrive.ts`,纯函数搬到了
 * `src/render/mediaSync.ts`。这里只剩「把它们按序列摆出来」和声音层(`AudioLayer`)——
 * 音频路由(`audio/previewAudio.ts`)只在这一侧接,舞台恒 `muted`。
 */


type CardState = "pending" | "ready" | "error";
const NO_HASHES: readonly string[] = [];
function AudioLayer({ project, clip, media, volume, t, playing, scrubbing, audioFx, onCardState, localHashes }: { project: Project; clip: TrackClip; media?: MediaAsset; volume: number; t: number; playing: boolean; scrubbing: boolean; audioFx?: AudioFxDef[]; onCardState?: (clipId: string, state: CardState, message?: string) => void; localHashes: readonly string[] }) {
  const ref = useRef<HTMLAudioElement>(null);
  const nodeId = cardAudioNodeOf(project, clip);
  // Card runtime blocks use clip-local samples; mediaOffset applies only to the old source media path.
  const target = nodeId ? Math.max(0, t - clip.start) : targetTimeOf(clip, t);
  const [cardUrl, setCardUrl] = useState<string | null>(null);
  const [cardState, setCardState] = useState<"idle" | CardState>("idle");
  // 换了图卡(HMR 重跑 src/cards/index.ts)之后 project 引用不变,effect 不会自己重跑;
  // configureCardAudio 每调一次 +1 的这个版本号就是重取的触发。
  const cardAudioEpoch = useSyncExternalStore(subscribeCardAudioEpoch, getCardAudioEpoch, getCardAudioEpoch);
  useEffect(() => {
    let current = true;
    if (!nodeId) { setCardUrl(null); setCardState("idle"); return; }
    setCardUrl(null); setCardState("pending");
    onCardState?.(clip.id, "pending"); ref.current?.dispatchEvent(new CustomEvent("promptcut:card-audio-pending", { bubbles: true, detail: { nodeId, clipId: clip.id } }));
    const frames = Math.max(1, Math.ceil((clip.end - clip.start) * CARD_AUDIO_SAMPLE_RATE));
    let release: (() => void) | undefined;
    void acquireCardAudioClipUrl({ project, nodeId, frames }).then((lease) => {
      release = lease.release; const url = lease.url;
      if (!current) { release(); return; }
      setCardUrl(url); setCardState("ready"); onCardState?.(clip.id, "ready");
      ref.current?.dispatchEvent(new CustomEvent("promptcut:card-audio-ready", { bubbles: true, detail: { nodeId, clipId: clip.id, url } }));
    }, (error: unknown) => {
      if (!current) return;
      const message = error instanceof Error ? error.message : String(error); setCardState("error"); onCardState?.(clip.id, "error", message);
      ref.current?.dispatchEvent(new CustomEvent("promptcut:card-audio-error", { bubbles: true, detail: { nodeId, clipId: clip.id, error: message } }));
    });
    return () => { current = false; release?.(); };
  }, [project, nodeId, clip.id, clip.start, clip.end, onCardState, cardAudioEpoch]);
  useLayoutEffect(() => {
    // While a 图卡 node is loading or has failed there is deliberately no source URL.
    // driveMedia may attempt play(), but it cannot emit source-media audio as a fallback.
    if (nodeId && !cardUrl) return;
    driveMedia(ref.current, { target, playing, volume, scrubbing });
    routePreviewAudio(ref.current, audioFx, clip, t, playing);
  }, [nodeId, cardUrl, target, playing, volume, scrubbing, audioFx, clip, t]);
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      releaseMedia(el);
      releasePreviewAudio(el);
    };
  }, []);
  // 主文档的声音也经换档判据(T1a 审查 #5)。C6.6「音频先留在小版」:播放中换了档,声音先接着用上一档,
  // 停下(暂停、拖动松开前的暂停态)再换 —— 两路声音不重叠、不爆音。上一档本来就没出声(挂失败了)时当场换。
  const wanted = media ? playbackUrl(media, localHashes) : undefined;
  const held = useRef<string | undefined>(undefined);
  if (held.current === undefined || !playing || held.current === wanted || !media || ref.current?.error) held.current = wanted;
  return <audio ref={ref} src={nodeId ? (cardUrl ?? undefined) : held.current} preload="auto" hidden data-card-audio-state={nodeId ? cardState : undefined} data-card-audio-node={nodeId ?? undefined} />;
}


/** 有画面段(视频/图片)的序列,顺序和 videoLayersAt 同一个口径:倒着走,最后一个 = 最上层 */
function visualTrackIds(p: Project): string[] {
  const audio = new Set(p.media.filter((m) => m.kind === "audio").map((m) => m.id));
  const known = new Set(p.media.map((m) => m.id));
  const ids: string[] = [];
  for (const tr of [...p.tracks].reverse()) {
    if (tr.hidden) continue;
    if (tr.clips.some((c) => c.mediaId && known.has(c.mediaId) && !audio.has(c.mediaId))) ids.push(tr.id);
  }
  return ids;
}

export function MediaLayers({
  project,
  t,
  playing,
  muted = false,
  masterVolume = 1,
  audioOnly = false,
  localHashes = NO_HASHES,
}: {
  project: Project;
  t: number;
  playing: boolean;
  /** 导出时用:画面照旧,声音一律不出(音轨由 ffmpeg 合成) */
  muted?: boolean;
  /** 预览总音量 0–1,叠在每段自己的淡入淡出音量之上;静音就传 0 */
  masterVolume?: number;
  audioOnly?: boolean;
  /**
   * 当前连接的素材服务报 `complete` 的哈希(A1 的 `localHashes`),声音层和画面层按它换档。
   * 缺省空集合 = 一律原片。来源(每 2 秒轮询 `GET media/<hash>/chunks`)在第 6 步。
   */
  localHashes?: readonly string[];
}) {
  // 手按着播放头时 seek 放疏一点;松手那一刻它变回 false,各层按 0.03s 精确对齐一次(见 mediaSync 的 SCRUB_SEEK_MIN_MS)
  const scrubbing = useSyncExternalStore(subscribeScrub, isScrubbing, isScrubbing);
  const layers = videoLayersAt(project, t);
  const nexts = nextVideoLayerAfter(project, t);
  const audios = muted ? [] : audioClipsAt(project, t);
  const generated = muted ? [] : generatedCardAudioClipsAt(project, t);
  const [cardStatus, setCardStatus] = useState<Record<string, { state: CardState; message?: string }>>({});
  const setGeneratedStatus = useCallback((clipId: string, state: CardState, message?: string) => setCardStatus(status => ({ ...status, [clipId]: { state, message } })), []);
  const master = Math.max(0, Math.min(1, masterVolume));
  const stage = { width: project.width, height: project.height };
  return (
    <>
      {!audioOnly && visualTrackIds(project).map((id) => (
        <VideoTrack
          key={id}
          project={project}
          cur={layers.find((l) => l.trackId === id) ?? null}
          next={nexts.find((n) => n.trackId === id) ?? null}
          t={t}
          playing={playing}
          scrubbing={scrubbing}
          muted={muted}
          gain={project.tracks.find((track) => track.id === id)?.muted ? 0 : master}
          stage={stage}
          filters={project.filters}
          localHashes={localHashes}
        />
      ))}
      {audioOnly && !muted && layers.filter(l => !cardAudioNodeOf(project, l.clip) && !isImageMedia(l.media) && l.media.kind === "video" && !l.clip.audioMuted && !project.tracks.find(tr => tr.id === l.trackId)?.muted).map(l => (
        <AudioLayer key={l.clip.id} project={project} clip={l.clip} media={l.media} volume={l.opacity * master * (l.clip.audioVolume ?? 1)} t={t} playing={playing} scrubbing={scrubbing} audioFx={project.audioFx} localHashes={localHashes} />
      ))}
      {audios.filter(a => !cardAudioNodeOf(project, a.clip)).map((a) => (
        <AudioLayer key={a.clip.id} project={project} clip={a.clip} media={a.media} volume={a.volume * master} t={t} playing={playing} scrubbing={scrubbing} audioFx={project.audioFx} localHashes={localHashes} />
      ))}
      {generated.map((a) => <AudioLayer key={`card-audio:${a.clip.id}`} project={project} clip={a.clip} media={a.media} volume={a.volume * master} t={t} playing={playing} scrubbing={scrubbing} audioFx={project.audioFx} onCardState={setGeneratedStatus} localHashes={localHashes} />)}
      {generated.map(({ clip }) => {
        const status = cardStatus[clip.id]; if (!status || status.state === "ready") return null;
        return <div key={`card-audio-status:${clip.id}`} role="status" aria-live="polite" style={{ position: "absolute", left: 12, bottom: 12, zIndex: 100, padding: "6px 9px", borderRadius: 4, color: "#fff", background: status.state === "error" ? "#a11" : "#333", fontSize: 12 }}>{status.state === "pending" ? `正在生成音频：${clip.label ?? clip.id}` : `音频生成失败：${status.message ?? clip.label ?? clip.id}`}</div>;
      })}
    </>
  );
}
