import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { INTERNAL_PATHS, validateAccountPrincipal, validateEventBatch, requireRequestId } from './protocol.mjs';

export const accountError = (status, code) => Object.assign(new Error(code), { status, code });
export const certificateFingerprint = value => String(value ?? '').replaceAll(':', '').toLowerCase();

/** Explicit owner-provided private CA, client certificate and pinned account leaf.
 * No credentials in URLs/logs, no loopback exemption, no CA-only fallback.
 */
export function createAccountClient({ origin, tls, serverFingerprint256, timeoutMs = 5000 }) {
  const url = new URL(origin);
  const pin = certificateFingerprint(serverFingerprint256);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !tls?.key || !tls?.cert || !tls?.ca || !/^[a-f0-9]{64}$/.test(pin)) throw accountError(503, 'account-configuration');
  const agent = new https.Agent({ key: tls.key, cert: tls.cert, ca: tls.ca, rejectUnauthorized: true, minVersion: 'TLSv1.3',
    checkServerIdentity(host, certificate) {
      const error = checkServerIdentity(host, certificate);
      if (error) return error;
      if (certificateFingerprint(certificate.fingerprint256) !== pin) return accountError(503, 'account-certificate');
    } });
  function request(method, path, body) {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const fail = () => reject(accountError(503, 'account-unavailable'));
      const req = https.request(new URL(path, url), { method, agent, timeout: timeoutMs,
        headers: encoded ? { 'content-type': 'application/json', 'content-length': encoded.length } : {} }, res => {
        let size = 0; const chunks = [];
        res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { res.destroy(); fail(); } else chunks.push(chunk); });
        res.on('error', fail);
        res.on('end', () => {
          let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(); }
          if (res.statusCode !== 200 || value?.ok !== true) {
            if (res.statusCode === 401) return reject(accountError(401, 'credential-revoked'));
            return fail();
          }
          resolve(value);
        });
      });
      req.on('timeout', () => req.destroy()); req.on('error', fail); req.end(encoded);
    });
  }
  return { close: () => agent.destroy(),
    async verify(accessToken) {
      if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 256) throw accountError(401, 'login-required');
      const result = await request('POST', INTERNAL_PATHS.verify, { accessToken, audience: 'doc', requestId: randomUUID() });
      try {
        const principal = validateAccountPrincipal(result.principal);
        if (result.accountEventSeq !== principal.accountEventSeq) throw new Error();
        return principal;
      } catch { throw accountError(503, 'account-protocol'); }
    },
    async events(after = 0) {
      const result = await request('GET', `${INTERNAL_PATHS.events}?after=${after}`);
      try { return validateEventBatch(result, after); } catch { throw accountError(503, 'account-event-gap'); }
    },
    ack(eventId, receipt) {
      requireRequestId(receipt.receiptId);
      return request('POST', `${INTERNAL_PATHS.events}/${encodeURIComponent(eventId)}/ack`, receipt);
    },
  };
}
