import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { openAccountLedger } from '../account/ledger.mjs';
import { instanceTlsBinding } from '../account/agent-instance-authority.mjs';
import { instanceFixture } from './agent-instance-fixture.mjs';

function setup(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-instance-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.db'), authorityId: 'instance-test' });
  const fixture = instanceFixture(ledger, options);
  t.after(() => { fixture.close(); ledger.close(); fs.rmSync(dir, { recursive: true }); });
  return { ledger, ...fixture, fixture };
}
const request = { projectId: 'project', conversationId: 'conversation', requestId: 'admit-request' };

test('durable registration ACK replay is exact; new boot has a distinct monotonic generation, not a close receipt', t => {
  const { ledger, fixture: f } = setup(t); const old = f.boot();
  assert.deepEqual(f.authority.register(old.registerArgs), old.registration);
  const next = f.boot(); assert.notEqual(next.registration.instanceId, old.registration.instanceId);
  assert.equal(next.registration.instanceGeneration, old.registration.instanceGeneration + 1);
  assert.equal(ledger.read().agentInstancesV2[old.registration.instanceId].state, 'active');
  assert.equal(ledger.read().agentInstancesV2[old.registration.instanceId].closure, null);
  assert.throws(() => f.authority.beginRegistration({ servicePrincipal: old.principal,
    requestId: old.registerArgs.challenge.requestId,
    publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() }), /instance-registration-mismatch/);
});

test('proof is bound to current connection, API, body, authority and immutable instance generation', t => {
  const { ledger, fixture: f } = setup(t); const process = f.boot();
  const auth = f.authorize(process, 'admit', request);
  const verify = (principal, operation = 'admit', input = request) =>
    f.authority.verifyInState(ledger.read(), principal, { operation, input });
  assert.equal(verify(auth.principal).instanceId, process.registration.instanceId);
  assert.throws(() => verify({ ...auth.principal, authenticationId: f.connection().authenticationId }), /instance-invocation-forbidden/);
  assert.throws(() => verify(auth.principal, 'checkAccess', { projectId: 'project', action: 'write' }), /instance-invocation-forbidden/);
  assert.throws(() => verify(auth.principal, 'admit', { ...request, conversationId: 'other' }), /instance-invocation-forbidden/);
  for (const delta of [{ method: 'GET' }, { path: '/wrong' }, { operation: 'finish' }, { request: { ...request, projectId: 'other' } }])
    assert.throws(() => f.authority.authenticate({ ...auth.args, ...delta }), /instance-proof-invalid/);
  assert.throws(() => f.authority.authenticate({ ...auth.args, proof: { ...auth.args.proof, instanceGeneration: 99 } }), /instance-binding-mismatch/);
  const other = f.boot();
  assert.throws(() => f.authority.authenticate({ ...auth.args, servicePrincipal: other.principal }), /instance-proof-invalid/);
  f.disconnect(process.principal); assert.throws(() => verify(auth.principal), /instance-transport-closed/);
});

test('doc restart discards capabilities; the still-live original key can reprove, a new key cannot inherit', t => {
  const { ledger, fixture: f } = setup(t); const old = f.boot(); const auth = f.authorize(old, 'admit', request);
  f.restart(); assert.throws(() => f.authority.verifyInState(ledger.read(), auth.principal,
    { operation: 'admit', input: request }), /instance-invocation-forbidden/);
  const reconnected = f.authorize(old, 'admit', request, { principal: f.connection() });
  assert.equal(f.authority.verifyInState(ledger.read(), reconnected.principal,
    { operation: 'admit', input: request }).instanceId, old.registration.instanceId);
  assert.throws(() => f.authorize({ ...old, keys: generateKeyPairSync('ed25519') }, 'admit', request), /instance-proof-invalid/);
});

test('fence rejects immediately; missing or incomplete OS closure evidence cannot turn unknown into closed', t => {
  const { ledger, fixture: f } = setup(t); const process = f.boot(); const auth = f.authorize(process, 'admit', request);
  ledger.transaction(state => f.authority.fenceInState(state,
    { ...process.registration, requestId: 'stop-instance', reason: 'shutdown' }));
  assert.throws(() => f.authority.verifyInState(ledger.read(), auth.principal, { operation: 'admit', input: request }), /instance-revoked/);
  assert.throws(() => f.authority.confirmClosed({ ...process.registration,
    witness: { ...process.registration, witnessId: 'claimed', complete: true } }), /instance-closure-verifier-unavailable/);
  assert.equal(ledger.read().agentInstancesV2[process.registration.instanceId].state, 'fenced');
  assert.throws(() => instanceTlsBinding({ encrypted: true, authorized: true, exportKeyingMaterial: null }), /instance-transport-unavailable/);
  assert.throws(() => instanceTlsBinding({ encrypted: false }), /instance-transport-unavailable/);
});
