import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { X509Certificate, randomBytes, generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import { createAccountClient } from '../account/client.mjs';
import { openAccountLedger, canonicalJson } from '../account/ledger.mjs';
import { createAccountAuthority } from '../account/authority.mjs';
import { mountAccountProjects, createAccountProjectsInternalServer } from '../docservice/modules/account-projects.mjs';

const providerDir = process.env.ACCOUNT_PROVIDER_DIR ?? 'C:/Users/admin/Documents/VisuHive/.worktrees/018-account-foundation';
const available = fs.existsSync(path.join(providerDir, 'account/internal.mjs'));
const ids = ['acc_0123456789abcdef01234567', 'acc_abcdef0123456789abcdef01'];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));
const fails = (work, code) => assert.rejects(work, error => error.code === code);
function certificateFixture(dir) {
  const openssl = process.env.OPENSSL ?? (process.platform === 'win32' ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/usr/bin/openssl.exe') : 'openssl');
  const run = args => { const result = spawnSync(openssl, args, { cwd: dir, windowsHide: true, stdio: 'ignore', timeout: 30000 }); assert.equal(result.status, 0, 'temporary mTLS fixture generation'); };
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Temporary account project CA', '-keyout', 'ca.key', '-out', 'ca.crt']);
  fs.writeFileSync(path.join(dir, 'extensions.txt'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n');
  const ca = fs.readFileSync(path.join(dir, 'ca.crt'));
  const leaf = name => {
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-keyout', `${name}.key`, '-out', `${name}.csr`]);
    run(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'extensions.txt', '-out', `${name}.crt`]);
    return { key: fs.readFileSync(path.join(dir, `${name}.key`)), cert: fs.readFileSync(path.join(dir, `${name}.crt`)), ca };
  };
  return { server: leaf('account'), doc: leaf('doc'), account: leaf('account-caller'), asset: leaf('asset'), ca };
}
function request(origin, tls, method, route, body, headers = {}) {
  return new Promise(resolve => {
    const req = (origin.startsWith('https:') ? https : http).request(origin + route, { ...tls, agent: false, method,
      timeout: 3000, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) }); } catch { resolve({ failed: true }); }
      });
    });
    req.on('error', () => resolve({ failed: true })); req.on('timeout', () => req.destroy()); req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('account project v2 real frozen provider, pinned mTLS, persisted doc authority and A/B separation',
  { skip: !available && 'readonly account provider not available; set ACCOUNT_PROVIDER_DIR' }, async t => {
    const [storeModule, credentialModule, internalModule] = await Promise.all(['store', 'credentials', 'internal'].map(name => import(pathToFileURL(path.join(providerDir, `account/${name}.mjs`)).href)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-account-projects-'));
    const tls = certificateFixture(dir); const store = storeModule.openStore(path.join(dir, 'account.sqlite'));
    const credentials = credentialModule.createCredentials({ store, key: randomBytes(32) });
    for (const [i, id] of ids.entries()) assert.equal(store.createAccount({ id, name: `Fixture ${i}`, nameKey: `fixture-${i}`, pw: 'unusable-hash-fixture', now: Date.now() }), true);
    const login = (i, requestId) => credentials.createEditor({ account: store.accountById(ids[i]), deviceId: `device-${requestId}`, requestId });
    const a = login(0, 'a-1'), a2 = login(0, 'a-2'), b = login(1, 'b-1'), b2 = login(1, 'b-2');
    const accountServer = internalModule.createInternalServer({ tls: tls.server, store, credentials,
      services: [{ serviceId: 'doc', fingerprint256: new X509Certificate(tls.doc.cert).fingerprint256 },
        { serviceId: 'asset', fingerprint256: new X509Certificate(tls.asset.cert).fingerprint256 }] });
    await listen(accountServer); const origin = `https://127.0.0.1:${accountServer.address().port}`;
    const pin = new X509Certificate(tls.server.cert).fingerprint256;
    const client = createAccountClient({ origin, tls: tls.doc, serverFingerprint256: pin });
    const keys = generateKeyPairSync('ed25519'); const file = path.join(dir, 'doc.sqlite');
    let ledger, authority, initialized = 0, failInitialize = false;
    const initializeProject = async ({ projectId, initialProject }) => {
      if (failInitialize) throw Object.assign(new Error('fixture init unavailable'), { code: 'initialization-unavailable', status: 503 });
      const contentFile = path.join(dir, `${projectId}.content`);
      const fd = fs.openSync(contentFile, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(initialProject)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      initialized++; return { contentId: `content:${projectId}` };
    };
    const open = () => {
      ledger = openAccountLedger({ file, authorityId: 'doc-fixture' });
      authority = createAccountAuthority({ ledger, accountClient: client, initializeProject, authorityUrl: 'https://fixture.invalid/editor',
        signingKey: keys.privateKey, keyId: 'fixture-key', pollMs: 0 }); return authority.start();
    };
    await open(); let project, aPrincipal, bPrincipal, publicServer, docServer;
    t.after(async () => {
      if (publicServer) await close(publicServer); if (docServer) await close(docServer);
      authority.close(); ledger.close(); client.close(); await close(accountServer); store.close();
      const target = path.resolve(dir); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('pc-account-projects-'));
      fs.rmSync(target, { recursive: true, force: true });
    });
    await t.test('owner supplied TLS pin and doc cert required, asset/no cert/wrong pin rejected', async () => {
      assert.equal((await client.verify(a.accessToken)).accountId, ids[0]);
      const wrong = createAccountClient({ origin, tls: tls.asset, serverFingerprint256: pin });
      const badPin = createAccountClient({ origin, tls: tls.doc, serverFingerprint256: '0'.repeat(64) });
      try { await fails(() => wrong.verify(a.accessToken), 'account-unavailable'); await fails(() => badPin.verify(a.accessToken), 'account-unavailable'); }
      finally { wrong.close(); badPin.close(); }
      assert.equal((await request(origin, { ca: tls.ca }, 'POST', '/internal/v2/credentials/verify', { accessToken: a.accessToken })).failed, true);
    });
    await t.test('SQLite v2 WAL explicit FULL, integrity and no LAN mutation', () => {
      assert.deepEqual({ schema: ledger.inspect().schema, synchronous: ledger.inspect().synchronous, journal: ledger.inspect().journalMode, integrity: ledger.inspect().integrity },
        { schema: 2, synchronous: 2, journal: 'wal', integrity: 'ok' });
    });
    await t.test('creator persisted before initializer, pending hidden, retry reuses id and result', async () => {
      failInitialize = true;
      await fails(() => authority.createProject({ accessToken: a.accessToken }, { name: 'A project', requestId: 'create-a', initialProject: { cards: [] } }), 'initialization-unavailable');
      assert.equal(authority.listProjects(ids[0]).owned.length, 0);
      const pending = Object.values(ledger.read().projects)[0]; assert.equal(pending.creatorAccountId, ids[0]); assert.equal(pending.status, 'pending');
      assert.throws(() => authority.status({ authorityId: 'doc-fixture', projectId: pending.projectId }), /no-project/);
      failInitialize = false; project = await authority.createProject({ accessToken: a.accessToken }, { name: 'A project', requestId: 'create-a', initialProject: { cards: [] } });
      assert.equal(project.projectId, pending.projectId); assert.equal(initialized, 1);
      assert.deepEqual(await authority.createProject({ accessToken: a.accessToken }, { name: 'A project', requestId: 'create-a', initialProject: { cards: [] } }), project);
      await fails(() => authority.createProject({ accessToken: a.accessToken }, { name: 'different', requestId: 'create-a' }), 'request-mismatch');
    });
    await t.test('owned/joined unique doc lists; no B access before actual join; body creator cannot self elevate', async () => {
      assert.equal(authority.listProjects(ids[0]).owned[0].projectId, project.projectId); assert.equal(authority.listProjects(ids[1]).joined.length, 0);
      await fails(() => authority.authorizePrincipal({ accessToken: b.accessToken, accountId: ids[0], creator: true }, { projectId: project.projectId }), 'not-listed');
      await authority.joinProject({ accessToken: b.accessToken }, { projectId: project.projectId, requestId: 'join-b' });
      assert.equal(authority.listProjects(ids[1]).joined[0].projectId, project.projectId);
      aPrincipal = await authority.authorizePrincipal({ accessToken: a.accessToken }, { projectId: project.projectId });
      bPrincipal = await authority.authorizePrincipal({ accessToken: b.accessToken }, { projectId: project.projectId });
      assert.equal(bPrincipal.creator, false); assert.equal(aPrincipal.creator, true);
    });
    await t.test('opaque reference binds live account/generation/project; raw identity and altered generation denied', async () => {
      assert.equal((await authority.checkAccess({ principal: aPrincipal, projectId: project.projectId, action: 'write', resource: { ns: 'media', hash: 'a'.repeat(64) } })).allowed, true);
      await fails(() => authority.checkAccess({ principal: { ...aPrincipal, authorizationId: undefined }, projectId: project.projectId, action: 'read' }), 'login-required');
      await fails(() => authority.checkAccess({ principal: { ...aPrincipal, loginGeneration: 99 }, projectId: project.projectId, action: 'read' }), 'principal-mismatch');
      await fails(() => authority.checkAccess({ principal: aPrincipal, projectId: `sp_${'a'.repeat(26)}`, action: 'read' }), 'project-mismatch');
    });
    await t.test('creator Agent identity never administrator; other account cannot admin', async () => {
      const agent = await authority.authorizePrincipal({ accessToken: a.accessToken }, { projectId: project.projectId, trustedRole: 'agent' });
      const body = { projectId: project.projectId, op: 'set-entry', allowLinkJoin: false, requestId: 'not-admin', expectedAccessRevision: agent.accessRevision };
      await fails(() => authority.adminProject(agent, body), 'creator-required');
      await fails(() => authority.adminProject({ accessToken: b.accessToken }, body), 'creator-required');
    });
    await t.test('restricted entry/list writes enforce current revision; removal affects both devices and read-only forbids write', async () => {
      const admin = async body => {
        const before = await authority.authorizePrincipal(aPrincipal, { projectId: project.projectId });
        return authority.adminProject(aPrincipal, { projectId: project.projectId, expectedAccessRevision: before.accessRevision, ...body });
      };
      const before = await authority.authorizePrincipal(aPrincipal, { projectId: project.projectId });
      await admin({ op: 'set-entry', allowLinkJoin: false, requestId: 'restricted-entry' });
      await fails(() => authority.adminProject(aPrincipal, { projectId: project.projectId, expectedAccessRevision: before.accessRevision,
        op: 'set-entry', allowLinkJoin: true, requestId: 'stale-entry' }), 'access-revision-mismatch');
      await admin({ op: 'set-list', members: [], requestId: 'remove-b-list' });
      await fails(() => authority.checkAccess({ principal: bPrincipal, projectId: project.projectId, action: 'read' }), 'not-listed');
      await fails(() => authority.authorizePrincipal({ accessToken: b2.accessToken }, { projectId: project.projectId }), 'not-listed');
      await fails(() => authority.joinProject({ accessToken: b.accessToken }, { projectId: project.projectId, requestId: 'restricted-b-join' }), 'not-listed');
      await admin({ op: 'set-list', members: [{ accountId: ids[1], access: 'r' }], requestId: 'allow-b-read' });
      assert.equal(authority.listProjects(ids[1]).joined.length, 0);
      await authority.joinProject({ accessToken: b.accessToken }, { projectId: project.projectId, requestId: 'listed-b-join' });
      const read = await authority.authorizePrincipal({ accessToken: b.accessToken }, { projectId: project.projectId });
      assert.equal((await authority.checkAccess({ principal: read, projectId: project.projectId, action: 'read' })).allowed, true);
      await fails(() => authority.checkAccess({ principal: read, projectId: project.projectId, action: 'write' }), 'not-listed');
      await admin({ op: 'set-list', members: [{ accountId: ids[1], access: 'rw' }], requestId: 'allow-b-write' });
      await admin({ op: 'set-hosted-service', service: 'agent', enabled: true, requestId: 'enable-agent' });
      assert.equal(ledger.read().projects[project.projectId].hosted.agent, true);
    });
    await t.test('kick persists account ban and closes permissions for both device logins; notification alone does not complete', async () => {
      let notified = null; const unsubscribe = authority.subscribeRevocations({ projectId: project.projectId, accountId: ids[1] }, event => { notified = event; });
      const before = await authority.authorizePrincipal(aPrincipal, { projectId: project.projectId });
      const kicked = await authority.adminProject(aPrincipal, { projectId: project.projectId, op: 'kick', accountId: ids[1], requestId: 'kick-b', expectedAccessRevision: before.accessRevision });
      assert.equal(kicked.completed, false); assert.deepEqual(notified.accountIds, [ids[1]]); unsubscribe();
      await fails(() => authority.authorizePrincipal({ accessToken: b.accessToken }, { projectId: project.projectId }), 'banned');
      await fails(() => authority.authorizePrincipal({ accessToken: b2.accessToken }, { projectId: project.projectId }), 'banned');
      await fails(() => authority.joinProject({ accessToken: b2.accessToken }, { projectId: project.projectId, requestId: 'b-rejoin' }), 'banned');
      assert.equal(authority.listProjects(ids[1]).joined.length, 0);
    });
    await t.test('restart preserves bans/head/list; opaque refs expire and require fresh verified handshake', async () => {
      const head = ledger.read().accessHead; authority.close(); ledger.close(); await open();
      assert.equal(ledger.read().accessHead, head); assert.equal(authority.listProjects(ids[0]).owned.length, 1);
      await fails(() => authority.checkAccess({ principal: aPrincipal, projectId: project.projectId, action: 'read' }), 'authorization-expired');
      await fails(() => authority.authorizePrincipal({ accessToken: b2.accessToken }, { projectId: project.projectId }), 'banned');
      aPrincipal = await authority.authorizePrincipal({ accessToken: a.accessToken }, { projectId: project.projectId });
    });
    await t.test('real password success retains old access for choice no; choice yes exact old set preserves new B login and initiator website', async () => {
      const now = Date.now();
      const website = store.createSession({ tokenHash: randomBytes(32).toString('hex'), accountId: ids[1], now, expiresAt: now + 86400000 });
      const changed = store.changePassword({ accountId: ids[1], requestId: 'password-b-retain', pw: 'new-unusable-hash', now,
        initiatorWebsiteLoginId: website.loginId });
      await authority.synchronize();
      assert.equal((await client.verify(b.accessToken)).loginId, b.loginId);
      store.choose(changed.event_id, website.loginId, false, 'choose-retain');
      await authority.synchronize(); assert.equal((await client.verify(b2.accessToken)).loginId, b2.loginId);
      const acked = await authority.flushAccountAcknowledgements(); assert.equal(acked.pendingEvents.length, 0);
      assert.equal(store.acks(changed.event_id).find(ack => ack.service === 'doc').logoutComplete, false);
      const changed2 = store.changePassword({ accountId: ids[1], requestId: 'password-b-exit', pw: 'newer-unusable-hash', now: Date.now(),
        initiatorWebsiteLoginId: website.loginId });
      const freshB = login(1, 'b-after-password'); store.choose(changed2.event_id, website.loginId, true, 'choose-exit');
      await authority.synchronize();
      const status = authority.revocationStatus(changed2.event_id);
      assert.ok(status.loginIds.includes(b.loginId)); assert.ok(status.loginIds.includes(b2.loginId));
      assert.equal(status.loginIds.includes(freshB.loginId), false); assert.equal(status.loginIds.includes(website.loginId), false);
      await fails(() => client.verify(b.accessToken), 'credential-revoked'); assert.equal((await client.verify(freshB.accessToken)).accountId, ids[1]);
      assert.equal(store.login(website.loginId).revoked_event_id, null);
      const pending = await authority.flushAccountAcknowledgements(); assert.ok(pending.pendingEvents.includes(changed2.event_id));
      assert.equal(store.acks(changed2.event_id).some(ack => ack.logoutComplete), false);
      const createdB = await authority.createProject({ accessToken: freshB.accessToken }, { name: 'B project', requestId: 'create-b' });
      assert.equal(authority.listProjects(ids[1]).owned[0].projectId, createdB.projectId);
      assert.equal(authority.listProjects(ids[0]).owned.length, 1);
    });
    await t.test('restart pulls every page through global account head including unrelated account events', async () => {
      for (let i = 0; i < 105; i++) {
        const id = `paged-login-${i}`;
        store.createLogin({ id, accountId: ids[1], kind: 'editor', now: Date.now(), expiresAt: Date.now() + 3600000 });
        store.logoutLogin(id, Date.now());
      }
      const cursor = ledger.read().accountHead;
      assert.ok(store.eventHead() - cursor > 100);
      authority.close(); ledger.close(); await open();
      assert.equal(ledger.read().accountHead, store.eventHead());
      assert.equal(Object.keys(ledger.read().accountEvents).length, store.eventHead());
      aPrincipal = await authority.authorizePrincipal({ accessToken: a.accessToken }, { projectId: project.projectId });
    });
    await t.test('ordinary real logout consumes exact global account sequence, no account-wide expansion; new login survives', async () => {
      const logout = store.logoutLogin(a.loginId, Date.now()); const fresh = login(0, 'a-fresh');
      await authority.synchronize(); const barrier = authority.revocationStatus(logout.eventId);
      assert.deepEqual(barrier.loginIds, [a.loginId]); assert.equal(barrier.logoutComplete, false); assert.ok(barrier.pendingServices.includes('doc'));
      await fails(() => authority.authorizePrincipal(aPrincipal, { projectId: project.projectId }), 'credential-revoked');
      assert.equal((await authority.authorizePrincipal({ accessToken: a2.accessToken }, { projectId: project.projectId })).allowed, undefined);
      aPrincipal = await authority.authorizePrincipal({ accessToken: fresh.accessToken }, { projectId: project.projectId });
      assert.equal(aPrincipal.accountId, ids[0]);
      assert.equal(ledger.read().accountHead, store.eventHead());
      assert.equal(authority.applyRevocation(store.events(0).events[0]).duplicate, true);
    });
    await t.test('persisted service ACK idempotency and restart do not invent doc close/order evidence', async () => {
      const event = ledger.read().accessEvents.find(e => e.type === 'login-revoked' && e.loginIds.includes(a.loginId));
      const receipt = { receiptId: 'asset-close-real-fixture', cursor: event.seq, complete: true, closedStreams: ['fixture-stream-closed'], stoppedRuns: [], rejectedCredentials: [a.loginId] };
      assert.deepEqual(authority.ackAccessEvent(event.eventId, 'asset', receipt), receipt);
      assert.deepEqual(authority.ackAccessEvent(event.eventId, 'asset', receipt), receipt);
      assert.throws(() => authority.ackAccessEvent(event.eventId, 'asset', { ...receipt, closedStreams: [] }), /ack-mismatch/);
      assert.throws(() => authority.ackAccessEvent(event.eventId, 'doc', receipt), /service-forbidden/);
      authority.close(); ledger.close(); await open();
      assert.deepEqual(authority.revocationStatus(event.accountEventId).serviceAcks.asset, receipt);
      assert.equal(authority.revocationStatus(event.accountEventId).logoutComplete, false);
      aPrincipal = await authority.authorizePrincipal({ accessToken: a2.accessToken }, { projectId: project.projectId });
    });
    await t.test('private internal mTLS account list and asset check/events; certificate method allowlist, no public internal fallback', async () => {
      const services = [{ serviceId: 'account', fingerprint256: new X509Certificate(tls.account.cert).fingerprint256 }, { serviceId: 'asset', fingerprint256: new X509Certificate(tls.asset.cert).fingerprint256 }];
      docServer = createAccountProjectsInternalServer({ tls: tls.doc, authority, services }); await listen(docServer);
      const mounted = mountAccountProjects({ authority, services });
      publicServer = http.createServer(async (req, res) => { if (!await mounted.handlePublic(req, res)) { res.writeHead(404); res.end(JSON.stringify({ error: 'no-route' })); } }); await listen(publicServer);
      const docOrigin = `https://127.0.0.1:${docServer.address().port}`;
      assert.equal((await request(docOrigin, tls.account, 'GET', `/internal/v2/projects?accountId=${ids[0]}`)).data.owned.length, 1);
      assert.equal((await request(docOrigin, tls.asset, 'GET', `/internal/v2/projects?accountId=${ids[0]}`)).status, 403);
      assert.equal((await request(docOrigin, tls.account, 'GET', '/internal/v2/access/events?after=0')).status, 403);
      assert.equal((await request(docOrigin, { ca: tls.ca }, 'GET', '/internal/v2/access/events?after=0')).failed, true);
      const checked = await request(docOrigin, tls.asset, 'POST', '/internal/v2/access/check', { principal: aPrincipal, projectId: project.projectId, action: 'read', resource: { ns: 'px' } });
      assert.equal(checked.status, 200); assert.equal(checked.data.allowed, true);
      assert.equal((await request(docOrigin, tls.asset, 'POST', '/internal/v2/access/check', { principal: aPrincipal, projectId: project.projectId, action: 'read', runGrantId: 'forged' })).status, 400);
      assert.equal((await request(`http://127.0.0.1:${publicServer.address().port}`, {}, 'GET', `/internal/v2/projects?accountId=${ids[0]}`)).status, 404);
      assert.equal((await request(`http://127.0.0.1:${publicServer.address().port}`, {}, 'POST', '/hosted/shared/account/create', { name: 'bad', requestId: 'bad' }, { cookie: 'vh_session=untrusted' })).status, 400);
    });
    await t.test('delete idempotency; gone is owner signed exact tombstone, wrong authority/unknown/invalid login never gone', async () => {
      const before = await authority.authorizePrincipal(aPrincipal, { projectId: project.projectId });
      const body = { projectId: project.projectId, op: 'delete', requestId: 'delete-a', expectedAccessRevision: before.accessRevision };
      const deleted = await authority.adminProject(aPrincipal, body); assert.deepEqual(await authority.adminProject(aPrincipal, body), deleted);
      const gone = await authority.statusForPrincipal(aPrincipal, { authorityId: 'doc-fixture', projectId: project.projectId });
      const { signature, ...payload } = gone; assert.equal(gone.state, 'gone'); assert.equal(verifySignature(null, Buffer.from(canonicalJson(payload)), keys.publicKey, Buffer.from(signature, 'base64url')), true);
      assert.throws(() => authority.status({ authorityId: 'wrong', projectId: project.projectId }), /wrong-authority/);
      assert.throws(() => authority.status({ authorityId: 'doc-fixture', projectId: `sp_${'b'.repeat(26)}` }), /no-project/);
      assert.equal(authority.listProjects(ids[0]).owned.length, 0);
      await fails(() => authority.statusForPrincipal({ accessToken: a.accessToken }, { authorityId: 'doc-fixture', projectId: project.projectId }), 'credential-revoked');
    });
    await t.test('usable access tokens absent from durable doc ledger', () => {
      const bytes = Buffer.concat(['', '-wal'].filter(s => fs.existsSync(file + s)).map(s => fs.readFileSync(file + s)));
      for (const editor of [a, a2, b, b2]) assert.equal(bytes.includes(Buffer.from(editor.accessToken)), false);
    });
  });
