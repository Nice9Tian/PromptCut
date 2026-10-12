import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createDocAssembly } from '../hosted/doc-assembly.mjs';
import { createFileStore } from '../docservice/store/index.mjs';
import { bytesDigest } from '../account/run-asset-protocol.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

const projectId = `sp_${'a'.repeat(26)}`;
const original = bytesDigest(Buffer.from('original'));
const small = bytesDigest(Buffer.from('small'));
const changed = bytesDigest(Buffer.from('changed'));
const initial = { id: 'local-payload-id-is-not-the-tenant-id', media: [{ id: 'media-one', kind: 'video',
  name: 'clip.mp4', hash: original, size: 8, ext: 'mp4', tiers: { original, small } }] };
const actor = { realm: 'account', identityVersion: 2, role: 'agent', projectId,
  accountId: 'sender', loginId: 'login-one', credentialId: 'credential-one', loginGeneration: 1,
  conversationId: 'conversation-one', messageId: 'message-one', runId: 'run-one', runGrantId: 'grant-one' };
const deferred = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

test('real doc coordinator recovers SQLite history and rechecks run ACL around pinned tier metadata',
  { timeout: 30000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-gdoc-history-'));
    const pki = assetWiringPki(dir), accountKey = generateKeyPairSync('ed25519'), docKey = generateKeyPairSync('ed25519');
    const dataDir = path.join(dir, 'doc'); fs.mkdirSync(dataDir);
    let allowed = true, checks = 0, gate = null, entered = null, metadataCalls = 0, view = { projectRev: 1, value: initial, versions: {} };
    const doc = createDocAssembly({ dataDir, authority: { authorityId: 'gdoc-history-authority',
      checkAccess: async () => ({ allowed: false }) },
    account: { origin: 'https://127.0.0.1:1', clientTls: pki.doc,
      serverFingerprint256: pki.account.fingerprint256,
      order: { witnessKeys: { 'controlled-order': accountKey.publicKey }, docAttestationPrivateKey: docKey.privateKey } },
    runProvider: { async checkAccess({ principal, projectId: asked, action }) {
      checks++; assert.equal(asked, projectId); assert.equal(principal.runGrantId, actor.runGrantId);
      assert.equal(action, 'read'); return { allowed };
    }, async authorizeQuery() { throw Error('not-used'); } },
    contentTypeForExt: ext => ext === 'mp4' ? 'video/mp4' : undefined,
    async resolveTierAssetRef(input) {
      metadataCalls++; assert.equal(input.projectId, projectId); assert.equal(input.tier, 'small');
      if (entered) { entered.release(); await gate.promise; }
      return { projectId, hash: input.hash, size: 5, ext: 'mp4', contentType: 'video/mp4' };
    } });
    t.after(async () => { await doc.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const store = createFileStore({ dir: path.join(dataDir, 'tenants', projectId), log: () => {} });
    const coordinator = doc.coordinatorForSpace({ space: projectId, store, directory: path.join(dataDir, 'tenants', projectId) });
    coordinator.bind({ read: () => structuredClone(view), async materialize(operation) {
      view = { projectRev: operation.projectRev, value: operation.after, versions: doc.history.snapshot(projectId).versions };
    } });
    const selector = { mediaId: 'media-one', tier: 'small' };
    const read = () => doc.resolveRunMedia({ principal: actor, projectId, purpose: 'openRead', selector });
    const first = await read();
    assert.deepEqual(first.resource, { projectId, ns: 'media', hash: small, size: 5, ext: 'mp4', contentType: 'video/mp4' });
    assert.equal(first.projectRev, 1); assert.equal(doc.history.snapshot(projectId).value.id, initial.id);
    assert.ok(checks >= 4, 'two coordinator.read calls each verify before and within order lock');
    assert.equal(metadataCalls, 1);
    await assert.rejects(doc.resolveRunMedia({ principal: { ...actor, projectId: 'other' }, projectId,
      purpose: 'openRead', selector }), { code: 'run-asset-project-forbidden' });
    gate = deferred(); entered = deferred();
    const revoked = read(); await entered.promise; allowed = false; gate.release();
    await assert.rejects(revoked, { code: 'operation-forbidden' });
    allowed = true; gate = deferred(); entered = deferred();
    const stale = read(); await entered.promise;
    // This controlled witness is committed through the real SQLite history API.
    // The test does not claim an external account-order provider signed it.
    const prepared = doc.history.prepareOperation({ projectId, opId: 'replace-small-tier',
      requestId: 'request-replace-small-tier', docAuthorityId: 'gdoc-history-authority', expectedRev: 1,
      actor: { accountId: 'owner', loginId: 'owner-login', credentialId: 'owner-credential', loginGeneration: 1 },
      ops: [{ op: 'set', path: '/media/@media-one/tiers/small', value: changed }], dependencies: [], result: null });
    const accepted = doc.history.recordAcceptedOperation(prepared, { witnessId: 'controlled-witness',
      state: 'sealed', orderSeq: 1 });
    doc.history.materialize(accepted); assert.equal(doc.history.snapshot(projectId).projectRev, 2);
    gate.release(); await assert.rejects(stale, { code: 'stale-media-ref' });
    const current = await read();
    assert.equal(current.resource.hash, changed); assert.equal(current.projectRev, 2);
    assert.notEqual(current.mediaRev, first.mediaRev);
  });
