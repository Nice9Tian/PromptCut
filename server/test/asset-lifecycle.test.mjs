import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openAssetLifecycle } from '../hosted/asset-lifecycle.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

test('unclean实例缺可信fence拒启；fixture关闭证明绑定上一instance/pid/cert，不能复用', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-lifecycle-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pki = assetWiringPki(root), config = { root, cert: pki.asset.cert };
  const first = await openAssetLifecycle({ ...config, instanceId: 'first' });
  await assert.rejects(openAssetLifecycle({ ...config, instanceId: 'second' }), { code: 'asset-recovery-required' });
  const recoveryFence = path.join(root, 'fence.json');
  const proof = { v: 1, serviceId: 'asset', previousInstanceId: 'first', previousPid: first.state.pid,
    previousServiceFingerprint256: first.state.fingerprint256, closed: true, observedAt: Date.now(), kind: 'owned-tree-close', scope: 'test-owned-child' };
  await fs.writeFile(recoveryFence, JSON.stringify({ ...proof, previousInstanceId: 'wrong' }));
  await assert.rejects(openAssetLifecycle({ ...config, instanceId: 'second', recoveryFence, allowFixtureRecoveryFence: true }), { code: 'asset-recovery-required' });
  await fs.writeFile(recoveryFence, JSON.stringify(proof));
  const second = await openAssetLifecycle({ ...config, instanceId: 'second', recoveryFence, allowFixtureRecoveryFence: true });
  await assert.rejects(openAssetLifecycle({ ...config, instanceId: 'third', recoveryFence, allowFixtureRecoveryFence: true }), { code: 'asset-recovery-required' });
  await second.closeClean();
  const third = await openAssetLifecycle({ ...config, instanceId: 'third' }); await third.closeClean();
  assert.equal(JSON.parse(await fs.readFile(first.file)).state, 'clean');
});
