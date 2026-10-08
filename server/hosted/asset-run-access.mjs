import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { certificateFingerprint, accountError } from '../account/client.mjs';
import { digestOf } from '../account/ledger.mjs';
import { instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { assertInstanceDirectTransport } from '../account/agent-instance-internal.mjs';
import { RUN_ASSET_DATA_ROOT, RUN_ASSET_PROOF_HEADER, assetHttpTuple, validateAssetHttpTuple,
  validateAssetRef, resourceRevision, assetRefId, bytesDigest, ticketDigest, requestProof, reference, hashOf,
  decodeRunAssetBody, exactShape } from '../account/run-asset-protocol.mjs';
import { createAssetResourceLease, authorizedAssetStore } from '../asset-store/project-access.mjs';
import { createFsStore } from '../asset-store/fs-store.mjs';
import { publishProjectFile, syncProjectDirectory } from '../asset-store/project-io.mjs';

const fail = (status, code) => { throw accountError(status, code); };
const actualClose = item => !item || item.closed ? Promise.resolve() : new Promise(resolve => item.once('close', resolve));
const relevant = (record, control) => control.retained.includes(record.runGrantId) || control.revoked.includes(record.runGrantId) ||
  (control.kind === 'instance-revoked' && control.instances.some(i => i.instanceId === record.instanceId && i.instanceGeneration === record.instanceGeneration));

/** Two logs, two receipts: this owns only run-outbox ACKs. The existing human
 * consumer remains the sole access ACK writer and waits for participant below.
 * The revalidation callback MUST be an independent doc request, not sync(). */
export function createAssetRunConsumer({ client, file, assetInstanceId, serviceIdentity, verifyLifecycle } = {}) {
  if (!file || ![assetInstanceId, serviceIdentity].every(reference) || typeof verifyLifecycle !== 'function' ||
      !['eventsSince', 'acknowledgeEvent'].every(k => typeof client?.[k] === 'function')) fail(503, 'asset-run-consumer-unconfigured');
  let state = { v: 1, assetInstanceId, serviceIdentity, cursor: 0, pending: null, leases: {} };
  let ready = false, stopped = false, chain = Promise.resolve(), writes = Promise.resolve(), head = 0;
  const live = new Map(), admissions = new Map();
  function persist() {
    const snapshot = JSON.stringify(state);
    const result = writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${crypto.randomUUID()}.tmp`, handle = await fs.open(temp, 'wx');
      try { await handle.writeFile(snapshot); await handle.sync(); } finally { await handle.close(); }
      try { await fs.rename(temp, file); await syncProjectDirectory(path.dirname(file)); }
      catch (error) { await fs.rm(temp, { force: true }); throw error; }
    });
    writes = result; return result;
  }
  function pause(event) {
    const seen = new Set(), results = [];
    const launch = () => { for (const [id, entry] of live) if (!seen.has(id) && (!event.control || relevant(state.leases[id], event.control))) {
      seen.add(id); results.push(Promise.resolve(entry.lease.revoke(event)).then(async result => {
        if (entry.lease.signal.aborted) await entry.closed; return result;
      }));
    } };
    launch(); // synchronous barrier before pending admissions/authority awaits
    return (async () => {
      const cohort = [...admissions.values()]; await Promise.all(cohort.map(a => a.done));
      launch(); await Promise.all(results);
    })();
  }
  async function acknowledgePending() {
    if (!state.pending) return;
    await persist(); await client.acknowledgeEvent(state.pending.eventId, state.pending.receipt);
    state.cursor = state.pending.receipt.cursor; state.pending = null; await persist();
  }
  async function drain() {
    ready = false;
    if (stopped || await verifyLifecycle({ state: structuredClone(state) }) !== true) fail(503, 'asset-run-recovery-pending');
    if (Object.values(state.leases).some(l => l.state === 'unknown')) fail(503, 'asset-run-recovery-pending');
    await acknowledgePending();
    for (;;) {
      const page = await client.eventsSince(state.cursor); head = page?.headSeq;
      if (!Number.isSafeInteger(head) || head < state.cursor || !Array.isArray(page.events)) fail(503, 'asset-run-event-gap');
      if (!page.events.length) { if (head !== state.cursor) fail(503, 'asset-run-event-gap'); ready = true; return head; }
      for (const event of page.events) {
        if (event.v !== 1 || event.seq !== state.cursor + 1 || event.eventId !== `run-asset:${event.controlId}` ||
            !hashOf(event.payloadDigest) || !Array.isArray(event.control?.retained) || !Array.isArray(event.control.revoked) ||
            !Array.isArray(event.control.instances) || !Number.isSafeInteger(event.control.fenceRevision)) fail(503, 'asset-run-event-gap');
        await pause(event); // synchronous pause precedes any callback await
        const affected = Object.values(state.leases).filter(l => relevant(l, event.control));
        const retained = [], closed = [];
        for (const l of affected) {
          if (l.state === 'closed') closed.push(l.leaseId);
          else if (event.control.retained.includes(l.runGrantId) && live.get(l.leaseId)?.last?.grantState === 'retained' &&
              live.get(l.leaseId).last.fenceRevision >= event.control.fenceRevision && live.get(l.leaseId).last.runAssetHead >= event.seq)
            retained.push(l.leaseId);
          else fail(503, 'asset-run-resource-closure-pending');
        }
        const receipt = { receiptId: crypto.randomUUID(), eventId: event.eventId, cursor: event.seq,
          controlId: event.controlId, fenceRevision: event.control.fenceRevision, complete: true, assetInstanceId,
          closedLeaseIds: closed.sort(), retainedLeaseIds: retained.sort(),
          evidenceDigest: digestOf({ eventId: event.eventId, affected: affected.map(l => ({ ...l })).sort((a, b) => a.leaseId.localeCompare(b.leaseId)) }) };
        state.pending = { eventId: event.eventId, receipt }; await persist(); await acknowledgePending();
      }
    }
  }
  function sync() {
    const result = chain.catch(() => {}).then(drain); chain = result;
    return result.catch(error => { ready = false; void pause({ reason: 'revocation-unavailable' }).catch(() => {}); throw error; });
  }
  return {
    async start() {
      try { const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        if (saved.v !== 1 || !Number.isSafeInteger(saved.cursor) || saved.cursor < 0 || !saved.leases ||
            saved.serviceIdentity !== serviceIdentity || (saved.pending && (saved.pending.receipt?.complete !== true || saved.pending.receipt.cursor !== saved.cursor + 1)))
          fail(503, 'asset-run-state-invalid');
        state = saved;
        for (const l of Object.values(state.leases)) if (l.state !== 'closed') l.state = 'unknown';
        state.assetInstanceId = assetInstanceId; await persist();
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await sync();
    },
    sync,
    beginAdmission() {
      if (!ready || stopped) fail(503, 'asset-run-not-ready');
      let resolve; const token = {}, done = new Promise(r => { resolve = r; }); admissions.set(token, { done, resolve }); return token;
    },
    finishAdmission(token) { const pending = admissions.get(token); if (pending) { admissions.delete(token); pending.resolve(); } },
    async admit(record, entry, token) { if (!admissions.has(token) || stopped || state.leases[record.leaseId]) fail(503, 'asset-run-not-ready');
      state.leases[record.leaseId] = { ...record, state: 'admitted', receipt: null }; live.set(record.leaseId, entry); await persist(); },
    async closed(leaseId, receipt) { const record = state.leases[leaseId]; if (!record) fail(503, 'asset-run-lease-unavailable');
      if (record.receipt && digestOf(record.receipt) !== digestOf(receipt)) fail(409, 'receipt-mismatch');
      record.state = 'closed'; record.receipt = structuredClone(receipt); await persist(); live.delete(leaseId); },
    async prepareClosure(leaseId, receipt) { const record = state.leases[leaseId]; if (!record) fail(503, 'asset-run-lease-unavailable');
      if (record.receipt && digestOf(record.receipt) !== digestOf(receipt)) fail(409, 'receipt-mismatch');
      record.state = 'closing'; record.receipt = structuredClone(receipt); await persist(); },
    async handleAccessEvent(event) {
      // Do not call humanConsumer.sync: it is awaiting this participant.
      await pause(event); await sync();
      return { complete: true, closedStreams: [], stoppedRuns: [], rejectedCredentials: [] };
    },
    unavailable(error) { ready = false; return pause({ reason: 'revocation-unavailable', error }); },
    async close() { stopped = true; ready = false; await pause({ reason: 'revocation-unavailable' }); await chain.catch(() => {}); await writes; },
    get ready() { return ready && !stopped; }, get cursor() { return state.cursor; }, get head() { return head; },
  };
}

async function readRequest(req, maximum) {
  const declared = req.headers['content-length'] ?? (['GET', 'HEAD'].includes(req.method) ? '0' : undefined);
  if (typeof declared !== 'string' || !/^(0|[1-9][0-9]*)$/.test(declared) || !Number.isSafeInteger(Number(declared))) fail(400, 'asset-run-body-invalid');
  if (Number(declared) > maximum) fail(413, 'asset-run-body-too-large');
  const chunks = []; let size = 0;
  try { for await (const chunk of req) { size += chunk.length; if (size > maximum) fail(413, 'asset-run-body-too-large'); chunks.push(chunk); } }
  catch (error) { if (error.status) throw error; fail(400, 'asset-run-body-incomplete'); }
  if (req.aborted || req.complete === false || size !== Number(declared)) fail(400, 'asset-run-body-incomplete');
  return Buffer.concat(chunks);
}
const header = (req, name) => {
  const value = req.headers[`x-promptcut-run-${name}`]; if (!reference(value)) fail(400, 'asset-run-request-invalid'); return value;
};
function rangeOf(range, size) {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range); if (!match || (!match[1] && !match[2])) fail(416, 'asset-run-range-invalid');
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] ? (match[2] ? Math.min(size - 1, Number(match[2])) : size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0 || start >= size) fail(416, 'asset-run-range-invalid');
  return { start, end };
}
function reply(res, status, result) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
  res.end(JSON.stringify(status < 400 ? { ok: true, result } : { ok: false, code: result }));
}

/** Dedicated Agent mTLS entry. No human/LAN resolver or hash-global fallback.
 * All bytes and wire metadata are observed here; the doc only receives hashes,
 * the exact signature tuple and real TLS evidence. Public tuple/body actor is
 * never an authorization input. */
export function createAssetRunAccess({ client, consumer, projectStores, humanConsumer, assetInstanceId, serviceIdentity,
  agentFingerprint256, resolveAgentTransport, maxBodyBytes } = {}) {
  const pin = certificateFingerprint(agentFingerprint256);
  if (!/^[a-f0-9]{64}$/.test(pin) || ![assetInstanceId, serviceIdentity].every(reference) ||
      typeof resolveAgentTransport !== 'function' || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 ||
      typeof client?.openLease !== 'function' || typeof consumer?.sync !== 'function' || typeof humanConsumer?.sync !== 'function' ||
      typeof projectStores?.project !== 'function') fail(503, 'asset-run-access-unconfigured');
  const active = new Set(); let stopped = false;
  const freshHeads = async () => { await humanConsumer.sync(); await consumer.sync(); if (!humanConsumer.ready || !consumer.ready) fail(503, 'asset-run-not-ready'); };
  async function handler(req, res) {
    if (!req.url?.startsWith(RUN_ASSET_DATA_ROOT)) return false;
    let channel, lease, closedTask, admission;
    try {
      if (stopped) fail(503, 'asset-run-not-ready');
      assertInstanceDirectTransport(req); const binding = instanceTlsBinding(req.socket);
      if (certificateFingerprint(req.socket.getPeerCertificate?.()?.fingerprint256) !== pin || req.headers.cookie) fail(403, 'asset-run-service-forbidden');
      const service = await resolveAgentTransport({ req, socket: req.socket, fingerprint256: pin });
      if (!exactShape(service, ['serviceKid']) || !reference(service.serviceKid)) fail(403, 'asset-run-service-forbidden');
      const ticketMatch = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? ''); if (!ticketMatch) fail(401, 'asset-run-ticket-required');
      let proof; try { const encoded = req.headers[RUN_ASSET_PROOF_HEADER];
        if (typeof encoded !== 'string' || encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) fail(403, 'instance-proof-required');
        proof = requestProof(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.from(encoded, 'base64url'))));
      } catch (error) { if (error.status) throw error; fail(400, 'instance-proof-invalid'); }
      const body = await readRequest(req, maxBodyBytes);
      const match = /^\/internal\/v2\/asset\/run\/media\/([a-f0-9]{64})(?:\/(chunks|complete|0|[1-9][0-9]*))?$/.exec(req.url);
      const action = req.method === 'PUT' || (req.method === 'POST' && match?.[2] === 'complete') ? 'write' : 'read';
      const input = assetHttpTuple({ projectId: header(req, 'project-id'), runGrantId: header(req, 'grant-id'), action,
        resourceRev: header(req, 'resource-rev'), nonce: header(req, 'nonce'), requestId: header(req, 'request-id'),
        ticketDigest: ticketDigest(ticketMatch[1]), method: req.method, url: req.url, range: req.headers.range ?? null,
        contentLength: body.length, contentDigest: bytesDigest(body), contentType: req.headers['content-type'] ?? null,
        ...(req.headers['x-promptcut-run-import-id'] ? { importId: header(req, 'import-id') } : {}),
        ...(req.method === 'PUT' ? { chunkIndex: Number(match?.[2]) } : {}) });
      const route = validateAssetHttpTuple(input);
      await freshHeads();
      admission = consumer.beginAdmission();
      const observation = { assetInstanceId, assetServiceIdentity: serviceIdentity, assetLeaseId: crypto.randomUUID(),
        agentFingerprint256: pin, agentServiceKid: service.serviceKid, authenticationId: crypto.randomUUID(), channelBinding: binding, open: true };
      channel = client.openLease({ ticket: ticketMatch[1], request: input, proof, observation });
      const entry = { last: await channel.check(), lease: null }; validateAssetRef(entry.last.resource);
      if (entry.last.projectId !== input.projectId || entry.last.resourceRev !== input.resourceRev ||
          resourceRevision(entry.last.resource) !== input.resourceRev || entry.last.action !== action) fail(403, 'asset-run-resource-mismatch');
      const listeners = new Set();
      lease = await createAssetResourceLease({ context: { projectId: input.projectId, action, resource: entry.last.resource },
        subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, eventPolicy: 'recheck', initialCheck: false,
        check: async () => {
          // Never acquire either consumer queue here: a committed event may
          // be waiting for this owned operation to leave its publish/IO hold.
          // The dedicated continuation independently synchronizes doc authority
          // and checks this exact live lease on every read/write step.
          entry.last = await channel.check(); if (entry.last.allowed !== true) fail(403, 'run-revoked'); return entry.last;
        }, close: () => { req.destroy(); res.destroy(); req.socket?.destroy(); } });
      entry.lease = lease;
      lease.track(req); lease.track(res); lease.track(req.socket);
      req.socket.once('close', () => { void lease.revoke({ reason: 'revocation-unavailable' }).catch(() => {}); });
      const done = actualClose(req.socket);
      closedTask = (async () => {
        await done; await lease.release();
        const receipt = { leaseId: channel.leaseId, receiptId: crypto.randomUUID(), complete: true,
          evidenceDigest: digestOf({ leaseId: channel.leaseId, sourceClosed: true, reqClosed: req.closed, resClosed: res.closed, socketClosed: req.socket?.closed }) };
        await consumer.prepareClosure(channel.leaseId, receipt); // durable actual-close proof before any doc ACK
        await channel.closeLease(receipt); await consumer.closed(channel.leaseId, receipt); await channel.close();
      })();
      entry.closed = closedTask;
      await consumer.admit({ leaseId: channel.leaseId, projectId: input.projectId, runGrantId: input.runGrantId,
        instanceId: proof.instanceId, instanceGeneration: proof.instanceGeneration }, entry, admission);
      consumer.finishAdmission(admission); admission = null;
      active.add(closedTask); closedTask.finally(() => active.delete(closedTask)).catch(() => {});
      const scope = projectStores.project(input.projectId), store = authorizedAssetStore(scope.stores.media, lease), ref = entry.last.resource;
      if (route.operation === 'openRead') {
        const stat = await store.stat(ref.hash); if (!stat) fail(404, 'asset-missing'); if (stat.size !== ref.size) fail(409, 'asset-size-mismatch');
        const range = rangeOf(input.range, stat.size), length = range ? range.end - range.start + 1 : stat.size;
        await lease.assert(); res.writeHead(range ? 206 : 200, { 'content-type': ref.contentType, 'content-length': length,
          'accept-ranges': 'bytes', 'cache-control': 'no-store', connection: 'close', ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${stat.size}` } : {}) });
        if (req.method === 'HEAD') res.end();
        else { const source = await store.read(ref.hash, range ?? {}); if (!source) fail(404, 'asset-missing');
          for await (const piece of source) { await lease.assert(); if (!res.write(piece)) await Promise.race([
            once(res, 'drain'), once(res, 'close').then(() => fail(503, 'asset-run-response-closed')),
          ]); } await lease.assert(); res.end(); }
      } else if (route.operation === 'verifyRef') {
        const parsed = decodeRunAssetBody(body).body;
        if (!exactShape(parsed, ['projectId', 'hash', 'size']) || parsed.projectId !== input.projectId || parsed.hash !== ref.hash || parsed.size !== ref.size) fail(403, 'asset-run-resource-mismatch');
        const stat = await store.stat(ref.hash); if (!stat) fail(404, 'asset-missing'); if (stat.size !== ref.size) fail(409, 'asset-size-mismatch');
        reply(res, 200, { assetRefId: assetRefId(ref), assetRef: ref, resourceRev: resourceRevision(ref) });
      } else {
        if (action === 'write' && !input.importId) fail(400, 'asset-run-import-required');
        const owner = digestOf({ projectId: input.projectId, runGrantId: input.runGrantId, instanceId: proof.instanceId,
          instanceGeneration: proof.instanceGeneration, importId: input.importId ?? 'read' });
        const dir = path.join(scope.root, '.run-imports', owner), stage = createFsStore({ dir, chunkSize: store.chunkSize });
        Object.defineProperty(stage, 'projectId', { value: input.projectId }); const staging = authorizedAssetStore(stage, lease);
        if (route.operation === 'chunks') {
          const complete = await store.chunks(ref.hash); reply(res, 200, complete.complete ? complete : await staging.chunks(ref.hash));
        } else if (route.operation === 'chunk') reply(res, 200, await staging.putChunk(ref.hash, input.chunkIndex, { size: ref.size, ext: ref.ext }, Readable.from([body])));
        else {
          const existing = await store.stat(ref.hash);
          if (existing) { if (existing.size !== ref.size) fail(409, 'asset-size-mismatch'); reply(res, 200, { status: 'ok', size: ref.size, ext: ref.ext }); }
          else {
            const result = await staging.complete(ref.hash);
            if (result.status !== 'ok') reply(res, result.status === 'hash-mismatch' ? 400 : 409, result.status);
            else {
              const sourceFile = path.join(dir, ref.ext ? `${ref.hash}.${ref.ext}` : ref.hash), target = path.join(scope.dirs.media, path.basename(sourceFile));
              await lease.run(async () => { await lease.assert(); await fs.mkdir(scope.dirs.media, { recursive: true });
                const temp = `${target}.${crypto.randomUUID()}.tmp`; await fs.copyFile(sourceFile, temp); await lease.assert();
                await publishProjectFile({ temp, target, assert: lease.assert, lease }); await lease.assert(); });
              reply(res, 200, { status: 'ok', size: ref.size, ext: ref.ext });
            }
          }
        }
      }
    } catch (error) {
      if (res.headersSent) { res.destroy(); req.socket?.destroy(); } else reply(res, error.status ?? 503, error.code ?? 'asset-run-unavailable');
      if (!closedTask) { lease?.revoke({ reason: 'revocation-unavailable' }); await channel?.close(); }
    }
    finally { if (admission) consumer.finishAdmission(admission); }
    return true;
  }
  return { handler, async close() { stopped = true; await consumer.unavailable(new Error('host-close')); await Promise.allSettled([...active]); },
    status() { return { runAssetsConfigured: true, runAssetCursor: consumer.cursor, runAssetHead: consumer.head, runAssetsReady: consumer.ready }; } };
}
