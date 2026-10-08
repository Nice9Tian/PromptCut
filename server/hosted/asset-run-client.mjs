import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { certificateFingerprint, accountError } from '../account/client.mjs';
import { RUN_ASSET_ROOT, reference } from '../account/run-asset-protocol.mjs';

const fail = code => accountError(503, code);
const actualClose = item => !item || item.closed ? Promise.resolve() : new Promise(resolve => item.once('close', resolve));

/** Asset-owned credentials only. Every data lease has one dedicated observer
 * TLS connection; an Agent request cannot be continued on a replacement socket.
 * Neither a shared pool nor a body instance reference supplies observer identity. */
export function createAssetRunClient({ origin, tls, serverFingerprint256, timeoutMs, maxResponseBytes } = {}) {
  let base; try { base = new URL(origin); } catch { throw fail('asset-run-client-unconfigured'); }
  const pin = certificateFingerprint(serverFingerprint256);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
      !tls?.key || !tls?.cert || !tls?.ca || !/^[a-f0-9]{64}$/.test(pin) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1)
    throw fail('asset-run-client-unconfigured');
  const channels = new Set(); let stopped = false;
  function channel() {
    if (stopped) throw fail('asset-run-client-closed');
    const agent = new https.Agent({ key: tls.key, cert: tls.cert, ca: tls.ca, rejectUnauthorized: true,
      minVersion: 'TLSv1.3', keepAlive: true, maxSockets: 1, maxFreeSockets: 1,
      checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) ||
        (certificateFingerprint(cert.fingerprint256) !== pin ? fail('asset-run-peer-forbidden') : undefined); } });
    let socket, lost = false, closing = false;
    const pending = new Set();
    const request = (method, route, body) => new Promise((resolve, reject) => {
      if (stopped || closing || lost || !route.startsWith(RUN_ASSET_ROOT)) return reject(fail('asset-run-observer-lost'));
      const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = https.request(new URL(route, base), { method, agent, timeout: timeoutMs,
        headers: bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {} }, res => {
        let size = 0; const pieces = [];
        res.on('data', piece => { size += piece.length; if (size > maxResponseBytes) res.destroy(fail('asset-run-response-invalid')); else pieces.push(piece); });
        res.on('error', () => reject(fail('asset-run-authority-unavailable')));
        res.on('aborted', () => reject(fail('asset-run-authority-unavailable')));
        res.on('end', () => {
          let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pieces))); }
          catch { return reject(fail('asset-run-response-invalid')); }
          if (res.statusCode !== 200 || value?.ok !== true) return reject(accountError(
            [400, 401, 403, 404, 409, 410, 413, 415].includes(res.statusCode) ? res.statusCode : 503,
            typeof value?.code === 'string' ? value.code : 'asset-run-authority-unavailable'));
          resolve(value.result);
        });
      });
      pending.add(req); req.once('close', () => pending.delete(req));
      req.on('socket', current => {
        if (socket && current !== socket) { lost = true; req.destroy(fail('asset-run-observer-lost')); return; }
        if (!socket) { socket = current; socket.once('close', () => { lost = true; }); }
      });
      req.on('timeout', () => req.destroy(fail('asset-run-authority-unavailable')));
      req.on('error', () => reject(fail('asset-run-authority-unavailable'))); req.end(bytes);
    });
    const result = { request, get lost() { return lost || closing; }, async close() {
      if (closing) return; closing = true;
      const waits = [...pending].map(actualClose); if (socket) waits.push(actualClose(socket));
      for (const req of pending) req.destroy(); agent.destroy(); socket?.destroy();
      await Promise.all(waits); channels.delete(result);
    } };
    channels.add(result); return result;
  }
  const metadata = channel();
  return {
    openLease(input) {
      const owned = channel(); let id;
      return {
        async check() {
          const result = await owned.request('POST', id ? `${RUN_ASSET_ROOT}leases/${id}/check` : `${RUN_ASSET_ROOT}check`, input);
          if (result?.allowed !== true || !reference(result.leaseId) || (id && id !== result.leaseId)) throw fail('asset-run-response-invalid');
          id = result.leaseId; return result;
        },
        closeLease(receipt) { if (!id) throw fail('asset-run-lease-unavailable'); return owned.request('POST', `${RUN_ASSET_ROOT}leases/${id}/closed`, { receipt }); },
        get leaseId() { return id; }, get lost() { return owned.lost; }, close: () => owned.close(),
      };
    },
    async eventsSince(after) {
      if (!Number.isSafeInteger(after) || after < 0) throw fail('asset-run-cursor-invalid');
      const page = await metadata.request('GET', `${RUN_ASSET_ROOT}events?after=${after}`);
      if (!Array.isArray(page?.events) || !Number.isSafeInteger(page.headSeq) || page.headSeq < after || page.events.length > 100 ||
          page.events.some((e, i) => e.seq !== after + i + 1 || !reference(e.eventId))) throw fail('asset-run-event-gap');
      return page;
    },
    acknowledgeEvent(eventId, receipt) { if (!reference(eventId)) throw fail('asset-run-event-invalid'); return metadata.request('POST', `${RUN_ASSET_ROOT}events/${eventId}/ack`, { receipt }); },
    async close() { stopped = true; await Promise.all([...channels].map(c => c.close())); },
  };
}
