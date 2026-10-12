import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stageHostedAssetFiles } from '../hosted/files.mjs';

test('independent asset stage imports the private metadata closure without resolving to the repo', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-run-asset-stage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'app');
  const copied = stageHostedAssetFiles(path.resolve('.'), app);
  for (const file of ['server/hosted/run-assets-metadata.mjs', 'server/hosted/run-assets-metadata-rpc.mjs',
    'server/account/run-asset-protocol.mjs', 'server/account/ledger.mjs'])
    assert.ok(copied.includes(path.join(app, file)));
  const module = await import(pathToFileURL(path.join(app, 'server/hosted/asset-runtime.mjs')).href);
  assert.equal(typeof module.startHostedAssetService, 'function');
});
