import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { runFixture, projectId } from './run-authority-fixture.mjs';
import { digestOf } from '../account/ledger.mjs';
import { createRunAssets } from '../account/run-assets.mjs';
import { assetHttpTuple, bytesDigest, resourceRevision, ticketDigest, runAssetIssueRequest } from '../account/run-asset-protocol.mjs';

// Genuine SQLite, instance authority/RAM-key signature and run authority. Socket,
// registry, account sender and media projection adapters are controlled here;
// this pure target does NOT prove mTLS, independent OS users or a deployed asset.
async function setup(t) {
  const f = await runFixture(); f.enqueue(); const g = await f.admit(); await f.provider.confirmRead(f.input(g));
  let epoch, lastSubject, closure = false, resource = { projectId, ns: 'media', hash: 'a'.repeat(64), size: 5,
    ext: 'wav', contentType: 'audio/wav' };
  const observerSocket = new EventEmitter(); observerSocket.destroyed = false;
  const observer = { socket: observerSocket, assetInstanceId: 'asset-process-1', serviceIdentity: 'asset-key-1' };
  const direct = { principal: f.agentProcess.principal };
  const verifyObserver = supplied => {
    if (![observerSocket].includes(supplied?.socket) || supplied.socket.destroyed ||
        supplied.assetInstanceId !== observer.assetInstanceId || supplied.serviceIdentity !== observer.serviceIdentity)
      throw new Error('observer-closed');
    return { ...observer };
  };
  const authenticate = args => {
    if (args.transport && args.transport !== direct) throw new Error('wrong-direct-transport');
    if (args.observer) verifyObserver(args.observer);
    const subject = { ...f.agentProcess.principal, ...f.instances.authority.authenticate({
      servicePrincipal: f.agentProcess.principal, method: args.method, path: args.path,
      operation: args.operation, request: args.request, proof: args.proof }) };
    lastSubject = subject;
    return { servicePrincipal: subject, release: () => f.instances.authority.release(subject.instanceSession) };
  };
  const config = { ledger: f.ledger, runProvider: f.rawProvider, authenticateDirect: authenticate,
    authenticateObserved: authenticate, verifyObserver, resolveMedia: async () => ({ resource, mediaRev: digestOf(resource), projectRev: 1 }),
    verifyLeaseClosure: async () => closure, verifyControlReceipt: async () => closure, now: () => f.clock.now, ticketTtlMs: 1000 };
  let assets = createRunAssets(config); epoch = assets.docEpoch;
  const body = (id = 'issue-1', purpose = 'openRead') => ({ projectId, runGrantId: g.runGrantId,
    action: purpose === 'import' ? 'write' : 'read', requestId: id, purpose,
    selector: purpose === 'openRead' ? { mediaId: 'media-1', tier: 'original' } :
      purpose === 'import' ? { hash: resource.hash, size: 5, ext: 'wav', name: 'wave', kind: 'audio', importId: 'import-1' } :
        { hash: resource.hash, size: 5 } });
  const proof = (request, method = 'POST', path = '/internal/v2/run-assets/issue', process = f.agentProcess) => {
    const signed = f.instances.authorize(process, 'checkAccess', request, { method, path });
    f.instances.authority.release(signed.principal.instanceSession);
    return { instanceId: signed.args.proof.instanceId, instanceGeneration: signed.args.proof.instanceGeneration,
      signature: signed.args.proof.signature };
  };
  const issue = async (input = body()) => {
    const bodyText = JSON.stringify(input), request = runAssetIssueRequest({ body: input, bodyText });
    return assets.issue({ body: input, bodyText, transport: direct, proof: proof(request) });
  };
  function request(issued, delta = {}) {
    return assetHttpTuple({ projectId, runGrantId: g.runGrantId, action: 'read', ticketDigest: ticketDigest(issued.ticket),
      resourceRev: issued.resourceRev, nonce: 'nonce-1', requestId: 'asset-request-1', method: 'GET',
      url: `/internal/v2/asset/run/media/${resource.hash}`, contentLength: 0, contentDigest: bytesDigest(Buffer.alloc(0)), ...delta });
  }
  function checkInput(issued, tuple = request(issued)) {
    const signed = f.instances.authorize(f.agentProcess, 'checkAccess', tuple, { method: tuple.method, path: tuple.url });
    f.instances.authority.release(signed.principal.instanceSession);
    return { ticket: issued.ticket, request: tuple, proof: proof(tuple, tuple.method, tuple.url), observer,
      observation: { assetInstanceId: observer.assetInstanceId, assetServiceIdentity: observer.serviceIdentity,
        assetLeaseId: 'owned-request-1', agentFingerprint256: 'b'.repeat(64), agentServiceKid: g.serviceKid,
        authenticationId: f.agentProcess.principal.authenticationId, channelBinding: signed.payload.channelBinding, open: true } };
  }
  t.after(() => { assets.close(); f.close(); fs.rmSync(f.dir, { recursive: true }); });
  return { f, g, config, body, issue, request, checkInput, proof, direct, observer, observerSocket,
    get assets() { return assets; }, get subject() { return lastSubject; }, epoch,
    setClosure(value) { closure = value; }, setResource(value) { resource = value; },
    restart() { assets.close(); assets = createRunAssets(config); } };
}

test('configuration fail closed; issue is exact, idempotent, never persists raw ticket/cap', async t => {
  assert.throws(() => createRunAssets(), /run-assets-unconfigured/);
  const x = await setup(t), one = await x.issue(); assert.deepEqual(await x.issue(), one);
  assert.equal(one.resourceRev, resourceRevision(one.resource));
  assert.equal(x.f.ledger.inspect().journalMode, 'wal'); assert.equal(x.f.ledger.inspect().synchronous, 2);
  const disk = JSON.stringify(x.f.ledger.read());
  assert.equal(disk.includes(one.ticket), false); assert.equal(disk.includes('instanceSession'), false);
  assert.equal(disk.includes('authorizationId'), false);
  await assert.rejects(x.issue({ ...x.body(), accountId: 'owner' }), /run-asset-body-invalid/);
  await assert.rejects(x.issue({ ...x.body(), selector: { mediaId: 'changed', tier: 'original' } }), /request-mismatch/);
});

test('real RAM key binds full issuance, project/instance/resource, read cannot write and nonce is durable', async t => {
  const x = await setup(t), issued = await x.issue(), input = x.checkInput(issued);
  const allowed = await x.assets.check(input); assert.equal(allowed.projectId, projectId);
  assert.equal(Object.hasOwn(allowed, 'principal'), false);
  await assert.rejects(x.assets.check(input), /nonce-replayed/);
  await assert.rejects(x.assets.check({ ...input, request: { ...input.request, range: 'bytes=0-1', nonce: 'nonce-new' } }), /instance-proof-invalid/);
  const other = x.f.instances.boot();
  await assert.rejects(x.assets.check({ ...input, request: x.request(issued, { nonce: 'nonce-new' }),
    proof: x.proof(x.request(issued, { nonce: 'nonce-new' }), 'GET', input.request.url, other) }), /instance-proof-invalid|instance-service-mismatch|run-binding-mismatch/);
  await assert.rejects(x.assets.check({ ...input, request: { ...input.request, action: 'write', method: 'PUT',
    url: `${input.request.url}/0`, chunkIndex: 0, importId: 'import-1' } }), /resource-scope-mismatch/);
  const principal = { ...x.g, servicePrincipal: x.subject };
  assert.throws(() => x.f.instances.authority.verifyInState(x.f.ledger.read(), x.subject,
    { operation: 'checkAccess', input: { principal, projectId, action: 'read' } }), /instance-invocation-forbidden/);
});

test('legal retained current run rechecks; stop/private and old observer cannot continue', async t => {
  const x = await setup(t), ticket = await x.issue(), input = x.checkInput(ticket), lease = await x.assets.check(input);
  x.f.provider.applyAccessEvent(x.f.exit());
  const keep = await x.assets.check({ ...input, leaseId: lease.leaseId }); assert.equal(keep.grantState, 'retained');
  const imported = await x.issue(x.body('retained-import', 'import')); assert.equal(imported.grantState, 'retained');
  const events = await x.assets.eventsSince(0); assert.equal(events.events.length, 1);
  assert.equal(events.headSeq, 1); assert.deepEqual(events.events[0].control.retained, [x.g.runGrantId]);
  await assert.rejects(x.assets.check({ ...input, leaseId: lease.leaseId,
    observer: { ...x.observer, socket: new EventEmitter() } }), /observer-closed/);
  x.f.privateFence(); await assert.rejects(x.assets.check({ ...input, leaseId: lease.leaseId }), /run-no-longer-current|run-revoked/);
  assert.equal((await x.assets.eventsSince(1)).headSeq, 2);
});

test('source actual close precedes durable lease and control receipt, duplicate ACK exact', async t => {
  const x = await setup(t), ticket = await x.issue(), input = x.checkInput(ticket), lease = await x.assets.check(input);
  let destroyDone; const source = new Readable({ read() {}, destroy(_error, done) { destroyDone = done; } });
  const actualClose = new Promise(resolve => source.once('close', resolve));
  source.destroy(); assert.equal(source.closed, false);
  const control = x.f.provider.fence({ kind: 'stop', requestId: 'stop-assets', projectId, runId: x.g.runId });
  const event = (await x.assets.eventsSince(0)).events[0];
  const receipt = { receiptId: 'receipt-control', eventId: event.eventId, cursor: 1, controlId: control.controlId,
    fenceRevision: control.fenceRevision, complete: true, assetInstanceId: x.observer.assetInstanceId,
    closedLeaseIds: [lease.leaseId], retainedLeaseIds: [], evidenceDigest: digestOf('actual-close') };
  await assert.rejects(x.assets.acknowledgeEvent({ eventId: event.eventId, observer: x.observer, receipt }), /closure-pending/);
  const closeReceipt = { leaseId: lease.leaseId, receiptId: 'receipt-lease', complete: true, evidenceDigest: digestOf('actual-close') };
  await assert.rejects(x.assets.closeLease({ leaseId: lease.leaseId, observer: x.observer, receipt: closeReceipt }), /closure-pending/);
  assert.equal(x.f.ledger.read().runAssetAcksV1['asset-key-1'], undefined);
  destroyDone(); await actualClose; assert.equal(source.closed, true); x.setClosure(true);
  await x.assets.closeLease({ leaseId: lease.leaseId, observer: x.observer, receipt: closeReceipt });
  assert.deepEqual(await x.assets.acknowledgeEvent({ eventId: event.eventId, observer: x.observer, receipt }), receipt);
  assert.deepEqual(await x.assets.acknowledgeEvent({ eventId: event.eventId, observer: x.observer, receipt }), receipt);
  await assert.rejects(x.assets.acknowledgeEvent({ eventId: event.eventId, observer: x.observer,
    receipt: { ...receipt, receiptId: 'changed' } }), /receipt-mismatch/);
  assert.equal(x.f.ledger.read().runControlsV2[control.controlId].state, 'pending');
});

test('epoch loses RAM tickets; unknown historical resources never get a free restart ACK', async t => {
  const x = await setup(t), ticket = await x.issue(), input = x.checkInput(ticket), lease = await x.assets.check(input);
  x.restart(); assert.notEqual(x.assets.docEpoch, x.epoch);
  assert.equal(x.f.ledger.read().runAssetLeasesV1[lease.leaseId].state, 'unknown');
  await assert.rejects(x.assets.check(input), /ticket-expired/);
  await assert.rejects(x.issue(), /ticket-epoch-lost/);
  await assert.rejects(x.assets.recoverLeaseClosure({ leaseId: lease.leaseId, witness: { complete: true } }), /closure-pending/);
  assert.ok((await x.issue(x.body('after-restart'))).ticket);
});

test('observer disconnect persists unknown; expiry/media change/new request cannot resurrect lease', async t => {
  const x = await setup(t), ticket = await x.issue(), input = x.checkInput(ticket), lease = await x.assets.check(input);
  x.observerSocket.destroyed = true; x.observerSocket.emit('close');
  assert.equal(x.f.ledger.read().runAssetLeasesV1[lease.leaseId].state, 'unknown');
  await assert.rejects(x.assets.check({ ...input, leaseId: lease.leaseId }), /observer-closed/);
  x.f.clock.now = 2000; await assert.rejects(x.issue(), /ticket-expired/);
});

test('parallel nonce admission linearizes in SQLite once; fake selector has no global hash escape', async t => {
  const x = await setup(t), ticket = await x.issue(), input = x.checkInput(ticket);
  const results = await Promise.allSettled([x.assets.check(input), x.assets.check(input)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /nonce-replayed/);
  assert.equal(Object.keys(x.f.ledger.read().runAssetNoncesV1).length, 1);
  x.setResource({ ...ticket.resource, projectId: 'sp_other' });
  await assert.rejects(x.issue(x.body('cross-project')), /resource-scope-mismatch/);
});

test('control inventory never closes another current run merely sharing its Agent instance', async t => {
  const x = await setup(t), ticket = await x.issue(), first = x.checkInput(ticket), firstLease = await x.assets.check(first);
  x.f.ledger.transaction(s => {
    const original = s.conversationsV2[projectId][x.g.conversationId];
    s.conversationsV2[projectId].second = { ...structuredClone(original), id: 'second', currentRunId: null,
      messages: [{ ...structuredClone(original.messages[0]), messageId: 'second-message', requestId: 'send-second',
        queueState: 'queued', runId: null, readReceiptId: null }] };
  });
  const second = await x.f.provider.admit({ servicePrincipal: x.f.agentProcess.principal,
    projectId, conversationId: 'second', requestId: 'admit-second' });
  await x.f.provider.confirmRead({ ...x.f.input(second, 'read-second'), conversationId: 'second' });
  const secondTicket = await x.issue({ ...x.body('second-issue'), runGrantId: second.runGrantId });
  const secondInput = x.checkInput(secondTicket, x.request(secondTicket, { runGrantId: second.runGrantId, nonce: 'second-nonce' }));
  const secondLease = await x.assets.check(secondInput);
  const c = x.f.provider.fence({ kind: 'stop', requestId: 'first-only', projectId, runId: x.g.runId });
  const event = (await x.assets.eventsSince(0)).events[0]; x.setClosure(true);
  await x.assets.closeLease({ leaseId: firstLease.leaseId, observer: x.observer,
    receipt: { leaseId: firstLease.leaseId, receiptId: 'first-close', complete: true, evidenceDigest: digestOf('first-close') } });
  const receipt = { receiptId: 'first-control', eventId: event.eventId, cursor: 1, controlId: c.controlId,
    fenceRevision: c.fenceRevision, complete: true, assetInstanceId: x.observer.assetInstanceId,
    closedLeaseIds: [firstLease.leaseId], retainedLeaseIds: [], evidenceDigest: digestOf('first-close') };
  await x.assets.acknowledgeEvent({ eventId: event.eventId, observer: x.observer, receipt });
  assert.equal(x.f.ledger.read().runAssetLeasesV1[secondLease.leaseId].state, 'admitted');
  assert.equal((await x.assets.check({ ...secondInput, leaseId: secondLease.leaseId })).allowed, true);
});

test('durable outbox corruption/gap fails closed instead of exposing a false continuous head', async t => {
  const x = await setup(t); x.f.provider.fence({ kind: 'stop', requestId: 'gap-control', projectId, runId: x.g.runId });
  const page = await x.assets.eventsSince(0); assert.equal(page.headSeq, 1);
  x.f.ledger.transaction(s => { s.runAssetControlOutboxV1[0].seq = 2; });
  await assert.rejects(x.assets.eventsSince(0), /run-control-gap/);
});

test('full body/method/path are signed; failed proof never claims the nonce; missing resource size refuses issue', async t => {
  const x = await setup(t), body = x.body(), bodyText = JSON.stringify(body), signed = runAssetIssueRequest({ body, bodyText });
  for (const [method, path] of [['GET', '/internal/v2/run-assets/issue'], ['POST', '/internal/v2/run-assets/other']])
    await assert.rejects(x.assets.issue({ body, bodyText, transport: x.direct, proof: x.proof(signed, method, path) }), /instance-proof-invalid/);
  await assert.rejects(x.assets.issue({ body: { ...body, selector: { mediaId: 'different', tier: 'original' } },
    bodyText: JSON.stringify({ ...body, selector: { mediaId: 'different', tier: 'original' } }),
    transport: x.direct, proof: x.proof(signed) }), /instance-proof-invalid/);
  await assert.rejects(x.assets.issue({ body, bodyText: ` ${bodyText}`, transport: x.direct, proof: x.proof(signed) }), /instance-proof-invalid/);
  await assert.rejects(x.assets.issue({ body, transport: x.direct, proof: x.proof(signed) }), /run-asset-body-invalid/);
  const ticket = await x.issue(), input = x.checkInput(ticket);
  await assert.rejects(x.assets.check({ ...input, proof: { ...input.proof, signature: 'A'.repeat(86) } }), /instance-proof-invalid/);
  assert.equal(Object.keys(x.f.ledger.read().runAssetNoncesV1).length, 0);
  await x.assets.check(input); assert.equal(Object.keys(x.f.ledger.read().runAssetNoncesV1).length, 1);
  const { size: _size, ...noSize } = ticket.resource; x.setResource(noSize);
  await assert.rejects(x.issue(x.body('small-no-stat')), /run-asset-resource-unavailable/);
});

test('new factory epoch invalidates the old runtime before any late admission can publish', async t => {
  const x = await setup(t), ticket = await x.issue(), input = x.checkInput(ticket);
  const replacement = createRunAssets(x.config); t.after(() => replacement.close());
  await assert.rejects(x.assets.check(input), /run-assets-unconfigured/);
  await assert.rejects(x.issue(x.body('late-old-runtime')), /run-assets-unconfigured/);
  assert.equal(Object.keys(x.f.ledger.read().runAssetNoncesV1).length, 0);
});

test('durable outbox is a bidirectional bijection with mirrors and original controls', async t => {
  const mutations = {
    'missing tail': s => s.runAssetControlOutboxV1.pop(),
    'missing middle': s => s.runAssetControlOutboxV1.shift(),
    'dangling mirror': s => { s.runAssetControlMirrorsV1.orphan = { ...Object.values(s.runAssetControlMirrorsV1)[0] }; },
    'mirror points outside head': s => { Object.values(s.runAssetControlMirrorsV1)[1].seq = 3; },
    'original control missing': s => { delete s.runControlsV2[s.runAssetControlOutboxV1[0].controlId]; },
    'duplicate outbox': s => { s.runAssetControlOutboxV1[1] = structuredClone(s.runAssetControlOutboxV1[0]); },
    'outbox control tampered': s => { s.runAssetControlOutboxV1[0].control.revoked = ['forged-grant']; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async sub => {
    const x = await setup(sub);
    x.f.provider.applyAccessEvent(x.f.exit()); x.f.privateFence();
    const before = await x.assets.eventsSince(0); assert.equal(before.headSeq, 2);
    assert.equal(Object.keys(x.f.ledger.read().runAssetControlMirrorsV1).length, 2);
    x.f.ledger.transaction(s => { mutate(s); });
    await assert.rejects(x.assets.eventsSince(0), /run-control-gap/);
  });
});
