import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openAccountLedger } from '../account/ledger.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

async function launch(file, args) {
  const child = fork(fileURLToPath(new URL(file, import.meta.url)), args,
    { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = once(child, 'close'); const [ready] = await once(child, 'message'); let seq = 0;
  return { child, closed, ready, call(command) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const listener = result => { if (result.id !== id) return; child.off('message', listener);
        if (result.error) reject(new Error(result.error)); else resolve(result.result); };
      child.on('message', listener); child.send({ ...command, id });
    });
  } };
}
for (const cut of ['instance-register-before-commit', 'instance-register-after-commit',
  'run-admit-before-commit', 'run-admit-after-commit', 'run-read-before-commit', 'run-read-after-commit'])
test(`doc-only actual exit73/close at ${cut}: independent live Agent key and local readIntent recover exact durable result`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-instance-doc-crash-')); assetWiringPki(dir);
  const children = []; let doc = await launch('./agent-instance-doc-child.mjs', [dir, cut]); children.push(doc);
  const agent = await launch('./agent-instance-tls-child.mjs', [dir, String(doc.ready.port)]); children.push(agent);
  t.after(async () => {
    for (const item of children) if (item.child.exitCode === null && item.child.connected) item.child.send({ kind: 'stop' });
    await Promise.all(children.map(item => item.closed)); fs.rmSync(dir, { recursive: true });
  });
  const register = () => agent.call({ kind: 'register', requestId: 'same-live-agent' });
  const admit = () => agent.call({ kind: 'invoke', operation: 'admit', request: { projectId: 'project', conversationId: 'conversation', requestId: 'admit-one' } });
  let grant, intent;
  if (cut.startsWith('instance-register')) await assert.rejects(register());
  else {
    assert.equal((await register()).status, 200);
    if (cut.startsWith('run-admit')) await assert.rejects(admit());
    else {
      grant = (await admit()).result; intent = await agent.call({ kind: 'prepare', grant });
      await assert.rejects(agent.call({ kind: 'confirm', readIntentId: intent.readIntentId }), /read-confirmation-unknown/);
    }
  }
  assert.equal((await doc.closed)[0], 73); assert.equal(agent.child.exitCode, null);
  const inspect = () => { const ledger = openAccountLedger({ file: path.join(dir, 'doc.db'), authorityId: 'instance-doc-crash' });
    try { assert.equal(ledger.inspect().integrity, 'ok'); return ledger.read(); } finally { ledger.close(); } };
  const before = inspect();
  const expectedGrants = cut.startsWith('instance-register') || cut === 'run-admit-before-commit' ? 0 : 1;
  assert.equal(Object.keys(before.runGrantsV2 ?? {}).length, expectedGrants);
  assert.equal(Object.keys(before.runReceiptsV2 ?? {}).length, cut === 'run-read-after-commit' ? 1 : 0);
  doc = await launch('./agent-instance-doc-child.mjs', [dir, 'none']); children.push(doc);
  await agent.call({ kind: 'setPort', port: doc.ready.port });
  const registration = await register(); assert.equal(registration.status, 200); assert.equal(registration.duplicateSame, true);
  const recovered = await admit(); assert.equal(recovered.status, 200);
  if (grant) assert.equal(recovered.result.runGrantId, grant.runGrantId); grant = recovered.result;
  if (!intent) intent = await agent.call({ kind: 'prepare', grant });
  const confirmed = await agent.call({ kind: 'confirm', readIntentId: intent.readIntentId }); assert.equal(confirmed.state, 'confirmed');
  const after = inspect(); assert.equal(Object.keys(after.runGrantsV2).length, 1); assert.equal(Object.keys(after.runReceiptsV2).length, 1);
  assert.equal(grant.instanceId, registration.registration.instanceId);
  if (cut === 'run-read-after-commit') assert.deepEqual(Object.keys(after.runReceiptsV2), Object.keys(before.runReceiptsV2));
  assert.equal(fs.existsSync(path.join(dir, 'external-effects.ndjson')), false);
  t.diagnostic('Doc exited and closed with 73; Agent process stayed alive, key stayed in RAM; no model/tool execution was requested.');
});
