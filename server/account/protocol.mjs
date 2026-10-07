// Cloud account v2 wire contract. Account credentials never confer project membership.
export const ACCOUNT_PROTOCOL_VERSION = 2;
export const ACCOUNT_SCHEMA_VERSION = 2;
export const NOTICE_VERSION = 1;
export const LOGIN_KINDS = Object.freeze(['website', 'editor']);
export const REVOCATION_SERVICES = Object.freeze(['doc', 'asset', 'agent', 'render']);
export const INTERNAL_PATHS = Object.freeze({
  verify: '/internal/v2/credentials/verify', events: '/internal/v2/events',
  consent: '/internal/v2/consents', reserve: '/internal/v2/order/reserve',
  logoutComplete: '/internal/v2/order/logout-complete',
});
export const ACCOUNT_PRINCIPAL_FIELDS = Object.freeze([
  'identityVersion', 'realm', 'accountId', 'accountName', 'loginId',
  'loginGeneration', 'credentialId', 'kind', 'expiresAt', 'accountEventSeq',
]);
export class AccountProtocolError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}
const fail = (code) => { throw new AccountProtocolError(code); };
export function requireRequestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) fail('bad-request-id');
  return value;
}
export function requireAccountId(value) {
  if (typeof value !== 'string' || !/^acc_[0-9a-f]{24}$/.test(value)) fail('bad-account-id');
  return value;
}
export function requireSequence(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('bad-sequence');
  return value;
}
export function validateAccountPrincipal(value) {
  if (!value || value.identityVersion !== 2 || value.realm !== 'account') fail('bad-principal');
  requireAccountId(value.accountId);
  if (typeof value.accountName !== 'string' || !value.accountName) fail('bad-principal');
  if (!LOGIN_KINDS.includes(value.kind) || typeof value.loginId !== 'string' || !value.loginId ||
      typeof value.credentialId !== 'string' || !value.credentialId ||
      !Number.isSafeInteger(value.loginGeneration) || value.loginGeneration < 1 ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) fail('bad-principal');
  requireSequence(value.accountEventSeq);
  return Object.fromEntries(ACCOUNT_PRINCIPAL_FIELDS.map((key) => [key, value[key]]));
}
export function validateAccountEvent(value) {
  if (!value || value.v !== 2 || value.issuer !== 'visuhive-account' ||
      !['password-changed', 'credentials-revoked'].includes(value.type) ||
      typeof value.eventId !== 'string' || !value.eventId) fail('bad-event');
  requireAccountId(value.accountId); requireSequence(value.seq); requireSequence(value.changeSeq);
  if (value.seq < 1 || value.changeSeq < 1 || !Array.isArray(value.oldLoginIds) || value.oldLoginIds.some((id) => typeof id !== 'string' || !id) || new Set(value.oldLoginIds).size !== value.oldLoginIds.length) fail('bad-event');
  if (value.revokedLoginIds !== undefined && (!Array.isArray(value.revokedLoginIds) ||
      value.revokedLoginIds.some((id) => typeof id !== 'string' || !id || !value.oldLoginIds.includes(id)) ||
      new Set(value.revokedLoginIds).size !== value.revokedLoginIds.length)) fail('bad-event');
  if (!Number.isSafeInteger(value.changedAt) || value.changedAt < 0 ||
      (value.type === 'password-changed' && (typeof value.initiatorWebsiteLoginId !== 'string' || !value.initiatorWebsiteLoginId)) ||
      (value.initiatorWebsiteLoginId != null && typeof value.initiatorWebsiteLoginId !== 'string')) fail('bad-event');
  return value;
}
export function validateEventBatch(value, after = 0) {
  // This validates one page. The doc consumer must persist each receipt and pull to head before opening access.
  requireSequence(after); requireSequence(value?.headSeq);
  if (after > value.headSeq) fail('event-head-regressed');
  if (!Array.isArray(value.events)) fail('bad-event-batch');
  let previous = after;
  for (const event of value.events) {
    validateAccountEvent(event);
    if (event.seq !== previous + 1 || event.seq > value.headSeq) fail('bad-event-order');
    previous = event.seq;
  }
  if (value.events.length === 0 && value.headSeq > after) fail('missing-events');
  return value;
}
export function validateConsent(value, accountId) {
  requireAccountId(accountId);
  if (!value || value.accountId !== accountId || value.noticeVersion !== NOTICE_VERSION ||
      typeof value.accepted !== 'boolean' || (value.accepted && !Number.isSafeInteger(value.acceptedAt))) fail('bad-consent');
  return value;
}
export function validateProjectList(value) {
  if (!value || typeof value.authorityId !== 'string' || !value.authorityId ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !Array.isArray(value.owned) || !Array.isArray(value.joined)) fail('projects-unavailable');
  for (const item of [...value.owned, ...value.joined]) {
    if (!item || typeof item.projectId !== 'string' || !item.projectId ||
        typeof item.name !== 'string' || item.status !== 'active' || typeof item.url !== 'string') fail('projects-unavailable');
    requireAccountId(item.creatorAccountId);
  }
  return value;
}
