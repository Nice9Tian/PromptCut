import { randomUUID, sign } from 'node:crypto';
import { newProjectId } from '../auth/store.mjs';
import { validateAccountEvent, validateEventBatch, requireRequestId } from './protocol.mjs';
import { accountError } from './client.mjs';
import { canonicalJson, digestOf, appendAccessEvent } from './ledger.mjs';

const accountIdOK = value => typeof value === 'string' && /^acc_[a-f0-9]{24}$/.test(value);
const projectIdOK = value => typeof value === 'string' && /^sp_[a-z2-7]{26}$/.test(value);
const services = ['asset', 'agent', 'render'];
const reject = (status, code) => { throw accountError(status, code); };
const projectOf = (state, id) => {
  if (!projectIdOK(id)) reject(400, 'invalid-project');
  const project = state.projects[id];
  if (!project) reject(404, 'no-project');
  return project;
};
const active = project => {
  if (project.status === 'relocating') reject(409, 'relocating');
  if (project.status !== 'active') reject(404, 'no-project');
};
const permission = (project, accountId, action) => {
  active(project);
  if (Object.hasOwn(project.bans, accountId)) reject(403, 'banned');
  const access = accountId === project.creatorAccountId ? 'rw' : project.members[accountId]?.access;
  if (!access || (action === 'write' && access !== 'rw')) reject(403, 'not-listed');
  return access;
};

/** Sole v2 cloud project authority. No LAN records, account passwords, or usable tokens on disk.
 * initializeProject must durably create the real doc/content snapshot before an active commit.
 * This factory is deliberately not mounted in the legacy shared service by itself.
 */
export function createAccountAuthority({ ledger, accountClient, initializeProject, authorityUrl,
  signingKey, keyId, now = Date.now, pollMs = 1000, onDiagnostic = () => {}, getDocBarrier, verifyDocBarrier,
  runHooks = null }) {
  if (runHooks !== null && typeof runHooks?.fenceInState !== 'function') reject(503, 'run-authority-unavailable');
  const refs = new Map(); const subscriptions = new Set(); const creating = new Map();
  let syncing = null, timer = null, closed = false, ready = false;
  const notify = (event, control = null) => {
    if (event.type !== 'login-revoked' && !(event.type === 'project-access-changed' &&
      (event.accountIds?.length || (event.service === 'agent' && event.enabled === false)))) return;
    for (const entry of subscriptions) {
      const context = entry.context;
      if (context.projectId && event.projectId && context.projectId !== event.projectId) continue;
      if (context.loginId && event.loginIds?.length && !event.loginIds.includes(context.loginId)) continue;
      if (context.accountId && event.accountIds?.length && !event.accountIds.includes(context.accountId)) continue;
      try { Promise.resolve(entry.callback(structuredClone(event), structuredClone(control))).catch(() => onDiagnostic({ code: 'revocation-subscriber-failed', seq: event.seq })); }
      catch { onDiagnostic({ code: 'revocation-subscriber-failed', seq: event.seq }); }
    }
  };
  function fenceRuns(state, fence) {
    if (runHooks) {
      const result = runHooks.fenceInState(state, fence);
      if (result?.then) reject(503, 'ledger-async-transaction');
      return result;
    }
    // A deployment may still be page-only before run authority is mounted. Durable
    // grants can never survive a missing fence implementation or be silently skipped.
    if (Object.keys(state.runGrantsV2 ?? {}).length) reject(503, 'run-authority-unavailable');
    return null;
  }
  function applyRevocation(input) {
    const event = validateAccountEvent(input);
    const result = ledger.transaction(state => {
      if (event.seq <= state.accountHead) {
        if (state.accountEvents[event.seq]?.digest !== digestOf(event)) reject(503, 'account-event-conflict');
        return { duplicate: true, event: null };
      }
      if (event.seq !== state.accountHead + 1) reject(503, 'account-event-gap');
      const priorEvent = Object.values(state.accountEvents).find(row => row.event.eventId === event.eventId)?.event;
      if (priorEvent && (priorEvent.type !== 'password-changed' || event.type !== 'credentials-revoked' ||
        ['accountId', 'changeSeq', 'changedAt', 'initiatorWebsiteLoginId'].some(field => priorEvent[field] !== event[field]) ||
        canonicalJson(priorEvent.oldLoginIds) !== canonicalJson(event.oldLoginIds))) reject(503, 'account-event-conflict');
      state.accountEvents[event.seq] = { event, digest: digestOf(event) };
      state.accountHead = event.seq;
      if (event.type !== 'credentials-revoked') return { duplicate: false, event: null };
      const loginIds = event.revokedLoginIds ?? event.oldLoginIds;
      for (const loginId of loginIds) state.revokedLogins[`login:${loginId}`] = { eventId: event.eventId, seq: event.seq, accountId: event.accountId };
      const accessEvent = appendAccessEvent(state, { type: 'login-revoked', accountEventId: event.eventId,
        accountEventSeq: event.seq, accountIds: [event.accountId], loginIds, createdAt: now() });
      state.barriers[`event:${event.eventId}`] = { eventId: event.eventId, accountEventSeq: event.seq,
        accessEventId: accessEvent.eventId, accessSeq: accessEvent.seq, loginIds, state: 'pending' };
      const control = fenceRuns(state, { kind: 'credential', requestId: `access:${accessEvent.eventId}`,
        loginIds, accessSeq: accessEvent.seq });
      return { duplicate: false, event: accessEvent, control };
    });
    if (result.event) notify(result.event, result.control);
    return { duplicate: result.duplicate, accountHead: ledger.read().accountHead };
  }
  async function synchronize() {
    if (closed) reject(503, 'authority-closed');
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        // Account's head is global. Validate and apply every page, never skip another account's seq.
        for (;;) {
          const cursor = ledger.read().accountHead;
          let batch;
          try { batch = validateEventBatch(await accountClient.events(cursor), cursor); }
          catch (error) { if (error.status) throw error; reject(503, 'account-event-gap'); }
          if (!Number.isSafeInteger(batch.headSeq) || batch.headSeq < cursor || !Array.isArray(batch.events)) reject(503, 'account-event-gap');
          if (batch.headSeq > cursor && batch.events.length === 0) reject(503, 'account-event-gap');
          for (const event of batch.events) applyRevocation(event);
          if (ledger.read().accountHead >= batch.headSeq) break;
        }
        ready = true; return { accountHead: ledger.read().accountHead };
      } catch (error) { ready = false; throw error; }
      finally { syncing = null; }
    })();
    return syncing;
  }
  async function verify(input, trustedRole = 'page') {
    if (!input || typeof input !== 'object') reject(401, 'login-required');
    let token = input.accessToken, ref;
    if (input.authorizationId !== undefined) {
      ref = refs.get(input.authorizationId);
      if (!ref) reject(401, 'authorization-expired');
      token = ref.token;
      for (const field of ['accountId', 'loginId', 'credentialId', 'loginGeneration']) {
        if (input[field] !== undefined && input[field] !== ref.principal[field]) reject(401, 'principal-mismatch');
      }
      if (input.accessToken !== undefined && input.accessToken !== token) reject(401, 'principal-mismatch');
      trustedRole = ref.role;
    }
    const principal = await accountClient.verify(token);
    await synchronize();
    const state = ledger.read();
    if (state.accountHead < principal.accountEventSeq) reject(503, 'account-event-gap');
    if (state.revokedLogins[`login:${principal.loginId}`]) reject(401, 'credential-revoked');
    if (principal.expiresAt <= now()) reject(401, 'credential-revoked');
    if (ref && ['accountId', 'loginId', 'credentialId', 'loginGeneration'].some(k => principal[k] !== ref.principal[k])) reject(401, 'principal-mismatch');
    if (!['page', 'agent', 'render'].includes(trustedRole)) reject(403, 'invalid-role');
    let authorizationId = input.authorizationId;
    if (!authorizationId) {
      authorizationId = randomUUID(); refs.set(authorizationId, { token, principal, role: trustedRole });
    }
    for (const [id, entry] of refs) if (entry.principal.expiresAt <= now()) refs.delete(id);
    return { ...principal, authorizationId, role: trustedRole };
  }
  async function authorizePrincipal(input, { projectId, action = 'read', trustedRole = 'page' } = {}) {
    if (!['read', 'write', 'admin'].includes(action)) reject(400, 'invalid-action');
    const principal = await verify(input, trustedRole);
    const state = ledger.read(); const project = projectOf(state, projectId);
    const access = permission(project, principal.accountId, action);
    if (action === 'admin' && (principal.role !== 'page' || project.creatorAccountId !== principal.accountId)) reject(403, 'creator-required');
    return { ...principal, projectId, authorityId: ledger.authorityId, access, creator: principal.accountId === project.creatorAccountId,
      accessRevision: project.accessRevision, revocationSeq: state.accessHead };
  }
  async function checkAccess({ principal, projectId, action, resource } = {}) {
    if (!principal?.authorizationId) reject(401, 'login-required');
    if (!accountIdOK(principal.accountId) || typeof principal.loginId !== 'string' || !principal.loginId ||
      typeof principal.credentialId !== 'string' || !principal.credentialId || !Number.isSafeInteger(principal.loginGeneration)) reject(401, 'principal-mismatch');
    if (principal.projectId !== projectId) reject(403, 'project-mismatch');
    if (!['read', 'write'].includes(action)) reject(400, 'invalid-action');
    if (resource !== undefined && (!resource || typeof resource !== 'object' || !['media', 'snap', 'px'].includes(resource.ns))) reject(400, 'invalid-resource');
    // runGrantId in a caller body cannot bypass a revoked login, private read or new run admission.
    const verified = await authorizePrincipal(principal, { projectId, action });
    return { allowed: true, ...verified };
  }
  function requestKey(accountId, requestId) { requireRequestId(requestId); return `request:${accountId}:${requestId}`; }
  function replay(state, key, digest) {
    const previous = state.requests[key];
    if (previous && previous.digest !== digest) reject(409, 'request-mismatch');
    return previous;
  }
  async function createProject(input, body) {
    const actor = await verify(input);
    if (actor.role !== 'page') reject(403, 'creator-required');
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 200 || /[\u0000-\u001f]/.test(name)) reject(400, 'invalid-name');
    if (body.allowLinkJoin !== undefined && typeof body.allowLinkJoin !== 'boolean') reject(400, 'invalid-entry');
    if (typeof initializeProject !== 'function') reject(503, 'initialization-unavailable');
    const key = requestKey(actor.accountId, body.requestId);
    const payload = { op: 'create', name, initialProject: body.initialProject ?? null, allowLinkJoin: body.allowLinkJoin ?? true };
    const digest = digestOf(payload);
    const pending = ledger.transaction(state => {
      const previous = replay(state, key, digest);
      if (previous) return { projectId: previous.projectId, result: previous.result ?? null };
      if (Object.values(state.projects).some(p => p.status !== 'deleted' && p.name === name)) reject(409, 'name-taken');
      let projectId; do { projectId = newProjectId(); } while (state.projects[projectId]);
      state.projects[projectId] = { v: 2, identityRealm: 'account', projectId, authorityId: ledger.authorityId,
        name, status: 'pending', creatorAccountId: actor.accountId, allowLinkJoin: payload.allowLinkJoin,
        members: { [actor.accountId]: { access: 'rw', joinedAt: now() } }, bans: {}, accessRevision: 0,
        hosted: { render: false, agent: false }, creationRequestId: body.requestId, initialProject: payload.initialProject };
      state.requests[key] = { digest, projectId, state: 'pending' }; return { projectId, result: null };
    });
    if (pending.result) return pending.result;
    if (creating.has(key)) return creating.get(key);
    const work = (async () => {
      const project = ledger.read().projects[pending.projectId];
      const initialized = await initializeProject({ projectId: project.projectId, creatorAccountId: actor.accountId,
        authorityId: ledger.authorityId, requestId: body.requestId, initialProject: structuredClone(project.initialProject) });
      if (!initialized || typeof initialized.contentId !== 'string' || !initialized.contentId) reject(503, 'initialization-incomplete');
      // Recheck the initiating credential after asynchronous durable initialization, before exposing active.
      await verify({ authorizationId: actor.authorizationId });
      const committed = ledger.transaction(state => {
        const p = state.projects[project.projectId]; const previous = replay(state, key, digest);
        if (previous.result) return { result: previous.result, event: null };
        p.status = 'active'; p.contentId = initialized.contentId; delete p.initialProject;
        p.accessRevision = ++state.revision;
        const event = appendAccessEvent(state, { type: 'project-created', projectId: p.projectId, accessRevision: p.accessRevision, createdAt: now() });
        const result = { projectId: p.projectId, authorityId: ledger.authorityId, contentId: p.contentId, accessRevision: p.accessRevision };
        state.requests[key] = { digest, projectId: p.projectId, state: 'complete', result };
        return { result, event };
      });
      if (committed.event) notify(committed.event); return committed.result;
    })();
    creating.set(key, work);
    try { return await work; } finally { creating.delete(key); }
  }
  function listProjects(accountId) {
    if (!accountIdOK(accountId)) reject(400, 'invalid-account');
    if (!ready || closed) reject(503, 'authority-not-ready');
    if (typeof authorityUrl !== 'string' || !/^https:\/\//.test(authorityUrl)) reject(503, 'authority-url-unavailable');
    const state = ledger.read(); const owned = [], joined = [];
    for (const p of Object.values(state.projects)) {
      if (p.status !== 'active' || p.bans[accountId]) continue;
      const item = { projectId: p.projectId, name: p.name, status: p.status, creatorAccountId: p.creatorAccountId,
        authorityId: ledger.authorityId, accessRevision: p.accessRevision,
        url: `${authorityUrl.replace(/\/$/, '')}/?project=${encodeURIComponent(p.projectId)}` };
      if (p.creatorAccountId === accountId) owned.push(item);
      else if (p.members[accountId]?.joinedAt != null) joined.push(item);
    }
    return { authorityId: ledger.authorityId, revision: state.revision, owned, joined };
  }
  async function joinProject(input, body) {
    const actor = await verify(input); const key = requestKey(actor.accountId, body?.requestId);
    const digest = digestOf({ op: 'join', projectId: body.projectId });
    const committed = ledger.transaction(state => {
      const p = projectOf(state, body.projectId); active(p);
      if (p.bans[actor.accountId]) reject(403, 'banned');
      if (!p.allowLinkJoin && !p.members[actor.accountId]) reject(403, 'not-listed');
      const previous = replay(state, key, digest); if (previous) return { result: previous.result, event: null };
      if (!p.members[actor.accountId]?.joinedAt) {
        p.members[actor.accountId] = { access: p.members[actor.accountId]?.access ?? 'rw', joinedAt: now() };
        p.accessRevision = ++state.revision;
      }
      const result = { projectId: p.projectId, authorityId: ledger.authorityId, accessRevision: p.accessRevision,
        access: p.members[actor.accountId].access };
      state.requests[key] = { digest, result, state: 'complete' };
      const event = appendAccessEvent(state, { type: 'member-joined', projectId: p.projectId, accountIds: [actor.accountId], accessRevision: p.accessRevision, createdAt: now() });
      return { result, event };
    });
    if (committed.event) notify(committed.event); return committed.result;
  }
  async function adminProject(input, body) {
    const actor = await verify(input);
    const key = requestKey(actor.accountId, body.requestId); const digest = digestOf({ op: 'admin', body });
    const committed = ledger.transaction(state => {
      const p = projectOf(state, body.projectId);
      if (actor.role !== 'page' || actor.accountId !== p.creatorAccountId) reject(403, 'creator-required');
      const previous = replay(state, key, digest); if (previous) return { result: previous.result, event: null };
      permission(p, actor.accountId, 'admin');
      if (body.expectedAccessRevision !== p.accessRevision) reject(409, 'access-revision-mismatch');
      const affected = [];
      switch (body.op) {
        case 'set-entry':
          if (typeof body.allowLinkJoin !== 'boolean') reject(400, 'invalid-entry'); p.allowLinkJoin = body.allowLinkJoin; break;
        case 'set-list': {
          if (!Array.isArray(body.members) || body.members.length > 10000) reject(400, 'invalid-members');
          const next = { [p.creatorAccountId]: p.members[p.creatorAccountId] };
          for (const member of body.members) {
            if (!accountIdOK(member?.accountId) || !['r', 'rw'].includes(member.access) || next[member.accountId]) reject(400, 'invalid-members');
            if (p.bans[member.accountId]) reject(403, 'banned');
            next[member.accountId] = { access: member.access, joinedAt: p.members[member.accountId]?.joinedAt ?? null };
          }
          for (const [id, old] of Object.entries(p.members)) if (!next[id] || (old.access === 'rw' && next[id].access === 'r')) affected.push(id);
          p.members = next; break;
        }
        case 'kick':
          if (!accountIdOK(body.accountId) || body.accountId === p.creatorAccountId) reject(400, 'invalid-member');
          delete p.members[body.accountId]; p.bans[body.accountId] = { reason: 'kick', requestId: body.requestId }; affected.push(body.accountId); break;
        case 'unban':
          if (!accountIdOK(body.accountId)) reject(400, 'invalid-member'); delete p.bans[body.accountId]; break;
        case 'delete': p.status = 'deleted'; affected.push(...Object.keys(p.members)); break;
        case 'set-hosted-service':
          if (!['render', 'agent'].includes(body.service) || typeof body.enabled !== 'boolean') reject(400, 'invalid-service');
          p.hosted[body.service] = body.enabled; break;
        default: reject(400, 'invalid-operation');
      }
      p.accessRevision = ++state.revision;
      const event = appendAccessEvent(state, { type: 'project-access-changed', reason: body.op, projectId: p.projectId,
        accountIds: affected, accessRevision: p.accessRevision, createdAt: now(),
        ...(body.op === 'set-hosted-service' ? { service: body.service, enabled: body.enabled } : {}) });
      let control = null;
      const fence = { requestId: `access:${event.eventId}`, projectId: p.projectId, accessSeq: event.seq };
      if (body.op === 'delete') control = fenceRuns(state, { ...fence, kind: 'delete' });
      else if (body.op === 'set-hosted-service' && body.service === 'agent' && body.enabled === false)
        control = fenceRuns(state, { ...fence, kind: 'agent-disabled' });
      else if (affected.length) control = fenceRuns(state, { ...fence, kind: 'member', accountIds: affected });
      if (p.status === 'deleted') p.tombstone = { revision: p.accessRevision, deletedAt: now() };
      const result = { eventId: event.eventId, accessRevision: p.accessRevision, completed: false, state: 'pending-services' };
      state.requests[key] = { digest, result, state: 'complete' };
      return { result, event, control };
    });
    if (committed.event) notify(committed.event, committed.control); return committed.result;
  }
  function eventsSince(after = 0) {
    if (!ready || closed) reject(503, 'authority-not-ready');
    const state = ledger.read();
    if (!Number.isSafeInteger(after) || after < 0 || after > state.accessHead) reject(400, 'invalid-cursor');
    return { events: state.accessEvents.filter(e => e.seq > after).slice(0, 100), headSeq: state.accessHead };
  }
  function ackAccessEvent(eventId, serviceId, receipt) {
    if (!services.includes(serviceId)) reject(403, 'service-forbidden');
    requireRequestId(receipt?.receiptId);
    // A service sends its immutable receipt only after real close. Progress/pending is not an ACK.
    if (!Number.isSafeInteger(receipt.cursor) || receipt.complete !== true || !Array.isArray(receipt.closedStreams) || !Array.isArray(receipt.stoppedRuns) || !Array.isArray(receipt.rejectedCredentials)) reject(400, 'invalid-receipt');
    return ledger.transaction(state => {
      const event = state.accessEvents.find(e => e.eventId === eventId); if (!event) reject(404, 'no-event');
      if (receipt.cursor < event.seq || receipt.cursor > state.accessHead) reject(409, 'ack-cursor-mismatch');
      if (serviceId === 'agent' && state.agentReadControlRequired === true) {
        const closure = state.agentReadAccessClosuresV1?.[eventId];
        if (!closure || closure.payload?.source !== 'doc-agent-read-control' || closure.payload.complete !== true ||
            closure.payload.eventId !== eventId || closure.payload.accessSeq !== event.seq ||
            !Array.isArray(closure.payload.controlIds) || !closure.payload.controlIds.length ||
            closure.digest !== digestOf(closure.payload) || receipt.agentReadClosureDigest !== closure.digest)
          reject(503, 'agent-read-closure-required');
      }
      const key = `ack:${eventId}:${serviceId}`; const old = state.accessAcks[key];
      if (old && receipt.cursor < old.cursor) return old;
      if (old && receipt.cursor === old.cursor && digestOf(old) !== digestOf(receipt)) reject(409, 'ack-mismatch');
      state.accessAcks[key] = structuredClone(receipt); return receipt;
    });
  }
  function status({ authorityId, projectId }) {
    if (!ready || closed) reject(503, 'authority-not-ready');
    if (authorityId !== ledger.authorityId) reject(409, 'wrong-authority');
    const p = projectOf(ledger.read(), projectId);
    if (p.status === 'pending') reject(404, 'no-project');
    if (p.status !== 'deleted') return { state: p.status === 'active' ? 'exists' : p.status, authorityId, projectId, accessRevision: p.accessRevision };
    if (!signingKey || typeof keyId !== 'string' || !keyId) reject(503, 'gone-proof-unavailable');
    const payload = { v: 1, authorityId, projectId, state: 'gone', tombstoneRevision: p.tombstone.revision, issuedAt: p.tombstone.deletedAt, kid: keyId };
    return { ...payload, signature: sign(null, Buffer.from(canonicalJson(payload)), signingKey).toString('base64url') };
  }
  function revocationStatus(eventId) {
    const state = ledger.read(); const barrier = state.barriers[`event:${eventId}`];
    if (!barrier) reject(404, 'no-event');
    const serviceAcks = Object.fromEntries(services.map(service => [service, state.accessAcks[`ack:${barrier.accessEventId}:${service}`] ?? null]));
    return { ...barrier, serviceAcks, pendingServices: ['doc', ...services.filter(s => !serviceAcks[s]?.complete || serviceAcks[s].cursor < barrier.accessSeq)],
      logoutComplete: false };
  }
  async function statusForPrincipal(input, query) {
    const actor = await verify(input);
    if (query.authorityId !== ledger.authorityId) reject(409, 'wrong-authority');
    const p = projectOf(ledger.read(), query.projectId);
    if (p.bans[actor.accountId]) reject(403, 'banned');
    if (p.creatorAccountId !== actor.accountId && !p.members[actor.accountId]) reject(403, 'not-listed');
    return status(query);
  }
  async function flushAccountAcknowledgements() {
    await synchronize();
    const pending = [];
    for (const { event } of Object.values(ledger.read().accountEvents)) {
      const ackKey = `seq:${event.seq}`;
      let persisted = ledger.read().accountAcks[ackKey];
      if (persisted?.sent) continue;
      if (!persisted) {
        let receipt = { receiptId: `doc:${ledger.authorityId}:${event.seq}`, appliedSeq: event.seq, logoutComplete: false };
        if (event.type === 'credentials-revoked') {
          const barrier = revocationStatus(event.eventId);
          // No default empty connection enumeration: only an owner-wired real registry/fence verifier can release this.
          if (typeof getDocBarrier !== 'function' || typeof verifyDocBarrier !== 'function' ||
            services.some(service => !barrier.serviceAcks[service]?.complete || barrier.serviceAcks[service].cursor < barrier.accessSeq)) {
            pending.push(event.eventId); continue;
          }
          const proof = await getDocBarrier(structuredClone(barrier));
          if (!proof || proof.eventId !== event.eventId || proof.accountEventSeq !== event.seq || proof.pendingSeals !== 0 ||
            !Array.isArray(proof.connections) || !Number.isSafeInteger(proof.endCursor) || proof.endCursor < 0 ||
            !proof.clockEvidence || !proof.modifications || await verifyDocBarrier(proof, barrier) !== true) {
            pending.push(event.eventId); continue;
          }
          receipt = { ...receipt, logoutComplete: true, connections: proof.connections, endCursor: proof.endCursor,
            clockEvidence: proof.clockEvidence, modifications: proof.modifications,
            serviceAcks: Object.fromEntries(services.map(service => [service, {
              receiptId: barrier.serviceAcks[service].receiptId, appliedSeq: event.seq, logoutComplete: true,
              accessCursor: barrier.serviceAcks[service].cursor, closedStreams: barrier.serviceAcks[service].closedStreams,
              stoppedRuns: barrier.serviceAcks[service].stoppedRuns, rejectedCredentials: barrier.serviceAcks[service].rejectedCredentials,
            }])) };
        }
        persisted = ledger.transaction(state => {
          state.accountAcks[ackKey] ??= { eventId: event.eventId, receipt, sent: false };
          return state.accountAcks[ackKey];
        });
      }
      // Persist the exact receipt before network send. A lost response/restart replays the same request.
      await accountClient.ack(persisted.eventId, persisted.receipt);
      ledger.transaction(state => { state.accountAcks[ackKey].sent = true; });
    }
    return { pendingEvents: [...new Set(pending)], accountHead: ledger.read().accountHead };
  }
  return { authorityId: ledger.authorityId, synchronize, applyRevocation, authorizePrincipal, checkAccess,
    createProject, joinProject, adminProject, listProjects, status, statusForPrincipal, eventsSince, ackAccessEvent, revocationStatus, flushAccountAcknowledgements,
    subscribeRevocations(context, callback) {
      if (!context || typeof context !== 'object' || typeof callback !== 'function') reject(400, 'invalid-subscription');
      const entry = { context: structuredClone(context), callback }; subscriptions.add(entry); return () => subscriptions.delete(entry);
    },
    async start() {
      await synchronize();
      if (!timer && pollMs > 0) { timer = setInterval(() => synchronize().catch(error => onDiagnostic({ code: error.code ?? 'account-unavailable' })), pollMs); timer.unref(); }
      return { accountHead: ledger.read().accountHead };
    },
    close() { closed = true; ready = false; clearInterval(timer); refs.clear(); subscriptions.clear(); },
  };
}
