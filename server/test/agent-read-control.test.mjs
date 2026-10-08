import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openAccountLedger, appendAccessEvent } from '../account/ledger.mjs';
import { createAccountAuthority } from '../account/authority.mjs';
import { createAgentReadControl, conversationControlOperations, CONVERSATION_CONTROL_ROOT } from '../account/agent-read-control.mjs';
import { conversationReadInState } from '../account/conversation-authority.mjs';
import { instanceFixture } from './agent-instance-fixture.mjs';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-read-core-'));
  const file = path.join(dir, 'doc.sqlite'), ledger = openAccountLedger({ file, authorityId: 'read-core' });
  const instances = instanceFixture(ledger), process = instances.boot(), frames = [];
  const principals = Object.fromEntries(['owner', 'member', 'creator'].map(accountId => [accountId, {
    projectId: 'project', accountId, loginId: `login-${accountId}`, credentialId: `cred-${accountId}`, loginGeneration: 1,
  }]));
  ledger.transaction(state => {
    state.projects.project = { status: 'active', creatorAccountId: 'creator', hosted: { agent: true }, bans: {},
      members: { owner: { access: 'rw' }, member: { access: 'rw' }, creator: { access: 'rw' } } };
    state.conversationsV2 = { project: { conversation: { id: 'conversation', projectId: 'project', ownerAccountId: 'owner',
      visibility: 'shared', aclRevision: 1, queueRevision: 1, currentRunId: null, messages: [{ arrivalSeq: 1, content: 'full message' }] } } };
  });
  const create = () => createAgentReadControl({ ledger, instanceAuthority: instances.authority,
    authorizeRead: async body => { const principal = principals[body.delegation]; if (!principal) throw new Error('delegation-required'); return structuredClone(principal); },
    checkReadInState: conversationReadInState });
  let control = create(); const releases = [];
  function signed(action, input, processArg = process) {
    const body = { requestId: randomUUID(), nonce: randomUUID(), ...input };
    const auth = instances.authorize(processArg, conversationControlOperations[action], body,
      { path: CONVERSATION_CONTROL_ROOT + action });
    releases.push(() => instances.authority.release(auth.principal.instanceSession));
    return { servicePrincipal: auth.principal, body };
  }
  function subscribe(p = process) { return control.subscribe({ ...signed('subscribe', {}, p), send: frame => frames.push(frame), onFailure() {} }); }
  const open = (delegation = 'member', fields = {}, p = process) => control.open(signed('open', {
    delegation, projectId: 'project', conversationId: 'conversation', action: 'get', after: 0, ...fields }, p));
  const fence = (input = {}) => ledger.transaction(state => {
    state.conversationsV2.project.conversation.visibility = 'private';
    return control.hooks.fenceInState(state, { kind: 'private', projectId: 'project', conversationId: 'conversation', requestId: 'private', ...input });
  });
  t.after(() => { control.close(); for (const release of releases) release(); instances.close(); ledger.close(); fs.rmSync(dir, { recursive: true }); });
  return { ledger, file, instances, process, signed, subscribe, open, fence, frames,
    get control() { return control; }, restart() { control.close(); control = create(); } };
}

test('zero-run HTTP reads persist exact instance inventory; private completion waits close then exact ACK', async t => {
  const f = setup(t); f.subscribe(); const opened = await f.open();
  assert.equal(opened.value.messages[0].content, 'full message');
  assert.equal(f.ledger.read().runGrantsV2, undefined);
  const c = f.fence(); const id = opened.readHandle.readHandleId;
  assert.deepEqual(c.targets[f.process.registration.instanceId].readHandleIds, [id]);
  assert.equal(f.control.completion({ projectId: 'project', conversationId: 'conversation' }).complete, false);
  const ack = () => f.signed('ack', { controlId: c.controlId, payloadDigest: c.payloadDigest, seq: c.seq, readHandleIds: [id] });
  assert.throws(() => f.control.acknowledge(ack()), { code: 'read-close-pending' });
  f.control.closeReads(f.signed('close', { readHandleIds: [id] }));
  assert.equal(f.control.completion({ projectId: 'project', conversationId: 'conversation' }).complete, false);
  f.control.acknowledge(ack());
  assert.equal(f.control.completion({ projectId: 'project', conversationId: 'conversation' }).complete, true);
  await assert.rejects(f.open(), { code: 'no-conversation' });
});

test('creator and owner private read remain; ordinary project-wide list is included in fence', async t => {
  const f = setup(t); f.subscribe();
  const list = await f.open('member', { action: 'list', conversationId: null });
  const creator = await f.open('creator'), owner = await f.open('owner');
  const c = f.fence(); assert.deepEqual(c.targets[f.process.registration.instanceId].readHandleIds, [list.readHandle.readHandleId]);
  assert.equal(f.ledger.read().agentReadsV1.handles[creator.readHandle.readHandleId].state, 'open');
  assert.equal(f.ledger.read().agentReadsV1.handles[owner.readHandle.readHandleId].state, 'open');
  assert.equal((await f.open('creator')).value.creatorReadOnly, true);
});

test('same certificate new RAM instance cannot close or ACK the original read; unknown historical instance stays pending', async t => {
  const f = setup(t); f.subscribe(); const opened = await f.open();
  const second = f.instances.boot(); const c = f.fence();
  assert.equal(c.targets[second.registration.instanceId].unknownInstance, true);
  assert.throws(() => f.control.closeReads(f.signed('close', { readHandleIds: [opened.readHandle.readHandleId] }, second)), { code: 'read-instance-mismatch' });
  f.subscribe(second);
  assert.throws(() => f.control.acknowledge(f.signed('ack', { controlId: c.controlId, payloadDigest: c.payloadDigest,
    seq: c.seq, readHandleIds: [] }, second)), { code: 'read-control-receipt-mismatch' });
});

test('disconnect and doc restart preserve open inventory; only original live RAM key can reprove', async t => {
  const f = setup(t); const disconnect = f.subscribe(); const opened = await f.open(); disconnect();
  await assert.rejects(f.open(), { code: 'read-control-disconnected' });
  f.restart(); const c = f.fence();
  assert.deepEqual(c.targets[f.process.registration.instanceId].readHandleIds, [opened.readHandle.readHandleId]);
  f.subscribe(); assert.equal(f.control.completion({ projectId: 'project' }).complete, false);
  f.control.closeReads(f.signed('close', { readHandleIds: [opened.readHandle.readHandleId] }));
  f.control.acknowledge(f.signed('ack', { controlId: c.controlId, payloadDigest: c.payloadDigest, seq: c.seq,
    readHandleIds: [opened.readHandle.readHandleId] }));
  assert.equal(f.control.completion({ projectId: 'project' }).complete, true);
});

test('read proofs have exact body/action scope, nonce replay rejects, and changed request identity conflicts', async t => {
  const f = setup(t); f.subscribe();
  const input = f.signed('open', { delegation: 'member', projectId: 'project', conversationId: 'conversation', action: 'get', after: 0 });
  await assert.rejects(f.control.open({ ...input, body: { ...input.body, delegation: 'owner' } }), { code: 'instance-invocation-forbidden' });
  await f.control.open(input);
  await assert.rejects(f.control.open(input), { code: 'read-control-replay' });
  await assert.rejects(f.open('owner', { requestId: input.body.requestId }), { code: 'read-request-mismatch' });
  assert.throws(() => f.control.closeReads({ ...input, body: { requestId: 'close', nonce: randomUUID(), readHandleIds: [] } }), { code: 'instance-invocation-forbidden' });
});

test('same control scope has immutable payload and rollback cannot publish a phantom control', async t => {
  const f = setup(t); f.subscribe(); await f.open();
  const c = f.fence();
  assert.equal(f.fence().controlId, c.controlId);
  assert.throws(() => f.fence({ ownerAccountId: 'forged' }), { code: 'read-control-mismatch' });
  const head = f.ledger.read().agentReadsV1.head;
  assert.throws(() => f.ledger.transaction(state => {
    f.control.hooks.fenceInState(state, { kind: 'delete', projectId: 'project', requestId: 'rollback' });
    throw new Error('rollback');
  }), /rollback/);
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(f.ledger.read().agentReadsV1.head, head);
  assert.equal(f.frames.some(frame => frame.seq > head), false);
});

test('legacy Agent ACK cannot bypass mandatory read closure, including module loss after SQLite reopen', t => {
  const f = setup(t);
  const event = f.ledger.transaction(state => appendAccessEvent(state, { type: 'login-revoked', loginIds: ['login-member'] }));
  const receipt = { receiptId: 'unproved', cursor: event.seq, complete: true, closedStreams: [], stoppedRuns: [], rejectedCredentials: [] };
  const authority = createAccountAuthority({ ledger: f.ledger });
  t.after(() => authority.close());
  assert.equal(f.ledger.read().agentReadControlRequired, true);
  assert.throws(() => authority.ackAccessEvent(event.eventId, 'agent', receipt), { code: 'agent-read-closure-required' });
  assert.equal(authority.ackAccessEvent(event.eventId, 'asset', receipt).complete, true);
  f.control.close();
  const reopened = openAccountLedger({ file: f.file, authorityId: 'read-core' });
  const absentModule = createAccountAuthority({ ledger: reopened });
  try { assert.throws(() => absentModule.ackAccessEvent(event.eventId, 'agent', receipt), { code: 'agent-read-closure-required' }); }
  finally { absentModule.close(); reopened.close(); }
});
