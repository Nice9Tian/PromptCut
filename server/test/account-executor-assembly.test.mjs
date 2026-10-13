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

// 账号版的命令行入口只装配「只做控制的主服务」（任务在任务进程里跑）。配置不齐、或者还带着在主进程里跑任务那一路的变量，
// 都在登记和监听之前拒绝，并说清缺的是哪一样——不留「能发消息、但任务停不了、第二条接不上」的半通状态。
test('actual account CLI rejects incomplete or legacy task-process configuration before registration and business listening', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-executor-cli-config-'));
  try {
    const pki = assetWiringPki(dir);
    for (const field of ['key', 'cert', 'ca']) fs.writeFileSync(path.join(dir, field), pki.asset[field]);
    const base = { ...process.env, PROMPTCUT_AGENT_DATA: dir, PROMPTCUT_AGENT_DOC_URL: 'wss://127.0.0.1:6640/',
      PROMPTCUT_AGENT_PORT: '6641', PROMPTCUT_ACCOUNT_V2: '1', PROMPTCUT_ACCOUNT_V2_REQUIRED: '1',
      PROMPTCUT_AGENT_DOC_INTERNAL_ORIGIN: 'https://127.0.0.1:6640', PROMPTCUT_AGENT_DOC_FINGERPRINT256: pki.doc.fingerprint256,
      PROMPTCUT_AGENT_CLIENT_KEY_FILE: path.join(dir, 'key'), PROMPTCUT_AGENT_CLIENT_CERT_FILE: path.join(dir, 'cert'),
      PROMPTCUT_AGENT_CA_FILE: path.join(dir, 'ca') };
    for (const name of ['PROMPTCUT_AGENT_CONTROL_PORT', 'PROMPTCUT_AGENT_INTERNAL_PORT', 'PROMPTCUT_AGENT_ROOT_FINGERPRINT256', 'PROMPTCUT_AGENT_SHARED_DATA',
      'PROMPTCUT_AGENT_ACCOUNT_LOOK', 'PROMPTCUT_AGENT_RUN_ASSET_ORIGIN', 'PROMPTCUT_AGENT_RUN_ASSET_FINGERPRINT256']) delete base[name];
    const complete = { PROMPTCUT_AGENT_INTERNAL_PORT: '6642', PROMPTCUT_AGENT_ROOT_FINGERPRINT256: pki.account.fingerprint256, PROMPTCUT_AGENT_SHARED_DATA: dir };
    const cases = [
      [{}, /"missing":\["PROMPTCUT_AGENT_INTERNAL_PORT","PROMPTCUT_AGENT_ROOT_FINGERPRINT256","PROMPTCUT_AGENT_SHARED_DATA"\]/],
      [{ ...complete, PROMPTCUT_AGENT_SHARED_DATA: undefined }, /"missing":\["PROMPTCUT_AGENT_SHARED_DATA"\]/],
      // 公开口和内部口是同一个
      [{ ...complete, PROMPTCUT_AGENT_INTERNAL_PORT: '6641' }, /PROMPTCUT_AGENT_INTERNAL_PORT/],
      [{ ...complete, PROMPTCUT_AGENT_ROOT_FINGERPRINT256: 'not-a-fingerprint' }, /PROMPTCUT_AGENT_ROOT_FINGERPRINT256/],
      [{ ...complete, PROMPTCUT_AGENT_SHARED_DATA: path.join(dir, 'no-such-dir') }, /PROMPTCUT_AGENT_SHARED_DATA/],
      // 在主进程里跑任务那一路的变量
      [{ ...complete, PROMPTCUT_AGENT_CONTROL_PORT: '6643' }, /"legacy":\["PROMPTCUT_AGENT_CONTROL_PORT"\]/],
      [{ ...complete, PROMPTCUT_AGENT_ACCOUNT_LOOK: '1' }, /"legacy":\["PROMPTCUT_AGENT_ACCOUNT_LOOK"\]/],
      [{ ...complete, PROMPTCUT_AGENT_RUN_ASSET_ORIGIN: 'https://127.0.0.1:6644/' }, /"legacy":\["PROMPTCUT_AGENT_RUN_ASSET_ORIGIN"\]/],
    ];
    for (const [extra, expected] of cases) {
      const env = { ...base, ...extra };
      for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../agent-service/main.mjs', import.meta.url))],
        { env, windowsHide: true, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 1); assert.match(result.stdout, /"reason":"account-task-processes"/); assert.match(result.stdout, expected);
      assert.doesNotMatch(result.stdout, /agent\.ready|agent\.listen|agent\.instance\.registered|agent\.master\.registered/);
    }
    assert.equal(fs.existsSync(path.join(dir, 'run-read-intents.sqlite')), false);
    assert.equal(fs.existsSync(path.join(dir, 'master-run-events.sqlite')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
