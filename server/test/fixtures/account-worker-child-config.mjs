// 任务进程（子进程）的本机启动配置，只给 account-worker-lifecycle.test.mjs 用。
// 真的：独立的操作系统进程、它自己内存里的钥匙、到文档服务和主服务的双向 TLS、本机事件日志、
//       执行器的任务管理与每一步之前的权限闸、收尾记录与四步结算。
// 受控的：运行器。它不调模型、不跑 SSR、不连项目数据，只照消息里写的脚本走闸、发事件、等放行；
//         所以这份配置证明不了真实工具和模型在子进程里能跑。
import fs from 'node:fs';
import path from 'node:path';

const settings = JSON.parse(fs.readFileSync(process.env.PROMPTCUT_WORKER_FIXTURE_SETTINGS, 'utf8'));
const tls = name => ({ key: fs.readFileSync(path.join(settings.pkiDir, `${name}.key`)),
  cert: fs.readFileSync(path.join(settings.pkiDir, `${name}.crt`)), ca: fs.readFileSync(path.join(settings.pkiDir, 'ca.crt')) });
const mark = (name, value = {}) => fs.writeFileSync(path.join(settings.markerDir, name),
  JSON.stringify({ pid: process.pid, at: Date.now(), epoch: settings.reservation.epoch, ...value }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function scriptOf(content) {
  const found = /```script\n([\s\S]*?)\n```/.exec(String(content ?? ''));
  return found ? JSON.parse(found[1]) : [{ say: 'no script' }];
}

/** 照脚本走的运行器。每一步之前都过执行器给的闸（它去问文档服务这条任务现在还能不能做）。 */
async function scriptedRunner({ grant, record, onModelCall, beforeToolCall, onEvent }) {
  const steps = scriptOf(record.content); let aborted = false, done = null;
  const run = async () => {
    mark(`started-${record.messageId}`, { runId: grant.runId });
    onEvent({ type: 'run', runId: grant.runId });
    try {
      for (const step of steps) {
        if (aborted) return;
        if (step.say !== undefined) { await onModelCall(); onEvent({ type: 'text', delta: String(step.say) }); }
        else if (step.tool !== undefined) {
          await beforeToolCall();
          onEvent({ type: 'tool_call', name: String(step.tool), callId: `call-${step.tool}` });
          onEvent({ type: 'tool_result', name: String(step.tool), callId: `call-${step.tool}`, output: { hidden: true } });
        } else if (step.hold !== undefined) {
          // 像一次很长的模型调用：一直占着，直到测试放行；期间每隔一会儿过一次闸，被撤销就停。
          mark(`held-${step.hold}`, { runId: grant.runId });
          while (!aborted && !fs.existsSync(path.join(settings.markerDir, `release-${step.hold}`))) { await sleep(40); await onModelCall(); }
        } else if (step.crash !== undefined) process.exit(3);
        else if (step.fail !== undefined) { onEvent({ type: 'error', code: 'scripted-failure', message: String(step.fail) }); return; }
      }
      if (!aborted) onEvent({ type: 'done' });
    } catch (error) {
      onEvent({ type: 'error', code: typeof error?.code === 'string' ? error.code : 'scripted-error', message: 'gate rejected' });
    } finally { mark(`ended-${record.messageId}`, { runId: grant.runId, aborted }); }
  };
  return {
    async start() { done = run(); return { done, abort() { aborted = true; }, async drain() { aborted = true; await done; } }; },
    async drain() { aborted = true; await done; return { runId: grant.runId, dispatchesOpen: 0 }; },
    close() {},
  };
}

export function createWorkerConfiguration() {
  return { listener: { host: '127.0.0.1', port: settings.identityPort ?? 0 }, workerOptions: {
    expected: settings.expected, reservation: settings.reservation, identityTls: tls('asset'),
    doc: { origin: settings.docOrigin, tls: tls('wrong'), serverFingerprint256: settings.docFingerprint256 },
    readRootRecord: async () => JSON.parse(fs.readFileSync(path.join(settings.chainDir, `epoch-${settings.reservation.epoch}.json`), 'utf8')),
    eventSink: { file: settings.journalFile, origin: settings.masterOrigin, tls: tls('wrong'), serverFingerprint256: settings.masterFingerprint256 },
    createAssemblyOptions: async () => ({ dataDir: settings.dataDir, controlPort: 0, root: settings.dataDir,
      loadModule: async () => { throw new Error('controlled-runner-has-no-ssr'); },
      modelConfig: async () => ({ vendor: 'controlled' }), runnerFactory: scriptedRunner }),
  } };
}
