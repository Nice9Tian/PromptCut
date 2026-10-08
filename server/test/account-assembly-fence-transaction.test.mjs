import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountFixture, actor } from './password-order-fixture.mjs';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountAuthority } from '../account/authority.mjs';

const actual = { skip: !process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT || !process.env.PROMPTCUT_PASSWORD_ORDER_MODULE ? 'explicit actual provider required' : false };

test('authority sync run fence shares the real admin/revocation transaction; throw/async rolls back; immutable off survives on/restart', actual, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-assembly-fence-tx-'));
  const provider = await accountFixture({ dir, actual: true });
  const editor = provider.credentials.createEditor({ account: provider.store.accountById(actor.accountId), deviceId: 'tx-page', requestId: 'tx-login' });
  let ledger, authority, fail = false, asynchronous = false;
  const seen = [];
  const open = async () => {
    ledger = openAccountLedger({ file: path.join(dir, 'doc.db'), authorityId: 'tx-doc' });
    authority = createAccountAuthority({ ledger,
      accountClient: { verify: async token => provider.credentials.verify(token), events: async after => provider.store.events(after) },
      initializeProject: async () => ({ contentId: 'tx-fixture-content' }),
      now: () => 100, pollMs: 0,
      // This seam test writes evidence in the real SQLite transaction; it makes no
      // claim about the separate run provider's grant/retention implementation.
      runHooks: { fenceInState(state, fence) {
        seen.push(structuredClone(fence));
        state.assemblyTransactionEvidence ??= [];
        state.assemblyTransactionEvidence.push(fence);
        if (fail) throw Object.assign(Error('controlled-hook-failure'), { status: 503 });
        if (asynchronous) return Promise.resolve({ state: 'pending' });
        return { state: 'pending', receipt: null, operationFences: [] };
      } } });
    await authority.start();
  };
  t.after(() => { authority?.close(); ledger?.close(); provider.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await open();
  const projectId = (await authority.createProject({ accessToken: editor.accessToken }, { name: 'Fence transaction', requestId: 'create' })).projectId;
  const revision = () => ledger.read().projects[projectId].accessRevision;
  const toggle = (enabled, requestId) => authority.adminProject({ accessToken: editor.accessToken }, {
    projectId, op: 'set-hosted-service', service: 'agent', enabled, requestId, expectedAccessRevision: revision() });
  await toggle(true, 'on');
  let before = ledger.read(); fail = true;
  await assert.rejects(toggle(false, 'off-fail'), /controlled-hook-failure/);
  assert.deepEqual(ledger.read(), before, 'project/event/fence evidence all rolled back');
  fail = false; asynchronous = true;
  await assert.rejects(toggle(false, 'off-async'), /ledger-async-transaction/);
  assert.deepEqual(ledger.read(), before);
  asynchronous = false;
  const notifications = []; authority.subscribeRevocations({}, (event, control) => notifications.push({ event, control }));
  await toggle(false, 'off'); await toggle(true, 'on-again');
  const off = ledger.read().accessEvents.find(event => event.service === 'agent' && event.enabled === false);
  assert.ok(off); assert.equal(off.accountIds.length, 0); assert.equal(off.reason, 'set-hosted-service');
  assert.equal(notifications.length, 1, 'empty affected account list cannot hide Agent-off');
  assert.equal(notifications[0].control.state, 'pending'); assert.equal(notifications[0].control.receipt, null);
  assert.equal(ledger.read().assemblyTransactionEvidence.at(-1).kind, 'agent-disabled');
  assert.equal(ledger.read().assemblyTransactionEvidence.at(-1).accessSeq, off.seq);
  authority.close(); ledger.close(); await open();
  assert.equal(ledger.read().projects[projectId].hosted.agent, true);
  assert.deepEqual(ledger.read().accessEvents.find(event => event.eventId === off.eventId), off);
  assert.equal(ledger.read().assemblyTransactionEvidence.at(-1).kind, 'agent-disabled');
  const event = provider.change('revocation-hook'); provider.choose(event, true);
  before = ledger.read(); fail = true;
  await assert.rejects(authority.synchronize(), /controlled-hook-failure/);
  // password-changed is a prior valid event; the credentials-revoked event/fence
  // is the atomic unit that must remain unapplied after the failing hook.
  assert.equal(ledger.read().accessHead, before.accessHead);
  assert.equal(Object.values(ledger.read().revokedLogins).length, 0);
  fail = false; await authority.synchronize();
  assert.equal(ledger.read().assemblyTransactionEvidence.at(-1).kind, 'credential');
  assert.ok(ledger.read().assemblyTransactionEvidence.at(-1).loginIds.includes(editor.loginId));
  assert.ok(seen.some(fence => fence.kind === 'agent-disabled'));
});
