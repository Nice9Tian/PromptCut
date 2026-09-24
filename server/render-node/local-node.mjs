import { createNodeSession } from './session.mjs';
import { splitPlan } from './split.mjs';

/**
 * 本机渲染节点的编排(分布式预渲染 M3,契约 `docs/plan/render-queue-contract.md` D 节)。
 *
 * 生产编排模块:把节点会话(`session.mjs`)、切分(`split.mjs`)和注入进来的三样东西串起来:
 *
 *   endpoint  到队列的一条连接(进程内是环回端点,M5 起是 WebSocket 适配层)
 *   executor  真正干活的:算计划、渲染一段
 *   sink      产物库:先推送、确认收全,再报完成(设计 4.4,语义 `asset-storage.md`)
 *
 * 只认这些注入接口,不引网络、不碰文件系统、不读环境变量、不开计时器,也不认识任何真实存储。
 * 环回传输、假执行器、假产物库只在 `server/test/`(仅供测试与进程内集成),生产代码不得引用。
 * 节拍由调用方驱动:按间隔调 `tick()`。
 *
 * # 认领到任务之后
 *
 * 开工先同步报一次进度 0,让队列的停滞规则也管得到卡死、从不报进度的执行器。
 *
 *   plan    executor.plan → splitPlan → 先 task.publish 细任务,再 complete 这个 plan
 *   细任务   sink.has 为真就直接 complete(dedup);否则 executor.render → sink.put →
 *            收全才 complete,没收全 fail(可重试)
 *   出错     fail,`error.retryable === false` 才不可重试
 *
 * 发布必须先于完成:派生任务继承 plan 的用户与订阅者(契约 A.4 末段),条件是发布那一刻
 * plan 仍由本节点认领。同一连接上的消息按序处理,先发的 publish 一定先生效。
 *
 * # 「仍持有」与迟到的结果
 *
 * 每个认领开一次「执行」(run),带自己的令牌和 AbortController。执行里每个 await 落定后,
 * 往队列发任何消息之前都要重新判一次仍持有:
 *
 *   没有 stop、本次执行没被中止、在跑表里的仍是这一次执行,且 `session.held()` 里有
 *   同 id、同令牌的持有
 *
 * 判完到发消息之间不 await,中间不会插进别的消息。会话的 `complete` / `fail` / `progress`
 * 用的是会话**此刻**持有的令牌,所以「令牌相同」这一条保证旧的执行绝不会拿新令牌去完成任务:
 * 同一 id 被本节点重新认领到新令牌时,旧的执行已经被 `onLost` 中止,而且它的令牌对不上。
 * 判不过就丢弃结果、报 `discarded`,不发任何消息。已经推到产物库的产物不回收:按内容寻址,
 * 下一个认领者查 `has` 会直接完成。
 *
 * `start(resume)` 只接续本实例在跑表里、令牌相同的项:接续只用于同一实例的重连。
 *
 * 对注入接口的每次等待都和中止信号赛跑:执行器或产物库不理会中止、一直不返回,这次执行也会
 * 在中止时落定(`settled()` 不会被卡死的执行器拖住),之后它再返回什么都被丢弃。
 *
 * @typedef {object} PlanContext  executor.plan 的结果,原样喂给 splitPlan(契约 B.4)
 * @property {string} entryKey
 * @property {object[]} cardPlan
 * @property {Set<string>} [prerenderSet]
 * @property {object[]} [streams]
 * @property {number[]} [anchorFrames]
 * @property {Record<string, string>} [cardSourceVersions]
 * @property {(control: object) => object} [weightOf]
 * @property {(control: object) => boolean} [isUserCard]
 * @property {(control: object) => boolean} [isGraphCard]
 *
 * @typedef {object} Executor  执行器(契约 D.1)
 * @property {(planTask: object, opts: { signal: AbortSignal }) => Promise<PlanContext>} plan
 *   算这一版项目的计划。planTask 是 TaskView
 * @property {(task: object, opts: { signal: AbortSignal, progress: (done: number) => void }) => Promise<unknown>} render
 *   渲染一段。task 是 TaskView;progress(done) 报进度;返回的 artifacts 不透明,原样交给 sink.put。
 *   抛出的错误带 `retryable === false` 时按不可重试处理,否则可重试
 *
 * @typedef {object} SinkRef
 * @property {string} resultKey
 * @property {'snapshot' | 'stream'} kind
 * @property {'shared' | 'local' | null} tier   流任务是 null
 * @property {{ unit: string, from: number, to: number }} range
 *
 * @typedef {object} Sink  产物库(契约 D.1;M5 起由素材服务实现)
 * @property {(ref: SinkRef) => Promise<boolean>} has   这一段是否已经收全
 * @property {(entry: SinkRef & { artifacts: unknown, meta: { taskId: string, nodeId: string, token: number } }) => Promise<{ complete: boolean }>} put
 *   推送一段;`complete !== true` 表示没收全。meta 供记账(设计第 7 节「节点信任」)
 *
 * @typedef {object} Endpoint  到队列的一条连接
 * @property {(message: object) => void} send
 * @property {(handler: (message: object) => void) => void} onMessage
 *
 * @typedef {object} LocalNode
 * @property {(resume?: { id: string, token: number }[]) => void} start
 * @property {() => void} tick
 * @property {(reason?: string) => number} yieldAll
 * @property {() => void} stop
 * @property {() => string[]} running
 * @property {() => Promise<void>} settled
 * @property {ReturnType<typeof createNodeSession>} session
 */

const noop = () => {};

/** 中止时抛出的标记:赛跑输给中止信号,不是执行器自己的错误。 */
const ABORTED = Symbol('aborted');

/** 等 promise 落定,或者等到中止信号,先到先算。信号已经中止就立即拒绝。 */
function untilAborted(work, signal) {
  if (signal.aborted) return Promise.reject(ABORTED);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // 执行器可能同步抛出,也可能返回非 Promise 的值:统一包成 Promise
  const settled = new Promise(resolve => resolve(work()));
  return Promise.race([settled, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

/**
 * @param {object} options
 * @param {string} options.nodeId
 * @param {string} [options.publisherId]  缺省等于 nodeId;切分出的细任务以它发布
 * @param {object} options.node           契约 B.2 的节点描述
 * @param {Endpoint} options.endpoint
 * @param {() => number} options.now
 * @param {() => number} [options.random]
 * @param {() => boolean} [options.isIdle]
 * @param {number} [options.maxConcurrent]
 * @param {object} [options.constants]
 * @param {string[] | 'all'} [options.projects]
 * @param {string} [options.codeVersion]  切分细任务时写进 requires.codeVersion
 * @param {Executor} options.executor
 * @param {Sink} options.sink
 * @param {(event: object) => void} [options.onEvent]  诊断用
 * @returns {LocalNode}
 */
export function createLocalNode({
  nodeId,
  publisherId = nodeId,
  node,
  endpoint,
  now,
  random,
  isIdle,
  maxConcurrent,
  constants = {},
  projects,
  codeVersion,
  executor,
  sink,
  onEvent = noop,
}) {
  /** 在跑表:id → 当前这一次执行 { id, token, kind, controller }。中止即移出 */
  const active = new Map();
  /** 还没落定的执行(含已中止、还在收尾的),供 `settled()` 等 */
  const pending = new Set();
  let attached = false;
  let stopped = false;

  // 诊断回调出错不能打断协议流程(它可能在消息处理器里被调到)
  const emit = event => {
    try { onEvent(event); } catch { /* 诊断回调的异常吞掉 */ }
  };

  // undefined 不传,让会话用它自己的缺省值
  const sessionOptions = { nodeId, node, send: message => endpoint.send(message), now, constants, onTask, onLost };
  if (random !== undefined) sessionOptions.random = random;
  if (isIdle !== undefined) sessionOptions.isIdle = isIdle;
  if (maxConcurrent !== undefined) sessionOptions.maxConcurrent = maxConcurrent;
  if (projects !== undefined) sessionOptions.projects = projects;
  const session = createNodeSession(sessionOptions);

  function abortRun(run, reason) {
    if (active.get(run.id) === run) active.delete(run.id);
    run.controller.abort(reason);
  }

  function abortAll(reason) {
    for (const run of [...active.values()]) abortRun(run, reason);
  }

  /** 仍持有:见文件头。同步判定,判完到发消息之间不能 await。 */
  function holding(run) {
    if (stopped || run.controller.signal.aborted || active.get(run.id) !== run) return false;
    return session.held().some(hold => hold.id === run.id && hold.token === run.token);
  }

  function onTask(task, { token }) {
    const id = task?.id;
    if (id == null) return;
    // 同一 id 还挂着旧的执行:它的持有已经没了(否则会话不会再调 onTask),先中止
    const previous = active.get(id);
    if (previous) abortRun(previous, 'reclaimed');
    const run = { id, token, kind: task.kind, controller: new AbortController() };
    active.set(id, run);
    // 开工先报一次进度 0:队列的停滞规则只在 done !== null 时生效,否则会话每拍用 null 续约,
    // 执行器卡死又从不报进度时任务永远不会被回收(契约 D.2〔裁〕)
    try {
      session.progress(id, 0);
    } catch {
      // 连接已坏:后面的发送同样会失败,由执行里的异常处理收尾
    }
    const done = execute(run, task).then(() => {
      if (active.get(id) === run) active.delete(id);
      pending.delete(done);
    });
    pending.add(done);
  }

  function onLost(id, reason) {
    const run = active.get(id);
    if (run) abortRun(run, reason);
    emit({ type: 'lost', id, reason });
  }

  /** 一次执行。从不拒绝:所有异常都在这里收掉。 */
  async function execute(run, task) {
    const { id } = run;
    const { signal } = run.controller;
    const discard = () => emit({ type: 'discarded', id });
    try {
      if (task.kind === 'plan') {
        const ctx = await untilAborted(() => executor.plan(task, { signal }), signal);
        if (!holding(run)) return discard();
        // ctx 放在前面:切分节点自己的指纹、plan 与代码版本一定生效(设计 2.1)
        const tasks = splitPlan({ ...ctx, planTask: task, envFingerprint: node?.envFingerprint, codeVersion, constants });
        const derived = tasks.map(t => t.id);
        if (tasks.length > 0) endpoint.send({ type: 'task.publish', tasks });
        // 同步传输下发布的回包可能已经转了一圈回来,再判一次
        if (!holding(run)) return discard();
        session.complete(id, { ranges: null, derived });
        emit({ type: 'plan-split', id, derived });
        return;
      }

      const { resultKey, kind, range } = task;
      const ref = { resultKey, kind, tier: task.tier ?? null, range };
      const ranges = [[range?.from, range?.to]];

      const have = await untilAborted(() => sink.has({ ...ref }), signal);
      if (!holding(run)) return discard();
      if (have === true) {
        session.complete(id, { ranges, dedup: true });
        emit({ type: 'dedup', id });
        return;
      }

      const progress = done => {
        if (holding(run)) session.progress(id, done);
      };
      const artifacts = await untilAborted(() => executor.render(task, { signal, progress }), signal);
      if (!holding(run)) return discard();

      const r = await untilAborted(
        () => sink.put({ ...ref, artifacts, meta: { taskId: id, nodeId, token: run.token } }),
        signal,
      );
      if (!holding(run)) return discard();
      if (r?.complete !== true) {
        session.fail(id, 'sink-incomplete', true);
        emit({ type: 'failed', id, error: 'sink-incomplete', retryable: true });
        return;
      }
      session.complete(id, { ranges });
      emit({ type: 'completed', id });
    } catch (error) {
      if (error === ABORTED || !holding(run)) return discard();
      const message = String(error?.message ?? error);
      const retryable = error?.retryable !== false;
      try {
        session.fail(id, message, retryable);
      } catch {
        // 连发失败都做不到(连接已坏):持有已经从会话里移除,队列会按租约或断开回收
      }
      emit({ type: 'failed', id, error: message, retryable });
    }
  }

  function handle(message) {
    if (stopped) return;
    session.receive(message);
    if (message?.type === 'task.published') emit({ type: 'publish-result', results: message.results });
  }

  function start(resume = []) {
    stopped = false;
    if (!attached) {
      endpoint.onMessage(handle);
      attached = true;
    }
    endpoint.send({ type: 'publisher.hello', publisherId });
    // 只接续本实例真在跑、令牌也对得上的认领:别的项没有执行去完成它,接续了只会一直续约、
    // 占住 maxConcurrent。新进程的实例在跑表是空的,等于不接续(契约 D.2〔裁〕)
    const resumable = (resume ?? []).filter(entry => entry && active.get(entry.id)?.token === entry.token);
    session.start(resumable);
  }

  function tick() {
    if (stopped) return;
    session.tick();
  }

  function yieldAll(reason = 'busy') {
    abortAll(reason);
    return session.yieldAll(reason);
  }

  function stop() {
    stopped = true;
    abortAll('stopped');
  }

  return {
    start,
    tick,
    yieldAll,
    stop,
    running: () => [...active.keys()].sort(),
    settled: async () => { await Promise.all([...pending]); },
    get session() { return session; },
  };
}
