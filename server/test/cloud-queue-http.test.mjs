import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createAgentHttp } from '../agent-service/http.mjs';
import { createAccountConversationService } from '../agent/service/conversation-policy.mjs';

// Pure protocol test: doc RPC is controlled here. The browser probe is the
// separate real-provider/mTLS/persistent-queue evidence, never this adapter.
test('account SSE publishes an independent queue snapshot and fresh read denial blocks fetched plaintext', async () => {
  let denied = false, revision = 2;
  const messages = [{ messageId: 'one', arrivalSeq: 1, content: 'first', senderAccountId: 'acc-a', senderNameAtSend: 'Alice', queueState: 'queued' },
    { messageId: 'two', arrivalSeq: 2, content: 'second', senderAccountId: 'acc-b', senderNameAtSend: 'Bob', queueState: 'queued' }];
  const client = Object.fromEntries(['identity','access','list','get','send','switchVisibility','stop','rename'].map(name => [name, async () => ({})]));
  client.get = async () => ({ id: 'conv', messages: structuredClone(messages), queueRevision: revision, aclRevision: 1, currentRunId: null });
  client.access = async () => { if (denied) throw Object.assign(Error('revoked'), { status: 403, code: 'not-listed' }); return { allowed: true, aclRevision: 1 }; };
  const service = createAccountConversationService({ conversationClient: client });
  const http = createAgentHttp({ service, authenticate: async () => ({ accountMode: true, projectId: 'project', accountId: 'acc-a', userId: 'acc-a', delegation: 'opaque' }) });
  let wire = '', ready; const seen = new Promise(resolve => { ready = resolve; });
  const res = new Writable({ write(chunk, _encoding, done) { wire += chunk; if (wire.includes('queue.state')) ready(); done(); } });
  res.writeHead = () => {}; res.flushHeaders = () => {};
  const req = new Readable({ read() {} }); req.url = '/v1/conversations/conv/events?after=0'; req.method = 'GET'; req.headers = {};
  const timeout = setTimeout(() => ready(), 3000);
  try {
    await http.handle(req, res); await seen;
    const events = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    assert.equal(events.filter(event => event.type === 'user').length, 2);
    const queue = events.find(event => event.type === 'queue.state'); assert.equal(queue.seq, undefined);
    assert.deepEqual(queue.items.map(item => [item.messageId, item.position]), [['one', 1], ['two', 2]]);
    // A later queue state for an already-seen row must arrive without resending user.
    messages[0].queueState = 'cancelled'; revision = 3;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(wire.includes('"queueRevision":3')); assert.equal((wire.match(/"type":"user"/g) ?? []).length, 2);
    denied = true; messages.push({ ...messages[1], messageId: 'forbidden', arrivalSeq: 4, content: 'must-not-publish' });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(wire.includes('must-not-publish'), false); assert.ok(wire.includes('access.revoked'));
    const info = await service.info({ accountMode: true, projectId: 'project', accountId: 'acc-a', delegation: 'opaque' });
    assert.equal(info.executorMounted, false);
  } finally { clearTimeout(timeout); res.destroy(); req.destroy(); service.close(); }
});
