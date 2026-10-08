import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { digestOf } from '../account/ledger.mjs';
import { instanceTlsBinding, instanceProofPayload } from '../account/agent-instance-authority.mjs';
import { signInstance } from './agent-instance-fixture.mjs';
import { openReadIntents } from '../agent/service/read-intents.mjs';
import { canonicalReadRecord } from '../account/run-authority.mjs';

const [dir, portText] = process.argv.slice(2); let port = Number(portText), intents;
const keys = generateKeyPairSync('ed25519'); // Never exported or written to disk.
let registration, lastProof;
const agent = new https.Agent({ key: fs.readFileSync(path.join(dir, 'asset.key')),
  cert: fs.readFileSync(path.join(dir, 'asset.crt')), ca: fs.readFileSync(path.join(dir, 'ca.crt')),
  keepAlive: false, maxCachedSessions: 0 });
function post(route, body, { signing = false, replay = false, target, operation = 'admit' } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const req = https.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', agent }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(data) }));
    });
    req.on('error', reject);
    req.once('socket', socket => socket.once('secureConnect', () => {
      try {
        if (signing || replay) {
          const ref = target ?? registration;
          const payload = instanceProofPayload({ ...ref, serviceId: 'agent', serviceKid: 'test-agent-kid',
            channelBinding: instanceTlsBinding(socket), method: 'POST', path: route, operation, requestDigest: digestOf(body) });
          const proof = replay ? lastProof : { instanceId: ref.instanceId, instanceGeneration: ref.instanceGeneration,
            signature: signInstance(keys.privateKey, payload) };
          if (!replay) lastProof = proof;
          req.setHeader('x-test-instance-proof', Buffer.from(JSON.stringify(proof)).toString('base64url'));
        }
        req.end(bytes);
      } catch (error) { req.destroy(error); }
    }));
  });
}
process.on('message', async command => {
  try {
    let result;
    if (command.kind === 'register') {
      const begin = await post('/begin', { requestId: command.requestId,
        publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
      const body = { challenge: begin.challenge, signature: signInstance(keys.privateKey, begin.challenge) };
      const first = await post('/register', body), second = await post('/register', body);
      registration = first.registration;
      result = { status: first.status, duplicateSame: JSON.stringify(first) === JSON.stringify(second), registration };
    } else if (command.kind === 'setPort') { port = command.port; result = { changed: true }; }
    else if (command.kind === 'invoke') result = await post(`/runs/${command.operation}`, command.request,
      { signing: true, operation: command.operation });
    else if (command.kind === 'prepare') {
      intents ??= openReadIntents({ file: path.join(dir, 'agent-read-intents.db') });
      const g = command.grant;
      const intent = intents.prepare({ requestId: 'read-one', binding: g, prompt: canonicalReadRecord(g.message, g) });
      result = { readIntentId: intent.readIntentId, state: intent.state };
    } else if (command.kind === 'confirm') {
      const send = operation => async request => {
        const response = await post(`/runs/${operation}`, request, { signing: true, operation });
        if (response.status !== 200) throw new Error(response.code); return response.result;
      };
      const value = await intents.confirm(command.readIntentId, { confirmRead: send('confirmRead'), queryRead: send('queryRead') });
      result = { state: value.state, receiptId: value.receipt?.receiptId };
    } else if (command.kind === 'call') result = await post('/call', command.request,
      { signing: true, replay: command.replay === true, target: command.target });
    else if (command.kind === 'stop') { intents?.close(); agent.destroy(); process.send({ id: command.id, result: { stopped: true } }, () => process.disconnect()); return; }
    else throw new Error('unknown-command');
    process.send({ id: command.id, result });
  } catch (error) { process.send({ id: command.id, error: error.code ?? 'child-operation-failed' }); }
});
process.send({ ready: true });
