/** Doc-owned high water for the root asset publication. Root files are read on
 * every gate; this durable row is never a substitute for their current state. */
import { accountError } from '../account/client.mjs';
import { digestOf } from '../account/ledger.mjs';
import { readRootRunAssetCandidate } from './run-assets-current-registry.mjs';

const fail = code => { throw accountError(503, code); };
const same = (a, b) => a && b && digestOf(a) === digestOf(b);

export function assertRunAssetCheckpointTransition(previous, candidate) {
  const next = candidate?.checkpoint, record = candidate?.record;
  if (!next || !record || record.state !== 'active') fail('asset-current-epoch-unaccepted');
  if (!previous) {
    if (next.epoch !== 1 || record.previous !== null) fail('asset-current-anchor-invalid');
  } else if (same(previous, next)) return next;
  else if (previous.authorityId !== next.authorityId || previous.anchorDigest !== next.anchorDigest ||
      next.epoch !== previous.epoch + 1 || record.previous?.registryDigest !== previous.recordDigest ||
      record.previous?.epoch !== previous.epoch) fail('asset-current-epoch-unaccepted');
  return next;
}

export function createRunAssetCheckpoint({ ledger, files, expected } = {}) {
  if (typeof ledger?.read !== 'function' || typeof ledger?.transaction !== 'function' ||
      ledger.authorityId !== expected?.authorityId || !files) fail('asset-current-checkpoint-unconfigured');
  const read = () => readRootRunAssetCandidate({ ...files, expected });
  const checkpointOf = () => ledger.read().runAssetCurrentCheckpointV1 ?? null;
  function current() {
    const checkpoint = checkpointOf();
    if (!checkpoint) fail('asset-current-epoch-unaccepted');
    const candidate = read();
    if (!same(candidate.checkpoint, checkpoint)) fail('asset-current-epoch-unaccepted');
    return Object.freeze({ ...candidate.checkpoint, instance: structuredClone(candidate.record.instance) });
  }
  function acceptCurrent() {
    const first = read();
    const previous = checkpointOf();
    assertRunAssetCheckpointTransition(previous, first);
    // The root publication and the existing checkpoint are checked again
    // inside the same durable SQLite transaction that advances the high water.
    ledger.transaction(state => {
      if (!same(state.runAssetCurrentCheckpointV1 ?? null, previous) &&
          !(state.runAssetCurrentCheckpointV1 == null && previous == null)) fail('asset-current-checkpoint-changed');
      const second = read();
      if (!same(second.checkpoint, first.checkpoint) || !same(second.record, first.record) ||
          !same(second.publication, first.publication)) fail('asset-current-registry-changed');
      state.runAssetCurrentCheckpointV1 = assertRunAssetCheckpointTransition(previous, second);
    });
    // A later publisher may already have acquired its lock: do not expose an
    // accepted identity until a fresh root read still matches the commit.
    return current();
  }
  return Object.freeze({ current, acceptCurrent });
}
