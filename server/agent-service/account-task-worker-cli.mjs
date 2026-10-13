import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAccountTaskWorker } from './account-task-worker.mjs';

// Private OS entry. Only root-owned local startup configuration supplies TLS,
// journal paths and the real read-control/Hosted assembly factory. Neither
// channel below carries private keys, pre-admitted grants or arbitrary callbacks/modules.
//
// 两种起法，指令的内容相同（领取、开跑、收尾，外加这个进程主动报的结算结果）：
//   node account-task-worker-cli.mjs --configuration-module <绝对路径>
//       由父进程 fork 出来，指令走 Node 的父子进程通道。没有父子通道直接退出。
//   node account-task-worker-cli.mjs --configuration-module <绝对路径> --control https
//       没有父进程通道也能起（systemd 起的就是这样）。指令走这个进程已有的那个只认 root 证书的本机 HTTPS 口
//       （`account-task-worker.mjs` 的 /internal/v2/agent/run-scope/control/*，客户端是 `account-worker-control-client.mjs`）。
//       起来以后往标准输出写一行 {"event":"worker.ready","pid":…,"port":…}；起不来往标准错误写一行 {"ok":false,"code":…}，退出码 1。
//       这两行只给人和日志看：root 认这个进程凭的是它自己对系统的观察和核身份的那个口，不凭这两行。
let worker = null, stopping = null, serial = Promise.resolve();
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const safeCode = error => typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(error.code)
  ? error.code : 'account-worker-unavailable';
const send = (body, callback) => { if (process.connected) process.send(body, callback); else callback?.(Error('ipc disconnected')); };
const close = () => stopping ??= (async () => { await worker?.close(); })();
const args = process.argv.slice(2);
const https = args.length === 4 && args[2] === '--control' && args[3] === 'https';
const entryError = () => Object.assign(Error('entry configuration required'), { code: 'account-worker-entry-configuration' });

async function configure(extra = {}) {
  const module = await import(pathToFileURL(args[1]).href);
  if (typeof module.createWorkerConfiguration !== 'function') throw entryError();
  const configuration = await module.createWorkerConfiguration();
  if (!exact(configuration, ['workerOptions', 'listener'])) throw entryError();
  // 指令通道开不开只由这个入口的起法定，配置模块改不了。
  worker = createAccountTaskWorker({ ...configuration.workerOptions, control: null, ...extra });
  return configuration;
}

if (https) {
  // ---------- 指令走本机 HTTPS ----------
  const line = (stream, value) => { try { stream.write(`${JSON.stringify(value)}\n`); } catch { /* 标准流已经关了 */ } };
  // 收完以后这个进程应当自己退出。真的退不掉（还有没关的句柄）时不拿「已退出」冒充「已关干净」：
  // 进程是不是关干净只认 root 对进程组的观察；这里只保证不无限期赖着。
  const leave = () => { void close().then(() => { process.exitCode ??= 0; }, () => { process.exitCode = 1; })
    .finally(() => { setTimeout(() => process.exit(process.exitCode ?? 1), 10_000).unref(); }); };
  try {
    if (!path.isAbsolute(args[1] ?? '') || args[0] !== '--configuration-module') throw entryError();
    const configuration = await configure({ control: { onClose: leave } });
    const listening = await worker.listen(configuration.listener);
    line(process.stdout, { event: 'worker.ready', pid: process.pid, port: listening.port });
  } catch (error) {
    line(process.stderr, { ok: false, code: safeCode(error) });
    await close().catch(() => {}); process.exitCode = 1;
  }
  process.on('SIGTERM', leave); process.on('SIGINT', leave);
} else {
  // ---------- 指令走父子进程通道 ----------
  try {
    if (!process.send || args.length !== 2 || args[0] !== '--configuration-module' || !path.isAbsolute(args[1])) throw entryError();
    const configuration = await configure();
    // 结算结果是这个进程主动报的唯一一件事：文档服务签的终态和本进程签的意向，或者「放弃」。
    // 两样都能被 root 独立验签，经手的调度方改不了；这条消息本身不让出名额、不代表进程已关。
    void worker.settlement().then(result => send({ type: 'event', name: 'settlement', result }));
    const listening = await worker.listen(configuration.listener);
    send({ type: 'ready', pid: process.pid, port: listening.port });
  } catch (error) {
    send({ type: 'failed', code: safeCode(error) });
    await close().catch(() => {}); process.exitCode = 1; process.disconnect?.();
  }
  process.on('message', message => {
    if (!exact(message, ['id', 'operation', 'input']) || typeof message.id !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(message.id)) return;
    const run = async () => {
      try {
        if (!worker || (stopping && message.operation !== 'close')) throw Object.assign(Error('closed'), { code: 'account-worker-closed' });
        let result;
        if (message.operation === 'prepare') result = await worker.prepareTask(message.input);
        else if (message.operation === 'start' && message.input === null) {
          const assembly = await worker.startTask();
          result = { started: true, completionReady: false, controlPort: assembly.controlPort };
        } else if (message.operation === 'close' && message.input === null) { await close(); result = { stopped: true, completionReady: false }; }
        else throw Object.assign(Error('unknown command'), { code: 'account-worker-command' });
        if (message.operation === 'close') {
          // Let the CHILD close its IPC after the ACK is flushed. Parent-side
          // disconnect can suppress the IPC EOF contribution to ChildProcess
          // close on the installed Node runtime; exit alone is insufficient.
          send({ type: 'result', id: message.id, ok: true, result }, error => {
            if (error) process.exitCode = 1; if (process.connected) process.disconnect();
          });
        } else send({ type: 'result', id: message.id, ok: true, result });
      } catch (error) { send({ type: 'result', id: message.id, ok: false, code: safeCode(error) }); }
    };
    // Stop can interrupt an owned pending network admission rather than waiting
    // behind it. Other commands retain one OS-local serial admission/start order.
    if (message.operation === 'close') void run();
    else { const work = serial.then(run); serial = work.catch(() => {}); }
  });
  process.on('disconnect', () => { void close().then(() => { process.exitCode ??= 0; }, () => { process.exitCode = 1; }); });
  process.on('SIGTERM', () => { void close().then(() => { process.exitCode ??= 0; process.disconnect?.(); }, () => {
    process.exitCode = 1; process.disconnect?.(); }); });
}
