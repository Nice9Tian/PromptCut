import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { accountError } from '../account/client.mjs';
import { createAccountRunManager } from '../agent/service/account-runner.mjs';
import { runFixture, projectId, conversationId, servicePrincipal } from './run-authority-fixture.mjs';

async function fixture(t, { loseAdmit = false, loseFinish = false } = {}) {
  const f = await runFixture(); f.enqueue();
  t.after(() => { f.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  let admitLost = false, finishLost = false, model = 0, tool = 0;
  const admitIds = [], finishIds = [];
  const client = {
    async admit(input) {
      admitIds.push(input.requestId);
      const result = await f.provider.admit({ ...input, servicePrincipal });
      if (loseAdmit && !admitLost) { admitLost = true; throw accountError(503, 'simulated-admit-ack-lost'); }
      return result;
    },
    confirmRead: input => f.provider.confirmRead({ ...input, servicePrincipal }),
    queryRead: input => f.provider.queryRead({ ...input, servicePrincipal }),
    async checkAccess({ projectId: p, runGrantId, action }) {
      const principal = await f.provider.resolveRunPrincipal({ servicePrincipal, projectId: p, runGrantId });
      return f.provider.checkAccess({ principal, projectId: p, action });
    },
    async finish(input) {
      finishIds.push(input.requestId);
      const result = await f.provider.finish({ ...input, servicePrincipal });
      if (loseFinish && !finishLost) { finishLost = true; throw accountError(503, 'simulated-finish-ack-lost'); }
      return result;
    },
    pending: async () => ({ conversations: [] }),
  };
  const manager = createAccountRunManager({ runClient: client, readIntents: f.intents,
    serviceKid: f.agentProcess.registration.serviceKid, instanceId: f.agentProcess.registration.instanceId,
    runnerFactory: async ({ onModelCall, beforeToolCall }) => ({
      async start() { await onModelCall(); model++; await beforeToolCall(); tool++;
        return { done: Promise.resolve(), abort() {}, async drain() { return { dispatchesOpen: 0 }; } }; },
      close() {},
    }) });
  t.after(() => manager.close());
  return { f, manager, admitIds, finishIds, counts: () => ({ model, tool }) };
}

test('admit ACK lost after SQLite commit reuses same OS/requestId and starts exactly once', async t => {
  const x = await fixture(t, { loseAdmit: true });
  await assert.rejects(x.manager.wake(projectId, conversationId), /simulated-admit-ack-lost/);
  assert.equal(Object.keys(x.f.ledger.read().runGrantsV2).length, 1);
  await x.manager.wake(projectId, conversationId);
  assert.equal(x.admitIds[0], x.admitIds[1]);
  assert.deepEqual(x.counts(), { model: 1, tool: 1 });
  assert.equal(Object.values(x.f.ledger.read().conversationsV2[projectId][conversationId].messages)[0].queueState, 'done');
});

test('finish ACK lost after actual model/tool never replays execution; original finish request resolves', async t => {
  const x = await fixture(t, { loseFinish: true });
  await assert.rejects(x.manager.wake(projectId, conversationId), /simulated-finish-ack-lost/);
  assert.deepEqual(x.counts(), { model: 1, tool: 1 });
  const before = x.f.ledger.read();
  assert.equal(before.conversationsV2[projectId][conversationId].messages[0].queueState, 'done');
  await x.manager.wake(projectId, conversationId);
  assert.deepEqual(x.counts(), { model: 1, tool: 1 });
  assert.equal(x.finishIds.length, 2); assert.equal(x.finishIds[0], x.finishIds[1]);
  assert.equal(Object.keys(x.f.ledger.read().runReceiptsV2).length, 1);
});
