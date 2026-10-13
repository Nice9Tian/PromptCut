import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PREFIX, SLICE_PREFIX, PROBE_SOURCE_PATHS, parseProbeArguments, probePlan, requireLinuxRoot, cleanup, leftovers } from '../agent-service/account-root-probe-support.mjs';
import { renderTaskUnit, parseTaskUnitArguments } from '../agent-service/account-task-unit.mjs';

// 节点自检脚本（scripts/probes/account-root-entry-linux.mjs）里在这台机器上验得到的部分：参数、名字、清理的幂等、非 Linux 明确拒绝；
// 以及任务槽单元模板的填法。脚本真正的十一步只在节点上（Linux、root、systemd）走得到。
const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '..', '..');
const script = path.join(repo, 'scripts', 'probes', 'account-root-entry-linux.mjs');

test('自检脚本的参数：只认四样；清理单独跑时不带别的', () => {
  assert.deepEqual(parseProbeArguments([]), { user: 'nobody', protect: [], keepOnFailure: false, cleanupId: null });
  assert.deepEqual(parseProbeArguments(['--user', 'promptcut-render', '--protect', 'promptcut-doc-v2.service,nginx.service', '--keep-on-failure']),
    { user: 'promptcut-render', protect: ['promptcut-doc-v2.service', 'nginx.service'], keepOnFailure: true, cleanupId: null });
  assert.equal(parseProbeArguments(['--cleanup', '0a1b2c3d']).cleanupId, '0a1b2c3d');
  for (const argv of [['--user'], ['--user', 'root'], ['--user', 'Bad User'], ['--protect', 'not-a-unit'], ['--protect', `${PREFIX}0a1b2c3d-a.service`],
    ['--cleanup', 'xyz'], ['--cleanup', '0a1b2c3d', '--keep-on-failure'], ['--cleanup', '0a1b2c3d', '--protect', 'nginx.service'], ['--force'], ['extra']])
    assert.throws(() => parseProbeArguments(argv), { code: 'probe-arguments' }, JSON.stringify(argv));
});

test('自检脚本用到的名字全由编号推出来、都带固定前缀；只认自己的单元和 slice', () => {
  const plan = probePlan('0a1b2c3d');
  assert.equal(plan.dir, '/run/pc-claude-probe-0a1b2c3d'); assert.equal(plan.unit, 'pc-claude-probe-0a1b2c3d-a.service');
  assert.equal(plan.unitFile, '/run/systemd/system/pc-claude-probe-0a1b2c3d-a.service');
  assert.equal(plan.dropInDir, '/run/systemd/system/pc-claude-probe-0a1b2c3d-a.service.d');
  assert.equal(plan.namespace, 'pcclaudeprobe0a1b2c3d'); assert.match(plan.namespace, /^[a-z][a-z0-9]{1,39}$/, '发布器对 slice 名字空间的规则');
  for (const key of ['repoDir', 'pkiDir', 'registryDir', 'settingsFile', 'dataDir', 'stateRoot', 'configFile']) assert.ok(plan[key].startsWith(`${plan.dir}/`), key);
  assert.ok(plan.unit.startsWith(PREFIX) && plan.authorityId.startsWith(PREFIX) && plan.namespace.startsWith(SLICE_PREFIX));
  assert.equal(plan.owns('pc-claude-probe-0a1b2c3d-a.service'), true);
  assert.equal(plan.owns('pcclaudeprobe0a1b2c3d3n0123456789abcdef0123456789abcdef.slice'), true);
  for (const foreign of ['pc-claude-probe-ffffffff-a.service', 'pcclaudeprobeffffffff1nabc.slice', 'promptcut-doc-v2.service', 'system.slice', 'pcclaudeprobe0a1b2c3d-x.slice', 'nginx.service'])
    assert.equal(plan.owns(foreign), false, foreign);
  for (const id of ['', 'ABCDEF12', '0a1b2c3', '0a1b2c3d4', '../../etc']) assert.throws(() => probePlan(id), { code: 'probe-id' });
});

test('自检脚本只在 Linux root 上跑：别的地方明确拒绝，什么都不碰', () => {
  assert.throws(() => requireLinuxRoot({ platform: 'win32' }), { code: 'linux-root-required' });
  assert.throws(() => requireLinuxRoot({ platform: 'linux', uid: 1000, euid: 1000 }), { code: 'linux-root-required' });
  assert.doesNotThrow(() => requireLinuxRoot({ platform: 'linux', uid: 0, euid: 0 }));
  if (process.platform === 'linux' && process.getuid?.() === 0) return;
  for (const args of [[], ['--cleanup', '0a1b2c3d'], ['--user', 'nobody', '--keep-on-failure']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(result.status, 1);
    const rows = result.stdout.trim().split('\n');
    assert.equal(rows[0], 'FAIL precondition linux-root-required'); assert.equal(rows.at(-1), 'FAIL account-root-entry-linux 0/11');
    assert.equal(rows.length, 2, '没有做任何别的事');
  }
  const bad = spawnSync(process.execPath, [script, '--force'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(bad.status, 1); assert.equal(bad.stdout.trim().split('\n')[0], 'FAIL precondition probe-arguments');
});

/** 一台受控的「系统」：有哪些单元、cgroup、文件、进程，清理动了什么全记下来 */
function fakeSystem(plan, { failing = [] } = {}) {
  const slice = `${plan.namespace}3n${'ab'.repeat(16)}.slice`, foreignSlice = 'pcclaudeprobeffffffff1nabc.slice';
  const state = { units: new Map([[plan.unit, 'loaded active'], [slice, 'loaded active'], ['promptcut-doc-v2.service', 'loaded active'], [foreignSlice, 'loaded active']]),
    files: new Set([plan.unitFile, plan.dropInDir, `${plan.dropInDir}/90-promptcut-root-slice.conf`, plan.dir, '/run/systemd/system/promptcut-doc-v2.service']),
    cgroups: new Set([slice, 'system.slice', foreignSlice]), processes: new Map([[4242, `/usr/bin/node\0${plan.dir}/repo/server/agent-service/account-root-main.mjs`], [1, '/sbin/init']]),
    listening: [] };
  const calls = [], maybeFail = what => { if (failing.includes(what)) throw Object.assign(new Error('boom'), { code: 'fake-failure' }); };
  const sys = {
    async systemctl(args) {
      calls.push(['systemctl', ...args]);
      if (args[0] === 'list-units') { const patterns = args.filter(arg => arg.endsWith('*')).map(arg => arg.slice(0, -1));
        return { code: 0, stdout: [...state.units].filter(([name]) => patterns.some(prefix => name.startsWith(prefix))).map(([name, row]) => `${name} ${row} running x`).join('\n'), stderr: '' }; }
      if (args[0] === 'stop') { maybeFail(`stop ${args[1]}`); if (state.units.has(args[1])) { state.units.delete(args[1]); state.cgroups.delete(args[1]); } return { code: 0, stdout: '', stderr: '' }; }
      return { code: 0, stdout: '', stderr: '' };
    },
    exists: async file => state.files.has(file),
    list: async dir => (dir === '/sys/fs/cgroup' ? [...state.cgroups] : dir === '/proc' ? [...state.processes.keys()].map(String).concat(['self', 'net'])
      : [...state.files].filter(file => path.posix.dirname(file) === dir).map(file => path.posix.basename(file))),
    async unlink(file) { calls.push(['unlink', file]); maybeFail(`unlink ${file}`); state.files.delete(file); },
    async rmdir(dir) { calls.push(['rmdir', dir]); if ([...state.files].some(file => path.posix.dirname(file) === dir)) throw Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' }); state.files.delete(dir); },
    async removeTree(dir) { calls.push(['removeTree', dir]); maybeFail(`removeTree ${dir}`); for (const file of [...state.files]) if (file === dir || file.startsWith(`${dir}/`)) state.files.delete(file); },
    readText: async file => (file === '/proc/net/tcp' ? ['sl local rem st', ...state.listening.map(port => `0: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A`)].join('\n')
      : state.processes.get(Number(/^\/proc\/(\d+)\/cmdline$/.exec(file)?.[1])) ?? ''),
    kill(pid) { calls.push(['kill', pid]); return state.processes.delete(pid); },
  };
  return { sys, state, calls, slice, foreignSlice };
}

test('清理：只动本次编号的东西；可以重复跑；一步出错接着做后面的；最后如实报还剩什么', async () => {
  const plan = probePlan('0a1b2c3d'), w = fakeSystem(plan);
  w.state.listening.push(40123);
  const before = await leftovers(plan, w.sys, { ports: [40123, 40124] });
  assert.deepEqual(before, { units: [plan.unit, w.slice], unitFiles: [plan.unitFile, plan.dropInDir], cgroups: [`/sys/fs/cgroup/${w.slice}`], processes: [4242], listeners: [40123], directory: [plan.dir] });
  const rows = await cleanup(plan, w.sys);
  assert.ok(rows.some(row => row === `stop ${plan.unit}: stopped`) && rows.some(row => row === `stop ${w.slice}: stopped`) && rows.some(row => row === `remove ${plan.dir}: removed`), rows.join(' | '));
  // 次序：先停任务槽单元，再停 slice，再删单元文件、重读，最后删目录
  const order = name => w.calls.findIndex(call => call.join(' ').startsWith(name));
  assert.ok(order(`systemctl stop ${plan.unit}`) < order(`systemctl stop ${w.slice}`) && order(`systemctl stop ${w.slice}`) < order(`unlink ${plan.unitFile}`) &&
    order(`unlink ${plan.unitFile}`) < order('systemctl daemon-reload') && order('systemctl daemon-reload') < order(`removeTree ${plan.dir}`));
  // 别人的一样都没碰
  for (const call of w.calls) {
    if (call[0] === 'systemctl' && ['stop', 'reset-failed'].includes(call[1])) assert.equal(plan.owns(call[2]), true, call.join(' '));
    if (['unlink', 'rmdir', 'removeTree'].includes(call[0])) assert.ok(call[1] === plan.dir || call[1].startsWith(plan.dropInDir) || call[1] === plan.unitFile, call.join(' '));
    if (call[0] === 'kill') assert.equal(call[1], 4242);
  }
  assert.equal(w.state.units.has('promptcut-doc-v2.service'), true); assert.equal(w.state.units.has(w.foreignSlice), true);
  assert.equal(w.state.files.has('/run/systemd/system/promptcut-doc-v2.service'), true); assert.equal(w.state.processes.has(1), true);
  w.state.listening.length = 0;
  assert.deepEqual(await leftovers(plan, w.sys, { ports: [40123] }), { units: [], unitFiles: [], cgroups: [], processes: [], listeners: [], directory: [] });
  // 再跑一遍：没有东西可清，不报错，也不再发任何改动的指令
  w.calls.length = 0;
  assert.deepEqual(await cleanup(plan, w.sys), [`nothing to clean: ${plan.id}`]);
  assert.equal(w.calls.some(call => call[0] !== 'systemctl' || call[1] !== 'list-units'), false);

  // 中途有几步出错：后面的照做，剩下的如实列出来
  const broken = fakeSystem(plan, { failing: [`stop ${plan.unit}`, `unlink ${plan.unitFile}`] });
  const partial = await cleanup(plan, broken.sys);
  assert.ok(partial.some(row => row === `stop ${plan.unit}: error fake-failure`) && partial.some(row => row === `remove ${plan.unitFile}: error fake-failure`));
  assert.ok(partial.some(row => row === `stop ${broken.slice}: stopped`) && partial.some(row => row === `remove ${plan.dir}: removed`), '出错之后的步骤照做');
  const left = await leftovers(plan, broken.sys);
  assert.deepEqual(left.units, [plan.unit]); assert.deepEqual(left.unitFiles, [plan.unitFile]); assert.deepEqual(left.directory, []);
  // 单元文件删了以后 systemd 还把它列成 not-found inactive：不算剩余
  const gone = fakeSystem(plan); gone.state.units.set(plan.unit, 'not-found inactive'); gone.state.units.delete(gone.slice); gone.state.cgroups.delete(gone.slice);
  gone.state.files.clear(); gone.state.processes.delete(4242);
  assert.deepEqual((await leftovers(plan, gone.sys)).units, []);
});

test('任务槽的单元模板：占位符都填上，发布器逐项核的那几样原样在；不许是 root、不许带空格和转义；模板被改坏就拒', () => {
  const options = { slot: 'slot-a', user: 'promptcut-agent-task', dir: '/opt/promptcut-render/current', node: '/usr/bin/node', settingsFile: '/etc/promptcut/agent-slots/slot-a/worker-settings.json' };
  const unit = renderTaskUnit(options), lines = unit.text.split('\n');
  assert.equal(unit.unit, 'promptcut-agent-task-slot-a.service'); assert.equal(unit.path, '/etc/systemd/system/promptcut-agent-task-slot-a.service');
  assert.doesNotMatch(unit.text, /\{\{|\}\}|\r/); assert.match(unit.sha256, /^[a-f0-9]{64}$/);
  for (const line of ['User=promptcut-agent-task', 'Group=promptcut-agent-task', 'Restart=no', 'KillMode=control-group', 'Delegate=no', 'RemainAfterExit=yes', 'KillSignal=SIGKILL',
    'OOMPolicy=continue', 'Environment=PROMPTCUT_AGENT_WORKER_SETTINGS=/etc/promptcut/agent-slots/slot-a/worker-settings.json', 'WorkingDirectory=/opt/promptcut-render/current'])
    assert.ok(lines.includes(line), line);
  const exec = lines.find(line => line.startsWith('ExecStart='));
  // 入口不带父子通道（--control https），凭生产的配置模块起；开头的「-」见模板里的说明
  assert.equal(exec, 'ExecStart=-/usr/bin/node --max-old-space-size=1536 /opt/promptcut-render/current/server/agent-service/account-task-worker-cli.mjs --configuration-module /opt/promptcut-render/current/server/agent-service/account-task-worker-config.mjs --control https');
  assert.equal(lines.some(line => /^\s*Slice=/.test(line) || line === '[Install]'), false, '不写 Slice=，不开机自启');
  // 模板在这台机器上是 CRLF 还是 LF，填出来的文件和摘要都一样
  const template = fs.readFileSync(path.join(repo, 'server', 'hosted', 'deploy', 'systemd-promptcut-agent-task.service'), 'utf8').replaceAll('\r\n', '\n');
  assert.equal(renderTaskUnit({ ...options, template: template.replaceAll('\n', '\r\n') }).sha256, unit.sha256);
  assert.equal(renderTaskUnit({ ...options, group: 'agents', heapMb: 512, unit: 'pc-claude-probe-0a1b2c3d-a.service' }).text.includes('Group=agents'), true);
  for (const bad of [{ user: 'root' }, { user: 'Bad User' }, { slot: 'a b' }, { dir: 'relative' }, { dir: '/opt/with space' }, { node: '/usr/bin/node; rm -rf /' },
    { settingsFile: '/etc/a/../b.json' }, { settingsFile: '/etc/%h/x.json' }, { heapMb: 1 }, { unit: 'not-a-unit' }])
    assert.throws(() => renderTaskUnit({ ...options, ...bad }), { code: 'task-unit-arguments' }, JSON.stringify(bad));
  for (const broken of [template.replace(/^Restart=no$/m, 'Restart=always'), template.replace(/^KillMode=control-group$/m, 'KillMode=process'), `${template}Slice=system.slice\n`,
    `${template}\n[Install]\nWantedBy=multi-user.target\n`, template.replace(/^RemainAfterExit=yes$/m, ''), template.replace(/^Delegate=no$/m, 'Delegate=yes'), template.replace('{{NODE}}', '{{UNKNOWN}}')])
    assert.throws(() => renderTaskUnit({ ...options, template: broken }), { code: 'task-unit-template' });
  assert.deepEqual(parseTaskUnitArguments(['--slot', 'slot-a', '--user', 'u', '--dir', '/d', '--node', '/n', '--settings', '/s', '--heap-mb', '512']),
    { slot: 'slot-a', user: 'u', dir: '/d', node: '/n', settingsFile: '/s', heapMb: 512 });
  for (const argv of [['--slot'], ['--slot', 'a', '--slot', 'b'], ['--unknown', 'x']]) assert.throws(() => parseTaskUnitArguments(argv), { code: 'task-unit-arguments' });
});

test('要拷到节点的那几样就够：不带 node_modules，任务进程的入口和 root 入口都载得起来', { timeout: 120_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-probe-source-'));
  try {
    for (const rel of PROBE_SOURCE_PATHS) {
      const from = path.join(repo, rel), to = path.join(dir, rel);
      assert.ok(fs.existsSync(from), rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      // 这里为了快不拷 server/test（节点上脚本自己拷给任务进程的那一份也不带它）
      fs.cpSync(from, to, { recursive: true, filter: source => !/[\\/]server[\\/]test([\\/]|$)/.test(source) });
    }
    assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);
    const url = rel => pathToFileURL(path.join(dir, rel)).href;
    const modules = ['server/agent-service/account-task-worker.mjs', 'server/agent-service/account-task-worker-config.mjs', 'server/agent-service/account-root-main.mjs',
      'server/agent-service/account-root-slots.mjs', 'server/agent-service/account-worker-control-client.mjs', 'server/agent-service/account-task-unit.mjs',
      'server/hosted/agent-run-scope-reader.mjs', 'server/hosted/deploy/agent-run-scope-publisher.mjs', 'scripts/probes/account-root-entry-linux.mjs'];
    const loaded = spawnSync(process.execPath, ['--input-type=module', '-e', `for (const m of ${JSON.stringify(modules.map(url))}) await import(m); console.log('loaded');`],
      { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 90_000 });
    assert.equal(loaded.status, 0, loaded.stderr.slice(-600)); assert.equal(loaded.stdout.trim(), 'loaded');
    // 真把任务进程的入口跑起来（生产的起法）：它一路载到配置那一步，在这台机器上被「只在 Linux 上」拒掉——不是缺模块
    if (process.platform !== 'linux') {
      const entry = spawnSync(process.execPath, [path.join(dir, 'server/agent-service/account-task-worker-cli.mjs'), '--configuration-module',
        path.join(dir, 'server/agent-service/account-task-worker-config.mjs'), '--control', 'https'], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
      assert.equal(entry.status, 1);
      assert.deepEqual(JSON.parse(entry.stderr.trim().split('\n').at(-1)), { ok: false, code: 'account-worker-linux-required' });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
