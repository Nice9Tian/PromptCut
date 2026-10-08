/** Domain-separated proof that a doc server socket is the same TLS channel
 * held by the asset client. Only the original live client channel can answer
 * the independent pinned doc-to-asset challenge. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { accountError, certificateFingerprint } from '../account/client.mjs';
import { canonicalJson } from '../account/ledger.mjs';

export const RUN_ASSET_OBSERVER_EXPORTER_LABEL = 'EXPORTER-PromptCut-RunAsset-Observer-v1';
const fail = () => { throw accountError(503, 'asset-observer-binding-unavailable'); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nonce = value => typeof value === 'string' && /^[A-Za-z0-9_-]{22,86}$/.test(value);
const context = ({ challenge, exporterDigest, epoch, recordDigest, docAuthorityId, purpose, instance }) => {
  if (!nonce(challenge) || !hash(exporterDigest) || !Number.isSafeInteger(epoch) || epoch < 1 || !hash(recordDigest) ||
      typeof docAuthorityId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(docAuthorityId) ||
      purpose !== 'run-assets-observer-verify' || !instance || typeof instance !== 'object' || Array.isArray(instance)) fail();
  return canonicalJson({ domain: 'promptcut.run-asset.observer-proof.v1', v: 1,
    docAuthorityId, purpose, epoch, recordDigest, challenge, exporterDigest, instance });
};
const material = socket => {
  if (!socket?.encrypted || socket.authorized !== true || socket.destroyed ||
      typeof socket.exportKeyingMaterial !== 'function') fail();
  try {
    const bytes = socket.exportKeyingMaterial(32, RUN_ASSET_OBSERVER_EXPORTER_LABEL);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) fail();
    return bytes;
  } catch { fail(); }
};
export const assetObserverExporterDigest = socket => createHash('sha256').update(material(socket)).digest('hex');
const mac = (socket, input) => {
  const secret = material(socket);
  if (createHash('sha256').update(secret).digest('hex') !== input?.exporterDigest) fail();
  return createHmac('sha256', secret).update(context(input)).digest();
};

/** Testable primitive; neither exporter material nor nonce is logged. */
export function proveAssetObserverSocket(socket, input) { return mac(socket, input).toString('hex'); }
export function verifyAssetObserverSocket(socket, input, proof) {
  if (!hash(proof)) fail();
  if (!timingSafeEqual(mac(socket, input), Buffer.from(proof, 'hex'))) fail();
  return true;
}

/** Asset-side active client channels. Registration requires successful
 * secureConnect + exact pinned doc certificate; close/closing drops first. */
export function createAssetObserverChannels({ docFingerprint256 } = {}) {
  const pin = certificateFingerprint(docFingerprint256);
  if (!hash(pin)) fail();
  const active = new Map(); let closed = false;
  function register(socket) {
    if (closed || !socket?.authorized || socket.destroyed ||
        certificateFingerprint(socket.getPeerCertificate?.()?.fingerprint256) !== pin) fail();
    const digest = assetObserverExporterDigest(socket);
    if (active.has(digest)) fail();
    const onClose = () => unregister(socket);
    active.set(digest, { socket, onClose });
    for (const event of ['end', 'error', 'close']) socket.once(event, onClose);
    return Object.freeze({ exporterDigest: digest, unregister: () => unregister(socket) });
  }
  function unregister(socket) {
    for (const [digest, entry] of active) if (entry.socket === socket) {
      active.delete(digest);
      for (const event of ['end', 'error', 'close']) socket.removeListener(event, entry.onClose);
    }
  }
  function prove(input) {
    if (closed || !hash(input?.exporterDigest)) fail();
    const entry = active.get(input.exporterDigest);
    if (!entry || entry.socket.destroyed || assetObserverExporterDigest(entry.socket) !== input.exporterDigest) fail();
    return proveAssetObserverSocket(entry.socket, input);
  }
  return Object.freeze({ register, unregister, prove, get size() { return active.size; },
    close() { closed = true; for (const entry of active.values()) unregister(entry.socket); } });
}
