/** Internal CAS over the directory's durable records. No project bytes or raw credentials.
 * HTTP authentication is owned by service.mjs; target readiness proves the new host key.
 */
import { isDeviceId, isProjectId } from '../auth/protocol.mjs';
import { isRelocationId, relocationTarget, relocationManifest } from '../recovery/relocation.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const refuse = reason => { throw Object.assign(new Error('Relocation rejected'), { reason }); };
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function relocationPending(rec) {
  if (!Object.hasOwn(rec ?? {}, 'move')) return false;
  const m = rec.move;
  return !m || m.version !== 1 || !isRelocationId(m.txnId) || m.phase !== 'committed'
    || !Number.isSafeInteger(m.sourceEpoch) || m.sourceEpoch < 1 || m.targetEpoch !== m.sourceEpoch + 1
    || rec.hostingEpoch !== m.targetEpoch || !relocationTarget(m.target) || !relocationManifest(m.manifest)
    || !digest(m.sourceVerifier) || !digest(m.targetVerifier) || !isDeviceId(m.targetDeviceId)
    || rec.location?.txnId !== m.txnId || rec.location?.epoch !== m.targetEpoch
    || !same(rec.location.target, m.target) || !same(rec.location.manifest, m.manifest);
}
export function createRelocationDirectory({ peek, commit, retire }) {
  const epoch = rec => rec.hostingEpoch ?? 1;
  function current(roomId) {
    if (!isProjectId(roomId)) refuse('bad-relocation');
    const rec = peek(roomId);
    if (!rec || rec.deleted) refuse(rec ? 'deleted' : 'no-project');
    return rec;
  }
  const result = rec => structuredClone({ roomId: rec.roomId, epoch: epoch(rec), ...(rec.location ? { location: rec.location } : {}), move: rec.move ?? null });
  function match(move, body) {
    return !!move && move.txnId === body.txnId && move.sourceEpoch === body.expectedEpoch
      && same(move.target, relocationTarget(body.target)) && same(move.manifest, relocationManifest(body.manifest))
      && move.targetVerifier === body.targetVerifier;
  }
  return {
    begin(body) {
      const rec = current(body.roomId), target = relocationTarget(body.target), manifest = relocationManifest(body.manifest);
      if (!isRelocationId(body.txnId) || !target || !manifest || !digest(body.targetVerifier)
        || !Number.isSafeInteger(body.expectedEpoch) || body.expectedEpoch < 1 || !Number.isSafeInteger(body.expectedEpoch + 1)) refuse('bad-relocation');
      if (match(rec.move, body)) return result(rec);
      if (body.targetVerifier === rec.hostVerifier) refuse('bad-relocation');
      if (relocationPending(rec) || epoch(rec) !== body.expectedEpoch) refuse('relocation-conflict');
      const move = { version: 1, txnId: body.txnId, phase: 'prepared', sourceEpoch: body.expectedEpoch,
        targetEpoch: body.expectedEpoch + 1, sourceVerifier: rec.hostVerifier, sourceDeviceId: rec.deviceId,
        target, targetVerifier: body.targetVerifier, manifest };
      commit(rooms => { rooms[body.roomId].move = move; });
      retire(body.roomId); return result(peek(body.roomId));
    },
    ready(body) {
      const rec = current(body.roomId), move = rec.move;
      if (!isRelocationId(body.txnId) || move?.txnId !== body.txnId || !['prepared', 'ready', 'committed'].includes(move.phase)
        || move.targetEpoch !== body.epoch || !same(move.manifest, relocationManifest(body.manifest))
        || !isDeviceId(body.deviceId) || move.target.where === 'lan' && move.target.deviceId !== body.deviceId) refuse('relocation-conflict');
      if (move.targetDeviceId && move.targetDeviceId !== body.deviceId) refuse('host-conflict');
      if (move.phase !== 'prepared') return result(rec);
      commit(rooms => { rooms[body.roomId].move = { ...move, phase: 'ready', targetDeviceId: body.deviceId }; });
      return result(peek(body.roomId));
    },
    publish(body) {
      const rec = current(body.roomId), move = rec.move;
      if (!match(move, body)) refuse('relocation-conflict');
      if (move.phase === 'committed' && epoch(rec) === move.targetEpoch) return result(rec);
      if (move.phase !== 'ready' || epoch(rec) !== move.sourceEpoch) refuse('relocation-not-ready');
      commit(rooms => {
        const draft = rooms[body.roomId];
        draft.hostingEpoch = move.targetEpoch; draft.deviceId = move.targetDeviceId; draft.hostVerifier = move.targetVerifier;
        draft.location = { roomId: body.roomId, txnId: move.txnId, epoch: move.targetEpoch, target: move.target, manifest: move.manifest };
        draft.move = { ...move, phase: 'committed' };
      });
      retire(body.roomId); return result(peek(body.roomId));
    },
    status(roomId) { return result(current(roomId)); },
  };
}
