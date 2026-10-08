import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExistingHostedRunnerFactory } from '../agent/service/account-runner.mjs';

test('an abort during model configuration settles before configuration returns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-runner-early-abort-'));
  let releaseConfig;
  const blockedConfig = new Promise(resolve => { releaseConfig = resolve; });
  const controller = new AbortController();
  const factory = createExistingHostedRunnerFactory({ root: process.cwd(), loadModule: async () => ({}),
    dataDir: dir, dataClient: { wsUrl: 'wss://fixture.invalid/', webSocketFor() { throw Error('no-socket-expected'); },
      openCount: () => 0 }, modelConfig: () => blockedConfig });
  try {
    const run = factory({ grant: { projectId: 'sp_fixture', conversationId: 'conversation_fixture',
      runId: 'run_fixture', messageId: 'message_fixture' },
    record: { messageId: 'message_fixture', runId: 'run_fixture' }, signal: controller.signal });
    controller.abort();
    const result = await Promise.race([run.then(() => 'unexpected-success', error => error.code),
      new Promise(resolve => setTimeout(() => resolve('still-pending'), 250))]);
    assert.equal(result, 'run-fenced');
    releaseConfig({ vendor: 'mock', model: 'mock' });
    await assert.rejects(run, /run-fenced/);
  } finally { releaseConfig({ vendor: 'mock', model: 'mock' }); fs.rmSync(dir, { recursive: true, force: true }); }
});
