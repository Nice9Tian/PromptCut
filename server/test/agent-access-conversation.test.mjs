import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAccountLedger } from '../account/ledger.mjs';
import { createConversationAuthority, claimNextInState, markReadInState, finishInState } from '../account/conversation-authority.mjs';

const projectId = 'sp_' + 'a'.repeat(26);
const ownerId = 'acc_' + 'a'.repeat(24);
const memberId = 'acc_' + 'b'.repeat(24);
const creatorId = 'acc_' + 'c'.repeat(24);
const names = { [ownerId]: 'Owner', [memberId]: 'Member', [creatorId]: 'Creator' };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-access-'));
  const file = path.join(dir, 'authority.sqlite');
  const ledger = openAccountLedger({ file, authorityId: 'agent-conversation-test' });
  ledger.transaction(state => {
    state.projects[projectId] = { projectId, status: 'active', creatorAccountId: creatorId,
      hosted: { agent: true }, bans: {}, members: {
        [ownerId]: { access: 'rw' }, [memberId]: { access: 'rw' }, [creatorId]: { access: 'rw' },
      } };
  });
  const principals = Object.fromEntries([ownerId, memberId, creatorId].map(accountId => [`auth:${accountId}`,
    { authorizationId: `auth:${accountId}`, projectId, accountId, loginId: `login:${accountId}`,
      credentialId: `cred:${accountId}`, loginGeneration: 1, username: names[accountId] }]));
  const accountAuthority = { async authorizePrincipal(ref, { projectId: requested, action }) {
    const principal = principals[ref.authorizationId];
    if (!principal || principal.projectId !== requested) throw Object.assign(new Error('login-required'), { status: 401 });
    const project = ledger.read().projects[requested];
    if (ledger.read().revokedLogins[`login:${principal.loginId}`]) throw Object.assign(new Error('revoked'), { status: 401 });
    if (action === 'write' && project.members[principal.accountId]?.access !== 'rw') throw Object.assign(new Error('readonly'), { status: 403 });
    return structuredClone(principal);
  } };
  const fenced = [];
  const options = { ledger, accountAuthority,
    checkConsent: async ({ accountId }) => ({ accountId, accepted: true, noticeVersion: 1 }),
    verifySelectionSnapshot: async ({ principal, projectId: id, selectionInput }) => ({ projectId: id, accountId: principal.accountId,
      pageId: selectionInput?.pageId ?? 'page_123', selection: selectionInput?.selection ?? { clipIds: [] }, sentAt: 100, source: 'sent-snapshot' }),
    runHooks: { fenceInState(state, input) { fenced.push(input); if (input.kind === 'private') {
      const conv = state.conversationsV2[input.projectId][input.conversationId];
      const running = conv.messages.find(m => m.runId === conv.currentRunId);
      if (running && running.senderAccountId !== conv.ownerAccountId) {
        running.queueState = 'cancelled'; running.reason = 'private'; conv.currentRunId = null;
      }
    } } }, now: () => 100, onFence: async value => ({ ack: true, ...value }) };
  const authority = createConversationAuthority(options);
  const ref = accountId => ({ authorizationId: `auth:${accountId}` });
  const send = (accountId, conversationId, requestId, content = 'hello') => authority.send({ principalRef: ref(accountId),
    projectId, conversationId, requestId, content, selectionInput: { pageId: 'page_123', selection: { clipIds: [] } } });
  return { dir, file, ledger, options, authority, principals, ref, send, fenced, close() {
    try { this.ledger.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true });
  } };
}

test('shared conversation persists trusted sender, FIFO and ACK replay across SQLite restart', async () => {
  const f = fixture();
  try {
    const first = await f.send(ownerId, 'conv1', 'req1');
    const second = await f.send(memberId, 'conv1', 'req2');
    assert.equal(first.queuePosition, 1);
    assert.equal(second.queuePosition, 2);
    assert.equal((await f.authority.list({ principalRef: f.ref(memberId), projectId })).length, 1);
    const view = await f.authority.get({ principalRef: f.ref(memberId), projectId, conversationId: 'conv1' });
    assert.deepEqual(view.messages.map(m => m.senderAccountId), [ownerId, memberId]);
    assert.equal(view.messages[0].selectionSnapshot.accountId, ownerId);
    assert.equal(view.messages[0].selectionSnapshot.messageId, first.messageId);
    assert.equal(view.messages[1].senderNameAtSend, 'Member');
    f.ledger.close();
    const reopened = openAccountLedger({ file: f.file, authorityId: 'agent-conversation-test' });
    f.ledger = reopened; f.options.ledger = reopened;
    const recovered = createConversationAuthority({ ...f.options, accountAuthority: {
      authorizePrincipal: async (ref, args) => { assert.equal(args.projectId, projectId); return f.principals[ref.authorizationId]; },
    } });
    assert.deepEqual(await recovered.send({ principalRef: f.ref(ownerId), projectId, conversationId: 'conv1',
      requestId: 'req1', content: 'hello' }), first);
    assert.equal((await recovered.get({ principalRef: f.ref(ownerId), projectId, conversationId: 'conv1' })).messages.length, 2);
  } finally { f.close(); }
});

test('private switch fences other queue and preserves creator read-only', async () => {
  const f = fixture();
  try {
    await f.send(ownerId, 'conv1', 'req1');
    await f.send(memberId, 'conv1', 'req2');
    const switched = await f.authority.switchVisibility({ principalRef: f.ref(ownerId), projectId, conversationId: 'conv1',
      visibility: 'private', requestId: 'private1' });
    assert.equal(switched.visibility, 'private');
    assert.equal(switched.cancelled.length, 1);
    assert.equal(f.fenced[0].kind, 'private');
    await assert.rejects(f.authority.get({ principalRef: f.ref(memberId), projectId, conversationId: 'conv1' }), { status: 404 });
    await assert.rejects(f.send(memberId, 'conv1', 'req3'), { status: 404 });
    const creator = await f.authority.get({ principalRef: f.ref(creatorId), projectId, conversationId: 'conv1' });
    assert.equal(creator.creatorReadOnly, true);
    await assert.rejects(f.send(creatorId, 'conv1', 'req4'), { status: 404 });
    await assert.rejects(f.authority.switchVisibility({ principalRef: f.ref(creatorId), projectId,
      conversationId: 'conv1', visibility: 'shared', requestId: 'switch2' }), { status: 404 });
  } finally { f.close(); }
});

test('read-only, revoked and consent-absent send fail before queue, 50 blocks rather than evicts', async () => {
  const f = fixture();
  try {
    f.ledger.transaction(state => { state.projects[projectId].members[memberId].access = 'r'; });
    await assert.rejects(f.send(memberId, 'conv1', 'req1'), { status: 403 });
    f.ledger.transaction(state => { state.revokedLogins[`login:${f.principals[`auth:${memberId}`].loginId}`] = { seq: 1 }; });
    await assert.rejects(f.send(memberId, 'conv1', 'req2'), { status: 401 });
    const denied = createConversationAuthority({ ...f.options, checkConsent: async ({ accountId }) => ({ accountId, accepted: false, noticeVersion: 1 }) });
    await assert.rejects(denied.send({ principalRef: f.ref(ownerId), projectId, conversationId: 'conv1', requestId: 'req3', content: 'x' }), { code: 'consent-required' });
    assert.equal(f.ledger.read().conversationsV2, undefined);
    for (let i = 0; i < 50; i++) await f.send(ownerId, `conv${i}`, `req${i}`);
    await assert.rejects(f.send(ownerId, 'conv50', 'req50'), { code: 'conversation-limit' });
    assert.equal(Object.keys(f.ledger.read().conversationsV2[projectId]).length, 50);
  } finally { f.close(); }
});

test('same SQLite transaction hooks claim strict FIFO, read once, finish and refuse revoked queued sender', async () => {
  const f = fixture();
  try {
    const first = await f.send(ownerId, 'conv1', 'req1');
    const second = await f.send(memberId, 'conv1', 'req2');
    const claim = f.ledger.transaction(state => claimNextInState(state, { projectId, conversationId: 'conv1', runId: 'run1', expectedMessageId: first.messageId }));
    assert.equal(claim.message.messageId, first.messageId);
    assert.equal(claim.message.queueState, 'preparing');
    await assert.rejects(Promise.resolve().then(() => f.ledger.transaction(state => claimNextInState(state,
      { projectId, conversationId: 'conv1', runId: 'run2', expectedMessageId: second.messageId }))), { code: 'busy-conversation' });
    f.ledger.transaction(state => markReadInState(state, { projectId, conversationId: 'conv1',
      messageId: first.messageId, runId: 'run1', readReceiptId: 'receipt1' }));
    assert.equal(f.ledger.read().conversationsV2[projectId].conv1.messages[0].queueState, 'running');
    await assert.rejects(Promise.resolve().then(() => f.ledger.transaction(state => markReadInState(state,
      { projectId, conversationId: 'conv1', messageId: first.messageId, runId: 'run1', readReceiptId: 'receipt2' }))), { code: 'run-fenced' });
    f.ledger.transaction(state => finishInState(state, { projectId, conversationId: 'conv1',
      messageId: first.messageId, runId: 'run1', state: 'done' }));
    f.ledger.transaction(state => { state.revokedLogins[`login:${f.principals[`auth:${memberId}`].loginId}`] = { seq: 2 }; });
    const emptied = f.ledger.transaction(state => claimNextInState(state,
      { projectId, conversationId: 'conv1', runId: 'run2', expectedMessageId: second.messageId }));
    assert.equal(emptied.message, null);
    assert.equal(emptied.cancelled.length, 1);
    assert.equal(f.ledger.read().conversationsV2[projectId].conv1.currentRunId, null);
  } finally { f.close(); }
});

test('claim commits revoked head and requires a fresh credential check for the next sender', async () => {
  const f = fixture();
  try {
    const first = await f.send(memberId, 'conv1', 'req1');
    const second = await f.send(ownerId, 'conv1', 'req2');
    f.ledger.transaction(state => { state.revokedLogins[`login:${f.principals[`auth:${memberId}`].loginId}`] = { seq: 1 }; });
    const shifted = f.ledger.transaction(state => claimNextInState(state, { projectId, conversationId: 'conv1',
      runId: 'run1', expectedMessageId: first.messageId }));
    assert.equal(shifted.message, null); assert.equal(shifted.retry, true); assert.deepEqual(shifted.cancelled, [first.messageId]);
    assert.equal(f.ledger.read().conversationsV2[projectId].conv1.currentRunId, null);
    const claimed = f.ledger.transaction(state => claimNextInState(state, { projectId, conversationId: 'conv1',
      runId: 'run2', expectedMessageId: second.messageId }));
    assert.equal(claimed.message.messageId, second.messageId);
  } finally { f.close(); }
});
