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
