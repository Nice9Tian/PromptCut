import type { CardDef } from "./types";
import { cardCapabilities } from "./frameMode.mjs";

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
    const capabilities = cardCapabilities(d);
    // compositing / canvasHeavy 的权威是审阅表(src/cards/capabilities.json),不是卡片源码,
    // 所以注册时统一盖成审阅结论 —— 后面谁拿 getCard(id) 都读到同一个答案。
    map.set(d.id, { ...d, need_prerendering: capabilities.need_prerendering, compositing: capabilities.compositing,
      canvasHeavy: capabilities.canvasHeavy,
      ...(!Object.hasOwn(d, 'need_prerendering') ? { _derivedPrerendering: true } : {}) });
  }
}

/*
 * 卡片代码换了的通知(C6.6 集成 3b)。`cards/index.ts` 是热更新的边界(它自己接住热更新、重装整套卡片),
 * 热更新不再冒到 Editor、Preview、StageView 上 —— 那会让它们的 effect 在 Fast Refresh 里重跑,
 * 把舞台的 RPC 客户端清掉。于是要看新卡的一方(舞台重渲、编辑器的卡片列表、探针重测)订阅这里。
 * 本模块不在热更新链上(卡片改了它不重跑),订阅一直有效。
 */
let cardsGen = 0;
const cardListeners = new Set<() => void>();

/** `cards/index.ts` 热更新重装完整套卡片之后调 */
export function noteCardsUpdated(): void {
  cardsGen++;
  for (const l of [...cardListeners]) {
    try { l(); } catch (err) { console.warn("[registry] 卡片更新的订阅方出错", err); }
  }
}

/** 卡片代码换过几次(本页面会话里);首次装载是 0 */
export function cardsVersion(): number {
  return cardsGen;
}

export function onCardsUpdated(cb: () => void): () => void {
  cardListeners.add(cb);
  return () => { cardListeners.delete(cb); };
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

/**
 * 定制卡(src/cards/user/)的源码原文:文件名 → 源码,以及卡片 id → 文件名。
 * 存 .proc 时要把项目用到的定制卡一起打包(editor/io/procCards.ts)。
 *
 * 由 cards/index.ts 每次(含 HMR 重跑)灌进来,而不是让 procCards 直接 import cards/user ——
 * 那会多出一条 cards/user → procCards → proc → drafts → headless 的依赖链,链上没有能接住
 * 热更新的模块,于是 Agent 每建 / 改一张卡,编辑器就整页刷新一次。
 */
let userSources: { files: Record<string, string>; fileOf: Record<string, string>; dependencies: Record<string, string> } = { files: {}, fileOf: {}, dependencies: {} };

export function setUserCardSources(files: Record<string, string>, fileOf: Record<string, string>, dependencies: Record<string, string> = {}) {
  userSources = { files, fileOf, dependencies };
}

export function userCardSources(): { files: Record<string, string>; fileOf: Record<string, string>; dependencies: Record<string, string> } {
  return userSources;
}
