import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { digestOf } from '../account/ledger.mjs';
import { runFixture, servicePrincipal, projectId, conversationId } from './run-authority-fixture.mjs';

async function ready(t) {
  const f = await runFixture();
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
