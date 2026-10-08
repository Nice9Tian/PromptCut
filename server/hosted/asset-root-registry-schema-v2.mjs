/** Pure v2 syntax/binding validation, shared by external root producer and doc.
 * Accepting booleans here is NOT OS attestation: callers must first authenticate
 * root-owned files, publication durability/exclusion and their trust anchor.
 * V1 is deliberately unsupported; no filesystem, network or checkpoint writes.
 */
import path from 'node:path';
import { digestOf } from '../account/ledger.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const same = (a, b) => digestOf(a) === digestOf(b);
const ref = v => typeof v === 'string' && /^[A-Za-z0-9_.:@-]{1,128}$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const positive = v => Number.isSafeInteger(v) && v > 0;
const boot = v => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const counter = v => typeof v === 'string' && /^[1-9][0-9]{0,24}$/.test(v);
const invocation = v => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v) && !/^0+$/.test(v);
const scopeIdValid = v => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const EXPECTED = ['authorityId', 'serviceIdentity', 'uid', 'unit', 'clientFingerprint256', 'serverFingerprint256', 'closurePolicy'];
const INSTANCE = ['instanceId', 'bootId', 'pid', 'pidBirth', 'uid', 'unit', 'unitInvocationId', 'cgroup',
  'serviceIdentity', 'clientFingerprint256', 'serverFingerprint256'];
const SCOPE = ['scopeId', 'authorityId', 'epoch', 'instanceId', 'kind', 'unit', 'unitInvocationId', 'bootId', 'cgroup'];

function cgroup(value) {
  if (!exact(value, ['v2Path', 'dev', 'ino', 'bootId']) || !boot(value.bootId) || !counter(value.dev) || !counter(value.ino) ||
      typeof value.v2Path !== 'string' || !/^\/sys\/fs\/cgroup\/[A-Za-z0-9_.@/-]+$/.test(value.v2Path) ||
      value.v2Path.split('/').slice(1).some(p => !p || p === '.' || p === '..') ||
      path.posix.normalize(value.v2Path) !== value.v2Path) fail('asset-root-v2-cgroup-invalid');
}

export function validateAssetRootExpectedV2(value) {
  if (!exact(value, EXPECTED) || !ref(value.authorityId) || !ref(value.serviceIdentity) || !positive(value.uid) ||
      typeof value.unit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,180}\.service$/.test(value.unit) ||
      !hash(value.clientFingerprint256) || !hash(value.serverFingerprint256) ||
      !exact(value.closurePolicy, ['kind', 'unitNamespace', 'cgroupRoot', 'placement', 'singleEpoch']) ||
      value.closurePolicy.kind !== 'systemd-slice' || !/^[a-z][a-z0-9]{1,39}$/.test(value.closurePolicy.unitNamespace ?? '') ||
      value.closurePolicy.cgroupRoot !== '/sys/fs/cgroup' || value.closurePolicy.placement !== 'direct-child' ||
      value.closurePolicy.singleEpoch !== true) fail('asset-root-v2-expected-invalid');
  return structuredClone(value);
}

export function assetClosureUnitV2(expected, { epoch, scopeId }) {
  validateAssetRootExpectedV2(expected);
  if (!positive(epoch) || !scopeIdValid(scopeId)) fail('asset-root-v2-scope-invalid');
  return `${expected.closurePolicy.unitNamespace}${epoch}n${scopeId}.slice`;
}

export function validateAssetRootScopeV2(value, { expected, epoch, instanceId }) {
  const unit = assetClosureUnitV2(expected, { epoch, scopeId: value?.scopeId });
  if (!exact(value, SCOPE) || value.authorityId !== expected.authorityId || value.epoch !== epoch ||
      !ref(instanceId) || value.instanceId !== instanceId || value.kind !== 'systemd-slice' || value.unit !== unit ||
      !invocation(value.unitInvocationId) || !boot(value.bootId)) fail('asset-root-v2-scope-invalid');
  cgroup(value.cgroup);
  if (value.cgroup.bootId !== value.bootId || value.cgroup.v2Path !== `/sys/fs/cgroup/${unit}`)
    fail('asset-root-v2-scope-invalid');
  return structuredClone(value);
}

export function validateAssetRootInstanceV2(value, { expected, closureScope }) {
  validateAssetRootExpectedV2(expected);
  if (!exact(value, INSTANCE) || !ref(value.instanceId) || !boot(value.bootId) || !positive(value.pid) ||
      !exact(value.pidBirth, ['bootId', 'startTicks']) || value.pidBirth.bootId !== value.bootId ||
      !counter(value.pidBirth.startTicks) || !invocation(value.unitInvocationId)) fail('asset-root-v2-instance-invalid');
  for (const key of ['uid', 'unit', 'serviceIdentity', 'clientFingerprint256', 'serverFingerprint256'])
    if (value[key] !== expected[key]) fail('asset-root-v2-instance-invalid');
  validateAssetRootScopeV2(closureScope, { expected, epoch: closureScope?.epoch, instanceId: value.instanceId });
  cgroup(value.cgroup);
  if (value.cgroup.bootId !== value.bootId || value.bootId !== closureScope.bootId ||
      value.cgroup.v2Path !== `${closureScope.cgroup.v2Path}/${value.unit}` ||
      value.unitInvocationId === closureScope.unitInvocationId ||
      value.cgroup.dev !== closureScope.cgroup.dev || value.cgroup.ino === closureScope.cgroup.ino)
    fail('asset-root-v2-containment-invalid');
  return structuredClone(value);
}

export function validateAssetRootRecordV2(value, { expected, activeOnly = true }) {
  validateAssetRootExpectedV2(expected);
  if (!exact(value, ['v', 'authorityId', 'serviceId', 'epoch', 'state', 'instance', 'closureScope', 'previous']) ||
      value.v !== 2 || value.authorityId !== expected.authorityId || value.serviceId !== 'asset' || !positive(value.epoch) ||
      !(activeOnly ? value.state === 'active' : ['preparing', 'active', 'closed'].includes(value.state))) fail('asset-root-v2-record-invalid');
  validateAssetRootScopeV2(value.closureScope, { expected, epoch: value.epoch, instanceId: value.instance?.instanceId });
  validateAssetRootInstanceV2(value.instance, { expected, closureScope: value.closureScope });
  const p = value.previous;
  if (value.epoch === 1) { if (p !== null) fail('asset-root-v2-history-invalid'); }
  else {
    if (!exact(p, ['epoch', 'registryDigest', 'instance', 'closureScope', 'closureWitnessDigest']) ||
        p.epoch !== value.epoch - 1 || !hash(p.registryDigest) || !hash(p.closureWitnessDigest)) fail('asset-root-v2-history-invalid');
    validateAssetRootScopeV2(p.closureScope, { expected, epoch: p.epoch, instanceId: p.instance?.instanceId });
    validateAssetRootInstanceV2(p.instance, { expected, closureScope: p.closureScope });
    if (p.instance.bootId !== value.instance.bootId || p.instance.instanceId === value.instance.instanceId ||
        p.instance.unitInvocationId === value.instance.unitInvocationId || p.closureScope.scopeId === value.closureScope.scopeId ||
        p.closureScope.unitInvocationId === value.closureScope.unitInvocationId) fail('asset-root-v2-generation-invalid');
  }
  return structuredClone(value);
}

export function validateAssetRootAnchorV2(value, { expected }) {
  validateAssetRootExpectedV2(expected);
  if (!exact(value, ['v', 'protocol', ...EXPECTED, 'firstEpoch', 'firstRegistryDigest']) || value.v !== 2 ||
      value.protocol !== 'promptcut.asset-root-anchor.v2' || value.firstEpoch !== 1 || !hash(value.firstRegistryDigest))
    fail('asset-root-v2-anchor-invalid');
  for (const key of EXPECTED) if (!same(value[key], expected[key])) fail('asset-root-v2-anchor-invalid');
  return structuredClone(value);
}

export function validateAssetRootReservationV2(value, { expected }) {
  validateAssetRootExpectedV2(expected);
  if (!exact(value, ['v', 'protocol', ...EXPECTED, 'epoch', 'instanceId', 'serviceCgroupPath', 'closureScope']) || value.v !== 2 ||
      value.protocol !== 'promptcut.asset-root-reservation.v2' || !positive(value.epoch) || !ref(value.instanceId))
    fail('asset-root-v2-reservation-invalid');
  for (const key of EXPECTED) if (!same(value[key], expected[key])) fail('asset-root-v2-reservation-invalid');
  validateAssetRootScopeV2(value.closureScope, { expected, epoch: value.epoch, instanceId: value.instanceId });
  if (value.serviceCgroupPath !== `${value.closureScope.cgroup.v2Path}/${expected.unit}`) fail('asset-root-v2-containment-invalid');
  return structuredClone(value);
}

export function validateAssetRootWitnessV2(value, { expected, previousRecord, nextEpoch, bootId }) {
  validateAssetRootRecordV2(previousRecord, { expected });
  if (!exact(value, ['v', 'protocol', 'witnessId', 'authorityId', 'fromEpoch', 'toEpoch', 'previousRegistry', 'observed']) ||
      value.v !== 2 || value.protocol !== 'promptcut.asset-os-closure.v2' || !ref(value.witnessId) ||
      value.authorityId !== expected.authorityId || value.fromEpoch !== previousRecord.epoch ||
      value.toEpoch !== nextEpoch || !positive(nextEpoch) || nextEpoch !== previousRecord.epoch + 1 ||
      !same(value.previousRegistry, previousRecord)) fail('asset-root-v2-witness-invalid');
  const o = value.observed;
  if (!exact(o, ['kind', 'closed', 'at', 'bootId', 'serviceInstance', 'closureScope', 'scopeActive', 'scopeExclusive',
    'populated', 'serviceInactive', 'mainBirthGone']) || o.kind !== 'cgroup-empty' || o.closed !== true || !positive(o.at) ||
      o.bootId !== bootId || bootId !== previousRecord.instance.bootId ||
      !same(o.serviceInstance, previousRecord.instance) || !same(o.closureScope, previousRecord.closureScope) ||
      o.scopeActive !== true || o.scopeExclusive !== true || o.populated !== 0 || o.serviceInactive !== true || o.mainBirthGone !== true)
    fail('asset-root-v2-witness-invalid');
  return structuredClone(value);
}

export function validateAssetRootPublicationV2({ record, anchor, reservation, witness = null, publication, expected, publisherLocked = true }) {
  validateAssetRootRecordV2(record, { expected });
  validateAssetRootAnchorV2(anchor, { expected });
  validateAssetRootReservationV2(reservation, { expected });
  if (publisherLocked !== false || reservation.epoch !== record.epoch || reservation.instanceId !== record.instance.instanceId ||
      !same(reservation.closureScope, record.closureScope) || reservation.serviceCgroupPath !== record.instance.cgroup.v2Path ||
      !exact(publication, ['v', 'protocol', 'authorityId', 'epoch', 'registryDigest', 'anchorDigest', 'closureWitnessDigest', 'reservationDigest']) ||
      publication.v !== 2 || publication.protocol !== 'promptcut.asset-root-publication.v2' ||
      publication.authorityId !== record.authorityId || publication.epoch !== record.epoch ||
      publication.registryDigest !== digestOf(record) || publication.anchorDigest !== digestOf(anchor) ||
      publication.reservationDigest !== digestOf(reservation)) fail('asset-root-v2-publication-incomplete');
  if (record.epoch === 1) {
    if (witness !== null || publication.closureWitnessDigest !== null || anchor.firstRegistryDigest !== digestOf(record))
      fail('asset-root-v2-anchor-invalid');
  } else {
    validateAssetRootWitnessV2(witness, { expected, previousRecord: witness?.previousRegistry, nextEpoch: record.epoch, bootId: record.instance.bootId });
    const p = record.previous;
    if (p.registryDigest !== digestOf(witness.previousRegistry) || !same(p.instance, witness.previousRegistry.instance) ||
        !same(p.closureScope, witness.previousRegistry.closureScope) || p.closureWitnessDigest !== digestOf(witness) ||
        publication.closureWitnessDigest !== digestOf(witness)) fail('asset-root-v2-history-invalid');
  }
  return { v: 2, authorityId: record.authorityId, epoch: record.epoch, recordDigest: digestOf(record), anchorDigest: digestOf(anchor) };
}

export function validateAssetRootCheckpointV2(checkpoint, { record, anchor, expected }) {
  validateAssetRootRecordV2(record, { expected }); validateAssetRootAnchorV2(anchor, { expected });
  if (!exact(checkpoint, ['v', 'authorityId', 'epoch', 'recordDigest', 'anchorDigest']) || checkpoint.v !== 2 ||
      checkpoint.authorityId !== record.authorityId || checkpoint.epoch !== record.epoch ||
      checkpoint.recordDigest !== digestOf(record) || checkpoint.anchorDigest !== digestOf(anchor)) fail('asset-root-v2-checkpoint-invalid');
  return structuredClone(checkpoint);
}

/** Full ascending history from epoch 1; no partial-prefix or gap fallback. The
 * caller authenticates every immutable root file before supplying these values.
 * No checkpoint is persisted or accepted by this pure validator.
 */
export function validateAssetRootHistoryV2({ entries, currentRecord, anchor, expected, publisherLocked = true }) {
  validateAssetRootAnchorV2(anchor, { expected });
  validateAssetRootRecordV2(currentRecord, { expected });
  if (!Array.isArray(entries) || entries.length !== currentRecord.epoch || publisherLocked !== false ||
      !same(entries.at(-1)?.record, currentRecord)) fail('asset-root-v2-history-invalid');
  const ids = new Set(), units = new Set(), instances = new Set(), invocations = new Set();
  let previous = null, checkpoint;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!exact(entry, ['record', 'reservation', 'witness', 'publication']) || entry.record?.epoch !== i + 1)
      fail('asset-root-v2-history-invalid');
    checkpoint = validateAssetRootPublicationV2({ ...entry, anchor, expected, publisherLocked: false });
    const r = entry.record, s = r.closureScope;
    if (previous && !same(entry.witness.previousRegistry, previous)) fail('asset-root-v2-history-invalid');
    if (ids.has(s.scopeId) || units.has(s.unit) || instances.has(r.instance.instanceId) ||
        invocations.has(s.unitInvocationId) || invocations.has(r.instance.unitInvocationId)) fail('asset-root-v2-generation-invalid');
    ids.add(s.scopeId); units.add(s.unit); instances.add(r.instance.instanceId);
    invocations.add(s.unitInvocationId); invocations.add(r.instance.unitInvocationId); previous = r;
  }
  return checkpoint;
}
