import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudError, cloudConversationControlPolicy, createCloudApi, createCloudControlScopeGuard, requireAccountAbortControl, withCloudControlConsent } from './cloudApi.ts';

const conversation = (overrides = {}) => ({ id: 'conversation', projectId: 'project', ownerAccountId: 'alice',
  visibility: 'shared', creatorReadOnly: false, title: '对话', updatedAt: 10, state: 'idle', lastSeq: 0, ...overrides });
const activeQueue = { conversationId: 'conversation', queueRevision: 5, aclRevision: 2, currentRunId: 'run-alice',
  items: [{ messageId: 'message-alice', arrivalSeq: 4, state: 'running', position: null, runId: 'run-alice' }] };
const baseApi = fetchImpl => createCloudApi({ baseUrl: () => 'https://fixture.invalid/v1', projectId: () => 'project',
  ticket: async () => 'opaque-ticket', grant: async () => undefined, fetchImpl });

test('account conversation controls are owner/creator scoped and queued work is not represented as running', () => {
  const queued = { ...activeQueue, currentRunId: null,
    items: [{ messageId: 'm', arrivalSeq: 2, state: 'queued', position: 1, runId: null }] };
  const waiting = cloudConversationControlPolicy({ accountMode: true, accountId: 'alice', creator: false,
    conversation: conversation(), queue: queued, senders: {}, legacyStreaming: true });
  assert.equal(waiting.streaming, false);
  assert.equal(waiting.canStop, false);
  assert.equal(waiting.canSwitchVisibility, true);

  const owner = cloudConversationControlPolicy({ accountMode: true, accountId: 'alice', creator: false,
    conversation: conversation(), queue: activeQueue, senders: { 'cq-message-alice': { accountId: 'alice', name: 'Alice' } }, legacyStreaming: false });
  assert.equal(owner.streaming, true);
  assert.equal(owner.canStop, true);

  const other = cloudConversationControlPolicy({ accountMode: true, accountId: 'bob', creator: false,
    conversation: conversation(), queue: activeQueue, senders: { 'cq-message-alice': { accountId: 'alice', name: 'Alice' } }, legacyStreaming: false });
  assert.equal(other.canSwitchVisibility, false);
  assert.equal(other.canStop, false);

  const creatorReadOnly = cloudConversationControlPolicy({ accountMode: true, accountId: 'creator', creator: true,
    conversation: conversation({ ownerAccountId: 'alice', visibility: 'private', creatorReadOnly: true }), queue: activeQueue,
    senders: { 'cq-message-alice': { accountId: 'alice', name: 'Alice' } }, legacyStreaming: false });
  assert.equal(creatorReadOnly.canSend, false);
  assert.equal(creatorReadOnly.canSwitchVisibility, false);
  assert.equal(creatorReadOnly.canStop, true);
});

test('visibility and account stop use strict POST confirmations without cookies; legacy abort keeps its old empty body', async () => {
  const calls = [];
  const api = baseApi(async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/visibility')) return Response.json({ ok: true, v: 2, ...conversation({ visibility: 'private' }), aclRevision: 6 });
    if (String(url).endsWith('/abort')) return Response.json({ ok: true, runId: 'run-alice' });
    return Response.json({ ok: true });
  });
  const switched = await api.switchVisibility('conversation', 'private', 'request-switch');
  assert.equal(switched.visibility, 'private');
  await api.abort('conversation', { runId: 'run-alice', requestId: 'request-stop' });
  await api.abort('conversation');

  assert.equal(calls[0].url, 'https://fixture.invalid/v1/conversations/conversation/visibility');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.deepEqual(JSON.parse(calls[0].init.body), { visibility: 'private', requestId: 'request-switch' });
  assert.equal(calls[1].init.credentials, 'omit');
  assert.deepEqual(JSON.parse(calls[1].init.body), { runId: 'run-alice', requestId: 'request-stop' });
  assert.deepEqual(JSON.parse(calls[2].init.body), {});
});

test('fence pending remains an error, malformed success is rejected, and callers can retry the same request ID', async () => {
  let switchCount = 0;
  const api = baseApi(async (url, init) => {
    if (String(url).endsWith('/visibility')) {
      switchCount++;
      assert.deepEqual(JSON.parse(init.body), { visibility: 'private', requestId: 'stable-request' });
      return switchCount === 1
        ? Response.json({ ok: false, code: 'agent-fence-pending', message: 'pending' }, { status: 503 })
        : Response.json({ ok: true, v: 2, ...conversation({ visibility: 'private' }), aclRevision: 6 });
    }
    return Response.json({ ok: true });
  });
  await assert.rejects(api.switchVisibility('conversation', 'private', 'stable-request'), error =>
    error instanceof CloudError && error.status === 503 && error.code === 'agent-fence-pending');
  const result = await api.switchVisibility('conversation', 'private', 'stable-request');
  assert.equal(result.visibility, 'private');
  assert.equal(switchCount, 2);

  const malformed = baseApi(async () => Response.json({ ok: true, v: 2, ...conversation({ visibility: 'shared' }), aclRevision: 6 }));
  await assert.rejects(malformed.switchVisibility('conversation', 'private', 'bad-response'), error => error instanceof CloudError);
});


test('late control response cannot mutate state after an account/project A-B-A scope change', async () => {
  const guard = createCloudControlScopeGuard();
  const first = guard.update('alice:project-one:consent-7', 'same-conversation');
  let releaseOld;
  const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  const visible = { pending: 'old-request', note: 'waiting' };
  const oldControl = oldResponse.then(() => {
    if (!guard.isCurrent(first)) return false;
    visible.pending = null;
    visible.note = 'old scope succeeded';
    return true;
  });

  guard.update('bob:project-two:consent-8', 'same-conversation');
  const current = guard.update('alice:project-one:consent-7', 'same-conversation');
  visible.pending = 'new-request';
  visible.note = 'new scope waiting';
  releaseOld();

  assert.equal(await oldControl, false);
  assert.equal(guard.isCurrent(current), true);
  assert.deepEqual(visible, { pending: 'new-request', note: 'new scope waiting' });
});


test('late consent in an A-B-A identity change never submits the old visibility request', async () => {
  const guard = createCloudControlScopeGuard();
  const first = guard.update('alice:project-one:binding-7', 'same-conversation');
  let releaseConsent;
  const consent = new Promise(resolve => { releaseConsent = resolve; });
  let submitted = 0;
  const operation = withCloudControlConsent(() => consent, () => guard.isCurrent(first), async () => { submitted++; });

  guard.update('bob:project-two:binding-8', 'same-conversation');
  guard.update('alice:project-one:binding-7', 'same-conversation');
  releaseConsent();
  await assert.rejects(operation, error => error instanceof CloudError && error.status === 403);
  assert.equal(submitted, 0);
});


test('account stop rejects missing current run/request IDs instead of falling back to an empty legacy abort', () => {
  assert.throws(() => requireAccountAbortControl(), error => error instanceof CloudError && error.status === 403);
  assert.throws(() => requireAccountAbortControl('run-current'), error => error instanceof CloudError && error.status === 403);
  assert.deepEqual(requireAccountAbortControl('run-current', 'request-current'),
    { runId: 'run-current', requestId: 'request-current' });
});
