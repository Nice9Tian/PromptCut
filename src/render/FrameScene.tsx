import { Profiler, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Stage, type ProxyRender, type StagePlaneProps } from "./Stage";
import { flattenOverlay, isImageMedia, nextVideoLayerAfter, opacityAt, videoLayersAt, type MediaAsset, type Project, type TrackClip } from "../kernel/project";
import type { Timeline } from "../kernel/types";
import { frameCss } from "../kernel/layout";
import { emphasisFilter } from "../kernel/emphasis";
import { clipFilterOpsAt, cssFilter } from "../kernel/filters.mjs";
import { type PixelMapDef } from "../kernel/pixelMap.mjs";
import { drawPixelMap } from "./pixelMapGl";
import { graphVisualNode } from "./cards/GraphCard";
import { cardMountedAt } from "./frameWindow.mjs";
import { VideoTrack } from "./VideoTrack";
import { driveMedia, releaseMedia, targetTimeOf } from "./mediaDrive";

/**
 * 素材层上的像素映射。画面由 WebGL2 片元着色器算(render/pixelMapGl.ts):表达式在
 * kernel/pixelMap.mjs 里翻译成 GLSL,视频 / 图片帧当纹理,`to` 是另一段素材时用第二张纹理。
 * 这张 <canvas> 只有 bitmaprenderer 上下文 —— 着色器画完整块位图转移过来。
 * 原先的逐像素 CPU 循环(getImageData → mapRgba → putImageData)已整体删除、不留退路:
 * 实测 1080p 每帧 416～483 ms,超 30 fps 的每拍预算约二十倍。
 */
function PixelMappedMedia({ media, clip, t, project, style, def, live = false, playing = false, scrubbing = false }: { media: any; clip: any; t: number; project: Project; style: React.CSSProperties; def: PixelMapDef; live?: boolean; playing?: boolean; scrubbing?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const source = useRef<HTMLVideoElement | HTMLImageElement>(null);
  const targetSource = useRef<HTMLVideoElement | HTMLImageElement>(null);
  // stage=after_filters 时先把滤镜套在一张中转画布上,再当纹理上传(滤镜由合成器在 GPU 上做,
  // 不读回像素)。stage=origin 直接上传素材元素,少一次重采样。
  const staged = useRef<HTMLCanvasElement | null>(null);
  const draw = useCallback(() => {
    const c = canvas.current; const s = source.current;
    const ready = (el: HTMLVideoElement | HTMLImageElement) => el instanceof HTMLVideoElement ? el.readyState >= 2 : el.complete && el.naturalWidth > 0;
    if (!c || !s || !ready(s)) return;
    const w = Math.max(1, Math.round(project.width)); const h = Math.max(1, Math.round(project.height));
    let src: CanvasImageSource = s;
    if (def.source.stage === "after_filters" && clip.filter) {
      const ops = project.filters?.length ? clipFilterOpsAt(project, clip, t) : null;
      const css = ops ? cssFilter(ops) : "";
      if (css) {
        const mid = staged.current ?? (staged.current = document.createElement("canvas"));
        if (mid.width !== w || mid.height !== h) { mid.width = w; mid.height = h; }
        const mx = mid.getContext("2d");
        if (mx) { mx.clearRect(0, 0, w, h); mx.filter = css; mx.drawImage(s, 0, 0, w, h); mx.filter = "none"; src = mid; }
      }
    }
    const ts = targetSource.current;
    const target = def.to?.kind === "media" && ts && ready(ts) ? ts : null;
    try {
      drawPixelMap(c, { def, source: src as TexImageSource, target: target as TexImageSource | null, width: w, height: h, t });
      c.removeAttribute("data-pc-pixel-error");
    } catch (err) {
      // 画不出来就让这一层空着,别把整个场景树拖垮;属性留给验收脚本和排错看
      c.setAttribute("data-pc-pixel-error", err instanceof Error ? err.message : String(err));
      console.error("[pixelMap]", err);
    }
  }, [def, clip, project, t]);
  useEffect(() => {
    // Source images/videos load only at capture time. Draw synchronously when
    // all decoders are ready; a wall-clock timer can miss the screenshot.
    document.addEventListener("pc:frame-media-ready", draw);
    return () => document.removeEventListener("pc:frame-media-ready", draw);
  }, [draw]);
  /*
   * live(舞台)路:源素材是**真的在放的** `<video>` / `<img>`,不是导出页那种等截图时才装 src 的占位。
   * 所以这里自己跟播放头对齐、每次渲染都重画一次;视频再补一次 rVFC —— 解出新的一帧时
   * 画面要跟着换,而暂停时没有播放循环推着重渲。
   */
  useLayoutEffect(() => {
    if (!live) return;
    const v = source.current;
    if (v instanceof HTMLVideoElement) {
      driveMedia(v, { target: targetTimeOf(clip, t), playing, volume: 0, scrubbing });
      v.requestVideoFrameCallback(() => draw());
    }
    const tv = targetSource.current;
    if (tv instanceof HTMLVideoElement) {
      driveMedia(tv, { target: Math.max(0, t), playing, volume: 0, scrubbing });
      tv.requestVideoFrameCallback(() => draw());
    }
    draw();
  });
  useLayoutEffect(() => {
    if (!live) return;
    const a = source.current;
    const b = targetSource.current;
    return () => {
      if (a instanceof HTMLVideoElement) releaseMedia(a);
      if (b instanceof HTMLVideoElement) releaseMedia(b);
    };
  }, [live]);
  // 源素材藏起来(画面由下面那张 canvas 出)。visibility:hidden 的视频照样解码、照样回调 rVFC
  // (实测 Chrome 152,同 VideoTrack 的隐藏槽位),`texImage2D` 也照样读得到它解出来的帧。
  const hidden: React.CSSProperties = { ...style, visibility: "hidden", position: "absolute" };
  const targetMedia = def.to?.kind === "media" ? project.media.find((m) => m.id === (def.to as Extract<PixelMapDef["to"], { kind: "media" }>).mediaId) : null;
  const targetHidden: React.CSSProperties = { ...hidden, pointerEvents: "none" };
  /*
   * 导出页(placeholder)刻意**不给 src**:推进 React 的过程中绝不能去 seek / 解码素材,
   * 截图那一步才由 `__pcPrepareFrameMedia` 按 `data-pc-media-*` 把这一帧装回来。
   * live(舞台)路正相反 —— 素材是真的在放的,所以这时候才挂 `src` 并 `preload="auto"`。
   */
  const srcOf = (url?: string) => (live ? url : undefined);
  const load = live ? "auto" : "none";
  return <>
    {isImageMedia(media) ? <img ref={source as any} src={srcOf(media.url)} onLoad={live ? () => draw() : undefined} data-pc-media-src={media.url} data-pc-media-hidden="true" alt="" style={hidden} /> :
      <video ref={source as any} muted playsInline preload={load} src={srcOf(media.url)} data-pc-media-src={media.url} data-pc-media-hidden="true"
        data-pc-media-time={Math.max(0, (clip.mediaOffset ?? 0) + t - clip.start)} style={hidden} />}
    {targetMedia ? (isImageMedia(targetMedia) ? <img ref={targetSource as any} src={srcOf(targetMedia.url)} onLoad={live ? () => draw() : undefined} data-pc-media-src={targetMedia.url} data-pc-media-hidden="true" alt="" style={targetHidden} /> :
      <video ref={targetSource as any} muted playsInline preload={load} src={srcOf(targetMedia.url)} data-pc-media-src={targetMedia.url} data-pc-media-hidden="true"
        data-pc-media-time={Math.max(0, t)} style={targetHidden} />) : null}
    <canvas ref={canvas} width={Math.max(1, Math.round(project.width))} height={Math.max(1, Math.round(project.height))}
      data-pc-pixel-map={JSON.stringify(def)} data-pc-pixel-time={t} style={style} />
  </>;
}

/**
 * One browser stacking tree, ordered from the bottom track upwards.
 *
 * # 两个素材变体(E7)
 *
 * `mediaMode: 'placeholder'`(缺省,导出页和 legacy 走这条):视频占位**刻意不给 src** ——
 * 推进 React 的过程中绝不能去 seek / 解码素材;截图那一步才由 `__pcPrepareFrameMedia`
 * 按 `data-pc-media-*` 把这一帧装回来。**这条路的 DOM 一个字都不许变**(导出有逐像素基线)。
 *
 * `mediaMode: 'live'`(舞台页):素材层是真的在放的 —— 每条序列一个 `VideoTrack`
 * (双 `<video>` 轮换,见 `render/VideoTrack.tsx`),`cur` / `next` 由这里按 `mediaT` 算好;
 * 卡片活跃判据换成 `cardMountedAt`(含 LEAD,和 `Stage` 内部同一个口径);
 * `Stage` 的六个可选 prop(快照 / 抑制 / 流平面 / 重挂载代数 / 追帧 / 等待)原样透传。
 */
export function FrameScene({
  project, sourceProject = project, t, directT = t, playToken, graph,
  mediaMode = "placeholder", mediaT = t, scrubbing = false, playing = false, proxy,
  suppressed, streamPlanes, snapshots, remountGen, settling, awaiting, localHashes, onMediaFrame, onCardCost,
}: {
  project: Project; sourceProject?: Project; t: number; directT?: number; playToken: number; graph?: Timeline["graph"];
  /** 素材层怎么画:导出页 / legacy 的占位,还是舞台里真的在放的那套(E7 第 1 条) */
  mediaMode?: "placeholder" | "live";
  /** 素材层跟的时刻(秒)。平时等于 `t`;K5 第二路的补跑里父页会单独给 `back` 下发目标拍 */
  mediaT?: number;
  scrubbing?: boolean;
  playing?: boolean;
  proxy?: ProxyRender;
  /**
   * A1 的本地素材哈希表。R3 只是把口子留在签名上(E7 列了它),换档那条路在 A1 / L,
   * 这里不消费 —— 传了也不会改变任何一个像素。
   */
  localHashes?: readonly string[];
  /** live:后台舞台的素材层画出一帧了(K5 第 (4) 步的 `mediaReady`) */
  onMediaFrame?: (mediaTime: number) => void;
  /**
   * K6:这一拍这张卡花了多少毫秒。**只有 live 路有**,`<Profiler>` 报的
   * `actualDuration`(这个片段的子树这一次提交渲染花的时间)。
   *
   * 为什么用 `Profiler` 而不是自己掐表:一拍是一次 `flushSync`,整棵树一起提交,
   * 外面掐表只量得到总数;而 K6 要的是「本窗口实测累计耗时最大的那张轻卡」。
   * live 路每个片段本来就是一个独立的单片段 `Stage`,套一层 `Profiler` 不产生任何 DOM。
   *
   * **限制**:它量的是 React 渲染 / 提交,不含卡片自己 rAF 回调里的时间
   * (那些跑在 `clock.tick` 里,回调和片段之间没有可靠的归属关系)。
   * 见报告里的更正建议。
   */
  onCardCost?: (clipId: string, ms: number) => void;
} & StagePlaneProps) {
  const live = mediaMode === "live";
  void localHashes;
  const layers = videoLayersAt(project, live ? mediaT : t);
  const frame = Math.round(directT * (project.fps || 30));
  const runtime = (sourceProject as any)._cardRender as { frames?: Record<string, Record<number, string>>; missing?: Record<number, string[]> } | undefined;
  const cached = (id: string) => runtime?.frames?.[id]?.[frame];
  const missing = new Set(runtime?.missing?.[frame] || []);
  const replaced = (id: string) => !!cached(id) || missing.has(id);
  const tracks = [...project.tracks].reverse().filter((tr) => !tr.hidden);
  /*
   * E7 第 2 条:live 下卡片活跃判据用 `cardMountedAt`(含 LEAD)—— 和 `Stage` 内部、
   * 导出的分片计划、`mountFrameOf` 同一个口径,卡片在入点前 50 ms 就挂上,进场动画才不会被切掉一截。
   * `placeholder` 那条保持原判据不动(导出逐像素基线)。
   */
  const active = live
    ? (clip: { start: number; end: number }) => cardMountedAt(clip, directT)
    : (clip: { start: number; end: number }) => directT >= clip.start && directT < clip.end;
  /*
   * 图卡接管的素材段、带像素映射的素材段都不进 `VideoTrack`:前者由 `Stage` 里的图卡画,
   * 后者由 `PixelMappedMedia` 画 —— 不滤掉的话同一段素材会被画两遍。
   * **过滤必须下推进 `nextVideoLayerAfter`**(它每条序列只回一段,事后滤等于这条序列没有 `next`)。
   */
  const takenByOther = (clip: TrackClip) =>
    graphVisualNode(graph, clip.nodeId) || !!(clip.pixelMap && project.pixelMaps?.some((x) => x.id === clip.pixelMap!.id));
  const nexts = live ? nextVideoLayerAfter(project, mediaT, takenByOther) : [];
  /*
   * E7 第 7 条:`legacyTimeline` 按 `(project, tr, clip)` 引用 memo。
   * 不 memo 的话每帧给每个片段新建一个 `timeline` 对象,`Stage` 的 `useMemo`、
   * `GraphCard` 的输入解算全部按新引用重算 —— 播放时这是每拍都要付的。
   * WeakMap 以 clip 对象为键:store 是不可变更新,没动过的 clip 引用不变。
   */
  const timelineCache = useRef(new WeakMap<object, { project: Project; tr: unknown; graph: unknown; timeline: Timeline }>());
  const legacyTimeline = (tr: Project["tracks"][number], clip: Project["tracks"][number]["clips"][number]): Timeline => {
    const hit = timelineCache.current.get(clip);
    if (hit && hit.project === project && hit.tr === tr && hit.graph === graph) return hit.timeline;
    // 图**不能**从裁剪版算(只留一条轨道一个片段,跨片段输入解不出)—— 由宿主算好、原样带进来。
    const timeline = { ...flattenOverlay({ ...project, tracks: [{ ...tr, clips: [clip] }] }), graph } as Timeline;
    timelineCache.current.set(clip, { project, tr, graph, timeline });
    return timeline;
  };
  const stageSize = { width: project.width, height: project.height };
  return <>{tracks.map((tr, index) => {
    const curOf = (trackId: string) => layers.find((l) => l.trackId === trackId && !takenByOther(l.clip) && !replaced(l.clip.id)) ?? null;
    // 这条序列上有没有画面段(视频 / 图片)。没有就不挂 VideoTrack,免得多两个空 <video>
    const hasVisual = tr.clips.some((c) => {
      if (!c.mediaId || takenByOther(c)) return false;
      const m = project.media.find((x) => x.id === c.mediaId);
      return !!m && m.kind !== "audio";
    });
    return <div key={tr.id} data-pc-track={tr.id} style={{ position: "absolute", inset: 0, zIndex: index }}>
      {live && hasVisual ? (
        <VideoTrack
          project={project}
          cur={curOf(tr.id)}
          next={nexts.find((n) => n.trackId === tr.id) ?? null}
          t={mediaT}
          playing={playing}
          scrubbing={scrubbing}
          // 舞台恒 muted:音频留在编辑器主文档(MediaLayers 的 audioOnly)
          muted
          stage={stageSize}
          filters={project.filters}
          onMediaFrame={onMediaFrame}
        />
      ) : null}
      {live ? layers.filter((l) => l.trackId === tr.id && !graphVisualNode(graph, l.clip.nodeId) && !replaced(l.clip.id)
        && !!(l.clip.pixelMap && project.pixelMaps?.some((x) => x.id === l.clip.pixelMap!.id))).map(({ clip, media, opacity }) => {
        const def = project.pixelMaps!.find((x) => x.id === clip.pixelMap!.id)!;
        const ops = project.filters?.length ? clipFilterOpsAt(project, clip, mediaT) : null;
        const filter = [ops ? cssFilter(ops) : "", emphasisFilter(clip.emphasis) || ""].filter(Boolean).join(" ");
        const style = { display: "block", width: "100%", height: "100%", objectFit: "cover" as const, opacity, filter: filter || undefined };
        return <div key={clip.id} data-pc-clip={clip.id} data-pc-media="" data-pc-local-frame={Math.round((mediaT - clip.start) * project.fps)} style={{ position: "absolute", overflow: "hidden", ...frameCss(clip.frame, project) }}>
          <PixelMappedMedia media={media as MediaAsset} clip={clip} t={mediaT} project={project} style={style} def={def} live playing={playing} scrubbing={scrubbing} />
        </div>;
      }) : null}
      {!live && layers.filter(l => l.trackId === tr.id && !graphVisualNode(graph, l.clip.nodeId) && !replaced(l.clip.id)).map(({ clip, media, opacity }) => {
        const ops = project.filters?.length ? clipFilterOpsAt(project, clip, t) : null;
        const filter = [ops ? cssFilter(ops) : "", emphasisFilter(clip.emphasis) || ""].filter(Boolean).join(" ");
        const style = { display: "block", width: "100%", height: "100%", objectFit: "cover" as const, opacity, filter: filter || undefined };
        // data-pc-media:生成快照时 controls 的选择器靠它把素材层排除掉(见 render/createSnapshot.ts)
        return <div key={clip.id} data-pc-clip={clip.id} data-pc-media="" data-pc-local-frame={Math.round((t - clip.start) * project.fps)} style={{ position: "absolute", overflow: "hidden", ...frameCss(clip.frame, project) }}>
          {clip.pixelMap && project.pixelMaps?.find((x) => x.id === clip.pixelMap!.id) ? (() => {
            const def = project.pixelMaps!.find((x) => x.id === clip.pixelMap!.id)!;
            return <PixelMappedMedia media={media} clip={clip} t={t} project={project} style={style} def={def} />;
          })() : isImageMedia(media) ? <img data-pc-media-src={media.url} alt="" style={{ ...style, visibility: "hidden" }} /> :
            <video muted playsInline preload="none" data-pc-media-src={media.url}
              data-pc-media-time={Math.max(0, (clip.mediaOffset ?? 0) + t - clip.start)}
              style={{ ...style, visibility: "hidden" }} />}
        </div>;
      })}
      {tr.clips.map((clip, clipIndex) => {
        if (!active(clip)) return null;
        const layerStyle: React.CSSProperties = { position: "absolute", inset: 0, zIndex: clipIndex };
        if (replaced(clip.id)) {
          const url = cached(clip.id);
          // Cached controls are full-stage PNGs. Their placement and motion have
          // already been baked by the capture, so applying frameCss here would
          // transform them twice. Opacity and fades are baked there as well.
          return url
            ? <div key={clip.id} data-pc-clip={clip.id} style={layerStyle}>
              <img data-pc-cached-control={clip.id} src={url} alt="" style={{ display: "block", width: "100%", height: "100%" }} />
            </div>
            : <div key={clip.id} data-pc-clip={clip.id} data-pc-incomplete={clip.id} style={{ ...layerStyle, ...frameCss(clip.frame, project), border: "2px dashed #dcb66a", boxSizing: "border-box", display: "grid", placeItems: "center", background: "#1e273050", opacity: opacityAt(clip, directT) }}>
              <span style={{ color: "#fff", fontSize: 28 }}>⌛</span>
            </div>;
        }
        const timeline = legacyTimeline(tr, clip);
        // Media has already been painted below this block. A one-clip Stage
        // keeps each legacy card at its original track position while retaining
        // Stage's direct-child perspective and glass/backdrop context.
        // E7 第 3～5 条:`proxy` 和六个平面 prop 原样透传给每个内部单片段 `Stage`。
        // `placeholder` 路一个都不传(宿主本来就不给),DOM 一个字不变。
        if (!timeline.clips.length) return null;
        const stage = (
          <Stage timeline={timeline} t={t} directT={directT} playToken={playToken}
            proxy={proxy} snapshots={snapshots} suppressed={suppressed} streamPlanes={streamPlanes}
            remountGen={remountGen} settling={settling} awaiting={awaiting} />
        );
        /*
         * K6 的每卡耗时。**包不包这一层由 `live` 决定、不由 `onCardCost` 在不在决定** ——
         * 中途多包一层 / 少包一层会让 React 认成另一棵树、把卡片重挂载,锚点就丢了。
         * `placeholder`(导出 / legacy)永远不包,DOM 和渲染路径一个字不变。
         */
        return (
          <div key={clip.id} data-pc-native-layer={clip.id} style={layerStyle}>
            {live ? (
              <Profiler id={clip.id} onRender={(_id, _phase, actualDuration) => onCardCost?.(clip.id, actualDuration)}>
                {stage}
              </Profiler>
            ) : stage}
          </div>
        );
      })}
    </div>;
  })}</>;
}
