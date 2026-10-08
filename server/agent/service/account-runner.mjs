import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createAgentInstance } from './instance.mjs';
import { createAccountConversationService } from './conversation-policy.mjs';
import { createWorkspaces } from './workspace.mjs';
import { createEgressGate } from './egress.mjs';
import { createHostedTools } from './hosted-tools.mjs';
import { createGate, limitsFileOf } from './gate.mjs';
import { createUsageLog } from './usage.mjs';
import { modelReady, pickModel } from './model-config.mjs';
import { openReadIntents } from './read-intents.mjs';
import { createAccountRunEvents } from './account-run-events.mjs';
import { canonicalReadRecord, acceptedMessageRef } from '../../account/run-authority.mjs';
import { canonicalJson } from '../../account/ledger.mjs';
import { PROTOCOL } from '../../auth/protocol.mjs';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const keyOf = (projectId, conversationId) => `${projectId}\n${conversationId}`;

/** Actual existing hosted Agent instance, one isolated instance per doc-owned run.
 * The doc-admitted grant binds this run's signed data connection; creator is never inferred.
 */
export function createExistingHostedRunnerFactory({ root, loadModule, dataClient, dataDir, modelConfig,
  assetBase = null, look = null, voiceConfig = async () => null, collect = null,
  egress: egressOptions = {}, workspaceLimits = {}, toolLimits = {}, toolFetch,
  now = Date.now, log = () => {} } = {}) {
  if (typeof root !== 'string' || typeof loadModule !== 'function' ||
    typeof dataClient?.wsUrl !== 'string' || !/^wss:\/\//.test(dataClient.wsUrl) ||
    typeof dataClient.webSocketFor !== 'function' ||
    typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof modelConfig !== 'function' ||
    typeof dataClient.openCount !== 'function') fail(503, 'account-runner-configuration');
  const usage = createUsageLog({ dir: path.join(dataDir, 'usage'), now, log });
  const gate = createGate({ limitsFile: limitsFileOf(dataDir), usage, now, log });
  const workspaces = createWorkspaces({ dataDir, limits: workspaceLimits, log });
  const egress = createEgressGate({ ...egressOptions, log });
  const hostedTools = createHostedTools({ root, loadModule, workspaces, egress, assetBase, voiceConfig, collect,
    ...(toolFetch ? { fetchImpl: toolFetch } : {}), limits: toolLimits, log,
    recordService: row => gate.record(row) });
  let lock = Promise.resolve();
  const execSerial = fn => { const work = lock.then(fn, fn); lock = work.catch(() => {}); return work; };
  return async ({ grant, record, onModelCall, beforeToolCall, onEvent = () => {}, signal }) => {
    if (!idOK(grant.projectId) || !idOK(grant.conversationId) || !idOK(grant.runId) ||
      grant.messageId !== record.messageId || grant.runId !== record.runId) fail(503, 'run-record-mismatch');
    let inst, DataWebSocket;
    let removeAbort = () => {};
    const aborted = new Promise((_, reject) => {
      if (!signal) return;
      const onAbort = () => {
        try { inst?.close('run-fenced'); } catch { /* Cleanup below still awaits the socket. */ }
        reject(Object.assign(new Error('run-fenced'), { status: 403, code: 'run-fenced' }));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbort = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
    });
    // Registration can be aborted before any phase starts. Attach a rejection
    // handler immediately; bind/ready may not have entered their race yet.
    void aborted.catch(() => {});
    try {
    if (signal?.aborted) fail(403, 'run-fenced');
    const cfg = await Promise.race([modelConfig(), aborted]);
    if (signal?.aborted) fail(403, 'run-fenced');
    if (!modelReady(cfg)) fail(503, 'no-model-key');
    const ownerKey = createHash('sha256').update(`account-v2\n${grant.projectId}\n${grant.conversationId}`).digest('hex').slice(0, 32);
    const dir = path.join(dataDir, 'tenants', grant.projectId, 'conversations', grant.conversationId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    DataWebSocket = dataClient.webSocketFor(grant);
    if (typeof DataWebSocket?.closeOwned !== 'function') fail(503, 'account-data-configuration');
    if (signal?.aborted) fail(403, 'run-fenced');
    const protocolsFor = async () => [PROTOCOL];
    // This binding is made only from the doc-admitted grant. Tool arguments and
    // page messages never choose the run or supply a selection snapshot.
    const accountSelection = Object.freeze({ projectId: grant.projectId, conversationId: grant.conversationId,
      runId: grant.runId, runGrantId: grant.runGrantId });
    inst = createAgentInstance({ profile: 'hosted', server: { httpServer: null, ssrLoadModule: loadModule,
      config: { root }, middlewares: { use() {} } },
      prerenderPost: look ? look.forProject(grant.projectId, { cards: () => inst.hasProjectCards?.() ? inst.cardRevs?.() : {} }) : null,
      latestMirror: () => null, latestPlayhead: () => null, projectId: grant.projectId,
      identity: { userId: grant.accountId, username: grant.initiatorName ?? record.senderNameAtSend }, ownerKey,
      hostedTools, docUrl: dataClient.wsUrl, protocolsFor, execSerial, accountMode: true, accountSelection,
      accountDataRequired: true, accountDataWebSocketImpl: DataWebSocket, initiatorOnline: () => false,
      pageCall: async () => ({ offline: true, why: 'initiator-unavailable' }),
      onFinalClose: () => { /* The next model/tool gate fails closed via doc. */ }, log });
      const binding = await Promise.race([inst.bindAgent({ projectId: grant.projectId, mode: 'hosted', signal }), aborted]);
      if (signal?.aborted) fail(403, 'run-fenced');
      // A signed welcome and current project.open reply must arrive before the
      // local read intent can move to execution-started or any model/tool call.
      binding.side.conversationNumber(grant.conversationId);
      await Promise.race([binding.side.link.ready(), aborted]);
      if (signal?.aborted) fail(403, 'run-fenced');
    let handle = null;
    return {
      async start() {
        if (handle) fail(409, 'runner-already-started');
        handle = inst.startHostedRun({ runId: grant.runId, conversationId: grant.conversationId,
          prompt: record.content, attachments: record.attachments,
          pageState: { selection: record.selectionSnapshot?.selection?.clipIds ?? [] },
          apiConfig: cfg, model: pickModel(cfg), historyFile: path.join(dir, 'history.json'),
          sessionKey: `account-v2-${grant.conversationId}`, onModelCall: async (phase, info) => {
            if (phase === 'before') {
              await onModelCall({ phase, info });
              const admitted = await gate.admitModelCall({ projectId: grant.projectId, userId: grant.accountId,
                model: pickModel(cfg) });
              if (admitted?.ok !== true) fail(429, admitted?.code ?? 'quota');
            } else {
              gate.record({ t: now(), projectId: grant.projectId, userId: grant.accountId,
                username: grant.initiatorName ?? record.senderNameAtSend, conversationId: grant.conversationId, runId: grant.runId,
                vendor: info?.vendor ?? cfg.vendor ?? '', model: info?.model ?? pickModel(cfg), input: info?.input ?? 0,
                output: info?.output ?? 0, cacheRead: info?.cacheRead ?? 0, ok: info?.ok !== false, ms: info?.ms ?? 0 });
            }
          }, beforeToolCall, onEvent });
        return handle;
      },
      async drain() { try { if (handle) await handle.drain(); }
        finally { removeAbort(); inst.close('run-drained'); await DataWebSocket.closeOwned(); }
        return { runId: grant.runId, dispatchesOpen: 0 }; },
      close() { removeAbort(); inst.close('run-finished'); },
    };
    } catch (error) {
      removeAbort();
      try { inst?.close('bind-failed'); } catch { /* The socket witness remains mandatory. */ }
      if (DataWebSocket) await DataWebSocket.closeOwned();
      throw error;
    }
  };
}

/** Durable queue consumer. A 202 send wakes work, but a run never starts until
 * the local FULL read-intent and doc receipt both commit. Unknown read ACK queries
 * the original request. execution-started work is never auto-replayed on restart.
 */
export function createAccountRunManager({ runClient, readIntents, runnerFactory, preflight = async () => true, serviceKid, instanceId,
  runEvents = null, resources = null, connectionsClosed = null, childrenClosed = null, now = Date.now, log = () => {} } = {}) {
  if (!runClient || ['admit', 'confirmRead', 'queryRead', 'checkAccess', 'finish', 'pending'].some(name => typeof runClient[name] !== 'function') ||
    !readIntents?.prepare || !readIntents?.confirm || !readIntents?.executeOnce || typeof runnerFactory !== 'function' ||
    typeof preflight !== 'function' || typeof serviceKid !== 'string' || !serviceKid ||
    typeof instanceId !== 'string' || !instanceId || (runEvents && typeof runEvents.writer !== 'function')) fail(503, 'account-runner-configuration');
  const waking = new Map(), active = new Map(), closedRuns = new Set(), listeners = new Set();
  // Same live Agent OS only: unknown doc ACKs keep the exact request/grant until
  // replay resolves them. A new OS cannot inherit an old instance's grant.
  const pending = new Map(), retryTimers = new Map(), retryDelay = new Map();
  let closed = false;
  const check = async (grant, action = 'write') => {
    const result = await runClient.checkAccess({ projectId: grant.projectId, runGrantId: grant.runGrantId, action });
    if (result?.allowed !== true || result.runGrant?.runGrantId !== grant.runGrantId || result.runGrant.runId !== grant.runId ||
      !['active', 'retained'].includes(result.runGrant.state)) fail(403, 'run-fenced');
    return result;
  };
  async function processGrant(grant, slot) {
    if (!grant?.message || grant.message.runId !== grant.runId || grant.message.messageId !== grant.messageId ||
      canonicalJson(acceptedMessageRef(grant.message, grant)) !== canonicalJson(grant.messageRef)) fail(503, 'run-record-mismatch');
    const prompt = canonicalReadRecord(grant.message, grant);
    const binding = Object.fromEntries(['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId'].map(key => [key, grant[key]]));
    const intent = readIntents.prepare({ requestId: `read:${grant.runGrantId}`, binding, prompt });
    const confirmed = await readIntents.confirm(intent.readIntentId, runClient);
    if (!['confirmed', 'execution-started', 'finished'].includes(confirmed.state) ||
        confirmed.receipt?.runGrantId !== grant.runGrantId) fail(503, 'read-confirmation-unknown');
    const local = readIntents.get(intent.readIntentId);
    if (local.state === 'execution-started') fail(503, 'run-execution-uncertain');
    if (local.state === 'finished') {
      if (runEvents) fail(503, 'run-outcome-unavailable');
      slot.grant = null; slot.finish = { ...binding, requestId: `finish:${grant.runGrantId}` }; return;
    }
    let settle;
    const entry = { grant, runner: null, handle: null, cancelled: false, done: null,
      cancelController: new AbortController(),
      completion: new Promise(resolve => { settle = resolve; }) };
    active.set(grant.runId, entry);
    let events = null;
    try {
      if (runEvents) {
        await runEvents.mirrorRunMessage({ grant });
        events = await runEvents.writer({ grant });
        // instance.mjs deliberately has a synchronous, exception-swallowing emit.
        // Never return an unobserved append promise to it: latch/abort here, and
        // every model/tool gate and completion boundary awaits the same queue.
        void events.failed.then(() => {
          entry.cancelled = true; entry.cancelController.abort();
          try { entry.handle?.abort(); } catch { /* drain remains mandatory */ }
        });
      }
      const context = resources ? await resources.contextFor({ projectId: grant.projectId, runGrantId: grant.runGrantId }) : null;
      entry.context = context;
      const gated = async () => {
        await events?.beforeCall();
        if (entry.cancelled || closed) fail(403, 'run-fenced');
        const result = await check(grant, 'write');
        if (context) await resources.authorize(context, 'write');
        await events?.beforeCall();
        if (entry.cancelled || closed) fail(403, 'run-fenced');
        return result;
      };
      const runner = await runnerFactory({ grant, record: prompt,
        onModelCall: gated, beforeToolCall: gated,
        ...(events ? { onEvent: event => events.emit(event?.type === 'done'
          ? { ...event, type: 'runner_done', settlement: 'pending' } : event) } : {}),
        signal: entry.cancelController.signal });
      entry.runner = runner;
      if (entry.cancelled) fail(403, 'run-fenced');
      await readIntents.executeOnce(intent.readIntentId, { authorize: gated, execute: async () => {
        if (entry.cancelled) fail(403, 'run-fenced');
        const handle = await runner.start(); entry.handle = handle;
        if (entry.cancelled) handle.abort();
        entry.done = Promise.resolve(handle.done);
        // Race persistence failure against the model promise, but always drain
        // the actual runner below. A rejected append cannot permit doc.finish.
        if (events) await Promise.race([entry.done, events.failed.then(error => { throw error; })]);
        else await entry.done;
        await events?.flush();
        // The current doc finish API unconditionally marks success. A resolved
        // model promise (including model/tool errors) is not an outcome receipt.
        // Keep this execution uncertain until its provider supplies settlement.
        if (events) fail(503, 'run-outcome-unavailable');
      } });
      // No later wake may call runner.start again. The next loop only retries the
      // deterministic finish request if its response is lost after doc commit.
      slot.grant = null;
      slot.finish = { ...binding, requestId: `finish:${grant.runGrantId}` };
    } finally {
      let drained = !entry.handle && !entry.runner;
      try {
        if (entry.runner?.drain) { await entry.runner.drain(); drained = true; }
        else if (entry.handle?.drain) { await entry.handle.drain(); drained = true; }
      }
      finally {
        // No emit may remain unobserved when the owned runner has drained.
        try { await events?.flush(); }
        finally {
          runnerClose(entry);
          active.delete(grant.runId); if (drained) closedRuns.add(grant.runId);
          settle();
        }
      }
    }
  }
  const runnerClose = entry => { try { entry.runner?.close(); } catch { /* Witness remains pending. */ } };
  function scheduleRetry(key, projectId, conversationId) {
    if (closed || retryTimers.has(key)) return;
    const delay = retryDelay.get(key) ?? 250;
    retryDelay.set(key, Math.min(delay * 2, 5_000));
    const timer = setTimeout(() => {
      retryTimers.delete(key);
      if (!closed) void wake(projectId, conversationId).catch(() => {});
    }, delay);
    timer.unref?.(); retryTimers.set(key, timer);
  }
  async function wake(projectId, conversationId) {
    if (closed) fail(503, 'account-runner-closed');
    const key = keyOf(projectId, conversationId);
    if (waking.has(key)) return waking.get(key);
    if (retryTimers.has(key)) { clearTimeout(retryTimers.get(key)); retryTimers.delete(key); }
    const slot = pending.get(key) ?? { admitRequestId: null, grant: null, finish: null };
    pending.set(key, slot);
    const work = (async () => {
      for (;;) {
        if (slot.finish) {
          await runClient.finish(slot.finish);
          slot.finish = null; retryDelay.delete(key);
          continue;
        }
        // Completing a read/execution already committed by this OS does not
        // require a fresh model configuration. New admissions still do.
        if (await preflight({ projectId, conversationId }) !== true) fail(503, 'no-model-key');
        if (slot.grant) { await processGrant(slot.grant, slot); continue; }
        slot.admitRequestId ??= `wake:${randomUUID()}`;
        const admitted = await runClient.admit({ projectId, conversationId, requestId: slot.admitRequestId });
        slot.admitRequestId = null;
        if (admitted?.empty) { pending.delete(key); retryDelay.delete(key); return; }
        if (admitted?.retry) continue;
        if (!admitted?.runGrantId || !admitted.message) fail(503, 'run-admit-protocol');
        slot.grant = admitted;
      }
    })();
    waking.set(key, work);
    try { return await work; }
    catch (error) {
      if (error?.status === 503 && !runEvents?.failure?.() &&
          !['run-execution-uncertain', 'run-outcome-unavailable', 'run-events-persistence'].includes(error?.code) &&
          (slot.admitRequestId || slot.grant || slot.finish)) scheduleRetry(key, projectId, conversationId);
      throw error;
    } finally { waking.delete(key); }
  }
  async function resumeQueued() {
    const listed = await runClient.pending();
    if (!Array.isArray(listed?.conversations)) fail(503, 'run-pending-protocol');
    const targets = new Map(listed.conversations.map(({ projectId, conversationId }) =>
      [keyOf(projectId, conversationId), { projectId, conversationId }]));
    for (const key of pending.keys()) {
      const [projectId, conversationId] = key.split('\n');
      targets.set(key, { projectId, conversationId });
    }
    await Promise.all([...targets.values()].map(({ projectId, conversationId }) => wake(projectId, conversationId)));
    return targets.size;
  }
  async function drainControl(control) {
    if (!control || !Array.isArray(control.operationFences)) fail(400, 'control-invalid');
    for (const callback of listeners) { try { callback({ projectId: control.projectId ?? null, userId: null,
      reason: control.kind, conversationId: control.scope?.conversationId ?? null }); } catch {} }
    const targets = [...new Set(control.operationFences.flatMap(row => row.runIds ?? []))];
    let oldInstanceUnknown = false;
    for (const runId of targets) {
      const entry = active.get(runId);
      if (!entry) { if (!closedRuns.has(runId)) oldInstanceUnknown = true; continue; }
      entry.cancelled = true; entry.cancelController.abort();
      try { entry.handle?.abort(); } catch {}
      // Resource abort begins synchronously with run cancellation; the existing
      // producer still must prove actual data sockets and the complete OS tree.
      const resourceClose = entry.context ? resources.abortForFence(entry.context, control.controlId) : null;
      const supervised = Promise.resolve(resourceClose); void supervised.catch(() => {});
      await entry.completion; await supervised;
    }
    const closedRunIds = targets.filter(id => closedRuns.has(id));
    const sockets = typeof connectionsClosed === 'function' ? await connectionsClosed({ control, instanceId, closedRunIds }) : false;
    const children = typeof childrenClosed === 'function' ? await childrenClosed({ control, instanceId, closedRunIds }) : false;
    return { serviceKid, instanceId, closedRunIds, dispatchesOpen: 0,
      connectionsOpen: sockets === true ? 0 : 1, childrenOpen: children === true ? 0 : 1, oldInstanceUnknown };
  }
  return { wake, resumeQueued, drainControl, onRevoke(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async idle() {
      const results = await Promise.allSettled([...waking.values()]);
      const errors = results.filter(row => row.status === 'rejected').map(row => row.reason);
      if (errors.length) throw new AggregateError(errors, 'account-runner-pending');
    },
    describe: () => ({ accountMode: true, instanceId, activeRuns: active.size, closedRuns: closedRuns.size,
      readIntents: readIntents.pending().length, pendingAdmissions: pending.size, runAuthorityMounted: true, at: now() }),
    close() { closed = true; for (const entry of active.values()) { entry.cancelled = true; entry.cancelController.abort();
        try { entry.handle?.abort(); } catch {} }
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear(); retryDelay.clear(); pending.clear(); listeners.clear(); } };
}

/** Public account-v2 service retains doc-owned HTTP ACL and adds the durable consumer. */
export function createAccountRunnerService({ conversationClient, runClient, readIntentsFile, runnerFactory,
  runEventsFile = null, runEventsAuthorityId = null,
  resources = null,
  serviceKid, instanceId, connectionsClosed, childrenClosed, now = Date.now, log = () => {}, ...runnerOptions } = {}) {
  if (typeof readIntentsFile !== 'string' || !path.isAbsolute(readIntentsFile)) fail(503, 'read-intent-configuration');
  const readIntents = openReadIntents({ file: readIntentsFile, now });
  let runEvents = null;
  try {
    // Legacy controlled runner fixtures can omit the event store. A real factory
    // must supply private persistent execution evidence; it never silently falls
    // back to the old conversation-owner store or a RAM-only event sink.
    if (!runnerFactory || runEventsFile) runEvents = createAccountRunEvents({ file: runEventsFile,
      authorityId: runEventsAuthorityId, now, verifyGrant: grant => runClient.checkAccess({
        projectId: grant.projectId, runGrantId: grant.runGrantId, action: 'write' }) });
    const factory = runnerFactory ?? createExistingHostedRunnerFactory({ ...runnerOptions, runClient, now, log });
    const preflight = runnerFactory ? async () => true : async () => modelReady(await runnerOptions.modelConfig());
    const manager = createAccountRunManager({ runClient, readIntents, runnerFactory: factory, preflight, serviceKid, instanceId,
      runEvents, resources, connectionsClosed, childrenClosed, now, log });
    const base = createAccountConversationService({ conversationClient, now });
    return { ...base, runManager: manager, runEvents,
      // Internal assembly seam only. A production caller must already own a
      // genuine conversation read-control invocation owned by HTTP/SSE.
      async mirrorAccepted(identity, conversationId) {
        if (!runEvents) fail(503, 'run-events-configuration');
        return runEvents.mirrorAccepted({ projectId: identity?.projectId, conversationId,
          read: () => base.conversation(identity, conversationId, 0) });
      },
      async send(identity, conversationId, body) {
        const response = await base.send(identity, conversationId, body);
        // The doc send response contains metadata, not the accepted original.
        // A failed read/commit propagates and never wakes a model from public body.
        if (runEvents) await runEvents.mirrorAccepted({ projectId: identity.projectId, conversationId,
          read: () => base.conversation(identity, conversationId, 0) });
        void manager.wake(identity.projectId, conversationId).catch(error => log('agent.account.run.pending',
          { projectId: identity.projectId, code: error?.code ?? 'unavailable' }));
        return response;
      },
      onRevoke: manager.onRevoke,
      describe: manager.describe,
      close() {
        manager.close();
        if (!runEvents) { readIntents.close(); return; }
        return manager.idle().finally(async () => { await runEvents.close(); readIntents.close(); });
      },
    };
  } catch (error) { if (runEvents) void runEvents.close(); readIntents.close(); throw error; }
}
