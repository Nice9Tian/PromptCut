/**
 * 侧栏行的右键菜单:重命名 / 置顶 / 归档 / 删除。
 *
 * 三种行(分组、项目、Agent 对话)共用这一个。按 Esc、点别处、滚动都关掉;上下键在项里走,
 * 回车选中 —— 右键菜单只能用鼠标开,但开出来之后得能用键盘走完,不然用读屏的人卡在这儿。
 *
 * 位置按鼠标点,贴着视口边时往回收,免得菜单被切掉一半。
 *
 * 待办(业务层):四样都只改页面上的假数据。真接上去时「删除」必须先确认(删的是云端项目,
 * 不可撤销),「归档」要有地方能看回来、能取消归档,重命名要落到云端文档服务。
 */
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import type { TreeKind } from "./treeKind";

export interface MenuAt {
  id: string;
  kind: TreeKind;
  name: string;
  pinned: boolean;
  /** 鼠标点的位置(视口坐标) */
  x: number;
  y: number;
}

/** 菜单大概多大,用来判断要不要往回收。宽度和 `.ps-menu` 的 min-width 对齐 */
const MENU = { w: 168, h: 148, pad: 8 };

const KIND_WORD: Record<TreeKind, string> = { group: "分组", project: "项目", chat: "对话" };

export function RowMenu(props: {
  at: MenuAt;
  onClose: () => void;
  onRename: () => void;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first = box.current?.querySelector<HTMLButtonElement>("button");
    first?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const items = [...(box.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    // 点别处、滚动都关:用 capture,免得被行自己的 handler 吃掉
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", props.onClose, true);
    window.addEventListener("resize", props.onClose);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", props.onClose, true);
      window.removeEventListener("resize", props.onClose);
    };
  }, [props]);

  // 贴着右边或下边时往回收
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const left = Math.min(props.at.x, vw - MENU.w - MENU.pad);
  const top = Math.min(props.at.y, vh - MENU.h - MENU.pad);

  const item = (label: string, onPick: () => void, extra?: { danger?: boolean; pc?: string }) => (
    <button
      type="button"
      className={`ps-menu-item${extra?.danger ? " is-danger" : ""}`}
      data-pc={extra?.pc}
      onClick={() => {
        onPick();
        props.onClose();
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      ref={box}
      className="ps-menu"
      role="menu"
      aria-label={`${KIND_WORD[props.at.kind]}「${props.at.name}」的操作`}
      data-pc="start-row-menu"
      style={{ left, top }}
    >
      <div className="ps-menu-head" title={props.at.name}>{props.at.name}</div>
      {item("重命名", props.onRename, { pc: "start-menu-rename" })}
      {item(props.at.pinned ? "取消置顶" : "置顶", props.onPin, { pc: "start-menu-pin" })}
      {item("归档", props.onArchive, { pc: "start-menu-archive" })}
      <div className="ps-menu-sep" />
      {item("删除", props.onDelete, { danger: true, pc: "start-menu-delete" })}
    </div>
  );
}
