import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { certificateFingerprint, accountError } from '../account/client.mjs';
import { createAgentInstanceSession } from '../agent/service/agent-instance-session.mjs';

const paths = Object.freeze({ admit: 'admit', confirmRead: 'read', queryRead: 'read/query',
  checkAccess: 'check', finish: 'finish', runTicket: 'ticket', pending: 'pending' });
const operations = Object.freeze({ admit: 'admit', confirmRead: 'confirmRead', queryRead: 'queryRead',
  checkAccess: 'checkAccess', finish: 'finish', runTicket: 'resolveRunPrincipal' });
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
  const active = new Set(); let closed = false;
  /** Every call opens its own real TLS socket. The signature is constructed only
   * after secureConnect, then the exact body is sent, and completion waits for
   * the transport close. No HTTP capability is reused on a later request. */
  function transmit(path, fields, operation = null) {
    if (closed) return Promise.reject(accountError(503, 'run-client-unavailable'));
    const encoded = Buffer.from(JSON.stringify(fields));
    if (encoded.length > 1024 * 1024) return Promise.reject(accountError(413, 'run-body-too-large'));
    return new Promise((resolve, reject) => {
      let settled = false, responseReady = false, socket = null, socketClosed = false, requestClosed = false;
      let responseError = null, responseValue;
      const finish = () => {
        if (settled || !responseReady || !(socket ? socketClosed : requestClosed)) return;
        settled = true; responseError ? reject(responseError) : resolve(responseValue);
      };
      const abort = error => { if (responseReady) return; responseError = error; responseReady = true; req.destroy(); finish(); };
      const req = https.request(new URL(path, base), { method: 'POST', agent: false, key: tls.key, cert: tls.cert,
        ca: tls.ca, rejectUnauthorized: true, minVersion: 'TLSv1.3', timeout: timeoutMs,
        checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) ||
          (certificateFingerprint(cert.fingerprint256) !== pin ? accountError(503, 'run-server-certificate') : undefined); },
        headers: { 'content-type': 'application/json', 'content-length': encoded.length, connection: 'close' } }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) res.destroy(); else chunks.push(chunk); });
        res.on('error', () => abort(accountError(503, 'run-client-unavailable')));
        res.on('end', () => {
          let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { return abort(accountError(503, 'run-client-protocol')); }
          if (res.statusCode !== 200 || body?.ok !== true) responseError = accountError(
            [400, 401, 403, 404, 409, 413].includes(res.statusCode) ? res.statusCode : 503,
            typeof body?.code === 'string' ? body.code : 'run-client-unavailable');
          else responseValue = body.result;
          responseReady = true; finish();
        });
      });
      active.add(req);
      req.once('close', () => { active.delete(req); requestClosed = true; finish(); });
      req.on('timeout', () => abort(accountError(503, 'run-client-unavailable')));
      req.on('error', () => abort(accountError(503, 'run-client-unavailable')));
      req.on('socket', current => {
        socket = current;
        current.once('close', () => { socketClosed = true; finish(); });
        current.once('secureConnect', () => {
          try {
            if (operation) {
              const proof = instanceSession.proofFor({ socket: current, method: 'POST', path, operation, body: fields });
              req.setHeader(proof.name, proof.value);
            }
            req.end(encoded);
          } catch (error) { abort(error); }
        });
      });
    });
  }
  const instanceSession = createAgentInstanceSession({ requestRegistration: (name, body) =>
    transmit(`/internal/v2/instances/${name}`, body) });
  async function request(name, fields) {
    if (closed || !paths[name]) throw accountError(503, 'run-client-unavailable');
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) ||
      ['servicePrincipal', 'serviceId', 'serviceKid', 'principal', 'creator', 'accountId', 'loginId', 'credentialId', 'loginGeneration',
        'instanceId', 'instanceGeneration', 'instanceSession'].some(key => fields[key] !== undefined))
      throw accountError(400, 'invalid-authority-claim');
    if (name === 'checkAccess' && !['read', 'write'].includes(fields.action)) throw accountError(400, 'invalid-run-action');
    if (name !== 'pending') await instanceSession.register();
    return transmit(`/internal/v2/runs/${paths[name]}`, fields, operations[name] ?? null);
  }
  return {
    admit: input => request('admit', input), confirmRead: input => request('confirmRead', input),
    queryRead: input => request('queryRead', input), checkAccess: input => request('checkAccess', input),
    finish: input => request('finish', input), runTicket: input => request('runTicket', input),
    pending: () => request('pending', {}),
    registerInstance: () => instanceSession.register(), instanceIdentity: () => instanceSession.identity(),
    dataProofFor: input => instanceSession.dataProofFor(input),
    close() { closed = true; instanceSession.close(); for (const req of active) req.destroy(); },
  };
}
