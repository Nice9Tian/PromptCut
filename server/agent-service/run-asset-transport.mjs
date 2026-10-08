import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { accountError, certificateFingerprint } from '../account/client.mjs';
import { assetHttpTuple, bytesDigest, reference, resourceRevision, runAssetIssueRequest,
  ticketDigest, validateAssetRef } from '../account/run-asset-protocol.mjs';

const fail = (status, code) => { throw accountError(status, code); };
const CONTEXT_KEYS = ['projectId', 'conversationId', 'runId', 'runGrantId', 'instanceId',
  'instanceGeneration', 'senderAccountId', 'messageId'];
const ISSUE_KEYS = ['context', 'purpose', 'selector', 'requestId'];
const REQUEST_KEYS = ['context', 'assetHandleId', 'method', 'url', 'requestId', 'range',
  'contentType', 'importId', 'chunkIndex', 'body'];
const identityKey = value => JSON.stringify(['serviceId', 'serviceKid', 'instanceId', 'instanceGeneration'].map(key => value?.[key]));
const contextKey = value => JSON.stringify(CONTEXT_KEYS.map(key => value?.[key]));
const exact = (value, required, optional = []) => value && typeof value === 'object' &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
  required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const sameAccess = (a, b) => a?.allowed === true && b?.allowed === true &&
  a.fenceRevision === b.fenceRevision && a.grantState === b.grantState;

function endpoint(origin, fingerprint) {
  let url, pin;
  try { url = new URL(origin); pin = certificateFingerprint(fingerprint); }
  catch { fail(503, 'run-assets-unconfigured'); }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash ||
      url.username || url.password || !/^[a-f0-9]{64}$/.test(pin)) fail(503, 'run-assets-unconfigured');
  return { url, pin };
}

function publicHeaders(headers) {
  const result = {};
  for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag'])
    if (typeof headers[key] === 'string') result[key] = headers[key];
  return Object.freeze(result);
}

/** Host-only transport. It holds the opaque ticket and uses the existing Agent OS RAM key. */
export function createRunAssetTransport({ runClient, assetOrigin, assetTls, assetFingerprint256,
  resources, timeoutMs = 5000 } = {}) {
  if (!runClient || !['registerInstance', 'issueRunAsset', 'runAssetHttpProofFor', 'instanceIdentity']
    .every(name => typeof runClient[name] === 'function') ||
    !resources || typeof resources.authorize !== 'function' || typeof resources.register !== 'function' ||
    !assetTls?.key || !assetTls?.cert || !assetTls?.ca ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail(503, 'run-assets-unconfigured');
  const { url: base, pin } = endpoint(assetOrigin, assetFingerprint256);
  const handles = new Map();
  const active = new Set();
  let closed = false;

  async function issue(input) {
    if (closed) fail(503, 'run-assets-unconfigured');
    if (!exact(input, ISSUE_KEYS)) fail(400, 'run-asset-body-invalid');
    const { context, purpose, selector, requestId } = input;
    if (!reference(context?.projectId) || !reference(context?.runGrantId) || !reference(requestId))
      fail(400, 'run-asset-body-invalid');
    const action = purpose === 'import' ? 'write' : 'read';
    const rawBody = { projectId: context.projectId, runGrantId: context.runGrantId,
      action, requestId, purpose, selector };
    const bodyText = JSON.stringify(rawBody);
    const descriptor = runAssetIssueRequest({ body: rawBody, bodyText });
    await runClient.registerInstance();
    const identity = runClient.instanceIdentity();
    if (identity?.instanceId !== context.instanceId || identity.instanceGeneration !== context.instanceGeneration)
      fail(403, 'instance-proof-invalid');
    const before = await resources.authorize(context, action);
    const result = await runClient.issueRunAsset(descriptor.body, { registerResource: (kind, resource) =>
      resources.register(context, { kind, resource }) });
    if (closed) fail(503, 'run-assets-unconfigured');
    const after = await resources.authorize(context, action);
    if (!sameAccess(before, after) || identityKey(identity) !== identityKey(runClient.instanceIdentity()))
      fail(403, 'run-revoked');
    if (typeof result?.ticket !== 'string' || result.ticket.length < 16 || result.ticket.length > 4096 ||
        /[\r\n\0]/.test(result.ticket) || !reference(result.ticketId) ||
        !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now() ||
        result.fenceRevision !== after.fenceRevision || result.grantState !== after.grantState)
      fail(503, 'run-asset-issue-protocol');
    const resource = Object.freeze(validateAssetRef(result.resource));
    if (resource.projectId !== context.projectId || result.resourceRev !== resourceRevision(resource) ||
        (purpose !== 'openRead' && resource.hash !== selector.hash)) fail(503, 'run-asset-issue-protocol');
    const assetHandleId = `asset_handle_${randomUUID()}`;
    handles.set(assetHandleId, { ticket: result.ticket, body: descriptor.body, resource,
      resourceRev: result.resourceRev, expiresAt: result.expiresAt,
      contextKey: contextKey(context), identityKey: identityKey(identity) });
    return Object.freeze({ assetHandleId, resource: structuredClone(resource), resourceRev: result.resourceRev,
      expiresAt: result.expiresAt, fenceRevision: result.fenceRevision,
      grantState: result.grantState });
  }

  async function request(input) {
    if (closed) fail(503, 'run-assets-unconfigured');
    if (!exact(input, REQUEST_KEYS.slice(0, 5), REQUEST_KEYS.slice(5))) fail(400, 'run-asset-body-invalid');
    const { context, assetHandleId, method, url, requestId } = input;
    if (typeof url !== 'string' || !url.startsWith('/internal/v2/asset/run/') || url.includes('?') || url.includes('#') ||
        !reference(requestId) || !reference(assetHandleId)) fail(400, 'run-asset-body-invalid');
    const held = handles.get(assetHandleId);
    if (!held || held.contextKey !== contextKey(context)) fail(403, 'resource-scope-mismatch');
    if (held.expiresAt <= Date.now()) fail(401, 'ticket-expired');
    if (identityKey(runClient.instanceIdentity()) !== held.identityKey) fail(403, 'instance-proof-invalid');
    const body = input.body === undefined ? Buffer.alloc(0) : input.body;
    if (!Buffer.isBuffer(body)) fail(400, 'run-asset-body-invalid');
    const bytes = Buffer.from(body); // The caller cannot mutate bytes after they are signed.
    const hash = held.resource.hash;
    const mediaRoot = `/internal/v2/asset/run/media/${hash}`;
    if (held.body.purpose === 'openRead') {
      if (!['GET', 'HEAD'].includes(method) || ![mediaRoot, `${mediaRoot}/chunks`].includes(url))
        fail(403, 'resource-scope-mismatch');
    } else if (held.body.purpose === 'import') {
      if (!((method === 'PUT' && /^\/internal\/v2\/asset\/run\/media\/[a-f0-9]{64}\/(?:0|[1-9][0-9]*)$/.test(url)) ||
          (method === 'POST' && url === `${mediaRoot}/complete`)) || !url.startsWith(`${mediaRoot}/`))
        fail(403, 'resource-scope-mismatch');
    } else if (method !== 'POST' || url !== '/internal/v2/asset/run/refs/verify')
      fail(403, 'resource-scope-mismatch');
    const tuple = assetHttpTuple({ projectId: context.projectId, runGrantId: context.runGrantId,
      action: held.body.action, ticketDigest: ticketDigest(held.ticket), resourceRev: held.resourceRev,
      nonce: `asset_${randomUUID()}`, requestId, method, url, range: input.range ?? null,
      contentLength: bytes.length, contentDigest: bytesDigest(bytes), contentType: input.contentType ?? null,
      ...(input.importId !== undefined ? { importId: input.importId } : {}),
      ...(input.chunkIndex !== undefined ? { chunkIndex: input.chunkIndex } : {}) });
    const before = await resources.authorize(context, held.body.action);
    if (before?.allowed !== true) fail(403, 'run-revoked');
    if (closed) fail(503, 'run-assets-unconfigured');
    if (identityKey(runClient.instanceIdentity()) !== held.identityKey) fail(403, 'instance-proof-invalid');

    let req, socket = null, source = null, output = null, readyDone = false, closeDone = false;
    let reqClosed = false, socketClosed = false, sourceClosed = false, outputClosed = false;
    let readyResolve, readyReject, closedResolve;
    const closedPromise = new Promise(resolve => { closedResolve = resolve; });
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const dispatch = { abort: () => { output?.destroy(); source?.destroy(); req?.destroy(); }, closed: closedPromise };
    active.add(dispatch);
    const closeCheck = () => {
      if (closeDone || !reqClosed || (socket && !socketClosed) || (source && !sourceClosed) ||
          (output && !outputClosed)) return;
      closeDone = true; active.delete(dispatch); closedResolve();
    };
    const abort = error => {
      if (!readyDone) { readyDone = true; closedPromise.then(() => readyReject(error)); }
      dispatch.abort(); closeCheck();
    };
    const headers = { authorization: `Bearer ${held.ticket}`, 'content-length': bytes.length,
      connection: 'close', ...(input.contentType ? { 'content-type': input.contentType } : {}),
      ...(input.range ? { range: input.range } : {}) };
    try {
      req = https.request(new URL(url, base), { method, agent: false, key: assetTls.key,
        cert: assetTls.cert, ca: assetTls.ca, rejectUnauthorized: true, minVersion: 'TLSv1.3',
        timeout: timeoutMs, headers,
        checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) ||
          (certificateFingerprint(cert.fingerprint256) !== pin ? accountError(503, 'run-asset-server-certificate') : undefined); },
      }, async res => {
        source = res; res.pause();
        res.once('close', () => { sourceClosed = true; closeCheck(); });
        res.on('error', () => abort(accountError(503, 'run-asset-unavailable')));
        output = new PassThrough();
        output.once('close', () => { outputClosed = true; closeCheck(); });
        output.once('error', () => dispatch.abort());
        try {
          await resources.register(context, { kind: 'stream', resource: res });
          await resources.register(context, { kind: 'stream', resource: output });
          const after = await resources.authorize(context, held.body.action);
          if (closed || !sameAccess(before, after) || identityKey(runClient.instanceIdentity()) !== held.identityKey)
            fail(403, 'run-revoked');
          readyDone = true;
          readyResolve({ status: res.statusCode, headers: publicHeaders(res.headers), stream: output,
            closed: closedPromise });
          try {
            for await (const chunk of res) {
              await resources.authorize(context, held.body.action);
              if (!output.write(chunk)) await once(output, 'drain');
            }
            output.end();
          } catch (error) { abort(error); }
        } catch (error) { abort(error); }
      });
      req.once('close', () => {
        reqClosed = true;
        if (!source && !readyDone) abort(accountError(503, 'run-asset-unavailable'));
        closeCheck();
      });
      req.on('error', () => abort(accountError(503, 'run-asset-unavailable')));
      req.on('timeout', () => abort(accountError(503, 'run-asset-unavailable')));
      req.on('socket', current => {
        socket = current;
        current.once('close', () => { socketClosed = true; closeCheck(); });
        const registered = Promise.all([
          resources.register(context, { kind: 'stream', resource: req }),
          resources.register(context, { kind: 'socket', resource: current }),
        ]);
        current.once('secureConnect', async () => {
          try {
            const [entry] = await registered;
            if (closed || entry.signal.aborted) fail(403, 'run-revoked');
            const currentAccess = await resources.authorize(context, held.body.action);
            if (!sameAccess(before, currentAccess) || identityKey(runClient.instanceIdentity()) !== held.identityKey)
              fail(403, 'run-revoked');
            const proof = runClient.runAssetHttpProofFor({ socket: current, tuple });
            req.setHeader(proof.name, proof.value);
            req.end(bytes);
          } catch (error) { abort(error); }
        });
        registered.catch(abort);
      });
    } catch (error) { if (!req) reqClosed = true; abort(error); }
    return ready;
  }

  async function close() {
    closed = true; handles.clear();
    const work = [...active];
    for (const dispatch of work) dispatch.abort();
    await Promise.all(work.map(dispatch => dispatch.closed));
  }

  return Object.freeze({ issue, request, close });
}
