import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runFixture, projectId, conversationId, servicePrincipal } from './run-authority-fixture.mjs';
import { digestOf } from '../account/ledger.mjs';
import { createRunAuthority } from '../account/run-authority.mjs';

async function fixture(t, options) {
  const f = await runFixture(options); t.after(() => { f.close(); fs.rmSync(f.dir, { recursive: true }); }); return f;
}
const inspect = f => f.ledger.read().conversationsV2[projectId][conversationId];

test('run authority requires real provider callbacks and SQLite FULL stores no usable user token', async t => {
  assert.throws(() => createRunAuthority({}), /run-authority-configuration/);
  const f = await fixture(t); f.enqueue(); const g = await f.admit();
  assert.equal(f.ledger.inspect().synchronous, 2); assert.equal(f.intents.inspect().synchronous, 2);
  assert.equal(g.state, 'preparing'); assert.equal(inspect(f).currentRunId, g.runId);
  await assert.rejects(f.principal(g), /run-revoked/);
  assert.equal(JSON.stringify(f.ledger.read()).includes('accessToken'), false);
});

test('full durable record is independently checked, including sender/selection/attachments and service identity', async t => {
  const f = await fixture(t); f.enqueue(); const g = await f.admit(), input = f.input(g);
  for (const key of ['content', 'senderAccountId', 'selectionSnapshot', 'attachments', 'runId']) {
    const changed = { ...input.prompt, [key]: 'forged' };
    await assert.rejects(f.provider.confirmRead({ ...input, prompt: changed, promptDigest: digestOf(changed) }), /complete-prompt-unverified/);
  }
  await assert.rejects(f.provider.confirmRead({ ...input, servicePrincipal: { service: 'agent', serviceKid: 'agent-test-key' } }), /service-revoked/);
  const result = await f.provider.confirmRead(input);
  assert.equal(result.confirmed, true); assert.equal(inspect(f).messages[0].queueState, 'running');
  assert.deepEqual(await f.provider.confirmRead(input), result);
  assert.equal(Object.keys(f.ledger.read().runReceiptsV2).length, 1);
  await assert.rejects(f.provider.confirmRead({ ...input, readIntentId: 'different' }), /run-request-mismatch/);
});

for (const order of ['read-first', 'exit-first']) test(`same SQLite commit order ${order}, no clock inference`, async t => {
  const f = await fixture(t); f.enqueue(); f.enqueue('queued-old'); f.enqueue('other-message', 'other');
  const g = await f.admit(); f.clock.now = -500;
  if (order === 'read-first') await f.provider.confirmRead(f.input(g));
  const event = f.exit(); f.provider.applyAccessEvent(event);
  if (order === 'read-first') {
    const p = await f.principal(g), access = await f.provider.checkAccess({ principal: p, projectId, action: 'write' });
    assert.equal(access.retainedGrant.state, 'retained'); assert.equal(access.retainedGrant.currentRun, true);
    const q = await f.provider.authorizeQuery({ principal: p, projectId, runGrantId: g.runGrantId });
    assert.equal(q.initiatorName, 'sender name'); assert.equal(q.selectionSnapshot.accountId, 'sender');
    assert.ok(Number.isSafeInteger(q.fenceRevision));
    const controls = Object.values(f.ledger.read().runControlsV2);
    assert.equal(controls[0].operationFences[0].retainedRuns[0].runGrantId, g.runGrantId);
  } else await assert.rejects(f.provider.confirmRead(f.input(g)), /credential-revoked|run-no-longer-current/);
  assert.equal(inspect(f).messages.find(m => m.messageId === 'queued-old').queueState, 'cancelled');
  assert.equal(inspect(f).messages.find(m => m.messageId === 'other-message').queueState, 'queued');
});

for (const order of ['private-first', 'exit-first']) test(`private wins ${order}; creator read exception never keeps another owner's run`, async t => {
  const f = await fixture(t); f.ledger.transaction(s => { s.projects[projectId].creatorAccountId = 'sender'; });
  f.enqueue(); f.enqueue('queued-owner', 'owner'); f.enqueue('queued-sender');
  const g = await f.admit(); await f.provider.confirmRead(f.input(g));
  if (order === 'private-first') f.privateFence();
  f.provider.applyAccessEvent(f.exit());
  if (order === 'exit-first') f.privateFence();
  assert.equal(f.ledger.read().runGrantsV2[g.runGrantId].state, 'revoked');
  assert.equal(inspect(f).messages.find(m => m.messageId === 'queued-owner').queueState, 'queued');
  assert.equal(inspect(f).messages.find(m => m.messageId === 'queued-sender').queueState, 'cancelled');
  await assert.rejects(f.principal(g), /run-no-longer-current|run-revoked/);
  f.ledger.transaction(s => { s.conversationsV2[projectId][conversationId].visibility = 'shared'; });
  await assert.rejects(f.principal(g), /run-no-longer-current|run-revoked/);
});

test('private owner exits: read receipt remains history, run is revoked', async t => {
  const f = await fixture(t); f.enqueue('owner-message', 'owner'); f.privateFence();
  const g = await f.admit(); await f.provider.confirmRead(f.input(g)); f.provider.applyAccessEvent(f.exit('owner'));
  assert.equal(f.ledger.read().runGrantsV2[g.runGrantId].state, 'revoked');
  assert.equal(Object.keys(f.ledger.read().runReceiptsV2).length, 1);
});

for (const kind of ['stop', 'delete', 'agent-disabled', 'service-revoked']) test(`${kind} terminates retained current run and never revives on reopen`, async t => {
  const f = await fixture(t); f.enqueue(); const g = await f.admit(); await f.provider.confirmRead(f.input(g)); f.provider.applyAccessEvent(f.exit());
  const control = f.provider.fence({ kind, requestId: `fence-${kind}`, projectId, ...(kind === 'stop' ? { runId: g.runId } : {}),
    ...(kind === 'service-revoked' ? { serviceKid: servicePrincipal.serviceKid } : {}) });
  assert.equal(control.state, 'pending'); assert.deepEqual(control.revoked, [g.runGrantId]);
  assert.throws(() => f.provider.acknowledgeControl({ requestId: control.requestId, receipt: { complete: true } }), /verifier-unavailable/);
  assert.throws(() => f.provider.acknowledgeControl({ requestId: control.requestId, receipt: { complete: true } }, () => false), /incomplete/);
  assert.equal(f.ledger.read().runGrantsV2[g.runGrantId].state, 'revoked');
  await assert.rejects(f.principal(g), /run-no-longer-current|run-revoked/);
});

test('run references cannot alter any actor/project/service binding; normal finish releases FIFO only once', async t => {
  const f = await fixture(t); f.enqueue(); f.enqueue('second', 'other'); const g = await f.admit();
  await f.provider.confirmRead(f.input(g)); const p = await f.principal(g);
  for (const k of ['accountId', 'loginId', 'credentialId', 'loginGeneration', 'messageId', 'runId', 'conversationId', 'runGrantId', 'serviceKid', 'projectId'])
    await assert.rejects(f.provider.checkAccess({ principal: { ...p, [k]: 'wrong' }, projectId, action: 'write' }), /mismatch|invalid/);
  await f.provider.finish({ ...f.input(g), requestId: 'finish1' });
  assert.equal(inspect(f).currentRunId, null); assert.equal(inspect(f).messages[1].queueState, 'queued');
  const g2 = await f.admit('admit2'); assert.equal(g2.accountId, 'other'); assert.notEqual(g2.runGrantId, g.runGrantId);
});

test('read ACK loss queries exact durable request and executes once; replayed ACK after private cannot start', async t => {
  const f = await fixture(t); f.enqueue(); const g = await f.admit(), input = f.input(g);
  const intent = f.intents.prepare({ requestId: input.requestId, binding: input, prompt: input.prompt });
  let calls = 0;
  const transport = { ...f.transport, confirmRead: async args => { await f.transport.confirmRead(args); throw new Error('lost ACK'); } };
  await f.intents.confirm(intent.readIntentId, transport);
  const authorize = async () => f.provider.checkAccess({ principal: await f.principal(g), projectId, action: 'write' });
  const execute = async () => { calls++; return 'executed'; };
  assert.equal(await f.intents.executeOnce(intent.readIntentId, { authorize, execute }), 'executed');
  await assert.rejects(f.intents.executeOnce(intent.readIntentId, { authorize, execute }), /not-confirmed/);
  assert.equal(calls, 1);
});

test('unknown ACK or private after confirmed ACK makes zero model calls', async t => {
  const f = await fixture(t); f.enqueue(); const g = await f.admit(), input = f.input(g);
  const intent = f.intents.prepare({ requestId: input.requestId, binding: input, prompt: input.prompt });
  let calls = 0; const execute = async () => { calls++; };
  await assert.rejects(f.intents.confirm(intent.readIntentId, { confirmRead: async () => { throw new Error('offline'); }, queryRead: async () => ({ confirmed: false }) }), /unknown/);
  await assert.rejects(f.intents.executeOnce(intent.readIntentId, { authorize: async () => ({ allowed: true }), execute }), /not-confirmed/);
  await f.intents.confirm(intent.readIntentId, f.transport); f.privateFence();
  await assert.rejects(f.intents.executeOnce(intent.readIntentId, { authorize: async () => f.provider.checkAccess({ principal: await f.principal(g), projectId, action: 'write' }), execute }));
  assert.equal(calls, 0);
});

test('real async credential gap cannot admit after durable exit', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, { verifySender: async ref => { entered.resolve(); await release.promise; return { ...ref, accountEventSeq: 0 }; } });
  f.enqueue(); const pending = f.admit(); await entered.promise; f.exit(); release.resolve();
  await assert.rejects(pending, /credential-revoked/); assert.equal(inspect(f).currentRunId, null);
});
