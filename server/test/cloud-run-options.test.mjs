import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { normalizeRunOptions, RUN_EFFORTS, RUN_CREATIVITY } from '../account/run-options.mjs';
import { canonicalReadRecord } from '../account/run-authority.mjs';
import { digestOf } from '../account/ledger.mjs';
import { CREATIVITY_LEVELS } from '../../src/kernel/creativity.mjs';
import { CAPABILITIES } from '../../src/ai/modelOptions.ts';
import { createAccountConversationService } from '../agent/service/conversation-policy.mjs';
import { readPublicModelInfo, writeModelConfig } from '../agent/service/model-config.mjs';
import { hostedRunOptions } from '../agent/service/account-runner.mjs';
import { createAgentHttp } from '../agent-service/http.mjs';
import { fixture as conversationFixture, ownerId, projectId as docProjectId } from './conversation-delete-fixture.mjs';
import { runFixture } from './run-authority-fixture.mjs';

/**
 * 云端账号模式的运行选项(发消息时点的模型、思考强度、创造力)从页面一路到任务进程:
 *   RO1 形状:空的不留、不认识的拒;档位清单与本机 API 直连、创造力等级各是同一份
 *   RO2 账号路由把三项交给服务,服务转给文档服务;都没点就不带;形状不对 400
 *   RO3 文档服务记在消息上;同一个请求号换了选项算不同请求;不带选项的摘要和原来一样
 *   RO4 消息记录(任务进程读、文档服务核的那一份)带上选项;没有选项的记录和原来一模一样;选项被改过就核不过
 *   RO5 任务进程按清单挑模型:清单里有就用,没有就用第一个;思考强度、创造力照点的带
 *   RO6 /v1/info 报模型清单与档位(不解 Key);配置读不到不挡 info
 */

test('RO1 运行选项的形状:空的项不留,全空回 null;不认识的键或值回 undefined', () => {
  assert.equal(normalizeRunOptions(undefined), null);
  assert.equal(normalizeRunOptions(null), null);
  assert.equal(normalizeRunOptions({}), null);
  assert.equal(normalizeRunOptions({ model: '', effort: null, creativity: undefined }), null);
  assert.deepEqual(normalizeRunOptions({ model: 'claude-opus-5-5', effort: 'high', creativity: 'medium' }),
    { model: 'claude-opus-5-5', effort: 'high', creativity: 'medium' });
  assert.deepEqual(normalizeRunOptions({ model: 'claude-opus-5-5', effort: '' }), { model: 'claude-opus-5-5' });
  for (const bad of [[], 'x', 5, { other: 1 }, { effort: 'turbo' }, { creativity: 'wild' }, { model: 'a b' }, { model: 'x'.repeat(201) },
    { model: '../etc' }, { model: 5 }]) assert.equal(normalizeRunOptions(bad), undefined, JSON.stringify(bad));
  // 档位与本机 API 直连同一套(去掉「默认」);创造力与 kernel 同一套(文档服务不引 src/,这里核两份一致)
  assert.deepEqual([...RUN_EFFORTS], CAPABILITIES.api.efforts.filter(Boolean));
  assert.deepEqual([...RUN_CREATIVITY], [...CREATIVITY_LEVELS]);
});

test('RO2 账号路由与服务:三项交给文档服务;都没点不带;形状不对 400', async t => {
  const sent = [];
  const conversationClient = Object.fromEntries(['identity', 'access', 'list', 'get', 'switchVisibility', 'stop', 'rename']
    .map(name => [name, async () => ({})]));
  conversationClient.send = async input => { sent.push(input); return { messageId: 'm1', seq: 1 }; };
  const service = createAccountConversationService({ conversationClient });
  const identity = { accountMode: true, delegation: 'd', projectId: 'sp_x', accountId: 'acc_x', userId: 'acc_x' };
  const api = createAgentHttp({ service, authenticate: async () => identity });
  const server = http.createServer((req, res) => { void api.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = body => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`http://127.0.0.1:${server.address().port}/v1/conversations/conv_1/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject); req.end(payload);
  });
  const base = { prompt: '你好', requestId: 'r1', selectionSnapshot: { pageId: 'page_1' } };
  assert.equal((await post({ ...base, model: 'claude-opus-5-5', effort: 'high', creativity: 'low' })).status, 202);
  assert.deepEqual(sent.at(-1).runOptions, { model: 'claude-opus-5-5', effort: 'high', creativity: 'low' });
  assert.equal((await post({ ...base, requestId: 'r2', creativity: null })).status, 202);
  assert.equal('runOptions' in sent.at(-1), false, '都没点:不带运行选项,文档服务里的消息和原来一样');
  const bad = await post({ ...base, requestId: 'r3', effort: 'turbo' });
  assert.equal(bad.status, 400); assert.equal(bad.body.code, 'invalid-run-options');
  assert.equal(sent.length, 2, '形状不对的没交给文档服务');
});

test('RO3 文档服务把运行选项记在消息上;同号换选项是另一条请求;不带选项的摘要不变', async t => {
  const f = conversationFixture(); t.after(() => f.close());
  const send = (requestId, runOptions, conversationId = 'conv_ro3') => f.authority.send({ principalRef: f.ref(ownerId), projectId: docProjectId,
    conversationId, requestId, content: 'hello', selectionInput: { pageId: 'page_123', selection: { clipIds: [] } },
    ...(runOptions !== undefined ? { runOptions } : {}) });
  const messages = () => f.ledger.read().conversationsV2[docProjectId].conv_ro3.messages;
  await send('req1', { model: 'claude-opus-5-5', effort: 'medium' });
  assert.deepEqual(messages()[0].runOptions, { model: 'claude-opus-5-5', effort: 'medium' });
  // 丢了回应后原样重发:回同一个结果,不多一条
  await send('req1', { model: 'claude-opus-5-5', effort: 'medium' });
  assert.equal(messages().length, 1);
  await assert.rejects(send('req1', { model: 'claude-opus-5-5', effort: 'high' }), e => e.status === 409 && e.code === 'request-mismatch');
  await send('req2');
  assert.equal('runOptions' in messages()[1], false);
  await assert.rejects(send('req3', { effort: 'turbo' }), e => e.status === 400 && e.code === 'invalid-run-options');
  // 不带选项时请求摘要的写法与原来相同(旧请求的重放照旧对得上)
  const digests = Object.values(f.ledger.read().conversationRequestsV2).map(row => row.digest);
  assert.ok(digests.includes(digestOf({ projectId: docProjectId, conversationId: 'conv_ro3', requestId: 'req2', content: 'hello' })));
});

test('RO4 消息记录带上运行选项,没有选项的记录和原来一样;选项被改过核不过', async t => {
  const context = { projectId: 'p', conversationId: 'c' };
  const message = { messageId: 'm', runId: 'r', requestId: 'q', senderAccountId: 'a', senderNameAtSend: 'n', loginId: 'l',
    credentialId: 'c', loginGeneration: 1, content: 'x', contentDigest: digestOf('x'), selectionSnapshot: null, attachments: [] };
  assert.deepEqual(Object.keys(canonicalReadRecord(message, context)).sort(), ['attachments', 'content', 'contentDigest', 'conversationId',
    'credentialId', 'loginGeneration', 'loginId', 'messageId', 'projectId', 'requestId', 'runId', 'selectionSnapshot', 'senderAccountId',
    'senderNameAtSend', 'v'], '没有选项:字段与原来一模一样');
  assert.deepEqual(canonicalReadRecord({ ...message, runOptions: { effort: 'low' } }, context).runOptions, { effort: 'low' });

  const f = await runFixture(); t.after(() => { f.close(); fs.rmSync(f.dir, { recursive: true }); });
  f.enqueue();
  f.ledger.transaction(s => { Object.values(s.conversationsV2).forEach(byId => Object.values(byId).forEach(c => {
    for (const m of c.messages) m.runOptions = { model: 'claude-opus-5-5', effort: 'high' }; })); });
  const g = await f.admit(), input = f.input(g);
  assert.deepEqual(input.prompt.runOptions, { model: 'claude-opus-5-5', effort: 'high' });
  const forged = { ...input.prompt, runOptions: { model: 'claude-opus-5-5', effort: 'low' } };
  await assert.rejects(f.provider.confirmRead({ ...input, prompt: forged, promptDigest: digestOf(forged) }), /complete-prompt-unverified/);
  assert.equal((await f.provider.confirmRead(input)).confirmed, true);
});

test('RO5 任务进程按清单挑模型,思考强度、创造力照点的带', () => {
  const cfg = { vendor: 'openai', model: 'claude-sonnet-5-5|claude-opus-5-5' };
  assert.deepEqual(hostedRunOptions(cfg, {}), { model: 'claude-sonnet-5-5' });
  assert.deepEqual(hostedRunOptions(cfg, { runOptions: { model: 'claude-opus-5-5', effort: 'high', creativity: 'low' } }),
    { model: 'claude-opus-5-5', effort: 'high', creativity: 'low' });
  assert.deepEqual(hostedRunOptions(cfg, { runOptions: { model: 'gpt-x' } }), { model: 'claude-sonnet-5-5' }, '不在清单里:用第一个');
  assert.deepEqual(hostedRunOptions(cfg, { runOptions: { effort: 'turbo' } }), { model: 'claude-sonnet-5-5' }, '形状不对:当作都没点');
});

test('RO6 /v1/info 报模型清单与档位,不解 Key;读不到配置不挡 info', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-run-options-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readPublicModelInfo(dir), { models: [], defaultModel: null, configured: false, efforts: [...RUN_EFFORTS] });
  writeModelConfig(dir, { vendor: 'openai', model: 'claude-sonnet-5-5|claude-opus-5-5' });
  assert.equal(readPublicModelInfo(dir).configured, false, '没有 Key 文件');
  fs.mkdirSync(path.join(dir, 'config', 'keys'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'keys', 'custom.key'), 'not-even-a-real-seal');
  assert.deepEqual(readPublicModelInfo(dir), { models: ['claude-sonnet-5-5', 'claude-opus-5-5'], defaultModel: 'claude-sonnet-5-5',
    configured: true, efforts: [...RUN_EFFORTS] }, 'Key 只看在不在,不打开');

  const conversationClient = Object.fromEntries(['identity', 'access', 'list', 'get', 'send', 'switchVisibility', 'stop', 'rename']
    .map(name => [name, async () => ({})]));
  const identity = { accountMode: true, delegation: 'd', projectId: 'sp_x', accountId: 'acc_x' };
  const info = await createAccountConversationService({ conversationClient, modelInfo: () => readPublicModelInfo(dir) }).info(identity);
  assert.deepEqual(info.models, ['claude-sonnet-5-5', 'claude-opus-5-5']); assert.deepEqual(info.efforts, [...RUN_EFFORTS]);
  assert.equal(info.accountMode, true);
  const broken = await createAccountConversationService({ conversationClient, modelInfo: () => { throw new Error('EACCES'); } }).info(identity);
  assert.equal(broken.enabled, true); assert.equal('models' in broken, false);
});
