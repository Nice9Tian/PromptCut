import { QUEUE_DEFAULTS } from '../render-queue/index.mjs';
import { filterClaimable } from './filter.mjs';
import { pickCandidate } from './pick.mjs';

/**
 * 渲染节点的会话状态机(任务书 M2「节点会话状态机」,契约 B.5)。
 *
 * 只管协议这一层:本地视图(看得见哪些 `open` 任务)、认领、续约、让路、放回、丢认领。
 * 传输(`send`)、时钟(`now`)、闲时判据(`isIdle`)、随机源都由调用方注入;这里不开计时器,
 * 由调用方按节拍调 `tick()`。真正干活由调用方在 `onTask` 里开始、在 `onLost` 里停手。
 *
 * # 认领节流
 *
 * 同一时刻至多一条认领在飞,一次 `tick` 至多发一条认领;持有数 + 在飞数到 `maxConcurrent`
 * 就不再认领。在飞的认领在收到 `task.claimed` / `task.claim-rejected`(或 `error`、重新
 * `start`)时清掉。队列回 `claim-rejected { reason: 'throttled' }`(契约 I.6)后,
 * 一个 `SWEEP_INTERVAL_MS` 内不发起新认领,续约照常。回 `preferred`(M6c X4:`plan` 还在发布方的独占窗口里)
 * 时这个候选留在视图里、搁到回包的 `retryInMs` 之后再考虑。
 *
 * # 重入
 *
 * 调用方可以把 `send` 直接接到进程内队列的 `handle` 上、把队列的回包同步地送回 `receive`
 * (进程内联调就是这么接的)。所以这里**先改本地状态、再 `send`**:例如认领时先记在飞再发,
 * 否则同步回来的 `task.claimed` 会先清在飞、随后又被记上,节点从此再也不认领。
 *
 * # 丢认领只通知一次
 *
 * `node.welcome.lost` 之后队列还会为同一个 id 补一条 `task.lease-lost`;持有已经移除,
 * 那一条就忽略。`task.lease-lost` 带的令牌和本地持有的对不上(旧认领的迟到消息,
 * 这个 id 已经重新认领过)同样忽略。
 */

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function createNodeSession({
  nodeId,
  node,
  send,
  now,
  random = Math.random,
  isIdle = () => true,
  maxConcurrent = 1,
  constants = {},
  projects = 'all',
  onTask = () => {},
  onLost = () => {},
}) {
  const settings = { ...QUEUE_DEFAULTS, ...constants };
  /** 本地看到的 open 任务:id → TaskView */
  let open = new Map();
  /** 持有的认领:id → { id, token, lastSentAt, done, projectId } */
  const holds = new Map();
  /** 在飞的认领:{ id, projectId } | null */
  let inflight = null;
  /** `yieldAll` 时还在飞的认领:回来的若是 `task.claimed`,立即放回而不开工 */
  let yielding = null;
  let lastProjectId = null;
  let epoch = null;
  /** 被队列限流(`claim-rejected { reason: 'throttled' }`,契约 I.6)后,这个时刻之前不发起新认领;续约照常 */
  let throttledUntil = -Infinity;
  /**
   * 搁置到某一刻的候选:id → 本地时刻(M6c X4)。`plan` 在发布方的独占窗口里被回 `preferred` 时,
   * 候选留在视图里、搁到窗口过后再考虑(队列回的 `retryInMs` 按本地时钟换算,跨机器也不怕时钟差)。
   */
  const deferred = new Map();
  /** 节点侧过滤用的节点描述:补上 `nodeId`(本地档能力闸 `requires.localMedia` 要比它,M6c X2) */
  const filterNode = () => (node?.nodeId != null ? node : { ...node, nodeId });
  /** 按摘要 watch 着的项目(M6c X3,只有 host 用 `'all'` 时才有);null = 还没 watch 过具体项目 */
  let watching = null;

  const dropHold = (id, reason) => {
    if (!holds.delete(id)) return;
    onLost(id, reason);
  };

  function start(resume = []) {
    const entries = (resume ?? [])
      .filter(entry => entry && entry.id != null)
      .map(({ id, token }) => ({ id, token }));
    const resuming = new Set(entries.map(entry => entry.id));
    // 没带上的持有,队列会按 not-resumed 直接放弃,这边先停手
    for (const id of [...holds.keys()]) if (!resuming.has(id)) dropHold(id, 'not-resumed');
    const at = now();
    for (const { id, token } of entries) {
      const hold = holds.get(id);
      if (hold) hold.token = token;
      else holds.set(id, { id, token, lastSentAt: at, done: null, projectId: null });
    }
    // 旧连接上在飞的认领和本地视图都作废:回包不会再来,视图等新的 queue.snapshot
    open = new Map();
    inflight = null;
    yielding = null;
    // 限流挂在队列的连接上,新连接不带着旧连接的退避(契约 I.10 第 6 条)
    throttledUntil = -Infinity;
    deferred.clear();
    watching = null;
    send({
      type: 'node.hello', nodeId, profile: node?.profile, envFingerprint: node?.envFingerprint,
      capabilities: node?.capabilities, codeVersions: node?.codeVersions, maxConcurrent, resume: entries,
    });
    send({ type: 'queue.watch', projects });
  }

  function onClaimed(message) {
    const { id, token } = message;
    if (inflight?.id === id) inflight = null;
    const task = message.task ?? open.get(id) ?? null;
    open.delete(id);
    if (yielding && yielding.id === id) {
      const { reason } = yielding;
      yielding = null;
      send({ type: 'task.release', id, token, reason });
      return;
    }
    const existing = holds.get(id);
    if (existing) { existing.token = token; return; }
    const projectId = task?.source?.projectId ?? null;
    holds.set(id, { id, token, lastSentAt: now(), done: null, projectId });
    if (projectId != null) lastProjectId = projectId;
    onTask(task, { token });
  }

  function onRejected(message) {
    const { id, reason } = message;
    if (inflight?.id === id) inflight = null;
    if (yielding?.id === id) yielding = null;
    if (reason === 'throttled') {
      // 契约 I.6:本连接这个扫描周期撞锁太多,队列在下一次扫描前一律回 throttled。退避一个扫描周期;
      // 候选不从本地视图删,任务本身没变,过后照常可以认领
      throttledUntil = now() + settings.SWEEP_INTERVAL_MS;
      return;
    }
    if (reason === 'stale') {
      const task = open.get(id);
      if (task && Number.isInteger(message.version)) open.set(id, { ...task, version: message.version });
      return;
    }
    if (reason === 'preferred') {
      // M6c X4:plan 还在发布方的独占窗口里。候选不删,搁到窗口过后;窗口过后任何指纹符合的 pc 都能认领
      const wait = Number(message.retryInMs);
      deferred.set(id, now() + (Number.isFinite(wait) && wait >= 0 ? wait : settings.SWEEP_INTERVAL_MS));
      const task = open.get(id);
      if (task && Number.isInteger(message.version)) open.set(id, { ...task, version: message.version });
      return;
    }
    // taken / gone / forbidden / card-locked / fingerprint-mismatch(契约 I.10 第 4 条)/ local-media(M6c X2)/
    // plan-profile(M6c X4)(以及认不出的原因):这一轮不再考虑它。
    // card-locked(契约 F.2):这张卡的锁在别的指纹上,本节点的指纹做不了,按 taken 丢掉候选、
    // 不重试;任务在队列里仍是 open,只有队列再发 task.opened / queue.snapshot 时才会回到视图
    open.delete(id);
  }

  /**
   * M6c X3:队列对 host 的 `watch: 'all'` 只回项目摘要 `queue.summary`,不发单任务增量。host 会话照旧报到后
   * watch `'all'`,接到摘要就改 watch 摘要里有 open 任务的那些项目(并上已 watch、摘要里还列着的):
   * 队列回这些项目的 `queue.snapshot`(整体替换本地视图),此后收它们的增量;非空项目列表不停摘要,
   * 所以新项目有活时下一条摘要又会带出来。只在出现新项目时改 watch,项目做完不收窄,免得来回重发快照。
   * 别的 profile、或调用方给了具体项目列表时,摘要一律不理(pc 的 `'all'` 本来就收全量)。
   */
  function followSummary(message) {
    if (projects !== 'all' || node?.profile !== 'host') return;
    const listed = new Set();
    const want = new Set();
    for (const p of Array.isArray(message.projects) ? message.projects : []) {
      if (typeof p?.projectId !== 'string' || p.projectId === '') continue;
      listed.add(p.projectId);
      if (Number(p.open) > 0) want.add(p.projectId);
    }
    const current = watching ?? new Set();
    if ([...want].every(id => current.has(id))) return;
    const next = [...new Set([...want, ...[...current].filter(id => listed.has(id))])].sort();
    watching = new Set(next);
    send({ type: 'queue.watch', projects: next });
  }

  function receive(message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'queue.summary':
        followSummary(message);
        break;
      case 'node.welcome': {
        epoch = message.epoch ?? epoch;
        for (const id of message.lost ?? []) dropHold(id, 'lost');
        // 接续的认领马上续一次约:断线期间发出去的续约可能都丢了,租约未必还剩多少
        const due = now() - settings.RENEW_INTERVAL_MS;
        for (const id of message.resumed ?? []) {
          const hold = holds.get(id);
          if (hold) hold.lastSentAt = Math.min(hold.lastSentAt, due);
        }
        break;
      }
      case 'queue.snapshot':
        open = new Map((message.tasks ?? []).filter(task => task?.id != null).map(task => [task.id, task]));
        break;
      case 'task.opened':
        if (message.task?.id != null) open.set(message.task.id, message.task);
        break;
      case 'task.taken':
      case 'task.closed':
        // 包括 `state: 'hidden'`(契约 I.6):队列的指纹前置过滤不再让本节点看见它,和别的 closed 一样移除
        open.delete(message.id);
        break;
      case 'task.claimed':
        onClaimed(message);
        break;
      case 'task.claim-rejected':
        onRejected(message);
        break;
      case 'task.lease-lost': {
        const hold = holds.get(message.id);
        if (!hold) break;
        if (Number.isFinite(message.token) && message.token !== hold.token) break;
        dropHold(message.id, message.reason ?? 'lost');
        break;
      }
      case 'error':
        // 认领不带 reqId,回包对不上是哪条请求;在飞的认领若就是它,不清的话节点从此再也不认领。
        // 带 reqId 的是同一条连接上别的请求(内容库、发布等)的回包,不是认领的,不清(契约 I.10 第 5 条)
        if (message.reqId === undefined) inflight = null;
        break;
      default:
        break;
    }
  }

  function tick() {
    const at = now();
    for (const hold of [...holds.values()]) {
      if (holds.get(hold.id) !== hold || at - hold.lastSentAt < settings.RENEW_INTERVAL_MS) continue;
      hold.lastSentAt = at;
      send({ type: 'task.progress', id: hold.id, token: hold.token, done: hold.done ?? null });
    }
    if (inflight || !isIdle() || holds.size >= maxConcurrent || at < throttledUntil) return;
    for (const [id, until] of deferred) if (until <= at || !open.has(id)) deferred.delete(id);
    const candidates = filterClaimable(known0().filter(task => !holds.has(task.id) && !deferred.has(task.id)), filterNode());
    const task = pickCandidate(candidates, { k: settings.PICK_K, random, lastProjectId });
    if (!task) return;
    inflight = { id: task.id, projectId: task.source?.projectId ?? null };
    try {
      send({ type: 'task.claim', id: task.id, expectVersion: task.version });
    } catch (error) {
      if (inflight?.id === task.id) inflight = null;
      throw error;
    }
  }

  function progress(id, done) {
    const hold = holds.get(id);
    if (!hold) return false;
    hold.done = done;
    hold.lastSentAt = now();
    send({ type: 'task.progress', id, token: hold.token, done: done ?? null });
    return true;
  }

  function complete(id, result) {
    const hold = holds.get(id);
    if (!hold) return false;
    holds.delete(id);
    send(result === undefined ? { type: 'task.complete', id, token: hold.token } : { type: 'task.complete', id, token: hold.token, result });
    return true;
  }

  function fail(id, error, retryable = true) {
    const hold = holds.get(id);
    if (!hold) return false;
    holds.delete(id);
    send(error === undefined
      ? { type: 'task.fail', id, token: hold.token, retryable }
      : { type: 'task.fail', id, token: hold.token, error, retryable });
    return true;
  }

  function yieldAll(reason = 'busy') {
    const released = [...holds.values()];
    holds.clear();
    if (inflight) yielding = { id: inflight.id, reason };
    for (const hold of released) send({ type: 'task.release', id: hold.id, token: hold.token, reason });
    return released.length;
  }

  const known0 = () => [...open.values()].sort(byId);

  return {
    start,
    receive,
    tick,
    progress,
    complete,
    fail,
    yieldAll,
    held: () => [...holds.values()].sort(byId).map(({ id, token, lastSentAt }) => ({ id, token, lastSentAt })),
    known: () => known0().map(task => ({ ...task })),
    /** host 按摘要 watch 着的项目(M6c X3),升序;没有就是空数组 */
    watching: () => (watching ? [...watching] : []),
    get epoch() { return epoch; },
  };
}
