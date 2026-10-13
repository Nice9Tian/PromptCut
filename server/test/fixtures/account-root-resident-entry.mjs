// 只给 account-root-resident.test.mjs 用：把 root 入口**常驻的那一部分**当成一个独立进程起来。
//
// root 入口本身只在 Linux root 上跑（别的平台直接拒绝），所以这里不经它的命令行，直接调它导出的常驻部分
// （`startRootResident`、`installRootStop`——命令行入口在常驻那条路上调的就是这两个），给它：
//   - 一个一直空着的槽（没有任何一代、也没人排队，所以调度永远不会去开进程）；
//   - 一个连不上的主服务（每一轮问话都失败，日志里一轮一行 `scheduler.tick.failed`）。
// 这正是「节点上槽都空着」的样子：这个进程里没有监听口、没有长连接。
//
// 这个文件自己不放任何会拉住进程的东西：没有父子通道、不读标准输入；轮询停止标记的定时器是 unref 的。
// 进程能不能留下来，只看 root 入口常驻部分自己的保活。
import fs from 'node:fs';
import { startRootResident, installRootStop } from '../../agent-service/account-root-main.mjs';

const stopFile = process.argv[2];
const never = name => async () => { throw Object.assign(new Error(`idle slot must not ${name}`), { code: 'fixture-idle-slot' }); };
const idleSlot = { slotId: 'slot-idle', current: async () => null, open: never('open'), bind: never('bind'), close: never('close'),
  forcedClose: never('forcedClose'), retire: never('retire'), observeFailure: never('observeFailure') };
const master = {
  async pending() { throw Object.assign(new Error('master unreachable'), { status: 503, code: 'master-scheduler-unavailable' }); },
  async scopeControl() { throw Object.assign(new Error('master unreachable'), { status: 503, code: 'master-scheduler-unavailable' }); },
  close() {},
};
const started = await startRootResident({ adapters: [idleSlot], master, pollMs: 100 });
const stop = installRootStop(started);
// Windows 上给子进程发 SIGTERM 是直接结束它、走不到信号处理，所以测试在那里改用一个标记文件来叫它停；走的是同一个停法。
if (stopFile) setInterval(() => { if (fs.existsSync(stopFile)) stop(); }, 50).unref();
