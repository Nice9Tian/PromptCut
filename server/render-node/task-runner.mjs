/**
 * 细任务的执行编排(M7 契约 D11 (a):从 `local-node.mjs` 抽出来的同构模块,桌面与页面的纯浏览器节点共用)。
 *
 * 不引任何模块:不引 `split.mjs`、队列本体、`fingerprint.mjs`,没有 `node:` 内置模块,不开计时器、不读环境变量,
 * 所以能原样进页面构建。切分(`plan` 任务)不在这里:桌面的 `local-node.mjs` 经 `executePlan` 注入;
 * 纯浏览器不认领 plan(设计 4.3 规则 6),页面不给 `executePlan`,真收到 plan 就按不可重试失败处理。
 *
 * # 认领到一个细任务之后(与 M3 起 local-node 的做法相同,契约 D.2)
 *
 *   开工先同步报一次进度 0:队列的停滞规则只在 done !== null 时生效,执行器卡死又从不报进度时也回收得到。
 *   sink.has 为真就直接 complete(dedup,带 sink.resultFor 的清单);否则 executor.render → sink.put →
 *   收全才 complete(带 put 回的清单),没收全 fail(可重试)。sink 收到的 ref 带任务的 input 与 requires(契约 J.3)。
 *   出错 fail,`error.retryable === false` 才不可重试。
 *
 * # 「仍持有」与迟到的结果
 *
 * 每个认领开一次「执行」(run),带自己的令牌和 AbortController。执行里每个 await 落定后,往队列发任何消息之前
 * 都要重新判一次仍持有:没有 stop、本次执行没被中止、在跑表里的仍是这一次执行,且 `session.held()` 里有同 id、
 * 同令牌的持有。判完到发消息之间不 await。判不过就丢弃结果、报 `discarded`,不发任何消息;已经推到产物库的产物
 * 不回收(按内容寻址,下一个认领者查 `has` 会直接完成)。
 *
 * 对注入接口的每次等待都和中止信号赛跑(`untilAborted`):执行器或产物库不理会中止、一直不返回,这次执行也会在
 * 中止时落定(`settled()` 不会被卡死的执行器拖住),之后它再返回什么都被丢弃。
 *
 * @typedef {object} TaskRunner
 * @property {(task: object, ctx: { token: number, browserFingerprints?: string[] }) => void} onTask  会话的 onTask
 * @property {(id: string, reason: string) => void} onLost   会话的 onLost
 * @property {(run: object) => boolean} holding
 * @property {(reason: string) => void} abortAll
 * @property {(reason?: string) => void} stop       停手:此后不再往队列发任何消息
 * @property {() => void} resume                    `stop` 之后重新开始(local-node 的 start)
 * @property {() => boolean} stopped
 * @property {(id: string) => number | null} tokenOf   跑表里这个 id 的令牌(接续判断用)
 * @property {() => string[]} running
 * @property {() => Promise<void>} settled
 */

/** 中止时抛出的标记:赛跑输给中止信号,不是执行器自己的错误。 */
export const ABORTED = Symbol('aborted');

/** 等 promise 落定,或者等到中止信号,先到先算。信号已经中止就立即拒绝。 */
export function untilAborted(work, signal) {
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

/** sink 回的清单 → 可展开进 `complete` 结果的对象;不是普通对象(null、缺省、数组)就什么都不加。 */
export function resultFields(result) {
  return result != null && typeof result === 'object' && !Array.isArray(result) ? result : {};
}

/**
 * @param {object} options
 * @param {string} options.nodeId
 * @param {() => { held(): { id: string, token: number }[], progress(id: string, done: number): boolean,
 *   complete(id: string, result?: object): boolean, fail(id: string, error?: string, retryable?: boolean): boolean }} options.session
 *   会话的取值函数(会话要 onTask / onLost,所以 runner 先建、会话后建)
 * @param {{ render: (task: object, opts: { signal: AbortSignal, progress: (done: number) => void }) => Promise<unknown> }} options.executor
 * @param {{ has: Function, put: Function, resultFor?: Function }} options.sink
 * @param {(event: object) => void} [options.emit]   诊断事件(调用方负责吞掉它自己的异常)
 * @param {(run: object, task: object, ctx: object) => Promise<void>} [options.executePlan]
 *   plan 任务怎么做(桌面给);它抛出的错误按细任务的规矩 fail。不给时 plan 按不可重试失败处理
 * @returns {TaskRunner}
 */
export function createTaskRunner({ nodeId, session, executor, sink, emit = () => {}, executePlan = null }) {
  /** 在跑表:id → 当前这一次执行 { id, token, kind, controller }。中止即移出 */
  const active = new Map();
  /** 还没落定的执行(含已中止、还在收尾的),供 `settled()` 等 */
  const pending = new Set();
  let stopped = false;

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
    return session().held().some(hold => hold.id === run.id && hold.token === run.token);
  }

  function onTask(task, ctx = {}) {
    const id = task?.id;
    if (id == null) return;
    // 同一 id 还挂着旧的执行:它的持有已经没了(否则会话不会再调 onTask),先中止
    const previous = active.get(id);
    if (previous) abortRun(previous, 'reclaimed');
    const run = { id, token: ctx.token, kind: task.kind, controller: new AbortController() };
    active.set(id, run);
    // 开工先报一次进度 0(契约 D.2〔裁〕)
    try {
      session().progress(id, 0);
    } catch {
      // 连接已坏:后面的发送同样会失败,由执行里的异常处理收尾
    }
    const done = execute(run, task, ctx).then(() => {
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
  async function execute(run, task, ctx) {
    const { id } = run;
    const { signal } = run.controller;
    const discard = () => emit({ type: 'discarded', id });
    try {
      if (task.kind === 'plan') {
        if (typeof executePlan !== 'function') {
          throw Object.assign(new Error('这个节点不切分 plan 任务'), { retryable: false });
        }
        await executePlan(run, task, ctx);
        return;
      }

      const { resultKey, kind, range } = task;
      // input / requires 原样带上:本地档的落盘键要用 input.entryKey、input.contentKey、
      // requires.envFingerprint,canvasHeavy 取 input.canvasHeavy(C6.2 第 11 节第 2、3 条,J.3)
      const ref = { resultKey, kind, tier: task.tier ?? null, range, input: task.input, requires: task.requires };
      const ranges = [[range?.from, range?.to]];

      const have = await untilAborted(() => sink.has({ ...ref }), signal);
      if (!holding(run)) return discard();
      if (have === true) {
        // 去重完成也带清单,订阅方才拉得到(C6.4 第 3 节);sink 没有 resultFor 时照旧(D.2)
        // resultFor 抛错算「没有清单」:照旧以去重方式完成,不让任务失败(契约 J.10)
        let manifest = null;
        if (typeof sink.resultFor === 'function') {
          try {
            manifest = await untilAborted(() => sink.resultFor({ ...ref }), signal);
          } catch (error) {
            if (error === ABORTED) throw error;
            manifest = null;
          }
          if (!holding(run)) return discard();
        }
        session().complete(id, { ranges, dedup: true, ...resultFields(manifest) });
        emit({ type: 'dedup', id });
        return;
      }

      const progress = done => {
        if (holding(run)) session().progress(id, done);
      };
      const artifacts = await untilAborted(() => executor.render(task, { signal, progress }), signal);
      if (!holding(run)) return discard();

      const r = await untilAborted(
        () => sink.put({ ...ref, artifacts, meta: { taskId: id, nodeId, token: run.token } }),
        signal,
      );
      if (!holding(run)) return discard();
      if (r?.complete !== true) {
        session().fail(id, 'sink-incomplete', true);
        emit({ type: 'failed', id, error: 'sink-incomplete', retryable: true });
        return;
      }
      // put 回的清单(C6.2 第 3 节)展开进 task.done 的 result(J.3)
      session().complete(id, { ranges, ...resultFields(r.result) });
      emit({ type: 'completed', id });
    } catch (error) {
      if (error === ABORTED || !holding(run)) return discard();
      const message = String(error?.message ?? error);
      const retryable = error?.retryable !== false;
      try {
        session().fail(id, message, retryable);
      } catch {
        // 连发失败都做不到(连接已坏):持有已经从会话里移除,队列会按租约或断开回收
      }
      emit({ type: 'failed', id, error: message, retryable });
    }
  }

  return {
    onTask,
    onLost,
    holding,
    abortAll,
    stop(reason = 'stopped') {
      stopped = true;
      abortAll(reason);
    },
    resume() { stopped = false; },
    stopped: () => stopped,
    tokenOf: id => active.get(id)?.token ?? null,
    running: () => [...active.keys()].sort(),
    settled: async () => { await Promise.all([...pending]); },
  };
}
