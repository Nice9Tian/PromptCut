import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runFixture, projectId, conversationId } from './run-authority-fixture.mjs';
import { createToolRunContextAccess } from '../agent/service/tool-context.mjs';

async function fixture(t) {
  const f = await runFixture();
  t.after(() => { f.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  return f;
}

function controlledAuthorityClient(f, grant, { denyWrite = false, unavailable = false } = {}) {
  const calls = [];
  return {
    calls,
    instanceIdentity: () => ({ ...f.agentProcess.registration }),
    async checkAccess({ projectId: requestedProjectId, runGrantId, action }) {
      calls.push({ projectId: requestedProjectId, runGrantId, action });
      if (unavailable) throw new Error('controlled transport unavailable');
      if (requestedProjectId !== grant.projectId || runGrantId !== grant.runGrantId)
        throw Object.assign(new Error('run binding denied'), { status: 403, code: 'run-binding-mismatch' });
      if (denyWrite && action === 'write')
        throw Object.assign(new Error('controlled read-only context'), { status: 403, code: 'read-only' });
      const principal = await f.principal(grant);
      return f.provider.checkAccess({ principal, projectId: requestedProjectId, action });
    },
  };
}

async function confirmedGrant(f) {
  f.enqueue();
  const grant = await f.admit();
  await f.provider.confirmRead(f.input(grant));
  return grant;
}

test('context comes only from a real SQLite runAuthority read-confirmed grant and current registered instance', async t => {
  const f = await fixture(t);
  f.enqueue();
  const grant = await f.admit();
  const runClient = controlledAuthorityClient(f, grant);
  const access = createToolRunContextAccess({ runClient });
  await assert.rejects(access.fromGrant({ projectId, runGrantId: grant.runGrantId }), { code: 'run-access-denied' },
    'a preparing grant without a read receipt cannot produce a tool context');

  await f.provider.confirmRead(f.input(grant));
  const context = await access.fromGrant({ projectId, runGrantId: grant.runGrantId });
  assert.deepEqual(context, {
    projectId, conversationId, runId: grant.runId, runGrantId: grant.runGrantId,
    instanceId: f.agentProcess.registration.instanceId,
    instanceGeneration: f.agentProcess.registration.instanceGeneration,
    senderAccountId: grant.accountId, messageId: grant.messageId,
  });
  assert.equal(Object.isFrozen(context), true);
  assert.deepEqual(runClient.calls.map(call => call.action), ['read', 'read']);
});

test('every read and write authorization is delegated to current SQLite authority and returns its active fence', async t => {
  const f = await fixture(t);
  const grant = await confirmedGrant(f);
  const runClient = controlledAuthorityClient(f, grant);
  const access = createToolRunContextAccess({ runClient });
  const context = await access.fromGrant({ projectId, runGrantId: grant.runGrantId });

  const read = await access.authorize(context, 'read');
  const write = await access.authorize(context, 'write');
  assert.equal(read.allowed, true);
  assert.equal(read.grantState, 'active');
  assert.equal(Number.isSafeInteger(read.fenceRevision), true);
  assert.deepEqual(write, { allowed: true, fenceRevision: read.fenceRevision, grantState: 'active' });
  assert.ok(read.fenceRevision > grant.fenceRevision, 'the current fence comes from the post-read-confirmation authority record');
  assert.deepEqual(runClient.calls.map(call => call.action), ['read', 'read', 'write']);

  f.exit();
  const retained = await access.authorize(context, 'write');
  assert.equal(retained.allowed, true);
  assert.equal(retained.grantState, 'retained', 'retained write semantics come from the real authority response');
  assert.deepEqual(runClient.calls.map(call => call.action), ['read', 'read', 'write', 'write']);
});

test('a controlled read-only RunClient response permits read and refuses write without an adapter-side upgrade', async t => {
  const f = await fixture(t);
  const grant = await confirmedGrant(f);
  const runClient = controlledAuthorityClient(f, grant, { denyWrite: true });
  const access = createToolRunContextAccess({ runClient });
  const context = await access.fromGrant({ projectId, runGrantId: grant.runGrantId });

  assert.equal((await access.authorize(context, 'read')).allowed, true);
  await assert.rejects(access.authorize(context, 'write'), { code: 'run-access-denied' });
  assert.deepEqual(runClient.calls.map(call => call.action), ['read', 'read', 'write']);
});

test('foreign, altered or arbitrary context and a changed instance registration fail closed', async t => {
  const f = await fixture(t);
  const grant = await confirmedGrant(f);
  const runClient = controlledAuthorityClient(f, grant);
  const access = createToolRunContextAccess({ runClient });
  const context = await access.fromGrant({ projectId, runGrantId: grant.runGrantId });
  const callsBefore = runClient.calls.length;

  await assert.rejects(access.fromGrant({ projectId, runGrantId: grant.runGrantId, senderAccountId: grant.accountId }),
    { code: 'tool-grant-locator-invalid' });
  await assert.rejects(access.fromGrant({ projectId, runGrantId: 'grant_other' }), { code: 'run-access-denied' });
  await assert.rejects(access.authorize({ ...context, runGrantId: 'grant_other' }, 'read'), { code: 'tool-context-untrusted' });
  await assert.rejects(access.authorize({ ...context, username: 'cached-name' }, 'read'), { code: 'tool-context-untrusted' });
  await assert.rejects(access.authorize(context, 'admin'), { code: 'tool-action-invalid' });
  assert.equal(runClient.calls.length, callsBefore + 1, 'only the untrusted locator reached the controlled runClient');

  const originalIdentity = runClient.instanceIdentity;
  runClient.instanceIdentity = () => ({ ...originalIdentity(), instanceGeneration: grant.instanceGeneration + 1 });
  await assert.rejects(access.authorize(context, 'read'), { code: 'tool-instance-changed' });
  runClient.instanceIdentity = originalIdentity;

  const originalCheckAccess = runClient.checkAccess;
  runClient.checkAccess = async request => {
    const result = await originalCheckAccess(request);
    runClient.instanceIdentity = () => ({ ...originalIdentity(), instanceGeneration: grant.instanceGeneration + 1 });
    return result;
  };
  await assert.rejects(access.authorize(context, 'read'), { code: 'tool-instance-changed' },
    'registration changes during the authority call cannot authorize a stale context');
  runClient.instanceIdentity = originalIdentity;
});

test('authority transport failure is not replaced with cached context authorization', async t => {
  const f = await fixture(t);
  const grant = await confirmedGrant(f);
  const runClient = controlledAuthorityClient(f, grant);
  const access = createToolRunContextAccess({ runClient });
  const context = await access.fromGrant({ projectId, runGrantId: grant.runGrantId });

  runClient.checkAccess = async () => { throw new Error('controlled transport unavailable'); };
  await assert.rejects(access.authorize(context, 'read'), { code: 'run-authority-unavailable' });
});
