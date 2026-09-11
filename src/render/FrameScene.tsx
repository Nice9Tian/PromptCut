import { Stage } from "../kernel/Stage";
import { flattenOverlay, videoLayersAt, type Project } from "../kernel/project";
import { frameCss } from "../kernel/layout";
import { emphasisFilter } from "../kernel/emphasis";
import { clipFilterOpsAt, cssFilter } from "../kernel/filters.mjs";

/** One browser stacking tree, ordered from the bottom track upwards.
 * Video placeholders deliberately have no src: advancing React must never seek/decode media.
 * The capture phase installs src and seeks only the visible frame's video elements.
 */
export function FrameScene({ project, t, playToken }: { project: Project; t: number; playToken: number }) {
  const layers = videoLayersAt(project, t);
  return <>{[...project.tracks].reverse().filter(tr => !tr.hidden).map((tr, index) => {
    const timeline = flattenOverlay({ ...project, tracks: [tr] });
    return <div key={tr.id} data-pc-track={tr.id} style={{ position: "absolute", inset: 0, zIndex: index }}>
      {layers.filter(l => l.trackId === tr.id).map(({ clip, media, opacity }) => {
        const ops = project.filters?.length ? clipFilterOpsAt(project, clip, t) : null;
        const filter = [ops ? cssFilter(ops) : "", emphasisFilter(clip.emphasis) || ""].filter(Boolean).join(" ");
        const style = { display: "block", width: "100%", height: "100%", objectFit: "cover" as const, opacity, filter: filter || undefined };
        return <div key={clip.id} data-pc-clip={clip.id} data-pc-local-frame={Math.round((t - clip.start) * project.fps)} style={{ position: "absolute", overflow: "hidden", ...frameCss(clip.frame, project) }}>
          {media.kind === "image" ? <img src={media.url} alt="" style={style} /> :
            <video muted playsInline preload="none" data-pc-media-src={media.url}
              data-pc-media-time={Math.max(0, (clip.mediaOffset ?? 0) + t - clip.start)}
              style={{ ...style, visibility: "hidden" }} />}
        </div>;
      })}
      <Stage timeline={timeline} t={t} playToken={playToken} />
    </div>;
  })}</>;
}
