import { useEffect, useRef } from "react";
import { emphasisFilter } from "../../kernel/emphasis";
import { frameCss } from "../../kernel/layout";
import { audioClipsAt, videoLayersAt, type MediaAsset, type Project, type TrackClip } from "../../kernel/project";
import { planSync } from "./mediaSync";

/**
 * 预览里的素材层:画面(视频/图片)和声音(配乐、旁白)。
 *
 * 画面层可以同时有多条——两段素材在时间上重叠、各自带淡入淡出,就是交叉溶解。
 * 时间轴上靠上的序列画在上面(videoLayersAt 已经按「最后一个 = 最上层」给好了顺序)。
 * 声音层每段一个 <audio>,音量走 opacityAt,所以音频段的淡入淡出同样有效。
 *
 * 每一层自己跟播放头同步。同步该怎么做在 mediaSync.ts,那边是纯函数、带单测;
 * 这里只负责把元素的读数递过去,再把结果照着执行。
 */

/** 上一次由我们发起的纠偏 seek 的时刻,按元素记 */
const lastSeekAt = new WeakMap<HTMLMediaElement, number>();

/** 把一个 media 元素对齐到时间轴 */
function syncMediaEl(el: HTMLMediaElement | null, target: number, playing: boolean, volume: number) {
  if (!el) return;
  const v = Math.max(0, Math.min(1, volume));
  if (el.volume !== v) el.volume = v;

  const plan = planSync({
    elTime: el.currentTime,
    seeking: el.seeking,
    paused: el.paused,
    target,
    playing,
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
}

function targetTimeOf(clip: TrackClip, t: number) {
  return (clip.mediaOffset ?? 0) + (t - clip.start);
}

/** 素材层的强调:filter 挂在元素上,和舞台那边同一份计算(kernel/emphasis.ts) */
function emphasisOf(clip: TrackClip): string | undefined {
  return emphasisFilter(clip.emphasis) || undefined;
}

function VideoLayer({
  clip,
  media,
  opacity,
  t,
  playing,
  muted,
  gain = 1,
  stage,
}: {
  clip: TrackClip;
  media: MediaAsset;
  opacity: number;
  t: number;
  playing: boolean;
  muted: boolean;
  /** 预览总音量,叠在淡入淡出之上 */
  gain?: number;
  /** 画面尺寸:算片段的框要用 */
  stage: { width: number; height: number };
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const target = targetTimeOf(clip, t);
  useEffect(() => {
    // 画面淡下去的同时声音也跟着淡:交叉溶解时两段的声音不会重叠成双倍
    syncMediaEl(ref.current, target, playing, muted ? 0 : opacity * gain);
  }, [target, playing, opacity, muted, gain]);

  /*
   * 外面这一层是**片段的框**(clip.frame):没有框就铺满画面,和以前一样;
   * 设过框就按框摆 —— set_rect / set_position / align / nudge、预览里拖动写的都是它。
   * 以前素材层不认这个字段,于是给视频摆位置写进去了却一动不动,只有卡片才看得出效果。
   */
  const box = { position: "absolute" as const, overflow: "hidden" as const, ...frameCss(clip.frame, stage) };
  const fill = { width: "100%", height: "100%", objectFit: "cover" as const, opacity, filter: emphasisOf(clip) };
  if (media.kind === "image") {
    return (
      <div style={box}>
        <img src={media.url} alt="" style={{ display: "block", ...fill }} />
      </div>
    );
  }
  return (
    <div style={box}>
      <video ref={ref} src={media.url} muted={muted} playsInline preload="auto" style={{ display: "block", ...fill }} />
    </div>
  );
}

function AudioLayer({ clip, media, volume, t, playing }: { clip: TrackClip; media: MediaAsset; volume: number; t: number; playing: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const target = targetTimeOf(clip, t);
  useEffect(() => {
    syncMediaEl(ref.current, target, playing, volume);
  }, [target, playing, volume]);
  return <audio ref={ref} src={media.url} preload="auto" hidden />;
}

export function MediaLayers({
  project,
  t,
  playing,
  muted = false,
  masterVolume = 1,
}: {
  project: Project;
  t: number;
  playing: boolean;
  /** 导出时用:画面照旧,声音一律不出(音轨由 ffmpeg 合成) */
  muted?: boolean;
  /** 预览总音量 0–1,叠在每段自己的淡入淡出音量之上;静音就传 0 */
  masterVolume?: number;
}) {
  const layers = videoLayersAt(project, t);
  const audios = muted ? [] : audioClipsAt(project, t);
  const master = Math.max(0, Math.min(1, masterVolume));
  return (
    <>
      {layers.map((l) => (
        <VideoLayer key={l.clip.id} clip={l.clip} media={l.media} opacity={l.opacity} t={t} playing={playing} muted={muted} gain={master} stage={{ width: project.width, height: project.height }} />
      ))}
      {audios.map((a) => (
        <AudioLayer key={a.clip.id} clip={a.clip} media={a.media} volume={a.volume * master} t={t} playing={playing} />
      ))}
    </>
  );
}
