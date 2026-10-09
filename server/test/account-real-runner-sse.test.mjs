import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAgentHttp } from '../agent-service/http.mjs';
import { createConversationTransports } from '../agent/service/conversation-transports.mjs';

// Real req/res/TCP/ALS ownership; the conversation projection is controlled.
// No account/provider/instance proof is claimed by this narrow timer regression.
test('actual SSE normal polls survive; synchronous fenced dispatch is supervised and closes owned response/socket',
  { timeout: 5000 }, async () => {
    const transports = createConversationTransports({ instanceIdentity: () => ({ instanceId: 'timer-instance', instanceGeneration: 1 }) });
    transports.ready(); let calls = 0, revoked = false, closeWork;
    const projection = { id: 'timer-conversation', projectId: 'timer-project', aclRevision: 1, queueRevision: 0, messages: [] };
    const read = value => transports.read(async () => ({ value, readHandle: {
      readHandleId: transports.current().readHandleId, instanceId: 'timer-instance', instanceGeneration: 1 } }));
    const service = { accountMode: true, readTransports: { run: (...args) => transports.run(...args), dispatch(callback) {
      calls++;
      if (revoked) { closeWork = transports.disconnect(); return transports.dispatch(callback); }
      return transports.dispatch(callback);
    } }, conversation: () => read(projection), access: () => read({ allowed: true, aclRevision: 1 }), onRevoke: () => () => {} };
    const api = createAgentHttp({ service, authenticate: async () => ({ accountMode: true, accountId: 'timer-account',
      userId: 'timer-account', projectId: 'timer-project' }) });
    const sockets = new Set(); const server = http.createServer((req, res) => { void api.handle(req, res); });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    let request, response, responseClosed = false, socketClosed = false;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(6707, '127.0.0.1', resolve); });
      response = await new Promise((resolve, reject) => {
        request = http.get('http://127.0.0.1:6707/v1/conversations/timer-conversation/events', resolve);
        request.once('error', reject);
      });
      assert.equal(response.statusCode, 200); response.on('error', () => {}); response.resume();
      const closed = new Promise(resolve => response.once('close', () => { responseClosed = true; resolve(); }));
      const socket = request.socket; const socketDone = new Promise(resolve => socket.once('close', () => { socketClosed = true; resolve(); }));
      while (calls < 3) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(response.destroyed, false, 'normal authorized timer polls remain open');
      revoked = true; await closed; await socketDone; await closeWork;
      assert.equal(responseClosed && socketClosed, true); assert.equal(transports.describe().open, 0);
    } finally {
      request?.destroy(); response?.destroy(); for (const socket of sockets) socket.destroy();
      await transports.close(); if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  });
