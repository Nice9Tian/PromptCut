import { useSyncExternalStore } from "react";

/**
 * 左栏 → 时间轴的拖放载荷。
 *
 * HTML5 拖放在 dragover 阶段读不到 dataTransfer 的内容(只能读 types),
 * 但落点预览必须知道拖的是什么、多长。所以拖开始时在这里存一份载荷,
 * 时间轴 dragover 时直接读;dragend / drop 之后清掉。
 * dataTransfer 仍然照常写(见 EDITOR-DESIGN.md 的拖放契约),跨窗口拖进来时还能靠 types 判断种类。
 */

export const MIME_CARD = "application/x-promptcut-card";
export const MIME_MEDIA = "application/x-promptcut-media";

export type DragPayload =
  | { kind: "card"; cardId: string; name: string; duration: number; params?: Record<string, unknown> }
  | { kind: "media"; mediaId: string; name: string; duration: number };

let payload: DragPayload | null = null;
const subs = new Set<() => void>();

function emit() {
  for (const f of subs) f();
}

export function setDragPayload(p: DragPayload) {
  payload = p;
  emit();
  // dragend 不一定落在源元素上(拖出窗口、拖到别的应用都可能丢),这里兜底清一次。
  // 注意用冒泡阶段:捕获阶段会赶在时间轴的 drop 之前把载荷清掉。
  window.addEventListener("dragend", clearDragPayload, { once: true });
  window.addEventListener("drop", clearDragPayload, { once: true });
}

export function clearDragPayload() {
  if (!payload) return;
  payload = null;
  emit();
}

export function getDragPayload(): DragPayload | null {
  return payload;
}

/** dataTransfer.types 里有没有我们认识的载荷(跨窗口拖进来时只能靠它) */
export function hasDragType(types: readonly string[] | DOMStringList): boolean {
  const list = Array.from(types as ArrayLike<string>);
  return list.includes(MIME_CARD) || list.includes(MIME_MEDIA);
}

function subscribe(f: () => void) {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

/** 组件里读「现在正拖着什么」(没在拖 = null) */
export function useDragPayload(): DragPayload | null {
  return useSyncExternalStore(subscribe, () => payload, () => payload);
}
