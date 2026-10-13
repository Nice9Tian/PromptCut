/**
 * 节点自检：账号版云端 Agent「一条任务一个进程」的 root 这一侧，在**真的 Linux、真的 systemd 和 cgroup** 上走一遍。
 * 只在 Linux 上、以 root 跑。它不连任何现有服务、不联网、不读任何真实密钥，只在自己的临时目录、
 * 自己起的临时单元和 cgroup 里活动；跑完（包括中途失败）把这些全部清掉，并打印「清理后还剩什么」。
 *
 * ── 怎么跑 ──────────────────────────────────────────────────────────────────────────
 *   1. 在仓库里打包（本机）：
 *        git archive --format=tar.gz -o pc-claude-probe-src.tgz <提交> server src/kernel/agentScopes.mjs src/kernel/creativity.mjs \
 *          scripts/probes/account-root-entry-linux.mjs scripts/probes/account-task-worker-config-linux.mjs
 *      （`PROBE_SOURCE_PATHS` 就是这几样。不需要 node_modules：任务进程入口和 root 入口静态引用到的只有仓库自己的文件与 Node 内置模块；
 *        vite 只在真领到任务以后才载，这支脚本走不到那一步。）
 *   2. 拷到节点，解到一个新建的临时目录（哪里都行，例如 /root/pc-claude-probe-src）：
 *        mkdir /root/pc-claude-probe-src && tar -xzf pc-claude-probe-src.tgz -C /root/pc-claude-probe-src
 *   3. 跑：
 *        cd /root/pc-claude-probe-src && node scripts/probes/account-root-entry-linux.mjs
 *      可选参数：
 *        --user <系统用户>     任务进程用哪个已有的非 root 用户跑，缺省 nobody（脚本不建用户）
 *        --protect a.service,b.service   点名几个现有单元：跑前跑后它们的主进程号与重启次数必须一样，不一样算失败
 *        --keep-on-failure     有检查不过时不清理，留给人看（之后用 --cleanup <编号> 清）
 *        --cleanup <编号>      只做清理：把某一次没清干净的（编号在那一次开头的 `probe id` 一行里；输出丢了的话 `ls -d /run/pc-claude-probe-*`
 *                              看目录名的后八位）清掉，可以重复跑
 *      建议放在 tmux / screen 里跑：SSH 掉线时脚本收到 SIGHUP 会照样清理，但你看不到输出。Ctrl-C（SIGINT）、SIGTERM 同样先清理再退。
 *   4. 跑完删掉第 2 步的目录：rm -rf /root/pc-claude-probe-src
 *
 * ── 它会碰什么（全部带本次的编号 <id>，8 位十六进制）──────────────────────────────────
 *   目录      /run/pc-claude-probe-<id>/            代码副本、临时证书、root 的记录、任务进程的数据（跑完删）
 *   单元      pc-claude-probe-<id>-a.service        一个任务槽；单元文件在 /run/systemd/system/（跑完删）
 *   drop-in   /run/systemd/system/pc-claude-probe-<id>-a.service.d/   发布器写的（跑完删）
 *   slice     pcclaudeprobe<id><代>n<随机>.slice    每一代一个临时 slice，cgroup 在 /sys/fs/cgroup/ 下
 *             （slice 名里不能有连字符——连字符在 systemd 里表示层级，发布器也不许——所以前缀是 pcclaudeprobe）
 *   端口      回环上向系统要来的三个空闲端口（一个给任务进程听，另两个故意没人听）
 *   全局动作  `systemctl daemon-reload` 共 7 次：布置 1 次、发布器每开一代 1 次（共 5 代）、清理 1 次。只重读单元文件，不重启任何服务
 * 不碰：任何现有单元、端口、数据目录、用户；不改防火墙、网络、时间。
 *
 * ── 输出 ────────────────────────────────────────────────────────────────────────────
 *   每一步一行：`ok <序号> <名字>`，或 `FAIL <名字> <原因码>`（后面跟几行 `  diag …` 现场）。一步不过，后面的记 `skip`，直接去清理。
 *   末尾：`cleanup …` 若干行、`left …` 一行（清理后还剩什么，全空才算干净；有一步超时或被信号打断时会等后台落定、清理两遍再盘点）、
 *   最后一行 `PASS account-root-entry-linux <过的数>/<总数>` 或 `FAIL account-root-entry-linux <过的数>/<总数>`。退出码 0 / 1。
 *
 * ── 核的是什么 ──────────────────────────────────────────────────────────────────────
 *   用的是生产的那几样：任务槽单元模板（`server/hosted/deploy/systemd-promptcut-agent-task.service`）、任务进程入口与它的生产配置
 *   （凭 root 写的设置文件起）、发布器的 Linux 运行时、root 入口的接线（`buildSlots`）、指令通道。
 *   受控的只有「文档服务」：没有文档服务，分配和强制终态由脚本自己的一把临时钥匙签（发布器照样验签）；所以任务进程领不到任务，
 *   「正常结束」那条关法（要任务进程签意向）这里验不到——它在本机的集成测试里验过，差的只是系统那一半，而系统那一半和强制关是同一段代码。
 *    1 初始化槽：开第一代、随即退掉；锚点摘要；单元回到 inactive（不是 failed），那一代的 slice 没了
 *    2 开第二代：设置文件是 root 的、任务进程读得到；发布器核过监听口归这一代主进程、核过身份口的回应
 *    3 指令通道：root 证书连得上，领取被如实拒绝（文档服务连不上），进程还活着，结算结果是「还没有」
 *    4 绑定：发布器认脚本签的分配
 *    5 进程还活着时强制关：整组进程被结束，cgroup 空了，写下关闭记录；单元 inactive
 *    6 主进程被结束（SIGKILL）：单元停在 active (exited)、cgroup 还在；写得下失败观察；再凭强制终态关
 *    7 主进程自己退出（收尾指令）且从没绑定过：写失败观察，按「没领过任务」退掉
 *    8 上一个 root 进程留下的一代：新的接线没有它的通道，先停它的主进程、写失败观察，再强制关
 *    9 文档服务读这条记录链的那段代码（只读）读得通：五代、都关了、三份失败观察；记录文件别的用户读得到
 *   10 root 入口 `--status`：它要执行的代码有一个文件组可写就拒绝启动；收回以后读配置、列出槽的现状
 *   11 root 入口常驻：起来以后一直在——槽空着、主服务连不上（每轮记一行）时空闲八秒以上还活着、问过三轮以上还在接着问；
 *      收到 SIGTERM 才退，退出码 0，不动任何槽
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PREFIX, PROBE_SOURCE_PATHS, parseProbeArguments, probePlan, requireLinuxRoot, realSystem, finishProbe } from '../../server/agent-service/account-root-probe-support.mjs';

const TOTAL = 11;
const here = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(here, '..', '..');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const codeOf = error => (typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(error.code) ? error.code : String(error?.message ?? 'failed').replace(/[^A-Za-z0-9_.:-]+/g, '-').slice(0, 120) || 'failed');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ------------------------------ 以下只在 Linux root 上走得到 ------------------------------ */

const say = text => { try { process.stdout.write(`${text}\n`); } catch { /* 终端已经断开 */ } };
const SIGNALS = ['SIGINT', 'SIGHUP', 'SIGTERM'];
const freePorts = async count => {
  const servers = await Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => { const server = net.createServer();
    server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server)); })));
  const ports = servers.map(server => server.address().port);
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  return ports;
};

async function main(options) {
  const sys = realSystem();
  if (options.cleanupId) {
    const plan = probePlan(options.cleanupId);
    return (await finishProbe({ plan, sys, say })).clean ? 0 : 1;
  }
  const plan = probePlan(randomBytes(4).toString('hex'));
  say(`probe id ${plan.id}  (dir ${plan.dir}, unit ${plan.unit}, slices ${plan.namespace}*.slice, user ${options.user})`);
  // 发布器每开一代做一次 daemon-reload（只重读单元文件，不重启任何服务）；这支脚本一共开五代
  say('note 这次会执行 systemctl daemon-reload 共 7 次：布置 1 次、每开一代 1 次（共 5 代）、清理 1 次');
  let passed = 0, failedAt = null, ports = [], child = null, timedOut = false, interrupted = null, interrupt = () => {};
  const diag = [], running = new Set();
  // Ctrl-C、终端断开（SSH 掉线）、被叫停：不再往下做，直接去清理。清理和正常结束走的是同一段
  const interruption = new Promise((_, reject) => { interrupt = name => { if (interrupted) return; interrupted = name; failedAt ??= `interrupted-by-${name}`;
    say(`FAIL interrupted ${name}`); reject(Object.assign(new Error('interrupted'), { code: 'interrupted' })); }; });
  interruption.catch(() => {});
  for (const name of SIGNALS) process.on(name, () => interrupt(name));
  const check = async (name, fn) => {
    if (failedAt) { say(`skip ${name}`); return; }
    const work = fn(); work.catch(() => {}); running.add(work); void work.finally(() => running.delete(work)).catch(() => {});
    try {
      // 每一步最多等三分钟（发布器自己等 cgroup 空最多两分钟）；到时就算不过，去清理
      let timer;
      await Promise.race([work, interruption, new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(Object.assign(new Error('check-timeout'), { code: 'check-timeout' })); }, 180_000); })]).finally(() => clearTimeout(timer));
      passed += 1; say(`ok ${passed} ${name}`);
    } catch (error) {
      if (interrupted) { say(`skip ${name}`); return; }
      failedAt = name; say(`FAIL ${name} ${codeOf(error)}`); for (const row of diag.splice(0)) say(`  diag ${row}`); await dump().catch(() => {});
    }
  };
  const need = (condition, code) => { if (!condition) fail(code); };
  // 现场：单元的状态、最近的日志、登记目录里有什么。只读。
  let dump = async () => {};
  const snapshot = async units => { const rows = {};
    for (const unit of units) { const shown = await sys.systemctl(['show', unit, '--no-pager', '--property=MainPID', '--property=NRestarts', '--property=ActiveState']);
      rows[unit] = shown.stdout.trim().split('\n').sort().join(' '); }
    return rows; };
  let protectedBefore = null, runningBefore = null;
  try {
    process.umask(0o022);
    // ---------- 前提 ----------
    for (const file of ['/usr/bin/systemctl', '/usr/bin/busctl', '/usr/bin/id']) need(fs.existsSync(file), `precondition-missing-${path.basename(file)}`);
    need(fs.existsSync('/sys/fs/cgroup/cgroup.controllers'), 'precondition-cgroup-v2');
    need(spawnSync('openssl', ['version'], { stdio: 'ignore', windowsHide: true }).status === 0, 'precondition-openssl');
    const idOf = flag => { const result = spawnSync('/usr/bin/id', [flag, '--', options.user], { encoding: 'utf8', windowsHide: true }); need(result.status === 0, 'precondition-user'); return result.stdout.trim(); };
    const uid = Number(idOf('-u')), gid = Number(idOf('-g')), group = idOf('-gn');
    need(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid), 'precondition-user');
    need(/^[a-z_][a-z0-9_-]{0,31}$/.test(group), 'precondition-user-group');
    need(spawnSync(process.execPath, ['-e', 'process.exit(0)'], { uid, gid, stdio: 'ignore', windowsHide: true }).status === 0, 'precondition-node-not-usable-by-user');
    need(!fs.existsSync(plan.dir) && !fs.existsSync(plan.unitFile), 'precondition-name-in-use');
    for (const rel of PROBE_SOURCE_PATHS) need(fs.existsSync(path.join(REPO, rel)), 'precondition-source-incomplete');
    protectedBefore = await snapshot(options.protect);
    const running = (await sys.systemctl(['list-units', '--type=service', '--state=running', '--plain', '--no-legend', '--no-pager'])).stdout
      .split('\n').map(row => row.trim().split(/\s+/)[0]).filter(name => name && name.endsWith('.service') && !name.startsWith(PREFIX));
    runningBefore = await snapshot(running);

    // ---------- 布置：代码副本、临时证书、单元文件、配置 ----------
    for (const dir of [plan.dir, plan.repoDir, plan.pkiDir, `${plan.dir}/registry`, plan.registryDir, `${plan.dir}/etc`, path.posix.dirname(plan.settingsFile), plan.dataDir, plan.stateRoot])
      fs.mkdirSync(dir, { mode: 0o755 });
    // 任务进程以 --user 那个用户跑，要读得到代码：拷一份到 /run 下（测试目录不拷）
    await fsp.cp(path.join(REPO, 'server'), `${plan.repoDir}/server`, { recursive: true, filter: source => !/[\\/]server[\\/]test([\\/]|$)/.test(source) });
    fs.mkdirSync(`${plan.repoDir}/src/kernel`, { recursive: true, mode: 0o755 });
    for (const name of ['agentScopes.mjs', 'creativity.mjs']) fs.copyFileSync(path.join(REPO, 'src', 'kernel', name), `${plan.repoDir}/src/kernel/${name}`);
    // 这份副本只有 root 改得了（root 入口启动时要核）：目录 0755、文件 0644。解包出来的文件常常是组可写的
    const tighten = dir => { fs.chmodSync(dir, 0o755);
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = `${dir}/${item.name}`;
        if (item.isSymbolicLink()) fail('setup-symlink-in-source'); else if (item.isDirectory()) tighten(file); else fs.chmodSync(file, 0o644); } };
    tighten(plan.repoDir);
    fs.chownSync(plan.dataDir, uid, gid); fs.chownSync(plan.stateRoot, uid, gid);
    const openssl = args => { const result = spawnSync('openssl', args, { cwd: plan.pkiDir, stdio: 'ignore', timeout: 60_000, windowsHide: true }); need(result.status === 0, 'setup-openssl'); };
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=pc claude probe CA', '-keyout', 'ca.key', '-out', 'ca.crt']);
    fs.writeFileSync(`${plan.pkiDir}/ext.txt`, 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n');
    for (const name of ['controller', 'identity', 'task']) {
      openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=pc claude probe ${name}`, '-keyout', `${name}.key`, '-out', `${name}.csr`]);
      openssl(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'ext.txt', '-out', `${name}.crt`]);
    }
    // root 的私钥只有 root 读得到；任务进程的两把私钥归那个用户；证书人人可读
    for (const name of ['ca.key', 'controller.key']) fs.chmodSync(`${plan.pkiDir}/${name}`, 0o600);
    for (const name of ['identity.key', 'task.key']) { fs.chownSync(`${plan.pkiDir}/${name}`, uid, gid); fs.chmodSync(`${plan.pkiDir}/${name}`, 0o600); }
    for (const name of ['ca.crt', 'controller.crt', 'identity.crt', 'task.crt']) fs.chmodSync(`${plan.pkiDir}/${name}`, 0o644);
    const pin = name => new X509Certificate(fs.readFileSync(`${plan.pkiDir}/${name}.crt`)).fingerprint256.replaceAll(':', '').toLowerCase();
    ports = await freePorts(3);
    const [identityPort, docPort, masterPort] = ports;

    // 生产的模块从这支脚本所在的检出里载（root 这一侧）；任务进程从 /run 下那份副本里载
    const load = rel => import(pathToFileURL(path.join(REPO, rel)).href);
    const { digestOf } = await load('server/account/ledger.mjs');
    const { rootRead, systemUnitV2 } = await load('server/hosted/deploy/asset-root-registry-publisher.mjs');
    const { createAgentScopeReader } = await load('server/hosted/agent-run-scope-reader.mjs');
    const { renderTaskUnit } = await load('server/agent-service/account-task-unit.mjs');
    const { validateRootConfiguration } = await load('server/agent-service/account-root-slots.mjs');
    const { buildSlots } = await load('server/agent-service/account-root-main.mjs');
    const { createWorkerControlClient } = await load('server/agent-service/account-worker-control-client.mjs');

    const docKey = generateKeyPairSync('ed25519');
    const signed = value => ({ ...value, signature: sign(null, Buffer.from(digestOf(value)), docKey.privateKey).toString('base64url') });
    const expected = { authorityId: plan.authorityId, slotId: plan.slotId, docAuthorityId: 'pc-claude-probe-doc',
      docPublicKey: createPublicKey(docKey.privateKey).export({ type: 'spki', format: 'der' }).toString('base64'),
      serviceIdentity: 'agent', uid, unit: plan.unit, clientFingerprint256: pin('controller'), serverFingerprint256: pin('identity'),
      closurePolicy: { kind: 'systemd-slice', unitNamespace: plan.namespace, cgroupRoot: '/sys/fs/cgroup', placement: 'direct-child', singleEpoch: true } };
    const rendered = renderTaskUnit({ slot: plan.slotId, user: options.user, group, dir: plan.repoDir, node: process.execPath, settingsFile: plan.settingsFile, heapMb: 512, unit: plan.unit });
    need(!interrupted, 'interrupted');
    fs.writeFileSync(plan.unitFile, rendered.text, { mode: 0o644, flag: 'wx' });
    need((await sys.systemctl(['daemon-reload'])).code === 0, 'setup-daemon-reload');
    const controllerFiles = { keyFile: `${plan.pkiDir}/controller.key`, certFile: `${plan.pkiDir}/controller.crt`, caFile: `${plan.pkiDir}/ca.crt` };
    const config = validateRootConfiguration({ v: 1, pollMs: 200,
      master: { origin: `https://127.0.0.1:${masterPort}/`, fingerprint256: pin('identity') },      // 没人在听：这支脚本里没有主服务
      controller: controllerFiles,
      worker: { doc: { origin: `https://127.0.0.1:${docPort}/`, fingerprint256: pin('identity'),    // 没人在听：这支脚本里没有文档服务
        keyFile: `${plan.pkiDir}/task.key`, certFile: `${plan.pkiDir}/task.crt`, caFile: `${plan.pkiDir}/ca.crt` },
        dataDir: plan.dataDir, stateRoot: plan.stateRoot },
      slots: [{ workerSettingsFile: plan.settingsFile,
        identity: { keyFile: `${plan.pkiDir}/identity.key`, certFile: `${plan.pkiDir}/identity.crt`, caFile: `${plan.pkiDir}/ca.crt` },
        publisher: { v: 1, expected, registryDir: plan.registryDir, configuredAnchorDigest: null,
          identity: { origin: `https://127.0.0.1:${identityPort}/`, ...controllerFiles },
          runtimeAdapter: { unitFragment: { path: plan.unitFile, sha256: rendered.sha256 }, baseDropIns: [], ownDropInPath: `${plan.dropInDir}/90-promptcut-root-slice.conf` } } }] });
    const controllerTls = { key: fs.readFileSync(controllerFiles.keyFile), cert: fs.readFileSync(controllerFiles.certFile), ca: fs.readFileSync(controllerFiles.caFile) };
    const slotConfig = config.slots[0];
    let { adapter } = (await buildSlots(config, controllerTls))[0];

    const unitNow = () => systemUnitV2(plan.unit);
    const record = epoch => rootRead(`${plan.registryDir}/epoch-${epoch}.json`);
    const file = name => rootRead(`${plan.registryDir}/${name}`, true);
    const sliceGone = async epoch => { const r = await file(`reservation-${epoch}.json`); return !fs.existsSync(r.closureScope.cgroup.v2Path); };
    const idle = async () => { const unit = await unitNow(); diag.push(`unit ${unit.ActiveState}/${unit.SubState} MainPID=${unit.MainPID} ControlGroup=${unit.ControlGroup}`);
      return unit.ActiveState === 'inactive' && Number(unit.MainPID) === 0; };
    const assignmentFor = async epoch => { const r = await record(epoch);
      return signed({ v: 1, protocol: 'promptcut.agent-run-scope.assignment.v1', authorityId: expected.authorityId, slotId: expected.slotId, epoch,
        recordDigest: digestOf(r), docAuthorityId: expected.docAuthorityId,
        target: { projectId: 'probe-project', conversationId: 'probe-conversation', messageId: `probe-message-${epoch}`, runId: `probe-run-${epoch}`,
          runGrantId: `probe-grant-${epoch}`, serviceId: 'agent', serviceKid: 'probe-task-kid', instanceId: r.instance.instanceId, instanceGeneration: 1,
          publicKeyDigest: r.worker.publicKeyDigest } }); };
    const forcedFor = async (epoch, kind) => { const r = await record(epoch), assignment = await file(`assignment-${epoch}.json`);
      return signed({ v: 1, protocol: 'promptcut.agent-run-scope.forced-terminal.v1', authorityId: expected.authorityId, slotId: expected.slotId, epoch,
        recordDigest: digestOf(r), docAuthorityId: expected.docAuthorityId, assignmentDigest: digestOf(assignment),
        fence: { controlId: `probe-control-${epoch}`, fenceRevision: 1, payloadDigest: digestOf({ probe: plan.id, epoch }), kind, outcome: kind === 'worker-failed' ? 'failed' : 'interrupted' } }); };
    const phase = async () => (await adapter.current())?.phase ?? null;
    const waitExited = async worker => { const result = await Promise.race([worker.exited, delay(15_000).then(() => null)]); need(result !== null, 'main-exit-not-observed'); };
    dump = async () => {
      const unit = await unitNow().catch(() => null);
      if (unit) say(`  diag unit ${JSON.stringify(Object.fromEntries(['ActiveState', 'SubState', 'MainPID', 'ControlGroup', 'InvocationID', 'Slice', 'DropInPaths'].map(k => [k, unit[k]])))}`);
      say(`  diag registry ${JSON.stringify(fs.existsSync(plan.registryDir) ? fs.readdirSync(plan.registryDir).sort() : null)}`);
      const journal = spawnSync('journalctl', ['-u', plan.unit, '-n', '25', '--no-pager', '-o', 'cat'], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
      for (const row of String(journal.stdout ?? '').trim().split('\n').slice(-25)) if (row) say(`  diag journal ${row.slice(0, 300)}`);
    };

    // ---------- 检查 ----------
    let anchorDigest = null;
    await check('初始化槽：开第一代、随即退掉；单元回到 inactive，那一代的 slice 没了', async () => {
      const result = await adapter.bootstrap();
      diag.push(`bootstrap ${JSON.stringify(result)}`);
      need(result.initialized === true && result.epoch === 1 && result.phase === 'closed' && /^[a-f0-9]{64}$/.test(result.anchorDigest), 'bootstrap-result');
      anchorDigest = result.anchorDigest; slotConfig.publisher.configuredAnchorDigest = anchorDigest;
      need((await file('terminal-1.json'))?.protocol === 'promptcut.agent-run-scope.unassigned-retirement.v1', 'bootstrap-not-retired');
      need(await idle(), 'unit-not-inactive'); need(await sliceGone(1), 'slice-not-released');
      need((await adapter.bootstrap()).initialized === false, 'bootstrap-not-idempotent');
    });
    let opened = null;
    await check('开第二代：设置文件是 root 的、任务进程读得到；监听口归这一代主进程', async () => {
      opened = await adapter.open();
      const r = await record(2), unit = await unitNow(), stat = fs.statSync(plan.settingsFile), settings = JSON.parse(fs.readFileSync(plan.settingsFile, 'utf8'));
      diag.push(`unit ${unit.ActiveState}/${unit.SubState} MainPID=${unit.MainPID} record.pid=${r.instance.pid} settings.mode=${(stat.mode & 0o777).toString(8)} uid=${stat.uid}`);
      need(opened.rootScopeRef.epoch === 2 && await phase() === 'ready', 'open-phase');
      need(unit.ActiveState === 'active' && Number(unit.MainPID) === r.instance.pid && r.instance.uid === uid, 'open-instance');
      need(stat.uid === 0 && (stat.mode & 0o022) === 0 && (stat.mode & 0o004) !== 0, 'settings-ownership');
      need(settings.reservation.epoch === 2 && settings.rootRecordFile === `${plan.registryDir}/epoch-2.json` && settings.stateDir === `${plan.stateRoot}/probe-a/epoch-2/state`, 'settings-content');
      need(fs.statSync(`${plan.stateRoot}/probe-a/epoch-2/state`).uid === uid, 'state-dir-owner');
      need(opened.worker.alive() === true, 'worker-not-alive');
    });
    await check('指令通道：root 证书连得上，领取被如实拒绝（文档服务连不上），进程还活着，结算结果还没有', async () => {
      let rejected = null, answered = false;
      try { await opened.worker.prepare({ projectId: 'probe-project', conversationId: 'probe-conversation', requestId: 'probe-dispatch-2' }); }
      catch (error) { rejected = codeOf(error); answered = error?.answered === true; }
      diag.push(`prepare rejected with ${rejected} (answered by the worker: ${answered})`);
      // 要的是「任务进程自己答的拒绝」：连不上、证书不对、被它当成不是 root 而拒，都不算指令通道通了
      need(rejected !== null && answered && rejected !== 'account-worker-controller-forbidden', 'control-channel');
      const settled = await Promise.race([opened.worker.settlement.then(() => true), delay(1500).then(() => false)]);
      need(settled === false, 'settlement-invented');
      need(Number((await unitNow()).MainPID) === (await record(2)).instance.pid, 'worker-died-on-rejection');
    });
    await check('绑定：发布器认这一代的分配', async () => {
      await adapter.bind(await assignmentFor(2));
      need(await phase() === 'bound', 'bind-phase');
    });
    await check('进程还活着时强制关：整组进程被结束、cgroup 空了、写下关闭记录；单元 inactive', async () => {
      const pid = (await record(2)).instance.pid;
      await adapter.forcedClose({ terminal: await forcedFor(2, 'stop') });
      const closure = await file('closure-2.json');
      need(await phase() === 'closed' && closure?.observed?.populated === 0 && closure.protocol === 'promptcut.agent-run-scope.forced-closure.v1', 'forced-closure');
      need(!fs.existsSync(`/proc/${pid}`), 'main-still-there'); need(await idle(), 'unit-not-inactive'); need(await sliceGone(2), 'slice-not-released');
    });
    await check('主进程被结束：单元停在 active (exited)、cgroup 还在；写得下失败观察；再凭强制终态关', async () => {
      const worker = (await adapter.open()).worker; await adapter.bind(await assignmentFor(3));
      await worker.stop(); await waitExited(worker);
      const unit = await unitNow();
      diag.push(`after main killed: unit ${unit.ActiveState}/${unit.SubState} MainPID=${unit.MainPID} ControlGroup=${unit.ControlGroup}`);
      need(Number(unit.MainPID) === 0, 'main-still-live');
      // 这一条就是单元模板里「ExecStart 前的 - 加 RemainAfterExit」要保证的：单元没进 failed / inactive，cgroup 没被收掉
      need(unit.ActiveState === 'active' && unit.ControlGroup !== '', 'unit-left-active-state');
      const published = await adapter.observeFailure();
      need(published.failure?.observed?.kind === 'main-birth-gone' && published.failure.observed.populated === 0, 'failure-observation');
      need(await phase() === 'bound', 'failure-is-not-closure');
      await adapter.forcedClose({ terminal: await forcedFor(3, 'worker-failed') });
      need(await phase() === 'closed' && await idle() && await sliceGone(3), 'forced-after-failure');
    });
    await check('主进程自己退出且从没绑定过：写失败观察，按「没领过任务」退掉', async () => {
      const worker = (await adapter.open()).worker;
      const client = createWorkerControlClient({ origin: slotConfig.publisher.identity.origin, tls: controllerTls, serverFingerprint256: expected.serverFingerprint256, timeoutMs: 10_000 });
      try { need((await client.close())?.stopping === true, 'close-command'); } finally { client.stop(); }
      await waitExited(worker);
      const unit = await unitNow(); diag.push(`after self exit: unit ${unit.ActiveState}/${unit.SubState} MainPID=${unit.MainPID}`);
      need(unit.ActiveState === 'active' && Number(unit.MainPID) === 0, 'unit-left-active-state');
      const published = await adapter.observeFailure();
      need(published.failure?.assignmentDigest === null, 'failure-observation');
      await adapter.retire({ reason: 'worker-start-failed' });
      need(await phase() === 'closed' && await idle() && await sliceGone(4), 'retire-after-failure');
    });
    await check('上一个 root 进程留下的一代：新的接线先停它的主进程、写失败观察，再强制关', async () => {
      await adapter.open(); await adapter.bind(await assignmentFor(5));
      const pid = (await record(5)).instance.pid;
      // 新的 root 进程：同一份配置、同一个登记目录，重新建接线（它没有连着任何一代）
      adapter = (await buildSlots(config, controllerTls))[0].adapter;
      need(adapter.describe().attachedEpoch === null && await phase() === 'bound' && fs.existsSync(`/proc/${pid}`), 'orphan-setup');
      const published = await adapter.observeFailure();
      need(published.failure?.observed?.mainPid === 0 && !fs.existsSync(`/proc/${pid}`), 'orphan-not-stopped');
      await adapter.forcedClose({ terminal: await forcedFor(5, 'worker-failed') });
      need(await phase() === 'closed' && await idle() && await sliceGone(5), 'orphan-forced');
    });
    await check('文档服务读这条记录链的那段代码读得通：五代、都关了、三份失败观察；记录文件别的用户读得到', async () => {
      const view = await createAgentScopeReader({ registryDir: plan.registryDir, expected, configuredAnchorDigest: anchorDigest }).read();
      diag.push(`reader head ${JSON.stringify(view.checkpoint.head)} failures ${Object.keys(view.failures)}`);
      need(view.checkpoint.head.epoch === 5 && view.checkpoint.head.phase === 'closed' && view.history.length === 5, 'reader-head');
      need(Object.keys(view.failures).sort().join(',') === '3,4,5', 'reader-failures');
      const names = fs.readdirSync(plan.registryDir);
      need(!names.includes('.publisher.lock'), 'publisher-lock-left');
      for (const name of names) need((fs.statSync(`${plan.registryDir}/${name}`).mode & 0o004) !== 0 && fs.statSync(`${plan.registryDir}/${name}`).uid === 0, `registry-file-mode-${name}`);
      // 以任务进程那个用户的身份真读一遍（文档服务也是一个非 root 用户）
      const asUser = spawnSync(process.execPath, ['-e', 'JSON.parse(require("fs").readFileSync(process.argv[1]))', `${plan.registryDir}/current.json`], { uid, gid, stdio: 'ignore', windowsHide: true });
      need(asUser.status === 0, 'registry-not-readable-by-user');
    });
    fs.writeFileSync(plan.configFile, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    // root 入口从 /run 下那份副本里跑：它启动时要核自己执行的代码只有 root 改得了，那份副本的权限上面已经收紧过
    const rootMain = `${plan.repoDir}/server/agent-service/account-root-main.mjs`;
    await check('root 入口 --status：代码有一个文件组可写就拒绝启动；收回以后读配置、列出槽的现状', async () => {
      const loose = `${plan.repoDir}/server/agent-service/account-root-slots.mjs`;
      fs.chmodSync(loose, 0o664);
      const refused = spawnSync(process.execPath, [rootMain, '--config', plan.configFile, '--status'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
      fs.chmodSync(loose, 0o644);
      diag.push(`status with group-writable code: exit ${refused.status} ${String(refused.stdout).trim().slice(0, 300)}`);
      need(refused.status === 1 && /"reason":"root-code-untrusted"/.test(refused.stdout) && refused.stdout.includes(loose), 'untrusted-code-not-refused');
      const result = spawnSync(process.execPath, [rootMain, '--config', plan.configFile, '--status'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
      diag.push(`status exit ${result.status} ${String(result.stdout).trim().slice(0, 400)}`);
      need(result.status === 0, 'status-exit');
      const row = String(result.stdout).trim().split('\n').map(text => JSON.parse(text)).find(entry => entry.event === 'root.slot.status');
      need(row?.slotId === plan.slotId && row.epoch === 5 && row.phase === 'closed' && row.activeState === 'inactive', 'status-row');
    });
    await check('root 入口常驻：起来以后一直在（槽空着、主服务连不上也在），问过三轮以上还活着；SIGTERM 才退，退出码 0，不动任何槽', async () => {
      let output = '';
      child = spawn(process.execPath, [rootMain, '--config', plan.configFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
      const ticks = () => (output.match(/"event":"scheduler[.]tick[.]failed"/g) ?? []).length;
      const alive = () => child.exitCode === null && child.signalCode === null;
      const deadline = Date.now() + 30_000;
      while (!/"event":"root[.]ready"/.test(output)) {
        if (Date.now() > deadline || !alive()) { diag.push(`root main output ${output.slice(-600)}`); fail('root-main-not-ready'); }
        await delay(100);
      }
      // 空闲八秒：这段时间里它没有任何事可做（没人排队），也没有监听口。它必须还在，并且还在一轮一轮地问。
      await delay(8_000);
      diag.push(`root main after 8s idle: alive=${alive()} exit=${child.exitCode} ticks=${ticks()}`);
      need(alive(), 'root-main-exited-by-itself');
      need(ticks() >= 3, 'root-main-not-polling');
      const before = ticks(); await delay(1_500);
      need(alive() && ticks() > before, 'root-main-stopped-polling');
      need(!/"event":"root[.]stopping"/.test(output), 'root-main-stopping-early');
      child.kill('SIGTERM');
      const ended = await Promise.race([exited, delay(20_000).then(() => null)]);
      diag.push(`root main ended ${JSON.stringify(ended)} ${output.slice(-300)}`);
      need(ended?.code === 0 && ended.signal === null, 'root-main-exit'); child = null;
      need(/"event":"root[.]stopping"/.test(output), 'root-main-not-stopped-by-signal');
      need(await phase() === 'closed' && await idle(), 'root-main-touched-slot');
      need(!/"event":"slot[.](opened|stuck)"/.test(output), 'root-main-opened-without-work');
    });
  } catch (error) {
    if (!failedAt) { failedAt = 'setup'; say(`FAIL setup ${codeOf(error)}`); for (const row of diag.splice(0)) say(`  diag ${row}`); await dump().catch(() => {}); }
  }

  // ---------- 现有单元有没有被碰到 ----------
  let disturbed = false;
  try {
    if (protectedBefore) { const after = await snapshot(options.protect);
      for (const unit of options.protect) if (after[unit] !== protectedBefore[unit]) { disturbed = true; say(`FAIL protected ${unit} before=${protectedBefore[unit]} after=${after[unit]}`); } }
    if (runningBefore) { const after = await snapshot(Object.keys(runningBefore));
      const changed = Object.keys(runningBefore).filter(unit => after[unit] !== runningBefore[unit]);
      say(`note 跑之前在运行的 ${Object.keys(runningBefore).length} 个服务里，主进程号或重启次数变了的：${changed.length ? changed.join(', ') : '没有'}`); }
  } catch (error) { say(`note 现有单元的前后对比没做成：${codeOf(error)}`); }

  // ---------- 清理 ----------
  // 被信号打断、或者有一步超时：那一步可能还在后台跑。清理一遍、等它落定（最多 40 秒）、再清理再盘点一遍。
  if (child) { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } }
  const settle = () => Promise.race([Promise.allSettled([...running]), delay(40_000)]).then(() => delay(1_000));
  const { clean } = await finishProbe({ plan, sys, say, ports, keep: Boolean(failedAt && options.keepOnFailure && !interrupted),
    unsettled: timedOut || interrupted !== null, settle });
  for (const name of SIGNALS) process.removeAllListeners(name);
  const good = !failedAt && !disturbed && passed === TOTAL && clean;
  say(`${good ? 'PASS' : 'FAIL'} account-root-entry-linux ${passed}/${TOTAL}${clean ? '' : ' (清理后还有剩余，见 left 一行)'}${interrupted ? ` (被 ${interrupted} 打断)` : ''}`);
  return good ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let code = 1;
  // 终端断开（SIGHUP）以后标准输出写不出去：不让它变成未处理的错，清理照做
  process.stdout.on('error', () => {});
  try {
    const options = parseProbeArguments(process.argv.slice(2));
    requireLinuxRoot();
    code = await main(options);
  } catch (error) { say(`FAIL precondition ${codeOf(error)}`); say(`FAIL account-root-entry-linux 0/${TOTAL}`); }
  process.exit(code);
}
