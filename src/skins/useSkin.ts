import { useSyncExternalStore } from "react";
import { DEFAULT_SKIN, skins } from "./skins";

let currentSkin = DEFAULT_SKIN;
try {
  const saved = localStorage.getItem("pc.skin");
  if (saved && skins.some(s => s.id === saved)) {
    currentSkin = saved;
  }
} catch (e) {
  // ignore
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentSkin;
}

export function setSkin(id: string) {
  if (id === currentSkin) return;
  if (!skins.some(s => s.id === id)) return;
  currentSkin = id;
  
  try {
    localStorage.setItem("pc.skin", id);
  } catch (e) {
    // ignore
  }

  document.documentElement.dataset.skin = id;
  document.documentElement.classList.add("skin-swapping");
  setTimeout(() => {
    document.documentElement.classList.remove("skin-swapping");
  }, 200);

  listeners.forEach(l => l());
}

// Initial setup
if (typeof document !== "undefined") {
  document.documentElement.dataset.skin = currentSkin;
}

export function useSkin() {
  const skinId = useSyncExternalStore(subscribe, getSnapshot);
  return { skinId, setSkin };
}

export { skins };
