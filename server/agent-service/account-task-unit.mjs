/**
 * 把任务槽的 systemd 单元模板（`server/hosted/deploy/systemd-promptcut-agent-task.service`）填成一个槽的单元文件，
 * 并算出它的 SHA-256——root 入口配置里这个槽的 `publisher.runtimeAdapter.unitFragment.sha256` 要的就是它
 * （发布器每开一代都核这份文件没被换过）。
 *
 * 跑（只打印，不写任何系统位置；`--out` 写到你指的文件）：
 *   node server/agent-service/account-task-unit.mjs --slot slot-a --user promptcut-agent-task --dir /opt/promptcut-render/current \
 *     --node /usr/bin/node --settings /etc/promptcut/agent-slots/slot-a/worker-settings.json [--group <组>] [--heap-mb 1536] [--unit <单元名>] [--out <文件>]
 * 标准输出是一行 JSON：{ unit, path, sha256, text? }（给了 --out 就不带 text）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEMPLATE = fileURLToPath(new URL('../hosted/deploy/systemd-promptcut-agent-task.service', import.meta.url));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const posixAbsolute = value => typeof value === 'string' && path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
  !/[\s"'%\\$;]/.test(value);

/**
 * @param {object} o
 * @param {string} o.slot 槽号（进单元名和说明）
 * @param {string} o.user 任务进程的系统用户（不能是 root）
 * @param {string} [o.group] 任务进程的组：任务用户和主服务用户共有的那个组（共用数据目录是它的）。缺省同用户名
 * @param {string} o.dir 这份检出在节点上的目录（里面有 server/）
 * @param {string} o.node node 可执行文件的绝对路径
 * @param {string} o.settingsFile root 入口给这个槽写设置的固定位置
 * @param {number} [o.heapMb] V8 老生代上限（MiB）
 * @param {string} [o.unit] 单元名，缺省 `promptcut-agent-task-<槽>.service`
 * @param {string} [o.template] 模板原文（缺省读仓库里的那一份）
 * @returns {{ unit: string, path: string, text: string, sha256: string }}
 */
export function renderTaskUnit({ slot, user, group = user, dir, node, settingsFile, heapMb = 1536, unit = `promptcut-agent-task-${slot}.service`,
  template = fs.readFileSync(TEMPLATE, 'utf8') } = {}) {
  if (typeof slot !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/.test(slot) ||
      typeof user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || user === 'root' ||
      typeof group !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(group) ||
      !posixAbsolute(dir) || !posixAbsolute(node) || !posixAbsolute(settingsFile) ||
      !Number.isInteger(heapMb) || heapMb < 128 || heapMb > 65536 ||
      typeof unit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,180}\.service$/.test(unit)) fail('task-unit-arguments');
  const values = { SLOT: slot, UNIT: unit, TASK_USER: user, TASK_GROUP: group, DIR: dir, NODE: node, SETTINGS_FILE: settingsFile, HEAP_MB: String(heapMb) };
  const text = template.replaceAll('\r\n', '\n').replace(/\{\{([A-Z_]+)\}\}/g, (whole, name) => (Object.hasOwn(values, name) ? values[name] : fail('task-unit-template')));
  // 发布器逐项核的那几样必须原样在：模板被改坏了宁可在这里就拒
  for (const line of ['Restart=no', 'KillMode=control-group', 'Delegate=no', 'RemainAfterExit=yes', 'UMask=0007', `User=${user}`, `Group=${group}`])
    if (!text.split('\n').includes(line)) fail('task-unit-template');
  if (/^\s*Slice=/m.test(text) || /^\[Install\]/m.test(text)) fail('task-unit-template');
  return { unit, path: `/etc/systemd/system/${unit}`, text, sha256: createHash('sha256').update(text).digest('hex') };
}

export function parseTaskUnitArguments(argv) {
  const names = { '--slot': 'slot', '--user': 'user', '--group': 'group', '--dir': 'dir', '--node': 'node', '--settings': 'settingsFile',
    '--heap-mb': 'heapMb', '--unit': 'unit', '--out': 'out' };
  const options = {};
  if (!Array.isArray(argv) || argv.length % 2) fail('task-unit-arguments');
  for (let i = 0; i < argv.length; i += 2) {
    const name = names[argv[i]];
    if (!name || Object.hasOwn(options, name) || typeof argv[i + 1] !== 'string') fail('task-unit-arguments');
    options[name] = name === 'heapMb' ? Number(argv[i + 1]) : argv[i + 1];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { out, ...options } = parseTaskUnitArguments(process.argv.slice(2));
    const rendered = renderTaskUnit(options);
    if (out) fs.writeFileSync(out, rendered.text, { mode: 0o644, flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ unit: rendered.unit, path: rendered.path, sha256: rendered.sha256, ...(out ? { out } : { text: rendered.text }) })}\n`);
  } catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code ?? 'task-unit-failed' })}\n`); process.exitCode = 1; }
}
