/** Source-side transport. Trust and registration authority come from its private device store. */
import { serviceIdentity } from './descriptor.mjs';
import { relocationFileStream } from './relocation-files.mjs';
import { requestRelocation } from '../hosting/relocation-client.mjs';
import { markRoomMoved } from './relocation.mjs';
const reject = reason => { throw Object.assign(new Error('Relocation transfer rejected'), { reason }); };
export async function transferRelocationToHosted({ snapshot, service, trustedService, registrationKey, store, signal }) {
  const base = serviceIdentity(trustedService), index = snapshot.index;
  if (serviceIdentity(service) !== base || index.target.service !== base || index.target.where !== 'hosted' || !/^[A-Za-z0-9_-]{43}$/.test(registrationKey ?? '')) reject('auth');
  const identity = { roomId: index.roomId, txnId: index.txnId };
  async function call(operation, payload = {}, entry = null) {
    let delay = 500;
    for (let attempt = 1; ; attempt++) {
      let stream;
      try {
        const url = new URL(`${base}/hosting/relocation/import-${operation}`);
        if (entry) { for (const [name, value] of Object.entries(identity)) url.searchParams.set(name, value); url.searchParams.set('path', entry.path); stream = relocationFileStream({ snapshot, relative: entry.path }); }
        const response = await fetch(url, { method: entry ? 'PUT' : 'POST', redirect: 'error',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(entry ? 300000 : 10000)]) : AbortSignal.timeout(entry ? 300000 : 10000),
          headers: { authorization: `Bearer ${registrationKey}`, 'content-type': entry ? 'application/octet-stream' : 'application/json', ...(entry ? { 'content-length': String(entry.size) } : {}) },
          body: entry ? stream : JSON.stringify({ ...identity, ...payload }), ...(entry ? { duplex: 'half' } : {}) });
        let result; try { result = await response.json(); } catch { reject('auth'); }
        if (!response.ok || !result.ok) throw Object.assign(new Error('Relocation transfer unavailable'), { reason: result.error ?? 'auth', retryable: [429, 502, 503, 504].includes(response.status), retryAfter: Number(response.headers.get('retry-after') || 0) });
        if (result.roomId !== index.roomId || result.txnId !== index.txnId) reject('auth');
        return result;
      } catch (e) {
        if (signal?.aborted) reject('cancelled');
        if (e.reason && !e.retryable || attempt >= 3) throw e.reason ? e : Object.assign(new Error('Relocation transport interrupted'), { reason: 'relocation-network', retryable: true });
        const wait = Math.max(delay, Math.min(300000, (e.retryAfter || 0) * 1000));
        await new Promise((resolve, rejectWait) => {
          const abort = () => { clearTimeout(timer); rejectWait(Object.assign(new Error('Relocation cancelled'), { reason: 'cancelled' })); };
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, wait);
          signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
        }); delay = Math.min(30000, delay * 2);
      } finally { stream?.destroy(); }
    }
  }
  const destination = await call('init', { target: index.target });
  if (!/^[a-f0-9]{64}$/.test(destination.targetVerifier ?? '')) reject('auth');
  const transaction = { ...identity, expectedEpoch: index.epoch, target: index.target, manifest: index.manifest, targetVerifier: destination.targetVerifier };
  const control = operation => requestRelocation({ service: base, trustedService: base, operation, body: transaction, registrationKey, signal });
  const begun = await control('begin');
  if (begun.move.phase === 'prepared') {
    await call('index', { index });
    for (const entry of index.entries) await call('file', {}, entry);
    await call('complete');
  }
  const published = await control('publish');
  await call('activate');
  markRoomMoved({ store, roomId: index.roomId, authority: published.location });
  return published.location;
}
