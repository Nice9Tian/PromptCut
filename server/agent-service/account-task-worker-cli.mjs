import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAccountTaskWorker } from './account-task-worker.mjs';

// Private OS entry. Only root-owned local startup configuration supplies TLS,
// journal paths and the real read-control/Hosted assembly factory. IPC never
// contains private keys, pre-admitted grants or arbitrary callbacks/modules.
let worker = null, stopping = null, serial = Promise.resolve();
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const safeCode = error => typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(error.code)
  ? error.code : 'account-worker-unavailable';
const send = body => { if (process.connected) process.send(body); };
const close = () => stopping ??= (async () => { await worker?.close(); })();
try {
  if (!process.send || process.argv.length !== 4 || process.argv[2] !== '--configuration-module' || !path.isAbsolute(process.argv[3]))
    throw Object.assign(Error('entry configuration required'), { code: 'account-worker-entry-configuration' });
  const module = await import(pathToFileURL(process.argv[3]).href);
  if (typeof module.createWorkerConfiguration !== 'function') throw Object.assign(Error('entry configuration required'), { code: 'account-worker-entry-configuration' });
  const configuration = await module.createWorkerConfiguration();
  if (!exact(configuration, ['workerOptions', 'listener'])) throw Object.assign(Error('entry configuration required'), { code: 'account-worker-entry-configuration' });
  worker = createAccountTaskWorker(configuration.workerOptions);
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
      send({ type: 'result', id: message.id, ok: true, result });
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
