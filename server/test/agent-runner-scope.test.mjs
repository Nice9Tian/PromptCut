import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAccountLedger } from '../account/ledger.mjs';
import { createConversationAuthority, claimNextInState, markReadInState, finishInState } from '../account/conversation-authority.mjs';
import { createRunAuthority } from '../account/run-authority.mjs';
import { instanceFixture } from './agent-instance-fixture.mjs';

const projectId = 'sp_' + 'a'.repeat(26), accountId = 'acc_' + 'b'.repeat(24);
test('same request ID scopes to action and conversation with real run hooks in one SQLite ledger', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-scope-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'state.sqlite'), authorityId: 'scope-test' });
  try {
    ledger.transaction(state => { state.projects[projectId] = { status: 'active', creatorAccountId: accountId,
      members: { [accountId]: { access: 'rw' } }, bans: {}, hosted: { agent: true } }; });
    const principal = { authorizationId: 'valid', projectId, accountId, accountName: 'Alice',
      loginId: 'login-1', credentialId: 'credential-1', loginGeneration: 1 };
    const instances = instanceFixture(ledger); instances.boot();
    const run = createRunAuthority({ ledger, instanceAuthority: instances.authority,
      conversationHooks: { claimNextInState, markReadInState, finishInState },
      verifySender: async ref => ({ ...ref, accountEventSeq: 0 }),
      verifyServiceInState: () => ({ serviceId: 'agent', serviceKid: 'kid-test' }),
      synchronize: async () => {} });
    const authority = createConversationAuthority({ ledger, accountAuthority: { authorizePrincipal: async () => principal },
      checkConsent: async () => ({ accountId, accepted: true, noticeVersion: 1 }),
      verifySelectionSnapshot: async ({ projectId: p }) => ({ projectId: p, accountId, pageId: 'page_123',
        selection: { clipIds: [] }, sentAt: 1, source: 'sent-snapshot' }),
      runHooks: run.hooks, onFence: async value => ({ ack: true, ...value }) });
    const send = (conversationId, content) => authority.send({ principalRef: { authorizationId: 'valid' },
      projectId, conversationId, requestId: 'same-client-request', content });
    const a = await send('first', 'one'), b = await send('second', 'two');
    assert.notEqual(a.messageId, b.messageId);
    assert.equal(ledger.read().conversationsV2[projectId].first.messages.length, 1);
    assert.equal(ledger.read().conversationsV2[projectId].second.messages.length, 1);
    assert.equal((await send('first', 'one')).messageId, a.messageId);
    await assert.rejects(send('first', 'changed'), { code: 'request-mismatch' });
    for (const conversationId of ['first', 'second']) {
      const switched = await authority.switchVisibility({ principalRef: { authorizationId: 'valid' },
        projectId, conversationId, visibility: 'private', requestId: 'same-switch-request' });
      assert.equal(switched.visibility, 'private');
    }
    assert.equal(Object.keys(ledger.read().runControlsV2).length, 2);
    assert.equal((await authority.switchVisibility({ principalRef: { authorizationId: 'valid' },
      projectId, conversationId: 'first', visibility: 'private', requestId: 'same-switch-request' })).visibility, 'private');
    await assert.rejects(authority.switchVisibility({ principalRef: { authorizationId: 'valid' }, projectId,
      conversationId: 'first', visibility: 'shared', requestId: 'same-switch-request' }), { code: 'request-mismatch' });
    ledger.transaction(state => {
      for (const [id, runId] of [['first', 'run1'], ['second', 'run2']]) {
        const conv = state.conversationsV2[projectId][id]; conv.currentRunId = runId;
        conv.messages[0].runId = runId; conv.messages[0].queueState = 'running';
      }
    });
    for (const [id, runId] of [['first', 'run1'], ['second', 'run2']]) {
      const stopped = await authority.stop({ principalRef: { authorizationId: 'valid' }, projectId,
        conversationId: id, runId, requestId: 'same-stop-request' });
      assert.equal(stopped.runId, runId);
    }
    assert.equal(Object.keys(ledger.read().conversationRequestsV2).length, 6);
  } finally { ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
