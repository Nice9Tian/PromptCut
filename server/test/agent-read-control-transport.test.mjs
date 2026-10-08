import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountAuthority } from '../account/authority.mjs';
import { createConversationAuthority } from '../account/conversation-authority.mjs';
import { createConversationInternalServer } from '../account/conversation-internal.mjs';
import { createConversationClient } from '../agent-service/conversation-client.mjs';
import { createAccountConversationService } from '../agent/service/conversation-policy.mjs';
import { createAgentHttp } from '../agent-service/http.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(port, '127.0.0.1', resolve);
});
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

// First counter deliberately uses the real old HTTP path and real doc ACL over
// pinned mTLS. The account credential issuer alone is controlled; nobody returns
// a fabricated access.allowed. No model/runner or production data is involved.
test('Agent history cannot send an old real access RPC result after a private fence', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-read-race-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'read-race-doc' });
  const pki = assetWiringPki(dir), projectId = 'sp_' + 'a'.repeat(26), conversationId = 'read_race';
  const owner = 'acc_' + 'a'.repeat(24), member = 'acc_' + 'b'.repeat(24);
  const principals = new Map([owner, member].map(accountId => [accountId, {
    identityVersion: 2, realm: 'account', accountId, accountName: accountId === owner ? 'Owner' : 'Member',
    loginId: `login-${accountId}`, credentialId: `cred-${accountId}`, loginGeneration: 1,
    expiresAt: Date.now() + 60000, accountEventSeq: 0,
  }]));
  const account = createAccountAuthority({ ledger, pollMs: 0, accountClient: {
    async verify(token) { const p = principals.get(token); assert.ok(p); return structuredClone(p); },
    async events() { return { events: [], headSeq: 0 }; },
  } });
  ledger.transaction(s => { s.projects[projectId] = { projectId, creatorAccountId: owner, status: 'active',
    hosted: { agent: true }, bans: {}, members: { [owner]: { access: 'rw' }, [member]: { access: 'rw' } }, accessRevision: 1 }; });
  const conversations = createConversationAuthority({ ledger, accountAuthority: account,
    checkConsent: async ({ accountId }) => ({ accountId, accepted: true, noticeVersion: 1 }),
    verifySelectionSnapshot: async ({ principal }) => ({ projectId, accountId: principal.accountId,
      pageId: 'page_race', selection: {}, source: 'sent-snapshot', sentAt: 1 }),
    // No run exists. The old production assembly likewise leaves closure pending.
    runHooks: { fenceInState() {} }, onFence: async () => { throw Object.assign(new Error('agent-fence-pending'), { code: 'agent-fence-pending', status: 503 }); },
  });
  await conversations.send({ principalRef: { accessToken: owner }, projectId, conversationId,
    requestId: 'message1', content: 'PRIVATE_RACE_SENTINEL' });
  const trusted = await account.authorizePrincipal({ accessToken: member }, { projectId, action: 'read' });
  const doc = createConversationInternalServer({ tls: pki.doc, conversationAuthority: conversations,
    agentFingerprint256: pki.asset.fingerprint256,
    resolveDelegation: async value => { assert.equal(value, 'temporary-delegation'); return trusted; } });
  const client = createConversationClient({ origin: 'https://127.0.0.1:6600', tls: pki.asset,
    serverFingerprint256: pki.doc.fingerprint256 });
  const checked = deferred(), release = deferred(); let held = false, actualAllowed = null;
  const originalAccess = client.access;
  client.access = async input => {
    const result = await originalAccess(input);
    if (!held) { held = true; actualAllowed = result.allowed; checked.resolve(); await release.promise; }
    return result;
  };
  const service = createAccountConversationService({ conversationClient: client });
  const api = createAgentHttp({ service, authenticate: async () => ({ accountMode: true, projectId,
    userId: member, accountId: member, delegation: 'temporary-delegation' }) });
  const agent = http.createServer((req, res) => { void api.handle(req, res); });
  let request;
  t.after(async () => { release.resolve(); request?.destroy(); client.close(); await close(agent); await close(doc);
    account.close(); ledger.close(); fs.rmSync(dir, { recursive: true }); });
  await listen(doc, 6600); await listen(agent, 6601);
  const body = new Promise((resolve, reject) => {
    request = http.get(`http://127.0.0.1:6601/v1/conversations/${conversationId}/events`, res => {
      const chunks = []; res.on('data', bytes => chunks.push(bytes));
      res.once('close', () => resolve(Buffer.concat(chunks).toString('utf8'))); res.on('error', () => {});
    }); request.once('error', reject);
  });
  await checked.promise;
  await assert.rejects(conversations.switchVisibility({ principalRef: { accessToken: owner }, projectId, conversationId,
    visibility: 'private', requestId: 'private1' }), { code: 'agent-fence-pending' });
  assert.equal(ledger.read().conversationsV2[projectId][conversationId].visibility, 'private');
  assert.equal(actualAllowed, true);
  release.resolve();
  const received = await body;
  t.diagnostic(JSON.stringify({ actualDocRpc: true, realSqlitePrivate: true, actualAllowed,
    leakedSentinel: received.includes('PRIVATE_RACE_SENTINEL'), executorMounted: false }));
  assert.equal(received.includes('PRIVATE_RACE_SENTINEL'), false, 'old lawful RPC result must not escape after the fence');
});
