import { useCallback, useEffect, useRef, useState } from "react";
import { videoClipAt } from "../kernel/project";
import { themeStyle } from "../themes";
import { actions, useStore } from "../store/project";
import type { PcStageApi } from "../StageView";

/**
 * 中央预览:视频层 + 动效渲染面,按容器缩放。播放循环也在这里(rAF 推进 store.t)。
 *
 * 动效不在这个文档里播:它跑在下面那个 ?stage=1 的 iframe(渲染面)里,时间被接管,
 * 这里只下发「现在是时间轴第几秒」,渲染面渲染出那一帧。所以拖播放头到片段中间
 * 看到的是那一刻该有的画面,而不是把进场动画从头重播一遍。详见 src/StageView.tsx。
 *
 * 视频层:按 videoClipAt 找当前该播的素材段,src 变了换源,时间对不上(>0.2s)就 seek。
 */
export function Preview() {
  const project = useStore((s) => s.project);
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  const playToken = useStore((s) => s.playToken);
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(0.4);
  const [stageReady, setStageReady] = useState(false);
  const tRef = useRef(t);
  tRef.current = t;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  const stage = useCallback((): PcStageApi | null => {
    return frameRef.current?.contentWindow?.__pcStage ?? null;
  }, []);

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

  // 渲染面就绪:它挂载完会 postMessage 过来;刷新顺序不定,onLoad 里再探一次
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source === frameRef.current?.contentWindow && (e.data as any)?.type === "pc-stage-ready") setStageReady(true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // 项目文档变了就整份发过去(渲染面自己判断要不要重跑这一帧)
  useEffect(() => {
    if (!stageReady) return;
    stage()?.setProject(project);
  }, [stageReady, project, stage]);

  // 时间变了就下发。播放中是连续推进;拖播放头 / 跳转 / 重播(playToken 变)都按跳转处理:
  // 重挂载 + 从入点补跑到那一刻。两者合在一个 effect 里,一次 seek 只渲染一帧。
  useEffect(() => {
    if (!stageReady) return;
    stage()?.render(t, { jump: !playingRef.current });
  }, [stageReady, t, playToken, stage]);

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
            <iframe
              ref={frameRef}
              data-pc="stage-frame"
              title="预览舞台"
              src={`${location.pathname}?stage=1`}
              onLoad={() => {
                if (frameRef.current?.contentWindow?.__pcStage) setStageReady(true);
              }}
              style={{
                position: "absolute",
                inset: 0,
                width: project.width,
                height: project.height,
                border: 0,
                display: "block",
                background: "transparent",
                colorScheme: "normal",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
