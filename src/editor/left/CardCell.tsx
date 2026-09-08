import { useState, useRef, useLayoutEffect } from "react";
import { useStore, actions, getState } from "../../store/project";
import { AnimClock } from "../../kernel/AnimClock";
import { themeStyle } from "../../themes";
import type { CardDef } from "../../kernel/types";
import { DEFAULT_CARD_DUR } from "../../kernel/project";
import { clearDragPayload, MIME_CARD, setDragPayload } from "../dnd";
import { PreviewCard } from "./PreviewCard";

/**
 * 卡片库里的一格:方形预览卡(PreviewCard)。不悬停显示名字和说明,悬停 180ms 后
 * 在卡里按项目画幅等比缩放跑一遍动画;点一下加到播放头,拖动拖到时间轴。
 */
export function CardCell({ def }: { def: CardDef<any> }) {
  const [hot, setHot] = useState(false);
  const [token, setToken] = useState(0);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [error, setError] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);

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
  };

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

  const scale = box.w && box.h ? Math.min(box.w / project.width, box.h / project.height) : 1;

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
              left: (box.w - project.width * scale) / 2,
              top: (box.h - project.height * scale) / 2,
              width: project.width,
              height: project.height,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
            }}
          >
            <div className="pc-stage" style={{ position: "relative", width: "100%", height: "100%" }} key={token}>
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
