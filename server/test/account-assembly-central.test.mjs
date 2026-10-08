import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { startHostedCombo, hostedPaths } from '../hosted/combo.mjs';
import { addServiceKey, generateServiceKeyPair } from '../auth/service-identity.mjs';
import { createAssetMtlsTransport } from '../hosted/asset-doc-client.mjs';
import { openAccountLedger, digestOf } from '../account/ledger.mjs';
import { canonicalReadRecord } from '../account/run-authority.mjs';
import { instanceHttpRequest, registerHttpInstance } from './fixtures/agent-instance-request.mjs';
import { stageHostedAssetFiles } from '../hosted/files.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';

const providerDir = process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT;
const orderFile = process.env.PROMPTCUT_PASSWORD_ORDER_MODULE;
const actual = { skip: !providerDir || !orderFile ? 'explicit actual account/order provider required' : false };
const web = async (origin, method, route, body, token) => {
  const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
};
const closeServer = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
const received = async (client, body) => { client.send(body); return client.next(value => value.reqId === body.reqId); };

test('v2 required refuses missing order before opening any cloud entry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-doc-assembly-required-'));
  try {
    await assert.rejects(startHostedCombo({ dataDir: dir, host: '127.0.0.1', accountRequired: true,
      account: {}, docPort: 5771, assetPort: 5779 }), error => error.reason === 'doc-assembly-configuration');
    assert.equal(fs.existsSync(path.join(dir, 'docservice')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const agentConfigured of [false, true]) test(`actual provider/order → central doc → independent asset → two pages${agentConfigured ? ' + real conversation/run factories' : ''}: durable op, readonly selection, restart and revoked resume`, actual, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-doc-assembly-central-'));
  const pki = assetWiringPki(dir), pair = { account: generateKeyPairSync('ed25519'), doc: generateKeyPairSync('ed25519') };
  let provider, accountServer, combo, child, childClosed, childLog = '', closed = false, agentTransport;
  const clients = [];
  const closePages = async () => { for (const client of clients) client.close(); await Promise.all(clients.map(client => client.closed)); clients.length = 0; };
  t.after(async () => {
    await closePages();
    agentTransport?.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await childClosed;
    await combo?.close();
    if (accountServer?.listening) await closeServer(accountServer);
    provider?.close();
    const log = path.join(os.tmpdir(), `pc-doc-assembly-child-${Date.now()}.log`); fs.writeFileSync(log, childLog); t.diagnostic(log);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const [storeModule, credentialsModule, internalModule, orderModule] = await Promise.all([
    ...['store', 'credentials', 'internal'].map(name => import(pathToFileURL(path.join(providerDir, `account/${name}.mjs`)))),
    import(pathToFileURL(orderFile)),
  ]);
  provider = storeModule.openStore(path.join(dir, 'provider.sqlite'));
  const credentials = credentialsModule.createCredentials({ store: provider, key: randomBytes(32) });
  const ids = ['acc_0123456789abcdef01234567', 'acc_abcdef0123456789abcdef01'];
  const editors = ids.map((id, i) => {
    provider.createAccount({ id, name: `Assembly Member ${i}`, nameKey: `assembly-${i}`, pw: 'fixture-only', now: Date.now() });
    return credentials.createEditor({ account: provider.accountById(id), deviceId: `page-${i}`, requestId: `login-${i}` });
  });
  const order = orderModule.createPasswordOrder({ store: provider, credentials,
    accountOrderSigningKey: pair.account.privateKey, accountOrderKeyId: 'assembly-account', docAttestationPublicKey: pair.doc.publicKey });
  accountServer = internalModule.createInternalServer({ tls: pki.account, store: provider, credentials, order,
    services: [{ serviceId: 'doc', fingerprint256: pki.doc.fingerprint256 }] });
  await new Promise(resolve => accountServer.listen(5770, '127.0.0.1', resolve));
  const docDir = path.join(dir, 'doc'), assetDir = path.join(dir, 'asset'), app = path.join(dir, 'app');
  fs.mkdirSync(docDir); fs.mkdirSync(assetDir); stageHostedAssetFiles(path.resolve('.'), app);
  const agentKey = generateServiceKeyPair();
  if (agentConfigured) addServiceKey(hostedPaths(docDir).servicesFile, {
    service: 'agent', role: 'agent', actsFor: 'member', kid: agentKey.kid, pub: agentKey.pub });
  const config = { dataDir: docDir, docPort: 5771, assetPort: 5779, host: '127.0.0.1', trustLoopback: false,
    clusterToken: 'assembly-fixture-cluster-token-32', accountRequired: true,
    assetPublicUrl: 'http://127.0.0.1:5773/api/asset',
    assetStatus: { origin: 'https://127.0.0.1:5774', tls: pki.doc, serverFingerprint256: pki.asset.fingerprint256 },
    account: { origin: 'https://127.0.0.1:5770', clientTls: pki.doc, serverFingerprint256: pki.account.fingerprint256,
      authorityId: 'assembly-doc', authorityUrl: 'https://fixture.invalid/editor', signingKey: pair.doc.privateKey,
      keyId: 'assembly-doc', internalTls: pki.doc, internalPort: 5772,
      services: [{ serviceId: 'asset', fingerprint256: pki.asset.fingerprint256 },
        ...(agentConfigured ? [{ serviceId: 'agent', fingerprint256: pki.wrong.fingerprint256 }] : [])],
      ...(agentConfigured ? { agent: { fingerprint256: pki.wrong.fingerprint256, serviceKid: agentKey.kid } } : {}),
      order: { witnessKeys: { 'assembly-account': pair.account.publicKey }, docAttestationPrivateKey: pair.doc.privateKey } } };
  combo = await startHostedCombo(config);
  const origin = 'http://127.0.0.1:5771';
  const call = (i, route, body) => web(origin, 'POST', '/hosted/shared/account/' + route, body, editors[i].accessToken);
  const created = await call(0, 'create', { name: 'Central history', requestId: 'create', initialProject: { title: 'before', tracks: [] } });
  assert.equal(created.status, 201, JSON.stringify(created.body)); const projectId = created.body.projectId;
  assert.equal((await call(1, 'join', { projectId, deviceId: 'page-1', requestId: 'unready' })).status, 503);
  assert.equal(combo.accountRuntime.authority.listProjects(ids[1]).joined.length, 0);
  child = spawn(process.execPath, ['server/hosted/asset-main.mjs'], { cwd: app, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PROMPTCUT_ASSET_DATA_DIR: assetDir, PROMPTCUT_ASSET_HOST: '127.0.0.1', PROMPTCUT_ASSET_PORT: '5773',
      PROMPTCUT_ASSET_INTERNAL_PORT: '5774', PROMPTCUT_ASSET_PUBLIC_URL: 'http://127.0.0.1:5773/api/asset',
      PROMPTCUT_ASSET_DOC_AUTHORITY_ID: 'assembly-doc', PROMPTCUT_ASSET_DOC_ORIGIN: 'https://127.0.0.1:5772',
      PROMPTCUT_ASSET_DOC_FINGERPRINT256: pki.doc.fingerprint256, PROMPTCUT_ASSET_DOC_CLIENT_FINGERPRINT256: pki.doc.fingerprint256,
      PROMPTCUT_ASSET_DOC_CA_FILE: path.join(dir, 'ca.crt'), PROMPTCUT_ASSET_CLIENT_KEY_FILE: path.join(dir, 'asset.key'),
      PROMPTCUT_ASSET_CLIENT_CERT_FILE: path.join(dir, 'asset.crt'), PROMPTCUT_ASSET_INTERNAL_KEY_FILE: path.join(dir, 'asset.key'),
      PROMPTCUT_ASSET_INTERNAL_CERT_FILE: path.join(dir, 'asset.crt') } });
  childClosed = new Promise(resolve => child.once('close', resolve));
  child.stdout.on('data', bytes => { childLog += bytes; }); child.stderr.on('data', bytes => { childLog += bytes; });
  await waitFor(async () => {
    if (child.exitCode !== null) throw Error('independent asset exited: ' + childLog);
    try { return (await fetch('http://127.0.0.1:5773/healthz')).ok; } catch { return false; }
  }, 10000, 'independent asset');
  assert.equal((await call(1, 'join', { projectId, deviceId: 'page-1', requestId: 'join' })).status, 200);
  const session = async i => {
    const result = await call(i, 'session', { projectId, deviceId: `page-${i}`, requestId: `session-${i}` });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  };
  const sessions = [await session(0), await session(1)];
  const connect = async ticket => { const client = wsClient(`ws://127.0.0.1:5771`, ['promptcut.v1', `promptcut.account.${ticket}`]);
    clients.push(client); await client.opened; return client; };
  let a = await connect(sessions[0].connectionTicket), b = await connect(sessions[1].connectionTicket);
  for (const [i, client] of [a, b].entries()) assert.equal((await received(client, { type: 'project.open', projectId, reqId: `open-${i}` })).rev, 1);
  const changed = await received(a, { type: 'project.op', projectId, opId: 'central-op', reqId: 'op',
    ops: [{ op: 'set', path: '/title', value: 'after' }], actor: { accountId: ids[1], loginId: 'forged' } });
  assert.equal(changed.type, 'project.op.ok', JSON.stringify(changed)); assert.equal(changed.rev, 2);
  const broadcast = await b.next(value => value.type === 'project.ops'); assert.equal(broadcast.actor.accountId, ids[0]);
  assert.equal(broadcast.actor.loginId, editors[0].loginId);
  const accepted = combo.docAssembly.history.accepted(projectId); assert.equal(accepted.length, 1);
  assert.equal(accepted[0].before.title, 'before'); assert.equal(accepted[0].after.title, 'after');
  assert.equal(accepted[0].changes[0].before.value, 'before'); assert.equal(accepted[0].witness.orderSeq, changed.orderSeq);
  const delegation = await combo.accountRuntime.resolveAgentDelegation(sessions[0].agentDelegationTicket);
  assert.equal(delegation.accountId, ids[0]);
  await assert.rejects(combo.accountRuntime.resolveAgentDelegation(sessions[0].assetTicket), /ticket-expired/);
  await assert.rejects(combo.docAssembly.runProvider.checkAccess({ principal: delegation, projectId, action: 'read' }),
    agentConfigured ? /run-service-forbidden/ : /run-authority-unavailable/);
  if (!agentConfigured) {
    agentTransport = createAssetMtlsTransport({ origin: 'https://127.0.0.1:5772', tls: pki.asset,
      serverFingerprint256: pki.doc.fingerprint256 });
    await assert.rejects(agentTransport.request('POST', '/internal/v2/instances/challenge', {
      requestId: 'not-configured', publicKey: pair.account.publicKey.export({ type: 'spki', format: 'pem' }).toString() }), /doc-agent-unavailable/);
  }
  if (agentConfigured) {
    assert.ok(combo.docAgentAssembly);
    const enable = async enabled => call(0, 'admin', { projectId, op: 'set-hosted-service', service: 'agent', enabled,
      expectedAccessRevision: combo.accountRuntime.authority.listProjects(ids[0]).owned.find(item => item.projectId === projectId).accessRevision,
      requestId: `agent-${enabled}-${Date.now()}` });
    assert.equal((await enable(true)).status, 200);
    agentTransport = createAssetMtlsTransport({ origin: 'https://127.0.0.1:5772', tls: pki.wrong,
      serverFingerprint256: pki.doc.fingerprint256 });
    const rpc = (action, body) => agentTransport.request('POST', '/internal/v2/' + action, body);
    for (const [index, client] of [a, b].entries()) assert.equal((await received(client, {
      type: 'selection.set', projectId, pageId: `sent-page-${index}`, revision: 1, selection: { clipIds: [] }, reqId: `sent-${index}` })).type, 'selection.ok');
    const send = (index, conversationId, requestId, selectionInput = { pageId: `sent-page-${index}` }) => rpc('conversations/send', {
      delegation: sessions[index].agentDelegationTicket, projectId, conversationId, requestId, content: `message ${index}`, selectionInput });
    await assert.rejects(send(0, 'actual-conversation', 'first'), /consent-required/);
    for (const id of ids) provider.acceptConsent(id, 'test-consent', Date.now());
    const sent = (await send(0, 'actual-conversation', 'first')).result;
    assert.equal(sent.queuePosition, 1);
    assert.equal((await send(0, 'actual-conversation', 'first')).result.messageId, sent.messageId);
    await assert.rejects(send(0, 'actual-conversation', 'forged', { pageId: 'sent-page-0', selection: { clipIds: ['fake'] } }), /invalid-authority-claim/);
    assert.equal((await send(1, 'actual-conversation', 'second')).result.queuePosition, 2);
    const pending = (await rpc('runs/pending', {})).result;
    assert.deepEqual(pending.conversations.map(row => row.conversationId), ['actual-conversation']);
    assert.equal(Object.keys(pending.conversations[0]).length, 3);
    await assert.rejects(rpc('runs/admit', { projectId, conversationId: 'actual-conversation', requestId: 'wake' }), /instance-proof-required/);
    const instance = await registerHttpInstance({ port: 5772, tls: pki.wrong, requestId: 'actual-agent-os-a' });
    const signedRpc = (action, operation, body, os = instance) => instanceHttpRequest({ port: 5772, tls: pki.wrong,
      path: '/internal/v2/runs/' + action, operation, body, instance: os });
    const admitted = await signedRpc('admit', 'admit', { projectId, conversationId: 'actual-conversation', requestId: 'signed-wake' });
    assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
    const grant = admitted.body.result;
    assert.equal(grant.instanceId, instance.instanceId); assert.equal(grant.instanceGeneration, instance.instanceGeneration);
    assert.equal(grant.accountId, ids[0]); assert.equal(grant.messageId, sent.messageId);
    const runBinding = Object.fromEntries(['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId'].map(field => [field, grant[field]]));
    const prompt = canonicalReadRecord(grant.message, grant);
    const readInput = { ...runBinding, requestId: 'signed-read', readIntentId: 'actual-os-read-intent', prompt, promptDigest: digestOf(prompt) };
    const read = await signedRpc('read', 'confirmRead', readInput);
    assert.equal(read.status, 200, JSON.stringify(read.body)); assert.equal(read.body.result.confirmed, true);
    assert.equal((await signedRpc('read/query', 'queryRead', readInput)).status, 200);
    const checkInput = { projectId, runGrantId: grant.runGrantId, action: 'write' };
    const checked = await signedRpc('check', 'checkAccess', checkInput);
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.result.principal.creator, false); assert.equal(checked.body.result.principal.accountId, ids[0]);
    assert.equal(JSON.stringify(checked.body).includes('instanceSession'), false);
    assert.equal(JSON.stringify(checked.body).includes('authenticationId'), false);
    const otherOs = await registerHttpInstance({ port: 5772, tls: pki.wrong, requestId: 'actual-agent-os-b' });
    assert.equal((await signedRpc('check', 'checkAccess', checkInput, otherOs)).status, 403, 'same cert new OS cannot consume old grant');
    const ticket = await signedRpc('ticket', 'resolveRunPrincipal', { projectId, runGrantId: grant.runGrantId,
      conversationId: grant.conversationId, purpose: 'run' });
    assert.equal(ticket.status, 503); assert.equal(ticket.body.code, 'run-data-proof-unavailable');
    assert.equal((await signedRpc('finish', 'finish', { ...runBinding, requestId: 'signed-finish' })).status, 200);
    await assert.rejects(rpc('conversations/send', { delegation: sessions[0].agentDelegationTicket, projectId,
      conversationId: 'fake', requestId: 'fake', content: 'fake', accountId: ids[1] }), /invalid-authority-claim/);
    await assert.rejects(rpc('conversations/switch', { delegation: sessions[0].agentDelegationTicket, projectId,
      conversationId: 'actual-conversation', requestId: 'make-private', visibility: 'private' }), /agent-fence-pending/);
    const messages = (await rpc('conversations/get', { delegation: sessions[0].agentDelegationTicket, projectId,
      conversationId: 'actual-conversation' })).result.messages;
    assert.equal(messages.find(message => message.messageId !== sent.messageId).queueState, 'cancelled');
    // off then on cannot revive already cancelled messages. HTTP invocation
    // proof does not establish a reusable WS/LP capability or OS-close witness.
    assert.equal((await enable(false)).status, 200); assert.equal((await enable(true)).status, 200);
    assert.equal((await rpc('runs/pending', {})).result.conversations.length, 0);
  }
  const readonly = await call(0, 'admin', { projectId, op: 'set-list', members: [{ accountId: ids[1], access: 'r' }],
    expectedAccessRevision: combo.accountRuntime.authority.listProjects(ids[0]).owned.find(item => item.projectId === projectId).accessRevision,
    requestId: 'readonly' });
  assert.equal(readonly.status, 200, JSON.stringify(readonly.body)); await b.closed;
  const readonlySession = await session(1); b = await connect(readonlySession.connectionTicket);
  assert.equal((await received(b, { type: 'selection.set', projectId, pageId: 'page-b', revision: 1, selection: { clipIds: [] }, reqId: 'select' })).type, 'selection.ok');
  const pagePrincipal = await combo.accountRuntime.resolveAgentDelegation(readonlySession.agentDelegationTicket);
  const captured = await combo.docAssembly.captureSnapshot({ principal: pagePrincipal, projectId, selectionInput: { pageId: 'page-b' } });
  assert.deepEqual(captured.selection, { clipIds: [] }); assert.equal(captured.accountId, ids[1]);
  await assert.rejects(combo.docAssembly.captureSnapshot({ principal: pagePrincipal, projectId,
    selectionInput: { pageId: 'page-b', selection: { clipIds: ['forged'] } } }), /invalid-authority-claim/);
  assert.equal((await received(b, { type: 'selection.set', projectId, pageId: 'page-b', revision: 2, selection: { clipIds: [] }, username: 'forged', reqId: 'name' })).reason, 'invalid-authority-claim');
  assert.equal((await received(b, { type: 'project.op', projectId, opId: 'readonly-op', ops: [{ op: 'set', path: '/title', value: 'bad' }], reqId: 'readonly-op' })).reason, 'not-listed');
  assert.equal(combo.docAssembly.history.accepted(projectId).length, 1);
  await closePages();
  await assert.rejects(combo.docAssembly.captureSnapshot({ principal: pagePrincipal, projectId,
    selectionInput: { pageId: 'page-b' } }), /selection-page-unavailable/);
  await combo.close();
  let priorClosureInstances = [];
  if (agentConfigured) {
    const audit = openAccountLedger({ file: path.join(docDir, 'docservice/account-v2.sqlite'), authorityId: 'assembly-doc' });
    try {
      const state = audit.read();
      assert.ok(Object.values(state.runControlsV2).length > 0);
      assert.ok(Object.values(state.runControlsV2).every(control => control.state === 'pending' && control.receipt === null));
      priorClosureInstances = Object.values(state.docRunClosuresV2).flatMap(record => Object.keys(record.instances));
      assert.ok(priorClosureInstances.length > 0);
      assert.ok(Object.values(state.docRunClosuresV2).every(record => Object.values(record.instances)
        .every(proof => proof.complete === false && proof.agentState === 'resource-closure-required')));
    } finally { audit.close(); }
  }
  combo = await startHostedCombo(config);
  if (agentConfigured) {
    const audit = openAccountLedger({ file: path.join(docDir, 'docservice/account-v2.sqlite'), authorityId: 'assembly-doc' });
    try {
      const state = audit.read(), restored = Object.values(state.docRunClosuresV2).flatMap(record => Object.keys(record.instances));
      assert.ok(priorClosureInstances.every(instance => restored.includes(instance)), 'restart preserves prior-instance closure evidence');
      assert.ok(restored.some(instance => !priorClosureInstances.includes(instance)), 'new doc instance records only its own partial evidence');
      assert.ok(Object.values(state.runControlsV2).every(control => control.state === 'pending' && control.receipt === null));
    } finally { audit.close(); }
  }
  a = await connect((await session(0)).connectionTicket);
  const recovered = await received(a, { type: 'project.open', projectId, reqId: 'reopen' });
  assert.equal(recovered.rev, 2); assert.equal(recovered.project.title, 'after');
  assert.equal(combo.docAssembly.history.accepted(projectId).length, 1);
  // A restart never persists reusable connection/delegation tickets.
  await assert.rejects(combo.accountRuntime.resolveAgentDelegation(sessions[0].agentDelegationTicket), /ticket-expired/);
  provider.createLogin({ id: 'assembly-website', accountId: ids[0], kind: 'website', now: Date.now(), expiresAt: Date.now() + 60000, generation: 1 });
  const event = provider.changePassword({ accountId: ids[0], requestId: 'password', pw: 'new-fixture-hash',
    now: Date.now(), initiatorWebsiteLoginId: 'assembly-website', clock: { diagnosticOnly: true } });
  provider.choose(event.event_id, 'assembly-website', true, 'choose-exit');
  await combo.accountRuntime.authority.synchronize(); await a.closed;
  const oldPrincipal = accepted[0].actor;
  assert.notEqual(await combo.accountRuntime.resumeGate({ ...oldPrincipal, realm: 'account', projectId, tenantId: projectId }), null);
  assert.equal((await call(0, 'session', { projectId, deviceId: 'page-0', requestId: 'revoked' })).status, 401);
  t.diagnostic(`actual order accepted=${accepted.length}, orderSeq=${changed.orderSeq}; ${agentConfigured ? 'real registered HTTP run factory; WS/LP proof and control ACK remain unavailable' : 'no run provider installed'}`);
});
