import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunAssetHeadClient } from '../hosted/run-assets-head-client.mjs';

test('each lease check requires both actual consumer cursors at A’s same-transaction heads', async () => {
  let answer = { allowed: true, accessHead: 3, runAssetHead: 8 };
  const humanConsumer = { ready: true, cursor: 3 }, runConsumer = { ready: true, cursor: 8 };
  const closed = [];
  const client = createRunAssetHeadClient({ humanConsumer, runConsumer,
    client: { openLease() { return { check: async () => answer, closeLease: async receipt => receipt,
      leaseId: 'lease-one', lost: false, close: async () => closed.push(true) }; } } });
  const lease = client.openLease({});
  assert.equal(await lease.check(), answer);
  answer = { allowed: true, accessHead: 4, runAssetHead: 8 };
  await assert.rejects(lease.check(), error => error.code === 'asset-run-head-pending');
  humanConsumer.cursor = 4;
  assert.equal(await lease.check(), answer);
  answer = { allowed: true, accessHead: 4, runAssetHead: 9 };
  await assert.rejects(lease.check(), error => error.code === 'asset-run-head-pending');
  runConsumer.cursor = 9; runConsumer.ready = false;
  await assert.rejects(lease.check(), error => error.code === 'asset-run-head-pending');
  runConsumer.ready = true;
  assert.equal(await lease.check(), answer);
  assert.equal(await lease.closeLease({ done: true }).then(value => value.done), true);
  await lease.close(); assert.equal(closed.length, 1);
});
