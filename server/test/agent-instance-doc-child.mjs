import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { openAccountLedger, digestOf } from '../account/ledger.mjs';
import { createAgentInstanceAuthority, instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { createRunAuthority } from '../account/run-authority.mjs';
import * as hooks from '../account/conversation-authority.mjs';

const [dir, cut] = process.argv.slice(2);
const die = point => { if (point === cut) process.exit(73); };
const ledger = openAccountLedger({ file: path.join(dir, 'doc.db'), authorityId: 'instance-doc-crash' });
if (!ledger.read().projects.project) ledger.transaction(s => {
  s.projects.project = { status: 'active', creatorAccountId: 'owner', hosted: { agent: true },
    members: { sender: { access: 'rw' } }, bans: {} };
  s.conversationsV2 = { project: { conversation: { v: 2, projectId: 'project', id: 'conversation',
    ownerAccountId: 'owner', visibility: 'shared', currentRunId: null, aclRevision: 1, queueRevision: 1,
    messages: [{ messageId: 'message', requestId: 'send', arrivalSeq: 1, senderAccountId: 'sender',
      senderNameAtSend: 'Fixture sender', loginId: 'login', credentialId: 'credential', loginGeneration: 1,
      content: 'Complete fixture message', contentDigest: digestOf('Complete fixture message'), attachments: [],
      selectionSnapshot: null, queueState: 'queued' }] } } };
});
const connections = new WeakMap(), sockets = new Set(); let seq = 0;
const fingerprint = new X509Certificate(fs.readFileSync(path.join(dir, 'asset.crt'))).fingerprint256;
const verifyServiceInState = (_s, p) => {
  if (!p?.socket?.authorized || p.socket.destroyed || p.socket.getPeerCertificate().fingerprint256 !== fingerprint)
    throw Object.assign(new Error('service-unverified'), { status: 403, code: 'service-unverified' });
  return { serviceId: 'agent', serviceKid: 'test-agent-kid' };
};
const instances = createAgentInstanceAuthority({ ledger, failpoint: die,
  verifyTransportInState: (s, p) => ({ ...verifyServiceInState(s, p),
    authenticationId: connections.get(p.socket), channelBinding: instanceTlsBinding(p.socket) }) });
const run = createRunAuthority({ ledger, instanceAuthority: instances, conversationHooks: hooks,
  verifyServiceInState, verifySender: async ref => ({ ...ref, accountEventSeq: 0 }), synchronize: async () => {}, failpoint: die });
const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'doc.key')), cert: fs.readFileSync(path.join(dir, 'doc.crt')),
  ca: fs.readFileSync(path.join(dir, 'ca.crt')), requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
  let cap;
  try {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw), servicePrincipal = { socket: req.socket };
    let answer;
    if (req.url === '/begin') answer = { challenge: instances.beginRegistration({ servicePrincipal, ...body }) };
    else if (req.url === '/register') answer = { registration: instances.register({ servicePrincipal, ...body }) };
    else {
      const operation = req.url.slice('/runs/'.length);
      if (!['admit', 'confirmRead', 'queryRead'].includes(operation)) throw new Error('fixture-operation-forbidden');
      const proof = JSON.parse(Buffer.from(req.headers['x-test-instance-proof'], 'base64url').toString());
      cap = instances.authenticate({ servicePrincipal, method: req.method, path: req.url, operation, request: body, proof });
      answer = { result: await run[operation]({ ...body, servicePrincipal: { ...servicePrincipal, ...cap } }) };
    }
    res.writeHead(200); res.end(JSON.stringify(answer));
  } catch (error) { res.writeHead(error.status ?? 500); res.end(JSON.stringify({ code: error.code ?? 'fixture-handler-failed' })); }
  finally { if (cap) instances.release(cap.instanceSession); }
});
server.on('secureConnection', socket => { connections.set(socket, `socket-${++seq}`); sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
server.listen(0, '127.0.0.1', () => process.send({ ready: true, port: server.address().port }));
process.on('message', async value => {
  if (value.kind === 'stop') {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); instances.close(); ledger.close(); process.disconnect();
  }
});
