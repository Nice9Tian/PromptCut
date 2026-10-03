/** Full required baseline against an isolated editor; owns and cleans up only its children. */
import '../lib/no-user-dirs.mjs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitFor } from '../../server/test/fake-ws-kit.mjs';
const require = createRequire(import.meta.url), root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reopen-baseline-'));
const port = Number(process.env.PC_REOPEN_BASELINE_PORT || 5212);
const env = { ...process.env, PROMPTCUT_DATA_DIR: path.join(root, 'data'), PROMPTCUT_EXPORT_DIR: path.join(root, 'export'), PROMPTCUT_PROJECTS_DIR: path.join(root, 'projects'), PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_AUTO_RENDER_NODE: '0', PROMPTCUT_PUSH: '0', PC_STAGE_TEST_URL: `http://127.0.0.1:${port}` };
const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
let editor;
async function run(args, file) {
  const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { out += b; });
  const code = await new Promise(r => child.once('exit', r));
  const safe = out.replace(/[A-Za-z0-9_-]{43,}/g, '[redacted-long-value]'); fs.writeFileSync(file, safe);
  const counts = safe.split(/\r?\n/).filter(l => /^ℹ (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)/.test(l));
  console.log(JSON.stringify({ command: args[0].includes('tsc') ? 'npx tsc -b --force' : 'npm test', code, evidence: path.resolve(file), counts }));
  return code;
}
try {
  const types = await run([require.resolve('typescript/bin/tsc'), '-b', '--force'], '.final-types.log');
  editor = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); editor.stdout.resume(); editor.stderr.resume();
  await waitFor(async () => { if (editor.exitCode !== null) throw new Error('isolated baseline editor failed'); try { return (await fetch(`${env.PC_STAGE_TEST_URL}/api/docservice/device`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, 30000, 'isolated baseline editor');
  const tests = await run(['--experimental-test-module-mocks', '--test-global-setup=server/test/global-setup.mjs', '--test', 'server/test/*.test.mjs', 'src/**/*.test.mjs', 'tools/report-worker/*.test.mjs'], '.final-tests.log');
  process.exitCode = types || tests;
} finally {
  if (editor?.exitCode === null) { const exited = new Promise(r => editor.once('exit', r)); editor.kill(); await exited; }
}
