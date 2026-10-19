/**
 * 账号模式事件流向文档服务读对话的节拍(`server/agent-service/http.mjs` 的 accountEvents)：
 *   空闲(没有在跑的一轮、没有排队的消息、本机没有新运行事件)时每 ACCOUNT_STREAM_IDLE_DOC_MS 读一次，不再每 250 毫秒一次；
 *   有在跑的一轮时照旧每拍都读；这个对话刚收下一条消息时马上读一次，不等空闲间隔。
 * 用假的账号服务，真的 http 服务器与真的 HTTP 客户端。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAgentHttp, ACCOUNT_STREAM_IDLE_DOC_MS, ACCOUNT_STREAM_TICK_MS } from '../agent-service/http.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function harness(t, view) {
  const reads = [];
  const service = {
    accountMode: true,
    readTransports: { run: (_req, _res, callback) => callback(), dispatch: callback => callback() },
    async conversation() { reads.push(Date.now()); return view(); },
    async access() { return { allowed: true, aclRevision: 1 }; },
    async send() { return { messageId: 'm1', runId: null, seq: 0 }; },
  };
  const api = createAgentHttp({ service, authenticate: async () => ({ accountMode: true, projectId: 'p', accountId: 'a', userId: 'a', delegation: 'd' }) });
  const server = http.createServer((req, res) => { void api.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stream = http.get(`${base}/v1/conversations/c1/events?after=0`, res => { res.resume(); });
  stream.on('error', () => {});
  t.after(async () => { stream.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const post = () => new Promise((resolve, reject) => {
    const req = http.request(`${base}/v1/conversations/c1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(JSON.stringify({ prompt: 'hi', requestId: 'r1' }));
  });
  return { reads, post };
}

test('空闲：向文档服务读对话按空闲间隔，不再每拍都读', async t => {
  const idle = { aclRevision: 1, queueRevision: 0, currentRunId: null, messages: [] };
  const h = await harness(t, () => idle);
  await sleep(2 * ACCOUNT_STREAM_IDLE_DOC_MS + 300);
  // 开流时一次 + 轮询的第一次，此后每秒一次：2.3 秒里约 4 次；原来每 250 毫秒一次是 10 次上下
  const everyTick = Math.floor((2 * ACCOUNT_STREAM_IDLE_DOC_MS + 300) / ACCOUNT_STREAM_TICK_MS);
  t.diagnostic(JSON.stringify({ reads: h.reads.length, everyTick }));
  assert.ok(h.reads.length <= 5, `空闲时读了 ${h.reads.length} 次`);
  assert.ok(h.reads.length >= 2, '空闲也照常读（核权限、看排队有没有变）');
});

test('有在跑的一轮：每拍都读', async t => {
  const busy = { aclRevision: 1, queueRevision: 1, currentRunId: 'run1', messages: [{ messageId: 'm1', arrivalSeq: 1, queueState: 'running', runId: 'run1' }] };
  const h = await harness(t, () => busy);
  await sleep(1300);
  assert.ok(h.reads.length >= 4, `忙时 1.3 秒只读了 ${h.reads.length} 次`);
});

test('这个对话刚收下一条消息：马上读一次，不等空闲间隔', async t => {
  const idle = { aclRevision: 1, queueRevision: 0, currentRunId: null, messages: [] };
  const h = await harness(t, () => idle);
  await sleep(400);
  const before = h.reads.length, sentAt = Date.now();
  assert.equal(await h.post(), 202);
  await sleep(120);
  const after = h.reads.filter(at => at >= sentAt).length;
  t.diagnostic(JSON.stringify({ before, afterSend: after }));
  assert.ok(after >= 1, '发送后 120 毫秒内已经读过一次');
});
