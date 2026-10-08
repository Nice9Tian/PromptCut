/** Read-only half of a root-authored asset OS registry. No method here accepts
 * a new epoch or creates a checkpoint: those require an external root witness
 * followed by a durable doc highwater commit before RAM exposure. */
import fs from 'node:fs';
import path from 'node:path';
import { digestOf } from '../account/ledger.mjs';
import { accountError } from '../account/client.mjs';

const fail = code => { throw accountError(503, code); };
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',');
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const epoch = value => Number.isSafeInteger(value) && value > 0;
const boot = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const tick = value => typeof value === 'string' && /^[1-9][0-9]{0,24}$/.test(value);
const counter = value => typeof value === 'string' && /^[1-9][0-9]{0,24}$/.test(value);
const same = (a, b) => digestOf(a) === digestOf(b);

function cgroup(value) {
  if (!keys(value, ['v2Path', 'dev', 'ino', 'bootId']) ||
      typeof value.v2Path !== 'string' || !/^\/sys\/fs\/cgroup\/[A-Za-z0-9_.@/\-]+$/.test(value.v2Path) ||
      value.v2Path.includes('/../') || !counter(value.dev) || !counter(value.ino) || !boot(value.bootId))
    fail('asset-current-registry-invalid');
  return value;
}
function instance(value) {
  if (!keys(value, ['instanceId', 'bootId', 'pid', 'pidBirth', 'uid', 'unit', 'unitInvocationId', 'cgroup',
    'serviceIdentity', 'clientFingerprint256', 'serverFingerprint256']) || !text(value.instanceId) ||
      !boot(value.bootId) || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      !keys(value.pidBirth, ['bootId', 'startTicks']) || value.pidBirth.bootId !== value.bootId ||
      !tick(value.pidBirth.startTicks) || !Number.isSafeInteger(value.uid) || value.uid < 1 ||
      !text(value.unit) || !/^[a-f0-9]{32}$/.test(value.unitInvocationId) ||
      !text(value.serviceIdentity) || !hash(value.clientFingerprint256) || !hash(value.serverFingerprint256))
    fail('asset-current-registry-invalid');
  if (cgroup(value.cgroup).bootId !== value.bootId) fail('asset-current-registry-invalid');
  return value;
}
function registry(value) {
  if (!keys(value, ['v', 'authorityId', 'serviceId', 'epoch', 'state', 'instance', 'previous']) ||
      value.v !== 1 || !text(value.authorityId) || value.serviceId !== 'asset' || !epoch(value.epoch) ||
      !['preparing', 'active', 'closed'].includes(value.state)) fail('asset-current-registry-invalid');
  instance(value.instance); return value;
}
function anchor(value, record) {
  if (!keys(value, ['v', 'protocol', 'authorityId', 'firstEpoch', 'firstRegistryDigest', 'serviceIdentity',
    'uid', 'unit', 'cgroupPath', 'clientFingerprint256', 'serverFingerprint256']) || value.v !== 1 ||
      value.protocol !== 'promptcut.asset-root-anchor.v1' || value.authorityId !== record.authorityId ||
      value.firstEpoch !== 1 || !hash(value.firstRegistryDigest) ||
      !text(value.serviceIdentity) || !Number.isSafeInteger(value.uid) || value.uid < 1 ||
      !text(value.unit) || !text(value.cgroupPath) ||
      !hash(value.clientFingerprint256) || !hash(value.serverFingerprint256)) fail('asset-current-anchor-invalid');
  return value;
}
function expectedMatches(record, expected, initial) {
  if (!keys(expected, ['authorityId', 'serviceIdentity', 'clientFingerprint256', 'serverFingerprint256',
    'uid', 'unit', 'cgroupPath']) || expected.authorityId !== record.authorityId) fail('asset-current-registry-invalid');
  for (const key of ['serviceIdentity', 'clientFingerprint256', 'serverFingerprint256', 'uid', 'unit'])
    if (record.instance[key] !== expected[key] || initial[key] !== expected[key]) fail('asset-current-registry-invalid');
  if (record.instance.cgroup.v2Path !== expected.cgroupPath || initial.cgroupPath !== expected.cgroupPath)
    fail('asset-current-registry-invalid');
}

const publicationProtocol = 'promptcut.asset-root-publication.v1';
const reservationProtocol = 'promptcut.asset-root-reservation.v1';

export function validateAssetRootReservation({ reservation, expected } = {}) {
  if (!keys(reservation, ['v', 'protocol', 'authorityId', 'serviceIdentity', 'uid', 'unit', 'cgroupPath',
    'clientFingerprint256', 'serverFingerprint256', 'epoch', 'instanceId']) ||
      reservation.v !== 1 || reservation.protocol !== reservationProtocol || !epoch(reservation.epoch) ||
      !text(reservation.instanceId) || !keys(expected, ['authorityId', 'serviceIdentity', 'uid', 'unit',
        'cgroupPath', 'clientFingerprint256', 'serverFingerprint256'])) fail('asset-current-reservation-invalid');
  for (const key of Object.keys(expected)) if (reservation[key] !== expected[key]) fail('asset-current-reservation-invalid');
  return Object.freeze(structuredClone(reservation));
}

/** A visible active rename is not a commit. The external root publisher must
 * have durably completed its publication and released its root-owned lock. */
export function validateRunAssetPublication({ record, trustAnchor, witness = null, reservation, publication,
  publisherLocked = true } = {}) {
  registry(record); anchor(trustAnchor, record);
  if (publisherLocked || record.state !== 'active' ||
      !keys(reservation, ['v', 'protocol', 'authorityId', 'serviceIdentity', 'uid', 'unit', 'cgroupPath',
        'clientFingerprint256', 'serverFingerprint256', 'epoch', 'instanceId']) ||
      reservation.v !== 1 || reservation.protocol !== reservationProtocol ||
      reservation.authorityId !== record.authorityId || reservation.epoch !== record.epoch ||
      reservation.instanceId !== record.instance.instanceId ||
      !keys(publication, ['v', 'protocol', 'authorityId', 'epoch', 'registryDigest', 'anchorDigest',
        'closureWitnessDigest', 'reservationDigest']) || publication.v !== 1 ||
      publication.protocol !== publicationProtocol || publication.authorityId !== record.authorityId ||
      publication.epoch !== record.epoch || publication.registryDigest !== digestOf(record) ||
      publication.anchorDigest !== digestOf(trustAnchor) ||
      publication.reservationDigest !== digestOf(reservation) ||
      publication.closureWitnessDigest !== (record.epoch === 1 ? null : digestOf(witness)) ||
      (record.epoch === 1 ? witness !== null : !witness)) fail('asset-current-publication-incomplete');
  for (const key of ['serviceIdentity', 'uid', 'unit', 'clientFingerprint256', 'serverFingerprint256'])
    if (reservation[key] !== record.instance[key]) fail('asset-current-publication-incomplete');
  if (reservation.cgroupPath !== record.instance.cgroup.v2Path) fail('asset-current-publication-incomplete');
  return { v: 1, authorityId: record.authorityId, epoch: record.epoch,
    recordDigest: digestOf(record), anchorDigest: digestOf(trustAnchor) };
}

/** Canonical hashes are digestOf/canonicalJson of the COMPLETE exact-shape
 * JSON objects; a digest-shaped field alone is never a witness. */
export function validateRunAssetCurrentRecord({ record, witness = null, trustAnchor, expected, checkpoint } = {}) {
  registry(record); anchor(trustAnchor, record); expectedMatches(record, expected, trustAnchor);
  if (!keys(checkpoint, ['v', 'authorityId', 'epoch', 'recordDigest', 'anchorDigest']) || checkpoint.v !== 1 ||
      checkpoint.authorityId !== record.authorityId || !epoch(checkpoint.epoch) ||
      !hash(checkpoint.recordDigest) || checkpoint.anchorDigest !== digestOf(trustAnchor)) fail('asset-current-anchor-invalid');
  if (record.state !== 'active') fail('asset-current-inactive');
  if (record.epoch !== checkpoint.epoch) fail('asset-current-epoch-unaccepted');
  const recordDigest = digestOf(record);
  if (recordDigest !== checkpoint.recordDigest) fail('asset-current-registry-changed');
  if (record.epoch === 1) {
    if (record.previous !== null || witness !== null || trustAnchor.firstRegistryDigest !== recordDigest)
      fail('asset-current-anchor-invalid');
  } else {
    const previous = record.previous;
    if (!keys(previous, ['epoch', 'registryDigest', 'instance', 'closureWitnessDigest']) ||
        previous.epoch !== record.epoch - 1 || !hash(previous.registryDigest) ||
        !hash(previous.closureWitnessDigest) || !witness?.previousRegistry?.instance ||
        !same(instance(previous.instance), witness.previousRegistry.instance))
      fail('asset-current-witness-invalid');
    if (!keys(witness, ['v', 'protocol', 'witnessId', 'authorityId', 'fromEpoch', 'toEpoch',
      'previousRegistry', 'observed']) || witness.v !== 1 ||
        witness.protocol !== 'promptcut.asset-os-closure.v1' || !text(witness.witnessId) ||
        witness.authorityId !== record.authorityId || witness.fromEpoch !== previous.epoch ||
        witness.toEpoch !== record.epoch || digestOf(witness) !== previous.closureWitnessDigest ||
        !keys(witness.observed, ['kind', 'closed', 'at', 'bootId', 'cgroup', 'unitInvocationId', 'pidBirth']) ||
        witness.observed.kind !== 'cgroup-empty' || witness.observed.closed !== true ||
        !Number.isSafeInteger(witness.observed.at) || witness.observed.at < 1 ||
        witness.observed.bootId !== record.instance.bootId ||
        !same(witness.observed.cgroup, previous.instance.cgroup) ||
        witness.observed.unitInvocationId !== previous.instance.unitInvocationId ||
        !same(witness.observed.pidBirth, previous.instance.pidBirth)) fail('asset-current-witness-invalid');
    const old = registry(witness.previousRegistry);
    if (old.authorityId !== record.authorityId || old.epoch !== previous.epoch || old.state !== 'active' ||
        digestOf(old) !== previous.registryDigest) fail('asset-current-witness-invalid');
  }
  return Object.freeze({ epoch: record.epoch, instance: structuredClone(record.instance), recordDigest });
}

function rootFile(filename) {
  if (process.platform !== 'linux' || typeof filename !== 'string' || !path.isAbsolute(filename)) fail('asset-current-registry-unavailable');
  for (let dir = path.dirname(filename); ; dir = path.dirname(dir)) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) fail('asset-current-registry-untrusted');
    if (path.dirname(dir) === dir) break;
  }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 0 || (stat.mode & 0o022) ||
      stat.size < 1 || stat.size > 65536) fail('asset-current-registry-untrusted');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const pinned = fs.fstatSync(fd);
    if (!pinned.isFile() || pinned.nlink !== 1 || pinned.uid !== 0 || pinned.ino !== stat.ino || pinned.dev !== stat.dev ||
        pinned.size !== stat.size || (pinned.mode & 0o022)) fail('asset-current-registry-untrusted');
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const after = fs.lstatSync(filename);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.uid !== 0 ||
        after.dev !== pinned.dev || after.ino !== pinned.ino || after.size !== pinned.size ||
        after.mtimeMs !== pinned.mtimeMs || (after.mode & 0o022)) fail('asset-current-registry-changed');
    return value;
  } catch (error) { if (error.status) throw error; fail('asset-current-registry-invalid'); }
  finally { fs.closeSync(fd); }
}

/** The asset process reads its root reservation ONCE at startup; it cannot
 * later adopt a reservation for another OS generation. */
export function readRootAssetReservation({ reservationFile, expected } = {}) {
  try { return validateAssetRootReservation({ reservation: rootFile(reservationFile), expected }); }
  catch (error) { if (error.status) throw error; fail('asset-current-reservation-unavailable'); }
}

function rootUnlocked(filename) {
  if (process.platform !== 'linux' || typeof filename !== 'string' || !path.isAbsolute(filename))
    fail('asset-current-registry-unavailable');
  try { fs.lstatSync(filename); fail('asset-current-publication-incomplete'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // The directory is checked by every rootFile read. A later publisher can
  // acquire the lock immediately; callers must recheck at the final gate.
}

/** Shared root-owned file primitives for the explicit v2 reader. Existing v1
 * callers and their interpretation remain unchanged. */
export { rootFile as readRootAssetEvidenceFile, rootUnlocked as assertRootAssetPublisherUnlocked };

/** Read a complete root-owned publication. This never advances doc state. */
export function readRootRunAssetCandidate({ registryFile, anchorFile, reservationFile,
  publisherLockFile, expected } = {}) {
  try {
    if (process.platform !== 'linux') fail('asset-current-registry-unavailable');
    const dir = path.dirname(registryFile ?? '');
    if (registryFile !== path.join(dir, 'current.json') || anchorFile !== path.join(dir, 'anchor.json') ||
        reservationFile !== path.join(dir, 'reservation.json') || publisherLockFile !== path.join(dir, '.publisher.lock'))
      fail('asset-current-registry-untrusted');
    rootUnlocked(publisherLockFile);
    const record = rootFile(registryFile), trustAnchor = rootFile(anchorFile);
    const publicationFile = path.join(dir, `publication-${record.epoch}.json`);
    const witnessFile = record.epoch === 1 ? null : path.join(dir, `witness-${record.epoch}.json`);
    const witness = record.epoch === 1 ? null : rootFile(witnessFile);
    const reservation = rootFile(reservationFile), publication = rootFile(publicationFile);
    const checkpoint = validateRunAssetPublication({ record, trustAnchor, witness, reservation, publication,
      publisherLocked: false });
    expectedMatches(record, expected, trustAnchor);
    validateRunAssetCurrentRecord({ record, witness, trustAnchor, expected, checkpoint });
    // Catch a transition begun between the first and last file read.
    rootUnlocked(publisherLockFile);
    if (digestOf(rootFile(registryFile)) !== checkpoint.recordDigest ||
        digestOf(rootFile(publicationFile)) !== digestOf(publication)) fail('asset-current-registry-changed');
    rootUnlocked(publisherLockFile);
    return { record, trustAnchor, witness, reservation, publication, checkpoint };
  } catch (error) { if (error.status) throw error; fail('asset-current-registry-unavailable'); }
}

/** No acceptCurrent here. A missing durable checkpoint is always rejected. */
export function readRootRunAssetCurrent({ registryFile, witnessFile, anchorFile, expected, checkpoint } = {}) {
  try {
    if (process.platform !== 'linux') fail('asset-current-registry-unavailable');
    const dir = path.dirname(registryFile ?? '');
    if (path.dirname(anchorFile ?? '') !== dir || (witnessFile && path.dirname(witnessFile) !== dir))
      fail('asset-current-registry-untrusted');
    const record = rootFile(registryFile), trustAnchor = rootFile(anchorFile);
    const witness = record.epoch === 1 ? null : rootFile(witnessFile);
    return validateRunAssetCurrentRecord({ record, witness, trustAnchor, expected, checkpoint });
  } catch (error) { if (error.status) throw error; fail('asset-current-registry-unavailable'); }
}
