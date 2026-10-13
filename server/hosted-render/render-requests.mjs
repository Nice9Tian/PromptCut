/**
 * 托管方渲染服务里「看画面」请求的持久队列（0.7.18 第 3 项的云端排队那一半；设计 `docs/plan/three-versions-018-design.md`
 * 「渲染容量排队与Agent优先」，契约 `docs/plan/hosted-render-contract.md` 第 4 节 2026-10-08 的容量策略对齐）。管理进程用。
 *
 * 为什么要它：原来看画面的请求在忙时直接回「忙」（排队满了、背压暂停、别的项目的隔离工作进程在跑到时限）。用户审定的规矩是
 * 「超出时排队等，不提示已满」。所以每个请求先登记在这里，轮到了才转给工作进程；管理进程重启后排着的请求还在。
 *
 * 本文件只管**登记、次序、落盘、等结果**，不认识工作进程、不发请求（那是 `look.mjs` 的调度）。
 *
 * # 一个请求的一生
 *
 *   queued ──轮到──▶ running ──出图──▶ done
 *     ▲                 │
 *     └──这一次没成──────┘（还有重试次数：回到 queued，次序不变，所以它仍排在最前）
 *   任何时候 ──▶ failed（重试用完、等得超过上限、项目关了）｜cancelled（调用方撤回、调用方不再来问）
 *
 * # 落盘（给了 `dir` 才落；不给就只在内存里，单测与「同步等」的旧调用方用）
 *
 *   <dir>/<id>.req.json     { v, id, seq, owner, projectId, path, cards, createdAt, attemptMs?, retries?, body }   登记时写一次；出了结果就删
 *   <dir>/<id>.state.json   { v, state, attempts, finishedAt?, result? }                     每次变化重写（很小；结果在里面）
 *
 * 请求体里有项目内容，所以目录 0700、文件 0600（管理进程的用户；部署时工作进程是另一个用户，读不到）。写用「临时文件 + 改名」。
 * 重启后 `load()`：没出结果的一律回到 queued（正在做的那一个也是——那一次不算重试次数：管理进程重启是暂时性故障）；
 * 出了结果的留到 `resultKeepMs` 给调用方来取，过期删掉。
 *
 * 落盘失败（磁盘满、目录写不了）不拒绝请求：这一条只在内存里排（`persisted: false`，日志里明说），重启后它就没了。
 */
import fs from 'node:fs';
import path from 'node:path';

export const RENDER_REQUEST_DEFAULTS = Object.freeze({
  /** 同时登记着（排队的加在做的）的最多几个。到了回 full：调用方过一会儿再登记，不算失败〔裁，三级：防止磁盘被请求体占满〕 */
  maxQueued: 64,
  /** 出了结果之后留多久给调用方来取 */
  resultKeepMs: 10 * 60_000,
  /** 调用方已经取走过一次的结果再留多久（它没收到回执会重问）；之后清掉，不让带图的结果在内存和盘上攒着 */
  deliveredKeepMs: 60_000,
});

export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const FINAL = new Set(['done', 'failed', 'cancelled']);
export const isFinal = (state) => FINAL.has(state);

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * @param {object} o
 * @param {string | null} [o.dir] 落盘目录；null 只在内存里
 * @param {() => number} [o.now]
 * @param {(event: string, fields?: object) => void} [o.log]
 */
export function createRenderRequests({ dir = null, now = Date.now, log = () => {}, limits: limitsIn = {} } = {}) {
  const limits = { ...RENDER_REQUEST_DEFAULTS, ...limitsIn };
  /** id → 请求 */
  const entries = new Map();
  let nextSeq = 1;
  let diskOk = dir !== null;
  const counts = { added: 0, restored: 0, done: 0, failed: 0, cancelled: 0, requeued: 0, full: 0, persistFailed: 0 };

  const reqFile = (id) => path.join(dir, `${id}.req.json`);
  const stateFile = (id) => path.join(dir, `${id}.state.json`);
  const rm = (file) => { try { fs.rmSync(file, { force: true }); } catch { /* 删不掉的下次 load 再清 */ } };

  function ensureDir() {
    if (dir === null) return false;
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return true; } catch (err) { diskOk = false; log('requests.dir-failed', { message: String(err?.code ?? err?.message ?? err) }); return false; }
  }

  function saveState(e) {
    if (dir === null || !e.persist || !e.persisted) return;
    try {
      writeAtomic(stateFile(e.id), JSON.stringify({ v: 1, state: e.state, attempts: e.attempts, ...(e.finishedAt ? { finishedAt: e.finishedAt } : {}), ...(e.result ? { result: e.result } : {}) }));
    } catch (err) {
      counts.persistFailed += 1;
      log('requests.persist-failed', { id: e.id, what: 'state', message: String(err?.code ?? err?.message ?? err) });
    }
  }

  function wake(e) {
    const ws = [...e.waiters];
    e.waiters.clear();
    for (const w of ws) w();
  }

  const active = () => [...entries.values()].filter((e) => !isFinal(e.state));

  return {
    limits,
    /** 落盘目录能不能用（状态口给人看） */
    get persistent() { return dir !== null && diskOk; },

    /**
     * 管理进程起来时调一次：把盘上没出结果的请求接回队列。回 `{ restored, results, dropped }`。
     */
    load() {
      const out = { restored: 0, results: 0, dropped: 0 };
      if (dir === null || !ensureDir()) return out;
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return out; }
      const ids = new Set();
      for (const name of names) {
        const m = /^([A-Za-z0-9_-]{16,64})\.(req|state)\.json$/.exec(name);
        if (m) ids.add(m[1]);
        else if (/\.tmp-\d+$/.test(name)) rm(path.join(dir, name)); // 上次写到一半的
      }
      for (const id of ids) {
        let req = null;
        let st = null;
        try { req = JSON.parse(fs.readFileSync(reqFile(id), 'utf8')); } catch { req = null; }
        try { st = JSON.parse(fs.readFileSync(stateFile(id), 'utf8')); } catch { st = null; }
        const final = st && isFinal(st.state);
        if (final) {
          rm(reqFile(id));
          if (!st.result || !Number.isFinite(st.finishedAt) || now() - st.finishedAt >= limits.resultKeepMs) { rm(stateFile(id)); out.dropped += 1; continue; }
          entries.set(id, {
            id, seq: 0, owner: st.result.owner ?? null, projectId: st.result.projectId ?? null, path: null, tool: null, cards: {}, body: null, persist: true, persisted: true,
            state: st.state, attempts: Number(st.attempts) || 0, createdAt: st.finishedAt, queuedAt: st.finishedAt, waitedMs: 0, startedAt: null, finishedAt: st.finishedAt,
            lastPollAt: now(), blockedReason: null, result: st.result, waiters: new Set(), restored: true,
          });
          out.results += 1;
          continue;
        }
        if (!req || req.v !== 1 || req.id !== id || typeof req.projectId !== 'string' || typeof req.path !== 'string' || !req.body || typeof req.body !== 'object') {
          rm(reqFile(id)); rm(stateFile(id)); out.dropped += 1;
          continue;
        }
        const seq = Number.isSafeInteger(req.seq) ? req.seq : 0;
        entries.set(id, {
          id, seq, owner: typeof req.owner === 'string' ? req.owner : null, projectId: req.projectId, path: req.path, tool: req.tool ?? null,
          cards: req.cards && typeof req.cards === 'object' ? req.cards : {}, body: req.body, persist: true, persisted: true,
          // 正在做的那一个也回到排队；那一次不算重试次数
          state: 'queued', attempts: Number(st?.attempts) || 0, createdAt: Number(req.createdAt) || now(), queuedAt: now(), waitedMs: 0, startedAt: null, finishedAt: null,
          // 停机的那一段没人能来问：从现在起算「调用方多久没来问」
          lastPollAt: now(), blockedReason: null, result: null, waiters: new Set(), restored: true, deadline: null,
          attemptMs: Number.isFinite(req.attemptMs) ? req.attemptMs : null, retries: Number.isInteger(req.retries) ? req.retries : null,
        });
        nextSeq = Math.max(nextSeq, seq + 1);
        out.restored += 1;
      }
      counts.restored += out.restored;
      if (out.restored || out.results || out.dropped) log('requests.loaded', out);
      return out;
    },

    /**
     * 登记一个请求。同一个 `id` 再登记回原来那一条（幂等：调用方没收到回执就重发）。
     * @returns {{ entry: object, created: boolean } | { full: true } | { conflict: true }} `conflict`：这个 id 是别的调用方登记的
     */
    add({ id, owner = null, projectId, path: pathname, tool = null, cards = {}, body, persist = false, deadline = null, attemptMs = null, retries = null }) {
      const had = entries.get(id);
      if (had) return had.owner === owner ? { entry: had, created: false } : { conflict: true };
      if (active().length >= limits.maxQueued) { counts.full += 1; return { full: true }; }
      const at = now();
      const e = {
        id, seq: nextSeq, owner, projectId, path: pathname, tool, cards, body, persist, persisted: false,
        state: 'queued', attempts: 0, createdAt: at, queuedAt: at, waitedMs: 0, startedAt: null, finishedAt: null,
        lastPollAt: at, blockedReason: null, result: null, waiters: new Set(), deadline,
        // 这条接口自己的时限与重试次数（没有就用调度的缺省：一分钟、三次）
        attemptMs, retries,
      };
      nextSeq += 1;
      if (persist && dir !== null) {
        try {
          if (!ensureDir()) throw new Error('dir');
          writeAtomic(reqFile(id), JSON.stringify({ v: 1, id, seq: e.seq, owner, projectId, path: pathname, tool, cards, createdAt: at, ...(attemptMs !== null ? { attemptMs } : {}), ...(retries !== null ? { retries } : {}), body }));
          e.persisted = true;
          diskOk = true;
        } catch (err) {
          counts.persistFailed += 1;
          rm(reqFile(id));
          log('requests.persist-failed', { id, what: 'request', message: String(err?.code ?? err?.message ?? err), detail: '这一条只在内存里排，管理进程重启后就没了' });
        }
      }
      entries.set(id, e);
      counts.added += 1;
      saveState(e);
      return { entry: e, created: true };
    },

    /** 调用方凭 id 取自己登记的那一条；不是它登记的回 null */
    get(id, owner = null) {
      const e = entries.get(id);
      return e && e.owner === owner ? e : null;
    },

    /** 排着的，按登记的先后 */
    queued: () => [...entries.values()].filter((e) => e.state === 'queued').sort((a, b) => a.seq - b.seq),
    running: () => [...entries.values()].find((e) => e.state === 'running') ?? null,
    /** 排在它前面的还有几个（在做的那个也算）；它自己在做或已出结果回 0 */
    position(e) {
      if (e.state !== 'queued') return 0;
      return [...entries.values()].filter((o) => o.state === 'running' || (o.state === 'queued' && o.seq < e.seq)).length;
    },

    start(e) {
      const at = now();
      e.waitedMs += at - e.queuedAt;
      e.state = 'running';
      e.startedAt = at;
      e.blockedReason = null;
      saveState(e);
    },

    /** 这一次没成、还有重试次数：回到排队（次序不变）。`attempts` 由调用方先加好 */
    requeue(e) {
      e.state = 'queued';
      e.queuedAt = now();
      e.startedAt = null;
      counts.requeued += 1;
      saveState(e);
      wake(e);
    },

    /** 只记一下重试次数变了（没有进过 running 的失败，例如隔离工作进程没起来） */
    touchAttempts(e) { saveState(e); },

    /**
     * 出了结果。`result` 是 `{ status, body, worker? }`（原样回给调用方的 HTTP 状态与内容）。
     * @param {'done' | 'failed' | 'cancelled'} state
     */
    finish(e, state, result) {
      if (isFinal(e.state)) return;
      const at = now();
      if (e.state === 'queued') e.waitedMs += at - e.queuedAt;
      e.state = state;
      e.finishedAt = at;
      e.result = { status: result.status, body: result.body, ...(result.worker ? { worker: result.worker } : {}), owner: e.owner, projectId: e.projectId };
      e.body = null; // 项目内容不留
      counts[state] += 1;
      saveState(e);
      if (dir !== null && e.persisted) rm(reqFile(e.id));
      wake(e);
    },

    /** 等它出结果或状态变化，最多 `ms`；回它此刻是不是已经出了结果 */
    wait(e, ms) {
      if (isFinal(e.state)) return Promise.resolve(true);
      return new Promise((resolve) => {
        let timer = null;
        const done = () => { clearTimeout(timer); e.waiters.delete(done); resolve(isFinal(e.state)); };
        // 不 unref：有人（一条挂着的连接）正等着它
        timer = setTimeout(done, Math.max(0, ms));
        e.waiters.add(done);
      });
    },

    /** 调用方来问了一次 */
    touch(e) { e.lastPollAt = now(); },
    /** 结果交给调用方了一次 */
    delivered(e) { e.deliveredAt ??= now(); },

    /** 把过了保留期的结果清掉 */
    sweep() {
      const at = now();
      for (const e of [...entries.values()]) {
        if (!isFinal(e.state)) continue;
        if (at - e.finishedAt < limits.resultKeepMs && !(e.deliveredAt != null && at - e.deliveredAt >= limits.deliveredKeepMs)) continue;
        entries.delete(e.id);
        if (dir !== null && e.persisted) rm(stateFile(e.id));
      }
    },

    stats() {
      const at = now();
      const q = [...entries.values()].filter((e) => e.state === 'queued');
      const blocked = {};
      for (const e of q) if (e.blockedReason) blocked[e.blockedReason] = (blocked[e.blockedReason] ?? 0) + 1;
      return {
        persistent: dir !== null && diskOk, queued: q.length, running: [...entries.values()].some((e) => e.state === 'running') ? 1 : 0,
        kept: [...entries.values()].filter((e) => isFinal(e.state)).length,
        oldestWaitMs: q.length ? Math.max(...q.map((e) => at - e.createdAt)) : null,
        blocked, ...counts,
      };
    },
  };
}
