import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { accountError, certificateFingerprint } from '../account/client.mjs';
import { canonicalJson } from '../account/ledger.mjs';
import { acceptedMessageRef } from '../account/run-authority.mjs';
import { WORKER_EVENT_PATH, WORKER_EVENT_BINDING_FIELDS } from './worker-event-internal.mjs';

const fail = code => { throw accountError(503, code); };
const bindingOf = grant => Object.fromEntries(WORKER_EVENT_BINDING_FIELDS.map(k => [k,
  k === 'senderAccountId' ? grant?.accountId : grant?.[k]]));
/** One task, one local journal, original worker RAM signer. The master receives
 * event evidence only. Model/tool execution is still gated by the current Doc
 * run authority, and a delivered runner_done remains settlement pending. */
export function createWorkerEventSink({ journal, runClient, origin, tls, serverFingerprint256,
  timeoutMs = 5000, verifyGrant } = {}) {
  let base;
  try { base = new URL(origin); } catch { fail('worker-sink-configuration'); }
  const pin = certificateFingerprint(serverFingerprint256);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
      !tls?.key || !tls.cert || !tls.ca || !/^[a-f0-9]{64}$/.test(pin) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 ||
      !['append', 'source', 'pending', 'receipt', 'acknowledge', 'scope', 'inspect', 'close'].every(k => typeof journal?.[k] === 'function') ||
      typeof runClient?.workerEventProofFor !== 'function' || typeof verifyGrant !== 'function') fail('worker-sink-configuration');
  const scope = journal.scope(), requests = new Set(), sockets = new Set(), responses = new Set();
  let tail = Promise.resolve(), fatal = null, stopped = false, closing = null, writerCreated = false;
  const usable = () => { if (fatal) throw fatal; if (stopped) fail('worker-sink-closed'); };
  const latch = error => { fatal ??= error; };
  function send(packet) {
    usable(); const bodyText = canonicalJson(journal.source(packet)), encoded = Buffer.from(bodyText);
    return new Promise((resolve, reject) => {
      let ready = false, error = null, value, reqClosed = false, socket = null, socketClosed = false,
        response = null, resClosed = false, settled = false;
      const finish = () => {
        if (settled || !ready || !reqClosed || (socket && !socketClosed) || (response && !resClosed)) return;
        settled = true; clearTimeout(timer); error ? reject(error) : resolve(value);
      };
      const abort = cause => { error ??= cause; ready = true; response?.destroy(); req.destroy(); socket?.destroy(); finish(); };
      const req = https.request(new URL(WORKER_EVENT_PATH, base), {
        ...tls, method: 'POST', agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.3',
        checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) ||
          (certificateFingerprint(cert.fingerprint256) !== pin ? accountError(503, 'worker-sink-server-certificate') : undefined); },
        headers: { 'content-type': 'application/json', 'content-length': encoded.length, connection: 'close' },
      }, res => {
        response = res; responses.add(res);
        res.once('close', () => { responses.delete(res); resClosed = true;
          if (!ready) abort(accountError(503, 'worker-sink-response-incomplete')); finish(); });
        let size = 0; const chunks = [];
        res.on('data', chunk => { size += chunk.length;
          if (size > 1024 * 1024) abort(accountError(503, 'worker-sink-response-too-large')); else chunks.push(chunk); });
        res.on('error', () => abort(accountError(503, 'worker-sink-response-incomplete')));
        res.once('end', () => {
          if (ready) return;
          try {
            const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            if (res.statusCode !== 200 || body?.ok !== true) throw accountError(
              [400, 401, 403, 409, 413].includes(res.statusCode) ? res.statusCode : 503,
              typeof body?.code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(body.code) ? body.code : 'worker-sink-unavailable');
            value = body.result; ready = true; finish();
          } catch (cause) { abort(cause.status ? cause : accountError(503, 'worker-sink-protocol')); }
        });
      });
      requests.add(req);
      const timer = setTimeout(() => abort(accountError(503, 'worker-sink-timeout')), timeoutMs);
      req.once('close', () => { requests.delete(req); reqClosed = true; finish(); });
      req.once('error', cause => abort(cause.status ? cause : accountError(503, 'worker-sink-unavailable')));
      req.once('socket', current => {
        socket = current; sockets.add(current);
        current.once('close', () => { sockets.delete(current); socketClosed = true; finish(); });
        current.once('secureConnect', async () => {
          try {
            usable(); if (ready || current.destroyed) fail('worker-sink-closed');
            const proof = await runClient.workerEventProofFor({ socket: current, packet, bodyText, nonce: randomUUID() });
            usable(); if (ready || current.destroyed) fail('worker-sink-closed');
            req.setHeader(proof.name, proof.value); req.end(encoded);
          } catch (cause) { abort(cause); }
        });
      });
    });
  }
  function enqueue(fn) {
    const work = tail.then(() => { usable(); return fn(); });
    // Observe immediately; original caller/flush still receives the first fault.
    tail = work.catch(latch); return work;
  }
  async function deliver(packet) {
    const receipt = await send(packet); usable(); return journal.acknowledge(receipt);
  }
  async function checked(grant) {
    usable();
    if (canonicalJson(bindingOf(grant)) !== canonicalJson(scope.binding)) fail('worker-sink-binding');
    const result = await verifyGrant(structuredClone(grant)); usable();
    if (result?.allowed !== true || canonicalJson(bindingOf(result.runGrant)) !== canonicalJson(scope.binding)) fail('worker-sink-grant');
    return result;
  }
  return {
    async mirrorRunMessage({ grant }) {
      const result = await checked(grant);
      if (!grant.message || canonicalJson(acceptedMessageRef(grant.message, grant)) !== canonicalJson(result.runGrant.messageRef))
        fail('worker-sink-message');
      // The master independently reads/mirrors Doc's original accepted message
      // inside appendWorker. Never send a public user body as a mirror record.
    },
    async writer({ grant }) {
      await checked(grant);
      if (writerCreated || journal.inspect().head !== 0) fail('worker-sink-execution-replay-pending');
      writerCreated = true; let next = journal.inspect().head;
      let error = null, resolveFailure;
      const failed = new Promise(resolve => { resolveFailure = resolve; });
      const stop = cause => { if (!error) { error = cause; latch(cause); resolveFailure(cause); } };
      const flush = async () => { await tail; if (error) throw error; usable(); };
      return { binding: structuredClone(scope.binding), failed, stop,
        emit(event) {
          if (error || stopped) return;
          // 事件要原样变成一段 JSON 交给主服务，主服务按「和这段 JSON 意思完全一样」来核。真实运行器发的事件里
          // 常带值为 undefined 的字段（比如没有的 callId），先按 JSON 的意思规整一遍：这些字段去掉，别的不变。
          let copy; try { copy = JSON.parse(JSON.stringify(event)); } catch (cause) { stop(cause); return; }
          if (!copy || typeof copy !== 'object' || Array.isArray(copy)) { stop(accountError(400, 'worker-event-packet')); return; }
          const eventId = `event:${scope.binding.runGrantId}:${++next}`;
          const work = enqueue(async () => { if (error) throw error;
            const packet = journal.append({ eventId, event: copy }); return deliver(packet); });
          void work.catch(stop); return eventId;
        }, flush, beforeCall: flush,
        // 只在 flush 之后有意义：主服务持久确认过的那一行的编号与摘要，没确认就是 null。
        async receiptOf(eventId) { await flush(); const receipt = journal.receipt(eventId);
          return receipt ? { eventId: receipt.eventId, eventDigest: receipt.eventDigest } : null; },
      };
    },
    // Explicit packet-only recovery. This never creates a model/runner nor resets
    // the single-task writer; retry always uses original packet and fresh TLS.
    replayPending: () => enqueue(async () => { for (const packet of journal.pending()) await deliver(packet); }),
    // 收尾记录跟事件走同一条串行队列：封存时前面的事件都已经送达并确认，之后不会再有事件插进来。
    sealTerminal: record => enqueue(async () => journal.sealTerminal(record)),
    terminal: () => { usable(); return journal.terminal(); },
    failure: () => fatal,
    describe: () => ({ requests: requests.size, sockets: sockets.size, responses: responses.size, writerCreated }),
    close() {
      if (closing) return closing;
      stopped = true;
      const resources = new Set([...requests, ...responses, ...sockets]);
      const ownedClose = [...resources].map(resource => new Promise(resolve => {
        if (resource.closed === true) return resolve(); resource.once('close', resolve); resource.destroy();
      }));
      closing = (async () => {
        const results = await Promise.allSettled([tail, ...ownedClose]);
        const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
        try { journal.close(); } catch (cause) { errors.push(cause); }
        if (fatal && !errors.includes(fatal)) errors.push(fatal);
        if (errors.length) throw new AggregateError(errors, 'worker-sink-close-pending');
      })();
      return closing;
    },
  };
}
