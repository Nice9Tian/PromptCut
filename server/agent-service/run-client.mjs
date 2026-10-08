import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { certificateFingerprint, accountError } from '../account/client.mjs';

const paths = Object.freeze({ admit: 'admit', confirmRead: 'read', queryRead: 'read/query',
  checkAccess: 'check', finish: 'finish', runTicket: 'ticket', pending: 'pending' });
const fail = code => { throw accountError(503, code); };

/** Agent-owned mTLS transport. Doc derives the service principal from the pinned
 * client certificate; no caller can supply servicePrincipal or a human identity.
 */
export function createRunClient({ origin, tls, serverFingerprint256, timeoutMs = 5000 } = {}) {
  let base;
  try { base = new URL(origin); } catch { fail('run-client-configuration'); }
  const pin = certificateFingerprint(serverFingerprint256);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
    !tls?.key || !tls?.cert || !tls?.ca || !/^[a-f0-9]{64}$/.test(pin) || !Number.isInteger(timeoutMs) || timeoutMs < 1)
    fail('run-client-configuration');
  const agent = new https.Agent({ key: tls.key, cert: tls.cert, ca: tls.ca, rejectUnauthorized: true, minVersion: 'TLSv1.3',
    checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) ||
      (certificateFingerprint(cert.fingerprint256) !== pin ? accountError(503, 'run-server-certificate') : undefined); } });
  const active = new Set(); let closed = false;
  function request(name, fields) {
    if (closed || !paths[name]) return Promise.reject(accountError(503, 'run-client-unavailable'));
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) ||
      ['servicePrincipal', 'serviceId', 'serviceKid', 'principal', 'creator', 'accountId', 'loginId', 'credentialId', 'loginGeneration']
        .some(key => fields[key] !== undefined)) return Promise.reject(accountError(400, 'invalid-authority-claim'));
    const encoded = Buffer.from(JSON.stringify(fields));
    if (encoded.length > 1024 * 1024) return Promise.reject(accountError(413, 'run-body-too-large'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
      const req = https.request(new URL(`/internal/v2/runs/${paths[name]}`, base), { method: 'POST', agent, timeout: timeoutMs,
        headers: { 'content-type': 'application/json', 'content-length': encoded.length } }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) res.destroy(); else chunks.push(chunk); });
        res.on('error', () => done(accountError(503, 'run-client-unavailable')));
        res.on('end', () => {
          let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { return done(accountError(503, 'run-client-protocol')); }
          if (res.statusCode !== 200 || body?.ok !== true) return done(accountError(
            [400, 401, 403, 404, 409, 413].includes(res.statusCode) ? res.statusCode : 503,
            typeof body?.code === 'string' ? body.code : 'run-client-unavailable'));
          done(null, body.result);
        });
      });
      active.add(req); req.once('close', () => active.delete(req));
      req.on('timeout', () => req.destroy());
      req.on('error', () => done(accountError(503, 'run-client-unavailable')));
      req.end(encoded);
    });
  }
  return {
    admit: input => request('admit', input), confirmRead: input => request('confirmRead', input),
    queryRead: input => request('queryRead', input), checkAccess: input => request('checkAccess', input),
    finish: input => request('finish', input), runTicket: input => request('runTicket', input),
    pending: () => request('pending', {}),
    close() { closed = true; for (const req of active) req.destroy(); agent.destroy(); },
  };
}
