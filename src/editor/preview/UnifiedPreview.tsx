import { useEffect, useRef, useState } from "react";
import type { Project } from "../../kernel/project";
import { collectSnapshots, frameRequest, see_frames } from "../../render/frameClient";

/** Displays only frames produced by the common Chrome pipeline. */
export function UnifiedPreview({ project, t, playing }: { project: Project; t: number; playing: boolean }) {
  const [image, setImage] = useState<{ project: Project; url: string } | null>(null);
  const [video, setVideo] = useState<{ project: Project; url: string } | null>(null);
  const [error, setError] = useState("");
  const ref = useRef<HTMLVideoElement>(null);
  const latest = useRef(t); latest.current = t;
  const requestFrame = useRef<() => void>(() => {});
  const controller = useRef<AbortController | null>(null);
  const playingRef = useRef(playing); playingRef.current = playing;
  const videoRef = useRef(video); videoRef.current = video;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let archived = 0;
    setError("");
    const poll = async () => {
      try {
        // C/B runs in the low-priority prerender process. It must never occupy
        // the hot Chrome used by the human preview.
        const status = await frameRequest("preload", project, {}, undefined, { target: "prerender", lane: "background" });
        if (!active) return;
        if (status.error) setError(status.error);
        if (status.video) setVideo({ project, url: status.video });
        if (status.sampled > archived) { await collectSnapshots(project); archived = status.sampled; }
        if (status.status !== "ready" && active) timer = setTimeout(poll, 2000);
      } catch (e) { if (active) { setError(String(e)); timer = setTimeout(poll, 4000); } }
    };
    // Let a burst of edits settle before starting a full project bake.
    timer = setTimeout(poll, 600);
    return () => { active = false; clearTimeout(timer); };
  }, [project]);
  useEffect(() => {
    let active = true;
    let inFlight: Promise<void> | null = null;
    let pending: number | null = null;
    const fps = Math.max(1, project.fps || 30);
    const frameOf = (sec: number) => Math.round(sec * fps);

    /**
     * Keep exactly one request in the hot user lane.  While it is rendering,
     * every timeline update overwrites `pending`; when the current request
     * finishes its result is shown first, then the newest pending frame starts
     * immediately.  This keeps the UI responsive without spawning a backlog
     * of obsolete Chrome renders.
     */
    const draw = () => {
      if (!active || (playingRef.current && videoRef.current?.project === project)) return;
      pending = latest.current;
      if (inFlight) return;
      inFlight = (async () => {
        while (active && pending !== null) {
          const requested = pending;
          pending = null;
          const currentController = new AbortController();
          controller.current = currentController;
          try {
            const result = await see_frames(project, [requested], currentController.signal, { target: "user", lane: "user" });
            if (!active || currentController.signal.aborted) return;
            const frame = result.frames[0];
            // A completed old frame is still useful: commit it immediately so
            // the player never waits on a blank gap before the latest frame.
            if (frame) setImage({ project, url: frame.url });
            if (frameOf(requested) === frameOf(latest.current)) setError("");
          } catch (e) {
            if (active && (e as any)?.name !== "AbortError" && !currentController.signal.aborted
              && frameOf(requested) === frameOf(latest.current)) setError(String(e));
          } finally {
            if (controller.current === currentController) controller.current = null;
          }
          if (active && frameOf(requested) !== frameOf(latest.current)) pending = latest.current;
        }
      })().finally(() => {
        inFlight = null;
        if (active && pending !== null) draw();
      });
    };
    requestFrame.current = () => { void draw(); };
    void draw();
    return () => { active = false; controller.current?.abort(); };
  }, [project]);
  useEffect(() => { if (!playing || video?.project !== project) requestFrame.current(); }, [Math.round(t * (project.fps || 30)), playing, video, project]);
  useEffect(() => {
    const element = ref.current;
    if (!element || video?.project !== project) return;
    const sync = () => {
      // Setting currentTime before metadata is available is ignored by some
      // Chromium builds.  Run the same seek again when the generated preview
      // has its duration, otherwise the editor appears permanently stuck on
      // the first frame after C becomes ready.
      if (!playing || Math.abs(element.currentTime - t) > 0.15) {
        try { element.currentTime = Math.max(0, Math.min(t, Number.isFinite(element.duration) ? element.duration : t)); } catch { /* loading */ }
      }
      if (playing) void element.play().catch(() => {}); else element.pause();
    };
    element.addEventListener("loadedmetadata", sync);
    element.addEventListener("loadeddata", sync);
    element.addEventListener("canplay", sync);
    element.addEventListener("seeked", sync);
    sync();
    return () => {
      element.removeEventListener("loadedmetadata", sync);
      element.removeEventListener("loadeddata", sync);
      element.removeEventListener("canplay", sync);
      element.removeEventListener("seeked", sync);
    };
  }, [project, video, t, playing]);
  const style = { position: "absolute" as const, inset: 0, width: "100%", height: "100%", pointerEvents: "none" as const };
  return <div style={style}>
    {video?.project === project && playing ? <video ref={ref} src={video.url} muted playsInline preload="auto" style={style} /> :
      image?.project === project ? <img src={image.url} alt="" style={style} /> :
      video?.project === project ? <video ref={ref} src={video.url} muted playsInline preload="auto" style={style} /> : null}
    {error && <div role="status" style={{ position: "absolute", bottom: 8, left: 8, color: "white", background: "#842323", fontSize: 16 }}>{error}</div>}
  </div>;
}
