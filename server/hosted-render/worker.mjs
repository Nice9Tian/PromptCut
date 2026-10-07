/**
 * 托管方渲染服务的工作进程看护（契约 `docs/plan/hosted-render-contract.md` 第 4、7.1 节）。管理进程用。
 *
 * 工作进程就是 `scripts/render-host.mjs` 起的那棵（Vite、预渲染进程、Chrome）。这里负责：
 * - 起：命令由调用方给（`command()`，可能包了 `systemd-run` 或 `nice`）；子进程自成一组，窗口隐藏；
 * - 退出就按退避重起（1 s 起、翻倍、封顶 60 s；连续跑满 60 s 后退避归零）。它手里的认领由队列按断线规则收回；
 * - `kill(reason)`：结束整棵树（内存看护超限时用），照常走退出与重起；
 * - `stop()`：先请它自己收尾（放回认领：非 Windows 发 SIGTERM，Windows 经 IPC 发 `shutdown`），等 `graceMs`，不退就结束整棵树。
 * 不引 Vite；子进程的起法可以整个注入（`spawn`），单测不起真进程。
 *
 * # 整棵树一起走
 *
 * 工作进程自己再起编辑器的 Vite（`detached`，自成进程组）、Vite 再起预渲染进程、预渲染进程再起 Chrome（puppeteer 同样 `detached`）。
 * 只向工作进程那一组发信号带不走它们：工作进程被 SIGKILL 之后 Vite 成了孤儿、占着端口，之后每次重起都报端口被占
 * （在一台没有 systemd 的 Linux 容器里实测到）。所以结束一棵树按两条线索找全它的进程：
 *   - **后代**：按父子关系从树根往下找（Linux 读 `/proc`，别的 POSIX 平台问 `ps`，Windows 用 `taskkill /T`）；
 *   - **记号**（Linux）：每次起工作进程现生成一个随机记号，放进它的环境变量 `PROMPTCUT_RENDER_TREE`，整棵树的进程都继承它；
 *     结束时把环境里带这个记号的进程一并结束——父进程已经死掉、挂到 1 号进程下面的孤儿也找得到。
 * 找到的进程逐个 SIGKILL（连同它们各自的进程组），再扫一遍收掉这期间新起的。
 *
 * 管理进程自己被 SIGKILL 时来不及做这些：工作进程一侧每秒看父进程在不在，不在就自己收尾（`scripts/render-host.mjs`）；
 * 再兜一层——每次起工作进程之前先清上一轮留下的：记号与树根的 pid 记在数据目录的 `treeFile` 里，Linux 上按记号清
 * （环境里带那个记号的才清，认的是自己起的进程），Windows 上只在那个 pid 还活着、命令行确实是同一个入口脚本时 `taskkill /T`。
 * 不按端口找进程。有 systemd 时工作进程在一个 scope 里（`systemd-run --scope`，缺省 `KillMode=control-group`），
 * 它的进程都带同一个记号，照上面的办法清干净后 scope 自己回收（`--collect`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';

export const WORKER_DEFAULTS = Object.freeze({ BACKOFF_MIN_MS: 1000, BACKOFF_MAX_MS: 60_000, STABLE_MS: 60_000, GRACE_MS: 15_000 });

/** 工作进程树的记号所在的环境变量（见文件头「整棵树一起走」） */
export const TREE_ENV = 'PROMPTCUT_RENDER_TREE';
const TOKEN_RE = /^[0-9a-f]{16,64}$/;

/**
 * 本机进程表：pid → `{ ppid, tagged }`。`tagged` 表示它的环境里带 `PROMPTCUT_RENDER_TREE=<token>`（只有 Linux 查得到；
 * 读不了别人进程的环境时当没带）。Linux 读 `/proc`；别的 POSIX 平台问一次 `ps`；Windows 问一次 CIM（隐藏窗口）。量不了回空表。
 */
export function listProcesses({ platform = process.platform, token = '', spawnSync = nodeSpawnSync } = {}) {
  const procs = new Map();
  try {
    if (platform === 'linux') {
      const needle = TOKEN_RE.test(token) ? `${TREE_ENV}=${token}` : null;
      for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
          const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
          let tagged = false;
          if (needle) {
            try { tagged = fs.readFileSync(`/proc/${name}/environ`, 'latin1').split('\0').includes(needle); } catch { /* 读不了：不是我们的用户起的 */ }
          }
          procs.set(Number(name), { ppid, tagged });
        } catch { /* 这个进程刚没了 */ }
      }
    } else if (platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { $b=\'-\'; if ($_.CreationDate) { $b=$_.CreationDate.ToFileTimeUtc() }; "$($_.ProcessId) $($_.ParentProcessId) $b" }'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
        const [id, ppid, born] = line.trim().split(/\s+/).map(Number);
        // born：创建时刻（FILETIME）。Windows 记的父进程号在父进程退出后不改，号被重用时靠它认出陈旧的父子关系（见 treePids）
        if (Number.isInteger(id) && id > 0) procs.set(id, { ppid, tagged: false, ...(Number.isFinite(born) ? { born } : {}) });
      }
    } else {
      const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 10_000 });
      for (const line of String(r.stdout ?? '').split('\n')) {
        const [id, ppid] = line.trim().split(/\s+/).map(Number);
        if (Number.isInteger(id) && id > 0) procs.set(id, { ppid, tagged: false });
      }
    }
  } catch { /* 量不了 */ }
  return procs;
}

/**
 * 一棵树的全部进程（纯函数）：`root` 与它的后代，并上带记号的进程与它们的后代。`self`（调用方自己）与 1 号进程从不在内。
 * @param {number | null} root 树根的 pid（已经死了也行：它的孩子还记着它是父进程）
 * 进程表里带创建时刻 `born` 时（Windows），「父」比「子」创建得晚的那条关系不认：Windows 记的父进程号在父进程退出后不改，
 * 那个号被这棵树里的新进程重用后，早就成了孤儿的无关进程会被当成它的孩子（完整验收里实测到：运行器自己被算进了工作进程树）。
 * @param {Map<number, { ppid: number, tagged?: boolean, born?: number }>} procs
 * @returns {number[]} 升序
 */
export function treePids(root, procs, { self = process.pid } = {}) {
  const children = new Map();
  for (const [pid, p] of procs) {
    const parent = procs.get(p.ppid);
    if (parent && Number.isFinite(parent.born) && Number.isFinite(p.born) && parent.born > p.born) continue; // 父进程号被重用了
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(pid);
  }
  const out = new Set();
  const stack = [];
  if (Number.isInteger(root) && root > 1) stack.push(root);
  for (const [pid, p] of procs) if (p.tagged) stack.push(pid);
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid) || pid === self || pid <= 1) continue;
    seen.add(pid);
    if (procs.has(pid)) out.add(pid);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 结束一棵进程树，回被结束的 pid（Windows 上回空数组：`taskkill /T` 自己找）。
 * @param {number | null} pid 树根；给 null 时只按记号清（清上一轮留下的孤儿）
 * @param {object} [o]
 * @param {string} [o.token] 这棵树的记号（Linux 上据此连孤儿一起清）
 * @param {boolean} [o.sync] Windows 上等 `taskkill` 做完再返回（进程退出前的最后一步用）
 */
export function killTree(pid, { platform = process.platform, spawn = nodeSpawn, spawnSync = nodeSpawnSync, token = '', sync = false, list = listProcesses, kill = (p, sig) => process.kill(p, sig) } = {}) {
  const rootOk = Number.isInteger(pid) && pid > 0;
  if (platform === 'win32') {
    if (!rootOk) return [];
    try {
      if (sync) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
      else spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* 已经没了 */ }
    return [];
  }
  if (!rootOk && !TOKEN_RE.test(token)) return [];
  const killed = new Set();
  // 两遍：第二遍收掉第一遍期间新起的进程
  for (let pass = 0; pass < 2; pass += 1) {
    let targets = [];
    try { targets = treePids(rootOk ? pid : null, list({ platform, token, spawnSync })); } catch { targets = []; }
    if (pass === 0 && rootOk && !targets.includes(pid)) targets.push(pid);
    for (const p of targets) {
      // 连同它自己那一组（工作进程、Vite、Chrome 都是各自进程组的组长）
      try { kill(-p, 'SIGKILL'); killed.add(p); } catch { /* 不是组长 */ }
      try { kill(p, 'SIGKILL'); killed.add(p); } catch { /* 已经没了 */ }
    }
    if (targets.length === 0) break;
  }
  return [...killed].sort((a, b) => a - b);
}

/**
 * 这棵树还活着的进程（探针与单测核对「没有残留」用）；Windows 的 CIM 记录还需 signal 0 核对。
 * Windows 可传先前 listProcesses 的 `observed` 快照：只核对那次树中的进程，以 pid + born 认身份，
 * 不把重用旧 pid 的新进程当残留；根已换人时仍逐个核对原后代。它不发现快照之后新起的进程。
 * 创建时刻缺失、存活查询权限不足或出错时保守保留；只有明确的不同身份或 ESRCH 才排除。
 */
export function treeAlive(pid, { token = '', platform = process.platform, list = listProcesses, observed = null, kill = (p, sig) => process.kill(p, sig) } = {}) {
  const current = list({ platform, token });
  const root = Number.isInteger(pid) && pid > 0 ? pid : null;
  if (platform !== 'win32') return treePids(root, current);
  return treePids(root, observed ?? current).filter((p) => {
    const now = current.get(p);
    const before = observed?.get(p);
    if (Number.isFinite(before?.born) && Number.isFinite(now?.born) && before.born !== now.born) return false;
    try { kill(p, 0); return true; } catch (err) { return err?.code !== 'ESRCH'; }
  });
}

/** Windows 上：这个 pid 还活着、而且命令行里确实有 `marker`（入口脚本的路径）才算是我们上一轮起的 */
function windowsProcessMatches(pid, marker, spawnSync) {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    return typeof r.stdout === 'string' && marker !== '' && r.stdout.toLowerCase().includes(String(marker).toLowerCase());
  } catch { return false; }
}

/**
 * 清上一轮留下的工作进程树（管理进程被 SIGKILL、来不及收尾的那种）。只清能确认是自己起的：
 * Linux 按 `treeFile` 里记的记号（环境里带它的进程）；Windows 按记的 pid，且它的命令行里有记下的入口脚本。
 * 回 `{ swept: number[], previous }`；没有记录、记录坏了回 `{ swept: [], previous: null }`。
 */
export function sweepStaleTree(treeFile, { platform = process.platform, spawn = nodeSpawn, spawnSync = nodeSpawnSync, list = listProcesses, kill, alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } } = {}) {
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(treeFile, 'utf8')); } catch { return { swept: [], previous: null }; }
  if (!previous || typeof previous !== 'object') return { swept: [], previous: null };
  let swept = [];
  if (platform === 'win32') {
    const pid = Number(previous.pid);
    if (Number.isInteger(pid) && pid > 0 && alive(pid) && windowsProcessMatches(pid, previous.marker ?? '', spawnSync)) {
      killTree(pid, { platform, spawn, spawnSync, sync: true });
      swept = [pid];
    }
  } else if (TOKEN_RE.test(String(previous.token ?? ''))) {
    swept = killTree(null, { platform, token: previous.token, spawnSync, list, ...(kill ? { kill } : {}) });
  }
  return { swept, previous };
}

/**
 * @param {object} o
 * @param {() => { cmd: string, args: string[], env: object, cwd?: string }} o.command 每次起之前调（并发降级后参数会变）
 * @param {(event: string, fields?: object) => void} [o.log]
 * @param {(line: string) => void} [o.onLine] 子进程的每一行输出
 * @param {() => number} [o.now]
 * @param {typeof nodeSpawn} [o.spawn]
 * @param {(fn: () => void, ms: number) => any} [o.setTimer]
 * @param {string} [o.treeFile] 记这棵树的记号与树根 pid 的文件（数据目录下）；给了就在每次起之前先清上一轮留下的
 * @param {boolean} [o.restart] 退出后要不要按退避重起，缺省要；隔离工作进程给 false（一轮一个项目，退出就收尾）
 * @param {(info: { code, signal, reason, ranMs }) => void} [o.onExit]
 */
export function createWorker({
  command, log = () => {}, onLine = () => {}, now = Date.now, spawn = nodeSpawn, setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  backoffMinMs = WORKER_DEFAULTS.BACKOFF_MIN_MS, backoffMaxMs = WORKER_DEFAULTS.BACKOFF_MAX_MS, stableMs = WORKER_DEFAULTS.STABLE_MS, graceMs = WORKER_DEFAULTS.GRACE_MS,
  platform = process.platform, treeFile = null, restart = true, onExit: exitHook = () => {}, sweep = sweepStaleTree, killer = killTree,
} = {}) {
  let child = null;
  let token = '';
  let lastPid = null;
  let stopping = false;
  let backoff = backoffMinMs;
  let startedAt = null;
  let starts = 0;
  let exits = 0;
  let lastExit = null;
  let pendingReason = null;
  let timer = null;
  let ready = false;
  const exitWaiters = [];

  function pipe(stream) {
    let tail = '';
    stream?.on('data', (chunk) => {
      const lines = (tail + chunk.toString()).split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) {
        const text = line.replace(/\r$/, '');
        if (/\[render-host\] ready /.test(text)) ready = true;
        try { onLine(text); } catch { /* 日志出错不影响看护 */ }
      }
    });
  }

  /** 结束当前（或刚退出的）这棵树的全部进程：后代加带记号的孤儿 */
  const killAll = (pid, opts = {}) => { try { return killer(pid, { platform, spawn, token, ...opts }) ?? []; } catch { return []; } };

  function start() {
    if (stopping || child) return;
    // 上一轮留下的先清掉（管理进程自己被杀、没来得及收尾的那种）：不清的话端口还被占着，这一次起不来
    if (treeFile) {
      try {
        const { swept } = sweep(treeFile, { platform, spawn });
        if (swept.length > 0) log('worker.swept-stale', { pids: swept.slice(0, 20), count: swept.length });
      } catch (err) { log('worker.sweep-failed', { message: String(err?.message ?? err) }); }
    }
    const { cmd, args, env, cwd } = command();
    token = randomBytes(16).toString('hex');
    starts += 1;
    ready = false;
    startedAt = now();
    let proc;
    try {
      proc = spawn(cmd, args, { env: { ...env, [TREE_ENV]: token }, cwd, stdio: ['ignore', 'pipe', 'pipe', ...(platform === 'win32' ? ['ipc'] : [])], windowsHide: true, detached: platform !== 'win32' });
    } catch (err) {
      log('worker.spawn-failed', { message: String(err?.message ?? err) });
      onExit(null, null, 'spawn-failed');
      return;
    }
    child = proc;
    lastPid = proc.pid ?? null;
    if (treeFile) {
      try {
        fs.mkdirSync(path.dirname(treeFile), { recursive: true });
        // marker：命令行里认得出「这是我们起的工作进程」的那一段（入口脚本的路径），Windows 上清上一轮时核对用
        fs.writeFileSync(treeFile, JSON.stringify({ token, pid: lastPid, marker: args.find((a) => /render-host\.mjs$/.test(String(a))) ?? '', at: now() }));
      } catch (err) { log('worker.tree-file-failed', { message: String(err?.code ?? err?.message ?? err) }); }
    }
    log('worker.start', { pid: proc.pid ?? null, starts });
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.once('error', (err) => { if (child === proc) { log('worker.spawn-failed', { message: String(err?.message ?? err) }); child = null; onExit(null, null, 'spawn-failed'); } });
    proc.once('exit', (code, signal) => {
      if (child !== proc) return;
      child = null;
      // 工作进程没了，它起的 Vite、预渲染进程、Chrome 不一定跟着没：按后代与记号再清一遍，免得占着端口
      // 只按记号清：树根的 pid 已经释放、可能被别的进程重用，不能再按它找后代（Windows 上没有记号，这一步不做）
      const left = platform === 'win32' ? [] : killAll(null);
      if (left.length > 0) log('worker.orphans-killed', { pids: left.slice(0, 20), count: left.length });
      onExit(code, signal, pendingReason ?? 'exit');
    });
  }

  function onExit(code, signal, reason) {
    exits += 1;
    const ranMs = startedAt === null ? 0 : now() - startedAt;
    lastExit = { code, signal, reason, ranMs, at: now() };
    pendingReason = null;
    ready = false;
    log('worker.exit', lastExit);
    for (const w of exitWaiters.splice(0)) w();
    try { exitHook(lastExit); } catch { /* 回调出错不影响看护 */ }
    if (stopping || !restart) return;
    if (ranMs >= stableMs) backoff = backoffMinMs;
    const wait = backoff;
    backoff = Math.min(backoff * 2, backoffMaxMs);
    log('worker.restart-in', { ms: wait });
    timer = setTimer(() => { timer = null; start(); }, wait);
  }

  const exited = () => new Promise((resolve) => { if (!child) resolve(); else exitWaiters.push(resolve); });

  return {
    start() { stopping = false; start(); },
    /** 结束整棵树；它会照常被重起。`reason` 记进 `worker.exit`（内存看护用 `'oom'`） */
    kill(reason = 'killed') {
      if (!child) return false;
      pendingReason = reason;
      killAll(child.pid);
      return true;
    },
    /** 请它收尾后退出；`graceMs` 内不退就结束整棵树。不再重起 */
    async stop() {
      stopping = true;
      clearTimeout(timer);
      timer = null;
      const proc = child;
      if (!proc) return;
      pendingReason = 'stop';
      try {
        if (platform === 'win32') { if (proc.connected) proc.send({ type: 'shutdown' }); else killAll(proc.pid); }
        else process.kill(proc.pid, 'SIGTERM');
      } catch { killAll(proc.pid); }
      let done = false;
      await Promise.race([exited().then(() => { done = true; }), new Promise((resolve) => setTimer(resolve, graceMs))]);
      if (!done) { killAll(proc.pid); await Promise.race([exited(), new Promise((resolve) => setTimer(resolve, 5000))]); }
    },
    /** 进程退出前的最后一步（同步）：把这棵树的进程全部结束。管理进程自己要没了、来不及走 `stop()` 时用 */
    killSync() { if (child?.pid || (platform !== 'win32' && token)) killAll(child?.pid ?? null, { sync: true }); },
    /** 这棵树的记号（探针核对残留用） */
    get treeToken() { return token; },
    get pid() { return child?.pid ?? null; },
    get running() { return !!child; },
    get ready() { return ready; },
    status: () => ({ pid: child?.pid ?? null, running: !!child, ready, starts, exits, lastExit, startedAt }),
  };
}
