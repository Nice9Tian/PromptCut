import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAccountLedger } from '../account/ledger.mjs';
import { createConversationAuthority, claimNextInState, markReadInState, finishInState } from '../account/conversation-authority.mjs';
import { createRunAuthority } from '../account/run-authority.mjs';
import { openReadIntents } from '../agent/service/read-intents.mjs';
import { createAccountRunManager } from '../agent/service/account-runner.mjs';

const projectId = 'sp_' + 'a'.repeat(26), accountId = 'acc_' + 'b'.repeat(24);
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-runner-read-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'runner-test' });
  ledger.transaction(state => { state.projects[projectId] = { status: 'active', creatorAccountId: accountId,
    members: { [accountId]: { access: 'rw' } }, bans: {}, hosted: { agent: true } }; });
  const servicePrincipal = { authenticated: 'temporary-agent-cert' };
  const run = createRunAuthority({ ledger, conversationHooks: { claimNextInState, markReadInState, finishInState },
    verifySender: async ref => ({ ...ref, accountEventSeq: 0 }),
    verifyServiceInState: (_state, source) => source === servicePrincipal ? { serviceId: 'agent', serviceKid: 'kid-fixture' } : null,
    synchronize: async () => {} });
  const principal = { authorizationId: 'valid', projectId, accountId, accountName: 'Alice',
    loginId: 'login-a', credentialId: 'credential-a', loginGeneration: 1 };
  const authority = createConversationAuthority({ ledger, accountAuthority: { authorizePrincipal: async () => principal },
    checkConsent: async () => ({ accountId, accepted: true, noticeVersion: 1 }),
    verifySelectionSnapshot: async () => ({ projectId, accountId, pageId: 'page_123',
      selection: { clipIds: ['clipA'] }, sentAt: 100, source: 'sent-snapshot' }),
    runHooks: run.hooks, onFence: async input => ({ ack: true, ...input }) });
  const intents = openReadIntents({ file: path.join(dir, 'intents.sqlite') });
  let lostAck = false;
  const client = {
    admit: input => run.admit({ ...input, servicePrincipal }),
    async confirmRead(input) { const result = await run.confirmRead({ ...input, servicePrincipal });
      if (!lostAck) { lostAck = true; throw new Error('response-lost-after-durable-commit'); } return result; },
    queryRead: input => run.queryRead({ ...input, servicePrincipal }),
    async checkAccess({ projectId: p, runGrantId, action }) {
      const runPrincipal = await run.resolveRunPrincipal({ servicePrincipal, projectId: p, runGrantId });
      return run.checkAccess({ principal: runPrincipal, projectId: p, action });
    },
    finish: input => run.finish({ ...input, servicePrincipal }),
    pending: async () => ({ conversations: Object.values(ledger.read().conversationsV2?.[projectId] ?? {})
      .filter(c => c.messages.some(m => m.queueState === 'queued')).map(c => ({ projectId, conversationId: c.id, queueRevision: c.queueRevision })) }),
  };
  return { dir, ledger, authority, run, intents, client,
    close() { intents.close(); ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('durable complete record + lost read ACK resolves by query before first model/tool', async () => {
  const f = fixture();
  try {
    const sent = await f.authority.send({ principalRef: { authorizationId: 'valid' }, projectId,
      conversationId: 'conv1', requestId: 'send1', content: 'Do work' });
    let started = 0, model = 0, tool = 0, closed = 0;
    const manager = createAccountRunManager({ runClient: f.client, readIntents: f.intents,
      serviceKid: 'kid-fixture', instanceId: 'instance-fixture',
      runnerFactory: async ({ grant, record, onModelCall, beforeToolCall }) => {
        assert.equal(record.messageId, sent.messageId);
        assert.equal(record.senderAccountId, accountId);
        assert.deepEqual(record.selectionSnapshot.selection.clipIds, ['clipA']);
        assert.equal(grant.messageId, record.messageId);
        return { async start() { started++;
          await onModelCall(); model++;
          await beforeToolCall(); tool++;
          return { done: Promise.resolve(), abort() {}, async drain() { return { dispatchesOpen: 0 }; } };
        }, close() { closed++; } };
      }, connectionsClosed: async () => true, childrenClosed: async () => true });
    await manager.wake(projectId, 'conv1');
    assert.equal(started, 1); assert.equal(model, 1); assert.equal(tool, 1); assert.equal(closed, 1);
    assert.equal(Object.keys(f.ledger.read().runReceiptsV2).length, 1);
    assert.equal(f.ledger.read().conversationsV2[projectId].conv1.messages[0].queueState, 'done');
    assert.equal(f.intents.pending().length, 0);
    manager.close();
  } finally { f.close(); }
});

test('credential revoked before admit cancels queue; no read intent or runner starts', async () => {
  const f = fixture();
  try {
    await f.authority.send({ principalRef: { authorizationId: 'valid' }, projectId,
      conversationId: 'conv1', requestId: 'send1', content: 'Must not run' });
    f.ledger.transaction(state => { state.revokedLogins['login:login-a'] = { seq: 1 }; });
    let starts = 0;
    const manager = createAccountRunManager({ runClient: f.client, readIntents: f.intents,
      serviceKid: 'kid-fixture', instanceId: 'instance-fixture',
      runnerFactory: async () => { starts++; throw new Error('must not start'); } });
    await manager.wake(projectId, 'conv1');
    assert.equal(starts, 0); assert.equal(f.intents.pending().length, 0);
    assert.equal(f.ledger.read().conversationsV2[projectId].conv1.messages[0].queueState, 'cancelled');
    manager.close();
  } finally { f.close(); }
});
