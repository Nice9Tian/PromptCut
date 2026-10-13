/**
 * root 入口：节点上以 root 身份跑的那一个进程。它开任务进程、关任务进程、写「这一代确实关干净了」的记录；
 * 账号版云端 Agent 的每条任务都在它开的进程里跑（一条任务一个进程）。
 *
 * 它做的事：
 *   1. 读一份 root 所有的配置（形状见 `account-root-slots.mjs` 的 `validateRootConfiguration`）；
 *   2. 照配置里的每个槽建适配：发布器的 Linux 运行时（`createAgentScopeRuntime`：systemd 单元、cgroup、root 所有的记录文件）、
 *      到任务进程的指令通道（本机 HTTPS，`account-worker-control-client.mjs`）、每开一代之前给它写设置文件；
 *   3. 起槽调度（`account-slot-scheduler.mjs`）。调度要问的「哪些对话在排队、哪些任务要强制关」「这一条的强制终态」
 *      经 Agent 主服务的内部口去问（`account-master-scheduler-client.mjs`）：主身份、事件库、收事件的口都在主服务那个进程里
 *      （`main.mjs`，它不必是 root），这里只拿 root 那张证书去问。
 *
 * 跑：
 *   node server/agent-service/account-root-main.mjs --config /etc/promptcut/agent-root.json
 *       常驻：起来以后一直在（槽都空着、主服务连不上时也在），只有收到信号才退。
 *       SIGTERM / SIGINT：只停调度，不关任何任务进程（关进程只凭文档服务的终态做），退出码 0。
 *       下次起来时，上一个 root 进程留下的一代在这里没有通道：它的主进程会被停下、写失败观察，
 *       由文档服务签「进程故障」的强制终态后关掉（那条任务记「失败」）。所以部署重启它之前最好先等槽空。
 *   node server/agent-service/account-root-main.mjs --config <同一份> --bootstrap
 *       部署时跑一次：把还没初始化的槽初始化（开第一代、随即退掉），逐槽打印锚点摘要。摘要要配进这份配置
 *       （各槽 `publisher.configuredAnchorDigest`）和文档服务的任务槽配置，之后才常驻得起来。跑它的时候常驻的那个要停着。
 *   node server/agent-service/account-root-main.mjs --config <同一份> --status
 *       只读：逐槽打印现在停在第几代、什么阶段、单元的状态。
 *
 * 只在 Linux 上、以 root 跑；别的平台、别的用户直接拒绝（退出码 1，一行 `config.error`）。
 * 它执行的这份代码（入口所在的整棵 `server/`、路径上的每一级目录、node 本身）必须属主是 root、别人写不了，
 * 启动时自己核，不满足就拒绝（`root-code-untrusted`，带上是哪个路径）：部署目录归别的用户的话，那个用户改一个文件就是 root。
 * 失败即关：配置读不了、形状不对、哪个槽的运行时建不起来，都打一行 `config.error { reason }` 退出，不带着半套槽跑。
 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { rootRead, rootDirectory, procInfo, systemUnitV2 } from '../hosted/deploy/asset-root-registry-publisher.mjs';
import { publishAgentScope, createAgentScopeRuntime } from '../hosted/deploy/agent-run-scope-publisher.mjs';
import { createAccountSlotScheduler } from './account-slot-scheduler.mjs';
import { createWorkerControlClient } from './account-worker-control-client.mjs';
import { createMasterSchedulerClient } from './account-master-scheduler-client.mjs';
import { validateRootConfiguration, workerSettingsFor, createRootSlotAdapter } from './account-root-slots.mjs';
import { assertRootOwnedCode } from './account-root-code-trust.mjs';
import { validateWorkerSettings } from './account-task-worker-config.mjs';

const line = (event, fields = {}) => { process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`); };
const safe = error => typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(error.code) ? error.code : 'unavailable';

/** 命令行参数：`--config <绝对路径> [--bootstrap | --status]`。不认识的一律拒。 */
export function parseRootArguments(argv) {
  if (!Array.isArray(argv) || argv.length < 2 || argv.length > 3 || argv[0] !== '--config' || typeof argv[1] !== 'string' ||
      !path.posix.isAbsolute(argv[1]) || path.posix.normalize(argv[1]) !== argv[1] ||
      (argv.length === 3 && !['--bootstrap', '--status'].includes(argv[2])))
    throw Object.assign(new Error('root-arguments'), { code: 'root-arguments' });
  return { configFile: argv[1], mode: argv.length === 3 ? argv[2].slice(2) : 'run' };
}

/** 不是 Linux、或者不是 root：拒。单独导出给测试核这一条（它不碰任何系统调用）。 */
export function requireLinuxRoot({ platform = process.platform, uid = process.getuid?.(), euid = process.geteuid?.() } = {}) {
  if (platform !== 'linux' || uid !== 0 || euid !== 0) throw Object.assign(new Error('root-linux-root-required'), { code: 'root-linux-root-required' });
}

/** 等回环上某个端口开始接受连接（只连一下就断，不发任何字节）。等到了回 true，到时限回 false。 */
export async function waitForLoopbackListener(port, timeoutMs, { everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const done = value => { socket.removeAllListeners(); socket.on('error', () => {}); socket.destroy(); resolve(value); };
      socket.once('connect', () => done(true)); socket.once('error', () => done(false));
      socket.setTimeout(1000, () => done(false));
    });
    if (open) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, everyMs));
  }
}

const systemctl = args => new Promise((resolve, reject) => execFile('/usr/bin/systemctl', args,
  { windowsHide: true, timeout: 30_000, maxBuffer: 65536, encoding: 'utf8' }, error => error ? reject(Object.assign(new Error('root-systemctl-failed'), { code: 'root-systemctl-failed' })) : resolve()));

/** 把设置写到固定位置：同目录下先写临时文件、落盘、再改名。目录和它的每一级上级都要是 root 的、别人写不了。 */
async function writeSettings(file, value) {
  const dir = path.dirname(file);
  await rootDirectory(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`), fd = await fs.open(tmp, 'wx', 0o644);
  // 里面没有任何密钥（只有路径、端口、公开的指纹和 root 的两份记录）；任务进程的用户要读得到
  try { await fd.chmod(0o644); await fd.writeFile(JSON.stringify(value)); await fd.sync(); } finally { await fd.close(); }
  await fs.rename(tmp, file);
  const handle = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** 照配置建各槽。只在 Linux root 上调得通（`createAgentScopeRuntime` 自己也核）。 */
export async function buildSlots(config, controllerTls) {
  const slots = [];
  for (const slot of config.slots) {
    const expected = slot.publisher.expected, io = await createAgentScopeRuntime(slot.publisher);
    // 每开一代之前：先把这一代的设置写好，再起单元。单元里的 PROMPTCUT_AGENT_WORKER_SETTINGS 指向这个固定位置。
    const start = io.start;
    // 起了单元以后先等任务进程真的开始监听它的身份口，再把控制权交回发布器。发布器自己核「监听口归这一代主进程」时只重试几秒，
    // 节点忙时任务进程起得慢一点就会被它判成失败——而它失败以后故意留着锁，这个槽要人处理才能再用。这里只是多等，
    // 等不到（30 秒）照旧交回去让发布器按它的规矩判；发布器核的东西一样都没少。
    const identityPort = Number(new URL(slot.publisher.identity.origin).port);
    io.start = async reservation => {
      await writeSettings(slot.workerSettingsFile, validateWorkerSettings(workerSettingsFor({ config, slot, reservation })));
      const result = await start(reservation);
      if (!await waitForLoopbackListener(identityPort, 30_000)) line('root.slot.listener.slow', { slotId: expected.slotId, epoch: reservation.epoch });
      return result;
    };
    const sameMain = async record => {
      const unit = await systemUnitV2(expected.unit);
      if (Number(unit.MainPID) !== record.instance.pid || unit.InvocationID !== record.instance.unitInvocationId) return false;
      try { return (await procInfo(record.instance.pid)).startTicks === record.instance.pidBirth.startTicks; }
      catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
    };
    const adapter = createRootSlotAdapter({ expected, io, publish: publishAgentScope,
      anchorDigest: () => slot.publisher.configuredAnchorDigest,
      connect: record => createWorkerControlClient({ origin: slot.publisher.identity.origin, tls: controllerTls, serverFingerprint256: expected.serverFingerprint256,
        scope: { slotId: expected.slotId, epoch: record.epoch, instanceId: record.instance.instanceId } }),
      host: { alive: sameMain,
        // 只动这个槽的单元的主进程（不按进程号发信号）；整组进程由发布器停单元、看 cgroup 空了来关
        async stop(record) { if (await sameMain(record)) await systemctl(['kill', '--kill-who=main', '--signal=SIGKILL', expected.unit]); } },
      log: line });
    slots.push({ adapter, expected, slot });
  }
  return slots;
}

export async function runRoot({ configFile, mode }) {
  requireLinuxRoot();
  const config = validateRootConfiguration(await rootRead(configFile));
  const [key, cert, ca] = await Promise.all(['keyFile', 'certFile', 'caFile'].map(name => rootRead(config.controller[name], false, true)));
  const slots = await buildSlots(config, { key, cert, ca });
  if (mode === 'status') {
    for (const { adapter, expected } of slots) {
      const [current, unit] = [await adapter.current(), await systemUnitV2(expected.unit)];
      line('root.slot.status', { slotId: expected.slotId, authorityId: expected.authorityId, epoch: current?.rootScopeRef.epoch ?? null, phase: current?.phase ?? 'uninitialized',
        unit: expected.unit, activeState: unit.ActiveState, subState: unit.SubState, mainPid: Number(unit.MainPID) });
    }
    return null;
  }
  if (mode === 'bootstrap') {
    for (const { adapter } of slots) line('root.slot.bootstrap', await adapter.bootstrap());
    return null;
  }
  const missing = config.slots.filter(slot => slot.publisher.configuredAnchorDigest === null).map(slot => slot.publisher.expected.slotId);
  if (missing.length) throw Object.assign(new Error('root-slot-not-initialized'), { code: 'root-slot-not-initialized', slots: missing });
  const master = createMasterSchedulerClient({ origin: config.master.origin, tls: { key, cert, ca }, serverFingerprint256: config.master.fingerprint256 });
  return startRootResident({ adapters: slots.map(row => row.adapter), master, pollMs: config.pollMs ?? 500, masterOrigin: config.master.origin });
}

/**
 * 常驻的那一部分：起槽调度，并且**拉住这个进程**。
 * 调度两轮之间的等待、适配里看主进程的等待都是不拉住进程的定时器（它们不该妨碍别的进程收尾），问主服务用的是短连接，
 * 这个进程又没有任何监听口——槽都空着的时候，事件循环里没有一样东西能让 Node 留下来，它会在第一轮问完以后自己以退出码 0 退出。
 * 所以这里明确放一个保活，只在 `close()` 里拿掉。
 * @param {{ adapters: object[], master: { pending: Function, scopeControl: Function, close?: Function }, pollMs?: number, masterOrigin?: string | null, log?: Function }} o
 */
export async function startRootResident({ adapters, master, pollMs = 500, masterOrigin = null, log = line } = {}) {
  const scheduler = createAccountSlotScheduler({ slots: adapters, master, pollMs, log });
  // 保活：一个什么都不做、**不 unref** 的定时器。它是这个进程在槽空闲时唯一拉住事件循环的东西。
  const keepAlive = setInterval(() => {}, 60_000);
  try { await scheduler.start(); } catch (error) { clearInterval(keepAlive); throw error; }
  log('root.ready', { slots: scheduler.describe(), master: masterOrigin, pollMs });
  let closing = null;
  return { scheduler, close: () => closing ??= (async () => { try { await scheduler.stop(); master.close?.(); } finally { clearInterval(keepAlive); } })() };
}

/** 收到 SIGTERM / SIGINT：只停调度（不关任何任务进程），停完退出码 0。回这个停法本身（测试在发不了信号的平台上直接调）。 */
export function installRootStop(started, { log = line, exit = code => process.exit(code) } = {}) {
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; log('root.stopping', {});
    void started.close().then(() => exit(0), error => { log('root.close.failed', { code: safe(error) }); exit(1); }); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return stop;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const failed = (reason, extra = {}) => { const text = `${JSON.stringify({ t: new Date().toISOString(), event: 'config.error', reason, ...extra })}\n`;
    process.stdout.write(text); process.stderr.write(text); process.exitCode = 1; };
  let started = null;
  try {
    // 先核平台和身份，再看参数：在别的平台上不管怎么写参数，回答都是「只在 Linux root 上跑」
    requireLinuxRoot();
    // 再核这份要以 root 执行的代码只有 root 改得了（见 `account-root-code-trust.mjs`）；三种跑法都核
    await assertRootOwnedCode({ entryFile: path.resolve(process.argv[1]), node: process.execPath });
    started = await runRoot(parseRootArguments(process.argv.slice(2)));
  } catch (error) { failed(safe(error), { ...(error?.slots ? { slots: error.slots } : {}), ...(error?.code === 'root-code-untrusted' ? { file: error.file, why: error.why } : {}) }); }
  if (started) installRootStop(started);
}
