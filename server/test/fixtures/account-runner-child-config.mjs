// 任务进程（子进程）的本机启动配置，只给 account-runner-process.test.mjs 用。
//
// 走的是生产的那份配置代码（`account-task-worker-config.mjs` 的 `buildWorkerConfiguration`），设置文件也是生产的形状：
// 真实的运行器（进程内 vite 载工具实现、到文档服务的项目数据连接、工具、看画面的客户端、运行素材的传输）。
// 只换了两处，都是这台机器做不了的：
//   - 读 root 写的这一代记录：生产要核文件属主是 root（只在 Linux 上），这里直接读夹具写的那份 JSON；
//   - 模型：用仓库里现成的模拟提供方（照用户消息里的脚本逐回合调工具、说话），不连真的模型服务、不用任何密钥。
import fs from 'node:fs';
import { buildWorkerConfiguration } from '../../agent-service/account-task-worker-config.mjs';

const fixture = JSON.parse(fs.readFileSync(process.env.PROMPTCUT_RUNNER_FIXTURE_SETTINGS, 'utf8'));
const note = (event, fields = {}) => {
  try { fs.appendFileSync(fixture.logFile, `${JSON.stringify({ at: Date.now(), pid: process.pid, event, ...fields })}\n`); } catch { /* 日志只为排查 */ }
};
process.on('uncaughtException', error => { note('child.uncaught', { message: String(error?.stack ?? error).slice(0, 2000) }); process.exit(70); });
process.on('unhandledRejection', error => { note('child.unhandled', { message: String(error?.stack ?? error).slice(0, 2000) }); });

export function createWorkerConfiguration() {
  note('child.configuration', { epoch: fixture.worker.reservation.epoch });
  return buildWorkerConfiguration(fixture.worker, {
    readRootRecord: async () => JSON.parse(fs.readFileSync(fixture.worker.rootRecordFile, 'utf8')),
    modelConfig: async () => ({ vendor: 'mock', model: 'scripted-local-response' }),
    log: (event, fields) => note(event, { code: fields?.code ?? null, reason: fields?.reason ?? null, status: fields?.status ?? null,
      path: fields?.path ?? null, blockedReason: fields?.blockedReason ?? null }),
  });
}
