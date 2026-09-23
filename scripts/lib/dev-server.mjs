/**
 * 测试脚本共用的两样东西,不单独运行:
 *
 *   1. 在一段空闲端口上起一台**自己的** dev server,用完连同子进程一起收掉
 *      (`scripts/export-e2e.mjs`、`scripts/review-loop-run.mjs` 用);
 *   2. media junction:建链接、只拆链接、清理上次被强杀留下的链接。
 *
 * 端口:每台 dev server 另占「端口 +1」「端口 +2」当舞台端口,三个连号都要空着;
 * 被占了页面会退回同源单舞台,测出来的就不是正常形态。5190~5192 是用户常驻的那台,不碰。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 用户常驻的 dev server(`npm run dev`)和它的两个舞台端口 */
const RESERVED = new Set([5190, 5191, 5192]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** worktree 没有自己的 node_modules(依赖往上解析到主仓库);vite 的 exports 不放行 bin,解析主入口再回到包根 */
export function viteBin() {
  const local = path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

export function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** 编辑器端口和它的两个舞台端口 */
export const portTriple = (port) => [port, port + 1, port + 2];

export async function tripleFree(port) {
  for (const p of portTriple(port)) if (!(await portFree(p))) return false;
  return true;
}

/**
 * 挑一个三连号都空着的编辑器端口。从 20000 以上随机挑:Node 的 fetch 和 Chrome 都拒绝
 * 「坏端口」黑名单(最大的是 10080),按构造绕开(见 scripts/headless.mjs 的 freePort)。
 */
export async function pickPort(tries = 50) {
  for (let i = 0; i < tries; i++) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    if (await tripleFree(port)) return port;
  }
  throw new Error('找不到三个连号都空着的端口');
}

export async function waitHttp(url, pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (pred(data)) return data;
      }
    } catch {}
    await sleep(400);
  }
  throw new Error(`${label} 超时(${Math.round(timeoutMs / 1000)}s)`);
}

/** 连子进程一起杀(vite 下面还挂着预渲染进程和 Chrome)。同步执行,退出钩子里也能用 */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

/**
 * 起一台 dev server。
 *
 * @param {object} o
 * @param {Record<string,string>} [o.env]  追加的环境变量(导出目录、数据目录之类)
 * @param {string} o.logFile               vite 的输出写到这里
 * @param {number} [o.port]                指定编辑器端口;不给就随机挑,舞台端口没起全会换一段重来
 * @param {(msg: string) => void} [o.log]
 * @returns {Promise<{ port: number, origin: string, stagePorts: number[], pid: number, restarts: () => number, exited: () => boolean, stop: () => void }>}
 */
export async function startDevServer({ env = {}, logFile, port, log = () => {} }) {
  if (port) {
    const clash = portTriple(port).filter((p) => RESERVED.has(p));
    if (clash.length) throw new Error(`端口 ${clash.join('、')} 是用户常驻 dev server 的,换一个`);
  }
  const attempts = port ? 1 : 3;
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    const p = port || (await pickPort());
    if (port && !(await tripleFree(p))) throw new Error(`端口 ${portTriple(p).join(' / ')} 没有全空着`);
    try {
      return await startOnce(p, env, logFile, log);
    } catch (e) {
      lastError = e;
      log(`端口 ${p} 没起成:${e.message}`);
    }
  }
  throw lastError;
}

async function startOnce(port, env, logFile, log) {
  const origin = `http://127.0.0.1:${port}`;
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const child = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: REPO,
    env: { ...process.env, BROWSER: 'none', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let exited = false;
  let restarts = 0;
  const onData = (chunk) => {
    logStream.write(chunk);
    // 测量期间有人改了 server/*.ts 或 vite.config.ts,vite 会整台重启:页面断线、跑到一半的对话被掐断
    const text = chunk.toString();
    const n = (text.match(/server restarted/gi) || []).length;
    if (n) { restarts += n; log(`⚠ dev server 重启了(累计 ${restarts} 次)—— 多半是有人改了 server/ 或 vite.config.ts`); }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', () => { exited = true; logStream.end(); });

  const stop = () => {
    if (!exited) killTree(child.pid);
  };
  try {
    await Promise.race([
      waitHttp(`${origin}/api/mcp/status`, (d) => d && typeof d.port === 'number', 120000, '等 dev server 起来'),
      new Promise((_, reject) => child.once('exit', (code) => reject(new Error(`vite 提前退出(code ${code}),看 ${logFile}`)))),
    ]);
    const stage = await fetch(`${origin}/api/stage/ports`).then((r) => r.json());
    const stagePorts = Array.isArray(stage?.ports) ? stage.ports : [];
    if (stagePorts.length < (stage?.count ?? 2)) {
      throw new Error(`舞台端口只起来 ${stagePorts.length} 个(${portTriple(port).slice(1).join(' / ')} 有被占的),页面会退回同源单舞台`);
    }
    return { port, origin, stagePorts, pid: child.pid, restarts: () => restarts, exited: () => exited, stop };
  } catch (e) {
    stop();
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * media junction
 *
 * 导出目录里的 media 指向用户的素材目录。危险在「删」:顺着 junction 递归删,删掉的是
 * 用户的素材本身。这里只提供两种动作 —— 建链接、只拆链接 —— 并且拆之前核对它确实是
 * 我们建的那条链接,拆之后核对它确实没了、目标还在。确认失败就抛,调用方不得再删任何东西。
 * ------------------------------------------------------------------ */

const MARKER = '.media-junction.json';

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** 在 link 处建一条指向 target 的 junction,并在同目录写标记(记下链接、目标、pid,供强杀后清理) */
export function createJunction(link, target) {
  const abs = path.resolve(target);
  const st = lstatOrNull(abs);
  if (!st || !st.isDirectory()) throw new Error(`素材目录不存在:${abs}`);
  if (lstatOrNull(link)) throw new Error(`${link} 已经存在,不在它上面建 junction`);
  fs.symlinkSync(abs, link, 'junction');
  fs.writeFileSync(path.join(path.dirname(link), MARKER), JSON.stringify({ link: path.resolve(link), target: abs, pid: process.pid, createdAt: new Date().toISOString() }, null, 2));
}

/**
 * 只拆链接,不碰目标。
 *
 * fs.unlinkSync 对 junction 删的是链接本身;对一个真目录,libuv 直接拒绝(EPERM),
 * 所以这一步按构造不会递归。和 PowerShell 里 [System.IO.Directory]::Delete(<junction>) 是同一件事。
 *
 * @param {string} link
 * @param {string} [expectTarget] 给了就核对链接确实指向它,不是就不拆
 * @returns {boolean} 拆了返回 true;本来就没有返回 false
 */
export function removeJunction(link, expectTarget) {
  const st = lstatOrNull(link);
  if (!st) return false;
  if (!st.isSymbolicLink()) throw new Error(`${link} 不是链接,不动它`);
  const target = fs.readlinkSync(link);
  if (expectTarget && !samePath(target, expectTarget)) throw new Error(`${link} 指向 ${target},不是 ${expectTarget},不动它`);
  fs.unlinkSync(link);
  if (lstatOrNull(link)) throw new Error(`${link} 拆完还在`);
  if (!lstatOrNull(target)) throw new Error(`拆完链接后目标 ${target} 不见了`);
  return true;
}

/** 按标记拆链接,拆成了再删标记 */
export function removeMarkedJunction(dir) {
  const marker = path.join(dir, MARKER);
  let info;
  try { info = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { return false; }
  const removed = removeJunction(info.link, info.target);
  fs.rmSync(marker, { force: true });
  return removed;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * 清理上次被强杀(任务管理器结束、taskkill /F)时没来得及拆的链接。
 * 只看 root 下一层目录里的标记;建它的进程还活着就不动。
 * @returns {string[]} 拆掉的链接
 */
export function sweepStaleJunctions(root) {
  const removed = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return removed; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const marker = path.join(dir, MARKER);
    let info;
    try { info = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { continue; }
    if (info.pid && info.pid !== process.pid && alive(info.pid)) continue;
    if (removeMarkedJunction(dir)) removed.push(info.link);
  }
  return removed;
}

/** 2026-09-23T15:30:12 → 20260923-153012,给默认目录名用 */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
