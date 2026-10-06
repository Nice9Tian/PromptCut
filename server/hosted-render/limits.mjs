/**
 * 托管方渲染服务的资源手段（契约 `docs/plan/hosted-render-contract.md` 第 4 节）。管理进程用；纯函数与可注入的探测，不引 Vite。
 *
 * - **cgroup**（只在有 systemd 与 cgroup v2 的 Linux 上）：工作进程经 `systemd-run --scope --slice=promptcut-render.slice` 起，
 *   内存硬上限、节流线、CPU 配额与权重、IO 权重、任务数、OOM 先后都写成 scope 的属性。没有 systemd 时**降级**：
 *   自检报一条 `no-cgroup` 的告警并继续，只靠下面的进程内手段（Linux 上另加 `nice`）。
 * - **背压**：每次采样给可用内存、文档服务自检的往返时延、1 分钟负载；任一项越线就暂停认领，全部恢复满 `recoverMs` 再放开。
 * - **内存看护**：量工作进程整棵树的常驻内存，超过硬上限就让调用方结束这棵树（没有 cgroup 时它是唯一的硬上限；
 *   有 cgroup 时通常是内核先动手，这里兜底）。
 * - **OOM 降级**：10 分钟内第 3 次因内存被结束，并发降到 1。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

/**
 * 一棵进程树的常驻内存（字节）；量不了回 null。Linux 走 `/proc`；Windows 问一次 CIM（隐藏窗口）；别的平台回 null。
 * @param {number} pid 树根
 */
export function treeRss(pid, { platform = process.platform } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') {
      const procs = new Map();
      for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
          const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          procs.set(Number(name), { ppid: Number(rest[1]), rss: Number(rest[21]) * 4096 });
        } catch { /* 这个进程刚没了 */ }
      }
      return sumTree(pid, procs);
    }
    if (platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)" }'],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
      if (r.status !== 0) return null;
      const procs = new Map();
      for (const line of r.stdout.split(/\r?\n/)) {
        const [id, ppid, rss] = line.trim().split(/\s+/).map(Number);
        if (Number.isInteger(id)) procs.set(id, { ppid, rss: Number.isFinite(rss) ? rss : 0 });
      }
      return sumTree(pid, procs);
    }
  } catch { /* 量不了 */ }
  return null;
}

/** `procs`: pid → { ppid, rss }；回以 `root` 为根的整棵树的 rss 之和（根不在表里回 null） */
export function sumTree(root, procs) {
  if (!procs.has(root)) return null;
  const children = new Map();
  for (const [pid, p] of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(pid);
  }
  let total = 0;
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += procs.get(pid)?.rss ?? 0;
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return total;
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
