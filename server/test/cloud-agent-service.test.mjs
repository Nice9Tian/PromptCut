/**
 * 云端 Agent 服务:独立入口与多实例(契约 `docs/plan/cloud-agent-contract.md` 第 2、3、9 节,第 13.1 节的编号)。
 * 跑:node --test server/test/cloud-agent-service.test.mjs
 *
 *   CA-SEAM-01   `server/agent/service/`、`server/agent-service/` 里没有指向 `src/` 的 import;
 *   CA-ENTRY-01  托管档入口不带页面起得来:`/healthz` 200;没有任何 `/api/*`;没配鉴权时 `/v1/*` 一律 401;
 *   CA-ENTRY-02  绑非回环地址、数据目录不存在、文档服务地址不对,各自拒绝启动并给出原因;
 *   CA-ENTRY-03  经 HTTP 走一遍:发消息回 202,事件流先补发再接实时,`seq` 递增,`tool_result` 不带完整输出;
 *   CA-MULTI-01  一个进程里两个项目各一个对话(同一个对话 id)同时跑,互不干扰;
 *   CA-ISO-01    两个项目的执行器并发各写 60 次:每次提交只动自己的项目;出锁后服务端 store 里不留任何项目;
 *   CA-ISO-02    甲拿乙的对话 id 去看、去停:都当作不存在,乙的对话不受影响;
 *   CA-RUN-01    发消息后没有任何人连着看:这一轮照样跑完,事后从头补看到完整过程;`after` 之后的才补;
 *   CA-CHAT-02   停止:进行中的一轮 1 秒内结束,状态与原因正确;
 *   CA-TOOL-01   「还没接上」的工具逐个调用都回 `cloudUnavailable` 与原因,项目版本不变;要操作发起人界面的,发起方不在线时
 *                逐个回 `initiatorOffline`,立刻回、不等;
 *   CA-TOOL-02   工具表里的每个工具都在云端工具表里归了类(新加的工具不表态就挂);在副本上执行的都是同步实现;
 *                在服务端另有实现的一个不少;
 *   CA-TOOL-04   交给模型的工具只有清单里的加 `think`,没有 `text_editor`;
 *   CA-PAGE-01   `get_selection`:带了快照回快照;没带(或发起方不在线)立刻回 `initiatorOffline`;
 *   CA-HIST-01   模型历史落在数据目录的「项目 / 主人 / 对话」下,不按请求里的 sessionId 找;
 *   CA-OWNER-01  主人键:创建者、限定进入的成员按用户名(换设备相同),自由进入的成员按用户名加设备;
 *   CA-MOCK-01   模拟模型提供方照脚本走。
 *
 * 文档服务用本机回环的内存实例(端口 0),模型用模拟提供方,全部不出网。鉴权与连文档服务的凭证是测试替身
 * (乙块接上真的之前):身份从 `Authorization: Bearer test:<项目>:<成员>` 取,连接用回环的 agent 角色项。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { createHostedAgentService, ownerKeyOf } from '../agent/service/create-agent-service.mjs';
import { CLOUD_OPEN_TOOLS, CLOUD_TOOL_PLAN, CLOUD_HOSTED_TOOLS, CLOUD_INITIATOR_TOOLS, CLOUD_AGENT_SIDE, CLOUD_SYSTEM_NOTE, checkCloudTool, pendingByReason } from '../agent/service/cloud-tools.mjs';
import { startAgentService, AgentConfigError } from '../agent-service/main.mjs';
import { mockScriptOf, createProvider } from '../harness/providers/mock.mjs';
import { buildTools } from '../harness/tools/index.mjs';
import { tools, toolGroups } from '../mcp-tools.mjs';
import { TOOL_ROUTES } from '../../src/mcp/routes.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';


import { ROOT, project, script, credentials, modelConfig, startDoc, startKit } from './cloud-agent-kit.mjs';

const alice = { projectId: 'p-a', userId: 'alice@dev-a', username: 'alice', deviceName: 'A 的电脑' };
const bob = { projectId: 'p-b', userId: 'bob@dev-b', username: 'bob', deviceName: 'B 的电脑' };

test('CA-SEAM-01 新目录里没有指向 src/ 的 import', () => {
  const bad = [];
  for (const dir of ['server/agent/service', 'server/agent-service']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (!/\.(mjs|js|ts)$/.test(name)) continue;
      const text = fs.readFileSync(path.join(ROOT, dir, name), 'utf8');
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|new URL\(\s*)(['"`])([^'"`]+)\1/g)) {
        const spec = m[2];
        if (!spec.startsWith('.')) continue;
        const target = path.resolve(ROOT, dir, spec);
        if (path.relative(path.join(ROOT, 'src'), target).startsWith('..') === false) bad.push(`${dir}/${name}: ${spec}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('CA-OWNER-01 主人键:创建者与限定进入按用户名,自由进入按用户名加设备', () => {
  const k = ownerKeyOf;
  assert.equal(k({ projectId: 'p', userId: 'a@d1', username: 'a', creator: true }), k({ projectId: 'p', userId: 'a@d2', username: 'a', creator: true }), '创建者换设备相同');
  assert.equal(k({ projectId: 'p', userId: 'a@d1', username: 'a', mode: 'restricted' }), k({ projectId: 'p', userId: 'a@d2', username: 'a', mode: 'restricted' }), '限定进入换设备相同');
  assert.notEqual(k({ projectId: 'p', userId: 'a@d1', username: 'a', mode: 'free' }), k({ projectId: 'p', userId: 'a@d2', username: 'a', mode: 'free' }), '自由进入换设备不同');
  assert.notEqual(k({ projectId: 'p', userId: 'a@d1', username: 'a', creator: true }), k({ projectId: 'p', userId: 'a@d1', username: 'a', mode: 'restricted' }), '创建者与同名成员不同');
  assert.notEqual(k({ projectId: 'p', userId: 'a@d1', username: 'a', creator: true }), k({ projectId: 'q', userId: 'a@d1', username: 'a', creator: true }), '不同项目不同');
});

test('CA-MOCK-01 模拟模型提供方照脚本走;没有脚本时是原来的两回合', async () => {
  const steps = [{ tool: 'get_project', input: {} }, { sleepMs: 5 }, { say: '好了' }];
  const messages = [{ role: 'user', content: [{ type: 'text', text: script(steps) }] }];
  assert.deepEqual(mockScriptOf(messages), steps);
  assert.equal(mockScriptOf([{ role: 'user', content: [{ type: 'text', text: '没有脚本' }] }]), null);
  const p = createProvider({});
  const collect = async () => { const out = []; for await (const ev of p.stream(messages, [], '', undefined)) out.push(ev); return out; };
  const t1 = await collect();
  assert.deepEqual(t1.map((e) => e.type), ['tool_use', 'usage', 'stop']);
  assert.equal(t1[0].name, 'get_project');
  const t2 = await collect();
  assert.deepEqual(t2.map((e) => e.type), ['text_delta', 'usage', 'stop']);
  assert.equal(t2[0].text, '好了');
  const plain = createProvider({});
  const first = [];
  for await (const ev of plain.stream([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], [], '', undefined)) first.push(ev);
  assert.deepEqual(first, [{ type: 'tool_use', id: 'call_1', name: 'get_editor_state', input: {} }, { type: 'stop', reason: 'tool_use' }]);
  const failing = createProvider({});
  await assert.rejects(async () => { for await (const _ of failing.stream([{ role: 'user', content: [{ type: 'text', text: script([{ fail: '模拟的模型错误' }]) }] }], [], '', undefined)) { /* 读完 */ } }, /模拟的模型错误/);
});

test('CA-TOOL-02 工具表里的每个工具都归了类;在副本上执行的都是同步实现;系统提示词不再写旧范围', () => {
  const names = tools.map((t) => t.name);
  // 两边一一对应:新加的工具不在云端工具表里表态,这里就挂(不会悄悄变成「云端没有」)
  assert.deepEqual(names.filter((n) => !Object.hasOwn(CLOUD_TOOL_PLAN, n)), [], '这些工具还没在云端工具表里归类');
  assert.deepEqual(Object.keys(CLOUD_TOOL_PLAN).filter((n) => !names.includes(n)), [], '云端工具表里有工具表没有的名字');
  const count = (mode) => Object.values(CLOUD_TOOL_PLAN).filter((p) => p.mode === mode).length;
  assert.deepEqual({ route: count('route'), hosted: count('hosted'), server: count('server'), initiator: count('initiator'), pending: count('pending') },
    { route: 71, hosted: 13, server: 6, initiator: 8, pending: 30 });
  assert.equal(CLOUD_OPEN_TOOLS.size, 98, '交给模型的 = 除「还没接上」的全部(看画面的四个要节点配了看画面的口子才交,见 cloud-agent-look.test.mjs)');
  // 在副本上执行的:走路由表的必须是同步实现(进程级的锁里不等外部);点名的两个例外实现本身是同步的
  const route = Object.entries(CLOUD_TOOL_PLAN).filter(([, p]) => p.mode === 'route').map(([n]) => n);
  // 看画面的四个不走路由表(读副本后向渲染服务要一帧,不进锁),与 get_layout 同理
  const awaited = route.filter((n) => Object.hasOwn(TOOL_ROUTES, n) && TOOL_ROUTES[n].awaited !== false && n !== 'get_layout' && n !== 'apply_card' && CLOUD_TOOL_PLAN[n].look !== true);
  assert.deepEqual(awaited, [], '这些工具的实现是异步的,不能进锁');
  const sides = route.map((n) => [n, tools.find((t) => t.name === n).side]).filter(([n, s]) => s !== 'agent' && !CLOUD_AGENT_SIDE.has(n));
  assert.deepEqual(sides, [], '在副本上执行的只有 agent 侧的工具,外加点名改到服务端的几个');
  for (const n of Object.entries(CLOUD_TOOL_PLAN).filter(([, p]) => p.mode === 'server').map(([x]) => x)) assert.equal(tools.find((t) => t.name === n).side, 'server', n);
  // 「还没接上」的每一个都写了差什么;要操作发起人界面的每一个都写了要用到他的什么
  for (const [n, p] of Object.entries(CLOUD_TOOL_PLAN)) {
    if (p.mode === 'pending') assert.ok(typeof p.why === 'string' && p.why.length > 10, `${n} 要写明差什么`);
    if (p.mode === 'initiator') assert.ok(typeof p.what === 'string' && p.what, `${n} 要写明用到发起人的什么`);
  }
  assert.ok(pendingByReason().size >= 5);
  assert.deepEqual([...CLOUD_HOSTED_TOOLS].sort(), ['cancel_card_audio', 'card_authoring_guide', 'create_card', 'edit_card', 'get_card_source', 'import_media', 'measure_audio', 'render_card_audio', 'sound_cancel', 'sound_generate', 'sound_status', 'voice_generate', 'voice_list']);
  assert.deepEqual([...CLOUD_INITIATOR_TOOLS].sort(), ['collect_login', 'collect_login_check', 'get_selection', 'pause', 'play', 'seek', 'spawn_agent', 'web_handoff']);
  assert.deepEqual(checkCloudTool('update_clip'), { ok: true, mode: 'route' });
  assert.deepEqual(checkCloudTool('create_card'), { ok: true, mode: 'hosted' });
  const no = checkCloudTool('web_open');
  assert.equal(no.ok, false);
  assert.equal(no.cloudUnavailable, true);
  assert.match(no.error, /云端 Agent 这一版还用不了 web_open/);
  assert.equal(checkCloudTool('no_such_tool').cloudUnavailable, true);
  // 系统提示词:不再说旧范围的话
  for (const stale of ['只能用内置卡', '云端第一版不支持', '云端暂不支持', '新建或修改卡片代码、']) assert.equal(CLOUD_SYSTEM_NOTE.includes(stale), false, stale);
  for (const must of ['发起方不在线', 'import_media', 'create_card', '托管方的配音服务']) assert.ok(CLOUD_SYSTEM_NOTE.includes(must), must);
});

test('CA-TOOL-04 交给模型的工具只有清单里的加 think', async () => {
  const offered = await buildTools({ callTool: async () => [], workspaceDir: null, only: CLOUD_OPEN_TOOLS, localTools: false });
  const names = offered.map((t) => t.name);
  assert.equal(names.includes('text_editor'), false);
  assert.equal(names.includes('think'), true);
  assert.deepEqual(names.filter((n) => n !== 'think' && !CLOUD_OPEN_TOOLS.has(n)), []);
  assert.equal(names.length, CLOUD_OPEN_TOOLS.size + 1);
  // 不给这两个选项时与原来相同:全部工具加 think、text_editor
  const all = await buildTools({ callTool: async () => [], workspaceDir: os.tmpdir() });
  assert.equal(all.length, tools.length + 2);
});

test('CA-ENTRY-02 配置不对拒绝启动', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-agent-cfg-'));
  try {
    const reasonOf = async (o) => {
      try { const s = await startAgentService(o); await s.close(); return 'started'; } catch (err) { return err instanceof AgentConfigError ? err.reason : `other:${err?.message}`; }
    };
    assert.equal(await reasonOf({ dataDir: dir, docUrl: 'ws://127.0.0.1:1', host: '0.0.0.0', port: 0 }), 'bind-public');
    assert.equal(await reasonOf({ dataDir: path.join(dir, 'no-such'), docUrl: 'ws://127.0.0.1:1', port: 0 }), 'data-dir');
    assert.equal(await reasonOf({ dataDir: dir, docUrl: 'http://127.0.0.1:1', port: 0 }), 'doc-url');
    assert.equal(await reasonOf({ docUrl: 'ws://127.0.0.1:1', port: 0 }), 'data-dir');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CA-ENTRY-01 / CA-ENTRY-03 托管档入口:没有 /api/*,没配鉴权一律 401;配了替身后发消息 202、事件流可补看', { timeout: 120_000 }, async (t) => {
  const doc = await startDoc(t);
  await doc.seed(project('p-a', '甲'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-agent-http-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  // 没配鉴权:进程起得来,只有 healthz
  const bare = await startAgentService({ dataDir, docUrl: doc.url, port: 0 });
  try {
    const h = await fetch(`${bare.url}/healthz`);
    assert.equal(h.status, 200);
    const health = await h.json();
    assert.deepEqual(Object.keys(health).sort(), ['egressTestAllow', 'look', 'ok', 'version']);
    assert.equal(health.egressTestAllow, false, '出网闸的测试例外缺省关着');
    assert.equal(health.look, false, '没配看画面的口子');
    for (const p of ['/api/ai/chat', '/api/ai/config', '/api/mcp/call', '/api/mcp/events', '/api/agent/status', '/api/agent/bind', '/api/chats/list', '/']) {
      const r = await fetch(`${bare.url}${p}`, { method: p === '/api/ai/chat' || p === '/api/mcp/call' ? 'POST' : 'GET' });
      assert.equal(r.status, 404, `${p} 不存在`);
      await r.arrayBuffer();
    }
    for (const p of ['/v1/info', '/v1/conversations', '/v1/conversations/c1/events']) {
      const r = await fetch(`${bare.url}${p}`, { headers: { Authorization: 'Bearer anything' } });
      assert.equal(r.status, 401, `${p} 没配鉴权时 401`);
      assert.deepEqual(await r.json(), { ok: false, code: 'unauthorized', message: 'unauthorized' });
    }
  } finally {
    await bare.close();
  }

  // 配了替身
  const authenticate = (req) => {
    const m = /^Bearer test:([^:]+):(.+)$/.exec(String(req.headers.authorization ?? ''));
    return m ? { projectId: m[1], userId: m[2], username: m[2].split('@')[0] } : null;
  };
  const svc = await startAgentService({ dataDir, docUrl: doc.url, port: 0, authenticate, credentials, modelConfig });
  t.after(() => svc.close());
  const auth = { Authorization: 'Bearer test:p-a:alice@dev-a' };
  assert.equal((await fetch(`${svc.url}/v1/info`)).status, 401, '不带票据 401');
  assert.equal((await fetch(`${svc.url}/v1/info`, { headers: { Authorization: 'Bearer nope' } })).status, 401, '票据不对 401');

  const steps = [{ tool: 'update_clip', input: { clipId: 'c1', end: 6 } }, { say: '改好了' }];
  const sent = await fetch(`${svc.url}/v1/conversations/c-http/messages`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: script(steps), projectId: 'p-b', userId: 'bob@dev-b', sessionId: 'someone-else' }) });
  assert.equal(sent.status, 202);
  const sentBody = await sent.json();
  assert.equal(sentBody.ok, true);
  assert.equal(typeof sentBody.runId, 'string');

  // 事件流:从头看到 end
  const readEvents = async (after) => {
    const res = await fetch(`${svc.url}/v1/conversations/c-http/events?after=${after}`, { headers: auth });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    const out = [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith('data: ')) out.push(JSON.parse(chunk.slice(6)));
      }
      if (out.some((e) => e.type === 'end')) { await reader.cancel(); break; }
    }
    return out;
  };
  const events = await readEvents(0);
  const types = events.map((e) => e.type);
  for (const want of ['user', 'run', 'tool_call', 'tool_result', 'text', 'done', 'end']) assert.ok(types.includes(want), `事件里有 ${want}:${types.join(',')}`);
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), 'seq 从 1 连续递增');
  assert.equal(events[0].type, 'user');
  assert.equal(events.at(-1).type, 'end');
  assert.equal(events.at(-1).state, 'idle');
  for (const e of events.filter((x) => x.type === 'tool_result')) assert.equal(e.output, undefined, 'tool_result 不带完整输出');
  const later = await readEvents(events.length - 2);
  assert.deepEqual(later.map((e) => e.seq), [events.length - 1, events.length], 'after 之后的才补');

  // 请求体里自报的 projectId / userId 被忽略:改的是票据里的项目
  const st = await doc.stateOf('p-a');
  assert.equal(st.project.tracks[0].clips[0].end, 6);
  const info = await (await fetch(`${svc.url}/v1/info`, { headers: auth })).json();
  assert.deepEqual(info.running, []);
  const list = await (await fetch(`${svc.url}/v1/conversations`, { headers: auth })).json();
  assert.deepEqual(list.items.map((c) => [c.id, c.state]), [['c-http', 'idle']]);
  // 别的成员看不到这个对话
  const other = await (await fetch(`${svc.url}/v1/conversations`, { headers: { Authorization: 'Bearer test:p-a:mallory@dev-m' } })).json();
  assert.deepEqual(other.items, []);
});

test('CA-MULTI-01 一个进程里两个项目各一个对话同时跑,互不干扰', { timeout: 120_000 }, async (t) => {
  const kit = await startKit(t);
  await kit.doc.seed(project('p-a', '甲'));
  await kit.doc.seed(project('p-b', '乙'));
  const stepsFor = (end, label) => [
    { tool: 'get_project', input: {} },
    { sleepMs: 30 },
    { tool: 'update_clip', input: { clipId: 'c1', end } },
    { sleepMs: 30 },
    { tool: 'update_clip', input: { clipId: 'c1', label } },
    { tool: 'add_track', input: { name: `${label} 加的序列` } },
    { say: `${label} 完成` },
  ];
  // 两边故意用同一个对话 id
  const [ra, rb] = await Promise.all([
    kit.service.send(alice, 'c-same', { prompt: script(stepsFor(5, '甲方')) }),
    kit.service.send(bob, 'c-same', { prompt: script(stepsFor(7, '乙方')) }),
  ]);
  assert.notEqual(ra.runId, rb.runId);
  const [ea, eb] = await Promise.all([kit.finished(alice, 'c-same'), kit.finished(bob, 'c-same')]);
  const sa = await kit.doc.stateOf('p-a');
  const sb = await kit.doc.stateOf('p-b');
  const view = (st) => ({ name: st.project.name, end: st.project.tracks[0].clips[0].end, label: st.project.tracks[0].clips[0].label, tracks: st.project.tracks.map((x) => x.name) });
  const out = {
    甲: { ...view(sa), 结束: ea.at(-1).state, 事件数: ea.length, 只有自己的runId: ea.every((e) => e.runId === undefined || e.runId === ra.runId), 最后一句: ea.filter((e) => e.type === 'text').map((e) => e.delta).join('') },
    乙: { ...view(sb), 结束: eb.at(-1).state, 事件数: eb.length, 只有自己的runId: eb.every((e) => e.runId === undefined || e.runId === rb.runId), 最后一句: eb.filter((e) => e.type === 'text').map((e) => e.delta).join('') },
    实例数: kit.service.describe().instances.length,
  };
  console.log('CA-MULTI-01', JSON.stringify(out));
  assert.deepEqual(out.甲, { name: '甲', end: 5, label: '甲方', tracks: ['序列 1', '甲方 加的序列'], 结束: 'idle', 事件数: ea.length, 只有自己的runId: true, 最后一句: '甲方 完成' });
  assert.deepEqual(out.乙, { name: '乙', end: 7, label: '乙方', tracks: ['序列 1', '乙方 加的序列'], 结束: 'idle', 事件数: eb.length, 只有自己的runId: true, 最后一句: '乙方 完成' });
  assert.equal(out.实例数, 2);
  assert.equal(JSON.stringify(sa.project).includes('乙'), false, '甲的项目里没有乙的任何东西');
  assert.equal(JSON.stringify(sb.project).includes('甲'), false, '乙的项目里没有甲的任何东西');
  assert.equal(JSON.stringify(ea).includes('乙方'), false, '甲的事件里没有乙的内容');
  assert.equal(JSON.stringify(eb).includes('甲方'), false, '乙的事件里没有甲的内容');
});

test('CA-ISO-01 / CA-ISO-02 / CA-TOOL-01 / CA-PAGE-01 / CA-HIST-01 / CA-RUN-01 / CA-CHAT-02', { timeout: 180_000 }, async (t) => {
  const kit = await startKit(t);
  await kit.doc.seed(project('p-a', '甲'));
  await kit.doc.seed(project('p-b', '乙'));

  await t.test('CA-RUN-01 没人连着看也跑完;事后从头补看;after 之后的才补', async () => {
    const { runId, seq } = await kit.service.send(alice, 'c-run', { prompt: script([{ tool: 'update_clip', input: { clipId: 'c1', start: 1 } }, { say: '完' }]) });
    assert.equal(seq, 1);
    // 不订阅,只等文档服务里出现改动与服务端状态变 idle
    await waitFor(() => kit.service.conversations(alice).find((c) => c.id === 'c-run')?.state === 'idle', 30_000, '这一轮结束');
    assert.equal((await kit.doc.stateOf('p-a')).project.tracks[0].clips[0].start, 1);
    const all = [];
    kit.service.subscribe(alice, 'c-run', 0, (ev) => all.push(ev))();
    assert.deepEqual(all.map((e) => e.seq), all.map((_, i) => i + 1));
    assert.equal(all[0].type, 'user');
    assert.equal(all.at(-1).type, 'end');
    assert.ok(all.every((e) => e.runId === runId));
    const tail = [];
    kit.service.subscribe(alice, 'c-run', all.length - 3, (ev) => tail.push(ev))();
    assert.deepEqual(tail.map((e) => e.seq), [all.length - 2, all.length - 1, all.length]);
  });

  await t.test('CA-HIST-01 模型历史在数据目录的「项目 / 主人 / 对话」下', () => {
    const file = path.join(kit.dataDir, 'tenants', 'p-a', 'owners', ownerKeyOf(alice), 'conversations', 'c-run', 'history.json');
    assert.ok(fs.existsSync(file), file);
    const messages = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(messages) && messages.length >= 3);
    assert.equal(fs.existsSync(path.join(kit.dataDir, 'tenants', 'p-b')), false, '乙的项目下没有东西');
  });

  await t.test('CA-ISO-02 甲拿乙的对话 id 去看、去停,都当作不存在', async () => {
    await kit.service.send(bob, 'c-bob', { prompt: script([{ sleepMs: 600 }, { tool: 'update_clip', input: { clipId: 'c1', end: 9 } }, { say: '乙完' }]) });
    assert.equal(kit.service.subscribe(alice, 'c-bob', 0, () => {}), null, '甲看不到乙的对话');
    assert.deepEqual(kit.service.abort(alice, 'c-bob'), { ok: true });
    assert.equal(kit.service.conversations(alice).some((c) => c.id === 'c-bob'), false);
    // 另一个成员在乙的项目里用同一个对话 id 也看不到
    assert.equal(kit.service.subscribe({ projectId: 'p-b', userId: 'carol@dev-c' }, 'c-bob', 0, () => {}), null);
    const events = await kit.finished(bob, 'c-bob');
    assert.equal(events.at(-1).state, 'idle', '乙的这一轮没被甲停掉');
    assert.equal((await kit.doc.stateOf('p-b')).project.tracks[0].clips[0].end, 9);
  });

  await t.test('CA-CHAT-02 停止:1 秒内结束', async () => {
    await kit.service.send(alice, 'c-stop', { prompt: script([{ tool: 'get_project', input: {} }, { sleepMs: 20_000 }, { tool: 'update_clip', input: { clipId: 'c1', end: 11 } }]) });
    const seen = [];
    kit.service.subscribe(alice, 'c-stop', 0, (ev) => seen.push(ev));
    await waitFor(() => seen.some((e) => e.type === 'tool_result'), 30_000, '跑到第一步之后');
    const at = Date.now();
    kit.service.abort(alice, 'c-stop');
    await waitFor(() => seen.some((e) => e.type === 'end'), 1000, '停下');
    assert.ok(Date.now() - at < 1000);
    assert.equal(seen.at(-1).state, 'idle');
    // 丙块给列表项追加了 title、updatedAt、startedOn;原有的四个字段不变
    const item = kit.service.conversations(alice).find((c) => c.id === 'c-stop');
    assert.deepEqual({ id: item.id, state: item.state, reason: item.reason, lastSeq: item.lastSeq }, { id: 'c-stop', state: 'idle', reason: 'stopped', lastSeq: seen.length });
    await new Promise((r) => setTimeout(r, 100));
    assert.notEqual((await kit.doc.stateOf('p-a')).project.tracks[0].clips[0].end, 11, '停下之后没有新的写入');
  });

  await t.test('CA-TOOL-01 还没接上的工具逐个回 cloudUnavailable 与原因;要操作发起人界面的在他不在线时逐个回 initiatorOffline;项目版本不变', async () => {
    const inst = kit.service._instance(alice);
    const before = (await kit.doc.stateOf('p-a')).rev;
    const closed = tools.map((x) => x.name).filter((n) => !CLOUD_OPEN_TOOLS.has(n));
    assert.equal(closed.length, 30);
    for (const name of closed) {
      const r = await inst.callTool(name, {}, 'c-tools');
      assert.equal(r?.cloudUnavailable, true, `${name} 回「还用不了」`);
      assert.equal(r.ok, false);
      assert.ok(r.error.includes(name) && r.error.includes(CLOUD_TOOL_PLAN[name].why), `${name} 的回答里写了差什么`);
    }
    // 发起方不在线(这个对话没有人连着看):八个要操作他界面的工具立刻回,不等
    for (const name of CLOUD_INITIATOR_TOOLS) {
      const t0 = Date.now();
      const r = await inst.callTool(name, {}, 'c-tools');
      assert.equal(r?.initiatorOffline, true, name);
      assert.equal(r.ok, false);
      assert.match(r.error, /发起方不在线/);
      assert.ok(Date.now() - t0 < 200, `${name} 不等待`);
    }
    assert.equal((await kit.doc.stateOf('p-a')).rev, before);
  });

  await t.test('CA-PAGE-01 get_selection:带了快照回快照,没带立刻回发起方不在线', async () => {
    const inst = kit.service._instance(alice);
    const t0 = Date.now();
    const off = await inst.callTool('get_selection', {}, 'c-nopage');
    assert.equal(off.initiatorOffline, true);
    assert.match(off.error, /发起方不在线/);
    assert.ok(Date.now() - t0 < 100, '不等待');
    // 丙块按契约第 9.4 节补上「发起方在线」的判定:发起这一轮的那个成员有事件流连着才算在线(甲块里只看有没有带快照)
    await kit.service.send(alice, 'c-sel', { prompt: script([{ sleepMs: 3000 }, { say: '看到了' }]), pageState: { t: 2.5, selection: ['c1'] } });
    assert.equal((await inst.callTool('get_selection', {}, 'c-sel')).initiatorOffline, true, '一轮在跑但发起方没有连着看:不在线');
    const off2 = kit.service.subscribe(alice, 'c-sel', 0, () => {});
    const got = await inst.callTool('get_selection', {}, 'c-sel');
    assert.equal(got.ok, true);
    assert.deepEqual(got.ids, ['c1']);
    assert.equal(got.clips[0].id, 'c1');
    assert.equal(got.clips[0].trackId, 't1');
    off2();
    const t1 = Date.now();
    const gone = await inst.callTool('get_selection', {}, 'c-sel');
    assert.equal(gone.initiatorOffline, true, '流断开后同一轮里再调:立刻回发起方不在线');
    assert.ok(Date.now() - t1 < 100, '不等待');
    kit.service.abort(alice, 'c-sel');
  });

  await t.test('CA-ISO-01 两个项目并发各写 60 次:只动自己的项目;出锁后 store 里不留项目', async () => {
    const ia = kit.service._instance(alice);
    const ib = kit.service._instance(bob);
    const N = 60;
    const jobs = [];
    const results = { a: 0, b: 0, stale: 0 };
    // 每个实例里串行(同一对话带期望版本),两个实例之间并发、交错
    const chain = async (inst, who, mark) => {
      for (let i = 1; i <= N; i += 1) {
        const r = await inst.callTool('update_clip', { clipId: 'c1', label: `${mark}-${i}` }, `iso-${who}`).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
        if (r?.ok === false) results.stale += 1; else results[who] += 1;
      }
    };
    jobs.push(chain(ia, 'a', 'AAA'), chain(ib, 'b', 'BBB'));
    await Promise.all(jobs);
    const sa = await kit.doc.stateOf('p-a');
    const sb = await kit.doc.stateOf('p-b');
    const out = { 甲写成: results.a, 乙写成: results.b, 被拒: results.stale, 甲最后: sa.project.tracks[0].clips[0].label, 乙最后: sb.project.tracks[0].clips[0].label };
    console.log('CA-ISO-01', JSON.stringify(out));
    assert.deepEqual(out, { 甲写成: N, 乙写成: N, 被拒: 0, 甲最后: `AAA-${N}`, 乙最后: `BBB-${N}` });
    assert.equal(JSON.stringify(sa.project).includes('BBB'), false);
    assert.equal(JSON.stringify(sb.project).includes('AAA'), false);
    assert.equal(sa.project.name, '甲');
    assert.equal(sb.project.name, '乙');
    const core = await kit.vite.ssrLoadModule('/src/store/core.ts');
    const left = core.getState();
    assert.deepEqual({ tracks: (left.project.tracks ?? []).flatMap((x) => x.clips ?? []).length, selection: left.selection, history: core.history.length, future: core.future.length }, { tracks: 0, selection: [], history: 0, future: 0 }, '出锁后 store 里没有任何实例的项目与撤销栈');
    assert.equal(JSON.stringify(left.project).includes('AAA') || JSON.stringify(left.project).includes('BBB'), false);
  });

  await t.test('日志里只有 id、计数与原因码,没有正文', () => {
    const text = JSON.stringify(kit.logs);
    for (const leak of ['mock-script', 'AAA-', 'BBB-', '按脚本做', '乙完']) assert.equal(text.includes(leak), false, `日志里不该有 ${leak}`);
  });
});

test('CA-DESK-01 桌面档:Agent 服务登记的路由与搬出插件之前逐条相同,桌面专用接口留在插件里', async () => {
  const { createAgentInstance } = await import('../agent/service/instance.mjs');
  const routes = [];
  const inst = createAgentInstance({
    server: { httpServer: null, ssrLoadModule: async () => { throw new Error('这条用例不载入前端代码'); }, config: { root: ROOT }, middlewares: { use: (route, handler) => routes.push([route, typeof handler]) } },
    prerenderPost: async () => null,
    latestMirror: () => null,
    latestPlayhead: () => null,
  });
  try {
    // 起点提交 e7d18340 的 server/vite-plugin-ai.ts 里这些路由的登记顺序
    assert.deepEqual(routes.map((r) => r[0]), [
      '/api/ai/chat', '/api/ai/abort',
      '/api/mcp/events', '/api/mcp/result', '/api/mcp/call',
      '/api/agent/bind', '/api/agent/unbind', '/api/agent/ticket', '/api/agent/editing',
      '/api/agent/tabs', '/api/agent/inbox', '/api/agent/spawned', '/api/agent/board', '/api/agent/desktop', '/api/agent/status',
      '/api/mcp/status',
    ]);
    assert.ok(routes.every((r) => r[1] === 'function'));
    assert.equal(typeof inst.getQuotaGuard, 'function');
  } finally {
    inst.close();
  }
  const shell = fs.readFileSync(path.join(ROOT, 'server', 'vite-plugin-ai.ts'), 'utf8');
  const kept = [...shell.matchAll(/server\.middlewares\.use\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(kept, [
    '/api/ai/providers', '/api/ai/auth-state', '/api/ai/models', '/api/ai/setup', '/api/ai/',
    '/api/ai/diagnostics/save', '/api/ai/diagnostics', '/api/ai/machine-code', '/api/ai/config', '/api/ai/agy-permissions', '/api/ai/quota',
  ]);
  assert.match(shell, /for \(const kind of \['install', 'login'\] as const\)/, "'/api/ai/' + kind 是安装与登录两条");
});
