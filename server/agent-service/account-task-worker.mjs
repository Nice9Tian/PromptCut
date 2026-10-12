import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { certificateFingerprint } from '../account/client.mjs';
import { canonicalJson, digestOf } from '../account/ledger.mjs';
import { validateAgentScopeExpected, validateAgentScopeReservation,
  validateAgentScopeRecord } from '../hosted/agent-run-scope-schema.mjs';
import { createRunClient } from './run-client.mjs';
import { createAccountExecutorAssembly } from './account-executor-assembly.mjs';
import { createWorkerEventJournal } from './worker-event-journal.mjs';
import { createWorkerEventSink } from './worker-event-sink.mjs';
import { createWorkerSettlement, createTerminalPrepareSource } from './worker-settlement.mjs';

const fail = code => { throw Object.assign(new Error(code), { status: 503, code }); };
const ref = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const binding = ['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId'];

/** One OS worker owns this client and its non-exported RAM key. The root
 * reservation is trusted startup configuration, not a request body. The identity
 * endpoint is only for the separately pinned root-controller certificate.
 * Master scheduling never supplies an existing grant or signs on this OS's behalf.
 */
export function createAccountTaskWorker({ doc, expected, reservation, identityTls, readRootRecord,
  scopePrepareSource = null, workerEventSource = null, eventSink = null, createAssemblyOptions = null } = {}) {
  const e = validateAgentScopeExpected(expected), r = validateAgentScopeReservation(reservation, e);
  if (!identityTls?.key || !identityTls.cert || !identityTls.ca || typeof readRootRecord !== 'function')
    fail('account-worker-configuration');
  let fingerprint;
  try { fingerprint = certificateFingerprint(new X509Certificate(identityTls.cert).fingerprint256); }
  catch { fail('account-worker-identity-certificate'); }
  if (fingerprint !== e.serverFingerprint256) fail('account-worker-identity-certificate');
  if (eventSink && (workerEventSource !== null || typeof eventSink.file !== 'string')) fail('account-worker-event-configuration');
  if (createAssemblyOptions !== null && typeof createAssemblyOptions !== 'function') fail('account-worker-assembly-configuration');
  let journal = null, events = null;
  // 带本机事件日志时，准备签名只认日志里封存的收尾记录；调用方不能再另给一个来源。
  if (eventSink && scopePrepareSource !== null) fail('account-worker-event-configuration');
  const terminalSource = eventSink ? createTerminalPrepareSource({ readTerminal: () => {
    if (!events) fail('account-worker-event-unavailable'); return events.terminal();
  } }) : scopePrepareSource;
  const client = createRunClient({ ...doc, registrationPurpose: 'run-worker', scopePrepareSource: terminalSource,
    workerEventSource: eventSink ? packet => {
      if (!journal) fail('account-worker-event-unavailable'); return journal.source(packet);
    } : workerEventSource });
  let record = null, task = null, grant = null, assignment = null, admission = null, assembly = null, starting = null, waiting = null;
  let stopped = false, closing = null;
  // 正常结算的结果只有两种：拿到了文档服务的终态和本进程的意向，或者放弃（交给强制路径）。
  let settle, settlementState = 'none', taskEnded = null, driver = null;
  const settlement = new Promise(resolve => { settle = value => { if (settlementState === 'settled') return;
    settlementState = 'settled'; resolve(value); }; });
  const abandon = code => settle({ kind: 'abandoned', code });
  async function taskDrained(value, configured) {
    taskEnded = { drainState: value.drainState, eventFlushState: value.eventFlushState, cancelled: value.cancelled === true,
      outcome: value.outcome?.status ?? null };
    try {
      if (!value.drainRecord || !events) return abandon('run-drain-unavailable');
      // 先封存再结算：封存失败就没有可以签准备的来源，这条任务不走正常结算。
      await events.sealTerminal(value.drainRecord);
      driver = createWorkerSettlement({ runClient: client, readTerminal: () => events.terminal(),
        scope: { expected: e, record, assignment, grant }, stopped: () => stopped });
      settlementState = 'running';
      void driver.start().then(settle);
    } catch (error) { abandon(error?.code ?? 'run-drain-unavailable'); throw error; }
    finally { await configured?.(value); }
  }
  const sockets = new Set();
  const identity = () => {
    if (stopped) fail('account-worker-closed');
    const key = client.scopeIdentity();
    return { v: 1, serviceId: 'agent', authorityId: e.authorityId, slotId: e.slotId, epoch: r.epoch,
      instanceId: r.instanceId, pid: process.pid, publicKey: key.scopePublicKey, publicKeyDigest: key.scopePublicKeyDigest,
      clientFingerprint256: e.clientFingerprint256, serverFingerprint256: e.serverFingerprint256 };
  };
  const server = https.createServer({ ...identityTls, requestCert: true, rejectUnauthorized: true,
    minVersion: 'TLSv1.3' }, (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      if (req.method !== 'GET' || req.url !== '/internal/v2/agent/run-scope/identity')
        return reply(404, { ok: false, code: 'no-route' });
      if (req.socket.authorized !== true || certificateFingerprint(req.socket.getPeerCertificate()?.fingerprint256) !== e.clientFingerprint256 ||
          Object.keys(req.headers).some(k => k === 'forwarded' || k === 'x-real-ip' || k.startsWith('x-forwarded-')))
        return reply(403, { ok: false, code: 'account-worker-controller-forbidden' });
      // Exact original root publisher response: no PEM alias or request identity.
      reply(200, identity());
    } catch (error) { reply(error.status ?? 503, { ok: false, code: error.code ?? 'account-worker-unavailable' }); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  async function prepareTask(input) {
    if (stopped) fail('account-worker-closed');
    if (!exact(input, ['projectId', 'conversationId', 'requestId']) || Object.values(input).some(v => !ref(v)))
      fail('account-worker-task');
    if (task && canonicalJson(task) !== canonicalJson(input)) fail('account-worker-task-conflict');
    task ??= structuredClone(input);
    if (!admission) {
      admission = (async () => {
        // Root writes ready only after observing this process/key/real listener.
        record = validateAgentScopeRecord(await readRootRecord(), e);
        if (stopped || record.instance.instanceId !== r.instanceId || record.epoch !== r.epoch ||
            record.instance.pid !== process.pid) fail('account-worker-record');
        client.configureRegistrationScope({ expected: e, record });
        // 登记被文档服务明确拒绝时还没有发出过领取请求，这一代肯定没有任何任务授权，可以如实报「没领到」。
        try { await client.registerInstance(); }
        catch (error) {
          if (![403, 409].includes(error?.status)) throw error;
          return { noTask: true, stage: 'registration', code: typeof error.code === 'string' ? error.code : 'instance-registration-rejected' };
        }
        if (stopped) fail('account-worker-closed');
        // 文档服务明确说「现在没有可领的」（上一条还没结清、队列空了、对话不在了）：这一代进程没有领到任务，
        // 也没有产生任何授权，如实回给调度方去退掉这一代。回应不确定的情况不在这里，照旧抛出。
        let admitted;
        try { admitted = await client.admit(task); }
        catch (error) {
          if (![403, 404, 409].includes(error?.status)) throw error;
          return { noTask: true, stage: 'admission', code: typeof error.code === 'string' ? error.code : 'run-admit-rejected' };
        }
        if (admitted?.empty === true || admitted?.retry === true)
          return { noTask: true, stage: 'admission', code: admitted.empty === true ? 'run-queue-empty' : 'run-queue-retry' };
        grant = admitted;
        if (!grant || grant.projectId !== task.projectId || grant.conversationId !== task.conversationId ||
            grant.instanceId !== r.instanceId || binding.some(k => !ref(grant[k]))) fail('account-worker-grant');
        const result = await client.scopeAssignment({ ...Object.fromEntries(binding.map(k => [k, grant[k]])),
          requestId: `assignment:${grant.runGrantId}` });
        if (!['assigned-unbound', 'bound'].includes(result?.phase) || typeof result.executionAllowed !== 'boolean')
          fail('account-worker-assignment');
        client.bindScope({ expected: e, record, assignment: result.assignment }); assignment = result.assignment;
        if (eventSink) {
          journal = createWorkerEventJournal({ file: eventSink.file, authorityId: e.docAuthorityId,
            rootScopeRef: { rootAuthorityId: e.authorityId, slotId: e.slotId, epoch: record.epoch, recordDigest: digestOf(record) },
            assignmentDigest: digestOf(assignment), binding: { ...Object.fromEntries([...binding,
              'instanceId', 'instanceGeneration', 'serviceKid'].map(k => [k, grant[k]])), senderAccountId: grant.accountId } });
          events = createWorkerEventSink({ ...eventSink, journal, runClient: client,
            verifyGrant: current => client.checkAccess({ projectId: current.projectId, runGrantId: current.runGrantId, action: 'write' }) });
        }
        return { assignment: structuredClone(assignment), phase: result.phase, executionAllowed: result.executionAllowed };
      })();
      // Persisting/admitting is one-way in this OS. Unknown ACK is pending; a
      // second scheduling request cannot reset it and acquire another message.
      void admission.catch(() => {});
    }
    return admission;
  }
  async function assignmentReady(current) {
    if (stopped || !grant || binding.some(k => current?.[k] !== grant[k]) ||
        current.instanceId !== grant.instanceId || current.instanceGeneration !== grant.instanceGeneration)
      fail('account-worker-grant');
    const result = await client.scopeAssignment({ ...Object.fromEntries(binding.map(k => [k, grant[k]])),
      requestId: `assignment:${grant.runGrantId}` });
    if (stopped || result?.phase !== 'bound' || result.executionAllowed !== true ||
        canonicalJson(result.assignment) !== canonicalJson(assignment)) fail('account-worker-not-bound');
    return result;
  }
  function startTask(options = {}) {
    if (!admission || starting || stopped) return Promise.reject(Object.assign(new Error('account-worker-not-prepared'), { status: 503, code: 'account-worker-not-prepared' }));
    // All callers for this one task share the same pending bound check. A ready
    // epoch is not executable yet and may become bound later; that expected
    // rejection must not poison an OS that has never created an assembly.
    if (waiting) return waiting;
    const work = (async () => {
    if ((await admission)?.noTask) fail('account-worker-no-task');
    await assignmentReady(grant);
    if (stopped) fail('account-worker-closed');
    // All actual Hosted/SSR/model/tool options are trusted entry configuration.
    // No network route exposes these or changes the one admitted task.
    starting = (async () => {
      // The entry's private local configuration constructs current read control
      // and Hosted/SSR options with THIS process's client. Never accept this
      // callback or its result from an IPC/HTTP body or a master-provided grant.
      const configured = createAssemblyOptions ? await createAssemblyOptions({ runClient: client,
        runEventsSink: events, task: structuredClone(task), grant: structuredClone(grant) }) : options;
      if (stopped) fail('account-worker-closed');
      return createAccountExecutorAssembly({ ...configured, ...(events ? { runEventsSink: events } : {}), doc,
        runClient: client, task, registrationScope: { expected: e, record }, assignmentReady,
        onTaskDrained: value => taskDrained(value, configured.onTaskDrained) });
    })();
    // 任务没能走到收尾（没绑定、启动失败、运行器没建起来）就没有正常结算。
    void starting.then(value => Promise.resolve(value.taskWork).then(
      () => { if (settlementState === 'none') abandon('run-drain-unavailable'); },
      error => { if (settlementState === 'none') abandon(error?.code ?? 'account-worker-task-failed'); }),
      error => abandon(error?.code ?? 'account-worker-start-failed'));
    assembly = await starting;
    return assembly;
    })();
    waiting = work;
    void work.catch(() => {}).finally(() => { if (!starting && waiting === work) waiting = null; });
    return work;
  }
  const close = () => closing ??= (async () => {
    stopped = true; abandon('account-worker-closed');
    const observedSockets = [...sockets].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); }));
    const serverClosed = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
    const results = await Promise.allSettled([client.close(), serverClosed, ...observedSockets,
      admission?.catch(() => {}), Promise.resolve(waiting).catch(() => {}).then(() => assembly?.close())]);
    // Journal/transport cleanup is required even when admission or assembly
    // failed. Sink errors remain observable; no new receipt is invented here.
    results.push(...await Promise.allSettled([events ? events.close() : Promise.resolve().then(() => journal?.close())]));
    const errors = results.filter(v => v.status === 'rejected').map(v => v.reason);
    if (errors.length) throw new AggregateError(errors, 'account-worker-close-pending');
  })();
  return { identity, prepareTask, startTask, assignmentReady, close,
    /** 正常结算的结果。`normal` 带文档服务签的终态和本进程签的意向，只是「可以交给 root 去关」，不是任务已结束。 */
    settlement: () => settlement,
    async listen({ port = 0, host = '127.0.0.1' } = {}) {
      if (stopped || server.listening || host !== '127.0.0.1' || !Number.isInteger(port) || port < 0 || port > 65535)
        fail('account-worker-listener');
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      return { port: server.address().port };
    },
    describe: () => ({ phase: stopped ? 'stopped' : assembly ? 'started' : assignment ? 'assigned-unbound' : 'identity',
      rootScopeRef: record ? { rootAuthorityId: e.authorityId, slotId: e.slotId, epoch: record.epoch } : null,
      taskSelected: task !== null, completionReady: false, identitySockets: sockets.size,
      durableEventSinkMounted: events !== null, taskEnded: taskEnded ? { ...taskEnded } : null,
      settlement: driver ? driver.describe().state : settlementState === 'settled' ? 'abandoned' : 'none' }),
  };
}
