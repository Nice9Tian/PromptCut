// 〔裁〕H07（审查必改三）：文档服务还是旧版（不认 lease/handover，回 404）时，Agent 照常订阅、照常服务，
// 但**不把租约当成已报**、不删本地租约；文档服务换成新版以后，下一次连上就补报上。Agent 先升级也不多丢一轮。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openAccountLedger } from '../account/ledger.mjs';
import { freePorts } from './free-ports.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { agentReadControlFixture } from './agent-read-control-fixture.mjs';
import { leaseMachineDigest } from '../agent-service/conversation-control-client.mjs';

const localState = file => { const db = new DatabaseSync(file, { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT payload FROM account_authority_state WHERE id=1').get().payload); } finally { db.close(); } };

test('旧版文档服务不认报锁：照常连上、本地租约留着；换成新版后重连就补报上', { timeout: 60_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-lease-old-doc-'));
  const pki = assetWiringPki(dir), [port] = await freePorts(1);
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'lease-old-doc' });
  let oldDoc = true;
  const fixture = agentReadControlFixture({ ledger, directory: dir, docTls: pki.doc, agentTls: pki.wrong,
    docPin: pki.doc.fingerprint256, agentPin: pki.wrong.fingerprint256, port,
    accountAuthority: { authorizePrincipal: async () => { throw new Error('unused'); } }, resolveDelegation: async () => { throw new Error('unused'); }, checkConsent: async () => ({ accepted: true }),
    verifySelectionSnapshot: async () => null,
    unsupportedRoute: req => oldDoc && /\/conversation-controls\/(lease|handover)$/.test(new URL(req.url, 'https://x').pathname) });
  t.after(async () => { await fixture.close(); ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await fixture.start();
  const me = fixture.runClient.instanceIdentity(), receipts = path.join(dir, 'read-closures.sqlite');
  assert.equal(fixture.readClient.describe().connected, true, '旧版文档服务下照常连上、照常服务');
  assert.equal(ledger.read().agentReadsV1?.leases?.[me.instanceId], undefined, '旧版没记租约');
  assert.equal(localState(receipts).agentInstanceLeasesV1?.[me.instanceId]?.instanceGeneration, me.instanceGeneration, '本地租约留着');
  // 文档服务换成新版；连接断了，Agent 自己重连，这一次把锁补报上
  oldDoc = false; fixture.dropConnections();
  const until = Date.now() + 20_000;
  while (!ledger.read().agentReadsV1?.leases?.[me.instanceId]) {
    if (Date.now() > until) throw new Error('lease was not declared after the doc upgrade');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const lease = ledger.read().agentReadsV1.leases[me.instanceId];
  assert.equal(lease.machine, leaseMachineDigest()); assert.match(lease.lockId, /^lock_/);
  assert.equal(localState(receipts).agentInstanceLeasesV1?.[me.instanceId]?.lockId, lease.lockId);
});
