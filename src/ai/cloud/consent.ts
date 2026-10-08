import { AccountFailure, type CloudAccountClient } from "../../account/client.ts";

/** This is a RAM view of the account server's consent, never its authority. */
export interface CloudConsentState { accountId: string | null; bindingVersion: number; accepted: boolean | null; pending: boolean; error: string | null }
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
      publish({ accountId: bound.accountId, bindingVersion: generation, accepted: null, pending: false, error: null });
    });
  }
}

function boundSource() {
  const bound = source;
  if (!bound || bound.client.account?.id !== bound.accountId) throw new AccountFailure(401, "login-required");
  return { bound, generation };
}
function stillBound(bound: Source, revision: number) {
  if (source !== bound || generation !== revision || bound.client.account?.id !== bound.accountId) throw new AccountFailure(401, "credential-revoked");
}
export class CloudConsentRequiredError extends Error { constructor() { super("使用云端 Agent 前，请先阅读并确认告知。"); } }

export async function refreshCloudConsent(): Promise<boolean> {
  const { bound, generation: revision } = boundSource();
  const request = ++requestSeq;
  publish({ accountId: bound.accountId, bindingVersion: revision, accepted: state.accepted, pending: true, error: null });
  try {
    const result = await bound.client.cloudAgentConsent();
    stillBound(bound, revision);
    if (request !== requestSeq) return state.accepted === true;
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

/** A fresh server read is required at every data operation; a prior UI result is only display state. */
export async function requireCloudConsent(): Promise<void> {
  if (!await refreshCloudConsent()) throw new CloudConsentRequiredError();
}
