import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { certificateFingerprint, accountError } from '../account/client.mjs';

/** Dedicated v2 mTLS client. Every call carries the doc-issued opaque Agent delegation;
 * no account token, claimed principal or result cache is persisted in this process.
 */
export function createConversationClient({ origin, tls, serverFingerprint256, timeoutMs = 5000 }) {
  const base = new URL(origin); const pin = certificateFingerprint(serverFingerprint256);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
      !tls?.key || !tls?.cert || !tls?.ca || !/^[a-f0-9]{64}$/.test(pin)) throw accountError(503, 'conversation-client-configuration');
  const agent = new https.Agent({ key: tls.key, cert: tls.cert, ca: tls.ca, rejectUnauthorized: true, minVersion: 'TLSv1.3',
    checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) ||
      (certificateFingerprint(cert.fingerprint256) !== pin ? accountError(503, 'conversation-server-certificate') : undefined); } });
  const active = new Set(); let closed = false;
  const request = (action, input) => new Promise((resolve, reject) => {
    if (closed || !['identity', 'access', 'list', 'get', 'send', 'switch', 'stop', 'rename'].includes(action))
      return reject(accountError(503, 'conversation-client-unavailable'));
    const body = Buffer.from(JSON.stringify(input));
    if (body.length > 1024 * 1024) return reject(accountError(413, 'conversation-body-too-large'));
    const req = https.request(new URL(`/internal/v2/conversations/${action}`, base), { method: 'POST', agent, timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': body.length } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) res.destroy(); else chunks.push(chunk); });
      res.on('error', () => reject(accountError(503, 'conversation-client-unavailable')));
      res.on('end', () => {
        let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reject(accountError(503, 'conversation-client-protocol')); }
        if (value?.ok !== true || res.statusCode !== 200) return reject(accountError(
          [400, 401, 403, 404, 409, 413].includes(res.statusCode) ? res.statusCode : 503,
          typeof value?.code === 'string' ? value.code : 'conversation-client-unavailable'));
        resolve(value.result);
      });
    });
    active.add(req); req.once('close', () => active.delete(req));
    req.on('timeout', () => req.destroy());
    req.on('error', () => reject(accountError(503, 'conversation-client-unavailable')));
    req.end(body);
  });
  return {
    identity: input => request('identity', input), access: input => request('access', input),
    list: input => request('list', input), get: input => request('get', input),
    send: input => request('send', input), switchVisibility: input => request('switch', input),
    stop: input => request('stop', input), rename: input => request('rename', input),
    close() { closed = true; for (const req of active) req.destroy(); agent.destroy(); },
  };
}
