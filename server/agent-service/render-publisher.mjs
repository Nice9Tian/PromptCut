/**
 * 补渲的发布通道(真的那一个):Agent 服务以**服务身份**在文档服务的任务队列里发布清单计划,让渲染节点把云端 Agent
 * 改到的片段渲出来(契约 `docs/plan/cloud-agent-contract.md` 第 16 节;`docs/plan/hosted-render-contract.md` 第 5a 节)。
 * 形状是 `server/agent/service/render-request.mjs` 文件头写的 `publisher`。
 *
 * 一个项目一条发布连接:`hosted.ticket { purpose: 'publish' }` 要一张只能发布的连接票据(服务自己的身份,不带任何成员的权限),
 * 握手后 `publisher.hello`。这条连接上只能发 `publisher.hello`、`task.publish`(带片段清单的计划)、`task.unsubscribe`。
 * 连接开着期间每分钟在控制连接上声明一次「这个项目有活」(`hosted.demand`),关的时候撤回。
 *
 * 队列怎么把进度告诉发布方(第三段 5a 节的三个边界,照着做):
 *   - 计划被渲染节点认领、切成细任务后,计划自己先 `task.done`,结果里的 `derived` 是切出的细任务 id;
 *     细任务继承计划的订阅者,所以之后**每做完一段**发布方收到一条 `task.done`(帧级的进度不转给发布方)。
 *     本模块把「任何一条 `task.done`」都算作这个项目里各计划的进度;一个计划的全部细任务都有了结果才算它完成。
 *   - 发布连接至少要保持到计划被认领:计划还没被认领、发布方又断开超过队列的宽限期(10 秒),计划会被撤。
 *     本模块的连接一直保持到计划完成;中途断了由 `render-request.mjs` 退避重开并**重发同一个计划**。
 *   - 断开期间做完的细任务不会补发通知;重发时计划若已经切完(回包 `state: 'done'`),或者别的发布方(在线页面)先发过同一个计划,
 *     发布方不在那些细任务的订阅者里。这时改发同一份清单的补渲档计划(结果键不同,所以是一个新的计划任务):
 *     渲染节点重新切一次,已有的细任务把发布方并进订阅者、做完的当场各补一条 `task.done`。同一份清单十分钟内只这样核对一次;
 *     还对不上就交给 `render-request.mjs` 的「连续没有进度」去放弃,由之后进来的页面按现有规则自己发。
 *
 * 项目往前走了(`docs/plan/render-queue-contract.md` J.15、`cloud-agent-contract.md` 第 16.4 节):
 *   - 细任务以 `task.failed { error: 'superseded' }` 收场 = 渲染节点判这份内容已被新版本取代、作废了。这**不是失败**:
 *     它算「有了结局」,计划照常收尾;内容换成了什么由改它的那一方(本服务的下一个计划、别的成员的页面)负责发。
 *   - 计划每被切一次(原计划、核对用的那一次)都以最新那一次给的细任务清单为准:渲染节点可能是按更新的版本切的。
 *   - 计划有了结局(完成、失败、撤回)就退订它与它的细任务(别的计划还要的除外),账上它们的失败与作废一并清掉。
 *     这样之后的计划再遇到同一个细任务时,队列会把它当成新并入的订阅者、把那一刻的真实状态补发过来,不凭旧账判。
 *
 * 票据原文不进日志。本文件不引用 `src/`。
 */
import { createHash } from 'node:crypto';
import { frameCode } from '../frame-code.mjs';
import { backfillPlanTaskOf } from '../render-queue/messages.mjs';

export const PUBLISHER_DEFAULTS = Object.freeze({
  connectTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
  /** 「这个项目有活」的声明保持多久、多久续一次 */
  demandHoldMs: 120_000,
  demandEveryMs: 60_000,
});

/**
 * @param {object} o
 * @param {ReturnType<import('../auth/service-client.mjs').createServiceClient>} o.client
 * @param {string} o.docUrl
 * @param {string} o.root
 * @param {(projectId: string) => { available: boolean, enabled: boolean }} o.renderState 渲染节点对这个项目开没开
 * @param {typeof globalThis.WebSocket} [o.WebSocketImpl]
 * @param {() => string | null} [o.codeVersionOf] 测试用:换掉代码版本的算法
 */
export function createQueuePublisher({
  client, docUrl, root, renderState, now = () => Date.now(), log = () => {}, WebSocketImpl = globalThis.WebSocket, codeVersionOf = null, limits: limitsIn = {},
} = {}) {
  const limits = { ...PUBLISHER_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响发布 */ } };
  /** 队列里「作废」的任务的 error(`render-queue/queue.mjs` 的 `isSuperseded`;执行器经 `task.fail` 报的也是它) */
  const SUPERSEDED = 'superseded';
  let version;
  /**
   * 跨连接留着的账,projectId → { done: Set(细任务 id), failed: Map(细任务 id → 原因), gone: Set(作废的细任务 id), plans: Map(计划 id → 计划的账) }。
   * 细任务的结果按内容寻址、做完就不会变,所以断线重连之后之前看到的完成仍然算数。项目里没有计划了就清掉。
   */
  const books = new Map();
  const handles = new Set();
  let seq = 0;

  const bookOf = (projectId) => {
    let b = books.get(projectId);
    if (!b) { b = { done: new Set(), failed: new Map(), gone: new Set(), plans: new Map() }; books.set(projectId, b); }
    return b;
  };
  const dropBookIfIdle = (projectId) => { const b = books.get(projectId); if (b && b.plans.size === 0) books.delete(projectId); };

  async function open(projectId, handlers = {}) {
    const t = await client.publishTicket(projectId);
    if (!t.ok) throw Object.assign(new Error(`要不到发布用的连接票据(${t.reason})`), { reason: t.reason });
    const book = bookOf(projectId);
    const publisherId = `agent-pub-${createHash('sha256').update(`${client.instanceId}\n${projectId}`).digest('hex').slice(0, 24)}`;
    const ws = new WebSocketImpl(docUrl, client.dataProtocols(t.ticket));
    /** reqId → { resolve, timer } */
    const waiting = new Map();
    /** 核对用的补渲档计划 id → 原计划 id */
    const alias = new Map();
    let closing = false;
    let down = false;
    let demandTimer = null;
    let handle = null;

    const call = (name, arg) => { try { handlers[name]?.(arg); } catch (err) { say('agent.publish.handler-error', { projectId, message: String(err?.message ?? err).slice(0, 120) }); } };

    function request(message) {
      return new Promise((resolve) => {
        if (down) { resolve({ type: 'error', reason: 'closed' }); return; }
        const reqId = `ap-${(seq += 1)}`;
        const timer = setTimeout(() => { waiting.delete(reqId); resolve({ type: 'error', reason: 'timeout' }); }, limits.requestTimeoutMs);
        timer.unref?.();
        waiting.set(reqId, { resolve, timer });
        try { ws.send(JSON.stringify({ ...message, reqId })); } catch { waiting.delete(reqId); clearTimeout(timer); resolve({ type: 'error', reason: 'closed' }); }
      });
    }

    const resolved = (id) => book.done.has(id) || book.failed.has(id) || book.gone.has(id);

    /**
     * 这个计划有了结局(完成、失败、撤回):从账上拿掉,退订它与它切出过的细任务(别的计划还要的不退),
     * 这些细任务的失败与作废记录一并清掉(完成的留着:内容寻址,做完就不会变)。见文件头。
     */
    function conclude(plan) {
      book.plans.delete(plan.id);
      for (const [v, p] of alias) if (p === plan.id) alias.delete(v);
      const wanted = new Set();
      for (const other of book.plans.values()) for (const id of other.derived ?? []) wanted.add(id);
      const mine = [...(plan.every ?? plan.derived ?? [])].filter((id) => !wanted.has(id));
      for (const id of mine) { book.failed.delete(id); book.gone.delete(id); }
      const ids = [plan.id, ...(plan.verifyId ? [plan.verifyId] : []), ...mine];
      dropBookIfIdle(projectId);
      return down ? Promise.resolve() : request({ type: 'task.unsubscribe', ids });
    }

    /** 看一遍这个项目里各计划:细任务都有结果的收尾,其余报一次进度 */
    function settle(progressed) {
      for (const plan of [...book.plans.values()]) {
        if (plan.derived) {
          const ids = [...plan.derived];
          const done = ids.filter((id) => book.done.has(id)).length;
          if (ids.every(resolved)) {
            const bad = ids.find((id) => book.failed.has(id));
            const reason = bad !== undefined ? String(book.failed.get(bad)).slice(0, 120) : null;
            const gone = ids.filter((id) => book.gone.has(id)).length;
            void conclude(plan);
            if (reason !== null) call('onFail', { id: plan.id, reason: `渲染节点报告失败:${reason}` });
            else call('onDone', { id: plan.id, ...(gone ? { superseded: gone } : {}) });
            continue;
          }
          if (progressed) call('onProgress', { id: plan.id, done, total: ids.length });
        } else if (progressed) {
          call('onProgress', { id: plan.id });
        }
      }
      dropBookIfIdle(projectId);
    }

    /** 这个计划切完了却有细任务的结果没见过(发布方不在它们的订阅者里):改发补渲档的同一份清单,让渲染节点重新切一次 */
    async function verify(plan) {
      if (plan.verified || down) return;
      plan.verified = true;
      const task = backfillPlanTaskOf({ projectId: plan.task.source.projectId, projectRev: plan.task.source.projectRev, clips: plan.task.input.clips });
      if (plan.task.requires?.codeVersion) task.requires = { codeVersion: plan.task.requires.codeVersion };
      if (task.id === plan.id) return;
      alias.set(task.id, plan.id);
      plan.verifyId = task.id;
      const r = await request({ type: 'task.publish', tasks: [task] });
      say('agent.publish.verify', { projectId, ok: r.type === 'task.published', state: r.results?.[0]?.state ?? null });
    }

    function onPlanDone(plan, msg) {
      const derived = Array.isArray(msg.result?.derived) ? msg.result.derived.map(String) : [];
      // 以最新这一次切分给的清单为准(渲染节点可能是按更新的版本切的,旧清单里已被取代的不再等);切出过的都记着,收尾时一起退订
      plan.every = new Set([...(plan.every ?? []), ...derived]);
      plan.derived = new Set(derived);
      plan.split = true;
      settle(true);
      if (book.plans.has(plan.id) && plan.uncertain && ![...plan.derived].every(resolved)) void verify(plan);
    }

    function onMessage(msg) {
      const w = msg?.reqId !== undefined ? waiting.get(msg.reqId) : undefined;
      if (w) { waiting.delete(msg.reqId); clearTimeout(w.timer); w.resolve(msg); return; }
      if (msg?.type === 'task.done' && typeof msg.id === 'string') {
        const plan = book.plans.get(alias.get(msg.id) ?? msg.id);
        if (plan) { onPlanDone(plan, msg); return; }
        book.done.add(msg.id);
        book.failed.delete(msg.id);
        book.gone.delete(msg.id);
        settle(true);
        return;
      }
      if (msg?.type === 'task.failed' && typeof msg.id === 'string') {
        if (alias.has(msg.id)) return; // 核对用的计划没切成:原计划照旧等着,由「连续没有进度」兜底
        const plan = book.plans.get(msg.id);
        if (plan) {
          book.plans.delete(plan.id);
          call('onFail', { id: plan.id, reason: `渲染节点没有接下这个计划:${String(msg.error ?? 'failed').slice(0, 120)}` });
          dropBookIfIdle(projectId);
          return;
        }
        // 作废(这份内容已被新版本取代)不是失败:只记「有了结局」
        if (msg.error === SUPERSEDED) { if (!book.done.has(msg.id)) book.gone.add(msg.id); settle(false); return; }
        if (!book.done.has(msg.id)) book.failed.set(msg.id, String(msg.error ?? 'failed'));
        settle(false);
      }
    }

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { ws.close(); } catch { /* 还没连上 */ } reject(new Error('发布连接超时')); }, limits.connectTimeoutMs);
      timer.unref?.();
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('close', (ev) => { clearTimeout(timer); reject(Object.assign(new Error(`发布连接没建成(${ev.code ?? 0})`), { closeCode: ev.code ?? null })); }, { once: true });
      ws.addEventListener('error', () => { /* 紧跟着会有 close */ });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      onMessage(msg);
    });
    ws.addEventListener('close', (ev) => {
      down = true;
      clearInterval(demandTimer);
      for (const [reqId, w] of waiting) { clearTimeout(w.timer); w.resolve({ type: 'error', reason: 'closed' }); waiting.delete(reqId); }
      handles.delete(handle);
      say('agent.publish.close', { projectId, code: ev.code ?? null, reason: String(ev.reason ?? '').slice(0, 40), byUs: closing });
      if (!closing) call('onClose');
    });

    const hello = await request({ type: 'publisher.hello', publisherId });
    if (hello.type !== 'publisher.welcome') {
      closing = true;
      try { ws.close(); } catch { /* 已经断了 */ }
      throw Object.assign(new Error(`发布方报到被拒(${hello.reason ?? hello.type})`), { reason: hello.reason ?? 'refused' });
    }
    const demand = () => { void client.demand(projectId, limits.demandHoldMs); };
    demand();
    demandTimer = setInterval(demand, limits.demandEveryMs);
    demandTimer.unref?.();
    say('agent.publish.open', { projectId });

    handle = {
      /** 发一个计划。队列不收(超出上限、被拒)时抛错;已经失败过且还没过保留期的当场报失败 */
      async publish(task) {
        const again = book.plans.get(task.id);
        const plan = again ?? { id: task.id, task, derived: null, split: false, uncertain: false, verified: false, verifyId: null };
        // 重发(断线重开之后):断开期间做完的细任务没有通知,切完之后要核对一次
        if (again) { plan.uncertain = true; plan.verified = false; }
        book.plans.set(plan.id, plan);
        const r = await request({ type: 'task.publish', tasks: [task] });
        const item = r.type === 'task.published' ? r.results?.[0] : null;
        if (!item || item.error) {
          book.plans.delete(plan.id);
          dropBookIfIdle(projectId);
          throw Object.assign(new Error(`队列没有收下这个计划(${item?.error ?? r.reason ?? r.type})`), { reason: item?.error ?? r.reason ?? 'refused' });
        }
        // 别的发布方先发过同一个计划、而且已经切完:它切出的细任务的订阅者里没有我们
        if (item.created === false && item.state === 'done') plan.uncertain = true;
        // 计划的完成通知可能比这个回包先到:那时还不知道要核对,这里补上
        if (plan.uncertain && plan.split && book.plans.has(plan.id) && ![...plan.derived].every(resolved)) void verify(plan);
        if (item.state === 'failed') {
          book.plans.delete(plan.id);
          dropBookIfIdle(projectId);
          queueMicrotask(() => call('onFail', { id: plan.id, reason: '渲染节点上一次没有做成这一版,稍后由进入项目的页面重发' }));
        }
        say('agent.publish.plan', { projectId, created: item.created === true, state: item.state ?? null, clips: task.input?.clips?.length ?? 0 });
      },
      /** 撤回:不再订这个计划与它切出的细任务(别的计划还要的不退;没人要、还没被认领的由队列删掉;已经在做的做完) */
      async withdraw(id) {
        const plan = book.plans.get(id);
        if (plan) { await conclude(plan); return; }
        dropBookIfIdle(projectId);
        if (!down) await request({ type: 'task.unsubscribe', ids: [id] });
      },
      close() {
        if (closing) return;
        closing = true;
        clearInterval(demandTimer);
        if (client.connected) void client.demand(projectId, 0);
        try { ws.close(1000, 'publisher-close'); } catch { /* 已经断了 */ }
        handles.delete(handle);
      },
    };
    handles.add(handle);
    return handle;
  }

  return {
    availability(projectId) {
      const s = renderState(projectId) ?? {};
      return { available: s.available === true && client.connected === true, enabled: s.enabled === true };
    },
    /** 这份检出的代码版本(与渲染服务、在线页面同一种算法;三者出自同一个提交时相同) */
    codeVersion() {
      if (version === undefined) {
        try { version = typeof codeVersionOf === 'function' ? codeVersionOf() : frameCode(root); } catch { version = null; }
      }
      return version;
    },
    open,
    describe: () => ({ connections: handles.size, projects: books.size }),
    close() {
      for (const h of [...handles]) h.close();
      books.clear();
    },
  };
}
