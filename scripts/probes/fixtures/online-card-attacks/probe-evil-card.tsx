/**
 * 恶意用户卡(夹具):画面组件一挂上就把攻击跑一遍,`audio()` 在声音线程里再跑 Worker 那一组。攻击本体在 `probe-evil-attacks.ts`。
 * 合流后经真实加载路径用:`content.put` 到 `src/cards/user/probe-evil-card.tsx`(攻击本体放 `src/cards/user/probe-evil-attacks.ts`),
 * 结果从舞台的 `globalThis.__pcEvil["user-card"]` 与声音线程回来的对象里读。探针经 `globalThis.__pcEvilCtx` 把收集站地址等参数交进来。
 * 模块顶层往 `globalThis` 写一个记号:编辑器页、导出页、同源单舞台、低内存档里都不该出现它(契约第 10 节「编辑器页不执行」)。
 */
import { useEffect } from "react";
import { runAll, workerAttacks } from "./probe-evil-attacks";

(globalThis as any).__pcEvilLoaded = { ...((globalThis as any).__pcEvilLoaded ?? {}), "user-card": true };

function EvilCard() {
  useEffect(() => {
    const g = globalThis as any;
    const ctx = { ...(g.__pcEvilCtx ?? {}), tag: "user-card", graph: false };
    void runAll(ctx).then((r: unknown) => { g.__pcEvil = { ...(g.__pcEvil ?? {}), "user-card": r }; });
  }, []);
  return <div className="absolute inset-0 flex items-center justify-center text-[80px]">probe-evil-card</div>;
}

export const probeEvilCard = {
  id: "probe-evil-card",
  name: "探针恶意用户卡",
  description: "安全验收探针用:尝试读凭证、票据、本机存储、父页对象,并向外部地址发请求",
  tags: ["探针"],
  frameMode: "stateful",
  defaults: {},
  controls: [],
  Component: EvilCard,
  // 声音线程里没有 DOM:只跑 Worker 那一组;结果随采样块之外的诊断口交回(合流时按声音宿主的实际接口接)
  audio: (a: any) => {
    const g = globalThis as any;
    void workerAttacks({ ...(g.__pcEvilCtx ?? {}), tag: "user-card-audio" }).then((r: unknown) => { g.__pcEvil = { ...(g.__pcEvil ?? {}), "user-card-audio": r }; });
    return a?.silence?.() ?? null;
  },
};
