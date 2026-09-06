import { useCallback, useEffect, useRef, useState } from "react";
import { MediaLayers } from "./preview/MediaLayers";
import { themeStyle } from "../themes";
import { actions, useStore } from "../store/project";
import type { PcStageApi } from "../StageView";
import { ControlBar } from "./preview/ControlBar";
import { ToolBar, ToolType } from "./preview/ToolBar";
import { MiniScrubber } from "./preview/MiniScrubber";
import { PreviewContextMenu } from "./preview/PreviewContextMenu";
import { getCard } from "../kernel/registry";
import { useLayoutMode } from "./layoutMode";

/**
 * 中央预览:视频层 + 动效渲染面,按容器缩放。播放循环也在这里(rAF 推进 store.t)。
 *
 * 动效不在这个文档里播:它跑在下面那个 ?stage=1 的 iframe(渲染面)里,时间被接管,
 * 这里只下发「现在是时间轴第几秒」,渲染面渲染出那一帧。所以拖播放头到片段中间
 * 看到的是那一刻该有的画面,而不是把进场动画从头重播一遍。详见 src/StageView.tsx。
 *
 * 视频层:按 videoClipAt 找当前该播的素材段,src 变了换源,时间对不上(>0.2s)就 seek。
 */
export function Preview({ chatLayout }: { chatLayout?: boolean }) {
  const layoutMode = useLayoutMode();
  // prop 是显式覆盖用的，平时不传就按当前 layoutMode 是否为 chat 决定
  const showMiniScrubber = chatLayout !== undefined ? chatLayout : layoutMode === "chat";

  const project = useStore((s) => s.project);
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  const playToken = useStore((s) => s.playToken);
  const selection = useStore((s) => s.selection);
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(0.4);
  const [stageReady, setStageReady] = useState(false);
  const tRef = useRef(t);
  tRef.current = t;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  const [tool, setTool] = useState<ToolType>("select");
  const [rects, setRects] = useState<{ clipId: string; left: number; top: number; width: number; height: number }[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; clipId: string; cardId: string } | null>(null);
  const [editingText, setEditingText] = useState<{ clipId: string; key: string; value: string; x: number; y: number } | null>(null);
  
  // 记录拖动工具过程中的位移预览状态
  const [dragPreview, setDragPreview] = useState<{ clipId: string; dx: number; dy: number } | null>(null);

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

  const refreshRects = useCallback(() => {
    const s = stage();
    if (s && s.rects) {
      setRects(s.rects());
    }
  }, [stage]);

  // 项目文档变了就整份发过去(渲染面自己判断要不要重跑这一帧)
  useEffect(() => {
    if (!stageReady) return;
    stage()?.setProject(project);
    setTimeout(refreshRects, 50);
  }, [stageReady, project, stage, refreshRects]);

  // 时间变了就下发。播放中是连续推进;拖播放头 / 跳转 / 重播(playToken 变)都按跳转处理:
  // 重挂载 + 从入点补跑到那一刻。两者合在一个 effect 里,一次 seek 只渲染一帧。
  useEffect(() => {
    if (!stageReady) return;
    stage()?.render(t, { jump: !playingRef.current });
    refreshRects();
  }, [stageReady, t, playToken, stage, refreshRects]);

  // 画面层和声音层都由 MediaLayers 管:可以同时有多条画面(重叠+淡化=交叉溶解),音频段单独出声

  // 命中测试与拖拽逻辑
  const handleOverlayPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;

    const targetRect = [...rects].reverse().find((r) => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height);

    if (tool === "select") {
      // 选择工具：点在卡片上则选中，点空白则取消选中
      if (targetRect) {
        actions.select([targetRect.clipId]);
      } else {
        actions.select([]);
      }
    } else if (tool === "move") {
      // 移动工具：按下开始拖拽，移动时更新本地拖拽状态，松开才写入 store 记录撤销
      if (!targetRect) return;
      actions.select([targetRect.clipId]);
      const clipId = targetRect.clipId;
      const startX = e.clientX;
      const startY = e.clientY;
      const clip = project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === clipId);
      const initX = (clip?.params.x as number) || 0;
      const initY = (clip?.params.y as number) || 0;

      let currentDx = 0;
      let currentDy = 0;

      const onMove = (ev: PointerEvent) => {
        currentDx = (ev.clientX - startX) / scale;
        currentDy = (ev.clientY - startY) / scale;
        setDragPreview({ clipId, dx: currentDx, dy: currentDy });
      };
      
      const onUp = () => {
        setDragPreview(null);
        if (Math.abs(currentDx) > 0.01 || Math.abs(currentDy) > 0.01) {
          // 等卡片支持 x/y 参数后即可生效
          actions.setClipParams(clipId, { x: initX + currentDx, y: initY + currentDy }, { merge: true });
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    }
  };

  // 文字工具逻辑
  const handleOverlayDoubleClick = (e: React.MouseEvent) => {
    if (tool !== "text") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    const targetRect = [...rects].reverse().find((r) => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height);
    if (!targetRect) return;

    const clip = project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === targetRect.clipId);
    if (!clip) return;
    const def = getCard(clip.cardId);
    if (!def) return;
    const textControl = def.controls.find((c) => c.type === "text");
    if (!textControl) return;

    const val = (clip.params[textControl.key] as string) ?? def.defaults[textControl.key] ?? "";
    
    // 输入框位置定位到卡片左上角（根据命中的目标矩形来换算）
    const inputX = targetRect.left * scale + rect.left;
    const inputY = targetRect.top * scale + rect.top;

    setEditingText({
      clipId: clip.id,
      key: textControl.key,
      value: val,
      x: inputX,
      y: inputY,
    });
  };

  const handleOverlayContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    const targetRect = [...rects].reverse().find((r) => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height);
    if (targetRect) {
      const clip = project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === targetRect.clipId);
      if (clip) {
        setContextMenu({ x: e.clientX, y: e.clientY, clipId: clip.id, cardId: clip.cardId });
      }
    }
  };

  const submitTextEdit = () => {
    if (editingText) {
      actions.setClipParams(editingText.clipId, { [editingText.key]: editingText.value }, { merge: true });
    }
    setEditingText(null);
  };

  return (
    <div className="w-full h-full flex flex-col overflow-hidden bg-[var(--ui-bg)]">
      <ToolBar tool={tool} onToolChange={setTool} />
      
      <div ref={boxRef} className="flex-1 w-full grid place-items-center overflow-hidden relative">
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
              <MediaLayers project={project} t={t} playing={playing} />
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
          
          {/* 画布覆盖层，处理命中测试以及拖拽绘制 */}
          <div
            style={{ position: "absolute", inset: 0, zIndex: 10 }}
            onPointerDown={handleOverlayPointerDown}
            onDoubleClick={handleOverlayDoubleClick}
            onContextMenu={handleOverlayContextMenu}
          >
            {rects.map((r) => {
              const isSelected = selection.includes(r.clipId);
              if (!isSelected) return null;
              const dragDx = (dragPreview?.clipId === r.clipId) ? dragPreview.dx : 0;
              const dragDy = (dragPreview?.clipId === r.clipId) ? dragPreview.dy : 0;

              return (
                <div
                  key={r.clipId}
                  style={{
                    position: "absolute",
                    left: (r.left + dragDx) * scale,
                    top: (r.top + dragDy) * scale,
                    width: r.width * scale,
                    height: r.height * scale,
                    border: "2px solid var(--ui-accent)",
                    pointerEvents: "none",
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
      
      <ControlBar />
      {showMiniScrubber && <MiniScrubber />}
      
      {contextMenu && (
        <PreviewContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          clipId={contextMenu.clipId}
          cardId={contextMenu.cardId}
          onClose={() => setContextMenu(null)}
        />
      )}
      
      {editingText && (
        <div style={{ position: "fixed", left: editingText.x, top: editingText.y, zIndex: 9999 }}>
          <input
            autoFocus
            type="text"
            value={editingText.value}
            onChange={(e) => setEditingText({ ...editingText, value: e.target.value })}
            onBlur={submitTextEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitTextEdit();
              if (e.key === "Escape") setEditingText(null);
            }}
            style={{
              padding: "4px 8px",
              border: "1px solid var(--ui-accent)",
              borderRadius: 4,
              background: "var(--ui-panel-2)",
              color: "var(--ui-fg)",
              outline: "none",
              fontSize: 14,
            }}
          />
        </div>
      )}
    </div>
  );
}
