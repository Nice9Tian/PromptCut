import type { CardDef } from "./types";

const map = new Map<string, CardDef<any>>();

/**
 * 注册卡片。同一次调用里 id 撞车是真的写错了(两张卡抢一个 id),直接抛错;
 * 跨调用的同 id 则按覆盖处理 —— 因为 cards/index.ts 会被 HMR 重新执行
 * (新建/修改 src/cards/user/ 下的卡就会触发),而这个 map 活在另一个模块里不会跟着重置。
 * 以前一律抛错,导致建完卡热更新时直接 "card id 重复" 把整个应用打挂,
 * 要手动刷新才能恢复。
 */
export function registerCards(defs: CardDef<any>[]) {
  const seen = new Set<string>();
  for (const d of defs) {
    if (seen.has(d.id)) throw new Error(`card id 重复: ${d.id}`);
    seen.add(d.id);
    map.set(d.id, d);
  }
}

/** 重新装载整套卡片前先清空,免得删掉的卡片文件在热更新后还赖在库里 */
export function resetCards() {
  map.clear();
}

export function getCard(id: string): CardDef<any> | undefined {
  return map.get(id);
}

export function allCards(): CardDef<any>[] {
  return [...map.values()];
}
