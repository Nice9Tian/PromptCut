import '../lib/no-user-dirs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publicOptions, projectFromVisibleLink, resourceMetadata, testIdentities } from './lib/account-public-path.mjs';

test('public writes require an explicit flag and private native arguments never change the public host', () => {
  assert.equal(publicOptions([]).run, false);
  assert.equal(publicOptions(['--dry-preflight']).run, false);
  assert.equal(publicOptions(['--run-public']).run, true);
  for (const args of [['--origin', 'https://evil'], ['--password', 'secret'], ['--run-public', '--dry-preflight'], ['--out', os.tmpdir()], ['--desktop-exe', 'C:/installed.exe']]) assert.throws(() => publicOptions(args));
  const options = publicOptions(['--desktop-exe', path.join(os.tmpdir(), 'isolated-public-build', 'promptcut.exe'), '--desktop-profile-root', path.join(os.tmpdir(), 'isolated-public-profile'), '--desktop-sha256', 'a'.repeat(64), '--desktop-source-root', path.join(os.tmpdir(), 'isolated-public-source')]);
  assert.equal(options.run, false); assert.equal(options.sha, 'a'.repeat(64));
});
test('resource diagnostics discard query/header secrets and visible link has a strict real public project shape', () => {
  const meta = resourceMetadata('https://visuhive.com/editor/assets/main.js?ticket=never-log', 'script', 200, 'text/javascript');
  assert.deepEqual(meta, { path:'/editor/assets/main.js', type:'script', status:200, mime:'text/javascript' });
  assert.ok(!JSON.stringify(meta).includes('never-log'));
  assert.equal(resourceMetadata('https://evil/editor/x', 'script', 200, 'text/javascript'), null);
  assert.equal(resourceMetadata('https://visuhive.com/api/account/me?secret=x', 'fetch', 200, 'application/json'), null);
  assert.equal(projectFromVisibleLink(`项目链接：https://visuhive.com/editor?project=sp_${'a'.repeat(26)}`).projectId, `sp_${'a'.repeat(26)}`);
  assert.throws(() => projectFromVisibleLink(`https://evil/editor?project=sp_${'a'.repeat(26)}`));
  const identities = testIdentities(); assert.ok(identities.accounts.every(a => a.name.startsWith(identities.marker) && a.password.length >= 32));
  assert.notEqual(identities.accounts[0].password, identities.accounts[1].password);
});
test('actual Rust isolation functions and their own assertions compile and reject public/native boundary deviations', async () => {
  const rust = await fs.readFile(new URL('../../desktop/src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const extract = name => { const value = new RegExp(`^fn ${name}\\([\\s\\S]*?^}`, 'm').exec(rust)?.[0]; assert.ok(value); return value; };
  const ownTest = /^    fn account_probe_binding_is_identifier_and_port_scoped\(\)[\s\S]*?^    }/m.exec(rust)?.[0]; assert.ok(ownTest);
  const constant = /^const EDITOR_PORT: u16 = [0-9]+;/m.exec(rust)?.[0]; assert.ok(constant);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-account-public-rust-'));
  try {
    const source = path.join(dir, 'binding.rs'), binary = path.join(dir, process.platform === 'win32' ? 'binding.exe' : 'binding');
    await fs.writeFile(source, `${constant}\n${extract('account_editor_port')}\n${extract('account_cloud_binding')}\n#[test]\n${ownTest}\n`);
    const compiled = spawnSync('rustc', ['--edition=2021', '--test', source, '-o', binary], { windowsHide:true, encoding:'utf8', timeout:60_000 });
    assert.equal(compiled.error, undefined); assert.equal(compiled.status, 0, compiled.stderr);
    const checked = spawnSync(binary, [], { windowsHide:true, encoding:'utf8', timeout:10_000 });
    assert.equal(checked.error, undefined); assert.equal(checked.status, 0, checked.stdout);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await fs.rm(dir, { recursive:true, force:true });
  }
});

test('actual default/dry CLI stops before browser, public network or account creation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-account-public-dry-'));
  try {
    const out = path.join(dir, 'out');
    const checked = spawnSync(process.execPath, [fileURLToPath(new URL('./account-public-user-pages-probe.mjs', import.meta.url)), '--dry-preflight', '--out', out], {
      windowsHide:true, encoding:'utf8', timeout:10_000,
    });
    assert.equal(checked.error, undefined); assert.equal(checked.status, 0, checked.stderr);
    const result = JSON.parse(await fs.readFile(path.join(out, 'result.json'), 'utf8'));
    assert.equal(result.summary.mode, 'dry-preflight'); assert.equal(result.summary.completed, false);
    assert.equal(result.summary.dryPreflightPassed, true); assert.equal(result.cleanup.browser, 'not-started');
    assert.deepEqual(result.network, []); assert.deepEqual(result.websocket, []); assert.deepEqual(result.screenshots, []);
    assert.equal(result.accountNames, undefined); assert.equal(result.ownedProjects, undefined);
    assert.equal(result.preflight.publicNetwork, 'not-contacted');
  } finally { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await fs.rm(dir, { recursive:true, force:true }); }
});
