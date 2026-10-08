import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createToolJobs } from '../agent/service/tool-jobs.mjs';
import { createRunResources } from '../agent/service/run-resources.mjs';
import { runFixture, projectId, conversationId, servicePrincipal } from './run-authority-fixture.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const fails = code => error => error?.code === code;

async function fixture(t, { member = false, revokeDuringCheckpoint = false } = {}) {
  const authority = await runFixture(); authority.enqueue();
  const grant = await authority.admit(); await authority.provider.confirmRead(authority.input(grant));
  const runClient = {
    registerInstance: async () => authority.agentProcess.registration,
    instanceIdentity: () => authority.agentProcess.registration,
    async checkAccess({ projectId: p, runGrantId, action }) {
      const principal = await authority.provider.resolveRunPrincipal({ servicePrincipal, projectId: p, runGrantId });
      return authority.provider.checkAccess({ principal, projectId: p, action });
    },
  };
  const resources = createRunResources({ runClient });
  const context = await resources.contextFor({ projectId, runGrantId: grant.runGrantId });
  let revokeOnNext = false;
  const authorize = async (ctx, action) => {
    const result = await resources.authorize(ctx, action);
    if (revokeOnNext) { revokeOnNext = false; authority.privateFence(); }
    return result;
  };
  const jobs = createToolJobs({ databasePath: path.join(authority.dir, 'tool-jobs.db'),
    authorize, verifyFence: (ctx, revision) => resources.verifyFence(ctx, revision) });
  t.after(async () => { await jobs.close(); await resources.close(); authority.close(); fs.rmSync(authority.dir, { recursive: true, force: true }); });
  const started = await jobs.start(context, 'media.probe', digest('full input'), 'request_retained_1');
  await jobs.update(context, started.jobId, 0, { state: 'running', stage: 'probe', progress: 0.2 });
  const before = await jobs.get(context, started.jobId);
  const oldFence = before.fenceRevision;
  if (member) await authority.provider.fence({ kind: 'member', projectId, accountIds: ['sender'], requestId: 'member-retain' });
  else authority.provider.applyAccessEvent(authority.exit());
  assert.equal(authority.ledger.read().runGrantsV2[grant.runGrantId].state, 'retained');
  revokeOnNext = revokeDuringCheckpoint;
  return { authority, resources, jobs, context, grant, started, oldFence, before };
}

for (const member of [false, true]) test(`real SQLite ${member ? 'member' : 'credential'} retained run checkpoints exact job fence`, async t => {
  const f = await fixture(t, { member });
  const { jobs, context, started, oldFence } = f;
  await assert.rejects(jobs.update(context, started.jobId, 1, { progress: 0.3 }), fails('job-scope-mismatch'));
  await assert.rejects(jobs.start(context, 'media.probe', digest('full input'), 'request_retained_1'), fails('job-scope-mismatch'));
  const retained = await jobs.checkpointRetained(context, started.jobId, 1);
  assert.equal(retained.revision, 2);
  assert.equal(retained.fenceRevision > oldFence, true);
  assert.equal(retained.grantState, 'retained');
  assert.equal((await jobs.start(context, 'media.probe', digest('full input'), 'request_retained_1')).jobId, started.jobId);
  await assert.rejects(jobs.checkpointRetained(context, started.jobId, 1), fails('stale-revision'));
  await assert.rejects(jobs.checkpointRetained({ ...context, senderAccountId: 'forged' }, started.jobId, 2), fails('authorization-unavailable'));
  await jobs.update(context, started.jobId, 2, { state: 'done', progress: 1 });
  assert.equal((await jobs.get(context, started.jobId)).state, 'done');
});

test('unknown pre-marker row cannot silently migrate to retained', async t => {
  const f = await fixture(t);
  const raw = new DatabaseSync(path.join(f.authority.dir, 'tool-jobs.db'));
  try { raw.prepare('DELETE FROM tool_job_grant_states WHERE job_id=?').run(f.started.jobId); }
  finally { raw.close(); }
  await assert.rejects(f.jobs.checkpointRetained(f.context, f.started.jobId, 1), fails('retained-checkpoint-denied'));
  const check = new DatabaseSync(path.join(f.authority.dir, 'tool-jobs.db'), { readOnly: true });
  try { const row = check.prepare('SELECT revision, fence_revision FROM tool_jobs WHERE job_id=?').get(f.started.jobId);
    assert.equal(row.revision, 1); assert.equal(row.fence_revision, f.oldFence); }
  finally { check.close(); }
});

for (const kind of ['private', 'stop', 'agent-disabled']) test(`${kind} revokes retained job before any further checkpoint or output`, async t => {
  const f = await fixture(t);
  if (kind === 'private') f.authority.privateFence();
  else await f.authority.provider.fence({ kind, projectId, requestId: `fence-${kind}`,
    ...(kind === 'stop' ? { runId: f.grant.runId } : {}) });
  await assert.rejects(f.jobs.checkpointRetained(f.context, f.started.jobId, 1));
  await assert.rejects(f.jobs.update(f.context, f.started.jobId, 1, { state: 'done', progress: 1 }));
  const raw = new DatabaseSync(path.join(f.authority.dir, 'tool-jobs.db'), { readOnly: true });
  try { const row = raw.prepare('SELECT state, fence_revision FROM tool_jobs WHERE job_id=?').get(f.started.jobId);
    assert.equal(row.state, 'running'); assert.equal(row.fence_revision, f.oldFence); }
  finally { raw.close(); }
});

test('revoke between checkpoint awaits rolls back exact fence migration', async t => {
  const f = await fixture(t, { revokeDuringCheckpoint: true });
  await assert.rejects(f.jobs.checkpointRetained(f.context, f.started.jobId, 1));
  const raw = new DatabaseSync(path.join(f.authority.dir, 'tool-jobs.db'), { readOnly: true });
  try { const row = raw.prepare('SELECT revision, fence_revision FROM tool_jobs WHERE job_id=?').get(f.started.jobId);
    assert.equal(row.revision, 1); assert.equal(row.fence_revision, f.oldFence); }
  finally { raw.close(); }
});
