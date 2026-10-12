/** Asset-private, doc-cert-only read endpoints. They do not call either
 * revocation consumer's sync, avoiding a doc ledger/coordinator lock cycle. */
import { X509Certificate } from 'node:crypto';
import { accountError, certificateFingerprint } from '../account/client.mjs';
import { hashOf, reference } from '../account/run-asset-protocol.mjs';
import { createRunAssetMetadata } from './run-assets-metadata.mjs';

const fail = (status, code) => { throw accountError(status, code); };
const respond = (res, status, value) => {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(status === 200 ? { ok: true, result: value } : { ok: false, code: value }));
};
const one = (params, name) => params.getAll(name).length === 1 ? params.get(name) : null;
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',');
async function smallBody(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length; if (length > 4096) fail(413, 'run-asset-observer-invalid'); chunks.push(chunk);
  }
  if (req.aborted || req.complete === false) fail(400, 'run-asset-observer-invalid');
  try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { fail(400, 'run-asset-observer-invalid'); }
}

export function createRunAssetMetadataRpc({ docFingerprint256, internalServerCert, lifecycle, projectStores,
  consumer, isOpen = () => true, rootReservation = null, observerChannels = null } = {}) {
  const docPin = certificateFingerprint(docFingerprint256);
  const serverPin = internalServerCert ? certificateFingerprint(new X509Certificate(internalServerCert).fingerprint256) : null;
  if (!hashOf(docPin) || !hashOf(serverPin) || typeof isOpen !== 'function' ||
      lifecycle?.state?.serviceId !== 'asset' || lifecycle.state.state !== 'running' ||
      !reference(lifecycle.state.serviceIdentity) || !reference(lifecycle.state.instanceId) ||
      !hashOf(lifecycle.state.fingerprint256)) fail(503, 'run-asset-metadata-unconfigured');
  const metadata = createRunAssetMetadata({ projectStores });
  if (rootReservation && (!reference(rootReservation.instanceId) || rootReservation.instanceId !== lifecycle.state.instanceId ||
      typeof observerChannels?.prove !== 'function')) fail(503, 'run-asset-observer-unconfigured');
  const identity = () => {
    if (isOpen() !== true) fail(503, 'asset-unavailable');
    const state = lifecycle.state;
    return { v: 1, serviceId: 'asset',
      ...(rootReservation ? { authorityId: rootReservation.authorityId, epoch: rootReservation.epoch } : {}),
      serviceIdentity: state.serviceIdentity,
      instanceId: state.instanceId, pid: state.pid, startedAt: state.startedAt,
      docClientFingerprint256: state.fingerprint256, internalServerFingerprint256: serverPin, state: 'running' };
  };
  async function handler(req, res) {
    const raw = req.url ?? '';
    if (!raw.startsWith('/internal/v2/asset/run/')) return false;
    try {
      if (raw.length > 2048 || req.headers.cookie || req.headers.authorization)
        fail(400, 'run-asset-metadata-invalid');
      if (req.socket?.authorized !== true || req.socket.destroyed ||
          certificateFingerprint(req.socket.getPeerCertificate?.()?.fingerprint256) !== docPin)
        fail(403, 'service-forbidden');
      const url = new URL(raw, 'https://asset.invalid');
      const current = identity();
      if (url.pathname === '/internal/v2/asset/run/observer/verify' && !url.search) {
        if (req.method !== 'POST' || !rootReservation || !observerChannels) fail(503, 'run-asset-observer-unavailable');
        const input = await smallBody(req);
        if (!exact(input, ['challenge', 'exporterDigest', 'epoch', 'recordDigest', 'docAuthorityId', 'purpose', 'instance']) ||
            input.docAuthorityId !== rootReservation.authorityId || input.epoch !== rootReservation.epoch ||
            input.instance?.instanceId !== rootReservation.instanceId ||
            input.instance?.serviceIdentity !== rootReservation.serviceIdentity) fail(403, 'run-asset-observer-forbidden');
        const proof = observerChannels.prove(input);
        identity(); respond(res, 200, { identity: current, proof }); return true;
      }
      if (req.method !== 'GET') fail(400, 'run-asset-metadata-invalid');
      if (url.pathname === '/internal/v2/asset/run/identity' && !url.search) {
        respond(res, 200, current); return true;
      }
      if (url.pathname === '/internal/v2/asset/run/metadata') {
        if ([...url.searchParams.keys()].sort().join(',') !== 'hash,mediaId,projectId,tier' ||
            [...url.searchParams.values()].some(value => value.length > 256)) fail(400, 'run-asset-metadata-invalid');
        const projectId = one(url.searchParams, 'projectId'), hash = one(url.searchParams, 'hash');
        const tier = one(url.searchParams, 'tier'), mediaId = one(url.searchParams, 'mediaId');
        const result = await metadata.resolveTierAssetRef({ projectId, hash, tier, mediaId });
        identity(); respond(res, 200, { ...result, assetInstanceId: current.instanceId }); return true;
      }
      const lease = /^\/internal\/v2\/asset\/run\/leases\/([^/]+)\/closure$/.exec(url.pathname);
      const event = /^\/internal\/v2\/asset\/run\/events\/([^/]+)\/closure$/.exec(url.pathname);
      if ((lease || event) && !url.search) {
        const id = decodeURIComponent((lease ?? event)[1]);
        if (!reference(id) || id.length > 256 || typeof (lease ? consumer?.closureWitness : consumer?.controlWitness) !== 'function')
          fail(503, 'asset-run-resource-closure-pending');
        const witness = lease ? consumer.closureWitness(id) : consumer.controlWitness(id);
        identity();
        if (witness?.assetInstanceId !== current.instanceId || witness.serviceIdentity !== current.serviceIdentity)
          fail(503, 'asset-run-resource-closure-pending');
        respond(res, 200, witness); return true;
      }
      fail(404, 'no-route');
    } catch (error) {
      respond(res, error.status ?? 503, error.code ?? 'asset-run-metadata-unavailable');
    }
    return true;
  }
  return Object.freeze({ identity, resolveTierAssetRef: metadata.resolveTierAssetRef, handler });
}
