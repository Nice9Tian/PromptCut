import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { digestOf } from '../account/ledger.mjs';
import { runFixture, servicePrincipal, projectId, conversationId } from './run-authority-fixture.mjs';

async function ready(t) {
  const f = await runFixture();
  t.after(() => { f.close(); fs.rmSync(f.dir, { recursive: true }); });
  f.enqueue(); f.enqueue('message2');
  const grant = await f.admit(), read = await f.provider.confirmRead(f.input(grant));
  const body = { ...Object.fromEntries(['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId'].map(k => [k, grant[k]])),
    servicePrincipal, requestId: `finish:${grant.runGrantId}`, readReceiptId: read.receipt.receiptId,
    outcome: { v: 1, status: 'failed', eventId: 'terminal1', eventDigest: digestOf({ type: 'error', code: 'model-error' }) } };
  return { f, grant, body, result: await f.provider.finish(body) };
}

test('terminal outcome creates its own closing control without cancelling or releasing FIFO', async t => {
  const { f, grant, result } = await ready(t);
  const control = f.ledger.read().runControlsV2[result.finishReceipt.controlId];
  assert.ok(control, 'normal outcome needs a durable closing target');
  assert.equal(control.kind, 'terminal');
  assert.deepEqual(control.revoked, []);
  assert.deepEqual(control.operationFences, []);
  assert.deepEqual(control.closing, [grant.runGrantId]);
  assert.equal(control.target.readReceiptId, result.finishReceipt.readReceiptId);
  assert.equal(control.target.outcomeDigest, result.finishReceipt.outcomeDigest);
  const conv = f.ledger.read().conversationsV2[projectId][conversationId];
  assert.equal(conv.currentRunId, grant.runId);
  assert.deepEqual(conv.messages.map(m => m.queueState), ['running', 'queued']);
});

test('internal finalizer cannot turn a terminal event or missing close evidence into a completed run', async t => {
  const { f, grant, result } = await ready(t);
  assert.equal(typeof f.rawProvider.finalizeFinish, 'function');
  assert.throws(() => f.rawProvider.finalizeFinish({ finishReceiptId: result.finishReceipt.finishReceiptId }),
    { code: 'run-doc-closure-pending' });
  assert.equal(f.ledger.read().conversationsV2[projectId][conversationId].currentRunId, grant.runId);
  await assert.rejects(f.admit('next-before-close'), { code: 'run-not-ready' });
});

test('finish query has a separate exact operation capability and cannot change the recorded outcome', async t => {
  const { f, body, result } = await ready(t);
  const invoke = async (input, operation = 'queryFinish') => {
    const signed = f.instances.authorize(f.agentProcess, operation, input);
    try { return await f.rawProvider.queryFinish({ ...input, servicePrincipal: signed.principal }); }
    finally { f.instances.authority.release(signed.principal.instanceSession); }
  };
  const result2 = await invoke(body);
  assert.equal(result2.recorded, true); assert.equal(result2.finishPending, true);
  assert.deepEqual(result2.finishReceipt, result.finishReceipt);
  await assert.rejects(invoke(body, 'finish'), { code: 'instance-invocation-forbidden' });
  await assert.rejects(invoke({ ...body, outcome: { ...body.outcome, status: 'done' } }), { code: 'run-request-mismatch' });
  assert.deepEqual(await invoke({ ...body, requestId: 'unrecorded' }), { recorded: false });
});

test('generic control ACK cannot bypass terminal finalizer; private fence wins without reviving current run', async t => {
  const { f, result } = await ready(t), c = f.ledger.read().runControlsV2[result.finishReceipt.controlId];
  let validatorCalled = false;
  assert.throws(() => f.rawProvider.acknowledgeControl({ controlId: c.controlId, receipt: {
    controlId: c.controlId, fenceRevision: c.fenceRevision, receiptId: 'forged', complete: true,
  } }, () => { validatorCalled = true; return true; }), { code: 'run-terminal-finalizer-required' });
  assert.equal(validatorCalled, false);
  f.privateFence();
  assert.throws(() => f.rawProvider.finalizeFinish({ finishReceiptId: result.finishReceipt.finishReceiptId }), { code: 'run-revoked' });
  const conv = f.ledger.read().conversationsV2[projectId][conversationId];
  assert.equal(conv.currentRunId, null); assert.equal(conv.messages[0].queueState, 'cancelled');
  assert.equal(f.ledger.read().runFinishReceiptsV2[result.finishReceipt.finishReceiptId].complete, false);
});
