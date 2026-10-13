/** Explicit v2 root publication reader and doc-owned high water. No v1 file,
 * checkpoint or service-leaf-only witness is ever interpreted as v2. */
import fs from 'node:fs';
import path from 'node:path';
import { accountError } from '../account/client.mjs';
import { digestOf } from '../account/ledger.mjs';
import { assertRootAssetPublisherUnlocked, readRootAssetEvidenceFile } from './run-assets-current-registry.mjs';
import { validateAssetRootExpectedV2, validateAssetRootReservationV2,
  validateAssetRootHistoryV2, validateAssetRootCheckpointV2 } from './asset-root-registry-schema-v2.mjs';

const fail = code => { throw accountError(503, code); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => a != null && b != null && digestOf(a) === digestOf(b);
function unavailable(error) {
  if (error?.status) throw error;
  if (typeof error?.code === 'string' && error.code.startsWith('asset-root-v2-')) fail(error.code);
  fail('asset-root-v2-unavailable');
}
function directoryStamp(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022))
    fail('asset-root-v2-untrusted');
  return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
}
function sourceDirectory(files) {
  if (process.platform !== 'linux' || !files || typeof files !== 'object') fail('asset-root-v2-unavailable');
  const { registryFile, anchorFile, reservationFile, publisherLockFile } = files;
  if (![registryFile, anchorFile, reservationFile, publisherLockFile].every(value =>
    typeof value === 'string' && path.isAbsolute(value))) fail('asset-root-v2-unavailable');
  const dir = path.dirname(registryFile);
  if (registryFile !== path.join(dir, 'current.json') || anchorFile !== path.join(dir, 'anchor.json') ||
      reservationFile !== path.join(dir, 'reservation.json') ||
      publisherLockFile !== path.join(dir, '.publisher.lock')) fail('asset-root-v2-untrusted');
  return dir;
}
const epochFile = (dir, kind, epoch) => path.join(dir, `${kind}-${epoch}.json`);

/** The asset service freezes this root-owned reservation once at OS start.
 * It is an identity reference, never an accepted current grant. */
export function readRootAssetReservationV2({ reservationFile, expected } = {}) {
  try {
    if (process.platform !== 'linux' || typeof reservationFile !== 'string' || !path.isAbsolute(reservationFile) ||
        path.basename(reservationFile) !== 'reservation.json') fail('asset-root-v2-unavailable');
    validateAssetRootExpectedV2(expected);
    return Object.freeze(validateAssetRootReservationV2(readRootAssetEvidenceFile(reservationFile), { expected }));
  } catch (error) { unavailable(error); }
}

/** Read every immutable epoch from the trusted epoch-1 anchor to the current
 * root publication. The absent lock and completion marker are checked before
 * and after; the producer's root-only fsync-before-unlock protocol is required. */
export function readRootRunAssetCandidateV2({ files, expected, configuredAnchorDigest } = {}) {
  try {
    validateAssetRootExpectedV2(expected);
    if (!hash(configuredAnchorDigest)) fail('asset-root-v2-anchor-unconfigured');
    const dir = sourceDirectory(files), firstDirectory = directoryStamp(dir);
    assertRootAssetPublisherUnlocked(files.publisherLockFile);
    const record = readRootAssetEvidenceFile(files.registryFile);
    const anchor = readRootAssetEvidenceFile(files.anchorFile);
    if (digestOf(anchor) !== configuredAnchorDigest || !Number.isSafeInteger(record?.epoch) || record.epoch < 1)
      fail('asset-root-v2-anchor-invalid');
    const entries = [];
    for (let epoch = 1; epoch <= record.epoch; epoch++) entries.push({
      record: readRootAssetEvidenceFile(epochFile(dir, 'epoch', epoch)),
      reservation: readRootAssetEvidenceFile(epochFile(dir, 'reservation', epoch)),
      witness: epoch === 1 ? null : readRootAssetEvidenceFile(epochFile(dir, 'witness', epoch)),
      publication: readRootAssetEvidenceFile(epochFile(dir, 'publication', epoch)),
    });
    if (!same(record, entries.at(-1)?.record) ||
        !same(readRootAssetEvidenceFile(files.reservationFile), entries.at(-1)?.reservation))
      fail('asset-root-v2-history-invalid');
    const checkpoint = validateAssetRootHistoryV2({ entries, currentRecord: record, anchor, expected, publisherLocked: false });
    assertRootAssetPublisherUnlocked(files.publisherLockFile);
    if (!same(directoryStamp(dir), firstDirectory) || !same(readRootAssetEvidenceFile(files.registryFile), record) ||
        !same(readRootAssetEvidenceFile(files.anchorFile), anchor) ||
        !same(readRootAssetEvidenceFile(files.reservationFile), entries.at(-1).reservation))
      fail('asset-root-v2-changed');
    for (let epoch = 1; epoch <= entries.length; epoch++) {
      const entry = entries[epoch - 1];
      if (!same(readRootAssetEvidenceFile(epochFile(dir, 'epoch', epoch)), entry.record) ||
          !same(readRootAssetEvidenceFile(epochFile(dir, 'reservation', epoch)), entry.reservation) ||
          (epoch > 1 && !same(readRootAssetEvidenceFile(epochFile(dir, 'witness', epoch)), entry.witness)) ||
          !same(readRootAssetEvidenceFile(epochFile(dir, 'publication', epoch)), entry.publication))
        fail('asset-root-v2-changed');
    }
    assertRootAssetPublisherUnlocked(files.publisherLockFile);
    if (!same(directoryStamp(dir), firstDirectory)) fail('asset-root-v2-changed');
    return { record, anchor, entries, checkpoint };
  } catch (error) { unavailable(error); }
}

/** Pure transition rule. A missing checkpoint accepts only epoch 1. Later
 * gaps can advance only after the complete chain has been revalidated. */
export function assertRunAssetCheckpointTransitionV2(previous, candidate, expected) {
  try {
    const { checkpoint: next, record, anchor, entries } = candidate ?? {};
    if (!next || !record || !anchor || !Array.isArray(entries) || record.state !== 'active' ||
        next.v !== 2 || next.epoch !== record.epoch || !same(entries.at(-1)?.record, record))
      fail('asset-root-v2-checkpoint-invalid');
    validateAssetRootCheckpointV2(next, { record, anchor, expected });
    if (!previous) {
      if (next.epoch !== 1 || record.previous !== null) fail('asset-root-v2-anchor-invalid');
    } else {
      const prior = entries[previous.epoch - 1];
      if (!prior || previous.epoch > next.epoch) fail('asset-root-v2-epoch-unaccepted');
      validateAssetRootCheckpointV2(previous, { record: prior.record, anchor, expected });
      if (previous.epoch === next.epoch && !same(previous, next)) fail('asset-root-v2-changed');
    }
    return next;
  } catch (error) { unavailable(error); }
}

/** v2 has its own SQLite key. There is deliberately no implicit migration of
 * a previously accepted v1 grant or guessed checkpoint from a visible file. */
export function createRunAssetCurrentRegistryV2({ ledger, files, expected, configuredAnchorDigest } = {}) {
  if (typeof ledger?.read !== 'function' || typeof ledger?.transaction !== 'function' ||
      ledger.authorityId !== expected?.authorityId || !hash(configuredAnchorDigest) || !files)
    fail('asset-root-v2-checkpoint-unconfigured');
  try { validateAssetRootExpectedV2(expected); } catch (error) { unavailable(error); }
  const read = () => readRootRunAssetCandidateV2({ files, expected, configuredAnchorDigest });
  const checkpointOf = () => {
    const state = ledger.read();
    if (state.runAssetCurrentCheckpointV1) fail('asset-root-v2-v1-migration-required');
    return state.runAssetCurrentCheckpointV2 ?? null;
  };
  function current() {
    const checkpoint = checkpointOf();
    if (!checkpoint) fail('asset-root-v2-epoch-unaccepted');
    const candidate = read();
    if (!same(candidate.checkpoint, checkpoint)) fail('asset-root-v2-epoch-unaccepted');
    return Object.freeze({ ...candidate.checkpoint, instance: structuredClone(candidate.record.instance),
      closureScope: structuredClone(candidate.record.closureScope) });
  }
  function acceptCurrent() {
    const first = read(), previous = checkpointOf();
    assertRunAssetCheckpointTransitionV2(previous, first, expected);
    if (same(previous, first.checkpoint)) return current();
    ledger.transaction(state => {
      if (state.runAssetCurrentCheckpointV1) fail('asset-root-v2-v1-migration-required');
      if (!(previous == null && state.runAssetCurrentCheckpointV2 == null) &&
          !same(previous, state.runAssetCurrentCheckpointV2)) fail('asset-root-v2-checkpoint-changed');
      const second = read();
      if (!same(first, second)) fail('asset-root-v2-changed');
      state.runAssetCurrentCheckpointV2 = assertRunAssetCheckpointTransitionV2(previous, second, expected);
    });
    return current();
  }
  return Object.freeze({ current, acceptCurrent });
}
