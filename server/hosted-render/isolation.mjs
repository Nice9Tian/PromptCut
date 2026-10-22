/**
 * 托管方渲染服务的隔离工作进程编排（契约 `docs/plan/hosted-render-contract.md` 第 7.5 节，方案 A）。管理进程用。
 *
 * 为什么要隔离：托管端任何人都能建项目。各项目的用户卡若装进同一个工作进程，项目甲的卡片代码会在渲染项目乙的页面里执行。
 * 所以——
 *   - 常驻工作进程不同步任何卡、不执行任何项目带来的代码；内容库里有 `card-source` 的项目它连着但**不认领**（`hold`），
 *     只把「这个项目要隔离、此刻有几个任务等着」报上来；
 *   - 这样的项目由**隔离工作进程**做：同一时刻只装一个项目，只连这一个项目，代理口只给它这一个项目的票据（口令每轮现生成）；
 *     有自己的数据目录与端口，开卡片同步，报 `userCards: true`。这就是「每个请求在只属于它那个项目的隔离环境里执行」
 *     （语义 `mechanism/rendering.md`「多项目模式的做法」第四条）；
 *   - 换项目之前把数据目录整个清空（装进来的用户卡都在数据目录的改动层里）。
 *
 * # 多项目模式（0.7.19 起；语义 `product/rendering.md`「渲染服务的两种模式」，取代 0.7.18 的「云端 Agent 按轮占用」）
 *
 * 不让哪个项目占着。下一个该装哪个项目，只看排队的请求按多项目模式的次序（`server/render-node/multi-queue.mjs`）谁排第一：
 *   1. **看画面先于产流**：有要隔离的看画面请求排着，就是排第一的那个请求的项目（次序由 `look.mjs` 的队列给：各项目轮流、
 *      项目内先来先做）；
 *   2. 否则是要产流的项目（常驻工作进程报的「有卡、有任务等着」），**各项目轮流**：一个项目做了一个任务就排到最后；
 *      刚装上、还没做到一个任务的项目先做完它这一个（不然两个项目来回装、谁都做不成）；
 *   3. 装着的项目就是排第一的：接着做（装过的卡和素材是缓存，留给同一项目的下一个请求）；
 *   4. 排第一的是别的项目：**不等它空闲**——不再认领新的（清单上标排空），手里正在做的那一个做完就结束、清空，下一拍装排第一的那个；
 *   5. 没人排队：装着的留作缓存，空了 `cacheMs` 才结束；内存吃紧（背压）时不等，空着就结束。
 * 0.7.18 暂行办法的「一轮从第一次看画面占到收尾」「心跳」「空闲满五分钟才让位」「真人在线的项目先产流、五分钟轮换」
 * 「流产满且五分钟没修改才关」都没有了。
 *
 * 本文件三块：
 *   `isolationCandidates`  纯函数：目录清单 + 常驻工作进程的诊断 + 要看画面的项目 → 此刻要隔离且有活等着的项目
 *   `createIsolation`      状态机：装哪个、何时换、何时结束；起停与清理由注入的 `runner` 做（单测不起真进程）
 *   `prepareCheckout` / `wipeDir`  检出副本与数据目录的建与清（真文件操作；带「只清自己建的目录」的记号核对）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRotation, orderByPolicy } from '../render-node/multi-queue.mjs';

export const ISOLATION_DEFAULTS = Object.freeze({
  /**
   * 没人排队时，装着的项目留作缓存多久（从最后一次有活算起）。只是缓存：别的项目一排上就不等它（见文件头第 4 条）。
   * 〔三级数字，待定〕沿用原来的五分钟；管理进程的 `PROMPTCUT_RENDER_ISO_IDLE_MS` 改它
   */
  CACHE_MS: 5 * 60_000,
  /** 换项目时等手里那一个做完的上限；到点还没完就让掉认领结束 */
  DRAIN_MS: 120_000,
  /** 起来这么久还没交过诊断就算起不来 */
  START_TIMEOUT_MS: 300_000,
  /** 一轮下来一个任务都没认领到（等着的任务它做不了）：同一批任务在这段时间内不再为它起隔离工作进程 */
  RETRY_IDLE_MS: 10 * 60_000,
  /**
   * 产流时一个项目一轮最多连做几个任务（那一轮开始时就排着的）再让给别的项目；与看画面的 `turnRequests` 同一个数
   * （`look.mjs` 的 `LOOK_DEFAULTS`）。〔裁，三级：见 AGENT-claude-multi-project-render.md「吞吐」〕
   */
  TURN_TASKS: 4,
});

/** 隔离工作进程的节点 id（与常驻工作进程的 `hosted-render:…` 区分开，两条连接可以同时在一个项目里） */
export const isoNodeIdFor = (instanceId, projectId) => `hosted-render-iso:${String(instanceId).slice(0, 12)}/${String(projectId).replace(/^sp_/, '').slice(0, 8)}`;

/**
 * 此刻要隔离且有活等着的项目。
 * @param {object} o
 * @param {{ projectId, enabled, active, members, since }[]} o.directory 目录清单
 * @param {{ projectId, cards?: { state: string }, pending?: number, pendingKey?: string }[]} o.residentNodes 常驻工作进程诊断里的各节点
 * @param {null | string[] | Map<string, unknown>} [o.looks] 有要隔离的看画面请求排着的项目，**按看画面队列的出队次序**
 *   （`look.mjs` 的 `isoOrder()`）；给 Map 时按它的键的次序，值是这次需求的记号
 * @returns {{ projectId: string, members: boolean, pending: number, pendingKey: string, look?: true, since: number }[]}
 *   要看画面的在前（按 `looks` 的次序），其余按变成有活的先后；产流那一类谁先由 `createIsolation` 按轮流定
 */
export function isolationCandidates({ directory = [], residentNodes = [], looks = null } = {}) {
  const byId = new Map(residentNodes.map((n) => [n.projectId, n]));
  const lookOrder = looks instanceof Map ? [...looks.keys()] : Array.isArray(looks) ? looks : [];
  const lookMark = (projectId) => (looks instanceof Map ? looks.get(projectId) : 1);
  const lookRank = new Map(lookOrder.map((id, i) => [id, i]));
  const out = [];
  for (const p of directory) {
    if (!p.enabled || !p.active) continue;
    const n = byId.get(p.projectId);
    /*
     * 「要看画面」的项目没有任务等着也算候选，而且排在最前——有人（模型的一轮）正等着这一帧。这样的项目不要求常驻工作进程已经
     * 报出「有卡」：Agent 服务刚把卡片源码写进内容库时，常驻工作进程的那份诊断可能还是上一拍的。
     */
    const look = lookRank.has(p.projectId);
    if (!look && (!n || n.cards?.state !== 'some')) continue;
    const pending = Number(n?.pending) || 0;
    if (pending <= 0 && !look) continue;
    out.push({
      projectId: p.projectId, members: p.members === true, pending,
      pendingKey: look ? `${String(n?.pendingKey ?? '')}|look:${lookMark(p.projectId)}` : String(n?.pendingKey ?? ''),
      ...(look ? { look: true } : {}), since: Number(p.since) || 0,
    });
  }
  out.sort((a, b) => ((a.look === true) !== (b.look === true) ? (a.look ? -1 : 1)
    : a.look ? lookRank.get(a.projectId) - lookRank.get(b.projectId)
      : (a.since - b.since) || (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0)));
  return out;
}

/**
 * @param {object} o
 * @param {{ prepare(projectId: string): Promise<void>, start(projectId: string): void, stop(reason: string): Promise<void>, cleanup(projectId: string): Promise<void>, exited(): boolean }} o.runner
 *   `prepare`：清数据目录、换代理口口令；`start`：起隔离工作进程；`stop`：请它放回认领后结束整棵树；
 *   `cleanup`：再清一遍数据目录；`exited()`：进程是不是已经自己没了
 * @param {(projectId: string) => string} o.nodeIdOf
 * @param {number} [o.cacheMs] 没人排队时装着的项目留多久（`idleMs` 是旧名字，同义）
 * @param {() => number} [o.now]
 * @param {(event: string, fields?: object) => void} [o.log]
 */
export function createIsolation({
  runner, nodeIdOf, now = Date.now, log = () => {},
  cacheMs: cacheIn = undefined, idleMs = undefined, drainMs = ISOLATION_DEFAULTS.DRAIN_MS,
  startTimeoutMs = ISOLATION_DEFAULTS.START_TIMEOUT_MS, retryIdleMs = ISOLATION_DEFAULTS.RETRY_IDLE_MS,
  turnTasks = ISOLATION_DEFAULTS.TURN_TASKS,
} = {}) {
  const turnCap = Math.max(1, Math.floor(Number(turnTasks) || 1));
  const cacheMs = cacheIn ?? idleMs ?? ISOLATION_DEFAULTS.CACHE_MS;
  /**
   * @type {null | { projectId, members, phase: 'preparing'|'starting'|'running'|'draining'|'stopping', startedAt, readyAt, lastBusyAt, drainAt,
   *   worked, pendingKey, claimed: number, served: number, why: string | null }}
   *   `claimed`：这一轮工作进程报的认领数（看它涨了没有）；`served`：这一轮做了几个产流任务
   */
  let current = null;
  let op = null; // 在途的起停操作（Promise）
  let runs = 0;
  let lastRun = null;
  let waiting = [];
  /** 产流那一类的轮流记账（看画面那一类的轮流在看画面的队列里记） */
  const rotation = createRotation();
  /** projectId → { key, until }：一轮下来什么都没认领到的项目，同一批任务暂不再起 */
  const skip = new Map();
  const history = [];

  const run = (fn) => {
    op = Promise.resolve().then(fn).catch((err) => { log('isolation.error', { message: String(err?.message ?? err) }); }).finally(() => { op = null; });
    return op;
  };

  const usable = (candidates) => candidates.filter((c) => {
    const s = skip.get(c.projectId);
    if (!s) return true;
    if (s.key !== c.pendingKey || now() >= s.until) { skip.delete(c.projectId); return true; }
    return false;
  });

  /**
   * 按多项目模式的次序，排第一的项目（见文件头）。回候选或 null。
   * @param {ReturnType<typeof isolationCandidates>} candidates
   */
  function target(candidates) {
    const list = usable(candidates);
    const look = list.find((c) => c.look === true);
    if (look) return look;
    const streams = list.filter((c) => c.look !== true);
    if (!streams.length) return null;
    // 装着的项目这一轮还没做满（那一轮开始时排着的、最多 turnTasks 个）：接着做它的
    const mine = current ? streams.find((c) => c.projectId === current.projectId) : null;
    if (mine && current.served < Math.min(turnCap, Math.max(1, current.turnPending ?? 1))) return mine;
    const ordered = orderByPolicy(streams.map((c, i) => ({ ...c, kind: 'stream', seq: i })), rotation);
    return ordered[0] ?? null;
  }

  function begin(c) {
    current = { projectId: c.projectId, members: c.members, phase: 'preparing', startedAt: now(), readyAt: null, lastBusyAt: null, drainAt: null, worked: false, pendingKey: c.pendingKey, claimed: 0, served: 0, why: null,
      // 这一轮开始时它排着几个产流任务（一轮最多连做 min(这个数, turnTasks) 个）
      turnPending: Number(c.pending) || 0 };
    runs += 1;
    log('isolation.start', { projectId: c.projectId, pending: c.pending, look: c.look === true, run: runs });
    const mine = current;
    return run(async () => {
      try {
        await runner.prepare(mine.projectId);
        if (current !== mine) return;
        mine.phase = 'starting';
        mine.startedAt = now();
        runner.start(mine.projectId);
      } catch (err) {
        log('isolation.prepare-failed', { projectId: mine.projectId, message: String(err?.message ?? err) });
        // 起不来：这一批任务先不再试（免得每一拍都重来）
        skip.set(mine.projectId, { key: mine.pendingKey, until: now() + retryIdleMs });
        try { await runner.cleanup(mine.projectId); } catch { /* 清不掉的下一轮 prepare 再清 */ }
        lastRun = { projectId: mine.projectId, reason: 'prepare-failed', worked: false, ms: now() - mine.startedAt, at: now() };
        if (current === mine) current = null;
      }
    });
  }

  function end(reason) {
    const mine = current;
    if (!mine || mine.phase === 'stopping') return op;
    mine.phase = 'stopping';
    log('isolation.stop', { projectId: mine.projectId, reason, worked: mine.worked, served: mine.served, ranMs: now() - mine.startedAt });
    return run(async () => {
      try { await runner.stop(reason); } catch (err) { log('isolation.stop-error', { message: String(err?.message ?? err) }); }
      let cleaned = true;
      try { await runner.cleanup(mine.projectId); } catch (err) { cleaned = false; log('isolation.cleanup-failed', { projectId: mine.projectId, message: String(err?.message ?? err) }); }
      // 什么都没认领到、起不来、内存超限被结束：同一批任务先不再为它起（免得每一拍都重来）
      if ((reason === 'idle' && !mine.worked) || reason === 'oom' || reason === 'start-timeout') skip.set(mine.projectId, { key: mine.pendingKey, until: now() + retryIdleMs });
      lastRun = { projectId: mine.projectId, reason, worked: mine.worked, served: mine.served, cleaned, ms: now() - mine.startedAt, at: now() };
      history.push(lastRun);
      while (history.length > 20) history.shift();
      log('isolation.ended', lastRun);
      if (current === mine) current = null;
    });
  }

  return {
    /**
     * 一拍。
     * @param {object} o
     * @param {ReturnType<typeof isolationCandidates>} o.candidates
     * @param {(projectId: string) => boolean} o.eligible 这个项目现在还该不该由渲染服务做（目录里开着且有活，或手里还有认领）
     * @param {null | { at: number, queue: { nodes: object[] } }} o.report 隔离工作进程最近一次交来的诊断（`at` 是收到的时刻）
     * @param {null | { wanted(projectId: string): boolean, busy: string | null }} [o.looks] 看画面（`look.mjs`）：`wanted` 这个项目此刻有没有
     *   排着或在做的看画面请求（有就不算闲）；`busy` 正在出图的那个项目（出图的半路上不结束、不换走）
     * @param {boolean} [o.memoryLow] 内存吃紧（背压暂停着）：装着的项目空着就结束，不留缓存
     */
    tick({ candidates = [], eligible = () => true, report = null, looks = null, memoryLow = false } = {}) {
      waiting = candidates.filter((c) => c.projectId !== current?.projectId).map((c) => c.projectId);
      if (op) return;
      if (!current) {
        const first = target(candidates);
        if (first) void begin(first);
        return;
      }
      const cur = current;
      const fresh = report && report.at >= cur.startedAt ? report : null;
      const node = fresh?.queue?.nodes?.find((n) => n.projectId === cur.projectId) ?? null;
      const mineNow = candidates.find((c) => c.projectId === cur.projectId);
      if (mineNow) cur.pendingKey = mineNow.pendingKey;
      if (cur.phase === 'starting') {
        if (runner.exited()) { void end('exit'); return; }
        if (fresh) { cur.phase = 'running'; cur.readyAt = now(); cur.lastBusyAt = now(); log('isolation.ready', { projectId: cur.projectId, startMs: now() - cur.startedAt }); }
        else if (now() - cur.startedAt >= startTimeoutMs) { void end('start-timeout'); return; }
        else return;
      }
      // 排空中自己退了（清单上标了排空、手里的做完，工作进程自己收尾退出）：这就是换装，不算意外退出
      if (runner.exited()) { void end(cur.phase === 'draining' ? 'rotated' : 'exit'); return; }
      const held = (node?.held?.length ?? 0) + (node?.running?.length ?? 0);
      // 认领数涨了：这一类里它出了一个请求（每涨一个记一次，轮流按「一个请求」算）
      const claimed = Number(node?.claimed) || 0;
      if (claimed > cur.claimed) {
        for (let i = cur.claimed; i < claimed; i += 1) rotation.served('stream', cur.projectId);
        cur.served += claimed - cur.claimed;
        cur.claimed = claimed;
        cur.worked = true;
      }
      const next = target(candidates);
      const looking = looks?.busy === cur.projectId;
      const lookWanted = looking || looks?.wanted?.(cur.projectId) === true;
      // 出过图也算这一轮干了活（不然只为看画面起的一轮会被记成「什么都没认领到」而暂不再起）
      if (looking) cur.worked = true;
      const busyNow = held > 0 || (node?.claimable ?? 0) > 0 || lookWanted;
      if (busyNow) cur.lastBusyAt = now();
      // 排第一的是别的项目：不等它空闲（见文件头第 4 条）
      const other = next && next.projectId !== cur.projectId ? next : null;
      if (cur.phase === 'draining' && !other && eligible(cur.projectId)) {
        // 等着的那个不等了（撤回、项目关了）：接着做，不白清一遍
        cur.phase = 'running';
        cur.drainAt = null;
        log('isolation.resume', { projectId: cur.projectId });
      }
      if (cur.phase === 'running') {
        if (!eligible(cur.projectId) && held === 0 && !looking) { void end('not-listed'); return; }
        if (other && !looking) {
          cur.phase = 'draining';
          cur.drainAt = now();
          cur.why = other.look ? 'look' : 'stream';
          log('isolation.rotate', { projectId: cur.projectId, next: other.projectId, nextIsLook: other.look === true, held, served: cur.served });
        } else if (!other && !busyNow && (memoryLow || now() - cur.lastBusyAt >= cacheMs)) {
          // 没人排队：缓存到期，或内存吃紧
          void end(memoryLow ? 'memory' : 'idle');
          return;
        }
      }
      if (cur.phase === 'draining') {
        if (held === 0 && !looking) { void end('rotated'); return; }
        if (now() - cur.drainAt >= drainMs) { void end('rotate-timeout'); }
      }
    },
    /** 隔离工作进程此刻该连的项目（代理口给它的清单）：最多一项 */
    listing() {
      if (!current || (current.phase !== 'starting' && current.phase !== 'running' && current.phase !== 'draining')) return [];
      return [{ projectId: current.projectId, members: current.members === true, drain: current.phase === 'draining', nodeId: nodeIdOf(current.projectId) }];
    },
    /** 立即结束当前这一轮（管理进程退出、开关关掉、内存超限时用）；回结束动作的 Promise */
    stop(reason = 'stop') { return current ? (end(reason) ?? Promise.resolve()) : (op ?? Promise.resolve()); },
    /** 在途的起停操作做完 */
    settled: () => op ?? Promise.resolve(),
    get current() { return current ? { ...current } : null; },
    get active() { return !!current; },
    status: () => ({
      current: current ? { projectId: current.projectId, phase: current.phase, sinceMs: now() - current.startedAt, worked: current.worked, served: current.served } : null,
      waiting: [...waiting], runs, lastRun, history: history.slice(-5), rotation: rotation.snapshot(),
      skipped: [...skip.entries()].map(([projectId, s]) => ({ projectId, until: s.until })),
    }),
  };
}

/* ------------------------------------------------------------------ 检出副本与数据目录 */

/** 我们自己建的目录里放的记号；清目录之前先认它，没有记号的非空目录不清（配错了路径不至于删到别处） */
export const ISO_MARKER = '.promptcut-render-iso';

/** 检出副本里要有的目录（编辑器与预渲染的 Vite 要读的）与不拷的名字 */
const CHECKOUT_DIRS = ['src', 'server', 'scripts'];
const SKIP_NAMES = new Set(['node_modules', '.git', '.worktrees', 'out', 'dist', 'dist-online', '.pc-work', '.pc-chats', '.pc-projects', '.cache']);

/** 从 `dir` 往上找最近的一个 `node_modules`；回它所在的目录，找不到回 null */
export function nearestNodeModules(dir) {
  let at = path.resolve(dir);
  for (;;) {
    try { if (fs.statSync(path.join(at, 'node_modules')).isDirectory()) return at; } catch { /* 不在这一层 */ }
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

const isInside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * 清空一个我们自己建的目录（整个删掉再建，放回记号）。目录不存在就建；存在而非空、又没有记号的不动，抛错。
 * 目录里的符号链接只拆链接、不跟进去（`node_modules` 的链接先单独拆）。
 */
export function wipeDir(dir) {
  const abs = path.resolve(dir);
  if (fs.existsSync(abs)) {
    const names = fs.readdirSync(abs);
    if (names.length > 0 && !names.includes(ISO_MARKER)) throw Object.assign(new Error(`${abs} 不是隔离工作进程的目录（没有记号），不清`), { code: 'iso-not-ours' });
    for (const name of names) {
      const p = path.join(abs, name);
      let st = null;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); } }
    }
    // 记号最后才动：先清记号以外的每一项；某一项被还没死透的进程占着、清不掉时，记号还在，上层（wipeIso）重试才认得这是我们的目录
    for (const name of names) {
      if (name === ISO_MARKER) continue;
      fs.rmSync(path.join(abs, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, ISO_MARKER), 'promptcut hosted render isolation\n');
}

/** 目录里除记号以外还有多少项（清空之后应为 0） */
export function leftoverCount(dir) {
  try { return fs.readdirSync(dir).filter((n) => n !== ISO_MARKER).length; } catch { return 0; }
}

/**
 * 建（或重建）隔离工作进程的检出副本：`root` 的 `src/`、`server/`、`scripts/` 与顶层的普通文件拷进 `dest`。
 * 依赖怎么解析（**Windows 上不建 junction**）：
 *   - `dest` 在「最近的 `node_modules` 所在目录」之内：什么都不用做，Node 与 Vite 向上解析就找得到（本机演练、开发机上的 worktree）；
 *   - 否则在非 Windows 上建符号链接 `dest/node_modules → <那一份 node_modules>`（云节点：副本在数据目录下，链回发布目录）；
 *   - 否则（Windows 上副本放在仓库目录树之外）抛 `iso-node-modules`：管理进程据此不启用隔离工作进程并告警。
 * @returns {{ dest: string, files: number, nodeModules: 'upward' | 'symlink', ms: number }}
 */
export function prepareCheckout({ root, dest, platform = process.platform }) {
  const t0 = Date.now();
  const src = path.resolve(root);
  const out = path.resolve(dest);
  if (out === src || isInside(src, out)) throw Object.assign(new Error('检出副本不能就是发布目录或它的上级'), { code: 'iso-bad-checkout' });
  const modulesHome = nearestNodeModules(src);
  if (!modulesHome) throw Object.assign(new Error('找不到 node_modules'), { code: 'iso-node-modules' });
  const upward = isInside(out, modulesHome);
  if (!upward && platform === 'win32') {
    throw Object.assign(new Error(`Windows 上检出副本要放在 ${modulesHome} 之内（不建 junction，靠向上解析找依赖）：${out}`), { code: 'iso-node-modules' });
  }
  wipeDir(out);
  let files = 0;
  const filter = (from) => {
    const name = path.basename(from);
    if (SKIP_NAMES.has(name)) return false;
    let st;
    try { st = fs.lstatSync(from); } catch { return false; }
    if (st.isSymbolicLink()) return false;
    if (st.isFile()) files += 1;
    return true;
  };
  for (const name of CHECKOUT_DIRS) {
    const from = path.join(src, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(out, name), { recursive: true, filter });
  }
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (!ent.isFile() || SKIP_NAMES.has(ent.name) || /\.(log|png|bat)$/i.test(ent.name) || /^\.env(\.|$)/.test(ent.name)) continue;
    fs.copyFileSync(path.join(src, ent.name), path.join(out, ent.name));
    files += 1;
  }
  if (!upward) fs.symlinkSync(path.join(modulesHome, 'node_modules'), path.join(out, 'node_modules'), 'dir');
  return { dest: out, files, nodeModules: upward ? 'upward' : 'symlink', ms: Date.now() - t0 };
}
