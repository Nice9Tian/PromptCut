import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { operationFixture } from './operation-wiring-fixture.mjs';
import { ask } from './fake-docservice-env.mjs';
import { stateBlobName } from '../docservice/modules/project.mjs';

const cases = [
  ['history:prepared-before-commit', 1], ['doc:prepared-after-commit', 1],
  ['account:reserve-before-commit', 1], ['account:reserve-after-commit', 1],
  ['history:reserved-before-commit', 1], ['doc:reserved-after-commit', 1], ['doc:before-seal', 1],
  ['account:seal-after-sequence', 1], ['account:seal-before-commit', 1],
  ['account:seal-after-commit', 2], ['doc:seal-ack', 2], ['history:accepted-before-commit', 2],
  ['doc:accepted-after-commit', 2], ['history:materialize-before-commit', 2], ['doc:materialize-after-commit', 2],
  ['projection:projection-before-write', 2], ['projection:projection-after-rename', 2],
  ['projection:projection-after-sync', 2], ['projection:projection-after-readback', 2],
  ['history:fence-request-before-commit', 2], ['doc:fence-request-after-commit', 2],
  ['history:fence-before-commit', 2], ['doc:fence-after-commit', 2],
  ['history:fence-ack-before-commit', 2], ['doc:fence-ack-after-commit', 2],
];
test('operation-wiring real WS subprocess crashes recover original store from exact accepted prepared', {
  skip: !process.env.PROMPTCUT_ACCOUNT_PROVIDER_ROOT && 'Explicit actual provider required', timeout: 180000,
}, async t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-operation-crash-'));
  for (const [phase, rev] of cases) await t.test(phase, async st => {
    const dir = fs.mkdtempSync(path.join(out, 'cut-'));
    const child = spawn(process.execPath, [fileURLToPath(new URL('./operation-wiring-child.mjs', import.meta.url)), dir, phase], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = []; child.stdout.on('data', b => output.push(b)); child.stderr.on('data', b => output.push(b));
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 30000);
    st.after(async () => { clearTimeout(timer); if (child.exitCode === null) child.kill(); await closed; });
    const result = await closed; clearTimeout(timer);
    fs.writeFileSync(path.join(dir, 'child.log'), Buffer.concat(output));
    assert.equal(result.code, 73, `${phase}: actual abrupt exit not reached (see ${path.join(dir, 'child.log')})`);
    const f = await operationFixture({ dir, port: 5761 });
    try {
      const b = await f.connect('b');
      const hasFence = phase.includes('fence-') && phase !== 'history:fence-request-before-commit';
      if (hasFence) await f.coordinator.recover(f.projectId);
      const opened = hasFence ? { type: 'project.state', rev: f.project.revOf(f.projectId), project: f.project.bodyOf(f.projectId) }
        : await ask(b, { type: 'project.open', projectId: f.projectId }, 10000);
      assert.equal(opened.type, 'project.state', opened.reason); assert.equal(opened.rev, rev);
      assert.equal(opened.project.title, rev === 2 ? 'complete tool result' : 'before');
      assert.equal(f.history.pending(f.projectId).length, 0);
      assert.equal(f.history.accepted(f.projectId).length, rev - 1);
      const disk = JSON.parse(f.store.readBlob(stateBlobName(f.projectId)));
      assert.equal(disk.rev, rev); assert.deepEqual(disk.project, opened.project);
      assert.equal(fs.readFileSync(path.join(dir, 'external-effects.ndjson'), 'utf8').trim().split('\n').length, 1);
      if (hasFence) {
        const c = await f.connect();
        const refused = await ask(c, { type: 'project.op', projectId: f.projectId, opId: 'after-fence', ops: [{ op: 'set', path: '/title', value: 'revive' }] }, 10000);
        assert.equal(refused.reason, 'operation-fenced');
      }
      if (rev === 2) {
        const accepted = f.history.accepted(f.projectId)[0];
        assert.equal(accepted.before.title, 'before'); assert.equal(accepted.after.title, 'complete tool result');
        assert.equal(disk.orderProjection.preparedDigest, accepted.preparedDigest);
        assert.deepEqual(disk.history.at(-1).actor, accepted.actor);
      }
      console.log(JSON.stringify({ proof: 'project-op-crash', phase, exit: result.code, close: true, rev, effects: 1, dir }));
    } finally { await f.close(); }
  });
});
