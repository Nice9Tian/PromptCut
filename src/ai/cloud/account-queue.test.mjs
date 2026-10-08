import test from 'node:test';
import assert from 'node:assert/strict';
import { accountCloudIdentity } from './identity.ts';
import { applyCloudEvent, queueSnapshot } from './events.ts';
import { createCloudApi } from './cloudApi.ts';
import { createCloudSession } from './session.ts';

const user = { type: 'user', seq: 2, messageId: 'msg-one', prompt: 'hello', senderAccountId: 'acc-alice', senderNameAtSend: 'Alice', queueState: 'queued' };
const snapshot = { type: 'queue.state', conversationId: 'conversation', queueRevision: 2, aclRevision: 1, currentRunId: null,
  items: [{ messageId: 'msg-one', arrivalSeq: 2, state: 'queued', position: 1, runId: null }] };
const memStore = () => { let value = []; const listeners = new Set(); return { get: () => value,
  set(next) { value = typeof next === 'function' ? next(value) : next; listeners.forEach(fn => fn()); },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } }; };

test('account delegate rechecks binding after an outstanding session refresh; no legacy grant', async () => {
  let current = true, resolve;
  const provider = accountCloudIdentity({ projectId: 'project', isCurrent: () => current,
    session: () => new Promise(done => { resolve = done; }) });
  const pending = provider.getTicket(); current = false;
  resolve({ projectId: 'project', agentDelegationTicket: 'd'.repeat(43) });
  await assert.rejects(pending, { code: 'no-identity' });
  assert.equal(provider.getGrant, undefined);
});

test('persistent user without run ID renders exactly once and never fabricates an assistant', () => {
  const messages = applyCloudEvent([], user);
  assert.deepEqual(messages, [{ id: 'cq-msg-one', role: 'user', text: 'hello' }]);
  assert.equal(applyCloudEvent(messages, user), messages);
});

test('queue validates project conversation, FIFO order, unique IDs and separate revision', () => {
  assert.equal(queueSnapshot(snapshot, 'other'), null);
  assert.equal(queueSnapshot({ ...snapshot, items: [...snapshot.items, ...snapshot.items] }, 'conversation'), null);
  assert.equal(queueSnapshot({ ...snapshot, items: [{ ...snapshot.items[0], position: 2 }] }, 'conversation'), null);
  assert.equal(queueSnapshot({ ...snapshot, items: [{ ...snapshot.items[0], state: 'running' }] }, 'conversation'), null);
  assert.equal(queueSnapshot(snapshot, 'conversation').items[0].position, 1);
});

test('actual account 202 retains message, position and no-run; cookies omitted and reference untouched', async () => {
  let wire;
  const api = createCloudApi({ baseUrl: () => 'https://fixture.invalid/v1', projectId: () => 'project', ticket: () => 'opaque', grant: () => undefined,
    fetchImpl: async (_, init) => { wire = init; return new Response(JSON.stringify({ messageId: 'msg-one', runId: null,
      seq: 2, queuePosition: 1, queueRevision: 2, conversation: { id: 'conversation', projectId: 'project' } }), { status: 202 }); } });
  const result = await api.send('conversation', { prompt: 'hello', requestId: 'req-one', selectionSnapshot: { pageId: 'authenticated-page' } });
  assert.equal(result.runId, null); assert.equal(result.messageId, 'msg-one'); assert.equal(result.queuePosition, 1);
  assert.equal(wire.credentials, 'omit'); assert.equal(JSON.parse(wire.body).grant, undefined);
  assert.deepEqual(JSON.parse(wire.body).selectionSnapshot, { pageId: 'authenticated-page' });
});

test('account acceptance from another project or a missing current binding is refused', async () => {
  for (const current of ['project', null]) {
    const api = createCloudApi({ baseUrl: () => 'https://fixture.invalid/v1', projectId: () => current,
      ticket: () => 'opaque', grant: () => undefined, fetchImpl: async () => new Response(JSON.stringify({
        messageId: 'msg-one', runId: null, seq: 2, queuePosition: 1, queueRevision: 2,
        conversation: { id: 'conversation', projectId: 'other-project' },
      }), { status: 202 }) });
    await assert.rejects(api.send('conversation', { prompt: 'hello' }), { code: 'unavailable', status: 503 });
  }
});

test('session sees queued sender, ignores old queue revisions and clears private content after access refusal', async () => {
  const store = memStore(); let end;
  const api = { send: async () => ({ runId: null, seq: 2, messageId: 'msg-one' }), abort: async () => {},
    async *events(_id, _after, signal) {
      yield user; yield snapshot; yield { ...snapshot, queueRevision: 1, items: [] };
      await new Promise(resolve => { end = resolve; signal.addEventListener('abort', resolve, { once: true }); });
      yield { type: 'access.revoked' };
    } };
  const session = createCloudSession({ api, store }); session.open('conversation');
  try {
    for (let i = 0; i < 30 && !end; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(session.getView().queue.queueRevision, 2);
    assert.equal(session.getView().senders['cq-msg-one'].name, 'Alice');
    assert.equal(session.getView().streaming, false);
    end(); await new Promise(resolve => setTimeout(resolve, 1));
    assert.deepEqual(store.get(), []); assert.equal(session.getView().queue, null);
  } finally { session.close(); }
});
