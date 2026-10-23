import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { canonical, digest, historyError } from '../docservice/modules/operation-history.mjs';
import { isGuestId } from './guest.mjs';

/**
 * 游客的写入由文档服务自己定序（claude/guest-enter）。
 *
 * 账号的每一步写入都要账号服务（VisuHive）签一份顺序见证：它要把写入和改密码、退出登录这些账号事件排在同一条序列上，
 * 改密退出时才找得出「旧登录在改密之后还写了哪几步」（`logout-rollback.mjs`）。游客不在账号服务那里
 * （编号、令牌都由文档服务签发和核对，`guest.mjs`；语义 `product/document-service.md`「游客」），账号服务也不认 `gst_` 编号
 * （它回 400 `bad-actor`，0.7.21 线上游客建了项目也一步都写不进去）；游客也没有密码可改、没有账号事件要排。
 * 所以游客的那一步由文档服务用自己的证明钥签一份同形状的见证（域 `promptcut.guest-order`），顺序号是这个项目里游客见证自己的一条序列；
 * 账号见证与游客见证各自单调（`operation-history.mjs` 按见证的域分开核）。只给写入身份是游客的操作签，账号的操作照旧只认账号服务的见证。
 */
export const GUEST_ORDER_DOMAIN = 'promptcut.guest-order';
const GUEST_ORDER_ISSUER = 'promptcut-doc';
const actorOfOperation = (operation) => operation?.actorRef ?? operation?.actor;
export const isGuestOperation = (operation) => isGuestId(actorOfOperation(operation)?.accountId);

const fields = ['requestId', 'docAuthorityId', 'projectId', 'opId', 'payloadDigest', 'preparedDigest'];
export function operationBinding(operation) {
  const result = Object.fromEntries(fields.map((field) => [field, operation[field]]));
  const actor = operation.actorRef ?? operation.actor;
  // `rollbackEventId`：改密退出撤回的补偿操作（0.7.20，`logout-rollback.mjs`）。它不借任何登录的身份，只有账号号和那次退出的事件号。
  result.actorRef = Object.fromEntries(['accountId', 'loginId', 'credentialId', 'loginGeneration', 'runGrantId', 'runId', 'messageId', 'conversationId', 'rollbackEventId'].filter((field) => actor[field] !== undefined).map((field) => [field, actor[field]]));
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
/** 改密退出撤回的补偿操作：文档服务用证明钥签一份「这一步是事件 X 的撤回」，账号服务据此给它定序（核对事件确实是选了退出的改密）。
 * 这一份只能给写入身份是 `{ accountId, rollbackEventId }`、与授权里的事件和账号都对得上的操作。 */
export function rollbackOperationProof(operation, witness, grant, privateKey) {
  const actor = operation.actor;
  if (!grant || typeof grant.eventId !== 'string' || !grant.eventId || grant.eventId !== actor?.rollbackEventId || grant.accountId !== actor.accountId ||
      ['loginId', 'credentialId', 'loginGeneration', 'runGrantId', 'runId', 'messageId', 'conversationId'].some((field) => actor[field] !== undefined))
    throw historyError('invalid-rollback-grant', 403);
  return signDocProof({ v: 1, domain: 'promptcut.logout-rollback', ...operationBinding(operation), witnessId: witness.witnessId,
    eventId: grant.eventId }, privateKey);
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
  // 游客见证用文档服务的证明钥签、自己核（见文件头 GUEST_ORDER_DOMAIN）。没配证明钥的部署没有游客写入这条路，照旧回 order-unavailable
  let guestKey = null;
  try { guestKey = docAttestationPrivateKey ? (docAttestationPrivateKey.type === 'private' ? docAttestationPrivateKey : createPrivateKey(docAttestationPrivateKey)) : null; } catch { guestKey = null; }
  const guestPublic = guestKey ? createPublicKey(guestKey) : null;
  function guestWitness(operation, fields) {
    if (!guestKey) throw historyError('order-unavailable', 503);
    return signDocProof({ v: 1, domain: GUEST_ORDER_DOMAIN, issuer: GUEST_ORDER_ISSUER, kind: 'operation', ...operationBinding(operation), ...fields }, guestKey);
  }
  /** 和账号服务的定序接口同样的四个动作；顺序号只在封口时取（项目锁里），是这个项目游客见证的下一个号 */
  const guestOrder = (operation) => ({
    reserve: () => guestWitness(operation, { witnessId: `gw_${randomBytes(12).toString('hex')}`, state: 'reserved', orderSeq: null }),
    seal: (witnessId) => guestWitness(operation, { witnessId, state: 'sealed', orderSeq: history.lastOrderSeq(operation.projectId, GUEST_ORDER_DOMAIN) + 1 }),
    cancel: (witnessId) => guestWitness(operation, { witnessId, state: 'cancelled', orderSeq: null }),
  });
  const orderOf = (operation) => isGuestOperation(operation) ? guestOrder(operation) : account;
  function verifyGuestWitness(witness, operation) {
    const { signature, ...body } = witness ?? {};
    let valid = false;
    try { valid = !!guestPublic && verify(null, Buffer.from(canonical(body)), guestPublic, Buffer.from(signature, 'base64url')); } catch {}
    if (!valid || body.v !== 1 || body.issuer !== GUEST_ORDER_ISSUER || !['reserved', 'sealed', 'cancelled'].includes(body.state) ||
        (body.state === 'sealed' ? !Number.isSafeInteger(body.orderSeq) || body.orderSeq < 1 : body.orderSeq !== null)) throw historyError('bad-witness', 403);
    if (operation && (body.kind !== 'operation' || !isGuestOperation(operation) || canonical(operationBinding(witness)) !== canonical(operationBinding(operation))))
      throw historyError('witness-binding-mismatch', 403);
    return witness;
  }
  /** 游客域的见证只给游客的操作、自己核；别的一律交账号服务的核对（它只认账号服务签的） */
  const checkWitness = (witness, operation) => witness?.domain === GUEST_ORDER_DOMAIN ? verifyGuestWitness(witness, operation) : verifyWitness(witness, operation);
  async function query(operation) {
    // 游客见证没有别处可问:文档服务自己就是签发方,历史里存的那一份就是它(签名照样核)
    if (isGuestOperation(operation)) { if (!operation.witness) throw historyError('needs-reconciliation'); return operation.witness; }
    try { return await account.get(operation.witness.witnessId); } catch (error) { if (error.code === 'witness-not-found' || error.status === 404) throw historyError('needs-reconciliation'); throw error; }
  }
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
    checkWitness(witness, operation);
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
    const order = orderOf(operation);
    let witness = operation.witness ? await query(operation) : await order.reserve(binding);
    checkWitness(witness, operation);
    if (witness.state === 'sealed') return accept(operation, witness);
    if (witness.state === 'cancelled') return history.cancelOperation(operation, witness);
    history.recordWitness(operation, witness); failpoint('reserved-after-commit');
    if (!resume) {
      witness = await order.cancel(witness.witnessId, binding); checkWitness(witness, operation);
      return witness.state === 'sealed' ? accept(operation, witness) : history.cancelOperation(operation, witness);
    }
    let authorization;
    try { authorization = await gate(operation, 'before-seal', witness); }
    catch (error) {
      const cancelled = await order.cancel(witness.witnessId, binding); checkWitness(cancelled, operation);
      if (cancelled.state === 'sealed') return accept(operation, cancelled);
      history.cancelOperation(operation, cancelled); throw error;
    }
    failpoint('before-seal');
    const body = { ...binding };
    if (authorization.retainedGrant) body.retainedProof = retainedOperationProof(operation, witness, authorization.retainedGrant, docAttestationPrivateKey);
    if (authorization.activeGrant) body.activeRunProof = activeRunOperationProof(operation, witness, authorization.activeGrant, docAttestationPrivateKey);
    if (authorization.rollbackGrant) {
      if (!docAttestationPrivateKey) throw historyError('order-unavailable', 503);
      body.rollbackProof = rollbackOperationProof(operation, witness, authorization.rollbackGrant, docAttestationPrivateKey);
    }
    let sealed;
    try { sealed = await order.seal(witness.witnessId, body); }
    catch (error) {
      if (!body.activeRunProof || error.status !== 401) throw error;
      // Account may see exit before doc receives its event. Recheck under THIS lock;
      // only doc's exact shared-current retained exception can continue this prepared op.
      const renewed = await gate(operation, 'active-seal-rejected', witness);
      if (!renewed.retainedGrant) throw error;
      const retainedProof = retainedOperationProof(operation, witness, renewed.retainedGrant, docAttestationPrivateKey);
      sealed = await order.seal(witness.witnessId, { ...binding, retainedProof });
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
        const witness = await query(op); checkWitness(witness, op);
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
        if (prior.state === 'materialized') { const witness = await query(prior); checkWitness(witness, prior); if (canonical(witness) !== canonical(prior.witness)) throw historyError('needs-reconciliation'); return prior; }
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
