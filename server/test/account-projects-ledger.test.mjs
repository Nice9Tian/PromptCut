import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountAuthority } from '../account/authority.mjs';

const accountId = 'acc_0123456789abcdef01234567';
const event = seq => ({ v: 2, issuer: 'visuhive-account', type: 'credentials-revoked', eventId: `logout:${seq}`, accountId,
  seq, changeSeq: seq, changedAt: 1, oldLoginIds: [`login:${seq}`], revokedLoginIds: [`login:${seq}`], initiatorWebsiteLoginId: null });
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-account-ledger-')); const file = path.join(dir, 'doc.sqlite');
  let ledger = openAccountLedger({ file, authorityId: 'doc-ledger-fixture', ...options });
  t.after(() => { ledger.close(); const target = path.resolve(dir); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('pc-account-ledger-')); fs.rmSync(target, { recursive: true, force: true }); });
  return { get ledger() { return ledger; }, reopen() { ledger.close(); ledger = openAccountLedger({ file, authorityId: 'doc-ledger-fixture', ...options }); return ledger; }, file };
}
for (const cut of ['ledger-before-write', 'ledger-before-commit']) {
  test(`v2 ledger ${cut} rollback preserves event/head/revocation/outbox atomicity on restart`, t => {
    let fail = false; const f = fixture(t, { failpoint: point => { if (fail && point === cut) throw new Error('injected-ledger-failure'); } });
    let authority = createAccountAuthority({ ledger: f.ledger, accountClient: {}, pollMs: 0 });
    fail = true; assert.throws(() => authority.applyRevocation(event(1)), /injected-ledger-failure/);
    authority.close(); f.reopen();
    assert.equal(f.ledger.read().accountHead, 0); assert.equal(f.ledger.read().accessHead, 0);
    assert.deepEqual(f.ledger.read().revokedLogins, {}); assert.deepEqual(f.ledger.read().barriers, {});
    fail = false; authority = createAccountAuthority({ ledger: f.ledger, accountClient: {}, pollMs: 0 });
    authority.applyRevocation(event(1)); authority.close(); f.reopen();
    assert.equal(f.ledger.read().accountHead, 1); assert.equal(f.ledger.read().accessHead, 1);
    assert.equal(f.ledger.read().revokedLogins['login:login:1'].eventId, 'logout:1');
  });
}
test('event duplicate exact digest is idempotent; conflict/gap do not expand revoked set', t => {
  const f = fixture(t); const authority = createAccountAuthority({ ledger: f.ledger, accountClient: {}, pollMs: 0 });
  assert.throws(() => authority.applyRevocation(event(2)), /account-event-gap/); assert.equal(f.ledger.read().accountHead, 0);
  authority.applyRevocation(event(1)); assert.equal(authority.applyRevocation(event(1)).duplicate, true);
  assert.throws(() => authority.applyRevocation({ ...event(1), oldLoginIds: ['different'], revokedLoginIds: ['different'] }), /account-event-conflict/);
  assert.equal(f.ledger.read().accountHead, 1); assert.equal(f.ledger.read().accessEvents.length, 1); authority.close();
});
test('consumer gap/out-of-order/head regression fails closed until complete contiguous recovery', async t => {
  const f = fixture(t); let mode = 'gap';
  const client = { events: async after => mode === 'gap' ? { events: [event(after + 2)], headSeq: after + 2 } :
    mode === 'empty' ? { events: [], headSeq: after + 1 } : mode === 'regressed' ? { events: [], headSeq: after - 1 } :
      { events: after === 0 ? [event(1)] : [], headSeq: 1 } };
  const authority = createAccountAuthority({ ledger: f.ledger, accountClient: client, authorityUrl: 'https://fixture.invalid', pollMs: 0 });
  await assert.rejects(() => authority.start(), /account-event-gap/); assert.equal(f.ledger.read().accountHead, 0);
  assert.throws(() => authority.listProjects(accountId), /authority-not-ready/);
  mode = 'empty'; await assert.rejects(() => authority.synchronize(), /account-event-gap/);
  mode = 'good'; await authority.synchronize(); assert.equal(f.ledger.read().accountHead, 1); assert.deepEqual(authority.listProjects(accountId).owned, []);
  mode = 'regressed'; await assert.rejects(() => authority.synchronize(), /account-event-gap/); assert.throws(() => authority.eventsSince(0), /authority-not-ready/);
  assert.equal(f.ledger.read().accountHead, 1); authority.close();
});
test('ledger authority mismatch and asynchronous mutation reject without persisting accidental changes', async t => {
  const f = fixture(t);
  assert.throws(() => openAccountLedger({ file: f.file, authorityId: 'other-authority' }), /authority-mismatch/);
  assert.throws(() => f.ledger.transaction(async state => { state.revision = 7; }), /ledger-async-transaction/);
  assert.equal(f.ledger.read().revision, 0);
  f.ledger.transaction(state => { state.revision = 1; }); assert.equal(f.reopen().read().revision, 1);
});
test('account ACK lost response persists exact receipt and replays after restart; no false completion for revocation', async t => {
  const f = fixture(t); const password = { ...event(1), type: 'password-changed', initiatorWebsiteLoginId: 'website-initiator' };
  const revoked = { ...password, seq: 2, type: 'credentials-revoked' };
  const receipts = []; let lose = true;
  const client = { events: async after => ({ events: [password, revoked].filter(e => e.seq > after), headSeq: 2 }),
    ack: async (id, receipt) => { receipts.push({ id, receipt }); if (lose) throw new Error('lost-ack-response'); return { ok: true }; } };
  let authority = createAccountAuthority({ ledger: f.ledger, accountClient: client, pollMs: 0 });
  await authority.start(); await assert.rejects(() => authority.flushAccountAcknowledgements(), /lost-ack-response/);
  assert.equal(f.ledger.read().accountAcks['seq:1'].sent, false);
  authority.close(); f.reopen(); lose = false;
  authority = createAccountAuthority({ ledger: f.ledger, accountClient: client, pollMs: 0 });
  await authority.start(); const result = await authority.flushAccountAcknowledgements();
  assert.deepEqual(receipts[1], receipts[0]); assert.deepEqual(result.pendingEvents, [password.eventId]);
  assert.equal(receipts.length, 2); assert.equal(receipts[1].receipt.logoutComplete, false);
  assert.equal(f.ledger.read().accountAcks['seq:2'], undefined); authority.close();
});
test('same event password/revocation cannot silently widen old login set', t => {
  const f = fixture(t); const authority = createAccountAuthority({ ledger: f.ledger, accountClient: {}, pollMs: 0 });
  const password = { ...event(1), type: 'password-changed', initiatorWebsiteLoginId: 'initiator' };
  authority.applyRevocation(password);
  assert.throws(() => authority.applyRevocation({ ...event(2), eventId: password.eventId, initiatorWebsiteLoginId: 'initiator' }), /account-event-conflict/);
  assert.equal(f.ledger.read().accountHead, 1); assert.deepEqual(f.ledger.read().revokedLogins, {});
  authority.applyRevocation({ ...password, type: 'credentials-revoked', seq: 2 });
  assert.equal(f.ledger.read().accountHead, 2); assert.equal(f.ledger.read().revokedLogins['login:login:2'], undefined); authority.close();
});
