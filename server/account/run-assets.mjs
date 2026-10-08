import { randomBytes, randomUUID } from 'node:crypto';
import { canonicalJson, digestOf } from './ledger.mjs';
import { RUN_ASSET_ROOT, RUN_ASSET_OPERATION, assetRefId, resourceRevision, ticketDigest,
  validateAssetRef, validateIssue, runAssetIssueRequest, validateAssetHttpTuple, requestProof, exactShape,
  reference, hashOf, failRunAsset as fail } from './run-asset-protocol.mjs';

const binding = ['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId', 'accountId',
  'loginId', 'credentialId', 'loginGeneration', 'serviceId', 'serviceKid', 'instanceId', 'instanceGeneration'];
const grantBinding = grant => Object.fromEntries(binding.map(key => [key, grant[key]]));
const clone = value => structuredClone(value);
function tables(s) {
  s.runAssetIntentsV1 ??= {}; s.runAssetLeasesV1 ??= {};
  s.runAssetNoncesV1 ??= {}; s.runAssetControlOutboxV1 ??= [];
  s.runAssetControlMirrorsV1 ??= {}; s.runAssetAcksV1 ??= {};
}
const receiptFields = ['receiptId', 'eventId', 'cursor', 'controlId', 'fenceRevision', 'complete',
  'assetInstanceId', 'closedLeaseIds', 'retainedLeaseIds', 'evidenceDigest'];
const controlFields = ['kind', 'projectId', 'fenceRevision', 'retained', 'revoked', 'instances', 'operationFences'];
function controlValue(c) {
  const value = Object.fromEntries(controlFields.map(key => [key, clone(c[key])]));
  if (c.scope?.conversationId) value.conversationId = c.scope.conversationId;
  if (c.scope?.runId) value.runId = c.scope.runId;
  return value;
}

/** Doc-owned resource metadata, not another ACL. The callbacks are production
 * trust seams: direct/observed authentication must use the SAME instanceAuthority
 * as runProvider; observer verification must own the actual pinned TLS socket.
 * No public method accepts an actor, authorizationId, or a serialized RAM cap. */
export function createRunAssets({ ledger, runProvider, authenticateDirect, authenticateObserved,
  verifyObserver, resolveMedia, verifyLeaseClosure, verifyControlReceipt, verifyRecoveryClosure,
  now, ticketTtlMs } = {}) {
  if (!ledger?.transaction || !ledger?.read || !reference(ledger.authorityId) ||
      typeof runProvider?.checkAccess !== 'function' || typeof runProvider?.synchronize !== 'function' ||
      ![authenticateDirect, authenticateObserved, verifyObserver, resolveMedia, verifyLeaseClosure,
        verifyControlReceipt, now].every(fn => typeof fn === 'function') ||
      !Number.isSafeInteger(ticketTtlMs) || ticketTtlMs < 1) fail(503, 'run-assets-unconfigured');
  const docEpoch = randomUUID(), tickets = new Map(), issued = new Map(), liveLeases = new Map();
  const observerIds = new WeakMap(), observerSockets = new Map();
  let closed = false, unavailable = false;
  const requireOpen = () => {
    if (closed || unavailable || ledger.read().runAssetsEpochV1 !== docEpoch) fail(503, 'run-assets-unconfigured');
  };
  const time = () => { const n = now(); if (!Number.isSafeInteger(n) || n < 0) fail(503, 'run-asset-clock-invalid'); return n; };
  ledger.transaction(s => { tables(s); s.runAssetsEpochV1 = docEpoch; for (const l of Object.values(s.runAssetLeasesV1))
    if (l.state === 'admitted') l.state = 'unknown'; return null; });

  function mirror() {
    return ledger.transaction(s => {
      tables(s);
      for (const [index, event] of s.runAssetControlOutboxV1.entries()) {
        const m = s.runAssetControlMirrorsV1[event.controlId];
        if (event.v !== 1 || event.seq !== index + 1 || event.eventId !== `run-asset:${event.controlId}` ||
            !m || m.seq !== event.seq || m.payloadDigest !== event.payloadDigest || m.digest !== digestOf(event.control))
          fail(503, 'run-control-gap');
      }
      // Reverse validation is required: validating only the surviving events
      // would silently shrink head after a missing tail or accept an orphan.
      // Never reconstruct a lost persisted event from its mirror/control.
      for (const [controlId, m] of Object.entries(s.runAssetControlMirrorsV1)) {
        const event = s.runAssetControlOutboxV1[m.seq - 1], c = s.runControlsV2?.[controlId];
        if (!Number.isSafeInteger(m.seq) || m.seq < 1 || !event || event.controlId !== controlId ||
            !c || c.controlId !== controlId || m.payloadDigest !== c.payloadDigest ||
            m.digest !== digestOf(controlValue(c))) fail(503, 'run-control-gap');
      }
      for (const ack of Object.values(s.runAssetAcksV1)) {
        const event = s.runAssetControlOutboxV1[ack.cursor - 1];
        if (!Number.isSafeInteger(ack.cursor) || ack.cursor < 1 || !event ||
            ack.receipt?.cursor !== ack.cursor || ack.receipt.eventId !== event.eventId ||
            ack.receipt.controlId !== event.controlId || ack.receipt.fenceRevision !== event.control.fenceRevision ||
            ack.digest !== digestOf(ack.receipt)) fail(503, 'run-control-gap');
      }
      for (const c of Object.values(s.runControlsV2 ?? {})) {
        if (!reference(c.controlId?.replace(/^run-control:/, '')) || !hashOf(c.payloadDigest) ||
            !Number.isSafeInteger(c.fenceRevision) || !Array.isArray(c.retained) || !Array.isArray(c.revoked) ||
            !Array.isArray(c.instances) || !Array.isArray(c.operationFences)) fail(503, 'run-control-invalid');
        const value = controlValue(c);
        const digest = digestOf(value), old = s.runAssetControlMirrorsV1[c.controlId];
        if (old) { if (old.digest !== digest || old.payloadDigest !== c.payloadDigest) fail(503, 'run-control-mismatch'); continue; }
        const event = { v: 1, eventId: `run-asset:${c.controlId}`, seq: s.runAssetControlOutboxV1.length + 1,
          controlId: c.controlId, payloadDigest: c.payloadDigest, control: value, committedAt: time() };
        s.runAssetControlOutboxV1.push(event);
        s.runAssetControlMirrorsV1[c.controlId] = { digest, payloadDigest: c.payloadDigest, seq: event.seq };
      }
      return { accessHead: s.accessHead, runAssetHead: s.runAssetControlOutboxV1.length };
    });
  }
  async function synchronize() { requireOpen(); await runProvider.synchronize(); requireOpen(); return mirror(); }
  function observerOf(observer) {
    requireOpen(); const result = verifyObserver(observer);
    if (result?.then || !exactShape(result, ['socket', 'assetInstanceId', 'serviceIdentity']) ||
        !result.socket || typeof result.socket !== 'object' || result.socket.destroyed ||
        !reference(result.assetInstanceId) || !reference(result.serviceIdentity)) fail(403, 'asset-observer-forbidden');
    let id = observerIds.get(result.socket);
    if (!id) {
      id = randomUUID(); observerIds.set(result.socket, id);
      const disconnected = () => {
        for (const [leaseId, live] of liveLeases) if (live.observerId === id) {
          liveLeases.delete(leaseId);
          if (!closed) try { ledger.transaction(s => {
            const lease = s.runAssetLeasesV1?.[leaseId]; if (lease?.state === 'admitted') lease.state = 'unknown'; return null;
          }); } catch { unavailable = true; } // RAM admission was already removed; persistence failure never reopens it.
        }
      };
      result.socket.once('close', disconnected); observerSockets.set(result.socket, disconnected);
    }
    return { ...result, observerId: id };
  }
  function principalFor(request, servicePrincipal) {
    const g = ledger.read().runGrantsV2?.[request.runGrantId];
    if (!g || g.projectId !== request.projectId) fail(403, 'run-binding-mismatch');
    return { ...grantBinding(g), realm: 'account', identityVersion: 2, role: 'agent', creator: false, servicePrincipal };
  }
  async function authorized({ request, proof, transport, observer, observation, direct }) {
    requestProof(proof);
    const authenticate = direct ? authenticateDirect : authenticateObserved;
    const invocation = await authenticate({ transport, observer, observation, proof,
      method: direct ? 'POST' : request.method, path: direct ? `${RUN_ASSET_ROOT}issue` : request.url,
      operation: RUN_ASSET_OPERATION, request });
    if (!invocation?.servicePrincipal || typeof invocation.release !== 'function') {
      invocation?.release?.(); fail(503, 'instance-consumer-unavailable');
    }
    try {
      const principal = principalFor(request, invocation.servicePrincipal);
      const check = async () => {
        const answer = await runProvider.checkAccess({ principal, projectId: request.projectId, action: request.action });
        if (answer?.allowed !== true || !answer.runGrant ||
            canonicalJson(grantBinding(answer.runGrant)) !== canonicalJson(grantBinding(principal))) fail(403, 'run-revoked');
        return answer.runGrant;
      };
      const grant = await check();
      return { principal, grant, check, release: () => invocation.release() };
    } catch (error) { invocation.release(); throw error; }
  }
  function atCommit(s, checked) {
    requireOpen(); const g = s.runGrantsV2?.[checked.runGrantId];
    if (!g || canonicalJson(grantBinding(g)) !== canonicalJson(grantBinding(checked)) ||
        g.state !== checked.state || g.fenceRevision !== checked.fenceRevision ||
        g.readReceiptId !== checked.readReceiptId || !['active', 'retained'].includes(g.state)) fail(403, 'run-state-changed');
    return g;
  }
  async function resourceFor(body, principal) {
    const selected = await resolveMedia({ principal, ...body });
    if (!selected || !exactShape(selected, ['resource'], ['mediaRev', 'projectRev', 'kind'])) fail(503, 'run-asset-resource-unavailable');
    let resource;
    try { resource = validateAssetRef(selected.resource); }
    catch { fail(503, 'run-asset-resource-unavailable'); }
    if (resource.projectId !== body.projectId || (body.purpose !== 'openRead' &&
        (resource.hash !== body.selector.hash || resource.size !== body.selector.size)) ||
        (body.purpose === 'import' && resource.ext !== body.selector.ext)) fail(403, 'resource-scope-mismatch');
    if ((selected.mediaRev !== undefined && !hashOf(selected.mediaRev)) ||
        (selected.projectRev !== undefined && (!Number.isSafeInteger(selected.projectRev) || selected.projectRev < 0)))
      fail(503, 'run-asset-resource-unavailable');
    return { ...selected, resource, resourceRev: resourceRevision(resource) };
  }
  async function issue({ body, bodyText, transport, proof }) {
    const request = runAssetIssueRequest({ body, bodyText }); body = request.body;
    proof = requestProof(proof); await synchronize();
    const auth = await authorized({ request, proof, transport, direct: true });
    try {
      const selected = await resourceFor(body, auth.principal), g = await auth.check();
      const key = digestOf({ binding: grantBinding(g), purpose: body.purpose, requestId: body.requestId });
      const inputDigest = digestOf(request), raw = issued.get(key);
      const old = ledger.read().runAssetIntentsV1[key];
      if (old) {
        if (old.inputDigest !== inputDigest) fail(409, 'request-mismatch');
        if (old.docEpoch !== docEpoch || !raw) fail(401, 'ticket-epoch-lost');
        if (old.expiresAt <= time()) fail(401, 'ticket-expired');
        if (old.resourceRev !== selected.resourceRev || old.mediaRev !== selected.mediaRev) fail(409, 'stale-media-ref');
        ledger.transaction(s => { atCommit(s, g); return null; });
        return clone(raw.result);
      }
      const ticket = randomBytes(32).toString('base64url'), ticketId = `asset-ticket:${randomUUID()}`;
      const issuedAt = time(), expiresAt = issuedAt + ticketTtlMs;
      if (!Number.isSafeInteger(expiresAt)) fail(503, 'run-asset-clock-invalid');
      const intent = { v: 1, key, ticketId, ticketDigest: ticketDigest(ticket), docEpoch, requestId: body.requestId,
        inputDigest, grantBinding: grantBinding(g), readReceiptId: g.readReceiptId, resource: selected.resource,
        resourceRev: selected.resourceRev, ...(selected.mediaRev ? { mediaRev: selected.mediaRev } : {}),
        selector: clone(body.selector), action: body.action, purpose: body.purpose, issuedAt, expiresAt,
        fenceRevisionAtIssue: g.fenceRevision, state: 'issued' };
      ledger.transaction(s => { atCommit(s, g); s.runAssetIntentsV1[key] = intent; return null; });
      const result = { ticket, expiresAt, ticketId, ...selected, fenceRevision: g.fenceRevision, grantState: g.state, docEpoch };
      issued.set(key, { result }); tickets.set(intent.ticketDigest, intent);
      return clone(result);
    } finally { auth.release(); }
  }
  function intentFor(ticket, request) {
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) fail(401, 'run-asset-ticket-required');
    const intent = tickets.get(ticketDigest(ticket));
    if (!intent || intent.docEpoch !== docEpoch || intent.expiresAt <= time()) fail(401, 'ticket-expired');
    const route = validateAssetHttpTuple(request);
    if (request.ticketDigest !== intent.ticketDigest || request.resourceRev !== intent.resourceRev ||
        request.projectId !== intent.resource.projectId || request.runGrantId !== intent.grantBinding.runGrantId ||
        request.action !== intent.action || (route.hash && route.hash !== intent.resource.hash) ||
        (request.action === 'write' && request.importId !== intent.selector.importId) ||
        (route.operation === 'verifyRef' && intent.purpose !== 'verifyRef')) fail(403, 'resource-scope-mismatch');
    return intent;
  }
  function observationOf(value, observer) {
    if (!exactShape(value, ['assetInstanceId', 'assetServiceIdentity', 'assetLeaseId', 'agentFingerprint256',
      'agentServiceKid', 'authenticationId', 'channelBinding', 'open']) || value.open !== true ||
        value.assetInstanceId !== observer.assetInstanceId || value.assetServiceIdentity !== observer.serviceIdentity ||
        ![value.assetLeaseId, value.agentServiceKid, value.authenticationId].every(reference) ||
        ![value.agentFingerprint256, value.channelBinding].every(hashOf)) fail(403, 'asset-observer-forbidden');
  }
  async function check({ ticket, request, proof, observation, observer, leaseId }) {
    request = clone(request); proof = requestProof(proof); observation = clone(observation);
    await synchronize(); const observed = observerOf(observer), intent = intentFor(ticket, request);
    observationOf(observation, observed);
    const digest = digestOf({ request, proof, observation });
    const existing = leaseId ? ledger.read().runAssetLeasesV1[leaseId] : null;
    if (leaseId && (!existing || existing.state !== 'admitted' || existing.docEpoch !== docEpoch ||
        existing.inputDigest !== digest || liveLeases.get(leaseId)?.observerId !== observed.observerId))
      fail(403, 'run-asset-lease-unavailable');
    const auth = await authorized({ request, proof, observer: observed, observation, direct: false });
    try {
      if (canonicalJson(grantBinding(auth.grant)) !== canonicalJson(intent.grantBinding) ||
          auth.grant.readReceiptId !== intent.readReceiptId || observation.agentServiceKid !== auth.grant.serviceKid)
        fail(403, 'run-binding-mismatch');
      const body = { projectId: request.projectId, runGrantId: request.runGrantId, action: intent.action,
        purpose: intent.purpose, selector: intent.selector };
      const resource = await resourceFor(body, auth.principal);
      if (resource.resourceRev !== intent.resourceRev || resource.mediaRev !== intent.mediaRev) fail(409, 'stale-media-ref');
      const g = await auth.check(); observerOf(observer);
      const id = leaseId ?? `asset-lease:${randomUUID()}`, nonceKey = digestOf({ ticketId: intent.ticketId, nonce: request.nonce });
      const heads = ledger.transaction(s => {
        atCommit(s, g); if (observed.socket.destroyed) fail(403, 'asset-observer-forbidden');
        if (leaseId) {
          const l = s.runAssetLeasesV1[id]; if (l.state !== 'admitted' || l.inputDigest !== digest) fail(403, 'run-asset-lease-unavailable');
        } else {
          const old = s.runAssetNoncesV1[nonceKey];
          if (old) fail(old.requestDigest === digestOf(request) ? 403 : 409, old.requestDigest === digestOf(request) ? 'nonce-replayed' : 'request-mismatch');
          s.runAssetNoncesV1[nonceKey] = { ticketId: intent.ticketId, requestDigest: digestOf(request), leaseId: id };
          s.runAssetLeasesV1[id] = { v: 1, leaseId: id, ticketId: intent.ticketId, docEpoch,
            assetInstanceId: observed.assetInstanceId, serviceIdentity: observed.serviceIdentity,
            assetLeaseId: observation.assetLeaseId, inputDigest: digest, requestDigest: digestOf(request),
            grantBinding: clone(intent.grantBinding), resource: clone(intent.resource), state: 'admitted', receipt: null };
        }
        Object.assign(s.runAssetLeasesV1[id], { fenceRevision: g.fenceRevision, grantState: g.state,
          accessHead: s.accessHead, runAssetHead: s.runAssetControlOutboxV1.length });
        return { accessHead: s.accessHead, runAssetHead: s.runAssetControlOutboxV1.length };
      });
      liveLeases.set(id, { observerId: observed.observerId });
      return { allowed: true, leaseId: id, projectId: request.projectId, action: request.action,
        resource: clone(intent.resource), resourceRev: intent.resourceRev, grantState: g.state,
        fenceRevision: g.fenceRevision, ...heads, docEpoch };
    } finally { auth.release(); }
  }
  async function closeLease({ leaseId, observer, receipt }) {
    receipt = clone(receipt);
    const observed = observerOf(observer), lease = ledger.read().runAssetLeasesV1[leaseId];
    if (!lease || lease.docEpoch !== docEpoch || liveLeases.get(leaseId)?.observerId !== observed.observerId ||
        lease.assetInstanceId !== observed.assetInstanceId || lease.serviceIdentity !== observed.serviceIdentity)
      fail(403, 'run-asset-lease-unavailable');
    if (!exactShape(receipt, ['leaseId', 'receiptId', 'complete', 'evidenceDigest']) || receipt.leaseId !== leaseId ||
        receipt.complete !== true || !reference(receipt.receiptId) || !hashOf(receipt.evidenceDigest)) fail(400, 'run-asset-receipt-invalid');
    if (lease.receipt) {
      if (canonicalJson(lease.receipt) !== canonicalJson(receipt)) fail(409, 'receipt-mismatch'); return clone(lease.receipt);
    }
    if (await verifyLeaseClosure({ observer: observed, lease: clone(lease), receipt: clone(receipt) }) !== true)
      fail(503, 'asset-resource-closure-pending');
    observerOf(observer);
    return ledger.transaction(s => {
      const l = s.runAssetLeasesV1[leaseId];
      if (l.state !== 'admitted') fail(503, 'asset-resource-closure-pending');
      l.state = 'closed'; l.receipt = clone(receipt); return l.receipt;
    });
  }
  async function recoverLeaseClosure({ leaseId, witness }) {
    requireOpen(); const lease = ledger.read().runAssetLeasesV1?.[leaseId];
    if (!lease || lease.state !== 'unknown' || typeof verifyRecoveryClosure !== 'function' ||
        await verifyRecoveryClosure({ lease: clone(lease), witness }) !== true) fail(503, 'asset-resource-closure-pending');
    return ledger.transaction(s => { const l = s.runAssetLeasesV1[leaseId];
      if (l.state !== 'unknown') fail(503, 'asset-resource-closure-pending');
      l.state = 'closed'; l.recoveryWitness = clone(witness); return { leaseId, closed: true }; });
  }
  async function eventsSince(after) {
    if (!Number.isSafeInteger(after) || after < 0) fail(400, 'run-asset-cursor-invalid');
    await synchronize(); const events = ledger.read().runAssetControlOutboxV1;
    if (after > events.length) fail(409, 'run-asset-cursor-ahead');
    return { events: clone(events.slice(after, after + 100)), headSeq: events.length };
  }
  async function acknowledgeEvent({ eventId, observer, receipt }) {
    receipt = clone(receipt);
    await synchronize(); const observed = observerOf(observer), state = ledger.read();
    const event = state.runAssetControlOutboxV1.find(e => e.eventId === eventId);
    if (!event || !exactShape(receipt, receiptFields) || receipt.eventId !== eventId || receipt.cursor !== event.seq ||
        receipt.controlId !== event.controlId || receipt.fenceRevision !== event.control.fenceRevision ||
        receipt.complete !== true || receipt.assetInstanceId !== observed.assetInstanceId ||
        !reference(receipt.receiptId) || !hashOf(receipt.evidenceDigest) ||
        ![receipt.closedLeaseIds, receipt.retainedLeaseIds].every(ids => Array.isArray(ids) &&
          new Set(ids).size === ids.length && ids.every(reference))) fail(400, 'run-asset-receipt-invalid');
    const ackKey = observed.serviceIdentity, digest = digestOf(receipt), old = state.runAssetAcksV1[ackKey];
    if (old?.cursor === event.seq) {
      if (old.digest !== digest) fail(409, 'receipt-mismatch'); return clone(old.receipt);
    }
    if (old && event.seq < old.cursor) return clone(old.receipt);
    if (event.seq !== (old?.cursor ?? 0) + 1) fail(409, 'run-asset-cursor-gap');
    const relevant = l => event.control.revoked.includes(l.grantBinding.runGrantId) || event.control.retained.includes(l.grantBinding.runGrantId) ||
      (event.control.kind === 'instance-revoked' && event.control.instances.some(i =>
        i.instanceId === l.grantBinding.instanceId && i.instanceGeneration === l.grantBinding.instanceGeneration));
    const checkLeases = s => {
      for (const l of Object.values(s.runAssetLeasesV1).filter(relevant)) {
        if (event.control.retained.includes(l.grantBinding.runGrantId) && l.state === 'admitted') {
          if (!receipt.retainedLeaseIds.includes(l.leaseId) || l.grantState !== 'retained' ||
              l.fenceRevision < event.control.fenceRevision || l.runAssetHead < event.seq) fail(503, 'asset-resource-closure-pending');
        } else if (l.state !== 'closed' || !receipt.closedLeaseIds.includes(l.leaseId)) fail(503, 'asset-resource-closure-pending');
      }
      const allowed = Object.values(s.runAssetLeasesV1).filter(relevant).map(l => l.leaseId);
      if ([...receipt.closedLeaseIds, ...receipt.retainedLeaseIds].some(id => !allowed.includes(id)) ||
          receipt.closedLeaseIds.some(id => receipt.retainedLeaseIds.includes(id))) fail(400, 'run-asset-receipt-invalid');
    };
    checkLeases(state);
    if (await verifyControlReceipt({ observer: observed, event: clone(event), receipt: clone(receipt) }) !== true)
      fail(503, 'asset-resource-closure-pending');
    observerOf(observer);
    return ledger.transaction(s => {
      checkLeases(s); const previous = s.runAssetAcksV1[ackKey];
      if (previous?.cursor >= event.seq) {
        if (previous.cursor === event.seq && previous.digest !== digest) fail(409, 'receipt-mismatch'); return previous.receipt;
      }
      if (event.seq !== (previous?.cursor ?? 0) + 1) fail(409, 'run-asset-cursor-gap');
      s.runAssetAcksV1[ackKey] = { cursor: event.seq, digest, receipt: clone(receipt) }; return receipt;
    });
  }
  return { docEpoch, issue, check, closeLease, recoverLeaseClosure, synchronize, eventsSince, acknowledgeEvent,
    close() {
      if (closed) return; closed = true; tickets.clear(); issued.clear(); liveLeases.clear();
      for (const [socket, callback] of observerSockets) socket.removeListener('close', callback);
      observerSockets.clear();
    } };
}
