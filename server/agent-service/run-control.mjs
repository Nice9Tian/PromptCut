import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { certificateFingerprint, accountError } from '../account/client.mjs';
import { TERMINAL_CONTROL_PATH, terminalControlPayload, validateTerminalControl, instanceTlsBinding } from '../account/agent-instance-authority.mjs';

const fail = (status, code) => { throw accountError(status, code); };
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function read(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) fail(413, 'control-body-too-large'); chunks.push(chunk); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'control-invalid'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'control-invalid');
  return body;
}

/** Doc-pinned internal Agent control receiver. Completion is generated only after
 * manager.drainControl has awaited the actual runner and all tracked resources.
 * An unobserved older instance, child or data socket leaves the control pending.
 */
export function createRunControlServer({ tls, docFingerprint256, serviceKid, instanceId,
  instanceGeneration, instanceSession, manager, now = Date.now } = {}) {
  const pin = certificateFingerprint(docFingerprint256);
  if (!tls?.key || !tls?.cert || !tls?.ca || !/^[a-f0-9]{64}$/.test(pin) ||
      typeof serviceKid !== 'string' || !serviceKid || typeof instanceId !== 'string' || !instanceId ||
      typeof manager?.drainControl !== 'function') fail(503, 'control-configuration');
  const inFlight = new Map();
  return https.createServer({ key: tls.key, cert: tls.cert, ca: tls.ca, requestCert: true,
    rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    try {
      const peer = req.socket?.getPeerCertificate?.();
      if (req.socket?.authorized !== true || certificateFingerprint(peer?.fingerprint256) !== pin) fail(403, 'control-service-forbidden');
      if (!['/internal/v2/agent/control', TERMINAL_CONTROL_PATH].includes(req.url) || req.method !== 'POST') fail(404, 'control-no-route');
      const body = await read(req);
      if (req.url === TERMINAL_CONTROL_PATH) {
        if (Object.keys(body).length !== 2 || !Object.hasOwn(body, 'control') || !Object.hasOwn(body, 'nonce')) fail(400, 'terminal-control-invalid');
        const control = body.control, identity = instanceSession?.identity?.();
        validateTerminalControl(control);
        if (typeof body.nonce !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(body.nonce)) fail(400, 'terminal-control-invalid');
        if (!identity || typeof manager.prepareTerminalClosure !== 'function' ||
            typeof instanceSession.terminalControlProofFor !== 'function') fail(503, 'terminal-control-unavailable');
        if (identity.instanceId !== instanceId || identity.instanceGeneration !== instanceGeneration || identity.serviceKid !== serviceKid ||
            ['authorityId', 'serviceId', 'serviceKid', 'instanceId', 'instanceGeneration'].some(k => control?.target?.[k] !== identity[k]) ||
            control?.kind !== 'terminal') fail(403, 'control-binding-mismatch');
        // Normal terminal drain NEVER invokes the cancelling drainControl path.
        // Manager must retain the immutable actual-event/result/resource tuple.
        const drain = await manager.prepareTerminalClosure(structuredClone(control));
        terminalControlPayload({ control, nonce: body.nonce, drain, channelBinding: instanceTlsBinding(req.socket) });
        const proof = instanceSession.terminalControlProofFor({ socket: req.socket, control, nonce: body.nonce, drain });
        send(res, 200, { ok: true, result: { drain, proof } }); return;
      }
      if (body.receipt !== undefined || body.complete !== undefined || body.servicePrincipal !== undefined ||
        body.targetInstanceId !== instanceId || body.targetServiceKid !== serviceKid) fail(403, 'control-binding-mismatch');
      const control = body.control;
      if (typeof control?.controlId !== 'string' || !control.controlId ||
        !Number.isSafeInteger(control.fenceRevision) || control.fenceRevision < 1 ||
        !Array.isArray(control.operationFences)) fail(400, 'control-invalid');
      const scope = `${control.controlId}:${control.fenceRevision}`;
      if (!inFlight.has(scope)) inFlight.set(scope, (async () => {
        const evidence = await manager.drainControl(control);
        const required = [...new Set(control.operationFences.flatMap(row => row.runIds ?? []))];
        if (evidence?.instanceId !== instanceId || evidence.serviceKid !== serviceKid ||
          !Array.isArray(evidence.closedRunIds) || required.some(id => !evidence.closedRunIds.includes(id)) ||
          evidence.dispatchesOpen !== 0 || evidence.connectionsOpen !== 0 || evidence.childrenOpen !== 0 ||
          evidence.oldInstanceUnknown === true) fail(503, 'control-pending');
        return { controlId: control.controlId, fenceRevision: control.fenceRevision,
          receiptId: `agent-close:${randomUUID()}`, complete: true, serviceKid, instanceId,
          closedRunIds: evidence.closedRunIds, closedAt: now(),
          dispatchesOpen: 0, connectionsOpen: 0, childrenOpen: 0 };
      })());
      let receipt;
      try { receipt = await inFlight.get(scope); }
      catch (error) { inFlight.delete(scope); throw error; }
      send(res, 200, { ok: true, result: receipt });
    } catch (error) { send(res, error?.status ?? 503, { ok: false, code: error?.code ?? 'control-unavailable' }); }
  });
}
