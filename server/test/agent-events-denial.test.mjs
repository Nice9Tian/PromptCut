/**
 * 账号模式事件流的轮询遇到错误时怎么办(`server/agent-service/http.mjs` 的 accountEvents):
 *   文档服务明确拒绝(401/403/404:退出登录、被踢、Agent 被关、对话被设为私有或删除)→ 写 `access.revoked` 再关流;
 *   暂时故障(503 一类:文档服务一时连不上、超时、读取通道被围栏掐断)→ 只关流,不写这个事件,页面照常重连;
 *   一切正常 → 流保持打开、不写这个事件。
 * 用假的账号服务，真的 http 服务器与真的 HTTP 客户端；读取通道不在这里测(`cloud-queue-http.test.mjs` 测)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAgentHttp } from '../agent-service/http.mjs';
import { AgentServiceError } from '../agent/service/create-agent-service.mjs';

const view = { aclRevision: 1, queueRevision: 0, currentRunId: null, messages: [] };

/** `second`:第二次起读对话(轮询)时要做的事——抛这个错,或不抛(undefined) */
async function readStream(t, second) {
  let reads = 0;
  const service = {
    accountMode: true,
    readTransports: { run: (_req, _res, callback) => callback(), dispatch: callback => callback() },
    async conversation() { reads++; if (reads > 1 && second) throw second; return view; },
    async access() { return { allowed: true, aclRevision: 1 }; },
  };
  const api = createAgentHttp({ service, authenticate: async () => ({ accountMode: true, projectId: 'p', accountId: 'a', userId: 'a', delegation: 'd' }) });
  const server = http.createServer((req, res) => { void api.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let wire = '', ended = false, status;
  await new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${server.address().port}/v1/conversations/c1/events?after=0`, res => {
      status = res.statusCode;
      res.on('data', chunk => { wire += chunk; });
      res.on('end', () => { ended = true; resolve(); });
      res.on('error', () => resolve());
      res.on('close', () => resolve());
      // 正常情况流不会自己结束:等够几轮轮询就收线
      if (!second) setTimeout(() => { request.destroy(); resolve(); }, 900);
    });
    request.on('error', () => resolve());
  });
  return { wire, ended, status, reads };
}

const revoked = wire => wire.includes('"type":"access.revoked"');

for (const status of [401, 403, 404]) {
  test(`文档服务明确拒绝(${status})：写 access.revoked 再关流`, async t => {
    const out = await readStream(t, new AgentServiceError('denied', 'denied', status));
    assert.equal(out.status, 200);
    assert.equal(revoked(out.wire), true, out.wire);
    assert.equal(out.ended, true, '流被关掉');
  });
}

for (const status of [503, 502, 500, undefined]) {
  test(`暂时故障(${status ?? '无状态'})：关流但不写 access.revoked，页面当断线重连`, async t => {
    const error = status === undefined ? new Error('socket hang up') : new AgentServiceError('conversation-client-unavailable', 'x', status);
    const out = await readStream(t, error);
    assert.equal(out.status, 200);
    assert.equal(revoked(out.wire), false, out.wire);
    assert.equal(out.ended, true, '流被关掉');
  });
}

test('一切正常：先发队列快照，之后不写 access.revoked，流保持打开', async t => {
  const out = await readStream(t, null);
  assert.equal(out.status, 200);
  assert.ok(out.wire.includes('"type":"queue.state"'), out.wire);
  assert.equal(revoked(out.wire), false);
  assert.equal(out.ended, false, '流没有被服务端关掉');
});
