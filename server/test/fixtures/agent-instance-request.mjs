import https from 'node:https';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson, digestOf } from '../../account/ledger.mjs';
import { instanceProofPayload, instanceTlsBinding } from '../../account/agent-instance-authority.mjs';
import { INSTANCE_PROOF_HEADER } from '../../account/agent-instance-internal.mjs';

/** Fixture keys exist only in this process. The signature is constructed after
 * secureConnect from the actual client socket, independently of the server. */
export function instanceHttpRequest({ port, tls, path, body, method = 'POST', instance, operation,
  headers = {}, signedBody = body, signedPath = path, signedOperation = operation, proofOverride } = {}) {
  return new Promise((resolve, reject) => {
    let outcome, socketClosed = false;
    const complete = () => { if (outcome && socketClosed) resolve(outcome); };
    const encoded = Buffer.from(JSON.stringify(body));
    const req = https.request({ host: '127.0.0.1', port, path, method, key: tls.key, cert: tls.cert,
      ca: tls.ca, minVersion: 'TLSv1.3', agent: false, headers: { 'content-type': 'application/json',
        'content-length': encoded.length, ...headers } }, res => {
      const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('error', reject);
      res.on('end', () => { outcome = { status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }; complete(); });
    });
    req.on('error', reject);
    req.on('socket', socket => {
      socket.once('close', () => { socketClosed = true; complete(); });
      socket.once('secureConnect', () => {
      try {
        if (instance) {
          const payload = instanceProofPayload({ ...instance, channelBinding: instanceTlsBinding(socket),
            method, path: signedPath, operation: signedOperation, requestDigest: digestOf(signedBody) });
          const proof = proofOverride ?? { instanceId: instance.instanceId, instanceGeneration: instance.instanceGeneration,
            signature: sign(null, Buffer.from(canonicalJson(payload)), instance.privateKey).toString('base64url') };
          req.setHeader(INSTANCE_PROOF_HEADER, Buffer.from(JSON.stringify(proof)).toString('base64url'));
        }
        req.end(encoded);
      } catch (error) { req.destroy(error); }
      });
    });
  });
}

export async function registerHttpInstance({ port, tls, requestId }) {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const challenge = await instanceHttpRequest({ port, tls, path: '/internal/v2/instances/challenge', body: { requestId, publicKey } });
  if (challenge.status !== 200) throw Error(`instance challenge failed: ${challenge.status}/${challenge.body.code}`);
  const registered = await instanceHttpRequest({ port, tls, path: '/internal/v2/instances/register',
    body: { challenge: challenge.body.result, signature: sign(null, Buffer.from(canonicalJson(challenge.body.result)), pair.privateKey).toString('base64url') } });
  if (registered.status !== 200) throw Error(`instance registration failed: ${registered.status}/${registered.body.code}`);
  return { ...registered.body.result, privateKey: pair.privateKey };
}
