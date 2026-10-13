/**
 * 云端 Agent 的浏览器进程:怎么认「还活着」、怎么认「是不是我们的浏览器」(`server/web/hosted/session.mjs`)。
 * 跑:npm test -- server/test/cloud-tools-w1-process.test.mjs
 *
 * 不起浏览器。Linux 上才走得到的分支(读 /proc、进程组、锁文件)用注入的假 /proc 目录与假进程表在任何平台上验。
 *
 *   W1-PROC-01  僵尸按已退算:`/proc/<进程号>/stat` 的状态是 Z 的进程查得到但不算活着;进程名里带空格和括号也读得对
 *   W1-PROC-02  进程组:组里只剩僵尸 = 整棵树退了;还有一个活的(进程表里列不出来的 zygote)= 没退;组已经不在 = 退了;
 *               Windows 没有进程组,回「不知道」
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { procStat, pidLive, liveGroupMembers, browserGroupLive } from '../web/hosted/session.mjs';

/** 造一个假的 /proc:`{ 进程号: { comm, state, ppid, pgrp, cmdline? } }` */
export function fakeProc(t, table) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-w1-proc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [pid, p] of Object.entries(table)) {
    fs.mkdirSync(path.join(root, pid));
    fs.writeFileSync(path.join(root, pid, 'stat'), `${pid} (${p.comm ?? 'chrome'}) ${p.state ?? 'S'} ${p.ppid ?? 1} ${p.pgrp ?? pid} ${p.pgrp ?? pid} 0 -1 4194560 0 0 0 0\n`);
    if (p.cmdline) fs.writeFileSync(path.join(root, pid, 'cmdline'), `${p.cmdline.join('\0')}\0`);
  }
  for (const name of ['self', 'meminfo']) fs.writeFileSync(path.join(root, name), 'x');
  return root;
}

test('W1-PROC-01 僵尸按已退算', (t) => {
  const procRoot = fakeProc(t, {
    100: { comm: 'chrome-headless', state: 'S', pgrp: 100 },
    101: { comm: 'chrome) (evil S 1 1', state: 'Z', pgrp: 100 },   // 进程名里塞了括号和空格:从最后一个 ) 往后读
    102: { comm: 'chrome', state: 'R', pgrp: 100 },
    103: { comm: 'chrome', state: 'X', pgrp: 100 },
  });
  assert.deepEqual(procStat(100, { procRoot }), { state: 'S', pgrp: 100 });
  assert.deepEqual(procStat(101, { procRoot }), { state: 'Z', pgrp: 100 });
  assert.equal(procStat(999, { procRoot }), null);
  const alive = () => true;                                       // 「查得到」:僵尸也查得到
  assert.equal(pidLive(100, { platform: 'linux', procRoot, alive }), true);
  assert.equal(pidLive(101, { platform: 'linux', procRoot, alive }), false, '僵尸:查得到,但不算活着');
  assert.equal(pidLive(103, { platform: 'linux', procRoot, alive }), false);
  assert.equal(pidLive(102, { platform: 'linux', procRoot, alive }), true);
  assert.equal(pidLive(100, { platform: 'linux', procRoot, alive: () => false }), false, '查不到就是没了');
  assert.equal(pidLive(999, { platform: 'linux', procRoot, alive }), true, '查得到但读不了状态:不假称它退了');
  assert.equal(pidLive(101, { platform: 'win32', procRoot, alive }), true, 'Windows 没有僵尸这回事');
});

test('W1-PROC-02 进程组:只剩僵尸算退了,还有进程表里列不出来的活进程算没退', (t) => {
  const zombiesOnly = fakeProc(t, {
    200: { state: 'Z', pgrp: 200 },                               // 主进程:已死,还没被收走
    201: { comm: 'chrome_zygote', state: 'Z', pgrp: 200 },
    300: { comm: 'node', state: 'S', pgrp: 300 },                 // 别的组的活进程:不相干
  });
  const zygoteAlive = fakeProc(t, {
    201: { comm: 'chrome_zygote', state: 'S', pgrp: 200 },         // 主进程没了,zygote 还活着
    202: { state: 'Z', pgrp: 200 },
  });
  const groupThere = () => true;
  const groupGone = () => false;
  assert.deepEqual(liveGroupMembers(200, { procRoot: zombiesOnly }), []);
  assert.deepEqual(liveGroupMembers(200, { procRoot: zygoteAlive }), [201]);
  assert.deepEqual(liveGroupMembers(300, { procRoot: zombiesOnly }), [300]);
  assert.equal(liveGroupMembers(200, { procRoot: path.join(zombiesOnly, 'no-such-dir') }), null);

  assert.equal(browserGroupLive(200, { platform: 'linux', procRoot: zombiesOnly, group: groupThere }), false, '组还在(系统这么说),但全是僵尸:整棵树退了');
  assert.equal(browserGroupLive(200, { platform: 'linux', procRoot: zygoteAlive, group: groupThere }), true, 'zygote 还活着:没退');
  assert.equal(browserGroupLive(200, { platform: 'linux', procRoot: zygoteAlive, group: groupGone }), false, '系统说组已经不在:退了');
  assert.equal(browserGroupLive(200, { platform: 'darwin', procRoot: path.join(zombiesOnly, 'no-such-dir'), group: groupThere }), true, '读不了 /proc 而组还在:不假称退干净');
  assert.equal(browserGroupLive(200, { platform: 'win32', procRoot: zombiesOnly, group: groupThere }), null, 'Windows 没有进程组:不知道');
  assert.equal(browserGroupLive(0, { platform: 'linux', procRoot: zombiesOnly, group: groupThere }), null);
});
