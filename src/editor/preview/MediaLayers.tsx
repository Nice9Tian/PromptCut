import { useEffect, useRef } from "react";
import { audioClipsAt, videoLayersAt, type MediaAsset, type Project, type TrackClip } from "../../kernel/project";

/**
 * 预览里的素材层:画面(视频/图片)和声音(配乐、旁白)。
 *
 * 画面层可以同时有多条——两段素材在时间上重叠、各自带淡入淡出,就是交叉溶解。
 * 序列靠后的画在上面(videoLayersAt 已经按这个顺序给了)。
 * 声音层每段一个 <audio>,音量走 opacityAt,所以音频段的淡入淡出同样有效。
 *
 * 每一层自己跟播放头同步:播放中差得超过 0.2s 就 seek,暂停时差 0.03s 就 seek——
 * 和以前单条视频的做法一致,只是现在每层各管各的。
 */

/** 把一个 media 元素对齐到时间轴 */
function syncMediaEl(el: HTMLMediaElement | null, target: number, playing: boolean, volume: number) {
  if (!el) return;
  const v = Math.max(0, Math.min(1, volume));
  if (el.volume !== v) el.volume = v;
  if (!Number.isFinite(target) || target < 0) return;
  if (playing) {
    if (Math.abs(el.currentTime - target) > 0.2) el.currentTime = target;
    if (el.paused) el.play().catch(() => {});
  } else {
    if (!el.paused) el.pause();
    if (Math.abs(el.currentTime - target) > 0.03) el.currentTime = target;
  }
}

function targetTimeOf(clip: TrackClip, t: number) {
  return (clip.mediaOffset ?? 0) + (t - clip.start);
}

function VideoLayer({
  clip,
  media,
  opacity,
  t,
  playing,
  muted,
}: {
  clip: TrackClip;
  media: MediaAsset;
  opacity: number;
  t: number;
  playing: boolean;
  muted: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const target = targetTimeOf(clip, t);
  useEffect(() => {
    // 画面淡下去的同时声音也跟着淡:交叉溶解时两段的声音不会重叠成双倍
    syncMediaEl(ref.current, target, playing, muted ? 0 : opacity);
  }, [target, playing, opacity, muted]);

  if (media.kind === "image") {
    return (
      <img
        src={media.url}
        alt=""
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity }}
      />
    );
  }
  return (
    <video
      ref={ref}
      src={media.url}
      muted={muted}
      playsInline
      preload="auto"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity }}
    />
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
}: {
  project: Project;
  t: number;
  playing: boolean;
  /** 导出时用:画面照旧,声音一律不出(音轨由 ffmpeg 合成) */
  muted?: boolean;
}) {
  const layers = videoLayersAt(project, t);
  const audios = muted ? [] : audioClipsAt(project, t);
  return (
    <>
      {layers.map((l) => (
        <VideoLayer key={l.clip.id} clip={l.clip} media={l.media} opacity={l.opacity} t={t} playing={playing} muted={muted} />
      ))}
      {audios.map((a) => (
        <AudioLayer key={a.clip.id} clip={a.clip} media={a.media} volume={a.volume} t={t} playing={playing} />
      ))}
    </>
  );
}
