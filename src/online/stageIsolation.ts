/**
 * 编辑器页这一侧的**舞台隔离会话**(契约 `docs/plan/online-card-exec-contract.md` 第 3.1、3.2、4.1 节)。
 *
 * 管三件事:
 *   1. 收两个跨源舞台的自检结果(`pc-stage-isolation`),按形状校验;
 *   2. 每个舞台取素材走哪条路:自检通过、票据交接成功 → **cookie**(舞台用 `/media-s/<sid>/media/<哈希>`,票据不进舞台的脚本);
 *      否则 → **旧办法**(票据经 RPC 下发、拼在地址的 `?t=` 里;这样的舞台文档不执行用户卡);
 *   3. 本页此刻能不能执行用户卡与图卡(`onlineCardExec()`):总开关开着、是双舞台、两个舞台都走 cookie、没出过加固拦下的事。
 *
 * 两条单向的规矩(「要执行就不放秘密」):
 *   - 本页会话里只要点过一次头(`cardExec: true` 发给过舞台),此后**任何舞台都不再收到票据**:哪一台后来自检不过或交接失败,
 *     它拿到的是不带票据的 cookie 基址(取不到素材就取不到),不退回旧办法;
 *   - 出过加固拦下的事(`breach`),本页会话不再点头。
 *
 * 总开关(托管方可关):运行配置 `editor/runtime-config.json` 里 `"onlineCardExec": false` 就整体退回原来的做法
 * (不执行、票据照旧走 `?t=`);缺省开。读不到运行配置时没有舞台源,本来就是同源单舞台、不执行。
 *
 * 本模块属于 render 这一层(`src/online/`):不引 editor;交接请求、时钟都可注入(单测用)。
 */
import { isSid, mediaGrantUrl, mediaSBase } from "./stagePolicy.mjs";
import type { StageLetter } from "./stageOrigins.ts";
import type { IsolationFailure, IsolationReport } from "./isolation/isolationCheck.ts";
import type { BreachKind } from "./isolation/harden.ts";

/** 跨源舞台 iframe 的 `sandbox`(契约第 3.3 节):只开脚本与保有自己的源;不给弹窗、带走顶层、表单、模态框、下载 */
export const STAGE_SANDBOX = "allow-scripts allow-same-origin";
/** 握手之后等这一台的自检结果多久;过了按没隔离算(这一台走旧办法) */
export const ISOLATION_REPORT_WAIT_MS = 4000;
/** 交接请求的时限 */
export const MEDIA_GRANT_TIMEOUT_MS = 8000;

export type StageMediaMode = "cookie" | "legacy";

/** 本页不执行用户卡、图卡的原因(给参数面板的说明与诊断;`ok` = 能执行) */
export type CardExecReason =
  | "ok"
  | "switch-off"     // 托管方关了总开关
  | "single-stage"   // 不是双舞台(同源单舞台、低内存档、握手失败)
  | "pending"        // 还在等舞台自检或票据交接
  | "not-isolated"   // 某一台舞台自检没过
  | "grant-failed"   // 票据交接没成
  | "breach";        // 加固拦下过试图造子框架的代码

export interface CardExecState {
  enabled: boolean;
  reason: CardExecReason;
  /** 各舞台自检没过的原因(诊断) */
  detail: Partial<Record<StageLetter, IsolationFailure[]>>;
  /** 兼容诊断字段：当前策略执行时为 `none`，不执行时为 null */
  egress: "none" | null;
}

const FAILURES: readonly IsolationFailure[] = ["same-origin", "no-policy", "meta-only", "not-hardened", "check-error"];
const BREACHES: readonly BreachKind[] = ["html", "create", "insert", "observed", "define"];

/** 舞台发来的自检结果按形状校验(舞台的消息一律当不可信输入);不对给 null */
export function sanitizeIsolationReport(d: unknown): IsolationReport | null {
  if (!d || typeof d !== "object") return null;
  const r = d as Record<string, unknown>;
  const csp = r.csp === "header" || r.csp === "meta" || r.csp === "none" ? r.csp : null;
  const egress = r.egress === "allowlist" || r.egress === "script" || r.egress === "none" ? r.egress : null;
  const tt = r.trustedTypes === "enforced" || r.trustedTypes === "created" || r.trustedTypes === "unsupported" || r.trustedTypes === "failed" ? r.trustedTypes : null;
  if (!csp || !egress || !tt || typeof r.ok !== "boolean" || typeof r.crossOrigin !== "boolean" || typeof r.hardened !== "boolean" || !Array.isArray(r.reasons)) return null;
  const reasons = r.reasons.filter((x): x is IsolationFailure => FAILURES.includes(x as IsolationFailure)).slice(0, FAILURES.length);
  // 不信舞台自己下的结论:按各项事实重算一遍(少一项就不算通过)
  const ok = r.ok === true && reasons.length === 0 && r.crossOrigin === true && csp === "header" && r.hardened === true;
  return { ok, crossOrigin: r.crossOrigin, csp, egress, hardened: r.hardened, trustedTypes: tt, reasons };
}

export function sanitizeBreach(d: unknown): BreachKind | null {
  return BREACHES.includes(d as BreachKind) ? (d as BreachKind) : null;
}

/** 每个页面会话一个随机的会话号(不是秘密:只把 cookie 圈在一段路径上) */
export function newSid(random: (bytes: Uint8Array) => void = (b) => { crypto.getRandomValues(b); }): string {
  const bytes = new Uint8Array(16);
  random(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** 交给舞台的取档策略里与隔离有关的那一半 */
export interface StageMediaPlan {
  mode: StageMediaMode;
  /** 舞台取素材的基址:cookie 走 `/media-s/<sid>`;旧办法是调用方原来的基址(这里给 null,调用方自己填) */
  base: string | null;
  /** 旧办法才带票据;cookie 恒为 null */
  ticket: string | null;
  /** 这一台能不能执行用户卡(舞台自己还要核自检与「没见过票据」) */
  cardExec: boolean;
}

export interface StageIsolationDeps {
  /** 总开关(运行配置) */
  enabled(): boolean;
  /** 向舞台源交接票据;成了回 true。缺省用 `fetch`(带凭据的跨源 POST) */
  grant?(stageOrigin: string, sid: string, ticket: string): Promise<boolean>;
  sid?: string;
  reportWaitMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

interface Slot {
  /** 这一台(当前文档)的自检结果;握手时清掉 */
  report: IsolationReport | null;
  /** 握手之后在等结果的人 */
  waiters: Array<(r: IsolationReport | null) => void>;
  mode: StageMediaMode | null;
  /** 上一次交接成功时用的票据与舞台源(同一张不重复交接) */
  granted: { ticket: string; origin: string } | null;
  /** 正在路上的交接(同一张票据、同一个舞台源只发一次请求;取档策略短时间里会连着算几遍) */
  granting: { key: string; done: Promise<boolean> } | null;
  /** 握手的代数:结果晚到时对不上代就丢 */
  gen: number;
}

export interface StageIsolationSession {
  readonly sid: string;
  /** 这一台握手了(新文档):清掉旧的自检结果与取档方式 */
  handshake(id: StageLetter): void;
  /** 这一台发来自检结果 */
  report(id: StageLetter, report: IsolationReport | null): void;
  /** 这一台(或任何一台)报加固拦下了事 */
  breach(kind: BreachKind): void;
  /**
   * 算这一台此刻的取档方式(会等自检结果、发交接请求)。`dual` 为假(同源单舞台)直接回旧办法。
   * `ticket` 为 null(还没连上素材服务)时不交接,回旧办法的空票据。
   */
  plan(id: StageLetter, ctx: { dual: boolean; stageOrigin: string | null; ticket: string | null }): Promise<StageMediaPlan>;
  /** 布局变了(双舞台 ↔ 单舞台):重算能不能执行 */
  setDual(dual: boolean): void;
  state(): CardExecState;
  subscribe(cb: () => void): () => void;
}

/** 缺省的交接:带凭据的跨源 POST,票据放在 `Authorization` 头里;204 才算成 */
export async function grantMediaCookie(stageOrigin: string, sid: string, ticket: string, fetchImpl: typeof fetch = fetch, timeoutMs = MEDIA_GRANT_TIMEOUT_MS): Promise<boolean> {
  if (!isSid(sid)) return false;
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
  try {
    const res = await fetchImpl(mediaGrantUrl(stageOrigin, sid), {
      method: "POST", credentials: "include", cache: "no-store", headers: { Authorization: `Bearer ${ticket}` }, signal: ctrl?.signal,
    });
    return res.status === 204;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function createStageIsolation(deps: StageIsolationDeps): StageIsolationSession {
  const sid = deps.sid ?? newSid();
  const grant = deps.grant ?? ((origin, s, ticket) => grantMediaCookie(origin, s, ticket));
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const waitMs = deps.reportWaitMs ?? ISOLATION_REPORT_WAIT_MS;
  const slots: Record<StageLetter, Slot> = {
    A: { report: null, waiters: [], mode: null, granted: null, granting: null, gen: 0 },
    B: { report: null, waiters: [], mode: null, granted: null, granting: null, gen: 0 },
  };
  const IDS: StageLetter[] = ["A", "B"];
  let dual = false;
  let breached = false;
  /** 点过头没有(点过之后任何舞台都不再收到票据) */
  let everAllowed = false;
  let grantFailed = false;
  const listeners = new Set<() => void>();
  let cached: CardExecState = { enabled: false, reason: "single-stage", detail: {}, egress: null };

  const judge = (): CardExecState => {
    const detail: CardExecState["detail"] = {};
    for (const id of IDS) { const r = slots[id].report; if (r && !r.ok) detail[id] = r.reasons; }
    const off = (reason: CardExecReason): CardExecState => ({ enabled: false, reason, detail, egress: null });
    if (!deps.enabled()) return off("switch-off");
    if (!dual) return off("single-stage");
    if (breached) return off("breach");
    if (IDS.some((id) => slots[id].report && !slots[id].report!.ok)) return off("not-isolated");
    if (IDS.some((id) => slots[id].mode === "legacy")) return off(grantFailed ? "grant-failed" : "not-isolated");
    if (IDS.some((id) => slots[id].mode !== "cookie" || !slots[id].report)) return off("pending");
    const egress = "none" as const;
    return { enabled: true, reason: "ok", detail, egress };
  };
  const update = () => {
    const next = judge();
    if (next.enabled) everAllowed = true;
    if (next.enabled === cached.enabled && next.reason === cached.reason && next.egress === cached.egress && JSON.stringify(next.detail) === JSON.stringify(cached.detail)) return;
    cached = next;
    for (const l of [...listeners]) { try { l(); } catch { /* 订阅方坏了 */ } }
  };

  const waitReport = (id: StageLetter): Promise<IsolationReport | null> => {
    const slot = slots[id];
    if (slot.report) return Promise.resolve(slot.report);
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: IsolationReport | null) => { if (done) return; done = true; clearTimer(timer); resolve(r); };
      const timer = setTimer(() => {
        const i = slot.waiters.indexOf(finish);
        if (i >= 0) slot.waiters.splice(i, 1);
        finish(null);
      }, waitMs);
      slot.waiters.push(finish);
    });
  };

  return {
    sid,
    handshake(id) {
      const slot = slots[id];
      slot.gen++;
      slot.report = null;
      slot.mode = null;
      slot.granted = null;
      slot.granting = null;
      for (const w of slot.waiters.splice(0)) w(null);
      update();
    },
    report(id, report) {
      const slot = slots[id];
      slot.report = report ?? { ok: false, crossOrigin: false, csp: "none", egress: "none", hardened: false, trustedTypes: "unsupported", reasons: ["check-error"] };
      for (const w of slot.waiters.splice(0)) w(slot.report);
      update();
    },
    breach() {
      breached = true;
      update();
    },
    setDual(next) {
      if (dual === next) return;
      dual = next;
      update();
    },
    async plan(id, ctx) {
      const slot = slots[id];
      const legacy = (): StageMediaPlan => {
        // 点过头之后不再给任何舞台票据:给它不带票据的 cookie 基址,取不到就取不到
        if (everAllowed) { slot.mode = "cookie"; update(); return { mode: "cookie", base: mediaSBase(sid), ticket: null, cardExec: false }; }
        slot.mode = "legacy"; update();
        return { mode: "legacy", base: null, ticket: ctx.ticket, cardExec: false };
      };
      if (!ctx.dual || !deps.enabled() || !ctx.stageOrigin) return legacy();
      const gen = slot.gen;
      const report = await waitReport(id);
      if (gen !== slot.gen) return legacy(); // 等的时候这一台又握手了:这一次作废,新的握手会再来
      // 等不到结果(旧版舞台页不发、或舞台卡住):按自检出错记,这一台走旧办法
      if (!report) slot.report = { ok: false, crossOrigin: false, csp: "none", egress: "none", hardened: false, trustedTypes: "unsupported", reasons: ["check-error"] };
      if (!report?.ok) return legacy();
      if (!ctx.ticket) {
        // 还没有票据(素材服务没连上):不交接,也不退回旧办法 —— 这一台已经判为隔离,等有票据再来
        return { mode: "cookie", base: mediaSBase(sid), ticket: null, cardExec: false };
      }
      if (!(slot.granted && slot.granted.ticket === ctx.ticket && slot.granted.origin === ctx.stageOrigin)) {
        const key = JSON.stringify([ctx.stageOrigin, ctx.ticket]);
        if (slot.granting?.key !== key) slot.granting = { key, done: grant(ctx.stageOrigin, sid, ctx.ticket) };
        const flying = slot.granting;
        const ok = await flying.done;
        if (slot.granting === flying) slot.granting = null;
        if (gen !== slot.gen) return legacy();
        if (!ok) {
          // 续票时交接失败:已经走 cookie 的舞台留在 cookie 上(旧 cookie 还能用到过期),不退回旧办法
          if (slot.mode === "cookie") return { mode: "cookie", base: mediaSBase(sid), ticket: null, cardExec: cached.enabled };
          grantFailed = true;
          return legacy();
        }
        slot.granted = { ticket: ctx.ticket, origin: ctx.stageOrigin };
      }
      slot.mode = "cookie";
      update();
      return { mode: "cookie", base: mediaSBase(sid), ticket: null, cardExec: cached.enabled };
    },
    state: () => cached,
    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
}

/* ------------------------------------------------------------------ 本页的那一份(编辑器页模块级) */

let pageSession: StageIsolationSession | null = null;
let pageEnabled: () => boolean = () => true;
const pageListeners = new Set<() => void>();
const OFF: CardExecState = Object.freeze({ enabled: false, reason: "single-stage", detail: {}, egress: null }) as CardExecState;

/** 本页的隔离会话(懒建;`enabled` 读运行配置里的总开关) */
export function pageStageIsolation(enabled?: () => boolean): StageIsolationSession {
  if (enabled) pageEnabled = enabled;
  if (!pageSession) {
    pageSession = createStageIsolation({ enabled: () => pageEnabled() });
    pageSession.subscribe(() => { for (const l of [...pageListeners]) { try { l(); } catch { /* 订阅方坏了 */ } } });
  }
  return pageSession;
}

/**
 * 本页此刻能不能执行用户卡与图卡,不能的话为什么(块 T、L 据此决定「这张卡在本页能不能运行」与参数面板的说明)。
 * 还没建会话(桌面运行环境、还没挂舞台)回「单舞台、不执行」。
 */
export function onlineCardExec(): CardExecState {
  return pageSession ? pageSession.state() : OFF;
}

export function subscribeOnlineCardExec(cb: () => void): () => void {
  pageListeners.add(cb);
  return () => { pageListeners.delete(cb); };
}

/** 单测用 */
export function resetPageStageIsolationForTest(): void {
  pageSession = null;
  pageEnabled = () => true;
  pageListeners.clear();
}
