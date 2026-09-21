import { useCallback, useEffect, useRef } from "react";
import { Stage } from "./Stage";
import { flattenOverlay, isImageMedia, opacityAt, videoLayersAt, type Project } from "../kernel/project";
import type { Timeline } from "../kernel/types";
import { frameCss } from "../kernel/layout";
import { emphasisFilter } from "../kernel/emphasis";
import { clipFilterOpsAt, cssFilter } from "../kernel/filters.mjs";
import { mapRgba, type PixelMapDef } from "../kernel/pixelMap.mjs";
import { graphVisualNode } from "./cards/GraphCard";

function PixelMappedMedia({ media, clip, t, project, style, def }: { media: any; clip: any; t: number; project: Project; style: React.CSSProperties; def: PixelMapDef }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const source = useRef<HTMLVideoElement | HTMLImageElement>(null);
  const targetSource = useRef<HTMLVideoElement | HTMLImageElement>(null);
  const draw = useCallback(() => {
    const c = canvas.current; const s = source.current;
    const ready = (el: HTMLVideoElement | HTMLImageElement) => el instanceof HTMLVideoElement ? el.readyState >= 2 : el.complete && el.naturalWidth > 0;
    if (!c || !s || !ready(s)) return;
    const w = Math.max(1, Math.round(project.width)); const h = Math.max(1, Math.round(project.height));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext("2d", { willReadFrequently: true }); if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (def.source.stage === "after_filters" && clip.filter) {
      const ops = project.filters?.length ? clipFilterOpsAt(project, clip, t) : null;
      ctx.filter = ops ? cssFilter(ops) : "none";
    }
    ctx.drawImage(s, 0, 0, w, h);
    ctx.filter = "none";
    const data = ctx.getImageData(0, 0, w, h); const d = data.data;
    let target: ImageData | null = null;
    const ts = targetSource.current;
    if (def.to?.kind === "media" && ts && ready(ts)) {
      const tc = document.createElement("canvas"); tc.width = w; tc.height = h;
      const tx = tc.getContext("2d");
      if (tx) { tx.drawImage(ts, 0, 0, w, h); target = tx.getImageData(0, 0, w, h); }
    }
    for (let i = 0; i < d.length; i += 4) {
      const targetRgba = target ? [target.data[i] / 255, target.data[i + 1] / 255, target.data[i + 2] / 255, target.data[i + 3] / 255] : null;
      const p = mapRgba(def, [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, d[i + 3] / 255], { x: (i / 4) % w / w, y: Math.floor(i / 4 / w) / h, t }, targetRgba);
      d[i] = Math.round(p[0] * 255); d[i + 1] = Math.round(p[1] * 255); d[i + 2] = Math.round(p[2] * 255); d[i + 3] = Math.round(p[3] * 255);
    }
    ctx.putImageData(data, 0, 0);
  }, [def, project.width, project.height, t]);
  useEffect(() => {
    // Source images/videos load only at capture time. Draw synchronously when
    // all decoders are ready; a wall-clock timer can miss the screenshot.
    document.addEventListener("pc:frame-media-ready", draw);
    return () => document.removeEventListener("pc:frame-media-ready", draw);
  }, [draw]);
  const hidden: React.CSSProperties = { ...style, visibility: "hidden", position: "absolute" };
  const targetMedia = def.to?.kind === "media" ? project.media.find((m) => m.id === (def.to as Extract<PixelMapDef["to"], { kind: "media" }>).mediaId) : null;
  const targetHidden: React.CSSProperties = { ...hidden, pointerEvents: "none" };
  return <>
    {isImageMedia(media) ? <img ref={source as any} data-pc-media-src={media.url} data-pc-media-hidden="true" alt="" style={hidden} /> :
      <video ref={source as any} muted playsInline preload="none" data-pc-media-src={media.url} data-pc-media-hidden="true"
        data-pc-media-time={Math.max(0, (clip.mediaOffset ?? 0) + t - clip.start)} style={hidden} />}
    {targetMedia ? (isImageMedia(targetMedia) ? <img ref={targetSource as any} data-pc-media-src={targetMedia.url} data-pc-media-hidden="true" alt="" style={targetHidden} /> :
      <video ref={targetSource as any} muted playsInline preload="none" data-pc-media-src={targetMedia.url} data-pc-media-hidden="true"
        data-pc-media-time={Math.max(0, t)} style={targetHidden} />) : null}
    <canvas ref={canvas} data-pc-pixel-map={JSON.stringify(def)} data-pc-pixel-time={t} style={style} />
  </>;
}

/** One browser stacking tree, ordered from the bottom track upwards.
 * Video placeholders deliberately have no src: advancing React must never seek/decode media.
 * The capture phase installs src and seeks only the visible frame's video elements.
 */
export function FrameScene({ project, sourceProject = project, t, directT = t, playToken, graph }: { project: Project; sourceProject?: Project; t: number; directT?: number; playToken: number; graph?: Timeline["graph"] }) {
  const layers = videoLayersAt(project, t);
  const frame = Math.round(directT * (project.fps || 30));
  const runtime = (sourceProject as any)._cardRender as { frames?: Record<string, Record<number, string>>; missing?: Record<number, string[]> } | undefined;
  const cached = (id: string) => runtime?.frames?.[id]?.[frame];
  const missing = new Set(runtime?.missing?.[frame] || []);
  const replaced = (id: string) => !!cached(id) || missing.has(id);
  const tracks = [...project.tracks].reverse().filter((tr) => !tr.hidden);
  const active = (clip: { start: number; end: number }) => directT >= clip.start && directT < clip.end;
  const legacyTimeline = (tr: Project["tracks"][number], clip: Project["tracks"][number]["clips"][number]) =>
    // 图**不能**从裁剪版算(只留一条轨道一个片段,跨片段输入解不出),也不能按 project
    // 引用 memo(这里每次都新建对象,永不命中)—— 由宿主算好、原样带进来。
    ({ ...flattenOverlay({ ...project, tracks: [{ ...tr, clips: [clip] }] }), graph });
  return <>{tracks.map((tr, index) => {
    return <div key={tr.id} data-pc-track={tr.id} style={{ position: "absolute", inset: 0, zIndex: index }}>
      {layers.filter(l => l.trackId === tr.id && !graphVisualNode(graph, l.clip.nodeId) && !replaced(l.clip.id)).map(({ clip, media, opacity }) => {
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
        return timeline.clips.length
          ? <div key={clip.id} data-pc-native-layer={clip.id} style={layerStyle}>
            <Stage timeline={timeline} t={t} directT={directT} playToken={playToken} />
          </div>
          : null;
      })}
    </div>;
  })}</>;
}
