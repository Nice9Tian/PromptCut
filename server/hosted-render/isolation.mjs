/**
 * 托管方渲染服务的隔离工作进程编排（契约 `docs/plan/hosted-render-contract.md` 第 7.5 节，方案 A）。管理进程用。
 *
 * 为什么要隔离：托管端任何人都能建项目。各项目的用户卡若装进同一个工作进程，项目甲的卡片代码会在渲染项目乙的页面里执行。
 * 所以——
 *   - 常驻工作进程不同步任何卡、不执行任何项目带来的代码；内容库里有 `card-source` 的项目它连着但**不认领**（`hold`），
 *     只把「这个项目要隔离、此刻有几个任务等着」报上来；
 *   - 这样的项目由**隔离工作进程**做：同一时刻最多一个，只连这一个项目，代理口只给它这一个项目的票据（口令每轮现生成）；
 *     有自己的检出副本、数据目录与端口，开卡片同步，报 `userCards: true`；
 *   - 这个项目 `idleMs`（60 s）没有它能做的任务就结束；几个项目都在等时轮流，每个最多 `sliceMs`（5 分钟）一换；
 *   - 换项目之前把数据目录整个清空、检出副本重建（装进来的用户卡都在数据目录的改动层里，副本一并重建是兜底）。
 *
 * **现状：本文件只有编排的状态机与目录操作，带单测（HR23），还没有接进管理进程（`main.mjs` 不引它）。**
 * 上面说的「常驻工作进程 hold 并上报」「代理口按工作进程分口令」「隔离工作进程的起停」都还没实现；渲染服务现在的行为仍等同方案 B。
 *
 * 本文件三块：
 *   `isolationCandidates`  纯函数：目录清单 + 常驻工作进程的诊断 → 此刻要隔离且有活等着的项目
 *   `createIsolation`      状态机：挑谁、何时结束、何时轮换；起停与清理由注入的 `runner` 做（单测不起真进程）
 *   `prepareCheckout` / `wipeDir`  检出副本与数据目录的建与清（真文件操作；带「只清自己建的目录」的记号核对）
 */
import fs from 'node:fs';
import path from 'node:path';

export const ISOLATION_DEFAULTS = Object.freeze({
  /** 这个项目这么久没有隔离工作进程能做的任务（手里没有、也没有可认领的）就结束 */
  IDLE_MS: 60_000,
  /** 另有项目在等时，一个项目最多连续做这么久 */
  SLICE_MS: 5 * 60_000,
  /** 轮换时等手里的任务做完的上限；到点还没完就让掉认领结束 */
  DRAIN_MS: 120_000,
  /** 起来这么久还没交过诊断就算起不来 */
  START_TIMEOUT_MS: 300_000,
  /** 一轮下来一个任务都没认领到（等着的任务它做不了）：同一批任务在这段时间内不再为它起隔离工作进程 */
  RETRY_IDLE_MS: 10 * 60_000,
});

/** 隔离工作进程的节点 id（与常驻工作进程的 `hosted-render:…` 区分开，两条连接可以同时在一个项目里） */
export const isoNodeIdFor = (instanceId, projectId) => `hosted-render-iso:${String(instanceId).slice(0, 12)}/${String(projectId).replace(/^sp_/, '').slice(0, 8)}`;

/**
 * 此刻要隔离且有活等着的项目。
 * @param {object} o
 * @param {{ projectId, enabled, active, members, since }[]} o.directory 目录清单
 * @param {{ projectId, cards?: { state: string }, pending?: number, pendingKey?: string }[]} o.residentNodes 常驻工作进程诊断里的各节点
 * @returns {{ projectId: string, members: boolean, pending: number, pendingKey: string }[]} 有成员在线的在前，其次按变成有活的先后
 */
export function isolationCandidates({ directory = [], residentNodes = [] } = {}) {
  const byId = new Map(residentNodes.map((n) => [n.projectId, n]));
  const out = [];
  for (const p of directory) {
    if (!p.enabled || !p.active) continue;
    const n = byId.get(p.projectId);
    if (!n || n.cards?.state !== 'some') continue;
    const pending = Number(n.pending) || 0;
    if (pending <= 0) continue;
    out.push({ projectId: p.projectId, members: p.members === true, pending, pendingKey: String(n.pendingKey ?? ''), since: p.since ?? 0 });
  }
  out.sort((a, b) => (a.members === b.members ? (a.since - b.since) || (a.projectId < b.projectId ? -1 : 1) : a.members ? -1 : 1));
  return out.map(({ since, ...rest }) => rest);
}

/**
 * @param {object} o
 * @param {{ prepare(projectId: string): Promise<void>, start(projectId: string): void, stop(reason: string): Promise<void>, cleanup(projectId: string): Promise<void>, exited(): boolean }} o.runner
 *   `prepare`：清数据目录、重建检出副本、换代理口口令；`start`：起隔离工作进程；`stop`：请它放回认领后结束整棵树；
 *   `cleanup`：再清一遍数据目录与副本；`exited()`：进程是不是已经自己没了
 * @param {(projectId: string) => string} o.nodeIdOf
 * @param {() => number} [o.now]
 * @param {(event: string, fields?: object) => void} [o.log]
 */
export function createIsolation({
  runner, nodeIdOf, now = Date.now, log = () => {},
  idleMs = ISOLATION_DEFAULTS.IDLE_MS, sliceMs = ISOLATION_DEFAULTS.SLICE_MS, drainMs = ISOLATION_DEFAULTS.DRAIN_MS,
  startTimeoutMs = ISOLATION_DEFAULTS.START_TIMEOUT_MS, retryIdleMs = ISOLATION_DEFAULTS.RETRY_IDLE_MS,
} = {}) {
  /** @type {null | { projectId, members, phase: 'preparing'|'starting'|'running'|'draining'|'stopping', startedAt, readyAt, lastBusyAt, drainAt, worked, pendingKey }} */
  let current = null;
  let op = null; // 在途的起停操作（Promise）
  let lastServed = null;
  let runs = 0;
  let lastRun = null;
  let waiting = [];
  /** projectId → { key, until }：一轮下来什么都没认领到的项目，同一批任务暂不再起 */
  const skip = new Map();
  const history = [];

  const run = (fn) => {
    op = Promise.resolve().then(fn).catch((err) => { log('isolation.error', { message: String(err?.message ?? err) }); }).finally(() => { op = null; });
    return op;
  };

  function pick(candidates) {
    const usable = candidates.filter((c) => {
      const s = skip.get(c.projectId);
      if (!s) return true;
      if (s.key !== c.pendingKey || now() >= s.until) { skip.delete(c.projectId); return true; }
      return false;
    });
    if (usable.length === 0) return null;
    // 轮流：上一轮做的那个排到最后
    const others = usable.filter((c) => c.projectId !== lastServed);
    return others[0] ?? usable[0];
  }

  function begin(c) {
    current = { projectId: c.projectId, members: c.members, phase: 'preparing', startedAt: now(), readyAt: null, lastBusyAt: null, drainAt: null, worked: false, pendingKey: c.pendingKey };
    runs += 1;
    log('isolation.start', { projectId: c.projectId, pending: c.pending, run: runs });
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
    log('isolation.stop', { projectId: mine.projectId, reason, worked: mine.worked, ranMs: now() - mine.startedAt });
    return run(async () => {
      try { await runner.stop(reason); } catch (err) { log('isolation.stop-error', { message: String(err?.message ?? err) }); }
      let cleaned = true;
      try { await runner.cleanup(mine.projectId); } catch (err) { cleaned = false; log('isolation.cleanup-failed', { projectId: mine.projectId, message: String(err?.message ?? err) }); }
      // 什么都没认领到、起不来、内存超限被结束：同一批任务先不再为它起（免得每一拍都重来）
      if ((reason === 'idle' && !mine.worked) || reason === 'oom' || reason === 'start-timeout') skip.set(mine.projectId, { key: mine.pendingKey, until: now() + retryIdleMs });
      lastServed = mine.projectId;
      lastRun = { projectId: mine.projectId, reason, worked: mine.worked, cleaned, ms: now() - mine.startedAt, at: now() };
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
     */
    tick({ candidates = [], eligible = () => true, report = null } = {}) {
      waiting = candidates.filter((c) => c.projectId !== current?.projectId).map((c) => c.projectId);
      if (op) return;
      if (!current) {
        const c = pick(candidates);
        if (c) void begin(c);
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
      if (runner.exited()) { void end('exit'); return; }
      const held = (node?.held?.length ?? 0) + (node?.running?.length ?? 0);
      if ((node?.claimed ?? 0) > 0) cur.worked = true;
      if (cur.phase === 'running') {
        if (held > 0 || (node?.claimable ?? 0) > 0) cur.lastBusyAt = now();
        if (!eligible(cur.projectId) && held === 0) { void end('not-listed'); return; }
        if (now() - cur.lastBusyAt >= idleMs) { void end('idle'); return; }
        if (waiting.length > 0 && now() - cur.readyAt >= sliceMs) {
          cur.phase = 'draining';
          cur.drainAt = now();
          log('isolation.rotate', { projectId: cur.projectId, waiting, held });
        }
      }
      if (cur.phase === 'draining') {
        if (held === 0) { void end('rotated'); return; }
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
      current: current ? { projectId: current.projectId, phase: current.phase, sinceMs: now() - current.startedAt, worked: current.worked } : null,
      waiting: [...waiting], runs, lastRun, history: history.slice(-5),
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
    fs.rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
