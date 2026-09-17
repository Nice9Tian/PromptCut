import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { emphasisFilter } from "../../kernel/emphasis";
import { clipFilterOpsAt, cssFilter, type FilterDef } from "../../kernel/filters.mjs";
import type { AudioFxDef } from "../../kernel/audioFx.mjs";
import { releasePreviewAudio, routePreviewAudio } from "../../audio/previewAudio";
import { CARD_AUDIO_SAMPLE_RATE, acquireCardAudioClipUrl, cardAudioNodeOf, generatedCardAudioClipsAt, getCardAudioEpoch, shouldMuteNativeAudio, subscribeCardAudioEpoch } from "../../audio/cardAudio";
import { frameCss } from "../../kernel/layout";
import { audioClipsAt, isImageMedia, nextVideoLayerAfter, videoLayersAt, type MediaAsset, type Project, type TrackClip } from "../../kernel/project";
import { isScrubbing, subscribeScrub } from "../timeline/useScrub";
import { planSlots, planSync, type SlotClip } from "./mediaSync";

/**
 * 预览里的素材层:画面(视频/图片)和声音(配乐、旁白)。
 *
 * 画面层可以同时有多条——两段素材在时间上重叠、各自带淡入淡出,就是交叉溶解。
 * 时间轴上靠上的序列画在上面(videoLayersAt 已经按「最后一个 = 最上层」给好了顺序)。
 * 声音层每段一个 <audio>,音量走 opacityAt,所以音频段的淡入淡出同样有效。
 *
 * 画面层**按序列**挂,不按片段:每条序列两个常驻 <video>,一个放当前段,一个提前装好下一段
 * (为什么、怎么轮换见 mediaSync.ts 的 planSlots)。以前是 key={clip.id},每切一段新建一个
 * 播放器再从文件中段 seek,交界处要空一两百毫秒才出画。
 *
 * 每个元素自己跟播放头同步。同步该怎么做在 mediaSync.ts,那边是纯函数、带单测;
 * 这里只负责把元素的读数递过去,再把结果照着执行。
 */

/** 上一次由我们发起的纠偏 seek 的时刻,按元素记 */
const lastSeekAt = new WeakMap<HTMLMediaElement, number>();

/** 一个元素眼下该对齐到哪儿 */
interface Want {
  target: number;
  playing: boolean;
  volume: number;
  scrubbing: boolean;
}
/**
 * 每个元素**最新的**「想去哪」。seek 落定、拖动节流到点时拿它再判一次;
 * 没有条目 = 这个元素眼下没人驱动(备用槽位、顶班的末帧),落定了也不补。
 */
const wants = new WeakMap<HTMLMediaElement, Want>();
const retryTimers = new WeakMap<HTMLMediaElement, number>();
const hooked = new WeakSet<HTMLMediaElement>();

/** 把一个 media 元素对齐到时间轴 */
function syncMediaEl(el: HTMLMediaElement, want: Want) {
  const v = Math.max(0, Math.min(1, want.volume));
  if (el.volume !== v) el.volume = v;

  const plan = planSync({
    elTime: el.currentTime,
    seeking: el.seeking,
    paused: el.paused,
    target: want.target,
    playing: want.playing,
    scrubbing: want.scrubbing,
    now: performance.now(),
    lastSeekAt: lastSeekAt.get(el) ?? 0,
  });

  if (plan.rate !== null && el.playbackRate !== plan.rate) el.playbackRate = plan.rate;
  if (plan.seekTo !== null) {
    el.currentTime = plan.seekTo;
    lastSeekAt.set(el, performance.now());
  }
  if (plan.pause) el.pause();
  if (plan.play) el.play().catch(() => {});

  // 拖动时被节流压下的那次 seek 必须补:手停住以后不会再有新的渲染来触发同步
  window.clearTimeout(retryTimers.get(el));
  if (plan.retryInMs !== null) {
    retryTimers.set(el, window.setTimeout(() => {
      const w = wants.get(el);
      if (w) syncMediaEl(el, w);
    }, plan.retryInMs));
  }
}

/** 让一个元素跟着播放头走:记下最新目标,立刻判一次 */
function driveMedia(el: HTMLMediaElement | null, want: Want) {
  if (!el) return;
  wants.set(el, want);
  if (!hooked.has(el)) {
    hooked.add(el);
    /*
     * seek 落定后拿最新目标再判一次。planSync 在 seeking 期间一律不下新指令(那时 currentTime
     * 读的是目标值,拿它算偏差会把刚发的 seek 推翻),代价是这期间来的新位置被丢掉 ——
     * 以前没有这一步,拖动的最后一下恰好落在 seek 中间,画面就永远停在旧的一帧。
     */
    el.addEventListener("seeked", () => {
      const w = wants.get(el);
      if (w) syncMediaEl(el, w);
    });
  }
  syncMediaEl(el, want);
}

/** 这个元素眼下不跟播放头了(备用、顶班):停下,落定了也不再补 seek */
function releaseMedia(el: HTMLMediaElement | null) {
  if (!el) return;
  wants.delete(el);
  window.clearTimeout(retryTimers.get(el));
  if (!el.paused) el.pause();
}

function targetTimeOf(clip: TrackClip, t: number) {
  return (clip.mediaOffset ?? 0) + (t - clip.start);
}

/**
 * 素材层元素上的 filter:先滤镜(kernel/filters.mjs,和导出、see_frames 同一份数值)、后强调的 drop-shadow ——
 * 影子是调过色的画面投下的,和导出链上「先滤镜、后强调」一个顺序。强调和舞台那边同一份计算(kernel/emphasis.ts)。
 * 元素在片段的框里、外面整体 transform 缩放,所以 blur 写的是框内像素(落到画布上要乘 frame.scale,导出那边 blurScale = p.scale 一致)。两样都没有就不写这个属性。
 */
function filterOf(clip: TrackClip, filters: FilterDef[] | undefined, t: number): string | undefined {
  const ops = filters?.length ? clipFilterOpsAt({ filters }, clip, t) : null;
  const parts = [ops ? cssFilter(ops) : "", emphasisFilter(clip.emphasis) || ""].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

interface Layer {
  clip: TrackClip;
  media: MediaAsset;
  opacity: number;
}

/** 一个常驻的 <video> 眼下装着哪一段、那一段出画了没有 */
interface Slot {
  clip: SlotClip | null;
  /** 装的那段的完整片段:摆框(frame)、强调要用 */
  full: TrackClip | null;
  ready: boolean;
  /** 每换一次装的东西加一,旧的出画回调认出自己过期了就不算数 */
  token: number;
  /** 最后一次显示时的不透明度:顶班的末帧照这个画 */
  opacity: number;
}
const emptySlot = (): Slot => ({ clip: null, full: null, ready: false, token: 0, opacity: 1 });

/** 进槽位的只有视频段;图片段、没地址的段不进 */
function slotClipOf(clip: TrackClip, media: MediaAsset): SlotClip | null {
  if (isImageMedia(media) || !media.url) return null;
  return { id: clip.id, url: media.url, start: clip.start, end: clip.end, offset: clip.mediaOffset ?? 0 };
}

/** 这个素材时刻属于这一段(前后放 0.1s:出画的帧时刻比目标早最多一帧) */
function inClipRange(c: SlotClip, mediaTime: number) {
  return mediaTime >= c.offset - 0.1 && mediaTime <= c.offset + (c.end - c.start) + 0.1;
}

function VideoTrack({
  project,
  cur,
  next,
  t,
  playing,
  scrubbing,
  muted,
  gain = 1,
  stage,
  filters,
  audioFx,
}: {
  project: Project;
  /** 项目的滤镜库(片段的 clip.filter 引用其中一条) */
  filters?: FilterDef[];
  /** 项目的音频效果库(片段的 clip.audioFx 引用其中一条);预览接 Web Audio,见 audio/previewAudio.ts */
  audioFx?: AudioFxDef[];
  /** 这条序列此刻的画面段(videoLayersAt 里属于它的那条),没有是 null */
  cur: Layer | null;
  /** 这条序列 t 之后的第一段画面(nextVideoLayerAfter) */
  next: { clip: TrackClip; media: MediaAsset } | null;
  t: number;
  playing: boolean;
  scrubbing: boolean;
  muted: boolean;
  /** 预览总音量,叠在淡入淡出之上 */
  gain?: number;
  /** 画面尺寸:算片段的框要用 */
  stage: { width: number; height: number };
}) {
  const el0 = useRef<HTMLVideoElement>(null);
  const el1 = useRef<HTMLVideoElement>(null);
  const els = [el0, el1];
  const slots = useRef<Slot[]>([emptySlot(), emptySlot()]);
  const shownRef = useRef<number | null>(null);
  // 出画回调在渲染之外到达:暂停时没有播放循环推着重渲,得自己敲一下,显示才换得过去
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const curV = cur ? slotClipOf(cur.clip, cur.media) : null;
  const nextV = next ? slotClipOf(next.clip, next.media) : null;
  const plan = planSlots({ slots: slots.current, shown: shownRef.current, cur: curV, next: nextV, t, playing });
  const fullOf = (i: number): TrackClip | null => {
    const id = plan.load[i]?.id;
    if (id && id === cur?.clip.id) return cur.clip;
    if (id && id === next?.clip.id) return next.clip;
    return slots.current[i].full;
  };

  useLayoutEffect(() => {
    plan.load.forEach((c, i) => {
      const s = slots.current[i];
      const el = els[i].current;
      if (!el || !c || s.clip?.id === c.id) return;
      // 换了一段:之前的出画不算数了。src 由 React 在这之前换好(同一个文件就不换,解码器和缓冲接着用)
      s.clip = c;
      s.full = fullOf(i);
      s.ready = false;
      // 冷却是给「同一段里的纠偏」的;换了一段就是新的开始,别让上一段留下的冷却挡住这一次对齐
      lastSeekAt.delete(el);
      const tok = ++s.token;
      // requestVideoFrameCallback:这一段真有一帧画到屏幕上了才算好(不是 seeked,那时帧未必已经交出去)
      const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (s.token !== tok) return;
        if (inClipRange(c, meta.mediaTime)) {
          s.ready = true;
          bump();
        } else el.requestVideoFrameCallback(onFrame);
      };
      el.requestVideoFrameCallback(onFrame);
      if (i === plan.preload) {
        // 备用槽位:停在下一段的起点。src 刚换时 readyState 还是 0,这一句会记成「元数据到了就 seek 过去」
        releaseMedia(el);
        el.currentTime = c.offset;
      }
    });

    for (let i = 0; i < 2; i++) {
      const el = els[i].current;
      if (!el) continue;
      if (i === plan.active && cur) {
        // 画面淡下去的同时声音也跟着淡:交叉溶解时两段的声音不会重叠成双倍
        // An 音频图卡 node replaces this video's native soundtrack. The visual remains in
        // its usual slot while AudioLayer loads and plays the generated WAV separately.
        driveMedia(el, { target: targetTimeOf(cur.clip, t), playing, volume: shouldMuteNativeAudio(project, cur.clip, muted) ? 0 : cur.opacity * gain * (cur.clip.audioVolume ?? 1), scrubbing });
        slots.current[i].opacity = cur.opacity;
        // 音频效果:音量(el.volume)之后、喇叭之前,和导出一个顺序。导出(muted)时页面不出声,不接
        if (!muted) routePreviewAudio(el, audioFx, cur.clip, t, playing);
      } else {
        releaseMedia(el);
        if (!muted) routePreviewAudio(el, audioFx, null, t, playing);
      }
      // 兜底:同一个文件 seek 到原地这类情况不会有新帧交出来,rVFC 不回调;解码好了、时刻对得上也算好
      const s = slots.current[i];
      if (s.clip && !s.ready && !el.seeking && el.readyState >= 2 && inClipRange(s.clip, el.currentTime)) {
        s.ready = true;
        bump();
      }
    }
    shownRef.current = plan.shown;
  });

  // 卸载时别留着定时器和「落定了再补」去碰已经不在的元素
  useLayoutEffect(() => {
    const a = el0.current;
    const b = el1.current;
    return () => {
      releaseMedia(a);
      releaseMedia(b);
      releasePreviewAudio(a);
      releasePreviewAudio(b);
    };
  }, []);

  /*
   * 外面这一层是**片段的框**(clip.frame):没有框就铺满画面,和以前一样;
   * 设过框就按框摆 —— set_rect / set_position / align / nudge、预览里拖动写的都是它。
   * 以前素材层不认这个字段,于是给视频摆位置写进去了却一动不动,只有卡片才看得出效果。
   */
  const boxOf = (clip: TrackClip | null) => ({ position: "absolute" as const, overflow: "hidden" as const, ...frameCss(clip?.frame, stage) });
  const image = cur && isImageMedia(cur.media) && cur.media.url ? cur : null;
  // A1:入库(上传 + 边落盘边算哈希)还没完成的素材没有地址,这一层画「上传中」占位 ——
  // 不挂空 src(空 src 会被当成页面地址,<img> 出裂图、<video> 报解码错)。
  // 传完 media.url 变成 /@media/<hash>,占位自动消失。
  const uploading = cur && cur.media.pending && !cur.media.url ? cur : null;
  return (
    <>
      {[0, 1].map((i) => {
        const clip = fullOf(i);
        const shown = i === plan.shown;
        const opacity = shown ? (i === plan.active && cur ? cur.opacity : slots.current[i].opacity) : 0;
        return (
          // 不显示的槽位用 visibility 藏:实测 Chrome 152 对 visibility:hidden 的暂停视频照样解码、照样回调 rVFC
          <div key={i} style={{ ...boxOf(clip), visibility: shown ? "visible" : "hidden" }}>
            <video
              ref={els[i]}
              src={plan.load[i]?.url}
              muted={muted}
              playsInline
              preload="auto"
              style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", opacity, filter: clip ? filterOf(clip, filters, t) : undefined }}
            />
          </div>
        );
      })}
      {image && (
        <div key={image.clip.id} style={boxOf(image.clip)}>
          <img src={image.media.url} alt="" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", opacity: image.opacity, filter: filterOf(image.clip, filters, t) }} />
        </div>
      )}
      {uploading && (
        <div
          key={`pending-${uploading.clip.id}`}
          data-pc-media-pending="1"
          style={{ ...boxOf(uploading.clip), display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.35)", color: "rgba(255,255,255,.72)", fontSize: 14 }}
        >
          上传中…
        </div>
      )}
    </>
  );
}

type CardState = "pending" | "ready" | "error";
function AudioLayer({ project, clip, media, volume, t, playing, scrubbing, audioFx, onCardState }: { project: Project; clip: TrackClip; media?: MediaAsset; volume: number; t: number; playing: boolean; scrubbing: boolean; audioFx?: AudioFxDef[]; onCardState?: (clipId: string, state: CardState, message?: string) => void }) {
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
  return <audio ref={ref} src={nodeId ? (cardUrl ?? undefined) : media?.url} preload="auto" hidden data-card-audio-state={nodeId ? cardState : undefined} data-card-audio-node={nodeId ?? undefined} />;
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
}: {
  project: Project;
  t: number;
  playing: boolean;
  /** 导出时用:画面照旧,声音一律不出(音轨由 ffmpeg 合成) */
  muted?: boolean;
  /** 预览总音量 0–1,叠在每段自己的淡入淡出音量之上;静音就传 0 */
  masterVolume?: number;
  audioOnly?: boolean;
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
          audioFx={project.audioFx}
        />
      ))}
      {audioOnly && !muted && layers.filter(l => !cardAudioNodeOf(project, l.clip) && !isImageMedia(l.media) && l.media.kind === "video" && !l.clip.audioMuted && !project.tracks.find(tr => tr.id === l.trackId)?.muted).map(l => (
        <AudioLayer key={l.clip.id} project={project} clip={l.clip} media={l.media} volume={l.opacity * master * (l.clip.audioVolume ?? 1)} t={t} playing={playing} scrubbing={scrubbing} audioFx={project.audioFx} />
      ))}
      {audios.filter(a => !cardAudioNodeOf(project, a.clip)).map((a) => (
        <AudioLayer key={a.clip.id} project={project} clip={a.clip} media={a.media} volume={a.volume * master} t={t} playing={playing} scrubbing={scrubbing} audioFx={project.audioFx} />
      ))}
      {generated.map((a) => <AudioLayer key={`card-audio:${a.clip.id}`} project={project} clip={a.clip} media={a.media} volume={a.volume * master} t={t} playing={playing} scrubbing={scrubbing} audioFx={project.audioFx} onCardState={setGeneratedStatus} />)}
      {generated.map(({ clip }) => {
        const status = cardStatus[clip.id]; if (!status || status.state === "ready") return null;
        return <div key={`card-audio-status:${clip.id}`} role="status" aria-live="polite" style={{ position: "absolute", left: 12, bottom: 12, zIndex: 100, padding: "6px 9px", borderRadius: 4, color: "#fff", background: status.state === "error" ? "#a11" : "#333", fontSize: 12 }}>{status.state === "pending" ? `正在生成音频：${clip.label ?? clip.id}` : `音频生成失败：${status.message ?? clip.label ?? clip.id}`}</div>;
      })}
    </>
  );
}
