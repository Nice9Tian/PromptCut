/**
 * 托管方渲染服务：工作进程整棵树一起结束、启动自检走真的开页路径（契约 `docs/plan/hosted-render-contract.md` 第 7.1、7.3 节；用例 HR30、HR31）。
 * 跑：npm test -- server/test/hosted-render-process.test.mjs（不起浏览器；HR30 有一例起真的子进程树，几秒）
 *
 *   HR30  结束工作进程时把整棵树带走：按父子关系找后代、按环境里的记号找孤儿（父进程已死、挂到 1 号进程下的）；
 *         每次起之前先清上一轮留下的（只清认得出是自己起的：Linux 按记号，Windows 按 pid 加命令行）；
 *         工作进程自己退出后按记号再清一遍；不重起的模式（隔离工作进程）；真起一棵子进程树验证后代被带走
 *   HR31  启动自检：Chrome 起得来但开不了受帧控制的页（完整版 Chrome / Chromium）时以 `chrome-frame` 失败，原因里有实际版本与期望版本；
 *         版本不是锁定的那一版但开页与出帧都行时只告警；工作进程打 `queue.skip` 时管理进程认得出原因
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { createWorker, killTree, treePids, sweepStaleTree, treeAlive, listProcesses, TREE_ENV } from '../hosted-render/worker.mjs';
import { runSelfcheck } from '../hosted-render/selfcheck.mjs';
import { queueSkipReason } from '../hosted-render/main.mjs';

const TOKEN = 'a'.repeat(32);
const procsOf = (rows) => new Map(rows.map(([pid, ppid, tagged = false]) => [pid, { ppid, tagged }]));

/* ------------------------------------------------------------------ HR30 */

test('HR30 一棵树的全部进程：树根的后代，并上带记号的进程（父进程死了、挂到 1 号进程下的孤儿）；自己与 1 号进程从不在内', () => {
  const procs = procsOf([
    [1, 0], [50, 1], // 管理进程（自己）
    [100, 50],       // 工作进程
    [110, 100], [111, 110], [112, 111], // 编辑器 vite → 预渲染 vite → Chrome
    [200, 1, true], [201, 200, true],   // 上一轮的孤儿：父进程已死，环境里带记号
    [300, 1], [301, 300],               // 别人的进程
  ]);
  assert.deepEqual(treePids(100, procs, { self: 50 }), [100, 110, 111, 112, 200, 201], '后代 + 带记号的孤儿');
  assert.deepEqual(treePids(null, procs, { self: 50 }), [200, 201], '只按记号');
  assert.deepEqual(treePids(100, procsOf([[1, 0], [50, 1], [100, 50], [110, 100]]), { self: 50 }), [100, 110]);
  assert.deepEqual(treePids(999, procs, { self: 50 }).filter((p) => p >= 300), [], '别人的进程不碰');
  // 自己带着记号（工作进程自己清自己那棵树时）：不把自己算进去；1 号进程哪怕带记号也不算
  assert.deepEqual(treePids(null, procsOf([[1, 0, true], [100, 1, true], [110, 100, true]]), { self: 100 }), [110]);
  // 树根已经不在进程表里：不凭空加
  assert.deepEqual(treePids(100, procsOf([[1, 0], [300, 1]]), { self: 50 }), []);
});

test('HR30b Windows 上父进程号被重用：早就成了孤儿的无关进程（和它的孩子）不算进这棵树；创建时刻缺的照旧按父子关系', () => {
  // 完整验收里实测到的情形：验收运行器（700）的父进程（111）早已退出，111 这个号后来被工作进程树里的新进程重用
  const born = (rows) => new Map(rows.map(([pid, ppid, at]) => [pid, { ppid, tagged: false, ...(at === undefined ? {} : { born: at }) }]));
  const procs = born([
    [50, 4, 100],                 // 管理进程（自己）
    [100, 50, 200],               // 工作进程
    [110, 100, 210], [111, 110, 220], // 111：重用了运行器父进程的号
    [700, 111, 20], [701, 700, 21],   // 运行器与它的控制台宿主：比 111 早创建
    [112, 111, 230],              // 111 真正的孩子
    [113, 111],                   // 创建时刻读不到：照旧算
  ]);
  assert.deepEqual(treePids(100, procs, { self: 50 }), [100, 110, 111, 112, 113]);
  // 树根已经死了、它的号还没被重用：孩子照旧找得到
  assert.deepEqual(treePids(100, born([[110, 100, 210], [111, 110, 220]]), { self: 50 }), [110, 111]);
});

test('HR30c Windows 树的存活核对：快照中过期的记录不算存活，权限错误不能冒充已退出', () => {
  const queried = [];
  const snapshot = procsOf([[100, 50], [110, 100], [120, 100], [130, 100], [200, 50]]);
  const remaining = treeAlive(100, {
    platform: 'win32', list: () => snapshot,
    kill: (pid, signal) => {
      queried.push([pid, signal]);
      if (pid === 100) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      if (pid === 120) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      if (pid === 130) throw Object.assign(new Error('unknown'), { code: 'EIO' });
    },
  });
  assert.deepEqual(remaining, [110, 120, 130], '只排除已确认退出的记录；树根死了也不漏还活着的孩子');
  assert.deepEqual(queried, [[100, 0], [110, 0], [120, 0], [130, 0]], '只做本树候选的无副作用存活查询');
});

test('HR30d Windows 核对先前观察的树：PID 重用不能冒充原进程，原孙进程仍活着时必须报出', () => {
  const observed = new Map([[100, { ppid: 50, born: 1000 }], [110, { ppid: 100, born: 1100 }]]);
  const replacement = new Map([[100, { ppid: 900, born: 2000 }], [110, { ppid: 100, born: 1100 }], [200, { ppid: 100, born: 2100 }]]);
  const queried = [];
  const options = { platform: 'win32', observed, list: () => replacement, kill: (pid, signal) => queried.push([pid, signal]) };
  assert.deepEqual(treeAlive(100, options), [110], '树根号已换人仍能认出原来活着的孙进程；新树不算本轮残留');
  assert.deepEqual(queried, [[110, 0]], '不查询替代进程的存活');
  replacement.set(110, { ppid: 100, born: 2200 });
  assert.deepEqual(treeAlive(100, options), [], '父孙号都被重用也不是原树残留');
  replacement.set(110, { ppid: 100 });
  assert.deepEqual(treeAlive(100, options), [110], '缺少创建时刻不能据此宣称没有残留');
  observed.get(110).born = undefined;
  replacement.set(110, { ppid: 100, born: 2200 });
  assert.deepEqual(treeAlive(100, options), [110], '原观察缺少创建时刻也不能宣称没有残留');
});

test('HR30e Windows 的新进程表空了或漏项：先前观察的成员仍要查存活，不把枚举失败当作退出', () => {
  const observed = new Map([[100, { ppid: 50, born: 1000 }], [110, { ppid: 100, born: 1100 }]]);
  const queried = [];
  const kill = (pid, signal) => {
    queried.push([pid, signal]);
    if (pid === 110) throw Object.assign(new Error('denied'), { code: 'EPERM' });
  };
  for (const current of [new Map(), new Map([[100, observed.get(100)]])]) {
    queried.length = 0;
    assert.deepEqual(treeAlive(100, { platform: 'win32', observed, list: () => current, kill }), [100, 110], '存活和权限不足的原成员都保留');
    assert.deepEqual(queried, [[100, 0], [110, 0]]);
  }
  assert.deepEqual(treeAlive(100, {
    platform: 'win32', observed, list: () => new Map(),
    kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
  }), [], '原成员都明确 ESRCH 才确认退出');
});

test('HR30 结束进程树（Linux）：后代与带记号的孤儿逐个 SIGKILL（连同各自的进程组），再扫一遍收掉新起的；Windows 上用 taskkill /T', () => {
  const sent = [];
  let pass = 0;
  const list = ({ token }) => {
    pass += 1;
    assert.equal(token, TOKEN, '查进程表时带着这棵树的记号');
    // 第一遍：工作进程 100、它的 vite 110、孤儿 200；第二遍：期间新起了一个 120（还带着记号）；第三遍没有了
    if (pass === 1) return procsOf([[1, 0], [100, 50], [110, 100], [200, 1, true]]);
    if (pass === 2) return procsOf([[1, 0], [120, 1, true]]);
    return procsOf([[1, 0]]);
  };
  const killed = killTree(100, { platform: 'linux', token: TOKEN, list, kill: (pid, sig) => { sent.push([pid, sig]); } });
  assert.deepEqual(killed, [100, 110, 120, 200]);
  assert.deepEqual(sent.filter(([p]) => p > 0).map(([p]) => p), [100, 110, 200, 120]);
  assert.ok(sent.some(([p, sig]) => p === -110 && sig === 'SIGKILL'), '各自的进程组也发（vite、Chrome 都是组长）');
  assert.ok(sent.every(([, sig]) => sig === 'SIGKILL'));

  // 只给记号（清上一轮留下的）：没有记号也没有 pid 时什么都不做
  pass = 0;
  assert.deepEqual(killTree(null, { platform: 'linux', token: TOKEN, list: () => procsOf([[1, 0], [200, 1, true]]), kill: () => {} }), [200]);
  assert.deepEqual(killTree(null, { platform: 'linux', token: '', list: () => { throw new Error('不该查'); }, kill: () => { throw new Error('不该杀'); } }), []);
  assert.deepEqual(killTree(null, { platform: 'linux', token: 'not-hex', list: () => { throw new Error('不该查'); } }), []);

  // Windows：taskkill /T /F；sync 时等它做完
  const win = [];
  killTree(4242, { platform: 'win32', spawn: (cmd, args, opts) => { win.push(['spawn', cmd, args, opts.windowsHide]); return new EventEmitter(); } });
  killTree(4242, { platform: 'win32', sync: true, spawnSync: (cmd, args, opts) => { win.push(['spawnSync', cmd, args, opts.windowsHide]); return {}; } });
  killTree(null, { platform: 'win32', spawn: () => { throw new Error('不该起'); } });
  assert.deepEqual(win, [['spawn', 'taskkill', ['/PID', '4242', '/T', '/F'], true], ['spawnSync', 'taskkill', ['/PID', '4242', '/T', '/F'], true]]);
});

test('HR30 清上一轮留下的：只清认得出是自己起的——Linux 按记下的记号；Windows 按记下的 pid 且命令行里确实是那个入口脚本；没有记录就不动', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hr30-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, 'worker-tree.json');
  // 没有记录、记录是坏的：什么都不清
  assert.deepEqual(sweepStaleTree(file, { platform: 'linux', list: () => { throw new Error('不该查'); } }), { swept: [], previous: null });
  fs.writeFileSync(file, '{oops');
  assert.deepEqual(sweepStaleTree(file, { platform: 'linux', list: () => { throw new Error('不该查'); } }).swept, []);

  fs.writeFileSync(file, JSON.stringify({ token: TOKEN, pid: 100, marker: 'C:\\repo\\scripts\\render-host.mjs', at: 1 }));
  // Linux：带那个记号的进程才清；pid 100 已经是别人的进程了（不带记号）也不碰
  const sent = [];
  const linux = sweepStaleTree(file, {
    platform: 'linux', kill: (pid) => { sent.push(pid); },
    list: ({ token }) => (token === TOKEN ? procsOf([[1, 0], [100, 1], [110, 1, true], [111, 110, true]]) : procsOf([])),
  });
  assert.deepEqual(linux.swept, [110, 111]);
  assert.equal(sent.includes(100), false, 'pid 被别人重用了：不带记号就不碰');

  // Windows：pid 还活着、命令行里有记下的入口脚本 → taskkill /T；命令行对不上（pid 被重用）→ 不碰；pid 不在了 → 不查
  const calls = [];
  const spawnSyncOf = (commandLine) => (cmd, args) => {
    calls.push(cmd);
    return cmd === 'powershell.exe' ? { stdout: commandLine } : {};
  };
  const ours = sweepStaleTree(file, { platform: 'win32', alive: () => true, spawnSync: spawnSyncOf('"C:\\node.exe" C:\\REPO\\scripts\\render-host.mjs --port 5400') });
  assert.deepEqual(ours.swept, [100]);
  assert.deepEqual(calls, ['powershell.exe', 'taskkill']);
  calls.length = 0;
  const reused = sweepStaleTree(file, { platform: 'win32', alive: () => true, spawnSync: spawnSyncOf('"C:\\Program Files\\Other\\app.exe" --something') });
  assert.deepEqual(reused.swept, []);
  assert.deepEqual(calls, ['powershell.exe'], '命令行对不上：不结束它');
  calls.length = 0;
  assert.deepEqual(sweepStaleTree(file, { platform: 'win32', alive: () => false, spawnSync: spawnSyncOf('x') }).swept, []);
  assert.deepEqual(calls, []);
  // 记录里没有入口脚本的记号：Windows 上不清
  fs.writeFileSync(file, JSON.stringify({ token: TOKEN, pid: 100, marker: '', at: 1 }));
  assert.deepEqual(sweepStaleTree(file, { platform: 'win32', alive: () => true, spawnSync: spawnSyncOf('anything') }).swept, []);
});

/** 假的子进程：记下起它时的参数；`exit(code)` 模拟它退出 */
function fakeSpawner() {
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.pid = 1000 + spawned.length;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.connected = false;
    proc.exit = (code = 0, signal = null) => proc.emit('exit', code, signal);
    spawned.push({ cmd, args, opts, proc });
    return proc;
  };
  return { spawn, spawned };
}

test('HR30 工作进程看护：每次起现生成记号放进环境、记进文件；起之前先清上一轮；kill 带着记号清整棵树；自己退出后按记号再清；不重起的模式', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hr30w-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const treeFile = path.join(tmp, 'data', 'worker-tree.json');
  const { spawn, spawned } = fakeSpawner();
  const order = [];
  const kills = [];
  const timers = [];
  const exits = [];
  const worker = createWorker({
    platform: 'linux', spawn, treeFile,
    command: () => { order.push('command'); return { cmd: 'node', args: ['/opt/x/scripts/render-host.mjs', '--port', '5400'], env: { KEEP: '1' }, cwd: '/opt/x' }; },
    sweep: (file) => { order.push('sweep'); assert.equal(file, treeFile); return { swept: order.filter((o) => o === 'sweep').length === 1 ? [] : [777] }; },
    killer: (pid, opts) => { kills.push({ pid, token: opts.token, sync: opts.sync === true }); return pid === null ? [901, 902] : []; },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return 0; },
    onExit: (info) => exits.push(info.reason),
    log: (event, fields) => order.push(`log:${event}${event === 'worker.orphans-killed' || event === 'worker.swept-stale' ? `:${fields.count}` : ''}`),
  });
  worker.start();
  assert.deepEqual(order.slice(0, 2), ['sweep', 'command'], '起之前先清上一轮留下的');
  const first = spawned[0];
  const token = first.opts.env[TREE_ENV];
  assert.match(token, /^[0-9a-f]{32}$/, '记号现生成，放进工作进程的环境');
  assert.equal(first.opts.env.KEEP, '1');
  assert.equal(first.opts.detached, true, '工作进程自成进程组');
  assert.equal(worker.treeToken, token);
  const rec = JSON.parse(fs.readFileSync(treeFile, 'utf8'));
  assert.deepEqual([rec.token, rec.pid, rec.marker], [token, 1000, '/opt/x/scripts/render-host.mjs'], '记号、树根 pid、入口脚本都记进文件');

  // 看护判死：带着记号清整棵树
  assert.equal(worker.kill('stalled'), true);
  assert.deepEqual(kills.at(-1), { pid: 1000, token, sync: false });
  // 进程退出：按记号再清一遍（不再按已经释放的 pid 找），清到的记日志
  first.proc.exit(null, 'SIGKILL');
  assert.deepEqual(kills.at(-1), { pid: null, token, sync: false });
  assert.ok(order.includes('log:worker.orphans-killed:2'));
  assert.deepEqual(exits, ['stalled']);
  // 退避后重起：又先清一遍上一轮的，换了新记号
  assert.equal(timers.length, 1);
  timers[0].fn();
  assert.equal(spawned.length, 2);
  assert.ok(order.includes('log:worker.swept-stale:1'));
  const token2 = spawned[1].opts.env[TREE_ENV];
  assert.notEqual(token2, token, '每次起换一个记号');
  assert.equal(JSON.parse(fs.readFileSync(treeFile, 'utf8')).token, token2);
  // 进程退出前的最后一步：同步清
  worker.killSync();
  assert.deepEqual(kills.at(-1), { pid: 1001, token: token2, sync: true });

  // Windows：进程退出后不按已经释放的 pid 去 taskkill（pid 可能已被别的进程重用）
  const winKills = [];
  const w = fakeSpawner();
  const win = createWorker({ platform: 'win32', spawn: w.spawn, command: () => ({ cmd: 'node', args: ['x'], env: {} }), killer: (pid) => { winKills.push(pid); return []; }, setTimer: () => 0 });
  win.start();
  w.spawned[0].proc.exit(1, null);
  assert.deepEqual(winKills, []);

  // 不重起的模式（隔离工作进程）：退出就完，回调照叫
  const once = fakeSpawner();
  const onceTimers = [];
  const got = [];
  const iso = createWorker({ platform: 'linux', spawn: once.spawn, restart: false, command: () => ({ cmd: 'node', args: ['x'], env: {} }), killer: () => [], setTimer: (fn, ms) => { onceTimers.push(ms); return 0; }, onExit: (info) => got.push(info.code) });
  iso.start();
  once.spawned[0].proc.exit(3, null);
  assert.deepEqual(got, [3]);
  assert.deepEqual(onceTimers, [], '不排重起');
  assert.equal(iso.running, false);
});

test('HR30 真的进程树：子进程再起一个自成进程组的孙进程（像工作进程起 Vite 那样），结束树根时孙进程一起没；按记号能找到它们', async (t) => {
  const token = randomBytes(16).toString('hex');
  const cleanupPipe = process.platform === 'win32' ? `\\\\.\\pipe\\pc-hr30-${token}` : path.join(os.tmpdir(), `pc-hr30-${token}.sock`);
  // 失败后的兜底由孙进程收到本轮口令后自行退出，不向可能已被重用的旧 PID 发 SIGKILL。
  const grandchild = `
    require('node:net').createServer((socket) => {
      let text = '';
      socket.on('data', (data) => { text += data; if (text === ${JSON.stringify(token)}) process.exit(0); });
    }).listen(${JSON.stringify(cleanupPipe)}, () => process.send('ready'));
  `;
  const parentSrc = `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    g.once('message', () => console.log('GRANDCHILD ' + g.pid));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', parentSrc], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, [TREE_ENV]: token } });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { if (err.code === 'ESRCH') return false; throw err; } };
  let grandPid = null;
  t.after(async () => {
    await new Promise((resolve) => {
      const socket = net.createConnection(cleanupPipe);
      socket.once('connect', () => socket.end(token));
      socket.once('error', () => socket.destroy()); // 树已退出时，管道不存在
      socket.once('close', resolve);
      socket.setTimeout(1000, () => socket.destroy());
    });
    // ChildProcess 保存本次启动的句柄；不用已经释放后可能换人的数值 PID。
    child.kill('SIGKILL');
    if (process.platform !== 'win32') fs.rmSync(cleanupPipe, { force: true });
  });
  grandPid = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (c) => { buf += c; const m = /GRANDCHILD (\d+)/.exec(buf); if (m) resolve(Number(m[1])); });
    child.once('exit', () => reject(new Error('父进程提前退出')));
    setTimeout(() => reject(new Error('等孙进程超时')), 15_000).unref();
  });
  assert.equal(alive(grandPid), true);
  const observed = listProcesses({ token });
  const tree = treeAlive(child.pid, { token, list: () => observed });
  assert.ok(tree.includes(child.pid) && tree.includes(grandPid), `进程表里找得到这棵树：${JSON.stringify(tree)}`);
  if (process.platform === 'win32') {
    assert.ok(Number.isFinite(observed.get(child.pid)?.born) && Number.isFinite(observed.get(grandPid)?.born), '本轮父孙的创建身份确实读到了');
  }
  if (process.platform === 'linux') {
    assert.ok(treePids(null, listProcesses({ token })).includes(grandPid), 'Linux 上只按记号也找得到（孙进程继承了环境）');
  }

  killTree(child.pid, { token });
  const until = Date.now() + 15_000;
  while ((alive(child.pid) || alive(grandPid)) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(child.pid), false, '树根没了');
  assert.equal(alive(grandPid), false, '自成进程组的孙进程也没了');
  assert.deepEqual(treeAlive(child.pid, { token, observed }).filter((p) => p === child.pid || p === grandPid), [], '本轮父孙身份都不再存活');
});

/* ------------------------------------------------------------------ HR31 */

test('HR31 启动自检走与工作进程同一条开页路径：开不了受帧控制的页就以 chrome-frame 失败，原因里有实际版本与期望版本；版本不同但走得通只告警', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hr31-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const config = { secretsDir: path.join(tmp, 'secrets'), dataDir: path.join(tmp, 'data') };
  const base = {
    nodeVersion: '24.21.0', readKey: () => ({ service: 'render', kid: 'KIDKIDKI', instanceId: 'instance-0000000001' }), checkDir: () => {},
    ffmpeg: () => ({ ok: true, h264: true, version: '6.1' }), cgroup: () => ({ ok: true }),
  };
  // 完整版 Chromium：起得来、普通页也开得了，但受帧控制的页开不了（Linux 容器里实测到的那条协议错误）
  const chromium = await runSelfcheck(config, {
    ...base,
    chrome: async () => ({
      ok: true, version: 'Chrome/141.0.7390.37', expected: '152.0.7977.75', cjk: true, noSandbox: 'root',
      frame: { ok: false, stage: 'open', detail: 'Protocol error (Target.createTarget): Target position can only be set for new windows' },
    }),
  });
  assert.equal(chromium.ok, false, '自检不过：管理进程以退出码 78 结束，不带病接活');
  const err = chromium.errors.find((e) => e.reason === 'chrome-frame');
  assert.ok(err, JSON.stringify(chromium.errors));
  assert.match(err.detail, /Chrome\/141\.0\.7390\.37/, '写出实际的版本');
  assert.match(err.detail, /chrome-headless-shell 152\.0\.7977\.75/, '写出期望的版本');
  assert.match(err.detail, /Target position can only be set for new windows/, '原样带上协议错误');
  assert.match(err.detail, /开页/);
  assert.equal(chromium.info.chromeFrame, 'failed:open');
  assert.equal(chromium.info.chromeExpected, '152.0.7977.75');
  assert.deepEqual(chromium.errors.map((e) => e.reason), ['chrome-frame'], '只报这一条（不连带报字体）');

  // 开得了页但出不了帧
  const noFrame = await runSelfcheck(config, { ...base, chrome: async () => ({ ok: true, version: 'HeadlessChrome/152.0.7977.75', expected: '152.0.7977.75', cjk: true, noSandbox: null, frame: { ok: false, stage: 'frame', detail: "'HeadlessExperimental.beginFrame' wasn't found" } }) });
  assert.match(noFrame.errors.find((e) => e.reason === 'chrome-frame').detail, /出帧.*beginFrame/);

  // 正是锁定的那一版：过，没有版本告警
  const pinned = await runSelfcheck(config, { ...base, chrome: async () => ({ ok: true, version: 'HeadlessChrome/152.0.7977.75', expected: '152.0.7977.75', cjk: true, noSandbox: null, frame: { ok: true, bytes: 2731 } }) });
  assert.equal(pinned.ok, true);
  assert.equal(pinned.info.chromeFrame, 'ok');
  assert.deepEqual(pinned.warnings.map((w) => w.reason), []);

  // 别的版本的 chrome-headless-shell：开页与出帧都行 → 只告警，照常起
  const other = await runSelfcheck(config, { ...base, chrome: async () => ({ ok: true, version: 'HeadlessChrome/150.0.1.2', expected: '152.0.7977.75', cjk: true, noSandbox: null, frame: { ok: true, bytes: 100 } }) });
  assert.equal(other.ok, true);
  assert.deepEqual(other.warnings.map((w) => w.reason), ['chrome-version']);
  assert.match(other.warnings[0].detail, /150\.0\.1\.2.*152\.0\.7977\.75/);

  // 探测没报 frame（旧形状的注入）：这一项不判，行为与原来相同
  const legacy = await runSelfcheck(config, { ...base, chrome: async () => ({ ok: true, version: 'v', cjk: true, noSandbox: null }) });
  assert.equal(legacy.ok, true);
  assert.equal('chromeFrame' in legacy.info, false);
});

test('HR31 工作进程的队列节点没起成（queue.skip）管理进程认得出原因，不静默', () => {
  assert.equal(queueSkipReason('[queue-node] queue.skip {"reason":"no-environment","profile":"host","message":"Protocol error (Target.createTarget): …"}'), 'no-environment');
  assert.equal(queueSkipReason('[queue-node] queue.skip reason=no-environment'), 'no-environment');
  assert.equal(queueSkipReason('[queue-node] queue.skip {"reason":"bad-shared-config"}'), 'bad-shared-config');
  assert.equal(queueSkipReason('[queue-node] queue.skip'), 'unknown');
  assert.equal(queueSkipReason('[queue-node] queue.started {"profile":"host"}'), null);
  assert.equal(queueSkipReason('[queue-node] queue.card-sync-skip {"reason":"disabled"}'), null, '卡片同步关着不是「节点没起成」');
  assert.equal(queueSkipReason('Error: Port 5730 is already in use'), null);
});
