import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { createAssetResourceLease } from '../asset-store/project-access.mjs';
import { createAssetRevocationConsumer } from '../asset-store/project-revocations.mjs';
import { createAssetRunConsumer } from '../hosted/asset-run-access.mjs';
import { digestOf } from '../account/ledger.mjs';

const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function temp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-run-pure-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }

test('run pause is synchronous, retained recheck resumes; denied gate cannot deadlock an owned assert hold', { timeout: 5000 }, async () => {
  let callback, allowed = true, checking, checkCount = 0;
  const lease = await createAssetResourceLease({ check: async () => { checkCount++; if (checking) await checking.promise;
    if (!allowed) throw new Error('run-revoked'); return { allowed: true, grantState: 'retained' }; },
    subscribe: cb => { callback = cb; return () => {}; }, eventPolicy: 'recheck' });
  const source = lease.track(new Readable({ read() {} }));
  checking = gate(); const decision = callback({ reason: 'credential' }); let asserted = false;
  const writing = lease.run(async () => { await lease.assert(); asserted = true; });
  await new Promise(r => setImmediate(r)); assert.equal(asserted, false); assert.equal(source.destroyed, false);
  checking.resolve(); checking = null; assert.equal((await decision).retained, true); await writing;
  assert.equal(asserted, true); assert.equal(lease.signal.aborted, false); assert.ok(checkCount >= 3);
  allowed = false; const denying = callback({ reason: 'stop' });
  const rejected = lease.run(() => lease.assert());
  await assert.rejects(rejected, /access-revoked/); await denying; assert.equal(source.closed, true); await lease.release();
});

test('normal release and run revocation both wait a real Readable _destroy callback, not end/finish', { timeout: 5000 }, async () => {
  let destroy; const lease = await createAssetResourceLease({ check: async () => ({ allowed: true }), subscribe: () => () => {} });
  const source = lease.track(new Readable({ read() {}, destroy(_error, done) { destroy = done; } }));
  let released = false, acknowledged = false;
  const release = lease.release().then(() => { released = true; }); const ack = lease.revoke({ reason: 'stop' }).then(() => { acknowledged = true; });
  await new Promise(r => setImmediate(r)); assert.equal(source.closed, false); assert.equal(released, false); assert.equal(acknowledged, false);
  destroy(); await Promise.all([release, ack]); assert.equal(source.closed, true); assert.equal(released, true);
});

test('the single human access consumer waits participant actual close and preserves exact lost-ACK receipt', { timeout: 5000 }, async t => {
  const dir = await temp(t), closing = gate(), events = [], sent = []; let lost = true, callback, fenced = false;
  const raw = { checkAccess: async () => ({ allowed: true }), subscribeRevocations(_context, cb) { callback = cb; return () => {}; },
    eventsSince: async after => ({ events: events.filter(e => e.seq > after), headSeq: events.length }),
    ackAccessEvent: async (_id, _service, receipt) => { sent.push(receipt); if (lost) throw new Error('lost-ack'); } };
  const participant = { handleAccessEvent() { fenced = true; return closing.promise.then(() => ({ complete: true,
    closedStreams: ['run-resource-real-close'], stoppedRuns: [], rejectedCredentials: [] })); }, unavailable: async () => {} };
  const consumer = createAssetRevocationConsumer({ authority: raw, file: path.join(dir, 'access.json'), participants: [participant] }); await consumer.start();
  const event = { eventId: 'exit-1', seq: 1, type: 'login-revoked' }; events.push(event); callback(event);
  assert.equal(fenced, true); await new Promise(r => setImmediate(r)); assert.equal(sent.length, 0);
  closing.resolve(); await assert.rejects(consumer.sync(), /lost-ack/); const pending = JSON.parse(await fs.readFile(path.join(dir, 'access.json'), 'utf8')).pending;
  assert.deepEqual(pending.receipt.closedStreams, ['run-resource-real-close']); await consumer.close(); lost = false;
  const restarted = createAssetRevocationConsumer({ authority: raw, file: path.join(dir, 'access.json'), participants: [participant] }); await restarted.start();
  assert.deepEqual(sent.at(-1), pending.receipt); assert.equal(restarted.cursor, 1); await restarted.close();
});

test('run outbox ACK is continuous/persisted before send; lost ACK replay is exact and unknown admission fails closed', { timeout: 5000 }, async t => {
  const dir = await temp(t), file = path.join(dir, 'run.json'), events = [], sent = []; let lost = true;
  const client = { eventsSince: async after => ({ events: events.filter(e => e.seq > after), headSeq: events.length }),
    acknowledgeEvent: async (_id, receipt) => { const disk = JSON.parse(await fs.readFile(file, 'utf8')); assert.deepEqual(disk.pending.receipt, receipt);
      sent.push(receipt); if (lost) throw new Error('lost-ack'); } };
  const config = { client, file, assetInstanceId: 'asset-one', serviceIdentity: 'asset-key', verifyLifecycle: async () => true };
  const consumer = createAssetRunConsumer(config); await consumer.start();
  events.push({ v: 1, eventId: 'run-asset:control-one', seq: 1, controlId: 'control-one', payloadDigest: digestOf('immutable'),
    control: { kind: 'stop', retained: [], revoked: [], instances: [], fenceRevision: 1 } });
  await assert.rejects(consumer.sync(), /lost-ack/); assert.equal(consumer.ready, false); const receipt = sent[0]; await consumer.close(); lost = false;
  const restarted = createAssetRunConsumer(config); await restarted.start(); assert.equal(restarted.cursor, 1); assert.deepEqual(sent.at(-1), receipt);
  const token = restarted.beginAdmission();
  const lease = await createAssetResourceLease({ check: async () => ({ allowed: true }), subscribe: () => () => {} });
  await restarted.admit({ leaseId: 'known-resource', runGrantId: 'grant-one', projectId: 'A', instanceId: 'agent-one', instanceGeneration: 1 }, { lease, last: {} }, token);
  restarted.finishAdmission(token);
  const another = createAssetRunConsumer(config); await assert.rejects(another.start(), /recovery-pending/);
  await restarted.close(); await another.close();
});
