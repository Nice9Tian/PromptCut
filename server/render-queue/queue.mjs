/**
 * 渲染任务队列本体：文档服务托管的拉取式任务队列的纯内存状态机（设计第 3、4、5 节）。
 *
 * 输入只有两种：「某条连接发来一条消息」（handle）和「时钟走到某一刻」（tick）；输出只有一种：
 * 「给某条连接发一条消息」（send）。传输、鉴权、产物存储都在接口外面，所以这里不开计时器、不读环境变量、
 * 不做 I/O，时钟由调用方注入。
 *
 * handle / tick 都是同步的一步，执行中不让出事件循环，也不回调调用方（send 除外）：认领的「比对再加锁」
 * 靠的就是这一点（设计 4.2）。每一步先把状态改完，再往外发消息，发消息出错也不会留下改了一半的状态。
 *
 * 契约：`docs/plan/render-queue-contract.md` A 节。
 */
import { randomUUID } from 'node:crypto';
import { QUEUE_DEFAULTS } from './constants.mjs';
import { makeMessage, parseInbound, NODE_TYPES, PUBLISHER_TYPES } from './messages.mjs';

function resolveConstants(overrides) {
  const out = { ...QUEUE_DEFAULTS };
  if (overrides === undefined || overrides === null) return Object.freeze(out);
  if (typeof overrides !== 'object') throw new TypeError('createRenderQueue: constants 必须是对象');
  for (const key of Object.keys(QUEUE_DEFAULTS)) {
    const v = overrides[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`createRenderQueue: constants.${key} 必须是有限的数`);
    out[key] = v;
  }
  return Object.freeze(out);
}

export function createRenderQueue(options = {}) {
  const { now, send } = options;
  if (typeof now !== 'function') throw new TypeError('createRenderQueue: now 必须是函数');
  if (typeof send !== 'function') throw new TypeError('createRenderQueue: send 必须是函数');
  if (options.epoch !== undefined && typeof options.epoch !== 'string') throw new TypeError('createRenderQueue: epoch 必须是字符串');
  const C = resolveConstants(options.constants);
  // 新实例 = 新 epoch：文档服务重启后，各方靠它认出旧认领已作废（设计第 5 节）
  const epoch = options.epoch ?? randomUUID();

  /**
   * 连接：connId → { connId, principal, nodeId, publisherId, watch }。
   * 用对象本身而不是 connId 认「同一条连接」：connId 可能被新连接复用，认领记的是当时那条连接。
   */
  const conns = new Map();
  /** 节点身份（跨连接）：nodeId → { nodeId, profile, envFingerprint, capabilities, codeVersions, maxConcurrent, conn, disconnectedAt } */
  const nodes = new Map();
  /** 发布方身份（跨连接）：publisherId → { publisherId, conn, disconnectedAt } */
  const publishers = new Map();
  /** 任务表：id → task（字段见 describe 与 viewOf） */
  const tasks = new Map();
  /** 每项目 open + claimed 的任务数，给 MAX_TASKS_PER_PROJECT 用；done / failed 不计（P10） */
  const activeByProject = new Map();

  /** 这一步的时刻：每个入口读一次时钟，同一步里的所有时间戳一致 */
  let at = 0;

  // ---------- 发消息 ----------

  function emit(conn, type, fields, reqId) {
    const msg = makeMessage(epoch, type, fields, reqId);
    // 一条连接的传输出错不该拖垮队列：状态已经改完，这里只丢这一条消息
    try { send(conn.connId, msg); } catch { /* 交给传输层自己处理 */ }
  }

  const isLive = (conn) => conn !== null && conns.get(conn.connId) === conn;

  /** 这条连接此刻代表哪个节点（被同一 nodeId 的新连接取代后就不再代表） */
  function nodeOf(conn) {
    if (conn.nodeId === null) return null;
    const node = nodes.get(conn.nodeId);
    return node && node.conn === conn ? node : null;
  }
  function publisherOf(conn) {
    if (conn.publisherId === null) return null;
    const pub = publishers.get(conn.publisherId);
    return pub && pub.conn === conn ? pub : null;
  }

  /**
   * 可见性（A.9）：只发给 watch 了该项目的节点连接；纯浏览器只见本人任务（Q2），
   * 这条边界由这里守，不靠节点自己过滤。
   */
  function canSee(conn, task) {
    if (conn.watch === null) return false;
    const node = nodeOf(conn);
    if (!node) return false;
    if (conn.watch !== 'all' && !conn.watch.has(task.source.projectId)) return false;
    if (node.profile === 'browser' && task.source.userId !== conn.principal.userId) return false;
    return true;
  }

  function broadcast(task, type, fields, exceptConn = null) {
    for (const conn of conns.values()) {
      if (conn !== exceptConn && canSee(conn, task)) emit(conn, type, fields);
    }
  }

  // ---------- 任务表 ----------

  const isActive = (state) => state === 'open' || state === 'claimed';

  function countActive(projectId, delta) {
    const n = (activeByProject.get(projectId) ?? 0) + delta;
    if (n > 0) activeByProject.set(projectId, n);
    else activeByProject.delete(projectId);
  }

  /** 唯一的状态转移入口：每次转移 version 恰好加一（A.7），顺带维护每项目的未完成计数 */
  function transition(task, state) {
    const was = isActive(task.state);
    const will = isActive(state);
    if (was !== will) countActive(task.source.projectId, will ? 1 : -1);
    task.state = state;
    task.version += 1;
  }

  function removeTask(task) {
    if (isActive(task.state)) countActive(task.source.projectId, -1);
    tasks.delete(task.id);
  }

  /** 出站消息里的任务（A.4 TaskView）：不含 claim、subscribers；深拷贝由 makeMessage 做 */
  function viewOf(task) {
    const v = { id: task.id, kind: task.kind };
    if (task.kind === 'snapshot') v.tier = task.tier;
    Object.assign(v, {
      resultKey: task.resultKey, range: task.range, source: task.source,
      input: task.input, weight: task.weight, requires: task.requires, priority: task.priority,
      state: task.state, version: task.version, attempts: task.attempts,
    });
    return v;
  }

  function doneFields(task) {
    return {
      id: task.id, resultKey: task.resultKey,
      projectId: task.source.projectId, projectRev: task.source.projectRev, result: task.result,
    };
  }

  /** 给任务当前的每个订阅者发一条消息；订阅者断开了就跳过（A.7.4） */
  function notifySubscribers(task, type, fields) {
    for (const publisherId of task.subscribers) {
      const pub = publishers.get(publisherId);
      if (pub && pub.conn) emit(pub.conn, type, fields);
    }
  }

  /**
   * 「放弃」（A.7.6）：task.fail 与 tick 的各种回收共用。先改完状态，返回的 notify 再往外发，
   * 调用方好把自己的回包排在前面。返回处理后的状态：open / failed / removed。
   */
  function abandon(task, { lastError, retryable = true }) {
    task.attempts += 1;
    task.claim = null;
    task.lastError = lastError;
    if (!retryable || task.attempts >= C.MAX_ATTEMPTS) {
      transition(task, 'failed');
      task.finishedAt = at;
      return {
        state: 'failed',
        notify() {
          notifySubscribers(task, 'task.failed', { id: task.id, error: task.lastError });
          broadcast(task, 'task.closed', { id: task.id, state: 'failed' });
        },
      };
    }
    transition(task, 'open');
    if (task.subscribers.size === 0) {
      // 没人要的任务回到 open 就直接删掉：留着只会被白做一遍
      removeTask(task);
      return { state: 'removed', notify: () => broadcast(task, 'task.closed', { id: task.id, state: 'removed' }) };
    }
    const view = viewOf(task);
    return { state: 'open', notify: () => broadcast(task, 'task.opened', { task: view }) };
  }

  /** tick 里的回收：放弃，并告诉原认领者（它的那条连接还在的话） */
  function reclaim(task, lastError) {
    const { conn, token } = task.claim;
    const out = abandon(task, { lastError });
    if (isLive(conn)) emit(conn, 'task.lease-lost', { id: task.id, token, reason: 'expired' });
    out.notify();
  }

  // ---------- 身份 ----------

  /** 这条连接不再代表它原来的节点：那个节点从此算断开，等宽限期 */
  function detachNode(conn) {
    const node = nodeOf(conn);
    if (node) { node.conn = null; node.disconnectedAt = at; }
    conn.nodeId = null;
    conn.watch = null;
  }
  function detachPublisher(conn) {
    const pub = publisherOf(conn);
    if (pub) { pub.conn = null; pub.disconnectedAt = at; }
    conn.publisherId = null;
  }

  // ---------- 入站消息 ----------

  function onNodeHello(conn, body, reqId) {
    const { nodeId } = body;
    if (conn.nodeId !== null && conn.nodeId !== nodeId) detachNode(conn);
    let node = nodes.get(nodeId);
    if (node) {
      // 同一身份的新连接取代旧连接：旧连接此后不再代表这个节点，也不再收广播
      if (node.conn && node.conn !== conn) { node.conn.nodeId = null; node.conn.watch = null; }
    } else {
      node = { nodeId };
      nodes.set(nodeId, node);
    }
    Object.assign(node, {
      profile: body.profile, envFingerprint: body.envFingerprint, capabilities: body.capabilities,
      codeVersions: body.codeVersions, maxConcurrent: body.maxConcurrent,
      conn, disconnectedAt: null,
    });
    conn.nodeId = nodeId;

    // resume：不论这个 nodeId 有没有记录都一样处理（A.9）
    const resumed = [];
    const lost = [];
    const seen = new Set();
    for (const { id, token } of body.resume) {
      if (seen.has(id)) continue;
      seen.add(id);
      const task = tasks.get(id);
      if (task && task.state === 'claimed' && task.claim.nodeId === nodeId && task.claim.token === token) {
        task.claim.conn = conn;   // 接续：leaseUntil、token 都不变
        resumed.push(id);
        continue;
      }
      let reason = 'token';
      if (!task) reason = 'epoch';                                             // 本实例没有这个任务：多半是文档服务重启过
      else if (task.state === 'claimed' && task.claim.nodeId !== nodeId) reason = 'not-owner';   // C4：令牌只认认领它的节点
      lost.push({ id, token, reason });
    }

    // 这个节点名下没能接续的认领一律放弃：节点自己都不认它了，留着只会等到租约到期
    const resumedSet = new Set(resumed);
    const dropped = [];
    for (const task of tasks.values()) {
      if (task.state === 'claimed' && task.claim.nodeId === nodeId && !resumedSet.has(task.id)) dropped.push(task);
    }
    const outs = dropped.map((task) => abandon(task, { lastError: 'not-resumed' }));

    emit(conn, 'node.welcome', { nodeId, resumed, lost: lost.map((l) => l.id) }, reqId);
    for (const l of lost) emit(conn, 'task.lease-lost', l);
    for (const out of outs) out.notify();
  }

  function onPublisherHello(conn, body, reqId) {
    const { publisherId } = body;
    if (conn.publisherId !== null && conn.publisherId !== publisherId) detachPublisher(conn);
    let pub = publishers.get(publisherId);
    if (pub) {
      if (pub.conn && pub.conn !== conn) pub.conn.publisherId = null;
    } else {
      pub = { publisherId };
      publishers.set(publisherId, pub);
    }
    // 重连：订阅全部保留（F7.4）
    pub.conn = conn;
    pub.disconnectedAt = null;
    conn.publisherId = publisherId;
    emit(conn, 'publisher.welcome', { publisherId }, reqId);
  }

  function onWatch(conn, body, reqId) {
    conn.watch = body.projects === 'all' ? 'all' : new Set(body.projects);
    const visible = [...tasks.values()]
      .filter((t) => t.state === 'open' && canSee(conn, t))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(viewOf);
    emit(conn, 'queue.snapshot', { tasks: visible }, reqId);
  }

  /**
   * 派生任务的继承（A.4 末段，设计第 3 节）：细任务的 userId 是产生它的那个 plan 任务的，不是切分节点的，
   * 否则纯浏览器用户的边界（Q2）会被切分节点的身份顶掉；订阅者并上 plan 的订阅者，页面订阅了 plan
   * 就能收到细任务的 task.done，切分节点断开也不会让细任务因没人订阅被删。
   * 只在「plan 此刻正由发布连接这个节点认领着」时继承：别人拿不到这份身份。条件不满足就不继承，不报错。
   */
  function planParentOf(conn, derivedFrom) {
    if (derivedFrom === null) return null;
    const plan = tasks.get(derivedFrom);
    const node = nodeOf(conn);
    if (!plan || plan.kind !== 'plan' || plan.state !== 'claimed' || !node) return null;
    return plan.claim.nodeId === node.nodeId ? plan : null;
  }

  const ttlPassed = (task) => (task.state === 'done' || task.state === 'failed') && at - task.finishedAt > C.DONE_TTL;

  function onPublish(conn, body, reqId) {
    const publisherId = conn.publisherId;
    const results = [];
    const after = [];
    for (const input of body.tasks) {
      let task = tasks.get(input.id);
      // 过了 TTL 的 done / failed 就当已经不存在，不必等下一次 tick 才能重新发布（C1）
      if (task && ttlPassed(task)) { removeTask(task); task = undefined; }
      if (!task) {
        if ((activeByProject.get(input.source.projectId) ?? 0) >= C.MAX_TASKS_PER_PROJECT) {
          results.push({ id: input.id, error: 'limit' });
          continue;
        }
        // 用户与租户只认连接凭证，发布方自报的在校验时已经丢掉（A.4、P7）；
        // 派生任务例外：继承它的 plan 任务的身份与订阅者
        const parent = planParentOf(conn, input.source.derivedFrom);
        task = {
          id: input.id, kind: input.kind, tier: input.tier, resultKey: input.resultKey, range: input.range,
          source: {
            projectId: input.source.projectId, projectRev: input.source.projectRev,
            derivedFrom: input.source.derivedFrom,
            userId: parent ? parent.source.userId : conn.principal.userId,
            tenantId: parent ? parent.source.tenantId : conn.principal.tenantId,
            publisher: { id: publisherId }, publishedAt: at,
          },
          input: input.input, weight: input.weight, requires: input.requires, priority: input.priority,
          state: 'open', version: 1, attempts: 0, lastError: null,
          claim: null, finishedAt: null, result: null,
          subscribers: new Set([publisherId, ...(parent ? parent.subscribers : [])]),
        };
        tasks.set(task.id, task);
        countActive(task.source.projectId, 1);
        results.push({ id: task.id, state: 'open', version: 1, created: true });
        const t = task;
        const view = viewOf(t);
        after.push(() => broadcast(t, 'task.opened', { task: view }));
        continue;
      }
      if (isActive(task.state)) {
        task.subscribers.add(publisherId);
      } else if (task.state === 'done') {
        const fields = doneFields(task);
        after.push(() => emit(conn, 'task.done', fields));
      }
      // failed（未过 TTL）：不重新打开，只在回包里说明（C1）
      results.push({ id: task.id, state: task.state, version: task.version, created: false });
    }
    emit(conn, 'task.published', { results }, reqId);
    for (const fn of after) fn();
  }

  function onUnsubscribe(conn, body, reqId) {
    const publisherId = conn.publisherId;
    let targets;
    if (body.ids) {
      targets = [...new Set(body.ids)].map((id) => tasks.get(id)).filter(Boolean);
    } else {
      targets = [...tasks.values()].filter((t) => t.source.projectId === body.projectId
        && (body.projectRev === null || t.source.projectRev === body.projectRev));
    }
    const ids = [];
    const removed = [];
    for (const task of targets) {
      if (!task.subscribers.delete(publisherId)) continue;
      ids.push(task.id);
      // 没人要的 open 任务删掉；claimed 的让它做完（结果按内容键寻址，别的版本可能还用得上），做完不通知
      if (task.subscribers.size === 0 && task.state === 'open') {
        removeTask(task);
        removed.push(task);
      }
    }
    emit(conn, 'task.unsubscribed', { ids }, reqId);
    for (const task of removed) broadcast(task, 'task.closed', { id: task.id, state: 'removed' });
  }

  function onClaim(conn, body, reqId) {
    const node = nodeOf(conn);
    const { id, expectVersion } = body;
    const task = tasks.get(id);
    // 设计 4.2 的顺序，一步同步做完
    if (!task) return emit(conn, 'task.claim-rejected', { id, reason: 'gone' }, reqId);
    if (node.profile === 'browser' && task.source.userId !== conn.principal.userId) {
      // 不带 state / version：别人的任务连状态也不给纯浏览器看
      return emit(conn, 'task.claim-rejected', { id, reason: 'forbidden' }, reqId);
    }
    if (task.state !== 'open') {
      return emit(conn, 'task.claim-rejected', { id, reason: 'taken', state: task.state, version: task.version }, reqId);
    }
    if (expectVersion !== task.version) {
      return emit(conn, 'task.claim-rejected', { id, reason: 'stale', state: 'open', version: task.version }, reqId);
    }
    transition(task, 'claimed');
    task.claim = {
      nodeId: node.nodeId, conn, token: task.version, claimedAt: at,
      leaseUntil: at + C.LEASE_MS, progress: { done: null, changedAt: at },
    };
    emit(conn, 'task.claimed', {
      id, token: task.claim.token, version: task.version, leaseUntil: task.claim.leaseUntil, task: viewOf(task),
    }, reqId);
    broadcast(task, 'task.taken', { id, version: task.version }, conn);
  }

  /**
   * 令牌栅栏（设计 4.2）：任务在、是 claimed、令牌对、发消息的就是当前认领者，才算持有。
   * 否则回 lease-lost、不改状态：租约被收回后原节点即使做完，也改不了任务状态。
   */
  function heldTask(conn, body, reqId) {
    const task = tasks.get(body.id);
    if (task && task.state === 'claimed' && task.claim.token === body.token && task.claim.nodeId === conn.nodeId) return task;
    emit(conn, 'task.lease-lost', { id: body.id, token: body.token, reason: 'token' }, reqId);
    return null;
  }

  function onProgress(conn, body, reqId) {
    const task = heldTask(conn, body, reqId);
    if (!task) return;
    const claim = task.claim;
    claim.leaseUntil = at + C.LEASE_MS;
    // 停滞计时只在 done 变了的时候重起：心跳还在但画面不动的节点照样按停滞回收（F3.1）
    if (body.done !== claim.progress.done) claim.progress = { done: body.done, changedAt: at };
    emit(conn, 'task.renewed', { id: task.id, token: claim.token, leaseUntil: claim.leaseUntil }, reqId);
  }

  function onComplete(conn, body, reqId) {
    const task = heldTask(conn, body, reqId);
    if (!task) return;
    transition(task, 'done');
    task.claim = null;
    task.finishedAt = at;
    task.result = body.result;
    emit(conn, 'task.completed', { id: task.id }, reqId);
    // 没有订阅者时一条 task.done 也不发（F7.2）
    notifySubscribers(task, 'task.done', doneFields(task));
    broadcast(task, 'task.closed', { id: task.id, state: 'done' });
  }

  function onRelease(conn, body, reqId) {
    const task = heldTask(conn, body, reqId);
    if (!task) return;
    // 主动放回是让路，不是做不了：attempts 不加（C2）
    transition(task, 'open');
    task.claim = null;
    // 没人要的任务放回时同样直接删掉（A.7.6 末条），否则它会一直挂在 open 里没人清
    const orphan = task.subscribers.size === 0;
    if (orphan) removeTask(task);
    emit(conn, 'task.released', { id: task.id }, reqId);
    if (orphan) broadcast(task, 'task.closed', { id: task.id, state: 'removed' });
    else broadcast(task, 'task.opened', { task: viewOf(task) });
  }

  function onFail(conn, body, reqId) {
    const task = heldTask(conn, body, reqId);
    if (!task) return;
    const out = abandon(task, { lastError: body.error ?? 'failed', retryable: body.retryable });
    emit(conn, 'task.fail-ack', { id: task.id, state: out.state }, reqId);
    out.notify();
  }

  const HANDLERS = new Map([
    ['node.hello', onNodeHello],
    ['publisher.hello', onPublisherHello],
    ['queue.watch', onWatch],
    ['task.publish', onPublish],
    ['task.unsubscribe', onUnsubscribe],
    ['task.claim', onClaim],
    ['task.progress', onProgress],
    ['task.complete', onComplete],
    ['task.release', onRelease],
    ['task.fail', onFail],
  ]);

  // ---------- 对外接口 ----------

  function connect(connId, principal) {
    if (principal === null || typeof principal !== 'object' || typeof principal.userId !== 'string') {
      throw new TypeError('connect: principal.userId 必须是字符串');
    }
    at = now();
    // 同一 connId 重复 connect：先按断开处理旧的
    if (conns.has(connId)) disconnect(connId);
    conns.set(connId, {
      connId,
      principal: { userId: principal.userId, tenantId: typeof principal.tenantId === 'string' ? principal.tenantId : null },
      nodeId: null, publisherId: null, watch: null,
    });
  }

  function disconnect(connId) {
    const conn = conns.get(connId);
    if (!conn) return;
    at = now();
    // 认领和订阅都不动，等 tick 的宽限扫描（A.9）
    detachNode(conn);
    detachPublisher(conn);
    conns.delete(connId);
  }

  function handle(connId, message) {
    const conn = conns.get(connId);
    if (!conn) return;
    at = now();
    const parsed = parseInbound(message);
    if (!parsed.ok) {
      emit(conn, 'error', { reason: 'bad-message', detail: parsed.detail }, parsed.reqId);
      return;
    }
    const { type, reqId, body } = parsed;
    if ((NODE_TYPES.has(type) && !nodeOf(conn)) || (PUBLISHER_TYPES.has(type) && !publisherOf(conn))) {
      emit(conn, 'error', { reason: 'not-registered' }, reqId);
      return;
    }
    HANDLERS.get(type)(conn, body, reqId);
  }

  /** 时钟推进后调用：租约、停滞、宽限、TTL 四项扫描，按此顺序，比较一律严格大于（A.8） */
  function tick() {
    at = now();
    const alive = (task) => tasks.get(task.id) === task;

    for (const task of [...tasks.values()]) {
      if (alive(task) && task.state === 'claimed' && at > task.claim.leaseUntil) reclaim(task, 'lease-expired');
    }
    for (const task of [...tasks.values()]) {
      if (!alive(task) || task.state !== 'claimed') continue;
      const { progress } = task.claim;
      // 从未报过进度的只受租约管（F3.3）
      if (progress.done !== null && at - progress.changedAt > C.STALL_MS) reclaim(task, 'stalled');
    }
    for (const node of [...nodes.values()]) {
      if (node.conn !== null || at - node.disconnectedAt <= C.RECONNECT_GRACE_MS) continue;
      for (const task of [...tasks.values()]) {
        if (alive(task) && task.state === 'claimed' && task.claim.nodeId === node.nodeId) reclaim(task, 'disconnected');
      }
      nodes.delete(node.nodeId);
    }
    for (const pub of [...publishers.values()]) {
      if (pub.conn !== null || at - pub.disconnectedAt <= C.RECONNECT_GRACE_MS) continue;
      // C5：宽限过后移除它的订阅；变得没人要的 open 任务删除，claimed 的让它做完
      for (const task of [...tasks.values()]) {
        if (!task.subscribers.delete(pub.publisherId)) continue;
        if (task.subscribers.size === 0 && task.state === 'open') {
          removeTask(task);
          broadcast(task, 'task.closed', { id: task.id, state: 'removed' });
        }
      }
      publishers.delete(pub.publisherId);
    }
    for (const task of [...tasks.values()]) {
      if (ttlPassed(task)) removeTask(task);   // C1：done / failed 留 DONE_TTL，删除不发消息
    }
  }

  function describe() {
    const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const out = {
      epoch,
      tasks: [...tasks.values()].sort((a, b) => byId(a.id, b.id)).map((t) => ({
        id: t.id, projectId: t.source.projectId, state: t.state, version: t.version,
        attempts: t.attempts, lastError: t.lastError,
        claim: t.claim && {
          nodeId: t.claim.nodeId, token: t.claim.token, leaseUntil: t.claim.leaseUntil,
          progress: { done: t.claim.progress.done, changedAt: t.claim.progress.changedAt },
        },
        subscribers: [...t.subscribers].sort(byId),
        finishedAt: t.finishedAt,
      })),
      nodes: [...nodes.values()].sort((a, b) => byId(a.nodeId, b.nodeId)).map((n) => ({
        nodeId: n.nodeId, profile: n.profile, connected: n.conn !== null, disconnectedAt: n.disconnectedAt,
      })),
      publishers: [...publishers.values()].sort((a, b) => byId(a.publisherId, b.publisherId)).map((p) => ({
        publisherId: p.publisherId, connected: p.conn !== null, disconnectedAt: p.disconnectedAt,
      })),
    };
    return structuredClone(out);
  }

  return Object.freeze({
    connect, disconnect, handle, tick, describe,
    get epoch() { return epoch; },
  });
}
