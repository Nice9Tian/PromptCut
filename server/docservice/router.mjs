/**
 * 文档服务的通用核心：连接登记、解析 JSON 信封、按消息类型把消息路由给已挂的模块、模块挂载与冲突检查。
 *
 * 契约见 `docs/plan/` 下 M5a 契约的 G.2、G.3（文件名含守门词，这里不写全）。文档服务是通用的文本 / JSON 分发中心
 * （`docs/semantics/architecture/document-service.md`「职责」），所以本文件不认识任何具体业务：
 * 不引用业务模块，也不按业务消息名写分支。业务都在组装层挂上来的模块里。
 *
 * 传输由组装层负责：本文件只经构造时给的 `write(connId, text)` 往外写已序列化的消息。
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

/** 核心自己在 `describeConn` 里给的字段，模块不能重名（G.3「字段冲突」） */
const CORE_CONN_FIELDS = Object.freeze(['connId', 'remote', 'principal', 'connectedAt']);
/**
 * `/healthz` 的核心字段（G.4），模块的 `health()` 不能重名。`conns` 也留给核心：
 * 组装层的 `describe()` 把健康字段和 `conns` 平铺在同一层。
 */
const CORE_HEALTH_FIELDS = Object.freeze(['ok', 'service', 'uptimeMs', 'connections', 'protocol', 'modules', 'conns']);

/** 挂载时拿来问 `describeConn` 字段名的连接 id：不会和真连接撞上 */
const PROBE_CONN_ID = '\u0000probe';

/** 两条类型声明是否会认领同一条消息（G.3「类型冲突」） */
function typesClash(a, b) {
  const pa = a.endsWith('.');
  const pb = b.endsWith('.');
  if (!pa && !pb) return a === b;
  if (pa && pb) return a.startsWith(b) || b.startsWith(a);
  return pa ? b.startsWith(a) : a.startsWith(b);
}

function fieldNames(fn, arg) {
  const out = fn(arg);
  if (!isObj(out)) throw new TypeError('describeConn / health 必须返回对象');
  return Object.keys(out);
}

/** 把模块给的字段合进 `into`；已有的字段（核心字段、先挂的模块）不让覆盖 */
function mergeFields(into, fields) {
  if (!isObj(fields)) return;
  for (const [k, v] of Object.entries(fields)) {
    if (!Object.hasOwn(into, k)) into[k] = v;
  }
}

/**
 * @param {object} options
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {(connId: string, text: string) => void} options.write 把一条已序列化的消息写到连接上
 */
export function createRouter({ now = Date.now, log = () => {}, write }) {
  if (typeof write !== 'function') throw new TypeError('createRouter: write 必须是函数');

  /** connId → { connId, principal, remote, connectedAt } */
  const conns = new Map();
  /** 按挂载顺序：{ mod, ctx, connFields, healthFields } */
  const mounted = [];

  function send(connId, message) {
    if (!conns.has(connId)) return;
    write(connId, JSON.stringify(message));
  }

  function replyError(connId, reason, detail, reqId) {
    const msg = { type: 'error', reason, detail };
    if (reqId !== undefined) msg.reqId = reqId;
    send(connId, msg);
  }

  /** 调模块的生命周期钩子；抛错只记日志，不影响核心和别的模块 */
  function callHook(entry, hook, ...args) {
    const fn = entry.mod[hook];
    if (typeof fn !== 'function') return;
    try {
      fn.call(entry.mod, entry.ctx, ...args);
    } catch (err) {
      log('module.error', { module: entry.mod.name, hook, message: String(err?.message ?? err) });
    }
  }

  function ownerOf(type) {
    for (const entry of mounted) {
      for (const t of entry.mod.types) {
        if (t.endsWith('.') ? type.startsWith(t) : type === t) return entry;
      }
    }
    return null;
  }

  function validate(mod) {
    if (!isObj(mod)) throw new TypeError('模块必须是对象');
    if (typeof mod.name !== 'string' || mod.name === '') throw new TypeError('模块的 name 必须是非空字符串');
    if (!Array.isArray(mod.types) || mod.types.some((t) => typeof t !== 'string' || t === '')) {
      throw new TypeError(`模块 ${mod.name} 的 types 必须是非空字符串数组`);
    }
    if (typeof mod.handle !== 'function') throw new TypeError(`模块 ${mod.name} 的 handle 必须是函数`);
    for (const hook of ['connect', 'disconnect', 'tick', 'describeConn', 'health', 'describe']) {
      if (mod[hook] !== undefined && typeof mod[hook] !== 'function') throw new TypeError(`模块 ${mod.name} 的 ${hook} 必须是函数`);
    }
  }

  function mount(mod) {
    validate(mod);
    if (mounted.some((e) => e.mod.name === mod.name)) throw new Error(`模块名 ${mod.name} 已经挂上了`);
    for (const e of mounted) {
      for (const a of mod.types) {
        for (const b of e.mod.types) {
          if (typesClash(a, b)) throw new Error(`模块 ${mod.name} 的类型 ${a} 与已挂模块 ${e.mod.name} 的 ${b} 冲突`);
        }
      }
    }
    const connFields = mod.describeConn ? fieldNames((id) => mod.describeConn(id), PROBE_CONN_ID) : [];
    const healthFields = mod.health ? fieldNames(() => mod.health()) : [];
    for (const f of connFields) {
      if (CORE_CONN_FIELDS.includes(f)) throw new Error(`模块 ${mod.name} 的连接字段 ${f} 与核心字段重名`);
      const other = mounted.find((e) => e.connFields.includes(f));
      if (other) throw new Error(`模块 ${mod.name} 的连接字段 ${f} 与模块 ${other.mod.name} 重名`);
    }
    for (const f of healthFields) {
      if (CORE_HEALTH_FIELDS.includes(f)) throw new Error(`模块 ${mod.name} 的健康字段 ${f} 与核心字段重名`);
      const other = mounted.find((e) => e.healthFields.includes(f));
      if (other) throw new Error(`模块 ${mod.name} 的健康字段 ${f} 与模块 ${other.mod.name} 重名`);
    }

    const ctx = Object.freeze({ send, now: () => now(), log: (event, fields) => log(event, fields) });
    const entry = { mod, ctx, connFields, healthFields };
    mounted.push(entry);
    for (const c of conns.values()) callHook(entry, 'connect', c.connId, c.principal);

    let done = false;
    return function unmount() {
      if (done) return;
      done = true;
      const i = mounted.indexOf(entry);
      if (i < 0) return;
      for (const c of conns.values()) callHook(entry, 'disconnect', c.connId);
      mounted.splice(mounted.indexOf(entry), 1);
    };
  }

  function dispatch(connId, text) {
    if (!conns.has(connId)) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return replyError(connId, 'bad-message', '不是合法的 JSON');
    }
    const reqId = isObj(msg) && isReqId(msg.reqId) ? msg.reqId : undefined;
    if (!isObj(msg) || typeof msg.type !== 'string') return replyError(connId, 'bad-message', '消息必须是带字符串 type 字段的对象', reqId);
    const entry = ownerOf(msg.type);
    if (!entry) return replyError(connId, 'unsupported', '没有模块处理这种消息', reqId);

    const fail = (err) => {
      log('module.error', { module: entry.mod.name, type: msg.type, message: String(err?.message ?? err) });
      replyError(connId, 'internal', '处理这条消息时出错', reqId);
    };
    let result;
    try {
      result = entry.mod.handle(entry.ctx, connId, msg);
    } catch (err) {
      return fail(err);
    }
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      result.then(undefined, fail);
    }
  }

  return {
    connect(connId, principal, info = {}) {
      if (conns.has(connId)) throw new Error(`连接 ${connId} 已经登记过`);
      const conn = {
        connId,
        principal: { ...principal },
        remote: info.remote ?? null,
        connectedAt: info.connectedAt ?? now(),
      };
      conns.set(connId, conn);
      for (const entry of [...mounted]) callHook(entry, 'connect', connId, conn.principal);
    },

    disconnect(connId) {
      if (!conns.has(connId)) return;
      for (const entry of [...mounted]) callHook(entry, 'disconnect', connId);
      conns.delete(connId);
    },

    dispatch,
    mount,

    tick(name) {
      for (const entry of [...mounted]) {
        if (name === undefined || entry.mod.name === name) callHook(entry, 'tick');
      }
    },

    send,

    describeConn(connId) {
      const c = conns.get(connId);
      if (!c) return null;
      const out = { connId: c.connId, remote: c.remote, principal: { ...c.principal }, connectedAt: c.connectedAt };
      for (const entry of mounted) {
        if (!entry.mod.describeConn) continue;
        try {
          mergeFields(out, entry.mod.describeConn(connId));
        } catch (err) {
          log('module.error', { module: entry.mod.name, hook: 'describeConn', message: String(err?.message ?? err) });
        }
      }
      return out;
    },

    health() {
      const out = { connections: conns.size, modules: mounted.map((e) => e.mod.name) };
      for (const entry of mounted) {
        if (!entry.mod.health) continue;
        try {
          mergeFields(out, entry.mod.health());
        } catch (err) {
          log('module.error', { module: entry.mod.name, hook: 'health', message: String(err?.message ?? err) });
        }
      }
      return out;
    },

    modules() {
      return mounted.map((e) => e.mod.name);
    },
  };
}
