/** Server-side relocation control. Never import into a page or take trust from a project file. */
import { serviceIdentity } from '../recovery/descriptor.mjs';
import { isProjectId } from '../auth/protocol.mjs';
import { isRelocationId } from '../recovery/relocation.mjs';
const operations = new Set(['begin', 'ready', 'publish', 'state']);
export async function requestRelocation({ service, trustedService, operation, body, registrationKey, signal, attempts = 3 }) {
  if (serviceIdentity(service) !== serviceIdentity(trustedService) || !operations.has(operation)
    || !isProjectId(body?.roomId) || !isRelocationId(body?.txnId) || !/^[A-Za-z0-9_-]{43}$/.test(registrationKey ?? '')
    || !Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) throw Object.assign(new Error('Untrusted relocation request'), { reason: 'auth' });
  const base = serviceIdentity(trustedService); let delay = 500;
  for (let attempt = 1; ; attempt++) {
    let error;
    try {
      const res = await fetch(`${base}/hosting/relocation/${operation}`, { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${registrationKey}` }, body: JSON.stringify(body) });
      let result; try { result = await res.json(); } catch { throw Object.assign(new Error('Invalid relocation response'), { reason: 'auth' }); }
      if (!res.ok || !result.ok) throw Object.assign(new Error('Relocation control rejected'), { reason: result.error ?? 'auth', status: res.status,
        retryAfter: Math.max(0, Number(res.headers.get('retry-after') || result.retryAfter || 0)), retryable: [429, 502, 503, 504].includes(res.status) });
      if (result.roomId !== body.roomId || result.move?.txnId !== body.txnId || !Number.isSafeInteger(result.epoch)
        || !['prepared', 'ready', 'committed'].includes(result.move?.phase)) throw Object.assign(new Error('Relocation identity mismatch'), { reason: 'auth' });
      return result;
    } catch (e) {
      if (signal?.aborted) throw Object.assign(new Error('Relocation cancelled'), { reason: 'cancelled' });
      error = e.reason ? e : Object.assign(new Error('Relocation service temporarily unavailable'), { reason: 'relocation-network', retryable: true });
      if (!error.retryable || attempt >= attempts) throw error;
    }
    const wait = Math.max(delay, Math.min(300000, error.retryAfter * 1000 || 0));
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(Object.assign(new Error('Relocation cancelled'), { reason: 'cancelled' })); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, wait);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    delay = Math.min(30000, delay * 2);
  }
}
