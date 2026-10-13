import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAccountMasterAssembly } from '../agent-service/account-master-assembly.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { freePorts } from './free-ports.mjs';

// 账号版主服务启动时文档服务还没起来：它要等（隔一会儿再去登记），不能自己退出。
// 等的这段时间它还没有任何监听口（公开口在装配好以后才开），所以等待用的定时器必须拉得住进程；
// 否则它会在第一次登记失败后以退出码 0 退出。
const here = path.dirname(fileURLToPath(import.meta.url));
const main = path.resolve(here, '..', 'agent-service', 'main.mjs');

test('真的把主服务的命令行入口跑起来、文档服务不在：六秒以后进程还活着、还在隔一会儿去登记一次，没有装作起来了', { timeout: 60_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-master-startup-'));
  const pki = assetWiringPki(dir), shared = path.join(dir, 'shared'); fs.mkdirSync(shared);
  for (const field of ['key', 'cert', 'ca']) fs.writeFileSync(path.join(dir, `master.${field}`), pki.account[field]);
  const [publicPort, internalPort, docPort] = await freePorts(3);   // docPort 上没有人在听
  const env = { ...process.env, PROMPTCUT_AGENT_DATA: dir, PROMPTCUT_AGENT_DOC_URL: `wss://127.0.0.1:${docPort}/`,
    PROMPTCUT_AGENT_PORT: String(publicPort), PROMPTCUT_ACCOUNT_V2: '1', PROMPTCUT_ACCOUNT_V2_REQUIRED: '1',
    PROMPTCUT_AGENT_DOC_INTERNAL_ORIGIN: `https://127.0.0.1:${docPort}`, PROMPTCUT_AGENT_DOC_FINGERPRINT256: pki.doc.fingerprint256,
    PROMPTCUT_AGENT_CLIENT_KEY_FILE: path.join(dir, 'master.key'), PROMPTCUT_AGENT_CLIENT_CERT_FILE: path.join(dir, 'master.cert'),
    PROMPTCUT_AGENT_CA_FILE: path.join(dir, 'master.ca'), PROMPTCUT_AGENT_INTERNAL_PORT: String(internalPort),
    PROMPTCUT_AGENT_ROOT_FINGERPRINT256: pki.asset.fingerprint256, PROMPTCUT_AGENT_SHARED_DATA: shared };
  for (const name of ['PROMPTCUT_AGENT_CONTROL_PORT', 'PROMPTCUT_AGENT_ACCOUNT_LOOK', 'PROMPTCUT_AGENT_RUN_ASSET_ORIGIN', 'PROMPTCUT_AGENT_RUN_ASSET_FINGERPRINT256',
    'PROMPTCUT_AGENT_RUN_ASSET_MAX_IMPORT_BYTES', 'NODE_TEST_CONTEXT']) delete env[name];
  const child = spawn(process.execPath, [main], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '', errors = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', text => { output += text; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { errors += text; });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; fs.rmSync(dir, { recursive: true, force: true }); });
  const count = event => output.split('\n').filter(text => text.includes(`"event":"${event}"`)).length;
  const started = Date.now();
  while (count('agent.master.pending') === 0) {
    assert.equal(child.exitCode, null, `主服务没等就退出了（退出码 ${child.exitCode}）：${output.slice(-300)} ${errors.slice(-300)}`);
    assert.ok(Date.now() - started < 30_000, '30 秒内没有看到第一次登记失败');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await new Promise(resolve => setTimeout(resolve, 6_500));
  assert.equal(child.exitCode, null, `文档服务不在时主服务自己退出了（退出码 ${child.exitCode}）`);
  assert.ok(count('agent.master.pending') >= 3, `六秒里隔一会儿去登记一次，至少三次，实际 ${count('agent.master.pending')}`);
  assert.equal(count('agent.ready'), 0, '没登记上就不说自己起来了'); assert.equal(count('agent.listen'), 0, '公开口也还没开');
  assert.equal(count('config.error'), 0, '文档服务一时不在不是配置错');
  t.diagnostic(`等了 ${Date.now() - started} 毫秒，登记失败 ${count('agent.master.pending')} 次，进程 ${child.pid} 仍在`);
});

test('文档服务先不在、过一会儿才起来：主服务装配等得到，登记上以后照常装好', { timeout: 60_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-master-wait-'));
  const pki = assetWiringPki(dir), shared = path.join(dir, 'shared'); fs.mkdirSync(shared);
  let attempts = 0, registered = null, readControlStarted = 0;
  const transports = { run: async (_req, _res, fn) => fn(), dispatch: fn => fn() };
  const stub = async () => { throw Object.assign(new Error('unused'), { status: 503 }); };
  const conversationClient = { readTransports: transports, ...Object.fromEntries(['identity', 'access', 'list', 'get', 'send', 'switchVisibility', 'stop', 'rename'].map(name => [name, stub])) };
  const runClient = {
    // 前三次文档服务连不上（503），第四次才登记上
    async registerInstance() { attempts += 1;
      if (attempts <= 3) throw Object.assign(new Error('run-client-unavailable'), { status: 503, code: 'run-client-unavailable' });
      registered = { instanceId: 'master-instance', instanceGeneration: 1 }; return registered; },
    instanceIdentity: () => (registered ? { ...registered, purpose: 'control-only', authorityId: 'doc-authority' } : null),
    pending: stub, scopeControl: stub, workerEventSource: stub };
  const log = [];
  const startedAt = Date.now();
  const assembly = await createAccountMasterAssembly({ dataDir: dir, sharedDataDir: shared, runClient, conversationClient, tls: pki.account, internalPort: 0,
    readControl: { transports, async start() { readControlStarted += 1; }, async close() {} }, controllerFingerprint256: pki.asset.fingerprint256,
    registerRetryMs: 300, log: (event, fields) => log.push([event, fields.code ?? null]) });
  t.after(async () => { await assembly.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(attempts, 4); assert.ok(Date.now() - startedAt >= 850, '三次失败之间各等了一会儿');
  assert.deepEqual(log.filter(([event]) => event.startsWith('agent.master.')).map(([event, code]) => `${event}:${code}`),
    ['agent.master.pending:run-client-unavailable', 'agent.master.pending:run-client-unavailable', 'agent.master.pending:run-client-unavailable', 'agent.master.registered:null']);
  assert.equal(assembly.describe().registered, true); assert.ok(assembly.internalPort > 0);
  assert.equal(readControlStarted, 1);
  assert.ok(fs.existsSync(path.join(dir, 'master-run-events.sqlite')), '登记上以后才建事件库（它钉在文档服务的权威号上）');
  // 文档服务明确不认这个身份（403）或者登记出来的不是只做控制的身份：那是配置错，不等，直接拒
  await assert.rejects(createAccountMasterAssembly({ dataDir: dir, sharedDataDir: shared, conversationClient, tls: pki.account, internalPort: 0,
    readControl: { transports, async start() {}, async close() {} }, controllerFingerprint256: pki.asset.fingerprint256, registerRetryMs: 300,
    runClient: { ...runClient, async registerInstance() { throw Object.assign(new Error('run-service-forbidden'), { status: 403, code: 'run-service-forbidden' }); } } }),
    { code: 'run-service-forbidden' });
  await assert.rejects(createAccountMasterAssembly({ dataDir: dir, sharedDataDir: shared, conversationClient, tls: pki.account, internalPort: 0,
    readControl: { transports, async start() {}, async close() {} }, controllerFingerprint256: pki.asset.fingerprint256, registerRetryMs: 300,
    runClient: { ...runClient, async registerInstance() { return { instanceId: 'x', instanceGeneration: 1 }; }, instanceIdentity: () => ({ purpose: 'run-worker', authorityId: 'doc-authority' }) } }),
    { code: 'account-master-purpose' });
});
