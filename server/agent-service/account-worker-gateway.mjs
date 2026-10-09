import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { status: 503, code });
const entry = fileURLToPath(new URL('./account-task-worker-cli.mjs', import.meta.url));
/** Private gateway owns exactly the ChildProcess it creates. Root alone chooses
 * slots, publishes/binds assignments and proves original cgroup closure. A child
 * close/IPC result NEVER frees FIFO, certifies closed descendants or admits the
 * next message. No public HTTP route accepts these startup parameters. */
export function createAccountWorkerGateway({ configurationModule, cwd, env = process.env, timeoutMs = 10000 } = {}) {
  if (!path.isAbsolute(configurationModule ?? '') || !path.isAbsolute(cwd ?? '') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1) throw fail('worker-gateway-configuration');
  // Worker is a separate runtime, never another test runner/inspector inherited
  // from the master. Preserve process-only preload/config, not Node test IPC.
  const childEnv = { ...env }; delete childEnv.NODE_TEST_CONTEXT;
  const child = fork(entry, ['--configuration-module', configurationModule], { cwd, env: childEnv, execArgv: [],
    execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const pending = new Map(); let readyResolve, readyReject, closeResolve, stopped = false, fatal = null, stopping = null;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const closed = new Promise(resolve => { closeResolve = resolve; });
  const startup = setTimeout(() => { fatal ??= fail('worker-gateway-start-timeout'); readyReject(fatal); }, timeoutMs);
  void ready.catch(() => {});
  child.on('message', message => {
    if (message?.type === 'ready' && message.pid === child.pid && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) {
      clearTimeout(startup); readyResolve({ pid: message.pid, port: message.port });
    } else if (message?.type === 'failed') {
      fatal ??= fail(typeof message.code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(message.code) ? message.code : 'worker-gateway-failed');
      clearTimeout(startup); readyReject(fatal);
    } else if (message?.type === 'result' && pending.has(message.id)) {
      const owner = pending.get(message.id); pending.delete(message.id); clearTimeout(owner.timer);
      if (message.ok === true) owner.resolve(message.result);
      else owner.reject(fail(typeof message.code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(message.code) ? message.code : 'worker-gateway-failed'));
    }
  });
  child.once('error', () => { fatal ??= fail('worker-gateway-process'); readyReject(fatal); });
  child.once('close', (code, signal) => {
    clearTimeout(startup); stopped = true;
    const cause = fatal ?? fail('worker-gateway-process-closed'); readyReject(cause);
    for (const owner of pending.values()) { clearTimeout(owner.timer); owner.reject(cause); } pending.clear();
    closeResolve({ pid: child.pid ?? null, exitCode: code, signal, childClosed: true, rootClosureProved: false });
  });
  function request(operation, input) {
    if (fatal && operation !== 'close') return Promise.reject(fatal);
    if (stopped || !child.connected || (stopping && operation !== 'close')) return Promise.reject(fail('worker-gateway-closed'));
    const id = randomUUID();
    const work = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(fail('worker-gateway-request-timeout')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, operation, input }, error => { if (error) {
        const owner = pending.get(id); if (owner) { clearTimeout(owner.timer); pending.delete(id); reject(fail('worker-gateway-send')); }
      } });
    });
    void work.catch(() => {}); return work;
  }
  return { ready, closed, pid: () => child.pid,
    prepare: input => request('prepare', input), start: () => request('start', null),
    close() {
      if (stopping) return stopping;
      stopping = (async () => {
        let error;
        if (!stopped) { try { await request('close', null); } catch (cause) { error = cause; }
          // The child flushes ACK then closes its IPC. Keep observing real EOF
          // and ChildProcess close; never substitute exit for actual close.
        }
        let timer;
        const observed = await Promise.race([closed, new Promise((_, reject) => {
          timer = setTimeout(() => reject(fail('worker-gateway-actual-close-pending')), timeoutMs);
        })]).finally(() => clearTimeout(timer));
        if (error) throw error; if (observed.exitCode !== 0) throw fatal ?? fail('worker-gateway-close-failed');
        return observed;
      })();
      void stopping.catch(() => {}); return stopping;
    },
    describe: () => ({ pid: child.pid ?? null, childClosed: stopped, pendingCommands: pending.size, completionReady: false }),
  };
}
