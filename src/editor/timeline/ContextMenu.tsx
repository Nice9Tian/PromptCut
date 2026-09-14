import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ContextMenuItem } from "./types";

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/** 菜单离视口边缘至少留这么多 */
const EDGE = 6;

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // 靠窗口右边 / 底部时往回夹:时间轴就在窗口最下面,右键靠下的片段时菜单原来会戳出窗口。
  // layout effect 里量完再改位置,浏览器画出来之前就已经夹好了
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(x, window.innerWidth - r.width - EDGE));
    const top = Math.max(EDGE, Math.min(y, window.innerHeight - r.height - EDGE));
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
  }, [x, y, items.length]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 时间轴或窗口一滚动 / 缩放,菜单指着的位置就不对了,直接关掉
    const close = () => onClose();
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", close, { capture: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  // 片段 / 行头所在的层是独立层叠上下文(index.tsx 的 isolation),菜单留在里面会被吸顶的标尺和行头列压住,
  // 所以 portal 到 body。React 事件仍按组件树冒泡,和原来挂在片段里一样;颜色不再能靠 [data-pc="timeline"] 下的换色规则,
  // 直接用皮肤变量(.pc-tl-ctxmenu,timeline.css)。
  return createPortal(
    <div
      ref={ref}
      data-pc="tl-ctxmenu"
      className="pc-tl-ctxmenu fixed min-w-[150px] py-1 text-sm"
      style={{ left: pos.left, top: pos.top }}
    >
      {items.map((item, i) => (
        <div
          key={i}
          className={`pc-tl-ctxmenu-item px-3 py-1.5 cursor-pointer ${item.disabled ? "opacity-50 pointer-events-none" : ""}`}
          onClick={() => {
            if (!item.disabled) {
              item.action();
              onClose();
            }
          }}
        >
          {item.label}
        </div>
      ))}
    </div>,
    document.body,
  );
}
