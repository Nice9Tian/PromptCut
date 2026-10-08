import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunAssetClosure } from '../hosted/run-assets-closure.mjs';

const receipt = { leaseId: 'asset-lease:one', receiptId: 'receipt-one', complete: true, evidenceDigest: 'a'.repeat(64) };
const binding = { projectId: 'project-A', runGrantId: 'grant-one', instanceId: 'agent-os-one', instanceGeneration: 1 };
const lease = { leaseId: receipt.leaseId, resource: { projectId: binding.projectId }, grantBinding: binding };
const observer = { socket: { destroyed: false }, assetInstanceId: 'asset-os-one', serviceIdentity: 'asset-service-one' };
const identity = () => ({ instanceId: 'asset-os-one', serviceIdentity: 'asset-service-one', state: 'running' });

test('closure compares the independent persisted receipt, exact binding and current observer again after await', async () => {
  let live = true, resume;
  const client = { identity,
    async closureWitness() { await new Promise(resolve => { resume = resolve; });
      return { assetInstanceId: 'asset-os-one', serviceIdentity: 'asset-service-one', receipt, binding }; },
    async controlWitness(eventId) { return { assetInstanceId: 'asset-os-one', serviceIdentity: 'asset-service-one',
      receipt: { eventId, complete: true } }; } };
  const verifier = createRunAssetClosure({ privateClient: client,
    currentAsset: () => live ? { assetInstanceId: 'asset-os-one', serviceIdentity: 'asset-service-one' } : null });
  const first = verifier.verifyLeaseClosure({ observer, lease, receipt });
  while (!resume) await Promise.resolve();
  resume(); assert.equal(await first, true);
  resume = null;
  const changed = verifier.verifyLeaseClosure({ observer, lease, receipt });
  while (!resume) await Promise.resolve();
  live = false; resume();
  await assert.rejects(changed, error => error.code === 'asset-resource-closure-pending');
});

test('a closure body cannot authorize itself: missing or changed witness remains pending', async () => {
  const verifier = createRunAssetClosure({ currentAsset: () => ({ assetInstanceId: 'asset-os-one', serviceIdentity: 'asset-service-one' }),
    privateClient: { identity,
      closureWitness: async () => ({ assetInstanceId: 'asset-os-one', serviceIdentity: 'asset-service-one',
        receipt: { ...receipt, receiptId: 'forged' }, binding }),
      controlWitness: async () => ({ assetInstanceId: 'asset-os-one', serviceIdentity: 'asset-service-one', receipt: null }) } });
  await assert.rejects(verifier.verifyLeaseClosure({ observer, lease, receipt }), error => error.code === 'asset-resource-closure-pending');
  await assert.rejects(verifier.verifyControlReceipt({ observer, event: { eventId: 'event-one' },
    receipt: { eventId: 'event-one', complete: true } }), error => error.code === 'asset-resource-closure-pending');
});
