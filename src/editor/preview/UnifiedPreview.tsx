import { useEffect, useRef, useState } from "react";
import type { Project } from "../../kernel/project";
import { collectSnapshots, frameRequest, see_frames } from "../../render/frameClient";
import { MovPlayer } from "../../render/movPlayer";
import { frameCss } from "../../kernel/layout";

/** Paused exact frames and live MOV playback share see_frames and its caches. */
export function UnifiedPreview({ project, t, playing }: { project: Project; t: number; playing: boolean }) {
  const [image, setImage] = useState<{ project: Project; url: string } | null>(null);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [playbackPreview, setPlaybackPreview] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ t, playing }); latest.current = { t, playing };
  const requestFrame = useRef<() => void>(() => {});
  const wakePlayback = useRef<() => void>(() => {});

  useEffect(() => {
    let active = true, archived = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await frameRequest("preload", project, {}, undefined, { target: "prerender", lane: "background" });
        if (!active) return;
        if (status.sampled > archived) { await collectSnapshots(project); archived = status.sampled; }
        if (status.status !== "ready" && active) timer = setTimeout(poll, 2000);
      } catch { if (active) timer = setTimeout(poll, 4000); }
    };
    timer = setTimeout(poll, 600);
    return () => { active = false; clearTimeout(timer); };
  }, [project]);

  useEffect(() => {
    let active = true, inFlight = false, pending = false;
    let retry: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    const fps = Math.max(1, project.fps || 30);
    const draw = async () => {
      pending = true;
      if (inFlight || !active || latest.current.playing) return;
      clearTimeout(retry);
      inFlight = true;
      while (active && pending && !latest.current.playing) {
        pending = false;
        const requested = latest.current.t;
        controller = new AbortController();
        try {
          const result = await see_frames(project, [requested], controller.signal, { target: "user", lane: "user" });
          // A stale result can populate the common cache, but never the view.
          if (active && !latest.current.playing && Math.round(requested * fps) === Math.round(latest.current.t * fps)) {
            if (result.frames[0]) setImage({ project, url: result.frames[0].url });
            setMissing(result.frames[0]?.missing || []);
            if (result.incomplete) retry = setTimeout(() => { void draw(); }, 700);
            setError("");
          }
        } catch (e) {
          if (active && !controller.signal.aborted) {
            setError(String(e));
            // A backend restart should recover the paused frame without
            // requiring a timeline edit or a reload of unsaved work.
            if ((e as { retryable?: boolean }).retryable) retry = setTimeout(() => { void draw(); }, 2000);
          }
        }
        if (Math.round(requested * fps) !== Math.round(latest.current.t * fps)) pending = true;
      }
      inFlight = false;
    };
    requestFrame.current = () => {
      if (latest.current.playing) controller?.abort(); else void draw();
    };
    void draw();
    return () => { active = false; clearTimeout(retry); controller?.abort(); };
  }, [project]);
  useEffect(() => { requestFrame.current(); }, [Math.round(t * (project.fps || 30)), playing, project]);

  useEffect(() => {
    if (!canvas.current) return;
    const player = new MovPlayer(canvas.current, setError);
    const owner = crypto.randomUUID();
    let active = true, sequence = 0, running = false, pending = false, raf = 0;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const pulse = async () => {
      pending = true;
      if (running || !active) return;
      clearTimeout(timer); running = true; pending = false;
      const clock = { ...latest.current };
      try {
        const status = await frameRequest("playback", project, { owner, sequence: ++sequence, ...clock, rate: 1, sentAt: Date.now(),
          deliveryMs: Math.min(5000, player.deliveryMs + 150) }, controller.signal);
        if (active && !status.closed && clock.playing === latest.current.playing) {
          player.update(status);
          if (clock.playing) { setMissing(status.preview?.missing || []); setPlaybackPreview(status.preview?.url || null); }
          if (status.error) setError(status.error); else if (clock.playing) setError("");
        }
      } catch (e) { if (active && !controller.signal.aborted) setError(String(e)); }
      finally {
        running = false;
        if (active) timer = setTimeout(pulse, pending ? 0 : latest.current.playing ? 100 : 1000);
      }
    };
    wakePlayback.current = () => { void pulse(); };
    const tick = () => {
      if (latest.current.playing) player.draw(latest.current.t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    void pulse(); // Create the full-duration transparent MOV when opening a project.
    return () => {
      active = false; controller.abort(); clearTimeout(timer); cancelAnimationFrame(raf); player.close();
      void frameRequest("playback", project, { owner, sequence: ++sequence, t: latest.current.t, playing: false, close: true }).catch(() => {});
    };
  }, [project]);
  useEffect(() => { wakePlayback.current(); }, [playing, project]);

  const style = { position: "absolute" as const, inset: 0, width: "100%", height: "100%", pointerEvents: "none" as const };
  return <div style={style}>
    <canvas ref={canvas} width={project.width} height={project.height} style={{ ...style, display: playing ? "block" : "none" }} />
    {playing && playbackPreview && <img src={playbackPreview} alt="" style={style} />}
    {!playing && image?.project === project && <img src={image.url} alt="" style={style} />}
    <style>{`@keyframes pc-card-hourglass{0%,35%{transform:rotate(0)}65%,100%{transform:rotate(180deg)}}`}</style>
    {project.tracks.flatMap(track => track.hidden ? [] : track.clips).filter(clip => missing.includes(clip.id) && t >= clip.start && t < clip.end).map(clip =>
      <div key={clip.id} role="status" aria-label="正在预渲染" style={{ ...frameCss(clip.frame, project), display: 'grid', placeItems: 'center', border: '2px dashed #dcb66a', boxSizing: 'border-box' }}>
        <span style={{ fontSize: 28, animation: 'pc-card-hourglass 1.8s ease-in-out infinite', background: '#202934', borderRadius: 8, padding: 8 }}>⌛</span>
      </div>)}
    {error && <div role="status" style={{ position: "absolute", bottom: 8, left: 8, color: "white", background: "#842323", fontSize: 16 }}>{error}</div>}
  </div>;
}
