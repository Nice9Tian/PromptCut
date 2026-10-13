/**
 * 云端 Agent 的一个浏览器会话:**一个「项目 × 对话」一个浏览器进程、一份用户数据目录、一个出网代理**
 * (计划 `docs/plan/cloud-agent-tools-implementation.md` 的 W1 包;契约 `docs/plan/cloud-agent-contract.md` 第 9.5、9.6 节)。
 *
 * 和桌面版(`server/web/browser.mjs`)不同的地方,都是因为它跑在别人的机器上、没人在旁边:
 *
 *   - **只用无头模式**,不开窗口;没有「挪到用户面前」这回事(网页接管是另一包)。
 *   - **用管道连浏览器**(`--remote-debugging-pipe`),不开调试端口:网页连不到调试口;Agent 服务进程一死,管道断开,浏览器自己退出,
 *     不会留下一个没人管的浏览器,也不存在「重启后接管旧浏览器」。
 *   - **出网只经本会话自己的代理**(`network.mjs`),其余的路在启动参数里堵上。
 *   - **环境变量按白名单重建**(`workspace.mjs` 的 `childEnv`):浏览器进程里没有 Agent 服务的任何配置与凭证,也没有系统代理变量。
 *   - **下载一律拒**;新开的标签页并回当前页;页面弹的对话框自动关掉(没人去点,不关会把页面卡死)。
 *   - **浏览器进程自己起**(`server/agent/service/perception/runner.mjs` 的 `spawnTree`,和云端别的子进程同一套):非 Windows 上是一个进程组,
 *     按组杀、按组核;puppeteer 只经管道说调试协议,不用它的启动器。
 *   - **关闭要有证据**:杀整棵树之后,等主进程的退出与管道关闭,逐个核记下的进程号,非 Windows 上再核进程组空了(僵尸按已退算),才算关掉。
 *
 * 动作层(打开、看、点、输入、滚动、读)的页面逻辑复用桌面版 `server/web/session.mjs`、`view.mjs`、`hit.mjs`,
 * 清单的版本与「编号还指着原来那个元素吗」在 `view.mjs`、`hit.mjs`(本目录)里。
 *
 * 本文件不认授权:谁能用、这一轮还算不算数,由 `server/agent/service/hosted-browser.mjs` 在每次调用前后核。
 * 不引用 `src/`。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { VIEWPORT } from '../browser.mjs';
import { read as desktopRead } from '../session.mjs';
import { childEnv } from '../../agent/service/workspace.mjs';
import { spawnTree, killTree, whenClosed, groupAlive } from '../../agent/service/perception/runner.mjs';
import { startBrowserProxy, hostedNetworkArgs, filterExtraArgs, pageRequestAllowed, isWebUrl, admitWebTarget, egressRefusalText } from './network.mjs';
import { captureHostedView, parseUid, PAGE_DATA_NOTICE } from './view.mjs';
import { resolveAt, explain, locate, focusElement, clearElement, explainStale, explainSecret } from './hit.mjs';

/** 记这份用户数据目录是哪个进程起的浏览器在用(清孤儿用) */
const OWNER_FILE = 'owner.json';
/**
 * 这个对话的清单出到第几版了。跨浏览器进程接着往下编:关掉重开、服务重启、目录因「设为私有」被清之后,
 * 新浏览器的版本号不会和模型手里旧清单的版本号撞上(撞上的话旧编号会点到新页面的元素上)。里面只有一个数,不是用户数据。
 */
const REV_FILE = 'rev';

function readRev(sessionDir) {
  try {
    const n = Number(fs.readFileSync(path.join(sessionDir, REV_FILE), 'utf8').trim());
    return Number.isSafeInteger(n) && n >= 0 && n < 900_000_000 ? n : 0;
  } catch { return 0; }
}

/** 清掉一个对话的浏览器数据。`keepRev`:只删用户数据目录与临时文件,留下清单版本的计数 */
export async function removeSessionData(sessionDir, { keepRev = false, timeoutMs = 8_000 } = {}) {
  if (!keepRev) return removeDirFully(sessionDir, { timeoutMs });
  let ok = true;
  for (const name of ['profile', '.tmp']) ok = await removeDirFully(path.join(sessionDir, name), { timeoutMs }) && ok;
  try { fs.rmSync(path.join(sessionDir, OWNER_FILE), { force: true }); } catch { /* 删不掉不影响 */ }
  return ok;
}

/**
 * 启动参数打头的那一个。本机的 Chrome for Testing 缺省套用实验配置,会偶发页面永远加载不完
 * (取证见 `scripts/probes/probe-chrome.mjs` 的说明);正式版与 chrome-headless-shell 不认识它也无妨。
 */
export const HOSTED_BROWSER_ARG_PREFIX = Object.freeze(['--disable-field-trial-config']);

export class HostedSessionError extends Error {
  /** @param {string} code */
  constructor(code, message) {
    super(message);
    this.name = 'HostedSessionError';
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/** 进程号还查得到吗。EPERM 是「在,但动不了」,也算在 */
export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

/** 杀整棵进程树:浏览器有渲染、GPU、网络等子进程,只杀主进程会留下它们 */
export function killProcessTree(pid, child = null) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      const killer = nodeSpawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => { try { child?.kill('SIGKILL'); } catch { /* 已经退了 */ } });
      // taskkill 自己可能很慢(机器忙时它查进程树要好几秒):不让它拖住本进程退出
      killer.unref();
    } catch { try { child?.kill('SIGKILL'); } catch { /* 已经退了 */ } }
    return;
  }
  // 浏览器是以新进程组的组长起的(detached),负的进程号 = 整个组
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经退了 */ } }
}

/**
 * Linux:`/proc/<进程号>/stat` 里的状态字母与进程组号;读不到回 null。
 * 进程名里可以有空格和括号,所以从最后一个 `)` 往后数:状态、父进程号、进程组号。
 */
export function procStat(pid, { procRoot = '/proc' } = {}) {
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const pgrp = Number(rest[2]);
    return { state: rest[0] ?? '', pgrp: Number.isSafeInteger(pgrp) ? pgrp : null };
  } catch { return null; }
}

/**
 * 进程是不是还**活着**:查得到、而且不是僵尸。
 * 僵尸是已经死了、只是还没被父进程收走的记录(不占内存、跑不了代码、发不了请求),按已退算。容器里 Agent 服务是 1 号进程又没有
 * init 时,浏览器的子进程(zygote、渲染进程)被杀后会挂成 Agent 服务名下的僵尸,一直查得到——只看「查不查得到」就永远关不完。
 */
export function pidLive(pid, { platform = process.platform, procRoot = '/proc', alive = pidAlive } = {}) {
  if (!alive(pid)) return false;
  if (platform !== 'linux') return true;
  const stat = procStat(pid, { procRoot });
  return !(stat && (stat.state === 'Z' || stat.state === 'X'));
}

/**
 * Linux:一个进程组里还活着(不是僵尸)的进程号。浏览器是进程组的组长,它起的 zygote、渲染、GPU、网络进程都在这个组里,
 * 包括浏览器自己的进程表里列不出来的——所以「整棵树都退了」在 Linux 上看的是这个组空了没有。读不了 /proc 回 null(不知道)。
 */
export function liveGroupMembers(pgid, { procRoot = '/proc' } = {}) {
  let names;
  try { names = fs.readdirSync(procRoot); } catch { return null; }
  const live = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const stat = procStat(Number(name), { procRoot });
    if (stat && stat.pgrp === pgid && stat.state !== 'Z' && stat.state !== 'X') live.push(Number(name));
  }
  return live;
}

/**
 * 浏览器这个进程组里还有没有活着的进程。Windows 没有进程组,回 null(那边靠逐个核进程号)。
 * 先问系统「组还在不在」(`runner.mjs` 的 `groupAlive`:组里一个进程都没有时是 ESRCH);还在的话再排掉僵尸。
 */
export function browserGroupLive(pgid, { platform = process.platform, procRoot = '/proc', group = groupAlive } = {}) {
  if (platform === 'win32' || !pgid) return null;
  if (group(pgid, { platform }) === false) return false;
  const live = liveGroupMembers(pgid, { procRoot });
  // 读不了 /proc(macOS):组还在就当还活着,不假称退干净了
  return live === null ? true : live.length > 0;
}

/** 等一组进程号都不再活着(僵尸按已退算);回还活着的那些 */
export async function waitPidsGone(pids, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let left = [...new Set(pids)].filter((pid) => pidLive(pid));
  while (left.length && Date.now() < end) {
    await sleep(50);
    left = left.filter((pid) => pidLive(pid));
  }
  return left;
}

/**
 * 经管道和浏览器说调试协议的传输层(交给 `puppeteer.connect({ transport })`):消息是 JSON,以 NUL 结尾。
 * 浏览器由本文件自己起(`spawnTree`),不经 puppeteer 的启动器,所以这一小段也自己写。
 */
class PipeTransport {
  /** @param {import('node:stream').Writable} write 浏览器的 3 号描述符(它从这里读命令) @param {import('node:stream').Readable} read 4 号(它往这里写) */
  constructor(write, read) {
    this.onmessage = null;
    this.onclose = null;
    this.closed = false;
    this.write = write;
    this.read = read;
    let pending = [];
    this.onData = (buffer) => {
      if (this.closed) return;
      pending.push(buffer);
      if (buffer.indexOf(0) === -1) return;
      const all = Buffer.concat(pending);
      let start = 0;
      for (let end = all.indexOf(0); end !== -1; end = all.indexOf(0, start)) {
        const message = all.toString('utf8', start, end);
        setImmediate(() => { if (!this.closed) this.onmessage?.call(null, message); });
        start = end + 1;
      }
      pending = start >= all.length ? [] : [all.subarray(start)];
    };
    this.onEnd = () => { this.onclose?.call(null); };
    read.on('data', this.onData);
    read.once('close', this.onEnd);
    read.on('error', () => {});
    write.on('error', () => {});
  }

  send(message) {
    if (this.closed || this.write.destroyed) return;
    try { this.write.write(message); this.write.write('\0'); } catch { /* 浏览器已经没了 */ }
  }

  close() {
    this.closed = true;
    this.read.removeListener('data', this.onData);
  }
}

/**
 * 这份用户数据目录是不是正被一个活着的浏览器占着。
 * Windows:浏览器独占打开目录里的 `lockfile`,别人打不开;Linux / macOS:目录里的 `SingletonLock` 是个指向「主机名-进程号」的链接。
 * @returns {{ held: boolean, pid: number | null }}
 */
export function profileHolder(userDataDir) {
  if (process.platform === 'win32') {
    const lock = path.join(userDataDir, 'lockfile');
    let fd;
    try { fd = fs.openSync(lock, 'r+'); } catch (err) {
      return { held: err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'EACCES', pid: null };
    }
    try { fs.closeSync(fd); } catch { /* 已经关了 */ }
    return { held: false, pid: null };
  }
  try {
    const target = fs.readlinkSync(path.join(userDataDir, 'SingletonLock'));
    const pid = Number(/-(\d+)$/.exec(target)?.[1]);
    return { held: pidAlive(pid), pid: Number.isSafeInteger(pid) ? pid : null };
  } catch { return { held: false, pid: null }; }
}

/** 一个进程的命令行(查不到回 null)。Linux 读 /proc,不起子进程;Windows、macOS 要问系统,只在清残留时用 */
export async function processCommandLine(pid, { timeoutMs = 15_000 } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || null; } catch { return null; }
  }
  const [command, args] = process.platform === 'win32'
    ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`]]
    : ['ps', ['-o', 'command=', '-p', String(pid)]];
  return new Promise((resolve) => {
    let text = '';
    let child;
    try { child = nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); } catch { resolve(null); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经退了 */ } }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', () => { clearTimeout(timer); resolve(text.trim() || null); });
  });
}

/**
 * Windows:一个进程的所有后代进程的进程号(查不到回空)。只在起浏览器时问一次系统。
 * 浏览器有几个子进程是它自己的进程表(SystemInfo)里列不出来的:崩溃上报的帮手进程、chrome-headless-shell 的控制台宿主。
 * 主进程被直接结束后,这种帮手进程实测还会多活几秒到十几秒,而且一直握着和本进程相连的管道——不单独结束它,就等不到「整棵树都退了」。
 */
export async function childPidsOf(pid, { timeoutMs = 8_000 } = {}) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return [];
  return new Promise((resolve) => {
    let text = '';
    let child;
    try {
      child = nodeSpawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId; $q = @(${pid}); while ($q.Count) { $c = @($all | Where-Object { $q -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId }); $c; $q = $c }`],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch { resolve([]); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经退了 */ } }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.once('error', () => { clearTimeout(timer); resolve([]); });
    child.once('close', () => {
      clearTimeout(timer);
      resolve(text.split(/\s+/).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0));
    });
  });
}

/**
 * 这个进程是不是一个正用着这份用户数据目录的浏览器。
 * 完整的 Chrome 会锁住目录(`profileHolder`);chrome-headless-shell 不锁(实测),所以再看它的命令行里有没有这份目录。
 */
export async function browserHoldsProfile(pid, userDataDir) {
  if (!pidAlive(pid)) return false;
  const holder = profileHolder(userDataDir);
  if (holder.held && (holder.pid === null || holder.pid === pid)) return true;
  const line = await processCommandLine(pid);
  if (!line) return false;
  return process.platform === 'win32' ? line.toLowerCase().includes(userDataDir.toLowerCase()) : line.includes(userDataDir);
}

/**
 * 清掉上一个 Agent 服务进程留下的浏览器(正常不会有:管道一断浏览器自己退;这是兜底)。
 * 只杀「登记过(或锁文件里写着)、还活着、而且确实正用着这份目录」的那个,免得进程号被系统回收后误杀别人。
 * @returns {Promise<{ found: boolean, killed: number[], stillHeld: boolean }>}
 */
export async function reapOrphan(sessionDir, { timeoutMs = 8_000 } = {}) {
  const userDataDir = path.join(sessionDir, 'profile');
  const forget = () => { try { fs.rmSync(path.join(sessionDir, OWNER_FILE), { force: true }); } catch { /* 删不掉不影响 */ } };
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(path.join(sessionDir, OWNER_FILE), 'utf8')); } catch { /* 没有登记 */ }
  const holder = profileHolder(userDataDir);
  const browserPid = holder.pid ?? (Number.isSafeInteger(owner?.browserPid) && owner.browserPid > 0 ? owner.browserPid : null);
  if (!browserPid || !await browserHoldsProfile(browserPid, userDataDir)) {
    // 目录被锁着却认不出是谁(没有登记、登记的进程不在了):杀不了,照实报「还被占着」
    if (holder.held) return { found: true, killed: [], stillHeld: true };
    forget();
    return { found: false, killed: [], stillHeld: false };
  }
  // 主进程直接结束(立刻生效),再让系统按父子关系补杀一遍。
  // 登记里的子进程号不直接杀:它们可能早就退了、号被系统分给了别的进程;主进程一没,浏览器的子进程自己会退
  try { process.kill(browserPid, 'SIGKILL'); } catch { /* 已经退了 */ }
  killProcessTree(browserPid);
  const left = await waitPidsGone([browserPid], timeoutMs);
  const end = Date.now() + timeoutMs;
  let stillHeld = left.length > 0 || profileHolder(userDataDir).held;
  while (stillHeld && Date.now() < end) { await sleep(100); stillHeld = pidAlive(browserPid) || profileHolder(userDataDir).held; }
  if (!stillHeld) forget();
  return { found: true, killed: [browserPid], stillHeld };
}

/** 删目录,删到真的没了(Windows 上进程刚退时文件句柄要过一会儿才放) */
export async function removeDirFully(dir, { timeoutMs = 8_000 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch { /* 下面看结果 */ }
    if (!fs.existsSync(dir)) return true;
    if (Date.now() > end) return false;
    await sleep(150);
  }
}

function dirBytes(dir) {
  let bytes = 0;
  const walk = (d) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { bytes += fs.statSync(p).size; } catch { /* 刚被删 */ } }
    }
  };
  walk(dir);
  return bytes;
}

function withDeadline(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new HostedSessionError('timeout', `${what} 超过 ${Math.round(ms / 1000)} 秒没有完成`)), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/* c8 ignore start — 页面内执行 */
function keepInOneTab() {
  // 云端只有一个页:新窗口、新标签页一律并回当前页(另有服务端的兜底:多出来的页直接关掉)
  try {
    window.open = (url) => { try { if (url) location.assign(String(url)); } catch { /* 地址不合法就算了 */ } return null; };
  } catch { /* 页面把 window 锁死了(改不了 open):靠服务端兜底 */ }
  document.addEventListener('click', (event) => {
    const a = event.target && event.target.closest ? event.target.closest('a[target],area[target]') : null;
    if (a && a.target && a.target !== '_self') a.target = '_self';
  }, true);
  document.addEventListener('submit', (event) => {
    const f = event.target;
    if (f && f.target && f.target !== '_self') f.target = '_self';
  }, true);
}
/* c8 ignore stop */

/**
 * 起一个会话。失败抛 `HostedSessionError`(`browser-missing` / `profile-busy` / `launch-failed`)。
 *
 * @param {object} o
 * @param {string} o.sessionDir 这个「项目 × 对话」的浏览器目录(宿主给的,不来自工具参数);用户数据目录是它下面的 `profile/`
 * @param {string} o.executablePath 浏览器可执行文件(部署者配置)
 * @param {'new' | 'shell'} [o.headless] 无头的哪一种;缺省按文件名判(chrome-headless-shell → `shell`)
 * @param {object} o.gate 出网闸(`createEgressGate` 的返回)
 * @param {object} o.limits `HOSTED_BROWSER_DEFAULTS` 合并后的上限
 * @param {string[]} [o.argPrefix] 启动参数打头的(缺省 `HOSTED_BROWSER_ARG_PREFIX`)
 * @param {string[]} [o.extraArgs] 部署者追加的启动参数(沙箱等;会过滤掉改代理、开调试口的)
 * @param {object} [o.puppeteer] 测试可换(要有 `defaultArgs` 与 `connect`)
 * @param {typeof spawnTree} [o.spawnBrowser] 起浏览器进程的函数,测试可换
 * @param {(event: string, fields?: object) => void} [o.log]
 */
export async function launchHostedSession({ sessionDir, executablePath, headless, gate, limits, argPrefix = HOSTED_BROWSER_ARG_PREFIX, extraArgs = [], puppeteer, spawnBrowser = spawnTree, log = () => {}, now = () => Date.now() }) {
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响 */ } };
  if (typeof executablePath !== 'string' || !executablePath) throw new HostedSessionError('browser-missing', '这台节点没有配置浏览器');
  try { if (!fs.statSync(executablePath).isFile()) throw new Error('not a file'); } catch { throw new HostedSessionError('browser-missing', '这台节点没有配置浏览器'); }
  const userDataDir = path.join(sessionDir, 'profile');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(path.join(sessionDir, '.tmp'), { recursive: true });

  // 上一个进程留下的浏览器还占着这份目录:先清掉;清不掉就不起(两个浏览器不能共用一份目录)
  const orphan = await reapOrphan(sessionDir);
  if (orphan.found) say('agent.web.orphan-reaped', { killed: orphan.killed.length, stillHeld: orphan.stillHeld });
  if (orphan.stillHeld) throw new HostedSessionError('profile-busy', '这个对话的浏览器目录被一个残留的浏览器进程占着,这次没有打开。');

  const mode = headless ?? (/headless[-_]shell/i.test(path.basename(executablePath)) ? 'shell' : 'new');
  const proxy = await startBrowserProxy({ gate, maxTunnels: limits.maxTunnels, log });
  const extra = filterExtraArgs(extraArgs);
  if (extra.dropped.length) say('agent.web.extra-args-dropped', { count: extra.dropped.length });
  // 打头的参数与部署者追加的参数过同一道过滤
  const prefix = filterExtraArgs(argPrefix);
  if (prefix.dropped.length) say('agent.web.extra-args-dropped', { count: prefix.dropped.length });
  let args = [];
  const ownArgs = [
    ...hostedNetworkArgs(proxy.url),
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    `--disk-cache-size=${limits.diskCacheBytes}`,
    `--media-cache-size=${limits.diskCacheBytes}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--disable-extensions',
    '--disable-breakpad',
    '--deny-permission-prompts',
    '--hide-crash-restore-bubble',
    '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,InterestFeedContentSuggestions',
    ...extra.args,
  ];

  // 浏览器由本文件自己起(`runner.mjs` 的 `spawnTree`:不弹窗口、不经 shell;非 Windows 上是新进程组的组长,
  // 它起的 zygote、渲染、GPU、网络进程都在这个组里,按组杀、按组核),puppeteer 只负责经管道说调试协议。
  let browser;
  let proc;
  let transport = null;
  try {
    const pptr = puppeteer ?? (await import('puppeteer')).default;
    const base = await pptr.defaultArgs({ headless: mode === 'shell' ? 'shell' : true, userDataDir, args: ownArgs });
    args = [...prefix.args, ...base, '--remote-debugging-pipe'];
    proc = spawnBrowser(executablePath, args, { cwd: sessionDir, env: childEnv(sessionDir), stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    const started = whenClosed(proc);
    if (!proc.pid || !proc.stdio?.[3] || !proc.stdio?.[4]) throw new Error('browser did not start');
    transport = new PipeTransport(proc.stdio[3], proc.stdio[4]);
    browser = await withDeadline(Promise.race([
      pptr.connect({ transport, defaultViewport: { ...VIEWPORT } }),
      started.then(() => { throw new Error('browser exited during launch'); }),
    ]), limits.launchMs, '起浏览器');
  } catch (err) {
    if (proc?.pid) { killTree(proc); await Promise.race([whenClosed(proc), sleep(limits.closeMs)]); }
    try { transport?.close(); } catch { /* 已经关了 */ }
    await proxy.close();
    say('agent.web.launch-failed', { message: String(err?.message ?? err).slice(0, 160) });
    throw new HostedSessionError('launch-failed', '云端的浏览器没能启动。请告诉用户联系托管方查看节点。');
  }

  const browserPid = proc.pid;
  /** 浏览器进程树**此刻**的进程号(每次动作后刷新成最新的一份;不攒旧的——退掉的渲染进程的号可能已被系统分给别的进程) */
  let pids = new Set([browserPid]);
  /** 进程表里列不出来的帮手子进程(见 `childPidsOf`,只有 Windows 上要记);随浏览器一起活,起来时记一次 */
  const helpers = new Set();
  let exited = false;
  /** 主进程 `exit` 与 `close`(管道也都关了)都到了 */
  const gone = whenClosed(proc).then(() => { exited = true; });
  const processGone = () => gone;
  /**
   * 杀整棵树。
   * 非 Windows:`killTree` 按进程组杀(组长先退了、组里还有进程时照样按组杀)。
   * Windows:没有进程组。先按最近一份进程表、加帮手进程,逐个直接结束(立刻生效),再用 `killTree`(taskkill 按父子关系)兜住表里没有的——
   * 只靠 taskkill 不行:机器忙时它查进程树要好几秒,而且主进程一没它就找不到树了。
   */
  const killAll = () => {
    if (process.platform === 'win32') {
      for (const pid of new Set([...pids, ...helpers])) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经退了 */ } }
    }
    killTree(proc);
    return true;
  };

  const state = {
    rev: readRev(sessionDir), // 清单版本(接着这个对话上一个浏览器的往下编)
    viewEpoch: -1,          // 出这版清单时的页面代数
    epoch: 0,               // 页面代数:主框架每跳转一次加一
    marks: new Map(),       // 编号 → 指纹
    opened: false,          // 打开过网页没有
    hasView: false,         // 这个浏览器出过清单没有
    blocked: [],            // 这次动作里被拦下的东西(下载、协议、新标签页、对话框)
    lastNavRequestAt: 0,
    lastNavEndedAt: 0,      // 主框架的跳转请求收完或失败的时刻(收完了却没换页 = 下载、204 之类)
    closed: false,
    closing: null,
    lastUsedAt: now(),
    busy: 0,
  };
  const noteBlocked = (item) => { if (state.blocked.length < 20) state.blocked.push(item); };

  let page;
  let cdp;
  try {
    cdp = await browser.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    cdp.on('Browser.downloadWillBegin', (event) => {
      noteBlocked({ kind: 'download', name: String(event?.suggestedFilename ?? '').slice(0, 80) });
      say('agent.web.download-denied', {});
    });
    page = (await browser.pages())[0] ?? await browser.newPage();
    await page.setViewport({ ...VIEWPORT });
    page.setDefaultTimeout(limits.actionMs);
    page.setDefaultNavigationTimeout(limits.navigationMs);
    await page.evaluateOnNewDocument(keepInOneTab);
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      let url = '';
      try { url = request.url(); } catch { /* 请求已经没了 */ }
      const allowed = pageRequestAllowed(url);
      try {
        if (!allowed) {
          noteBlocked({ kind: 'protocol', scheme: (/^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1] ?? '').toLowerCase() });
          say('agent.web.scheme-blocked', {});
          void request.abort('blockedbyclient').catch(() => {});
          return;
        }
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) state.lastNavRequestAt = now();
        void request.continue().catch(() => {});
      } catch { /* 拦截句柄失效(页面跳走了):不用管 */ }
    });
    const navEnded = (request) => {
      try {
        if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
        state.lastNavEndedAt = now();
        // 主框架的跳转被代理拒了:明文的回 403 并带原因码;https 的是隧道建不起来
        const code = request.response()?.headers()?.['x-egress-refused'];
        if (code) noteBlocked({ kind: 'egress', code: String(code).slice(0, 40) });
        else if (/ERR_TUNNEL_CONNECTION_FAILED/.test(String(request.failure()?.errorText ?? ''))) noteBlocked({ kind: 'egress', code: 'refused' });
      } catch { /* 请求已经没了 */ }
    };
    page.on('requestfinished', navEnded);
    page.on('requestfailed', navEnded);
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) state.epoch += 1; });
    page.on('dialog', (dialog) => {
      noteBlocked({ kind: 'dialog', type: dialog.type(), text: String(dialog.message() ?? '').slice(0, 120) });
      void dialog.dismiss().catch(() => {});
    });
    // 兜底:页面还是开出了别的标签页(绕过了 keepInOneTab)就关掉它
    browser.on('targetcreated', (target) => {
      if (target.type() !== 'page') return;
      void (async () => {
        try {
          const other = await target.page();
          if (other && other !== page) { noteBlocked({ kind: 'popup' }); await other.close({ runBeforeUnload: false }); }
        } catch { /* 已经关了 */ }
      })();
    });
    browser.on('disconnected', () => { state.closed = true; });
  } catch (err) {
    killAll();
    await Promise.race([processGone(), sleep(limits.closeMs)]);
    await proxy.close();
    say('agent.web.launch-failed', { message: String(err?.message ?? err).slice(0, 160) });
    throw new HostedSessionError('launch-failed', '云端的浏览器没能启动。请告诉用户联系托管方查看节点。');
  }

  /** 刷新进程树的进程号(渲染进程会随跳转换) */
  async function refreshPids() {
    if (state.closed) return [...pids];
    try {
      const info = await withDeadline(cdp.send('SystemInfo.getProcessInfo'), 2_000, '取进程表');
      const current = new Set(browserPid ? [browserPid] : []);
      for (const p of info?.processInfo ?? []) if (Number.isSafeInteger(p?.id) && p.id > 0) current.add(p.id);
      pids = current;
      fs.writeFileSync(path.join(sessionDir, OWNER_FILE), JSON.stringify({ servicePid: process.pid, browserPid, pids: [...pids], at: now() }));
    } catch { /* 取不到就用已有的 */ }
    return [...pids];
  }
  await refreshPids();
  // 后台问一次系统:主进程的后代进程里,进程表没列出来的就是帮手进程
  const helpersKnown = (async () => {
    if (process.platform !== 'win32' || !browserPid) return;
    const before = new Set(pids);
    const children = await childPidsOf(browserPid);
    if (state.closed && !children.length) return;
    await refreshPids();
    for (const pid of children) if (!before.has(pid) && !pids.has(pid) && pidAlive(pid)) helpers.add(pid);
  })().catch(() => {});
  say('agent.web.launched', { mode, processes: pids.size });

  /* ---------------------------------------------------------------- 串行与收尾 */

  let queue = Promise.resolve();
  /** 一个对话的浏览器只有一个页,动作串行;整个动作有时限 */
  function enqueue(job, what) {
    const run = async () => {
      if (state.closed) throw new HostedSessionError('closed', '浏览器已经关了。');
      state.busy += 1;
      // 超时以后这个动作不许再碰页面:它后面每次动手之前都要过 check()
      const token = { dead: false };
      const check = (guard) => {
        if (token.dead) throw new HostedSessionError('timeout', `${what} 已经超时,后面的步骤没有做`);
        if (state.closed) throw new HostedSessionError('closed', '浏览器已经关了。');
        guard?.();
      };
      try { return await withDeadline(job(check), limits.actionMs, what); }
      catch (err) {
        token.dead = true;
        // 动作半路断了:页面处在什么状态说不准,这一版清单作废
        state.viewEpoch = -1;
        throw err;
      }
      finally { state.busy -= 1; state.lastUsedAt = now(); }
    };
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  /** 每个动作收尾:出新的一版清单 */
  async function finish(extra = {}) {
    state.rev += 1;
    // 先记下版本再把清单交出去:模型见过的版本号一定已经落盘,下一个浏览器不会重用它
    try { fs.writeFileSync(path.join(sessionDir, REV_FILE), String(state.rev)); } catch { /* 写不了:本次浏览器里仍然不重复 */ }
    state.hasView = true;
    const epochBefore = state.epoch;
    const { result, marks } = await captureHostedView(page, state.rev);
    state.marks = marks;
    // 截图期间页面又跳了:这版清单已经过期,记成对不上,动作时会被拒
    state.viewEpoch = epochBefore === state.epoch ? state.epoch : -1;
    void refreshPids();
    const out = { ...result, ...extra, ok: true };
    if (state.blocked.length) {
      // 自上一版清单以来被拦下的东西(含两次动作之间页面自己干的);交出去就清掉
      out.blocked = state.blocked.splice(0);
      out.blockedNote = '这一步里有东西被云端拦下了:'
        + [...new Set(out.blocked.map((b) => ({ download: '下载(云端的浏览器不下载文件)', protocol: '非 http(s) 的地址', popup: '新开的标签页', dialog: '页面弹出的对话框(已自动关掉)', egress: '页面要跳去的地址被出网限制拒绝(云节点本机、内网等不许访问)' })[b.kind] ?? b.kind))].join('、') + '。';
    }
    return out;
  }

  /** 输入之后:页面要是开始跳转了,等它落地 */
  async function settle(sinceEpoch, inputAt) {
    await sleep(350);
    if (state.lastNavRequestAt >= inputAt && state.epoch === sinceEpoch) {
      const end = now() + limits.settleMs;
      while (state.epoch === sinceEpoch && now() < end && !state.closed) {
        // 请求已经收完(或失败)却没有换页:是下载、204 这类不换页的回应,不用再等
        if (state.lastNavEndedAt >= state.lastNavRequestAt) { await sleep(250); break; }
        await sleep(60);
      }
    }
    await sleep(150);
  }

  /** 编号能不能用(版本、页面代数、指纹在不在);不能就回原因 */
  function checkUid(u) {
    const parsed = parseUid(u);
    if (!parsed) return { reason: 'format' };
    if (!state.hasView) return { reason: parsed.rev <= state.rev ? 'old_rev' : 'no_view' };
    if (parsed.rev !== state.rev) return { reason: 'old_rev' };
    if (state.viewEpoch !== state.epoch) return { reason: 'navigated' };
    const mark = state.marks.get(u);
    if (!mark) return { reason: 'gone' };
    return { mark };
  }

  const stale = (reason, detail = {}) => ({ ok: false, stale: true, reason, error: explainStale(reason, detail) });

  /* ---------------------------------------------------------------- 动作 */

  /**
   * 打开一条链接。地址先在本进程过一遍出网闸(不许的当场拒,浏览器都不碰),浏览器发出去的每个请求再各自过代理。
   * @param {string} input 模型给的地址
   * @param {{ guard?: () => void }} [o] 真正动页面之前再调一次的闸(这一轮被收回就抛)
   */
  const open = (input, { guard } = {}) => enqueue(async (check) => {
    const admitted = await admitWebTarget(gate, input);
    if (!admitted.ok) return admitted.result;
    const target = admitted.target;
    check(guard);
    const mark = proxy.seq;
    const blockedBefore = state.blocked.length;
    let response = null;
    let failure = null;
    try {
      response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: limits.navigationMs });
    } catch (err) { failure = err; }
    state.opened = true;
    const refused = proxy.refusedSince(mark);
    const landed = page.url();
    // 落在了非 http(s) 的地址上(正常到不了这里:入口与请求拦截都挡过):退回空白页
    if (!isWebUrl(landed) && landed !== 'about:blank' && !landed.startsWith('chrome-error://')) {
      try { await page.goto('about:blank', { timeout: 5_000 }); } catch { /* 退不回去也照实报 */ }
      return { ok: false, error: '没有打开:云端 Agent 的浏览器只打开 http / https 地址。', refused: 'protocol' };
    }
    // 被出网闸拒了:明文的(含跳转到的那一跳)最后一个回应带着原因码;https 的是隧道建不起来,原因码在代理的记录里。
    // 代理记录里别的拒绝(浏览器自己的后台请求)不算数:只认「隧道失败」这一种失败。
    const proxyRefusedMain = response?.headers?.()['x-egress-refused'];
    const tunnelRefused = failure && /ERR_TUNNEL_CONNECTION_FAILED/.test(String(failure?.message ?? '')) && refused.filter((e) => e.kind === 'connect').pop();
    if (proxyRefusedMain || tunnelRefused) {
      const code = proxyRefusedMain ?? tunnelRefused.code;
      // 这次拒绝已经在这里说了,不用再在下一版清单里提一遍
      state.blocked.splice(blockedBefore);
      return { ok: false, error: `没有打开:这个地址(或它跳转到的地址)被拒绝了。${egressRefusalText(code)}`, egress: code };
    }
    // 下载被拒时浏览器报的是「跳转中止」,「这是个下载」的事件晚一拍才到
    if (failure && /ERR_ABORTED/.test(String(failure?.message ?? '')) && !state.blocked.some((b) => b.kind === 'download')) await sleep(400);
    if (failure && state.blocked.some((b) => b.kind === 'download')) {
      state.blocked.splice(blockedBefore);
      return { ok: false, refused: 'download', error: '没有打开:这个地址是一个文件下载,云端 Agent 的浏览器不下载文件。要把网上的素材放进项目,用素材采集或按地址导入素材的工具。' };
    }
    if (failure) {
      if (failure instanceof HostedSessionError) throw failure;
      const text = String(failure?.message ?? failure);
      const timedOut = /timeout|timed out/i.test(text);
      return { ok: false, error: timedOut ? `这个页面 ${Math.round(limits.navigationMs / 1000)} 秒没有加载出来,没有打开。` : `没有打开:${text.replace(/\s+at\s+https?:\S+/i, '').slice(0, 160)}` };
    }
    return finish({ navigated: target });
  }, '打开网页');

  const view = () => enqueue(async () => {
    if (!state.opened) return { ok: false, error: '浏览器里还没有打开网页。先用 web_open 打开一条链接。' };
    return finish();
  }, '截图');

  /**
   * 点击。`u` 是带版本的编号;或 `x,y` 是最近那张图上的坐标(强烈建议带 `expect`)。
   * 点之前核对编号还指着清单里那个元素、点下去不会落到别的元素上。
   */
  const click = ({ u, x, y, expect } = {}, { guard } = {}) => enqueue(async (check) => {
    if (!state.opened) return { ok: false, error: '浏览器里还没有打开网页。先用 web_open 打开一条链接。' };
    let uid = typeof u === 'string' && u ? u : null;
    let positional = false;
    if (!uid) {
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, error: '要么给 u,要么给 x,y。x,y 是上一次 web_view 返回的那张图上的像素坐标。' };
      }
      if (!state.hasView) return stale('no_view');
      if (state.viewEpoch !== state.epoch) return stale('navigated', { u: '图上的坐标' });
      const res = await resolveAt(page, x, y, { expect: typeof expect === 'string' && expect ? expect : null });
      if (!res.ok) return { ok: false, error: explain(res), ...(res.cands ? { candidates: res.cands } : {}) };
      uid = res.pick.u;
      positional = true;
    }
    const checked = checkUid(uid);
    if (checked.reason) return stale(checked.reason, { u: uid });
    const spot = await locate(page, uid, checked.mark, { positional });
    if (!spot.ok) return stale(spot.reason, { u: uid, by: spot.by });
    check(guard);
    const epoch = state.epoch;
    const at = now();
    await page.mouse.click(spot.x, spot.y);
    await settle(epoch, at);
    return finish({ clicked: { u: uid, n: spot.label } });
  }, '点击');

  /** 往输入框里打字。口令、验证码、卡号这类字段不填 */
  const type = ({ u, text, append = false, submit = false } = {}, { guard } = {}) => enqueue(async (check) => {
    if (!state.opened) return { ok: false, error: '浏览器里还没有打开网页。先用 web_open 打开一条链接。' };
    if (typeof u !== 'string' || !u) return { ok: false, error: '要给 u:clickable 清单里那个输入框的编号。' };
    const value = String(text ?? '');
    if (value.length > limits.maxTypeChars) return { ok: false, error: `一次最多输入 ${limits.maxTypeChars} 个字。` };
    const checked = checkUid(u);
    if (checked.reason) return stale(checked.reason, { u });
    const spot = await locate(page, u, checked.mark);
    if (!spot.ok) return stale(spot.reason, { u, by: spot.by });
    if (spot.secret) return { ok: false, refused: 'credentials', error: explainSecret(spot.secret) };
    if (!spot.editable) return { ok: false, error: `${u} 不是能打字的输入框(是 <${spot.tag}>)。` };
    if (spot.disabled) return { ok: false, error: `${u} 这个输入框现在不能改(禁用或只读)。` };
    check(guard);
    await page.mouse.click(spot.x, spot.y);
    // 焦点没落在这个输入框上就不打:字不能进了别处
    if (!await focusElement(page, u)) return stale('covered', { u });
    // 点了之后它要是变成了口令框(有的站点聚焦时才换类型),同样不填
    const again = await locate(page, u, checked.mark);
    if (again.ok && again.secret) return { ok: false, refused: 'credentials', error: explainSecret(again.secret) };
    check(guard);
    if (!append) await clearElement(page, u);
    await page.keyboard.type(value, { delay: limits.typeDelayMs });
    if (submit) {
      check(guard);
      const epoch = state.epoch;
      const at = now();
      await page.keyboard.press('Enter');
      await settle(epoch, at);
    }
    return finish({ typed: { u, submit: submit === true } });
  }, '输入');

  const scroll = ({ dy, to } = {}, { guard } = {}) => enqueue(async (check) => {
    if (!state.opened) return { ok: false, error: '浏览器里还没有打开网页。先用 web_open 打开一条链接。' };
    const args = {};
    if (to === 'top' || to === 'bottom') args.to = to;
    else if (to !== undefined && to !== null) return { ok: false, error: 'to 只能是 "top" 或 "bottom"。' };
    if (dy !== undefined && dy !== null) {
      if (typeof dy !== 'number' || !Number.isFinite(dy)) return { ok: false, error: 'dy 要是一个数(页面像素,正数往下)。' };
      args.dy = Math.max(-limits.maxScrollPx, Math.min(limits.maxScrollPx, dy));
    }
    check(guard);
    // 与桌面版 scroll() 同样的滚法(缺省 600、滚完等半秒让懒加载填上);不直接调它是因为它自己还要截一次图
    const amount = args.dy ?? 600;
    await page.evaluate((dy, where) => {
      if (where === 'top') scrollTo({ top: 0 });
      else if (where === 'bottom') scrollTo({ top: document.body.scrollHeight });
      else scrollBy({ top: dy });
    }, amount, args.to ?? null);
    await sleep(500);
    return finish({ scrolled: args.to || amount });
  }, '滚动');

  /** 读正文,不返图 */
  const read = ({ limit } = {}) => enqueue(async () => {
    if (!state.opened) return { ok: false, error: '浏览器里还没有打开网页。先用 web_open 打开一条链接。' };
    let n = 8000;
    if (limit !== undefined && limit !== null) {
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) return { ok: false, error: 'limit 要是一个正数。' };
      n = Math.min(Math.floor(limit), limits.maxReadChars);
    }
    const out = await desktopRead(page, { limit: n });
    return { ...out, dataNotice: PAGE_DATA_NOTICE };
  }, '读正文');

  /* ---------------------------------------------------------------- 关闭 */

  /**
   * 关掉这个会话:浏览器整棵进程树退出、代理关掉;`removeProfile` 时连用户数据目录一起删。
   * 回的是证据,不是「已发出关闭」:`exited` 为真当且仅当主进程的退出与管道关闭都到了、记下的每个进程号都不再活着、
   * (非 Windows)浏览器那个进程组里也没有活着的进程了。
   *
   * @param {{ graceful?: boolean, removeProfile?: boolean, removeAll?: boolean, reason?: string }} [o]
   *   `graceful`:先让浏览器自己退(把 cookie 落盘);被收回授权时不给这个机会,直接杀。
   *   `removeProfile`:删用户数据目录(留下清单版本的计数);`removeAll`:整个目录都删(对话、项目没了)
   */
  function close({ graceful = true, removeProfile = false, removeAll = false, reason = 'close' } = {}) {
    const wipe = () => removeSessionData(sessionDir, { keepRev: !removeAll, timeoutMs: limits.closeMs });
    if (state.closing) {
      // 已经在关:后来的调用只多做「删目录」这一件
      return state.closing.then(async (first) => {
        if (!(removeProfile || removeAll)) return first;
        return { ...first, profileRemoved: await wipe() };
      });
    }
    state.closing = (async () => {
      // 帮手进程的名单要是还在问(刚起来就关),等它一下;问不出来就按已知的办
      await Promise.race([helpersKnown, sleep(limits.closeMs)]);
      const known = [...new Set([...await refreshPids(), ...helpers])];
      state.closed = true;
      if (graceful && browser.connected !== false) {
        // 请它自己退,并等它真的退(退之前它把 cookie 落盘);到时限还不退就杀
        try { await withDeadline(browser.close(), limits.gracefulCloseMs, '关浏览器'); } catch { /* 不肯退就杀 */ }
        await Promise.race([processGone(), sleep(limits.gracefulCloseMs)]);
      }
      // 不管它自己退没退,记下的每个进程都直接结束一遍:主进程自己退了以后,子进程在忙的机器上要拖好几秒才跟着退
      killAll();
      const quick = await Promise.race([processGone().then(() => true), sleep(1_500).then(() => false)]);
      if (!quick && process.platform === 'win32') {
        // 还有谁握着管道没退:多半是起来时没问到的帮手进程。主进程没了也照样能按父子关系把它的后代问出来,问到就结束
        for (const pid of await childPidsOf(browserPid, { timeoutMs: limits.closeMs })) {
          if (!pidAlive(pid)) continue;
          helpers.add(pid);
          known.push(pid);
          try { process.kill(pid, 'SIGKILL'); } catch { /* 已经退了 */ }
        }
      }
      await Promise.race([processGone(), sleep(limits.closeMs)]);
      // 主进程退了以后子进程可能还要一瞬;逐个核,还在的直接杀
      let alive = await waitPidsGone(known, 1_500);
      for (const pid of alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经退了 */ } }
      if (alive.length) alive = await waitPidsGone(alive, limits.closeMs);
      // 非 Windows:看浏览器那个进程组空了没有(进程表里列不出来的 zygote 之类也在组里;僵尸不算)。
      // 组里还有活的(主进程退出时那一次按组清扫之后又冒出来的):组还有成员,组号就不会被别人用掉,可以再按组杀
      let groupLive = browserGroupLive(browserPid);
      const groupEnd = Date.now() + limits.closeMs;
      while (groupLive === true && Date.now() < groupEnd) {
        try { process.kill(-browserPid, 'SIGKILL'); } catch { /* 组里没有进程了 */ }
        await sleep(100);
        groupLive = browserGroupLive(browserPid);
      }
      try { browser.disconnect(); } catch { /* 已经断了 */ }
      try { transport.close(); } catch { /* 已经关了 */ }
      const proxyClosed = await proxy.close();
      let profileRemoved = false;
      let profileBytes = null;
      if (removeProfile || removeAll) profileRemoved = await wipe();
      else {
        try { fs.rmSync(path.join(sessionDir, OWNER_FILE), { force: true }); } catch { /* 删不掉不影响 */ }
        // 用户数据目录超过上限:整个删掉(登录态也没了),免得一个对话把磁盘占满
        profileBytes = dirBytes(userDataDir);
        if (profileBytes > limits.maxProfileBytes) {
          profileRemoved = await removeSessionData(sessionDir, { keepRev: true, timeoutMs: limits.closeMs });
          say('agent.web.profile-over-limit', { bytes: profileBytes });
        }
      }
      const exitedAll = alive.length === 0 && exited && groupLive !== true;
      say('agent.web.closed', { reason, exited: exitedAll, processes: known.length, profileRemoved });
      return { exited: exitedAll, pids: known, alivePids: alive, groupLive, proxyClosed: proxyClosed.closed, profileRemoved, profileBytes };
    })();
    return state.closing;
  }

  return {
    sessionDir,
    userDataDir,
    mode,
    args,
    browserPid,
    /** 杀整棵进程树(同步发出;真退了没有看 `processGone` 与 `close()` 的回执) */
    kill: killAll,
    proxy,
    /** 整棵进程树此刻的进程号(进程表里的,加帮手进程) */
    pids: () => [...new Set([...pids, ...helpers])],
    /** 帮手进程的名单问完了没有(测试等它) */
    helpersKnown,
    refreshPids,
    get rev() { return state.rev; },
    get opened() { return state.opened; },
    get closed() { return state.closed; },
    get busy() { return state.busy > 0; },
    get lastUsedAt() { return state.lastUsedAt; },
    /** 进程是不是已经真的退了(exit + close 都到) */
    get processExited() { return exited; },
    processGone,
    open, view, click, type, scroll, read, close,
  };
}
