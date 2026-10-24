/**
 * `scripts/render-host.mjs` 退出时把整棵树收干净（2026-10-24 生产事故的回归测试）。
 *
 * 事故经过：等就绪超时那条路只 `killTree()`（结束编辑器那一个进程组）就 `process.exit(1)`，漏了 `sweepTree()`。
 * 而预渲染进程与它的 Chrome 各自是进程组的组长，收不到那个信号，于是每起一次工作进程就留下 14 个 Chrome。
 * 从 10-23 22:18 起每 4 分钟一轮，攒到 414 个，占掉 107 个 inotify 实例（`max_user_instances` 是 128），
 * Vite 建文件监听报 `EMFILE: too many open files` 当场退出，工作进程再也起不来，
 * 云端 Agent 的 `see_frames` 看画面连败（`iso-failed`），还漏了 10 GB 的临时 profile。
 *
 * 跑：npm test -- server/test/render-host-sweep.test.mjs（不起浏览器；RHS4 只在 Linux 上真起进程，几秒）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { finishTree } from '../../scripts/render-host.mjs';
import { killTree as killProcessTree, TREE_ENV } from '../hosted-render/worker.mjs';

const HOST_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'render-host.mjs');

test('RHS1 收尾两步都要做：先结束编辑器那一组，再按记号清逃出去的后代', async () => {
  const order = [];
  const never = new Promise(() => {}); // 编辑器不理 SIGTERM，赖着不走
  await finishTree({
    killTree: () => order.push('kill'),
    sweepTree: () => order.push('sweep'),
    exited: never,
    waitMs: 20,
  });
  // 事故就出在这里：当时只有 kill，没有 sweep。编辑器退不退都不影响——sweep 不是靠它退出来触发的
  assert.deepEqual(order, ['kill', 'sweep']);
});

test('RHS2 编辑器痛快退出时不白等满 waitMs', async () => {
  const order = [];
  const started = Date.now();
  await finishTree({
    killTree: () => order.push('kill'),
    sweepTree: () => order.push('sweep'),
    exited: Promise.resolve(0),
    waitMs: 10_000,
  });
  assert.deepEqual(order, ['kill', 'sweep']);
  assert.ok(Date.now() - started < 5_000, '编辑器已经退了就该立刻接着清，不该干等');
});

test('RHS3 三条退出路径都落到收尾：编辑器自己挂了 / 收到停止信号 / 等就绪超时', () => {
  const src = fs.readFileSync(HOST_SRC, 'utf8');
  // 这一条是源码形状的核对：上面两条只能证明 finishTree 本身对，证明不了那三条路都走了它。
  // 漏掉的恰恰是「某条路没调」，所以这里逐条按它们各自的特征行取出那一段来看。
  const sweeps = (text) => /finishTree\(|sweepTree\(\)/.test(text);

  const notReady = src.split('\n').find((line) => line.includes("say('not-ready'"));
  assert.ok(notReady, '找不到等就绪超时那条路了（改过名字？那就连同本测试一起改）');
  assert.ok(sweeps(notReady), '等就绪超时这条路没收尾——2026-10-24 漏的就是这里');

  const exitHandler = src.slice(src.indexOf("child.once('exit'"), src.indexOf('const shutdown'));
  assert.ok(exitHandler.includes("say('editor-exit'"), '取到的不是编辑器自己挂了那一段');
  assert.ok(sweeps(exitHandler), '编辑器自己挂了这条路没收尾');

  const shutdown = src.slice(src.indexOf('const shutdown'), src.indexOf("for (const signal of"));
  assert.ok(shutdown.includes("say('exit'"), '取到的不是收到停止信号那一段');
  assert.ok(sweeps(shutdown), '收到停止信号这条路没收尾');
});

test('RHS4 真的孤儿：带记号、自成进程组的后代，收尾之后没了', { skip: process.platform === 'win32' && 'Windows 上 killTree 用 taskkill /T 带走整棵树，不走记号这条路' }, async (t) => {
  const token = randomBytes(16).toString('hex');
  const flag = path.join(os.tmpdir(), `pc-rhs4-${token}.txt`);
  t.after(() => { try { fs.rmSync(flag, { force: true }); } catch { /* 已经没了 */ } });

  // 像预渲染进程那样：自成进程组（detached），父进程退了也活着，环境里带着本轮记号
  const orphan = spawn(process.execPath, ['-e', `
    require('node:fs').writeFileSync(${JSON.stringify(flag)}, String(process.pid));
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, [TREE_ENV]: token } });
  orphan.unref();

  for (let i = 0; i < 100 && !fs.existsSync(flag); i += 1) await delay(50);
  const pid = Number(fs.readFileSync(flag, 'utf8'));
  assert.ok(pid > 0, '孤儿没起来，测不了');
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(), true, '收尾之前它应该活着');

  // 这里的 killTree 故意什么都不做：模拟「只结束编辑器那一组，收不到它的后代」
  await finishTree({ killTree: () => {}, sweepTree: () => killProcessTree(null, { token }), exited: new Promise(() => {}), waitMs: 20 });

  for (let i = 0; i < 100 && alive(); i += 1) await delay(50);
  assert.equal(alive(), false, '按记号该把它清掉；清不掉就是当时那 414 个 Chrome 的来路');
});
