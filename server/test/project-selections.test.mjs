import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocService } from '../docservice/service.mjs';
import { mountSelection } from '../docservice/modules/selection.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';

test('018 project selection provider over real WS: all pages, authority, revoke, offline snapshot', async t => {
  const active = new Set(['alice', 'bob', 'carol']);
  let failHead = false;
  const project = {
    revOf: id => id === 'p1' ? 7 : null,
    bodyOf: id => id === 'p1' ? { tracks: [{ id: 't1', clips: [{ id: 'c1', name: 'One' }, { id: 'c2', name: 'Two' }] }] } : null,
  };
  const selection = mountSelection({ project,
    checkAccess: async ({ principal, projectId }) => {
      if (failHead) throw Object.assign(new Error('head unavailable'), { status: 503 });
      return active.has(principal.accountId) && projectId === 'p1'
        ? { accountId: principal.accountId, projectId, accountName: `${principal.accountId}-trusted` } : false;
    },
    authorizeQuery: async ({ projectId, runGrantId }) => runGrantId === 'run1' && projectId === 'p1'
      ? { projectId, runGrantId, initiatorAccountId: 'alice', initiatorName: 'alice-trusted',
          selectionSnapshot: { source: 'sent-snapshot', projectId, accountId: 'alice', pageId: 'sent-page',
            selection: { clipIds: ['c2'] }, sentAt: 1000 } } : null,
    now: () => 2000,
  });
  const authenticate = req => {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const accountId = q.get('account');
    const service = q.get('service');
    return { userId: accountId ?? service ?? 'stranger', tenantId: q.get('project') ?? 'p1',
      ...(service ? { service } : { role: 'page', accountId, accountName: 'AUTH-INITIAL', loginId: q.get('login') ?? 'L1' }) };
  };
  const doc = createDocService({ modules: [selection], authenticate, autoTick: false, log: () => {} });
  const { port } = await doc.listen(5920, '127.0.0.1');
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.close();
    await doc.close();
  });
  let seq = 0;
  async function client(params) {
    const c = wsClient(`ws://127.0.0.1:${port}/?${new URLSearchParams(params)}`, ['promptcut.v1']);
    clients.push(c); await c.opened;
    return { c, ask: async msg => {
      const reqId = `sel${++seq}`;
      c.send({ ...msg, reqId });
      return c.next(reply => reply.reqId === reqId);
    } };
  }
  const a1 = await client({ account: 'alice' });
  const a2 = await client({ account: 'alice', login: 'L2' });
  const bob = await client({ account: 'bob' });
  const carol = await client({ account: 'carol' });
  const agent = await client({ service: 'agent' });
  const page = await client({ account: 'stranger' });
  const askQuery = () => agent.ask({ type: 'selection.query', projectId: 'p1', runGrantId: 'run1' });

  assert.equal((await a1.ask({ type: 'selection.set', projectId: 'p1', pageId: 'a1', revision: 1,
    username: 'forged', accountId: 'bob', selection: { clipIds: ['c1', 'gone'] } })).type, 'selection.ok');
  assert.equal((await a2.ask({ type: 'selection.set', projectId: 'p1', pageId: 'a2', revision: 1,
    selection: { clipIds: ['c2'] } })).type, 'selection.ok');
  assert.equal((await bob.ask({ type: 'selection.set', projectId: 'p1', pageId: 'b1', revision: 1,
    selection: { clipIds: ['c1'] } })).type, 'selection.ok');
  let state = await askQuery();
  assert.equal(state.type, 'selection.state');
  assert.equal(state.projectRev, 7);
  assert.deepEqual(state.members.map(m => m.accountId), ['alice', 'bob', 'carol']);
  assert.equal(state.members[0].displayName, 'alice-trusted（当前用户）');
  assert.deepEqual(state.members[0].pages.map(p => p.pageId), ['a1', 'a2']);
  assert.deepEqual(state.members[0].pages[0].items.map(i => [i.id, !!i.missing]), [['c1', false], ['gone', true]]);
  assert.deepEqual(state.members[2].pages[0].selection.clipIds, [], 'empty online page remains');
  assert.equal(state.members.some(m => m.username === 'forged'), false);

  assert.deepEqual([(await page.ask({ type: 'selection.query', projectId: 'p1', runGrantId: 'run1' })).reason,
    (await agent.ask({ type: 'selection.query', projectId: 'p2', runGrantId: 'run1' })).reason,
    (await agent.ask({ type: 'selection.query', projectId: 'p1', runGrantId: 'unknown' })).reason],
    ['forbidden', 'forbidden', 'run-grant-invalid']);
  assert.equal((await agent.ask({ type: 'selection.query', projectId: 'p1', runGrantId: 'run1',
    selectionSnapshot: { selection: { clipIds: ['c1'] } } })).reason, 'invalid-authority-claim');
  assert.equal((await bob.ask({ type: 'selection.set', projectId: 'p2', pageId: 'b1', revision: 2,
    selection: { clipIds: ['c1'] } })).reason, 'forbidden');

  assert.equal((await bob.ask({ type: 'selection.clear', projectId: 'p1', pageId: 'b1' })).type, 'selection.ok');
  state = await askQuery();
  assert.deepEqual(state.members[1].pages[0].selection.clipIds, []);
  selection.revoke({ projectId: 'p1', accountId: 'alice', loginId: 'L2' });
  state = await askQuery();
  assert.deepEqual(state.members[0].pages.map(p => p.pageId), ['a1']);
  assert.equal((await a2.ask({ type: 'selection.set', projectId: 'p1', pageId: 'a2', revision: 2,
    selection: { clipIds: ['c1'] } })).reason, 'connection-closed', 'revoked connection cannot reinsert even before upstream head moves');
  active.delete('alice');
  selection.revoke({ projectId: 'p1', accountId: 'alice' });
  assert.equal((await a1.ask({ type: 'selection.set', projectId: 'p1', pageId: 'a1', revision: 2,
    selection: { clipIds: ['c1'] } })).reason, 'forbidden');
  state = await askQuery();
  assert.deepEqual(state.members[0].pages.map(p => [p.pageId, p.live, p.note]),
    [['sent-page', false, '发消息时的选区，非实时']]);
  failHead = true;
  assert.equal((await askQuery()).reason, 'authority-unavailable', 'unreachable head fails closed');
  failHead = false;
  active.delete('carol');
  state = await askQuery();
  assert.equal(state.members.some(m => m.accountId === 'carol'), false, 'query evicts revoked page even before explicit revoke callback');
  bob.c.close();
  await waitFor(() => selection.describe().pages === 0, 3000, 'disconnect cleanup');
  state = await askQuery();
  assert.equal(state.members.some(m => m.accountId === 'bob'), false);
});
