import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { certificateFingerprint, accountError } from '../account/client.mjs';
import { createAgentInstanceSession } from '../agent/service/agent-instance-session.mjs';
import { runAssetIssueRequest } from '../account/run-asset-protocol.mjs';

const paths = Object.freeze({ admit: 'admit', confirmRead: 'read', queryRead: 'read/query',
  checkAccess: 'check', finish: 'finish', runTicket: 'ticket', pending: 'pending' });
const operations = Object.freeze({ admit: 'admit', confirmRead: 'confirmRead', queryRead: 'queryRead',
  checkAccess: 'checkAccess', finish: 'finish', runTicket: 'resolveRunPrincipal' });
const fail = code => { throw accountError(503, code); };

/** Agent-owned mTLS transport. Doc derives the service principal from the pinned
 * client certificate; no caller can supply servicePrincipal or a human identity.
 */
export function createRunClient({ origin, tls, serverFingerprint256, timeoutMs = 5000, scopePrepareSource = null,
  registrationPurpose = null, workerEventSource = null } = {}) {
  let base;
  try { base = new URL(origin); } catch { fail('run-client-configuration'); }
  const pin = certificateFingerprint(serverFingerprint256);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
    !tls?.key || !tls?.cert || !tls?.ca || !/^[a-f0-9]{64}$/.test(pin) || !Number.isInteger(timeoutMs) || timeoutMs < 1)
    fail('run-client-configuration');
  const active = new Set(), sockets = new Set(); let closed = false, closing = null;
  /** Every call opens its own real TLS socket. The signature is constructed only
   * after secureConnect, then the exact body is sent, and completion waits for
   * the transport close. No HTTP capability is reused on a later request. */
  function transmit(path, fields, operation = null,
    { bodyText = null, runAssetIssue = false, registerResource = null } = {}) {
    if (closed) return Promise.reject(accountError(503, 'run-client-unavailable'));
    const encoded = Buffer.from(bodyText ?? JSON.stringify(fields), 'utf8');
    if (encoded.length > 1024 * 1024) return Promise.reject(accountError(413, 'run-body-too-large'));
    return new Promise((resolve, reject) => {
      let settled = false, responseReady = false, socket = null, socketClosed = false, requestClosed = false;
      let responseSeen = false, responseClosed = false;
      let responseError = null, responseValue;
      const finish = () => {
        if (settled || !responseReady || !(socket ? socketClosed : requestClosed) ||
            (runAssetIssue && responseSeen && !responseClosed)) return;
        settled = true; responseError ? reject(responseError) : resolve(responseValue);
      };
      const abort = error => { if (responseReady) return; responseError = error; responseReady = true; req.destroy(); finish(); };
      const req = https.request(new URL(path, base), { method: 'POST', agent: false, key: tls.key, cert: tls.cert,
        ca: tls.ca, rejectUnauthorized: true, minVersion: 'TLSv1.3', timeout: timeoutMs,
        checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) ||
          (certificateFingerprint(cert.fingerprint256) !== pin ? accountError(503, 'run-server-certificate') : undefined); },
        headers: { 'content-type': 'application/json', 'content-length': encoded.length, connection: 'close' } }, res => {
        responseSeen = true;
        res.once('close', () => { responseClosed = true; finish(); });
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
        sockets.add(current);
        current.once('close', () => { sockets.delete(current); socketClosed = true; finish(); });
        const registrations = registerResource ? Promise.all([
          registerResource('stream', req), registerResource('socket', current),
        ]) : Promise.resolve([]);
        registrations.catch(abort);
        current.once('secureConnect', async () => {
          try {
            await registrations;
            if (operation || runAssetIssue) {
              const proof = runAssetIssue
                ? instanceSession.runAssetIssueProofFor({ socket: current, body: fields, bodyText })
                : instanceSession.proofFor({ socket: current, method: 'POST', path, operation, body: fields });
              req.setHeader(proof.name, proof.value);
            }
            req.end(encoded);
          } catch (error) { abort(error); }
        });
      });
    });
  }
  let scopedRegistration = false;
  const instanceSession = createAgentInstanceSession({ scopePrepareSource, registrationPurpose, workerEventSource, requestRegistration: (name, body) =>
    transmit(`/internal/v2/instances/${name}`, body) });
  async function request(name, fields) {
    if (closed || !paths[name]) throw accountError(503, 'run-client-unavailable');
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) ||
      ['servicePrincipal', 'serviceId', 'serviceKid', 'principal', 'creator', 'accountId', 'loginId', 'credentialId', 'loginGeneration',
        'instanceId', 'instanceGeneration', 'instanceSession'].some(key => fields[key] !== undefined))
      throw accountError(400, 'invalid-authority-claim');
    if (name === 'checkAccess' && !['read', 'write'].includes(fields.action)) throw accountError(400, 'invalid-run-action');
    if (name !== 'pending' || registrationPurpose || scopedRegistration) await instanceSession.register();
    return transmit(`/internal/v2/runs/${paths[name]}`, fields,
      name === 'pending' && instanceSession.identity()?.purpose ? 'pendingRuns' : operations[name] ?? null);
  }
  return {
    admit: input => request('admit', input), confirmRead: input => request('confirmRead', input),
    queryRead: input => request('queryRead', input), checkAccess: input => request('checkAccess', input),
    finish: input => request('finish', input), runTicket: input => request('runTicket', input),
    pending: () => request('pending', {}),
    async scopeAssignment(input) {
      const keys = ['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId', 'requestId'];
      if (!input || Array.isArray(input) || Object.keys(input).sort().join(',') !== keys.sort().join(',') ||
          Object.values(input).some(value => typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)))
        throw accountError(400, 'invalid-scope-assignment');
      if (closed) throw accountError(503, 'run-client-unavailable');
      await instanceSession.register();
      return transmit('/internal/v2/runs/assignment', input, 'scopeAssignment');
    },
    async issueRunAsset(body, { registerResource } = {}) {
      if (closed) throw accountError(503, 'run-client-unavailable');
      if (registerResource !== undefined && typeof registerResource !== 'function')
        throw accountError(503, 'run-assets-unconfigured');
      const bodyText = JSON.stringify(body);
      runAssetIssueRequest({ body, bodyText });
      await instanceSession.register();
      return transmit('/internal/v2/run-assets/issue', body, null,
        { bodyText, runAssetIssue: true, registerResource });
    },
    registerInstance: () => instanceSession.register(), instanceIdentity: () => instanceSession.identity(),
    scopeIdentity: () => instanceSession.scopeIdentity(),
    configureRegistrationScope(input) { const result = instanceSession.configureRegistrationScope(input); scopedRegistration = true; return result; },
    bindScope: input => instanceSession.bindScope(input),
    scopePrepareFor: input => instanceSession.scopePrepareFor(input),
    scopeIntentFor: input => instanceSession.scopeIntentFor(input),
    workerEventProofFor: input => instanceSession.workerEventProofFor(input),
    dataProofFor: input => instanceSession.dataProofFor(input),
    conversationControlProofFor: input => instanceSession.conversationControlProofFor(input),
    runAssetHttpProofFor: input => instanceSession.runAssetHttpProofFor(input),
    close() {
      if (closing) return closing;
      closed = true; instanceSession.close();
      const resources = new Set([...active, ...sockets]);
      closing = Promise.all([...resources].map(resource => new Promise(resolve => {
        if (resource.closed === true) return resolve();
        resource.once('close', resolve); resource.destroy();
      })));
      return closing;
    },
  };
}
