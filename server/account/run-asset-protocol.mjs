import { createHash } from 'node:crypto';
import { digestOf } from './ledger.mjs';
import { accountError } from './client.mjs';

export const RUN_ASSET_ROOT = '/internal/v2/run-assets/';
export const RUN_ASSET_DATA_ROOT = '/internal/v2/asset/run/';
export const RUN_ASSET_PROOF_HEADER = 'x-promptcut-run-asset-proof';
export const RUN_ASSET_OPERATION = 'checkAccess';
export const failRunAsset = (status, code) => { throw accountError(status, code); };
export const reference = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
export const hashOf = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const bytesDigest = bytes => createHash('sha256').update(bytes).digest('hex');
export const ticketDigest = ticket => bytesDigest(Buffer.from(ticket, 'utf8'));
export function exactShape(value, required, optional = []) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
const size = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value);
export function validateAssetRef(ref) {
  if (!exactShape(ref, ['projectId', 'ns', 'hash', 'size', 'contentType'], ['ext']) ||
      !reference(ref.projectId) || ref.ns !== 'media' || !hashOf(ref.hash) || !size(ref.size) ||
      !text(ref.contentType) || (ref.ext !== undefined && !/^[a-z0-9]{1,16}$/.test(ref.ext)))
    failRunAsset(400, 'resource-invalid');
  return structuredClone(ref);
}
export const resourceRevision = ref => digestOf({ v: 1, ...validateAssetRef(ref) });
export const assetRefId = ref => `asset:${resourceRevision(ref)}`;
export function validateIssue(body) {
  if (!exactShape(body, ['projectId', 'runGrantId', 'action', 'requestId', 'purpose', 'selector']) ||
      ![body.projectId, body.runGrantId, body.requestId].every(reference) ||
      !['openRead', 'import', 'verifyRef'].includes(body.purpose) ||
      body.action !== (body.purpose === 'import' ? 'write' : 'read')) failRunAsset(400, 'run-asset-body-invalid');
  const s = body.selector;
  if (body.purpose === 'openRead') {
    if (!exactShape(s, ['mediaId', 'tier']) || !reference(s.mediaId) || !['original', 'small'].includes(s.tier))
      failRunAsset(400, 'resource-invalid');
  } else {
    const fields = body.purpose === 'import' ? ['hash', 'size', 'ext', 'name', 'kind', 'importId'] : ['hash', 'size'];
    if (!exactShape(s, fields) || !hashOf(s.hash) || !size(s.size) || (body.purpose === 'import' &&
        (!/^[a-z0-9]{1,16}$/.test(s.ext) || !text(s.name) || !['image', 'audio', 'video'].includes(s.kind) || !reference(s.importId))))
      failRunAsset(400, 'resource-invalid');
  }
  return structuredClone(body);
}

/** Preserve all actual wire bytes: fatal UTF8, no BOM stripping/replacement,
 * no reserialization fallback. A valid parsed descriptor alone is not a proof. */
export function decodeRunAssetBody(bytes) {
  let bodyText, body;
  try { bodyText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); body = JSON.parse(bodyText); }
  catch { failRunAsset(400, 'run-asset-body-invalid'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) failRunAsset(400, 'run-asset-body-invalid');
  return { body, bodyText };
}
export function runAssetIssueRequest({ body, bodyText } = {}) {
  if (typeof bodyText !== 'string' || Buffer.from(bodyText, 'utf8').toString('utf8') !== bodyText)
    failRunAsset(400, 'run-asset-body-invalid');
  const actual = decodeRunAssetBody(Buffer.from(bodyText, 'utf8'));
  const checked = validateIssue(body);
  if (digestOf(actual.body) !== digestOf(checked)) failRunAsset(400, 'run-asset-body-invalid');
  return { v: 1, purpose: 'run-asset-issue', projectId: checked.projectId, runGrantId: checked.runGrantId,
    action: checked.action, body: checked, bodyText, bodyDigest: bytesDigest(Buffer.from(bodyText, 'utf8')) };
}

/** Signing input only. The asset role must supply these values from the ACTUAL
 * request/socket/spool; a public client-supplied tuple is never trusted input. */
export function assetHttpTuple(input) {
  const result = { v: 1, purpose: 'run-asset-http', projectId: input.projectId,
    runGrantId: input.runGrantId, action: input.action, ticketDigest: input.ticketDigest,
    resourceRev: input.resourceRev, nonce: input.nonce, requestId: input.requestId,
    method: input.method, url: input.url, range: input.range ?? null,
    contentLength: input.contentLength, contentDigest: input.contentDigest,
    contentType: input.contentType ?? null,
    ...(input.importId !== undefined ? { importId: input.importId } : {}),
    ...(input.chunkIndex !== undefined ? { chunkIndex: input.chunkIndex } : {}) };
  validateAssetHttpTuple(result); return result;
}
export function validateAssetHttpTuple(value) {
  if (!exactShape(value, ['v', 'purpose', 'projectId', 'runGrantId', 'action', 'ticketDigest',
    'resourceRev', 'nonce', 'requestId', 'method', 'url', 'range', 'contentLength', 'contentDigest', 'contentType'],
    ['importId', 'chunkIndex']) || value.v !== 1 || value.purpose !== 'run-asset-http' ||
      ![value.projectId, value.runGrantId, value.nonce, value.requestId].every(reference) ||
      !['read', 'write'].includes(value.action) || ![value.ticketDigest, value.resourceRev, value.contentDigest].every(hashOf) ||
      !size(value.contentLength) || !(value.range === null || text(value.range)) ||
      !(value.contentType === null || text(value.contentType)) ||
      (value.importId !== undefined && !reference(value.importId)) ||
      (value.chunkIndex !== undefined && !size(value.chunkIndex))) failRunAsset(400, 'run-asset-body-invalid');
  if (typeof value.url !== 'string' || value.url.length > 1024 || !value.url.startsWith('/') || value.url.startsWith('//'))
    failRunAsset(400, 'resource-invalid');
  const u = new URL(value.url, 'https://asset.invalid');
  if (u.search || u.hash || u.pathname !== value.url) failRunAsset(400, 'resource-invalid');
  const match = /^\/internal\/v2\/asset\/run\/media\/([a-f0-9]{64})(?:\/(chunks|complete|0|[1-9][0-9]*))?$/.exec(u.pathname);
  const verify = u.pathname === `${RUN_ASSET_DATA_ROOT}refs/verify`;
  if (!match && !verify) failRunAsset(403, 'resource-scope-mismatch');
  const suffix = match?.[2];
  const expected = verify ? 'POST' : suffix === 'complete' ? 'POST' :
    suffix && suffix !== 'chunks' ? 'PUT' : null;
  if ((expected ? value.method !== expected : !['GET', 'HEAD'].includes(value.method)) ||
      value.action !== (expected && !verify ? 'write' : 'read') ||
      (value.range !== null && (value.method !== 'GET' || !match || suffix))) failRunAsset(403, 'resource-scope-mismatch');
  if (['GET', 'HEAD'].includes(value.method) && (value.contentLength !== 0 || value.contentDigest !== bytesDigest(Buffer.alloc(0))))
    failRunAsset(400, 'run-asset-body-invalid');
  if (value.method === 'PUT' && (value.chunkIndex !== Number(suffix) || !Number.isSafeInteger(Number(suffix))))
    failRunAsset(400, 'resource-invalid');
  return { hash: match?.[1] ?? null, operation: verify ? 'verifyRef' :
    suffix === 'complete' ? 'complete' : value.method === 'PUT' ? 'chunk' : suffix === 'chunks' ? 'chunks' : 'openRead' };
}
export function requestProof(value) {
  if (!exactShape(value, ['instanceId', 'instanceGeneration', 'signature']) || !reference(value.instanceId) ||
      !Number.isSafeInteger(value.instanceGeneration) || value.instanceGeneration < 1 ||
      typeof value.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value.signature)) failRunAsset(400, 'instance-proof-invalid');
  return structuredClone(value);
}
