/**
 * 托管档的 Agent 服务:实例登记表(契约 `docs/plan/cloud-agent-contract.md` 第 3 节)。
 *
 * 一个进程里按「项目 × 成员(`userId`)」各建一个实例(`instance.mjs`),实例之间不共用任何以页面自报 id 为键的状态:
 * 一切查找先由 `identity`(来自鉴权,不来自请求体)定实例,再在实例里按对话 id 找。
 *
 * 进程级只有三样:
 *   - `execSerial`:服务端 store 是进程里的单例(`src/store/core.ts`),所有实例的工具实现经同一把锁串行执行、
 *     进锁清场(`agent-exec.mjs` 的 `isolateStore`);
 *   - 闸(`gate`,契约第 6 节):这一块先留接口位,缺省永远放行;
 *   - 进行中的一轮的登记(按实例、按对话)。
 *
 * 这一块(甲)的范围:实例、对话在内存里的事件记录(带 `seq`,可补看)、一轮与发起它的连接无关。
 * 事件与状态落盘、用量记录、补渲发布属于后面的块(契约第 6、7、16 节),这里的接口形状已按它们留好。
 * 本文件不引用 `src/`。
 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createAgentInstance } from './instance.mjs';

export const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const HOSTED_DEFAULTS = Object.freeze({
  /** 存活实例上限;超了先回收闲置最久的,回收不动就回 busy */
  maxInstances: 24,
  /** 没有进行中的一轮、这么久没有请求的实例被回收 */
  idleMs: 10 * 60_000,
  /** 一个对话在内存里最多留多少条事件(落盘之前的兜底) */
  maxEventsPerConversation: 5000,
  /** 一轮的墙钟上限 */
  runMs: 30 * 60_000,
});

/** 闸的缺省实现:永远放行(契约第 6.2 节「现在永远放行」) */
export const ALLOW_ALL_GATE = Object.freeze({
  admitRun: () => ({ ok: true }),
  admitModelCall: () => ({ ok: true }),
  record: () => {},
  release: () => {},
});

export class AgentServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const sha = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 32);

/**
 * 对话归谁(契约第 7.2 节,主会话 2026-10-06 裁定,待用户审):创建者与限定进入的名单成员按用户名,
 * 换设备能找回;自由进入的成员(用户名是自报的)按「用户名 + 设备」,只能在原设备找回。
 * @param {{ projectId: string, userId: string, username?: string, creator?: boolean, mode?: string }} identity
 */
export function ownerKeyOf(identity) {
  if (identity.creator === true) return sha(`${identity.projectId}\ncreator`);
  if (identity.mode === 'restricted' && identity.username) return sha(`${identity.projectId}\nuser\n${identity.username}`);
  return sha(`${identity.projectId}\ndevice\n${identity.userId}`);
}

/**
 * @param {object} o
 * @param {string} o.root 仓库根目录(系统提示词等相对它找)
 * @param {(id: string) => Promise<any>} o.loadModule 前端代码的唯一入口(vite 的 `ssrLoadModule`),只交给 `ssr-host.mjs`
 * @param {string} o.docUrl 文档服务的 ws(s) 地址
 * @param {{ protocolsFor(identity: object, conversation: number): Promise<string[]> | string[] }} o.credentials
 *   这个成员的第几个对话连文档服务用的子协议(乙块接上之前由测试替身给)
 * @param {() => Promise<object> | object} o.modelConfig 这一轮用的模型配置 `{ vendor, model, apiKey?, baseUrl?, maxTokens? }`
 * @param {string | null} [o.dataDir] 数据目录;给了,模型历史放 `tenants/<项目>/owners/<主人>/conversations/<对话>/history.json`
 */
export function createHostedAgentService({
  root,
  loadModule,
  docUrl,
  credentials,
  modelConfig,
  dataDir = null,
  gate = ALLOW_ALL_GATE,
  limits: limitsIn = {},
  log = () => {},
  now = () => Date.now(),
} = {}) {
  if (typeof loadModule !== 'function') throw new TypeError('createHostedAgentService: 要 loadModule');
  if (typeof docUrl !== 'string' || !/^wss?:\/\//.test(docUrl)) throw new TypeError('createHostedAgentService: docUrl 要是 ws(s):// 地址');
  if (!credentials || typeof credentials.protocolsFor !== 'function') throw new TypeError('createHostedAgentService: 要 credentials.protocolsFor');
  if (typeof modelConfig !== 'function') throw new TypeError('createHostedAgentService: 要 modelConfig');
  const limits = { ...HOSTED_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响服务 */ } };

  /** 进程级的串行锁:所有实例的工具实现共用服务端那一份 store */
  let lock = Promise.resolve();
  const execSerial = (fn) => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  };

  /** 实例键 → { key, identity, inst, ready, convs, lastUsed, closed } */
  const instances = new Map();
  let closed = false;

  const keyOf = (identity) => `${identity.projectId}\n${identity.userId}`;

  function checkIdentity(identity) {
    if (!identity || typeof identity.projectId !== 'string' || !identity.projectId || typeof identity.userId !== 'string' || !identity.userId) {
      throw new AgentServiceError('unauthorized', '没有身份', 401);
    }
  }

  function activeRunsOf(entry) {
    let n = 0;
    for (const c of entry.convs.values()) if (c.run) n += 1;
    return n;
  }

  function closeEntry(entry, reason) {
    if (entry.closed) return;
    entry.closed = true;
    instances.delete(entry.key);
    for (const c of entry.convs.values()) {
      if (c.run) { try { c.run.abort(); } catch { /* 已经结束 */ } }
    }
    try { entry.inst.close(reason); } catch { /* 已经关了 */ }
    say('agent.instance.close', { projectId: entry.identity.projectId, user: sha(entry.identity.userId).slice(0, 8), reason });
  }

  function reclaim() {
    const at = now();
    for (const entry of [...instances.values()]) {
      if (activeRunsOf(entry) === 0 && at - entry.lastUsed >= limits.idleMs) closeEntry(entry, 'idle');
    }
  }
  const sweep = setInterval(reclaim, Math.min(60_000, limits.idleMs));
  sweep.unref?.();

  /** 找到或建出这位成员在这个项目里的实例;同一个键并发到达的共用同一次建立 */
  async function instanceFor(identity) {
    checkIdentity(identity);
    if (closed) throw new AgentServiceError('unavailable', '服务正在关闭', 503);
    const key = keyOf(identity);
    let entry = instances.get(key);
    if (!entry) {
      if (instances.size >= limits.maxInstances) {
        const idle = [...instances.values()].filter((e) => activeRunsOf(e) === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!idle) throw new AgentServiceError('busy', '云端 Agent 正忙,请稍后再试。', 503);
        closeEntry(idle, 'evicted');
      }
      const inst = createAgentInstance({
        profile: 'hosted',
        server: {
          httpServer: null,
          ssrLoadModule: loadModule,
          config: { root },
          // 托管档没有 /api/*:实例登记的桌面路由一条都不挂
          middlewares: { use() {} },
        },
        prerenderPost: null,
        latestMirror: () => null,
        latestPlayhead: () => null,
        projectId: identity.projectId,
        docUrl,
        protocolsFor: (n) => credentials.protocolsFor(identity, n),
        execSerial,
        log: (event, fields) => say(event, fields),
      });
      entry = { key, identity: { ...identity }, inst, convs: new Map(), lastUsed: now(), closed: false, ready: null };
      entry.ready = inst.bindAgent({ projectId: identity.projectId, mode: 'hosted' }).then(() => entry, (err) => {
        closeEntry(entry, 'bind-failed');
        throw new AgentServiceError('unavailable', `连不上文档服务:${err?.message ?? err}`, 503);
      });
      instances.set(key, entry);
      say('agent.instance.open', { projectId: identity.projectId, user: sha(identity.userId).slice(0, 8), instances: instances.size });
    }
    entry.lastUsed = now();
    return entry.ready;
  }

  function conversationOf(entry, id, create) {
    if (typeof id !== 'string' || !CONVERSATION_ID_RE.test(id)) throw new AgentServiceError('bad-request', '对话 id 不合法');
    let conv = entry.convs.get(id);
    if (!conv && create) {
      conv = { id, events: [], seq: 0, listeners: new Set(), run: null, state: 'idle', reason: null };
      entry.convs.set(id, conv);
    }
    return conv ?? null;
  }

  /** 事件先记下来,再发给此刻连着的流(契约第 2.4 节) */
  function emit(conv, event) {
    const ev = { ...event, seq: ++conv.seq };
    conv.events.push(ev);
    if (conv.events.length > limits.maxEventsPerConversation) conv.events.splice(0, conv.events.length - limits.maxEventsPerConversation);
    for (const cb of [...conv.listeners]) {
      try { cb(ev); } catch { /* 一条流坏了不影响别的 */ }
    }
    return ev;
  }

  function historyFileOf(identity, conversationId) {
    if (!dataDir) return null;
    return path.join(dataDir, 'tenants', identity.projectId, 'owners', ownerKeyOf(identity), 'conversations', conversationId, 'history.json');
  }

  return {
    limits,

    /**
     * 发一条消息、起一轮。这一轮从此与调用方的连接无关:事件进这个对话的事件记录,谁连着谁看。
     * @returns {Promise<{ runId: string, seq: number }>} `seq` 是这一轮第一条事件(用户消息)的序号
     */
    async send(identity, conversationId, body = {}) {
      checkIdentity(identity);
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new AgentServiceError('bad-request', '消息是空的');
      if (!CONVERSATION_ID_RE.test(String(conversationId))) throw new AgentServiceError('bad-request', '对话 id 不合法');
      const admitted = await gate.admitRun({ projectId: identity.projectId, userId: identity.userId });
      if (!admitted?.ok) throw new AgentServiceError(admitted?.code ?? 'busy', admitted?.message ?? '云端 Agent 正忙,请稍后再试。', admitted?.code === 'disabled' ? 403 : 429);
      let entry;
      let conv;
      try {
        entry = await instanceFor(identity);
        conv = conversationOf(entry, conversationId, true);
        if (conv.run) throw new AgentServiceError('busy-conversation', '这个对话还有一轮在进行。', 409);
      } catch (err) {
        gate.release({ projectId: identity.projectId, userId: identity.userId });
        throw err;
      }
      const cfg = await modelConfig();
      const runId = randomUUID();
      const first = emit(conv, { type: 'user', runId, prompt: body.prompt, from: identity.deviceName ?? null, at: now() });
      conv.state = 'running';
      conv.reason = null;
      let finished = false;
      const finish = (state, reason = null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        conv.run = null;
        conv.state = state;
        conv.reason = reason;
        entry.lastUsed = now();
        gate.release({ projectId: identity.projectId, userId: identity.userId });
        emit(conv, { type: 'end', runId, state });
        say('agent.run.end', { projectId: identity.projectId, runId, state });
      };
      let sawError = null;
      let stopped = false;
      const run = entry.inst.startHostedRun({
        runId,
        conversationId,
        prompt: body.prompt,
        model: typeof body.model === 'string' ? body.model : undefined,
        effort: typeof body.effort === 'string' ? body.effort : undefined,
        creativity: body.creativity,
        script: body.script,
        library: Array.isArray(body.library) ? body.library : [],
        pageState: body.pageState && typeof body.pageState === 'object' ? body.pageState : null,
        apiConfig: cfg,
        historyFile: historyFileOf(identity, conversationId),
        sessionKey: `cloud-${ownerKeyOf(identity).slice(0, 16)}-${conversationId}`,
        fetchImpl: body.__fetchImpl,
        onEvent: (ev) => {
          if (finished) return;
          if (ev.type === 'error') sawError = ev;
          emit(conv, { ...ev, runId });
        },
      });
      const timer = setTimeout(() => {
        if (finished) return;
        emit(conv, { type: 'error', code: 'limit', runId, message: `这一轮超过了 ${Math.round(limits.runMs / 60_000)} 分钟的上限,已停下。已经落地的改动保留在项目里。` });
        stopped = true;
        try { run.abort(); } catch { /* 已经结束 */ }
        finish('failed', 'limit');
      }, limits.runMs);
      timer.unref?.();
      conv.run = {
        runId,
        abort: () => {
          if (finished) return;
          stopped = true;
          try { run.abort(); } catch { /* 已经结束 */ }
          emit(conv, { type: 'status', runId, text: '已停止' });
          finish('idle', 'stopped');
        },
      };
      say('agent.run.start', { projectId: identity.projectId, runId });
      run.done.then(
        () => { if (!stopped) finish(sawError ? 'failed' : 'idle', sawError ? (sawError.code ?? 'model') : null); },
        (err) => {
          if (stopped) return;
          emit(conv, { type: 'error', code: 'model', runId, message: String(err?.message ?? err) });
          finish('failed', 'model');
        },
      );
      return { runId, seq: first.seq };
    },

    /**
     * 看一个对话的事件:先把 `seq` 大于 `after` 的补发,再接实时的。回退订函数。
     * 对话不存在(或不是这位成员在这个项目里的)时回 null,不泄露存在与否之外的任何东西。
     */
    subscribe(identity, conversationId, after, onEvent) {
      checkIdentity(identity);
      const entry = instances.get(keyOf(identity));
      const conv = entry && !entry.closed ? conversationOf(entry, conversationId, false) : null;
      if (!conv) return null;
      entry.lastUsed = now();
      const from = Number.isSafeInteger(after) && after > 0 ? after : 0;
      // 补发与接上实时在同一拍里做:emit 是同步的,中间插不进别的事件
      for (const ev of conv.events) if (ev.seq > from) onEvent(ev);
      conv.listeners.add(onEvent);
      return () => conv.listeners.delete(onEvent);
    },

    /** 停这个对话进行中的一轮。别人的、不存在的都当作没有 */
    abort(identity, conversationId) {
      checkIdentity(identity);
      const entry = instances.get(keyOf(identity));
      const conv = entry && !entry.closed && CONVERSATION_ID_RE.test(String(conversationId)) ? entry.convs.get(conversationId) : null;
      if (conv?.run) conv.run.abort();
      return { ok: true };
    },

    /** 这位成员在这个项目里的对话(这一块只有内存里的;落盘后由存储给) */
    conversations(identity) {
      checkIdentity(identity);
      const entry = instances.get(keyOf(identity));
      if (!entry || entry.closed) return [];
      return [...entry.convs.values()].map((c) => ({ id: c.id, state: c.state, reason: c.reason, lastSeq: c.seq }));
    },

    /** 撤销(契约第 4.5 节):关掉受影响的实例,进行中的一轮记原因后停下。`userId` 不给表示整个项目 */
    revoke({ projectId, userId = null, reason }) {
      for (const entry of [...instances.values()]) {
        if (entry.identity.projectId !== projectId) continue;
        if (userId !== null && entry.identity.userId !== userId) continue;
        for (const conv of entry.convs.values()) {
          if (!conv.run) continue;
          const runId = conv.run.runId;
          emit(conv, { type: 'error', code: 'revoked', reason, runId, message: `云端 Agent 的这段对话已失效(${reason})。已经落地的改动保留在项目里。` });
        }
        closeEntry(entry, `revoked:${reason}`);
      }
    },

    /** 诊断:不含任何正文 */
    describe() {
      return {
        instances: [...instances.values()].map((e) => ({
          projectId: e.identity.projectId,
          user: sha(e.identity.userId).slice(0, 8),
          conversations: e.convs.size,
          running: activeRunsOf(e),
        })),
      };
    },

    /** 测试与诊断:某位成员的实例(没有回 null) */
    _instance(identity) {
      return instances.get(keyOf(identity))?.inst ?? null;
    },

    async close() {
      if (closed) return;
      closed = true;
      clearInterval(sweep);
      for (const entry of [...instances.values()]) {
        for (const conv of entry.convs.values()) {
          if (conv.run) emit(conv, { type: 'error', code: 'interrupted', runId: conv.run.runId, message: '云端 Agent 服务中断,这一轮没有做完。已经落地的改动保留在项目里。' });
        }
        closeEntry(entry, 'service-close');
      }
    },
  };
}
