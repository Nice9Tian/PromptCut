import { useEffect, useRef } from "react";
import { ContextMenuItem } from "./types";

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  // Prevent menu from going off-screen
  const style: React.CSSProperties = { top: y, left: x };

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[150px] bg-neutral-800 border border-neutral-700 shadow-xl rounded py-1 text-sm text-neutral-200"
      style={style}
    >
      {items.map((item, i) => (
        <div
          key={i}
          className={`px-3 py-1.5 cursor-pointer hover:bg-neutral-700 ${item.disabled ? "opacity-50 pointer-events-none" : ""}`}
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
    </div>
  );
}
