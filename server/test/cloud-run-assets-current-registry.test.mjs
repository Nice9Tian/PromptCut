import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestOf } from '../account/ledger.mjs';
import { validateRunAssetCurrentRecord, readRootRunAssetCurrent } from '../hosted/run-assets-current-registry.mjs';

const bootId = '11111111-2222-3333-4444-555555555555';
const pin = char => char.repeat(64);
const instance = (id, pid = 1201) => ({ instanceId: id, bootId, pid,
  pidBirth: { bootId, startTicks: String(pid * 101) }, uid: 1050, unit: 'promptcut-asset.service',
  unitInvocationId: 'd'.repeat(32), cgroup: { v2Path: '/sys/fs/cgroup/system.slice/promptcut-asset.service',
    dev: '1001', ino: String(pid * 10), bootId }, serviceIdentity: 'asset-service',
  clientFingerprint256: pin('a'), serverFingerprint256: pin('b') });
const expected = value => ({ authorityId: 'doc-one', serviceIdentity: value.serviceIdentity,
  clientFingerprint256: value.clientFingerprint256, serverFingerprint256: value.serverFingerprint256,
  uid: value.uid, unit: value.unit, cgroupPath: value.cgroup.v2Path });
const record = (epoch, value, previous = null, state = 'active') =>
  ({ v: 1, authorityId: 'doc-one', serviceId: 'asset', epoch, state, instance: value, previous });
const anchor = first => ({ v: 1, protocol: 'promptcut.asset-root-anchor.v1', authorityId: 'doc-one',
  firstEpoch: 1, firstRegistryDigest: digestOf(first), serviceIdentity: first.instance.serviceIdentity,
  uid: first.instance.uid, unit: first.instance.unit, cgroupPath: first.instance.cgroup.v2Path,
  clientFingerprint256: first.instance.clientFingerprint256, serverFingerprint256: first.instance.serverFingerprint256 });
const snapshot = (current, trustAnchor, witness = null) => ({ record: current, witness, trustAnchor,
  expected: expected(current.instance), checkpoint: { v: 1, authorityId: 'doc-one', epoch: current.epoch,
    recordDigest: digestOf(current), anchorDigest: digestOf(trustAnchor) } });
const denied = (input, code) => assert.throws(() => validateRunAssetCurrentRecord(input), error => error.code === code);

test('accepted root anchor and checkpoint bind the full immutable OS process identity', () => {
  const first = record(1, instance('asset-one')), trustAnchor = anchor(first), accepted = snapshot(first, trustAnchor);
  assert.equal(validateRunAssetCurrentRecord(accepted).instance.instanceId, 'asset-one');
  denied({ ...accepted, checkpoint: undefined }, 'asset-current-anchor-invalid');
  denied({ ...accepted, checkpoint: { ...accepted.checkpoint, epoch: 2 } }, 'asset-current-epoch-unaccepted');
  denied({ ...accepted, record: { ...first, instance: { ...first.instance, pid: 1202 } } }, 'asset-current-registry-changed');
  denied({ ...accepted, record: record(1, first.instance, null, 'preparing') }, 'asset-current-inactive');
  denied({ ...accepted, record: record(1, first.instance, null, 'closed') }, 'asset-current-inactive');
  denied({ ...accepted, expected: { ...accepted.expected, uid: 999 } }, 'asset-current-registry-invalid');
  denied({ ...accepted, record: { ...first, instance: { ...first.instance, pidBirth: { bootId, startTicks: '0' } } } },
    'asset-current-registry-invalid');
  denied({ ...accepted, record: { ...first, instance: { ...first.instance,
    cgroup: { ...first.instance.cgroup, v2Path: '/sys/fs/cgroup/../other' } } } }, 'asset-current-registry-invalid');
});

test('next epoch needs full prior registry and root witness content, not a digest-shaped field', () => {
  const first = record(1, instance('asset-one')), trustAnchor = anchor(first), next = instance('asset-two', 1202);
  const witness = { v: 1, protocol: 'promptcut.asset-os-closure.v1', witnessId: 'witness-one', authorityId: 'doc-one',
    fromEpoch: 1, toEpoch: 2, previousRegistry: first,
    observed: { kind: 'cgroup-empty', closed: true, at: 1700000000000, bootId,
      cgroup: first.instance.cgroup, unitInvocationId: first.instance.unitInvocationId,
      pidBirth: first.instance.pidBirth } };
  const current = record(2, next, { epoch: 1, registryDigest: digestOf(first), instance: first.instance,
    closureWitnessDigest: digestOf(witness) });
  const accepted = snapshot(current, trustAnchor, witness);
  assert.equal(validateRunAssetCurrentRecord(accepted).epoch, 2);
  denied({ ...accepted, witness: { ...witness, previousRegistry: { ...first, instance: { ...first.instance, pid: 7 } } } },
    'asset-current-witness-invalid');
  denied({ ...accepted, witness: { ...witness, observed: { ...witness.observed, at: 1700000000001 } } },
    'asset-current-witness-invalid');
  denied({ ...accepted, witness: { ...witness, observed: { ...witness.observed, closed: false } } },
    'asset-current-witness-invalid');
  denied({ ...accepted, witness: null }, 'asset-current-witness-invalid');
  denied({ ...accepted, checkpoint: { ...accepted.checkpoint, epoch: 1 } }, 'asset-current-epoch-unaccepted');
});

test('untrusted local platform cannot act as root-owned production registry', { skip: process.platform === 'linux' }, () => {
  assert.throws(() => readRootRunAssetCurrent({ registryFile: 'C:/temp/not-a-root-registry', expected: {}, checkpoint: {} }),
    error => error.code === 'asset-current-registry-unavailable');
});
