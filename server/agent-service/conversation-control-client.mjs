import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { certificateFingerprint, accountError } from '../account/client.mjs';
import { openAccountLedger, canonicalJson } from '../account/ledger.mjs';
import { CONVERSATION_CONTROL_ROOT, conversationControlOperations, conversationControlScope } from '../account/agent-read-control.mjs';
import { createConversationTransports } from '../agent/service/conversation-transports.mjs';

const fail = code => { throw accountError(503, code); };
/** One OS instance, one actual pinned control connection. No human token or
 * delegation is persisted. Local receipts are produced by actual close only. */
export function createConversationControlClient({ origin, tls, serverFingerprint256, runClient,
  receiptFile, retryMs = 500, onDiagnostic = () => {} } = {}) {
  const base = new URL(origin), pin = certificateFingerprint(serverFingerprint256);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
      !tls?.key || !tls?.cert || !tls?.ca || !/^[a-f0-9]{64}$/.test(pin) ||
      typeof runClient?.conversationControlProofFor !== 'function') fail('read-control-configuration');
  let closed = false, store = null, stream = null, retry = null, starting = null, expectedSeq = 0, identity = null;
  const requests = new Set(), work = new Map();
  const local = () => store.read().agentReadClosedV1 ?? {};
  function persistClosed(ids) {
    store.transaction(state => {
      const rows = state.agentReadClosedV1 ??= {};
      for (const readHandleId of ids) rows[readHandleId] ??= { readHandleId,
        instanceId: identity.instanceId, instanceGeneration: identity.instanceGeneration };
    });
  }
  const transports = createConversationTransports({ instanceIdentity: () => identity,
    async onClosed(id) { if (!store || closed) return; persistClosed([id]); await closeHandles([id]); } });
  function request(action, input, { signal, frame } = {}) {
    if (closed || !identity) return Promise.reject(accountError(503, 'read-control-unavailable'));
    const body = { ...input, nonce: randomUUID() }, operation = conversationControlOperations[action];
    conversationControlScope(operation, body);
    const path = CONVERSATION_CONTROL_ROOT + action, encoded = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      let socket, socketClosed = false, requestClosed = false, responseClosed = false, responseSeen = false,
        result, error, complete = false, settled = false;
      const finish = () => {
        if (settled || !complete || !(socket ? socketClosed : requestClosed) || (responseSeen && !responseClosed)) return;
        settled = true; signal?.removeEventListener('abort', abortSignal); error ? reject(error) : resolve(result);
      };
      const abort = reason => { error ??= reason; complete = true; req.destroy(); socket?.destroy(); finish(); };
      const abortSignal = () => abort(accountError(503, 'read-control-aborted'));
      const req = https.request(new URL(path, base), { method: 'POST', agent: false, key: tls.key, cert: tls.cert,
        ca: tls.ca, rejectUnauthorized: true, minVersion: 'TLSv1.3', timeout: 5000,
        checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) ||
          (certificateFingerprint(cert.fingerprint256) !== pin ? accountError(503, 'read-control-server-certificate') : undefined); },
        headers: { 'content-type': 'application/json', 'content-length': encoded.length, connection: 'close' } }, res => {
        responseSeen = true;
        res.once('close', () => { responseClosed = true;
          if (!complete) abort(accountError(503, 'read-control-disconnected')); finish(); });
        res.on('error', () => abort(accountError(503, 'read-control-disconnected')));
        const chunks = []; let size = 0, pending = Buffer.alloc(0);
        res.on('data', chunk => {
          try {
            if (frame && res.statusCode === 200) {
              pending = Buffer.concat([pending, chunk]);
              if (pending.length > 1024 * 1024) fail('read-control-frame-too-large');
              for (;;) {
                const index = pending.indexOf(10); if (index < 0) break;
                const line = pending.subarray(0, index); pending = pending.subarray(index + 1);
                frame(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
              }
            } else { size += chunk.length; if (size > 1024 * 1024) fail('read-control-response-too-large'); chunks.push(chunk); }
          } catch (e) { abort(e); }
        });
        res.on('end', () => {
          if (frame && res.statusCode === 200) return abort(accountError(503, 'read-control-disconnected'));
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (res.statusCode !== 200 || value?.ok !== true) error = accountError(res.statusCode ?? 503, value?.code ?? 'read-control-unavailable');
            else result = value.result;
          } catch { error = accountError(503, 'read-control-protocol'); }
          complete = true; finish();
        });
      });
      requests.add(req); req.once('close', () => { requests.delete(req); requestClosed = true; finish(); });
      req.on('error', e => abort(accountError(503, e.code === 'ECONNREFUSED' ? 'read-control-unavailable' : 'read-control-disconnected')));
      req.on('timeout', () => abort(accountError(503, 'read-control-timeout')));
      req.on('socket', current => {
        socket = current; current.once('close', () => { socketClosed = true; finish(); });
        current.once('secureConnect', () => {
          try { if (signal?.aborted || closed) return abortSignal();
            const proof = runClient.conversationControlProofFor({ socket: current, path, operation, body });
            req.setHeader(proof.name, proof.value); req.end(encoded);
          } catch (e) { abort(e); }
        });
      });
      signal?.addEventListener('abort', abortSignal, { once: true }); if (signal?.aborted) abortSignal();
    });
  }
  async function closeHandles(ids) {
    for (const id of ids) {
      const row = local()[id];
      if (!row || row.instanceId !== identity.instanceId || row.instanceGeneration !== identity.instanceGeneration)
        fail('read-resource-unknown');
    }
    return request('close', { requestId: `close:${ids.join(':').slice(0, 180)}`, readHandleIds: ids });
  }
  function consume(value) {
    if (value?.authorityId !== identity.authorityId) fail('read-control-authority-mismatch');
    if (value.type === 'control') {
      if (!Number.isSafeInteger(value.seq) || value.seq !== expectedSeq + 1 || !Array.isArray(value.readHandleIds)) fail('read-control-gap');
      expectedSeq = value.seq;
      if (!value.required) return;
      // fence() synchronously closes output before any Promise continuation.
      const unknown = value.readHandleIds.filter(id => !transports.hasClosed(id) && !local()[id]);
      const closing = transports.fence(unknown);
      const key = value.controlId;
      if (work.has(key)) return;
      const pending = (async () => {
        if (value.unknownInstance) fail('read-resource-unknown');
        await closing;
        persistClosed(unknown);
        await closeHandles(value.readHandleIds);
        const receipt = { requestId: `ack:${value.seq}`, controlId: value.controlId, payloadDigest: value.payloadDigest,
          seq: value.seq, readHandleIds: value.readHandleIds };
        store.transaction(state => { const rows = state.agentReadReceiptsV1 ??= {}, old = rows[key];
          if (old && canonicalJson(old) !== canonicalJson(receipt)) fail('read-control-receipt-mismatch'); rows[key] = receipt; });
        await request('ack', receipt);
      })();
      work.set(key, pending); void pending.catch(error => onDiagnostic({ code: error.code ?? 'read-control-pending' }))
        .finally(() => work.delete(key));
    } else if (value.type === 'ready') {
      if (value.instanceId !== identity.instanceId || value.instanceGeneration !== identity.instanceGeneration ||
          value.head !== expectedSeq || !Array.isArray(value.openReadHandleIds)) fail('read-control-ready-mismatch');
      // Old same-OS closed handles may have lost their close ACK. A new OS key
      // cannot acquire this instance or recycle those persisted receipts.
      for (const id of value.openReadHandleIds) if (local()[id]) void closeHandles([id]).catch(() => {});
      transports.ready();
    } else fail('read-control-frame-invalid');
  }
  async function start() {
    if (closed) fail('read-control-closed');
    if (starting) return starting;
    starting = (async () => {
      identity = await runClient.registerInstance();
      store ??= openAccountLedger({ file: receiptFile, authorityId: identity.authorityId });
      expectedSeq = 0;
      stream = request('subscribe', { requestId: `subscribe_${randomUUID()}` }, { frame: consume });
      void stream.catch(error => onDiagnostic({ code: error.code ?? 'read-control-disconnected' })).finally(() => {
        void transports.disconnect(); stream = null;
        if (!closed) { retry = setTimeout(() => { void start().catch(() => {}); }, retryMs); retry.unref?.(); }
      });
    })().finally(() => { starting = null; });
    return starting;
  }
  return { start, transports,
    read(input) { return transports.read(({ requestId, signal }) => request('open', { ...input, requestId }, { signal })); },
    async close() { closed = true; clearTimeout(retry); const draining = transports.close();
      for (const req of requests) req.destroy(); await Promise.allSettled([draining, stream, ...work.values()]);
      store?.close(); },
    describe: () => ({ ...transports.describe(), executorMounted: false }) };
}
