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
