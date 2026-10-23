import { AccountFailure, type CloudAccountClient } from "../../account/client.ts";

/** This is a RAM view of the account server's consent, never its authority. */
export interface CloudConsentState { accountId: string | null; bindingVersion: number; accepted: boolean | null; pending: boolean; error: string | null }
export interface CloudConsentBinding { accountId: string; bindingVersion: number }
type Source = { client: CloudAccountClient; accountId: string };
let source: Source | null = null;
let offAuth: (() => void) | null = null;
let generation = 0;
let requestSeq = 0;
let state: CloudConsentState = { accountId: null, bindingVersion: 0, accepted: null, pending: false, error: null };
const listeners = new Set<() => void>();
function publish(next: CloudConsentState) { state = next; for (const listener of [...listeners]) listener(); }
export function subscribeCloudConsent(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function cloudConsentState() { return state; }

export function setCloudConsentSource(next: Source | null) {
  offAuth?.(); offAuth = null;
  source = next;
  generation++;
  requestSeq++;
  publish({ accountId: next?.accountId ?? null, bindingVersion: generation, accepted: null, pending: false, error: null });
  if (next) {
    const bound = next;
    offAuth = next.client.subscribeAuth(() => {
      if (source !== bound) return;
      generation++;
      requestSeq++;
      publish({ accountId: bound.client.principal?.id === bound.accountId ? bound.accountId : null,
        bindingVersion: generation, accepted: null, pending: false, error: null });
    });
  }
}

function boundSource() {
  const bound = source;
  if (!bound || bound.client.principal?.id !== bound.accountId) throw new AccountFailure(401, "login-required");
  return { bound, generation };
}
function stillBound(bound: Source, revision: number) {
  if (source !== bound || generation !== revision || bound.client.principal?.id !== bound.accountId) throw new AccountFailure(401, "credential-revoked");
}
function assertBinding(expected?: CloudConsentBinding) {
  if (expected && (state.accountId !== expected.accountId || state.bindingVersion !== expected.bindingVersion))
    throw new AccountFailure(401, "credential-revoked");
}
export class CloudConsentRequiredError extends Error { constructor() { super("使用云端 Agent 前，请先阅读并确认告知。"); } }

export async function refreshCloudConsent(expected?: CloudConsentBinding): Promise<boolean> {
  assertBinding(expected);
  const { bound, generation: revision } = boundSource();
  const request = ++requestSeq;
  publish({ accountId: bound.accountId, bindingVersion: revision, accepted: state.accepted, pending: true, error: null });
  try {
    const result = await bound.client.cloudAgentConsent();
    stillBound(bound, revision);
    assertBinding(expected);
    // A superseded read cannot authorize a send, even if an older display value is true.
    if (request !== requestSeq) return false;
    publish({ accountId: bound.accountId, bindingVersion: revision, accepted: result.accepted, pending: false, error: null });
    return result.accepted;
  } catch (error) {
    if (source === bound && generation === revision && request === requestSeq) publish({ accountId: bound.accountId, bindingVersion: revision, accepted: null, pending: false,
      error: error instanceof Error ? error.message : "云端账号暂时不可用。" });
    throw error;
  }
}
export async function acceptCloudConsent(): Promise<void> {
  const { bound, generation: revision } = boundSource();
  requestSeq++;
  publish({ accountId: bound.accountId, bindingVersion: revision, accepted: null, pending: true, error: null });
  try {
    const result = await bound.client.acceptCloudAgentConsent();
    stillBound(bound, revision);
    if (!result.accepted) throw new AccountFailure(503, "account-protocol");
    requestSeq++;
    publish({ accountId: bound.accountId, bindingVersion: revision, accepted: true, pending: false, error: null });
  } catch (error) {
    if (source === bound && generation === revision) { requestSeq++; publish({ accountId: bound.accountId, bindingVersion: revision, accepted: null, pending: false,
      error: error instanceof Error ? error.message : "云端账号暂时不可用。" });
    }
    throw error;
  }
}

/**
 * 一次发送只核一次告知：发送流程开头那次向账号服务的新读取，读到「已同意」时发一张一次性的许可，
 * 交给同一次发送的最后一步（真正 POST 之前）当场同步核对，不再读第二次。许可只是「刚刚那次新读取」的凭据，
 * 不是缓存：账号、绑定版本、登录状态、告知状态任何一样变了，或者期间有别的告知读取/确认插进来，
 * 或者过了 CLOUD_CONSENT_PERMIT_TTL_MS，许可就作废，最后一步退回一次新的服务端读取。
 */
export interface CloudConsentPermit { readonly binding: CloudConsentBinding }
interface PermitRecord { bound: Source; generation: number; request: number; issuedAt: number; used: boolean }
const permits = new WeakMap<CloudConsentPermit, PermitRecord>();
/** 许可的有效期。发送前要先把附件放进素材库时可能超过它，那时最后一步照旧再读一次。 */
export const CLOUD_CONSENT_PERMIT_TTL_MS = 5_000;
// 单调钟：系统时间往回拨不会把有效期拉长
const monotonic = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());
let clock: () => number = monotonic;
/** 只给单测用：换掉许可有效期用的时钟。 */
export function setCloudConsentClockForTest(next: (() => number) | null) { clock = next ?? monotonic; }

/**
 * 向账号服务新读一次告知，出错照旧抛出。`accepted` 是「服务端说同意了没有」，决定要不要弹告知框；
 * `permit` 是「这次能不能省掉发出前那次读取」：同意了但此刻发不出许可（别处有读取在路上、绑定刚变、
 * 被更新的读取取代等）时 `permit` 为 null，调用方照常往下发，发出前那一步自己再真读一次。
 */
export async function grantCloudConsent(expected: CloudConsentBinding): Promise<{ accepted: boolean; permit: CloudConsentPermit | null }> {
  const fresh = await refreshCloudConsent(expected);
  assertBinding(expected);
  // 被更新的读取取代时 fresh 是 false，但不等于没同意：看此刻的状态（与面板挂载时那次读取的判断一致）
  const accepted = fresh || (state.accepted === true && state.accountId === expected.accountId);
  if (!fresh || state.accepted !== true || state.pending) return { accepted, permit: null };
  const bound = source;
  if (!bound || bound.client.principal?.id !== bound.accountId || bound.accountId !== expected.accountId || generation !== expected.bindingVersion)
    return { accepted, permit: null };
  const permit: CloudConsentPermit = Object.freeze({ binding: Object.freeze({ ...expected }) });
  permits.set(permit, { bound, generation, request: requestSeq, issuedAt: clock(), used: false });
  return { accepted, permit };
}

/** 发送被拒在「没同意告知」上（页面自己的读取，或服务端收消息时回 consent-required）：叫面板弹告知框。 */
/** `origin`：发这条消息的那个分页，只让它弹框。绑定已经变了的旧报告丢掉。 */
type RequiredListener = (binding: CloudConsentBinding, origin: string) => void;
const requiredListeners = new Set<RequiredListener>();
export function onCloudConsentRequired(listener: RequiredListener) { requiredListeners.add(listener); return () => { requiredListeners.delete(listener); }; }
export function reportCloudConsentRequired(binding: CloudConsentBinding, origin: string) {
  if (state.accountId !== binding.accountId || state.bindingVersion !== binding.bindingVersion) return;
  for (const listener of [...requiredListeners]) listener(binding, origin);
}

/** 同步核许可并作废它；任何一项对不上都回 false，调用方要退回新读取。 */
function spendPermit(expected: CloudConsentBinding, permit: CloudConsentPermit): boolean {
  const record = permits.get(permit);
  if (!record || record.used) return false;
  record.used = true;
  const age = clock() - record.issuedAt;
  return permit.binding.accountId === expected.accountId && permit.binding.bindingVersion === expected.bindingVersion &&
    source === record.bound && generation === record.generation && generation === expected.bindingVersion &&
    record.bound.accountId === expected.accountId && record.bound.client.principal?.id === expected.accountId &&
    requestSeq === record.request &&
    state.accountId === expected.accountId && state.bindingVersion === expected.bindingVersion && state.accepted === true && !state.pending &&
    age >= 0 && age <= CLOUD_CONSENT_PERMIT_TTL_MS;
}

/**
 * A fresh server read is required at every data operation; a prior UI result is only display state.
 * 例外只有一个：同一次发送开头已经新读过、拿到许可，且许可当场核对仍有效，这一次就不再读。
 * 登录失效、换号、换绑定时即便许可作废，也先按原来的规则拒绝（login-required / credential-revoked）。
 */
export async function requireCloudConsent(expected?: CloudConsentBinding, permit?: CloudConsentPermit | null): Promise<void> {
  if (permit && expected) {
    assertBinding(expected);
    boundSource();
    if (spendPermit(expected, permit)) return;
  }
  if (!await refreshCloudConsent(expected)) throw new CloudConsentRequiredError();
  assertBinding(expected);
  if (state.accepted !== true || state.pending) throw new CloudConsentRequiredError();
}
