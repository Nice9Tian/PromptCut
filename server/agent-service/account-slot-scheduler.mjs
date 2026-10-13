/**
 * 节点上的任务槽调度：一个槽同一时间只装一个任务进程，一个进程只跑一条任务。
 *
 * 它做四件事，别的都不做：
 *   1. 有排队的对话、又有空槽时，让 root 开一代新进程，叫它去文档服务领这一条任务，把文档服务签的分配交给 root 绑定，再让它开跑。
 *   2. 任务进程交来「文档服务签的终态 + 它自己签的意向」时，让 root 真的把这一代进程关掉并写下关闭记录。
 *   3. 文档服务那边出现强制终态（用户停止、切私有、踢人、改密退出、进程死了）时，让 root 强制关掉这一代。
 *   4. 每关掉一代，再问一次文档服务（master.pending），由它读 root 的关闭记录去结清；结清了下一条才领得到。
 *
 * 它不判断任何权限，也不产生任何证明：
 *   - 领不领得到任务由文档服务定（上一条没结清就领不到），所以「第一条真结束了第二条才开始」不靠这里的状态。
 *   - 终态、强制终态、分配都是文档服务签的，意向是任务进程签的，root 的发布器各自验签；这里只是递。
 *   - 进程是不是真的关了，只认 root 的关闭记录。
 *
 * 每个槽的关闭动作排成一条队（一次只做一个）。正常终态和强制终态同时到的话先到的先做；
 * 这一代一旦关了，后到的那个不再做。结果算「做完」还是「被中断」由文档服务按它自己的记录定。
 *
 * slots[i]（root 那一侧的口子，本机测试用受控的实现，Linux 上由 root 进程实现）：
 *   slotId
 *   current()                → { rootScopeRef, phase: 'ready'|'bound'|'closed' } | null   当前这一代
 *   open()                   → { rootScopeRef, worker }    开新一代；worker 见下
 *   bind(assignment)         root 记下文档服务签的分配
 *   close({ terminal, intent })     正常关：停进程、看到进程组空了、写关闭记录
 *   forcedClose({ terminal })       强制关：同上，凭文档服务签的强制终态
 *   retire({ reason })              这一代没领到任务：关掉并回收槽
 *   observeFailure()                主进程已经不在了：写下失败观察（不是关闭记录）
 * worker：
 *   prepare(task)  → { assignment, phase, executionAllowed } | { noTask: true, code }
 *   start()
 *   settlement     Promise<{ kind: 'normal', terminal, intent } | { kind: 'abandoned', code } | { kind: 'closed' }>
 *   exited         Promise<any>   进程退出
 *   alive()        boolean
 * master（只做控制、不跑任务的那个 Agent 身份）：
 *   pending()      → { conversations: [{ projectId, conversationId, queueRevision }], scopeControls: [...] }
 *   scopeControl(row) → { unassigned: true, ... } | { unassigned: false, terminal }
 */
const fail = code => { throw Object.assign(new Error(code), { status: 503, code }); };
const sameRef = (a, b) => !!a && !!b && a.rootAuthorityId === b.rootAuthorityId && a.slotId === b.slotId &&
  a.epoch === b.epoch && a.recordDigest === b.recordDigest;
const keyOf = c => `${c.projectId}\n${c.conversationId}`;
const codeOf = error => typeof error?.code === 'string' ? error.code : 'unavailable';

export function createAccountSlotScheduler({ slots, master, pollMs = 500, log = () => {} } = {}) {
  if (!Array.isArray(slots) || !slots.length || typeof master?.pending !== 'function' || typeof master.scopeControl !== 'function' ||
      !Number.isInteger(pollMs) || pollMs < 10 ||
      slots.some(s => typeof s?.slotId !== 'string' || ['current', 'open', 'bind', 'close', 'forcedClose', 'retire', 'observeFailure']
        .some(name => typeof s[name] !== 'function')) || new Set(slots.map(s => s.slotId)).size !== slots.length)
    fail('slot-scheduler-configuration');
  const states = slots.map(adapter => ({ adapter, phase: 'unknown', ref: null, worker: null, conversation: null,
    lane: Promise.resolve(), closing: false, failure: false, forcing: null, dispatching: null, note: null }));
  let stopped = false, started = false, loop = null, wake = null, ticking = null;
  // 一个对话领不到任务（多半是上一条还没结清）时隔一会儿再试，间隔逐次加倍，不为它反复开进程。
  const cooldown = new Map();
  const rest = key => { const delay = Math.min((cooldown.get(key)?.delay ?? pollMs) * 2, 30_000); cooldown.set(key, { delay, until: Date.now() + delay }); };
  const kick = () => { wake?.(); };
  const say = (event, slot, fields = {}) => { try { log(event, { slotId: slot?.adapter.slotId, epoch: slot?.ref?.epoch, ...fields }); } catch { /* 日志不影响调度 */ } };

  /** 一个槽上的关闭类动作一次只做一个；前一个失败不拦后一个，各自的错各自报。 */
  function inLane(slot, fn) {
    const work = slot.lane.then(fn);
    slot.lane = work.catch(() => {});
    return work;
  }
  function released(slot, how) {
    say('slot.closed', slot, { how });
    slot.phase = 'idle'; slot.worker = null; slot.conversation = null; slot.closing = false; slot.failure = false; slot.note = how;
    kick();
  }
  /** root 的动作失败以后槽上可能留着发布锁，不能再自动往下做：标出来，等人看。 */
  function stuck(slot, code) { say('slot.stuck', slot, { code }); slot.phase = 'stuck'; slot.note = code; slot.closing = false; }

  function closeNormal(slot, ref, settlement) {
    return inLane(slot, async () => {
      if (!sameRef(slot.ref, ref) || slot.phase === 'idle' || slot.phase === 'stuck') return;
      // 进程已经不在了就不能按正常关：正常关要亲眼看着这一代主进程停下。改走失败观察。
      if (slot.worker && !slot.worker.alive()) return void await observe(slot, ref);
      slot.closing = true;
      try { await slot.adapter.close({ terminal: settlement.terminal, intent: settlement.intent }); released(slot, 'normal'); }
      catch (error) { stuck(slot, codeOf(error)); }
    });
  }
  function closeForced(slot, ref, row) {
    if (slot.forcing) return slot.forcing;
    const work = inLane(slot, async () => {
      if (!sameRef(slot.ref, ref) || slot.phase === 'idle' || slot.phase === 'stuck') return;
      let answer;
      // 文档服务还没把它那边的连接关完会回 503：这一轮先不做，下一轮再问。
      try { answer = await master.scopeControl(row); }
      catch (error) { say('slot.forced.pending', slot, { code: codeOf(error) }); return; }
      slot.closing = true;
      try {
        if (answer?.unassigned === true) { await slot.adapter.retire({ reason: 'assignment-failed' }); released(slot, 'retired'); }
        else if (answer?.unassigned === false && answer.terminal) { await slot.adapter.forcedClose({ terminal: answer.terminal }); released(slot, 'forced'); }
        else { slot.closing = false; say('slot.forced.protocol', slot); }
      } catch (error) { stuck(slot, codeOf(error)); }
    }).finally(() => { slot.forcing = null; });
    slot.forcing = work; void work.catch(() => {});
    return work;
  }
  function retire(slot, ref, reason) {
    return inLane(slot, async () => {
      if (!sameRef(slot.ref, ref) || slot.phase === 'idle' || slot.phase === 'stuck') return;
      slot.closing = true;
      try { await slot.adapter.retire({ reason }); released(slot, 'retired'); }
      catch (error) { stuck(slot, codeOf(error)); }
    });
  }
  /** 只写「主进程不在了」的观察。之后由文档服务据此签强制终态，再走 closeForced。 */
  async function observe(slot, ref) {
    if (!sameRef(slot.ref, ref) || slot.failure || slot.phase === 'idle' || slot.phase === 'stuck') return;
    try { await slot.adapter.observeFailure(); slot.failure = true; slot.phase = 'failed'; say('slot.failure-observed', slot); kick(); }
    catch (error) { say('slot.failure.pending', slot, { code: codeOf(error) }); }
  }
  function watch(slot, ref, worker) {
    void Promise.resolve(worker.settlement).then(result => {
      if (stopped || !sameRef(slot.ref, ref)) return;
      if (result?.kind === 'normal') return closeNormal(slot, ref, result);
      // 放弃正常结算：什么都不关，等文档服务的强制终态。
      if (result?.kind === 'abandoned') say('slot.settlement.abandoned', slot, { code: result.code });
    }).catch(() => {});
    void Promise.resolve(worker.exited).then(() => {
      // 自己关的不算；别的情况是这一代主进程没了。
      if (stopped || !sameRef(slot.ref, ref) || slot.closing || slot.phase === 'idle') return;
      return inLane(slot, () => observe(slot, ref));
    }).catch(() => {});
  }

  async function dispatch(slot, target) {
    slot.phase = 'opening'; slot.conversation = target; slot.note = null;
    let opened;
    try { opened = await slot.adapter.open(); }
    catch (error) { slot.ref = null; slot.conversation = null; return stuck(slot, codeOf(error)); }
    const ref = opened.rootScopeRef, worker = opened.worker;
    slot.ref = ref; slot.worker = worker; slot.failure = false; slot.closing = false;
    watch(slot, ref, worker);
    say('slot.opened', slot, target);
    let prepared;
    try {
      prepared = await worker.prepare({ projectId: target.projectId, conversationId: target.conversationId,
        requestId: `dispatch:${ref.slotId}:${ref.epoch}` });
    } catch (error) {
      // 不知道文档服务有没有记下这次领取。不退槽（退了而它记下了，那条任务就永远结不清）：
      // 让这一代主进程停下、写失败观察；文档服务有记录就会签强制终态，由 closeForced 收。
      say('slot.prepare.unknown', slot, { code: codeOf(error) });
      slot.phase = 'failed';
      try { await worker.stop?.(); } catch { /* 停不下来就等它自己退出 */ }
      return inLane(slot, () => observe(slot, ref));
    }
    if (prepared?.noTask === true) {
      say('slot.no-task', slot, { code: prepared.code }); rest(keyOf(target));
      return retire(slot, ref, prepared.stage === 'registration' ? 'registration-failed' : 'assignment-failed');
    }
    slot.phase = 'assigned';
    try {
      await inLane(slot, () => slot.adapter.bind(prepared.assignment));
      await worker.start();
      if (sameRef(slot.ref, ref) && slot.phase === 'assigned') slot.phase = 'running';
      cooldown.delete(keyOf(target)); say('slot.running', slot, target);
    } catch (error) {
      // 文档服务已经有这条任务的授权了。同上：停主进程、写失败观察，等强制终态。
      say('slot.start.failed', slot, { code: codeOf(error) });
      if (!sameRef(slot.ref, ref) || slot.phase === 'idle') return;
      slot.phase = 'failed';
      try { await worker.stop?.(); } catch { /* 同上 */ }
      return inLane(slot, () => observe(slot, ref));
    }
  }

  async function adopt() {
    for (const slot of states) {
      const current = await slot.adapter.current();
      if (!current || current.phase === 'closed') { slot.phase = 'idle'; slot.ref = current?.rootScopeRef ?? null; continue; }
      // 上一个调度进程留下的一代：没有它的通道了，只能等它的主进程退出后写失败观察，再凭强制终态关。
      slot.phase = 'orphan'; slot.ref = current.rootScopeRef; slot.worker = null; say('slot.adopted', slot, { phase: current.phase });
    }
  }
  // 第一次用之前先看一眼每个槽现在停在哪一代（只看一次）。
  let adopting = null;
  const ready = () => adopting ??= adopt();
  async function tickOnce() {
    await ready();
    // 主进程该没而还没写下失败观察的槽（上一个调度进程留下的、领取或启动失败的），每一轮再试一次。
    for (const slot of states) if (['orphan', 'failed'].includes(slot.phase) && !slot.failure) await inLane(slot, () => observe(slot, slot.ref));
    // 每一轮都先问文档服务：它在这一问里读 root 的失败观察和关闭记录，该签强制终态的签、该结清的结清。
    const listed = await master.pending();
    if (!Array.isArray(listed?.conversations)) fail('slot-scheduler-pending-protocol');
    for (const row of listed.scopeControls ?? []) {
      const slot = states.find(s => sameRef(s.ref, row.rootScopeRef));
      if (slot && !['idle', 'stuck', 'unknown'].includes(slot.phase)) void closeForced(slot, slot.ref, row);
    }
    const serving = new Set(states.filter(s => s.conversation).map(s => keyOf(s.conversation)));
    for (const row of listed.conversations) {
      if (stopped) break;
      const key = keyOf(row);
      if (serving.has(key) || (cooldown.get(key)?.until ?? 0) > Date.now()) continue;
      const slot = states.find(s => s.phase === 'idle');
      if (!slot) break;
      serving.add(key);
      const target = { projectId: row.projectId, conversationId: row.conversationId };
      slot.phase = 'opening'; slot.conversation = target;
      const work = dispatch(slot, target).catch(error => { say('slot.dispatch.failed', slot, { code: codeOf(error) }); })
        .finally(() => { if (slot.dispatching === work) slot.dispatching = null; });
      slot.dispatching = work;
    }
  }
  function tick() {
    ticking ??= tickOnce().finally(() => { ticking = null; });
    return ticking;
  }
  return {
    async start() {
      if (started) fail('slot-scheduler-started');
      started = true; await ready();
      loop = (async () => {
        while (!stopped) {
          try { await tick(); } catch (error) { say('scheduler.tick.failed', null, { code: codeOf(error) }); }
          if (stopped) break;
          await new Promise(resolve => { const timer = setTimeout(resolve, pollMs); timer.unref?.(); wake = () => { clearTimeout(timer); resolve(); }; });
          wake = null;
        }
      })();
    },
    /** 测试和排障用：立刻做一轮，等它做完。 */
    tick, kick,
    /** 只停调度，不关任何进程、不动任何槽：关进程是 root 凭文档服务的终态做的事。 */
    async stop() {
      stopped = true; kick(); await loop;
      await Promise.allSettled(states.flatMap(s => [s.lane, s.dispatching, s.forcing]));
    },
    describe: () => states.map(s => ({ slotId: s.adapter.slotId, phase: s.phase, epoch: s.ref?.epoch ?? null,
      conversation: s.conversation ? { ...s.conversation } : null, failureObserved: s.failure, note: s.note })),
  };
}
