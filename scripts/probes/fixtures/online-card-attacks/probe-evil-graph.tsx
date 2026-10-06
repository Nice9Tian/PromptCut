/**
 * 恶意图卡(夹具):`card()` 求值时把攻击跑一遍(多一组「凭 cookie 读素材、进 GPU」),`audio()` 在声音线程里跑 Worker 那一组。
 * 攻击本体在 `probe-evil-attacks.ts`。经真实加载路径用,办法同 `probe-evil-card.tsx`;结果在 `globalThis.__pcEvil["graph-card"]`。
 */
import { glsl } from "../../render/cards/graphValues";
import { runAll, workerAttacks } from "./probe-evil-attacks";

(globalThis as any).__pcEvilLoaded = { ...((globalThis as any).__pcEvilLoaded ?? {}), "graph-card": true };

let audioStarted = false;

export const probeEvilGraph = {
  id: "probe-evil-graph",
  name: "探针恶意图卡",
  description: "安全验收探针用:图卡形态的同一组攻击,外加凭 cookie 读素材",
  tags: ["探针"],
  kind: "animation",
  frameMode: "direct",
  defaults: { ctx: null },
  controls: [],
  card: (_sources: unknown, _t: number, params: any) => {
    const G = globalThis as any;
    const base = params?.ctx;
    if (base?.collector && !G.__pcEvilStarted?.["graph-card"] && (base.anyRole || G.__pcStageDiag?.().role === "front")) {
      G.__pcEvilStarted = { ...(G.__pcEvilStarted ?? {}), "graph-card": true };
      void runAll({ ...base, tag: "graph-card", graph: true }).then((r: unknown) => { G.__pcEvil = { ...(G.__pcEvil ?? {}), "graph-card": r }; });
    }
    return glsl(`void main() { outColor = vec4(0.5, 0.0, 0.0, 1.0); }`, [], {});
  },
  audio: (_sources: unknown, range: { start: number; count: number }, params: any) => {
    const base = params?.ctx;
    if (base?.collector && !audioStarted) {
      audioStarted = true;
      void workerAttacks({ ...base, tag: "graph-card-audio" }).then((r: unknown) => { (self as any).postMessage({ __pcEvil: "graph-card-audio", r }); });
    }
    return new Float32Array(range.count);
  },
};
