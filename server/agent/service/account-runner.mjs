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
import { createRunDrainRecord } from '../../agent-service/worker-settlement.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createProjectAssets } from './project-assets.mjs';
import { WorkspaceError } from './workspace.mjs';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const keyOf = (projectId, conversationId) => `${projectId}\n${conversationId}`;

/** 运行素材导入时的额度。「项目素材」每读到一块就来问一次；这里一次导入只在第一块时看一次工作目录还剩多少
 * （`workspace.room()`，要同步扫两遍目录树），之后只做累计，超了照旧拒。大文件不会每一小块都去扫目录、堵住事件循环。
 *
 * 导入总要先在工作目录的 `.tmp/` 里落一份再上传。来源如果本来就是工作目录里的文件（用户的附件、下载下来的文件），
 * 它当初进工作目录时已经按额度核过、也已经算在占用里；临时的那一份上传完就删。这种来源不再按额度算第二遍——
 * 否则大于剩余额度一半的文件永远导不进去。只限它不超过声明的大小（源文件中途变大就拒）。〔裁〕代价是导入期间
 * 磁盘上短暂多出一份，最多一个单文件上限。来源是内存里现生成的字节（音效、配音）时，临时那一份就是唯一的一份，照额度算。
 * @param {() => { room(): number }} workspace 这条任务的对话工作目录
 */
export function createImportReservation(workspace) {
  const scope = new AsyncLocalStorage();
  return {
    /** 在一次导入的范围里跑 fn。`origin.inWorkspace`：来源已经是工作目录里的文件；`origin.size`：来源的大小（知道的话） */
    run(origin, fn) {
      const size = Number.isSafeInteger(origin?.size) && origin.size >= 0 ? origin.size : null;
      return scope.run({ counted: origin?.inWorkspace === true && size !== null, size, reserved: 0, room: null }, fn);
    },
    reserve(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new WorkspaceError('bad-path', '字节数不对');
      // 不在任何一次导入的范围里（不该发生）：按最保守的办，当场看一次
      const state = scope.getStore() ?? { counted: false, size: null, reserved: 0, room: null };
      if (state.room === null) {
        state.room = state.counted ? state.size : workspace().room();
        if (!state.counted && state.size !== null && state.size > state.room) throw new WorkspaceError('quota', '工作目录放不下这个文件');
      }
      state.reserved += bytes;
      if (state.reserved > state.room) throw new WorkspaceError('quota', state.counted ? '要导入的文件在导入过程中变大了' : '工作目录放不下这个文件');
    },
  };
}

/** Actual existing hosted Agent instance, one isolated instance per doc-owned run.
 * The doc-admitted grant binds this run's signed data connection; creator is never inferred.
 */
export function createExistingHostedRunnerFactory({ root, loadModule, dataClient, dataDir, modelConfig,
  assetBase = null, look = null, voiceConfig = async () => null, collect = null,
  egress: egressOptions = {}, workspaceLimits = {}, toolLimits = {}, toolFetch,
  resources = null, runAssets = null,
  now = Date.now, log = () => {} } = {}) {
  if (typeof root !== 'string' || typeof loadModule !== 'function' ||
    typeof dataClient?.wsUrl !== 'string' || !/^wss:\/\//.test(dataClient.wsUrl) ||
    typeof dataClient.webSocketFor !== 'function' ||
    typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof modelConfig !== 'function' ||
    typeof dataClient.openCount !== 'function') fail(503, 'account-runner-configuration');
  // 运行素材：这条任务凭自己的授权读写所在项目的素材。给了就必须配齐，缺一样直接拒绝，不退回成员票据那条旧路。
  if (runAssets !== null && (['issue', 'request', 'json'].some(name => typeof runAssets?.client?.[name] !== 'function') ||
      !Number.isSafeInteger(runAssets.maxImportBytes) || runAssets.maxImportBytes < 1 ||
      typeof resources?.contextAccess?.authorize !== 'function' || typeof resources.register !== 'function'))
    fail(503, 'account-runner-run-assets-configuration');
  // 看画面同理：账号模式下每个请求都要绑这条任务的授权（登记前、每趟去问前过授权闸，带任务号）。
  // 给了看画面的客户端而没有能问授权的 resources，直接拒绝；不退回不过闸、不带任务号的老路。
  if (look !== null && (typeof look?.forProject !== 'function' || typeof resources?.authorize !== 'function'))
    fail(503, 'account-runner-look-configuration');
  const usage = createUsageLog({ dir: path.join(dataDir, 'usage'), now, log });
  const gate = createGate({ limitsFile: limitsFileOf(dataDir), usage, now, log });
  const workspaces = createWorkspaces({ dataDir, limits: workspaceLimits, log });
  const egress = createEgressGate({ ...egressOptions, log });
  const hostedTools = createHostedTools({ root, loadModule, workspaces, egress, assetBase, voiceConfig, collect,
    ...(toolFetch ? { fetchImpl: toolFetch } : {}), limits: toolLimits, log,
    recordService: row => gate.record(row) });
  let lock = Promise.resolve();
  const execSerial = fn => { const work = lock.then(fn, fn); lock = work.catch(() => {}); return work; };
  return async ({ grant, record, onModelCall, beforeToolCall, onEvent = () => {}, signal, context = null }) => {
    if (!idOK(grant.projectId) || !idOK(grant.conversationId) || !idOK(grant.runId) ||
      grant.messageId !== record.messageId || grant.runId !== record.runId) fail(503, 'run-record-mismatch');
    // 看画面要绑的那条任务上下文必须是执行器给的、和这条授权对得上；没有就不开这一轮（不带着不过闸的看画面往下跑）
    if (look && (!context || context.projectId !== grant.projectId || context.runGrantId !== grant.runGrantId))
      fail(503, 'look-context-unavailable');
    let inst, DataWebSocket, projectAssets = null;
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
    // 「项目素材」只认执行器给的这条任务的上下文（由文档服务当前的任务授权算出），工具自己拿不到、也换不了。
    // 它名下的连接和流登记在同一个 resources 里，任务被下围栏时一起关。
    let accountRunAssets = null;
    if (runAssets) {
      if (!context || context.projectId !== grant.projectId || context.runGrantId !== grant.runGrantId)
        fail(503, 'run-assets-context-unavailable');
      const workspace = () => workspaces.open({ projectId: grant.projectId, ownerKey, conversationId: grant.conversationId });
      const reservation = createImportReservation(workspace);
      projectAssets = createProjectAssets({ contextAccess: resources.contextAccess, runAssetClient: runAssets.client,
        resources, workspace: async () => { const ws = workspace(); ws.dir(); return ws; }, maxImportBytes: runAssets.maxImportBytes,
        // 导入先落到这个对话的工作目录里再上传，所以额度就是工作目录原有的那几条上限〔裁〕；怎么算见 createImportReservation
        reserveImport: async (_context, bytes) => { reservation.reserve(bytes); } });
      accountRunAssets = Object.freeze({
        authorizeWrite: () => resources.authorize(context, 'write'),
        import: (source, options, origin = {}) => reservation.run(origin, () => projectAssets.import(context, source, options)),
        openRead: (mediaId, options) => projectAssets.openRead(context, mediaId, options),
      });
    }
    inst = createAgentInstance({ profile: 'hosted', server: { httpServer: null, ssrLoadModule: loadModule,
      config: { root }, middlewares: { use() {} } },
      // 这一轮被停掉(signal)时,它排在渲染服务队列里的看画面请求一并撤回,不占着队列、不在失权之后还出图
      // 看画面绑这条任务的授权:项目号来自授权;登记前、每趟去问前都问一次文档服务这条任务还能不能读
      prerenderPost: look ? look.forProject(grant.projectId, { cards: () => inst.hasProjectCards?.() ? inst.cardRevs?.() : {}, signal: signal ?? null,
        authorize: () => resources.authorize(context, 'read'), instance: grant.instanceId,
        run: { runGrantId: grant.runGrantId, runId: grant.runId, conversationId: grant.conversationId } }) : null,
      latestMirror: () => null, latestPlayhead: () => null, projectId: grant.projectId,
      identity: { userId: grant.accountId, username: grant.initiatorName ?? record.senderNameAtSend }, ownerKey,
      hostedTools, docUrl: dataClient.wsUrl, protocolsFor, execSerial, accountMode: true, accountSelection,
      accountDataRequired: true, accountDataWebSocketImpl: DataWebSocket, initiatorOnline: () => false,
      ...(accountRunAssets ? { accountRunAssets } : {}),
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
      async drain() {
        try { if (handle) await handle.drain(); }
        finally {
          // 素材的连接和流也是本机资源：等它们真的关完才算收完，收尾记录在这之后才形成。
          // 关不干净就抛出去，执行器据此不形成收尾记录，这条任务只能由强制路径收口。
          try { await projectAssets?.close(); }
          finally { removeAbort(); inst.close('run-drained'); await DataWebSocket.closeOwned(); }
        }
        return { runId: grant.runId, dispatchesOpen: 0 }; },
      close() { removeAbort(); inst.close('run-finished'); },
    };
    } catch (error) {
      removeAbort();
      try { inst?.close('bind-failed'); } catch { /* The socket witness remains mandatory. */ }
      try { await projectAssets?.close(); } catch { /* Registered resources stay owned by resources.abortForFence. */ }
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
  runEvents = null, resources = null, connectionsClosed = null, childrenClosed = null,
  task = null, assignmentReady = null, onTaskDrained = null, now = Date.now, log = () => {} } = {}) {
  if (!runClient || ['admit', 'confirmRead', 'queryRead', 'checkAccess', 'finish', 'pending'].some(name => typeof runClient[name] !== 'function') ||
    !readIntents?.prepare || !readIntents?.confirm || !readIntents?.executeOnce || typeof runnerFactory !== 'function' ||
    typeof preflight !== 'function' || typeof serviceKid !== 'string' || !serviceKid ||
    typeof instanceId !== 'string' || !instanceId || (runEvents && typeof runEvents.writer !== 'function')) fail(503, 'account-runner-configuration');
  const selectedTask = task ? structuredClone(task) : null;
  if (selectedTask && (Object.keys(selectedTask).sort().join(',') !== 'conversationId,projectId,requestId' ||
      Object.values(selectedTask).some(value => typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) ||
      typeof assignmentReady !== 'function' || typeof onTaskDrained !== 'function' || !runEvents?.writer))
    fail(503, 'account-worker-task-configuration');
  // 一条任务一个进程时，任务做完的结果由这个进程自己形成并交给它的主人去结算；
  // 旧的多任务路径没有结算方，仍然不给结果（下面照旧抛 run-outcome-unavailable）。
  let taskConsumed = false;
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
    if (selectedTask) {
      if (grant.projectId !== selectedTask.projectId || grant.conversationId !== selectedTask.conversationId ||
          grant.serviceKid !== serviceKid || grant.instanceId !== instanceId) fail(403, 'account-worker-task-binding');
      // Admission alone is not execution authority. The private worker gate
      // waits for the Doc/root bound publication before preparing read intent.
      const bound = await assignmentReady(structuredClone(grant));
      if (closed) fail(503, 'account-runner-closed');
      if (bound?.executionAllowed !== true || bound?.phase !== 'bound' ||
          ['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId', 'serviceKid', 'instanceId', 'instanceGeneration']
            .some(k => bound.assignment?.target?.[k] !== grant[k])) fail(503, 'account-worker-assignment-pending');
    }
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
    let events = null, eventsFailed = false;
    // 终态只看这个进程真的看到的事：运行器有没有说做完、有没有报错、是不是被叫停。
    const seen = { done: false, error: false, terminal: false };
    try {
      if (runEvents) {
        await runEvents.mirrorRunMessage({ grant });
        events = await runEvents.writer({ grant });
        if (selectedTask && typeof events.receiptOf !== 'function') fail(503, 'account-worker-task-configuration');
        // instance.mjs deliberately has a synchronous, exception-swallowing emit.
        // Never return an unobserved append promise to it: latch/abort here, and
        // every model/tool gate and completion boundary awaits the same queue.
        void events.failed.then(() => {
          eventsFailed = true; entry.cancelled = true; entry.cancelController.abort();
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
      const runner = await runnerFactory({ grant, record: prompt, context,
        onModelCall: gated, beforeToolCall: gated,
        ...(events ? { onEvent: event => {
          if (!selectedTask) return void events.emit(event?.type === 'done'
            ? { ...event, type: 'runner_done', settlement: 'pending' } : event);
          // 终态事件发出以后不再接事件：它必须是这条任务的最后一条。
          if (seen.terminal) return;
          if (event?.type === 'done') { seen.done = true; return; }
          if (event?.type === 'error') seen.error = true;
          events.emit(event);
        } } : {}),
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
        let rejected = false;
        try {
          if (events) await Promise.race([entry.done, events.failed.then(error => { throw error; })]);
          else await entry.done;
        } catch (error) {
          // 事件没能落盘就没有可信的终态；运行器自己失败则是一个真实的「失败」结果。
          if (!selectedTask || eventsFailed) throw error;
          rejected = true;
        }
        if (selectedTask) {
          // 这一条就是终态事件。主服务持久确认它以后，才有可以交给文档服务的结果。
          const status = entry.cancelled ? 'interrupted' : rejected || seen.error || !seen.done ? 'failed' : 'done';
          seen.terminal = true;
          const eventId = events.emit({ type: 'runner_done', settlement: 'pending', outcome: status });
          await events.flush();
          const receipt = eventId ? await events.receiptOf(eventId) : null;
          if (!receipt) fail(503, 'run-outcome-unavailable');
          entry.outcome = Object.freeze({ v: 1, status, eventId: receipt.eventId, eventDigest: receipt.eventDigest });
          return;
        }
        await events?.flush();
        // The legacy doc finish API unconditionally marks success. A resolved
        // model promise (including model/tool errors) is not an outcome receipt.
        // Without a settlement owner this execution stays uncertain.
        if (events) fail(503, 'run-outcome-unavailable');
      } });
      // No later wake may call runner.start again. The next loop only retries the
      // deterministic finish request if its response is lost after doc commit.
      slot.grant = null;
      // 单任务进程不走旧的结束接口：结算由收尾记录的主人按「结束、准备、终态、意向」去做。
      slot.finish = selectedTask ? null : { ...binding, requestId: `finish:${grant.runGrantId}` };
    } finally {
      let drained = !entry.handle && !entry.runner;
      try {
        if (entry.runner?.drain) { await entry.runner.drain(); drained = true; }
        else if (entry.handle?.drain) { await entry.handle.drain(); drained = true; }
      }
      finally {
        // No emit may remain unobserved when the owned runner has drained.
        let eventFlushState = 'failed';
        try { await events?.flush(); eventFlushState = 'durable'; }
        finally {
          let closeError = null;
          if (selectedTask) {
            try { await entry.runner?.close(); }
            catch (error) { closeError = error; drained = false; }
          } else runnerClose(entry);
          try {
            if (selectedTask) {
              // This local observation is not a root/OS closure receipt and does
              // not settle Doc outcome/FIFO. The owner must preserve that boundary.
              // 三样都成立才有收尾记录：终态事件已被持久确认、运行器真的收完、最后一次落盘成功。
              // 缺任何一样都只报告状态，不形成记录，这条任务只能由强制路径收口。
              const outcome = entry.outcome ?? null;
              const drainRecord = outcome && drained && eventFlushState === 'durable' && !closeError
                ? createRunDrainRecord({ grant, readReceiptId: confirmed.receipt.receiptId, outcome }) : null;
              await onTaskDrained({ grant: structuredClone(grant), readReceiptId: confirmed.receipt.receiptId,
                drainState: drained ? 'local-drained' : 'unknown', eventFlushState, cancelled: entry.cancelled,
                outcome: outcome ? structuredClone(outcome) : null, drainRecord: drainRecord ? structuredClone(drainRecord) : null });
            }
            if (closeError) throw closeError;
          } catch (error) {
            if (closeError && error !== closeError) throw new AggregateError([closeError, error], 'account-worker-drain-pending');
            throw error;
          } finally {
            active.delete(grant.runId); if (drained) closedRuns.add(grant.runId);
            if (selectedTask) taskConsumed = true;
            settle();
          }
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
    if (selectedTask && (projectId !== selectedTask.projectId || conversationId !== selectedTask.conversationId))
      fail(403, 'account-worker-task-binding');
    if (selectedTask && taskConsumed) fail(503, 'account-worker-task-consumed');
    const key = keyOf(projectId, conversationId);
    if (waking.has(key)) return waking.get(key);
    if (retryTimers.has(key)) { clearTimeout(retryTimers.get(key)); retryTimers.delete(key); }
    const slot = pending.get(key) ?? { admitRequestId: null, grant: null, finish: null };
    pending.set(key, slot);
    const work = (async () => {
      for (;;) {
        if (slot.finish) {
          if (selectedTask) fail(503, 'run-outcome-unavailable');
          await runClient.finish(slot.finish);
          slot.finish = null; retryDelay.delete(key);
          continue;
        }
        // Completing a read/execution already committed by this OS does not
        // require a fresh model configuration. New admissions still do.
        if (await preflight({ projectId, conversationId }) !== true) fail(503, 'no-model-key');
        if (slot.grant) { await processGrant(slot.grant, slot); if (selectedTask) return; continue; }
        slot.admitRequestId ??= selectedTask?.requestId ?? `wake:${randomUUID()}`;
        const admitted = await runClient.admit({ projectId, conversationId, requestId: slot.admitRequestId });
        slot.admitRequestId = null;
        if (admitted?.empty) { pending.delete(key); retryDelay.delete(key); if (selectedTask) taskConsumed = true; return; }
        if (admitted?.retry) continue;
        if (!admitted?.runGrantId || !admitted.message) fail(503, 'run-admit-protocol');
        slot.grant = admitted;
      }
    })();
    waking.set(key, work);
    try { return await work; }
    catch (error) {
      if (!selectedTask && error?.status === 503 && !runEvents?.failure?.() &&
          !['run-execution-uncertain', 'run-outcome-unavailable', 'run-events-persistence'].includes(error?.code) &&
          (slot.admitRequestId || slot.grant || slot.finish)) scheduleRetry(key, projectId, conversationId);
      throw error;
    } finally { waking.delete(key); }
  }
  /** 单任务进程：领取、等绑定、已读确认这几步都是凭固定请求号可以原样重发的。文档服务一时答不上（503）就退避重试，
   * 不把一次暂时性故障变成「这条任务再也不会做、也结不了」。已读确认之后（事件通道已经建起来、运行器可能已经开跑）不重试：
   * 那以后只有一次执行，失败如实记成失败或交给强制路径。 */
  async function resumeTask() {
    const key = keyOf(selectedTask.projectId, selectedTask.conversationId);
    for (let delay = 250; ; delay = Math.min(delay * 2, 5_000)) {
      try { return await wake(selectedTask.projectId, selectedTask.conversationId); }
      catch (error) {
        const slot = pending.get(key);
        if (closed || taskConsumed || error?.status !== 503 || runEvents?.failure?.() ||
            // 这几种不是「文档服务一时答不上」：执行结果不明、事件没落盘、进程在收、配置不对，
            // 以及「还没绑定」「没配模型」「记录对不上」这类要调用方或人来处理的状态——照旧原样抛出，不在这里空转。
            ['run-execution-uncertain', 'run-outcome-unavailable', 'run-events-persistence', 'account-runner-closed',
              'account-worker-task-consumed', 'account-runner-configuration', 'account-worker-task-configuration',
              'account-worker-assignment-pending', 'account-worker-not-bound', 'account-worker-grant', 'account-worker-closed',
              'account-worker-task-binding', 'no-model-key', 'run-record-mismatch', 'run-admit-protocol'].includes(error?.code) ||
            !(slot?.admitRequestId || slot?.grant)) throw error;
        log('agent.account.task.retry', { code: error?.code ?? 'unavailable' });
        await new Promise(resolve => { const timer = setTimeout(resolve, delay); timer.unref?.(); });
        if (closed) throw error;
      }
    }
  }
  async function resumeQueued() {
    if (selectedTask) return resumeTask();
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
      readIntents: readIntents.pending().length, pendingAdmissions: pending.size, runAuthorityMounted: true, at: now(),
      ...(selectedTask ? { singleTask: true, taskConsumed } : {}) }),
    close() { closed = true; for (const entry of active.values()) { entry.cancelled = true; entry.cancelController.abort();
        try { entry.handle?.abort(); } catch {} }
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear(); retryDelay.clear(); pending.clear(); listeners.clear(); } };
}

/** Public account-v2 service retains doc-owned HTTP ACL and adds the durable consumer. */
export function createAccountRunnerService({ conversationClient, runClient, readIntentsFile, runnerFactory,
  runEventsFile = null, runEventsAuthorityId = null,
  resources = null,
  task = null, assignmentReady = null, onTaskDrained = null, runEventsSink = null,
  serviceKid, instanceId, connectionsClosed, childrenClosed, now = Date.now, log = () => {}, ...runnerOptions } = {}) {
  if (typeof readIntentsFile !== 'string' || !path.isAbsolute(readIntentsFile)) fail(503, 'read-intent-configuration');
  const readIntents = openReadIntents({ file: readIntentsFile, now });
  let runEvents = null;
  try {
    // Legacy controlled runner fixtures can omit the event store. A real factory
    // must supply private persistent execution evidence; it never silently falls
    // back to the old conversation-owner store or a RAM-only event sink.
    if (runEventsSink) {
      if (!task || ['writer', 'mirrorRunMessage', 'failure', 'close'].some(name => typeof runEventsSink[name] !== 'function'))
        fail(503, 'worker-event-sink-configuration');
      runEvents = runEventsSink;
    } else if (!runnerFactory || runEventsFile) runEvents = createAccountRunEvents({ file: runEventsFile,
      authorityId: runEventsAuthorityId, now, verifyGrant: grant => runClient.checkAccess({
        projectId: grant.projectId, runGrantId: grant.runGrantId, action: 'write' }) });
    const factory = runnerFactory ?? createExistingHostedRunnerFactory({ ...runnerOptions, runClient, resources, now, log });
    const preflight = runnerFactory ? async () => true : async () => modelReady(await runnerOptions.modelConfig());
    const manager = createAccountRunManager({ runClient, readIntents, runnerFactory: factory, preflight, serviceKid, instanceId,
      runEvents, resources, connectionsClosed, childrenClosed, task, assignmentReady, onTaskDrained, now, log });
    const base = createAccountConversationService({ conversationClient, now });
    return { ...base, runManager: manager, runEvents,
      // `/healthz` 据此报看画面接没接：只有真实运行器、并且给了看画面的客户端才算
      look: !runnerFactory && !!runnerOptions.look,
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
