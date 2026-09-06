import type { CardDef } from "./types";

const map = new Map<string, CardDef<any>>();

export function registerCards(defs: CardDef<any>[]) {
  for (const d of defs) {
    if (map.has(d.id)) throw new Error(`card id 重复: ${d.id}`);
    map.set(d.id, d);
  }
}

export function getCard(id: string): CardDef<any> | undefined {
  return map.get(id);
}

export function allCards(): CardDef<any>[] {
  return [...map.values()];
}
