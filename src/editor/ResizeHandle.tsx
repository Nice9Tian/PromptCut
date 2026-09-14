import { useRef } from "react";

/**
 * 面板拖杆。左栏 / 右栏 / 时间轴共用这一根:
 * - axis="x" 拖出宽度,axis="y" 拖出高度
 * - invert:拖动方向和尺寸增长方向相反(右栏往左拖变宽、时间轴往上拖变高)
 * - 双击回到默认尺寸
 *
 * 拖动期间给 <body> 打上 data-pc-resizing:预览是个 iframe,鼠标滑进去就收不到
 * pointermove 了(虽然有 setPointerCapture 兜底,但按下时若捕获失败就会断),
 * 所以直接让它这会儿不吃鼠标事件。顺带把光标和禁选也统一成拖动态。
 */
export function ResizeHandle({
  axis,
  value,
  min,
  max,
  invert = false,
  disabled = false,
  onChange,
  onCommit,
  onReset,
  title,
}: {
  axis: "x" | "y";
  value: number;
  min: number;
  max: number | (() => number);
  invert?: boolean;
  disabled?: boolean;
  onChange: (next: number) => void;
  onCommit: () => void;
  onReset?: () => void;
  title?: string;
}) {
  const latest = useRef(value);
  latest.current = value;

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const start = axis === "x" ? e.clientX : e.clientY;
    const startValue = value;
    const sign = invert ? -1 : 1;

    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // 指针已经不在了(合成事件等),没有捕获也能拖
    }
    document.body.dataset.pcResizing = axis;
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const now = axis === "x" ? ev.clientX : ev.clientY;
      const upper = typeof max === "function" ? max() : max;
      onChange(Math.max(min, Math.min(upper, startValue + (now - start) * sign)));
    };
    const onUp = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        // 已经放开了
      }
      delete document.body.dataset.pcResizing;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onCommit();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const cursorClass = disabled ? "" : (axis === "x" ? "cursor-col-resize" : "cursor-row-resize");
  const disabledClass = disabled ? "is-disabled" : "";

  return (
    <div
      data-pc-resize={axis}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      style={{ pointerEvents: disabled ? "none" : "auto" }}
      className={`pc-gutter shrink-0 touch-none flex items-center justify-center ${
        axis === "x" ? "w-2 h-full" : "h-2 w-full"
      } ${cursorClass} ${disabledClass}`}
      title={title ?? (onReset ? "拖动调整大小,双击复位" : "拖动调整大小")}
      onPointerDown={handlePointerDown}
      onDoubleClick={onReset}
    />
  );
}
