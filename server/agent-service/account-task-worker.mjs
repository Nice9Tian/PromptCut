import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { certificateFingerprint } from '../account/client.mjs';
import { canonicalJson } from '../account/ledger.mjs';
import { validateAgentScopeExpected, validateAgentScopeReservation,
  validateAgentScopeRecord } from '../hosted/agent-run-scope-schema.mjs';
import { createRunClient } from './run-client.mjs';
import { createAccountExecutorAssembly } from './account-executor-assembly.mjs';

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
  scopePrepareSource = null, workerEventSource = null } = {}) {
  const e = validateAgentScopeExpected(expected), r = validateAgentScopeReservation(reservation, e);
  if (!identityTls?.key || !identityTls.cert || !identityTls.ca || typeof readRootRecord !== 'function')
    fail('account-worker-configuration');
  let fingerprint;
  try { fingerprint = certificateFingerprint(new X509Certificate(identityTls.cert).fingerprint256); }
  catch { fail('account-worker-identity-certificate'); }
  if (fingerprint !== e.serverFingerprint256) fail('account-worker-identity-certificate');
  const client = createRunClient({ ...doc, registrationPurpose: 'run-worker', scopePrepareSource, workerEventSource });
  let record = null, task = null, grant = null, assignment = null, admission = null, assembly = null, starting = null;
  let stopped = false, closing = null;
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
        await client.registerInstance();
        if (stopped) fail('account-worker-closed');
        grant = await client.admit(task);
        if (!grant || grant.projectId !== task.projectId || grant.conversationId !== task.conversationId ||
            grant.instanceId !== r.instanceId || binding.some(k => !ref(grant[k]))) fail('account-worker-grant');
        const result = await client.scopeAssignment({ ...Object.fromEntries(binding.map(k => [k, grant[k]])),
          requestId: `assignment:${grant.runGrantId}` });
        if (!['assigned-unbound', 'bound'].includes(result?.phase) || typeof result.executionAllowed !== 'boolean')
          fail('account-worker-assignment');
        client.bindScope({ expected: e, record, assignment: result.assignment }); assignment = result.assignment;
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
    if (!admission || starting || stopped) return Promise.reject(Object.assign(new Error('account-worker-not-prepared'), { status: 503 }));
    starting = (async () => {
    await admission; await assignmentReady(grant);
    if (stopped) fail('account-worker-closed');
    // All actual Hosted/SSR/model/tool options are trusted entry configuration.
    // No network route exposes these or changes the one admitted task.
    assembly = await createAccountExecutorAssembly({ ...options, doc, runClient: client, task,
      registrationScope: { expected: e, record }, assignmentReady });
    return assembly;
    })();
    void starting.catch(() => {});
    return starting;
  }
  const close = () => closing ??= (async () => {
    stopped = true;
    const observedSockets = [...sockets].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); }));
    const serverClosed = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
    const results = await Promise.allSettled([client.close(), serverClosed, ...observedSockets,
      admission?.catch(() => {}), Promise.resolve(starting).catch(() => {}).then(() => assembly?.close())]);
    const errors = results.filter(v => v.status === 'rejected').map(v => v.reason);
    if (errors.length) throw new AggregateError(errors, 'account-worker-close-pending');
  })();
  return { identity, prepareTask, startTask, assignmentReady, close,
    async listen({ port = 0, host = '127.0.0.1' } = {}) {
      if (stopped || server.listening || host !== '127.0.0.1' || !Number.isInteger(port) || port < 0 || port > 65535)
        fail('account-worker-listener');
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      return { port: server.address().port };
    },
    describe: () => ({ phase: stopped ? 'stopped' : assembly ? 'started' : assignment ? 'assigned-unbound' : 'identity',
      rootScopeRef: record ? { rootAuthorityId: e.authorityId, slotId: e.slotId, epoch: record.epoch } : null,
      taskSelected: task !== null, completionReady: false, identitySockets: sockets.size }),
  };
}
