import { canonicalJson, digestOf } from '../account/ledger.mjs';

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const ref = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');

export const RUN_DRAIN_PROTOCOL = 'promptcut.agent-run.drain.v1';
export const RUN_DRAIN_BINDING = Object.freeze(['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId',
  'instanceId', 'instanceGeneration', 'serviceKid']);
const RUN_BINDING = Object.freeze(['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId']);

export function validateRunOutcome(value) {
  if (!exact(value, ['v', 'status', 'eventId', 'eventDigest']) || value.v !== 1 ||
      !['done', 'failed', 'interrupted'].includes(value.status) || !ref(value.eventId) || !hash(value.eventDigest))
    fail(503, 'run-outcome-invalid');
  return structuredClone(value);
}

/** 「任务终态 + 本机资源已收干净」的记录。它只陈述这个进程自己看到的事：终态事件已经由主服务持久确认、
 * 运行器和它的数据连接已经收完、最后一次事件落盘成功。它不是操作系统层面的关闭证明，也不让出队列名额；
 * 那两件事分别由 root 的关闭记录和文档服务的结清负责。内容一经形成不再改，回执号由内容算出。 */
export function createRunDrainRecord({ grant, readReceiptId, outcome } = {}) {
  const binding = Object.fromEntries(RUN_DRAIN_BINDING.map(k => [k, grant?.[k]]));
  if (RUN_DRAIN_BINDING.some(k => k === 'instanceGeneration'
    ? !Number.isSafeInteger(binding[k]) || binding[k] < 1 : !ref(binding[k])) || !ref(readReceiptId))
    fail(503, 'run-drain-binding');
  const body = { v: 1, protocol: RUN_DRAIN_PROTOCOL, binding, readReceiptId, outcome: validateRunOutcome(outcome),
    drain: { state: 'local-drained', events: 'durable', dispatchesOpen: 0 } };
  return Object.freeze({ ...body, drainReceiptId: `drain:${digestOf(body)}` });
}

export function validateRunDrainRecord(value) {
  if (!exact(value, ['v', 'protocol', 'binding', 'readReceiptId', 'outcome', 'drain', 'drainReceiptId']) ||
      value.v !== 1 || value.protocol !== RUN_DRAIN_PROTOCOL || !exact(value.binding, RUN_DRAIN_BINDING) ||
      !exact(value.drain, ['state', 'events', 'dispatchesOpen']) || value.drain.state !== 'local-drained' ||
      value.drain.events !== 'durable' || value.drain.dispatchesOpen !== 0) fail(503, 'run-drain-record');
  const rebuilt = createRunDrainRecord({ grant: value.binding, readReceiptId: value.readReceiptId, outcome: value.outcome });
  if (canonicalJson(rebuilt) !== canonicalJson(value)) fail(503, 'run-drain-record');
  return structuredClone(value);
}

/** 任务进程这一侧的正常结算：结束 → 准备 → 终态 → 意向，四步都只用本进程内存里的那把钥匙签。
 *
 * - 只有已经封存的收尾记录（readTerminal）才能开始；没有记录就不结算，任务留给强制路径。
 * - 四个请求的编号都由任务授权号算出，回应丢了就原样重发；文档服务按编号去重。
 * - 任何一步被文档服务明确拒绝（任务已被撤销等），正常结算到此为止，回 `{ kind: 'abandoned' }`：
 *   之后只能走文档服务已经签好的强制终态，这里不补签、不重试成别的结果。
 * - 拿到意向不等于任务结束。进程由 root 关，名额由文档服务在看到 root 的关闭记录后让出。 */
export function createWorkerSettlement({ runClient, readTerminal, scope, sleep = ms => new Promise(r => setTimeout(r, ms)),
  retryMs = 100, maxRetryMs = 2000, stopped = () => false } = {}) {
  if (['finish', 'queryFinish', 'scopePrepareFor', 'scopePrepare', 'scopeTerminal', 'scopeIntentFor']
    .some(name => typeof runClient?.[name] !== 'function') || typeof readTerminal !== 'function' ||
      !scope?.expected || !scope.record || !scope.assignment || !scope.grant) fail(503, 'worker-settlement-configuration');
  const { expected, record, assignment, grant } = scope;
  const base = Object.fromEntries(RUN_BINDING.map(k => [k, grant[k]]));
  let state = 'idle', work = null, lastCode = null;
  // 503 是「还没好」或「回应不确定」，原样再问；别的状态码是文档服务的明确答复。
  async function settled(call) {
    for (let delay = retryMs; ; delay = Math.min(delay * 2, maxRetryMs)) {
      if (stopped()) fail(503, 'worker-settlement-stopped');
      try { return await call(); }
      catch (error) {
        lastCode = error?.code ?? 'unavailable';
        if (error?.status !== 503 || /^instance-/.test(lastCode)) throw error;
      }
      await sleep(delay);
    }
  }
  async function run() {
    const terminal = validateRunDrainRecord(await readTerminal());
    if (RUN_DRAIN_BINDING.some(k => terminal.binding[k] !== grant[k])) fail(503, 'run-drain-binding');
    state = 'finish';
    const finish = { ...base, requestId: `finish:${grant.runGrantId}`, readReceiptId: terminal.readReceiptId, outcome: terminal.outcome };
    const view = await settled(() => runClient.finish(finish));
    const receipt = view?.finishReceipt;
    if (!receipt || !ref(receipt.finishReceiptId) || !ref(receipt.controlId) || receipt.readReceiptId !== terminal.readReceiptId ||
        receipt.outcomeDigest !== digestOf(terminal.outcome) || !Number.isSafeInteger(receipt.authoritySeq)) fail(503, 'worker-settlement-finish-protocol');
    state = 'prepare';
    const payload = { v: 1, domain: 'promptcut.agent-run.prepare.v1',
      scope: { authorityId: expected.authorityId, slotId: expected.slotId, epoch: record.epoch,
        recordDigest: digestOf(record), assignmentDigest: digestOf(assignment) },
      target: structuredClone(assignment.target), readReceiptId: receipt.readReceiptId,
      finishReceiptId: receipt.finishReceiptId, outcomeDigest: receipt.outcomeDigest,
      eventId: terminal.outcome.eventId, eventDigest: terminal.outcome.eventDigest,
      drainReceiptId: terminal.drainReceiptId, docControlId: receipt.controlId, docFenceRevision: receipt.authoritySeq };
    const prepare = await runClient.scopePrepareFor(payload);
    const settlement = { ...base, finishReceiptId: receipt.finishReceiptId };
    await settled(() => runClient.scopePrepare({ ...settlement, requestId: `prepare:${grant.runGrantId}`, prepare }));
    state = 'terminal';
    // 文档服务要先把这条任务在它那边的连接真的关掉，才签终态；没关完回 503，这里等。
    const answer = await settled(() => runClient.scopeTerminal({ ...settlement, requestId: `terminal:${grant.runGrantId}` }));
    const intent = runClient.scopeIntentFor({ assignment, terminal: answer?.terminal });
    state = 'intent-ready';
    return { kind: 'normal', terminal: structuredClone(answer.terminal), intent };
  }
  return {
    start() {
      work ??= run().catch(error => {
        state = 'abandoned'; lastCode = error?.code ?? 'worker-settlement-failed';
        return { kind: 'abandoned', code: lastCode };
      });
      return work;
    },
    describe: () => ({ state, lastCode }),
  };
}

/** 准备签名的私有来源：只认本进程日志里已经封存的那条收尾记录。网络上来的内容不能让它签。 */
export function createTerminalPrepareSource({ readTerminal } = {}) {
  if (typeof readTerminal !== 'function') fail(503, 'worker-settlement-configuration');
  return async value => {
    const terminal = validateRunDrainRecord(await readTerminal());
    if (!value || value.readReceiptId !== terminal.readReceiptId || value.eventId !== terminal.outcome.eventId ||
        value.eventDigest !== terminal.outcome.eventDigest || value.outcomeDigest !== digestOf(terminal.outcome) ||
        value.drainReceiptId !== terminal.drainReceiptId ||
        RUN_DRAIN_BINDING.some(k => value.target?.[k] !== terminal.binding[k])) fail(503, 'instance-scope-prepare-source');
    return structuredClone(value);
  };
}
