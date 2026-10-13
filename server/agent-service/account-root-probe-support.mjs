/**
 * 节点自检脚本（`scripts/probes/account-root-entry-linux.mjs`）里不依赖 Linux 的那一部分：参数、本次用到的全部名字、
 * 清理与「清理后还剩什么」的盘点。放在这里是因为它们要在本机的测试里验（清理必须幂等、只动自己的东西），
 * 而仓库的依赖方向只许 scripts/ 引 server/。脚本怎么跑、会碰什么，写在脚本的文件头。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const PREFIX = 'pc-claude-probe-';
export const SLICE_PREFIX = 'pcclaudeprobe';
/** 要拷到节点的路径（相对仓库根）。`git archive <提交> <这些路径>` 打出来的就是脚本要的全部。 */
export const PROBE_SOURCE_PATHS = Object.freeze(['server', 'src/kernel/agentScopes.mjs', 'src/kernel/creativity.mjs',
  'scripts/probes/account-root-entry-linux.mjs', 'scripts/probes/account-task-worker-config-linux.mjs']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const codeOf = error => (typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(error.code) ? error.code : String(error?.message ?? 'failed').replace(/[^A-Za-z0-9_.:-]+/g, '-').slice(0, 120) || 'failed');

/** `--user <名>`、`--protect a,b`、`--keep-on-failure`、`--cleanup <编号>`。不认识的一律拒。 */
export function parseProbeArguments(argv) {
  const options = { user: 'nobody', protect: [], keepOnFailure: false, cleanupId: null };
  if (!Array.isArray(argv)) fail('probe-arguments');
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i], value = argv[i + 1];
    if (name === '--keep-on-failure') options.keepOnFailure = true;
    else if (name === '--user' && typeof value === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(value) && value !== 'root') { options.user = value; i++; }
    else if (name === '--protect' && typeof value === 'string' && value.split(',').every(unit => /^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/.test(unit)) &&
      !value.split(',').some(unit => unit.startsWith(PREFIX))) { options.protect = value.split(','); i++; }
    else if (name === '--cleanup' && typeof value === 'string' && /^[a-f0-9]{8}$/.test(value)) { options.cleanupId = value; i++; }
    else fail('probe-arguments');
  }
  if (options.cleanupId && (options.keepOnFailure || options.protect.length)) fail('probe-arguments');
  return options;
}

/** 这一次要用到的全部名字与路径：都由编号推出来，清理只认这些。纯计算。 */
export function probePlan(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}$/.test(id)) fail('probe-id');
  const dir = `/run/${PREFIX}${id}`, unit = `${PREFIX}${id}-a.service`, namespace = `${SLICE_PREFIX}${id}`;
  return { id, dir, unit, namespace, slotId: 'probe-a', authorityId: `${PREFIX}${id}`,
    unitFile: `/run/systemd/system/${unit}`, dropInDir: `/run/systemd/system/${unit}.d`,
    repoDir: `${dir}/repo`, pkiDir: `${dir}/pki`, registryDir: `${dir}/registry/probe-a`, settingsFile: `${dir}/etc/probe-a/worker-settings.json`,
    dataDir: `${dir}/data`, stateRoot: `${dir}/state`, configFile: `${dir}/etc/agent-root.json`,
    /** 属于这一次的单元（任务槽单元与各代 slice）的名字 */
    owns: name => name === unit || (name.startsWith(namespace) && /^[a-z0-9]+\.slice$/.test(name)) };
}

export function requireLinuxRoot({ platform = process.platform, uid = process.getuid?.(), euid = process.geteuid?.() } = {}) {
  if (platform !== 'linux' || uid !== 0 || euid !== 0) fail('linux-root-required');
}

/** 真的系统调用。清理与盘点只经这几样，测试换成受控的。 */
export function realSystem() {
  const run = (file, args, timeout = 60_000) => new Promise(resolve => execFile(file, args, { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => resolve({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })));
  return {
    systemctl: args => run('/usr/bin/systemctl', args),
    exists: async file => { try { await fsp.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } },
    list: async dir => { try { return await fsp.readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } },
    unlink: file => fsp.unlink(file), rmdir: dir => fsp.rmdir(dir),
    removeTree: dir => fsp.rm(dir, { recursive: true, force: true }),
    readText: async file => { try { return await fsp.readFile(file, 'utf8'); } catch { return ''; } },
    kill: pid => { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } },
  };
}

/** 现在还在的、属于这一次的东西。全空才算干净。 */
export async function leftovers(plan, sys, { ports = [] } = {}) {
  const listed = await sys.systemctl(['list-units', '--all', '--plain', '--no-legend', '--no-pager', `${PREFIX}${plan.id}*`, `${plan.namespace}*`]);
  // 单元文件删掉、重读以后，systemd 有时还会把它列成「not-found inactive」直到回收：那不算剩余
  const units = listed.stdout.split('\n').map(row => row.trim().split(/\s+/)).filter(columns => columns[0] && plan.owns(columns[0]) &&
    !(columns[1] === 'not-found' && columns[2] === 'inactive')).map(columns => columns[0]);
  const unitFiles = [];
  if (await sys.exists(plan.unitFile)) unitFiles.push(plan.unitFile);
  if (await sys.exists(plan.dropInDir)) unitFiles.push(plan.dropInDir);
  const cgroups = (await sys.list('/sys/fs/cgroup')).filter(name => plan.owns(name)).map(name => `/sys/fs/cgroup/${name}`);
  const processes = [];
  for (const name of await sys.list('/proc')) {
    if (!/^[1-9][0-9]*$/.test(name) || Number(name) === process.pid) continue;
    const text = (await sys.readText(`/proc/${name}/cmdline`)).replaceAll('\0', ' ');
    if (text.includes(`${plan.dir}/`)) processes.push(Number(name));
  }
  const table = await sys.readText('/proc/net/tcp'), listeners = [];
  for (const row of table.split('\n').slice(1)) {
    const columns = row.trim().split(/\s+/), local = /^[0-9A-F]+:([0-9A-F]{4})$/i.exec(columns[1] ?? '');
    if (local && String(columns[3]).toUpperCase() === '0A' && ports.includes(parseInt(local[1], 16))) listeners.push(parseInt(local[1], 16));
  }
  return { units, unitFiles, cgroups, processes, listeners, directory: (await sys.exists(plan.dir)) ? [plan.dir] : [] };
}

/**
 * 清理。可以重复跑；哪一步出错都接着做后面的，回每一步做了什么。只动 `plan` 推出来的那些名字。
 * 次序：先停任务槽单元（整组进程随之结束），再停各代 slice，再删单元文件与 drop-in、重读单元，最后删目录。
 */
export async function cleanup(plan, sys) {
  const rows = [], note = (what, result) => rows.push(`${what}: ${result}`);
  const attempt = async (what, fn) => { try { note(what, await fn()); } catch (error) { note(what, `error ${codeOf(error)}`); } };
  const before = await leftovers(plan, sys).catch(() => ({ units: [], unitFiles: [], cgroups: [], processes: [], directory: [] }));
  if (before.units.includes(plan.unit) || before.unitFiles.includes(plan.unitFile)) {
    await attempt(`stop ${plan.unit}`, async () => (await sys.systemctl(['stop', plan.unit, '--no-ask-password'])).code === 0 ? 'stopped' : 'stop returned non-zero');
    await attempt(`reset-failed ${plan.unit}`, async () => { await sys.systemctl(['reset-failed', plan.unit]); return 'done'; });
  }
  for (const slice of new Set([...before.units.filter(name => name.endsWith('.slice')), ...before.cgroups.map(file => path.posix.basename(file))])) {
    await attempt(`stop ${slice}`, async () => (await sys.systemctl(['stop', slice, '--no-ask-password'])).code === 0 ? 'stopped' : 'stop returned non-zero');
    await attempt(`reset-failed ${slice}`, async () => { await sys.systemctl(['reset-failed', slice]); return 'done'; });
  }
  // 单元停了以后还有带着这个目录的进程（比如脚本自己起的 root 入口子进程）：按进程号结束。只认命令行里带本次目录的。
  for (const pid of before.processes) await attempt(`kill ${pid}`, async () => (sys.kill(pid) ? 'killed' : 'already gone'));
  let reload = false;
  if (await sys.exists(plan.dropInDir)) {
    for (const name of await sys.list(plan.dropInDir)) await attempt(`remove ${plan.dropInDir}/${name}`, async () => { await sys.unlink(`${plan.dropInDir}/${name}`); return 'removed'; });
    await attempt(`remove ${plan.dropInDir}`, async () => { await sys.rmdir(plan.dropInDir); return 'removed'; }); reload = true;
  }
  if (await sys.exists(plan.unitFile)) { await attempt(`remove ${plan.unitFile}`, async () => { await sys.unlink(plan.unitFile); return 'removed'; }); reload = true; }
  if (reload) await attempt('daemon-reload', async () => (await sys.systemctl(['daemon-reload'])).code === 0 ? 'done' : 'returned non-zero');
  if (await sys.exists(plan.dir)) await attempt(`remove ${plan.dir}`, async () => { await sys.removeTree(plan.dir); return 'removed'; });
  if (!rows.length) note('nothing to clean', plan.id);
  return rows;
}


/**
 * 收场：清理，然后盘点还剩什么。可以被信号打断后调、也可以在某一步超时后调。
 * 有一步没等到结果（超时、被打断）时，那一步的发布器事务可能还在后台跑、还会接着造东西（起单元、建 slice）：
 * 所以清理一遍以后先等它落定（`settle`，有时限），**再清理一遍、再盘点一遍**；盘点不干净也再来，最多三遍。
 * 不这样做，「还剩什么」那一行可能在后台事务造出东西之前就印出来了，漏报。
 * @param {object} o
 * @param {object} o.plan `probePlan` 的结果
 * @param {object} o.sys `realSystem()` 那样的一组系统调用
 * @param {(text: string) => void} o.say
 * @param {number[]} [o.ports]
 * @param {boolean} [o.keep] 不清理（--keep-on-failure），只盘点
 * @param {boolean} [o.unsettled] 有一步没等到结果
 * @param {() => Promise<void>} [o.settle] 等后台那一步落定（调用方给时限）
 * @returns {Promise<{ left: object, clean: boolean, passes: number }>}
 */
export async function finishProbe({ plan, sys, say, ports = [], keep = false, unsettled = false, settle = async () => {} }) {
  const empty = left => Object.values(left).every(list => list.length === 0);
  if (keep) {
    say(`cleanup skipped (--keep-on-failure)。之后清理：node scripts/probes/account-root-entry-linux.mjs --cleanup ${plan.id}`);
    const left = await leftovers(plan, sys, { ports });
    say(`left ${JSON.stringify(left)}`);
    return { left, clean: empty(left), passes: 0 };
  }
  let left = null, passes = 0;
  for (;;) {
    passes += 1;
    const label = passes === 1 ? 'cleanup' : `cleanup(第${passes}遍)`;
    for (const row of await cleanup(plan, sys)) say(`${label} ${row}`);
    left = await leftovers(plan, sys, { ports });
    // 第一遍之后：有没等到结果的步骤就等它落定再来一遍；没有的话，干净了就收
    if (passes === 1 && unsettled) { say('note 有一步没等到结果，等它在后台落定以后再清理、再盘点一遍'); await settle(); continue; }
    if (empty(left) || passes >= 3) break;
    await settle();
  }
  say(`left ${JSON.stringify(left)}`);
  return { left, clean: empty(left), passes };
}
