import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digestOf } from '../account/ledger.mjs';
import { publishAgentScope } from '../hosted/deploy/agent-run-scope-publisher.mjs';
import { loadAgentRunScopesConfig } from '../hosted/agent-run-scope-config.mjs';
import { validateWorkerSettings } from '../agent-service/account-task-worker-config.mjs';
import { createAccountSlotScheduler } from '../agent-service/account-slot-scheduler.mjs';
import { validateRootConfiguration, workerSettingsFor, createRootSlotAdapter } from '../agent-service/account-root-slots.mjs';
import { parseRootArguments, requireLinuxRoot } from '../agent-service/account-root-main.mjs';
import { scopeModel, signed } from './agent-run-scope-fixture.mjs';

// root 这一侧的任务槽：配置、给任务进程写的设置、槽的适配（接发布器与指令通道）、root 入口的参数与平台闸。
// 发布器的事务是真的（`publishAgentScope`）；看操作系统的那一半是仓库里受控的模型（`agent-run-scope-fixture.mjs`），
// 任务进程是替身。真的 systemd / cgroup 那一半只有节点上的自检脚本验得到（scripts/probes/account-root-entry-linux.mjs）。
const here = path.dirname(fileURLToPath(import.meta.url));
const until = async (check, what, timeoutMs = 5000) => { const deadline = Date.now() + timeoutMs;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 10)); } };
const PIN = n => String(n).repeat(64);

function rootConfig(models = [scopeModel('slot-a')]) {
  return { v: 1, master: { origin: 'https://127.0.0.1:8792/', fingerprint256: PIN('a') },
    controller: { keyFile: '/etc/promptcut/agent-root/controller.key', certFile: '/etc/promptcut/agent-root/controller.crt', caFile: '/etc/promptcut/agent-root/ca.crt' },
    worker: { doc: { origin: 'https://127.0.0.1:8789/', fingerprint256: PIN('b'), keyFile: '/etc/promptcut/agent-task/task.key', certFile: '/etc/promptcut/agent-task/task.crt', caFile: '/etc/promptcut/agent-task/ca.crt' },
      dataDir: '/var/lib/promptcut/agent-shared', stateRoot: '/var/lib/promptcut/agent-task-state' },
    slots: models.map((m, index) => ({ workerSettingsFile: `/etc/promptcut/agent-slots/${m.expected.slotId}/worker-settings.json`,
      identity: { keyFile: '/etc/promptcut/agent-task/identity.key', certFile: '/etc/promptcut/agent-task/identity.crt', caFile: '/etc/promptcut/agent-task/ca.crt' },
      publisher: { v: 1, expected: m.expected, registryDir: `/var/lib/promptcut/agent-root/${m.expected.slotId}`, configuredAnchorDigest: null,
        identity: { origin: `https://127.0.0.1:${8800 + index}/`, keyFile: '/etc/promptcut/agent-root/controller.key', certFile: '/etc/promptcut/agent-root/controller.crt', caFile: '/etc/promptcut/agent-root/ca.crt' },
        runtimeAdapter: { unitFragment: { path: `/etc/systemd/system/${m.expected.unit}`, sha256: PIN('c') }, baseDropIns: [],
          ownDropInPath: `/run/systemd/system/${m.expected.unit}.d/90-promptcut-root-slice.conf` } } })) };
}

test('root 入口的配置：形状、路径、槽之间不许共用任何一样；写错的一律拒', () => {
  const good = rootConfig([scopeModel('slot-a'), scopeModel('slot-b')]);
  assert.equal(validateRootConfiguration(good), good);
  const bad = (mutate, code) => { const value = structuredClone(good); mutate(value); assert.throws(() => validateRootConfiguration(value), { code }, code); };
  bad(c => { c.v = 2; }, 'root-configuration');
  bad(c => { delete c.master; }, 'root-configuration');
  bad(c => { c.master.origin = 'https://10.0.0.5:8792/'; }, 'root-configuration');        // 主服务的内部口只许回环
  bad(c => { c.master.origin = 'http://127.0.0.1:8792/'; }, 'root-configuration');
  bad(c => { c.controller.keyFile = 'controller.key'; }, 'root-configuration');
  bad(c => { c.extra = true; }, 'root-configuration');
  bad(c => { c.pollMs = 5; }, 'root-configuration');
  bad(c => { c.slots = []; }, 'root-configuration');
  bad(c => { c.worker.dataDir = 'relative'; }, 'root-configuration-worker');
  bad(c => { c.worker.stateRoot = c.worker.dataDir; }, 'root-configuration-worker');     // 共用的和每代自己的不能是同一个目录
  bad(c => { c.worker.doc.origin = 'https://example.com/'; }, 'root-configuration-worker');
  bad(c => { c.worker.unknown = 1; }, 'root-configuration-worker');
  bad(c => { c.slots[0].publisher.configuredAnchorDigest = 'short'; }, 'root-configuration-slot');
  bad(c => { c.slots[0].publisher.identity.origin = 'https://127.0.0.1/'; }, 'root-configuration-slot'); // 身份口要写明端口
  bad(c => { delete c.slots[0].identity; }, 'root-configuration-slot');
  bad(c => { c.slots[0].controlPort = 70000; }, 'root-configuration-slot');
  bad(c => { c.slots[1].publisher.registryDir = c.slots[0].publisher.registryDir; }, 'root-configuration-slot-duplicate');
  bad(c => { c.slots[1].workerSettingsFile = c.slots[0].workerSettingsFile; }, 'root-configuration-slot-duplicate');
  bad(c => { c.slots[1].publisher.identity.origin = c.slots[0].publisher.identity.origin; }, 'root-configuration-slot-duplicate');
  bad(c => { c.slots[1].publisher.expected = c.slots[0].publisher.expected; }, 'root-configuration-slot-duplicate');
  bad(c => { c.slots[1].controlPort = 8800; }, 'root-configuration-slot-duplicate');      // 和另一个槽的身份口撞
  bad(c => { c.slots[0].workerSettingsFile = `${c.slots[0].publisher.registryDir}/worker-settings.json`; }, 'root-configuration-slot-path');
  bad(c => { c.slots[0].workerSettingsFile = `${c.worker.stateRoot}/slot-a/worker-settings.json`; }, 'root-configuration-slot-path'); // 任务进程可写的目录里不放
  bad(c => { c.slots[0].publisher.registryDir = `${c.worker.dataDir}/registry`; }, 'root-configuration-slot-path');
  bad(c => { c.slots[0].publisher.expected.uid = 0; }, 'asset-root-v2-expected-invalid'); // 任务进程不能是 root
});

test('给某一代任务进程写的设置：就是任务进程的生产配置认的那个形状；每一代的状态各在各的目录', async () => {
  const m = scopeModel('slot-a'); await m.run('initialize');
  const config = rootConfig([m]), reservation = m.files.get('reservation-1.json');
  const settings = workerSettingsFor({ config, slot: config.slots[0], reservation });
  // 任务进程按本机的路径规则核设置；这台机器不是 Linux 时把路径换成本机写法再核形状
  const native = value => (typeof value === 'string' ? (value.startsWith('/') ? path.resolve(value) : value)
    : Array.isArray(value) ? value.map(native) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, ['expected', 'reservation'].includes(k) ? v : native(v)])) : value);
  assert.doesNotThrow(() => validateWorkerSettings(native(settings)));
  assert.equal(settings.rootRecordFile, '/var/lib/promptcut/agent-root/slot-a/epoch-1.json');
  assert.equal(settings.identity.port, 8800); assert.deepEqual(settings.master, config.master);
  assert.equal(settings.dataDir, '/var/lib/promptcut/agent-shared');
  assert.equal(settings.stateDir, '/var/lib/promptcut/agent-task-state/slot-a/epoch-1/state');
  assert.equal(settings.journalFile, '/var/lib/promptcut/agent-task-state/slot-a/epoch-1/journal.sqlite');
  assert.deepEqual(settings.reservation, reservation);
  assert.equal(settings.look, undefined); assert.equal(settings.runAssets, undefined); assert.equal(settings.controlPort, undefined);
  // 看画面、运行素材、模型配置目录、控制口：配置里写了才带下去
  const full = structuredClone(config);
  Object.assign(full.worker, { modelConfigDir: '/var/lib/promptcut/agent', look: { url: 'http://127.0.0.1:5399', keyDir: '/var/lib/promptcut/agent-secrets' },
    runAssets: { origin: 'https://127.0.0.1:8791/', fingerprint256: PIN('d'), maxResponseBytes: 1048576, maxImportBytes: 2147483648 } });
  full.slots[0].controlPort = 8850;
  const rich = workerSettingsFor({ config: full, slot: full.slots[0], reservation });
  assert.equal(rich.modelConfigDir, '/var/lib/promptcut/agent'); assert.equal(rich.controlPort, 8850);
  assert.deepEqual(rich.look, full.worker.look); assert.deepEqual(rich.runAssets, full.worker.runAssets);
  assert.doesNotThrow(() => validateWorkerSettings(native(rich)));
  // 别的槽的预留：拒
  const other = scopeModel('slot-b'); await other.run('initialize');
  assert.throws(() => workerSettingsFor({ config, slot: config.slots[0], reservation: other.files.get('reservation-1.json') }), { code: 'agent-scope-reservation' });
});

test('root 入口只在 Linux root 上跑：别的平台、别的用户一律拒；参数只认 --config 加一个可选的方式', () => {
  assert.throws(() => requireLinuxRoot({ platform: 'win32', uid: undefined, euid: undefined }), { code: 'root-linux-root-required' });
  assert.throws(() => requireLinuxRoot({ platform: 'darwin', uid: 0, euid: 0 }), { code: 'root-linux-root-required' });
  assert.throws(() => requireLinuxRoot({ platform: 'linux', uid: 1000, euid: 1000 }), { code: 'root-linux-root-required' });
  assert.throws(() => requireLinuxRoot({ platform: 'linux', uid: 1000, euid: 0 }), { code: 'root-linux-root-required' });
  assert.doesNotThrow(() => requireLinuxRoot({ platform: 'linux', uid: 0, euid: 0 }));
  assert.deepEqual(parseRootArguments(['--config', '/etc/promptcut/agent-root.json']), { configFile: '/etc/promptcut/agent-root.json', mode: 'run' });
  assert.equal(parseRootArguments(['--config', '/etc/promptcut/agent-root.json', '--bootstrap']).mode, 'bootstrap');
  assert.equal(parseRootArguments(['--config', '/etc/promptcut/agent-root.json', '--status']).mode, 'status');
  for (const argv of [[], ['--config'], ['--config', 'relative.json'], ['--config', '/etc/a/../b.json'], ['--config', '/etc/a.json', '--force'],
    ['--bootstrap', '--config', '/etc/a.json'], ['--config', '/etc/a.json', '--bootstrap', '--status']])
    assert.throws(() => parseRootArguments(argv), { code: 'root-arguments' }, JSON.stringify(argv));
  // 真的把入口跑起来：在这台机器（不是 Linux root）上，不管参数怎么写都是同一句拒绝，退出码 1
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    for (const args of [['--config', '/etc/promptcut/agent-root.json'], ['--config', '/etc/promptcut/agent-root.json', '--bootstrap'], []]) {
      const result = spawnSync(process.execPath, [path.resolve(here, '..', 'agent-service', 'account-root-main.mjs'), ...args],
        { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.status, 1);
      const reported = JSON.parse(result.stdout.trim().split('\n').at(-1));
      assert.equal(reported.event, 'config.error'); assert.equal(reported.reason, 'root-linux-root-required');
      assert.doesNotMatch(result.stdout, /root\.ready/);
    }
  }
});

/** 一个槽：真的发布器事务 + 受控的系统模型 + 替身任务进程。`live` 是「主进程还在」的那几代。 */
function slotUnderTest({ slotId = 'slot-a', configured = true } = {}) {
  const m = scopeModel(slotId), live = new Set(), workers = new Map(), log = [];
  const start = m.io.start;
  m.io.start = async reservation => { await start(reservation); live.add(reservation.epoch); m.faults.mainGone = false; };
  const kill = epoch => { live.delete(epoch); m.faults.mainGone = true; };
  const options = () => ({ expected: m.expected, io: m.io, publish: publishAgentScope, watchMs: 10, stopWaitMs: 200,
    anchorDigest: () => (configured && m.files.has('anchor.json') ? digestOf(m.files.get('anchor.json')) : null),
    connect: record => { let settle; const settlement = new Promise(resolve => { settle = resolve; });
      const worker = { epoch: record.epoch, prepared: [], started: 0, stopped: false, settle,
        answer: () => ({ assignment: m.assignment(), phase: 'assigned-unbound', executionAllowed: false }) };
      workers.set(record.epoch, worker);
      return { prepare: async task => { worker.prepared.push(task); return worker.answer(); }, start: async () => { worker.started += 1; },
        settlement: ({ gone }) => Promise.race([settlement, (async () => { while (!gone()) await new Promise(resolve => { setTimeout(resolve, 5).unref(); }); return { kind: 'closed' }; })()]),
        stop() { worker.stopped = true; } }; },
    host: { alive: async record => live.has(record.epoch), stop: async record => { log.push(['host.stop', record.epoch]); kill(record.epoch); } },
    log: (event, fields) => log.push([event, fields.epoch ?? null]) });
  return { m, live, workers, log, kill, options, adapter: createRootSlotAdapter(options()),
    forcedTerminal(epoch, kind = 'stop') { const record = m.files.get(`epoch-${epoch}.json`), assignment = m.files.get(`assignment-${epoch}.json`);
      return signed({ v: 1, protocol: 'promptcut.agent-run-scope.forced-terminal.v1', authorityId: m.expected.authorityId, slotId: m.expected.slotId, epoch,
        recordDigest: digestOf(record), docAuthorityId: m.expected.docAuthorityId, assignmentDigest: digestOf(assignment),
        fence: { controlId: `control-${epoch}`, fenceRevision: 1, payloadDigest: 'c'.repeat(64), kind, outcome: kind === 'worker-failed' ? 'failed' : 'interrupted' } }, m.doc.privateKey); } };
}

test('槽的适配：没初始化的槽调度开不了；初始化只开第一代并随即退掉，回锚点摘要，重复跑不再动它', async () => {
  const raw = slotUnderTest({ configured: false });
  assert.equal(await raw.adapter.current(), null);
  await assert.rejects(raw.adapter.open(), { code: 'root-slot-not-initialized' });
  assert.equal(raw.m.files.size, 0, '调度不会顺手初始化：锚点摘要要先配进文档服务');
  const first = await raw.adapter.bootstrap();
  assert.deepEqual({ ...first, anchorDigest: undefined }, { slotId: 'slot-a', authorityId: 'root-slot-a', initialized: true, anchorDigest: undefined, epoch: 1, phase: 'closed' });
  assert.equal(first.anchorDigest, digestOf(raw.m.files.get('anchor.json')));
  assert.equal(raw.m.files.get('terminal-1.json').protocol, 'promptcut.agent-run-scope.unassigned-retirement.v1');
  assert.equal(raw.m.files.get('assignment-1.json'), undefined, '第一代从没领过任务');
  assert.equal(raw.workers.size, 0, '初始化不连任务进程、不叫它领取');
  assert.deepEqual(await raw.adapter.bootstrap(), { ...first, initialized: false });
  assert.deepEqual(raw.m.calls.filter(name => name === 'start'), ['start'], '第二次没有再开进程');
  // 摘要还没配进配置：调度照旧开不了
  await assert.rejects(raw.adapter.open(), { code: 'root-slot-not-initialized' });
  // 上一次初始化开了第一代、没来得及退就断了：再跑一次把它退掉
  const cut = slotUnderTest({ configured: false }); await cut.m.run('initialize');
  assert.equal((await cut.adapter.current()).phase, 'ready');
  assert.equal((await cut.adapter.bootstrap()).phase, 'closed');
  // 配置里写了摘要而登记目录是空的（指错了目录）：拒，不重新初始化出另一条链
  const wrong = slotUnderTest({ configured: false });
  await assert.rejects(createRootSlotAdapter({ ...wrong.options(), anchorDigest: () => 'f'.repeat(64) }).bootstrap(), { code: 'root-slot-anchor-without-registry' });
  // 配置里的摘要和登记目录里的对不上：拒
  await assert.rejects(createRootSlotAdapter({ ...raw.options(), anchorDigest: () => 'f'.repeat(64) }).bootstrap(), { code: 'root-slot-anchor-mismatch' });
  assert.throws(() => createRootSlotAdapter({ ...raw.options(), host: {} }), { code: 'root-slot-configuration' });
});

test('槽的适配接上槽调度：正常结束按终态和意向关；强制终态强制关；主进程自己没了写失败观察', async () => {
  const s = slotUnderTest(); await s.adapter.bootstrap();
  const pending = { conversations: [{ projectId: 'project', conversationId: 'conversation-slot-a', queueRevision: 1 }], scopeControls: [] };
  const controls = new Map();
  const scheduler = createAccountSlotScheduler({ slots: [s.adapter], pollMs: 20, log: (event, fields) => s.log.push([event, fields.epoch ?? null]),
    master: { pending: async () => structuredClone(pending), scopeControl: async row => { const answer = controls.get(row.controlId); if (!answer) throw Object.assign(new Error('pending'), { status: 503, code: 'run-scope-doc-close-pending' }); return answer; } } });
  await scheduler.start();
  try {
    // ---- 正常结束 ----
    await until(() => scheduler.describe()[0].phase === 'running', '第 2 代在跑');
    const second = s.workers.get(2);
    assert.deepEqual(second.prepared, [{ projectId: 'project', conversationId: 'conversation-slot-a', requestId: 'dispatch:slot-a:2' }]);
    assert.equal(second.started, 1); assert.equal((await s.adapter.current()).phase, 'bound');
    pending.conversations = [];
    second.settle({ kind: 'normal', ...s.m.closing() });
    await until(() => scheduler.describe()[0].phase === 'idle', '第 2 代正常关掉');
    assert.equal(s.m.files.get('closure-2.json').protocol, 'promptcut.agent-run-scope.closure.v1');
    assert.equal(second.stopped, true, '关掉以后不再问这一代的结算结果');
    assert.equal(s.adapter.describe().attachedEpoch, null);
    // ---- 强制关 ----
    pending.conversations = [{ projectId: 'project', conversationId: 'conversation-slot-a', queueRevision: 2 }];
    await until(() => scheduler.describe()[0].phase === 'running' && scheduler.describe()[0].epoch === 3, '第 3 代在跑');
    pending.conversations = [];
    const ref3 = (await s.adapter.current()).rootScopeRef;
    pending.scopeControls = [{ projectId: 'project', controlId: 'control-3', runGrantId: 'grant-3', assignmentDigest: digestOf(s.m.files.get('assignment-3.json')), rootScopeRef: ref3 }];
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(scheduler.describe()[0].phase, 'running', '文档服务还没给强制终态：不关');
    controls.set('control-3', { unassigned: false, terminal: s.forcedTerminal(3) });
    await until(() => scheduler.describe()[0].phase === 'idle', '第 3 代被强制关掉');
    assert.equal(s.m.files.get('closure-3.json').protocol, 'promptcut.agent-run-scope.forced-closure.v1');
    assert.equal(s.m.files.get('intent-3.json'), null, '强制关没有任务进程的意向');
    pending.scopeControls = [];
    // ---- 主进程自己没了 ----
    pending.conversations = [{ projectId: 'project', conversationId: 'conversation-slot-a', queueRevision: 3 }];
    await until(() => scheduler.describe()[0].phase === 'running' && scheduler.describe()[0].epoch === 4, '第 4 代在跑');
    pending.conversations = [];
    s.kill(4);
    await until(() => scheduler.describe()[0].failureObserved === true, '写下失败观察');
    assert.equal(s.m.files.get('failure-4.json').observed.kind, 'main-birth-gone');
    assert.equal(s.log.some(([event, epoch]) => event === 'host.stop' && epoch === 4), false, '进程已经没了：不用再去停');
    assert.equal((await s.adapter.current()).phase, 'bound', '失败观察不是关闭');
    pending.scopeControls = [{ projectId: 'project', controlId: 'control-4', runGrantId: 'grant-4', assignmentDigest: digestOf(s.m.files.get('assignment-4.json')), rootScopeRef: (await s.adapter.current()).rootScopeRef }];
    controls.set('control-4', { unassigned: false, terminal: s.forcedTerminal(4, 'worker-failed') });
    await until(() => scheduler.describe()[0].phase === 'idle', '第 4 代凭「进程故障」的强制终态关掉');
    assert.equal((await s.adapter.current()).phase, 'closed');
  } finally { await scheduler.stop(); }
});

test('上一个 root 进程留下的一代：这里没有它的通道，先让它的主进程停下、写失败观察，再凭强制终态关', async () => {
  const s = slotUnderTest(); await s.adapter.bootstrap();
  // 上一个 root 进程开了第 2 代、绑了任务，然后它自己没了（任务进程还活着）
  const opened = await s.adapter.open(), prepared = await opened.worker.prepare({ projectId: 'project', conversationId: 'conversation-slot-a', requestId: 'dispatch:slot-a:2' });
  await s.adapter.bind(prepared.assignment);
  assert.equal(s.live.has(2), true);
  // 新的 root 进程：同一份登记目录，新的适配（没有连着任何一代）
  const fresh = createRootSlotAdapter(s.options()), pending = { conversations: [], scopeControls: [] }, controls = new Map();
  assert.equal(fresh.describe().attachedEpoch, null);
  const scheduler = createAccountSlotScheduler({ slots: [fresh], pollMs: 20, log: (event, fields) => s.log.push([event, fields.epoch ?? null]),
    master: { pending: async () => structuredClone(pending), scopeControl: async row => controls.get(row.controlId) ?? Promise.reject(Object.assign(new Error('pending'), { status: 503 })) } });
  await scheduler.start();
  try {
    assert.equal(s.log.some(([event]) => event === 'slot.adopted'), true);
    await until(() => scheduler.describe()[0].failureObserved === true, '接手的那一代写下失败观察');
    assert.deepEqual(s.log.filter(([event]) => event === 'host.stop'), [['host.stop', 2]], '它的主进程被停下，只停一次');
    assert.equal(s.live.has(2), false);
    assert.equal((await fresh.current()).phase, 'bound');
    pending.scopeControls = [{ projectId: 'project', controlId: 'control-2', runGrantId: 'grant-2', assignmentDigest: digestOf(s.m.files.get('assignment-2.json')), rootScopeRef: (await fresh.current()).rootScopeRef }];
    controls.set('control-2', { unassigned: false, terminal: s.forcedTerminal(2, 'worker-failed') });
    await until(() => scheduler.describe()[0].phase === 'idle', '凭强制终态关掉');
    // 槽回到可用：下一条照常开第 3 代
    pending.scopeControls = []; pending.conversations = [{ projectId: 'project', conversationId: 'conversation-slot-a', queueRevision: 9 }];
    await until(() => scheduler.describe()[0].phase === 'running' && scheduler.describe()[0].epoch === 3, '第 3 代在跑');
  } finally { await scheduler.stop(); }
  // 主进程停不下来：如实报「还活着」，不写失败观察
  const stubborn = slotUnderTest(); await stubborn.adapter.bootstrap(); await stubborn.adapter.open();
  const blocked = createRootSlotAdapter({ ...stubborn.options(), host: { alive: async () => true, stop: async () => {} } });
  await assert.rejects(blocked.observeFailure(), { code: 'agent-scope-main-still-live' });
  assert.equal(stubborn.m.files.get('failure-2.json'), undefined);
});

test('文档服务这一侧的任务槽配置：只在 Linux 上开；主身份和任务身份必须是两把钥匙；签名钥匙和各槽对得上', () => {
  const m = scopeModel('slot-a'), authorityId = m.expected.docAuthorityId;
  const signingPem = m.doc.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const agent = { fingerprint256: PIN('1'), serviceKid: 'task-kid' };
  const value = { v: 1, signingKeyFile: '/etc/promptcut/doc/run-scope-signing.pem', masterServiceKid: 'master-kid', masterFingerprint256: PIN('2'),
    slots: [{ expected: m.expected, registryDir: path.resolve('/var/lib/promptcut/agent-root/slot-a'), configuredAnchorDigest: PIN('3') }] };
  const file = path.resolve('/etc/promptcut/doc/agent-run-scopes.json');
  value.signingKeyFile = path.resolve(value.signingKeyFile);
  const load = (changed = value, extra = {}) => loadAgentRunScopesConfig({ file, agent, authorityId, platform: 'linux',
    read: name => (name === file ? Buffer.from(JSON.stringify(changed)) : name === value.signingKeyFile ? Buffer.from(signingPem) : (() => { throw new Error('ENOENT'); })()), ...extra });
  const loaded = load();
  assert.equal(loaded.masterServiceKid, 'master-kid'); assert.equal(loaded.masterFingerprint256, PIN('2'));
  assert.deepEqual(loaded.slots, [{ expected: m.expected, registryDir: value.slots[0].registryDir, configuredAnchorDigest: PIN('3'), workerServiceKid: 'task-kid', workerFingerprint256: PIN('1') }]);
  assert.equal(loaded.signingKey.asymmetricKeyType, 'ed25519');
  assert.throws(() => load(value, { platform: 'win32' }), { code: 'run-scopes-linux-required' });
  assert.throws(() => load(value, { file: 'relative.json' }), { code: 'run-scopes-configuration' });
  assert.throws(() => load(value, { agent: { fingerprint256: PIN('1') } }), { code: 'run-scopes-configuration' });
  const bad = (mutate, code) => { const changed = structuredClone(value); mutate(changed); assert.throws(() => load(changed), { code }, code); };
  bad(c => { c.masterFingerprint256 = PIN('1'); }, 'run-scopes-role-configuration');
  bad(c => { c.masterServiceKid = 'task-kid'; }, 'run-scopes-role-configuration');
  bad(c => { c.slots = []; }, 'run-scopes-configuration');
  bad(c => { c.extra = 1; }, 'run-scopes-configuration');
  bad(c => { c.slots[0].configuredAnchorDigest = null; }, 'run-scopes-slot');
  bad(c => { c.slots[0].registryDir = 'relative'; }, 'run-scopes-slot');
  bad(c => { c.slots[0].expected.docAuthorityId = 'another-doc'; }, 'run-scopes-slot-authority');
  bad(c => { c.slots[0].expected.docPublicKey = scopeModel('x').expected.docPublicKey; }, 'run-scopes-slot-authority');
  bad(c => { c.slots.push(structuredClone(c.slots[0])); }, 'run-scopes-slot-duplicate');
  bad(c => { c.signingKeyFile = path.resolve('/etc/promptcut/doc/missing.pem'); }, 'run-scopes-signing-key');
  assert.throws(() => loadAgentRunScopesConfig({ file, agent, authorityId, platform: 'linux', read: () => Buffer.from('not json') }), { code: 'run-scopes-file' });
});
