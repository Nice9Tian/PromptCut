/**
 * 云端 Agent 服务:一轮的生命周期探针(契约 `docs/plan/cloud-agent-contract.md` 第 2.4、6、7、9.4 节;任务书
 * `docs/plan/cloud-agent-task.md`「用户体验验收」里不依赖页面与渲染服务的那一部分,加完成条件第 7 条的本机版)。
 *
 * 跑:node scripts/probes/cloud-agent-run-probe.mjs
 *
 * 搭法:本进程起一个内存里的文档服务(127.0.0.1:8798);Agent 服务是**另一个真实进程**(本文件带 `--child` 再起一遍,
 * 127.0.0.1:5741),数据目录是系统临时目录下新建的一个;模型用仓库里的模拟提供方(经 `set-key.mjs --mock` 切过去)。
 * 鉴权与连文档服务的凭证是测试替身(乙块的真身份合流后换成真的):`Authorization: Bearer test:<项目>:<成员>`。
 * 全部静默运行、不弹窗口,结束时只结束自己起的那个子进程,删掉临时目录。不连任何远端。
 *
 * 验收标准(每条打一行 PASS / FAIL,有一条 FAIL 退出码为 1):
 *
 *   A 断流不停
 *     A1 发消息回 202,带 runId 与 seq
 *     A2 事件流看到第 2 个工具结果后断开;之后没有任何流连着,这一轮照跑到结束(状态 idle)
 *     A3 脚本里的 6 次写入全部落进文档服务,项目版本连续加 6
 *   B 按 seq 补发再接实时流
 *     B1 断开后按 after=<最后看到的 seq> 重连(这一轮已结束):补到 end
 *     B2 断开前看到的加补发的,与 after=0 一口气看完的逐事件相同;seq 从 1 起连续,无缺无重
 *     B3 一轮还在跑时重连:先补发、再接实时,直到 end;与事后 after=0 看到的逐事件相同
 *   C 进程被杀
 *     C1 一轮进行中结束 Agent 服务进程(真的结束进程,不是关流);进程确实没了
 *     C2 重新起来后:这个对话的状态是 interrupted,原因可读;事件记录末尾是中断说明与 end
 *     C3 不自动续跑:info.running 为空;项目停在被杀前最后一次成功写入的版本上
 *     C4 可以重开:接着发一条消息,新的一轮正常跑完,seq 接着往后
 *   D 额度(完成条件第 7 条的本机版)
 *     D1 用管理命令把测试项目的额度设成很小的数:发消息被明确拒绝(429 quota-exceeded),话里带已用与上限
 *     D2 一轮中途超额:当前这次模型请求不发,事件里有 quota-exceeded 与原因,已落地的改动保留
 *     D3 用管理命令设回不限:不重启服务,再发消息恢复正常
 *     D4 用量记录里查得到这几次调用的项目、成员、模型与用量(管理命令与 /v1/usage 两处一致)
 *   E 发起方不在线
 *     E1 发起方没有连着看时,读选区的工具立刻回「发起方不在线」
 *     E2 这一轮不卡住,继续跑完(后面的写入落地,状态 idle)
 *     E3 发起方连着看时,同一个工具回发消息时的选区
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const DOC_PORT = 8798;
const AGENT_PORT = 5741;
const DOC_URL = `ws://127.0.0.1:${DOC_PORT}/docservice`;
const AGENT = `http://127.0.0.1:${AGENT_PORT}`;
const PROJECT = 'p-probe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 子进程:Agent 服务(鉴权与凭证是测试替身) ---------------- */

if (process.argv.includes('--child')) {
  const { startAgentService } = await import(new URL('../../server/agent-service/main.mjs', import.meta.url).href);
  const started = await startAgentService({
    dataDir: process.env.PROMPTCUT_AGENT_DATA,
    docUrl: DOC_URL,
    port: AGENT_PORT,
    authenticate: (req) => {
      const m = /^Bearer test:([^:]+):(.+)$/.exec(String(req.headers.authorization ?? ''));
      return m ? { projectId: m[1], userId: m[2], username: m[2].split('@')[0], deviceName: m[2].split('@')[1], mode: 'restricted' } : null;
    },
    credentials: { protocolsFor: (_identity, n) => ['promptcut.v1', `promptcut.role.agent.${n}`] },
    log: (event, fields) => process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`),
  });
  process.stdout.write(`${JSON.stringify({ event: 'probe.child.ready', url: started.url })}\n`);
  const stop = () => { void started.close().then(() => process.exit(0)); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await new Promise(() => {});
}

/* ---------------- 探针本体 ---------------- */

const results = [];
function check(id, what, fn) {
  return Promise.resolve().then(fn).then(
    (detail) => { results.push({ id, ok: true }); console.log(`PASS ${id} ${what}${detail ? ` —— ${detail}` : ''}`); },
    (err) => { results.push({ id, ok: false }); console.log(`FAIL ${id} ${what} —— ${String(err?.message ?? err).split('\n')[0].slice(0, 300)}`); },
  );
}

async function waitFor(pred, ms, what) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > until) throw new Error(`等「${what}」超时(${ms} ms)`);
    await sleep(40);
  }
}

const script = (steps) => `按脚本做。\n\`\`\`mock-script\n${JSON.stringify(steps)}\n\`\`\``;
const authOf = (user) => ({ Authorization: `Bearer test:${PROJECT}:${user}`, 'Content-Type': 'application/json' });
const ALICE = authOf('alice@dev1');
const ALICE2 = authOf('alice@dev2');

async function post(pathname, body, headers = ALICE) {
  const res = await fetch(`${AGENT}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json() };
}
async function get(pathname, headers = ALICE) {
  const res = await fetch(`${AGENT}${pathname}`, { headers });
  return { status: res.status, body: await res.json() };
}

/** 读事件流到 `until` 为真(然后断开);回收到的事件 */
async function readEvents(conversationId, after, until, headers = ALICE) {
  const ctrl = new AbortController();
  const res = await fetch(`${AGENT}/v1/conversations/${conversationId}/events?after=${after}`, { headers, signal: ctrl.signal });
  assert.equal(res.status, 200, '事件流 200');
  const out = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      let stop = false;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!chunk.startsWith('data: ')) continue;
        const ev = JSON.parse(chunk.slice(6));
        out.push(ev);
        if (until(ev, out)) { stop = true; break; }
      }
      if (stop) break;
    }
  } finally {
    ctrl.abort(); // 真的断开这条连接
  }
  return out;
}
const untilEnd = (ev) => ev.type === 'end';
const metaOf = async (id, headers = ALICE) => (await get(`/v1/conversations/${id}`, headers)).body.meta;
const idle = (id) => waitFor(async () => (await metaOf(id))?.state !== 'running' && (await metaOf(id)), 60_000, `对话 ${id} 结束`);

/* 文档服务(本进程,内存) */
async function startDoc() {
  const { createSharedDocService } = await import(new URL('../../server/docservice/shared-service.mjs', import.meta.url).href);
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const built = createSharedDocService({ mode: 'lan', dataDir: null, store: null, server, path: '/docservice', isLoopback: () => true, localDevice: { deviceId: 'pc-probe-device-0001', deviceName: 'probe' }, log: () => {} });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(DOC_PORT, '127.0.0.1', resolve); });
  let seq = 0;
  const call = (message, accept) => new Promise((resolve, reject) => {
    const ws = new WebSocket(DOC_URL);
    const timer = setTimeout(() => { ws.close(); reject(new Error('文档服务没有回应')); }, 8000);
    const parts = [];
    let state = null;
    ws.onopen = () => ws.send(JSON.stringify(message));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'project.state.part') parts.push(m);
      if (m.type === 'project.state' && m.project === undefined && Number.isSafeInteger(m.parts)) { state = m; return; }
      if (state && m.type === 'project.state.end') {
        state.project = JSON.parse(parts.sort((a, b) => a.index - b.index).map((x) => x.data).join(''));
        clearTimeout(timer); ws.close(); resolve(state); return;
      }
      if (accept(m)) { clearTimeout(timer); ws.close(); resolve(m); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('连不上文档服务')); };
  });
  return {
    stateOf: () => call({ type: 'project.open', projectId: PROJECT, reqId: `o${++seq}` }, (m) => m.type === 'project.state' && m.project !== undefined),
    async seed(project) {
      const opId = `seed-${++seq}`;
      const r = await call({ type: 'project.op', projectId: PROJECT, opId, session: 'seed', ops: [{ op: 'set', path: '', value: project }], reqId: opId }, (m) => m.reqId === opId);
      assert.equal(r.type, 'project.op.ok', '项目写进文档服务');
    },
    async close() {
      await built.service.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/* Agent 服务子进程 */
let child = null;
const childLogs = [];
function startAgent(dataDir) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child'], {
      cwd: ROOT, env: { ...process.env, PROMPTCUT_AGENT_DATA: dataDir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    child = c;
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Agent 服务 60 秒内没有就绪')), 60_000);
    c.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        childLogs.push(line);
        if (line.includes('probe.child.ready')) { clearTimeout(timer); resolve(c); }
      }
    });
    c.stderr.on('data', (d) => childLogs.push(`stderr: ${d.toString('utf8').trim()}`));
    c.once('exit', (code) => { if (child === c) child = null; clearTimeout(timer); reject(new Error(`Agent 服务退出了(${code})`)); });
  });
}
function killAgent() {
  const c = child;
  if (!c) return Promise.resolve();
  return new Promise((resolve) => { c.once('exit', () => resolve()); c.kill('SIGKILL'); });
}
const cli = (file, args, dataDir) => spawnSync(process.execPath, [path.join(ROOT, 'server', 'agent-service', file), ...args], {
  cwd: ROOT, env: { ...process.env, PROMPTCUT_AGENT_DATA: dataDir }, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-agent-probe-'));
let doc = null;
try {
  doc = await startDoc();
  await doc.seed({
    version: 1, id: PROJECT, name: '探针项目', width: 1920, height: 1080, fps: 30, duration: 12, themeId: 'midnight', media: [],
    tracks: [{ id: 't1', name: '序列 1', clips: [{ id: 'c1', cardId: 'title', start: 0, end: 4, params: {}, label: '起始' }, { id: 'c2', cardId: 'title', start: 4, end: 8, params: {}, label: '第二张' }] }],
    transitions: [],
  });
  const mock = cli('set-key.mjs', ['--mock'], dataDir);
  assert.equal(mock.status, 0, `set-key --mock:${mock.stdout}${mock.stderr}`);
  await startAgent(dataDir);
  const info0 = (await get('/v1/info')).body;
  console.log(`环境:Agent 服务 ${AGENT}(子进程 ${child.pid}),文档服务 ${DOC_URL},模型 ${info0.mock ? '模拟提供方' : '?'} ${info0.defaultModel},数据目录在系统临时目录下`);

  /* ---------- A、B:断流不停,按 seq 补发 ---------- */
  const rev0 = (await doc.stateOf()).rev;
  const writes = [1, 2, 3, 4, 5, 6].map((i) => [{ sleepMs: 250 }, { tool: 'update_clip', input: { clipId: 'c1', label: `第 ${i} 次改` } }]).flat();
  let sentA = null;
  let seenA = [];
  await check('A1', '发消息回 202,带 runId 与 seq', async () => {
    sentA = await post('/v1/conversations/c-a/messages', { prompt: script([...writes, { say: '六次都改完了' }]) });
    assert.equal(sentA.status, 202);
    assert.equal(sentA.body.ok, true);
    assert.equal(typeof sentA.body.runId, 'string');
    assert.equal(sentA.body.seq, 1);
    return `runId ${sentA.body.runId.slice(0, 8)}…,seq ${sentA.body.seq}`;
  });
  await check('A2', '看到第 2 个工具结果后断开事件流;没有任何流连着,这一轮照跑到结束', async () => {
    seenA = await readEvents('c-a', 0, (_ev, all) => all.filter((e) => e.type === 'tool_result').length >= 2);
    const at = (await metaOf('c-a')).state;
    assert.equal(at, 'running', '断开时这一轮还在跑');
    const m = await idle('c-a');
    assert.equal(m.state, 'idle');
    return `断开时看到 seq ${seenA.at(-1).seq}、状态 running;之后无人连接,结束时 lastSeq ${m.lastSeq}、状态 ${m.state}`;
  });
  await check('A3', '6 次写入全部落进文档服务,版本连续加 6', async () => {
    const st = await doc.stateOf();
    assert.equal(st.project.tracks[0].clips[0].label, '第 6 次改');
    assert.equal(st.rev, rev0 + 6);
    return `版本 ${rev0} → ${st.rev},片段文案「${st.project.tracks[0].clips[0].label}」`;
  });
  let fullA = [];
  await check('B1', '按 after=<最后看到的 seq> 重连:补到 end', async () => {
    const rest = await readEvents('c-a', seenA.at(-1).seq, untilEnd);
    assert.equal(rest[0].seq, seenA.at(-1).seq + 1);
    assert.equal(rest.at(-1).type, 'end');
    fullA = [...seenA, ...rest];
    return `补发 ${rest.length} 条(seq ${rest[0].seq}～${rest.at(-1).seq})`;
  });
  await check('B2', '断开前看到的加补发的,与 after=0 一口气看完的逐事件相同;seq 连续,无缺无重', async () => {
    const whole = await readEvents('c-a', 0, untilEnd);
    assert.deepEqual(fullA, whole);
    assert.deepEqual(whole.map((e) => e.seq), whole.map((_, i) => i + 1));
    return `共 ${whole.length} 条,seq 1～${whole.at(-1).seq}`;
  });
  await check('B3', '一轮还在跑时重连:先补发、再接实时直到 end;与事后 after=0 看到的逐事件相同', async () => {
    const steps = [1, 2, 3, 4, 5].map((i) => [{ sleepMs: 300 }, { tool: 'update_clip', input: { clipId: 'c2', label: `乙 ${i}` } }]).flat();
    const base = (await metaOf('c-a')).lastSeq;
    await post('/v1/conversations/c-a/messages', { prompt: script([...steps, { say: '乙做完了' }]) });
    const head = await readEvents('c-a', base, (_ev, all) => all.filter((e) => e.type === 'tool_result').length >= 1);
    await sleep(500); // 断开期间又发生了几件事
    assert.equal((await metaOf('c-a')).state, 'running', '重连时这一轮还在跑');
    const tail = await readEvents('c-a', head.at(-1).seq, untilEnd, ALICE2); // 换一台设备接着看
    const whole = await readEvents('c-a', base, untilEnd);
    assert.deepEqual([...head, ...tail], whole);
    assert.deepEqual(whole.map((e) => e.seq), whole.map((_, i) => base + 1 + i));
    assert.equal(tail.at(-1).state, 'idle');
    return `第一段看到 seq ${head.at(-1).seq} 断开,换设备从 ${head.at(-1).seq + 1} 接到 ${tail.at(-1).seq}(含实时部分),与整段 ${whole.length} 条相同`;
  });

  /* ---------- C:进程被杀 ---------- */
  let revBeforeKill = null;
  await check('C1', '一轮进行中结束 Agent 服务进程;进程确实没了', async () => {
    await post('/v1/conversations/c-kill/messages', { prompt: script([{ tool: 'update_clip', input: { clipId: 'c1', label: '被杀前落地的' } }, { tool: 'get_project', input: {} }, { sleepMs: 60_000 }, { tool: 'update_clip', input: { clipId: 'c1', label: '被杀后不该出现' } }]) });
    await readEvents('c-kill', 0, (_ev, all) => all.filter((e) => e.type === 'tool_result').length >= 2);
    revBeforeKill = (await doc.stateOf()).rev;
    const pid = child.pid;
    await killAgent();
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(alive, false, '进程还在');
    await assert.rejects(() => fetch(`${AGENT}/healthz`), '端口上已经没有服务');
    return `结束了进程 ${pid}(SIGKILL),端口 ${AGENT_PORT} 连不上`;
  });
  await check('C2', '重新起来后:状态 interrupted,原因可读;事件记录末尾是中断说明与 end', async () => {
    await startAgent(dataDir);
    const m = await metaOf('c-kill', ALICE2);
    assert.equal(m.state, 'interrupted');
    assert.equal(m.reason, 'interrupted');
    const ev = await readEvents('c-kill', 0, untilEnd, ALICE2);
    assert.deepEqual(ev.slice(-2).map((e) => [e.type, e.code ?? e.state]), [['error', 'interrupted'], ['end', 'interrupted']]);
    assert.deepEqual(ev.map((e) => e.seq), ev.map((_, i) => i + 1));
    return `新进程 ${child.pid};状态 ${m.state};原因原文「${ev.at(-2).message}」`;
  });
  await check('C3', '不自动续跑:info.running 为空;项目停在被杀前最后一次成功写入的版本上', async () => {
    await sleep(800);
    const info = (await get('/v1/info')).body;
    assert.deepEqual(info.running, []);
    const st = await doc.stateOf();
    assert.equal(st.rev, revBeforeKill);
    assert.equal(st.project.tracks[0].clips[0].label, '被杀前落地的');
    return `running=[];版本仍是 ${st.rev},文案「${st.project.tracks[0].clips[0].label}」`;
  });
  await check('C4', '可以重开:接着发一条消息,新的一轮正常跑完,seq 接着往后', async () => {
    const before = (await metaOf('c-kill')).lastSeq;
    const sent = await post('/v1/conversations/c-kill/messages', { prompt: script([{ tool: 'update_clip', input: { clipId: 'c1', label: '重开后接着改的' } }, { say: '接着做完了' }]) });
    assert.equal(sent.status, 202);
    assert.equal(sent.body.seq, before + 1);
    const m = await idle('c-kill');
    assert.equal(m.state, 'idle');
    assert.equal((await doc.stateOf()).project.tracks[0].clips[0].label, '重开后接着改的');
    return `新一轮从 seq ${sent.body.seq} 起,结束状态 ${m.state}`;
  });

  /* ---------- D:额度 ---------- */
  const usageNow = () => JSON.parse(cli('admin.mjs', ['usage', '--project', PROJECT, '--json'], dataDir).stdout);
  await check('D1', '额度设成很小的数:发消息被明确拒绝,话里带已用与上限', async () => {
    const set = cli('admin.mjs', ['quota', 'set', PROJECT, '--tokens', '10'], dataDir);
    assert.equal(set.status, 0, set.stdout + set.stderr);
    const r = await post('/v1/conversations/c-quota/messages', { prompt: script([{ say: '不该跑' }]) });
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'quota-exceeded');
    assert.match(r.body.message, /额度已用完\(已用 \d+ \/ 上限 10\)。请联系托管方。/);
    return `HTTP ${r.status} ${JSON.stringify(r.body)}`;
  });
  await check('D2', '一轮中途超额:当前这次模型请求不发,事件里有原因,已落地的改动保留', async () => {
    const used = usageNow().tokens;
    assert.equal(cli('admin.mjs', ['quota', 'set', PROJECT, '--tokens', String(used + 1)], dataDir).status, 0);
    const calls = usageNow().calls;
    const sent = await post('/v1/conversations/c-quota/messages', { prompt: script([{ tool: 'update_clip', input: { clipId: 'c2', label: '额度内的一步' } }, { tool: 'update_clip', input: { clipId: 'c2', label: '额度外不该有' } }, { say: '不会到' }]) });
    assert.equal(sent.status, 202);
    const ev = await readEvents('c-quota', 0, untilEnd);
    const err = ev.filter((e) => e.type === 'error').at(-1);
    assert.equal(err.code, 'quota-exceeded');
    assert.equal(ev.at(-1).state, 'failed');
    assert.equal(usageNow().calls, calls + 1, '超额之后那一次模型请求没有发');
    assert.equal((await doc.stateOf()).project.tracks[0].clips[1].label, '额度内的一步');
    const m = await metaOf('c-quota');
    assert.deepEqual([m.state, m.reason], ['failed', 'quota-exceeded']);
    return `事件原文 ${JSON.stringify({ code: err.code, message: err.message })};模型请求只多了 1 次;片段停在「额度内的一步」`;
  });
  await check('D3', '设回不限:不重启服务,再发消息恢复正常', async () => {
    const pid = child.pid;
    assert.equal(cli('admin.mjs', ['quota', 'clear', PROJECT], dataDir).status, 0);
    const sent = await post('/v1/conversations/c-quota/messages', { prompt: script([{ tool: 'update_clip', input: { clipId: 'c2', label: '恢复后改的' } }, { say: '恢复了' }]) });
    assert.equal(sent.status, 202);
    const m = await idle('c-quota');
    assert.equal(m.state, 'idle');
    assert.equal(child.pid, pid, '服务没有重启');
    assert.equal((await get('/v1/info')).body.usage.limitTokens, null);
    return `HTTP 202,结束状态 ${m.state},服务进程仍是 ${pid}`;
  });
  await check('D4', '用量记录里查得到项目、成员、模型与用量(管理命令与 /v1/usage 一致)', async () => {
    const u = usageNow();
    const p = u.projects[PROJECT];
    assert.ok(p.calls >= 10);
    assert.deepEqual(Object.keys(p.members), ['alice@dev1']);
    assert.equal(p.members['alice@dev1'].username, 'alice');
    assert.deepEqual(Object.keys(p.models), ['mock/mock-1']);
    const api = (await get('/v1/usage', ALICE2)).body;
    assert.deepEqual(api.project, { tokens: p.tokens, calls: p.calls });
    assert.deepEqual(api.members, [{ username: 'alice', tokens: p.tokens, calls: p.calls }]);
    const row = fs.readdirSync(path.join(dataDir, 'usage')).filter((n) => n.endsWith('.jsonl')).map((n) => fs.readFileSync(path.join(dataDir, 'usage', n), 'utf8').trim().split('\n').at(-1))[0];
    return `管理命令:项目 ${PROJECT} ${p.calls} 次 ${p.tokens} token,成员 ${JSON.stringify(p.members)},模型 ${JSON.stringify(p.models)};流水最后一行 ${row}`;
  });

  /* ---------- E:发起方不在线 ---------- */
  let offEvents = [];
  await check('E1', '发起方没有连着看时,读选区的工具立刻回「发起方不在线」', async () => {
    await post('/v1/conversations/c-off/messages', { pageState: { t: 3, selection: ['c1'] }, prompt: script([{ sleepMs: 300 }, { tool: 'get_selection', input: {} }, { tool: 'update_clip', input: { clipId: 'c2', label: '发起方不在也照做' } }, { say: '做完了,选区没用上' }]) });
    await idle('c-off');
    offEvents = await readEvents('c-off', 0, untilEnd);
    const call = offEvents.find((e) => e.type === 'tool_result' && e.name === 'get_selection');
    assert.equal(call.ok, false);
    assert.match(call.summary, /发起方不在线,读不到页面的选区。请按项目内容继续,不要等待。/);
    assert.ok(call.durationMs < 500, `不等待(${call.durationMs} ms)`);
    return `工具结果原文 ${call.summary}(耗时 ${call.durationMs} ms)`;
  });
  await check('E2', '这一轮不卡住,继续跑完', async () => {
    assert.equal(offEvents.at(-1).state, 'idle');
    assert.equal(offEvents.filter((e) => e.type === 'tool_result' && e.name === 'update_clip')[0].ok, true);
    assert.equal((await doc.stateOf()).project.tracks[0].clips[1].label, '发起方不在也照做');
    return `end 状态 ${offEvents.at(-1).state};之后的写入落地,文案「发起方不在也照做」`;
  });
  await check('E3', '发起方连着看时,同一个工具回发消息时的选区', async () => {
    await post('/v1/conversations/c-on/messages', { pageState: { t: 3, selection: ['c1'] }, prompt: script([{ sleepMs: 800 }, { tool: 'get_selection', input: {} }, { say: '看到了' }]) });
    const ev = await readEvents('c-on', 0, untilEnd);
    const call = ev.find((e) => e.type === 'tool_result' && e.name === 'get_selection');
    assert.equal(call.ok, true);
    assert.match(call.summary, /"ids":\["c1"\]/);
    return `工具结果开头 ${call.summary.slice(0, 60)}…`;
  });
} catch (err) {
  results.push({ id: 'setup', ok: false });
  console.log(`FAIL 探针没跑完 —— ${String(err?.stack ?? err).slice(0, 600)}`);
  if (childLogs.length) console.log(`Agent 服务最后的日志:\n${childLogs.slice(-12).join('\n')}`);
} finally {
  await killAgent().catch(() => {});
  await doc?.close().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n共 ${results.length} 条,通过 ${results.length - failed},失败 ${failed}`);
process.exit(failed ? 1 : 0);
