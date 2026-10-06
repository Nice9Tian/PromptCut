/**
 * 托管方渲染服务的工作进程看护（契约 `docs/plan/hosted-render-contract.md` 第 4、7.1 节）。管理进程用。
 *
 * 工作进程就是 `scripts/render-host.mjs` 起的那棵（Vite、预渲染进程、Chrome）。这里负责：
 * - 起：命令由调用方给（`command()`，可能包了 `systemd-run` 或 `nice`）；子进程自成一组，窗口隐藏；
 * - 退出就按退避重起（1 s 起、翻倍、封顶 60 s；连续跑满 60 s 后退避归零）。它手里的认领由队列按断线规则收回；
 * - `kill(reason)`：结束整棵树（内存看护超限时用），照常走退出与重起；
 * - `stop()`：先请它自己收尾（放回认领：非 Windows 发 SIGTERM，Windows 经 IPC 发 `shutdown`），等 `graceMs`，不退就结束整棵树。
 * 不引 Vite；子进程的起法可以整个注入（`spawn`），单测不起真进程。
 */
import { spawn as nodeSpawn } from 'node:child_process';

export const WORKER_DEFAULTS = Object.freeze({ BACKOFF_MIN_MS: 1000, BACKOFF_MAX_MS: 60_000, STABLE_MS: 60_000, GRACE_MS: 15_000 });

/** 结束一棵进程树 */
export function killTree(pid, { platform = process.platform, spawn = nodeSpawn } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 已经没了 */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ } }
}

/**
 * @param {object} o
 * @param {() => { cmd: string, args: string[], env: object, cwd?: string }} o.command 每次起之前调（并发降级后参数会变）
 * @param {(event: string, fields?: object) => void} [o.log]
 * @param {(line: string) => void} [o.onLine] 子进程的每一行输出
 * @param {() => number} [o.now]
 * @param {typeof nodeSpawn} [o.spawn]
 * @param {(fn: () => void, ms: number) => any} [o.setTimer]
 */
export function createWorker({
  command, log = () => {}, onLine = () => {}, now = Date.now, spawn = nodeSpawn, setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  backoffMinMs = WORKER_DEFAULTS.BACKOFF_MIN_MS, backoffMaxMs = WORKER_DEFAULTS.BACKOFF_MAX_MS, stableMs = WORKER_DEFAULTS.STABLE_MS, graceMs = WORKER_DEFAULTS.GRACE_MS,
  platform = process.platform,
} = {}) {
  let child = null;
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

  function start() {
    if (stopping || child) return;
    const { cmd, args, env, cwd } = command();
    starts += 1;
    ready = false;
    startedAt = now();
    let proc;
    try {
      proc = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe', ...(platform === 'win32' ? ['ipc'] : [])], windowsHide: true, detached: platform !== 'win32' });
    } catch (err) {
      log('worker.spawn-failed', { message: String(err?.message ?? err) });
      onExit(null, null, 'spawn-failed');
      return;
    }
    child = proc;
    log('worker.start', { pid: proc.pid ?? null, starts });
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.once('error', (err) => { if (child === proc) { log('worker.spawn-failed', { message: String(err?.message ?? err) }); child = null; onExit(null, null, 'spawn-failed'); } });
    proc.once('exit', (code, signal) => { if (child === proc) { child = null; onExit(code, signal, pendingReason ?? 'exit'); } });
  }

  function onExit(code, signal, reason) {
    exits += 1;
    const ranMs = startedAt === null ? 0 : now() - startedAt;
    lastExit = { code, signal, reason, ranMs, at: now() };
    pendingReason = null;
    ready = false;
    log('worker.exit', lastExit);
    for (const w of exitWaiters.splice(0)) w();
    if (stopping) return;
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
      killTree(child.pid, { platform, spawn });
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
        if (platform === 'win32') { if (proc.connected) proc.send({ type: 'shutdown' }); else killTree(proc.pid, { platform, spawn }); }
        else process.kill(proc.pid, 'SIGTERM');
      } catch { killTree(proc.pid, { platform, spawn }); }
      let done = false;
      await Promise.race([exited().then(() => { done = true; }), new Promise((resolve) => setTimer(resolve, graceMs))]);
      if (!done) { killTree(proc.pid, { platform, spawn }); await Promise.race([exited(), new Promise((resolve) => setTimer(resolve, 5000))]); }
    },
    get pid() { return child?.pid ?? null; },
    get running() { return !!child; },
    get ready() { return ready; },
    status: () => ({ pid: child?.pid ?? null, running: !!child, ready, starts, exits, lastExit, startedAt }),
  };
}
