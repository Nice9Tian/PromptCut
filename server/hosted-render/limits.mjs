/**
 * 托管方渲染服务的资源手段（契约 `docs/plan/hosted-render-contract.md` 第 4 节）。管理进程用；纯函数与可注入的探测，不引 Vite。
 *
 * - **cgroup**（只在有 systemd 与 cgroup v2 的 Linux 上）：工作进程经 `systemd-run --scope --slice=promptcut-render.slice` 起，
 *   内存硬上限、节流线、CPU 配额与权重、IO 权重、任务数、OOM 先后都写成 scope 的属性。没有 systemd 时**降级**：
 *   自检报一条 `no-cgroup` 的告警并继续，只靠下面的进程内手段（Linux 上另加 `nice`）。
 * - **背压**：每次采样给可用内存、文档服务自检的往返时延、1 分钟负载；任一项越线就暂停认领，全部恢复满 `recoverMs` 再放开。
 * - **内存看护**：量工作进程整棵树实际占的物理内存（不重复计共享页：cgroup 的 `memory.current`、`Pss`、Windows 的私有工作集，
 *   见「内存量法」；量不了这一拍不判），超过硬上限就让调用方结束这棵树。没有 cgroup 时它是唯一的硬上限；有 cgroup 时内核先动手，
 *   这里放宽 5% 兜底（`createMemoryWatch`）。
 * - **OOM 降级**：10 分钟内第 3 次因内存被结束，并发降到 1。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync as nodeSpawnSync } from 'node:child_process';

const GiB = 1024 ** 3;

export const LIMIT_DEFAULTS = Object.freeze({
  maxConcurrent: 2,
  maxProjects: 16,
  memoryMax: '6G',
  memoryHigh: '5G',
  cpuQuota: '400%',
  cpuWeight: 20,
  ioWeight: 20,
  tasksMax: 4096,
  oomScoreAdjust: 500,
  nice: 10,
  slice: 'promptcut-render.slice',
  /** 背压 */
  memLowBytes: 2 * GiB,
  healthSlowMs: 500,
  healthSlowCount: 3,
  /** 1 分钟负载的线：缺省按核数算（`loadHighFor`），这里留空；要写死就给数 */
  loadHigh: null,
  recoverMs: 30_000,
  sampleMs: 5_000,
  /** OOM 降级 */
  oomWindowMs: 10 * 60_000,
  oomCount: 3,
});

/** `'6G'`、`'512M'`、`'100K'`、纯数字 → 字节；不合格回 null */
export function parseBytes(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)(?:i?B)?\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const unit = { '': 1, K: 1024, M: 1024 ** 2, G: GiB, T: 1024 ** 4 }[m[2].toUpperCase()];
  const n = Math.round(Number(m[1]) * unit);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 这台机器有没有可用的 cgroup 手段：Linux、systemd 在跑、cgroup v2、找得到 systemd-run。回 `{ ok, reason }` */
export function cgroupSupport({ platform = process.platform, exists = fs.existsSync, which = whichSync } = {}) {
  if (platform !== 'linux') return { ok: false, reason: 'not-linux' };
  if (!exists('/run/systemd/system')) return { ok: false, reason: 'no-systemd' };
  if (!exists('/sys/fs/cgroup/cgroup.controllers')) return { ok: false, reason: 'no-cgroup-v2' };
  if (!which('systemd-run')) return { ok: false, reason: 'no-systemd-run' };
  return { ok: true, reason: null };
}

/** 在 PATH 里找一个可执行文件；找到回路径，否则 null */
export function whichSync(name, { env = process.env, platform = process.platform } = {}) {
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try { if (fs.statSync(file).isFile()) return file; } catch { /* 不在这里 */ }
    }
  }
  return null;
}

/**
 * 起工作进程用的命令。有 cgroup 时包一层 `systemd-run --scope`；没有时 Linux 上包 `nice`（有的话），其余原样。
 * @param {object} o
 * @param {string} o.node  Node 可执行文件
 * @param {string[]} o.args  入口脚本与它的参数
 * @param {object} [o.limits]  覆盖 `LIMIT_DEFAULTS` 里的上限项
 * @param {{ ok: boolean }} o.support  `cgroupSupport()` 的结果
 * @param {string} [o.user]  工作进程用的系统用户（只在 cgroup 分支上经 `--uid` 生效；空表示与管理进程同一用户）
 * @param {string} [o.unit]  scope 的名字（不给由 systemd 取）
 * @param {boolean} [o.hasNice]
 * @returns {{ cmd: string, args: string[], mode: 'cgroup' | 'nice' | 'plain' }}
 */
export function workerCommand({ node, args, limits = {}, support, user = '', unit = '', platform = process.platform, hasNice = platform === 'linux' && !!whichSync('nice') }) {
  const L = { ...LIMIT_DEFAULTS, ...limits };
  if (support?.ok) {
    const props = [
      `MemoryMax=${L.memoryMax}`, `MemoryHigh=${L.memoryHigh}`, 'MemorySwapMax=0', `CPUQuota=${L.cpuQuota}`, `CPUWeight=${L.cpuWeight}`,
      `IOWeight=${L.ioWeight}`, `TasksMax=${L.tasksMax}`, `OOMScoreAdjust=${L.oomScoreAdjust}`, `Nice=${L.nice}`,
    ];
    return {
      cmd: 'systemd-run',
      args: ['--scope', '--quiet', '--collect', `--slice=${L.slice}`, ...(unit ? [`--unit=${unit}`] : []), ...(user ? [`--uid=${user}`] : []),
        ...props.flatMap((p) => ['-p', p]), node, ...args],
      mode: 'cgroup',
    };
  }
  if (platform === 'linux' && hasNice) return { cmd: 'nice', args: ['-n', String(L.nice), node, ...args], mode: 'nice' };
  return { cmd: node, args: [...args], mode: 'plain' };
}

/** 本机可用内存（字节）：Linux 读 `/proc/meminfo` 的 MemAvailable，别的平台用 `os.freemem()` */
export function memAvailable({ platform = process.platform, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  if (platform === 'linux') {
    try {
      const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(read('/proc/meminfo'));
      if (m) return Number(m[1]) * 1024;
    } catch { /* 读不了就用下面的 */ }
  }
  return os.freemem();
}

/* ------------------------------------------------------------------ 内存量法（契约第 4 节「内存看护」） */

/**
 * 量法的口径，由准到粗；一次读数里用到的最粗的一级写进 `method`，日志与诊断里看得到。
 * 为什么不能累加工作集（VmRSS / WorkingSetSize）：Chrome 是多进程的，每个进程的工作集都含着共享的库、字体、GPU 与共享内存页，
 * 累加起来同一页被算了好几遍——常驻那棵树空着就量出 6.7 GB（4 核 15 GiB 的 Linux 容器）、两棵树合计 6.9 GB（Windows），而系统的
 * 可用内存几乎没动。所以只用**不重复**的口径：
 *   - Linux：进程在自己独立的 cgroup 里（`systemd-run --scope`）→ 那个 cgroup 的 `memory.current` 减 `inactive_file`（`cgroup`）；
 *     否则逐进程读 `/proc/<pid>/smaps_rollup` 的 `Pss`（共享页按共享的进程数均摊，`pss`）；读不到（内核早于 4.14、无权读）退到
 *     `/proc/<pid>/status` 的 `RssAnon + RssShmem`（`rss-anon-shmem`，不含文件映射的共享页）；再读不到就是量不了；
 *   - Windows：逐进程的私有工作集（`Win32_PerfRawData_PerfProc_Process.WorkingSetPrivate`，`private-ws`）；这一项没有的进程退到
 *     `Win32_Process.PrivatePageCount`（私有已提交，只会偏大、不重复，`private-bytes`）；再没有就是量不了。
 * 量不了就回 `{ bytes: null, reason }`：不当成 0，也不当成超限，调用方这一拍不判。
 */
export const MEMORY_METHOD_RANK = Object.freeze({ cgroup: 0, 'private-ws': 1, pss: 1, 'private-bytes': 2, 'rss-anon-shmem': 2 });
const coarser = (a, b) => (a === null || (b !== null && MEMORY_METHOD_RANK[b] > MEMORY_METHOD_RANK[a]) ? b : a);

const realProcfs = { read: (file) => fs.readFileSync(file, 'utf8'), list: (dir) => fs.readdirSync(dir) };

/** `/proc/<pid>/cgroup` 的内容 → cgroup v2 里的路径（`0::/a/b.scope` → `/a/b.scope`）；没有 v2 那一行回 null */
export function parseCgroupPath(text) {
  for (const line of String(text ?? '').split('\n')) {
    const m = /^0::(\/.*?)(?: \(deleted\))?$/.exec(line.trim());
    if (m) return m[1];
  }
  return null;
}

/** `Key:   1234 kB` 一类行里的数（kB）；没有这一行回 null */
function kbOf(text, key) {
  const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(String(text ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * 一个 cgroup 里实际占着的内存：`memory.current` 减去 `inactive_file`（内核在压力下先回收的文件缓存；它到硬上限时先回收这一部分，
 * 不会因此杀进程，所以不能算进「占用」）。读不到回 null。
 */
export function cgroupMemory(cgPath, { fsx = realProcfs, root = '/sys/fs/cgroup' } = {}) {
  if (typeof cgPath !== 'string' || !cgPath.startsWith('/') || cgPath.split('/').includes('..')) return null;
  try {
    const current = Number(String(fsx.read(`${root}${cgPath}/memory.current`)).trim());
    if (!Number.isFinite(current) || current < 0) return null;
    let inactiveFile = 0;
    try { inactiveFile = Number(/^inactive_file\s+(\d+)\s*$/m.exec(fsx.read(`${root}${cgPath}/memory.stat`))?.[1] ?? 0); } catch { /* 没有 memory.stat：只好用 current */ }
    return { bytes: Math.max(0, current - inactiveFile), current, inactiveFile };
  } catch { return null; }
}

/**
 * 一个进程的物理内存（Linux，不重复计共享页）。回 `{ bytes, method }`、`{ gone: true }`（这个进程刚没了）或 `{ error }`（读不了）。
 */
export function pidMemoryLinux(pid, fsx = realProcfs) {
  try {
    const kb = kbOf(fsx.read(`/proc/${pid}/smaps_rollup`), 'Pss');
    if (kb !== null) return { bytes: kb * 1024, method: 'pss' };
  } catch { /* 没有这个文件（老内核）、无权读或进程刚没了：下面读 status 判断是哪一种 */ }
  let status;
  try { status = fsx.read(`/proc/${pid}/status`); } catch (err) { return err?.code === 'ENOENT' || err?.code === 'ESRCH' ? { gone: true } : { error: err?.code ?? 'EREAD' }; }
  if (/^State:\s+Z/m.test(status)) return { bytes: 0, method: null }; // 僵尸进程：地址空间已经释放
  const anon = kbOf(status, 'RssAnon');
  if (anon === null) return { error: 'no-rss-fields' };
  return { bytes: (anon + (kbOf(status, 'RssShmem') ?? 0)) * 1024, method: 'rss-anon-shmem' };
}

/**
 * 父子关系表 `ppids`（pid → ppid）里以 `root` 为根的整棵树的 pid；`root` 不在表里回空数组。
 *
 * `born`（pid → 创建时刻，可缺）：Windows 上进程记的父进程号在父进程退出后不会改，那个号之后可能被别的进程重用——
 * 一个早就成了孤儿的无关进程，就会被当成重用了它父进程号的那个进程的孩子。给了 `born` 时，「父」比「子」创建得晚的那条
 * 关系不认（真正的父进程一定先于子进程创建）。Linux 上孤儿会改挂到 1 号进程下面，没有这个问题，不用给。
 */
export function treeMembers(root, ppids, born = null) {
  if (!ppids.has(root)) return [];
  const children = new Map();
  for (const [pid, ppid] of ppids) {
    if (born && born.has(pid) && born.has(ppid) && born.get(ppid) > born.get(pid)) continue; // 父进程号被重用了：不是它的孩子
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return out;
}

/** 把一棵树里各进程的读数加起来；`one(pid)` 回 `{ bytes, method }`、`{ gone }` 或 `{ error }`。任何一个进程读不了，整棵树就是量不了 */
function sumMembers(root, members, one) {
  let bytes = 0;
  let method = null;
  for (const pid of members) {
    const r = one(pid);
    if (r.gone) { if (pid === root) return { bytes: null, reason: 'root-gone' }; continue; }
    if (r.error) return { bytes: null, reason: `unreadable:${pid}:${r.error}` };
    bytes += r.bytes;
    method = coarser(method, r.method);
  }
  return { bytes, method: method ?? 'pss', procs: members.length };
}

function measureLinux(roots, fsx) {
  const ppids = new Map();
  for (const name of fsx.list('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fsx.read(`/proc/${name}/stat`);
      ppids.set(Number(name), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch { /* 这个进程刚没了 */ }
  }
  let selfPath = null;
  try { selfPath = parseCgroupPath(fsx.read('/proc/self/cgroup')); } catch { /* 读不了：当没有独立 cgroup 处理 */ }
  const claimed = new Map();
  return roots.map((root) => {
    if (!Number.isInteger(root) || root <= 0) return null;
    if (!ppids.has(root)) return { bytes: null, reason: 'root-gone' };
    // 有自己独立的 cgroup（不是管理进程自己所在的那个）：整个 cgroup 就是这棵树，内核记的账不重复也不漏
    let cg = null;
    try { cg = parseCgroupPath(fsx.read(`/proc/${root}/cgroup`)); } catch { /* 读不了：按进程量 */ }
    if (cg && cg !== '/' && cg !== selfPath) {
      if (claimed.has(cg)) return { bytes: 0, method: 'cgroup', cgroup: cg, sharedWith: claimed.get(cg) }; // 两棵树在同一个 cgroup 里：只记一次
      const m = cgroupMemory(cg, { fsx });
      if (m) { claimed.set(cg, root); return { bytes: m.bytes, method: 'cgroup', cgroup: cg, current: m.current }; }
    }
    return sumMembers(root, treeMembers(root, ppids), (pid) => pidMemoryLinux(pid, fsx));
  });
}

/** Windows 上一次问全：每个进程的 pid、父 pid、私有工作集（没有记 `-`）、私有已提交（没有记 `-`）、创建时刻（FILETIME，没有记 `-`） */
const WIN_MEMORY_SCRIPT = '$perf=@{}; try { Get-CimInstance Win32_PerfRawData_PerfProc_Process -ErrorAction Stop | ForEach-Object { $perf[[int]$_.IDProcess]=$_.WorkingSetPrivate } } catch {}; '
  + 'Get-CimInstance Win32_Process | ForEach-Object { $w=$perf[[int]$_.ProcessId]; if ($null -eq $w) { $w=\'-\' }; $p=$_.PrivatePageCount; if ($null -eq $p) { $p=\'-\' }; '
  + '$b=\'-\'; if ($_.CreationDate) { $b=$_.CreationDate.ToFileTimeUtc() }; "$($_.ProcessId) $($_.ParentProcessId) $w $p $b" }';

function measureWindows(roots, spawnSync) {
  const failAll = (reason) => roots.map((r) => (Number.isInteger(r) && r > 0 ? { bytes: null, reason } : null));
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_MEMORY_SCRIPT], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  if (r.error || r.status !== 0) return failAll('query-failed');
  const ppids = new Map();
  const mem = new Map();
  const born = new Map();
  for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
    const [id, ppid, ws, priv, at] = line.trim().split(/\s+/);
    if (!/^\d+$/.test(id ?? '')) continue;
    ppids.set(Number(id), Number(ppid));
    if (/^\d+$/.test(at ?? '')) born.set(Number(id), Number(at));
    mem.set(Number(id), { ws: /^\d+$/.test(ws ?? '') ? Number(ws) : null, priv: /^\d+$/.test(priv ?? '') ? Number(priv) : null });
  }
  if (ppids.size === 0) return failAll('empty-process-table');
  return roots.map((root) => {
    if (!Number.isInteger(root) || root <= 0) return null;
    if (!ppids.has(root)) return { bytes: null, reason: 'root-gone' };
    return sumMembers(root, treeMembers(root, ppids, born), (pid) => {
      const m = mem.get(pid);
      if (!m) return { gone: true };
      if (m.ws !== null) return { bytes: m.ws, method: 'private-ws' };
      if (m.priv !== null) return { bytes: m.priv, method: 'private-bytes' };
      return { error: 'no-private-memory' };
    });
  });
}

/**
 * 量几棵进程树占的物理内存（口径见上）。一次扫一遍进程表：Windows 上只起一次 PowerShell。
 * @param {Array<number | null>} roots 各棵树的根 pid；`null` 表示这一棵没在跑
 * @returns {Array<null | { bytes: number, method: string } | { bytes: null, reason: string }>} 与 `roots` 一一对应；没在跑的回 null
 */
export function measureTrees(roots, { platform = process.platform, fsx = realProcfs, spawnSync = nodeSpawnSync } = {}) {
  try {
    if (platform === 'linux') return measureLinux(roots, fsx);
    if (platform === 'win32') return measureWindows(roots, spawnSync);
    return roots.map((r) => (Number.isInteger(r) && r > 0 ? { bytes: null, reason: 'unsupported-platform' } : null));
  } catch (err) {
    return roots.map((r) => (Number.isInteger(r) && r > 0 ? { bytes: null, reason: `measure-error:${String(err?.code ?? err?.message ?? err).slice(0, 80)}` } : null));
  }
}

/** `procs`: pid → { ppid, rss }；回以 `root` 为根的整棵树的 rss 之和（根不在表里回 null）。`rss` 要是已经不重复的口径 */
export function sumTree(root, procs) {
  const members = treeMembers(root, new Map([...procs].map(([pid, p]) => [pid, p.ppid])));
  if (members.length === 0) return null;
  return members.reduce((n, pid) => n + (procs.get(pid)?.rss ?? 0), 0);
}

/**
 * 内存看护的判定（纯状态机，管理进程每个采样拍调一次）。
 *
 * 管的是两棵工作进程树合起来的（契约第 4 节）：`resident` 常驻的、`iso` 隔离的，各是 `measureTrees` 的一项
 * （`null` / `undefined` = 这一棵没在跑）。回 `{ total, limit, verdict, victim, failures, methods }`：
 *   - `verdict: 'idle'`：两棵都没在跑，不判；
 *   - `verdict: 'unmeasured'`：在跑的有任何一棵量不了（`failures` 里列出原因）——不当成 0、也不当成超限，这一拍不判，`total` 为 null；
 *   - `verdict: 'ok'`：合起来没超；
 *   - `verdict: 'over'`：合起来超了；`victim` 是要结束的那一棵：隔离的在跑就先结束它（跑的是项目带来的代码），常驻的留着；
 *     只有常驻的在跑才结束常驻的。刚结束过的那一棵在 `cooldownMs` 内不再判（它还在退出，读数还是旧的，别记两次、别连杀）：
 *     这一拍 `verdict: 'cooling'`、`victim: null`。
 *
 * **与 cgroup 的关系**：有独立 cgroup 时（任一棵的口径是 `cgroup`），硬上限由内核执行——它在 `memory.current` 到 `MemoryMax` 时先回收文件缓存、
 * 回收不下来才在这个 cgroup 里杀进程，所以内核总是先动手。这里的上限放宽 `backstopRatio`（缺省 5%）：内核已经动手的那一拍读数不会越过这条线，
 * 不会双杀；只有内核没有执行（slice 没装、`MemoryMax` 没生效、两个 scope 各自没超而合起来超了）才会越线，这时进程内看护兜底。
 * 没有独立 cgroup 时没有内核那一层，上限就是 `max`。
 */
export function createMemoryWatch({ max, backstopRatio = 1.05, cooldownMs = 30_000, now = Date.now } = {}) {
  const lastKill = { resident: -Infinity, isolated: -Infinity };
  return {
    judge({ resident = null, iso = null } = {}) {
      const entries = [['resident', resident], ['isolated', iso]].filter(([, m]) => m !== null && m !== undefined);
      if (entries.length === 0) return { total: null, limit: max, verdict: 'idle', victim: null, failures: [], methods: {} };
      const methods = Object.fromEntries(entries.map(([who, m]) => [who, m.method ?? null]));
      const failures = entries.filter(([, m]) => !Number.isFinite(m.bytes)).map(([who, m]) => ({ who, reason: m.reason ?? 'unknown' }));
      const viaCgroup = entries.some(([, m]) => m.method === 'cgroup');
      const limit = viaCgroup ? Math.round(max * backstopRatio) : max;
      if (failures.length > 0) return { total: null, limit, verdict: 'unmeasured', victim: null, failures, methods };
      const total = entries.reduce((n, [, m]) => n + m.bytes, 0);
      if (!(Number.isFinite(max) && max > 0) || total <= limit) return { total, limit, verdict: 'ok', victim: null, failures, methods };
      const victim = iso !== null && iso !== undefined ? 'isolated' : 'resident';
      const at = now();
      if (at - lastKill[victim] < cooldownMs) return { total, limit, verdict: 'cooling', victim: null, failures, methods };
      lastKill[victim] = at;
      return { total, limit, verdict: 'over', victim, failures, methods };
    },
  };
}

/** 这台机器的核数（容器里按可用的算） */
export const machineCores = () => (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) || 1;

/**
 * 背压里「负载高」的线：每核 1（1 分钟负载高于核数，说明就绪的任务已经排不下）。新节点 8 核就是 8，
 * 4 核的容器是 4——原来写死 8，是照新节点定的，核少的机器上等于没有这条线。
 */
export const loadHighFor = (cores) => Math.max(1, Math.floor(Number(cores) || 1));

/**
 * 背压的判定（纯状态机）。`sample({ memAvailable, healthMs, load1 })` 回 `{ paused, reasons }`：
 * - 可用内存低于 `memLowBytes` → `memory`；
 * - 文档服务自检连续 `healthSlowCount` 次超过 `healthSlowMs`（`healthMs` 为 null 表示这次没问通，同样算慢）→ `docservice`；
 * - 1 分钟负载高于 `loadHigh`（缺省按核数，`loadHighFor(cores)`）→ `load`；
 * 任一项成立就暂停；全部不成立持续满 `recoverMs` 才放开。读数给 null / undefined 的那一项这次不判。
 */
export function createBackpressure({ now = Date.now, cores = machineCores(), ...overrides } = {}) {
  const L = { ...LIMIT_DEFAULTS, ...overrides };
  if (!Number.isFinite(L.loadHigh)) L.loadHigh = loadHighFor(cores);
  let paused = false;
  let slow = 0;
  let clearSince = null;
  let reasons = [];
  return {
    sample({ memAvailable: mem, healthMs, load1 } = {}) {
      const at = now();
      if (healthMs === null || (Number.isFinite(healthMs) && healthMs > L.healthSlowMs)) slow += 1;
      else if (Number.isFinite(healthMs)) slow = 0;
      const hit = [];
      if (Number.isFinite(mem) && mem < L.memLowBytes) hit.push('memory');
      if (slow >= L.healthSlowCount) hit.push('docservice');
      if (Number.isFinite(load1) && load1 > L.loadHigh) hit.push('load');
      if (hit.length > 0) {
        paused = true;
        reasons = hit;
        clearSince = null;
      } else if (paused) {
        clearSince ??= at;
        if (at - clearSince >= L.recoverMs) {
          paused = false;
          reasons = [];
          clearSince = null;
        }
      }
      return { paused, reasons: [...reasons] };
    },
    get paused() { return paused; },
    get reasons() { return [...reasons]; },
  };
}

/**
 * 因内存被结束的记账：`note()` 记一次，回 `{ count, degrade }`；`oomWindowMs` 内满 `oomCount` 次 `degrade` 为真（并发降到 1）。
 */
export function createOomTracker({ now = Date.now, windowMs = LIMIT_DEFAULTS.oomWindowMs, count = LIMIT_DEFAULTS.oomCount } = {}) {
  let times = [];
  let degraded = false;
  return {
    note() {
      const at = now();
      times = times.filter((t) => at - t <= windowMs);
      times.push(at);
      if (times.length >= count) degraded = true;
      return { count: times.length, degrade: degraded };
    },
    get degraded() { return degraded; },
  };
}
