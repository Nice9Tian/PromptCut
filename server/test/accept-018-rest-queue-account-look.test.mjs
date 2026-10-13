/**
 * 0.7.18 验收 RS18-queue 的一处缺口:账号模式下云端 Agent 有没有接上「看画面」(排队就是给它用的)。
 * 跑:npm test -- server/test/accept-018-rest-queue-account-look.test.mjs
 *
 * 块八「云端排队」(0ec8c7cd)把看画面的请求做成持久队列,但它的调用方(`server/agent-service/look-client.mjs`)在
 * `server/agent-service/main.mjs` 里只在「不是账号模式」时才创建;账号模式的执行器是用同一份 serviceOptions 展开出来的,
 * 所以拿不到 `look`。生产上云端项目一律走账号模式,于是线上那条路的 Agent 看不了画面,排队用不上。
 *
 *   Q-ACC-1 main.mjs 里创建看画面客户端的条件不含「!accountMode」(现状不成立,标 todo)
 *   Q-ACC-2 自检:这条静态检查确实找得到那一行(找不到就是 main.mjs 改了写法,这条测试要跟着改)
 *
 * 这是静态检查(读源码),不起服务。真正的端到端判据是「账号模式的 Agent 服务起来后,see_frames 能经队列拿到图」,
 * 那要等接线合入后补一支探针;现在只把「还没接」固定下来,接上以后把 todo 去掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'server/agent-service/main.mjs'), 'utf8');
const createLine = mainSrc.split('\n').find((l) => l.includes('createLookClient({'));

test('Q-ACC-2 自检:找得到创建看画面客户端的那一行', () => {
  assert.ok(createLine, 'main.mjs 里应有 createLookClient({ … }) 的调用');
  assert.match(createLine, /\blook:\s*createLookClient\(/);
});

test('Q-ACC-1 账号模式下也给执行器接上看画面的客户端', { todo: '现状不成立:server/agent-service/main.mjs 只在 !accountMode 时创建 look;账号模式的 Agent 看不了画面,块八的排队在生产路径上用不上' }, () => {
  assert.ok(createLine);
  assert.doesNotMatch(createLine, /!\s*accountMode/, `创建看画面客户端的条件把账号模式排除在外:${createLine.trim()}`);
});
