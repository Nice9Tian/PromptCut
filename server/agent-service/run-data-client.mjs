import https from 'node:https';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import { accountError, certificateFingerprint } from '../account/client.mjs';
import { instanceConnectionRequest, instanceDataRequest, instanceProtocolHeaders,
  INSTANCE_PROOF_HEADER } from '../account/agent-instance-internal.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const fail = (code, status = 503) => { throw accountError(status, code); };
const actionOf = frame => /^(?:project\.op|project\.upload|project\.snapshot\.put|content\.put|presence\.(?:set|clear|send))$/.test(frame?.type) ||
  /^(?:events\.|task\.|publisher\.|node\.)/.test(frame?.type) ? 'write' : 'read';
const sessionItemOf = protocols => {
  const item = protocols.find(value => value.startsWith('promptcut.session.'));
  if (item === 'promptcut.session.new') return { kind: 'new' };
  const match = /^promptcut\.session\.([A-Za-z0-9_-]+)\.(0|[1-9]\d*)$/.exec(item ?? '');
  if (!match || !Number.isSafeInteger(Number(match[2]))) fail('run-session-protocol', 400);
  return { kind: 'resume', sid: match[1], ack: Number(match[2]) };
};
const proofHeader = proof => Buffer.from(JSON.stringify(proof)).toString('base64url');
const handshakeProof = proof => ({ instanceId: proof.instanceId,
  instanceGeneration: proof.instanceGeneration, signature: proof.signature });

function maskedFrame(op, payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomBytes(4), len = bytes.length;
  const header = Buffer.alloc(len < 126 ? 2 : len < 65536 ? 4 : 10);
  header[0] = 0x80 | op;
  if (len < 126) header[1] = 0x80 | len;
  else if (len < 65536) { header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const out = Buffer.from(bytes);
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, out]);
}

/** An Agent-owned connection uses no global WebSocket override. The existing
 * session layer still owns seq/ack, buffering and exact original-frame retry. */
export function createRunDataClient({ origin, tls, serverFingerprint256, runClient, timeoutMs = 5000 } = {}) {
  let base;
  try { base = new URL(origin); } catch { fail('run-data-configuration'); }
  const pin = certificateFingerprint(serverFingerprint256);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
      !tls?.key || !tls?.cert || !tls?.ca || !/^[a-f0-9]{64}$/.test(pin) ||
      typeof runClient?.registerInstance !== 'function' || typeof runClient?.dataProofFor !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1) fail('run-data-configuration');
  const sockets = new Set(), longPolls = new Set(); let closed = false, sequence = randomInt(1, 0x7fffffff);
  const nonce = () => { if (!Number.isSafeInteger(sequence + 1)) fail('run-data-nonce-exhausted'); return ++sequence; };
  const pinServer = (host, cert) => checkServerIdentity(host, cert) ||
    (certificateFingerprint(cert.fingerprint256) !== pin ? accountError(503, 'run-data-server-certificate') : undefined);
  const options = { agent: false, key: tls.key, cert: tls.cert, ca: tls.ca, rejectUnauthorized: true,
    minVersion: 'TLSv1.3', timeout: timeoutMs, checkServerIdentity: pinServer };
  const ensureGrant = grant => {
    if (!grant || typeof grant.projectId !== 'string' || typeof grant.runGrantId !== 'string' ||
        !grant.projectId || !grant.runGrantId) fail('run-data-grant');
    return Object.freeze({ projectId: grant.projectId, runGrantId: grant.runGrantId });
  };
  const sign = (socket, method, path, operation, request) => runClient.dataProofFor({ socket, method, path, operation, request });

  function webSocketFor(grantInput) {
    const grant = ensureGrant(grantInput);
    const owned = new Set();
    return class RunWebSocket {
      readyState = 0;
      static async closeOwned() {
        await Promise.all([...owned].map(socket => new Promise(resolve => {
          socket.addEventListener('close', resolve); socket.terminate();
        })));
      }
      constructor(url, protocols) {
        this.handlers = new Map(); this.socket = null; this.request = null; this.buffer = Buffer.alloc(0);
        this.fragments = null; this.connId = null; this.ended = false; this.closeSent = false;
        this.closeInfo = { code: 1006, reason: 'transport-close' }; this.closeTimer = null;
        if (closed || !Array.isArray(protocols) || protocols[0] !== 'promptcut.v1' ||
            protocols.some(value => typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value)))
          fail('run-data-protocol');
        const target = new URL(url);
        if (target.protocol !== 'wss:' || target.host !== base.host || target.pathname !== '/' || target.search || target.hash)
          fail('run-data-origin');
        this.protocols = [...protocols]; this.item = sessionItemOf(protocols);
        this.initialNonce = nonce();
        this.rawUrl = `/?projectId=${encodeURIComponent(grant.projectId)}&runGrantId=${encodeURIComponent(grant.runGrantId)}&nonce=${this.initialNonce}`;
        this.protocolHeader = protocols.join(', ');
        this.protocolHeaders = instanceProtocolHeaders({ 'sec-websocket-protocol': this.protocolHeader });
        sockets.add(this); owned.add(this);
        void Promise.resolve().then(() => runClient.registerInstance()).then(() => this.connect()).catch(error => this.fail(error));
      }
      addEventListener(type, handler) { const list = this.handlers.get(type) ?? new Set(); list.add(handler); this.handlers.set(type, list); }
      removeEventListener(type, handler) { this.handlers.get(type)?.delete(handler); }
      emit(type, value = {}) { for (const handler of this.handlers.get(type) ?? []) try { handler(value); } catch {} }
      fail(error) { if (this.ended) return; this.emit('error', { error, message: error?.code ?? 'run-data-unavailable' });
        this.closeInfo = { code: 1006, reason: 'transport-error' };
        if (this.socket) this.socket.destroy();
        else if (this.request) this.request.destroy();
        else this.end(1006, 'transport-error'); }
      end(code, reason) { if (this.ended) return; this.ended = true; this.readyState = 3; sockets.delete(this); owned.delete(this);
        if (this.closeTimer) clearTimeout(this.closeTimer);
        this.emit('close', { code, reason }); }
      connect() {
        if (closed || this.ended) fail('run-data-closed');
        const key = randomBytes(16).toString('base64');
        const req = https.request(new URL(this.rawUrl, base), { ...options, method: 'GET',
          headers: { host: base.host, upgrade: 'websocket', connection: 'Upgrade',
            'sec-websocket-key': key, 'sec-websocket-version': '13', 'sec-websocket-protocol': this.protocolHeader } });
        this.request = req;
        req.on('socket', socket => socket.once('secureConnect', () => {
          try {
            const request = instanceConnectionRequest({ ...grant, nonce: this.initialNonce,
              purpose: this.item.kind === 'new' ? 'run-connection' : 'run-resume',
              url: this.rawUrl, protocols: this.protocolHeaders, bodyText: '',
              ...(this.item.kind === 'resume' ? { sessionItem: { sid: this.item.sid, ack: this.item.ack } } : {}) });
            const operation = this.item.kind === 'new' ? 'resolveRunPrincipal' : 'checkAccess';
            const proof = sign(socket, 'GET', '/', operation,
              operation === 'checkAccess' ? { ...request, action: 'read' } : request);
            req.setHeader(INSTANCE_PROOF_HEADER, proofHeader(handshakeProof(proof))); req.end();
          } catch (error) { this.fail(error); }
        }));
        req.on('upgrade', (res, socket, head) => {
          if (this.ended || closed) { socket.destroy(); return; }
          const expected = createHash('sha1').update(key + GUID).digest('base64');
          if (res.statusCode !== 101 || res.headers['sec-websocket-accept'] !== expected ||
              res.headers['sec-websocket-protocol'] !== 'promptcut.v1' || res.headers['sec-websocket-extensions']) {
            this.socket = socket;
            socket.once('close', () => this.end(1006, 'upgrade-invalid'));
            this.fail(accountError(503, 'run-data-upgrade')); return;
          }
          this.socket = socket; this.readyState = 1;
          socket.on('data', chunk => this.receive(chunk));
          socket.on('error', error => this.fail(error));
          socket.on('close', () => this.end(this.closeInfo.code, this.closeInfo.reason));
          this.emit('open'); if (head.length) this.receive(head);
        });
        req.on('response', res => { res.resume(); this.fail(accountError(
          [400, 401, 403, 404, 409].includes(res.statusCode) ? res.statusCode : 503,
          `run-data-upgrade-${res.statusCode}`)); });
        req.on('error', error => this.fail(error));
        req.on('close', () => { if (!this.socket) this.end(this.closeInfo.code, this.closeInfo.reason); });
        req.on('timeout', () => this.fail(accountError(503, 'run-data-timeout')));
      }
      receive(chunk) {
        if (this.ended) return;
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        while (this.buffer.length >= 2) {
          const b = this.buffer, op = b[0] & 15, fin = !!(b[0] & 0x80);
          if (b[0] & 0x70 || b[1] & 0x80) return this.fail(accountError(503, 'run-data-frame'));
          let length = b[1] & 127, offset = 2;
          if (length === 126) { if (b.length < 4) return; length = b.readUInt16BE(2); offset = 4; }
          else if (length === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2);
            if (big > 8n * 1024n * 1024n) return this.fail(accountError(503, 'run-data-frame'));
            length = Number(big); offset = 10; }
          if (length > 8 * 1024 * 1024 || b.length < offset + length) return length > 8 * 1024 * 1024 ?
            this.fail(accountError(503, 'run-data-frame')) : undefined;
          const payload = b.subarray(offset, offset + length); this.buffer = b.subarray(offset + length);
          if (op === 9) { if (!fin || length > 125) return this.fail(accountError(503, 'run-data-frame'));
            this.socket.write(maskedFrame(10, payload)); continue; }
          if (op === 10) continue;
          if (op === 8) { const code = length >= 2 ? payload.readUInt16BE(0) : 1000;
            const reason = length >= 2 ? payload.subarray(2).toString('utf8') : '';
            if (!this.closeSent && this.socket.writable) this.socket.write(maskedFrame(8, payload));
            this.closeInfo = { code, reason }; this.socket.end(); return; }
          if (op !== 1 && op !== 0) return this.fail(accountError(503, 'run-data-frame'));
          if (op === 1 && this.fragments) return this.fail(accountError(503, 'run-data-frame'));
          if (op === 0 && !this.fragments) return this.fail(accountError(503, 'run-data-frame'));
          if (!fin) { this.fragments ??= []; this.fragments.push(payload); continue; }
          const text = this.fragments ? Buffer.concat([...this.fragments, payload]).toString('utf8') : payload.toString('utf8');
          this.fragments = null;
          let frame; try { frame = JSON.parse(text); } catch { return this.fail(accountError(503, 'run-data-frame')); }
          if (frame?.type === 'session.welcome') {
            if (typeof frame.connId !== 'string' || !frame.connId) return this.fail(accountError(503, 'run-data-conn-id'));
            this.connId = frame.connId;
          } else if (!this.connId) return this.fail(accountError(503, 'run-data-conn-id'));
          this.emit('message', { data: text });
        }
      }
      send(text) {
        if (this.readyState !== 1 || !this.connId || typeof text !== 'string') fail('run-data-not-open');
        let frame; try { frame = JSON.parse(text); } catch { fail('run-data-frame', 400); }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) fail('run-data-frame', 400);
        const number = nonce(), request = instanceDataRequest({ ...grant, connId: this.connId,
          nonce: number, kind: 'message', url: this.rawUrl, protocols: this.protocolHeaders, bodyText: '', text: JSON.stringify(frame) });
        const action = actionOf(frame);
        const proofs = [sign(this.socket, 'WS', '/', 'checkAccess', { ...request, action })];
        if (frame.type === 'selection.query') proofs.push(sign(this.socket, 'WS', '/', 'authorizeQuery', request));
        this.socket.write(maskedFrame(1, JSON.stringify({ nonce: number, frame, proofs })));
      }
      close(code = 1000, reason = '') {
        if (this.readyState === 3 || this.closeSent) return;
        this.closeSent = true; this.readyState = 2;
        if (!this.socket?.writable) { this.request?.destroy(); this.socket?.destroy();
          if (!this.request && !this.socket) this.end(1006, 'closed'); return; }
        const label = Buffer.from(reason).subarray(0, 123), bytes = Buffer.alloc(2 + label.length);
        bytes.writeUInt16BE(code, 0); label.copy(bytes, 2);
        this.socket.write(maskedFrame(8, bytes));
        this.closeTimer = setTimeout(() => this.socket?.destroy(), 2000); this.closeTimer.unref?.();
      }
      terminate() { this.closeInfo = { code: 1006, reason: 'terminated' };
        this.socket?.destroy(); this.request?.destroy(); if (!this.socket && !this.request) this.end(1006, 'terminated'); }
    };
  }
  /** Explicit LP transport for hosts that select HTTP. The existing Agent
   * session-link still selects WS; an LP fallback must use this same signed
   * transport before it can be wired into that session layer. */
  function longPollFor(grantInput) {
    const grant = ensureGrant(grantInput);
    let sid = null, connId = null, ended = false;
    const active = new Set();
    function request(method, rawUrl, bodyText = '', extraHeaders = {}, makeProof) {
      if (closed || ended) return Promise.reject(accountError(503, 'run-data-closed'));
      const bytes = Buffer.from(bodyText);
      if (bytes.length > 1024 * 1024) return Promise.reject(accountError(413, 'run-data-body-too-large'));
      return new Promise((resolve, reject) => {
        let socket, socketClosed = false, requestClosed = false, result, error, responseReady = false, settled = false;
        let closedOwner;
        const done = () => { if (settled || !responseReady || !(socket ? socketClosed : requestClosed)) return;
          settled = true; active.delete(owner); closedOwner(); error ? reject(error) : resolve(result); };
        const abort = problem => { if (responseReady) return; error = problem; responseReady = true; req.destroy(); done(); };
        const req = https.request(new URL(rawUrl, base), { ...options, method,
          headers: { connection: 'close', ...(method === 'POST' ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}),
            ...(sid ? { authorization: `Bearer ${sid}` } : {}), ...extraHeaders } }, res => {
          const chunks = []; let length = 0;
          res.on('data', chunk => { length += chunk.length; if (length > 8 * 1024 * 1024) res.destroy(); else chunks.push(chunk); });
          res.on('error', () => abort(accountError(503, 'run-data-unavailable')));
          res.on('end', () => {
            try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { error = accountError(503, 'run-data-protocol'); responseReady = true; done(); return; }
            if (res.statusCode !== 200 || result?.ok !== true) error = accountError(
              [400, 401, 403, 404, 409, 410, 413].includes(res.statusCode) ? res.statusCode : 503,
              typeof result?.error === 'string' ? result.error : 'run-data-unavailable');
            responseReady = true; done();
          });
        });
        const owner = { req, closed: new Promise(resolveOwner => { closedOwner = resolveOwner; }) };
        active.add(owner);
        req.once('close', () => { requestClosed = true;
          if (!responseReady) { error = accountError(503, 'run-data-unavailable'); responseReady = true; }
          done(); });
        req.on('socket', current => {
          socket = current;
          current.once('close', () => { socketClosed = true; done(); });
          current.once('secureConnect', () => {
            try {
              const proof = makeProof(current);
              req.setHeader(proof.name, proof.value);
              req.end(bytes);
            } catch (problem) { abort(problem); }
          });
        });
        req.on('error', () => abort(accountError(503, 'run-data-unavailable')));
        req.on('timeout', () => abort(accountError(503, 'run-data-timeout')));
      });
    }
    const headersFor = headers => instanceProtocolHeaders(Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])));
    const dataProof = (socket, method, rawUrl, kind, bodyText, text, frameIndex) => {
      const number = nonce(), path = new URL(rawUrl, base).pathname;
      const requestBody = instanceDataRequest({ ...grant, connId, nonce: number, kind, url: rawUrl,
        protocols: headersFor({}), bodyText,
        ...(text !== undefined ? { text } : {}), ...(frameIndex !== undefined ? { frameIndex } : {}) });
      const frame = text === undefined ? null : JSON.parse(text);
      const action = actionOf(frame);
      const proofs = [sign(socket, method, path, 'checkAccess', { ...requestBody, action })];
      if (frame?.type === 'selection.query') proofs.push(sign(socket, method, path, 'authorizeQuery', requestBody));
      return { nonce: number, proofs };
    };
    async function open({ resume = null } = {}) {
      if (sid && !resume) fail('run-data-already-open', 409);
      await runClient.registerInstance();
      const initial = nonce(), rawUrl = `/?projectId=${encodeURIComponent(grant.projectId)}&runGrantId=${encodeURIComponent(grant.runGrantId)}&nonce=${initial}`;
      const route = `/lp/open${rawUrl.slice(1)}`, bodyText = '{}';
      const protocolHeader = resume ? `promptcut.v1, promptcut.session.${resume.sid}.${resume.ack}` :
        'promptcut.v1, promptcut.session.new';
      const headers = { 'x-promptcut-protocols': protocolHeader };
      const result = await request('POST', route, bodyText, headers, socket => {
        const baseRequest = instanceConnectionRequest({ ...grant, nonce: initial,
          purpose: resume ? 'run-resume' : 'run-connection', url: route, protocols: headersFor(headers), bodyText,
          ...(resume ? { sessionItem: { sid: resume.sid, ack: resume.ack } } : {}) });
        const operation = resume ? 'checkAccess' : 'resolveRunPrincipal';
        const proof = sign(socket, 'POST', '/lp/open', operation,
          resume ? { ...baseRequest, action: 'read' } : baseRequest);
        return { name: INSTANCE_PROOF_HEADER, value: proofHeader(handshakeProof(proof)) };
      });
      if (typeof result.sid !== 'string' || typeof result.connId !== 'string' || !result.connId)
        fail('run-data-open-protocol');
      sid = result.sid; connId = result.connId;
      return result;
    }
    async function send(frames) {
      if (!sid || !connId || !Array.isArray(frames) || frames.length === 0 ||
          frames.some(frame => typeof frame !== 'string')) fail('run-data-send-input', 400);
      const rawUrl = '/lp/send', bodyText = JSON.stringify({ frames });
      return request('POST', rawUrl, bodyText, {}, socket => ({ name: 'x-promptcut-data-proof',
        value: proofHeader({ frames: frames.map((text, frameIndex) =>
          dataProof(socket, 'POST', rawUrl, 'message', bodyText, text, frameIndex)) }) }));
    }
    async function recv({ ack = 0, wait = 0 } = {}) {
      if (!sid || !connId || !Number.isSafeInteger(ack) || ack < 0 || !Number.isSafeInteger(wait) || wait < 0)
        fail('run-data-recv-input', 400);
      const rawUrl = `/lp/recv?ack=${ack}&wait=${wait}`;
      return request('GET', rawUrl, '', {}, socket => ({ name: 'x-promptcut-data-proof',
        value: proofHeader(dataProof(socket, 'GET', rawUrl, 'recv', '')) }));
    }
    async function closeSession({ code = 1000, reason = '' } = {}) {
      if (!sid || !connId) fail('run-data-not-open');
      const rawUrl = '/lp/close', bodyText = JSON.stringify({ code, reason });
      const result = await request('POST', rawUrl, bodyText, {}, socket => ({ name: 'x-promptcut-data-proof',
        value: proofHeader(dataProof(socket, 'POST', rawUrl, 'close', bodyText)) }));
      ended = true; sid = null; connId = null; longPolls.delete(api); return result;
    }
    async function close() {
      ended = true; const owners = [...active]; for (const owner of owners) owner.req.destroy();
      await Promise.all(owners.map(owner => owner.closed));
      sid = null; connId = null; longPolls.delete(api);
    }
    const api = { open, send, recv, closeSession, close, describe: () => ({ open: !!sid && !ended, connId }) };
    longPolls.add(api); return api;
  }
  async function close() {
    closed = true; const current = [...sockets];
    await Promise.all([...longPolls].map(session => session.close()));
    await Promise.all(current.map(socket => new Promise(resolve => {
      if (socket.ended) return resolve();
      socket.addEventListener('close', resolve); socket.terminate();
    })));
  }
  return { webSocketFor, longPollFor, close, openCount: () => sockets.size + longPolls.size,
    wsUrl: `wss://${base.host}/` };
}
