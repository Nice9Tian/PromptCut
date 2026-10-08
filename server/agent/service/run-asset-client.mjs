import { RUN_ASSET_DATA_ROOT, validateAssetRef, resourceRevision, reference } from '../../account/run-asset-protocol.mjs';
import { accountError } from '../../account/client.mjs';

/** Thin consumer of the trusted worker facade. It owns neither RAM key nor
 * raw ticket and cannot construct an arbitrary instance signing invocation. */
export function createRunAssetClient({ transport, maxResponseBytes } = {}) {
  if (!['issue', 'request'].every(k => typeof transport?.[k] === 'function') ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw accountError(503, 'run-asset-transport-unconfigured');
  const issued = new WeakSet();
  const issue = async (context, purpose, selector, requestId) => {
    const result = await transport.issue({ context, purpose, selector, requestId });
    const resource = validateAssetRef(result?.resource);
    if (!reference(result.assetHandleId) || resource.projectId !== context.projectId || result.resourceRev !== resourceRevision(resource))
      throw accountError(503, 'run-asset-response-invalid');
    const value = Object.freeze({ ...result, resource }); issued.add(value); return value;
  };
  async function request(context, handle, { method, suffix = '', verify = false, requestId, ...options }) {
    if (!issued.has(handle) || handle.resource.projectId !== context.projectId) throw accountError(403, 'run-asset-handle-untrusted');
    const result = await transport.request({ context, assetHandleId: handle.assetHandleId, method,
      url: verify ? `${RUN_ASSET_DATA_ROOT}refs/verify` : `${RUN_ASSET_DATA_ROOT}media/${handle.resource.hash}${suffix}`,
      requestId, ...options });
    if (!result?.stream || typeof result.stream.destroy !== 'function' || !result.closed?.then ||
        !Number.isInteger(result.status)) throw accountError(503, 'run-asset-response-invalid');
    return result;
  }
  async function json(context, handle, options, track) {
    const result = await request(context, handle, options); await track(result.stream);
    const pieces = []; let size = 0;
    try { for await (const piece of result.stream) { size += piece.length;
      if (size > maxResponseBytes) throw accountError(503, 'run-asset-response-invalid'); pieces.push(piece); }
      await result.closed;
      let value; try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(pieces))); }
      catch { throw accountError(503, 'run-asset-response-invalid'); }
      if (result.status >= 400 || value?.ok !== true) throw accountError(result.status, value?.code ?? 'run-asset-response-invalid');
      return value.result;
    } finally { result.stream.destroy(); }
  }
  return { issue, request, json };
}
