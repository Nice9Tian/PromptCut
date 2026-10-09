import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPublicKey, sign } from 'node:crypto';
import { scopeModel, pair } from './agent-run-scope-fixture.mjs';
import { runFixture, projectId, conversationId, servicePrincipal } from './run-authority-fixture.mjs';
import { canonicalJson, digestOf } from '../account/ledger.mjs';
import { createAgentRunScopeDoc, agentScopeKeyMapping, agentScopeRef } from '../account/agent-run-scope-doc.mjs';
import { createAgentInstanceAuthority, instanceProofPayload } from '../account/agent-instance-authority.mjs';
import { createRunAuthority, canonicalReadRecord } from '../account/run-authority.mjs';
import { inspectAgentScopeSource } from '../hosted/agent-run-scope-reader.mjs';

const pem = key => createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }).export({ format: 'pem', type: 'spki' }).toString();
const signature = (value, key) => sign(null, Buffer.from(canonicalJson(value)), key).toString('base64url');

async function fixture(t) {
  const f = await runFixture(), m = scopeModel(); m.expected.docAuthorityId = f.ledger.authorityId;
  await m.run('initialize');
  const ref = agentScopeRef(m.files.get('epoch-1.json'));
  const slot = { expected: m.expected, configuredAnchorDigest: digestOf(m.files.get('anchor.json')),
    workerServiceKid: servicePrincipal.serviceKid, workerFingerprint256: '3'.repeat(64) };
  // Real SQLite, signatures and complete root-chain validator; OS/transport below
  // are controlled models, NOT kernel/TLS proof or a production source factory.
  const scope = createAgentRunScopeDoc({ ledger: f.ledger, signingKey: m.doc.privateKey, slots: [slot],
    sourceFactory: () => ({ read: ({ checkpoint }) => inspectAgentScopeSource({ read: m.io.read,
      expected: m.expected, configuredAnchorDigest: slot.configuredAnchorDigest, checkpoint }) }) });
  const principal = { ...servicePrincipal, authenticationId: 'test-connection' };
  const transport = (_s, p) => {
    assert.equal(p.authenticationId, principal.authenticationId);
    return { serviceId: 'agent', serviceKid: p.serviceKid, authenticationId: p.authenticationId,
      channelBinding: '4'.repeat(64), fingerprint256: slot.workerFingerprint256 };
  };
  const instances = createAgentInstanceAuthority({ ledger: f.ledger, verifyTransportInState: transport, scopeAuthority: scope });
  const request = { servicePrincipal: principal, requestId: 'register', publicKey: pem(m.workerKey.publicKey), rootScopeRef: ref };
  const challenge = await instances.beginRegistration(request);
  const registration = await instances.register({ servicePrincipal: principal, challenge, signature: signature(challenge, m.workerKey.privateKey) });
  const options = { ledger: f.ledger, conversationHooks: f.hooks, instanceAuthority: instances, scopeAuthority: scope,
    synchronize: async () => {}, verifySender: async actor => ({ ...actor, accountEventSeq: f.ledger.read().accountHead }),
    verifyServiceInState: (_s, p) => ({ serviceId: p.service, serviceKid: p.serviceKid }) };
  const provider = createRunAuthority(options);
  async function invoke(operation, input) {
    const proof = { instanceId: registration.instanceId, instanceGeneration: registration.instanceGeneration,
      signature: signature(instanceProofPayload({ ...registration, channelBinding: '4'.repeat(64), method: 'POST',
        path: `/test/${operation}`, operation, requestDigest: digestOf(input) }), m.workerKey.privateKey) };
    const cap = instances.authenticate({ servicePrincipal: principal, method: 'POST', path: `/test/${operation}`, operation, request: input, proof });
    try { return await provider[operation]({ ...input, servicePrincipal: { ...principal, ...cap } }); }
    finally { instances.release(cap.instanceSession); }
  }
  t.after(() => { instances.close(); f.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });
  return { ...f, m, ref, scope, instances, request, challenge, registration, options, invoke, principal };
}

test('DER/PEM join proves one key, keeps both digest domains, rejects another key', () => {
  const a = pair(), b = pair(), value = agentScopeKeyMapping(pem(a.publicKey), a.publicKey);
  assert.equal(value.docPublicKeyDigest, digestOf(pem(a.publicKey)));
  assert.equal(value.scopePublicKeyDigest, digestOf(a.publicKey));
  assert.notEqual(value.docPublicKeyDigest, value.scopePublicKeyDigest);
  assert.throws(() => agentScopeKeyMapping(pem(a.publicKey), b.publicKey), { code: 'run-scope-key-mismatch' });
});

test('SQLite registration pins real root ID/key; assignment stays invisible to read until root bind', async t => {
  const f = await fixture(t);
  assert.equal(f.registration.instanceId, f.m.files.get('epoch-1.json').instance.instanceId);
  assert.equal(f.challenge.publicKeyDigest, f.challenge.docPublicKeyDigest);
  assert.notEqual(f.challenge.publicKeyDigest, f.challenge.scopePublicKeyDigest);
  f.enqueue();
  const grant = await f.invoke('admit', { projectId, conversationId, requestId: 'admit' });
  const binding = Object.fromEntries(['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId'].map(k => [k, grant[k]]));
  const prompt = canonicalReadRecord(grant.message, grant);
  const read = { ...binding, requestId: 'read', readIntentId: 'intent', prompt, promptDigest: digestOf(prompt) };
  const assignment = await f.invoke('scopeAssignment', { ...binding, requestId: 'assignment' });
  assert.equal(assignment.executionAllowed, false);
  assert.equal(assignment.assignment.target.publicKeyDigest, f.challenge.scopePublicKeyDigest);
  await assert.rejects(f.invoke('confirmRead', read), { code: 'run-scope-assignment-not-bound' });
  assert.equal(Object.keys(f.ledger.read().runReceiptsV2).length, 0);
  await f.m.run('bind', { assignment: assignment.assignment });
  assert.equal((await f.invoke('scopeAssignment', { ...binding, requestId: 'assignment' })).executionAllowed, true);
  assert.equal((await f.invoke('confirmRead', read)).confirmed, true);
  assert.deepEqual(await f.instances.beginRegistration(f.request), f.challenge);
  await assert.rejects(f.invoke('finish', { ...binding, requestId: 'finish' }), { code: 'run-scope-terminal-required' });
  assert.equal(f.ledger.read().conversationsV2[projectId][conversationId].currentRunId, grant.runId);
  f.m.files.set('.publisher.lock', { pid: 1 });
  await assert.rejects(f.invoke('queryRead', read), { code: 'agent-scope-publisher-locked' });
});

test('required mode persists and cannot reopen without scope module; wrong key/extra ref rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(f.instances.beginRegistration({ ...f.request, requestId: 'wrong-key', publicKey: pem(pair().publicKey) }), { code: 'run-scope-key-mismatch' });
  await assert.rejects(f.instances.beginRegistration({ ...f.request, rootScopeRef: { ...f.ref, free: true } }), { code: 'run-scope-reference' });
  const missing = createAgentInstanceAuthority({ ledger: f.ledger, verifyTransportInState: () => ({
    serviceId: 'agent', serviceKid: servicePrincipal.serviceKid, authenticationId: 'x', channelBinding: '4'.repeat(64) }) });
  assert.throws(() => missing.beginRegistration({ ...f.request, rootScopeRef: undefined }), { code: 'instance-scope-unavailable' });
  missing.close();
});
