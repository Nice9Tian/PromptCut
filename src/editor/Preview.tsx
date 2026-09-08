import { useCallback, useEffect, useRef, useState } from "react";
import { MediaLayers } from "./preview/MediaLayers";
import { themeStyle } from "../themes";
import { actions, getState, useStore } from "../store/project";
import { videoLayersAt, findClip } from "../kernel/project";
import { frameBox, nudgeFrame } from "../kernel/layout";
import type { PcStageApi } from "../StageView";
import { ControlBar } from "./preview/ControlBar";
import { ToolBar, ToolType } from "./preview/ToolBar";
import { MiniScrubber } from "./preview/MiniScrubber";
import { PreviewContextMenu } from "./preview/PreviewContextMenu";
import { getCard } from "../kernel/registry";
import { useLayoutMode } from "./layoutMode";
import "./preview/preview.css";

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
  const volume = useStore((s) => s.volume);
  const muted = useStore((s) => s.muted);
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

  // 把 getter 挂到主窗口,AI 的定位工具(get_layout 等)靠它量卡片的实体内容框。
  // 挂的是 getter 不是 api 本身:iframe 重载后 api 会换,getter 每次都取最新的。
  useEffect(() => {
    window.__pcPreviewStage = stage;
    return () => {
      if (window.__pcPreviewStage === stage) delete window.__pcPreviewStage;
    };
  }, [stage]);

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

  /**
   * 选中描边用的外框:不用包裹层(每张卡都占满整屏),用片段的实体范围——
   * 字幕卡的描边贴着字幕本身,而不是绕屏幕一圈。老渲染面没有 bounds 就退回包裹层。
   */
  /**
   * 此刻画面上的素材段(视频 / 图片)和它们的矩形。
   *
   * 它们由**主文档**的 MediaLayers 画,不在舞台 iframe 里 —— 所以 iframe 的 hitTest
   * 看不见它们,点一下视频等于点了个寂寞(选不中、拖不动)。这里把它们补上,
   * 和卡片一起参与命中和描边。矩形就是片段的框,没设框就是整幅画面。
   */
  const mediaRects = useCallback((): { clipId: string; left: number; top: number; width: number; height: number }[] => {
    const stageSize = { width: project.width, height: project.height };
    return videoLayersAt(project, t).map((l) => ({ clipId: l.clip.id, ...frameBox(l.clip.frame, stageSize) }));
  }, [project, t]);

  const refreshRects = useCallback(() => {
    const s = stage();
    const list = s?.rects ? s.rects() : [];
    const cards = s?.bounds
      ? list.map((r) => {
          const b = s.bounds!(r.clipId);
          return b ? { clipId: r.clipId, ...b } : r;
        })
      : list;
    // 素材段在下、卡片在上(DOM 里 MediaLayers 排在舞台 iframe 前面),命中时也按这个顺序找
    setRects([...mediaRects(), ...cards]);
  }, [stage, mediaRects]);

  /** 刚被点中的片段:描边闪一下,让用户看清点到的是谁 */
  const [flash, setFlash] = useState<{ clipId: string; token: number } | null>(null);
  const flashClip = (clipId: string) => setFlash({ clipId, token: Date.now() });

  /**
   * 实体命中:问渲染面这一点上从最上层往下第一个「画了东西」的元素属于哪个片段。
   * 透明容器穿过去——字幕卡在最上层也不会挡住下面的卡。老渲染面没有 hitTest 时
   * 退回按包裹层外框找最上层的那个。
   */
  const hitAt = (e: { clientX: number; clientY: number; currentTarget: EventTarget & Element }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    const s = stage();
    // 卡片在上层:先问舞台。没点中卡片再看素材段(它们在主文档里,舞台看不见)
    const card = s?.hitTest ? s.hitTest(x, y) : null;
    const inside = (r: { left: number; top: number; width: number; height: number }) =>
      x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    const hit =
      card ??
      [...mediaRects()].reverse().find(inside) ??
      (s?.hitTest ? null : [...rects].reverse().find(inside)) ??
      null;
    return { hit, overlayRect: rect };
  };

  // 项目文档变了就整份发过去(渲染面自己判断要不要重跑这一帧)
  useEffect(() => {
    if (!stageReady) return;
    stage()?.setProject(project);
    setTimeout(refreshRects, 50);
  }, [stageReady, project, stage, refreshRects]);

  /*
   * 实体模式的挡位:**播放中 = 色块,暂停 = 真渲**。
   *
   * 这是最省事的调度,也基本够用 —— 不需要 requestIdleCallback、不需要优先级队列,
   * 而且符合剪辑软件的直觉:一边看一边判断构图,停下来才看细节。
   * 真要更细,再按「离播放头的距离」分批升级。
   */
  useEffect(() => {
    if (!stageReady) return;
    stage()?.setProxy(playing);
  }, [stageReady, playing, stage]);

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
    const { hit: targetRect } = hitAt(e);

    if (tool === "select") {
      // 选择工具：点在实体上则选中并闪一下描边，点空白(或透明区域下面没东西)则取消选中
      if (targetRect) {
        actions.select([targetRect.clipId]);
        flashClip(targetRect.clipId);
      } else {
        actions.select([]);
      }
    } else if (tool === "move") {
      // 移动工具：按下开始拖拽，移动时更新本地拖拽状态，松开才写入 store 记录撤销
      if (!targetRect) return;
      actions.select([targetRect.clipId]);
      flashClip(targetRect.clipId);
      const clipId = targetRect.clipId;
      const startX = e.clientX;
      const startY = e.clientY;

      let currentDx = 0;
      let currentDy = 0;

      const onMove = (ev: PointerEvent) => {
        // 覆盖层是按 scale 缩放显示的,位移换算回舞台像素,和 frame 用的是同一套单位
        currentDx = (ev.clientX - startX) / scale;
        currentDy = (ev.clientY - startY) / scale;
        setDragPreview({ clipId, dx: currentDx, dy: currentDy });
      };

      const onUp = () => {
        setDragPreview(null);
        if (Math.abs(currentDx) > 0.5 || Math.abs(currentDy) > 0.5) {
          /*
           * 拖动改的是 clip 的 frame(位置框),不是卡片参数:卡片没有 x / y 参数,以前往 params 里
           * 写 x / y 等于什么都没改 —— 描边跟着鼠标走了一段,松手就弹回去。
           * 走 nudgeFrame 和 Agent 的 nudge / set_position 是同一条路:没有 frame 的卡先按铺满舞台
           * 算出当前位置再加位移,松手只写一次,一次拖动 = 一步撤销。
           */
          const hit = findClip(getState().project, clipId);
          if (hit) {
            const stageSize = { width: getState().project.width, height: getState().project.height };
            actions.setClipFrame(clipId, nudgeFrame({ dx: Math.round(currentDx), dy: Math.round(currentDy) }, hit.clip.frame, stageSize));
          }
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
    const { hit: targetRect, overlayRect: rect } = hitAt(e);
    if (!targetRect) return;
    flashClip(targetRect.clipId);

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
    const { hit: targetRect } = hitAt(e);
    if (targetRect) {
      const clip = project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === targetRect.clipId);
      if (clip) {
        actions.select([clip.id]);
        flashClip(clip.id);
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
    <div className="pc-pv" data-pc="preview">
      <ToolBar tool={tool} onToolChange={setTool} />

      <div ref={boxRef} className="pc-pv-stage">
        <div
          className="pc-pv-frame"
          style={{
            width: project.width * scale,
            height: project.height * scale,
            // 透明棋盘格必须比周围画布更暗、更弱(配色规范 04 条):原来是偏亮的中灰,
            // 在近黑界面里成了最亮的一大块,把注意力从画面本身拽走。跟着皮肤走,不写死。
            backgroundColor: "color-mix(in srgb, var(--ui-bg-2) 30%, var(--ui-panel))",
            backgroundImage:
              "linear-gradient(45deg,var(--ui-bg-2) 25%,transparent 25%,transparent 75%,var(--ui-bg-2) 75%),linear-gradient(45deg,var(--ui-bg-2) 25%,transparent 25%,transparent 75%,var(--ui-bg-2) 75%)",
            backgroundSize: "32px 32px",
            backgroundPosition: "0 0,16px 16px",
          }}
        >
          <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0", position: "absolute", left: 0, top: 0, ...themeStyle(project.themeId) }}>
            <div style={{ position: "relative", width: project.width, height: project.height }}>
              <MediaLayers project={project} t={t} playing={playing} masterVolume={muted ? 0 : volume} />
              <iframe
                ref={frameRef}
                data-pc="stage-frame"
                title="预览舞台"
                // proxy=1 只加在编辑台这一处:实体模式是给人浏览用的,
                // 导出(?export=1)和 see_preview 都不该看到色块(见 render/solidMode.ts)
                src={`${location.pathname}?stage=1&proxy=1`}
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
          
          {/* 四角标记:设计稿画面四角各一个 16 方的 L 形,提示这是可编辑画布 */}
          <span className="pc-pv-corner tl" aria-hidden="true" />
          <span className="pc-pv-corner tr" aria-hidden="true" />
          <span className="pc-pv-corner bl" aria-hidden="true" />
          <span className="pc-pv-corner br" aria-hidden="true" />

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

              // 描边贴着实体范围;刚点中的那个用 key 带上 token,每次点击都重新跑一遍脉冲动画
              const pulsing = flash?.clipId === r.clipId;
              return (
                <div
                  key={pulsing ? `${r.clipId}:${flash!.token}` : r.clipId}
                  className={`pc-pv-hit${pulsing ? " is-pulse" : ""}`}
                  style={{
                    left: (r.left + dragDx) * scale,
                    top: (r.top + dragDy) * scale,
                    width: r.width * scale,
                    height: r.height * scale,
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
