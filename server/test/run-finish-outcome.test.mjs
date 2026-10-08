import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { digestOf, openAccountLedger } from '../account/ledger.mjs';
import { createRunAuthority, validateRunFinishInput } from '../account/run-authority.mjs';
import { instanceFixture } from './agent-instance-fixture.mjs';
import { runFixture, servicePrincipal, projectId, conversationId } from './run-authority-fixture.mjs';

async function ready(t, options) {
  const f = await runFixture(options);
  t.after(() => { f.close(); fs.rmSync(f.dir, { recursive: true }); });
  f.enqueue(); const grant = await f.admit();
  const read = await f.provider.confirmRead(f.input(grant));
  const input = (status = 'done') => {
    const event = { eventId: `event:${grant.runGrantId}:1`, event: { type: status === 'failed' ? 'error' : 'done', status } };
    return { ...Object.fromEntries(['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId'].map(k => [k, grant[k]])),
      servicePrincipal, requestId: `finish:${grant.runGrantId}`, readReceiptId: read.receipt.receiptId,
      outcome: { v: 1, status, eventId: event.eventId, eventDigest: digestOf(event) } };
  };
  return { f, grant, read, input };
}

test('legacy finish without terminal evidence cannot release FIFO as successful', async t => {
  const { f, input } = await ready(t);
  const legacy = input(); delete legacy.outcome; delete legacy.readReceiptId;
  await assert.rejects(f.provider.finish(legacy), { code: 'run-outcome-required' });
  assert.equal(f.ledger.read().conversationsV2[projectId][conversationId].messages[0].queueState, 'running');
});

test('model error event plus resolved donePromise records failed outcome, never done or closed', async t => {
  const { f, grant, input } = await ready(t);
  // Controlled runner events, no model call: this reproduces the old settlement
  // contract while all provider/SQLite/RAM signatures remain real modules.
  const events = new EventEmitter(); let observed;
  events.on('event', value => { observed = value; });
  const donePromise = Promise.resolve(); events.emit('event', { type: 'error', code: 'model-failed' }); await donePromise;
  assert.equal(observed.type, 'error');
  const result = await f.provider.finish(input('failed'));
  assert.equal(result.finishPending, true); assert.equal(result.finishReceipt.complete, false);
  assert.equal(result.finishReceipt.outcome.status, 'failed');
  const state = f.ledger.read(), c = state.conversationsV2[projectId][conversationId];
  assert.equal(c.currentRunId, grant.runId); assert.equal(c.messages[0].queueState, 'running');
  assert.notEqual(state.runGrantsV2[grant.runGrantId].state, 'finished');
});

test('finish invocation capability binds outcome and read receipt, not only the outer HTTP signature', async t => {
  const { f, input } = await ready(t), original = input('failed');
  const invocation = f.instances.authorize(f.agentProcess, 'finish', original);
  try {
    await assert.rejects(f.rawProvider.finish({ ...original, outcome: input('done').outcome,
      servicePrincipal: invocation.principal }), { code: 'instance-invocation-forbidden' });
  } finally { f.instances.authority.release(invocation.principal.instanceSession); }
});

for (const status of ['done', 'failed', 'interrupted']) test(`explicit ${status} is immutable/idempotent but cannot release FIFO without closure`, async t => {
  const { f, grant, input } = await ready(t), body = input(status);
  const principal = await f.principal(grant);
  const first = await f.provider.finish(body), clock = f.ledger.read().runClockV2;
  assert.deepEqual(await f.provider.finish(body), first);
  assert.equal(f.ledger.read().runClockV2, clock);
  assert.equal(first.finishReceipt.outcomeDigest, digestOf(body.outcome));
  assert.equal(first.finishReceipt.readReceiptId, body.readReceiptId);
  assert.equal(first.finishReceipt.instanceId, grant.instanceId);
  assert.equal(first.finishReceipt.instanceGeneration, grant.instanceGeneration);
  await assert.rejects(f.provider.finish({ ...body, outcome: input(status === 'done' ? 'failed' : 'done').outcome }), { code: 'run-request-mismatch' });
  await assert.rejects(f.provider.finish({ ...body, requestId: 'other-finish' }), { code: 'run-finish-conflict' });
  await assert.rejects(f.provider.checkAccess({ principal, projectId, action: 'write' }), { code: 'run-finishing' });
  await assert.rejects(f.provider.checkAccess({ principal, projectId, action: 'read' }), { code: 'run-finishing' });
  await assert.rejects(f.admit('next-run'), { code: 'run-not-ready' });
  assert.equal(f.ledger.read().conversationsV2[projectId][conversationId].currentRunId, grant.runId);
});

test('wrong read receipt, full binding, instance and unsupported outcome never create a terminal receipt', async t => {
  const { f, input } = await ready(t), body = input();
  await assert.rejects(f.provider.finish({ ...body, readReceiptId: 'other-read' }), { code: 'run-read-receipt-mismatch' });
  await assert.rejects(f.provider.finish({ ...body, messageId: 'other-message' }), { code: 'run-binding-mismatch' });
  const second = f.instances.boot(), auth = f.instances.authorize(second, 'finish', body);
  try { await assert.rejects(f.rawProvider.finish({ ...body, servicePrincipal: auth.principal }), { code: 'run-instance-mismatch' }); }
  finally { f.instances.authority.release(auth.principal.instanceSession); }
  assert.throws(() => validateRunFinishInput({ ...body, outcome: { ...body.outcome, status: 'unknown' } }, { allowServicePrincipal: true }), { code: 'run-outcome-unknown' });
  for (const extra of [{ closed: true }, { completed: true }, { arbitrary: 'value' }])
    await assert.rejects(f.provider.finish({ ...body, outcome: { ...body.outcome, ...extra } }), { code: 'invalid-run-outcome' });
  assert.equal(Object.keys(f.ledger.read().runFinishReceiptsV2).length, 0);
});

test('finish commit ACK loss replays exact durable outcome; a fresh provider can read it with the original RAM key', async t => {
  let lose = true;
  const { f, input } = await ready(t, { failpoint: point => {
    if (point === 'run-finish-after-commit' && lose) { lose = false; throw Error('lost-finish-ack'); }
  } });
  const body = input('failed'); await assert.rejects(f.provider.finish(body), /lost-finish-ack/);
  const first = await f.provider.finish(body);
  const reopened = openAccountLedger({ file: path.join(f.dir, 'doc.db'), authorityId: 'doc-run-test' });
  const instances = instanceFixture(reopened);
  const provider = createRunAuthority({ ledger: reopened, conversationHooks: f.hooks, instanceAuthority: instances.authority,
    verifySender: async ref => ({ ...ref, accountEventSeq: 0 }),
    verifyServiceInState: (_state, principal) => ({ serviceId: principal.service, serviceKid: principal.serviceKid }),
    synchronize: async () => {} });
  const connection = instances.connection();
  const signed = instances.authorize(f.agentProcess, 'finish', body, { principal: connection });
  try { assert.deepEqual(await provider.finish({ ...body, servicePrincipal: signed.principal }), first); }
  finally { instances.authority.release(signed.principal.instanceSession); instances.close(); reopened.close(); }
  assert.equal(Object.keys(f.ledger.read().runFinishReceiptsV2).length, 1);
});

test('precommit failure rolls back the terminal receipt and does not invent a closed run', async t => {
  const { f, grant, input } = await ready(t, { failpoint: point => {
    if (point === 'run-finish-before-commit') throw Error('finish-before-commit');
  } });
  await assert.rejects(f.provider.finish(input()), /finish-before-commit/);
  const state = f.ledger.read();
  assert.equal(Object.keys(state.runFinishReceiptsV2).length, 0);
  assert.equal(state.runGrantsV2[grant.runGrantId].finishReceiptId, undefined);
  assert.equal(state.conversationsV2[projectId][conversationId].currentRunId, grant.runId);
});
