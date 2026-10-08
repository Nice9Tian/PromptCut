import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { stageHostedFiles } from '../hosted/files.mjs';

test('isolated hosted stage imports actual instance consumer without repository dependency lookup', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-instance-doc-deploy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const copied = stageHostedFiles(path.resolve('.'), dir);
  for (const file of ['server/account/agent-instance-internal.mjs', 'server/account/agent-instance-authority.mjs',
    'server/account/run-internal.mjs', 'server/hosted/doc-agent-assembly.mjs'])
    assert.ok(copied.includes(path.join(dir, file)), file);
  const url = pathToFileURL(path.join(dir, 'server/hosted/doc-agent-assembly.mjs')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `const m=await import(${JSON.stringify(url)}); if(typeof m.createDocAgentAssembly!=='function')process.exitCode=1;`],
    { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, output); t.diagnostic(`staged files=${copied.length}; actual child close observed`);
});
