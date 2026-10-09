import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { createAgentInstanceSession } from '../agent/service/agent-instance-session.mjs';
import { canonicalJson, digestOf } from '../account/ledger.mjs';
import { validateAgentScopeTerminal } from '../hosted/agent-run-scope-schema.mjs';
import { scopeModel, signed } from './agent-run-scope-fixture.mjs';

// Real Ed25519/signature validation; registration/local drain and OS lifecycle
// are controlled adapters here. This is not a Doc/root/production admission.
async function setup({ source = async value => value, rootRegistration = false, changeChallenge = value => value,
  changeResult = value => value } = {}) {
  const model = scopeModel(); let wirePublicKey;
  const session = createAgentInstanceSession({ scopePrepareSource: source,
    requestRegistration: async (name, body) => {
      if (name === 'challenge') {
        wirePublicKey = body.publicKey;
        return changeChallenge({ domain: 'promptcut.agent-instance.register.v1', authorityId: 'doc', serviceId: 'agent',
          serviceKid: 'agent-kid', requestId: body.requestId, challengeId: 'challenge', nonce: 'nonce',
          publicKeyDigest: digestOf(body.publicKey), ...(body.rootScopeRef ? { rootScopeRef: body.rootScopeRef,
            docPublicKeyDigest: digestOf(body.publicKey), scopePublicKeyDigest: session.scopeIdentity().scopePublicKeyDigest } : {}) });
      }
      assert.ok(verify(null, Buffer.from(canonicalJson(body.challenge)), wirePublicKey,
        Buffer.from(body.signature, 'base64url')));
      return changeResult({ authorityId: 'doc', serviceId: 'agent', serviceKid: 'agent-kid',
        instanceId: model.files.get('epoch-1.json').instance.instanceId, instanceGeneration: 1,
        ...(body.challenge.rootScopeRef ? { rootScopeRef: body.challenge.rootScopeRef } : {}) });
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
