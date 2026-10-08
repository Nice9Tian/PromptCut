import { accountError } from './client.mjs';
import { canonicalJson, digestOf } from './ledger.mjs';
import { assertInstanceDirectTransport, instanceRequestProof } from './agent-instance-internal.mjs';

const fail = (status, code) => { throw accountError(status, code); };
const clone = value => structuredClone(value);
const reference = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const instanceKeys = ['serviceId', 'serviceKid', 'instanceId', 'instanceGeneration'];
const sameInstance = (a, b) => instanceKeys.every(key => a?.[key] === b?.[key]);
const tables = state => (state.agentReadsV1 ??= { head: 0, controls: [], handles: {}, instances: {}, nonces: {}, requests: {} });
export const CONVERSATION_CONTROL_ROOT = '/internal/v2/conversation-controls/';
export const conversationControlOperations = Object.freeze({ subscribe: 'conversationControlSubscribe',
  open: 'conversationReadOpen', close: 'conversationReadClose', ack: 'conversationControlAck' });

/** The whole exact request is the capability scope, including the fresh nonce.
 * Ordinary run metadata/read/write capabilities cannot authorize these APIs. */
export function conversationControlScope(operation, body) {
  const action = Object.keys(conversationControlOperations).find(key => conversationControlOperations[key] === operation);
  const shapes = { subscribe: ['requestId', 'nonce'], open: ['requestId', 'nonce', 'delegation', 'projectId', 'conversationId', 'action', 'after'],
    close: ['requestId', 'nonce', 'readHandleIds'], ack: ['requestId', 'nonce', 'controlId', 'payloadDigest', 'seq', 'readHandleIds'] };
  if (!action || !body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== [...shapes[action]].sort().join(',') ||
      !reference(body.requestId) || !reference(body.nonce)) fail(400, 'read-control-request-invalid');
  if (action === 'open' && (typeof body.delegation !== 'string' || !body.delegation || body.delegation.length > 8192 ||
      !reference(body.projectId) || (body.conversationId !== null && !reference(body.conversationId)) ||
      !['get', 'list', 'access'].includes(body.action) || !Number.isSafeInteger(body.after) || body.after < 0)) fail(400, 'read-control-request-invalid');
  if (['close', 'ack'].includes(action) && (!Array.isArray(body.readHandleIds) || body.readHandleIds.length > 1024 ||
      new Set(body.readHandleIds).size !== body.readHandleIds.length || !body.readHandleIds.every(reference))) fail(400, 'read-control-request-invalid');
  if (action === 'ack' && (!reference(body.controlId) || !/^[a-f0-9]{64}$/.test(body.payloadDigest ?? '') ||
      !Number.isSafeInteger(body.seq) || body.seq < 1)) fail(400, 'read-control-request-invalid');
  return { operation, request: clone(body) };
}

/** Mounted only on doc's existing pinned Agent mTLS server. No public header can
 * replace the actual TLS socket, exporter, or currently registered instance. */
export function createAgentReadControlHandler({ control, resolveServicePrincipal, instanceAuthority }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'https://internal.invalid');
    if (!url.pathname.startsWith(CONVERSATION_CONTROL_ROOT)) return false;
    let invocation, unsubscribe, timer;
    try {
      assertInstanceDirectTransport(req);
      if (req.method !== 'POST' || url.search) fail(400, 'read-control-request-invalid');
      const action = url.pathname.slice(CONVERSATION_CONTROL_ROOT.length), operation = conversationControlOperations[action];
      if (!operation) fail(404, 'read-control-no-route');
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) fail(413, 'read-control-body-too-large'); chunks.push(chunk); }
      let body; try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { fail(400, 'read-control-request-invalid'); }
      conversationControlScope(operation, body);
      const base = await resolveServicePrincipal({ socket: req.socket });
      invocation = instanceAuthority.authenticate({ servicePrincipal: base, method: req.method, path: url.pathname,
        operation, request: body, proof: instanceRequestProof(req) });
      const servicePrincipal = { ...base, ...invocation };
      if (action === 'subscribe') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'connection': 'close' });
        const closed = new Promise(resolve => { res.once('close', resolve); req.once('aborted', resolve); });
        unsubscribe = control.subscribe({ servicePrincipal, body,
          send(frame) { if (res.destroyed || res.writableEnded) fail(503, 'read-control-disconnected');
            res.write(JSON.stringify(frame) + '\n'); },
          onFailure: () => res.destroy() });
        timer = setInterval(() => control.publish(), 1000); timer.unref?.();
        await closed;
      } else {
        const result = await ({ open: control.open, close: control.closeReads, ack: control.acknowledge })[action]({ servicePrincipal, body });
        if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: true, result })); }
      }
    } catch (error) {
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) { res.writeHead(error.status ?? 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, code: error.code ?? 'read-control-unavailable' })); }
    } finally { clearInterval(timer); unsubscribe?.(); if (invocation) instanceAuthority.release(invocation.instanceSession); }
    return true;
  };
}

/** One SQLite authority for HTTP read inventory and close controls. Network
 * adapters must derive servicePrincipal from an actual authenticated socket and
 * release invocation capabilities only after the complete request/stream ends.
 * Unknown historical OS instances never become closed through an empty list. */
export function createAgentReadControl({ ledger, instanceAuthority, authorizeRead, checkReadInState,
  synchronize = async () => {}, onProgress = () => {} } = {}) {
  if (![ledger?.read, ledger?.transaction, instanceAuthority?.verifyInState, authorizeRead, checkReadInState]
    .every(value => typeof value === 'function')) fail(503, 'read-control-configuration');
  ledger.transaction(state => { state.agentReadControlRequired = true; tables(state); });
  const streams = new Map(), waiters = new Set(); let stopped = false;
  const instance = (state, servicePrincipal, action, body) => {
    const operation = conversationControlOperations[action]; conversationControlScope(operation, body);
    if (stopped) fail(503, 'read-control-closed');
    return instanceAuthority.verifyInState(state, servicePrincipal, { operation, input: body });
  };
  const nonce = (state, who, body) => {
    const key = digestOf({ instanceId: who.instanceId, nonce: body.nonce });
    const t = tables(state);
    if (t.nonces[key]) fail(409, 'read-control-replay');
    t.nonces[key] = true;
  };
  const requireLive = who => {
    const stream = streams.get(who.instanceId);
    if (!stream || !sameInstance(stream.who, who)) fail(503, 'read-control-disconnected');
    stream.verify();
    return stream;
  };
  function subscribe({ servicePrincipal, body, send, onFailure }) {
    if (typeof send !== 'function' || typeof onFailure !== 'function') fail(503, 'read-control-configuration');
    const who = ledger.transaction(state => {
      const who = instance(state, servicePrincipal, 'subscribe', body); nonce(state, who, body);
      const t = tables(state), old = t.instances[who.instanceId];
      if (old && !sameInstance(old, who)) fail(403, 'read-instance-mismatch');
      t.instances[who.instanceId] ??= { ...who };
      return who;
    });
    // A reconnect invalidates the old stream before publishing any ready frame.
    streams.get(who.instanceId)?.close();
    const stream = { who, seq: 0, closed: false,
      verify() { instance(ledger.read(), servicePrincipal, 'subscribe', body); },
      close() { if (stream.closed) return; stream.closed = true;
        if (streams.get(who.instanceId) === stream) streams.delete(who.instanceId); onFailure(); },
      pump() {
        if (stream.closed) return;
        try {
          stream.verify(); const state = ledger.read(), t = tables(state);
          for (const control of t.controls) {
            if (control.seq <= stream.seq) continue;
            if (control.seq !== stream.seq + 1) fail(503, 'read-control-gap');
            const target = control.targets[who.instanceId];
            send({ type: 'control', authorityId: ledger.authorityId, seq: control.seq,
              controlId: control.controlId, payloadDigest: control.payloadDigest,
              readHandleIds: target?.readHandleIds ?? [], required: Boolean(target && !target.receipt),
              unknownInstance: target?.unknownInstance === true });
            stream.seq = control.seq;
          }
          send({ type: 'ready', authorityId: ledger.authorityId, ...who, head: t.head,
            openReadHandleIds: Object.values(t.handles).filter(h => sameInstance(h, who) && h.state !== 'closed').map(h => h.readHandleId) });
        } catch { stream.close(); }
      } };
    streams.set(who.instanceId, stream); stream.pump();
    return () => stream.close();
  }
  const publish = () => { for (const stream of streams.values()) stream.pump(); };
  async function open({ servicePrincipal, body }) {
    const who = instance(ledger.read(), servicePrincipal, 'open', body); requireLive(who);
    await synchronize();
    // The adapter resolves the opaque delegation, and doc reconstructs the
    // principal. No caller-supplied user/creator/run field becomes authority.
    const principal = await authorizeRead(body);
    return ledger.transaction(state => {
      const current = instance(state, servicePrincipal, 'open', body); requireLive(current); nonce(state, current, body);
      const value = checkReadInState(state, principal, body);
      const t = tables(state), binding = { ...current, projectId: body.projectId, conversationId: body.conversationId,
        ...Object.fromEntries(['accountId', 'loginId', 'credentialId', 'loginGeneration'].map(k => [k, principal[k]])) };
      const key = digestOf({ instanceId: current.instanceId, requestId: body.requestId });
      const old = t.requests[key];
      if (old) {
        if (old.digest !== digestOf(binding)) fail(409, 'read-request-mismatch');
        const handle = t.handles[old.readHandleId];
        if (handle.state !== 'open') fail(403, 'read-handle-closed');
        return { readHandle: clone(handle), value };
      }
      const handle = { ...binding, readHandleId: `read_${key}`, state: 'open', head: t.head };
      t.handles[handle.readHandleId] = handle; t.requests[key] = { digest: digestOf(binding), readHandleId: handle.readHandleId };
      return { readHandle: clone(handle), value };
    });
  }
  function closeReads({ servicePrincipal, body }) {
    return ledger.transaction(state => {
      const who = instance(state, servicePrincipal, 'close', body); nonce(state, who, body);
      const t = tables(state);
      for (const id of body.readHandleIds) {
        const handle = t.handles[id]; if (!handle || !sameInstance(handle, who)) fail(403, 'read-instance-mismatch');
        handle.state = 'closed';
        handle.closeReceipt ??= { requestId: body.requestId, ...who };
      }
      return { closedReadHandleIds: [...body.readHandleIds] };
    });
  }
  function fenceInState(state, fence) {
    if (!reference(fence.requestId)) fail(400, 'read-fence-invalid');
    if (!['credential', 'member', 'private', 'stop', 'delete', 'agent-disabled', 'service-revoked', 'instance-revoked'].includes(fence.kind)) fail(400, 'read-fence-invalid');
    const t = tables(state), scope = Object.fromEntries(['kind', 'projectId', 'conversationId', 'runId', 'serviceKid',
      'instanceId', 'instanceGeneration', 'requestId'].map(k => [k, fence[k] ?? null]));
    const id = `read-control:${digestOf(scope)}`, digest = digestOf(fence), old = t.controls.find(c => c.controlId === id);
    if (old) { if (old.payloadDigest !== digest) fail(409, 'read-control-mismatch'); return clone(old); }
    const control = { controlId: id, payloadDigest: digest, seq: ++t.head, scope,
      accessSeq: fence.accessSeq ?? null, targets: {} };
    for (const handle of Object.values(t.handles)) {
      if (handle.state === 'closed' || fence.kind === 'stop' ||
          (fence.projectId && fence.projectId !== handle.projectId) ||
          (fence.conversationId && handle.conversationId && fence.conversationId !== handle.conversationId) ||
          (fence.loginIds && !fence.loginIds.includes(handle.loginId)) ||
          (fence.accountIds && !fence.accountIds.includes(handle.accountId)) ||
          (fence.serviceKid && fence.serviceKid !== handle.serviceKid) ||
          (fence.instanceId && (fence.instanceId !== handle.instanceId || fence.instanceGeneration !== handle.instanceGeneration))) continue;
      if (fence.kind === 'private') {
        const c = state.conversationsV2?.[fence.projectId]?.[fence.conversationId];
        if (!c) fail(503, 'read-fence-conversation-missing');
        if (handle.accountId === c.ownerAccountId || handle.accountId === state.projects[fence.projectId]?.creatorAccountId) continue;
      }
      handle.state = 'closing';
      const target = control.targets[handle.instanceId] ??= { ...Object.fromEntries(instanceKeys.map(k => [k, handle[k]])),
        readHandleIds: [], receipt: null, unknownInstance: false };
      target.readHandleIds.push(handle.readHandleId);
    }
    // Instances created before mandatory read inventory cannot prove empty by
    // reconnecting with the same certificate, or by registering a new RAM key.
    for (const row of Object.values(state.agentInstancesV2 ?? {})) {
      if (row.state === 'closed' && row.closure) continue;
      if (t.instances[row.instanceId] || fence.kind === 'stop') continue;
      control.targets[row.instanceId] = { ...Object.fromEntries(instanceKeys.map(k => [k, row[k]])),
        readHandleIds: [], receipt: null, unknownInstance: true };
    }
    t.controls.push(control);
    // Runs after the synchronous SQLite commit; rollback leaves nothing to send.
    queueMicrotask(() => { publish(); onProgress(); });
    return clone(control);
  }
  function acknowledge({ servicePrincipal, body }) {
    const result = ledger.transaction(state => {
      const who = instance(state, servicePrincipal, 'ack', body); nonce(state, who, body);
      const t = tables(state), control = t.controls.find(c => c.controlId === body.controlId), target = control?.targets[who.instanceId];
      if (!control || control.seq !== body.seq || control.payloadDigest !== body.payloadDigest || !target ||
          !sameInstance(target, who) || target.unknownInstance ||
          canonicalJson([...target.readHandleIds].sort()) !== canonicalJson([...body.readHandleIds].sort())) fail(403, 'read-control-receipt-mismatch');
      if (target.readHandleIds.some(id => t.handles[id]?.state !== 'closed' || !t.handles[id].closeReceipt)) fail(503, 'read-close-pending');
      const receipt = { controlId: control.controlId, seq: control.seq, payloadDigest: control.payloadDigest,
        ...who, closedReadHandleIds: [...target.readHandleIds].sort() };
      if (target.receipt && canonicalJson(target.receipt) !== canonicalJson(receipt)) fail(409, 'read-control-receipt-mismatch');
      target.receipt = receipt; return clone(receipt);
    });
    for (const wake of waiters) wake();
    onProgress();
    return result;
  }
  function completion({ projectId, conversationId, accessSeq } = {}) {
    const state = ledger.read(), t = tables(state);
    const relevant = t.controls.filter(c => (accessSeq !== undefined ? c.accessSeq === accessSeq :
      c.scope.projectId === projectId && (!conversationId || c.scope.conversationId === conversationId)));
    const pending = relevant.filter(c => Object.values(c.targets).some(target => !target.receipt));
    return { complete: pending.length === 0, controlIds: relevant.map(c => c.controlId), pending: pending.map(c => c.controlId) };
  }
  function waitCompletion(scope, timeoutMs = 5000) {
    if (completion(scope).complete) return Promise.resolve(completion(scope));
    return new Promise((resolve, reject) => {
      const wake = () => { const result = completion(scope); if (!result.complete && !stopped) return;
        clearTimeout(timer); waiters.delete(wake); stopped ? reject(accountError(503, 'read-control-closed')) : resolve(result); };
      const timer = setTimeout(() => { waiters.delete(wake); reject(accountError(503, 'read-close-pending')); }, timeoutMs);
      waiters.add(wake); wake();
    });
  }
  function finalizeAccessEvent({ eventId }) {
    return ledger.transaction(state => {
      const event = state.accessEvents.find(row => row.eventId === eventId);
      if (!event) fail(404, 'read-control-event-missing');
      const controls = tables(state).controls.filter(c => c.accessSeq === event.seq);
      if (!controls.length || controls.some(c => Object.values(c.targets).some(target => !target.receipt))) fail(503, 'read-close-pending');
      // This phase cannot certify an active/retained/historical run's resources.
      const runs = Object.values(state.runControlsV2 ?? {}).filter(c => c.requestId === `access:${event.eventId}`);
      if (runs.some(c => c.instances.length || c.revoked.length || c.retained.length)) fail(503, 'agent-run-closure-pending');
      const payload = { source: 'doc-agent-read-control', complete: true, eventId, accessSeq: event.seq,
        controlIds: controls.map(c => c.controlId), receipts: controls.flatMap(c => Object.values(c.targets).map(t => t.receipt)) };
      const result = { payload, digest: digestOf(payload) }, rows = state.agentReadAccessClosuresV1 ??= {};
      if (rows[eventId] && canonicalJson(rows[eventId]) !== canonicalJson(result)) fail(409, 'read-control-closure-mismatch');
      rows[eventId] = result; return result;
    });
  }
  return { open, closeReads, subscribe, publish, acknowledge, completion, waitCompletion, finalizeAccessEvent,
    hooks: { fenceInState }, close() { stopped = true; for (const stream of [...streams.values()]) stream.close();
      for (const wake of waiters) wake(); } };
}
