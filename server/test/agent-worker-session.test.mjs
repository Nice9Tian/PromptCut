import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { createAgentInstanceSession } from '../agent/service/agent-instance-session.mjs';
import { canonicalJson, digestOf } from '../account/ledger.mjs';
import { validateAgentScopeTerminal } from '../hosted/agent-run-scope-schema.mjs';
import { scopeModel, signed } from './agent-run-scope-fixture.mjs';
import { createRunClient } from '../agent-service/run-client.mjs';
import { instanceProofPayload, instanceTlsBinding } from '../account/agent-instance-authority.mjs';

// Real Ed25519/signature validation; registration/local drain and OS lifecycle
// are controlled adapters here. This is not a Doc/root/production admission.
async function setup({ source = async value => value, rootRegistration = false, changeChallenge = value => value,
  changeResult = value => value, eventSource = null } = {}) {
  const model = scopeModel(); let wirePublicKey;
  const session = createAgentInstanceSession({ scopePrepareSource: source, workerEventSource: eventSource,
    requestRegistration: async (name, body) => {
      if (name === 'challenge') {
        wirePublicKey = body.publicKey;
        return changeChallenge({ domain: 'promptcut.agent-instance.register.v1', authorityId: 'doc', serviceId: 'agent',
          serviceKid: 'agent-kid', requestId: body.requestId, challengeId: 'challenge', nonce: 'nonce',
          publicKeyDigest: digestOf(body.publicKey), ...(body.rootScopeRef ? { purpose: 'run-worker', rootScopeRef: body.rootScopeRef,
            docPublicKeyDigest: digestOf(body.publicKey), scopePublicKeyDigest: session.scopeIdentity().scopePublicKeyDigest } : {}) });
      }
      assert.ok(verify(null, Buffer.from(canonicalJson(body.challenge)), wirePublicKey,
        Buffer.from(body.signature, 'base64url')));
      return changeResult({ authorityId: 'doc', serviceId: 'agent', serviceKid: 'agent-kid',
        instanceId: model.files.get('epoch-1.json').instance.instanceId, instanceGeneration: 1,
        ...(body.challenge.rootScopeRef ? { purpose: 'run-worker', rootScopeRef: body.challenge.rootScopeRef } : {}) });
    } });
  const key = session.scopeIdentity();
  const identity = model.io.identity;
  model.io.identity = async reservation => ({ ...await identity(reservation),
    publicKey: key.scopePublicKey, publicKeyDigest: key.scopePublicKeyDigest });
  await model.run('initialize');
  if (rootRegistration) session.configureRegistrationScope({ expected: model.expected, record: model.files.get('epoch-1.json') });
  try { await session.register(); } catch (error) { session.close(); throw error; }
  const record = model.files.get('epoch-1.json'), assignment = model.assignment();
  return { session, model, record, assignment, key, wirePublicKey };
}

const prepareOf = ({ model, record, assignment }) => ({ v: 1, domain: 'promptcut.agent-run.prepare.v1',
  scope: { authorityId: model.expected.authorityId, slotId: model.expected.slotId,
    epoch: record.epoch, recordDigest: digestOf(record), assignmentDigest: digestOf(assignment) },
  target: assignment.target, readReceiptId: 'read', finishReceiptId: 'finish', outcomeDigest: 'a'.repeat(64),
  eventId: 'terminal-event', eventDigest: 'b'.repeat(64), drainReceiptId: 'drain',
  docControlId: 'control', docFenceRevision: 1 });

test('worker public PEM/DER refer to one RAM key and retain distinct digest rules', async () => {
  const x = await setup();
  try {
    assert.equal(x.wirePublicKey, x.key.publicKey);
    assert.equal(createPublicKey(x.key.publicKey).export({ format: 'der', type: 'spki' }).toString('base64'), x.key.scopePublicKey);
    assert.equal(x.key.docPublicKeyDigest, digestOf(x.key.publicKey));
    assert.equal(x.key.scopePublicKeyDigest, digestOf(x.key.scopePublicKey));
    assert.notEqual(x.key.docPublicKeyDigest, x.key.scopePublicKeyDigest);
    assert.equal(Object.keys(x.key).some(k => /private/i.test(k)), false);
    const other = await setup();
    try { assert.notEqual(other.key.scopePublicKey, x.key.scopePublicKey); } finally { other.session.close(); }
  } finally { x.session.close(); }
});

function workerPacket(x) {
  return { v: 1, authorityId: 'doc', rootScopeRef: { rootAuthorityId: x.model.expected.authorityId,
    slotId: x.model.expected.slotId, epoch: x.record.epoch, recordDigest: digestOf(x.record) },
  assignmentDigest: digestOf(x.assignment), binding: { ...Object.fromEntries(['projectId', 'conversationId',
    'messageId', 'runId', 'runGrantId', 'instanceId', 'instanceGeneration', 'serviceKid'].map(k => [k, x.assignment.target[k]])),
    senderAccountId: 'account-a' }, sourceSeq: 1, eventId: 'worker-event:1', event: { type: 'text', delta: 'kept' } };
}

test('worker event signer uses its own domain, full original body and current TLS exporter', async () => {
  const x = await setup({ rootRegistration: true, eventSource: async packet => packet });
  try {
    x.session.bindScope({ expected: x.model.expected, record: x.record, assignment: x.assignment });
    const packet = workerPacket(x), bodyText = JSON.stringify(packet);
    const socket = { encrypted: true, authorized: true, destroyed: false,
      exportKeyingMaterial: (_length, label) => { assert.equal(label, 'EXPORTER-PromptCut-Agent-Worker-Event-v1'); return Buffer.alloc(32, 4); } };
    const proof = await x.session.workerEventProofFor({ socket, bodyText, packet, nonce: 'event-nonce' });
    const protocol = await import('../agent-service/worker-event-internal.mjs');
    const parsed = JSON.parse(Buffer.from(proof.value, 'base64url').toString('utf8'));
    const request = protocol.workerEventRequest({ body: packet, bodyText });
    const payload = protocol.workerEventProofPayload({ request, channelBinding: protocol.workerEventTlsBinding(socket), nonce: parsed.nonce });
    assert.equal(proof.name, protocol.WORKER_EVENT_PROOF_HEADER);
    assert.ok(verify(null, Buffer.from(canonicalJson(payload)), x.key.publicKey, Buffer.from(parsed.signature, 'base64url')));
    for (const changed of [{ ...payload, path: '/internal/v2/runs/check' }, { ...payload, method: 'GET' },
      { ...payload, nonce: 'replay-nonce' }, { ...payload, channelBinding: 'a'.repeat(64) },
      protocol.workerEventProofPayload({ request: protocol.workerEventRequest({ body: packet, bodyText: ' ' + bodyText }),
        channelBinding: protocol.workerEventTlsBinding(socket), nonce: parsed.nonce })])
      assert.equal(verify(null, Buffer.from(canonicalJson(changed)), x.key.publicKey, Buffer.from(parsed.signature, 'base64url')), false);
    assert.throws(() => protocol.workerEventRequest({ body: packet, bodyText: JSON.stringify({ ...packet, sourceSeq: 2 }) }));
    assert.throws(() => protocol.workerEventRequest({ body: packet, bodyText: null }));
  } finally { x.session.close(); }
});

test('event signing requires durable private source and exact bound worker identity', async () => {
  for (const eventSource of [null, async () => { throw Error('worker-event-not-durable'); },
    async packet => ({ ...packet, sourceSeq: 2 })]) {
    const x = await setup({ rootRegistration: true, eventSource });
    try {
      x.session.bindScope({ expected: x.model.expected, record: x.record, assignment: x.assignment });
      const packet = workerPacket(x), socket = { encrypted: true, authorized: true, destroyed: false,
        exportKeyingMaterial: () => Buffer.alloc(32, 4) };
      await assert.rejects(x.session.workerEventProofFor({ socket, packet, bodyText: JSON.stringify(packet), nonce: 'n' }));
      const wrong = { ...packet, binding: { ...packet.binding, runGrantId: 'another-run' } };
      await assert.rejects(x.session.workerEventProofFor({ socket, packet: wrong, bodyText: JSON.stringify(wrong), nonce: 'n' }));
    } finally { x.session.close(); }
  }
});

test('closed TLS after durable source await cannot sign a worker packet', async () => {
  let sourceEntered, release;
  const entered = new Promise(resolve => { sourceEntered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const x = await setup({ rootRegistration: true, eventSource: async packet => { sourceEntered(); await wait; return packet; } });
  try {
    x.session.bindScope({ expected: x.model.expected, record: x.record, assignment: x.assignment });
    const packet = workerPacket(x), socket = { encrypted: true, authorized: true, destroyed: false,
      exportKeyingMaterial: () => Buffer.alloc(32, 4) };
    const work = x.session.workerEventProofFor({ socket, packet, bodyText: JSON.stringify(packet), nonce: 'n' });
    const observed = work.catch(error => error);
    await entered; socket.destroyed = true; release();
    assert.match((await observed).message, /worker-event-transport/);
  } finally { release(); x.session.close(); }
});

test('root-scoped registration binds the exact record and rejects swapped digest/ref/instance', async () => {
  const x = await setup({ rootRegistration: true });
  try {
    x.session.bindScope({ expected: x.model.expected, record: x.record, assignment: x.assignment });
    assert.throws(() => x.session.configureRegistrationScope({ expected: x.model.expected, record: x.record }), /registration-started/);
  } finally { x.session.close(); }
  await assert.rejects(setup({ rootRegistration: true,
    changeChallenge: value => ({ ...value, scopePublicKeyDigest: value.docPublicKeyDigest }) }), /instance-challenge-scope/);
  await assert.rejects(setup({ rootRegistration: true,
    changeResult: value => ({ ...value, rootScopeRef: { ...value.rootScopeRef, epoch: 2 } }) }), /instance-register-scope/);
  await assert.rejects(setup({ rootRegistration: true,
    changeResult: value => ({ ...value, instanceId: 'replacement-instance' }) }), /instance-register-scope/);
});

test('prepare needs bound assignment/source and intent signs only the matching Doc terminal', async () => {
  const x = await setup();
  try {
    const payload = prepareOf(x);
    await assert.rejects(x.session.scopePrepareFor(payload), /instance-scope-unbound/);
    x.session.bindScope({ expected: x.model.expected, record: x.record, assignment: x.assignment });
    const prepare = await x.session.scopePrepareFor(payload);
    assert.ok(verify(null, Buffer.from(digestOf(payload)), createPublicKey(x.key.publicKey), Buffer.from(prepare.signature, 'base64url')));
    assert.equal('closed' in prepare, false); assert.equal('resourceWitnessId' in prepare, false);
    const terminal = signed({ v: 1, protocol: 'promptcut.agent-run-scope.terminal.v1', authorityId: x.model.expected.authorityId,
      slotId: x.model.expected.slotId, epoch: 1, recordDigest: digestOf(x.record), docAuthorityId: 'doc',
      assignmentDigest: digestOf(x.assignment), finish: { readReceiptId: 'read', finishReceiptId: 'finish',
        outcomeDigest: payload.outcomeDigest, terminalReceiptDigest: digestOf(prepare) } }, x.model.doc.privateKey);
    const intent = x.session.scopeIntentFor({ assignment: x.assignment, terminal });
    assert.deepEqual(validateAgentScopeTerminal(terminal, intent, x.model.expected, x.record, x.assignment), terminal);
    assert.throws(() => x.session.scopeIntentFor({ assignment: x.assignment,
      terminal: { ...terminal, finish: { ...terminal.finish, outcomeDigest: 'c'.repeat(64) } } }));
    x.session.close(); assert.throws(() => x.session.scopeIntentFor({ assignment: x.assignment, terminal }), /closed/);
  } finally { x.session.close(); }
});

test('different key, instance, scope, extra closed declaration and conflicting prepare are rejected', async () => {
  const x = await setup();
  try {
    assert.throws(() => x.session.bindScope({ expected: x.model.expected, record: x.record,
      assignment: x.model.assignment({ publicKeyDigest: x.key.docPublicKeyDigest }) }));
    assert.throws(() => x.session.bindScope({ expected: x.model.expected, record: x.record,
      assignment: x.model.assignment({ instanceGeneration: 2 }) }), /instance-scope-binding/);
    x.session.bindScope({ expected: x.model.expected, record: x.record, assignment: x.assignment });
    const payload = prepareOf(x);
    await assert.rejects(x.session.scopePrepareFor({ ...payload, closed: true }), /instance-scope-prepare/);
    await assert.rejects(x.session.scopePrepareFor({ ...payload, scope: { ...payload.scope, epoch: 2 } }), /instance-scope-prepare/);
    await x.session.scopePrepareFor(payload);
    await assert.rejects(x.session.scopePrepareFor({ ...payload, eventDigest: 'c'.repeat(64) }), /instance-scope-prepare-conflict/);
  } finally { x.session.close(); }
});

test('prepare source failure or changes reject and cannot create an intent', async () => {
  for (const source of [null, async () => { throw Error('durable-event-failed'); }, async value => ({ ...value, eventId: 'changed' })]) {
    const x = await setup({ source });
    try {
      x.session.bindScope({ expected: x.model.expected, record: x.record, assignment: x.assignment });
      await assert.rejects(x.session.scopePrepareFor(prepareOf(x)));
      assert.throws(() => x.session.scopeIntentFor({ assignment: x.assignment, terminal: {} }), /instance-scope-prepare-unavailable/);
    } finally { x.session.close(); }
  }
});

test('assignment proof has a distinct full-body scope; resolve/read and other routes cannot substitute', async () => {
  const x = await setup();
  try {
    // Controlled exporter adapter; real signed payload, not a TLS integration.
    const socket = { encrypted: true, authorized: true, destroyed: false,
      exportKeyingMaterial: () => Buffer.alloc(32, 1) };
    const body = { projectId: 'project', conversationId: 'conversation-slot-a', messageId: 'message-1',
      runId: 'run-1', runGrantId: 'grant-1', requestId: 'assignment:grant-1' };
    const input = { socket, method: 'POST', path: '/internal/v2/runs/assignment', operation: 'scopeAssignment', body };
    const result = x.session.proofFor(input), proof = JSON.parse(Buffer.from(result.value, 'base64url'));
    const payload = instanceProofPayload({ ...x.session.identity(), channelBinding: instanceTlsBinding(socket),
      method: input.method, path: input.path, operation: input.operation, requestDigest: digestOf(body) });
    assert.ok(verify(null, Buffer.from(canonicalJson(payload)), x.key.publicKey, Buffer.from(proof.signature, 'base64url')));
    assert.equal(verify(null, Buffer.from(canonicalJson({ ...payload, operation: 'resolveRunPrincipal' })),
      x.key.publicKey, Buffer.from(proof.signature, 'base64url')), false);
    assert.equal(verify(null, Buffer.from(canonicalJson({ ...payload, requestDigest: digestOf({ ...body, messageId: 'changed' }) })),
      x.key.publicKey, Buffer.from(proof.signature, 'base64url')), false);
    assert.throws(() => x.session.proofFor({ ...input, path: '/internal/v2/runs/check' }), /instance-proof-input/);
    assert.throws(() => x.session.proofFor({ ...input, body: { ...body, action: 'write' } }), /instance-proof-input/);
  } finally { x.session.close(); }
});

test('run client exposes the same public-only key and rejects body identity before creating TLS', async () => {
  const client = createRunClient({ origin: 'https://127.0.0.1:6700', tls: { key: 'unused', cert: 'unused', ca: 'unused' },
    serverFingerprint256: 'a'.repeat(64) });
  try {
    assert.deepEqual(client.scopeIdentity(), client.scopeIdentity());
    await assert.rejects(client.scopeAssignment({ projectId: 'p', conversationId: 'c', messageId: 'm',
      runId: 'r', runGrantId: 'g', requestId: 'a', instanceId: 'forged' }), /invalid-scope-assignment/);
    await assert.rejects(client.scopeAssignment({}), /invalid-scope-assignment/);
    client.close(); assert.throws(() => client.scopeIdentity(), /instance-session-closed/);
  } finally { client.close(); }
});

test('control-only instance signs only scoped metadata/read-control and cannot become a run worker', async () => {
  const session = createAgentInstanceSession({ registrationPurpose: 'control-only',
    requestRegistration: async (name, body) => name === 'challenge'
      ? { domain: 'promptcut.agent-instance.register.v1', authorityId: 'doc', serviceId: 'agent', serviceKid: 'master-kid',
        requestId: body.requestId, challengeId: 'master-challenge', nonce: 'nonce', publicKeyDigest: digestOf(body.publicKey),
        purpose: 'control-only' }
      : { authorityId: 'doc', serviceId: 'agent', serviceKid: 'master-kid', instanceId: 'master-instance',
        instanceGeneration: 1, purpose: 'control-only' } });
  try {
    await session.register();
    const socket = { encrypted: true, authorized: true, destroyed: false, exportKeyingMaterial: () => Buffer.alloc(32, 2) };
    const input = { socket, method: 'POST', path: '/internal/v2/runs/pending', operation: 'pendingRuns', body: {} };
    assert.ok(session.proofFor(input).value);
    assert.throws(() => session.proofFor({ ...input, body: { projectId: 'p' } }), /instance-proof-input/);
    const observer = { ...input, path: '/internal/v2/runs/worker-event-source', operation: 'workerEventSource',
      body: { projectId: 'p', runGrantId: 'g', assignmentDigest: 'a'.repeat(64) } };
    const proof = JSON.parse(Buffer.from(session.proofFor(observer).value, 'base64url'));
    const payload = instanceProofPayload({ ...session.identity(), method: 'POST', path: observer.path,
      operation: 'workerEventSource', requestDigest: digestOf(observer.body), channelBinding: instanceTlsBinding(socket) });
    assert.ok(verify(null, Buffer.from(canonicalJson(payload)), session.scopeIdentity().publicKey, Buffer.from(proof.signature, 'base64url')));
    assert.equal(verify(null, Buffer.from(canonicalJson({ ...payload, operation: 'checkAccess' })),
      session.scopeIdentity().publicKey, Buffer.from(proof.signature, 'base64url')), false);
    assert.throws(() => session.proofFor({ ...observer, body: { ...observer.body, action: 'write' } }), /instance-proof-input/);
    assert.throws(() => session.proofFor({ ...observer, path: '/internal/v2/runs/check' }), /instance-proof-input/);
    assert.throws(() => session.proofFor({ ...input, path: '/internal/v2/runs/admit', operation: 'admit' }), /instance-purpose-forbidden/);
    assert.throws(() => session.dataProofFor({}), /instance-purpose-forbidden/);
    assert.throws(() => session.runAssetIssueProofFor({}), /instance-purpose-forbidden/);
    assert.throws(() => session.runAssetHttpProofFor({}), /instance-purpose-forbidden/);
    assert.throws(() => session.configureRegistrationScope({}), /registration-started/);
    assert.throws(() => session.bindScope({}), /instance-purpose-forbidden/);
  } finally { session.close(); }
});

test('explicit worker registration requires trusted root scope; requested purpose cannot be downgraded', async () => {
  let calls = 0;
  const worker = createAgentInstanceSession({ registrationPurpose: 'run-worker', requestRegistration: async () => { calls++; } });
  try { await assert.rejects(worker.register(), /instance-scope-registration-required/); assert.equal(calls, 0); }
  finally { worker.close(); }
  const master = createAgentInstanceSession({ registrationPurpose: 'control-only', requestRegistration: async (_name, body) => ({
    domain: 'promptcut.agent-instance.register.v1', authorityId: 'doc', serviceId: 'agent', serviceKid: 'kid',
    requestId: body.requestId, challengeId: 'challenge', nonce: 'nonce', publicKeyDigest: digestOf(body.publicKey), purpose: 'run-worker' }) });
  try { await assert.rejects(master.register(), /instance-challenge-purpose/); }
  finally { master.close(); }
});
