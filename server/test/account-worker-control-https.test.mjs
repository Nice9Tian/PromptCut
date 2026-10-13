import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAccountWorkerHttpsGateway, createWorkerControlClient, WORKER_SCOPE_HEADERS } from '../agent-service/account-worker-control-client.mjs';
import { createAccountTaskWorker } from '../agent-service/account-task-worker.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { scopeModel } from './agent-run-scope-fixture.mjs';
import { certificateFingerprint } from '../account/client.mjs';
import { freePort } from './free-ports.mjs';

// 调度方到任务进程的指令通道（本机 HTTPS 那一种）：任务进程不带父子通道也能起、能收指令、能报结算结果。
// 这里没有文档服务、也没有 root 的记录，所以领取一定被拒——验的是通道本身和它的闸，不是任务。
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', 'agent-service', 'account-task-worker-cli.mjs');
const raw = (port, tls, { method = 'GET', route, body, headers = {} }) => new Promise((resolve, reject) => {
  const text = body === undefined ? null : JSON.stringify(body);
  const req = https.request(`https://127.0.0.1:${port}${route}`, { ...tls, method, agent: false, rejectUnauthorized: true, timeout: 5000,
    headers: { connection: 'close', ...(text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}), ...headers } }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
    res.once('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
  });
  req.on('error', reject); req.on('timeout', () => req.destroy(Error('raw-timeout'))); req.end(text ?? undefined);
});
/** 这一代是哪个槽、第几代、哪个实例（root 的预留里写的）；指令要带着它 */
const scopeOf = model => ({ slotId: model.expected.slotId, epoch: 1, instanceId: model.files.get('reservation-1.json').instanceId });
const scopeHeaders = scope => ({ [WORKER_SCOPE_HEADERS.slotId]: scope.slotId, [WORKER_SCOPE_HEADERS.epoch]: String(scope.epoch), [WORKER_SCOPE_HEADERS.instanceId]: scope.instanceId });
function environment(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pc-worker-https-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pki = assetWiringPki(dir), model = scopeModel(name);
  return { dir, pki, model };
}
async function childConfig(env, port, { settlementMarker = null } = {}) {
  const { dir, pki, model } = env; await model.run('initialize');
  model.expected.clientFingerprint256 = certificateFingerprint(pki.account.fingerprint256);
  model.expected.serverFingerprint256 = certificateFingerprint(pki.asset.fingerprint256);
  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ expected: model.expected, reservation: model.files.get('reservation-1.json') }), { mode: 0o600 });
  const configurationModule = path.join(dir, 'worker-config.mjs');
  fs.writeFileSync(configurationModule, `import fs from 'node:fs';
const dir=${JSON.stringify(dir)}, settings=${JSON.stringify(settings)};
const tls=name=>({key:fs.readFileSync(dir+'/'+name+'.key'),cert:fs.readFileSync(dir+'/'+name+'.crt'),ca:fs.readFileSync(dir+'/ca.crt')});
export function createWorkerConfiguration(){const s=JSON.parse(fs.readFileSync(settings));return {listener:{host:'127.0.0.1',port:${port}},workerOptions:{
expected:s.expected,reservation:s.reservation,identityTls:tls('asset'),
doc:{origin:'https://127.0.0.1:9',tls:tls('wrong'),serverFingerprint256:${JSON.stringify(pki.doc.fingerprint256)}},
readRootRecord:async()=>{${settlementMarker ? `fs.writeFileSync(${JSON.stringify(settlementMarker)},'asked');` : ''}throw Object.assign(Error('root ready missing'),{status:503,code:'root-ready-missing'});},
createAssemblyOptions:async()=>{throw Object.assign(Error('must not execute'),{code:'model-must-not-start'});},
// 配置模块想自己关掉或换掉指令通道都不行：开不开只由入口的起法定
control:{onClose(){throw new Error('configuration must not own the control channel');}}
}};}`, { mode: 0o600 });
  return { configurationModule, serverFingerprint256: model.expected.serverFingerprint256, scope: scopeOf(model) };
}

test('任务子进程不带父子通道：领取、开跑、收尾、结算结果都走只认 root 证书的本机 HTTPS 口', { timeout: 60_000 }, async t => {
  const env = environment(t, 'https'), port = await freePort();
  const { configurationModule, serverFingerprint256, scope } = await childConfig(env, port);
  const gateway = createAccountWorkerHttpsGateway({ configurationModule, cwd: here, timeoutMs: 15_000, port,
    controllerTls: env.pki.account, serverFingerprint256, settlementWaitMs: 500, scope });
  const mine = scopeHeaders(scope);
  t.after(async () => { await gateway.terminate().catch(() => {}); });
  const ready = await gateway.ready;
  assert.notEqual(ready.pid, process.pid); assert.equal(ready.pid, gateway.pid()); assert.equal(ready.port, port);

  // 身份口回的是 root 发布器读的那个形状
  const identity = await raw(port, env.pki.account, { route: '/internal/v2/agent/run-scope/identity' });
  assert.equal(identity.status, 200); assert.equal(identity.body.ok, true); assert.equal(identity.body.result.pid, ready.pid);
  assert.equal(identity.body.result.instanceId, env.model.files.get('reservation-1.json').instanceId);

  // 不是 root 那张证书：身份和四条指令一律 403，什么都不做
  for (const request of [{ route: '/internal/v2/agent/run-scope/identity' },
    { method: 'POST', route: '/internal/v2/agent/run-scope/control/prepare', body: { projectId: 'p', conversationId: 'c', requestId: 'r' } },
    { method: 'POST', route: '/internal/v2/agent/run-scope/control/start', body: {} },
    { method: 'POST', route: '/internal/v2/agent/run-scope/control/close', body: {} },
    { route: '/internal/v2/agent/run-scope/control/settlement?waitMs=10' }]) {
    const answer = await raw(port, env.pki.wrong, request);
    assert.equal(answer.status, 403, request.route); assert.equal(answer.body.code, 'account-worker-controller-forbidden');
  }
  // 经过反向代理转来的（带转发头）也不认，哪怕证书对
  const forwarded = await raw(port, env.pki.account, { method: 'POST', route: '/internal/v2/agent/run-scope/control/start', body: {}, headers: { ...mine, 'x-forwarded-for': '127.0.0.1' } });
  assert.equal(forwarded.status, 403);
  // 不认识的指令、带查询串的指令：没有这条路
  assert.equal((await raw(port, env.pki.account, { method: 'POST', route: '/internal/v2/agent/run-scope/control/assign', body: {} })).status, 404);
  assert.equal((await raw(port, env.pki.account, { method: 'POST', route: '/internal/v2/agent/run-scope/control/start?x=1', body: {} })).status, 404);
  assert.equal(gateway.describe().childClosed, false, '被拒的请求不影响进程');

  // 没领取就开跑：拒；领取时读不到 root 的记录：原因码原样带回；指令里夹带授权号：拒
  await assert.rejects(gateway.start(), { code: 'account-worker-not-prepared' });
  await assert.rejects(gateway.prepare({ projectId: 'project', conversationId: 'conversation-child', requestId: 'one' }), { code: 'root-ready-missing' });
  await assert.rejects(gateway.prepare({ projectId: 'project', conversationId: 'conversation-child', requestId: 'one', runGrantId: 'master-grant' }), { code: 'account-worker-task' });
  // 开跑的请求体不是空对象：拒
  assert.equal((await raw(port, env.pki.account, { method: 'POST', route: '/internal/v2/agent/run-scope/control/start', body: { grant: 'x' }, headers: mine })).body.code, 'account-worker-command');

  // 指令要写明是给哪个槽、第几代、哪个实例的：没写、写的是别的一代、别的实例、别的槽，一律不做，回应里带着这一代自己是谁
  for (const headers of [{}, { ...mine, [WORKER_SCOPE_HEADERS.epoch]: '2' }, { ...mine, [WORKER_SCOPE_HEADERS.instanceId]: 'another-instance' },
    { ...mine, [WORKER_SCOPE_HEADERS.slotId]: 'another-slot' }]) {
    for (const request of [{ method: 'POST', route: '/internal/v2/agent/run-scope/control/close', body: {} }, { route: '/internal/v2/agent/run-scope/control/settlement?waitMs=10' },
      { method: 'POST', route: '/internal/v2/agent/run-scope/control/prepare', body: { projectId: 'project', conversationId: 'conversation-child', requestId: 'one' } }]) {
      const answer = await raw(port, env.pki.account, { ...request, headers });
      assert.equal(answer.status, 409, JSON.stringify(headers)); assert.deepEqual(answer.body, { ok: false, code: 'account-worker-scope-mismatch', scope });
    }
  }
  assert.equal(gateway.describe().childClosed, false, '写错代号的「收尾」没有把进程收掉');
  // 上一代的调度方（代号差一）拿着同一张证书来问：任务进程不做，客户端也不认它的回应
  const stale = createWorkerControlClient({ origin: `https://127.0.0.1:${port}`, tls: env.pki.account, serverFingerprint256, timeoutMs: 5000, scope: { ...scope, epoch: 2 } });
  await assert.rejects(stale.close(), { code: 'worker-control-scope-mismatch' }); await assert.rejects(stale.start(), { code: 'worker-control-scope-mismatch' });
  stale.stop(); assert.equal(gateway.describe().childClosed, false);

  // 结算结果：没有就回「还没有」，不编
  const pending = await raw(port, env.pki.account, { route: '/internal/v2/agent/run-scope/control/settlement?waitMs=50', headers: mine });
  assert.deepEqual(pending.body, { ok: true, result: { settled: false }, scope });
  let settled = false; void gateway.settlement.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(settled, false, '长挂到时限以后接着问，不把「还没有」当成结果');

  // 收尾：进程自己收完退出（退出码 0）；这只是这个子进程的退出，不是关闭证明
  const closed = await gateway.close();
  assert.equal(closed.childClosed, true); assert.equal(closed.exitCode, 0); assert.equal(closed.rootClosureProved, false);
  assert.deepEqual(await gateway.settlement, { kind: 'closed' }, '进程没了、又没报过结果：通道如实说「已关」，不说放弃也不说做完');
  await assert.rejects(gateway.prepare({ projectId: 'project', conversationId: 'conversation-child', requestId: 'two' }));
  assert.equal(gateway.describe().pendingCommands, 0); assert.equal(gateway.describe().completionReady, false);
});

test('指令通道本身：收尾的回应先到、进程没了以后结算结果说「已关」；没开通道的任务进程四条路都不存在', { timeout: 60_000 }, async t => {
  // 进程内直接起一个任务进程对象（不起子进程），看结算结果这一条本身
  const env = environment(t, 'settle'); await env.model.run('initialize');
  env.model.expected.clientFingerprint256 = certificateFingerprint(env.pki.account.fingerprint256);
  env.model.expected.serverFingerprint256 = certificateFingerprint(env.pki.asset.fingerprint256);
  let closeAsked = 0;
  const worker = createAccountTaskWorker({ expected: env.model.expected, reservation: env.model.files.get('reservation-1.json'), identityTls: env.pki.asset,
    doc: { origin: 'https://127.0.0.1:9', tls: env.pki.wrong, serverFingerprint256: env.pki.doc.fingerprint256 },
    readRootRecord: async () => { throw Object.assign(Error('root ready missing'), { status: 503, code: 'root-ready-missing' }); },
    control: { onClose: () => { closeAsked += 1; }, settlementWaitMs: 300 } });
  const { port } = await worker.listen({ port: 0 });
  const client = createWorkerControlClient({ origin: `https://127.0.0.1:${port}`, tls: env.pki.account,
    serverFingerprint256: env.model.expected.serverFingerprint256, timeoutMs: 5000, settlementWaitMs: 300, scope: scopeOf(env.model) });
  // 客户端必须知道自己连的是哪一代
  assert.throws(() => createWorkerControlClient({ origin: `https://127.0.0.1:${port}`, tls: env.pki.account, serverFingerprint256: env.model.expected.serverFingerprint256 }), { code: 'worker-control-configuration' });
  assert.throws(() => createWorkerControlClient({ origin: `https://127.0.0.1:${port}`, tls: env.pki.account, serverFingerprint256: env.model.expected.serverFingerprint256,
    scope: { slotId: 'slot', epoch: 0, instanceId: 'x' } }), { code: 'worker-control-configuration' });
  let gone = false;
  const settlement = client.settlement({ gone: () => gone });
  assert.equal(client.settlement({ gone: () => true }), settlement, '同一个客户端只开一条');
  // 收尾指令：回应先到，入口给的回调随后被叫一次；这个回应不说明进程已退出
  assert.deepEqual(await client.close(), { stopping: true, completionReady: false });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(closeAsked, 1);
  // 任务进程对象自己收掉：它把结算记成「放弃」。长挂的那条连接被它关了，客户端重连时进程已经不在
  gone = true; await worker.close();
  assert.deepEqual(await settlement, { kind: 'closed' });
  client.stop();
  // 没开指令通道的任务进程对象：四条路都不存在（原来的行为）
  const plain = createAccountTaskWorker({ expected: env.model.expected, reservation: env.model.files.get('reservation-1.json'), identityTls: env.pki.asset,
    doc: { origin: 'https://127.0.0.1:9', tls: env.pki.wrong, serverFingerprint256: env.pki.doc.fingerprint256 },
    readRootRecord: async () => { throw new Error('unused'); } });
  const plainPort = (await plain.listen({ port: 0 })).port;
  try {
    assert.equal((await raw(plainPort, env.pki.account, { method: 'POST', route: '/internal/v2/agent/run-scope/control/start', body: {} })).status, 404);
    assert.equal((await raw(plainPort, env.pki.account, { route: '/internal/v2/agent/run-scope/control/settlement' })).status, 404);
    assert.equal((await raw(plainPort, env.pki.account, { route: '/internal/v2/agent/run-scope/identity' })).status, 200);
  } finally { await plain.close(); }
  assert.throws(() => createAccountTaskWorker({ expected: env.model.expected, reservation: env.model.files.get('reservation-1.json'), identityTls: env.pki.asset,
    doc: { origin: 'https://127.0.0.1:9', tls: env.pki.wrong, serverFingerprint256: env.pki.doc.fingerprint256 },
    readRootRecord: async () => {}, control: {} }), { code: 'account-worker-control-configuration' });
});

test('入口的起法：没有父子通道又没写 --control https 直接退出；配置起不来时原因码写到标准错误、退出码 1', { timeout: 60_000 }, async t => {
  const env = environment(t, 'entry');
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: here, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    child.once('close', code => resolve({ code, out, err }));
  });
  const missing = path.join(env.dir, 'no-such-config.mjs');
  // 父子通道那一种起法，但其实没有父进程通道
  assert.equal((await run(['--configuration-module', missing])).code, 1);
  // HTTPS 那一种：配置模块不存在
  const failed = await run(['--configuration-module', missing, '--control', 'https']);
  assert.equal(failed.code, 1); assert.equal(failed.out, '');
  assert.equal(JSON.parse(failed.err.trim().split('\n').at(-1)).ok, false);
  // 路径不是绝对路径、--control 后面不是 https
  assert.equal(JSON.parse((await run(['--configuration-module', 'relative.mjs', '--control', 'https'])).err.trim().split('\n').at(-1)).code, 'account-worker-entry-configuration');
  assert.equal((await run(['--configuration-module', missing, '--control', 'http'])).code, 1);
  // 起不来时网关把入口报的原因码带给调用方
  const port = await freePort();
  const anyScope = { slotId: 'slot-entry', epoch: 1, instanceId: 'instance-entry' };
  const gateway = createAccountWorkerHttpsGateway({ configurationModule: missing, cwd: here, timeoutMs: 15_000, port,
    controllerTls: env.pki.account, serverFingerprint256: certificateFingerprint(env.pki.asset.fingerprint256), scope: anyScope });
  await assert.rejects(gateway.ready);
  assert.equal((await gateway.closed).exitCode, 1);
  assert.deepEqual(await gateway.settlement, { kind: 'closed' });
  assert.throws(() => createAccountWorkerHttpsGateway({ configurationModule: missing, cwd: here, port: 0, controllerTls: env.pki.account,
    serverFingerprint256: certificateFingerprint(env.pki.asset.fingerprint256), scope: anyScope }), { code: 'worker-gateway-configuration' });
  assert.throws(() => createAccountWorkerHttpsGateway({ configurationModule: missing, cwd: here, port, controllerTls: env.pki.account,
    serverFingerprint256: certificateFingerprint(env.pki.asset.fingerprint256) }), { code: 'worker-control-configuration' }, '网关也必须知道子进程是哪一代');
});
