import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountAuthority } from '../account/authority.mjs';
import { LOGOUT_CONFIRM_TIMEOUT_MS } from '../account/logout-confirmer.mjs';
import { createDocService } from '../docservice/service.mjs';

test('LOGOUT_CONFIRM_TIMEOUT_MS is 45 seconds (45_000 ms)', () => {
  assert.equal(LOGOUT_CONFIRM_TIMEOUT_MS, 45_000);
});

test('established connection with authorizationId does not expire after 120s or 300s', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-rev-life-'));
  const file = path.join(dir, 'account.db');

  const ledger = openAccountLedger({ file, authorityId: 'doc-fixture' });
  const keys = generateKeyPairSync('ed25519');
  let now = 1000;

  const client = {
    async verify(token) {
      if (token === 'valid-token') {
        return {
          identityVersion: 2,
          realm: 'account',
          accountId: 'acc_111111111111111111111111',
          accountName: 'Alice',
          loginId: 'login-alice-1',
          loginGeneration: 1,
          credentialId: 'cred-1',
          kind: 'website',
          expiresAt: now + 120_000,
          accountEventSeq: 0,
        };
      }
      throw Object.assign(new Error('credential-revoked'), { status: 401, code: 'credential-revoked' });
    },
    async events(after = 0) {
      return { events: [], headSeq: 0 };
    },
    async revocations(since = 0) {
      return { events: [], headSeq: 0 };
    },
  };

  const authority = createAccountAuthority({
    ledger,
    accountClient: client,
    initializeProject: async () => ({ contentId: 'c1' }),
    authorityUrl: 'https://fixture.invalid',
    signingKey: keys.privateKey,
    keyId: 'k1',
    pollMs: 0,
    now: () => now,
  });

  t.after(() => {
    authority.close();
    ledger.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  await authority.start();

  // Create a project
  const project = await authority.createProject({ accessToken: 'valid-token' }, {
    name: 'Project 1',
    requestId: 'req-create-1',
  });

  // Initial connection auth
  const principal = await authority.authorizePrincipal({ accessToken: 'valid-token' }, {
    projectId: project.projectId,
    action: 'write',
  });
  assert.ok(principal.authorizationId);

  // Operation check at t = 1000
  let access = await authority.checkAccess({ principal, projectId: project.projectId, action: 'write' });
  assert.equal(access.allowed, true);

  // Time advances past 120s (token expiration)
  now += 150_000;
  // Connection DOES NOT expire by clock time!
  access = await authority.checkAccess({ principal, projectId: project.projectId, action: 'write' });
  assert.equal(access.allowed, true);

  // Time advances past 300s
  now += 200_000;
  access = await authority.checkAccess({ principal, projectId: project.projectId, action: 'write' });
  assert.equal(access.allowed, true);

  // Now, active revocation notification arrives:
  const revEvent = {
    v: 2,
    issuer: 'visuhive-account',
    type: 'credentials-revoked',
    eventId: 'pw_rev_1',
    accountId: 'acc_111111111111111111111111',
    seq: 1,
    changeSeq: 1,
    changedAt: now,
    oldLoginIds: ['login-alice-1'],
    revokedLoginIds: ['login-alice-1'],
    initiatorWebsiteLoginId: 'website-other',
  };

  const ack = await authority.applyRevocationNotification(revEvent);
  assert.equal(ack.ok, true);
  assert.equal(ack.ackSeq, 1);

  // Now checkAccess MUST be rejected immediately!
  await assert.rejects(
    authority.checkAccess({ principal, projectId: project.projectId, action: 'write' }),
    { code: 'credential-revoked' }
  );
});

test('docservice handles POST /internal/v2/revocations and confirms with ackSeq', async (t) => {
  let receivedEvent = null;
  const service = createDocService({
    onRevocationNotification: async (event) => {
      receivedEvent = event;
      return { ok: true, ackSeq: event.seq };
    },
  });
  t.after(() => service.close());

  const req = {
    url: '/internal/v2/revocations',
    method: 'POST',
    socket: {},
    on(event, cb) {
      if (event === 'data') {
        cb(Buffer.from(JSON.stringify({ seq: 7, type: 'credentials-revoked', accountId: 'acc_111111111111111111111111' })));
      } else if (event === 'end') {
        cb();
      }
    },
  };

  let responseData = '';
  let responseStatus = 0;
  const res = {
    writeHead(status) { responseStatus = status; },
    end(data) { responseData = data; },
  };

  const handled = service.handleTransportHttp(req, res);
  assert.equal(handled, true);

  await new Promise(r => setTimeout(r, 20));
  assert.equal(responseStatus, 200);
  const parsed = JSON.parse(responseData);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ackSeq, 7);
  assert.equal(receivedEvent.seq, 7);
});

test('docservice rejects POST /internal/v2/revocations with 503 if authority is not ready', async (t) => {
  const service = createDocService();
  t.after(() => service.close());

  let status = 0, body = '';
  const req = {
    url: '/internal/v2/revocations', method: 'POST', socket: { remoteAddress: '127.0.0.1' },
    on() {},
  };
  const res = {
    writeHead(s) { status = s; },
    end(b) { body = b; },
  };
  service.handleTransportHttp(req, res);
  assert.equal(status, 503);
  assert.equal(JSON.parse(body).code, 'authority-not-ready');
});

test('docservice rejects POST /internal/v2/revocations with 403 from unauthorized remote', async (t) => {
  const service = createDocService({ onRevocationNotification: async () => ({ ok: true }) });
  t.after(() => service.close());

  let status = 0, body = '';
  const req = {
    url: '/internal/v2/revocations', method: 'POST', socket: { remoteAddress: '198.51.100.1' },
    headers: {},
    on() {},
  };
  const res = {
    writeHead(s) { status = s; },
    end(b) { body = b; },
  };
  service.handleTransportHttp(req, res);
  assert.equal(status, 403);
  assert.equal(JSON.parse(body).code, 'service-forbidden');
});

test('docservice catches up missed events using sinceSeq when gap occurs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-rev-catchup-'));
  const file = path.join(dir, 'account.db');

  const ledger = openAccountLedger({ file, authorityId: 'doc-fixture' });
  const keys = generateKeyPairSync('ed25519');

  let started = false;
  const client = {
    async verify() { throw new Error(); },
    async events() { return { events: [], headSeq: 0 }; },
    async revocations(since) {
      if (!started) return { events: [], headSeq: 0 };
      // After started, returning missed event 1
      return {
        events: [{
          v: 2,
          issuer: 'visuhive-account',
          type: 'credentials-revoked',
          eventId: 'pw_missed_1',
          accountId: 'acc_111111111111111111111111',
          seq: 1,
          changeSeq: 1,
          oldLoginIds: ['login-missed'],
          revokedLoginIds: ['login-missed'],
        }],
        headSeq: 1,
      };
    },
  };

  const authority = createAccountAuthority({
    ledger,
    accountClient: client,
    initializeProject: async () => ({ contentId: 'c1' }),
    authorityUrl: 'https://fixture.invalid',
    signingKey: keys.privateKey,
    keyId: 'k1',
    pollMs: 0,
  });

  t.after(() => {
    authority.close();
    ledger.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  await authority.start();
  started = true;

  // Initial head is 0
  assert.equal(ledger.read().accountHead, 0);

  // Event 2 arrives directly (gap detected: 2 > 0 + 1)
  const event2 = {
    v: 2,
    issuer: 'visuhive-account',
    type: 'credentials-revoked',
    eventId: 'pw_direct_2',
    accountId: 'acc_111111111111111111111111',
    seq: 2,
    changeSeq: 2,
    oldLoginIds: ['login-direct-2'],
    revokedLoginIds: ['login-direct-2'],
  };

  const ack = await authority.applyRevocationNotification(event2);
  assert.equal(ack.ok, true);
  assert.equal(ack.ackSeq, 2);

  // Both events 1 and 2 applied in order
  assert.equal(ledger.read().accountHead, 2);
  assert.ok(ledger.read().revokedLogins['login:login-missed']);
  assert.ok(ledger.read().revokedLogins['login:login-direct-2']);
});
