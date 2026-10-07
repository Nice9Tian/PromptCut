import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture, actor, actorNew, actorOther, spec, keys, accountFixture } from './password-order-fixture.mjs';
import { passwordCandidates } from '../account/password-order.mjs';
import { itemKey } from '../docservice/modules/operation-history.mjs';

// Keep isolated fault databases in TEMP for evidence; all handles close in each test's own hook.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pc-order-'));
test('password-order exact acceptance: complete prepared, signed seal, accepted fsync, same materialization, duplicate stable', async (t) => {
  const f = await fixture({ dir: tmp(t) }); t.after(() => f.close());
  const input = spec('one'); const result = await f.coordinator.submit(input);
  assert.equal(result.state, 'materialized'); assert.equal(f.history.snapshot('project-one').value.title, 'one');
  assert.deepEqual((await f.coordinator.submit(input)), result);
  assert.deepEqual(f.history.journal('project-one').map((row) => row.kind), ['prepared-op', 'reserved-op', 'accepted-op', 'materialized-op']);
  await assert.rejects(f.coordinator.submit({ ...input, result: { altered: true } }), { code: 'operation-id-mismatch' });
});
test('password-order reserve/password/seal gap uses seal sequence, not clock or reservation', async (t) => {
  let event; const dir = tmp(t); const pair = keys(); const account = await accountFixture({ dir, pair }); t.after(() => account.close());
  let changed = false;
  const f = await fixture({ dir, pair, account, request: async (args, invoke) => {
    const result = await invoke(args);
    if (args.path.endsWith('/reserve') && !changed) { changed = true; event = account.change(); }
    return result;
  } }); t.after(() => f.close());
  const op = await f.coordinator.submit(spec('gap'));
  assert.ok(op.witness.orderSeq > (event.changeSeq ?? event.change_seq));
  const candidates = passwordCandidates({ event: { ...event, choice: 'exit', endOrderSeq: op.witness.orderSeq }, operations: [op], projectId: 'project-one' });
  assert.deepEqual(candidates.candidates, ['gap']);
});
test('password-order lost seal ACK queries the same witness and never prepares or executes twice', async (t) => {
  let lose = true; const f = await fixture({ dir: tmp(t), request: async (args, invoke) => {
    const result = await invoke(args); if (args.path.endsWith('/seal') && lose) { lose = false; throw new Error('lost ACK'); } return result;
  } }); t.after(() => f.close());
  await assert.rejects(f.coordinator.submit(spec('ack')), /lost ACK/);
  assert.equal(f.history.snapshot('project-one').projectRev, 0);
  await f.coordinator.recover('project-one');
  assert.equal(f.history.snapshot('project-one').projectRev, 1);
  assert.equal(f.history.journal('project-one').filter((row) => row.kind === 'prepared-op').length, 1);
  assert.equal(f.history.accepted('project-one').length, 1);
});
test('password-order fence while reserve waits cancels unaccepted operation; another project continues', async (t) => {
  let release; let reached; const waiting = new Promise((r) => { reached = r; }); const pause = new Promise((r) => { release = r; });
  const principal = { ...actor, runGrantId: 'grant', runId: 'run', messageId: 'message', conversationId: 'conversation' };
  const f = await fixture({ dir: tmp(t), request: async (args, invoke) => {
    const result = await invoke(args); if (args.path.endsWith('/reserve') && args.body.opId === 'paused') { reached(); await pause; } return result;
  } }); t.after(() => f.close());
  const submit = f.coordinator.submit(spec('paused', { principal })); const failed = assert.rejects(submit, { code: 'operation-fenced' });
  await waiting;
  const fence = f.coordinator.fence({ id: 'private', projectId: 'project-one', kind: 'private', conversationId: 'conversation', ownerAccountId: actorOther.accountId });
  const other = await f.coordinator.submit(spec('other-project', { projectId: 'project-two' })); assert.equal(other.state, 'materialized');
  release(); await failed; const result = await fence;
  assert.equal(result.complete, false, 'No durable service ACK is not completion');
  assert.equal(f.history.snapshot('project-one').projectRev, 0);
  assert.equal(f.history.get('project-one', 'paused').state, 'cancelled');
  await assert.rejects(f.coordinator.submit(spec('late', { principal })), { code: 'operation-fenced' });
});
test('password-order seal ACK lost before stop: settle exact accepted operation, then commit stop', async (t) => {
  let lose = true;
  const principal = { ...actor, runGrantId: 'grant', runId: 'run', messageId: 'message', conversationId: 'conversation' };
  const f = await fixture({ dir: tmp(t), request: async (args, invoke) => { const result = await invoke(args); if (args.path.endsWith('/seal') && lose) { lose = false; throw new Error('ACK lost'); } return result; }, acknowledgeFence: async () => ({ durable: true }) }); t.after(() => f.close());
  await assert.rejects(f.coordinator.submit(spec('accepted-before-stop', { principal })), /ACK lost/);
  assert.equal((await f.coordinator.fence({ id: 'stop', projectId: 'project-one', kind: 'stop', runId: 'run' })).complete, true);
  const kinds = f.history.journal('project-one').map((row) => row.kind);
  assert.ok(kinds.indexOf('materialized-op') < kinds.indexOf('fence-committed'));
  await assert.rejects(f.coordinator.submit(spec('late', { expectedRev: 1, principal })), { code: 'operation-fenced' });
});
test('password-order history stable IDs, complete before/after, structure dependencies, equal write evidence survives checkpoint', async (t) => {
  const f = await fixture({ dir: tmp(t) }); t.after(() => f.close());
  await f.coordinator.submit(spec('change-x', { ops: [{ op: 'set', path: '/clips/@clip~1a/x', value: 7 }] }));
  await f.coordinator.submit(spec('other-same-value', { expectedRev: 1, principal: actorOther, ops: [{ op: 'set', path: '/clips/@clip~1a/x', value: 7 }] }));
  await f.coordinator.submit(spec('move', { expectedRev: 2, ops: [{ op: 'move', path: '/clips/@clip~1a', index: 1 }, { op: 'set', path: '/cardSource', value: 'complete source bytes' }] }));
  const records = f.history.accepted('project-one'); f.history.checkpoint();
  assert.deepEqual(f.history.accepted('project-one'), records);
  const key = itemKey('/clips/@clip~1a/x');
  const first = records[0].changes.find((c) => c.itemKey === key); const second = records[1].changes.find((c) => c.itemKey === key);
  assert.deepEqual(first.before, { present: true, value: 1 }); assert.deepEqual(first.after, { present: true, value: 7 });
  assert.equal(second.beforeVersion, first.afterVersion); assert.notEqual(second.afterVersion, first.afterVersion);
  assert.equal(records[1].actor.accountId, actorOther.accountId);
  assert.ok(records[2].changes.some((c) => c.kind === 'structure' && c.path === '/clips'));
  assert.ok(records[0].dependencies.some((d) => d.itemKey === itemKey('/clips', 'structure')));
});
test('password-order bad signature or digest never changes visible state', async (t) => {
  for (const corrupt of [(w) => ({ ...w, signature: 'invalid' }), (w) => ({ ...w, preparedDigest: 'f'.repeat(64) })]) {
    const f = await fixture({ dir: tmp(t), request: async (args, invoke) => { const value = await invoke(args); return args.path.endsWith('/seal') ? corrupt(value) : value; } });
    try { await assert.rejects(f.coordinator.submit(spec('bad')), { code: 'bad-witness' }); assert.equal(f.history.snapshot('project-one').projectRev, 0); }
    finally { f.close(); }
  }
});
