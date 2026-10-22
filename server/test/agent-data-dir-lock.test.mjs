// 〔裁〕H07：Agent 数据目录的独占锁（conversation-control-client.mjs 的 acquireDataDirLock）。退出确认收口一个「不在了」的实例，
// 凭的就是这把锁的这几条性质，这里逐条验：
// 1. 一个进程握着时，别的连接（同进程或别的进程）拿不到；
// 2. 握着它的进程被硬杀（不给它收口的机会），操作系统放开它，下一个拿得到；
// 3. 锁号存在锁文件里，放开再拿还是同一个（文档服务据它核「两个实例握的是同一把锁」）；
// 4. 锁文件被拷走另起一份，拷出来的那份换新锁号（拷出来的目录替不了原来那份里的实例交证据）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireDataDirLock } from '../agent-service/conversation-control-client.mjs';

test('数据目录独占锁：活着的握着就拿不到；硬杀以后拿得到；锁号不变', { timeout: 60_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-agent-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'reads.sqlite.owner');
  const first = acquireDataDirLock(file);
  assert.match(first.lockId, /^lock_[0-9a-f-]{36}$/);
  assert.throws(() => acquireDataDirLock(file), { code: 'read-control-owner-busy' }, '同一个进程里另一条连接也拿不到');
  first.release();
  const again = acquireDataDirLock(file);
  assert.equal(again.lockId, first.lockId, '放开再拿是同一个锁号');
  again.release();

  // 另一个进程握着它
  const moduleUrl = pathToFileURL(path.resolve('server/agent-service/conversation-control-client.mjs')).href;
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `const { acquireDataDirLock } = await import(${JSON.stringify(moduleUrl)});
     const lock = acquireDataDirLock(${JSON.stringify(file)}); process.stdout.write('held ' + lock.lockId + ' ');
     setInterval(() => {}, 1000);`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => holder.once('close', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL'); });
  let out = '', err = '';
  holder.stdout.on('data', bytes => { out += bytes; }); holder.stderr.on('data', bytes => { err += bytes; });
  const until = Date.now() + 20_000;
  while (!out.includes('held ')) {
    if (Date.now() > until || holder.exitCode !== null) throw Error(`lock holder did not start: ${out}${err}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(out.trim().split(' ')[1], first.lockId, '别的进程拿到的也是同一个锁号');
  assert.throws(() => acquireDataDirLock(file), { code: 'read-control-owner-busy' }, '别的进程活着握着：拿不到');
  // 硬杀它：它来不及做任何收口
  holder.kill('SIGKILL');
  await closed;
  let after = null;
  const deadline = Date.now() + 10_000;
  while (!after) {
    try { after = acquireDataDirLock(file); }
    catch (error) { if (error.code !== 'read-control-owner-busy' || Date.now() > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.equal(after.lockId, first.lockId);
  after.release();

  // 整个目录拷走另起一份：拷出来的锁文件不是同一份文件，锁号换新的；原来那份不变
  const copy = path.join(dir, 'copied', 'reads.sqlite.owner');
  fs.mkdirSync(path.dirname(copy)); fs.copyFileSync(file, copy);
  const copied = acquireDataDirLock(copy);
  assert.notEqual(copied.lockId, first.lockId, '拷出来的那份换了新锁号');
  copied.release();
  const original = acquireDataDirLock(file);
  assert.equal(original.lockId, first.lockId, '原来那份锁号不变');
  original.release();

  // 别的毛病（这里：锁文件的位置是个目录，打不开）不混成「有人握着」
  assert.throws(() => acquireDataDirLock(dir), err => err.code === 'read-control-owner-unavailable' && err.code !== 'read-control-owner-busy');
});
