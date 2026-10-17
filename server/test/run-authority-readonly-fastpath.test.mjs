import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPublicKey, sign } from 'node:crypto';
import { runFixture, projectId, conversationId, servicePrincipal } from './run-authority-fixture.mjs';
import { scopeModel, signed } from './agent-run-scope-fixture.mjs';
import { canonicalJson, digestOf, appendAccessEvent } from '../account/ledger.mjs';
import { createAgentRunScopeDoc, agentScopeRef } from '../account/agent-run-scope-doc.mjs';
import { createAgentInstanceAuthority, instanceProofPayload } from '../account/agent-instance-authority.mjs';
import { createRunAuthority, canonicalReadRecord } from '../account/run-authority.mjs';
import { inspectAgentScopeSource } from '../hosted/agent-run-scope-reader.mjs';

const pem = key => createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }).export({ format: 'pem', type: 'spki' }).toString();
const signature = (value, key) => sign(null, Buffer.from(canonicalJson(value)), key).toString('base64url');

test('synchronize and checkAccess use read-only fastpath when accessHead has not advanced, and reconcile when accessEvents advance', async t => {
  const f = await runFixture();
  t.after(() => { f.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });

  f.enqueue('msg-fastpath', 'sender');
  const grant = await f.admit('admit-fastpath');
  const readReply = await f.transport.confirmRead(f.input(grant, 'read-fastpath'));
  assert.equal(readReply.confirmed, true);

  const principal = await f.principal(grant);

  let txCount = 0;
  const origTx = f.ledger.transaction.bind(f.ledger);
  f.ledger.transaction = fn => {
    txCount += 1;
    return origTx(fn);
  };

  // Warm state already has all v2 tables initialized and runAccessCursorV2 caught up.
  for (let i = 0; i < 5; i += 1) {
    const pending = await f.provider.synchronize({ servicePrincipal });
    assert.deepEqual(pending, []);
  }
  assert.equal(txCount, 0, 'synchronize() should not enter ledger.transaction when no new accessEvents exist');

  for (let i = 0; i < 5; i += 1) {
    const readCheck = await f.provider.checkAccess({ principal, projectId, action: 'read' });
    assert.equal(readCheck.allowed, true);
    assert.equal(readCheck.projectId, projectId);
    assert.equal(readCheck.accountId, 'sender');
    assert.equal(readCheck.runGrant.runGrantId, grant.runGrantId);
    assert.equal(readCheck.activeGrant?.readConfirmed, true);
    assert.equal(readCheck.activeGrant?.currentRun, true);

    const writeCheck = await f.provider.checkAccess({ principal, projectId, action: 'write' });
    assert.equal(writeCheck.allowed, true);

    const queryAuth = await f.provider.authorizeQuery({ principal, projectId, runGrantId: grant.runGrantId });
    assert.equal(queryAuth.runGrantId, grant.runGrantId);
    assert.equal(queryAuth.initiatorAccountId, 'sender');

    const resolved = await f.principal(grant);
    assert.equal(resolved.runGrantId, grant.runGrantId);
  }
  assert.equal(txCount, 0, 'checkAccess/authorizeQuery/resolveRunPrincipal should not enter ledger.transaction when no new accessEvents exist');

  // Append a new access event (member revocation for 'other' so sender remains active, testing checkAccess reconcile).
  origTx(s => {
    delete s.projects[projectId].members.other;
    appendAccessEvent(s, {
      type: 'project-access-changed',
      projectId,
      reason: 'remove-member',
      accountIds: ['other'],
    });
  });

  const afterOtherRevoked = await f.provider.checkAccess({ principal, projectId, action: 'read' });
  assert.equal(afterOtherRevoked.allowed, true);
  assert.equal(txCount, 1, 'checkAccess should run exactly one reconcile transaction when accessEvents advance');
  assert.equal(f.ledger.read().runAccessCursorV2, f.ledger.read().accessHead);

  txCount = 0;
  await f.provider.checkAccess({ principal, projectId, action: 'read' });
  assert.equal(txCount, 0, 'subsequent checkAccess after reconcile returns to read-only fastpath');

  // Now revoke sender's credential via access event; synchronize() must reconcile and produce the pending control fence.
  origTx(s => {
    s.revokedLogins['login:login-sender'] = { seq: ++s.accountHead };
    appendAccessEvent(s, {
      type: 'login-revoked',
      accountIds: ['sender'],
      loginIds: ['login-sender'],
    });
  });
  txCount = 0;
  const controls = await f.provider.synchronize({ servicePrincipal });
  assert.equal(txCount, 1, 'synchronize() should enter ledger.transaction when accessEvents advance');
  assert.equal(controls.length, 2);
  const credentialControl = controls.find(c => c.kind === 'credential');
  assert.ok(credentialControl);
  assert.deepEqual(credentialControl.retained, [grant.runGrantId]);

  txCount = 0;
  const controlsAgain = await f.provider.synchronize({ servicePrincipal });
  assert.equal(txCount, 0, 'synchronize() after reconcile should not enter ledger.transaction');
  assert.deepEqual(controlsAgain, controls);

  // Retained shared run still passes checkAccess without entering ledger.transaction.
  const retainedCheck = await f.provider.checkAccess({ principal, projectId, action: 'write' });
  assert.equal(txCount, 0, 'retained checkAccess should also use read-only fastpath');
  assert.equal(retainedCheck.allowed, true);
  assert.equal(retainedCheck.retainedGrant?.readConfirmed, true);
});

test('reconcileScopeClosures skips active running grants without finishReceiptId and does not trigger rollback transactions', async t => {
  const f = await runFixture(), m = scopeModel();
  m.expected.docAuthorityId = f.ledger.authorityId;
  await m.run('initialize');
  const ref = agentScopeRef(m.files.get('epoch-1.json'));
  const workerPin = '3'.repeat(64), masterPin = '5'.repeat(64);
  const slot = {
    expected: m.expected,
    configuredAnchorDigest: digestOf(m.files.get('anchor.json')),
    workerServiceKid: servicePrincipal.serviceKid,
    workerFingerprint256: workerPin,
  };
  const scope = createAgentRunScopeDoc({
    ledger: f.ledger,
    signingKey: m.doc.privateKey,
    slots: [slot],
    masterServiceKid: 'master-key',
    masterFingerprint256: masterPin,
    sourceFactory: () => ({
      read: ({ checkpoint }) => inspectAgentScopeSource({
        read: m.io.read,
        expected: m.expected,
        configuredAnchorDigest: slot.configuredAnchorDigest,
        checkpoint,
      }),
    }),
  });
  const principal = { ...servicePrincipal, authenticationId: 'test-connection' };
  const transport = (_s, p) => ({
    serviceId: 'agent',
    serviceKid: p.serviceKid,
    authenticationId: p.authenticationId,
    channelBinding: '4'.repeat(64),
    fingerprint256: p.serviceKid === 'master-key' ? masterPin : slot.workerFingerprint256,
  });
  const instances = createAgentInstanceAuthority({
    ledger: f.ledger,
    verifyTransportInState: transport,
    scopeAuthority: scope,
  });
  const req = { servicePrincipal: principal, requestId: 'register', publicKey: pem(m.workerKey.publicKey), rootScopeRef: ref };
  const challenge = await instances.beginRegistration(req);
  const registration = await instances.register({
    servicePrincipal: principal,
    challenge,
    signature: signature(challenge, m.workerKey.privateKey),
  });
  const provider = createRunAuthority({
    ledger: f.ledger,
    conversationHooks: f.hooks,
    instanceAuthority: instances,
    scopeAuthority: scope,
    docInstanceId: 'doc-live',
    synchronize: async () => {},
    verifySender: async actor => ({ ...actor, accountEventSeq: f.ledger.read().accountHead }),
    verifyServiceInState: (_s, p) => ({ serviceId: p.service, serviceKid: p.serviceKid }),
  });
  async function invoke(operation, input) {
    const proof = {
      instanceId: registration.instanceId,
      instanceGeneration: registration.instanceGeneration,
      signature: signature(instanceProofPayload({
        ...registration,
        channelBinding: '4'.repeat(64),
        method: 'POST',
        path: `/test/${operation}`,
        operation,
        requestDigest: digestOf(input),
      }), m.workerKey.privateKey),
    };
    const cap = instances.authenticate({
      servicePrincipal: principal,
      method: 'POST',
      path: `/test/${operation}`,
      operation,
      request: input,
      proof,
    });
    try {
      return await provider[operation]({ ...input, servicePrincipal: { ...principal, ...cap } });
    } finally {
      instances.release(cap.instanceSession);
    }
  }
  t.after(() => { instances.close(); f.close(); fs.rmSync(f.dir, { recursive: true, force: true }); });

  f.enqueue('msg-scope', 'sender');
  const grant = await invoke('admit', { projectId, conversationId, requestId: 'admit-scope' });
  const binding = Object.fromEntries(['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId'].map(k => [k, grant[k]]));

  let txCount = 0;
  const origTx = f.ledger.transaction.bind(f.ledger);
  f.ledger.transaction = fn => {
    txCount += 1;
    return origTx(fn);
  };

  // While grant is in 'preparing' state without finishReceiptId, reconcileScopeClosures should not run any transaction.
  assert.deepEqual(await provider.reconcileScopeClosures(), []);
  assert.equal(txCount, 0, 'reconcileScopeClosures should skip preparing grant without finishReceiptId');

  const assigned = await invoke('scopeAssignment', { ...binding, requestId: 'assign-scope' });
  await m.run('bind', { assignment: assigned.assignment });
  const prompt = canonicalReadRecord(grant.message, grant);
  const readReply = await invoke('confirmRead', {
    ...binding,
    requestId: 'read-scope',
    readIntentId: 'intent-scope',
    prompt,
    promptDigest: digestOf(prompt),
  });
  assert.equal(readReply.confirmed, true);
  assert.equal(f.ledger.read().runGrantsV2[grant.runGrantId].state, 'active');

  txCount = 0;
  // While grant is in 'active' state without finishReceiptId, reconcileScopeClosures must not enter ledger.transaction.
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(await provider.reconcileScopeClosures(), []);
  }
  assert.equal(txCount, 0, 'reconcileScopeClosures should skip active grant without finishReceiptId');

  // Verify checkAccess with scopeAuthority only executes scopeAuthority.refresh transactions (2) and 0 runAuthority reconcile transactions.
  const checkPrincipal = {
    ...f.ledger.read().runGrantsV2[grant.runGrantId],
    realm: 'account',
    identityVersion: 2,
    role: 'agent',
    creator: false,
  };
  const checkBody = { principal: checkPrincipal, projectId, action: 'read' };
  const proof = {
    instanceId: registration.instanceId,
    instanceGeneration: registration.instanceGeneration,
    signature: signature(instanceProofPayload({
      ...registration,
      channelBinding: '4'.repeat(64),
      method: 'POST',
      path: '/test/checkAccess',
      operation: 'checkAccess',
      requestDigest: digestOf(checkBody),
    }), m.workerKey.privateKey),
  };
  const cap = instances.authenticate({
    servicePrincipal: principal,
    method: 'POST',
    path: '/test/checkAccess',
    operation: 'checkAccess',
    request: checkBody,
    proof,
  });
  txCount = 0;
  try {
    const res = await provider.checkAccess({
      ...checkBody,
      principal: { ...checkPrincipal, servicePrincipal: { ...principal, ...cap } },
    });
    assert.equal(res.allowed, true);
  } finally {
    instances.release(cap.instanceSession);
  }
  assert.equal(txCount, 2, 'checkAccess with bound scopeAuthority should skip both sync and checkWithScope reconcile transactions');
});
