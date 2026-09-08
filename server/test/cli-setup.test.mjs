import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { resolveCli, cliCommand, cliEnv } from '../runners/cli-runtime.mjs';
import { createSetupService, authUrlFrom } from '../runners/setup.mjs';
import { probeAuth } from '../runners/auth.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-cli-test-'));
const previousRoot = process.env.PROMPTCUT_CLI_HOME;
process.env.PROMPTCUT_CLI_HOME = path.join(root, '中文 user & space');
test.after(() => {
  if (previousRoot === undefined) delete process.env.PROMPTCUT_CLI_HOME;
  else process.env.PROMPTCUT_CLI_HOME = previousRoot;
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('promptcut-cli-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); } assert.fail('timed out'); }
function fakeService(options = {}) {
  const calls = [];
  const service = createSetupService({
    launch(command, args, opts) {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null)); };
      calls.push({ command, args, opts, child });
      return child;
    },
    verifyInstall: async () => {}, verifyVersion: async () => {},
    verifyAuth: async () => ({ loggedIn: true }), ...options,
  });
  return { service, calls };
}

test('finds a newly installed executable without PATH or cached misses', () => {
  const home = path.join(root, 'another 用户');
  const opts = { home, env: {}, root: path.join(root, 'managed'), platform: 'win32', lookup() { throw new Error('no PATH'); } };
  assert.equal(resolveCli('claude', opts), 'claude');
  const exe = path.join(home, '.local', 'bin', 'claude.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, '');
  assert.equal(resolveCli('claude', opts), exe);
});

test('does not mistake Codex Desktop internal runtime for an installed CLI', () => {
  const local = path.join(root, 'LocalAppData');
  const desktop = path.join(local, 'OpenAI', 'Codex', 'bin', 'internal', 'codex.exe');
  fs.mkdirSync(path.dirname(desktop), { recursive: true }); fs.writeFileSync(desktop, '');
  const result = resolveCli('codex', {
    env: { LOCALAPPDATA: local }, home: path.join(root, 'home'), root: path.join(root, 'managed-missing'), platform: 'win32',
    lookup: () => desktop,
  });
  assert.equal(result, 'codex');
});

test('npm shim uses bundled Node and preserves JSON and shell metacharacters', () => {
  const bin = path.join(root, 'npm 中文 & spaced');
  const pkg = path.join(bin, 'node_modules', '@openai', 'codex');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { codex: 'cli.cjs' } }));
  fs.writeFileSync(path.join(pkg, 'cli.cjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  const args = ['a & b', '配置文件', '{"path":"C:\\space here","value":"$HOME"}', 'a"b', 'line\nbreak'];
  const cmd = cliCommand(path.join(bin, 'codex.cmd'), args, 'win32');
  assert.equal(cmd.command, process.execPath);
  assert.deepEqual(JSON.parse(execFileSync(cmd.command, cmd.args, { encoding: 'utf8' })), args);
});

test('Codex home is created and inherited PowerShell module paths are removed', () => {
  const env = cliEnv('codex', { CODEX_HOME: 'unrelated desktop', PSModulePath: 'powershell7', Path: 'custom' });
  assert.notEqual(env.CODEX_HOME, 'unrelated desktop');
  assert.ok(fs.existsSync(env.CODEX_HOME));
  assert.equal(env.PSModulePath, undefined);
  assert.ok(env.Path.endsWith('custom'));
});

test('deduplicates clicks and tracks providers independently', async () => {
  const { service, calls } = fakeService();
  const first = service.start('codex', 'install');
  assert.equal(service.start('codex', 'login').id, first.id);
  service.start('agy', 'install');
  assert.equal(calls.length, 2);
  calls[0].child.emit('close', 0);
  await until(() => service.list()[0].state === 'succeeded');
  assert.equal(service.list()[1].state, 'running');
  service.dispose(); await tick();
});

test('spawn error is reported, and retry creates a fresh job', async () => {
  const { service, calls } = fakeService();
  const first = service.start('codex', 'install');
  calls[0].child.emit('error', new Error('ENOENT'));
  await until(() => service.list()[0].state === 'failed');
  assert.match(service.list()[0].message, /ENOENT/);
  assert.notEqual(service.start('codex', 'install').id, first.id);
  service.dispose(); await tick();
});

test('exit zero is insufficient without successful binary verification', async () => {
  const { service, calls } = fakeService({ verifyInstall: async () => { throw new Error('binary missing'); } });
  service.start('agy', 'install'); calls[0].child.emit('close', 0);
  await until(() => service.list()[0].state === 'failed');
  assert.match(service.list()[0].message, /binary missing/);
});

test('login URL survives split chunks; raw output is never returned', async () => {
  const { service, calls } = fakeService();
  service.start('codex', 'login'); await until(() => calls.length === 1);
  calls[0].child.stderr.write('secret-token-value\nhttps://auth.');
  calls[0].child.stderr.write('openai.com/oauth/authorize?state=example\n');
  assert.equal(service.list()[0].url, 'https://auth.openai.com/oauth/authorize?state=example');
  assert.ok(!JSON.stringify(service.list()).includes('secret-token-value'));
  calls[0].child.emit('close', 0);
  await until(() => service.list()[0].state === 'succeeded');
  assert.equal(service.list()[0].url, undefined);
});

test('login is not marked successful without verified authentication', async () => {
  const { service, calls } = fakeService({ verifyAuth: async () => ({ loggedIn: false }) });
  service.start('claude', 'login'); await until(() => calls.length === 1);
  calls[0].child.emit('close', 0);
  await until(() => service.list()[0].state === 'failed');
});

test('Antigravity login uses a hidden ConPTY helper, never a visible shell', async () => {
  const { service, calls } = fakeService();
  service.start('agy', 'login'); await until(() => calls.length === 1);
  assert.equal(calls[0].command, process.execPath);
  assert.ok(calls[0].args[0].endsWith('agy-login.mjs'));
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.detached, undefined);
  calls[0].child.emit('close', 0);
  await until(() => service.list()[0].state === 'succeeded');
});

test('timeout stops the child and makes the operation retryable', async () => {
  const { service, calls } = fakeService({ timeoutMs: 30 });
  service.start('agy', 'install');
  await until(() => service.list()[0].state === 'failed');
  assert.equal(calls[0].child.killed, true);
  assert.match(service.list()[0].message, /超时/);
});

test('cancel waits for child exit before allowing retry', async () => {
  const { service, calls } = fakeService();
  const first = service.start('codex', 'install'); service.cancel('codex');
  assert.equal(service.start('codex', 'install').id, first.id);
  await until(() => service.list()[0].state === 'failed');
  assert.equal(calls[0].child.killed, true);
});

test('rejects arbitrary providers and untrusted login URL hosts', () => {
  const { service } = fakeService();
  assert.throws(() => service.start('__proto__', 'install'));
  assert.throws(() => service.start('codex & whoami', 'login'));
  assert.equal(authUrlFrom('https://auth.openai.com.attacker.test/login', 'codex'), undefined);
  assert.equal(authUrlFrom('https://user:pass@auth.openai.com/login', 'codex'), undefined);
});

test('Codex auth accepts status on stderr (actual child process)', { skip: process.platform !== 'win32' }, async () => {
  const appdata = path.join(root, 'roaming');
  const bin = path.join(appdata, 'npm'); const pkg = path.join(bin, 'node_modules', '@openai', 'codex');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off');
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { codex: 'cli.cjs' } }));
  fs.writeFileSync(path.join(pkg, 'cli.cjs'), 'console.error("Logged in using ChatGPT")');
  const before = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.APPDATA = appdata; process.env.LOCALAPPDATA = path.join(root, 'local');
  try { assert.equal((await probeAuth('codex', { refresh: true })).loggedIn, true); }
  finally { for (const [k,v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test('Codex Desktop under Programs\ is excluded too, not just the where.exe hit', () => {
  // 这条路径曾经写在候选表里、当作合法 CLI 直接返回,而排除只写在 where.exe 那一支 ——
  // 候选表命中就 return,那道排除对它永远跑不到。
  const local = path.join(root, 'LocalAppData-programs');
  const desktop = path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  fs.mkdirSync(path.dirname(desktop), { recursive: true }); fs.writeFileSync(desktop, '');
  const result = resolveCli('codex', {
    env: { LOCALAPPDATA: local }, home: path.join(root, 'home'), root: path.join(root, 'managed-missing'), platform: 'win32',
    lookup: () => desktop,
  });
  assert.equal(result, 'codex');
});
