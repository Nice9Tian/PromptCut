/**
 * 预览走哪条路:**回滚开关 `?preview=legacy` 与双舞台开关 `?preview=stage`**(D5 / F2)。
 *
 * **R7 已经把缺省翻过来了**:不带参数、带 `?preview=stage`、带任何别的值,走的都是
 * 跨源双舞台 —— 舞台 iframe 直接露出来,播放头由可见舞台按帧节拍推(K4),
 * 主文档只留音频。要回到老路得显式写 `?preview=legacy`:一个同源舞台 iframe、
 * 整帧 `<img>` 预览、播放头由 `Preview` 的 rAF 循环推。
 *
 * R2～R6 期间缺省是 legacy,新东西全藏在 `?preview=stage` 后面 —— 那几步的验收条件是
 * 「可见行为逐项不变」,而新行为要多起两个端口、要 iframe 换源,用户手里那份编辑台
 * 随便刷新一下就会踩上去。R7 是第一步**故意**改用户可见行为的,所以这一步才翻。
 * **为什么必须和 D5 的其余几条一起原子地翻**见 `restructure_planning/r2-r7-task.md` 的 D5 末尾。
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

/**
 * **缺省是 stage(R7 的原子切换)**;只有显式 `?preview=legacy` 才退回单舞台 + 整帧那条路。
 *
 * `?preview=stage` 仍然认 —— 它现在和不带参数一个意思,留着是因为 R2～R6 的探针、
 * 文档和用户手里的书签都写着它。别的值(打错的、老链接)一律按缺省走 stage。
 */
export function previewMode(): PreviewMode {
  return paramOf() === "legacy" ? "legacy" : "stage";
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
 * 才是实测过的那条路(`restructure_planning/g0-a-webview2-probe.md`),换成别的 host 就成了另一件事。
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

/**
 * 舞台 iframe 的地址。legacy(或端口没起来)时是同源,只有 A 那一个。
 *
 * **开了双舞台才带 `&preview=stage`**(R3):舞台页靠它决定渲 `FrameScene` 的 live 变体
 * (素材层进舞台、六个平面 prop 生效)还是照旧只渲 `Stage`。不带 = 今天用户手里那份编辑台,
 * 舞台内容一个字不变 —— 这就是「新行为只在非 legacy 下生效」的落点。
 */
export function stageSrc(id: StageId): string {
  const dual = dualStage();
  const origins = dual ? stageOrigins() : null;
  return `${origins ? origins[id] : ""}${location.pathname}?stage=1&id=${id}${dual ? "&preview=stage" : ""}`;
}

/** 给 `createStageRpc` 的 `targetOrigin`:跨源时必须点名,不能用 `location.origin` */
export function stageTargetOrigin(id: StageId): string {
  const origins = dualStage() ? stageOrigins() : null;
  return origins ? origins[id] : location.origin;
}
