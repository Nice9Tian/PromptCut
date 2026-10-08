import { createPublicKey, sign, verify } from 'node:crypto';
import { canonical, digest, historyError } from '../docservice/modules/operation-history.mjs';

const fields = ['requestId', 'docAuthorityId', 'projectId', 'opId', 'payloadDigest', 'preparedDigest'];
export function operationBinding(operation) {
  const result = Object.fromEntries(fields.map((field) => [field, operation[field]]));
  const actor = operation.actorRef ?? operation.actor;
  result.actorRef = Object.fromEntries(['accountId', 'loginId', 'credentialId', 'loginGeneration', 'runGrantId', 'runId', 'messageId', 'conversationId'].filter((field) => actor[field] !== undefined).map((field) => [field, actor[field]]));
  return result;
}
export function createWitnessVerifier({ keys, issuer = 'visuhive-account' } = {}) {
  return (witness, operation = null) => {
    const { signature, ...body } = witness ?? {};
    let valid = false;
    try {
      const configured = keys instanceof Map ? keys.get(body.keyId) : keys?.[body.keyId];
      const key = configured?.type === 'public' ? configured : createPublicKey(configured);
      valid = key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(canonical(body)), key, Buffer.from(signature, 'base64url'));
    } catch {}
    if (!valid || body.v !== 1 || body.domain !== 'visuhive.account-order' || body.issuer !== issuer ||
        !['reserved', 'sealed', 'cancelled'].includes(body.state) ||
        (body.state === 'sealed' ? !Number.isSafeInteger(body.orderSeq) || body.orderSeq < 1 : body.orderSeq !== null)) throw historyError('bad-witness', 403);
    if (operation && (body.kind !== 'operation' || canonical(operationBinding(witness)) !== canonical(operationBinding(operation)))) throw historyError('witness-binding-mismatch', 403);
    return witness;
  };
}
export function signDocProof(value, privateKey) {
  const { signature, ...body } = value;
  return { ...body, signature: sign(null, Buffer.from(canonical(body)), privateKey).toString('base64url') };
}
export function retainedOperationProof(operation, witness, grant, privateKey) {
  const actor = operation.actor;
  if (grant.state !== 'retained' || grant.visibilityAtRead !== 'shared' || grant.readConfirmed !== true || grant.currentRun !== true ||
      ['projectId', 'runId', 'messageId', 'conversationId', 'runGrantId'].some((field) => grant[field] !== (field === 'projectId' ? operation.projectId : actor[field]))) throw historyError('invalid-retained-grant', 403);
  return signDocProof({ v: 1, domain: 'promptcut.retained-operation', ...operationBinding(operation), witnessId: witness.witnessId,
    state: 'retained', visibilityAtRead: 'shared', readConfirmed: true, currentRun: true, readReceiptId: grant.readReceiptId, fenceRevision: grant.fenceRevision }, privateKey);
}
export function activeRunOperationProof(operation, witness, grant, privateKey) {
  const actor = operation.actor;
  if (grant.state !== 'active' || grant.readConfirmed !== true || grant.currentRun !== true ||
      ['projectId', 'runId', 'messageId', 'conversationId', 'runGrantId'].some(field => grant[field] !== (field === 'projectId' ? operation.projectId : actor[field])) ||
      ['accountId', 'loginId', 'credentialId', 'loginGeneration'].some(field => grant[field] !== actor[field]) ||
      grant.messageRef?.projectId !== operation.projectId || grant.messageRef?.conversationId !== actor.conversationId ||
      grant.messageRef?.messageId !== actor.messageId || !/^[0-9a-f]{64}$/.test(grant.messageRef?.recordDigest))
    throw historyError('invalid-active-run-grant', 403);
  return signDocProof({ v: 1, domain: 'promptcut.active-run-operation', ...operationBinding(operation), witnessId: witness.witnessId,
    state: 'active', readConfirmed: true, currentRun: true, readReceiptId: grant.readReceiptId,
    fenceRevision: grant.fenceRevision, messageRef: grant.messageRef }, privateKey);
}

/** request is the owner's authenticated doc mTLS transport, never a user-supplied URL. */
export function createAccountOrderClient({ request, timeoutMs = 15_000 } = {}) {
  if (typeof request !== 'function') throw historyError('order-unavailable', 503);
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(historyError('order-outcome-unknown', 503)), timeoutMs);
    Promise.resolve().then(() => request({ method, path, body })).then((value) => {
      if (Object.hasOwn(value ?? {}, 'ok')) {
        if (value.ok !== true) throw historyError(value.code ?? 'order-unavailable', 503);
        const { ok, ...witness } = value; return witness;
      }
      return value;
    }).then(resolve, reject).finally(() => clearTimeout(timer));
  });
  return {
    reserve: (body) => call('POST', '/internal/v2/order/reserve', body),
    get: (id) => call('GET', `/internal/v2/order/${encodeURIComponent(id)}`),
    seal: (id, body) => call('POST', `/internal/v2/order/${encodeURIComponent(id)}/seal`, body),
    cancel: (id, body) => call('POST', `/internal/v2/order/${encodeURIComponent(id)}/cancel`, body),
    logoutComplete: (body) => call('POST', '/internal/v2/order/logout-complete', body),
  };
}
function affected(fence, operation) {
  const actor = operation.actor;
  if (fence.kind === 'delete') return true;
  if (fence.kind === 'agent-disabled') return fence.runIds.includes(actor.runId);
  if (fence.kind === 'stop') return actor.runId === fence.runId;
  if (fence.kind === 'private') return fence.runIds.includes(actor.runId) && actor.conversationId === fence.conversationId && actor.accountId !== fence.ownerAccountId;
  if (fence.kind === 'credential') {
    if (!fence.loginIds.includes(actor.loginId)) return false;
    return !(fence.retainedRuns ?? []).some((run) => ['accountId', 'loginId', 'credentialId', 'loginGeneration', 'runGrantId', 'runId', 'messageId', 'conversationId'].every((field) => run[field] !== undefined && run[field] === actor[field]));
  }
  throw historyError('bad-fence');
}

/** All document submit/fence entry points must use this one coordinator and its history store. */
export function createPasswordOrder({ history, account, verifyWitness, checkGate, docAttestationPrivateKey, failpoint = () => {}, acknowledgeFence, onFenceRequested, materializeAccepted, initializeProject } = {}) {
  if (!history || !account || typeof verifyWitness !== 'function' || typeof checkGate !== 'function') throw historyError('order-unavailable', 503);
  const queues = new Map();
  const reconciled = new Set();
  async function query(witnessId) { try { return await account.get(witnessId); } catch (error) { if (error.code === 'witness-not-found' || error.status === 404) throw historyError('needs-reconciliation'); throw error; } }
  function locked(projectId, fn) {
    const work = (queues.get(projectId) ?? Promise.resolve()).then(fn);
    const tail = work.catch(() => {}); queues.set(projectId, tail);
    return work.finally(() => { if (queues.get(projectId) === tail) queues.delete(projectId); });
  }
  function localGate(operation) { if (history.fences(operation.projectId).some((fence) => affected(fence, operation))) throw historyError('operation-fenced', 403); }
  async function gate(operation, phase, witness = null) {
    localGate(operation);
    const result = await checkGate({ operation, phase, witness });
    if (result?.allowed !== true) throw historyError('operation-forbidden', 403);
    localGate(operation); // A control-plane fence may arrive while the owner checks its authorities.
    if (result.retainedGrant && history.fences(operation.projectId).some((fence) => fence.kind === 'private' && fence.runIds.includes(operation.actor.runId) && fence.conversationId === operation.actor.conversationId)) throw historyError('private-overrides-retained', 403);
    return result;
  }
  async function accept(operation, witness) {
    verifyWitness(witness, operation);
    if (witness.state !== 'sealed') throw historyError('not-accepted');
    history.verifyPrepared(operation);
    const accepted = history.recordAcceptedOperation(operation, witness); failpoint('accepted-after-commit');
    const materialized = history.materialize(accepted); failpoint('materialize-after-commit');
    await materializeAccepted?.(materialized);
    return materialized;
  }
  async function resolveWitness(operation, { resume = false } = {}) {
    history.verifyPrepared(operation);
    const binding = operationBinding(operation);
    let witness = operation.witness ? await query(operation.witness.witnessId) : await account.reserve(binding);
    verifyWitness(witness, operation);
    if (witness.state === 'sealed') return accept(operation, witness);
    if (witness.state === 'cancelled') return history.cancelOperation(operation, witness);
    history.recordWitness(operation, witness); failpoint('reserved-after-commit');
    if (!resume) {
      witness = await account.cancel(witness.witnessId, binding); verifyWitness(witness, operation);
      return witness.state === 'sealed' ? accept(operation, witness) : history.cancelOperation(operation, witness);
    }
    let authorization;
    try { authorization = await gate(operation, 'before-seal', witness); }
    catch (error) {
      const cancelled = await account.cancel(witness.witnessId, binding); verifyWitness(cancelled, operation);
      if (cancelled.state === 'sealed') return accept(operation, cancelled);
      history.cancelOperation(operation, cancelled); throw error;
    }
    failpoint('before-seal');
    const body = { ...binding };
    if (authorization.retainedGrant) body.retainedProof = retainedOperationProof(operation, witness, authorization.retainedGrant, docAttestationPrivateKey);
    if (authorization.activeGrant) body.activeRunProof = activeRunOperationProof(operation, witness, authorization.activeGrant, docAttestationPrivateKey);
    let sealed;
    try { sealed = await account.seal(witness.witnessId, body); }
    catch (error) {
      if (!body.activeRunProof || error.status !== 401) throw error;
      // Account may see exit before doc receives its event. Recheck under THIS lock;
      // only doc's exact shared-current retained exception can continue this prepared op.
      const renewed = await gate(operation, 'active-seal-rejected', witness);
      if (!renewed.retainedGrant) throw error;
      const retainedProof = retainedOperationProof(operation, witness, renewed.retainedGrant, docAttestationPrivateKey);
      sealed = await account.seal(witness.witnessId, { ...binding, retainedProof });
    }
    failpoint('seal-ack');
    return accept(operation, sealed);
  }
  async function recoverProject(projectId, { resumeOpId } = {}) {
    await initializeProject?.(projectId);
    for (const fence of history.fences(projectId)) if (fence.state === 'requested') onFenceRequested?.(fence);
    history.validate(projectId);
    if (!reconciled.has(projectId)) {
      for (const op of history.accepted(projectId)) {
        const witness = await query(op.witness.witnessId); verifyWitness(witness, op);
        if (canonical(witness) !== canonical(op.witness)) throw historyError('needs-reconciliation');
      }
      reconciled.add(projectId);
    }
    for (const operation of history.pending(projectId)) if (operation.opId !== resumeOpId) await resolveWitness(operation);
    const latest = history.accepted(projectId).at(-1);
    if (latest) await materializeAccepted?.(latest);
    for (const fence of history.fences(projectId)) if (fence.state === 'requested') { const { state, ...body } = fence; history.commitFence(body); }
  }
  async function submitUnlocked(spec) {
      const prior = history.get(spec.projectId, spec.opId);
      if (prior) {
        history.validate(spec.projectId);
        history.prepareOperation(spec); // Checks the complete immutable request, including actor and result.
        if (prior.state === 'materialized') { const witness = await query(prior.witness.witnessId); verifyWitness(witness, prior); if (canonical(witness) !== canonical(prior.witness)) throw historyError('needs-reconciliation'); return prior; }
        if (prior.state === 'cancelled') throw historyError('operation-cancelled');
        return resolveWitness(prior, { resume: true });
      }
      await recoverProject(spec.projectId);
      await gate(spec, 'before-prepare');
      const operation = history.prepareOperation(spec); failpoint('prepared-after-commit');
      return resolveWitness(operation, { resume: true });
  }
  const submit = (spec) => locked(spec.projectId, () => submitUnlocked(spec));
  // The owner constructs the immutable specification under this SAME lock, after recovery.
  // A scope cannot escape its callback or submit into another project's lock.
  const transact = (projectId, work, { resumeOpId } = {}) => locked(projectId, async () => {
    await recoverProject(projectId, { resumeOpId });
    let active = true;
    try { return await work({ submit(spec) {
      if (!active || spec.projectId !== projectId) throw historyError('invalid-operation-scope');
      return submitUnlocked(spec);
    } }); } finally { active = false; }
  });
  function fence(value) {
    if (!value?.id || !value.projectId || !['stop', 'private', 'delete', 'agent-disabled', 'credential'].includes(value.kind)) throw historyError('bad-fence', 400);
    if (['private', 'agent-disabled'].includes(value.kind) && (!Array.isArray(value.runIds) || value.runIds.some((run) => typeof run !== 'string' || !run))) throw historyError('bad-fence', 400);
    if (value.kind === 'private' && (!value.conversationId || !value.ownerAccountId)) throw historyError('bad-fence', 400);
    if (value.kind === 'stop' && !value.runId) throw historyError('bad-fence', 400);
    if (value.kind === 'credential' && (!Array.isArray(value.loginIds) || value.loginIds.some((login) => typeof login !== 'string' || !login))) throw historyError('bad-fence', 400);
    history.requestFence(value); // Durable request pauses affected new writes/read control immediately; not completion.
    failpoint('fence-request-after-commit');
    onFenceRequested?.(value); // Owner synchronously closes/rejects reads and tool dispatch; errors cannot undo the durable pause.
    return locked(value.projectId, async () => {
      await recoverProject(value.projectId);
      history.commitFence(value); failpoint('fence-after-commit');
      const ack = history.fenceReceipt(value.id) ?? (acknowledgeFence ? await acknowledgeFence(value) : null);
      if (ack?.durable === true) history.recordFenceReceipt(value, ack);
      failpoint('fence-ack-after-commit');
      return { ...value, state: 'committed', complete: ack?.durable === true, acknowledgement: ack ?? null };
    });
  }
  return { submit, transact, fence, assertUnfenced: localGate, idle: () => Promise.all([...queues.values()]),
    recover: (projectId) => locked(projectId, () => recoverProject(projectId)) };
}

/** 0.7.18 only records the candidate interval; no compensation is performed. */
export function passwordCandidates({ event, operations, projectId }) {
  if (event.choice !== 'exit') return { state: 'retained', candidates: [], exempt: [] };
  const start = event.changeSeq ?? event.change_seq; const end = event.endOrderSeq ?? event.end_order_seq;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return { state: 'needs-reconciliation', candidates: [], exempt: [] };
  const candidates = []; const exempt = [];
  for (const operation of operations) {
    const actor = operation.actor; const witness = operation.witness;
    if (!['accepted', 'materialized'].includes(operation.state) || operation.projectId !== projectId || actor.accountId !== (event.accountId ?? event.account_id) ||
        !event.oldLoginIds.includes(actor.loginId) || !Number.isSafeInteger(actor.loginGeneration) || !actor.credentialId || witness?.state !== 'sealed' || !Number.isSafeInteger(witness.orderSeq) || witness.orderSeq <= start || witness.orderSeq > end) continue;
    const grant = witness.authorization;
    if (grant?.kind === 'retained' && grant.projectId === projectId && ['runGrantId', 'runId', 'messageId', 'conversationId'].every((key) => grant[key] === actor[key])) exempt.push(operation.opId);
    else candidates.push(operation.opId);
  }
  return { state: 'retained', candidateRange: { changeSeq: start, endOrderSeq: end }, candidates, exempt };
}
