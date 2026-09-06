import { useSyncExternalStore } from "react";

/** 布局模式:传统式(左中右+时间轴)或对话式(AI助手+预览) */
export type LayoutMode = "classic" | "chat";

const STORAGE_KEY = "pc.layout.mode";

/** 从 localStorage 读取初始布局模式(带异常保护) */
function readInitialMode(): LayoutMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "classic" || saved === "chat") {
      return saved;
    }
  } catch {}
  return "classic";
}

let currentMode: LayoutMode = readInitialMode();
const listeners = new Set<() => void>();

/** 获取当前布局模式 */
export function getLayoutMode(): LayoutMode {
  return currentMode;
}

/** 设置布局模式并持久化至 localStorage */
export function setLayoutMode(mode: LayoutMode): void {
  if (currentMode === mode) return;
  currentMode = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {}
  for (const listener of listeners) {
    listener();
  }
}

/** 订阅布局模式变化 */
export function subscribeLayoutMode(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React hook:获取当前布局模式 */
export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribeLayoutMode, getLayoutMode, () => "classic");
}
