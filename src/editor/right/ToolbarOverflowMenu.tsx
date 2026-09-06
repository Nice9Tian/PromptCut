import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";

export interface OverflowEntry {
  key: string;
  /** 这个控件叫什么。用于「⋯」按钮的悬停提示,以及 showLabel 时菜单行左侧的说明 */
  label: string;
  /**
   * 菜单里要不要额外显示 label。
   * 本身就带文字的按钮不用(不然「历史对话 历史」重复);
   * 分段开关、下拉框这种看不出名字的才需要。
   */
  showLabel?: boolean;
  /** 控件本体,和留在栏上时是同一个 */
  node: JSX.Element;
}

/**
 * 顶栏放不下时的「⋯」按钮和它的菜单。
 *
 * 菜单走 portal 挂到 body:右栏是 overflow:hidden 的,挂在里面会被裁掉。
 * 位置按按钮的实际矩形定,并且贴着面板右边缘往里收,窄面板上不会飘到屏幕外。
 */
export function ToolbarOverflowMenu({ entries }: { entries: OverflowEntry[] }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 面板拉宽后控件被放回栏上,菜单可能空了,顺手收起来
  useEffect(() => {
    if (entries.length === 0) setOpen(false);
  }, [entries.length]);

  // 点外面、按 Escape 关闭;窗口尺寸或滚动一变也关掉,免得菜单和按钮错位
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    const close = () => setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  // 打开后把焦点送进菜单,键盘用户不用从头 Tab 一遍。
  // 跳过 disabled(比如没消息时的「诊断」),否则焦点会落空留在 body 上。
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLElement>("button:not([disabled]), select:not([disabled]), [tabindex]")
      ?.focus();
  }, [open]);

  if (entries.length === 0) return null;

  const toggle = () => {
    setRect(btnRef.current?.getBoundingClientRect() ?? null);
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="ai-gear-btn ai-more-btn"
        title={`更多:${entries.map((e) => e.label).join("、")}`}
        aria-label="更多操作"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={toggle}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            className="ai-overflow-menu"
            role="group"
            aria-label="更多操作"
            style={{
              top: rect.bottom + 4,
              // 右对齐到按钮,再夹回视口内
              left: Math.max(8, Math.min(rect.right - 200, window.innerWidth - 208)),
            }}
            // 菜单里点了按钮就收起来;下拉框选完也收起来
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("button")) setOpen(false);
            }}
            onChange={() => setOpen(false)}
          >
            {entries.map((entry) => (
              <div key={entry.key} className="ai-overflow-row">
                {entry.showLabel && <span className="ai-overflow-label">{entry.label}</span>}
                {entry.node}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
