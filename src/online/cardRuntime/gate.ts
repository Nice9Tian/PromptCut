/**
 * 本页能不能执行同步来的用户卡与图卡(`docs/plan/online-card-exec-contract.md` 3.1 的前提)。
 *
 * 缺一条就不执行,整体退回原做法:
 *   - `site`:站点的总开关没关(运行配置 `runtime-config.json` 的 `onlineCardExec`,缺省开);
 *   - `isolated`:本页是双舞台且握手成功、舞台源与编辑页面不同源、舞台自检确认内容安全策略生效、素材票据交接成功。
 * 这两项由安全隔离那一块(舞台握手与自检)写进来;在它写之前本页**不执行**(缺省 `isolated: false`)——
 * 没有 nginx 的摆法(本机开发服务器、桌面版自己提供的页面)自检不过,就一直停在这个缺省上。
 * 低内存档由调用方另判(它没有跨源舞台,`isolated` 本来就是假)。
 *
 * 转译(`onlineCardSources.ts`)只在这里说「能」的时候才做,所以不能执行的页面不会去载入转译器那一块。
 */
export interface CardExecGate {
  /** 站点总开关;null = 还没读到运行配置(按开算,但 `isolated` 没立之前照样不执行) */
  site: boolean | null;
  /** 隔离环境就绪 */
  isolated: boolean;
  /** `isolated` 为假时的原因(诊断) */
  reason: string | null;
  /**
   * 画面那一半能不能执行(〔裁:主会话 2026-10-06〕契约 3.4):隔离就绪之外,还要两台舞台的出口都由浏览器拦
   * (自检的 `egress: "allowlist"`,响应头 `Connection-Allowlist`)。只靠脚本加固拦 WebRTC 的浏览器(`egress: "script"`)上为假:
   * 画面不执行、退回原做法;声音线程照常(后台线程里没有 WebRTC)。缺省真(由 `isolated` 把关),隔离那一块写进来。
   */
  visual: boolean;
}

let gate: CardExecGate = { site: null, isolated: false, reason: "还没有隔离环境的结论", visual: true };
const listeners = new Set<() => void>();

export function cardExecGate(): Readonly<CardExecGate> {
  return gate;
}

/** 本页此刻能不能执行同步来的卡 */
export function cardExecAvailable(): boolean {
  return gate.site !== false && gate.isolated;
}

/** 本页此刻能不能执行同步来的卡的**画面**(声音线程只看 `cardExecAvailable`) */
export function cardVisualExecAvailable(): boolean {
  return cardExecAvailable() && gate.visual;
}

/** 画面因为出口拦不住而不执行时,参数面板上的那一句(状态仍是 `not-isolated`) */
export const CARD_EXEC_EGRESS_DETAIL = "这个浏览器拦不住卡片代码经 WebRTC 向外发数据";

/** 不能执行时,卡片该报哪一句(参数面板):站点关了与没有隔离环境是两句话,状态都是 `not-isolated` */
export function cardExecBlockedDetail(): string | null {
  if (gate.site === false) return "这个站点没有开启在线运行用户卡与图卡";
  if (!gate.isolated) return null;
  if (!gate.visual) return CARD_EXEC_EGRESS_DETAIL;
  return null;
}

export function setCardExecGate(patch: Partial<CardExecGate>): void {
  const next = { ...gate, ...patch };
  if (next.isolated) next.reason = null;
  if (next.site === gate.site && next.isolated === gate.isolated && next.reason === gate.reason && next.visual === gate.visual) return;
  gate = next;
  for (const l of [...listeners]) { try { l(); } catch { /* 订阅方坏了 */ } }
}

export function subscribeCardExecGate(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 运行配置(`runtime-config.json` 解析后的对象或文本)里的总开关:只有明写 `false` 才是关 */
export function siteCardExecOf(config: unknown): boolean {
  let c: unknown = config;
  if (typeof c === "string") { try { c = JSON.parse(c); } catch { return true; } }
  return !(c && typeof c === "object" && (c as { onlineCardExec?: unknown }).onlineCardExec === false);
}

/** 单测用 */
export function resetCardExecGateForTest(): void {
  gate = { site: null, isolated: false, reason: "还没有隔离环境的结论", visual: true };
  listeners.clear();
}
