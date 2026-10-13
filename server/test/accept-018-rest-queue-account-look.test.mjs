/**
 * 0.7.18 验收 RS18-queue 的一处缺口:账号模式下云端 Agent 有没有接上「看画面」(排队就是给它用的)。
 * 跑:npm test -- server/test/accept-018-rest-queue-account-look.test.mjs
 *
 * 块八「云端排队」(0ec8c7cd)把看画面的请求做成持久队列,但它的调用方(`server/agent-service/look-client.mjs`)原先在
 * `server/agent-service/main.mjs` 里只在「不是账号模式」时才创建,账号模式拿不到 `look`。现在改成账号版要显式开关
 * `PROMPTCUT_AGENT_ACCOUNT_LOOK=1` 才接(缺省不接,因为部署模板固定写着看画面地址而渲染服务还看不到账号项目;
 * 见 main.mjs 文件头与 `resolveAccountLook()`)。本文件把这个现状固定成两条硬断言:
 *
 *   Q-ACC-1a 开关开(= 1):账号模式回签名用的服务私钥,看画面客户端接上
 *   Q-ACC-1b 缺省(不设或 0):账号模式不接,也不去读私钥,哪怕看画面地址设了
 *   Q-ACC-2  接线在哪:账号版的主服务(main.mjs 的命令行入口)只做控制、不跑任务,所以它自己不接看画面(lookOn 在账号模式恒为假);
 *            看画面由任务进程接——root 入口的配置里写了 `worker.look`,就随每一代任务进程的设置下发,任务进程凭设置建看画面客户端。
 *            (2026-10-13 生产入口那一块改的:原来这一条钉的是「main.mjs 的 lookOn 在账号模式看开关回的私钥」,那是在主进程里跑任务的旧路。)
 *
 * 端到端的判据(账号模式的 Agent 服务起来后 see_frames 能经队列拿到图)要等接线合入后补一支探针。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAccountLook } from '../agent-service/main.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'server/agent-service/main.mjs'), 'utf8');
const createLine = mainSrc.split('\n').find((l) => l.includes('createLookClient({'));

test('Q-ACC-2 账号版看画面的接线:主服务自己不接(它不跑任务);root 入口的配置写了就随任务进程的设置下发,任务进程凭设置建客户端', async () => {
  // 旧模式那一行还在,仍受 lookOn 管
  assert.ok(createLine, 'main.mjs 里应有 createLookClient({ … }) 的调用');
  assert.match(createLine, /look:\s*createLookClient\(/);
  assert.match(createLine, /lookOn\s*\?/, `创建看画面客户端要受 lookOn 管:${createLine.trim()}`);
  // 账号版的主服务不接
  assert.match(mainSrc, /const lookOn = accountMode \? false : !!lookUrl;/, '账号版主服务不跑任务,自己不接看画面');
  // 任务进程:设置里写了 look 就建客户端(读不到私钥拒绝启动);root 入口把配置里的 worker.look 原样写进每一代的设置
  const workerSrc = fs.readFileSync(path.join(ROOT, 'server/agent-service/account-task-worker-config.mjs'), 'utf8');
  assert.match(workerSrc, /look = createLookClient\(\{ url: settings\.look\.url, key,/);
  const { workerSettingsFor } = await import('../agent-service/account-root-slots.mjs');
  const { scopeModel } = await import('./agent-run-scope-fixture.mjs');
  const m = scopeModel('slot-look'); await m.run('initialize');
  const slot = { workerSettingsFile: '/etc/promptcut/agent-slots/slot-look/worker-settings.json', identity: { keyFile: '/k', certFile: '/c', caFile: '/a' },
    publisher: { expected: m.expected, registryDir: '/var/lib/promptcut/agent-root/slot-look', identity: { origin: 'https://127.0.0.1:8801/' } } };
  const base = { master: { origin: 'https://127.0.0.1:8792/', fingerprint256: 'a'.repeat(64) },
    worker: { doc: { origin: 'https://127.0.0.1:8789/', fingerprint256: 'b'.repeat(64), keyFile: '/k', certFile: '/c', caFile: '/a' }, dataDir: '/data', stateRoot: '/state' } };
  const reservation = m.files.get('reservation-1.json');
  assert.equal(workerSettingsFor({ config: base, slot, reservation }).look, undefined, '没写就不接');
  const look = { url: URL_, keyDir: '/var/lib/promptcut/agent-secrets' };
  assert.deepEqual(workerSettingsFor({ config: { ...base, worker: { ...base.worker, look } }, slot, reservation }).look, look, '写了就下发给任务进程');
});

const URL_ = 'http://127.0.0.1:5399';
const KEY = { service: 'agent', kid: 'k1', priv: 'priv-for-test' };

test('Q-ACC-1a 开关开(PROMPTCUT_AGENT_ACCOUNT_LOOK=1):账号模式接上看画面,签名用的是 PROMPTCUT_AGENT_SECRETS 里的服务私钥', () => {
  const reads = [];
  const key = resolveAccountLook({ env: { PROMPTCUT_AGENT_ACCOUNT_LOOK: '1', PROMPTCUT_AGENT_SECRETS: '/x/secrets' }, lookUrl: URL_, readKey: dir => { reads.push(dir); return KEY; } });
  assert.equal(key, KEY, '回了私钥 = main.mjs 里 lookOn 为真 = 创建看画面客户端');
  assert.deepEqual(reads, ['/x/secrets']);
});

test('Q-ACC-1b 缺省(不设或 0):账号模式不接看画面,也不去读私钥,哪怕看画面地址设了', () => {
  const reads = [];
  const readKey = dir => { reads.push(dir); return KEY; };
  assert.equal(resolveAccountLook({ env: { PROMPTCUT_AGENT_LOOK_URL: URL_ }, lookUrl: URL_, readKey }), null);
  assert.equal(resolveAccountLook({ env: { PROMPTCUT_AGENT_ACCOUNT_LOOK: '0' }, lookUrl: URL_, readKey }), null);
  assert.deepEqual(reads, [], '缺省时不读私钥');
});
