/**
 * 只在 Linux 上、以 root 跑：核任务进程的**生产配置入口**（`server/agent-service/account-task-worker-config.mjs` 的
 * `createWorkerConfiguration()`）。这条路在 Windows 上直接拒绝（要核文件属主是 root），本机测试走的是换掉读文件那一处的
 * `buildWorkerConfiguration`，所以「凭 root 写的设置文件起任务进程」这一段只有这支脚本验得到。
 *
 * 怎么跑（在节点自己的临时目录里；不碰任何生产单元、端口、数据目录，不起任何服务，不联网）：
 *
 *   sudo node scripts/probes/account-task-worker-config-linux.mjs --dir /run/pc-worker-config-probe
 *
 * 前提：
 *   - Linux，root（uid 0）；`--dir` 是一个**还不存在**的绝对路径，它的每一级上级目录属主都是 root、别人写不了
 *     （/run 下新建的目录满足；/tmp 不满足，因为 /tmp 人人可写）；
 *   - 机器上有 openssl（生成临时证书）；有一个非 root 的系统用户 `nobody`（用来造「属主不对」的文件）；
 *   - 在仓库目录里跑（依赖按仓库的 node_modules 解析）。
 *
 * 预期输出：一行一条检查，全部以 `ok ` 开头，最后一行 `PASS account-task-worker-config-linux 9/9`，退出码 0。
 * 任何一条不过：打印 `FAIL <哪一条> <原因码>`，退出码 1，临时目录留着给人看（过了才删）。
 *
 * 核的九条：
 *   1 设置文件、root 记录属主都是 root、权限 0600：读得出，拼出的配置能交给任务进程（身份证书、记录形状都对）；
 *   2 入口照设置去读的就是那一份 root 记录；
 *   3 环境变量没设或不是绝对路径：拒；
 *   4 设置文件别人可写（0666）：拒；
 *   5 设置文件属主不是 root：拒；
 *   6 设置文件是符号链接：拒；
 *   7 设置缺一项（没有 master）：拒；
 *   8 写了看画面但服务私钥目录里没有私钥：拒，不悄悄变成「看不了画面」；
 *   9 写了运行素材但少一个上限：拒。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { scopeModel } from '../../server/test/agent-run-scope-fixture.mjs';
import { createWorkerConfiguration } from '../../server/agent-service/account-task-worker-config.mjs';
import { createAccountTaskWorker } from '../../server/agent-service/account-task-worker.mjs';

const args = process.argv.slice(2), dir = args[0] === '--dir' ? args[1] : null;
const say = line => process.stdout.write(`${line}\n`);
if (process.platform !== 'linux' || process.getuid?.() !== 0) { say('FAIL precondition linux-root-required'); process.exit(1); }
if (!dir || !path.isAbsolute(dir) || fs.existsSync(dir)) { say('FAIL precondition --dir must be a new absolute path'); process.exit(1); }
const pin = cert => new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
const openssl = a => execFileSync('openssl', a, { cwd: dir, stdio: 'ignore', timeout: 30_000, windowsHide: true });
let passed = 0;
const check = async (name, fn) => {
  try { await fn(); passed += 1; say(`ok ${passed} ${name}`); }
  catch (error) { say(`FAIL ${name} ${error?.code ?? error?.message ?? 'unknown'}`); process.exit(1); }
};
const rejects = async (fn, codes) => {
  try { await fn(); } catch (error) { if (codes.includes(error?.code)) return; throw Object.assign(new Error(`unexpected:${error?.code ?? error?.message}`), { code: `unexpected:${error?.code ?? error?.message}` }); }
  throw Object.assign(new Error('not-rejected'), { code: 'not-rejected' });
};

fs.mkdirSync(dir, { mode: 0o700 });
openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=worker config probe CA', '-keyout', 'ca.key', '-out', 'ca.crt']);
fs.writeFileSync(path.join(dir, 'ext.txt'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n');
for (const name of ['task', 'identity', 'controller']) {
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-keyout', `${name}.key`, '-out', `${name}.csr`]);
  openssl(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'ext.txt', '-out', `${name}.crt`]);
}
const file = name => path.join(dir, name);
// 一份形状正确的槽记录：用仓库里受控的发布器模型走一遍「开第一代」，取它产出的预留与记录（纯计算，不碰系统）
const model = scopeModel('probe-slot');
Object.assign(model.expected, { clientFingerprint256: pin(fs.readFileSync(file('controller.crt'))), serverFingerprint256: pin(fs.readFileSync(file('identity.crt'))) });
await model.run('initialize');
const reservation = model.files.get('reservation-1.json'), record = model.files.get('epoch-1.json');
const write = (name, value, mode = 0o600) => { fs.writeFileSync(file(name), typeof value === 'string' ? value : JSON.stringify(value), { mode }); fs.chmodSync(file(name), mode); };
write('epoch-1.json', record);
const base = () => ({ v: 1, expected: model.expected, reservation, rootRecordFile: file('epoch-1.json'),
  identity: { keyFile: file('identity.key'), certFile: file('identity.crt'), caFile: file('ca.crt'), port: 0 },
  doc: { origin: 'https://127.0.0.1:1/', fingerprint256: pin(fs.readFileSync(file('ca.crt'))), keyFile: file('task.key'), certFile: file('task.crt'), caFile: file('ca.crt') },
  master: { origin: 'https://127.0.0.1:2/', fingerprint256: pin(fs.readFileSync(file('ca.crt'))) },
  journalFile: file('journal.sqlite'), dataDir: file('data'), stateDir: file('state') });
const withSettings = async (name, value, fn, mode = 0o600) => {
  write(name, value, mode); process.env.PROMPTCUT_AGENT_WORKER_SETTINGS = file(name);
  try { return await fn(); } finally { delete process.env.PROMPTCUT_AGENT_WORKER_SETTINGS; }
};

let configuration;
await check('root 写的设置与记录读得出，拼出的配置任务进程认', async () => {
  configuration = await withSettings('settings.json', base(), () => createWorkerConfiguration());
  if (configuration.listener.host !== '127.0.0.1' || configuration.listener.port !== 0) throw Object.assign(new Error('listener'), { code: 'listener' });
  const worker = createAccountTaskWorker(configuration.workerOptions); // 核 expected、预留、身份证书的指纹
  if (worker.describe().phase !== 'identity') throw Object.assign(new Error('phase'), { code: 'phase' });
  await worker.close();
});
await check('入口读的就是设置里写的那份 root 记录', async () => {
  const got = await configuration.workerOptions.readRootRecord();
  if (JSON.stringify(got) !== JSON.stringify(record)) throw Object.assign(new Error('record'), { code: 'record-mismatch' });
});
await check('环境变量没设或不是绝对路径：拒', async () => {
  delete process.env.PROMPTCUT_AGENT_WORKER_SETTINGS;
  await rejects(() => createWorkerConfiguration(), ['account-worker-entry-configuration']);
  process.env.PROMPTCUT_AGENT_WORKER_SETTINGS = 'settings.json';
  try { await rejects(() => createWorkerConfiguration(), ['account-worker-entry-configuration']); } finally { delete process.env.PROMPTCUT_AGENT_WORKER_SETTINGS; }
});
await check('设置文件别人可写：拒', () => rejects(() => withSettings('loose.json', base(), () => createWorkerConfiguration(), 0o666), ['publisher-file-untrusted']));
await check('设置文件属主不是 root：拒', async () => {
  write('foreign.json', base()); execFileSync('chown', ['nobody', file('foreign.json')], { stdio: 'ignore', windowsHide: true });
  process.env.PROMPTCUT_AGENT_WORKER_SETTINGS = file('foreign.json');
  try { await rejects(() => createWorkerConfiguration(), ['publisher-file-untrusted']); } finally { delete process.env.PROMPTCUT_AGENT_WORKER_SETTINGS; }
});
await check('设置文件是符号链接：拒', async () => {
  fs.symlinkSync(file('settings.json'), file('link.json'));
  process.env.PROMPTCUT_AGENT_WORKER_SETTINGS = file('link.json');
  try { await rejects(() => createWorkerConfiguration(), ['ELOOP', 'publisher-file-untrusted', 'publisher-file-changed']); } finally { delete process.env.PROMPTCUT_AGENT_WORKER_SETTINGS; }
});
await check('设置缺一项：拒', () => { const value = base(); delete value.master;
  return rejects(() => withSettings('missing.json', value, () => createWorkerConfiguration()), ['account-worker-settings']); });
await check('写了看画面但没有服务私钥：拒', () => { fs.mkdirSync(file('empty-key-dir'), { mode: 0o700 });
  return rejects(() => withSettings('look.json', { ...base(), look: { url: 'http://127.0.0.1:5399', keyDir: file('empty-key-dir') } }, () => createWorkerConfiguration()),
    ['account-worker-settings-look-key']); });
await check('写了运行素材但少一个上限：拒', () => rejects(() => withSettings('assets.json', { ...base(),
  runAssets: { origin: 'https://127.0.0.1:3/', fingerprint256: pin(fs.readFileSync(file('ca.crt'))), maxResponseBytes: 1024 } }, () => createWorkerConfiguration()),
  ['account-worker-settings-run-assets']));

fs.rmSync(dir, { recursive: true, force: true });
say(`PASS account-task-worker-config-linux ${passed}/9`);
