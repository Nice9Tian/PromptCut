import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openAssetLifecycle } from '../hosted/asset-lifecycle.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

// 仅此TMP无业务资源的root操作模拟；runtime绝不提供claim清理入口。
async function clearFailedClaim(root, expectedInstanceId) {
  const claim = path.join(root, '.asset-start.claim'), record = JSON.parse(await fs.readFile(claim));
  assert.equal(record.instanceId, expectedInstanceId); assert.ok(record.nonce); await fs.rm(claim);
}
const deadline = (promise, label) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error(label)), 3000); timer.unref(); })]);

test('unclean实例缺可信fence拒启；fixture关闭证明绑定上一instance/pid/cert，不能复用', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-lifecycle-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pki = assetWiringPki(root), config = { root, cert: pki.asset.cert };
  const first = await openAssetLifecycle({ ...config, instanceId: 'first' });
  await assert.rejects(openAssetLifecycle({ ...config, instanceId: 'second' }), { code: 'asset-recovery-required' });
  await clearFailedClaim(root, 'second');
  const recoveryFence = path.join(root, 'fence.json');
  const proof = { v: 1, serviceId: 'asset', previousInstanceId: 'first', previousPid: first.state.pid,
    previousServiceFingerprint256: first.state.fingerprint256, closed: true, observedAt: Date.now(), kind: 'owned-tree-close', scope: 'test-owned-child' };
  await fs.writeFile(recoveryFence, JSON.stringify({ ...proof, previousInstanceId: 'wrong' }));
  await assert.rejects(openAssetLifecycle({ ...config, instanceId: 'second', recoveryFence, allowFixtureRecoveryFence: true }), { code: 'asset-recovery-required' });
  await clearFailedClaim(root, 'second');
  await fs.writeFile(recoveryFence, JSON.stringify(proof));
  const second = await openAssetLifecycle({ ...config, instanceId: 'second', recoveryFence, allowFixtureRecoveryFence: true });
  await assert.rejects(openAssetLifecycle({ ...config, instanceId: 'third', recoveryFence, allowFixtureRecoveryFence: true }), { code: 'asset-recovery-required' });
  await clearFailedClaim(root, 'third');
  await second.closeClean();
  const third = await openAssetLifecycle({ ...config, instanceId: 'third' }); await third.closeClean();
  assert.equal(JSON.parse(await fs.readFile(first.file)).state, 'clean');
});

test('真实fs恢复双启动：A持claim暂停旧owner读取时B在wx处busy，不能删A的新锁', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-start-race-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pki = assetWiringPki(root), config = { root, cert: pki.asset.cert };
  const previous = await openAssetLifecycle({ ...config, instanceId: 'previous' });
  const recoveryFence = path.join(root, 'fence.json');
  await fs.writeFile(recoveryFence, JSON.stringify({ v: 1, serviceId: 'asset', previousInstanceId: 'previous', previousPid: previous.state.pid,
    previousServiceFingerprint256: previous.state.fingerprint256, closed: true, observedAt: Date.now(), kind: 'owned-tree-close', scope: 'metadata-only-fixture' }));
  const original = fs.readFile, lock = path.join(root, '.asset-owner.lock');
  let reads = 0, entered, release; const blocked = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  t.mock.method(fs, 'readFile', async (file, ...args) => { const value = await original(file, ...args); if (path.resolve(file) === lock && ++reads === 1) { entered(); await gate; } return value; });
  const options = { ...config, recoveryFence, allowFixtureRecoveryFence: true };
  const aPromise = openAssetLifecycle({ ...options, instanceId: 'next-a' }); aPromise.catch(() => {});
  try {
    await deadline(blocked, 'A did not enter old-owner read');
    const claim = JSON.parse(await original(path.join(root, '.asset-start.claim'))); assert.equal(claim.instanceId, 'next-a'); assert.equal(claim.phase, 'starting'); assert.ok(claim.nonce);
    await assert.rejects(deadline(openAssetLifecycle({ ...options, instanceId: 'next-b' }), 'B must reject before old-owner read'), { code: 'asset-instance-busy' });
    assert.equal(reads, 1, 'B never enters the root counterexample second-read barrier');
    release(); const a = await deadline(aPromise, 'A did not finish');
    assert.equal(JSON.parse(await original(a.file)).instanceId, 'next-a'); assert.equal(JSON.parse(await original(lock)).instanceId, 'next-a');
    await assert.rejects(fs.stat(path.join(root, '.asset-start.claim')), { code: 'ENOENT' }); await a.closeClean();
  } finally { release(); await aPromise.catch(() => {}); }
});

test('真实fs正常close与新启动：clean marker已落盘但owner未移除时claim仍排除B', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-close-race-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pki = assetWiringPki(root), config = { root, cert: pki.asset.cert }, a = await openAssetLifecycle({ ...config, instanceId: 'a' });
  const original = fs.rm, lock = path.join(root, '.asset-owner.lock');
  let entered, release; const blocked = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  t.mock.method(fs, 'rm', async (file, ...args) => { if (path.resolve(file) === lock) { entered(); await gate; } return original(file, ...args); });
  const closing = a.closeClean(); closing.catch(() => {});
  try {
    await deadline(blocked, 'A close did not reach owner unlink'); assert.equal(JSON.parse(await fs.readFile(a.file)).state, 'clean');
    await assert.rejects(deadline(openAssetLifecycle({ ...config, instanceId: 'b' }), 'B must reject during closing claim'), { code: 'asset-instance-busy' });
    assert.equal(JSON.parse(await fs.readFile(lock)).instanceId, 'a');
    release(); await deadline(closing, 'A close did not finish');
    const b = await openAssetLifecycle({ ...config, instanceId: 'b' }); assert.equal(JSON.parse(await fs.readFile(lock)).instanceId, 'b'); await b.closeClean();
  } finally { release(); await closing.catch(() => {}); }
});

test('持claim后恢复失败必须留证；后续启动busy且不能覆盖nonce或自动清理', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-claim-left-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pki = assetWiringPki(root), config = { root, cert: pki.asset.cert }, old = await openAssetLifecycle({ ...config, instanceId: 'old' }); await old.closeClean();
  await fs.writeFile(path.join(root, '.asset-owner.lock'), 'broken-old-owner');
  await assert.rejects(openAssetLifecycle({ ...config, instanceId: 'failed' }), { code: 'asset-instance-busy' });
  const claimFile = path.join(root, '.asset-start.claim'), before = await fs.readFile(claimFile, 'utf8'); assert.equal(JSON.parse(before).instanceId, 'failed');
  await assert.rejects(openAssetLifecycle({ ...config, instanceId: 'later' }), { code: 'asset-instance-busy' }); assert.equal(await fs.readFile(claimFile, 'utf8'), before);
});
