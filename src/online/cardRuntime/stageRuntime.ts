/**
 * 舞台这一侧的接线(`docs/plan/online-card-exec-contract.md` 第 2、8 节):加载器 + 页面自带模块的表 + 样式注入 +
 * 把载入成功的定义写进舞台自己的注册表。**只在跨源舞台里建**(由舞台按需载入;建不建由舞台的隔离自检决定)。
 *
 *   const rt = createStageCardRuntime({ onStates: (states) => 报给编辑页面 });
 *   await rt.setBundles(编辑页面经 RPC 发来的包);   // 回每个入口的结论
 *   rt.dispose();                                    // 舞台卸载、退回同源单舞台时
 *
 * 运行状态的摊法:载入成功的卡是 `ready`;失败的入口摊到「同步表里源码是这个入口」的那些卡上
 * (同步表由编辑页面经 `setSyncedUserCards` 发来,在舞台自己的注册表里)。
 */
import { setRuntimeCards, syncedUserCards, type CardRunState } from "../../kernel/registry.ts";
import { createCardLoader, runStatesOf, type CardLoaderOptions } from "./loader.ts";
import { stageHostModules } from "./hostModules.ts";
import { CARD_RUNTIME_VERSION } from "./version.ts";
import type { CardBundle, LoadResult } from "./protocol.ts";

export interface StageCardRuntime {
  setBundles(bundles: readonly CardBundle[]): Promise<LoadResult[]>;
  /** 此刻每张同步卡的运行状态(卡片 id → 状态) */
  states(): [string, CardRunState][];
  dispose(): void;
}

export interface StageCardRuntimeOptions {
  /** 运行状态变了(整份) */
  onStates?: (states: [string, CardRunState][]) => void;
  /** 开了 Trusted Types 的舞台给一个走策略的编译函数(见 `loader.ts` 的 `compile`) */
  compile?: CardLoaderOptions["compile"];
  doc?: Document;
}

const STYLE_ATTR = "data-pc-card-style";

export function createStageCardRuntime(opts: StageCardRuntimeOptions = {}): StageCardRuntime {
  const doc = opts.doc ?? document;
  const entryCards = (entry: string) => [...syncedUserCards().values()].filter((c) => c.source === entry).map((c) => c.id);
  let last: [string, CardRunState][] = [];
  const loader = createCardLoader({
    runtime: CARD_RUNTIME_VERSION,
    host: stageHostModules,
    compile: opts.compile,
    onStyle(entry, css) {
      let el: HTMLStyleElement | null = null;
      for (const s of doc.head.querySelectorAll<HTMLStyleElement>(`style[${STYLE_ATTR}]`)) if (s.getAttribute(STYLE_ATTR) === entry) { el = s; break; }
      if (!css) { el?.remove(); return; }
      if (!el) { el = doc.createElement("style"); el.setAttribute(STYLE_ATTR, entry); doc.head.appendChild(el); }
      if (el.textContent !== css) el.textContent = css;
    },
    onCards: (defs) => { setRuntimeCards(defs); },
    onResults(results) {
      last = [...runStatesOf(results, entryCards)];
      opts.onStates?.(last);
    },
  });
  return {
    setBundles: (bundles) => loader.setBundles(bundles),
    states: () => last,
    dispose() {
      loader.clear();
      setRuntimeCards([]);
    },
  };
}
