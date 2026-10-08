import https from 'node:https';
import tls from 'node:tls';
import { randomBytes, createHash, sign } from 'node:crypto';
import { canonicalJson, digestOf } from '../../account/ledger.mjs';
import { instanceProofPayload, instanceTlsBinding } from '../../account/agent-instance-authority.mjs';
import { INSTANCE_PROOF_HEADER, INSTANCE_DATA_PROOF_HEADER, instanceProtocolHeaders,
  instanceConnectionRequest, instanceDataRequest } from '../../account/agent-instance-internal.mjs';

// Test-only keys remain in RAM. Client signatures use the client's actual TLS
// exporter; no server callback supplies a capability or a signature to this code.
export function signDataProof(socket, instance, method, url, operation, request, action) {
  const payload = instanceProofPayload({ ...instance, channelBinding: instanceTlsBinding(socket), method,
    path: new URL(url, 'https://fixture.invalid').pathname, operation, requestDigest: digestOf(request) });
  return { operation, instanceId: instance.instanceId, instanceGeneration: instance.instanceGeneration,
    signature: sign(null, Buffer.from(canonicalJson(payload)), instance.privateKey).toString('base64url'),
    ...(action ? { action } : {}) };
}
const referenceProof = proof => ({ instanceId: proof.instanceId, instanceGeneration: proof.instanceGeneration, signature: proof.signature });
const headerOf = proof => Buffer.from(JSON.stringify(proof)).toString('base64url');
export const dataAction = frame => /^(project\.op|project\.upload|project\.snapshot\.put|content\.put|events\.|presence\.(set|clear|send)|task\.|publisher\.|node\.)/.test(frame.type) ? 'write' : 'read';

export function instanceDataHttpRequest({ port, tls: identity, instance, projectId, runGrantId, connId, nonce,
  kind, url, method = kind === 'recv' ? 'GET' : 'POST', body, headers = {}, sessionItem,
  signedUrl = url, signedBodyText, signedHeaders = headers, actionOverride, proofOverride } = {}) {
  return new Promise((resolve, reject) => {
    const bodyText = body === undefined ? '' : JSON.stringify(body), encoded = Buffer.from(bodyText);
    let result, closed = false;
    const complete = () => { if (result && closed) resolve(result); };
    const req = https.request({ host: '127.0.0.1', port, method, path: url, agent: false,
      ...identity, minVersion: 'TLSv1.3', headers: { ...(body === undefined ? {} : {
        'content-type': 'application/json', 'content-length': encoded.length }), ...headers } }, res => {
      const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('error', reject);
      res.on('end', () => { result = { status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }; complete(); });
    }); req.on('error', reject);
    req.on('socket', socket => {
      socket.once('close', () => { closed = true; complete(); });
      socket.once('secureConnect', () => {
        try {
          const protocols = instanceProtocolHeaders(signedHeaders), actualText = signedBodyText ?? bodyText;
          if (kind === 'connection' || kind === 'resume') {
            const operation = kind === 'resume' ? 'checkAccess' : 'resolveRunPrincipal';
            const request = instanceConnectionRequest({ projectId, runGrantId, nonce, purpose: kind === 'resume' ? 'run-resume' : 'run-connection',
              url: signedUrl, protocols, bodyText: actualText, sessionItem });
            const proof = signDataProof(socket, instance, method, signedUrl, operation,
              kind === 'resume' ? { ...request, action: 'read' } : request, kind === 'resume' ? 'read' : undefined);
            req.setHeader(INSTANCE_PROOF_HEADER, headerOf(proofOverride ?? referenceProof(proof)));
          } else {
            const proofsFor = (text, frameIndex, itemNonce) => {
              const frame = text === undefined ? undefined : JSON.parse(text), action = actionOverride ?? (frame ? dataAction(frame) : 'read');
              const request = instanceDataRequest({ projectId, runGrantId, connId, nonce: itemNonce, kind,
                url: signedUrl, protocols, bodyText: actualText, text, frameIndex });
              const proofs = [signDataProof(socket, instance, method, signedUrl, 'checkAccess', { ...request, action }, action)];
              if (frame?.type === 'selection.query') proofs.push(signDataProof(socket, instance, method, signedUrl, 'authorizeQuery', request));
              return { nonce: itemNonce, proofs };
            };
            const envelope = kind === 'message' ? { frames: body.frames.map((text, index) => proofsFor(text, index, nonce + index)) } : proofsFor(undefined, undefined, nonce);
            req.setHeader(INSTANCE_DATA_PROOF_HEADER, headerOf(proofOverride ?? envelope));
          }
          req.end(encoded);
        } catch (error) { req.destroy(error); }
      });
    });
  });
}

const frameBytes = (opcode, payload) => {
  const size = payload.length, head = Buffer.alloc(size < 126 ? 2 : size < 65536 ? 4 : 10);
  head[0] = 0x80 | opcode; head[1] = 0x80 | (size < 126 ? size : size < 65536 ? 126 : 127);
  if (size >= 126 && size < 65536) head.writeUInt16BE(size, 2);
  if (size >= 65536) head.writeBigUInt64BE(BigInt(size), 2);
  const mask = randomBytes(4), bytes = Buffer.from(payload);
  for (let index = 0; index < bytes.length; index++) bytes[index] ^= mask[index & 3];
  return Buffer.concat([head, mask, bytes]);
};

export async function instanceWsClient({ port, tls: identity, instance, projectId, runGrantId, nonce,
  url = `/?projectId=${projectId}&runGrantId=${runGrantId}&nonce=${nonce}`,
  protocols = ['promptcut.v1', 'promptcut.session.new'], sessionItem, signedUrl = url,
  signedProtocols = protocols, proofOverride, headers = {} } = {}) {
  const socket = tls.connect({ host: '127.0.0.1', port, ...identity, minVersion: 'TLSv1.3' });
  socket.on('error', () => {});
  const ended = new Promise(resolve => socket.once('close', resolve));
  await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
  const key = randomBytes(16).toString('base64'), protocolText = protocols.join(', '), offered = instanceProtocolHeaders({ 'sec-websocket-protocol': signedProtocols.join(', ') });
  const request = instanceConnectionRequest({ projectId, runGrantId, nonce, purpose: sessionItem ? 'run-resume' : 'run-connection',
    url: signedUrl, protocols: offered, sessionItem });
  const proof = signDataProof(socket, instance, 'GET', signedUrl, sessionItem ? 'checkAccess' : 'resolveRunPrincipal',
    sessionItem ? { ...request, action: 'read' } : request, sessionItem ? 'read' : undefined);
  const lines = [`GET ${url} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Protocol: ${protocolText}`,
    `${INSTANCE_PROOF_HEADER}: ${headerOf(proofOverride ?? referenceProof(proof))}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)];
  let buffer = Buffer.alloc(0);
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(Error('TLS WS handshake timeout')); }, 5000);
    const onData = data => { buffer = Buffer.concat([buffer, data]); const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      clearTimeout(timer); socket.off('data', onData); const head = buffer.subarray(0, end).toString('latin1');
      buffer = buffer.subarray(end + 4); resolve(head); };
    socket.on('data', onData); socket.once('close', () => { clearTimeout(timer); reject(Error('TLS WS closed during handshake')); });
  }); socket.write(lines.join('\r\n') + '\r\n\r\n');
  const responseHead = await response, status = Number(responseHead.split(' ')[1]);
  if (status !== 101) { socket.destroy(); await ended; return { status, ended, destroy() {}, responseHead }; }
  assertHandshake(responseHead, key);
  const inbox = [], all = [], waiters = []; let closeFrame = null;
  const next = (match = () => true, ms = 4000) => {
    const index = inbox.findIndex(match); if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => { const waiter = { match, resolve, timer: null };
      waiter.timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(Error('TLS WS message timeout')); }, ms);
      waiters.push(waiter); });
  };
  const parse = () => {
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 15; let size = buffer[1] & 127, offset = 2;
      if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
      else if (size === 127) { if (buffer.length < 10) return; size = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      if (buffer.length < offset + size) return;
      const bytes = buffer.subarray(offset, offset + size); buffer = buffer.subarray(offset + size);
      if (opcode === 1) { const msg = JSON.parse(bytes.toString()); all.push(msg); const index = waiters.findIndex(waiter => waiter.match(msg));
        if (index >= 0) { const waiter = waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(msg); } else inbox.push(msg); }
      else if (opcode === 9) socket.write(frameBytes(10, bytes));
      else if (opcode === 8) { closeFrame = { code: bytes.length >= 2 ? bytes.readUInt16BE(0) : 1005 }; socket.end(frameBytes(8, bytes)); }
    }
  };
  socket.on('data', data => { buffer = Buffer.concat([buffer, data]); parse(); }); if (buffer.length) parse();
  return { status, socket, ended, all, next, get closeFrame() { return closeFrame; },
    destroy() { socket.destroy(); },
    envelope({ connId, nonce: messageNonce, frame, actionOverride, omitQuery = false, signedFrame = frame }) {
      const action = actionOverride ?? dataAction(frame), request = instanceDataRequest({ projectId, runGrantId, connId, nonce: messageNonce,
        kind: 'message', url, protocols: instanceProtocolHeaders({ 'sec-websocket-protocol': protocolText }), text: JSON.stringify(signedFrame) });
      const proofs = [signDataProof(socket, instance, 'WS', url, 'checkAccess', { ...request, action }, action)];
      if (frame.type === 'selection.query' && !omitQuery) proofs.push(signDataProof(socket, instance, 'WS', url, 'authorizeQuery', request));
      return { nonce: messageNonce, frame, proofs };
    },
    send(envelope) { socket.write(frameBytes(1, Buffer.from(JSON.stringify(envelope)))); } };
}
function assertHandshake(head, key) {
  const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  if (!head.toLowerCase().includes(`sec-websocket-accept: ${expected.toLowerCase()}`)) throw Error('TLS WS accept mismatch');
}
