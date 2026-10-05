/** Local destination adapter. All authority and capabilities come from its protected move journal. */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { serviceIdentity } from './descriptor.mjs';
import { buildAuthProtocols } from '../auth/client.mjs';
import { requestRelocation } from '../hosting/relocation-client.mjs';
import { receiveRelocationIndex, receiveRelocationFile, loadRelocationStage, installRelocationStage, activateRelocationStage } from './relocation-files.mjs';
const refuse = reason => { throw Object.assign(new Error('Relocation reception rejected'), { reason }); };
export async function pullRelocationToLocal({ dataDir, store, assets, reloadSpace, move, identity, device, signal, current = () => true }) {
  const base = serviceIdentity(move.descriptor.service), roomId = move.descriptor.roomId, txnId = move.txnId;
  if (serviceIdentity(identity.candidate.service ?? identity.candidate.base) !== base || identity.candidate.projectId !== roomId) refuse('auth');
  const target = { service: base, where: 'lan', deviceId: device.deviceId }, targetVerifier = createHash('sha256').update(move.registrationKey).digest('hex');
  const ensureCurrent = () => { if (!current() || signal?.aborted) refuse('cancelled'); };
  async function call(operation, body = null, entry = null) {
    let delay = 500;
    for (let attempt = 1; ; attempt++) {
      ensureCurrent(); let response;
      try {
        const url = new URL(`${base}/hosting/relocation/export-${operation}`);
        if (!body) { url.searchParams.set('roomId', roomId); url.searchParams.set('txnId', txnId); if (entry) url.searchParams.set('path', entry.path); }
        response = await fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(entry ? 300000 : 10000)]) : AbortSignal.timeout(entry ? 300000 : 10000),
          headers: { authorization: `Bearer ${move.sourceCapability}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify({ roomId, txnId, ...body }) } : {}) });
        ensureCurrent();
        if (!response.ok) {
          const result = await response.json(); throw Object.assign(new Error('Relocation reception unavailable'), { reason: result.error ?? 'auth', status: response.status,
            retryable: [429, 502, 503, 504].includes(response.status), retryAfter: Number(response.headers.get('retry-after') || 0) });
        }
        if (entry) { await receiveRelocationFile({ dataDir, txnId, relative: entry.path, stream: Readable.fromWeb(response.body) }); ensureCurrent(); return; }
        const result = await response.json(); if (!result.ok || result.roomId !== roomId || result.txnId !== txnId) refuse('auth');
        return result;
      } catch (e) {
        if (!current() || signal?.aborted) refuse('cancelled');
        if (e.reason && !e.retryable || attempt >= 3) throw e.reason ? e : Object.assign(new Error('Relocation reception interrupted'), { reason: 'relocation-network', retryable: true });
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(Object.assign(new Error('Relocation cancelled'), { reason: 'cancelled' })); };
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.max(delay, Math.min(300000, (e.retryAfter || 0) * 1000)));
          signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
        }); delay = Math.min(30000, delay * 2);
      } finally { if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {}); }
    }
  }
  const initial = { target, targetVerifier, sourceCapability: move.sourceCapability };
  let authority;
  // First try the durable transaction capability; a lost initial response must not
  // require a fresh challenge from an already restricted source service.
  try { authority = await call('start', initial); }
  catch (e) {
    if (e.status !== 401) throw e;
    const protocols = await buildAuthProtocols({ base, projectId: roomId, username: identity.username, as: identity.as, key: identity.key,
      deviceId: device.deviceId, deviceName: device.deviceName, fetch: (url, init) => fetch(url, { ...init, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }) });
    authority = await call('start', { ...initial, protocols });
  }
  const received = await call('index');
  const stage = receiveRelocationIndex({ dataDir, index: received.index, authority });
  if (authority.phase !== 'committed') {
    for (const entry of stage.index.entries) await call('file', null, entry);
    ensureCurrent();
    const installed = installRelocationStage({ stage: loadRelocationStage({ dataDir, txnId }), dataDir, store, assets, reloadSpace });
    await requestRelocation({ service: base, trustedService: base, operation: 'ready', body: { ...installed, deviceId: device.deviceId }, registrationKey: move.registrationKey, signal });
  }
  ensureCurrent(); const published = await call('publish', {}); ensureCurrent();
  activateRelocationStage({ stage: loadRelocationStage({ dataDir, txnId }), dataDir, store, assets, authority: published });
  return { roomId, txnId, epoch: published.epoch, target: published.target, manifest: published.manifest };
}
