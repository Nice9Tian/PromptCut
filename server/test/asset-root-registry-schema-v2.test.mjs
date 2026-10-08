import test from 'node:test';
import assert from 'node:assert/strict';
import { digestOf } from '../account/ledger.mjs';
import { assetClosureUnitV2, validateAssetRootExpectedV2, validateAssetRootRecordV2,
  validateAssetRootReservationV2, validateAssetRootHistoryV2, validateAssetRootPublicationV2,
  validateAssetRootCheckpointV2 } from '../hosted/asset-root-registry-schema-v2.mjs';

const expected = { authorityId: 'doc-v2', serviceIdentity: 'asset-v2', uid: 12001, unit: 'asset-test.service',
  clientFingerprint256: '1'.repeat(64), serverFingerprint256: '2'.repeat(64),
  closurePolicy: { kind: 'systemd-slice', unitNamespace: 'pcassettest', cgroupRoot: '/sys/fs/cgroup', placement: 'direct-child', singleEpoch: true } };
const bootId = '11111111-1111-1111-1111-111111111111';
const clone = structuredClone;
function chain(length = 2) {
  const entries = []; let anchor;
  for (let epoch = 1; epoch <= length; epoch++) {
    const instanceId = `instance-${epoch}`, scopeId = String(epoch).padStart(32, '0');
    const unit = assetClosureUnitV2(expected, { epoch, scopeId });
    const closureScope = { scopeId, authorityId: expected.authorityId, epoch, instanceId, kind: 'systemd-slice', unit,
      unitInvocationId: String(epoch * 2).padStart(32, '0'), bootId,
      cgroup: { v2Path: `/sys/fs/cgroup/${unit}`, dev: '30', ino: String(100 + epoch), bootId } };
    const instance = { instanceId, bootId, pid: 1000 + epoch, pidBirth: { bootId, startTicks: String(10000 + epoch) },
      uid: expected.uid, unit: expected.unit, unitInvocationId: String(epoch * 2 + 1).padStart(32, '0'),
      cgroup: { v2Path: `${closureScope.cgroup.v2Path}/${expected.unit}`, dev: '30', ino: String(200 + epoch), bootId },
      serviceIdentity: expected.serviceIdentity, clientFingerprint256: expected.clientFingerprint256, serverFingerprint256: expected.serverFingerprint256 };
    const old = entries.at(-1)?.record;
    const witness = old ? { v: 2, protocol: 'promptcut.asset-os-closure.v2', witnessId: `witness-${epoch}`,
      authorityId: expected.authorityId, fromEpoch: epoch - 1, toEpoch: epoch, previousRegistry: clone(old),
      observed: { kind: 'cgroup-empty', closed: true, at: 100, bootId, serviceInstance: clone(old.instance),
        closureScope: clone(old.closureScope), scopeActive: true, scopeExclusive: true, populated: 0, serviceInactive: true, mainBirthGone: true } } : null;
    const record = { v: 2, authorityId: expected.authorityId, serviceId: 'asset', epoch, state: 'active', instance, closureScope,
      previous: old ? { epoch: epoch - 1, registryDigest: digestOf(old), instance: clone(old.instance), closureScope: clone(old.closureScope),
        closureWitnessDigest: digestOf(witness) } : null };
    const reservation = { v: 2, protocol: 'promptcut.asset-root-reservation.v2', ...clone(expected), epoch, instanceId,
      serviceCgroupPath: instance.cgroup.v2Path, closureScope: clone(closureScope) };
    anchor ??= { v: 2, protocol: 'promptcut.asset-root-anchor.v2', ...clone(expected), firstEpoch: 1, firstRegistryDigest: digestOf(record) };
    const publication = { v: 2, protocol: 'promptcut.asset-root-publication.v2', authorityId: expected.authorityId, epoch,
      registryDigest: digestOf(record), anchorDigest: digestOf(anchor), closureWitnessDigest: witness ? digestOf(witness) : null,
      reservationDigest: digestOf(reservation) };
    entries.push({ record, reservation, witness, publication });
  }
  return { expected, entries, currentRecord: entries.at(-1).record, anchor, publisherLocked: false };
}

test('v2 pure validation binds two distinct tuples, immutable reservations and full contiguous history', () => {
  const c = chain(3), checkpoint = validateAssetRootHistoryV2(c), record = c.entries.at(-1).record;
  assert.equal(checkpoint.v, 2); assert.equal(checkpoint.epoch, 3);
  assert.equal(checkpoint.recordDigest, digestOf(record));
  assert.deepEqual(validateAssetRootCheckpointV2(checkpoint, { record, anchor: c.anchor, expected }), checkpoint);
  assert.notEqual(record.instance.cgroup.v2Path, record.closureScope.cgroup.v2Path);
  assert.notEqual(record.instance.unitInvocationId, record.closureScope.unitInvocationId);
  assert.deepEqual(validateAssetRootExpectedV2(expected), expected);
});

test('v2 rejects slice/service tuple substitution, prefix-only containment and foreign identity', async t => {
  for (const [name, mutate] of [
    ['slice substituted for service', r => { r.instance.cgroup = clone(r.closureScope.cgroup); }],
    ['sibling prefix', r => { r.instance.cgroup.v2Path = `${r.closureScope.cgroup.v2Path}-other/${expected.unit}`; }],
    ['nested other unit', r => { r.instance.cgroup.v2Path = `${r.closureScope.cgroup.v2Path}/other/${expected.unit}`; }],
    ['dot path', r => { r.instance.cgroup.v2Path = `${r.closureScope.cgroup.v2Path}/./${expected.unit}`; }],
    ['wrong scope epoch', r => { r.closureScope.epoch++; }],
    ['wrong authority', r => { r.closureScope.authorityId = 'other'; }],
    ['wrong instance', r => { r.closureScope.instanceId = 'other'; }],
    ['different boot', r => { r.closureScope.bootId = '22222222-2222-2222-2222-222222222222'; }],
    ['same inode', r => { r.instance.cgroup.ino = r.closureScope.cgroup.ino; }],
    ['same invocation', r => { r.instance.unitInvocationId = r.closureScope.unitInvocationId; }],
    ['zero invocation', r => { r.closureScope.unitInvocationId = '0'.repeat(32); }],
    ['extra trusted flag', r => { r.closureScope.closed = true; }],
  ]) await t.test(name, () => {
    const r = chain(1).entries[0].record; mutate(r);
    assert.throws(() => validateAssetRootRecordV2(r, { expected }));
  });
});

test('v2 rejects missing/nonempty/unknown closure facts and changed previous tuple even with recomputed witness digest', async t => {
  for (const [field, value] of [['populated', 1], ['closed', false], ['scopeActive', false], ['scopeExclusive', false],
    ['serviceInactive', false], ['mainBirthGone', false], ['kind', 'ENODEV'], ['at', 0]]) await t.test(field, () => {
    const c = chain(), e = c.entries[1]; e.witness.observed[field] = value;
    e.record.previous.closureWitnessDigest = e.publication.closureWitnessDigest = digestOf(e.witness);
    e.publication.registryDigest = digestOf(e.record);
    assert.throws(() => validateAssetRootHistoryV2(c));
  });
  const c = chain(), e = c.entries[1]; e.witness.observed.serviceInstance.pidBirth.startTicks = '99999';
  e.record.previous.closureWitnessDigest = e.publication.closureWitnessDigest = digestOf(e.witness);
  e.publication.registryDigest = digestOf(e.record);
  assert.throws(() => validateAssetRootHistoryV2(c));
});

test('v2 requires marker/unlocked gate, exact reservation and checkpoint rather than visible active alone', () => {
  const c = chain(), e = c.entries[1];
  const args = { ...e, anchor: c.anchor, expected };
  assert.throws(() => validateAssetRootPublicationV2(args));
  const cp = validateAssetRootPublicationV2({ ...args, publisherLocked: false });
  for (const key of ['recordDigest', 'anchorDigest']) assert.throws(() =>
    validateAssetRootCheckpointV2({ ...cp, [key]: 'f'.repeat(64) }, { record: e.record, anchor: c.anchor, expected }));
  const wrong = clone(e.reservation); wrong.closureScope.cgroup.ino = '987';
  assert.throws(() => validateAssetRootPublicationV2({ ...args, reservation: wrong, publisherLocked: false }));
  assert.throws(() => validateAssetRootReservationV2({ ...e.reservation, v: 1 }, { expected }));
  assert.throws(() => validateAssetRootPublicationV2({ ...args, publication: null, publisherLocked: false }));
});

test('v2 rejects history gaps, reorder, epoch truncation and all v1 forms without migration', () => {
  const c = chain(3);
  for (const entries of [[], c.entries.slice(1), c.entries.slice(0, -1), [c.entries[0], c.entries[2]], [...c.entries].reverse()])
    assert.throws(() => validateAssetRootHistoryV2({ ...c, entries }));
  for (const field of ['record', 'reservation', 'publication', 'witness']) {
    const altered = clone(c); altered.entries[1][field].v = 1;
    assert.throws(() => validateAssetRootHistoryV2(altered));
  }
  assert.throws(() => validateAssetRootHistoryV2({ ...c, anchor: { ...c.anchor, v: 1 } }));
  assert.throws(() => validateAssetRootExpectedV2({ ...expected, cgroupPath: '/sys/fs/cgroup/system.slice/old.service' }));
});

test('v2 never reuses a prior scope ID even when epoch-specific name and all digests are recomputed', () => {
  const c = chain(), e = c.entries[1], s = e.record.closureScope;
  s.scopeId = c.entries[0].record.closureScope.scopeId;
  s.unit = assetClosureUnitV2(expected, { epoch: 2, scopeId: s.scopeId });
  s.cgroup.v2Path = `/sys/fs/cgroup/${s.unit}`;
  e.record.instance.cgroup.v2Path = `${s.cgroup.v2Path}/${expected.unit}`;
  e.reservation.closureScope = clone(s); e.reservation.serviceCgroupPath = e.record.instance.cgroup.v2Path;
  e.publication.registryDigest = digestOf(e.record); e.publication.reservationDigest = digestOf(e.reservation);
  assert.throws(() => validateAssetRootHistoryV2(c), { code: 'asset-root-v2-generation-invalid' });
});
