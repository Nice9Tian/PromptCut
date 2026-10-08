import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRunResources } from '../agent/service/run-resources.mjs';
import { runFixture, projectId, servicePrincipal } from './run-authority-fixture.mjs';

async function fixture(t, options = {}) {
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
  const resources = createRunResources({ runClient, ...options });
  t.after(async () => { await resources.close(); authority.close(); fs.rmSync(authority.dir, { recursive: true, force: true }); });
  const context = await resources.contextFor({ projectId, runGrantId: grant.runGrantId });
  return { authority, resources, context, grant, runClient };
}

test('resource contexts bind all eight live provider fields and current registered instance', async t => {
  const { resources, context } = await fixture(t);
  assert.equal(Object.keys(context).length, 8);
  assert.equal(context.projectId, projectId);
  assert.equal((await resources.authorize(context, 'write')).allowed, true);
  for (const forged of [
    { ...context, senderAccountId: 'other' },
    { ...context, instanceGeneration: context.instanceGeneration + 1 },
    { ...context, conversationId: 'other' },
  ]) {
    const stream = new PassThrough(); const closed = once(stream, 'close');
    await assert.rejects(resources.register(forged, { kind: 'stream', resource: stream }), /run-resource-/);
    await closed; assert.equal(stream.destroyed, true);
  }
});

test('a private fence aborts real stream/socket before receipt and late registration never resurrects resources', async t => {
  const { authority, resources, context } = await fixture(t);
  const stream = new PassThrough(), socket = new net.Socket();
  await resources.register(context, { kind: 'stream', resource: stream });
  await resources.register(context, { kind: 'socket', resource: socket });
  const streamClosed = once(stream, 'close'), socketClosed = once(socket, 'close');
  authority.privateFence();
  const receipt = await resources.abortForFence(context, 'private');
  await Promise.all([streamClosed, socketClosed]);
  assert.equal(receipt.complete, false);
  assert.equal(receipt.witnessMissing, true);
  assert.deepEqual([receipt.streamsOpen, receipt.connectionsOpen, receipt.childrenOpen], [0, 0, 0]);
  const late = new PassThrough(), lateClosed = once(late, 'close');
  await assert.rejects(resources.register(context, { kind: 'stream', resource: late }), /run-resource-/);
  await lateClosed; assert.equal(late.destroyed, true);
  assert.equal((await resources.abortForFence(context, 'private')).complete, false);
});

test('unknown run and absent child-tree witness cannot be mistaken for complete close', async t => {
  const { resources, context } = await fixture(t);
  const unknown = await resources.abortForFence(context, 'stop');
  assert.equal(unknown.complete, false);
  assert.equal(unknown.witnessMissing, true);
});

test('owned child reports both actual exit and close while unknown descendants keep ACK pending', async t => {
  const { resources, context } = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { windowsHide: true, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const exit = once(child, 'exit'), close = once(child, 'close');
  await resources.register(context, { kind: 'child', resource: child });
  const receipt = await resources.abortForFence(context, 'stop');
  await Promise.all([exit, close]);
  assert.equal(receipt.complete, false);
  assert.equal(receipt.witnessMissing, true);
  assert.equal((await resources.abortForFence(context, 'stop')).childrenOpen, 0);
});

test('abort during live authorization tombstones the run before late resource registration', async t => {
  const { resources, context, runClient } = await fixture(t, { childTreeWitness: async () => true });
  const original = runClient.checkAccess;
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  runClient.checkAccess = async input => { entered(); await gate; return original(input); };
  const stream = new PassThrough(), closed = once(stream, 'close');
  const registration = resources.register(context, { kind: 'stream', resource: stream });
  await started;
  const pending = await resources.abortForFence(context, 'private');
  assert.equal(pending.complete, false);
  assert.equal(pending.pendingRegistrations, 1);
  release();
  await assert.rejects(registration, /run-resource-/);
  await closed;
  assert.equal(stream.destroyed, true);
  assert.equal((await resources.abortForFence(context, 'private')).complete, false);
});
