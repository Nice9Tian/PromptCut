/**
 * 云端 Agent 服务起的子进程是一棵杀得掉的树:子进程再起孙进程,撤销(运行资源登记器的 abort)、超时、close() 之后,
 * 子进程和孙进程的进程号都查不到了。
 *
 * 三层:
 *   1. 公共实现本身(`perception/runner.mjs` + `workspace.mjs` 的 `spawn()`),真 Python 起真孙进程;
 *   2. 四个起 Python 的调用方(语音转写、主体识别、运动追踪、网页采集)各自的超时、撤销、close():
 *      包目录指到一个替身包(进去就起一个孙进程然后一直睡),解释器是真 Python,走的是各调用方真实的起进程路径;
 *   3. 平台分支的决定(在这台机器上跑不到的那一个平台):用假的子进程和注入的杀法核对「该按组杀 / 该按树杀 / 该收手」。
 *      Linux 上真的按组杀要到节点上跑 `scripts/probes/cloud-tools-spawn-linux-demo.mjs`。
 *
 * 没有 Python 时前两层 skip(不假绿)。
 * 跑:npm test -- server/test/cloud-tools-spawn-tree.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRunResources } from '../agent/service/run-resources.mjs';
import { createWorkspaces, killTree as killTreeFromWorkspace } from '../agent/service/workspace.mjs';
import { createCollect, newCollectState } from '../agent/service/hosted-collect.mjs';
import {
  groupAlive, isolatedPythonArgs, killTree, PYTHON_BOOTSTRAP, PYTHON_ISOLATED_FLAGS, spawnTree, splitRoots, superviseChild, treeSettled, whenClosed,
} from '../agent/service/perception/runner.mjs';
import { p2Fixture } from './cloud-tools-p2-fixture.mjs';
import { makeP4Fixture } from './cloud-tools-p4-fixture.mjs';
import { buildTrackEnv, contextOf } from './cloud-tools-p3-kit.mjs';

function findPython() {
  for (const cand of [process.env.PROMPTCUT_TEST_PYTHON, process.env.PROMPTCUT_PYTHON, 'python', 'python3'].filter(Boolean)) {
    const r = spawnSync(cand, ['-I', '-c', 'import sys;sys.stdout.write(sys.executable)'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (r.status === 0 && r.stdout.trim() && fs.existsSync(r.stdout.trim())) return r.stdout.trim();
  }
  return null;
}
const python = findPython();
const skip = python ? false : '没有可用的 Python';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };
async function until(check, { ms = 20_000, what = '条件' } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`等${what}超时(${ms} ms)`);
    await sleep(50);
  }
}
/** 子进程和孙进程的进程号都查不到了 */
async function assertTreeGone(pids, what) {
  await until(() => !alive(pids.pid) && !alive(pids.grandchild), { what: `${what}:子进程 ${pids.pid} 与孙进程 ${pids.grandchild} 都退出` });
  assert.equal(alive(pids.pid), false, `${what}:子进程还在`);
  assert.equal(alive(pids.grandchild), false, `${what}:孙进程还在`);
}

/** 起一个孙进程(继承本进程的标准流),把两个进程号写到当前目录的 tree-pids.json 并打一行 JSON,然后一直睡 */
const TREE_PY = [
  'import json, os, subprocess, sys, time',
  "g = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(600)'])",
  "pids = {'pid': os.getpid(), 'grandchild': g.pid}",
  "open(os.path.join(os.getcwd(), 'tree-pids.json'), 'w').write(json.dumps(pids))",
  'print(json.dumps(pids), flush=True)',
  'time.sleep(600)',
  '',
].join('\n');

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** 替身包目录:四个包名都在,`python -m 包名 …` 进去就是上面那段 */
function stubPackages(t) {
  const root = tmpDir(t, 'pc-spawn-stub-');
  for (const name of ['promptcut_stt', 'promptcut_subject', 'promptcut_track', 'promptcut_collect']) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, '__init__.py'), '');
    fs.writeFileSync(path.join(root, name, '__main__.py'), TREE_PY);
  }
  return root;
}
const pidsIn = (dir) => until(() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'tree-pids.json'), 'utf8')); } catch { return null; } }, { what: '替身包报出进程号' });
const clearPids = (dir) => fs.rmSync(path.join(dir, 'tree-pids.json'), { force: true });

/* ================================================================ 1. 公共实现本身 */

const CONTEXT = Object.freeze({
  projectId: 'proj_a', conversationId: 'conv_a', runId: 'run_a', runGrantId: 'grant_a', instanceId: 'inst_a',
  instanceGeneration: 1, senderAccountId: 'acct_a', messageId: 'msg_a',
});

function runnerKit(t) {
  const dir = tmpDir(t, 'pc-spawn-tree-');
  const script = path.join(dir, 'tree.py');
  fs.writeFileSync(script, TREE_PY);
  const ws = createWorkspaces({ dataDir: path.join(dir, 'agent') }).open({ projectId: 'proj_a', ownerKey: 'owner1234', conversationId: 'conv_a' });
  const resources = createRunResources({ contextAccess: { fromGrant: async () => CONTEXT, authorize: async () => ({ fenceRevision: 1 }) } });
  t.after(() => resources.close());
  /** 起那棵树,回 `{ child, pids }`(pids 是它自己报的) */
  const start = (spawnOptions = {}) => {
    const child = ws.spawn(python, ['-I', script], spawnOptions);
    let text = '';
    const pids = new Promise((resolve) => {
      child.stdout.on('data', (d) => { text += d.toString('utf8'); const line = text.split('\n').find((l) => l.trim().startsWith('{')); if (line && text.includes('\n')) resolve(JSON.parse(line)); });
    });
    return { child, pids };
  };
  return { ws, resources, start };
}

test('公共实现:撤销(运行资源登记器的 abort)杀掉整棵树,等到 exit + close 才算完', { skip, timeout: 60_000 }, async (t) => {
  const k = runnerKit(t);
  const { child, pids: reported } = k.start();
  const run = await superviseChild(child, { resources: k.resources, context: CONTEXT });
  const pids = await reported;
  assert.equal(pids.pid, child.pid);
  assert.ok(alive(pids.pid) && alive(pids.grandchild), '树起来了');
  await k.resources.abortForFence(CONTEXT, 'stop');
  const end = await run.done;
  assert.equal(end.aborted, true);
  assert.equal(end.timedOut, false);
  assert.equal(treeSettled(child), true, 'exit 与 close 都到了');
  await assertTreeGone(pids, '撤销');
  const receipt = await k.resources.abortForFence(CONTEXT, 'stop');
  assert.equal(receipt.childrenOpen, 0, '登记器上没有没关的子进程');
  // 这一轮已经被撤销:再起的子进程登记被拒,整棵树被杀掉、等它收干净之后才抛
  const again = k.start();
  await assert.rejects(superviseChild(again.child, { resources: k.resources, context: CONTEXT }), { code: 'run-resource-fenced' });
  assert.equal(treeSettled(again.child), true);
  assert.equal(alive(again.child.pid), false);
});

test('公共实现:超时杀掉整棵树(监管的超时,与工作区 spawn 自带的超时)', { skip, timeout: 60_000 }, async (t) => {
  const k = runnerKit(t);
  const first = k.start();
  const run = await superviseChild(first.child, { resources: k.resources, context: CONTEXT, timeoutMs: 1500 });
  const pids = await first.pids;
  const end = await run.done;
  assert.equal(end.timedOut, true);
  assert.equal(end.aborted, false);
  await assertTreeGone(pids, '监管的超时');

  const second = k.start({ timeoutMs: 1500 });
  const closed = whenClosed(second.child);
  const pids2 = await second.pids;
  await closed;
  await assertTreeGone(pids2, '工作区 spawn 自带的超时');
});

test('公共实现:登记器 close()、外面给的取消信号、只会 child.kill() 的旧代码,杀的都是整棵树', { skip, timeout: 90_000 }, async (t) => {
  const k = runnerKit(t);
  // 外面给的取消信号(网页采集走这条)
  const abort = new AbortController();
  const first = k.start();
  const run = await superviseChild(first.child, { signal: abort.signal });
  const pids = await first.pids;
  abort.abort();
  assert.equal((await run.done).aborted, true);
  await assertTreeGone(pids, '取消信号');

  // 只会 child.kill() 的代码(`audio-loudness.mjs` 的超时就是这样)
  const second = k.start();
  const closed = whenClosed(second.child);
  const pids2 = await second.pids;
  assert.equal(second.child.kill(), true);
  await closed;
  await assertTreeGone(pids2, 'child.kill()');
  assert.equal(killTree(second.child), false, '收干净之后不再发信号');
  assert.equal(killTreeFromWorkspace, killTree, '工作区转出的是同一个杀法');

  // 登记器 close()(Agent 服务关闭)
  const third = k.start();
  const run3 = await superviseChild(third.child, { resources: k.resources, context: CONTEXT });
  const pids3 = await third.pids;
  await k.resources.close();
  await run3.done;
  await assertTreeGone(pids3, '登记器 close()');
});

test('公共实现:起不来的解释器不登记、不悬着,done 里带 spawnError', { timeout: 30_000 }, async (t) => {
  const k = runnerKit(t);
  const child = k.ws.spawn(path.join(os.tmpdir(), 'pc-no-such-python-binary'), ['-I', '-c', 'pass']);
  let registered = 0;
  const resources = { register: async () => { registered += 1; throw new Error('不该登记'); } };
  const run = await superviseChild(child, { resources, context: CONTEXT });
  const end = await run.done;
  assert.ok(end.spawnError);
  assert.equal(registered, 0);
  assert.equal(run.pid, undefined);
  assert.equal(killTree(child), false);
});

/* ================================================================ 2. 四个起 Python 的调用方 */

test('运动追踪:超时、撤销、close() 之后子进程和孙进程都退了', { skip, timeout: 120_000 }, async (t) => {
  const stub = stubPackages(t);
  const config = { executable: python, packageRoot: stub };

  await t.test('超时', async (tt) => {
    const env = await buildTrackEnv(tt, { runtime: null, python: config, limits: { statusTimeoutMs: 2000 } });
    const ctx = env.access.trust(contextOf());
    const dir = (await env.workspace(ctx)).dir();
    const call = env.tracks.call('track_status', {}, ctx);
    const pids = await pidsIn(dir);
    const status = await call;
    assert.match(status.reason, /超时/);
    await assertTreeGone(pids, '运动追踪超时');
    await env.close();
  });

  await t.test('撤销', async (tt) => {
    const env = await buildTrackEnv(tt, { runtime: null, python: config });
    const ctx = env.access.trust(contextOf());
    const dir = (await env.workspace(ctx)).dir();
    const call = env.tracks.call('track_status', {}, ctx).then((v) => v, (e) => e);
    const pids = await pidsIn(dir);
    assert.ok(alive(pids.pid) && alive(pids.grandchild));
    await env.resources.abortForFence(ctx, 'stop');
    await call;
    await assertTreeGone(pids, '运动追踪撤销');
    await env.close();
  });

  await t.test('close()', async (tt) => {
    const env = await buildTrackEnv(tt, { runtime: null, python: config });
    const ctx = env.access.trust(contextOf());
    const dir = (await env.workspace(ctx)).dir();
    const call = env.tracks.call('track_status', {}, ctx).then((v) => v, (e) => e);
    const pids = await pidsIn(dir);
    await env.tracks.close('shutdown');
    await call;
    await assertTreeGone(pids, '运动追踪 close()');
    await env.close();
  });
});

test('主体识别:超时、撤销、close() 之后子进程和孙进程都退了', { skip, timeout: 120_000 }, async (t) => {
  const stub = stubPackages(t);
  const models = tmpDir(t, 'pc-spawn-models-');
  const config = { python, modelsDir: models, pythonPath: stub };

  await t.test('超时', async (tt) => {
    const fx = await makeP4Fixture(tt, { config, limits: { statusMs: 2000 } });
    const call = fx.tools.call('subject_status', {}, fx.context);
    const pids = await pidsIn(fx.ws.dir());
    const status = await call;
    assert.match(String(status.reason), /超时/);
    await assertTreeGone(pids, '主体识别超时');
  });

  await t.test('撤销', async (tt) => {
    const fx = await makeP4Fixture(tt, { config });
    const call = fx.tools.call('subject_status', {}, fx.context).then((v) => v, (e) => e);
    const pids = await pidsIn(fx.ws.dir());
    assert.ok(alive(pids.pid) && alive(pids.grandchild));
    await fx.resources.abortForFence(fx.context, 'stop');
    await call;
    await assertTreeGone(pids, '主体识别撤销');
  });

  await t.test('close()', async (tt) => {
    const fx = await makeP4Fixture(tt, { config });
    const call = fx.tools.call('subject_status', {}, fx.context).then((v) => v, (e) => e);
    const pids = await pidsIn(fx.ws.dir());
    const receipt = await fx.tools.close('shutdown');
    assert.equal(receipt.childrenClosed, true);
    await call;
    await assertTreeGone(pids, '主体识别 close()');
  });
});

test('语音转写:超时、撤销、close() 之后子进程和孙进程都退了', { skip, timeout: 120_000 }, async (t) => {
  const stub = stubPackages(t);
  const runtime = { pythonPath: python, sourceRoot: stub };

  await t.test('超时', async (tt) => {
    const f = await p2Fixture(tt, { realPython: true, runtime, limits: { statusMs: 2000 } });
    const call = f.tools.call('stt_status', {}, f.context);
    const pids = await pidsIn(f.ws.dir());
    const status = await call;
    assert.equal(status.code, 'STATUS_FAILED');
    await assertTreeGone(pids, '语音转写超时');
  });

  await t.test('撤销', async (tt) => {
    const f = await p2Fixture(tt, { realPython: true, runtime });
    const call = f.tools.call('stt_status', {}, f.context).then((v) => v, (e) => e);
    const pids = await pidsIn(f.ws.dir());
    assert.ok(alive(pids.pid) && alive(pids.grandchild));
    await f.resources.abortForFence(f.context, 'stop');
    await call;
    await assertTreeGone(pids, '语音转写撤销');
  });

  await t.test('close()', async (tt) => {
    const f = await p2Fixture(tt, { realPython: true, runtime });
    const call = f.tools.call('stt_status', {}, f.context).then((v) => v, (e) => e);
    const pids = await pidsIn(f.ws.dir());
    await f.tools.close('shutdown');
    await call;
    await assertTreeGone(pids, '语音转写 close()');
  });
});

test('网页采集:超时、取消(stopAll)之后子进程和孙进程都退了', { skip, timeout: 120_000 }, async (t) => {
  const stub = stubPackages(t);
  const dataDir = tmpDir(t, 'pc-spawn-collect-');
  const ws = createWorkspaces({ dataDir }).open({ projectId: 'proj_a', ownerKey: 'owner1234', conversationId: 'conv_a' });
  const proxies = { open: 0 };
  const egress = { startProxy: async () => { proxies.open += 1; return { url: 'http://127.0.0.1:9', close: async () => { proxies.open -= 1; } }; } };
  const collect = createCollect({ config: { python, pythonPath: stub }, egress, limits: { statusMs: 2000, watchMs: 100 } });
  const state = newCollectState();
  const tools = collect.forConversation({ state, workspace: () => ws, ensureCanWrite: async () => {}, importFile: async () => ({}), conversationId: 'conv_a' });

  const call = tools.collect_status();
  const pids = await pidsIn(ws.dir());
  const status = await call;
  assert.equal(status.ready, false);
  await assertTreeGone(pids, '网页采集超时');
  assert.equal(proxies.open, 0, '代理在进程树收干净之后关掉');

  clearPids(ws.dir());
  const started = await tools.collect_download({ url: 'https://example.test/v' });
  const pids2 = await pidsIn(ws.dir());
  assert.ok(alive(pids2.pid) && alive(pids2.grandchild));
  tools.stopAll();
  const job = await until(async () => { const j = await tools.collect_job({ jobId: started.jobId }); return j.status !== 'running' ? j : null; }, { what: '下载作业结束' });
  assert.equal(job.message, '已取消');
  await assertTreeGone(pids2, '网页采集取消');
  assert.equal(proxies.open, 0);
});

/* ================================================================ 3. 平台分支的决定(假子进程 + 注入的杀法) */

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.rawKills = [];
  child.kill = (signal) => { child.rawKills.push(signal); return true; };
  return child;
}

test('非 Windows:起成进程组的组长,按组杀;组长先退也照样按组杀;收干净之后收手', () => {
  const calls = [];
  let options = null;
  const child = fakeChild();
  const got = spawnTree('python3', ['-I'], { cwd: '/w', env: { A: '1' } }, {
    platform: 'linux', spawnImpl: (_c, _a, o) => { options = o; return child; }, processKill: (pid, signal) => { calls.push([pid, signal]); },
  });
  assert.equal(got, child);
  assert.deepEqual([options.detached, options.windowsHide, options.shell, options.cwd], [true, true, false, '/w']);
  assert.equal(killTree(child), true);
  assert.deepEqual(calls, [[-4242, 'SIGKILL']], '给整个进程组发 SIGKILL');
  assert.equal(child.kill('SIGTERM'), true, 'child.kill() 也是按组杀,带上调用方给的信号');
  assert.deepEqual(calls.at(-1), [-4242, 'SIGTERM']);
  assert.deepEqual(child.rawKills, [], '没有只杀组长');

  // 组长退了、孙进程还握着管道(close 没到):退出时扫一次组,之后再杀仍是按组
  child.emit('exit', 0, null);
  assert.deepEqual(calls.at(-1), [-4242, 'SIGKILL'], '组长退出时把组里剩下的收掉');
  const before = calls.length;
  assert.equal(killTree(child), true);
  assert.equal(calls.length, before + 1);
  assert.equal(treeSettled(child), false);

  // exit 与 close 都到了:进程号可能已经归别人,不再发信号
  child.emit('close', 0, null);
  assert.equal(treeSettled(child), true);
  assert.equal(killTree(child), false);
  assert.equal(calls.length, before + 1);
});

test('非 Windows:按组杀失败(组不在)而组长还没退,退回只杀组长;没经 spawnTree 起的子进程用它自己的 kill', () => {
  const child = fakeChild(77);
  spawnTree('x', [], {}, { platform: 'linux', spawnImpl: () => child, processKill: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); } });
  assert.equal(killTree(child), true);
  assert.deepEqual(child.rawKills, ['SIGKILL']);

  const plain = fakeChild(78);
  assert.equal(killTree(plain), true);
  assert.deepEqual(plain.rawKills, ['SIGKILL']);

  assert.equal(groupAlive(99, { platform: 'linux', processKill: () => {} }), true);
  assert.equal(groupAlive(99, { platform: 'linux', processKill: () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); } }), false);
  assert.equal(groupAlive(99, { platform: 'win32' }), null, 'Windows 上没有进程组:回不知道,不假称退干净');
});

test('Windows:不建进程组,用 taskkill 按树杀;没杀成退回只杀根;根已经退了就收手', () => {
  const kills = [];
  let options = null;
  const killers = [];
  const taskkill = (pid) => { const k = new EventEmitter(); kills.push(pid); killers.push(k); return k; };
  const child = fakeChild(900);
  spawnTree('python', [], {}, { platform: 'win32', spawnImpl: (_c, _a, o) => { options = o; return child; }, processKill: () => { throw new Error('Windows 上不该按组杀'); }, taskkill });
  assert.equal(options.detached, false);
  assert.equal(child.kill(), true);
  assert.equal(child.kill(), true, '上一个 taskkill 还没回来:不重复起');
  assert.deepEqual(kills, [900]);
  killers[0].emit('exit', 1);
  assert.deepEqual(child.rawKills, ['SIGKILL'], 'taskkill 没杀成:退回只杀根');
  assert.equal(killTree(child), true);
  assert.deepEqual(kills, [900, 900]);
  killers[1].emit('exit', 0);
  assert.deepEqual(child.rawKills, ['SIGKILL']);
  child.emit('exit', 1, null);
  assert.equal(killTree(child), false, '根已经退了:Windows 上没有树可找');
  assert.deepEqual(kills, [900, 900]);
});

test('隔离模式的命令行:有包目录走引导代码,没有走 -m;模块名只收标识符', () => {
  assert.deepEqual(isolatedPythonArgs('promptcut_stt', { args: ['status'] }), ['-I', '-X', 'utf8', '-u', '-B', '-m', 'promptcut_stt', 'status']);
  assert.deepEqual(isolatedPythonArgs('promptcut_track', { roots: ['/a', '', null, '/b'], args: ['--x', 'status'] }),
    [...PYTHON_ISOLATED_FLAGS, '-c', PYTHON_BOOTSTRAP, '2', '/a', '/b', 'promptcut_track', '--x', 'status']);
  assert.throws(() => isolatedPythonArgs('pkg; import os'));
  assert.throws(() => isolatedPythonArgs(''));
  assert.deepEqual(splitRoots(['a', '', 'b']), ['a', 'b']);
  assert.deepEqual(splitRoots(`a${path.delimiter}b`), ['a', 'b']);
  assert.deepEqual(splitRoots(undefined), []);
});

test('隔离模式的引导代码:当前目录不进搜索路径,包目录排最前,参数与 -m 一样递给包', { skip, timeout: 60_000 }, (t) => {
  const root = tmpDir(t, 'pc-spawn-boot-');
  const cwd = tmpDir(t, 'pc-spawn-cwd-');
  fs.mkdirSync(path.join(root, 'echo_pkg'));
  fs.writeFileSync(path.join(root, 'echo_pkg', '__init__.py'), '');
  fs.writeFileSync(path.join(root, 'echo_pkg', '__main__.py'),
    "import json, os, sys\nprint(json.dumps({'argv': sys.argv[1:], 'argv0': sys.argv[0], 'path0': sys.path[0], 'cwdInPath': ('' in sys.path) or (os.getcwd() in sys.path), 'isolated': sys.flags.isolated, 'utf8': sys.flags.utf8_mode, 'nobytecode': sys.dont_write_bytecode, 'name': __name__, 'stdout': sys.stdout.encoding}))\n");
  const r = spawnSync(python, isolatedPythonArgs('echo_pkg', { roots: [root], args: ['--flag', '值 with space', 'a"b'] }),
    { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, PYTHONPATH: cwd, PYTHONUTF8: '0' } });
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(r.stdout);
  assert.deepEqual(seen.argv, ['--flag', '值 with space', 'a"b']);
  assert.equal(path.resolve(seen.path0), path.resolve(root));
  assert.equal(seen.cwdInPath, false, '当前目录(也没有经 PYTHONPATH)进搜索路径');
  assert.deepEqual([seen.isolated, seen.utf8, seen.nobytecode, seen.name], [1, 1, true, '__main__']);
  assert.match(seen.stdout, /utf-?8/i);
  assert.equal(path.basename(seen.argv0), '__main__.py', 'sys.argv[0] 与 -m 一样是包的入口文件');
});
