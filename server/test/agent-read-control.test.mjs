import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openAccountLedger, appendAccessEvent } from '../account/ledger.mjs';
import { createAccountAuthority } from '../account/authority.mjs';
import { createAgentReadControl, conversationControlOperations, CONVERSATION_CONTROL_ROOT, KEEP_CLOSED_READS_PER_INSTANCE, KEEP_READ_CONTROL_NONCES, pruneClosedReads, READ_NONCE_TTL_MS, pruneNonces } from '../account/agent-read-control.mjs';
import { conversationReadInState } from '../account/conversation-authority.mjs';
import { instanceFixture } from './agent-instance-fixture.mjs';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-read-core-'));
  const file = path.join(dir, 'doc.sqlite'), ledger = openAccountLedger({ file, authorityId: 'read-core' });
  const instances = instanceFixture(ledger), process = instances.boot(), frames = [];
  const principals = Object.fromEntries(['owner', 'member', 'creator'].map(accountId => [accountId, {
    projectId: 'project', accountId, loginId: `login-${accountId}`, credentialId: `cred-${accountId}`, loginGeneration: 1,
  }]));
  ledger.transaction(state => {
    state.projects.project = { status: 'active', creatorAccountId: 'creator', hosted: { agent: true }, bans: {},
      members: { owner: { access: 'rw' }, member: { access: 'rw' }, creator: { access: 'rw' } } };
    state.conversationsV2 = { project: { conversation: { id: 'conversation', projectId: 'project', ownerAccountId: 'owner',
      visibility: 'shared', aclRevision: 1, queueRevision: 1, currentRunId: null, messages: [{ arrivalSeq: 1, content: 'full message' }] } } };
  });
  const create = () => createAgentReadControl({ ledger, instanceAuthority: instances.authority,
    authorizeRead: async body => { const principal = principals[body.delegation]; if (!principal) throw new Error('delegation-required'); return structuredClone(principal); },
    checkReadInState: conversationReadInState });
  let control = create(); const releases = [];
  function signed(action, input, processArg = process) {
    const body = { requestId: randomUUID(), nonce: randomUUID(), ...input };
    const auth = instances.authorize(processArg, conversationControlOperations[action], body,
      { path: CONVERSATION_CONTROL_ROOT + action });
    releases.push(() => instances.authority.release(auth.principal.instanceSession));
    return { servicePrincipal: auth.principal, body };
  }
  function subscribe(p = process) { return control.subscribe({ ...signed('subscribe', {}, p), send: frame => frames.push(frame), onFailure() {} }); }
  const open = (delegation = 'member', fields = {}, p = process) => control.open(signed('open', {
    delegation, projectId: 'project', conversationId: 'conversation', action: 'get', after: 0, ...fields }, p));
  const fence = (input = {}) => ledger.transaction(state => {
    state.conversationsV2.project.conversation.visibility = 'private';
    return control.hooks.fenceInState(state, { kind: 'private', projectId: 'project', conversationId: 'conversation', requestId: 'private', ...input });
  });
  t.after(() => { control.close(); for (const release of releases) release(); instances.close(); ledger.close(); fs.rmSync(dir, { recursive: true }); });
  return { ledger, file, instances, process, principals, signed, subscribe, open, fence, frames,
    get control() { return control; }, restart() { control.close(); control = create(); } };
}

test('zero-run HTTP reads persist exact instance inventory; private completion waits close then exact ACK', async t => {
  const f = setup(t); f.subscribe(); const opened = await f.open();
  assert.equal(opened.value.messages[0].content, 'full message');
  assert.equal(f.ledger.read().runGrantsV2, undefined);
  const c = f.fence(); const id = opened.readHandle.readHandleId;
  assert.deepEqual(c.targets[f.process.registration.instanceId].readHandleIds, [id]);
  assert.equal(f.control.completion({ projectId: 'project', conversationId: 'conversation' }).complete, false);
  const ack = () => f.signed('ack', { controlId: c.controlId, payloadDigest: c.payloadDigest, seq: c.seq, readHandleIds: [id] });
  assert.throws(() => f.control.acknowledge(ack()), { code: 'read-close-pending' });
  f.control.closeReads(f.signed('close', { readHandleIds: [id] }));
  assert.equal(f.control.completion({ projectId: 'project', conversationId: 'conversation' }).complete, false);
  f.control.acknowledge(ack());
  assert.equal(f.control.completion({ projectId: 'project', conversationId: 'conversation' }).complete, true);
  await assert.rejects(f.open(), { code: 'no-conversation' });
});

test('creator and owner private read remain; ordinary project-wide list is included in fence', async t => {
  const f = setup(t); f.subscribe();
  const list = await f.open('member', { action: 'list', conversationId: null });
  const creator = await f.open('creator'), owner = await f.open('owner');
  const c = f.fence(); assert.deepEqual(c.targets[f.process.registration.instanceId].readHandleIds, [list.readHandle.readHandleId]);
  assert.equal(f.ledger.read().agentReadsV1.handles[creator.readHandle.readHandleId].state, 'open');
  assert.equal(f.ledger.read().agentReadsV1.handles[owner.readHandle.readHandleId].state, 'open');
  assert.equal((await f.open('creator')).value.creatorReadOnly, true);
});

test('same certificate new RAM instance cannot close or ACK the original read; unknown historical instance stays pending', async t => {
  const f = setup(t); f.subscribe(); const opened = await f.open();
  // 「本账本的读取必须清点」以前登记的实例（这里改记号模拟）：没订阅过也照旧按来历不明等
  const historical = f.instances.boot();
  f.ledger.transaction(state => { state.agentReadsV1.inventorySinceGeneration = historical.registration.instanceGeneration; });
  // 〔裁〕H07：那以后登记、从没订阅过的实例名下不可能有读取，不等它
  const second = f.instances.boot(); const c = f.fence();
  assert.equal(c.targets[historical.registration.instanceId].unknownInstance, true);
  assert.equal(c.targets[second.registration.instanceId], undefined);
  assert.throws(() => f.control.closeReads(f.signed('close', { readHandleIds: [opened.readHandle.readHandleId] }, second)), { code: 'read-instance-mismatch' });
  f.subscribe(second);
  assert.throws(() => f.control.acknowledge(f.signed('ack', { controlId: c.controlId, payloadDigest: c.payloadDigest,
    seq: c.seq, readHandleIds: [] }, second)), { code: 'read-control-receipt-mismatch' });
});

test('disconnect and doc restart preserve open inventory; only original live RAM key can reprove', async t => {
  const f = setup(t); const disconnect = f.subscribe(); const opened = await f.open(); disconnect();
  await assert.rejects(f.open(), { code: 'read-control-disconnected' });
  f.restart(); const c = f.fence();
  assert.deepEqual(c.targets[f.process.registration.instanceId].readHandleIds, [opened.readHandle.readHandleId]);
  f.subscribe(); assert.equal(f.control.completion({ projectId: 'project' }).complete, false);
  f.control.closeReads(f.signed('close', { readHandleIds: [opened.readHandle.readHandleId] }));
  f.control.acknowledge(f.signed('ack', { controlId: c.controlId, payloadDigest: c.payloadDigest, seq: c.seq,
    readHandleIds: [opened.readHandle.readHandleId] }));
  assert.equal(f.control.completion({ projectId: 'project' }).complete, true);
});

test('read proofs have exact body/action scope, nonce replay rejects, and changed request identity conflicts', async t => {
  const f = setup(t); f.subscribe();
  const input = f.signed('open', { delegation: 'member', projectId: 'project', conversationId: 'conversation', action: 'get', after: 0 });
  await assert.rejects(f.control.open({ ...input, body: { ...input.body, delegation: 'owner' } }), { code: 'instance-invocation-forbidden' });
  await f.control.open(input);
  await assert.rejects(f.control.open(input), { code: 'read-control-replay' });
  await assert.rejects(f.open('owner', { requestId: input.body.requestId }), { code: 'read-request-mismatch' });
  assert.throws(() => f.control.closeReads({ ...input, body: { requestId: 'close', nonce: randomUUID(), readHandleIds: [] } }), { code: 'instance-invocation-forbidden' });
});

test('same control scope has immutable payload and rollback cannot publish a phantom control', async t => {
  const f = setup(t); f.subscribe(); await f.open();
  const c = f.fence();
  assert.equal(f.fence().controlId, c.controlId);
  assert.throws(() => f.fence({ ownerAccountId: 'forged' }), { code: 'read-control-mismatch' });
  const head = f.ledger.read().agentReadsV1.head;
  assert.throws(() => f.ledger.transaction(state => {
    f.control.hooks.fenceInState(state, { kind: 'delete', projectId: 'project', requestId: 'rollback' });
    throw new Error('rollback');
  }), /rollback/);
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(f.ledger.read().agentReadsV1.head, head);
  assert.equal(f.frames.some(frame => frame.seq > head), false);
});

test('legacy Agent ACK cannot bypass mandatory read closure, including module loss after SQLite reopen', t => {
  const f = setup(t);
  const event = f.ledger.transaction(state => appendAccessEvent(state, { type: 'login-revoked', loginIds: ['login-member'] }));
  const receipt = { receiptId: 'unproved', cursor: event.seq, complete: true, closedStreams: [], stoppedRuns: [], rejectedCredentials: [] };
  const authority = createAccountAuthority({ ledger: f.ledger });
  t.after(() => authority.close());
  assert.equal(f.ledger.read().agentReadControlRequired, true);
  assert.throws(() => authority.ackAccessEvent(event.eventId, 'agent', receipt), { code: 'agent-read-closure-required' });
  assert.equal(authority.ackAccessEvent(event.eventId, 'asset', receipt).complete, true);
  f.control.close();
  const reopened = openAccountLedger({ file: f.file, authorityId: 'read-core' });
  const absentModule = createAccountAuthority({ ledger: reopened });
  try { assert.throws(() => absentModule.ackAccessEvent(event.eventId, 'agent', receipt), { code: 'agent-read-closure-required' }); }
  finally { absentModule.close(); reopened.close(); }
});

test('only complete internal zero-run closure can produce the legacy ACK digest; real run inventory remains pending', async t => {
  const f = setup(t); f.subscribe(); const opened = await f.open(), id = opened.readHandle.readHandleId;
  const { event, control } = f.ledger.transaction(state => {
    state.revokedLogins['login:login-member'] = { seq: 1 };
    const event = appendAccessEvent(state, { type: 'login-revoked', loginIds: ['login-member'] });
    const control = f.control.hooks.fenceInState(state, { kind: 'credential', loginIds: ['login-member'],
      accessSeq: event.seq, requestId: `access:${event.eventId}` });
    return { event, control };
  });
  assert.throws(() => f.control.finalizeAccessEvent({ eventId: event.eventId }), { code: 'read-close-pending' });
  f.control.closeReads(f.signed('close', { readHandleIds: [id] }));
  f.control.acknowledge(f.signed('ack', { controlId: control.controlId, payloadDigest: control.payloadDigest, seq: control.seq, readHandleIds: [id] }));
  f.ledger.transaction(state => { state.runControlsV2 = { pending: { requestId: `access:${event.eventId}`,
    instances: [f.process.registration], revoked: ['existing-run'], retained: [] } }; });
  assert.throws(() => f.control.finalizeAccessEvent({ eventId: event.eventId }), { code: 'agent-run-closure-pending' });
  f.ledger.transaction(state => { delete state.runControlsV2.pending; });
  const closure = f.control.finalizeAccessEvent({ eventId: event.eventId });
  const authority = createAccountAuthority({ ledger: f.ledger }); t.after(() => authority.close());
  const receipt = { receiptId: 'closed', cursor: event.seq, complete: true, closedStreams: [id], stoppedRuns: [], rejectedCredentials: ['login-member'] };
  assert.throws(() => authority.ackAccessEvent(event.eventId, 'agent', { ...receipt, agentReadClosureDigest: 'a'.repeat(64) }), { code: 'agent-read-closure-required' });
  assert.equal(authority.ackAccessEvent(event.eventId, 'agent', { ...receipt, agentReadClosureDigest: closure.digest }).complete, true);
  assert.deepEqual(f.control.finalizeAccessEvent({ eventId: event.eventId }), closure);
});

for (const lostOldAccountAck of [false, true]) test(`pre-existing legacy Agent ACK stays evidence, not completion after required/reopen (outbox=${lostOldAccountAck})`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-read-legacy-'));
  const file = path.join(dir, 'doc.sqlite'), authorityId = 'legacy-read';
  let ledger = openAccountLedger({ file, authorityId });
  const event = { v: 2, issuer: 'visuhive-account', type: 'credentials-revoked', eventId: 'account-exit',
    accountId: 'acc_' + 'a'.repeat(24), seq: 1, changeSeq: 1, changedAt: 1, oldLoginIds: ['old-login'] };
  let sends = 0;
  const client = { async events(after) { return { headSeq: 1, events: after ? [] : [event] }; },
    async ack() { sends++; if (lostOldAccountAck && sends === 1) throw new Error('lost-old-account-ack'); } };
  // The doc/page side of this isolated counter has no transports or operations.
  // It does not supply an Agent receipt, which is precisely the missing proof.
  const options = { accountClient: client, pollMs: 0,
    getDocBarrier: async barrier => ({ eventId: barrier.eventId, accountEventSeq: 1, pendingSeals: 0,
      connections: [], endCursor: 0, clockEvidence: {}, modifications: {} }), verifyDocBarrier: async () => true };
  let authority = createAccountAuthority({ ledger, ...options });
  t.after(() => { authority.close(); ledger.close(); fs.rmSync(dir, { recursive: true }); });
  await authority.synchronize();
  const barrier = authority.revocationStatus(event.eventId);
  const legacy = { receiptId: 'legacy', cursor: barrier.accessSeq, complete: true,
    closedStreams: [], stoppedRuns: [], rejectedCredentials: ['old-login'] };
  for (const service of ['asset', 'agent', 'render']) authority.ackAccessEvent(barrier.accessEventId, service, legacy);
  if (lostOldAccountAck) await assert.rejects(authority.flushAccountAcknowledgements(), /lost-old-account-ack/);
  const instances = instanceFixture(ledger);
  const required = createAgentReadControl({ ledger, instanceAuthority: instances.authority,
    authorizeRead: async () => { throw Error('no-read-issued'); }, checkReadInState: conversationReadInState });
  required.close(); instances.close(); authority.close(); ledger.close();
  ledger = openAccountLedger({ file, authorityId });
  authority = createAccountAuthority({ ledger, ...options }); // read module intentionally absent
  const before = sends, status = authority.revocationStatus(event.eventId);
  const flushed = await authority.flushAccountAcknowledgements();
  t.diagnostic(JSON.stringify({ lostOldAccountAck, agentPending: status.pendingServices.includes('agent'),
    forwardedAfterRequired: sends - before, pendingEvents: flushed.pendingEvents.length }));
  assert.deepEqual(ledger.read().accessAcks[`ack:${barrier.accessEventId}:agent`], legacy);
  assert.equal(status.serviceAcks.asset.complete, true);
  assert.equal(status.pendingServices.includes('agent'), true);
  assert.equal(sends, before);
  assert.deepEqual(flushed.pendingEvents, [event.eventId]);
});

test('已关的读取只留最近几十条：早关的连同开启记录删掉；还在等回执的、开着的不删；删完重启照样能读能关', async t => {
  const f = setup(t); f.subscribe();
  const extra = 5, ids = [];
  for (let i = 0; i < KEEP_CLOSED_READS_PER_INSTANCE + extra; i++) {
    const opened = await f.open(); ids.push(opened.readHandle.readHandleId);
    f.control.closeReads(f.signed('close', { readHandleIds: [opened.readHandle.readHandleId] }));
  }
  const live = await f.open(), liveId = live.readHandle.readHandleId;
  let t1 = f.ledger.read().agentReadsV1;
  assert.equal(Object.values(t1.handles).filter(h => h.state === 'closed').length, KEEP_CLOSED_READS_PER_INSTANCE);
  for (const id of ids.slice(0, extra)) assert.equal(t1.handles[id], undefined);
  for (const id of ids.slice(extra)) assert.equal(t1.handles[id].state, 'closed');
  assert.equal(t1.handles[liveId].state, 'open');
  assert.equal(Object.values(t1.requests).filter(row => !t1.handles[row.readHandleId]).length, 0, '开启记录不留悬空的');
  // 控制记录在等回执的那条，关了也不删，直到回执落账
  const c = f.fence();
  f.control.closeReads(f.signed('close', { readHandleIds: [liveId] }));
  for (let i = 0; i < 3; i++) {
    const opened = await f.open('owner');
    f.control.closeReads(f.signed('close', { readHandleIds: [opened.readHandle.readHandleId] }));
  }
  assert.equal(f.ledger.read().agentReadsV1.handles[liveId].state, 'closed', '等回执的那条还在');
  f.control.acknowledge(f.signed('ack', { controlId: c.controlId, payloadDigest: c.payloadDigest, seq: c.seq, readHandleIds: [liveId] }));
  assert.equal(f.control.completion({ projectId: 'project', conversationId: 'conversation' }).complete, true);
  t1 = f.ledger.read().agentReadsV1;
  assert.equal(Object.values(t1.handles).filter(h => h.state === 'closed').length, KEEP_CLOSED_READS_PER_INSTANCE);
  assert.equal(pruneClosedReads(structuredClone(f.ledger.read())), 0, '已经修剪到位');
  f.restart(); f.subscribe();
  const again = await f.open('owner');
  f.control.closeReads(f.signed('close', { readHandleIds: [again.readHandle.readHandleId] }));
  assert.equal(Object.values(f.ledger.read().agentReadsV1.handles).filter(h => h.state === 'closed').length, KEEP_CLOSED_READS_PER_INSTANCE);
  // 长连接反复用同一个 requestId 调 open（如 SSE 事件流 250ms 轮询）时，第一次落盘后后续复核不再重写 SQLite，且重放随机数仍被拒
  const sseReqId = `sse_${randomUUID()}`;
  await f.control.open(f.signed('open', { requestId: sseReqId, delegation: 'owner', projectId: 'project', conversationId: 'conversation', action: 'get', after: 0 }));
  const noncesAfterFirstSse = Object.keys(f.ledger.read().agentReadsV1.nonces).length;
  const replayedCall = f.signed('open', { requestId: sseReqId, delegation: 'owner', projectId: 'project', conversationId: 'conversation', action: 'get', after: 0 });
  await f.control.open(replayedCall);
  await assert.rejects(f.control.open(replayedCall), { status: 409, code: 'read-control-replay' });
  for (let i = 0; i < 20; i++) {
    await f.control.open(f.signed('open', { requestId: sseReqId, delegation: 'owner', projectId: 'project', conversationId: 'conversation', action: 'get', after: 0 }));
  }
  assert.equal(Object.keys(f.ledger.read().agentReadsV1.nonces).length, noncesAfterFirstSse, '已处于 open 的同一 requestId 复核不再重复写 SQLite');
  f.control.closeReads(f.signed('close', { readHandleIds: [`read_${f.ledger.read().agentReadsV1.requests[Object.keys(f.ledger.read().agentReadsV1.requests).at(-1)].readHandleId.slice(5)}`] }));
  // 不同 requestId 的大量新建读取：nonces 表严格封顶在 KEEP_READ_CONTROL_NONCES
  for (let i = 0; i < KEEP_READ_CONTROL_NONCES + 20; i++) {
    const opened = await f.open('owner');
    f.control.closeReads(f.signed('close', { readHandleIds: [opened.readHandle.readHandleId] }));
  }
  assert.equal(Object.keys(f.ledger.read().agentReadsV1.nonces).length, KEEP_READ_CONTROL_NONCES);
});

const LOCK = 'lock_00000000-0000-4000-8000-000000000001', MACHINE = 'a'.repeat(64), OTHER_MACHINE = 'b'.repeat(64);
const lease = (f, p, fields = {}) => f.control.declareLease(f.signed('lease', { lockId: LOCK, machine: MACHINE, ...fields }, p));
const handover = (f, p, prior) => f.control.handover(f.signed('handover', { instanceId: prior.registration.instanceId,
  instanceGeneration: prior.registration.instanceGeneration }, p));
const controlOnly = (f, ...ps) => f.ledger.transaction(state => { for (const p of ps) state.agentInstancesV2[p.registration.instanceId].purpose = 'control-only'; });

test('〔裁〕H07 主服务重启：新一代登记、订阅都不算证据，旧实例开着的读取照旧等；新一代凭同一把锁交了证据才收口；历史访问事件补建控制记录', async t => {
  const f = setup(t);
  controlOnly(f, f.process);
  lease(f, f.process);
  const unsubOld = f.subscribe();
  await f.open('member');
  // 模拟：访问事件先写入账本（当时未调 fenceInState）
  const event = f.ledger.transaction(state => appendAccessEvent(state, {
    type: 'login-revoked', accountEventId: 'logout-after-restart', accountEventSeq: 1,
    accountIds: ['member-account'], loginIds: ['login-member'], createdAt: 1,
  }));
  f.control.reconcileAccessEvents();
  assert.throws(() => f.control.finalizeAccessEvent({ eventId: event.eventId }), { code: 'read-close-pending' });
  // 新一代主服务登记并连上订阅：这本身不是旧进程不在了的证据（原来凭这一条就收口，已去掉）
  const nextProc = f.instances.boot(); controlOnly(f, nextProc);
  const unsub = f.subscribe(nextProc);
  t.after(() => unsub());
  assert.throws(() => f.control.finalizeAccessEvent({ eventId: event.eventId }), { code: 'read-close-pending' });
  assert.equal(f.ledger.read().agentInstancesV2[f.process.registration.instanceId].state, 'active');
  // 新一代报了同一把锁，但旧实例还连着订阅流（还活着）：证据和事实矛盾，不收口
  lease(f, nextProc);
  assert.throws(() => handover(f, nextProc, f.process), { status: 409, code: 'read-handover-predecessor-live' });
  assert.throws(() => f.control.finalizeAccessEvent({ eventId: event.eventId }), { code: 'read-close-pending' });
  // 旧实例的订阅流断了：照旧不收口（断线不是证据）
  unsubOld();
  assert.throws(() => f.control.finalizeAccessEvent({ eventId: event.eventId }), { code: 'read-close-pending' });
  // 新一代交了证据，核过才收口
  const result = handover(f, nextProc, f.process);
  assert.equal(result.closed, true);
  const closure = f.control.finalizeAccessEvent({ eventId: event.eventId });
  assert.equal(closure.payload.complete, true);
  const old = f.ledger.read().agentInstancesV2[f.process.registration.instanceId];
  assert.equal(old.state, 'closed');
  assert.equal(old.closure.witnessId, `handover:${nextProc.registration.instanceId}:${nextProc.registration.instanceGeneration}`);
  assert.equal(old.closure.evidence, 'agent-data-dir-exclusive-lock');
  // 收口了的旧实例再也认不过（连订阅、开读取都不行）；同一份证据再交一遍不报错
  assert.throws(() => f.subscribe(), { code: 'instance-revoked' });
  assert.equal(handover(f, nextProc, f.process).closed, true);
});

test('〔裁〕H07 反向：证据对不上一样都不收口——锁号不同、机器不同、没报过锁、用途不同、更新的一代、只跑一条任务的进程、报过的锁不能改', async t => {
  const f = setup(t);
  const unsubOld = f.subscribe(); const opened = await f.open('member');
  const c = f.fence();
  assert.deepEqual(c.targets[f.process.registration.instanceId].readHandleIds, [opened.readHandle.readHandleId]);
  const pending = () => assert.equal(f.control.completion({ projectId: 'project' }).complete, false);
  const successor = (fields = {}) => { const p = f.instances.boot(); f.subscribe(p); if (fields !== null) lease(f, p, fields); return p; };
  // 旧实例的订阅流断了（断线本身不是证据）；它没报过锁：后继拿什么锁都不算
  unsubOld();
  const s0 = successor();
  assert.throws(() => handover(f, s0, f.process), { status: 403, code: 'read-handover-unproven' }); pending();
  // 旧实例报了锁之后：后继的锁号不同、机器不同、后继自己没报，都不算
  f.ledger.transaction(state => { state.agentReadsV1.leases = { [f.process.registration.instanceId]: {
    serviceId: 'agent', serviceKid: 'agent-test-key', instanceId: f.process.registration.instanceId,
    instanceGeneration: f.process.registration.instanceGeneration, lockId: LOCK, machine: MACHINE, declaredSeq: 0 } }; });
  const sLock = successor({ lockId: 'lock_00000000-0000-4000-8000-000000000002' });
  assert.throws(() => handover(f, sLock, f.process), { code: 'read-handover-unproven' }); pending();
  const sMachine = successor({ machine: OTHER_MACHINE });
  assert.throws(() => handover(f, sMachine, f.process), { code: 'read-handover-unproven' }); pending();
  const sNone = successor(null);
  assert.throws(() => handover(f, sNone, f.process), { code: 'read-handover-unproven' }); pending();
  // 报过的锁不能改
  assert.throws(() => lease(f, sLock), { status: 409, code: 'read-lease-mismatch' });
  // 用途不同（后继是只做控制的主服务，旧的不是）
  const sPurpose = successor(); controlOnly(f, sPurpose);
  assert.throws(() => handover(f, sPurpose, f.process), { status: 403, code: 'read-handover-forbidden' }); pending();
  // 报锁报得晚的那个是「前一个」：不行（报锁先后就是握锁先后）
  const sGood = successor();
  assert.throws(() => handover(f, f.process, sGood), { code: 'read-handover-forbidden' }); pending();
  // 前一个是只跑一条任务的进程：不归这里管
  f.ledger.transaction(state => { state.agentInstancesV2[f.process.registration.instanceId].purpose = 'run-worker'; });
  assert.throws(() => handover(f, sGood, f.process), { code: 'read-handover-forbidden' }); pending();
  f.ledger.transaction(state => { delete state.agentInstancesV2[f.process.registration.instanceId].purpose; });
  // 不认识的实例、代对不上
  assert.throws(() => f.control.handover(f.signed('handover', { instanceId: f.process.registration.instanceId,
    instanceGeneration: f.process.registration.instanceGeneration + 100 }, sGood)), { status: 404, code: 'read-handover-unknown' });
  pending();
  assert.equal(f.ledger.read().agentInstancesV2[f.process.registration.instanceId].state, 'active');
  // 都对上了才收口
  assert.equal(handover(f, sGood, f.process).closed, true);
  assert.equal(f.control.completion({ projectId: 'project' }).complete, true);
});

test('〔裁〕H07（审查 F2）：先后看报锁，不看代次——代次低、后拿到锁的后继能替代次高、先握锁的前一个交；反过来不行', async t => {
  const f = setup(t); f.subscribe();                                // 夹具自带的那个实例：连着，名下没有读取
  const low = f.instances.boot(), high = f.instances.boot();       // low 先登记（代次低），high 后登记
  assert.ok(low.registration.instanceGeneration < high.registration.instanceGeneration);
  controlOnly(f, low, high);
  lease(f, high); const unsubHigh = f.subscribe(high);              // high 先拿到锁、先报锁、开着读取
  const opened = await f.open('member', {}, high);
  const c = f.fence();
  assert.deepEqual(c.targets[high.registration.instanceId].readHandleIds, [opened.readHandle.readHandleId]);
  unsubHigh();                                                      // high 的进程没了，锁放开
  lease(f, low); f.subscribe(low);                                  // low 这时才拿到锁、报锁
  assert.throws(() => handover(f, high, low), { status: 403, code: 'read-handover-forbidden' }, '报锁晚的不能被报锁早的「交掉」');
  assert.equal(handover(f, low, high).closed, true);
  assert.equal(f.control.completion({ projectId: 'project' }).complete, true);
  assert.equal(f.ledger.read().agentInstancesV2[high.registration.instanceId].state, 'closed');
});

test('〔裁〕H07（审查必改一）：报锁时机器只收 64 位十六进制摘要；可读的机器识别码进不了账本', async t => {
  const f = setup(t);
  assert.throws(() => lease(f, f.process, { machine: 'PCM-ABCDE-ABCDE-ABCDE-ABCDE' }), { status: 400, code: 'read-control-request-invalid' });
  assert.throws(() => lease(f, f.process, { machine: 'A'.repeat(64) }), { status: 400, code: 'read-control-request-invalid' });
  assert.equal(f.ledger.read().agentReadsV1?.leases?.[f.process.registration.instanceId], undefined);
  const ok = lease(f, f.process);
  assert.equal(ok.machine, MACHINE); assert.equal(ok.declaredSeq, 1);
  assert.equal(lease(f, f.process).declaredSeq, 1, '同一份再报不另记序号');
});

test('〔裁〕H07：从没订阅过的新实例不挡退出；它订阅以后开的读取照常要它自己关、自己确认', async t => {
  const f = setup(t); f.subscribe(); const opened = await f.open('member');
  const idle = f.instances.boot();
  const c = f.fence();
  assert.equal(c.targets[idle.registration.instanceId], undefined, '没订阅过的实例名下没有读取，不等它');
  f.control.closeReads(f.signed('close', { readHandleIds: [opened.readHandle.readHandleId] }));
  f.control.acknowledge(f.signed('ack', { controlId: c.controlId, payloadDigest: c.payloadDigest, seq: c.seq,
    readHandleIds: [opened.readHandle.readHandleId] }));
  assert.equal(f.control.completion({ projectId: 'project' }).complete, true);
  // 它订阅、开了读取以后，下一次点名照常等它
  f.subscribe(idle); const later = await f.open('owner', {}, idle);
  const next = f.ledger.transaction(state => f.control.hooks.fenceInState(state, { kind: 'delete', projectId: 'project', requestId: 'delete-later' }));
  assert.deepEqual(next.targets[idle.registration.instanceId].readHandleIds, [later.readHandle.readHandleId]);
  assert.equal(f.control.completion({ accessSeq: undefined, projectId: 'project', conversationId: undefined }).complete, false);
});

test('旧一代主服务收口以后，它名下已关的读取一条不留（不再按每个实例留 64 条）', async t => {
  const f = setup(t);
  controlOnly(f, f.process); lease(f, f.process);
  const unsubOld = f.subscribe();
  for (let i = 0; i < 5; i++) {
    const opened = await f.open('member');
    f.control.closeReads(f.signed('close', { readHandleIds: [opened.readHandle.readHandleId] }));
  }
  const oldId = f.process.registration.instanceId;
  const ofOld = () => Object.values(f.ledger.read().agentReadsV1.handles).filter(h => h.instanceId === oldId);
  assert.equal(ofOld().length, 5, '还活着的实例照旧留着');
  unsubOld();
  const nextProc = f.instances.boot(); controlOnly(f, nextProc);
  const unsub = f.subscribe(nextProc);
  t.after(() => unsub());
  assert.equal(f.ledger.read().agentInstancesV2[oldId].state, 'active', '新一代订阅了不算旧的收口');
  lease(f, nextProc); handover(f, nextProc, f.process);
  assert.equal(f.ledger.read().agentInstancesV2[oldId].state, 'closed');
  assert.equal(ofOld().length, 0, '收口了的旧一代：已关读取全删');
  assert.equal(Object.values(f.ledger.read().agentReadsV1.requests).filter(row => !f.ledger.read().agentReadsV1.handles[row.readHandleId]).length, 0, '开启记录不留悬空的');
  // 新一代照常能读能关
  const opened = await f.open('member', {}, nextProc);
  f.control.closeReads(f.signed('close', { readHandleIds: [opened.readHandle.readHandleId] }, nextProc));
  assert.equal(f.ledger.read().agentReadsV1.handles[opened.readHandle.readHandleId].state, 'closed');
});

test('用过的随机数只留 10 分钟:窗口内重放照样拒;过期的和老格式(true)的都删掉,账本不再无限变大', async t => {
  const f = setup(t); f.subscribe();
  const input = f.signed('open', { delegation: 'member', projectId: 'project', conversationId: 'conversation', action: 'get', after: 0 });
  const opened = await f.control.open(input);
  await assert.rejects(f.control.open(input), { code: 'read-control-replay' }, '窗口内重放照样拒');
  const t1 = f.ledger.read().agentReadsV1.nonces;
  assert.ok(Object.values(t1).every(v => typeof v === 'number'), '新记的都带时间');
  // 造一条过期的、一条老格式的
  f.ledger.transaction(state => {
    state.agentReadsV1.nonces.expired = Date.now() - READ_NONCE_TTL_MS - 1;
    state.agentReadsV1.nonces.legacy = true;
  });
  f.control.closeReads(f.signed('close', { readHandleIds: [opened.readHandle.readHandleId] }));
  const t2 = f.ledger.read().agentReadsV1.nonces;
  assert.equal(t2.expired, undefined); assert.equal(t2.legacy, undefined);
  assert.ok(Object.keys(t2).length >= 2, '窗口内的留着');
  const table = { nonces: { a: 1000, b: 999_999, c: true } };
  assert.equal(pruneNonces(table, 1_000_000, 10), 2); assert.deepEqual(Object.keys(table.nonces), ['b']);
});

test('同一登录续期访问令牌(credentialId 轮换、loginId 与 loginGeneration 不变)不会掐断已打开的 SSE 读取流', async t => {
  const f = setup(t); f.subscribe();
  const reqId = `http-read_${randomUUID()}`;
  const first = await f.open('member', { requestId: reqId });
  assert.equal(first.readHandle.credentialId, 'cred-member');
  f.principals.member.credentialId = 'cred-member-renewed';
  const second = await f.open('member', { requestId: reqId });
  assert.equal(second.readHandle.readHandleId, first.readHandle.readHandleId);
  assert.equal(second.readHandle.credentialId, 'cred-member-renewed');
  f.principals.member.loginGeneration = 2;
  await assert.rejects(f.open('member', { requestId: reqId }), { status: 409, code: 'read-request-mismatch' });
});

