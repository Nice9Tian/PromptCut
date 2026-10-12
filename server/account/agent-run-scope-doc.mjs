/** Doc-side scope assignment. Root IO is a read-only source, never a network
 * supplied closed row. The optional sourceFactory is only for controlled tests;
 * production assembly uses the fixed root-file reader and configured anchors. */
import { createPublicKey, sign } from 'node:crypto';
import { accountError } from './client.mjs';
import { digestOf, canonicalJson } from './ledger.mjs';
import { createAgentScopeReader } from '../hosted/agent-run-scope-reader.mjs';
import { exactScope, validateAgentScopeAssignment, verifyScopeSignature } from '../hosted/agent-run-scope-schema.mjs';

const fail = (status, code) => { throw accountError(status, `run-scope-${code}`); };
const copy = structuredClone;
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const refFields = ['rootAuthorityId', 'slotId', 'epoch', 'recordDigest'];
const targetFields = ['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId',
  'serviceId', 'serviceKid', 'instanceId', 'instanceGeneration'];
export const agentScopeRef = record => ({ rootAuthorityId: record.authorityId, slotId: record.slotId,
  epoch: record.epoch, recordDigest: digestOf(record) });

/** Keep the original Doc PEM digest and the root DER digest distinct. Equality
 * of key bytes, not equality of unrelated hashes, joins the two identities. */
export function agentScopeKeyMapping(publicKey, rootPublicKey) {
  let key;
  try { key = createPublicKey(publicKey); } catch { fail(403, 'key-invalid'); }
  if (key.asymmetricKeyType !== 'ed25519') fail(403, 'key-invalid');
  const pem = key.export({ format: 'pem', type: 'spki' }).toString();
  const der = key.export({ format: 'der', type: 'spki' }).toString('base64');
  if (der !== rootPublicKey) fail(403, 'key-mismatch');
  return { publicKey: pem, publicKeyDigest: digestOf(pem), docPublicKeyDigest: digestOf(pem),
    scopePublicKey: der, scopePublicKeyDigest: digestOf(der) };
}

export function createAgentRunScopeDoc({ ledger, signingKey, slots, masterServiceKid, masterFingerprint256,
  sourceFactory = createAgentScopeReader } = {}) {
  if (!ledger?.transaction || !ledger?.read || !signingKey || !Array.isArray(slots) || !slots.length)
    fail(503, 'configuration');
  if (!hash(masterFingerprint256) || typeof masterServiceKid !== 'string' || !masterServiceKid) fail(503, 'master-configuration');
  const publicKey = createPublicKey(signingKey).export({ format: 'der', type: 'spki' }).toString('base64');
  const configs = new Map(), sources = new Map(), live = new Map();
  const keyOf = ref => `${ref.rootAuthorityId}:${ref.slotId}`;
  for (const slot of slots) {
    const e = slot.expected, key = keyOf({ rootAuthorityId: e?.authorityId, slotId: e?.slotId });
    if (e?.docAuthorityId !== ledger.authorityId || e.docPublicKey !== publicKey || configs.has(key) ||
        !hash(slot.workerFingerprint256) || typeof slot.workerServiceKid !== 'string' || !slot.workerServiceKid ||
        slot.workerFingerprint256 === masterFingerprint256 || slot.workerServiceKid === masterServiceKid)
      fail(503, 'configuration');
    configs.set(key, slot); sources.set(key, sourceFactory(slot));
  }
  ledger.transaction(s => {
    s.agentRunScopesV1 ??= { required: true, checkpoints: {}, assignments: {} };
    s.agentRunScopesV1.required = true;
  });
  function requireRef(ref) {
    if (!exactScope(ref, refFields) || !Number.isSafeInteger(ref.epoch) || ref.epoch < 1 || !hash(ref.recordDigest) ||
        !configs.has(keyOf(ref))) fail(403, 'reference');
    return keyOf(ref);
  }
  async function refresh(ref) {
    const key = requireRef(ref), checkpoint = ledger.read().agentRunScopesV1.checkpoints[key] ?? null;
    live.delete(key); // Failed/locked refresh must never leave an older allow cached.
    const result = await sources.get(key).read({ checkpoint });
    const historical = result.history?.find(entry => entry.record.epoch === ref.epoch);
    const projection = result.record.epoch === ref.epoch ? result : historical ? { ...result,
      record: historical.record, assignment: historical.assignment, terminal: historical.terminal, closure: historical.closure } : null;
    if (!projection || canonicalJson(agentScopeRef(projection.record)) !== canonicalJson(ref)) fail(403, 'epoch-changed');
    projection.phase = projection.closure ? 'closed' : projection.assignment ? 'bound' : 'ready';
    projection.failure = result.failures?.[ref.epoch] ?? null;
    ledger.transaction(s => {
      const old = s.agentRunScopesV1.checkpoints[key];
      if (canonicalJson(old ?? null) !== canonicalJson(checkpoint)) fail(409, 'refresh-race');
      const imported = (s.agentRunScopesV1.failureDigests ??= {})[key] ??= {};
      for (const [epoch, digest] of Object.entries(imported))
        if (!result.failures?.[epoch] || digestOf(result.failures[epoch]) !== digest) fail(503, 'failure-history-changed');
      for (const [epoch, observation] of Object.entries(result.failures ?? {})) imported[epoch] = digestOf(observation);
      s.agentRunScopesV1.checkpoints[key] = projection.checkpoint;
    });
    live.set(key, copy(projection)); return copy(projection);
  }
  function projectionFor(ref) {
    const value = live.get(requireRef(ref));
    if (!value || canonicalJson(agentScopeRef(value.record)) !== canonicalJson(ref)) fail(503, 'source-unavailable');
    return value;
  }
  function registrationInState(s, { publicKey: requestedKey, rootScopeRef, transport }) {
    if (transport.serviceId === 'agent' && transport.serviceKid === masterServiceKid && transport.fingerprint256 === masterFingerprint256) {
      if (rootScopeRef !== undefined) fail(403, 'master-scope-forbidden');
      return { purpose: 'control-only', publicKey: requestedKey };
    }
    const value = projectionFor(rootScopeRef), cfg = configs.get(keyOf(rootScopeRef));
    if (value.failure) fail(403, 'worker-failed');
    // Root controller's identity-RPC client cert is NOT the worker Doc client.
    if (transport.serviceId !== 'agent' || transport.serviceKid !== cfg.workerServiceKid ||
        transport.fingerprint256 !== cfg.workerFingerprint256) fail(403, 'worker-transport');
    const mapping = agentScopeKeyMapping(requestedKey, value.record.worker.publicKey);
    if (mapping.scopePublicKeyDigest !== value.record.worker.publicKeyDigest) fail(403, 'key-mismatch');
    const prior = s.agentInstancesV2?.[value.record.instance.instanceId];
    if (value.phase !== 'ready' && !(value.phase === 'bound' && prior?.state === 'active'))
      fail(403, 'not-ready');
    if (prior && (prior.publicKey !== mapping.publicKey || canonicalJson(prior.rootScopeRef) !== canonicalJson(rootScopeRef)))
      fail(409, 'instance-reused');
    return { purpose: 'run-worker', rootScopeRef: copy(rootScopeRef), instanceId: value.record.instance.instanceId, ...mapping };
  }
  function assignInState(s, grant) {
    const instance = s.agentInstancesV2?.[grant.instanceId];
    if (!instance?.rootScopeRef || instance.instanceGeneration !== grant.instanceGeneration) fail(403, 'instance-unbound');
    const ref = instance.rootScopeRef, projection = projectionFor(ref), key = `${keyOf(ref)}:${ref.epoch}`;
    if (projection.failure) fail(403, 'worker-failed');
    const prior = s.agentRunScopesV1.assignments[key];
    if (prior) {
      if (prior.target.runGrantId !== grant.runGrantId) fail(409, 'slot-already-assigned');
      return { rootScopeRef: copy(ref), assignmentDigest: digestOf(prior), phase: 'assigned-unbound' };
    }
    if (projection.phase !== 'ready') fail(403, 'not-ready');
    const cfg = configs.get(keyOf(ref));
    const payload = { v: 1, protocol: 'promptcut.agent-run-scope.assignment.v1',
      authorityId: ref.rootAuthorityId, slotId: ref.slotId, epoch: ref.epoch, recordDigest: ref.recordDigest,
      docAuthorityId: ledger.authorityId, target: { ...Object.fromEntries(targetFields.map(k => [k, grant[k]])),
        publicKeyDigest: agentScopeKeyMapping(instance.publicKey, projection.record.worker.publicKey).scopePublicKeyDigest } };
    const assignment = { ...payload, signature: sign(null, Buffer.from(digestOf(payload)), signingKey).toString('base64url') };
    validateAgentScopeAssignment(assignment, cfg.expected, projection.record);
    s.agentRunScopesV1.assignments[key] = assignment;
    return { rootScopeRef: copy(ref), assignmentDigest: digestOf(assignment), phase: 'assigned-unbound' };
  }
  function assignmentInState(s, grant, { requireBound = false } = {}) {
    const ref = grant.scopeBinding?.rootScopeRef;
    if (!ref) fail(403, 'assignment-missing');
    const projection = projectionFor(ref), assignment = s.agentRunScopesV1.assignments[`${keyOf(ref)}:${ref.epoch}`];
    if (projection.failure) fail(403, 'worker-failed');
    if (!assignment || digestOf(assignment) !== grant.scopeBinding.assignmentDigest ||
        targetFields.some(k => assignment.target[k] !== grant[k])) fail(403, 'assignment-mismatch');
    const phase = projection.phase;
    if (phase === 'closed') fail(403, 'already-closed');
    const bound = phase === 'bound' && canonicalJson(projection.assignment) === canonicalJson(assignment);
    if (phase === 'bound' && !bound) fail(403, 'root-assignment-mismatch');
    if (requireBound && !bound) fail(503, 'assignment-not-bound');
    return { assignment: copy(assignment), phase: bound ? 'bound' : 'assigned-unbound', executionAllowed: bound };
  }
  async function synchronize() {
    const state = ledger.read(), refs = Object.values(state.agentInstancesV2 ?? {}).filter(i => i.state === 'active' && i.rootScopeRef)
      .map(i => i.rootScopeRef);
    for (const ref of refs) await refresh(ref);
  }
  async function prepareRegistration({ rootScopeRef, transport }) {
    if (transport.serviceId === 'agent' && transport.serviceKid === masterServiceKid && transport.fingerprint256 === masterFingerprint256) {
      if (rootScopeRef !== undefined) fail(403, 'master-scope-forbidden');
      return;
    }
    await refresh(rootScopeRef);
  }
  function docClosed(s, control) {
    if (!control) fail(503, 'doc-closure-pending');
    const inventory = s.docRunClosuresV2?.[control.controlId];
    if (!control.docInstanceIds?.length || inventory?.payloadDigest !== control.payloadDigest || inventory.fenceRevision !== control.fenceRevision ||
        control.docInstanceIds.some(id => {
          const row = inventory.instances?.[id];
          return row?.state !== 'closed' || row.closed?.actualClosed !== true || !Array.isArray(row.closed.connections) ||
            row.closed.connections.some(connection => connection.actualClosed !== true) ||
            (control.operationFences ?? []).some(fence => !row.operationReceipts?.some(receipt =>
              receipt.state === 'committed' && canonicalJson(Object.fromEntries(Object.keys(fence).map(k => [k, receipt[k]]))) === canonicalJson(fence)));
        })) fail(503, 'doc-closure-pending');
    return inventory;
  }
  async function closeDocTerminal({ controlId, docInstanceId, service }) {
    if (ledger.read().runControlsV2?.[controlId]?.kind !== 'terminal') fail(503, 'doc-closure-unavailable');
    return closeDocControl({ controlId, docInstanceId, service });
  }
  async function closeDocControl({ controlId, docInstanceId, service, operationCoordinator }) {
    const control = ledger.read().runControlsV2?.[controlId];
    if (!control?.docInstanceIds?.includes(docInstanceId) || typeof service?.fencePrincipals !== 'function' ||
        (control.operationFences?.length && typeof operationCoordinator?.fence !== 'function'))
      fail(503, 'doc-closure-unavailable');
    const ids = control.kind === 'terminal' ? control.closing : control.revoked;
    if (!ids?.length) fail(503, 'doc-closure-unavailable');
    // Install the real read/transport barrier synchronously before awaiting
    // operation settlement. Keep the rejection handler installed throughout.
    const closing = service.fencePrincipals({ runGrantIds: ids, roles: ['agent'] })
      .then(value => ({ value }), error => ({ error }));
    const operationReceipts = [];
    for (const fence of control.operationFences ?? []) operationReceipts.push(await operationCoordinator.fence(fence));
    const outcome = await closing;
    if (outcome.error) throw outcome.error;
    const closed = outcome.value;
    if (closed?.actualClosed !== true || !Array.isArray(closed.connections) || closed.connections.some(c => c.actualClosed !== true))
      fail(503, 'doc-closure-pending');
    ledger.transaction(s => {
      const now = s.runControlsV2[controlId];
      if (!now || now.payloadDigest !== control.payloadDigest || now.fenceRevision !== control.fenceRevision) fail(403, 'doc-control-changed');
      const row = (s.docRunClosuresV2 ??= {})[controlId] ??= { controlId, payloadDigest: control.payloadDigest,
        fenceRevision: control.fenceRevision, instances: {} };
      row.instances[docInstanceId] = { docInstanceId, state: 'closed', closed, operationReceipts };
      // Persist this actual Doc instance independently; a historical instance
      // still missing from the inventory must not erase this one's evidence.
      docClosed(s, { ...now, docInstanceIds: [docInstanceId] });
    });
  }
  function preparePayload(s, grant, receipt, drainReceiptId) {
    const assignment = assignmentInState(s, grant, { requireBound: true }).assignment;
    const control = s.runControlsV2[receipt.controlId];
    if (!control || control.kind !== 'terminal' || typeof drainReceiptId !== 'string' || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(drainReceiptId))
      fail(403, 'prepare-binding');
    const ref = grant.scopeBinding.rootScopeRef;
    return { v: 1, domain: 'promptcut.agent-run.prepare.v1', scope: { authorityId: ref.rootAuthorityId, slotId: ref.slotId,
      epoch: ref.epoch, recordDigest: ref.recordDigest, assignmentDigest: digestOf(assignment) }, target: copy(assignment.target),
      readReceiptId: receipt.readReceiptId, finishReceiptId: receipt.finishReceiptId, outcomeDigest: receipt.outcomeDigest,
      eventId: receipt.outcome.eventId, eventDigest: receipt.outcome.eventDigest, drainReceiptId,
      docControlId: control.controlId, docFenceRevision: control.fenceRevision };
  }
  function recordPrepareInState(s, grant, receipt, prepared) {
    if (!prepared || typeof prepared !== 'object') fail(400, 'prepare-invalid');
    const { signature, ...payload } = prepared;
    if (canonicalJson(payload) !== canonicalJson(preparePayload(s, grant, receipt, payload.drainReceiptId))) fail(403, 'prepare-binding');
    verifyScopeSignature(prepared, projectionFor(grant.scopeBinding.rootScopeRef).record.worker.publicKey);
    const rows = s.runScopePreparesV1 ??= {}, prior = rows[receipt.finishReceiptId];
    if (prior && canonicalJson(prior) !== canonicalJson(prepared)) fail(409, 'prepare-conflict');
    rows[receipt.finishReceiptId] ??= copy(prepared);
    return { recorded: true, prepareDigest: digestOf(prepared), finishReceiptId: receipt.finishReceiptId };
  }
  function terminalInState(s, grant, receipt) {
    const assignment = assignmentInState(s, grant, { requireBound: true }).assignment;
    const prepare = s.runScopePreparesV1?.[receipt.finishReceiptId];
    if (!prepare) fail(503, 'prepare-pending');
    recordPrepareInState(s, grant, receipt, prepare);
    const control = s.runControlsV2[receipt.controlId]; docClosed(s, control);
    const ref = grant.scopeBinding.rootScopeRef;
    const payload = { v: 1, protocol: 'promptcut.agent-run-scope.terminal.v1', authorityId: ref.rootAuthorityId,
      slotId: ref.slotId, epoch: ref.epoch, recordDigest: ref.recordDigest, docAuthorityId: ledger.authorityId,
      assignmentDigest: digestOf(assignment), finish: { readReceiptId: receipt.readReceiptId, finishReceiptId: receipt.finishReceiptId,
        outcomeDigest: receipt.outcomeDigest, terminalReceiptDigest: digestOf(prepare) } };
    const terminal = { ...payload, signature: sign(null, Buffer.from(digestOf(payload)), signingKey).toString('base64url') };
    const rows = s.runScopeTerminalsV1 ??= {}, prior = rows[receipt.finishReceiptId];
    if (prior && canonicalJson(prior) !== canonicalJson(terminal)) fail(409, 'terminal-conflict');
    rows[receipt.finishReceiptId] ??= terminal;
    return { terminal: copy(terminal), terminalDigest: digestOf(terminal) };
  }
  function closedInState(s, grant, receipt) {
    const p = projectionFor(grant.scopeBinding.rootScopeRef);
    const assignment = s.agentRunScopesV1.assignments[`${keyOf(grant.scopeBinding.rootScopeRef)}:${grant.scopeBinding.rootScopeRef.epoch}`];
    const retired = p.terminal?.protocol === 'promptcut.agent-run-scope.unassigned-retirement.v1';
    if (p.phase !== 'closed' || !p.closure || (!retired && (canonicalJson(p.assignment) !== canonicalJson(assignment) ||
        targetFields.some(k => p.assignment?.target[k] !== grant[k])))) fail(503, 'closure-pending');
    if (grant.state === 'revoked') {
      const control = s.runControlsV2[grant.closureControlId];
      if (!control?.revoked.includes(grant.runGrantId)) fail(403, 'forced-control-mismatch');
      docClosed(s, control);
      if (!retired && p.terminal.protocol === 'promptcut.agent-run-scope.forced-terminal.v1') {
        if (p.terminal.fence.controlId !== control.controlId || p.terminal.fence.fenceRevision !== control.fenceRevision ||
            p.terminal.fence.payloadDigest !== control.payloadDigest ||
            canonicalJson(p.terminal) !== canonicalJson(s.runScopeForcedV1?.[control.controlId]?.[grant.runGrantId]))
          fail(403, 'forced-control-mismatch');
      } else if (!retired && !receipt) fail(403, 'terminal-mismatch');
    } else if (retired) fail(403, 'retirement-has-live-grant');
    if (receipt && p.terminal.protocol === 'promptcut.agent-run-scope.terminal.v1') {
      const stored = s.runScopeTerminalsV1?.[receipt.finishReceiptId], prepare = s.runScopePreparesV1?.[receipt.finishReceiptId];
      if (!stored || !prepare || canonicalJson(stored) !== canonicalJson(p.terminal) ||
          p.terminal.finish.terminalReceiptDigest !== digestOf(prepare)) fail(403, 'terminal-mismatch');
      docClosed(s, s.runControlsV2[receipt.controlId]);
    }
    const evidence = { v: 1, source: 'root-observed-run-scope-v1', rootScopeRef: copy(grant.scopeBinding.rootScopeRef),
      target: copy(assignment.target), closure: copy(p.closure), closureWitnessDigest: digestOf(p.closure),
      terminal: copy(p.terminal), checkpoint: copy(p.checkpoint) };
    (s.runScopeClosuresV1 ??= {})[grant.runGrantId] = evidence;
    return evidence;
  }
  function forcedInState(s, grant, control) {
    const ref = grant.scopeBinding?.rootScopeRef;
    if (!ref || grant.state !== 'revoked' || !control.revoked?.includes(grant.runGrantId)) fail(403, 'forced-control-mismatch');
    const assignment = s.agentRunScopesV1.assignments[`${keyOf(ref)}:${ref.epoch}`];
    if (!assignment || targetFields.some(k => assignment.target[k] !== grant[k])) fail(403, 'assignment-mismatch');
    const kind = ({ credential: 'credential-revoked', member: 'member-revoked', 'service-revoked': 'agent-disabled' })[control.kind] ?? control.kind;
    const payload = { v: 1, protocol: 'promptcut.agent-run-scope.forced-terminal.v1', authorityId: ref.rootAuthorityId,
      slotId: ref.slotId, epoch: ref.epoch, recordDigest: ref.recordDigest, docAuthorityId: ledger.authorityId,
      assignmentDigest: digestOf(assignment), fence: { controlId: control.controlId, fenceRevision: control.fenceRevision,
        payloadDigest: control.payloadDigest, kind, outcome: kind === 'worker-failed' ? 'failed' : 'interrupted' } };
    const terminal = { ...payload, signature: sign(null, Buffer.from(digestOf(payload)), signingKey).toString('base64url') };
    ((s.runScopeForcedV1 ??= {})[control.controlId] ??= {})[grant.runGrantId] = terminal;
    return copy(terminal);
  }
  function failureInState(s, grant) {
    const ref = grant.scopeBinding?.rootScopeRef;
    if (!ref) return null;
    const p = projectionFor(ref), failure = p.failure;
    if (!failure) return null;
    const assignment = s.agentRunScopesV1.assignments[`${keyOf(ref)}:${ref.epoch}`];
    if (!assignment || digestOf(assignment) !== grant.scopeBinding.assignmentDigest ||
        targetFields.some(k => assignment.target[k] !== grant[k]) ||
        p.record.instance.instanceId !== grant.instanceId || p.record.worker.publicKeyDigest !== assignment.target.publicKeyDigest)
      fail(403, 'failure-assignment-mismatch');
    if (failure.assignmentDigest !== null && (failure.assignmentDigest !== digestOf(assignment) ||
        canonicalJson(p.assignment) !== canonicalJson(assignment))) fail(403, 'failure-assignment-mismatch');
    if (failure.assignmentDigest === null && p.assignment !== null) fail(403, 'failure-assignment-mismatch');
    return { failureDigest: digestOf(failure), rootScopeRef: copy(ref), bound: failure.assignmentDigest !== null };
  }
  function eventSourceInState(s, grant, master) {
    if (master?.purpose !== 'control-only' || master.serviceKid !== masterServiceKid) fail(403, 'master-required');
    const { assignment } = assignmentInState(s, grant, { requireBound: true });
    const ref = grant.scopeBinding.rootScopeRef, p = projectionFor(ref), cfg = configs.get(keyOf(ref));
    if (grant.serviceKid !== cfg.workerServiceKid) fail(403, 'worker-transport');
    return { assignmentDigest: digestOf(assignment), rootScopeRef: copy(ref), scopePublicKey: p.record.worker.publicKey,
      scopePublicKeyDigest: p.record.worker.publicKeyDigest, workerFingerprint256: cfg.workerFingerprint256,
      runGrant: { ...copy(assignment.target), accountId: grant.accountId, initiatorName: grant.initiatorName,
        state: grant.state, fenceRevision: grant.fenceRevision, readReceiptId: grant.readReceiptId } };
  }
  function controlSourceInState(s, grant, master, input) {
    if (master?.purpose !== 'control-only' || master.serviceKid !== masterServiceKid) fail(403, 'master-required');
    const ref = grant.scopeBinding?.rootScopeRef;
    if (!ref || canonicalJson(ref) !== canonicalJson(input.rootScopeRef) || grant.scopeBinding.assignmentDigest !== input.assignmentDigest ||
        grant.state !== 'revoked' || grant.closureControlId !== input.controlId) fail(403, 'forced-control-mismatch');
    const control = s.runControlsV2[input.controlId], terminal = s.runScopeForcedV1?.[input.controlId]?.[grant.runGrantId];
    if (!control?.revoked.includes(grant.runGrantId) || !terminal || terminal.assignmentDigest !== input.assignmentDigest ||
        !control.instances.some(i => i.instanceId === grant.instanceId && i.instanceGeneration === grant.instanceGeneration && i.serviceKid === grant.serviceKid))
      fail(403, 'forced-control-mismatch');
    const p = projectionFor(ref), cfg = configs.get(keyOf(ref));
    if (grant.serviceKid !== cfg.workerServiceKid) fail(403, 'worker-transport');
    docClosed(s, control);
    if (p.phase === 'ready' && p.assignment === null) return { unassigned: true, rootScopeRef: copy(ref),
      assignmentDigest: input.assignmentDigest, reason: 'root-assignment-not-bound' };
    if (!p.assignment || digestOf(p.assignment) !== input.assignmentDigest) fail(403, 'root-assignment-mismatch');
    return { unassigned: false, rootScopeRef: copy(ref), assignmentDigest: input.assignmentDigest, terminal: copy(terminal) };
  }
  function controlReferenceInState(s, grant, master) {
    if (master?.purpose !== 'control-only' || master.serviceKid !== masterServiceKid) fail(403, 'master-required');
    const ref = grant.scopeBinding?.rootScopeRef, cfg = configs.get(requireRef(ref));
    const assignment = s.agentRunScopesV1.assignments[`${keyOf(ref)}:${ref.epoch}`], instance = s.agentInstancesV2[grant.instanceId];
    const control = s.runControlsV2[grant.closureControlId];
    if (grant.state !== 'revoked' || !control?.revoked.includes(grant.runGrantId) || grant.serviceKid !== cfg.workerServiceKid ||
        canonicalJson(instance?.rootScopeRef) !== canonicalJson(ref) || instance.instanceGeneration !== grant.instanceGeneration ||
        !assignment || targetFields.some(k => assignment.target[k] !== grant[k]) ||
        digestOf(assignment) !== grant.scopeBinding.assignmentDigest || assignment.target.publicKeyDigest !== instance.scopePublicKeyDigest ||
        !control.instances.some(i => i.instanceId === grant.instanceId && i.instanceGeneration === grant.instanceGeneration && i.serviceKid === grant.serviceKid))
      fail(403, 'forced-control-mismatch');
    return { projectId: grant.projectId, controlId: control.controlId, runGrantId: grant.runGrantId,
      assignmentDigest: grant.scopeBinding.assignmentDigest, rootScopeRef: copy(ref) };
  }
  return Object.freeze({ refresh, synchronize, prepareRegistration, registrationInState, assignInState, assignmentInState,
    preparePayload, recordPrepareInState, terminalInState, forcedInState, failureInState, closedInState, docClosed, closeDocTerminal, closeDocControl, eventSourceInState, controlSourceInState, controlReferenceInState });
}
