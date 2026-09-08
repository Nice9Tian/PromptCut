import type { PartDef } from "./types";

const map = new Map<string, PartDef<any>>();

/** 和卡片注册表一样:同一次调用里 id 撞车是写错了,跨调用同 id 按覆盖(HMR 会重跑 index.ts) */
export function registerParts(defs: PartDef<any>[]) {
  const seen = new Set<string>();
  for (const d of defs) {
    if (seen.has(d.id)) throw new Error(`part id 重复: ${d.id}`);
    seen.add(d.id);
    map.set(d.id, d);
  }
}

export function resetParts() {
  map.clear();
}

export function getPart(id: string): PartDef<any> | undefined {
  return map.get(id);
}

export function allParts(): PartDef<any>[] {
  return [...map.values()];
}
