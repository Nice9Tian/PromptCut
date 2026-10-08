import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runFixture, projectId, conversationId } from './run-authority-fixture.mjs';

async function fixture(t, options) {
  const f = await runFixture(options); t.after(() => { f.close(); fs.rmSync(f.dir, { recursive: true }); }); return f;
}
async function call(f, process, operation, input) {
  const auth = f.instances.authorize(process, operation, input);
  const actual = input.principal ? { ...input, principal: { ...input.principal, servicePrincipal: auth.principal } }
    : { ...input, servicePrincipal: auth.principal };
  try { return await f.rawProvider[operation](actual); }
  finally { f.instances.authority.release(auth.principal.instanceSession); }
}

test('all run entry points bind the immutable registered instance; a new same-certificate process cannot inherit ACKs', async t => {
  const f = await fixture(t); f.enqueue(); const g = await f.admit(); const read = f.input(g);
  await f.provider.confirmRead(read); const principal = await f.principal(g), next = f.instances.boot();
  assert.equal(g.instanceId, f.agentProcess.registration.instanceId);
  assert.equal(f.ledger.read().runReceiptsV2[f.ledger.read().runGrantsV2[g.runGrantId].readReceiptId].instanceId, g.instanceId);
  const cases = [
    ['confirmRead', read], ['queryRead', read], ['finish', { ...read, requestId: 'finish-new' }],
    ['resolveRunPrincipal', { projectId, runGrantId: g.runGrantId }],
    ['checkAccess', { principal, projectId, action: 'write' }],
    ['authorizeQuery', { principal, projectId, runGrantId: g.runGrantId }],
  ];
  for (const [op, input] of cases) await assert.rejects(call(f, next, op, input), /run-instance-mismatch/);
  await assert.rejects(call(f, next, 'admit', { projectId, conversationId, requestId: 'admit1' }), /run-not-ready/);
  assert.equal(Object.keys(f.ledger.read().runGrantsV2).length, 1);
});

test('resolve/read capability cannot authorize check/write; missing/forged instance fields are denied', async t => {
  const f = await fixture(t); f.enqueue(); const g = await f.admit(); await f.provider.confirmRead(f.input(g));
  const resolve = { projectId, runGrantId: g.runGrantId };
  const auth = f.instances.authorize(f.agentProcess, 'resolveRunPrincipal', resolve);
  const principal = await f.rawProvider.resolveRunPrincipal({ ...resolve, servicePrincipal: auth.principal });
  await assert.rejects(f.rawProvider.checkAccess({ principal, projectId, action: 'write' }), /instance-invocation-forbidden/);
  const input = { principal, projectId, action: 'write' };
  const write = f.instances.authorize(f.agentProcess, 'checkAccess', input);
  const withCap = { ...principal, servicePrincipal: write.principal };
  assert.equal((await f.rawProvider.checkAccess({ ...input, principal: withCap })).allowed, true);
  for (const delta of [{ instanceId: 'forged' }, { instanceGeneration: 0 }, { instanceSession: undefined }])
    await assert.rejects(f.rawProvider.checkAccess({ ...input, principal: { ...withCap,
      servicePrincipal: { ...write.principal, ...delta } } }), /instance-invocation-forbidden/);
  await assert.rejects(f.rawProvider.checkAccess({ ...input, principal: { ...withCap, instanceGeneration: 0 } }), /run-principal-mismatch/);
});

test('instance fence and grant revoke share a SQLite commit; queued work remains available to a new instance without reviving the old run', async t => {
  const f = await fixture(t); f.enqueue(); f.enqueue('queued-other', 'other'); const g = await f.admit();
  await f.provider.confirmRead(f.input(g));
  const control = f.provider.fenceInstance({ ...f.agentProcess.registration, requestId: 'terminate-instance', reason: 'shutdown', projectId: 'wrong-filter' });
  const state = f.ledger.read(); assert.equal(state.agentInstancesV2[g.instanceId].state, 'fenced');
  assert.equal(state.runGrantsV2[g.runGrantId].state, 'revoked'); assert.equal(control.state, 'pending');
  assert.equal(control.instances[0].instanceId, g.instanceId); assert.equal(control.operationFences[0].runIds[0], g.runId);
  await assert.rejects(f.principal(g), /instance-revoked/);
  const next = f.instances.boot();
  const other = await call(f, next, 'admit', { projectId, conversationId, requestId: 'next' });
  assert.equal(other.messageId, 'queued-other'); assert.equal(other.instanceId, next.registration.instanceId);
  assert.notEqual(other.runId, g.runId); assert.equal(state.agentInstancesV2[g.instanceId].closure, null);
});

test('instance revoked during asynchronous credential verification cannot commit admission', async t => {
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const f = await fixture(t, { verifySender: async ref => { entered.resolve(); await resume.promise; return { ...ref, accountEventSeq: 0 }; } });
  f.enqueue(); const pending = f.admit(); await entered.promise;
  const control = f.provider.fenceInstance({ ...f.agentProcess.registration, requestId: 'stop-during-admit', reason: 'shutdown' }); resume.resolve();
  await assert.rejects(pending, /instance-revoked/);
  assert.equal(Object.keys(f.ledger.read().runGrantsV2).length, 0);
  assert.equal(f.ledger.read().conversationsV2[projectId][conversationId].messages[0].queueState, 'queued');
  assert.equal(control.state, 'pending'); assert.equal(control.instances.length, 1);
  assert.equal(control.instances[0].instanceId, f.agentProcess.registration.instanceId);
  assert.equal(f.ledger.read().agentInstancesV2[control.instances[0].instanceId].closure, null);
});
