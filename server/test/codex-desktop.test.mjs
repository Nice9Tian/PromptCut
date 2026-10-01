/**
 * Codex 桌面版那条路(app-server --stdio)的单测。
 *
 * 跑法 —— **必须带这个 flag**:
 *   node --experimental-test-module-mocks --test server/test/codex-desktop.test.mjs
 *
 * `mock.module` 在 Node 里还是实验特性,不带 flag 时它压根不存在,报的是
 * 「mock.module is not a function」,看上去像用例挂了,其实是没开开关。
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * 与本机装了哪种 codex 无关:createCodexTask 取 `PROMPTCUT_CODEX_EXE || resolveCli('codex')`,
 * 后者会去查本机的 PATH、npm 全局目录(装 npm 版 codex 时会走 node + codex.js),结果因机器而异。
 * 所以每个用例都显式设 PROMPTCUT_CODEX_EXE(见 withCodexExe),resolveCli 不会被调用;
 * cliCommand 只对 win32 上的 .cmd/.bat 才读文件,假的 .exe 路径原样返回,不要求文件存在。
 */
const IS_WIN = process.platform === 'win32';
const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-codex-desktop-'));
const fakeExe = path.join(fakeRoot, IS_WIN ? 'codex.exe' : 'codex');

/** 临时设 PROMPTCUT_CODEX_EXE,跑完(无论成败)恢复原值,不影响同进程里的其它用例 */
async function withCodexExe(exe, fn) {
  const had = Object.hasOwn(process.env, 'PROMPTCUT_CODEX_EXE');
  const old = process.env.PROMPTCUT_CODEX_EXE;
  process.env.PROMPTCUT_CODEX_EXE = exe;
  try { return await fn(); }
  finally { if (had) process.env.PROMPTCUT_CODEX_EXE = old; else delete process.env.PROMPTCUT_CODEX_EXE; }
}

let scenario;
/** 每次 spawn 的 { command, args, options },用例里据此断言怎么起的 */
let spawns = [];
mock.module('node:child_process', { exports: { execFileSync, spawn: (command, args, options) => {
  spawns.push({ command, args, options });
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.stdout.end(); child.stderr.end(); };
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(chunk.toString());
    queueMicrotask(() => {
      if (request.id == null) return;
      scenario.calls.push(request.method);
      const emit = value => child.stdout.write(JSON.stringify(value) + '\n');
      let result = {};
      if (request.method === 'thread/start' && scenario.unsupported) return emit({ id: request.id, error: { message: 'unknown field projectId' } });
      if (request.method === 'thread/start' || request.method === 'thread/read') {
        result = { thread: { id: 'thread', cwd: options.cwd, projectId: scenario.mismatch ? 'wrong' : null } };
      }
      emit({ id: request.id, result });
      if (request.method === 'turn/start') {
        emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: scenario.turnFailed ? 'failed' : 'completed', error: { message: 'model unavailable' } } } });
      }
    });
    done();
  } });
  return child;
} } });
const { createCodexTask } = await import('../codex-desktop.ts');
const dir = path.resolve('task with spaces');

/** 原 mock 里的断言:app-server 以 stdio 方式起、隐藏窗口、不 detached */
function assertSpawnedAppServer(spawn, expectedArgs = ['app-server', '--stdio'], expectedCommand = fakeExe) {
  assert.equal(spawn.command, expectedCommand);
  assert.deepEqual(spawn.args, expectedArgs);
  assert.equal(spawn.options.windowsHide, true);
  assert.equal(spawn.options.detached, undefined);
}

after(() => { fs.rmSync(fakeRoot, { recursive: true, force: true }); });

/** 默认用例:固定假 exe,每个用例前清空 spawn 记录 */
const codexTest = (name, fn) => test(name, () => withCodexExe(fakeExe, () => { spawns = []; return fn(); }));
codexTest('verifies projectless workspace; relaunch does not send a second turn', async () => {
  scenario = { calls: [] };
  const progress = [];
  const launch = await createCodexTask(dir, 'test', undefined, value => progress.push(value));
  assert.equal(launch.status, 'ready');
  assert.equal(launch.projectId, null);
  assert.equal(launch.initialState, 'completed');
  assert.ok(progress.some(value => value.initialState === 'dispatching'));
  const again = await createCodexTask(dir, 'test', launch, () => {});
  assert.equal(again.status, 'ready');
  assert.equal(scenario.calls.filter(method => method === 'turn/start').length, 1);
  assert.ok(spawns.length >= 1);
  for (const spawn of spawns) assertSpawnedAppServer(spawn);
});

codexTest('wrong workspace assignment prevents sending', async () => {
  scenario = { calls: [], mismatch: true };
  const launch = await createCodexTask(dir, 'test', undefined, () => {});
  assert.equal(launch.status, 'failed');
  assert.ok(!scenario.calls.includes('turn/start'));
  assert.equal(spawns.length, 1);
  assertSpawnedAppServer(spawns[0]);
});

codexTest('unsupported protocol is reported instead of using selected project', async () => {
  scenario = { calls: [], unsupported: true };
  const launch = await createCodexTask(dir, 'test', undefined, () => {});
  assert.equal(launch.status, 'failed');
  assert.match(launch.detail, /unknown field/);
  assert.ok(!scenario.calls.includes('turn/start'));
});

codexTest('failed turn keeps identity and blocks duplicate dispatch', async () => {
  scenario = { calls: [], turnFailed: true };
  const launch = await createCodexTask(dir, 'test', undefined, () => {});
  assert.equal(launch.status, 'failed');
  assert.equal(launch.threadId, 'thread');
  assert.match(launch.detail, /model unavailable/);
  await createCodexTask(dir, 'test', launch, () => {});
  assert.equal(scenario.calls.filter(method => method === 'turn/start').length, 1);
});

// 下面两条覆盖「解析到 npm 版 codex 时怎么起」。npm 版只在 win32 上走 .cmd 垫片,所以只在 win32 跑;
// 垫片和 package.json 都建在临时目录里,不碰本机真实的 npm 全局目录。
test('npm shim with a resolvable entry script is launched with node, script path first', { skip: !IS_WIN }, async () => {
  const shimDir = fs.mkdtempSync(path.join(fakeRoot, 'npm-ok-'));
  const pkg = path.join(shimDir, 'node_modules', '@openai', 'codex');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { codex: 'bin/codex.js' } }));
  fs.writeFileSync(path.join(pkg, 'bin', 'codex.js'), '');
  const shim = path.join(shimDir, 'codex.cmd');
  fs.writeFileSync(shim, '@echo off');
  await withCodexExe(shim, async () => {
    spawns = [];
    scenario = { calls: [] };
    const launch = await createCodexTask(dir, 'test', undefined, () => {});
    assert.equal(launch.status, 'ready');
    assert.equal(spawns.length, 1);
    assertSpawnedAppServer(spawns[0], [path.join(pkg, 'bin', 'codex.js'), 'app-server', '--stdio'], process.execPath);
  });
});

test('npm shim without a resolvable entry script falls back to hidden PowerShell', { skip: !IS_WIN }, async () => {
  const shimDir = fs.mkdtempSync(path.join(fakeRoot, 'npm-bare-'));
  const shim = path.join(shimDir, 'codex.cmd');
  fs.writeFileSync(shim, '@echo off');
  await withCodexExe(shim, async () => {
    spawns = [];
    scenario = { calls: [] };
    const launch = await createCodexTask(dir, 'test', undefined, () => {});
    assert.equal(launch.status, 'ready');
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].command, 'powershell.exe');
    assert.deepEqual(spawns[0].args.slice(0, 4), ['-NonInteractive', '-WindowStyle', 'Hidden', '-NoLogo']);
    assert.equal(spawns[0].options.windowsHide, true);
    assert.equal(spawns[0].options.detached, undefined);
  });
});

test('PROMPTCUT_CODEX_EXE is restored after a run', async () => {
  const before = process.env.PROMPTCUT_CODEX_EXE;
  await withCodexExe(fakeExe, async () => { assert.equal(process.env.PROMPTCUT_CODEX_EXE, fakeExe); });
  assert.equal(process.env.PROMPTCUT_CODEX_EXE, before);
  await assert.rejects(withCodexExe(fakeExe, () => { throw new Error('boom'); }), /boom/);
  assert.equal(process.env.PROMPTCUT_CODEX_EXE, before);
});
