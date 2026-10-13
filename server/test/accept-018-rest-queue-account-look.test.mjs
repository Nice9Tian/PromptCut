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
 *   Q-ACC-2  自检:这条静态检查确实找得到创建那一行,且它受 lookOn 管(找不到就是 main.mjs 改了写法,这条测试要跟着改)
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

test('Q-ACC-2 自检:找得到创建看画面客户端的那一行,且它受「lookOn」管;lookOn 在账号模式下看开关回的私钥', () => {
  assert.ok(createLine, 'main.mjs 里应有 createLookClient({ … }) 的调用');
  assert.match(createLine, /look:\s*createLookClient\(/);
  assert.match(createLine, /lookOn\s*\?/, `创建看画面客户端要受 lookOn 管:${createLine.trim()}`);
  assert.match(mainSrc, /const lookOn = accountMode \? !!key : !!lookUrl;/, '账号模式的 lookOn = resolveAccountLook 回了私钥');
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
