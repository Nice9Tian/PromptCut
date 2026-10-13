// 0.7.18「真实运行器进任务进程」这一块的几处接线，单独验（整条链在 account-runner-process.test.mjs）：
//   RW1 看画面绑运行授权：登记前、每趟去问前都过授权闸；不过就撤回排着的请求；请求带任务授权号；签名里的实例号可换
//   RW2 渲染服务那一侧：把调用方报的任务记在请求上（落盘、重启后还在）；形状不对的拒
//   RW3 任务进程的生产设置：形状不对、路径不对、写了一半的看画面与运行素材，一律拒
//   RW4 任务范围的刷新：并着来的刷新不互相打掉（不出假的 503）；刷新失败时不留更早的结果
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLookClient, LOOK_CLIENT_MESSAGES } from '../agent-service/look-client.mjs';
import { createLook, createLookVerifier, signLookRequest, LOOK_AUTH_HEADER } from '../hosted-render/look.mjs';
import { createRenderRequests } from '../hosted-render/render-requests.mjs';
import { generateServiceKeyPair, newInstanceId } from '../auth/service-identity.mjs';
import { validateWorkerSettings, createWorkerConfiguration } from '../agent-service/account-task-worker-config.mjs';
import { createAgentRunScopeDoc, agentScopeRef } from '../account/agent-run-scope-doc.mjs';
import { openAccountLedger } from '../account/ledger.mjs';
import { inspectAgentScopeSource } from '../hosted/agent-run-scope-reader.mjs';
import { digestOf } from '../account/ledger.mjs';
import { scopeModel, pair } from './agent-run-scope-fixture.mjs';
import { createExistingHostedRunnerFactory, createImportReservation } from '../agent/service/account-runner.mjs';
import { createWorkspaces } from '../agent/service/workspace.mjs';
import { runAssetImportWithRetry } from '../agent/service/hosted-tools.mjs';
import { resolveAccountLook } from '../agent-service/main.mjs';

const P = `sp_${'a'.repeat(26)}`;
const RUN = { runGrantId: 'grant_one', runId: 'run_one', conversationId: 'conversation_one' };
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-runner-wiring-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

/** 真的签名核对、真的队列与调度；出图的工作进程是替身。`fetch` 直接接到 look 的三个口子上 */
function renderSide({ dir = null, hold = () => false } = {}) {
  const key = generateServiceKeyPair(), logs = [];
  const registry = { get: name => (name === 'agent' ? { role: 'agent', keys: [{ kid: key.kid, pub: key.pub }] } : null) };
  const requests = createRenderRequests({ dir, log: (event, fields) => logs.push({ event, ...fields }) });
  const loaded = requests.load();
  const look = createLook({ verify: createLookVerifier({ registry }), requests,
    project: id => (id === P ? { enabled: true, active: true, hosted: { agent: { enabled: true } } } : null),
    resident: () => ({ port: 7000, key: 'resident-key', running: !hold(), node: id => (!hold() && id === P ? { projectId: id, connected: true, cards: { state: 'none' } } : null) }),
    iso: () => ({ enabled: false, port: 0, key: null, current: null, report: null, lastRun: null }),
    fetch: async () => ({ status: 200, json: async () => ({ ok: true, frame: 1 }) }),
    log: (event, fields) => logs.push({ event, ...fields }), limits: { pollMs: 10, settleMs: 60_000 } });
  const seen = [];
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname, op = { '/look': 'handle', '/look/poll': 'poll', '/look/cancel': 'cancel' }[route];
    seen.push({ route, auth: JSON.parse(Buffer.from(init.headers[LOOK_AUTH_HEADER].slice(3), 'base64url').toString('utf8')), body: JSON.parse(init.body) });
    const out = await look[op]({ auth: init.headers[LOOK_AUTH_HEADER], bodyText: init.body });
    return { status: out.status, json: async () => out.body };
  };
  const client = createLookClient({ url: 'http://127.0.0.1:5399', key: { service: 'agent', kid: key.kid, priv: key.priv, instanceId: newInstanceId() },
    fetch: fetchImpl, limits: { pollWaitMs: 50, backoffMs: [5] } });
  return { key, look, requests, loaded, logs, seen, client, close: () => look.close() };
}

test('RW1 看画面绑运行授权：每趟都过授权闸；失权就撤回排着的请求；请求带任务授权号；实例号用任务进程登记的那一个', async t => {
  let held = false; const r = renderSide({ hold: () => held }); t.after(() => r.close());
  let checks = 0, allowed = true;
  const post = r.client.forProject(P, { authorize: async () => { checks += 1; if (!allowed) throw new Error('run-access-denied'); return { allowed: true }; },
    run: RUN, instance: 'instance-task-7' });
  // 正常：出图。登记那一趟和去问的每一趟之前都问过授权
  assert.deepEqual(await post('/api/vision/snapshot', { project: { id: P, tracks: [] }, t: 1 }), { ok: true, frame: 1 });
  assert.ok(checks >= 2, `授权问了 ${checks} 次`);
  assert.deepEqual(r.seen[0].body.run, RUN); assert.equal(r.seen[0].body.projectId, P);
  assert.ok(r.seen.every(row => row.auth.d === 'instance-task-7'), '签名里的实例号是任务进程登记的那一个');
  assert.equal(r.logs.find(row => row.event === 'look.queued').runGrant, 'grant_one');
  // 排着的时候失权：下一趟去问之前被闸拦下，排着的请求撤回，工具收到明确的话
  held = true; r.seen.length = 0;
  const waiting = post('/api/vision/snapshot', { project: { id: P, tracks: [] }, t: 2 });
  for (let i = 0; i < 200 && !r.seen.some(row => row.route === '/look/poll'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  allowed = false;
  await assert.rejects(waiting, /这次没看成：这条任务已经被停止/);
  for (let i = 0; i < 200 && r.look.status().queue.queued > 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(r.look.status().queue.queued, 0, '排着的那一条撤回了');
  assert.ok(r.seen.some(row => row.route === '/look/cancel'));
  assert.equal(r.client.describe().revoked, 1);
  // 一开始就没权：根本不登记
  r.seen.length = 0;
  await assert.rejects(post('/api/vision/snapshot', { project: { id: P, tracks: [] }, t: 3 }), /这次没看成：这条任务已经被停止/);
  assert.equal(r.seen.length, 0, '没有发出任何请求');
  // 文档服务一时问不到（不是没权限）：按退避再问几次；都问不到才说「确认不了」，不说成「被停止或没权限」
  let asked = 0, down = 2;
  const flaky = r.client.forProject(P, { run: RUN, instance: 'instance-task-7', authorize: async () => { asked += 1;
    if (down > 0) { down -= 1; throw Object.assign(new Error('run-authority-unavailable'), { code: 'run-authority-unavailable' }); } return { allowed: true }; } });
  held = false;
  assert.deepEqual(await flaky('/api/vision/snapshot', { project: { id: P, tracks: [] }, t: 4 }), { ok: true, frame: 1 }, '问不到两次、第三次问到了：照常出图');
  assert.ok(asked >= 3);
  down = Infinity; r.seen.length = 0;
  await assert.rejects(flaky('/api/vision/snapshot', { project: { id: P, tracks: [] }, t: 5 }), error => error.message === LOOK_CLIENT_MESSAGES.AUTHORITY_UNAVAILABLE);
  assert.equal(r.seen.length, 0, '确认不了权限时不登记');
  assert.deepEqual([r.client.describe().revoked, r.client.describe().unverified], [2, 1]);
  assert.notEqual(LOOK_CLIENT_MESSAGES.AUTHORITY_UNAVAILABLE, LOOK_CLIENT_MESSAGES.REVOKED);
  // 形状不对的绑定不收
  assert.throws(() => r.client.forProject(P, { run: { runGrantId: 'g' } }), /run 不对/);
  assert.throws(() => r.client.forProject(P, { authorize: 'yes' }), /authorize/);
});
test('RW2 渲染服务把调用方报的任务记在请求上，落盘、重启后还在；形状不对的拒', async t => {
  const dir = tmp(t); let held = true;
  const a = renderSide({ dir, hold: () => held }); t.after(() => a.close());
  const post = a.client.forProject(P, { run: RUN, instance: 'instance-task-7' });
  const pending = post('/api/vision/snapshot', { project: { id: P, tracks: [] }, t: 1 }).catch(error => error);
  for (let i = 0; i < 200 && a.requests.queued().length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const entry = a.requests.queued()[0];
  assert.deepEqual(entry.run, RUN); assert.equal(entry.owner, 'instance-task-7'); assert.equal(entry.persisted, true);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(name => name.endsWith('.req.json'))), 'utf8'));
  assert.deepEqual(saved.run, RUN);
  // 新起的一个管理进程接回这条请求，任务的归属还在
  const b = createRenderRequests({ dir }); assert.equal(b.load().restored, 1); assert.deepEqual(b.queued()[0].run, RUN);
  held = false; assert.deepEqual(await pending, { ok: true, frame: 1 });
  // 形状不对：签名是真的也拒，不登记
  const before = a.requests.stats().queued;
  for (const run of [{ runGrantId: 'g' }, { ...RUN, extra: 1 }, { ...RUN, runId: 'has space' }, 'grant_one']) {
    const text = JSON.stringify({ projectId: P, path: '/api/vision/snapshot', body: { project: { id: P, tracks: [] }, t: 1 }, requestId: `req-bad-${'x'.repeat(16)}`, run });
    const out = await a.look.handle({ auth: signLookRequest({ service: 'agent', kid: a.key.kid, priv: a.key.priv, instanceId: 'instance-task-7' }, text), bodyText: text });
    assert.deepEqual([out.status, out.body.error], [400, 'bad-request']);
  }
  assert.equal(a.requests.stats().queued, before);
});

test('RW3 任务进程的生产设置：形状、路径、写了一半的看画面与运行素材一律拒；生产入口只在 Linux 上', async () => {
  const abs = name => path.resolve(os.tmpdir(), name), pin = 'a'.repeat(64);
  const good = () => ({ v: 1, expected: {}, reservation: {}, rootRecordFile: abs('epoch-1.json'),
    identity: { keyFile: abs('i.key'), certFile: abs('i.crt'), caFile: abs('ca.crt'), port: 0 },
    doc: { origin: 'https://127.0.0.1:8443/', fingerprint256: pin, keyFile: abs('t.key'), certFile: abs('t.crt'), caFile: abs('ca.crt') },
    master: { origin: 'https://127.0.0.1:8444/', fingerprint256: pin }, journalFile: abs('j.sqlite'), dataDir: abs('data'), stateDir: abs('state') });
  assert.equal(validateWorkerSettings(good()).v, 1);
  assert.equal(validateWorkerSettings({ ...good(), look: { url: 'http://127.0.0.1:5399', keyDir: abs('keys') },
    runAssets: { origin: 'https://127.0.0.1:8445/', fingerprint256: pin, maxResponseBytes: 1024, maxImportBytes: 4096 } }).v, 1);
  const bad = (change, code) => { const value = good(); change(value); assert.throws(() => validateWorkerSettings(value), error => error.code === code, code); };
  bad(v => { delete v.master; }, 'account-worker-settings');
  bad(v => { v.extra = 1; }, 'account-worker-settings');
  bad(v => { v.dataDir = 'relative/data'; }, 'account-worker-settings');
  bad(v => { v.doc.origin = 'https://example.com/'; }, 'account-worker-settings');
  bad(v => { v.doc.origin = 'http://127.0.0.1:8443/'; }, 'account-worker-settings');
  bad(v => { v.identity.port = 70000; }, 'account-worker-settings');
  bad(v => { v.look = { url: 'http://10.0.0.1:5399', keyDir: abs('keys') }; }, 'account-worker-settings-look');
  bad(v => { v.look = { url: 'http://127.0.0.1:5399' }; }, 'account-worker-settings-look');
  bad(v => { v.runAssets = { origin: 'https://127.0.0.1:8445/', fingerprint256: pin, maxResponseBytes: 1024 }; }, 'account-worker-settings-run-assets');
  bad(v => { v.runAssets = { origin: 'https://127.0.0.1:8445/x', fingerprint256: pin, maxResponseBytes: 1024, maxImportBytes: 1 }; }, 'account-worker-settings-run-assets');
  if (process.platform !== 'linux') await assert.rejects(createWorkerConfiguration(), error => error.code === 'account-worker-linux-required');
});

test('RW4 任务范围的刷新：并着来的不互相打掉；失败的刷新不留更早的结果', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-runner-wiring-')), ledger = openAccountLedger({ file: path.join(dir, 'doc.db'), authorityId: 'doc-refresh' });
  t.after(() => { ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const m = scopeModel('slot-refresh'), docKey = pair();
  Object.assign(m.expected, { docAuthorityId: ledger.authorityId, docPublicKey: docKey.publicKey });
  let slow = 0, broken = false;
  const scope = createAgentRunScopeDoc({ ledger, signingKey: docKey.privateKey,
    slots: [{ expected: m.expected, workerServiceKid: 'worker-key', workerFingerprint256: 'b'.repeat(64) }],
    masterServiceKid: 'master-key', masterFingerprint256: 'c'.repeat(64),
    sourceFactory: () => ({ async read({ checkpoint }) {
      // 读 root 记录要一会儿（真的读端要读一串文件）
      await new Promise(resolve => setTimeout(resolve, slow));
      if (broken) throw Object.assign(new Error('agent-scope-publisher-locked'), { code: 'agent-scope-publisher-locked' });
      return inspectAgentScopeSource({ read: m.io.read, expected: m.expected, configuredAnchorDigest: digestOf(m.files.get('anchor.json')), checkpoint });
    } }) });
  await m.run('initialize');
  const ref = agentScopeRef(m.files.get('epoch-1.json'));
  // 用得着缓存结果的同步读法（登记实例时就这么读）：读得到时因为传输对不上被拒，读不到时回「来源不可用」
  const probe = () => { try { scope.registrationInState({}, { publicKey: 'x', rootScopeRef: ref,
    transport: { serviceId: 'agent', serviceKid: 'nobody', fingerprint256: 'd'.repeat(64) } }); return 'accepted'; } catch (error) { return error.code; } };
  // 一个请求刚刷新完、隔一两拍才用结果；别的请求的刷新这时正好开始。原来后一个一开始就把结果清掉，前一个读不到（503）。
  slow = 12;
  const seen = [];
  await Promise.all(Array.from({ length: 12 }, async (_unused, i) => {
    await new Promise(resolve => setTimeout(resolve, i * 3));
    await scope.refresh(ref); await null; await null; seen.push(probe());
  }));
  assert.deepEqual([...new Set(seen)], ['run-scope-worker-transport'], '每个请求刷新完都读得到结果');
  // 刷新失败：结果清掉，不留更早的
  broken = true;
  await assert.rejects(scope.refresh(ref), /publisher-locked/);
  assert.equal(probe(), 'run-scope-source-unavailable');
  broken = false; slow = 0;
  assert.equal((await scope.refresh(ref)).phase, 'ready');
  assert.equal(probe(), 'run-scope-worker-transport');
});

test('RW5 账号模式的看画面不能悄悄不过授权闸：没有 resources 构造就拒；没有这条任务的上下文这一轮不开', async t => {
  const dir = tmp(t);
  const base = { root: dir, loadModule: async () => { throw new Error('not-loaded'); }, dataDir: dir, modelConfig: async () => ({ vendor: 'mock' }),
    dataClient: { wsUrl: 'wss://127.0.0.1:1/', webSocketFor() { throw new Error('data-connection-must-not-open'); }, openCount: () => 0 } };
  const calls = [], look = { forProject(projectId, options) { calls.push({ projectId, options }); return async () => ({ ok: true }); } };
  const resources = { authorize: async () => ({ allowed: true }) };
  // 给了看画面而没有能问授权的 resources：构造时就拒（原来会照旧可用，但不过闸、不带任务号）
  assert.throws(() => createExistingHostedRunnerFactory({ ...base, look }), error => error.code === 'account-runner-look-configuration');
  assert.throws(() => createExistingHostedRunnerFactory({ ...base, look, resources: {} }), error => error.code === 'account-runner-look-configuration');
  assert.throws(() => createExistingHostedRunnerFactory({ ...base, look: {}, resources }), error => error.code === 'account-runner-look-configuration');
  // 没配看画面：不要求 resources（和原来一样）
  assert.equal(typeof createExistingHostedRunnerFactory(base), 'function');
  // 配齐了，但执行器没给这条任务的上下文、或上下文是别的任务的：这一轮不开，数据连接都不建
  const factory = createExistingHostedRunnerFactory({ ...base, look, resources });
  const grant = { projectId: 'project_one', conversationId: 'conversation_one', runId: 'run_one', runGrantId: 'grant_one', messageId: 'message_one', instanceId: 'instance-task-1', accountId: 'account_one' };
  const record = { messageId: 'message_one', runId: 'run_one', content: 'x', attachments: [] };
  const start = context => factory({ grant, record, onModelCall: async () => {}, beforeToolCall: async () => {}, context });
  await assert.rejects(start(null), error => error.code === 'look-context-unavailable');
  await assert.rejects(start({ projectId: 'project_one', runGrantId: 'grant_other' }), error => error.code === 'look-context-unavailable');
  await assert.rejects(start({ projectId: 'project_other', runGrantId: 'grant_one' }), error => error.code === 'look-context-unavailable');
  assert.equal(calls.length, 0, '没有上下文时一次看画面的绑定都没有建');
});

test('RW6 账号模式的看画面要显式开关：缺省忽略地址；开了而没有地址或读不到私钥就拒绝启动', () => {
  const url = 'http://127.0.0.1:5399', good = { service: 'agent', kid: 'k', priv: 'p', instanceId: 'i' };
  const reads = [], readKey = dir => { reads.push(dir); return good; };
  // 缺省（部署模板固定写着地址）：不接，也不去读私钥——行为和没有这项功能时一样
  assert.equal(resolveAccountLook({ env: { PROMPTCUT_AGENT_LOOK_URL: url }, lookUrl: url, readKey }), null);
  assert.equal(resolveAccountLook({ env: { PROMPTCUT_AGENT_ACCOUNT_LOOK: '0' }, lookUrl: url, readKey }), null);
  assert.equal(resolveAccountLook({ env: {}, lookUrl: null, readKey }), null);
  assert.equal(reads.length, 0);
  // 开了：回签名用的私钥，私钥目录取配置的那一个
  assert.equal(resolveAccountLook({ env: { PROMPTCUT_AGENT_ACCOUNT_LOOK: '1', PROMPTCUT_AGENT_SECRETS: '/x/secrets' }, lookUrl: url, readKey }), good);
  assert.deepEqual(reads, ['/x/secrets']);
  // 开了而条件不齐：拒绝，原因码分得清
  const reason = fn => { try { fn(); } catch (error) { return error.reason; } return 'not-rejected'; };
  assert.equal(reason(() => resolveAccountLook({ env: { PROMPTCUT_AGENT_ACCOUNT_LOOK: '1' }, lookUrl: null, readKey })), 'account-look');
  assert.equal(reason(() => resolveAccountLook({ env: { PROMPTCUT_AGENT_ACCOUNT_LOOK: 'yes' }, lookUrl: url, readKey })), 'account-look');
  assert.equal(reason(() => resolveAccountLook({ env: { PROMPTCUT_AGENT_ACCOUNT_LOOK: '1' }, lookUrl: url, readKey: () => { throw new Error('ENOENT'); } })), 'look-key');
  assert.equal(reason(() => resolveAccountLook({ env: { PROMPTCUT_AGENT_ACCOUNT_LOOK: '1' }, lookUrl: url, readKey: () => ({ ...good, service: 'render' }) })), 'look-key');
});

test('RW7 导入的额度：一次导入只看一次目录、之后只累计；工作目录里已有的文件不按两份算；现生成的字节照额度算', async t => {
  let scans = 0, room = 1000;
  const r = createImportReservation(() => ({ room() { scans += 1; return room; } }));
  const quota = fn => { try { fn(); } catch (error) { return error.workspace === true ? error.code : `other:${error.message}`; } return 'ok'; };
  // 现生成的字节（不知道大小）：分一百块，目录只看了一次；累计超过剩余额度的那一块被拒
  await r.run({}, async () => {
    for (let i = 0; i < 100; i++) { await null; assert.equal(quota(() => r.reserve(10)), 'ok'); }
    assert.equal(quota(() => r.reserve(1)), 'quota');
  });
  assert.equal(scans, 1, '一百多块只扫了一次目录');
  // 知道大小而放不下：第一块就拒，不白写
  scans = 0;
  await r.run({ size: 1001 }, async () => { assert.equal(quota(() => r.reserve(10)), 'quota'); });
  assert.equal(scans, 1);
  // 来源本来就在工作目录里：不再按额度算第二遍（剩余额度比文件小也导得了），目录一次都不用看；中途变大就拒
  scans = 0; room = 10;
  await r.run({ inWorkspace: true, size: 600 }, async () => {
    for (let i = 0; i < 6; i++) assert.equal(quota(() => r.reserve(100)), 'ok');
    assert.equal(quota(() => r.reserve(1)), 'quota');
  });
  assert.equal(scans, 0);
  // 两次导入并着来，各记各的
  room = 100;
  await Promise.all([r.run({}, async () => { await null; r.reserve(60); await null; assert.equal(quota(() => r.reserve(60)), 'quota'); }),
    r.run({}, async () => { r.reserve(60); await null; await null; assert.equal(quota(() => r.reserve(30)), 'ok'); })]);
  assert.equal(quota(() => r.reserve(-1)), 'bad-path');
  // 真的工作目录：room() 回的是单文件上限、对话与项目剩余额度里最小的那个；文件数到上限抛 quota
  const dir = tmp(t), ws = createWorkspaces({ dataDir: dir, limits: { maxFileBytes: 500, maxConversationBytes: 300, maxProjectBytes: 10_000, maxFiles: 3 } })
    .open({ projectId: 'project_one', ownerKey: 'a'.repeat(32), conversationId: 'conversation_one' });
  assert.equal(ws.room(), 300); ws.write('attachments/a.bin', Buffer.alloc(120)); assert.equal(ws.room(), 180);
  ws.write('b.bin', Buffer.alloc(1)); ws.write('c.bin', Buffer.alloc(1));
  assert.throws(() => ws.room(), error => error.workspace === true && error.code === 'quota');
});

test('RW8 导入重试用同一个请求号（接着传已收到的片，不在素材服务上另开暂存目录）', async () => {
  const seen = [], waits = [], retried = [];
  const unavailable = () => Object.assign(new Error('run-asset-unavailable'), { status: 503, code: 'run-asset-unavailable' });
  const out = await runAssetImportWithRetry(async requestId => { seen.push(requestId); if (seen.length < 3) throw unavailable(); return { stored: true }; },
    { sleep: async ms => { waits.push(ms); }, onRetry: row => retried.push(row) });
  assert.deepEqual(out, { stored: true });
  assert.equal(seen.length, 3); assert.equal(new Set(seen).size, 1, '三次用的是同一个请求号'); assert.match(seen[0], /^import-[0-9a-f-]{36}$/);
  assert.deepEqual(waits, [500, 1000]); assert.deepEqual(retried.map(row => [row.code, row.attempt]), [['run-asset-unavailable', 1], ['run-asset-unavailable', 2]]);
  // 另一次导入是另一个请求号
  const other = []; await runAssetImportWithRetry(async requestId => { other.push(requestId); return {}; });
  assert.notEqual(other[0], seen[0]);
  // 三次都不成：把最后那个错原样抛出
  let calls = 0;
  await assert.rejects(runAssetImportWithRetry(async () => { calls += 1; throw unavailable(); }, { sleep: async () => {} }), error => error.code === 'run-asset-unavailable');
  assert.equal(calls, 3);
});

test('RW9 导入只重试确属暂时性的错：任务被停、配置不对、额度不够这类 503 不白等一轮', async () => {
  const run = async error => { let calls = 0; const waits = [];
    const outcome = await runAssetImportWithRetry(async () => { calls += 1; throw error; }, { sleep: async ms => { waits.push(ms); } }).then(() => 'ok', e => e.code);
    return { calls, waits: waits.length, outcome }; };
  const e = (code, status = 503, extra = {}) => Object.assign(new Error(code), { code, status, ...extra });
  // 不重试：一次就原样抛出
  for (const error of [e('project-assets-closed'), e('project-assets-workspace-unconfigured'), e('project-assets-unconfigured'), e('run-assets-unconfigured'),
    e('asset-run-recovery-pending'), e('run-revoked', 403), e('ticket-expired', 401), e('asset-hash-mismatch', 409), e('quota', undefined, { workspace: true }),
    e('some-new-503-nobody-listed')])
    assert.deepEqual(await run(error), { calls: 1, waits: 0, outcome: error.code }, error.code);
  // 重试：连不上、还在对账
  for (const code of ['run-asset-unavailable', 'run-client-unavailable', 'asset-run-head-pending', 'asset-run-not-ready', 'doc-agent-unavailable'])
    assert.deepEqual(await run(e(code)), { calls: 3, waits: 2, outcome: code }, code);
  // 没有状态码、只有错误码的那一种（问授权时文档服务不通）也算
  assert.deepEqual(await run(Object.assign(new Error('run-authority-unavailable'), { code: 'run-authority-unavailable' })), { calls: 3, waits: 2, outcome: 'run-authority-unavailable' });
});
