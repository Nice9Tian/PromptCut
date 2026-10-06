/**
 * 恶意图卡(夹具):`card()` 求值时把攻击跑一遍(多一组「凭 cookie 读素材、进 GPU」),`audio()` 在声音线程里跑 Worker 那一组。
 * 攻击本体在 `probe-evil-attacks.ts`。合流后经真实加载路径用,办法同 `probe-evil-card.tsx`;结果在 `globalThis.__pcEvil["graph-card"]`。
 * `card()` / `audio()` 的签名按合流时图卡的实际接口调整(这里只要求「被调用时跑攻击」)。
 */
import { runAll, workerAttacks } from "./probe-evil-attacks";

(globalThis as any).__pcEvilLoaded = { ...((globalThis as any).__pcEvilLoaded ?? {}), "graph-card": true };

let started = false;

export const probeEvilGraph = {
  id: "probe-evil-graph",
  name: "探针恶意图卡",
  description: "安全验收探针用:图卡形态的同一组攻击,外加凭 cookie 读素材",
  tags: ["探针"],
  defaults: {},
  controls: [],
  card: (g: any) => {
    const G = globalThis as any;
    if (!started) {
      started = true;
      void runAll({ ...(G.__pcEvilCtx ?? {}), tag: "graph-card", graph: true }).then((r: unknown) => { G.__pcEvil = { ...(G.__pcEvil ?? {}), "graph-card": r }; });
    }
    return g?.solid?.([0.5, 0, 0, 1]) ?? null;
  },
  audio: (a: any) => {
    const G = globalThis as any;
    void workerAttacks({ ...(G.__pcEvilCtx ?? {}), tag: "graph-card-audio" }).then((r: unknown) => { G.__pcEvil = { ...(G.__pcEvil ?? {}), "graph-card-audio": r }; });
    return a?.silence?.() ?? null;
  },
};
