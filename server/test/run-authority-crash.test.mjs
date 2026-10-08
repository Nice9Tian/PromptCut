import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runFixture, projectId } from './run-authority-fixture.mjs';

const childFile = fileURLToPath(new URL('./run-authority-child.mjs', import.meta.url));
const cuts = ['run-admit-before-commit', 'run-admit-after-commit', 'read-intent-before-commit', 'read-intent-after-commit',
  'run-read-before-commit', 'run-read-after-commit', 'read-confirmation-before-commit', 'read-confirmation-after-commit',
  'read-execution-before-commit', 'read-execution-after-commit', 'external-effect-after-fsync',
  'read-finished-before-commit', 'read-finished-after-commit', 'run-fence-before-commit', 'run-fence-after-commit',
  'credential-event-after-commit', 'credential-retained-after-commit', 'private-after-retained-commit', 'agent-off-on-after-commit'];

test('actual SQLite child process crashes preserve doc read and Agent intent without replaying an uncertain external effect', async t => {
  for (const cut of cuts) await t.test(cut, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-run-crash-'));
    let f = await runFixture({ dir }); f.enqueue(); f.close();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [childFile, dir, cut], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const timeout = setTimeout(() => child.kill(), 15000);
      let output = '', exit = null;
      child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
      child.once('error', reject); child.once('exit', code => { exit = code; });
      child.once('close', code => { clearTimeout(timeout); resolve({ code, exit, output }); });
    });
    assert.equal(result.code, 73, result.output); assert.equal(result.exit, 73);
    f = await runFixture({ dir });
    try {
      assert.equal(f.ledger.inspect().integrity, 'ok'); assert.equal(f.intents.inspect().integrity, 'ok');
      const state = f.ledger.read(), grants = Object.values(state.runGrantsV2 ?? {});
      if (cut === 'run-admit-before-commit') {
        assert.equal(grants.length, 0); assert.equal(state.conversationsV2[projectId].conversation_fixture.currentRunId, null);
      } else {
        assert.equal(grants.length, 1);
        const readCommitted = !['run-admit-after-commit', 'read-intent-before-commit', 'read-intent-after-commit', 'run-read-before-commit'].includes(cut);
        assert.equal(Object.keys(state.runReceiptsV2).length, readCommitted ? 1 : 0);
      }
      const effectsFile = path.join(dir, 'external-effects.ndjson');
      const effects = fs.existsSync(effectsFile) ? fs.readFileSync(effectsFile, 'utf8').trim().split('\n') : [];
      const effectCommitted = ['external-effect-after-fsync', 'read-finished-before-commit', 'read-finished-after-commit'].includes(cut);
      assert.equal(effects.length, effectCommitted ? 1 : 0);
      const pending = f.intents.pending();
      if (['credential-event-after-commit', 'credential-retained-after-commit'].includes(cut)) {
        // Both doc and the original Agent died. This new OS/RAM key cannot adopt
        // even an eligible retained run; the persisted read remains audit evidence.
        await assert.rejects(f.principal(grants[0]), { status: 403, code: 'run-instance-mismatch' });
        assert.ok(grants[0].readReceiptId);
      }
      if (['run-fence-after-commit', 'private-after-retained-commit', 'agent-off-on-after-commit'].includes(cut)) {
        assert.equal(grants[0].state, 'revoked');
        await assert.rejects(f.principal(grants[0]), { status: 403, code: 'run-instance-mismatch' });
      }
      if (['read-execution-after-commit', 'external-effect-after-fsync', 'read-finished-before-commit'].includes(cut)) {
        assert.equal(pending[0].state, 'execution-started');
        await assert.rejects(f.intents.executeOnce(pending[0].readIntentId, { authorize: async () => ({ allowed: true }),
          execute: async () => { throw new Error('must never replay'); } }), /not-confirmed/);
      }
      if (['run-read-after-commit', 'read-confirmation-before-commit'].includes(cut)) {
        const before = Object.keys(f.ledger.read().runReceiptsV2);
        await assert.rejects(f.intents.confirm(pending[0].readIntentId, f.transport), /read-confirmation-unknown/);
        await assert.rejects(f.provider.queryRead({ ...f.input({ ...grants[0], message: state.conversationsV2[projectId].conversation_fixture.messages[0] }),
          readIntentId: pending[0].readIntentId }), { status: 403, code: 'run-instance-mismatch' });
        assert.deepEqual(Object.keys(f.ledger.read().runReceiptsV2), before);
      }
      // Restart itself performed zero external actions; the file must remain exact.
      assert.equal(fs.existsSync(effectsFile) ? fs.readFileSync(effectsFile, 'utf8').trim().split('\n').length : 0, effects.length);
    } finally { f.close(); fs.rmSync(dir, { recursive: true }); }
  });
});
