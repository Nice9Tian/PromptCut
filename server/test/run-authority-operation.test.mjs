import test from 'node:test';
import assert from 'node:assert/strict';
import { runOperationFixture } from './run-authority-operation-fixture.mjs';
import { ask } from './fake-docservice-env.mjs';
import { stateBlobName } from '../docservice/modules/project.mjs';
const actual = { skip: !process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT && 'Actual accepted-message and active-order providers required', timeout: 15000 };
const open = (c, projectId) => ask(c, { type: 'project.open', projectId }, 10000);
const op = (c, projectId, opId, title = opId) => ask(c, { type: 'project.op', projectId, opId, ops: [{ op: 'set', path: '/title', value: title }] }, 10000);

test('real WS project.op with actual active proof after access TTL and password no-exit persists and broadcasts', actual, async t => {
  const f = await runOperationFixture(); t.after(() => f.close());
  const a = await f.connect(), b = await f.connect(); await open(a, f.projectId); await open(b, f.projectId);
  f.expireAccess(); f.change(false);
  const reply = await op(a, f.projectId, 'expired-active'); assert.equal(reply.type, 'project.op.ok'); assert.equal(reply.rev, 2);
  const broadcast = await b.next(m => m.type === 'project.ops'); assert.equal(broadcast.rev, 2);
  const accepted = f.history.accepted(f.projectId)[0]; assert.equal(accepted.witness.authorization.kind, 'active-run');
  assert.equal(accepted.witness.authorization.proof.messageRef.recordDigest, f.ledger.read().runGrantsV2[f.grant.runGrantId].messageRef.recordDigest);
  assert.equal(JSON.parse(f.store.readBlob(stateBlobName(f.projectId))).project.title, 'expired-active');
});

test('actual accepted FIFO message waiting past 120 seconds still admits/reads and commits through real WS', actual, async t => {
  const f = await runOperationFixture({ waitPastAccessExpiry: true }); t.after(() => f.close());
  assert.equal(f.grant.state, 'preparing');
  assert.equal(f.ledger.read().runGrantsV2[f.grant.runGrantId].state, 'active');
  assert.throws(() => f.credentials.verifyActorRef(f.actor), { code: 'credential-revoked' });
  const c = await f.connect(); await open(c, f.projectId);
  assert.equal((await op(c, f.projectId, 'waited-message')).type, 'project.op.ok');
  assert.equal(f.history.accepted(f.projectId)[0].witness.authorization.kind, 'active-run');
});

test('account exit in first active seal changes to retained using same real witness/prepared and no new op', actual, async t => {
  const attempts = []; let changed = false;
  const f = await runOperationFixture({ request(args, invoke, own) {
    if (args.path.endsWith('/seal')) {
      attempts.push({ witness: args.path, prepared: args.body.preparedDigest, request: args.body.requestId, active: !!args.body.activeRunProof, retained: !!args.body.retainedProof });
      if (!changed) { changed = true; own.change(true); }
    }
    return invoke(args);
  } }); t.after(() => f.close());
  const c = await f.connect(); await open(c, f.projectId);
  assert.equal((await op(c, f.projectId, 'exit-gap')).type, 'project.op.ok');
  assert.equal(attempts.length, 2); assert.deepEqual(attempts.map(a => [a.active, a.retained]), [[true, false], [false, true]]);
  assert.equal(attempts[0].witness, attempts[1].witness); assert.equal(attempts[0].prepared, attempts[1].prepared); assert.equal(attempts[0].request, attempts[1].request);
  assert.equal(f.history.accepted(f.projectId).length, 1); assert.equal(f.history.accepted(f.projectId)[0].witness.authorization.kind, 'retained');
});

for (const kind of ['private', 'stop']) test(`real ${kind} fence during active-401 recheck prevents retained seal and keeps original store`, actual, async t => {
  let changed = false, fenced = false, seals = 0;
  const f = await runOperationFixture({ request(args, invoke, own) {
    if (args.path.endsWith('/seal')) { seals++; if (!changed) { changed = true; own.change(true); } }
    return invoke(args);
  }, afterGate(value, own) {
    if (value.retainedGrant && !fenced) { fenced = true; own.control(kind); }
  } }); t.after(() => f.close());
  const c = await f.connect(); await open(c, f.projectId);
  c.send({ type: 'project.op', projectId: f.projectId, opId: `fenced-${kind}`, ops: [{ op: 'set', path: '/title', value: 'must-not-land' }] });
  await c.closed; await f.wiring.idle();
  assert.equal(fenced, true); assert.equal(c.all.some(m => m.type === 'project.op.ok'), false);
  assert.equal(seals, 1); assert.equal(f.history.accepted(f.projectId).length, 0);
  assert.equal(JSON.parse(f.store.readBlob(stateBlobName(f.projectId))).project.title, 'before');
});

test('explicit identical real project.op resumes reserved without new prepared; changed content cannot gain resume', actual, async t => {
  let denied = false, first;
  const f = await runOperationFixture({ request(args, invoke) {
    if (args.path.endsWith('/seal') && !denied) { denied = true; first = { path: args.path, digest: args.body.preparedDigest };
      throw Object.assign(new Error('credential-revoked'), { code: 'credential-revoked', status: 401 }); }
    if (args.path.endsWith('/seal')) { assert.equal(args.path, first.path); assert.equal(args.body.preparedDigest, first.digest); }
    return invoke(args);
  } }); t.after(() => f.close());
  const c = await f.connect(); await open(c, f.projectId);
  assert.notEqual((await op(c, f.projectId, 'retry')).type, 'project.op.ok');
  assert.equal(f.history.get(f.projectId, 'retry').state, 'reserved');
  const changed = await op(c, f.projectId, 'retry', 'different'); assert.equal(changed.reason, 'operation-id-mismatch');
  assert.equal(f.history.get(f.projectId, 'retry').state, 'reserved');
  f.expireAccess();
  await assert.rejects(f.wiring.execute({ projectId: f.projectId, principal: f.ordinaryPrincipal, actor: f.actor,
    request: { opId: 'retry', ops: [{ op: 'set', path: '/title', value: 'retry' }] } }, () => { throw new Error('must not prepare'); }), { code: 'credential-revoked' });
  assert.equal(f.history.get(f.projectId, 'retry').state, 'reserved');
  assert.equal((await op(c, f.projectId, 'retry')).type, 'project.op.ok');
  assert.equal(f.history.accepted(f.projectId).length, 1);
});
