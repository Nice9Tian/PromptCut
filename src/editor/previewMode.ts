/**
 * 预览走哪条路:**回滚开关 `?preview=legacy` 与双舞台开关 `?preview=stage`**(D5 / F2)。
 *
 * R2～R6 的新东西全藏在这个开关后面,**这几步里 legacy 是缺省** —— 不带参数、带
 * `?preview=legacy`、带任何别的值,看到的都是今天这套:**一个同源的舞台 iframe**,
 * 播放头由 `Preview` 的 rAF 循环推,父页每帧发 `setTime`。要看新路得显式写
 * `?preview=stage`。R7 才把缺省翻过来(那一步同时摘掉 `front` 的 `opacity: 0`)。
 *
 * 为什么另起一个值而不是「没有 `legacy` 就是新路」:R2 的新行为是**跨源双舞台**,
 * 它要多起两个端口、要 iframe 换源。用户手里那份编辑台随便刷新一下就会踩上去,
 * 而 R2 的验收条件是「可见行为逐项不变」。显式开关才对得上这一条。
 *
 * `StageView` 自己那个 `LEGACY`(`?preview=legacy` 时 `setProject` 立刻按跳转重算这一帧)
 * 是**另一件事**,而且 `Preview` 从来不把 `preview` 参数传进 iframe,所以这里加的值
 * 一个字都不影响它。
 */

/** 舞台实例名。**只是实例名,和角色无关**(E1):谁当 `front` 由 `setRole` 定 */
export type StageId = "A" | "B";

export const STAGE_IDS: readonly StageId[] = ["A", "B"];

/** 起手的角色分派:A 当可见舞台,B 当后台舞台。K5 的互换之后这张表就不作数了 */
export const INITIAL_ROLE_OF: Record<StageId, "front" | "back"> = { A: "front", B: "back" };

export type PreviewMode = "legacy" | "stage";

const paramOf = (): string => (typeof location === "undefined" ? "" : new URLSearchParams(location.search).get("preview") || "");

/** 缺省是 legacy;只有显式 `?preview=stage` 才走 R2 的跨源双舞台 */
export function previewMode(): PreviewMode {
  return paramOf() === "stage" ? "stage" : "legacy";
}

/**
 * 编辑器进程真的起起来的舞台端口(`server/vite-plugin-stage-ports.ts` 注入)。
 * 端口被占、或者在没有这个插件的环境里(vite preview 的产物包),这里是空表。
 */
export function stagePorts(): number[] {
  const v = (window as unknown as { __PC_STAGE_PORTS__?: unknown }).__PC_STAGE_PORTS__;
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
}

/**
 * 每个舞台实例该从哪个源加载。**按当前页面的 hostname 拼**(不是写死 127.0.0.1):
 * 用户从 `localhost` 打开时两个 iframe 也得是 `localhost` —— 同 host 不同端口 + OAC 头
 * 才是实测过的那条路(`docs/g0-a-webview2-probe.md`),换成别的 host 就成了另一件事。
 */
export function stageOrigins(): Record<StageId, string> | null {
  const ports = stagePorts();
  if (ports.length < STAGE_IDS.length) return null;
  const out = {} as Record<StageId, string>;
  STAGE_IDS.forEach((id, i) => { out[id] = `${location.protocol}//${location.hostname}:${ports[i]}`; });
  return out;
}

/**
 * 这一次到底开不开双舞台。两个条件都要:显式开了 `?preview=stage`,而且两个舞台端口都起来了。
 * 少一个就退回 legacy 的同源单舞台 —— 宁可少一个后台舞台,也不能让编辑台开不出画面。
 */
export function dualStage(): boolean {
  return previewMode() === "stage" && stageOrigins() !== null;
}

/** 舞台 iframe 的地址。legacy(或端口没起来)时是同源,只有 A 那一个 */
export function stageSrc(id: StageId): string {
  const origins = dualStage() ? stageOrigins() : null;
  return `${origins ? origins[id] : ""}${location.pathname}?stage=1&id=${id}`;
}

/** 给 `createStageRpc` 的 `targetOrigin`:跨源时必须点名,不能用 `location.origin` */
export function stageTargetOrigin(id: StageId): string {
  const origins = dualStage() ? stageOrigins() : null;
  return origins ? origins[id] : location.origin;
}
