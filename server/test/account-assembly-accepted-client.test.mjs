import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createAccountClient } from '../account/client.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

const providerRoot = process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT;
const closeServer = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const reference = { projectId: 'project-a', conversationId: 'conversation-a', messageId: 'message-a', recordDigest: 'a'.repeat(64) };

test('accepted-message client keeps ordinary TTL admission strict while qualifying an exact persisted editor message until login revocation', {
  timeout: 15000, skip: !providerRoot ? 'explicit actual account provider required' : false,
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-accepted-client-')); let store, server, client;
  t.after(async () => { client?.close(); if (server?.listening) await closeServer(server); store?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const pki = assetWiringPki(dir);
  const [storeModule, credentialsModule, internalModule] = await Promise.all(['store', 'credentials', 'internal']
    .map(name => import(pathToFileURL(path.join(providerRoot, `account/${name}.mjs`)))));
  let clock = 1_800_000_000_000;
  store = storeModule.openStore(path.join(dir, 'provider.sqlite'));
  const credentials = credentialsModule.createCredentials({ store, key: randomBytes(32), now: () => clock });
  assert.equal(typeof credentials.verifyAcceptedMessageActorRef, 'function', 'actual accepted-message provider configuration required');
  const accountId = 'acc_0123456789abcdef01234567';
  store.createAccount({ id: accountId, name: 'Accepted fixture', nameKey: 'accepted-fixture', pw: 'fixture-only', now: clock });
  const login = credentials.createEditor({ account: store.accountById(accountId), deviceId: 'accepted-device', requestId: 'login-a' });
  server = internalModule.createInternalServer({ tls: pki.account, store, credentials,
    services: [{ serviceId: 'doc', fingerprint256: pki.doc.fingerprint256 }] });
  await new Promise(resolve => server.listen(5771, '127.0.0.1', resolve));
  client = createAccountClient({ origin: 'https://127.0.0.1:5771', tls: pki.doc, serverFingerprint256: pki.account.fingerprint256 });
  const initial = await client.verify(login.accessToken), actor = Object.fromEntries(
    ['accountId', 'loginId', 'credentialId', 'loginGeneration'].map(field => [field, initial[field]]));
  clock += credentialsModule.CREDENTIAL_LIMITS.accessMs + 1;
  await assert.rejects(client.verify(login.accessToken), error => error.status === 401);
  const checked = await client.verifyAcceptedMessage(actor, { purpose: 'accepted-message', messageRef: reference });
  assert.deepEqual(checked, { ...actor, accountEventSeq: store.eventHead() });
  await assert.rejects(client.verifyAcceptedMessage({ ...actor, loginGeneration: actor.loginGeneration + 1 },
    { purpose: 'accepted-message', messageRef: reference }), error => error.status === 401);
  await assert.rejects(client.verifyAcceptedMessage(actor, { purpose: 'ordinary', messageRef: reference }), error => error.status === 400);
  await assert.rejects(client.verifyAcceptedMessage({ ...actor, token: 'forged' },
    { purpose: 'accepted-message', messageRef: reference }), error => error.status === 400);
  store.revokeLogins([login.loginId], 'fixture-logout');
  await assert.rejects(client.verifyAcceptedMessage(actor, { purpose: 'accepted-message', messageRef: reference }), error => error.status === 401);
});

test('accepted-message client rejects wrong purpose, kind, actor/message echo, event head and ordinary principal envelopes', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-accepted-protocol-')); let server, client;
  t.after(async () => { client?.close(); if (server?.listening) await closeServer(server); fs.rmSync(dir, { recursive: true, force: true }); });
  const pki = assetWiringPki(dir);
  const actor = { accountId: 'acc_0123456789abcdef01234567', loginId: 'login-a', credentialId: 'credential-a', loginGeneration: 1 };
  let mutate = result => result;
  server = https.createServer({ key: pki.account.key, cert: pki.account.cert, ca: pki.account.ca,
    requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.url, '/internal/v2/credentials/verify-accepted-message'); assert.equal(body.audience, 'doc');
    assert.deepEqual(body.actorRef, actor); assert.deepEqual(body.messageRef, reference);
    assert.deepEqual(Object.keys(body).sort(), ['actorRef', 'audience', 'messageRef', 'requestId']);
    const result = mutate({ ok: true, purpose: 'accepted-message', actorRef: { ...actor }, messageRef: { ...reference }, accountEventSeq: 3, kind: 'editor' });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(5771, '127.0.0.1', resolve));
  client = createAccountClient({ origin: 'https://127.0.0.1:5771', tls: pki.doc, serverFingerprint256: pki.account.fingerprint256 });
  assert.deepEqual(await client.verifyAcceptedMessage(actor, { purpose: 'accepted-message', messageRef: reference }), { ...actor, accountEventSeq: 3 });
  for (const change of [
    value => ({ ...value, purpose: 'ordinary' }), value => ({ ...value, kind: 'website' }),
    value => ({ ...value, actorRef: { ...actor, loginId: 'wrong-login' } }),
    value => ({ ...value, messageRef: { ...reference, recordDigest: 'b'.repeat(64) } }),
    value => ({ ...value, accountEventSeq: -1 }), value => ({ ...value, accountEventSeq: 1.5 }),
    value => ({ ...value, principal: {} }), value => ({ ...value, expiresAt: 1 }),
  ]) {
    mutate = change;
    await assert.rejects(client.verifyAcceptedMessage(actor, { purpose: 'accepted-message', messageRef: reference }),
      error => error.code === 'accepted-message-protocol' && error.status === 503);
  }
});
