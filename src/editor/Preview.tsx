import { useEffect, useRef, useState } from "react";
import { Stage } from "../kernel/Stage";
import { flattenOverlay, videoClipAt } from "../kernel/project";
import { themeStyle } from "../themes";
import { actions, useStore } from "../store/project";

/**
 * 中央预览:视频层 + 动效舞台,按容器缩放。播放循环也在这里(rAF 推进 store.t)。
 * 视频层:按 videoClipAt 找当前该播的素材段,src 变了换源,时间对不上(>0.2s)就 seek。
 */
export function Preview() {
  const project = useStore((s) => s.project);
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  const playToken = useStore((s) => s.playToken);
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [scale, setScale] = useState(0.4);
  const tRef = useRef(t);
  tRef.current = t;

  // 播放循环
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const nt = tRef.current + (now - last) / 1000;
      last = now;
      if (nt >= project.duration) {
        actions.pause();
        actions.seek(project.duration);
        return;
      }
      actions.tick(nt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, project.duration]);

  // 自适应缩放
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setScale(Math.max(0.05, Math.min((r.width - 16) / project.width, (r.height - 16) / project.height)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.width, project.height]);

  // 视频层同步
  const hit = videoClipAt(project, t);
  const videoSrc = hit?.media.url ?? "";
  const videoTime = hit ? (hit.clip.mediaOffset ?? 0) + (t - hit.clip.start) : 0;
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !videoSrc) return;
    if (playing) {
      if (Math.abs(v.currentTime - videoTime) > 0.2) v.currentTime = videoTime;
      if (v.paused) v.play().catch(() => {});
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - videoTime) > 0.03) v.currentTime = videoTime;
    }
  }, [playing, videoTime, videoSrc]);

  const timeline = flattenOverlay(project);
  return (
    <div ref={boxRef} className="w-full h-full grid place-items-center overflow-hidden">
      <div
        className="relative overflow-hidden shadow-2xl"
        style={{
          width: project.width * scale,
          height: project.height * scale,
          backgroundImage:
            "linear-gradient(45deg,#1b1b1b 25%,transparent 25%,transparent 75%,#1b1b1b 75%),linear-gradient(45deg,#1b1b1b 25%,#222 25%,#222 75%,#1b1b1b 75%)",
          backgroundSize: "32px 32px",
          backgroundPosition: "0 0,16px 16px",
        }}
      >
        <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0", position: "absolute", left: 0, top: 0, ...themeStyle(project.themeId) }}>
          <div style={{ position: "relative", width: project.width, height: project.height }}>
            {videoSrc && (
              <video ref={videoRef} src={videoSrc} muted playsInline preload="auto" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
            )}
            <div style={{ position: "absolute", inset: 0 }}>
              <Stage timeline={timeline} t={t} playToken={playToken} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
