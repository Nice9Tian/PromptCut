import { useLayoutEffect, useReducer, useRef, useSyncExternalStore } from "react";
import { frameCss } from "../kernel/layout";
import { isImageMedia, type MediaAsset, type Project, type TrackClip } from "../kernel/project";
import type { FilterDef } from "../kernel/filters.mjs";
import { shouldMuteNativeAudio } from "../audio/cardAudio";
import { driveMedia, filterOf, lastSeekAt, releaseMedia, targetTimeOf } from "./mediaDrive";
import { planSlots, tierAligned, type SlotClip } from "./mediaSync";
import { chooseTier, hashFromUrl, playbackUrl } from "./mediaTier";
import { playabilityVersion, subscribePlayability } from "./playability";

/**
 * 一条序列的画面层(视频 / 图片)。E7 第 1 条:素材层搬进舞台,由 `FrameScene` 的 `live` 变体渲。
 *
 * 画面层**按序列**挂,不按片段:每条序列两个常驻 `<video>`,一个放当前段,一个提前装好下一段
 * (为什么、怎么轮换见 `mediaSync.ts` 的 `planSlots`)。以前是 `key={clip.id}`,每切一段新建一个
 * 播放器再从文件中段 seek,交界处要空一两百毫秒才出画。
 *
 * 每个元素自己跟播放头同步。同步该怎么做在 `mediaSync.ts`(纯函数、带单测),执行在
 * `mediaDrive.ts`;这里只负责把元素的读数递过去,再把结果照着执行。
 *
 * # 这里**不**做的两件事
 *
 *  1. **不 import `src/audio/previewAudio`**:音频路由是编辑器主文档的事(`MediaLayers` 的
 *     `AudioLayer`),舞台恒 `muted`、编辑器只渲 `audioOnly`,所以这条路上一个音频节点都不接。
 *  2. **不 import `src/editor/timeline/useScrub`**:`scrubbing` 从 prop 来(父页经 `setScrubbing`
 *     下发)。两条都是为了舞台 bundle 不带编辑器模块。
 */

const NO_HASHES: readonly string[] = [];

/**
 * 同一页面同时预热换档的层数上限(C6.6 第 8 节查资料结论第 4 条:两路同时解码占额外解码器与帧缓存,
 * 1080p 一帧约 3.1 MB;只预热少数层,其余等名额)。按序列计,一条序列同时最多预热一个。
 */
export const MAX_WARMING = 2;
const warming = new Set<object>();

export interface VideoLayer {
  clip: TrackClip;
  media: MediaAsset;
  opacity: number;
}

/** 一个常驻的 `<video>` 眼下装着哪一段、那一段出画了没有 */
export interface Slot {
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

/**
 * 进槽位的只有视频段;图片段、没地址的段不进。
 * `url` 经换档判据(`mediaTier.ts` 的 `playbackUrl`,T1a 审查 #5):同一片段换档 = url 变了 = 新的一段,
 * `planSlots` 按「id 和 url 都相同」认槽位。集合为空时就是 `media.url`,和以前一样。
 */
function slotClipOf(clip: TrackClip, media: MediaAsset, localHashes: readonly string[]): SlotClip | null {
  if (isImageMedia(media) || !media.url) return null;
  return { id: clip.id, url: playbackUrl(media, localHashes), start: clip.start, end: clip.end, offset: clip.mediaOffset ?? 0 };
}

/** 这个素材时刻属于这一段(前后放 0.1s:出画的帧时刻比目标早最多一帧) */
function inClipRange(c: SlotClip, mediaTime: number) {
  return mediaTime >= c.offset - 0.1 && mediaTime <= c.offset + (c.end - c.start) + 0.1;
}

export function VideoTrack({
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
  onMediaFrame,
  localHashes = NO_HASHES,
}: {
  project: Project;
  /** 项目的滤镜库(片段的 clip.filter 引用其中一条) */
  filters?: FilterDef[];
  /** 这条序列此刻的画面段(videoLayersAt 里属于它的那条),没有是 null */
  cur: VideoLayer | null;
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
  /**
   * 这条序列有一帧真画到屏幕上了(K5 第 (4) 步的 `mediaReady`:后台舞台补跑完、素材也出画了
   * 才敢互换)。舞台把它接到 `postStageEvent({ type: 'mediaReady' })` 上;编辑器不传。
   */
  onMediaFrame?: (mediaTime: number) => void;
  /**
   * 当前连接的素材服务报 `complete` 的哈希(A1 的 `localHashes`),换档判据只看它。
   * 缺省空集合 = 还没问过素材服务(有小版挂小版)。来源:主文档每 2 秒轮询 `GET media/<hash>/chunks`
   * (`src/editor/media/assetTiers.ts`),经 `setLocalHashes` 下发。
   */
  localHashes?: readonly string[];
}) {
  const el0 = useRef<HTMLVideoElement>(null);
  const el1 = useRef<HTMLVideoElement>(null);
  const els = [el0, el1];
  const slots = useRef<Slot[]>([emptySlot(), emptySlot()]);
  /** 每个槽位装的那一档上一次渲染时在素材服务上到齐没有(到齐的那一刻重载失败过的元素) */
  const completeSeen = useRef<boolean[]>([false, false]);
  /** 上一次规划的预热槽位 / 播放槽位(帧回调在渲染之外到达,读这里) */
  const warmRef = useRef<number | null>(null);
  const activeRef = useRef<number | null>(null);
  const shownRef = useRef<number | null>(null);
  // 出画回调在渲染之外到达:暂停时没有播放循环推着重渲,得自己敲一下,显示才换得过去
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // 可播性探出结论(`playability.ts`)时重渲一次:暂停中也当场换档
  useSyncExternalStore(subscribePlayability, playabilityVersion, playabilityVersion);
  const warmKey = useRef({}).current;
  const canWarm = warming.has(warmKey) || warming.size < MAX_WARMING;
  const curV = cur ? slotClipOf(cur.clip, cur.media, localHashes) : null;
  const nextV = next ? slotClipOf(next.clip, next.media, localHashes) : null;
  const plan = planSlots({ slots: slots.current, shown: shownRef.current, cur: curV, next: nextV, t, playing, canWarm });
  // 换档对齐判据要的「此刻」:帧回调在渲染之外到达,读最新的
  const live = useRef({ t, playing, cur, fps: project.fps || 30, shown: plan.shown as number | null });
  live.current = { t, playing, cur, fps: project.fps || 30, shown: plan.shown };
  const complete = new Set(localHashes);
  const fullOf = (i: number): TrackClip | null => {
    const id = plan.load[i]?.id;
    if (id && id === cur?.clip.id) return cur.clip;
    if (id && id === next?.clip.id) return next.clip;
    return slots.current[i].full;
  };

  /**
   * K5 第 (4) 步的钩子:同一片段内**不换段**时下面那句 `s.clip?.id === c.id` 不会重注册 rVFC,
   * 于是「`back` 补跑到 T′ 之后素材层出没出画」只能等满 300 ms。父页每改一次 `mediaT`
   * 都会让 `t` 变,偏差超过 `PAUSED_SEEK_SEC` 就是真 seek 过了 —— 这时补注册一次 rVFC,
   * 出画即报,不用等满兜底。
   */
  const armed = useRef(false);
  const armFrame = (el: HTMLVideoElement, i: number) => {
    if (!onMediaFrame || armed.current) return;
    armed.current = true;
    el.requestVideoFrameCallback((_now, meta) => {
      armed.current = false;
      if (slots.current[i].clip) onMediaFrame(meta.mediaTime);
    });
  };

  useLayoutEffect(() => {
    // 换档预热的槽位:交出的帧要和画面上那一档对齐到一帧以内才算好(C6.6「帧误差不超过一帧」)——
    // 播放中比显示着的那一档此刻的时刻,暂停中比目标时刻。判的时候才看它是不是预热槽位(`warmRef`):
    // 一个槽位可能先按普通段装上(比如等待上传方时挂失败了)、后来才成了预热槽位
    const aligned = (i: number, c: SlotClip, mediaTime: number) => {
      const now = live.current;
      if (!now.cur || now.cur.clip.id !== c.id) return false;
      const front = now.shown !== null && now.shown !== i ? els[now.shown].current : null;
      const ref = now.playing && front && !front.paused ? front.currentTime : targetTimeOf(now.cur.clip, now.t);
      const ok = tierAligned(mediaTime, ref, now.fps);
      // 探针的观察口(`scripts/probes/tier-switch-probe.mjs`):数组时才记,和 __pcFallbackTrace 一个做法
      const trace = (window as unknown as { __pcTierTrace?: unknown[] }).__pcTierTrace;
      if (ok && Array.isArray(trace)) trace.push({ clipId: c.id, url: c.url, mediaTime, ref, fps: now.fps, playing: now.playing });
      return ok;
    };
    // requestVideoFrameCallback:这一段真有一帧画到屏幕上了才算好(不是 seeked,那时帧未必已经交出去)
    const arm = (i: number, c: SlotClip, el: HTMLVideoElement) => {
      const s = slots.current[i];
      const tok = ++s.token;
      const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (s.token !== tok) return;
        if (warmRef.current === i ? aligned(i, c, meta.mediaTime) : inClipRange(c, meta.mediaTime)) {
          s.ready = true;
          bump();
          if (i === shownRef.current || i === activeRef.current) onMediaFrame?.(meta.mediaTime);
        } else el.requestVideoFrameCallback(onFrame);
      };
      el.requestVideoFrameCallback(onFrame);
    };
    const prevWarm = warmRef.current;
    warmRef.current = plan.warm;
    activeRef.current = plan.active;
    plan.load.forEach((c, i) => {
      const s = slots.current[i];
      const el = els[i].current;
      if (!el || !c) return;
      if (s.clip?.id === c.id && s.clip?.url === c.url) {
        // 装着的东西没变、却刚成了预热槽位:之前按普通段判的「出过画」不算,按对齐重新判
        if (i === plan.warm && prevWarm !== i) { s.ready = false; arm(i, c, el); }
        return;
      }
      // 同一片段换档(url 变了)也是换了一段:冷却清掉、重新等出画;播放位置由下面的 driveMedia 对齐回去
      // 换了一段:之前的出画不算数了。src 由 React 在这之前换好(同一个文件就不换,解码器和缓冲接着用)
      s.clip = c;
      s.full = fullOf(i);
      s.ready = false;
      // 冷却是给「同一段里的纠偏」的;换了一段就是新的开始,别让上一段留下的冷却挡住这一次对齐
      lastSeekAt.delete(el);
      arm(i, c, el);
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
        const target = targetTimeOf(cur.clip, t);
        // 偏差过了「暂停时该 seek」的门槛就补注册一次 rVFC(见 armFrame)
        if (Math.abs(el.currentTime - target) > 0.03) armFrame(el, i);
        driveMedia(el, { target, playing, volume: shouldMuteNativeAudio(project, cur.clip, muted) ? 0 : cur.opacity * gain * (cur.clip.audioVolume ?? 1), scrubbing });
        slots.current[i].opacity = cur.opacity;
      } else if (i === plan.warm && cur) {
        // 换档预热:静音、跟着播放头走(播放中也在走,对齐靠帧回调判),不出声
        driveMedia(el, { target: targetTimeOf(cur.clip, t), playing, volume: 0, scrubbing });
      } else {
        releaseMedia(el);
      }
      // 兜底:同一个文件 seek 到原地这类情况不会有新帧交出来,rVFC 不回调;解码好了、时刻对得上也算好
      const s = slots.current[i];
      // 素材服务上刚到齐的那一档:之前按它挂过、失败了(404:等待上传方)的元素重新加载一次
      const h = s.clip ? hashFromUrl(s.clip.url) : null;
      const doneNow = !!h && complete.has(h);
      if (doneNow && !completeSeen.current[i] && s.clip && (el.error || el.networkState === 3)) {
        el.load();
        s.ready = false;
        lastSeekAt.delete(el);
        arm(i, s.clip, el);
      }
      completeSeen.current[i] = doneNow;
      // 预热槽位:暂停中停在原地、当前帧已解好(HAVE_CURRENT_DATA)且对齐,也算好(停在原地不会再交新帧,帧回调等不来);
      // 播放中只认帧回调给的对齐
      const settle = i === plan.warm
        ? !playing && el.paused && aligned(i, s.clip ?? ({} as SlotClip), el.currentTime)
        : !!s.clip && inClipRange(s.clip, el.currentTime);
      if (s.clip && !s.ready && !el.seeking && el.readyState >= 2 && settle) {
        s.ready = true;
        bump();
        if (i === plan.shown || i === plan.active) onMediaFrame?.(el.currentTime);
      }
    }
    shownRef.current = plan.shown;
    if (plan.warm !== null) warming.add(warmKey);
    else warming.delete(warmKey);
  });

  // 卸载时别留着定时器和「落定了再补」去碰已经不在的元素
  useLayoutEffect(() => {
    const a = el0.current;
    const b = el1.current;
    return () => {
      releaseMedia(a);
      releaseMedia(b);
      warming.delete(warmKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // C6.6:轮询回过、而这一层要挂的那一档在当前素材服务上还没到齐 —— 画面透明,角上提示「等待上传方」
  // (A1「那一层透明并提示」;rendering.md「预览里任何一层都不无提示地透明」)
  const awaiting = cur && !uploading && cur.media.url && chooseTier(cur.media, localHashes, { probe: false }).awaiting ? cur : null;
  return (
    <>
      {[0, 1].map((i) => {
        const clip = fullOf(i);
        const shown = i === plan.shown;
        const opacity = shown ? (i === plan.active && cur ? cur.opacity : slots.current[i].opacity) : 0;
        return (
          // 不显示的槽位用 visibility 藏:实测 Chrome 152 对 visibility:hidden 的暂停视频照样解码、照样回调 rVFC
          // D3 第 4 步:**显示着的那个槽位**写 data-pc-clip,素材段才进 rects() / hitTest;隐藏槽位不写
          // (写了就有两个同 clipId 的包裹层,rects 按 clipId 去重会挑到藏着的那个)。
          <div key={i} data-pc-clip={shown && clip ? clip.id : undefined} data-pc-media={shown && clip ? "" : undefined}
            style={{ ...boxOf(clip), visibility: shown ? "visible" : "hidden" }}>
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
        <div key={`${image.clip.id}:${awaiting ? "wait" : "ok"}`} data-pc-clip={image.clip.id} data-pc-media="" style={boxOf(image.clip)}>
          <img src={playbackUrl(image.media, localHashes)} alt="" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", opacity: image.opacity, filter: filterOf(image.clip, filters, t) }} />
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
      {awaiting && (
        <div key={`awaiting-${awaiting.clip.id}`} data-pc-media-awaiting="1" style={{ ...boxOf(awaiting.clip), pointerEvents: "none" }}>
          <span style={{ position: "absolute", left: 16, bottom: 16, padding: "4px 16px", borderRadius: 999, background: "rgba(0,0,0,.45)", color: "rgba(255,255,255,.8)", fontSize: 28 }}>
            等待上传方
          </span>
        </div>
      )}
    </>
  );
}
