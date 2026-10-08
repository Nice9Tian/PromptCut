import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { createAssetResourceLease, waitAssetWritable } from '../asset-store/project-access.mjs';
import { EventEmitter } from 'node:events';
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

test('private closure witness and control ACK wait actual source close and durable bound receipt', { timeout: 5000 }, async t => {
  const dir = await temp(t), file = path.join(dir, 'closure.json'), events = [], acknowledgements = [];
  let consumer, allowed = true, destroy; const entryClosed = gate();
  const client = { eventsSince: async after => ({ events: events.filter(e => e.seq > after), headSeq: events.length }),
    acknowledgeEvent: async (id, receipt) => {
      const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.deepEqual(persisted.pending.receipt, receipt);
      assert.deepEqual(consumer.controlWitness(id).receipt, receipt); acknowledgements.push(receipt);
    } };
  consumer = createAssetRunConsumer({ client, file, assetInstanceId: 'asset-one', serviceIdentity: 'asset-key', verifyLifecycle: async () => true });
  await consumer.start(); const token = consumer.beginAdmission();
  const lease = await createAssetResourceLease({ check: async () => { if (!allowed) throw new Error('revoked'); return { allowed: true }; },
    subscribe: () => () => {}, eventPolicy: 'recheck' });
  const source = lease.track(new Readable({ read() {}, destroy(_error, done) { destroy = done; } }));
  const record = { leaseId: 'real-lease', projectId: 'A', runGrantId: 'real-grant', instanceId: 'agent-one', instanceGeneration: 1 };
  await consumer.admit(record, { lease, last: {}, closed: entryClosed.promise }, token); consumer.finishAdmission(token);
  const receipt = { leaseId: record.leaseId, receiptId: 'actual-close', complete: true, evidenceDigest: digestOf(record) };
  await assert.rejects(consumer.closed(record.leaseId, receipt), /closure-pending/);
  let prepared = false; const preparing = consumer.prepareClosure(record.leaseId, receipt).then(() => { prepared = true; });
  allowed = false; events.push({ v: 1, seq: 1, eventId: 'run-asset:stop-real', controlId: 'stop-real', payloadDigest: digestOf('stop'),
    control: { kind: 'stop', revoked: [record.runGrantId], retained: [], instances: [], fenceRevision: 2 } });
  const syncing = consumer.sync(); await new Promise(r => setImmediate(r));
  assert.equal(source.closed, false); assert.equal(prepared, false); assert.equal(acknowledgements.length, 0);
  assert.throws(() => consumer.closureWitness(record.leaseId), /closure-pending/);
  destroy(); await preparing; assert.equal(source.closed, true);
  assert.deepEqual(consumer.closureWitness(record.leaseId).binding, { projectId: 'A', runGrantId: 'real-grant', instanceId: 'agent-one', instanceGeneration: 1 });
  await consumer.closed(record.leaseId, receipt); entryClosed.resolve(); await syncing;
  assert.deepEqual(acknowledgements[0].closedLeaseIds, [record.leaseId]); await consumer.close();
});

test('new asset instance cannot rename a persisted lost-ACK receipt into a current observer proof', async t => {
  const dir = await temp(t), file = path.join(dir, 'old-instance.json'); let sent = 0;
  const receipt = { eventId: 'run-asset:old', cursor: 1, complete: true, assetInstanceId: 'asset-old' };
  await fs.writeFile(file, JSON.stringify({ v: 1, assetInstanceId: 'asset-old', serviceIdentity: 'asset-key', cursor: 0,
    leases: {}, pending: { eventId: receipt.eventId, receipt } }));
  const consumer = createAssetRunConsumer({ client: { eventsSince: async () => ({ events: [], headSeq: 0 }), acknowledgeEvent: async () => { sent++; } },
    file, assetInstanceId: 'asset-new', serviceIdentity: 'asset-key', verifyLifecycle: async () => true });
  await assert.rejects(consumer.start(), /recovery-pending/); assert.equal(sent, 0); assert.equal(consumer.ready, false);
  assert.throws(() => consumer.controlWitness(receipt.eventId), /closure-pending/); await consumer.close();
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).assetInstanceId, 'asset-old');
});

test('backpressure completion removes every losing close/error listener', async () => {
  const stream = new EventEmitter(); stream.closed = false;
  for (let n = 0; n < 20; n++) { const waiting = waitAssetWritable(stream); stream.emit('drain'); await waiting;
    assert.equal(stream.listenerCount('close'), 0); assert.equal(stream.listenerCount('error'), 0); }
  const waiting = waitAssetWritable(stream); stream.closed = true; stream.emit('close'); await assert.rejects(waiting, /response-closed/);
  assert.equal(stream.listenerCount('drain'), 0);
});
