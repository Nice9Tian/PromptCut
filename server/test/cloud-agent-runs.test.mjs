/**
 * 云端 Agent 服务:一轮的生命周期、事件补发、对话状态落盘、闸与用量、Key、补渲发布
 * (契约 `docs/plan/cloud-agent-contract.md` 第 2.4、6、7、8、9.4、16 节,第 13.1 节的编号)。
 * 跑:node --test server/test/cloud-agent-runs.test.mjs
 *
 *   CA-CHAT-01    事件的顺序与形状;`seq` 跨轮连续;`tool_result` 不带完整输出;
 *   CA-RUN-02     看到一半断开,再按 `after` 连:补发的加实时的与一口气看完的逐事件相同,不丢不重;增量合并后补发仍逐事件相同;
 *   CA-RUN-03     两台设备(同一个主人)同时看同一个对话:内容相同;另一台设备停,两边都收到 end;
 *   CA-RUN-04     主人键:同用户名换设备读得到同一份对话;创建者与同名成员互相读不到;不同用户名读不到;
 *   CA-RUN-05     每种收尾各自的 meta.json 状态、原因与事件记录里的那句话;
 *   CA-CHAT-03    对话的列、取、改标题、删;记录降级与封顶;对话数上限的淘汰不动在跑的;
 *   CA-CRASH-01   一轮进行中进程没了再起:标 interrupted、末尾有说明与 end;不自动续跑;接着说能续上,历史里没有悬空的工具调用;
 *   CA-GATE-01    每次模型请求前都过闸,每次请求后都有一行用量;
 *   CA-GATE-02    额度设成很小:超出后下一次模型请求不发,话里带已用与上限;设回不限后恢复;不重启;
 *   CA-GATE-03    用量流水、`usage()`、`admin.mjs usage` 三处一致;
 *   CA-GATE-04    并发:全节点、每项目、每成员三个上限各自生效,结束后名额释放;
 *   CA-GATE-05    `limits.json` 写坏:保留上一份,不崩;
 *   CA-KEY-01     `set-key.mjs`:命令行或环境变量里带 Key 拒绝;标准输入不是终端拒绝;写出的是密文;输出里没有 Key;
 *   CA-KEY-02     Key 出现在模型报错里:事件、对话记录、模型历史、日志四处都没有它;
 *   CA-LOG-01     跑完整轮,日志全文里没有提示词、回复正文、对话委托;
 *   CA-GRANT-04   对话委托只在内存里:数据目录与日志全文里没有它;凭证接口拿得到对话 id 与对话委托;
 *   CA-PAGE-01    发起方在线才用发消息时的页面状态;切剪辑的工具离线照常执行并注明;两个对话各用各的播放头;
 *   CA-TOOL-03    开放清单里的工具逐个跑一遍:没有任何 HTTP 请求发出去,没有碰作业表;
 *   CA-REVOKE-0x  撤销:进行中的一轮立刻停、记原因;只停受影响的;项目删除后对话目录被删;连接关闭码到原因的对应;
 *   CA-RENDER-01  写入落地后攒批发出清单计划,形状与在线页面的逐字段相同;新计划发出后旧的被撤回;一轮结束时补发;
 *   CA-RENDER-02  完成 → render done、清单清空、发布通道关闭;失败 → render failed 带片段与原因;没开 → unavailable、不发布;
 *                 连续没有进度 → 放弃并撤回;
 *   CA-RENDER-03  没渲完时进程没了再起:按 pending-render.json 重新发布,不需要任何成员连接。
 *
 * 文档服务是本机回环的内存实例,模型是模拟提供方,全部不出网。鉴权、凭证、补渲的发布通道是测试替身(乙块与第三段合流后接真的)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createConversationStore, expandEntry, mergeDeltas } from '../agent/service/conversations.mjs';
import { createGate, limitsFileOf, normalizeLimits } from '../agent/service/gate.mjs';
import { createUsageLog, queryUsage } from '../agent/service/usage.mjs';
import { ownerKeyOf, revokeReasonOfClose } from '../agent/service/create-agent-service.mjs';
import { CLOUD_OPEN_TOOLS } from '../agent/service/cloud-tools.mjs';
import { readModelConfig, modelConfigPaths } from '../agent/service/model-config.mjs';
import { STALL_REASON } from '../agent/service/render-request.mjs';
import { clipsPlanTaskOf } from '../render-queue/messages.mjs';
import { runSetKey } from '../agent-service/set-key.mjs';
import { runAdmin } from '../agent-service/admin.mjs';
import { startAgentService } from '../agent-service/main.mjs';
import { tools } from '../mcp-tools.mjs';
import { waitFor } from './fake-ws-kit.mjs';
import { project, script, credentials, modelConfig, startDoc, startKit, readSse } from './cloud-agent-kit.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A1 = { projectId: 'p-a', userId: 'alice@d1', username: 'alice', deviceName: '电脑一', mode: 'restricted' };
const A2 = { projectId: 'p-a', userId: 'alice@d2', username: 'alice', deviceName: '电脑二', mode: 'restricted' };
const BOB = { projectId: 'p-a', userId: 'bob@d1', username: 'bob', deviceName: 'B', mode: 'restricted' };
const metaOf = (kit, identity, id) => JSON.parse(fs.readFileSync(path.join(kit.dataDir, 'tenants', identity.projectId, 'owners', ownerKeyOf(identity), 'conversations', id, 'meta.json'), 'utf8'));
const dirOf = (kit, identity, id) => path.join(kit.dataDir, 'tenants', identity.projectId, 'owners', ownerKeyOf(identity), 'conversations', id);
/** 目录下所有文件的全文(查有没有不该落盘的东西) */
function allText(dir) {
  let out = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out += e.isDirectory() ? allText(p) : `${fs.readFileSync(p, 'utf8')}\n`;
  }
  return out;
}
const collect = () => { const seen = []; return { seen, cb: (ev) => seen.push(ev) }; };

test('事件记录:增量并成整段后,补发与实时逐事件相同;从任意 seq 接上都无缺无重', () => {
  const store = createConversationStore({ dataDir: null });
  const conv = store.get('p', 'o', 'c1', { create: true });
  const live = collect();
  store.subscribe(conv, 0, live.cb);
  store.emit(conv, { type: 'user', runId: 'r', prompt: '问' });
  for (const d of ['你', '好,', '', '世界']) store.emit(conv, { type: 'text', runId: 'r', delta: d });
  store.emit(conv, { type: 'thinking', runId: 'r', round: 1, delta: '想' });
  store.emit(conv, { type: 'thinking', runId: 'r', round: 1, delta: '一想' });
  store.emit(conv, { type: 'thinking', runId: 'r', round: 2, delta: '再想' });
  store.emit(conv, { type: 'text', runId: 'r', delta: '完' });
  store.emit(conv, { type: 'end', runId: 'r', state: 'idle' });
  const before = conv.entries.length;
  store.compact(conv);
  assert.ok(conv.entries.length < before, '记录里的行变少了');
  assert.equal(conv.entries.find((e) => e.type === 'text').delta, '你好,世界');
  const replay = collect();
  store.subscribe(conv, 0, replay.cb)();
  assert.deepEqual(replay.seen, live.seen, '从头补发与实时流逐事件相同');
  assert.deepEqual(replay.seen.map((e) => e.seq), replay.seen.map((_, i) => i + 1));
  for (let after = 0; after <= live.seen.length; after += 1) {
    const part = collect();
    store.subscribe(conv, after, part.cb)();
    assert.deepEqual(part.seen, live.seen.slice(after), `after=${after}`);
  }
  // 再来一轮、再并一次:已经并过的不坏
  store.emit(conv, { type: 'text', runId: 'r2', delta: '甲' });
  store.emit(conv, { type: 'text', runId: 'r2', delta: '乙' });
  store.compact(conv);
  const again = collect();
  store.subscribe(conv, 0, again.cb)();
  assert.deepEqual(again.seen, live.seen);
  assert.deepEqual([...expandEntry(mergeDeltas([{ type: 'text', delta: 'a', seq: 1 }, { type: 'text', delta: 'b', seq: 2 }])[0])], [{ type: 'text', delta: 'a', seq: 1 }, { type: 'text', delta: 'b', seq: 2 }]);
});

test('CA-GATE-04 / CA-GATE-05 闸:三个并发上限各自生效、结束后释放;limits.json 写坏保留上一份', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-gate-'));
  try {
    const file = limitsFileOf(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const logs = [];
    const usage = createUsageLog({ dir: null });
    const gate = createGate({ limitsFile: file, usage, log: (event, f) => logs.push({ event, ...f }) });
    // 没有文件:额度永远放行,并发用缺省数字(全节点 6、每项目 3、每成员 2)
    assert.deepEqual(gate.nodeLimits(), { maxRuns: 6, maxRunsPerProject: 3, maxRunsPerMember: 2, maxInstances: 24 });
    assert.equal(gate.admitRun({ projectId: 'p1', userId: 'u1' }).ok, true);
    assert.equal(gate.admitRun({ projectId: 'p1', userId: 'u1' }).ok, true);
    assert.deepEqual(gate.admitRun({ projectId: 'p1', userId: 'u1' }), { ok: false, code: 'busy', message: '云端 Agent 正忙,请稍后再试。' }, '每成员 2');
    assert.equal(gate.admitRun({ projectId: 'p1', userId: 'u2' }).ok, true);
    assert.equal(gate.admitRun({ projectId: 'p1', userId: 'u3' }).code, 'busy', '每项目 3');
    assert.equal(gate.admitRun({ projectId: 'p2', userId: 'u1' }).ok, true);
    assert.equal(gate.admitRun({ projectId: 'p2', userId: 'u2' }).ok, true);
    assert.equal(gate.admitRun({ projectId: 'p2', userId: 'u3' }).ok, true);
    assert.equal(gate.admitRun({ projectId: 'p3', userId: 'u9' }).code, 'busy', '全节点 6');
    gate.release({ projectId: 'p1', userId: 'u1' });
    assert.equal(gate.admitRun({ projectId: 'p3', userId: 'u9' }).ok, true, '释放后名额回来');
    for (const [p, u] of [['p1', 'u1'], ['p1', 'u2'], ['p2', 'u1'], ['p2', 'u2'], ['p2', 'u3'], ['p3', 'u9']]) gate.release({ projectId: p, userId: u });
    assert.deepEqual(gate.describe(), { running: 0, projects: {}, members: 0 });

    // 改文件即生效
    fs.writeFileSync(file, JSON.stringify({ v: 1, node: { maxRuns: 1 }, projects: { p1: { limitTokens: 10 } } }));
    assert.equal(gate.nodeLimits().maxRuns, 1);
    usage.append({ projectId: 'p1', userId: 'u1', input: 8, output: 4 });
    const no = gate.admitModelCall({ projectId: 'p1', userId: 'u1', model: 'm' });
    assert.equal(no.code, 'quota-exceeded');
    assert.match(no.message, /已用 12 \/ 上限 10/);
    assert.equal(gate.admitModelCall({ projectId: 'p2', userId: 'u1', model: 'm' }).ok, true, '别的项目不受影响');
    // 写坏:保留上一份
    fs.writeFileSync(file, '{ "v": 1, "projects": { "p1": { "limitTokens": "很多" } }');
    assert.equal(gate.admitModelCall({ projectId: 'p1', userId: 'u1', model: 'm' }).code, 'quota-exceeded', '写坏之后仍按上一份');
    assert.equal(gate.nodeLimits().maxRuns, 1);
    assert.ok(logs.some((l) => l.event === 'agent.limits.invalid'));
    fs.writeFileSync(file, JSON.stringify({ v: 1, projects: { p1: { limitTokens: -3 } } }));
    assert.equal(gate.admitModelCall({ projectId: 'p1', userId: 'u1', model: 'm' }).code, 'quota-exceeded', '格式对但值不合法也保留上一份');
    // 设回不限
    fs.writeFileSync(file, JSON.stringify({ v: 1 }));
    assert.equal(gate.admitModelCall({ projectId: 'p1', userId: 'u1', model: 'm' }).ok, true);
    assert.throws(() => normalizeLimits({ node: { maxRuns: 0 } }));
    // 开关关着:最先判
    const off = createGate({ usage, isEnabled: (p) => p !== 'p-off' });
    assert.deepEqual(off.admitRun({ projectId: 'p-off', userId: 'u' }), { ok: false, code: 'disabled', message: '项目创建者已关闭云端 Agent。' });
    assert.equal(off.admitModelCall({ projectId: 'p-off', userId: 'u' }).code, 'disabled');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('用量记录:累计的检查点加之后的流水重建;检查点坏了从流水全量重算;窗口按 UTC', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-usage-'));
  try {
    const t0 = Date.UTC(2026, 8, 30, 23, 0, 0);
    let at = t0;
    const a = createUsageLog({ dir, now: () => at });
    a.append({ t: at, projectId: 'p1', userId: 'u1@d', username: 'u1', vendor: 'mock', model: 'm1', input: 100, output: 20, ok: true, ms: 5, prompt: '不该落盘的正文' });
    a.flush();
    at = Date.UTC(2026, 9, 1, 1, 0, 0);
    a.append({ t: at, projectId: 'p1', userId: 'u2@d', username: 'u2', vendor: 'mock', model: 'm2', input: 7, output: 3, ok: true, ms: 5 });
    // 不 flush、不 close:模拟进程被杀
    const b = createUsageLog({ dir, now: () => at });
    assert.equal(b.used('p1', 'total'), 130);
    assert.equal(b.used('p1', 'month'), 10, '十月只有第二次');
    assert.equal(b.used('p1', 'day'), 10);
    fs.writeFileSync(path.join(dir, 'totals.json'), '{ 坏的');
    const c = createUsageLog({ dir, now: () => at });
    assert.equal(c.used('p1', 'total'), 130, '检查点坏了从流水重算');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort(), ['2026-09.jsonl', '2026-10.jsonl']);
    const text = allText(dir);
    assert.equal(text.includes('不该落盘的正文'), false, '流水里只有规定的字段');
    const q = queryUsage(dir, { projectId: 'p1', since: Date.UTC(2026, 9, 1) });
    assert.equal(q.calls, 1);
    assert.deepEqual(q.projects.p1.models, { 'mock/m2': { tokens: 10, calls: 1 } });
    b.close(); c.close(); a.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CA-KEY-01 set-key:不收命令行与环境变量里的 Key;不是终端拒绝;写出的是密文;输出里没有 Key;--mock 与 --clear', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-key-'));
  const KEY = 'sk-test-0123456789abcdefWXYZ';
  const run = async ({ argv = [], env = {}, input = null, tty = true }) => {
    const stdin = new PassThrough();
    stdin.isTTY = tty;
    stdin.setRawMode = () => stdin;
    const out = [];
    const stdout = { write: (s) => { out.push(String(s)); return true; } };
    const p = runSetKey({ argv, env: { PROMPTCUT_AGENT_DATA: dataDir, ...env }, stdin, stdout });
    if (input !== null) for (const line of input) { await sleep(5); stdin.write(line); }
    const code = await p;
    return { code, out: out.join('') };
  };
  try {
    const viaArg = await run({ argv: [KEY] });
    assert.equal(viaArg.code, 1);
    assert.match(viaArg.out, /不接受从命令行/);
    assert.equal(viaArg.out.includes(KEY), false, '报错里不复述 Key');
    const viaFlag = await run({ argv: ['--key', KEY] });
    assert.equal(viaFlag.code, 1);
    const viaEnv = await run({ env: { PROMPTCUT_AGENT_MODEL_KEY: KEY } });
    assert.equal(viaEnv.code, 1);
    assert.match(viaEnv.out, /不接受从环境变量/);
    assert.equal(viaEnv.out.includes(KEY), false);
    const piped = await run({ tty: false, input: [`anthropic\n\nm1\n\n${KEY}\n`] });
    assert.equal(piped.code, 1);
    assert.match(piped.out, /标准输入不是终端/);
    assert.equal(fs.existsSync(modelConfigPaths(dataDir).file), false, '被拒的几次什么都没写');

    // 正常录入(回车用 \r,像终端的 raw 模式)
    const ok = await run({ input: ['openai\r', 'https://api.example.test/v1\r', 'model-a|model-b\r', '\r', `${KEY}\r`] });
    assert.equal(ok.code, 0, ok.out);
    assert.equal(ok.out.includes(KEY), false, '输出里没有 Key(输入时不回显)');
    assert.match(ok.out, /已保存,末四位 WXYZ/);
    const { file, keyFile } = modelConfigPaths(dataDir);
    const sealed = fs.readFileSync(keyFile, 'utf8');
    assert.match(sealed, /^PCENC1\./, '写出的是密文');
    assert.equal(sealed.includes(KEY), false);
    assert.equal(fs.readFileSync(file, 'utf8').includes(KEY), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    assert.deepEqual(readModelConfig(dataDir), { vendor: 'openai', baseUrl: 'https://api.example.test/v1', model: 'model-a|model-b', maxTokens: 4096, apiKey: KEY });

    const mock = await run({ argv: ['--mock'], tty: false });
    assert.equal(mock.code, 0);
    assert.equal(readModelConfig(dataDir).vendor, 'mock');
    const cleared = await run({ argv: ['--clear'], tty: false });
    assert.equal(cleared.code, 0);
    assert.equal(fs.existsSync(keyFile), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('一轮的生命周期、收尾与对话状态', { timeout: 240_000 }, async (t) => {
  const seenCreds = [];
  const creds = { protocolsFor: (identity, n, extra) => { seenCreds.push({ userId: identity.userId, n, ...extra }); return credentials.protocolsFor(identity, n); } };
  const KEY = 'sk-mock-SECRET-0123456789';
  const kit = await startKit(t, { extra: { credentials: creds, modelConfig: () => ({ vendor: 'mock', model: 'mock-1|mock-2', apiKey: KEY, baseUrl: 'https://models.example.test/v1' }) } });
  await kit.doc.seed(project('p-a', '甲'));
  await kit.doc.seed(project('p-b', '乙'));
  const svc = kit.service;

  await t.test('CA-CHAT-01 事件的顺序与形状;seq 跨轮连续;tool_result 不带完整输出', async () => {
    const r1 = await svc.send(A1, 'c-order', { prompt: script([{ tool: 'update_clip', input: { clipId: 'c1', end: 5 } }, { say: '第一轮完' }]) });
    const e1 = await kit.finished(A1, 'c-order');
    assert.equal(r1.seq, 1);
    const types = e1.map((e) => e.type);
    assert.equal(types[0], 'user');
    assert.equal(types.at(-1), 'end');
    const order = ['user', 'run', 'session', 'tool_call', 'tool_result', 'text', 'done', 'end'].map((x) => types.indexOf(x));
    assert.ok(order.every((x) => x >= 0), `都有:${types.join(',')}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, '先后顺序对');
    assert.deepEqual(e1.map((e) => e.seq), e1.map((_, i) => i + 1));
    assert.ok(e1.every((e) => e.runId === r1.runId));
    assert.deepEqual(Object.keys(e1[0]).sort(), ['at', 'from', 'prompt', 'runId', 'seq', 'type']);
    assert.equal(e1[0].from, '电脑一');
    for (const e of e1.filter((x) => x.type === 'tool_result')) assert.equal(e.output, undefined);
    for (const e of e1.filter((x) => x.type === 'diagnostic')) assert.ok(['configuration', 'request', 'response'].includes(e.stage));
    assert.equal(JSON.stringify(e1).includes('models.example.test'), false, '事件里没有模型接口的地址');
    assert.deepEqual(e1.at(-1), { type: 'end', runId: r1.runId, state: 'idle', seq: e1.length });
    const r2 = await svc.send(A1, 'c-order', { prompt: script([{ say: '第二轮完' }]) });
    assert.equal(r2.seq, e1.length + 1, 'seq 跨轮连续');
    await waitFor(() => svc.conversation(A1, 'c-order').state === 'idle', 20_000, '第二轮结束');
    const all = await kit.finished(A1, 'c-order');
    assert.deepEqual(all.map((e) => e.seq), all.map((_, i) => i + 1));
    assert.deepEqual(metaOf(kit, A1, 'c-order').lastSeq, all.length);
    assert.equal(metaOf(kit, A1, 'c-order').title, '按脚本做。');
    // 事件记录在盘上,一行一个事件
    const lines = fs.readFileSync(path.join(dirOf(kit, A1, 'c-order'), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.at(-1).seq, all.length);
  });

  await t.test('CA-RUN-02 / CA-RUN-03 断开再按 after 连:无缺无重;两台设备同时看;另一台设备停', async () => {
    const steps = [{ tool: 'get_project', input: {} }, { sleepMs: 150 }, { tool: 'update_clip', input: { clipId: 'c1', label: '改一' } }, { sleepMs: 150 }, { tool: 'update_clip', input: { clipId: 'c1', label: '改二' } }, { sleepMs: 20_000 }, { say: '不会到这里' }];
    await svc.send(A1, 'c-two', { prompt: script(steps) });
    const whole = collect();
    svc.subscribe(A2, 'c-two', 0, whole.cb); // 另一台设备从头看到尾
    const first = collect();
    const off = svc.subscribe(A1, 'c-two', 0, first.cb);
    await waitFor(() => first.seen.filter((e) => e.type === 'tool_result').length >= 1, 20_000, '看到第一步');
    off();
    const cut = first.seen.at(-1).seq;
    await waitFor(() => whole.seen.filter((e) => e.type === 'tool_result').length >= 3, 20_000, '断开期间这一轮照跑');
    const second = collect();
    svc.subscribe(A1, 'c-two', cut, second.cb); // 按 seq 补齐,再接实时
    assert.deepEqual(svc.abort(A2, 'c-two'), { ok: true }); // 另一台设备停
    await waitFor(() => whole.seen.some((e) => e.type === 'end') && second.seen.some((e) => e.type === 'end'), 2000, '两边都收到 end');
    const joined = [...first.seen, ...second.seen];
    assert.deepEqual(joined, whole.seen, '补发的加实时的与一口气看完的逐事件相同');
    assert.deepEqual(joined.map((e) => e.seq), joined.map((_, i) => i + 1), '无缺无重');
    assert.equal(whole.seen.at(-1).state, 'idle');
    assert.equal(metaOf(kit, A1, 'c-two').reason, 'stopped');
    assert.equal((await kit.doc.stateOf('p-a')).project.tracks[0].clips[0].label, '改二', '项目停在最后一次成功提交之后');
    // 不是这个主人的人停不了、看不到
    assert.equal(svc.subscribe(BOB, 'c-two', 0, () => {}), null);
  });

  await t.test('CA-RUN-04 主人键:换设备读得到同一份;创建者与同名成员互相读不到;不同用户名读不到', () => {
    assert.deepEqual(svc.conversations(A2).map((c) => c.id).sort(), svc.conversations(A1).map((c) => c.id).sort());
    assert.ok(svc.conversations(A1).some((c) => c.id === 'c-order'));
    assert.equal(svc.conversations(A2).find((c) => c.id === 'c-order').startedOn, '电脑一');
    assert.deepEqual(svc.conversations(BOB), []);
    assert.deepEqual(svc.conversations({ ...A1, creator: true }), [], '创建者身份读不到同名成员的');
    assert.deepEqual(svc.conversations({ ...A1, mode: 'free' }), [], '自由进入的按设备,读不到');
    assert.deepEqual(svc.conversations({ ...A1, projectId: 'p-b' }), [], '别的项目读不到');
    // 文档服务核验后直接给主人键时用它
    assert.equal(ownerKeyOf({ projectId: 'p-a', userId: 'x@y', ownerKey: 'user:alice' }), ownerKeyOf(A1));
    assert.equal(svc.conversation(BOB, 'c-order'), null);
  });

  await t.test('CA-RUN-05 每种收尾各自的状态、原因与那句话', async (t2) => {
    const tail = async (identity, id) => {
      const ev = await kit.finished(identity, id);
      const m = metaOf(kit, identity, id);
      return { ev, m, err: ev.filter((e) => e.type === 'error').at(-1), end: ev.at(-1) };
    };
    // 模型调用失败
    await svc.send(A1, 'c-fail', { prompt: script([{ tool: 'update_clip', input: { clipId: 'c1', label: '失败前落地的' } }, { fail: '上游 500:请求 {{baseUrl}}/messages 被拒,key={{apiKey}}' }]) });
    const f = await tail(A1, 'c-fail');
    assert.equal(f.end.state, 'failed');
    assert.equal(f.err.code, 'model');
    assert.match(f.err.message, /^模型调用失败:上游 500/);
    assert.deepEqual([f.m.state, f.m.reason], ['failed', 'model']);
    assert.equal(f.m.message, f.err.message);
    assert.equal((await kit.doc.stateOf('p-a')).project.tracks[0].clips[0].label, '失败前落地的', '已经落地的改动保留');

    await t2.test('CA-KEY-02 Key 与接口地址出现在模型报错里:事件、对话记录、模型历史、日志里都没有', () => {
      for (const [name, text] of [['事件', JSON.stringify(f.ev)], ['数据目录', allText(kit.dataDir)], ['日志', JSON.stringify(kit.logs)]]) {
        assert.equal(text.includes(KEY), false, `${name}里没有 Key`);
        assert.equal(text.includes('models.example.test'), false, `${name}里没有接口地址`);
      }
    });

    // 到时间上限
    const short = kit.another({ limits: { runMs: 400 } });
    await short.send(BOB, 'c-limit', { prompt: script([{ sleepMs: 20_000 }]) });
    const l = await kit.finished(BOB, 'c-limit', 10_000, short);
    assert.equal(l.at(-1).state, 'failed');
    assert.equal(l.filter((e) => e.type === 'error').at(-1).code, 'limit');
    assert.deepEqual([metaOf(kit, BOB, 'c-limit').state, metaOf(kit, BOB, 'c-limit').reason], ['failed', 'limit']);

    // 撤销:四种原因,只停受影响的
    const reasons = { disabled: /项目创建者已关闭云端 Agent/, removed: /已被移出这个项目/, kicked: /已被请出这个项目/ };
    for (const [reason, re] of Object.entries(reasons)) {
      const id = `c-rev-${reason}`;
      await svc.send(A1, id, { prompt: script([{ tool: 'update_clip', input: { clipId: 'c1', label: `撤销前-${reason}` } }, { sleepMs: 20_000 }, { tool: 'update_clip', input: { clipId: 'c1', label: '撤销后不该有' } }]) });
      await svc.send({ ...A1, projectId: 'p-b' }, id, { prompt: script([{ sleepMs: 300 }, { say: '另一个项目照常' }]) });
      const live = collect();
      svc.subscribe(A2, id, 0, live.cb);
      await waitFor(() => live.seen.some((e) => e.type === 'tool_result'), 20_000, '第一步落地');
      const at = Date.now();
      svc.revoke({ projectId: 'p-a', ...(reason === 'disabled' ? {} : { userId: A1.userId }), reason });
      await waitFor(() => live.seen.some((e) => e.type === 'end'), 2000, '停下');
      assert.ok(Date.now() - at < 2000, '2 秒内');
      const err = live.seen.filter((e) => e.type === 'error').at(-1);
      assert.deepEqual([err.code, err.reason], ['revoked', reason]);
      assert.match(err.message, re);
      assert.deepEqual(live.seen.at(-1), { type: 'end', runId: err.runId, state: 'revoked', reason, seq: live.seen.length });
      assert.deepEqual([metaOf(kit, A1, id).state, metaOf(kit, A1, id).reason], ['revoked', reason]);
      await sleep(150);
      assert.equal((await kit.doc.stateOf('p-a')).project.tracks[0].clips[0].label, `撤销前-${reason}`, '之后没有新的写入');
      const other = await kit.finished({ ...A1, projectId: 'p-b' }, id);
      assert.equal(other.at(-1).state, 'idle', 'CA-REVOKE-03 同一位成员在另一个项目的对话照常');
      assert.equal(svc._instance(A1), null, '受影响的实例关了');
    }
    // 文档服务不给票据(授权过期、代数变了):这一轮按原因收尾。接口位:凭证一侧抛带 reason 的错
    await svc.send(A1, 'c-keep', { prompt: script([{ sleepMs: 20_000 }]) });
    const keep = collect();
    svc.subscribe(A2, 'c-keep', 0, keep.cb);
    await waitFor(() => keep.seen.some((e) => e.type === 'diagnostic'), 20_000, '这一轮起来了(实例自己的连接已经连上)');
    const real = creds.protocolsFor;
    creds.protocolsFor = (identity, n, extra) => {
      if (extra.conversationId === 'c-expired') throw Object.assign(new Error('对话委托的代数变了'), { reason: 'generation' });
      if (extra.conversationId === 'c-flaky') throw Object.assign(new Error('控制连接断着'), { reason: 'unavailable' });
      return real(identity, n, extra);
    };
    const exp = collect();
    await svc.send(A1, 'c-expired', { prompt: script([{ tool: 'update_clip', input: { clipId: 'c1', label: '换不出票据,不该落地' } }, { sleepMs: 20_000 }]) });
    svc.subscribe(A2, 'c-expired', 0, exp.cb);
    await waitFor(() => exp.seen.some((e) => e.type === 'end'), 5000, '按原因收尾');
    const ee = exp.seen.filter((e) => e.type === 'error').at(-1);
    assert.deepEqual([ee.code, ee.reason], ['revoked', 'generation']);
    assert.match(ee.message, /成员名单或口令改过/);
    assert.deepEqual([metaOf(kit, A1, 'c-expired').state, metaOf(kit, A1, 'c-expired').reason], ['revoked', 'generation']);
    assert.equal(keep.seen.some((e) => e.type === 'end'), false, '同一个实例里别的对话不受连累');
    // 暂时性的连不上不收尾:这一轮还在,工具自己报错
    const flaky = collect();
    await svc.send(A2, 'c-flaky', { prompt: script([{ tool: 'update_clip', input: { clipId: 'c1', label: '连不上' } }, { sleepMs: 20_000 }]) });
    svc.subscribe(A1, 'c-flaky', 0, flaky.cb);
    await waitFor(() => flaky.seen.some((e) => e.type === 'tool_result'), 10_000, '工具报了错');
    assert.equal(flaky.seen.find((e) => e.type === 'tool_result').ok, false);
    assert.equal(flaky.seen.some((e) => e.type === 'end'), false, '暂时性故障不收尾');
    creds.protocolsFor = real;
    svc.abort(A1, 'c-flaky');
    svc.abort(A1, 'c-keep');
    assert.notEqual((await kit.doc.stateOf('p-a')).project.tracks[0].clips[0].label, '换不出票据,不该落地');

    assert.equal(revokeReasonOfClose({ code: 4004, reason: 'deleted' }), 'deleted');
    assert.equal(revokeReasonOfClose({ code: 4003, reason: 'service-disabled' }), 'disabled');
    assert.equal(revokeReasonOfClose({ code: 4003, reason: 'kicked' }), 'kicked');
    assert.equal(revokeReasonOfClose({ code: 4003, reason: 'removed' }), 'removed');
  });

  await t.test('CA-GRANT-04 / CA-LOG-01 对话委托只在内存里;凭证接口拿得到对话 id 与委托;日志里没有正文', async () => {
    const GRANT = 'v1.grant-payload-ZZZ.signature-QQQ';
    seenCreds.length = 0;
    await svc.send(A1, 'c-grant', { grant: GRANT, prompt: script([{ tool: 'update_clip', input: { clipId: 'c1', label: '带委托写的' } }, { say: '机密的回复正文' }]) });
    await kit.finished(A1, 'c-grant');
    const mine = seenCreds.filter((c) => c.conversationId === 'c-grant');
    assert.ok(mine.length >= 1, '这个对话的连接要过凭证');
    assert.ok(mine.every((c) => c.grant === GRANT && c.userId === A1.userId && Number.isSafeInteger(c.n)));
    assert.equal(allText(kit.dataDir).includes('grant-payload-ZZZ'), false, '数据目录里没有对话委托');
    const logs = JSON.stringify(kit.logs);
    for (const leak of ['grant-payload-ZZZ', '机密的回复正文', 'mock-script', '带委托写的', '按脚本做']) assert.equal(logs.includes(leak), false, `日志里不该有 ${leak}`);
  });

  await t.test('CA-CHAT-03 对话的列、取、改标题、删', async () => {
    const got = svc.conversation(A2, 'c-order');
    assert.deepEqual([got.id, got.state, got.title], ['c-order', 'idle', '按脚本做。']);
    assert.equal(svc.rename(A2, 'c-order', '  新标题  '), true);
    assert.equal(metaOf(kit, A1, 'c-order').title, '新标题');
    assert.equal(svc.rename(BOB, 'c-order', '别人改'), false);
    assert.equal(svc.remove(BOB, 'c-order'), false);
    assert.equal(fs.existsSync(path.join(dirOf(kit, A1, 'c-order'), 'history.json')), true);
    assert.equal(svc.remove(A2, 'c-order'), true);
    assert.equal(fs.existsSync(dirOf(kit, A1, 'c-order')), false, '连模型历史一起删');
    assert.equal(svc.conversation(A1, 'c-order'), null);
    // 删进行中的:先停
    await svc.send(A1, 'c-del', { prompt: script([{ sleepMs: 20_000 }]) });
    assert.equal(svc.remove(A1, 'c-del'), true);
    assert.equal(svc._instance(A1) ? svc.describe().instances.reduce((n, i) => n + i.running, 0) : 0, 0, '名额还了');
    assert.equal(fs.existsSync(dirOf(kit, A1, 'c-del')), false);
    // 同一个对话还有一轮在跑时再发:409
    await svc.send(A1, 'c-busy', { prompt: script([{ sleepMs: 20_000 }]) });
    await assert.rejects(() => svc.send(A2, 'c-busy', { prompt: 'x' }), (err) => err.code === 'busy-conversation' && err.status === 409);
    svc.abort(A1, 'c-busy');
  });

  await t.test('CA-REVOKE-02 项目删除:进行中的停下,对话目录被删', async () => {
    await svc.send({ ...A1, projectId: 'p-b' }, 'c-gone', { prompt: script([{ sleepMs: 20_000 }]) });
    const live = collect();
    svc.subscribe({ ...A2, projectId: 'p-b' }, 'c-gone', 0, live.cb);
    svc.revoke({ projectId: 'p-b', reason: 'deleted' });
    assert.deepEqual([live.seen.at(-2).code, live.seen.at(-2).reason, live.seen.at(-1).state], ['revoked', 'deleted', 'revoked']);
    assert.equal(fs.existsSync(path.join(kit.dataDir, 'tenants', 'p-b')), false);
    assert.ok(fs.existsSync(path.join(kit.dataDir, 'usage')), '用量记录留着');
  });
});

test('CA-CHAT-03 记录降级与封顶;对话数上限的淘汰不动在跑的', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-store-'));
  try {
    let at = 1000;
    const store = createConversationStore({ dataDir, now: () => at, limits: { degradeBytes: 600, capBytes: 1200, maxPerOwner: 3 } });
    const c = store.get('p', 'o', 'c1', { create: true });
    assert.ok(store.emit(c, { type: 'thinking', delta: '想' }), '没到线照记');
    while (c.bytes < 600) store.emit(c, { type: 'text', delta: '字'.repeat(20) });
    assert.equal(store.emit(c, { type: 'thinking', delta: '想' }), null, '降级后不记 thinking');
    assert.equal(store.emit(c, { type: 'diagnostic', stage: 'request' }), null);
    assert.ok(store.emit(c, { type: 'tool_call', name: 'x' }), '别的照记');
    assert.equal(store.full(c), false);
    while (c.bytes < 1200) store.emit(c, { type: 'text', delta: '字'.repeat(20) });
    assert.equal(store.full(c), true, '封顶后不能再发消息');
    // 对话数上限:删最久没动且不在跑的
    c.run = { runId: 'r' }; // c1 最旧,但在跑
    at = 2000; store.setState(store.get('p', 'o', 'c2', { create: true }), {});
    at = 3000; store.setState(store.get('p', 'o', 'c3', { create: true }), {});
    at = 4000; store.get('p', 'o', 'c4', { create: true });
    assert.deepEqual(store.list('p', 'o').map((m) => m.id).sort(), ['c1', 'c3', 'c4'], 'c2 被淘汰,在跑的 c1 留着');
    // 目录名:走不出 tenants/
    assert.throws(() => store.get('..', 'o', 'c1', { create: true }));
    assert.equal(store.get('p', 'o', '../x', { create: true }), null);
    store.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('闸与用量接进一轮;进程没了再起', { timeout: 240_000 }, async (t) => {
  const kit = await startKit(t);
  await kit.doc.seed(project('p-a', '甲'));
  const svc = kit.service;
  const limitsFile = limitsFileOf(kit.dataDir);
  fs.mkdirSync(path.dirname(limitsFile), { recursive: true });
  const usageRows = () => queryUsage(path.join(kit.dataDir, 'usage')).rows;

  await t.test('CA-GATE-01 每次模型请求前都过闸,每次请求后都有一行用量', async () => {
    const r = await svc.send(A1, 'c-gate', { model: 'mock-1', prompt: script([{ tool: 'get_project', input: {} }, { tool: 'update_clip', input: { clipId: 'c1', end: 6 } }, { say: '完' }]) });
    const ev = await kit.finished(A1, 'c-gate');
    const requests = ev.filter((e) => e.type === 'diagnostic' && e.stage === 'request').length;
    assert.equal(requests, 3, '三次模型请求');
    const rows = usageRows();
    assert.equal(rows.length, 3, '每次请求一行');
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['cacheRead', 'conversationId', 'input', 'model', 'ms', 'ok', 'output', 'projectId', 'runId', 't', 'userId', 'username', 'vendor']);
      assert.deepEqual([row.projectId, row.userId, row.username, row.conversationId, row.runId, row.vendor, row.model, row.ok], ['p-a', 'alice@d1', 'alice', 'c-gate', r.runId, 'mock', 'mock-1', true]);
      assert.ok(row.input > 0 && row.output > 0);
    }
    // 模型历史每完成一次工具往返落一次盘(进行中也在)
    assert.ok(fs.existsSync(path.join(dirOf(kit, A1, 'c-gate'), 'history.json')));
  });

  await t.test('CA-GATE-02 额度很小:超出后下一次模型请求不发;设回不限后恢复;不重启', async () => {
    const used = usageRows().reduce((n, r) => n + r.input + r.output, 0);
    fs.writeFileSync(limitsFile, JSON.stringify({ v: 1, projects: { 'p-a': { limitTokens: used + 1 } } }));
    const before = usageRows().length;
    await svc.send(A1, 'c-quota', { prompt: script([{ tool: 'update_clip', input: { clipId: 'c1', label: '额度内的一步' } }, { tool: 'update_clip', input: { clipId: 'c1', label: '额度外不该有' } }, { say: '不会到' }]) });
    const ev = await kit.finished(A1, 'c-quota');
    const err = ev.filter((e) => e.type === 'error').at(-1);
    assert.equal(err.code, 'quota-exceeded');
    assert.match(err.message, /额度已用完\(已用 \d+ \/ 上限 \d+\)。请联系托管方。/);
    assert.equal(ev.at(-1).state, 'failed');
    assert.deepEqual([metaOf(kit, A1, 'c-quota').state, metaOf(kit, A1, 'c-quota').reason], ['failed', 'quota-exceeded']);
    assert.equal(usageRows().length, before + 1, '超出之后那一次模型请求没有发');
    assert.equal((await kit.doc.stateOf('p-a')).project.tracks[0].clips[0].label, '额度内的一步', '已落地的保留,之后没有新的写入');
    await assert.rejects(() => svc.send(A1, 'c-quota', { prompt: '再来' }), (e) => e.code === 'quota-exceeded' && e.status === 429 && /已用 \d+ \/ 上限 \d+/.test(e.message));
    assert.deepEqual((await svc.info(A1)).usage.limitTokens, used + 1);
    // 用管理命令设回不限:不重启
    const out = [];
    assert.equal(runAdmin(['quota', 'clear', 'p-a'], { env: { PROMPTCUT_AGENT_DATA: kit.dataDir }, stdout: { write: (s) => out.push(s) } }), 0);
    await svc.send(A1, 'c-quota', { prompt: script([{ say: '恢复了' }]) });
    const again = await kit.finished(A1, 'c-quota');
    await waitFor(() => svc.conversation(A1, 'c-quota').state === 'idle', 20_000, '恢复后的一轮结束');
    assert.equal((await kit.finished(A1, 'c-quota')).filter((e) => e.type === 'text').at(-1).delta, '恢复了');
    assert.ok(again.length > ev.length);
    assert.equal((await svc.info(A1)).usage.limitTokens, null);
    // 管理命令再设一次,服务读得到
    assert.equal(runAdmin(['quota', 'set', 'p-a', '--tokens', '5', '--window', 'month'], { env: { PROMPTCUT_AGENT_DATA: kit.dataDir }, stdout: { write: () => {} } }), 0);
    assert.deepEqual([(await svc.info(A1)).usage.limitTokens, (await svc.info(A1)).usage.window], [5, 'month']);
    assert.equal(runAdmin(['quota', 'clear', 'p-a'], { env: { PROMPTCUT_AGENT_DATA: kit.dataDir }, stdout: { write: () => {} } }), 0);
  });

  await t.test('CA-GATE-03 用量流水、usage()、admin usage 三处一致', () => {
    const rows = usageRows();
    const tokens = rows.reduce((n, r) => n + r.input + r.output, 0);
    const viaApi = svc.usage(BOB);
    assert.deepEqual(viaApi, { project: { tokens, calls: rows.length }, members: [{ username: 'alice', tokens, calls: rows.length }] });
    const out = [];
    assert.equal(runAdmin(['usage', '--project', 'p-a', '--json'], { env: { PROMPTCUT_AGENT_DATA: kit.dataDir }, stdout: { write: (s) => out.push(s) } }), 0);
    const viaAdmin = JSON.parse(out.join(''));
    assert.deepEqual([viaAdmin.calls, viaAdmin.tokens], [rows.length, tokens]);
    assert.deepEqual(viaAdmin.projects['p-a'].members['alice@d1'], { username: 'alice', tokens, calls: rows.length });
    assert.deepEqual(Object.keys(viaAdmin.projects['p-a'].models), ['mock/mock-1']);
    const text = [];
    runAdmin(['usage'], { env: { PROMPTCUT_AGENT_DATA: kit.dataDir }, stdout: { write: (s) => text.push(s) } });
    assert.match(text.join(''), new RegExp(`项目 p-a:${rows.length} 次,${tokens} token`));
    assert.equal(svc.usage(A1, Date.now() + 60_000).project.calls, 0, 'since 之后没有');
  });

  await t.test('CA-CRASH-01 一轮进行中进程没了再起:标中断,不续跑,接着说能续上', async () => {
    await svc.send(A1, 'c-crash', { prompt: script([{ tool: 'update_clip', input: { clipId: 'c1', label: '崩之前落地的' } }, { tool: 'get_project', input: {} }, { sleepMs: 60_000 }, { tool: 'update_clip', input: { clipId: 'c1', label: '崩之后不该有' } }]) });
    await waitFor(() => fs.existsSync(path.join(dirOf(kit, A1, 'c-crash'), 'history.json')) && JSON.parse(fs.readFileSync(path.join(dirOf(kit, A1, 'c-crash'), 'history.json'), 'utf8')).length >= 3, 20_000, '历史在进行中就落过盘');
    assert.equal(metaOf(kit, A1, 'c-crash').state, 'running');
    const midHistory = JSON.parse(fs.readFileSync(path.join(dirOf(kit, A1, 'c-crash'), 'history.json'), 'utf8'));
    // 「进程被杀」:前一份服务不收尾,在同一个数据目录上另起一份(探针里是真的结束进程)
    const next = kit.another();
    const m = metaOf(kit, A1, 'c-crash');
    assert.deepEqual([m.state, m.reason], ['interrupted', 'interrupted']);
    const ev = collect();
    next.subscribe(A2, 'c-crash', 0, ev.cb)();
    assert.deepEqual(ev.seen.slice(-2).map((e) => [e.type, e.code ?? e.state]), [['error', 'interrupted'], ['end', 'interrupted']]);
    assert.equal(ev.seen.at(-2).message, '云端 Agent 服务中断,这一轮没有做完。已经落地的改动保留在项目里。');
    assert.deepEqual(ev.seen.map((e) => e.seq), ev.seen.map((_, i) => i + 1));
    assert.deepEqual((await next.info(A1)).running, [], '不自动续跑');
    assert.equal(next.describe().instances.length, 0);
    assert.equal((await kit.doc.stateOf('p-a')).project.tracks[0].clips[0].label, '崩之前落地的');
    // 接着说:新的一轮,历史接着上一次落盘处,没有悬空的工具调用
    await next.send(A2, 'c-crash', { prompt: script([{ say: '接着做完了' }]) });
    await waitFor(() => next.conversation(A2, 'c-crash').state === 'idle', 30_000, '接着说的那一轮结束');
    const after = await kit.finished(A2, 'c-crash', 30_000, next);
    assert.equal(after.at(-1).state, 'idle');
    assert.equal(after.at(-1).seq, after.length, 'seq 接着中断那两条往后');
    const history = JSON.parse(fs.readFileSync(path.join(dirOf(kit, A1, 'c-crash'), 'history.json'), 'utf8'));
    assert.ok(history.length > midHistory.length);
    const uses = new Set(); const results = new Set();
    for (const msg of history) for (const b of Array.isArray(msg.content) ? msg.content : []) { if (b.type === 'tool_use') uses.add(b.id); if (b.type === 'tool_result') results.add(b.tool_use_id); }
    assert.deepEqual([...uses].filter((id) => !results.has(id)), [], '历史里没有悬空的工具调用');
    svc.abort(A1, 'c-crash'); // 收拾前一份里还睡着的那一轮
  });
});

test('CA-PAGE-01 / CA-TOOL-03 页面状态按对话找、发起方在线才用;开放的工具不发 HTTP、不碰作业表', { timeout: 240_000 }, async (t) => {
  const kit = await startKit(t);
  await kit.doc.seed(project('p-a', '甲'));
  await kit.doc.seed(project('p-b', '乙'));
  const T3 = { ...A1, projectId: 'p-b' };
  const svc = kit.service;

  await t.test('CA-PAGE-01 两个对话各用各的播放头;发起方不在线时照常执行、播放头按 0 记并注明', async () => {
    // 同一位成员同时开两个对话,带不同的播放头;都连着看
    await svc.send(A1, 'c-p1', { pageState: { t: 2.5, selection: ['c1'] }, prompt: script([{ sleepMs: 400 }, { tool: 'add_cut', input: { name: '甲剪辑' } }, { sleepMs: 20_000 }]) });
    await svc.send(A1, 'c-p2', { pageState: { t: 7.25, selection: [] }, prompt: script([{ sleepMs: 20_000 }]) });
    const s1 = collect();
    svc.subscribe(A1, 'c-p1', 0, s1.cb);
    const off2 = svc.subscribe(A1, 'c-p2', 0, () => {});
    await waitFor(() => s1.seen.some((e) => e.type === 'tool_result'), 20_000, 'c-p1 切完剪辑');
    const r1 = s1.seen.find((e) => e.type === 'tool_result');
    assert.equal(r1.ok, true, r1.summary);
    assert.equal(/发起方不在线/.test(r1.summary), false);
    const after1 = JSON.stringify((await kit.doc.stateOf('p-a')).project);
    assert.ok(after1.includes(':2.5'), `c-p1 的写入用的是它自己的播放头 2.5(不是后发的那条消息带来的 7.25):${after1.slice(0, 400)}`);
    assert.equal(after1.includes(':7.25'), false);
    // c-p2 在线:用 7.25
    const inst = svc._instance(A1);
    await inst.callTool('get_project', {}, 'c-p2');
    const r2 = await inst.callTool('add_cut', { name: '乙剪辑' }, 'c-p2');
    assert.equal(r2.initiatorOffline, undefined);
    assert.ok(JSON.stringify((await kit.doc.stateOf('p-a')).project).includes(':7.25'));
    // c-p2 的发起方走了:照常执行,播放头按 0 记,结果里注明;立刻回,不等
    off2();
    const t0 = Date.now();
    const r3 = await inst.callTool('add_cut', { name: '丙剪辑' }, 'c-p2');
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(r3.ok !== false, true, JSON.stringify(r3).slice(0, 300));
    assert.equal(r3.initiatorOffline, true);
    assert.equal(r3.note, '发起方不在线,播放头按 0 记。');
    assert.equal((await inst.callTool('get_selection', {}, 'c-p2')).initiatorOffline, true);
    assert.deepEqual((await inst.callTool('get_selection', {}, 'c-p1')).ids, ['c1'], 'c-p1 的发起方还连着');
    svc.abort(A1, 'c-p1');
    svc.abort(A1, 'c-p2');
  });

  await t.test('CA-TOOL-03 开放清单里的工具逐个跑一遍:没有任何 HTTP 请求,没有碰作业表', async () => {
    await svc.send(T3, 'c-tools3', { prompt: script([{ sleepMs: 60_000 }]) });
    const inst = svc._instance(T3);
    const common = await kit.vite.ssrLoadModule('/src/mcp/common.ts');
    const tables = Object.entries(common).filter(([, v]) => v instanceof Map || v instanceof Set);
    assert.ok(tables.some(([k]) => /Jobs?$/.test(k)) && tables.some(([k]) => /Results?$/.test(k)), `找得到作业表与结果表:${tables.map(([k]) => k).join(',')}`);
    const sizes = () => Object.fromEntries(tables.map(([k, v]) => [k, v.size]));
    const before = sizes();
    const fetched = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input) => { fetched.push(String(input?.url ?? input)); throw new Error('这条用例里不该有任何 HTTP 请求'); };
    const valueFor = (key, schema) => {
      if (key === 'clipId') return 'c1';
      if (key === 'trackId') return 't1';
      if (Array.isArray(schema?.enum) && schema.enum.length) return schema.enum[0];
      const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
      if (type === 'number' || type === 'integer') return 1;
      if (type === 'boolean') return false;
      if (type === 'array') return [];
      if (type === 'object') return {};
      return 'x';
    };
    const ran = [];
    try {
      for (const name of [...CLOUD_OPEN_TOOLS].sort()) {
        const def = tools.find((x) => x.name === name);
        const args = {};
        for (const key of def.inputSchema?.required ?? []) args[key] = valueFor(key, def.inputSchema?.properties?.[key]);
        if (name === 'wait') args.seconds = 1;
        let outcome;
        try { const r = await inst.callTool(name, args, 'c-tools3'); outcome = r?.ok === false ? 'refused' : 'ok'; } catch (err) { outcome = 'threw'; if (process.env.CA_DEBUG) console.log(name, String(err?.message).slice(0, 120)); }
        ran.push([name, outcome]);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(ran.length, 66);
    assert.deepEqual(fetched, [], '没有一次请求发出去(更不会打到 agent-service.invalid)');
    assert.deepEqual(sizes(), before, '作业表与结果表没有被碰');
    const okCount = ran.filter(([, o]) => o === 'ok').length;
    console.log('CA-TOOL-03', JSON.stringify({ 跑了: ran.length, 成功: okCount, 被拒或报错: ran.length - okCount, 报错的: ran.filter(([, o]) => o === 'threw').map(([n]) => n) }));
    // 按名字顺序跑,add_cut 之后当前剪辑是空的,后面点名 c1 / t1 的会各自报「找不到」——那也是在服务端副本上跑出来的结论
    assert.ok(okCount >= 15, `最小参数能跑通的(${okCount})`);
    svc.abort(T3, 'c-tools3');
  });
});

/** 补渲发布通道的测试替身(真的要第三段的队列与乙块的服务身份) */
function fakePublisher(state = { available: true, enabled: true }) {
  const pub = {
    state, log: [], handlers: new Map(), opens: 0,
    availability: async () => ({ ...pub.state }),
    codeVersion: () => 'code-v1',
    open: async (projectId, h) => {
      pub.opens += 1;
      pub.handlers.set(projectId, h);
      return {
        publish: async (task) => { pub.log.push(['publish', projectId, task]); },
        withdraw: async (id) => { pub.log.push(['withdraw', projectId, id]); },
        close: () => { pub.log.push(['close', projectId]); },
      };
    },
    published: () => pub.log.filter((x) => x[0] === 'publish').map((x) => x[2]),
    withdrawn: () => pub.log.filter((x) => x[0] === 'withdraw').map((x) => x[2]),
  };
  return pub;
}

test('CA-RENDER-01 / 02 / 03 没人在线时的补渲:攒批发布、撤回旧计划、完成与失败记进对话、重启后重发', { timeout: 240_000 }, async (t) => {
  const pub = fakePublisher();
  const kit = await startKit(t, { extra: { publisher: pub, renderLimits: { debounceMs: 200, stallMs: 600, progressEveryMs: 0 } } });
  const p = project('p-a', '甲');
  p.tracks[0].clips.push({ id: 'c2', cardId: 'title', start: 4, end: 8, params: {}, label: '第二张卡' }, { id: 'v1', cardId: 'video', start: 8, end: 12, params: {}, label: '素材片段' });
  await kit.doc.seed(p);
  const svc = kit.service;
  const pendingFile = (id) => path.join(dirOf(kit, A1, id), 'pending-render.json');
  const renders = async (id, service = svc) => { const c = collect(); service.subscribe(A2, id, 0, c.cb)(); return c.seen.filter((e) => e.type === 'render'); };

  await t.test('CA-RENDER-01 攒 3 秒(这里缩成 200 毫秒)发一个清单计划;新计划发出后旧的撤回;一轮结束时补发', async () => {
    const run = await svc.send(A1, 'c-r1', { prompt: script([
      { tool: 'update_clip', input: { clipId: 'c1', label: '一' } },
      { tool: 'update_clip', input: { clipId: 'c1', label: '二' } },
      { tool: 'update_clip', input: { clipId: 'v1', label: '素材不进清单' } },
      { sleepMs: 700 },
      { tool: 'update_clip', input: { clipId: 'c2', label: '三' } },
      { say: '完' },
    ]) });
    await waitFor(() => pub.published().length >= 1, 20_000, '第一个计划发出');
    assert.equal(pub.published().length, 1, '连着的几次写入合成一个计划');
    const first = pub.published()[0];
    assert.deepEqual(first.input.clips, ['c1'], '只有被写到的、要预渲染的片段;素材片段不放');
    assert.equal(fs.existsSync(pendingFile('c-r1')), true);
    await kit.finished(A1, 'c-r1');
    await waitFor(() => pub.published().length >= 2, 5000, '一轮结束时补发');
    await svc._render._settled({ projectId: 'p-a', ownerKey: ownerKeyOf(A1), id: 'c-r1' });
    const second = pub.published()[1];
    assert.deepEqual(second.input.clips, ['c1', 'c2'], '旧计划里还没渲完的并进新计划');
    assert.deepEqual(pub.withdrawn(), [first.id], '新的发出后旧的被撤回');
    assert.ok(pub.log.findIndex((x) => x[0] === 'withdraw') > pub.log.findIndex((x) => x[2] === second), '先发新的再撤旧的');
    const rev = (await kit.doc.stateOf('p-a')).rev;
    assert.deepEqual(second, clipsPlanTaskOf({ projectId: 'p-a', projectRev: rev, clips: ['c1', 'c2'], codeVersion: 'code-v1' }), '按最后的项目版本发');
    const page = await kit.vite.ssrLoadModule('/src/online/planPublisher.ts');
    assert.deepEqual(second, page.clipsPlanTask({ projectId: 'p-a', projectRev: rev, clips: ['c2', 'c1'], codeVersion: 'code-v1' }), '形状与在线页面发的逐字段相同');
    assert.equal(second.id, `plan:p-a@${rev}#clips:${page.clipsSig(['c1', 'c2'])}`);
    const rs = await renders('c-r1');
    assert.deepEqual(rs.map((e) => [e.state, e.clips]), [['published', ['c1']], ['published', ['c1', 'c2']]]);
    assert.ok(rs.every((e) => e.runId === run.runId));
    assert.equal(pub.opens, 1, '每个项目一条发布通道');
  });

  await t.test('CA-RENDER-02 进度与完成 → 事件、清单清空、通道关闭', async () => {
    const plan = pub.published().at(-1);
    pub.handlers.get('p-a').onProgress({ id: plan.id, done: 1, total: 2 });
    pub.handlers.get('p-a').onDone({ id: plan.id });
    const rs = await renders('c-r1');
    assert.deepEqual(rs.slice(-2).map((e) => [e.state, e.done ?? null, e.total ?? null]), [['progress', 1, 2], ['done', null, null]]);
    assert.deepEqual(rs.at(-1).clips, ['c1', 'c2']);
    assert.equal(fs.existsSync(pendingFile('c-r1')), false, '清单清空');
    assert.deepEqual(pub.log.at(-1), ['close', 'p-a'], '全部清单清空后关发布通道');
  });

  await t.test('CA-RENDER-02 失败 → render failed 带片段与原因;连续没有进度 → 放弃并撤回', async () => {
    await svc.send(A1, 'c-r2', { prompt: script([{ tool: 'update_clip', input: { clipId: 'c1', label: '四' } }, { say: '完' }]) });
    await kit.finished(A1, 'c-r2');
    const n = pub.published().length;
    await waitFor(() => pub.published().length > 0 && pub.published().at(-1).input.clips.length === 1 && pub.published().length >= n, 5000, '发出');
    await svc._render._settled({ projectId: 'p-a', ownerKey: ownerKeyOf(A1), id: 'c-r2' });
    const plan = pub.published().at(-1);
    pub.handlers.get('p-a').onFail({ id: plan.id, reason: '节点渲染出错:着色器编译失败', clips: ['c1'] });
    const rs = await renders('c-r2');
    assert.deepEqual([rs.at(-1).state, rs.at(-1).clips, rs.at(-1).reason], ['failed', ['c1'], '节点渲染出错:着色器编译失败']);
    assert.equal(fs.existsSync(pendingFile('c-r2')), false);

    await svc.send(A1, 'c-r3', { prompt: script([{ tool: 'update_clip', input: { clipId: 'c2', label: '五' } }, { say: '完' }]) });
    await kit.finished(A1, 'c-r3');
    await waitFor(async () => (await renders('c-r3')).some((e) => e.state === 'published'), 5000, '发出');
    const stalled = pub.published().at(-1);
    await waitFor(async () => (await renders('c-r3')).some((e) => e.state === 'failed'), 5000, '连续没有进度后放弃');
    const rs3 = await renders('c-r3');
    assert.deepEqual([rs3.at(-1).state, rs3.at(-1).reason, rs3.at(-1).clips], ['failed', STALL_REASON, ['c2']]);
    assert.ok(pub.withdrawn().includes(stalled.id), '放弃时撤回');
  });

  await t.test('CA-RENDER-02 渲染节点没有为这个项目开:render unavailable,不发布', async () => {
    pub.state.enabled = false;
    const n = pub.published().length;
    await svc.send(A1, 'c-r4', { prompt: script([{ tool: 'update_clip', input: { clipId: 'c1', label: '六' } }, { say: '完' }]) });
    await kit.finished(A1, 'c-r4');
    await waitFor(async () => (await renders('c-r4')).length > 0, 5000, '记了一条');
    assert.deepEqual((await renders('c-r4')).map((e) => [e.state, e.clips]), [['unavailable', ['c1']]]);
    assert.equal(pub.published().length, n);
    assert.equal((await svc.info(A1)).render.enabled, true);
    pub.state.enabled = true;
  });

  await t.test('CA-RENDER-03 没渲完时进程没了再起:按 pending-render.json 重新发布,不需要任何成员连接', async () => {
    await svc.send(A1, 'c-r5', { prompt: script([{ tool: 'update_clip', input: { clipId: 'c1', label: '七' } }, { tool: 'update_clip', input: { clipId: 'c2', label: '八' } }, { say: '完' }]) });
    await kit.finished(A1, 'c-r5');
    await waitFor(async () => (await renders('c-r5')).some((e) => e.state === 'published'), 5000, '发出');
    const saved = JSON.parse(fs.readFileSync(pendingFile('c-r5'), 'utf8'));
    assert.deepEqual(saved.plans.map((x) => x.clips), [['c1', 'c2']]);
    const pub2 = fakePublisher();
    const next = kit.another({ publisher: pub2, renderLimits: { debounceMs: 200, stallMs: 60_000, progressEveryMs: 0 } });
    assert.equal(await next.restored, 1);
    assert.equal(next.describe().instances.length, 0, '没有任何成员的实例');
    assert.deepEqual(pub2.published().map((x) => [x.input.clips, x.source.projectRev]), [[['c1', 'c2'], saved.plans[0].projectRev]]);
    pub2.handlers.get('p-a').onDone({ id: pub2.published()[0].id });
    assert.equal((await renders('c-r5', next)).at(-1).state, 'done', '结果记进对话');
    assert.equal(fs.existsSync(pendingFile('c-r5')), false);
  });
});

test('HTTP:丙块追加的接口(对话的取、改标题、删;用量;info 的新字段;事件流上限)', { timeout: 120_000 }, async (t) => {
  const doc = await startDoc(t);
  await doc.seed(project('p-a', '甲'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-agent-http2-'));
  const authenticate = (req) => {
    const m = /^Bearer test:([^:]+):(.+)$/.exec(String(req.headers.authorization ?? ''));
    return m ? { projectId: m[1], userId: m[2], username: m[2].split('@')[0], mode: 'restricted' } : null;
  };
  // 没有模型配置:起得来,发消息回 no-model-key
  const bare = await startAgentService({ dataDir, docUrl: doc.url, port: 0, authenticate, credentials });
  const auth = { Authorization: 'Bearer test:p-a:alice@d1', 'Content-Type': 'application/json' };
  const none = await fetch(`${bare.url}/v1/conversations/c1/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ prompt: 'hi' }) });
  assert.equal(none.status, 503);
  assert.equal((await none.json()).code, 'no-model-key');
  assert.equal((await (await fetch(`${bare.url}/v1/info`, { headers: auth })).json()).configured, false);
  await bare.close();

  // --mock 之后不重启配置代码路径:同一个数据目录再起就读得到
  assert.equal(await runSetKey({ argv: ['--mock'], env: { PROMPTCUT_AGENT_DATA: dataDir }, stdin: new PassThrough(), stdout: { write: () => true } }), 0);
  const svc = await startAgentService({ dataDir, docUrl: doc.url, port: 0, authenticate, credentials });
  t.after(async () => { await svc.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const info = await (await fetch(`${svc.url}/v1/info`, { headers: auth })).json();
  assert.deepEqual({ ok: info.ok, enabled: info.enabled, mock: info.mock, models: info.models, defaultModel: info.defaultModel, limits: info.limits, usage: info.usage, running: info.running, render: info.render },
    { ok: true, enabled: true, mock: true, models: ['mock-1'], defaultModel: 'mock-1', limits: { rounds: 24, runMs: 30 * 60_000 }, usage: { tokens: 0, limitTokens: null, window: 'total' }, running: [], render: { enabled: false } });

  const sent = await fetch(`${svc.url}/v1/conversations/c1/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ prompt: script([{ tool: 'update_clip', input: { clipId: 'c1', end: 6 } }, { say: '好' }]), grant: 'v1.x.y' }) });
  assert.equal(sent.status, 202);
  const stream = await readSse(`${svc.url}/v1/conversations/c1/events?after=0`, auth);
  assert.equal(stream.events.at(-1).type, 'end');
  const meta = await (await fetch(`${svc.url}/v1/conversations/c1`, { headers: auth })).json();
  assert.deepEqual([meta.ok, meta.meta.id, meta.meta.state, meta.meta.lastSeq], [true, 'c1', 'idle', stream.events.length]);
  // 换设备(同用户名)改标题、看列表
  const auth2 = { Authorization: 'Bearer test:p-a:alice@d2', 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${svc.url}/v1/conversations/c1`, { method: 'PATCH', headers: auth2, body: JSON.stringify({ title: '我的对话' }) })).status, 200);
  const list = await (await fetch(`${svc.url}/v1/conversations`, { headers: auth2 })).json();
  assert.deepEqual(list.items.map((c) => [c.id, c.title, c.state, c.lastSeq]), [['c1', '我的对话', 'idle', stream.events.length]]);
  assert.deepEqual(Object.keys(list.items[0]).sort(), ['id', 'lastSeq', 'reason', 'startedOn', 'state', 'title', 'updatedAt']);
  const usage = await (await fetch(`${svc.url}/v1/usage`, { headers: auth2 })).json();
  assert.equal(usage.ok, true);
  assert.equal(usage.project.calls, 2);
  assert.deepEqual(usage.members.map((m) => [m.username, m.calls]), [['alice', 2]]);
  assert.deepEqual(Object.keys(usage.members[0]).sort(), ['calls', 'tokens', 'username'], '不给别的成员看设备号');
  // 别人:取、改、删都是 404
  const mallory = { Authorization: 'Bearer test:p-a:mallory@d9', 'Content-Type': 'application/json' };
  for (const [method, body] of [['GET'], ['PATCH', JSON.stringify({ title: 'x' })], ['DELETE']]) {
    const r = await fetch(`${svc.url}/v1/conversations/c1`, { method, headers: mallory, ...(body ? { body } : {}) });
    assert.equal(r.status, 404, `${method} 别人的对话`);
    await r.arrayBuffer();
  }
  // 事件流上限:同一个主人 8 条,第 9 条 busy;断开后名额回来
  const ctrls = [];
  for (let i = 0; i < 8; i += 1) {
    const c = new AbortController();
    ctrls.push(c);
    const r = await fetch(`${svc.url}/v1/conversations/c1/events?after=${stream.events.length}`, { headers: auth, signal: c.signal });
    assert.equal(r.status, 200);
  }
  const ninth = await fetch(`${svc.url}/v1/conversations/c1/events`, { headers: auth2 });
  assert.equal(ninth.status, 429);
  assert.equal((await ninth.json()).code, 'busy');
  for (const c of ctrls) c.abort();
  await waitFor(async () => { const c = new AbortController(); const r = await fetch(`${svc.url}/v1/conversations/c1/events`, { headers: auth, signal: c.signal }); c.abort(); return r.status === 200; }, 5000, '断开后名额回来');
  assert.equal((await fetch(`${svc.url}/v1/conversations/c1`, { method: 'DELETE', headers: auth2 })).status, 200);
  assert.deepEqual((await (await fetch(`${svc.url}/v1/conversations`, { headers: auth })).json()).items, []);
  assert.equal(fs.readdirSync(dataDir).includes('tenants'), true);
  assert.equal(JSON.stringify(fs.readdirSync(path.join(dataDir, 'config')).sort()), JSON.stringify(['ai.json']), '模拟提供方不写 Key 文件');
  assert.equal(modelConfig().vendor, 'mock');
});
