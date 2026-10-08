/** External root supervisor. Never run inside the target service cgroup.
 * CLI has no fixture/force/recover flag. Failure after rename may leave active
 * VISIBLE, so consumers require a durable publication marker AND no lock.
 * Failed/unknown transitions retain the lock for explicit root recovery.
 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { execFile } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { digestOf } from '../../account/ledger.mjs';
import { assetClosureUnitV2, validateAssetRootExpectedV2, validateAssetRootScopeV2, validateAssetRootInstanceV2,
  validateAssetRootRecordV2, validateAssetRootReservationV2, validateAssetRootWitnessV2,
  validateAssetRootHistoryV2 } from '../asset-root-registry-schema-v2.mjs';

const fail = code => { const error = new Error(code); error.code = code; throw error; };
const equal = (a, b) => digestOf(a) === digestOf(b);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const ref = v => typeof v === 'string' && /^[A-Za-z0-9_.:@-]{1,128}$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const positive = v => Number.isSafeInteger(v) && v > 0;
const boot = v => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const ticks = v => typeof v === 'string' && /^[1-9][0-9]{0,24}$/.test(v);
const SCOPE = ['authorityId', 'serviceIdentity', 'uid', 'unit', 'cgroupPath', 'clientFingerprint256', 'serverFingerprint256'];
const pin = v => String(v ?? '').replaceAll(':', '').toLowerCase();

export function validatePublisherScope(scope) {
  if (!exact(scope, SCOPE) || !ref(scope.authorityId) || !ref(scope.serviceIdentity) ||
      !positive(scope.uid) || !/^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/.test(scope.unit) ||
      !/^\/sys\/fs\/cgroup\/[A-Za-z0-9_.@/-]+$/.test(scope.cgroupPath) ||
      scope.cgroupPath.split('/').slice(1).some(p => !p || p === '.' || p === '..') ||
      path.posix.normalize(scope.cgroupPath) !== scope.cgroupPath ||
      !hash(scope.clientFingerprint256) || !hash(scope.serverFingerprint256)) fail('publisher-scope-invalid');
  return structuredClone(scope);
}

export function parseProcStat(text) {
  // comm is parenthesized and may itself contain spaces or ')'.
  const end = text.lastIndexOf(')'), pid = Number(text.slice(0, text.indexOf(' ')));
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (!/^[1-9][0-9]* \(/.test(text) || end < 1 || !positive(pid) || !ticks(fields[19])) fail('publisher-proc-invalid');
  return { pid, startTicks: fields[19] };
}

function validateInstance(scope, instance) {
  if (!exact(instance, ['instanceId', 'bootId', 'pid', 'pidBirth', 'uid', 'unit', 'unitInvocationId', 'cgroup',
    'serviceIdentity', 'clientFingerprint256', 'serverFingerprint256']) || !ref(instance.instanceId) ||
      !boot(instance.bootId) || !positive(instance.pid) ||
      !exact(instance.pidBirth, ['bootId', 'startTicks']) || instance.pidBirth.bootId !== instance.bootId ||
      !ticks(instance.pidBirth.startTicks) || !/^[a-f0-9]{32}$/.test(instance.unitInvocationId) ||
      !exact(instance.cgroup, ['v2Path', 'dev', 'ino', 'bootId']) ||
      instance.cgroup.v2Path !== scope.cgroupPath || instance.cgroup.bootId !== instance.bootId ||
      !ticks(instance.cgroup.dev) || !ticks(instance.cgroup.ino)) fail('publisher-instance-invalid');
  for (const k of ['uid', 'unit', 'serviceIdentity', 'clientFingerprint256', 'serverFingerprint256'])
    if (instance[k] !== scope[k]) fail('publisher-scope-mismatch');
}

function activeRecord(scope, record) {
  if (!exact(record, ['v', 'authorityId', 'serviceId', 'epoch', 'state', 'instance', 'previous']) ||
      record.v !== 1 || record.authorityId !== scope.authorityId || record.serviceId !== 'asset' ||
      !positive(record.epoch) || record.state !== 'active') fail('publisher-current-invalid');
  validateInstance(scope, record.instance);
  if (record.epoch === 1 ? record.previous !== null :
    !exact(record.previous, ['epoch', 'registryDigest', 'instance', 'closureWitnessDigest']) ||
    record.previous.epoch !== record.epoch - 1 || !hash(record.previous.registryDigest) ||
    !hash(record.previous.closureWitnessDigest)) fail('publisher-chain-invalid');
}

const reservationFor = (scope, epoch, instanceId) => ({ v: 1, protocol: 'promptcut.asset-root-reservation.v1',
  ...scope, epoch, instanceId });
const publicationFor = (scope, record, anchor) => ({ v: 1, protocol: 'promptcut.asset-root-publication.v1',
  authorityId: scope.authorityId, epoch: record.epoch, registryDigest: digestOf(record), anchorDigest: digestOf(anchor),
  closureWitnessDigest: record.previous?.closureWitnessDigest ?? null,
  reservationDigest: digestOf(reservationFor(scope, record.epoch, record.instance.instanceId)) });

async function history(io, scope, current, anchor) {
  if (!exact(anchor, ['v', 'protocol', ...SCOPE, 'firstEpoch', 'firstRegistryDigest']) || anchor.v !== 1 ||
      anchor.protocol !== 'promptcut.asset-root-anchor.v1' || anchor.firstEpoch !== 1 ||
      !hash(anchor.firstRegistryDigest)) fail('publisher-anchor-invalid');
  for (const k of SCOPE) if (anchor[k] !== scope[k]) fail('publisher-anchor-invalid');
  let value = current;
  for (;;) {
    activeRecord(scope, value);
    if (!equal(value, await io.read(`epoch-${value.epoch}.json`))) fail('publisher-history-mismatch');
    if (!equal(publicationFor(scope, value, anchor), await io.read(`publication-${value.epoch}.json`)))
      fail('publisher-publication-missing');
    if (value.epoch === 1) {
      if (anchor.firstRegistryDigest !== digestOf(value)) fail('publisher-anchor-invalid');
      return;
    }
    const w = await io.read(`witness-${value.epoch}.json`), previous = value.previous;
    if (!exact(w, ['v', 'protocol', 'witnessId', 'authorityId', 'fromEpoch', 'toEpoch', 'previousRegistry', 'observed']) ||
        w.v !== 1 || w.protocol !== 'promptcut.asset-os-closure.v1' || !ref(w.witnessId) ||
        w.authorityId !== scope.authorityId || w.fromEpoch !== value.epoch - 1 || w.toEpoch !== value.epoch ||
        digestOf(w) !== previous.closureWitnessDigest || digestOf(w.previousRegistry) !== previous.registryDigest ||
        !equal(w.previousRegistry?.instance, previous.instance) ||
        !exact(w.observed, ['kind', 'closed', 'at', 'bootId', 'cgroup', 'unitInvocationId', 'pidBirth']) ||
        w.observed.kind !== 'cgroup-empty' || w.observed.closed !== true || !positive(w.observed.at) ||
        w.observed.bootId !== value.instance.bootId || !equal(w.observed.cgroup, previous.instance.cgroup) ||
        w.observed.unitInvocationId !== previous.instance.unitInvocationId || !equal(w.observed.pidBirth, previous.instance.pidBirth))
      fail('publisher-history-mismatch');
    value = w.previousRegistry;
    if (value.epoch !== w.fromEpoch) fail('publisher-history-mismatch');
  }
}

/** Pure transaction coordinator. Injected IO in tests is a controlled model,
 * never an OS attestation. Only runAssetRootPublisher constructs production IO.
 */
export async function publishAssetRootRegistry({ scope, mode, io }) {
  scope = validatePublisherScope(scope);
  if (!['initialize', 'rotate'].includes(mode)) fail('publisher-mode-invalid');
  const release = await io.lock(); let publicationDurable = false;
  try {
    const old = await io.read('current.json');
    const anchor = await io.read('anchor.json');
    if (mode === 'initialize') {
      if (old || anchor || await io.read('reservation.json') || await io.read('transition.json'))
        fail('publisher-bootstrap-not-empty');
      // Explicit --initialize is the root's fresh-deployment trust decision,
      // not evidence that a historical process was closed.
      await io.assertInitial();
    } else {
      if (!old || !anchor) fail('publisher-anchor-missing');
      activeRecord(scope, old);
      await history(io, scope, old, anchor);
    }
    const epoch = old ? old.epoch + 1 : 1;
    if (!positive(epoch)) fail('publisher-epoch-overflow');
    const reservation = reservationFor(scope, epoch, io.uuid());
    let witness = null;
    if (old) {
      // Pin exact kernel objects BEFORE making the known unit stop. This step
      // does not act on a numeric PID; no command targets a PID from disk.
      const pinned = await io.pinPrevious(old.instance);
      try {
        await io.write('current.json', { ...old, state: 'preparing' });
        await io.write('transition.json', { v: 1, phase: 'closing', fromDigest: digestOf(old), toEpoch: epoch });
        const observed = await pinned.stopAndObserve();
        if (!exact(observed, ['kind', 'closed', 'at', 'bootId', 'cgroup', 'unitInvocationId', 'pidBirth']) ||
            observed.kind !== 'cgroup-empty' || observed.closed !== true || !positive(observed.at) ||
            observed.bootId !== old.instance.bootId || !equal(observed.cgroup, old.instance.cgroup) ||
            observed.unitInvocationId !== old.instance.unitInvocationId || !equal(observed.pidBirth, old.instance.pidBirth))
          fail('publisher-closure-invalid');
        witness = { v: 1, protocol: 'promptcut.asset-os-closure.v1', witnessId: io.uuid(),
          authorityId: scope.authorityId, fromEpoch: old.epoch, toEpoch: epoch, previousRegistry: old, observed };
        await io.write(`witness-${epoch}.json`, witness, true);
      } finally { await pinned.close(); }
    }
    await io.write('reservation.json', reservation);
    await io.write('transition.json', { v: 1, phase: 'reserved', fromDigest: old ? digestOf(old) : null, toEpoch: epoch });
    await io.start();
    const before = await io.inspect(reservation);
    validateInstance(scope, before);
    const identity = await io.identity();
    const after = await io.inspect(reservation);
    validateInstance(scope, after);
    if (!equal(before, after) || (old && after.bootId !== old.instance.bootId)) fail('publisher-instance-changed');
    if (!exact(identity, ['v', 'serviceId', 'authorityId', 'epoch', 'instanceId', 'pid', 'startedAt', 'serviceIdentity',
      'docClientFingerprint256', 'internalServerFingerprint256', 'state']) || identity.v !== 1 ||
        identity.serviceId !== 'asset' || identity.authorityId !== scope.authorityId || identity.epoch !== epoch ||
        identity.instanceId !== reservation.instanceId || identity.instanceId !== after.instanceId ||
        identity.pid !== after.pid || identity.serviceIdentity !== scope.serviceIdentity || identity.state !== 'running' ||
        !positive(identity.startedAt) || identity.docClientFingerprint256 !== scope.clientFingerprint256 ||
        identity.internalServerFingerprint256 !== scope.serverFingerprint256) fail('publisher-identity-mismatch');
    const record = { v: 1, authorityId: scope.authorityId, serviceId: 'asset', epoch, state: 'active', instance: after,
      previous: old ? { epoch: old.epoch, registryDigest: digestOf(old), instance: old.instance,
        closureWitnessDigest: digestOf(witness) } : null };
    if (!old) await io.write('anchor.json', { v: 1, protocol: 'promptcut.asset-root-anchor.v1',
      ...scope, firstEpoch: 1, firstRegistryDigest: digestOf(record) }, true);
    await io.write(`epoch-${epoch}.json`, record, true);
    // Active is only a candidate until marker durability and successful unlock.
    if (!equal(after, await io.inspect(reservation))) fail('publisher-instance-changed');
    await io.write('current.json', record);
    const complete = publicationFor(scope, record, old ? anchor : await io.read('anchor.json'));
    await io.write(`publication-${epoch}.json`, complete, true);
    publicationDurable = true; // Reached ONLY after marker file and directory fsync.
    return { epoch, recordDigest: complete.registryDigest, anchorDigest: complete.anchorDigest };
  } finally { await release({ publicationDurable }); }
}

/** Independent v2 entry. The injected IO is a sequencing model, not permission
 * to attest OS facts. Production IO is only created by runAssetRootPublisherV2.
 * Original v1 coordinator and CLI are not upgraded implicitly.
 */
export async function publishAssetRootRegistryV2({ expected, mode, io }) {
  expected = validateAssetRootExpectedV2(expected);
  if (!['initialize', 'rotate'].includes(mode)) fail('publisher-mode-invalid');
  const release = await io.lock(); let publicationDurable = false;
  try {
    const old = await io.read('current.json'), initialAnchor = await io.read('anchor.json'), entries = [];
    if (mode === 'initialize') {
      if (old || initialAnchor || await io.read('reservation.json') || await io.read('transition.json')) fail('publisher-bootstrap-not-empty');
      await io.assertInitial();
    } else {
      if (!old || !initialAnchor) fail('publisher-anchor-missing');
      validateAssetRootRecordV2(old, { expected });
      for (let n = 1; n <= old.epoch; n++) entries.push({ record: await io.read(`epoch-${n}.json`),
        reservation: await io.read(`reservation-${n}.json`), witness: n === 1 ? null : await io.read(`witness-${n}.json`),
        publication: await io.read(`publication-${n}.json`) });
      // We own the transition lock. This validates completed historical markers,
      // not a doc acceptance of the currently locked candidate.
      validateAssetRootHistoryV2({ entries, currentRecord: old, anchor: initialAnchor, expected, publisherLocked: false });
    }
    const epoch = old ? old.epoch + 1 : 1;
    if (!positive(epoch)) fail('publisher-epoch-overflow');
    const plan = { epoch, instanceId: io.uuid(), scopeId: io.scopeId() };
    assetClosureUnitV2(expected, plan);
    if (entries.some(e => e.record.instance.instanceId === plan.instanceId || e.record.closureScope.scopeId === plan.scopeId))
      fail('publisher-history-identity-reused');
    let witness = null;
    if (old) {
      const pinned = await io.pinPrevious(old);
      try {
        await io.write('current.json', { ...old, state: 'preparing' });
        await io.write('transition.json', { v: 2, phase: 'closing', fromDigest: digestOf(old), toEpoch: epoch });
        const observed = await pinned.stopAndObserve();
        witness = { v: 2, protocol: 'promptcut.asset-os-closure.v2', witnessId: io.uuid(), authorityId: expected.authorityId,
          fromEpoch: old.epoch, toEpoch: epoch, previousRegistry: old, observed };
        validateAssetRootWitnessV2(witness, { expected, previousRecord: old, nextEpoch: epoch, bootId: old.instance.bootId });
        await io.write(`witness-${epoch}.json`, witness, true);
        // The old empty scope survives until its complete witness is durable.
        // This await is deliberately after the witness file+directory barrier.
        await pinned.releaseScope();
      } finally { await pinned.close(); }
    }
    await io.write('transition.json', { v: 2, phase: 'scope-reserved', fromDigest: old ? digestOf(old) : null, ...plan });
    const closureScope = await io.createScope(plan);
    validateAssetRootScopeV2(closureScope, { expected, epoch, instanceId: plan.instanceId });
    if (old && closureScope.bootId !== old.instance.bootId) fail('publisher-cross-boot-unsupported');
    const reservation = { v: 2, protocol: 'promptcut.asset-root-reservation.v2', ...expected,
      epoch, instanceId: plan.instanceId, serviceCgroupPath: `${closureScope.cgroup.v2Path}/${expected.unit}`, closureScope };
    validateAssetRootReservationV2(reservation, { expected });
    await io.write(`reservation-${epoch}.json`, reservation, true);
    await io.write('reservation.json', reservation);
    await io.configureService(reservation);
    await io.start(reservation);
    const before = await io.inspect(reservation);
    validateAssetRootInstanceV2(before.instance, { expected, closureScope: before.closureScope });
    if (!equal(before.closureScope, closureScope)) fail('publisher-scope-changed');
    const identity = await io.identity(reservation);
    const after = await io.inspect(reservation);
    if (!equal(before, after)) fail('publisher-instance-changed');
    if (!exact(identity, ['v', 'serviceId', 'authorityId', 'epoch', 'instanceId', 'pid', 'startedAt', 'serviceIdentity',
      'docClientFingerprint256', 'internalServerFingerprint256', 'state']) || identity.v !== 1 || identity.serviceId !== 'asset' ||
        identity.authorityId !== expected.authorityId || identity.epoch !== epoch || identity.instanceId !== plan.instanceId ||
        after.instance.instanceId !== plan.instanceId || identity.pid !== after.instance.pid || !positive(identity.startedAt) ||
        identity.serviceIdentity !== expected.serviceIdentity || identity.state !== 'running' ||
        identity.docClientFingerprint256 !== expected.clientFingerprint256 || identity.internalServerFingerprint256 !== expected.serverFingerprint256)
      fail('publisher-identity-mismatch');
    const record = { v: 2, authorityId: expected.authorityId, serviceId: 'asset', epoch, state: 'active', instance: after.instance,
      closureScope, previous: old ? { epoch: old.epoch, registryDigest: digestOf(old), instance: old.instance,
        closureScope: old.closureScope, closureWitnessDigest: digestOf(witness) } : null };
    const anchor = initialAnchor ?? { v: 2, protocol: 'promptcut.asset-root-anchor.v2', ...expected, firstEpoch: 1, firstRegistryDigest: digestOf(record) };
    const publication = { v: 2, protocol: 'promptcut.asset-root-publication.v2', authorityId: expected.authorityId, epoch,
      registryDigest: digestOf(record), anchorDigest: digestOf(anchor), closureWitnessDigest: witness ? digestOf(witness) : null,
      reservationDigest: digestOf(reservation) };
    const checkpoint = validateAssetRootHistoryV2({ entries: [...entries, { record, reservation, witness, publication }],
      currentRecord: record, anchor, expected, publisherLocked: false });
    if (!old) await io.write('anchor.json', anchor, true);
    await io.write(`epoch-${epoch}.json`, record, true);
    if (!equal(after, await io.inspect(reservation))) fail('publisher-instance-changed');
    await io.write('current.json', record);
    await io.write(`publication-${epoch}.json`, publication, true);
    publicationDurable = true;
    return checkpoint;
  } finally { await release({ publicationDurable }); }
}

async function rootDirectory(dir) {
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir) fail('publisher-path-untrusted');
  for (let p = dir; ; p = path.dirname(p)) {
    const st = await fs.lstat(p);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022)) fail('publisher-path-untrusted');
    if (p === path.dirname(p)) break;
  }
}
async function rootRead(filename, optional = false, bytes = false) {
  await rootDirectory(path.dirname(filename));
  let fd;
  try { fd = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o022) || st.size > 65536 || st.size < 1)
      fail('publisher-file-untrusted');
    const content = await fd.readFile();
    const last = await fs.lstat(filename);
    if (last.ino !== st.ino || last.dev !== st.dev || last.isSymbolicLink() || last.size !== st.size || last.mtimeMs !== st.mtimeMs)
      fail('publisher-file-changed');
    return bytes ? content : JSON.parse(content.toString('utf8'));
  } finally { await fd.close(); }
}
async function atomicWrite(dir, name, value, exclusive = false) {
  await rootDirectory(dir);
  const target = path.join(dir, name);
  if (exclusive && await rootRead(target, true)) fail('publisher-record-exists');
  await writePublisherArtifact({ dir, name, value, exclusive });
}
async function syncDirectory(dir) {
  const directory = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
/** Filesystem primitive shared with real-TMP fault tests. Production only
 * reaches it after Linux/root and owned-directory validation; no CLI injection.
 * A rejected directory barrier can leave the published target VISIBLE.
 */
export async function writePublisherArtifact({ dir, name, value, exclusive = false, directoryBarrier = syncDirectory }) {
  if (!/^[a-z][a-z0-9.-]*\.json$/.test(name)) fail('publisher-artifact-name');
  const target = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.${randomUUID()}.tmp`), fd = await fs.open(tmp, 'wx', 0o644);
  try { await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
  if (exclusive) { await fs.link(tmp, target); await fs.unlink(tmp); }
  else await fs.rename(tmp, target);
  await directoryBarrier(dir, { name, value, exclusive });
}
export async function openPublisherLock(dir, { directoryBarrier = syncDirectory } = {}) {
  const filename = path.join(dir, '.publisher.lock'), fd = await fs.open(filename, 'wx', 0o600);
  const stat = await fd.stat();
  try { await fd.writeFile(JSON.stringify({ pid: process.pid })); await fd.sync(); await directoryBarrier(dir); }
  catch (error) { await fd.close(); throw error; }
  return async ({ publicationDurable = false } = {}) => {
    try {
      if (!publicationDurable) return; // Failed/unknown result retains the exclusion marker.
      const current = await fs.lstat(filename);
      if (current.ino !== stat.ino || current.dev !== stat.dev || current.isSymbolicLink()) fail('publisher-lock-changed');
      await fs.unlink(filename);
      await directoryBarrier(dir);
    } catch { fail('publisher-unlock-result-unknown'); }
    finally { await fd.close(); }
  };
}
const bytesDigest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Portable real-file primitive for the exclusive root runtime adapter. The
 * production caller separately authenticates every ancestor/receipt/base file.
 * A post-rename barrier failure is unknown-visible and must retain its lock.
 */
export async function writePublisherTextV2({ filename, text, previous = null, directoryBarrier = syncDirectory }) {
  const check = async () => {
    let st;
    try { st = await fs.lstat(filename, { bigint: true }); }
    catch (e) { if (e.code === 'ENOENT' && previous === null) return; throw e; }
    if (!previous || !st.isFile() || st.isSymbolicLink() || st.nlink !== 1n || String(st.dev) !== previous.dev ||
        String(st.ino) !== previous.ino || bytesDigest(await fs.readFile(filename)) !== previous.digest) fail('publisher-dropin-ownership');
  };
  await check();
  const dir = path.dirname(filename), tmp = path.join(dir, `.publisher-${randomUUID()}.tmp`), fd = await fs.open(tmp, 'wx', 0o644);
  try { await fd.chmod(0o644); await fd.writeFile(text); await fd.sync(); } finally { await fd.close(); }
  await check();
  if (previous === null) { await fs.link(tmp, filename); await fs.unlink(tmp); }
  else await fs.rename(tmp, filename);
  await directoryBarrier(dir);
  const st = await fs.lstat(filename, { bigint: true });
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n || bytesDigest(await fs.readFile(filename)) !== bytesDigest(text))
    fail('publisher-dropin-ownership');
  return { dev: String(st.dev), ino: String(st.ino), digest: bytesDigest(text) };
}

export function validatePublisherRuntimeAdapterV2(value, expected) {
  validateAssetRootExpectedV2(expected);
  const file = v => exact(v, ['path', 'sha256']) && typeof v.path === 'string' &&
    /^\/(?:etc|run|usr|lib)\/[A-Za-z0-9_.@/-]+$/.test(v.path) && path.posix.normalize(v.path) === v.path &&
    !v.path.split('/').some(s => s === '.' || s === '..') && hash(v.sha256);
  if (!exact(value, ['unitFragment', 'baseDropIns', 'ownDropInPath']) || !file(value.unitFragment) ||
      !Array.isArray(value.baseDropIns) || value.baseDropIns.some(v => !file(v)) ||
      value.ownDropInPath !== `/run/systemd/system/${expected.unit}.d/90-promptcut-root-slice.conf` ||
      new Set([value.unitFragment.path, ...value.baseDropIns.map(v => v.path), value.ownDropInPath]).size !== value.baseDropIns.length + 2)
    fail('publisher-runtime-config-invalid');
  return structuredClone(value);
}
const exec = args => new Promise((resolve, reject) => execFile('/usr/bin/systemctl', args,
  { windowsHide: true, timeout: 120000, maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) =>
    error ? reject(Object.assign(new Error('publisher-systemctl-failed'), { code: 'publisher-systemctl-failed' })) : resolve(stdout)));
export function validatePublisherUnit(value, unit) {
  if (value.Id !== unit || value.LoadState !== 'loaded' || value.KillMode !== 'control-group' || value.Delegate !== 'no' ||
      value.Restart !== 'no') fail('publisher-unit-scope');
  return value;
}
async function unitInfo(unit) {
  const names = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlGroup', 'InvocationID', 'KillMode', 'Delegate', 'Restart'];
  const raw = await exec(['show', unit, '--no-pager', ...names.map(n => `--property=${n}`)]);
  const value = Object.fromEntries(raw.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  return validatePublisherUnit(value, unit);
}
async function bootId() { const v = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); if (!boot(v)) fail('publisher-boot-invalid'); return v; }
async function procInfo(pid) {
  const first = parseProcStat(await fs.readFile(`/proc/${pid}/stat`, 'utf8'));
  const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
  const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
  const cg = (await fs.readFile(`/proc/${pid}/cgroup`, 'utf8')).trim();
  const second = parseProcStat(await fs.readFile(`/proc/${pid}/stat`, 'utf8'));
  if (!equal(first, second) || first.pid !== pid || !ids || ids.slice(1).some(v => v !== ids[1]) || !/^0::\/[^\n]*$/.test(cg))
    fail('publisher-proc-changed');
  return { ...first, uid: Number(ids[1]), cgroupPath: `/sys/fs/cgroup${cg.slice(3)}` };
}
async function inspect(scope, reservation) {
  const before = await unitInfo(scope.unit), pid = Number(before.MainPID), bootBefore = await bootId();
  if (!positive(pid) || !['active', 'activating'].includes(before.ActiveState) ||
      `/sys/fs/cgroup${before.ControlGroup}` !== scope.cgroupPath || !/^[a-f0-9]{32}$/.test(before.InvocationID)) fail('publisher-unit-not-running');
  const proc = await procInfo(pid), cg = await fs.lstat(scope.cgroupPath, { bigint: true });
  if ((await fs.statfs(scope.cgroupPath)).type !== 0x63677270) fail('publisher-cgroup-not-v2');
  if (!cg.isDirectory() || cg.isSymbolicLink() || proc.uid !== scope.uid || proc.cgroupPath !== scope.cgroupPath ||
      !equal(before, await unitInfo(scope.unit)) || bootBefore !== await bootId()) fail('publisher-proc-changed');
  return { instanceId: reservation.instanceId, bootId: bootBefore, pid,
    pidBirth: { bootId: bootBefore, startTicks: proc.startTicks }, uid: proc.uid, unit: scope.unit,
    unitInvocationId: before.InvocationID, cgroup: { v2Path: scope.cgroupPath, dev: String(cg.dev), ino: String(cg.ino), bootId: bootBefore },
    serviceIdentity: scope.serviceIdentity, clientFingerprint256: scope.clientFingerprint256, serverFingerprint256: scope.serverFingerprint256 };
}

async function freshIdentity(config, scope) {
  const [key, cert, ca] = await Promise.all(['keyFile', 'certFile', 'caFile'].map(k => rootRead(config[k], false, true)));
  return await new Promise((resolve, reject) => {
    let result, failure, socket;
    const req = https.request(new URL('/internal/v2/asset/run/identity', config.origin), {
      method: 'GET', agent: false, key, cert, ca, rejectUnauthorized: true, minVersion: 'TLSv1.3', timeout: 10000,
      checkServerIdentity(host, peer) { return checkServerIdentity(host, peer) ||
        (pin(peer.fingerprint256) !== scope.serverFingerprint256 ? new Error('publisher-tls-pin') : undefined); },
    }, res => {
      let length = 0; const chunks = [];
      res.on('data', chunk => { length += chunk.length; if (length > 16384) res.destroy(new Error('publisher-identity-size')); else chunks.push(chunk); });
      res.on('error', error => { failure = error; req.destroy(); });
      res.on('aborted', () => { failure = new Error('publisher-identity-aborted'); req.destroy(); });
      res.on('end', () => { try {
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (res.statusCode !== 200 || body.ok !== true) fail('publisher-identity-unavailable');
        result = body.result;
      } catch (e) { failure = e; } req.destroy(); socket?.destroy(); });
    });
    const complete = () => {
      if (!failure && result) return resolve(result);
      const error = new Error('publisher-identity-unavailable'); error.code = 'publisher-identity-unavailable';
      // Only connection-not-yet-listening is a startup readiness retry. A
      // protocol/pin/identity rejection is never retried into acceptance.
      error.retryable = failure?.code === 'ECONNREFUSED'; reject(error);
    };
    req.on('socket', s => { socket = s; s.once('close', complete); });
    req.on('error', e => { failure = e; if (!socket) complete(); });
    req.on('timeout', () => { failure = new Error('publisher-identity-timeout'); req.destroy(); }); req.end();
  });
}

export async function runAssetRootPublisher({ configFile, mode }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) fail('publisher-linux-root-required');
  const config = await rootRead(configFile);
  if (!exact(config, ['v', 'scope', 'registryDir', 'identity']) || config.v !== 1 ||
      !exact(config.identity, ['origin', 'keyFile', 'certFile', 'caFile'])) fail('publisher-config-invalid');
  const scope = validatePublisherScope(config.scope), dir = config.registryDir;
  const origin = new URL(config.identity.origin);
  if (origin.protocol !== 'https:' || !['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname) ||
      origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)
    fail('publisher-config-invalid');
  await rootDirectory(dir);
  const selfGroup = (await fs.readFile('/proc/self/cgroup', 'utf8')).trim();
  if (!/^0::\/[^\n]*$/.test(selfGroup) || scope.cgroupPath === `/sys/fs/cgroup${selfGroup.slice(3)}` ||
      `/sys/fs/cgroup${selfGroup.slice(3)}`.startsWith(`${scope.cgroupPath}/`)) fail('publisher-inside-target-cgroup');
  const io = {
    uuid: randomUUID,
    read: name => rootRead(path.join(dir, name), true),
    write: (name, value, exclusive) => atomicWrite(dir, name, value, exclusive),
    lock: () => openPublisherLock(dir),
    async assertInitial() {
      const unit = await unitInfo(scope.unit);
      if (unit.ActiveState !== 'inactive' || Number(unit.MainPID) !== 0) fail('publisher-bootstrap-unit-active');
      const files = await fs.readdir(dir);
      if (files.some(n => n !== '.publisher.lock')) fail('publisher-bootstrap-not-empty');
      // No historical closure is inferred here. Explicit root initialization
      // authorizes a genuinely fresh scope; any existing populated group vetoes it.
      let group;
      try { group = await fs.open(scope.cgroupPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (group) try {
        const events = await fs.readFile(`/proc/self/fd/${group.fd}/cgroup.events`, 'utf8');
        if (!/^populated 0$/m.test(events)) fail('publisher-bootstrap-cgroup-populated');
      } finally { await group.close(); }
    },
    async pinPrevious(previous) {
      if (!equal(previous, await inspect(scope, previous))) fail('publisher-previous-instance-mismatch');
      const group = await fs.open(scope.cgroupPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      let events;
      try {
        const st = await group.stat({ bigint: true });
        if (String(st.dev) !== previous.cgroup.dev || String(st.ino) !== previous.cgroup.ino) fail('publisher-cgroup-changed');
        events = await fs.open(`/proc/self/fd/${group.fd}/cgroup.events`, constants.O_RDONLY | constants.O_NOFOLLOW);
        return {
          async stopAndObserve() {
            if (!equal(previous, await inspect(scope, previous))) fail('publisher-previous-instance-mismatch');
            // Start exact configured unit stop, immediately attach its rejection
            // handler, and inspect the pinned object while systemd drains it.
            const stopping = exec(['stop', scope.unit, '--no-ask-password']).then(() => ({ ok: true }), () => ({ ok: false }));
            const deadline = Date.now() + 120000; let empty = false;
            try {
              while (Date.now() < deadline) {
                const buffer = Buffer.alloc(4096), { bytesRead } = await events.read(buffer, 0, buffer.length, 0);
                const text = buffer.subarray(0, bytesRead).toString('utf8');
                if (!/^populated [01]$/m.test(text)) fail('publisher-cgroup-observation-invalid');
                const st2 = await group.stat({ bigint: true });
                if (String(st2.dev) !== previous.cgroup.dev || String(st2.ino) !== previous.cgroup.ino || await bootId() !== previous.bootId)
                  fail('publisher-cgroup-changed');
                let gone = false;
                try { const p = parseProcStat(await fs.readFile(`/proc/${previous.pid}/stat`, 'utf8')); gone = p.startTicks !== previous.pidBirth.startTicks; }
                catch (e) { if (e.code === 'ENOENT') gone = true; else throw e; }
                if (/^populated 0$/m.test(text) && gone) { empty = true; break; }
                await new Promise(resolve => setTimeout(resolve, 20));
              }
            } finally { if (!(await stopping).ok) fail('publisher-stop-failed'); }
            if (!empty) fail('publisher-closure-unproved');
            const unit = await unitInfo(scope.unit);
            if (unit.ActiveState !== 'inactive' || Number(unit.MainPID) !== 0) fail('publisher-unit-not-stopped');
            return { kind: 'cgroup-empty', closed: true, at: Date.now(), bootId: previous.bootId,
              cgroup: previous.cgroup, unitInvocationId: previous.unitInvocationId, pidBirth: previous.pidBirth };
          },
          async close() { await events.close(); await group.close(); },
        };
      } catch (e) { await events?.close(); await group.close(); throw e; }
    },
    start: () => exec(['start', scope.unit, '--no-ask-password']),
    inspect: reservation => inspect(scope, reservation),
    async identity() {
      const reservation = await rootRead(path.join(dir, 'reservation.json'));
      const original = await inspect(scope, reservation);
      for (let attempt = 0; ; attempt++) {
        try { return await freshIdentity(config.identity, scope); }
        catch (error) {
          if (!error.retryable || attempt >= 6) throw error;
          if (!equal(original, await inspect(scope, reservation))) fail('publisher-instance-changed');
          await new Promise(resolve => setTimeout(resolve, Math.min(100 * 2 ** attempt, 1600)));
          if (!equal(original, await inspect(scope, reservation))) fail('publisher-instance-changed');
        }
      }
    },
  };
  return await publishAssetRootRegistry({ scope, mode, io });
}

const sliceTextV2 = (expected, reservation) => `# PromptCut root publisher v2 ${expected.authorityId} epoch ${reservation.epoch}\n[Service]\nSlice=${reservation.closureScope.unit}\n`;
const systemPropertiesV2 = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlGroup', 'InvocationID',
  'KillMode', 'Delegate', 'Restart', 'Slice', 'User', 'FragmentPath', 'SourcePath', 'DropInPaths', 'Following', 'Transient', 'Job', 'Description', 'StopWhenUnneeded'];
async function systemUnitV2(unit) {
  const raw = await exec(['show', unit, '--no-pager', '--all', ...systemPropertiesV2.map(n => `--property=${n}`)]);
  return Object.fromEntries(raw.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
}
const externalV2 = (file, args) => new Promise((resolve, reject) => execFile(file, args,
  { windowsHide: true, timeout: 10000, maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) =>
    error ? reject(Object.assign(new Error('publisher-control-failed'), { code: 'publisher-control-failed' })) : resolve(stdout)));

/** Explicit Linux root v2 runtime. It only manages the configured service and
 * its exact owned runtime drop-in; no live Slice mutation or v1 migration.
 */
export async function runAssetRootPublisherV2({ configFile, mode }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) fail('publisher-linux-root-required');
  const config = await rootRead(configFile);
  if (!exact(config, ['v', 'expected', 'registryDir', 'identity', 'runtimeAdapter']) || config.v !== 2 ||
      !exact(config.identity, ['origin', 'keyFile', 'certFile', 'caFile'])) fail('publisher-config-invalid');
  const expected = validateAssetRootExpectedV2(config.expected), adapter = validatePublisherRuntimeAdapterV2(config.runtimeAdapter, expected);
  const dir = config.registryDir, origin = new URL(config.identity.origin);
  if (origin.protocol !== 'https:' || !['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname) ||
      origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) fail('publisher-config-invalid');
  await rootDirectory(dir);
  const read = name => rootRead(path.join(dir, name), true);
  const write = (name, value, exclusive) => atomicWrite(dir, name, value, exclusive);
  const receiptName = 'runtime-dropin.json';
  const descriptor = async filename => {
    const content = await rootRead(filename, false, true), st = await fs.lstat(filename, { bigint: true });
    return { content, dev: String(st.dev), ino: String(st.ino), digest: bytesDigest(content) };
  };
  async function configuration(reservation = null) {
    const unit = validatePublisherUnit(await systemUnitV2(expected.unit), expected.unit);
    if (unit.FragmentPath !== adapter.unitFragment.path || unit.SourcePath || unit.Following || unit.Transient !== 'no')
      fail('publisher-unit-config-changed');
    for (const declared of [adapter.unitFragment, ...adapter.baseDropIns])
      if ((await descriptor(declared.path)).digest !== declared.sha256) fail('publisher-unit-config-changed');
    const receipt = await read(receiptName);
    let content = null;
    const ownDir = path.dirname(adapter.ownDropInPath);
    await rootDirectory(path.dirname(ownDir));
    let ownDirExists = true;
    try { await fs.lstat(ownDir); } catch (e) { if (e.code === 'ENOENT') ownDirExists = false; else throw e; }
    if (ownDirExists) content = await rootRead(adapter.ownDropInPath, true, true);
    if (receipt) {
      if (!exact(receipt, ['v', 'authorityId', 'epoch', 'unit', 'path', 'scopeUnit', 'file', 'adapterDigest']) || receipt.v !== 2 ||
          receipt.authorityId !== expected.authorityId || receipt.unit !== expected.unit || receipt.path !== adapter.ownDropInPath ||
          receipt.adapterDigest !== digestOf(adapter) || !positive(receipt.epoch) || !content) fail('publisher-dropin-ownership');
      const previousReservation = await read(`reservation-${receipt.epoch}.json`);
      validateAssetRootReservationV2(previousReservation, { expected });
      const actual = await descriptor(adapter.ownDropInPath);
      if (receipt.scopeUnit !== previousReservation.closureScope.unit ||
          !equal(receipt.file, { dev: actual.dev, ino: actual.ino, digest: actual.digest }) ||
          !content.equals(Buffer.from(sliceTextV2(expected, previousReservation)))) fail('publisher-dropin-ownership');
    } else if (content) fail('publisher-dropin-ownership');
    const loaded = (unit.DropInPaths ?? '').split(' ').filter(Boolean).sort();
    const allowed = [...adapter.baseDropIns.map(v => v.path), ...(receipt ? [adapter.ownDropInPath] : [])].sort();
    if (!equal(loaded, allowed)) fail('publisher-foreign-dropin');
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$|^[1-9][0-9]*$/.test(unit.User ?? '')) fail('publisher-unit-user');
    const userId = Number((await externalV2('/usr/bin/id', ['-u', '--', unit.User])).trim());
    if (userId !== expected.uid) fail('publisher-unit-user');
    if (reservation && (!receipt || receipt.epoch !== reservation.epoch || unit.Slice !== reservation.closureScope.unit))
      fail('publisher-unit-slice-mismatch');
    return { unit, receipt, content };
  }
  async function scopeInfo(scope) {
    validateAssetRootScopeV2(scope, { expected, epoch: scope.epoch, instanceId: scope.instanceId });
    const u = await systemUnitV2(scope.unit), cg = await fs.lstat(scope.cgroup.v2Path, { bigint: true });
    const self = (await fs.readFile('/proc/self/cgroup', 'utf8')).trim();
    if (u.Id !== scope.unit || u.ActiveState !== 'active' || u.Transient !== 'yes' || u.StopWhenUnneeded !== 'no' || u.User ||
        u.Description !== `PromptCut root closure ${expected.authorityId} epoch ${scope.epoch} ${scope.scopeId}` ||
        u.InvocationID !== scope.unitInvocationId || `/sys/fs/cgroup${u.ControlGroup}` !== scope.cgroup.v2Path ||
        !cg.isDirectory() || cg.isSymbolicLink() || cg.uid !== 0n || (cg.mode & 0o022n) ||
        String(cg.dev) !== scope.cgroup.dev || String(cg.ino) !== scope.cgroup.ino || await bootId() !== scope.bootId ||
        !/^0::\/[^\n]*$/.test(self) || `/sys/fs/cgroup${self.slice(3)}` === scope.cgroup.v2Path ||
        `/sys/fs/cgroup${self.slice(3)}`.startsWith(`${scope.cgroup.v2Path}/`)) fail('publisher-scope-changed');
    if ((await fs.statfs(scope.cgroup.v2Path)).type !== 0x63677270) fail('publisher-cgroup-not-v2');
    return scope;
  }
  async function exclusiveScope(scope, empty = false) {
    const prefix = `${scope.cgroup.v2Path}/${expected.unit}`;
    async function visit(p) {
      const st = await fs.lstat(p);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022)) fail('publisher-scope-not-exclusive');
      const pids = (await fs.readFile(path.join(p, 'cgroup.procs'), 'utf8')).trim().split('\n').filter(Boolean);
      if ((empty || p === scope.cgroup.v2Path) && pids.length) fail('publisher-scope-not-exclusive');
      for (const line of pids) {
        if (!/^[1-9][0-9]*$/.test(line)) fail('publisher-scope-not-exclusive');
        const proc = await procInfo(Number(line));
        if (proc.uid !== expected.uid || !(proc.cgroupPath === prefix || proc.cgroupPath.startsWith(`${prefix}/`)))
          fail('publisher-scope-not-exclusive');
      }
      for (const item of await fs.readdir(p, { withFileTypes: true })) if (item.isDirectory()) {
        const child = path.join(p, item.name);
        if (!(child === prefix || child.startsWith(`${prefix}/`))) fail('publisher-scope-not-exclusive');
        await visit(child);
      }
    }
    await visit(scope.cgroup.v2Path);
  }
  async function inspectV2(reservation) {
    validateAssetRootReservationV2(reservation, { expected });
    await configuration(reservation); await scopeInfo(reservation.closureScope);
    const instance = await inspect({ ...expected, cgroupPath: reservation.serviceCgroupPath }, reservation);
    await exclusiveScope(reservation.closureScope);
    await configuration(reservation); await scopeInfo(reservation.closureScope);
    validateAssetRootInstanceV2(instance, { expected, closureScope: reservation.closureScope });
    return { instance, closureScope: reservation.closureScope };
  }
  const io = {
    uuid: randomUUID, scopeId: () => randomBytes(16).toString('hex'), read, write, lock: () => openPublisherLock(dir),
    async assertInitial() {
      if ((await fs.readdir(dir)).some(n => n !== '.publisher.lock')) fail('publisher-bootstrap-not-empty');
      const { unit } = await configuration();
      if (unit.ActiveState !== 'inactive' || Number(unit.MainPID) !== 0 || unit.ControlGroup || unit.Job)
        fail('publisher-bootstrap-unit-active');
      // Explicit fresh-authority bootstrap is not a witness for legacy work.
    },
    async createScope(plan) {
      const unit = assetClosureUnitV2(expected, plan), cgPath = `/sys/fs/cgroup/${unit}`;
      const u = await systemUnitV2(unit);
      if (u.Id !== unit || u.LoadState !== 'loaded' || u.ActiveState !== 'inactive' || u.SubState !== 'dead' || u.Transient !== 'no' ||
          u.Description !== `Slice /${unit.slice(0, -6)}` || u.StopWhenUnneeded !== 'no' || u.User || u.MainPID ||
          ['FragmentPath', 'SourcePath', 'DropInPaths', 'InvocationID', 'ControlGroup', 'Job', 'Following'].some(k => u[k] !== ''))
        fail('publisher-slice-collision');
      try { await fs.lstat(cgPath); fail('publisher-slice-collision'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await externalV2('/usr/bin/busctl', ['--system', '--no-pager', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
        'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))', unit, 'fail', '2', 'Description', 's',
        `PromptCut root closure ${expected.authorityId} epoch ${plan.epoch} ${plan.scopeId}`, 'StopWhenUnneeded', 'b', 'false', '0']);
      const deadline = Date.now() + 10000; let active;
      do { active = await systemUnitV2(unit); if (active.ActiveState === 'active') break;
        if (active.ActiveState === 'failed') fail('publisher-slice-start-failed');
        await new Promise(r => setTimeout(r, 20));
      } while (Date.now() < deadline);
      const st = await fs.lstat(cgPath, { bigint: true }), currentBoot = await bootId();
      const scope = { ...plan, authorityId: expected.authorityId, kind: 'systemd-slice', unit,
        unitInvocationId: active.InvocationID, bootId: currentBoot,
        cgroup: { v2Path: cgPath, dev: String(st.dev), ino: String(st.ino), bootId: currentBoot } };
      await scopeInfo(scope); await exclusiveScope(scope, true);
      if (!/^populated 0$/m.test(await fs.readFile(path.join(cgPath, 'cgroup.events'), 'utf8'))) fail('publisher-scope-not-empty');
      return scope;
    },
    async configureService(reservation) {
      const previous = await configuration();
      if (previous.unit.ActiveState !== 'inactive' || Number(previous.unit.MainPID) !== 0 || previous.unit.Job)
        fail('publisher-unit-not-stopped');
      await scopeInfo(reservation.closureScope); await exclusiveScope(reservation.closureScope, true);
      const ownDir = path.dirname(adapter.ownDropInPath); await rootDirectory(path.dirname(ownDir));
      try { await fs.mkdir(ownDir, { mode: 0o755 }); await fs.chmod(ownDir, 0o755); await syncDirectory(path.dirname(ownDir)); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      await rootDirectory(ownDir);
      await write(`runtime-backup-${reservation.epoch}.json`, { v: 2, authorityId: expected.authorityId, epoch: reservation.epoch,
        path: adapter.ownDropInPath, previousReceipt: previous.receipt, previousText: previous.content?.toString('utf8') ?? null }, true);
      const file = await writePublisherTextV2({ filename: adapter.ownDropInPath, text: sliceTextV2(expected, reservation), previous: previous.receipt?.file ?? null });
      await write(receiptName, { v: 2, authorityId: expected.authorityId, epoch: reservation.epoch, unit: expected.unit,
        path: adapter.ownDropInPath, scopeUnit: reservation.closureScope.unit, file, adapterDigest: digestOf(adapter) });
      await exec(['daemon-reload']);
      const loaded = await configuration(reservation);
      if (loaded.unit.ActiveState !== 'inactive' || Number(loaded.unit.MainPID) !== 0 || loaded.unit.Job) fail('publisher-unit-not-stopped');
      await scopeInfo(reservation.closureScope); await exclusiveScope(reservation.closureScope, true);
    },
    async start(reservation) {
      const state = await configuration(reservation);
      if (state.unit.ActiveState !== 'inactive' || Number(state.unit.MainPID) !== 0 || state.unit.Job) fail('publisher-unit-not-stopped');
      await scopeInfo(reservation.closureScope); await exclusiveScope(reservation.closureScope, true);
      await exec(['start', expected.unit, '--no-ask-password']);
    },
    inspect: inspectV2,
    async identity(reservation) {
      const original = await inspectV2(reservation);
      for (let attempt = 0; ; attempt++) {
        try { return await freshIdentity(config.identity, expected); }
        catch (error) {
          if (!error.retryable || attempt >= 6) throw error;
          if (!equal(original, await inspectV2(reservation))) fail('publisher-instance-changed');
          await new Promise(resolve => setTimeout(resolve, Math.min(100 * 2 ** attempt, 1600)));
          if (!equal(original, await inspectV2(reservation))) fail('publisher-instance-changed');
        }
      }
    },
    async pinPrevious(old) {
      const reservation = await read(`reservation-${old.epoch}.json`);
      if (!equal(await inspectV2(reservation), { instance: old.instance, closureScope: old.closureScope })) fail('publisher-previous-instance-mismatch');
      const scope = old.closureScope, group = await fs.open(scope.cgroup.v2Path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      let events;
      try {
        events = await fs.open(`/proc/self/fd/${group.fd}/cgroup.events`, constants.O_RDONLY | constants.O_NOFOLLOW);
        const empty = async () => {
          await scopeInfo(scope);
          const st = await group.stat({ bigint: true });
          if (String(st.dev) !== scope.cgroup.dev || String(st.ino) !== scope.cgroup.ino) fail('publisher-scope-changed');
          const buf = Buffer.alloc(4096), { bytesRead } = await events.read(buf, 0, buf.length, 0);
          const match = /^populated ([01])$/m.exec(buf.subarray(0, bytesRead).toString('utf8'));
          if (!match) fail('publisher-cgroup-observation-invalid');
          return match[1] === '0';
        };
        const stopped = async () => {
          const { unit } = await configuration(reservation);
          if (unit.ActiveState !== 'inactive' || Number(unit.MainPID) !== 0 || unit.Job) fail('publisher-unit-not-stopped');
          try { if (parseProcStat(await fs.readFile(`/proc/${old.instance.pid}/stat`, 'utf8')).startTicks === old.instance.pidBirth.startTicks)
            fail('publisher-old-birth-live'); }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (!await empty()) fail('publisher-closure-unproved');
          await exclusiveScope(scope, true);
        };
        return {
          async stopAndObserve() {
            if (!equal(await inspectV2(reservation), { instance: old.instance, closureScope: scope })) fail('publisher-previous-instance-mismatch');
            const stopping = exec(['stop', expected.unit, '--no-ask-password']).then(() => true, () => false);
            let observed = false;
            try {
              const deadline = Date.now() + 120000;
              do { if (await empty()) { observed = true; break; } await new Promise(r => setTimeout(r, 20)); } while (Date.now() < deadline);
            } finally { if (!await stopping) fail('publisher-stop-failed'); }
            if (!observed) fail('publisher-closure-unproved');
            await stopped();
            return { kind: 'cgroup-empty', closed: true, at: Date.now(), bootId: old.instance.bootId,
              serviceInstance: old.instance, closureScope: scope, scopeActive: true, scopeExclusive: true,
              populated: 0, serviceInactive: true, mainBirthGone: true };
          },
          async releaseScope() { await stopped(); await exec(['stop', scope.unit, '--no-ask-password']);
            const after = await systemUnitV2(scope.unit);
            if (after.ActiveState !== 'inactive' || after.Job) fail('publisher-scope-release-incomplete'); },
          async close() { await events.close(); await group.close(); },
        };
      } catch (e) { await events?.close(); await group.close(); throw e; }
    },
  };
  return await publishAssetRootRegistryV2({ expected, mode, io });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || !['--config', '--config-v2'].includes(args[0]) || !['--initialize', '--rotate'].includes(args[2])) fail('publisher-cli-invalid');
    const run = args[0] === '--config-v2' ? runAssetRootPublisherV2 : runAssetRootPublisher;
    const result = await run({ configFile: args[1], mode: args[2].slice(2) });
    process.stdout.write(JSON.stringify({ ok: true, epoch: result.epoch, recordDigest: result.recordDigest, anchorDigest: result.anchorDigest }) + '\n');
  } catch (e) {
    process.stderr.write(JSON.stringify({ ok: false, code: /^publisher-[a-z-]+$/.test(e.code ?? '') ? e.code : 'publisher-failed' }) + '\n');
    process.exitCode = 1;
  }
}
