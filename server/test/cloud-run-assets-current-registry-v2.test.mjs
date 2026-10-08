import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digestOf, openAccountLedger } from '../account/ledger.mjs';
import { assetClosureUnitV2, validateAssetRootHistoryV2 } from '../hosted/asset-root-registry-schema-v2.mjs';
import { readRootRunAssetCandidateV2, readRootAssetReservationV2,
  assertRunAssetCheckpointTransitionV2, createRunAssetCurrentRegistryV2 } from '../hosted/run-assets-current-registry-v2.mjs';
import { startHostedAssetService } from '../hosted/asset-runtime.mjs';

const expected = { authorityId: 'doc-v2-test', serviceIdentity: 'asset-v2-test', uid: 12001, unit: 'asset-test.service',
  clientFingerprint256: '1'.repeat(64), serverFingerprint256: '2'.repeat(64),
  closurePolicy: { kind: 'systemd-slice', unitNamespace: 'pcassettest', cgroupRoot: '/sys/fs/cgroup',
    placement: 'direct-child', singleEpoch: true } };
const bootId = '11111111-1111-1111-1111-111111111111';
const clone = structuredClone;
function fixture(length = 2) {
  const entries = []; let anchor;
  for (let epoch = 1; epoch <= length; epoch++) {
    const instanceId = `asset-${epoch}`, scopeId = String(epoch).padStart(32, '0');
    const unit = assetClosureUnitV2(expected, { epoch, scopeId });
    const closureScope = { scopeId, authorityId: expected.authorityId, epoch, instanceId, kind: 'systemd-slice', unit,
      unitInvocationId: String(epoch * 2).padStart(32, '0'), bootId,
      cgroup: { v2Path: `/sys/fs/cgroup/${unit}`, dev: '30', ino: String(100 + epoch), bootId } };
    const instance = { instanceId, bootId, pid: 1000 + epoch, pidBirth: { bootId, startTicks: String(10000 + epoch) },
      uid: expected.uid, unit: expected.unit, unitInvocationId: String(epoch * 2 + 1).padStart(32, '0'),
      cgroup: { v2Path: `${closureScope.cgroup.v2Path}/${expected.unit}`, dev: '30', ino: String(200 + epoch), bootId },
      serviceIdentity: expected.serviceIdentity, clientFingerprint256: expected.clientFingerprint256,
      serverFingerprint256: expected.serverFingerprint256 };
    const old = entries.at(-1)?.record;
    const witness = old ? { v: 2, protocol: 'promptcut.asset-os-closure.v2', witnessId: `witness-${epoch}`,
      authorityId: expected.authorityId, fromEpoch: epoch - 1, toEpoch: epoch, previousRegistry: clone(old),
      observed: { kind: 'cgroup-empty', closed: true, at: 100, bootId, serviceInstance: clone(old.instance),
        closureScope: clone(old.closureScope), scopeActive: true, scopeExclusive: true, populated: 0,
        serviceInactive: true, mainBirthGone: true } } : null;
    const record = { v: 2, authorityId: expected.authorityId, serviceId: 'asset', epoch, state: 'active', instance,
      closureScope, previous: old ? { epoch: epoch - 1, registryDigest: digestOf(old), instance: clone(old.instance),
        closureScope: clone(old.closureScope), closureWitnessDigest: digestOf(witness) } : null };
    const reservation = { v: 2, protocol: 'promptcut.asset-root-reservation.v2', ...clone(expected), epoch, instanceId,
      serviceCgroupPath: instance.cgroup.v2Path, closureScope: clone(closureScope) };
    anchor ??= { v: 2, protocol: 'promptcut.asset-root-anchor.v2', ...clone(expected), firstEpoch: 1,
      firstRegistryDigest: digestOf(record) };
    const publication = { v: 2, protocol: 'promptcut.asset-root-publication.v2', authorityId: expected.authorityId,
      epoch, registryDigest: digestOf(record), anchorDigest: digestOf(anchor),
      closureWitnessDigest: witness ? digestOf(witness) : null, reservationDigest: digestOf(reservation) };
    entries.push({ record, reservation, witness, publication });
  }
  const record = entries.at(-1).record;
  return { record, anchor, entries, checkpoint: validateAssetRootHistoryV2({ entries, currentRecord: record,
    anchor, expected, publisherLocked: false }) };
}
const denied = (fn, code) => assert.throws(fn, error => error.status === 503 && error.code === code);

test('v2 checkpoint starts only at epoch 1 and advances over complete witnessed history', () => {
  const first = fixture(1), later = fixture(3);
  assert.equal(assertRunAssetCheckpointTransitionV2(null, first, expected).epoch, 1);
  assert.equal(assertRunAssetCheckpointTransitionV2(first.checkpoint, later, expected).epoch, 3);
  assert.equal(assertRunAssetCheckpointTransitionV2(later.checkpoint, later, expected).epoch, 3);
  denied(() => assertRunAssetCheckpointTransitionV2(null, later, expected), 'asset-root-v2-anchor-invalid');
  denied(() => assertRunAssetCheckpointTransitionV2({ ...first.checkpoint, recordDigest: '0'.repeat(64) }, later, expected),
    'asset-root-v2-checkpoint-invalid');
  denied(() => assertRunAssetCheckpointTransitionV2({ ...first.checkpoint, v: 1 }, later, expected),
    'asset-root-v2-checkpoint-invalid');
  denied(() => assertRunAssetCheckpointTransitionV2(later.checkpoint, first, expected),
    'asset-root-v2-epoch-unaccepted');
});

test('v2 reader requires an explicit root anchor digest and never self-accepts a visible record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-asset-v2-reader-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'ledger.sqlite'), authorityId: expected.authorityId });
  const files = { registryFile: path.join(dir, 'current.json'), anchorFile: path.join(dir, 'anchor.json'),
    reservationFile: path.join(dir, 'reservation.json'), publisherLockFile: path.join(dir, '.publisher.lock') };
  try {
    denied(() => createRunAssetCurrentRegistryV2({ ledger, files, expected }), 'asset-root-v2-checkpoint-unconfigured');
    const access = createRunAssetCurrentRegistryV2({ ledger, files, expected, configuredAnchorDigest: 'a'.repeat(64) });
    denied(() => access.current(), 'asset-root-v2-epoch-unaccepted');
    if (process.platform !== 'linux') {
      denied(() => access.acceptCurrent(), 'asset-root-v2-unavailable');
      denied(() => readRootRunAssetCandidateV2({ files, expected, configuredAnchorDigest: 'a'.repeat(64) }),
        'asset-root-v2-unavailable');
      denied(() => readRootAssetReservationV2({ reservationFile: files.reservationFile, expected }),
        'asset-root-v2-unavailable');
    }
    assert.equal(ledger.read().runAssetCurrentCheckpointV2, undefined);
    ledger.transaction(state => { state.runAssetCurrentCheckpointV1 = { v: 1 }; });
    denied(() => access.current(), 'asset-root-v2-v1-migration-required');
  } finally { ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('v2 checkpoint uses a separate durable SQLite key and survives doc reopen without authorizing absent root files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-asset-v2-ledger-'));
  const file = path.join(dir, 'ledger.sqlite'), first = fixture(1);
  let ledger = openAccountLedger({ file, authorityId: expected.authorityId });
  try {
    ledger.transaction(state => { state.runAssetCurrentCheckpointV2 = assertRunAssetCheckpointTransitionV2(null, first, expected); });
    assert.equal(ledger.read().runAssetCurrentCheckpointV1, undefined);
    ledger.close(); ledger = openAccountLedger({ file, authorityId: expected.authorityId });
    assert.deepEqual(ledger.read().runAssetCurrentCheckpointV2, first.checkpoint);
    const files = { registryFile: path.join(dir, 'current.json'), anchorFile: path.join(dir, 'anchor.json'),
      reservationFile: path.join(dir, 'reservation.json'), publisherLockFile: path.join(dir, '.publisher.lock') };
    const access = createRunAssetCurrentRegistryV2({ ledger, files, expected, configuredAnchorDigest: digestOf(first.anchor) });
    assert.throws(() => access.current(), error => error.status === 503 && error.code.startsWith('asset-root-v2-'));
  } finally { ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('asset runtime rejects unsupported protocol and missing v2 reservation before any listener', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-asset-v2-reservation-'));
  const base = { dataDir: dir, internalPort: 6553, docFingerprint256: 'a'.repeat(64),
    internalTls: { key: 'fixture', cert: 'fixture', ca: 'fixture' }, serviceIdentity: expected.serviceIdentity };
  const runAssets = { agentFingerprint256: 'b'.repeat(64), resolveAgentTransport: () => null,
    timeoutMs: 1, maxResponseBytes: 1, maxBodyBytes: 1 };
  try {
    await assert.rejects(startHostedAssetService({ ...base, runAssets: { ...runAssets, rootProtocol: 'v3' } }),
      error => error.status === 503 && error.code === 'asset-root-protocol-unsupported');
    await assert.rejects(startHostedAssetService({ ...base, runAssets: { ...runAssets, rootProtocol: 'v2' } }),
      error => error.status === 503 && error.code === 'asset-root-v2-reservation-required');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
