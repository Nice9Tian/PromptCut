import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAccountPrincipal, validateAccountEvent, validateEventBatch, validateConsent, validateProjectList, requireRequestId } from '../account/protocol.mjs';
const accountId = 'acc_0123456789abcdef01234567';
test('account v2 principal rejects self-reported legacy identities and strips project authority', () => {
  const principal = { identityVersion: 2, realm: 'account', accountId, accountName: 'alice', loginId: 'login_1', loginGeneration: 1, credentialId: 'cred_1', kind: 'editor', expiresAt: 1, accountEventSeq: 0, creator: true };
  assert.equal(validateAccountPrincipal(principal).creator, undefined);
  assert.throws(() => validateAccountPrincipal({ ...principal, identityVersion: 1 }));
  assert.throws(() => validateAccountPrincipal({ ...principal, accountId: 'alice' }));
});
test('account outbox requires strictly increasing persistent sequence', () => {
  const event = { v: 2, issuer: 'visuhive-account', type: 'password-changed', eventId: 'pw_1', accountId, seq: 3, changeSeq: 2, changedAt: 100, oldLoginIds: ['login_1'], initiatorWebsiteLoginId: 'login_2' };
  assert.equal(validateEventBatch({ events: [event], headSeq: 3 }, 2).events.length, 1);
  assert.throws(() => validateEventBatch({ events: [event, event], headSeq: 3 }));
  assert.throws(() => validateEventBatch({ events: [event], headSeq: 2 }));
  assert.throws(() => validateEventBatch({ events: [event], headSeq: 3 }, 1));
  assert.throws(() => validateEventBatch({ events: [], headSeq: 3 }, 2));
  assert.throws(() => validateEventBatch({ events: [], headSeq: 2 }, 3));
});
test('consent is account-bound and project failures cannot become empty success', () => {
  assert.equal(validateConsent({ accountId, noticeVersion: 1, accepted: false }, accountId).accepted, false);
  assert.throws(() => validateConsent({ accountId, noticeVersion: 1, accepted: true }, accountId));
  assert.throws(() => validateProjectList({ owned: [], joined: [] }));
  assert.deepEqual(validateProjectList({ owned: [], joined: [], authorityId: 'doc', revision: 0 }).owned, []);
  assert.throws(() => requireRequestId('bad request'));
});
test('normal website/editor logout is consumable and explicit revocation cannot enlarge the snapshot', () => {
  const event = { v: 2, issuer: 'visuhive-account', type: 'credentials-revoked', eventId: 'logout_1', accountId, seq: 1, changeSeq: 1, changedAt: 100, oldLoginIds: ['login_1'], revokedLoginIds: ['login_1'], initiatorWebsiteLoginId: null };
  assert.equal(validateAccountEvent(event).type, 'credentials-revoked');
  assert.equal(validateAccountEvent({ ...event, initiatorWebsiteLoginId: 'editor_login_1' }).oldLoginIds.length, 1);
  assert.throws(() => validateAccountEvent({ ...event, revokedLoginIds: ['newer_login'] }));
  assert.throws(() => validateAccountEvent({ ...event, revokedLoginIds: 'whole-account' }));
  assert.throws(() => validateAccountEvent({ ...event, type: 'password-changed' }));
});
