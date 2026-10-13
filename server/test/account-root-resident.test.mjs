import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// root 入口常驻起来以后必须一直在：槽都空着、主服务连不上的时候也不能自己退出。
// （它的定时器都是不拉住进程的那一种，又没有监听口；少了保活，它会在第一轮问完以后以退出码 0 退出，
//  而退出码 0 不会被 systemd 当成故障拉起——消息就永远排着。）
// 真的把常驻部分当独立进程起来看：见 fixtures/account-root-resident-entry.mjs 的说明。
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, 'fixtures', 'account-root-resident-entry.mjs');

test('root 入口常驻：槽空着、主服务连不上，十秒以后还活着、还在一轮一轮地问；叫它停才停，退出码 0', { timeout: 60_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-root-resident-')), stopFile = path.join(dir, 'stop');
  const child = spawn(process.execPath, [entry, stopFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '', errors = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', text => { output += text; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { errors += text; });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; fs.rmSync(dir, { recursive: true, force: true }); });
  const rows = () => output.split('\n').filter(Boolean).map(text => JSON.parse(text));
  const count = event => rows().filter(row => row.event === event).length;

  const started = Date.now();
  while (count('root.ready') === 0) {
    assert.equal(child.exitCode, null, `常驻部分没起来就退出了：${errors.slice(-400)}`);
    assert.ok(Date.now() - started < 20_000, '常驻部分没有在 20 秒内报 root.ready');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const readyAt = Date.now();
  // 空闲十秒以上
  await new Promise(resolve => setTimeout(resolve, 10_500));
  assert.equal(child.exitCode, null, `空闲 ${Date.now() - readyAt} 毫秒后进程自己退出了（退出码 ${child.exitCode}）`);
  assert.equal(child.signalCode, null);
  const ticksBefore = count('scheduler.tick.failed');
  assert.ok(ticksBefore >= 3, `十秒里至少问过三轮，实际 ${ticksBefore}`);
  // 还在接着问，不是停在那里
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.ok(count('scheduler.tick.failed') > ticksBefore, '还在一轮一轮地问');
  assert.equal(count('slot.opened'), 0, '没有人排队：没有开过任何进程');
  assert.equal(count('root.stopping'), 0);

  // 叫它停：Linux / macOS 上发 SIGTERM（生产上 systemd 就是这样停它）；Windows 上发不了，用标记文件走同一个停法
  if (process.platform === 'win32') fs.writeFileSync(stopFile, '1'); else child.kill('SIGTERM');
  const ended = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), 15_000))]);
  assert.deepEqual(ended, { code: 0, signal: null }, `叫停以后 15 秒内以退出码 0 退出；输出尾部 ${output.slice(-300)} ${errors.slice(-300)}`);
  assert.equal(count('root.stopping'), 1);
  assert.equal(count('root.close.failed'), 0);
  t.diagnostic(`空闲 ${Date.now() - readyAt} 毫秒，问了 ${count('scheduler.tick.failed')} 轮，pid ${child.pid}`);
});
