import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stageHostedAssetFiles } from '../hosted/files.mjs';

test('独立asset精确stage不借node_modules：真实导入读口和无配置入口failclosed', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-stage-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'app'); stageHostedAssetFiles(path.resolve('.'), out);
  const run = args => new Promise(resolve => { const child = spawn(process.execPath, args, { cwd: out, windowsHide: true, env: { ...process.env,
    PROMPTCUT_ASSET_DATA_DIR: '', PROMPTCUT_ASSET_CLIENT_KEY_FILE: '', PROMPTCUT_ASSET_DOC_CA_FILE: '' } });
    let text = ''; child.stdout.on('data', b => { text += b; }); child.stderr.on('data', b => { text += b; }); child.once('close', code => resolve({ code, text })); });
  const imported = await run(['--input-type=module', '-e', "await import('./server/hosted/asset-runtime.mjs'); const { registerTsResolve } = await import('./server/hosted/ts-resolve.mjs'); registerTsResolve(); await Promise.all([import('./server/asset-service.ts'), import('./server/vite-plugin-media.ts'), import('./server/asset-store/shots-thumb.mjs')])"]);
  assert.equal(imported.code, 0, imported.text);
  const absent = await run(['server/hosted/asset-main.mjs']); assert.equal(absent.code, 1, absent.text); assert.match(absent.text, /asset.config-error/);
});
