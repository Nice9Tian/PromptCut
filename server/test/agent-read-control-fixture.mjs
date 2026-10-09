import https from 'node:https';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { certificateFingerprint } from '../account/client.mjs';
import { createAgentInstanceAuthority, instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { createAgentInstanceInternalHandler } from '../account/agent-instance-internal.mjs';
import { createAgentReadControl, createAgentReadControlHandler } from '../account/agent-read-control.mjs';
import { createConversationAuthority, conversationReadInState } from '../account/conversation-authority.mjs';
import { createConversationInternalHandler } from '../account/conversation-internal.mjs';
import { createConversationClient } from '../agent-service/conversation-client.mjs';
import { createConversationControlClient } from '../agent-service/conversation-control-client.mjs';
import { createRunClient } from '../agent-service/run-client.mjs';

// Real TLS/exporter/RAM-instance and SQLite control fixture. The supplied account
// authority/consent provider is explicitly owned by the calling test.
export function agentReadControlFixture({ ledger, directory, docTls, agentTls, docPin, agentPin,
  accountAuthority, resolveDelegation, checkConsent, verifySelectionSnapshot, port }) {
  const sockets = new WeakMap(), subjects = new Map(), serverSockets = new Set();
  const resolveServicePrincipal = ({ socket }) => {
    if (!socket.authorized || certificateFingerprint(socket.getPeerCertificate().fingerprint256) !== certificateFingerprint(agentPin))
      throw Object.assign(Error('agent-certificate-required'), { status: 403, code: 'agent-certificate-required' });
    if (!sockets.has(socket)) {
      const id = randomUUID(); sockets.set(socket, id); subjects.set(id, socket);
      socket.once('close', () => subjects.delete(id));
    }
    return { service: 'agent', serviceKid: 'fixture-agent-kid', authenticationId: sockets.get(socket) };
  };
  const instanceAuthority = createAgentInstanceAuthority({ ledger, verifyTransportInState(_state, principal) {
    const socket = subjects.get(principal.authenticationId);
    if (!socket || socket.destroyed) throw Error('fixture-transport-closed');
    return { serviceId: 'agent', serviceKid: 'fixture-agent-kid', authenticationId: principal.authenticationId,
      channelBinding: instanceTlsBinding(socket) };
  } });
  const control = createAgentReadControl({ ledger, instanceAuthority,
    async authorizeRead(body) {
      const principalRef = await resolveDelegation(body.delegation);
      if (principalRef.projectId !== body.projectId) throw Error('project-mismatch');
      return accountAuthority.authorizePrincipal(principalRef, { projectId: body.projectId, action: 'read' });
    }, checkReadInState: conversationReadInState });
  const conversations = createConversationAuthority({ ledger, accountAuthority, checkConsent, verifySelectionSnapshot,
    runHooks: control.hooks, onFence: async input => {
      await control.waitCompletion(input); return { ...input, ack: true };
    } });
  const handlers = [
    createAgentInstanceInternalHandler({ instanceAuthority, agentFingerprint256: agentPin, resolveServicePrincipal }),
    createAgentReadControlHandler({ control, instanceAuthority, resolveServicePrincipal }),
    createConversationInternalHandler({ conversationAuthority: conversations, requireReadControl: true,
      agentFingerprint256: agentPin, resolveDelegation }),
  ];
  const server = https.createServer({ ...docTls, requestCert: true, rejectUnauthorized: true }, async (req, res) => {
    for (const handler of handlers) if (await handler(req, res)) return;
    res.writeHead(404); res.end();
  });
  server.on('connection', socket => { serverSockets.add(socket); socket.once('close', () => serverSockets.delete(socket)); });
  const options = { origin: `https://127.0.0.1:${port}`, tls: agentTls, serverFingerprint256: docPin };
  const client = createConversationClient(options), runClient = createRunClient(options);
  const readClient = createConversationControlClient({ ...options, runClient, receiptFile: path.join(directory, 'read-closures.sqlite') });
  client.useReadControl(readClient);
  return { conversations, control, client, runClient, readClient, server,
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      await readClient.start();
      const deadline = Date.now() + 5000;
      while (!readClient.describe().connected) {
        if (Date.now() >= deadline) throw Error('real-control-not-ready');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    },
    async close() {
      await readClient.close(); client.close(); runClient.close(); control.close();
      const closed = [...serverSockets].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); }));
      await Promise.all(closed);
      if (server.listening) await new Promise(resolve => server.close(resolve));
      instanceAuthority.close();
    } };
}
