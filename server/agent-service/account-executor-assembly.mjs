import path from 'node:path';
import { createHostedAgentService } from '../agent/service/create-agent-service.mjs';
import { createRunDataClient } from './run-data-client.mjs';
import { createRunResources } from '../agent/service/run-resources.mjs';
import { createRunControlServer } from './run-control.mjs';

const fail = code => { throw Object.assign(new Error(code), { status: 503, code }); };
const reference = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);

/** Account-only composition. All proofs use runClient's one OS-local RAM key.
 * Registering the current process never proves an older process has closed.
 * Missing resource/OS closure producers intentionally leave control RPCs pending.
 */
export async function createAccountExecutorAssembly({ dataDir, doc, runClient, conversationClient, readControl,
  controlPort, controlHost = '127.0.0.1', root, loadModule, modelConfig,
  readyTimeoutMs = 5000, resumeIntervalMs = 2000, runnerFactory = null,
  connectionsClosed = null, childrenClosed = null, childTreeWitness = null,
  task = null, registrationScope = null, assignmentReady = null, onTaskDrained = null, runEventsSink = null,
  log = () => {}, ...runnerOptions } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) ||
      !doc?.tls?.key || !doc.tls.cert || !doc.tls.ca || typeof doc.origin !== 'string' ||
      typeof doc.serverFingerprint256 !== 'string' || typeof runClient?.registerInstance !== 'function' ||
      typeof runClient.instanceIdentity !== 'function' || !readControl?.transports ||
      typeof readControl.start !== 'function' || typeof readControl.close !== 'function' ||
      conversationClient?.readTransports !== readControl.transports ||
      typeof root !== 'string' || typeof loadModule !== 'function' || typeof modelConfig !== 'function' ||
      !Number.isInteger(controlPort) || controlPort < 0 || controlPort > 65535 ||
      controlHost !== '127.0.0.1' || !Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0 ||
      !Number.isFinite(resumeIntervalMs) || resumeIntervalMs < 100)
    fail('account-executor-configuration');
  let service, dataClient, resources, controlServer, timer, resumeWork = null, stopped = false, closing = null;
  const controlSockets = new Set();
  const closeServer = async () => {
    if (!controlServer) return;
    const closed = [...controlSockets].map(socket => new Promise(resolve => {
      socket.once('close', resolve); socket.destroy();
    }));
    await Promise.all(closed);
    if (controlServer.listening) await new Promise(resolve => controlServer.close(resolve));
  };
  const close = () => closing ??= (async () => {
    stopped = true; clearInterval(timer);
    // Stop admission immediately, before awaiting a read stream or model drain.
    service?.runManager.close();
    const results = await Promise.allSettled([
      closeServer(), readControl.close(), dataClient?.close(), resources?.close(),
      Promise.resolve(resumeWork).catch(() => {}), service?.close(),
    ]);
    const errors = results.filter(row => row.status === 'rejected').map(row => row.reason);
    if (errors.length) throw new AggregateError(errors, 'account-executor-close-pending');
  })();
  try {
    if (task) {
      if (!registrationScope || typeof runClient.configureRegistrationScope !== 'function' ||
          typeof assignmentReady !== 'function' || typeof onTaskDrained !== 'function' || !runEventsSink)
        fail('account-worker-task-configuration');
      runClient.configureRegistrationScope(registrationScope);
    }
    const registered = await runClient.registerInstance(), identity = runClient.instanceIdentity();
    if (!identity || identity.serviceId !== 'agent' || !reference(identity.authorityId) ||
        !reference(identity.serviceKid) || !reference(identity.instanceId) ||
        !Number.isSafeInteger(identity.instanceGeneration) || identity.instanceGeneration < 1 ||
        identity.instanceId !== registered?.instanceId || identity.instanceGeneration !== registered.instanceGeneration)
      fail('account-executor-instance');
    await readControl.start();
    const deadline = Date.now() + readyTimeoutMs;
    while (readControl.describe().connected !== true) {
      if (Date.now() >= deadline) fail('account-executor-read-control');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    dataClient = createRunDataClient({ ...doc, runClient });
    resources = createRunResources({ runClient, ...(childTreeWitness ? { childTreeWitness } : {}) });
    service = createHostedAgentService({ ...runnerOptions, root, loadModule, modelConfig, dataDir,
      accountMode: true, requireAccountRunner: true, conversationClient, runClient, dataClient, resources,
      readIntentsFile: path.join(dataDir, 'run-read-intents.sqlite'),
      runEventsFile: path.join(dataDir, 'run-events.sqlite'), runEventsAuthorityId: identity.authorityId,
      serviceKid: identity.serviceKid, instanceId: identity.instanceId,
      runnerFactory, connectionsClosed, childrenClosed, task, assignmentReady, onTaskDrained, runEventsSink, log });
    controlServer = createRunControlServer({ tls: doc.tls, docFingerprint256: doc.serverFingerprint256,
      serviceKid: identity.serviceKid, instanceId: identity.instanceId, manager: service.runManager });
    controlServer.on('connection', socket => { controlSockets.add(socket);
      socket.once('close', () => controlSockets.delete(socket)); });
    await new Promise((resolve, reject) => { controlServer.once('error', reject);
      controlServer.listen(controlPort, controlHost, resolve); });
    const resume = () => {
      if (stopped || resumeWork || readControl.describe().connected !== true) return;
      const work = service.runManager.resumeQueued();
      resumeWork = work;
      void work.catch(error => log('agent.account.resume.pending', { code: error?.code ?? 'unavailable' }))
        .finally(() => { if (resumeWork === work) resumeWork = null; });
    };
    if (!task) { timer = setInterval(resume, resumeIntervalMs); timer.unref?.(); }
    resume();
    const taskWork = task ? resumeWork : null;
    return { service, dataClient, resources, identity: Object.freeze({ ...identity }),
      controlPort: controlServer.address().port, close,
      ...(task ? { taskWork } : {}),
      describe: () => ({ ...service.describe(), readControlConnected: readControl.describe().connected === true,
        runDataProofMounted: true, completionReady: false, controlSockets: controlSockets.size }) };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'account-executor-start-close-pending'); }
    throw error;
  }
}
