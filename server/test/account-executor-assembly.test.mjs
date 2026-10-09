import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';

test('account executor assembly rejects incomplete configuration before registration or listening', async () => {
  const { createAccountExecutorAssembly } = await import('../agent-service/account-executor-assembly.mjs');
  let registered = 0;
  await assert.rejects(createAccountExecutorAssembly({ runClient: { registerInstance() { registered++; } } }),
    { code: 'account-executor-configuration', status: 503 });
  assert.equal(registered, 0);
});

test('actual account CLI rejects missing or shared control port before registration and business listening', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-executor-cli-config-'));
  try {
    const pki = assetWiringPki(dir);
    for (const field of ['key', 'cert', 'ca']) fs.writeFileSync(path.join(dir, field), pki.asset[field]);
    const env = { ...process.env, PROMPTCUT_AGENT_DATA: dir, PROMPTCUT_AGENT_DOC_URL: 'wss://127.0.0.1:6640/',
      PROMPTCUT_AGENT_PORT: '6641', PROMPTCUT_ACCOUNT_V2: '1', PROMPTCUT_ACCOUNT_V2_REQUIRED: '1',
      PROMPTCUT_AGENT_DOC_INTERNAL_ORIGIN: 'https://127.0.0.1:6640', PROMPTCUT_AGENT_DOC_FINGERPRINT256: pki.doc.fingerprint256,
      PROMPTCUT_AGENT_CLIENT_KEY_FILE: path.join(dir, 'key'), PROMPTCUT_AGENT_CLIENT_CERT_FILE: path.join(dir, 'cert'),
      PROMPTCUT_AGENT_CA_FILE: path.join(dir, 'ca') };
    delete env.PROMPTCUT_AGENT_CONTROL_PORT;
    for (const port of [undefined, '6641']) {
      if (port !== undefined) env.PROMPTCUT_AGENT_CONTROL_PORT = port;
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../agent-service/main.mjs', import.meta.url))],
        { env, windowsHide: true, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 1); assert.match(result.stdout, /"reason":"account-v2"/);
      assert.doesNotMatch(result.stdout, /agent\.ready|agent\.listen|agent\.instance\.registered/);
    }
    assert.equal(fs.existsSync(path.join(dir, 'run-read-intents.sqlite')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
