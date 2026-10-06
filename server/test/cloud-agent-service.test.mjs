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
 *   CA-TOOL-01   开放清单 ⊆ 工具表;不在清单里的逐个调用都回 `cloudUnsupported`,项目版本不变;
 *   CA-TOOL-02   清单里走路由表的工具都是同步实现(`awaited: false`);
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
import { CLOUD_OPEN_TOOLS, checkCloudTool } from '../agent/service/cloud-tools.mjs';
import { startAgentService, AgentConfigError } from '../agent-service/main.mjs';
import { mockScriptOf, createProvider } from '../harness/providers/mock.mjs';
import { buildTools } from '../harness/tools/index.mjs';
import { tools, toolGroups } from '../mcp-tools.mjs';
import { TOOL_ROUTES } from '../../src/mcp/routes.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

function project(id, name) {
  return {
    version: 1, id, name, width: 1920, height: 1080, fps: 30, duration: 12, themeId: 'midnight', media: [],
    tracks: [{ id: 't1', name: '序列 1', clips: [{ id: 'c1', cardId: 'title', start: 0, end: 4, params: {}, label: `${name} 的卡` }] }],
    transitions: [],
  };
}

const script = (steps) => `按脚本做。\n\`\`\`mock-script\n${JSON.stringify(steps)}\n\`\`\``;
const credentials = { protocolsFor: (_identity, n) => ['promptcut.v1', `promptcut.role.agent.${n}`] };
const modelConfig = () => ({ vendor: 'mock', model: 'mock-1' });

/** 本机回环的文档服务(内存)加两个小工具:把项目写进去、读当前内容 */
async function startDoc(t) {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const built = createSharedDocService({ mode: 'lan', dataDir: null, store: null, server, path: '/docservice', isLoopback: () => true, localDevice: { deviceId: 'pc-test-device-0001', deviceName: 'test' }, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/docservice`;
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.close();
    await built.service.close();
    await new Promise((resolve) => server.close(resolve));
  });
  let seq = 0;
  async function open(projectId) {
    const c = wsClient(url);
    clients.push(c);
    await c.opened;
    c.send({ type: 'project.open', projectId, reqId: `open-${++seq}` });
    const st = await c.next((m) => m.type === 'project.state', 5000);
    if (st.project === undefined && Number.isSafeInteger(st.parts)) {
      await c.next((m) => m.type === 'project.state.end' && m.rev === st.rev, 5000);
      const parts = c.all.filter((m) => m.type === 'project.state.part' && m.rev === st.rev).sort((x, y) => x.index - y.index);
      st.project = JSON.parse(parts.map((m) => m.data).join(''));
    }
    return { c, st };
  }
  return {
    url,
    async seed(p) {
      const { c } = await open(p.id);
      const opId = `seed-${++seq}`;
      c.send({ type: 'project.op', projectId: p.id, opId, session: 'seed', ops: [{ op: 'set', path: '', value: p }], reqId: opId });
      const r = await c.next((m) => m.reqId === opId, 5000);
      assert.equal(r.type, 'project.op.ok', `项目 ${p.id} 写进文档服务`);
      c.close();
    },
    async stateOf(projectId) {
      const { c, st } = await open(projectId);
      c.close();
      return st;
    },
  };
}

/** 一套:文档服务 + vite + 托管档服务(不经 HTTP) */
async function startKit(t, { limits } = {}) {
  const doc = await startDoc(t);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-agent-'));
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const logs = [];
  const service = createHostedAgentService({
    root: ROOT, loadModule: (id) => vite.ssrLoadModule(id), docUrl: doc.url, credentials, modelConfig, dataDir,
    ...(limits ? { limits } : {}), log: (event, fields) => logs.push({ event, ...fields }),
  });
  t.after(async () => {
    await service.close();
    await vite.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  /** 等这个对话的事件里出现 end,回全部事件 */
  async function finished(identity, conversationId, ms = 30_000) {
    const seen = [];
    await waitFor(() => {
      seen.length = 0;
      const off = service.subscribe(identity, conversationId, 0, (ev) => seen.push(ev));
      off?.();
      return seen.some((e) => e.type === 'end');
    }, ms, `对话 ${conversationId} 结束`);
    return seen;
  }
  return { doc, vite, service, dataDir, logs, finished };
}

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

test('CA-TOOL-02 开放清单 ⊆ 工具表,走路由表的都是同步实现', () => {
  const names = new Set(tools.map((t) => t.name));
  for (const n of CLOUD_OPEN_TOOLS) assert.ok(names.has(n), `${n} 在工具表里`);
  assert.equal(CLOUD_OPEN_TOOLS.size, 66);
  const awaited = [...CLOUD_OPEN_TOOLS].filter((n) => Object.hasOwn(TOOL_ROUTES, n) && TOOL_ROUTES[n].awaited !== false && n !== 'get_layout');
  assert.deepEqual(awaited, [], '这些工具的实现是异步的,不能进锁');
  const sides = [...CLOUD_OPEN_TOOLS].map((n) => [n, tools.find((t) => t.name === n).side]).filter(([n, s]) => s !== 'agent' && s !== 'server' && n !== 'list_cards' && n !== 'get_selection');
  assert.deepEqual(sides, [], '清单里只有 agent / server 侧的工具,外加点名的两个');
  assert.equal(checkCloudTool('update_clip', toolGroups).ok, true);
  const no = checkCloudTool('web_open', toolGroups);
  assert.equal(no.ok, false);
  assert.equal(no.cloudUnsupported, true);
  assert.match(no.error, /云端暂不支持 web_open/);
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
    assert.deepEqual(Object.keys(await h.json()).sort(), ['ok', 'version']);
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
    assert.deepEqual(kit.service.conversations(alice).find((c) => c.id === 'c-stop'), { id: 'c-stop', state: 'idle', reason: 'stopped', lastSeq: seen.length });
    await new Promise((r) => setTimeout(r, 100));
    assert.notEqual((await kit.doc.stateOf('p-a')).project.tracks[0].clips[0].end, 11, '停下之后没有新的写入');
  });

  await t.test('CA-TOOL-01 不在清单里的工具逐个回 cloudUnsupported,项目版本不变', async () => {
    const inst = kit.service._instance(alice);
    const before = (await kit.doc.stateOf('p-a')).rev;
    const closed = tools.map((x) => x.name).filter((n) => !CLOUD_OPEN_TOOLS.has(n));
    assert.equal(closed.length, tools.length - 66);
    for (const name of closed) {
      const r = await inst.callTool(name, {}, 'c-tools');
      assert.equal(r?.cloudUnsupported, true, `${name} 回云端暂不支持`);
      assert.equal(r.ok, false);
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
    await kit.service.send(alice, 'c-sel', { prompt: script([{ tool: 'get_selection', input: {} }, { say: '看到了' }]), pageState: { t: 2.5, selection: ['c1'] } });
    await kit.finished(alice, 'c-sel');
    const got = await inst.callTool('get_selection', {}, 'c-sel');
    assert.equal(got.ok, true);
    assert.deepEqual(got.ids, ['c1']);
    assert.equal(got.clips[0].id, 'c1');
    assert.equal(got.clips[0].trackId, 't1');
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
