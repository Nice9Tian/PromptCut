import { useState, useRef, useLayoutEffect } from "react";
import { useStore, actions, getState } from "../../store/project";
import { AnimClock } from "../../kernel/AnimClock";
import { themeStyle } from "../../themes";
import type { CardDef } from "../../kernel/types";
import { DEFAULT_CARD_DUR } from "../../kernel/project";
import { clearDragPayload, MIME_CARD, setDragPayload } from "../dnd";

export function CardCell({ def }: { def: CardDef<any> }) {
  const [hot, setHot] = useState(false);
  const [token, setToken] = useState(0);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const timerRef = useRef<any>(null);
  const ref = useRef<HTMLDivElement>(null);

  const project = useStore(s => s.project);

  useLayoutEffect(() => {
    if (hot && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setBox({ w: rect.width, h: rect.height });
    }
  }, [hot]);

  const onEnter = () => {
    timerRef.current = setTimeout(() => {
      setHot(true);
      setToken(t => t + 1);
    }, 180);
  };

  const onLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setHot(false);
  };

  const onDragStart = (e: React.DragEvent) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setHot(false);
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

  const [error, setError] = useState(false);

  const scale = box.w && box.h ? Math.min(box.w / project.width, box.h / project.height) : 1;

  return (
    <div
      data-pc-card={def.id}
      ref={ref}
      className="relative rounded border border-neutral-800 bg-neutral-900 hover:border-neutral-600 cursor-grab overflow-hidden h-24"
      draggable
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      title="点击 = 加到播放头;拖动 = 拖到时间轴的位置"
    >
      {!hot && (
        <div className="p-1.5 pointer-events-none">
          <div className="text-xs text-neutral-200 font-medium truncate">{def.name}</div>
          <div className="text-[10px] text-neutral-500 line-clamp-2 mt-1">{def.description}</div>
        </div>
      )}
      
      {error && (
        <div className="absolute bottom-1 inset-x-0 text-center text-[10px] text-red-500 z-10 pointer-events-none bg-black/50">
          没有动效轨,先在时间轴新建一条
        </div>
      )}

      {hot && box.w > 0 && box.h > 0 && (
        <>
          <div data-pc="preview" className="absolute inset-0 overflow-hidden bg-black/60 pointer-events-none" style={{ ...themeStyle(project.themeId) }}>
            <div style={{
              position: "absolute",
              left: (box.w - project.width * scale) / 2,
              top: (box.h - project.height * scale) / 2,
              width: project.width,
              height: project.height,
              transform: `scale(${scale})`,
              transformOrigin: "0 0"
            }}>
              <div className="pc-stage" style={{ position: "relative", width: "100%", height: "100%" }} key={token}>
                <AnimClock speed={1}>
                  <def.Component params={def.defaults} playToken={token} />
                </AnimClock>
              </div>
            </div>
          </div>
          <div className="absolute top-0 inset-x-0 bg-black/70 text-[10px] px-1 py-0.5 truncate text-neutral-200 pointer-events-none z-10">
            {def.name}
          </div>
        </>
      )}
    </div>
  );
}
