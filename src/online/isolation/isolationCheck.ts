/**
 * 舞台启动自检(契约 `docs/plan/online-card-exec-contract.md` 第 3.1、3.3 节):确认隔离真的生效,不生效就不执行用户卡与图卡,
 * 并把原因报给父页(`pc-stage-isolation`)。只在跨源舞台(在线构建的 `stage.html`)里跑。
 *
 * 逐项:
 *   1. **跨源**:读 `parent.location.href` 抛错才算(同源单舞台读得到 → 不算隔离)。
 *   2. **内容安全策略生效,而且出自响应头**:向一个固定的、不存在的外部地址发一次 `fetch`,等 `securitypolicyviolation`;
 *      事件里的 `originalPolicy` 带 `frame-ancestors` 才算响应头那一份(`<meta>` 兜底那一份没有这条指令)。
 *      只有 `<meta>` 生效 = 托管端的 nginx 没更新(或页面放在没有 nginx 的本机),不算隔离:那时也没有 `/media-s/` 路由。
 *   3. **出口**:浏览器认 `Connection-Allowlist` 时,同源的重定向被它拦下(缺省不许重定向)—— 取 `_iso/ok` 成功而取
 *      `_iso/redirect` 失败,就是它在生效(`egress: "allowlist"`,WebRTC 由浏览器拦下)。否则看脚本加固:Trusted Types 在强制、
 *      构造器已去掉,记 `egress: "script"`(WebRTC 靠脚本加固,不是浏览器保证);两样都没有,不算隔离。
 *   4. **加固装上了**(`harden.ts`)。
 *
 * 结论 `ok` 为真才允许执行(还要父页点头、票据交接成功,见 `execGate.ts`)。
 */
import { STAGE_CSP_HEADER_ONLY_DIRECTIVE } from "../stagePolicy.mjs";
import type { HardenReport } from "./harden.ts";

/** 自检用的外部地址:`.invalid` 是保留的顶级域,永远解析不出来;策略在解析之前就拦下 */
export const ISOLATION_CHECK_EXTERNAL_URL = "https://pc-isolation-check.invalid/";
/** 舞台源上给自检用的两个地址(相对在线构建的 base):前者回 204,后者重定向到前者 */
export const ISOLATION_OK_PATH = "_iso/ok";
export const ISOLATION_REDIRECT_PATH = "_iso/redirect";
/** 每一项等多久 */
export const ISOLATION_CHECK_TIMEOUT_MS = 2500;

export type IsolationFailure =
  | "same-origin"        // 舞台与父页同源
  | "no-policy"          // 内容安全策略没生效
  | "meta-only"          // 只有 <meta> 兜底生效,响应头没到
  | "no-egress-guard"    // 浏览器不认出口白名单,脚本加固也没装全
  | "not-hardened"       // 加固没装上
  | "check-error";       // 自检自己出错

export interface IsolationReport {
  ok: boolean;
  crossOrigin: boolean;
  /** 策略出自哪里 */
  csp: "header" | "meta" | "none";
  /** WebRTC 等策略管不到的出口由谁拦:`allowlist` = 浏览器(`Connection-Allowlist`);`script` = 脚本加固;`none` = 没人拦 */
  egress: "allowlist" | "script" | "none";
  hardened: boolean;
  trustedTypes: HardenReport["trustedTypes"];
  reasons: IsolationFailure[];
}

export interface IsolationCheckDeps {
  win?: Window & typeof globalThis;
  /** 在线构建的 base(`/editor/`) */
  base: string;
  harden: HardenReport | null;
  timeoutMs?: number;
}

/** 由各项事实下结论。纯函数,单测逐条核 */
export function judgeIsolation(f: { crossOrigin: boolean; csp: IsolationReport["csp"]; allowlist: boolean; harden: HardenReport | null }): IsolationReport {
  const reasons: IsolationFailure[] = [];
  const hardened = !!f.harden?.installed && f.harden.webrtcRemoved;
  const trustedTypes = f.harden?.trustedTypes ?? "unsupported";
  const scriptGuard = hardened && trustedTypes === "enforced";
  const egress: IsolationReport["egress"] = f.allowlist ? "allowlist" : scriptGuard ? "script" : "none";
  if (!f.crossOrigin) reasons.push("same-origin");
  if (f.csp === "none") reasons.push("no-policy");
  else if (f.csp === "meta") reasons.push("meta-only");
  if (!hardened) reasons.push("not-hardened");
  if (egress === "none") reasons.push("no-egress-guard");
  return { ok: reasons.length === 0, crossOrigin: f.crossOrigin, csp: f.csp, egress, hardened, trustedTypes, reasons };
}

function isCrossOrigin(w: Window): boolean {
  try {
    if (w.parent === w) return false; // 不在 iframe 里
    void w.parent.location.href;
    return false;
  } catch {
    return true;
  }
}

/** 策略在不在强制、出自哪里 */
function checkPolicy(w: Window & typeof globalThis, timeoutMs: number): Promise<IsolationReport["csp"]> {
  return new Promise((resolve) => {
    let best: IsolationReport["csp"] = "none";
    let settle: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      w.document.removeEventListener("securitypolicyviolation", onViolation);
      clearTimeout(deadline);
      if (settle) clearTimeout(settle);
      resolve(best);
    };
    const onViolation = (e: SecurityPolicyViolationEvent) => {
      if (e.disposition !== "enforce" || !String(e.blockedURI).startsWith(ISOLATION_CHECK_EXTERNAL_URL.replace(/\/$/, ""))) return;
      if (String(e.originalPolicy).includes(STAGE_CSP_HEADER_ONLY_DIRECTIVE)) { best = "header"; finish(); return; }
      if (best === "none") best = "meta";
      // 响应头与 <meta> 两份各报一次,先后不定:再等一小会儿看响应头那一份来不来
      settle ??= setTimeout(finish, 150);
    };
    const deadline = setTimeout(finish, timeoutMs);
    w.document.addEventListener("securitypolicyviolation", onViolation);
    w.fetch(ISOLATION_CHECK_EXTERNAL_URL, { mode: "no-cors", cache: "no-store" }).then(
      // 请求居然发出去了(并且有应答):策略没在管
      () => { best = "none"; finish(); },
      () => { /* 被拦或解析不出来:看有没有违规事件 */ },
    );
  });
}

/** 浏览器在不在执行出口白名单:同源的 204 取得到、同源的重定向被拦下 */
async function checkAllowlist(w: Window & typeof globalThis, base: string, timeoutMs: number): Promise<boolean> {
  const root = base.replace(/\/?$/, "/");
  const get = async (path: string): Promise<"ok" | "blocked" | "other"> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await w.fetch(`${root}${path}`, { cache: "no-store", signal: ctrl.signal });
      return r.status === 204 ? "ok" : "other";
    } catch {
      return ctrl.signal.aborted ? "other" : "blocked";
    } finally {
      clearTimeout(timer);
    }
  };
  if ((await get(ISOLATION_OK_PATH)) !== "ok") return false; // 托管端没有这两个地址(旧 nginx):判不了,按没有算
  return (await get(ISOLATION_REDIRECT_PATH)) === "blocked";
}

/** 跑一遍自检。不抛:出错回 `ok: false`、原因 `check-error` */
export async function runIsolationCheck(deps: IsolationCheckDeps): Promise<IsolationReport> {
  const w = deps.win ?? window;
  const timeoutMs = deps.timeoutMs ?? ISOLATION_CHECK_TIMEOUT_MS;
  try {
    const crossOrigin = isCrossOrigin(w);
    const [csp, allowlist] = await Promise.all([checkPolicy(w, timeoutMs), checkAllowlist(w, deps.base, timeoutMs)]);
    return judgeIsolation({ crossOrigin, csp, allowlist, harden: deps.harden });
  } catch {
    return { ok: false, crossOrigin: false, csp: "none", egress: "none", hardened: false, trustedTypes: deps.harden?.trustedTypes ?? "unsupported", reasons: ["check-error"] };
  }
}
