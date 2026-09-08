import { useState, useRef, useLayoutEffect, useEffect } from "react";
import { useStore, actions, getState } from "../../store/project";
import { AnimClock } from "../../kernel/AnimClock";
import { themeStyle } from "../../themes";
import type { CardDef } from "../../kernel/types";
import { DEFAULT_CARD_DUR } from "../../kernel/project";
import { clearDragPayload, MIME_CARD, setDragPayload } from "../dnd";
import { PreviewCard } from "./PreviewCard";
import { measureContentBox, unionBox, type Box } from "./contentBox";

/** 量包围盒的时刻(悬停后毫秒):进场动画常常从画外飞进来,多量几次取并集 */
const MEASURE_AT = [160, 600, 1400];
/** 包围盒四周留的空,按盒子尺寸的比例 */
const PAD = 0.1;

/**
 * 卡片库里的一格:方形预览卡(PreviewCard)。不悬停显示名字和说明,悬停 180ms 后
 * 在卡里跑一遍动画;点一下加到播放头,拖动拖到时间轴。
 *
 * 预览的缩放不按整个画幅,按**动效实际画出来的包围盒**:先按整幅铺开跑起来,
 * 量到内容的盒子之后再把视野推近到那个盒子(contentBox.ts)。1920×1080 的画幅
 * 里一个 400px 的标题,按整幅缩进 130px 的卡只剩一粒,按盒子缩就能看清。
 */
export function CardCell({ def }: { def: CardDef<any> }) {
  const [hot, setHot] = useState(false);
  const [token, setToken] = useState(0);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [content, setContent] = useState<Box | null>(null);
  const [error, setError] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const project = useStore((s) => s.project);

  useLayoutEffect(() => {
    if (hot && viewRef.current) {
      const rect = viewRef.current.getBoundingClientRect();
      setBox({ w: rect.width, h: rect.height });
    }
  }, [hot]);

  const onHover = (v: boolean) => {
    setHot(v);
    if (v) setToken((t) => t + 1);
    else setContent(null);
  };

  // 整幅铺开时的比例:量包围盒要用它把屏幕像素换回舞台像素
  const fullScale = box.w && box.h ? Math.min(box.w / project.width, box.h / project.height) : 1;

  useEffect(() => {
    if (!hot) return;
    let union: Box | null = null;
    const timers = MEASURE_AT.map((ms) =>
      window.setTimeout(() => {
        const stage = stageRef.current;
        if (!stage) return;
        const measured = measureContentBox(stage);
        if (!measured) return;
        union = unionBox(union, measured);
        setContent(union);
      }, ms),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [hot, token]);

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(MIME_CARD, def.id);
    e.dataTransfer.effectAllowed = "copy";
    setDragPayload({ kind: "card", cardId: def.id, name: def.name, duration: DEFAULT_CARD_DUR });
    (e.target as HTMLElement).classList.add("opacity-50");
  };

  const onDragEnd = (e: React.DragEvent) => {
    (e.target as HTMLElement).classList.remove("opacity-50");
    clearDragPayload();
  };

  const onClick = () => {
    const t = Math.round(getState().t * 10) / 10;
    const clip = actions.addCardClip(def.id, t, {});
    if (!clip) {
      setError(true);
      setTimeout(() => setError(false), 2000);
    }
  };

  // 有包围盒就推近到盒子(留一圈边),没有就整幅
  let scale = fullScale;
  let left = (box.w - project.width * scale) / 2;
  let top = (box.h - project.height * scale) / 2;
  if (content) {
    const bw = Math.max(1, content.r - content.l);
    const bh = Math.max(1, content.b - content.t);
    scale = Math.min(box.w / (bw * (1 + PAD * 2)), box.h / (bh * (1 + PAD * 2)));
    // 别推得比整幅还远(盒子量错成一大片时退回整幅),也别放大到糊成马赛克
    scale = Math.max(fullScale, Math.min(scale, 2));
    const cx = (content.l + content.r) / 2;
    const cy = (content.t + content.b) / 2;
    left = box.w / 2 - cx * scale;
    top = box.h / 2 - cy * scale;
  }

  const preview = (
    <div ref={viewRef} className="absolute inset-0">
      {!hot && (
        <div className="pc-pcard-text">
          <div className="pc-pcard-name">{def.name}</div>
          <div className="pc-pcard-desc">{def.description}</div>
        </div>
      )}
      {hot && box.w > 0 && box.h > 0 && (
        <div data-pc="preview" className="absolute inset-0 overflow-hidden bg-black/60 pointer-events-none" style={{ ...themeStyle(project.themeId) }}>
          <div
            style={{
              position: "absolute",
              left,
              top,
              width: project.width,
              height: project.height,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
              // 量到盒子之后视野是「推近」过去的,不是跳过去
              transition: content ? "transform 260ms cubic-bezier(0.16, 1, 0.3, 1), left 260ms cubic-bezier(0.16, 1, 0.3, 1), top 260ms cubic-bezier(0.16, 1, 0.3, 1)" : "none",
            }}
          >
            <div ref={stageRef} className="pc-stage" style={{ position: "relative", width: "100%", height: "100%" }} key={token}>
              <AnimClock speed={1}>
                <def.Component params={def.defaults} playToken={token} />
              </AnimClock>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <PreviewCard
      attrs={{ "data-pc-card": def.id }}
      title={def.name}
      // 不悬停时名字已经在画面区里,标题条只在动画跑起来之后压在底边
      caption="hover"
      preview={preview}
      hoverDelayMs={180}
      onHover={onHover}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      error={error ? "没有动效轨,先在时间轴新建一条" : null}
      titleAttr="点击 = 加到播放头;拖动 = 拖到时间轴的位置"
    />
  );
}
