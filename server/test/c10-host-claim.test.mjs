/** A5 failure diagnosis: actual queue views, static eligibility, hidden tick errors and secret exclusion.
 * These checks do not prove a lane is free or replace the real full C10 host completion assertion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostClaimStatusOf } from '../../scripts/render-host.mjs';
import { clipsPlanTaskOf } from '../render-queue/messages.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createRenderHost } from '../render-node/host.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';

const queueView = () => ({ profile: 'host', codeVersion: 'v1', envFingerprint: '0c10b0e5f1a9e7d2', maxConcurrent: 1,
  capabilities: { userCards: true, graphCards: false, streams: false, transcode: false },
  nodes: [{ projectId: 'sp_a', nodeId: 'host-a', connected: true, seen: 1, watching: ['sp_a'], held: [], running: [] }] });
const plan = (version = 'v1') => ({ ...clipsPlanTaskOf({ projectId: 'sp_a', projectRev: 2, clips: ['clip-a'], codeVersion: version }), state: 'open' });

test('A5 diagnosis distinguishes unseen observer data, eligible list plan and code-version filtering without weakening the filter', () => {
  const q = queueView();
  assert.equal(hostClaimStatusOf(q).nodes[0].eligible, null);
  const eligible = hostClaimStatusOf(q, [], [plan()]);
  assert.equal(eligible.nodes[0].eligible, 1, '禁流主机能接清单 plan');
  assert.deepEqual(eligible.nodes[0].filters, {});
  const blocked = hostClaimStatusOf(q, [], [plan('v2')]);
  assert.equal(blocked.nodes[0].eligible, 0);
  assert.deepEqual(blocked.nodes[0].filters, { 'code-version': 1 });
  assert.equal(blocked.nodes[0].seen, 1, 'seen 不等于可认领');
  assert.equal(eligible.eligibility, 'observer-static-filter-only', '静态过滤不能冒称 lane/时序闸已通过');
});

test('A5 diagnosis omits credentials/payload/error text and reports unknown card identities instead of fabricating a failure', () => {
  const q = queueView();
  const secret = 'fixture-value-never-log';
  q.password = secret; q.nodes[0].session = { token: secret }; q.capabilities.accessToken = secret;
  const fine = { ...plan(), kind: 'snapshot', requires: { cardSources: { card: 'r1' } }, input: { token: secret } };
  const before = structuredClone(q);
  const status = hostClaimStatusOf(q, [{ event: 'queue.tick-error', message: `${secret} is not a function` },
    { event: 'queue.tick-error', message: `${secret} is not a function` }], [fine]);
  assert.equal(status.nodes[0].unknownCardSources, 1);
  assert.equal(status.nodes[0].eligible, 0);
  assert.equal(status.tickErrors.length, 1);
  assert.equal(status.tickErrors[0].category, 'not-a-function');
  assert.match(status.tickErrors[0].hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.deepEqual(q, before);
  assert.deepEqual(hostClaimStatusOf(null).nodes, []);
});

test('A5 queue/provider control: a host with idle serial lane claims and splits the real list plan despite streams=false', async () => {
  const lb = createLoopback();
  const q = createRenderQueue({ now: () => 1000, send: lb.queueSend, epoch: 'c10-diag' });
  lb.attach(q);
  const pub = lb.connect('page', { userId: 'member', tenantId: 'sp_a' });
  pub.send({ type: 'publisher.hello', publisherId: 'page' });
  pub.send({ type: 'task.publish', tasks: [plan()] });
  const view = queueView();
  const host = createRenderHost({ entries: [{ projectId: 'sp_a' }], codeVersion: view.codeVersion, envFingerprint: view.envFingerprint,
    capabilities: view.capabilities, now: () => 1000,
    connect: () => ({ endpoint: lb.connect('host', { userId: 'member', tenantId: 'sp_a' }),
      executor: { laneOf: t => ['plan', 'snapshot'].includes(t.kind) ? 'queue' : null, laneBusy: () => 0,
        async plan() { return { entryKey: 'entry', cardPlan: [] }; }, async render() { assert.fail('空计划不应制造细任务'); } },
      sink: { async has() { return false; }, async put() { assert.fail('空计划不应推产物'); } } }) });
  try {
    host.start(); lb.flush(); host.tick(); lb.flush();
    await new Promise(resolve => setImmediate(resolve)); lb.flush();
    assert.equal(host.nodes()[0].claimed, 1);
    assert.equal(host.nodes()[0].plans, 1);
    assert.deepEqual(lb.errors(), []);
    assert.deepEqual(lb.nonJson(), []);
    assert.ok(lb.log().some(e => e.connId === 'host' && e.dir === 'in' && e.message.type === 'task.claim'));
  } finally { host.shutdown(); lb.flush(); await host.settled(); }
});
