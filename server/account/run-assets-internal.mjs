import https from 'node:https';
import { certificateFingerprint } from './client.mjs';
import { instanceTlsBinding } from './agent-instance-authority.mjs';
import { assertInstanceDirectTransport, instanceRequestProof } from './agent-instance-internal.mjs';
import { RUN_ASSET_ROOT, exactShape, requestProof, reference, decodeRunAssetBody, failRunAsset as fail } from './run-asset-protocol.mjs';

function respond(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req, maximum) {
  const declared = req.headers?.['content-length'];
  if (declared !== undefined && (!/^(0|[1-9][0-9]*)$/.test(declared) || !Number.isSafeInteger(Number(declared))))
    fail(400, 'run-asset-body-invalid');
  if (Number(declared) > maximum) fail(413, 'run-asset-body-too-large');
  const chunks = []; let size = 0;
  try { for await (const chunk of req) { size += chunk.length;
    if (size > maximum) fail(413, 'run-asset-body-too-large'); chunks.push(chunk); } }
  catch (error) { if (error.status) throw error; fail(400, 'run-asset-body-incomplete'); }
  if (req.aborted || req.complete === false || (declared !== undefined && Number(declared) !== size))
    fail(400, 'run-asset-body-incomplete');
  return decodeRunAssetBody(Buffer.concat(chunks));
}

/** Dedicated mTLS routes. No forwarded header/loopback exemption; pins precede
 * body parsing. resolveObserver must force the CURRENT asset registry and return
 * its trusted startup identity. It cannot take the identity from observation. */
export function createRunAssetsInternalHandler({ runAssets, agentFingerprint256, assetFingerprint256,
  resolveObserver, maxBodyBytes } = {}) {
  const agentPin = certificateFingerprint(agentFingerprint256), assetPin = certificateFingerprint(assetFingerprint256);
  if (![agentPin, assetPin].every(pin => /^[a-f0-9]{64}$/.test(pin)) || agentPin === assetPin ||
      typeof resolveObserver !== 'function' || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 ||
      !['issue', 'check', 'closeLease', 'eventsSince', 'acknowledgeEvent'].every(k => typeof runAssets?.[k] === 'function'))
    fail(503, 'run-assets-internal-unconfigured');
  return async function handle(req, res) {
    let url;
    try { url = new URL(req.url ?? '/', 'https://internal.invalid'); }
    catch { respond(res, 400, { ok: false, code: 'run-asset-body-invalid' }); return true; }
    if (!url.pathname.startsWith(RUN_ASSET_ROOT)) return false;
    try {
      assertInstanceDirectTransport(req);
      instanceTlsBinding(req.socket); // Real authorized/non-destroyed TLS exporter, not a forwarded string.
      const route = url.pathname.slice(RUN_ASSET_ROOT.length);
      const peer = certificateFingerprint(req.socket.getPeerCertificate?.()?.fingerprint256);
      if (peer !== (route === 'issue' ? agentPin : assetPin)) fail(403, 'service-forbidden');
      const expectedMethod = route === 'events' ? 'GET' : 'POST';
      if (req.method !== expectedMethod) fail(405, 'method-not-allowed');
      if (route !== 'events' && url.search) fail(400, 'run-asset-body-invalid');
      let result;
      if (route === 'issue') {
        result = await runAssets.issue({ ...await readBody(req, maxBodyBytes), transport: req,
          proof: instanceRequestProof(req) });
      } else {
        const identity = await resolveObserver({ socket: req.socket, fingerprint256: peer });
        if (!exactShape(identity, ['assetInstanceId', 'serviceIdentity']) ||
            ![identity.assetInstanceId, identity.serviceIdentity].every(reference)) fail(403, 'asset-observer-forbidden');
        const observer = { ...identity, socket: req.socket };
        if (route === 'events') {
          if (url.searchParams.size !== 1 || !url.searchParams.has('after') ||
              !/^(0|[1-9][0-9]*)$/.test(url.searchParams.get('after'))) fail(400, 'run-asset-cursor-invalid');
          // Registry was force-checked on this actual socket even for metadata.
          result = await runAssets.eventsSince(Number(url.searchParams.get('after')));
        } else {
          const leaseRoute = /^leases\/([A-Za-z0-9_.:-]{1,128})\/(check|closed)$/.exec(route);
          const ackRoute = /^events\/([A-Za-z0-9_.:-]{1,128})\/ack$/.exec(route);
          if (route !== 'check' && !leaseRoute && !ackRoute) fail(404, 'no-route');
          const { body } = await readBody(req, maxBodyBytes);
          if (route === 'check' || leaseRoute?.[2] === 'check') {
            if (!exactShape(body, ['ticket', 'request', 'proof', 'observation'])) fail(400, 'run-asset-body-invalid');
            requestProof(body.proof);
            result = await runAssets.check({ ...body, observer, ...(leaseRoute ? { leaseId: leaseRoute[1] } : {}) });
          } else {
            if (!exactShape(body, ['receipt'])) fail(400, 'run-asset-body-invalid');
            result = leaseRoute ? await runAssets.closeLease({ leaseId: leaseRoute[1], observer, receipt: body.receipt }) :
              await runAssets.acknowledgeEvent({ eventId: ackRoute[1], observer, receipt: body.receipt });
          }
        }
      }
      respond(res, 200, { ok: true, result });
    } catch (error) { respond(res, error.status ?? 503, { ok: false, code: error.code ?? 'run-assets-unavailable' }); }
    return true;
  };
}
export function createRunAssetsInternalServer({ tls, ...options } = {}) {
  if (!tls?.key || !tls?.cert || !tls?.ca) fail(503, 'run-assets-internal-unconfigured');
  const handle = createRunAssetsInternalHandler(options);
  return https.createServer({ key: tls.key, cert: tls.cert, ca: tls.ca, requestCert: true,
    rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    if (!await handle(req, res)) respond(res, 404, { ok: false, code: 'no-route' });
  });
}
