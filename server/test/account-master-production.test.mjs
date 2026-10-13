import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { startRunnerProcessFixture, until, toneWav } from './fixtures/account-runner-process.mjs';
import { MASTER_SCHEDULER_PENDING_PATH } from '../agent-service/account-master-scheduler-client.mjs';

// 账号模式「一条任务一个进程」的整套，主服务这一侧用的是生产的装配（`account-master-assembly.mjs`）：
// 这个进程只做控制、不跑任务；任务在真的子进程里跑（真实运行器，指令走本机 HTTPS）；槽调度经主服务的内部口、
// 用 root 那张证书去问文档服务排着什么、哪条要强制关。root 看操作系统的那一半仍是受控的（Windows 没有 systemd），
// 其余哪些是真的见夹具 fixtures/account-runner-process.mjs 的开头。
// 要设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT 与 PROMPTCUT_PASSWORD_ORDER_MODULE（用 npm test 跑）。
//
// 证明的两条行为（验收里原先不成立、标成 todo 的那两条，断言照抄）：
//   - 停止：这一轮真的停下，进程被关，结果是「被中断」，停之后才会说的话没有出现；
//   - 共有对话里一个成员的任务结束后，另一个成员后发的消息的任务按到达顺序开始。
const PORTS = Object.freeze({ combo: [28680, 28681, 28682, 28683, 28684, 28685, 28686], agent: 28687,
  masterEvents: 28688, look: 28689, renderWorker: 28690, identityBase: 28700, controlBase: 28720 });
const script = steps => `按脚本做。\n\`\`\`mock-script\n${JSON.stringify(steps)}\n\`\`\``;
const safeCode = body => (/^[a-z0-9-]{1,80}$/.test(body?.code ?? '') ? body.code : 'unclassified');
const kind = row => row.event?.type ?? row.type;

test('生产的主服务装配：任务在任务进程里跑；停止真的停下；共有对话里第二位发送者的任务按到达顺序开始；附件存进各代共用的目录',
  { timeout: 300_000 }, async t => {
    const f = await startRunnerProcessFixture({ ports: PORTS, productionMaster: true });
    const actors = [];
    t.after(async () => {
      for (const actor of actors) await actor.close().catch(() => {});
      const result = await f.close();
      assert.equal(result.alive, 0, '收尾后不该还有活着的任务子进程');
      if (result.errors.length) throw new AggregateError(result.errors, 'master fixture close');
    });
    const a = await f.connectActor(0); actors.push(a);
    const b = await f.connectActor(1); actors.push(b);
    const rowsOf = conversationId => f.events(conversationId);
    const diagnose = () => JSON.stringify({ scheduler: f.scheduler.describe(), head: f.headRecord()?.head ?? null, master: f.masterAssembly.describe(),
      log: f.log.filter(row => row.event !== 'slot.forced.pending').slice(-40).map(row => ({ ...row, at: undefined })) });
    const waitFor = async (check, what, timeoutMs = 90_000) => { try { return await until(check, { what, timeoutMs }); } catch (error) { error.message += ` :: ${diagnose()}`; throw error; } };
    const health = () => new Promise((resolve, reject) => { https.get(`${f.origin}/agent/healthz`, { ca: f.pki.ca }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks))); } catch (error) { reject(error); } }); }).on('error', reject); });

    // ---------- 调度还没起来：如实报「没有在执行」，消息只排队 ----------
    assert.equal(f.masterAssembly.describe().registered, true);
    assert.equal((await a.agent('/info')).body.executorMounted, false, '没有调度在问时不说自己在执行');
    assert.deepEqual((({ taskProcesses, scheduler }) => ({ taskProcesses, scheduler }))(await health()), { taskProcesses: true, scheduler: false });

    // ---------- 内部口的闸：调度要的那两条只认 root 那张证书 ----------
    const internal = (tls, route, body = {}) => new Promise((resolve, reject) => {
      const text = JSON.stringify(body);
      const req = https.request(`https://127.0.0.1:${PORTS.masterEvents}${route}`, { ...tls, method: 'POST', agent: false, rejectUnauthorized: true,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), connection: 'close' } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } }); });
      req.on('error', reject); req.end(text); });
    // 任务证书（pki.wrong）来问排队：拒。它只能往这个口交事件
    const forbidden = await internal(f.pki.wrong, MASTER_SCHEDULER_PENDING_PATH);
    assert.equal(forbidden.status, 403); assert.equal(forbidden.body.code, 'master-scheduler-forbidden');
    assert.equal((await internal(f.pki.rootctl, '/internal/v2/master/scheduler/assign')).status, 404);
    assert.equal(f.masterAssembly.schedulerAlive(), false, '被拒的请求不算调度来问过');

    // ---------- 附件：照页面的做法传给主服务，存进各代任务进程共用的数据目录 ----------
    const shared = 'shared_queue';
    const wav = toneWav(), wavHash = createHash('sha256').update(wav).digest('hex');
    const uploaded = await a.upload(shared, 'tone.wav', wav);
    assert.equal(uploaded.status, 200, safeCode(uploaded.body));
    assert.equal(uploaded.body.attachment.url, 'work:attachments/tone.wav'); assert.equal(uploaded.body.attachment.size, wav.length);
    assert.deepEqual(f.workspaceOf(shared).read('attachments/tone.wav'), wav, '落在共用数据目录里这个对话的工作目录（任务进程从这里读）');
    assert.equal((await a.upload(shared, 'empty.bin', Buffer.alloc(0))).status, 400, '空附件被拒');

    // ---------- 共有对话：A 先发，B 后发 ----------
    const sentA = await a.agent(`/conversations/${shared}/messages`, { requestId: 'q-a', selectionSnapshot: { pageId: a.pageId },
      attachments: [{ url: uploaded.body.attachment.url }],
      prompt: script([{ tool: 'get_project', input: {} }, { tool: 'import_media', input: { url: uploaded.body.attachment.url, name: 'tone.wav' } }, { say: 'FROM_A' }]) });
    assert.equal(sentA.status, 202, safeCode(sentA.body));
    // 消息带的附件只认这个对话工作目录里真有的文件：没传过的地址、工作目录外的地址一律拒，不悄悄丢掉
    for (const url of ['work:attachments/never-uploaded.bin', 'work:../secret', 'https://example.invalid/x.png']) {
      const refused = await a.agent(`/conversations/${shared}/messages`, { requestId: `q-bad-${url.length}`, selectionSnapshot: { pageId: a.pageId }, prompt: 'x', attachments: [{ url }] });
      assert.equal(refused.status, 400, url); assert.equal(refused.body.code, 'attachment-missing');
    }
    assert.deepEqual(f.messageOf(shared, 'q-a').attachments, [{ name: 'tone.wav', url: 'work:attachments/tone.wav', size: wav.length }], '文档服务记下的是主服务核过的引用');
    // 页面的事件流（对话有了第一条消息以后开）
    const seenA = []; const streamA = await a.stream(shared, seenA);
    await f.scheduler.start();
    await waitFor(() => f.masterAssembly.schedulerAlive(), '调度经内部口问到了主服务', 15_000);
    assert.equal((await a.agent('/info')).body.executorMounted, true);
    assert.equal((await health()).scheduler, true);
    const messageA = f.messageOf(shared, 'q-a').messageId;
    await waitFor(() => rowsOf(shared).some(row => kind(row) === 'runner_done'), 'A 的这一轮结束');
    await waitFor(() => f.grantOf(messageA)?.state === 'finished', 'A 的任务结清');
    const grantA = f.grantOf(messageA), stopA = f.stops.find(row => row.epoch === 1);
    assert.equal(grantA.terminalOutcome.status, 'done');
    assert.notEqual(f.generations.get(1).pid, process.pid, '任务不在主服务这个进程里跑');
    assert.equal(stopA.how, 'graceful');
    // 任务进程读到了主服务存的那个附件，并把它导入了项目素材库
    const results = rowsOf(shared).filter(row => kind(row) === 'tool_result').map(row => [row.event.name, row.event.ok !== false]);
    assert.deepEqual(results, [['get_project', true], ['import_media', true]]);
    // 用量:任务进程把这条任务的模型请求记在共用数据目录里;成员经主服务(生产的装配)查得到,是这条任务记的那几行
    const usageA = await a.agent('/usage');
    assert.equal(usageA.status, 200, safeCode(usageA.body));
    assert.ok(usageA.body.project.calls >= 3, `脚本三个回合各一次模型请求,实际 ${usageA.body.project.calls}`);
    assert.deepEqual(usageA.body.models.map(row => row.model), ['scripted-local-response']);
    assert.equal(usageA.body.models[0].calls, usageA.body.project.calls);
    assert.equal(usageA.body.members.length, 1, '这时只有甲发起过任务');
    assert.equal(usageA.body.members[0].calls, usageA.body.project.calls);
    assert.equal(JSON.stringify(usageA.body).includes(grantA.accountId), false, '成员只给显示名,不给账号编号');
    const media = (await a.project()).project.media ?? [];
    assert.ok(media.some(item => item.hash === wavHash || item.sha256 === wavHash || JSON.stringify(item).includes(wavHash)), '附件进了项目素材库');
    // 页面的事件流是从主服务的事件库读的：用户消息、工具过程、模型的话、结束都在流里
    await waitFor(() => seenA.some(e => e.type === 'runner_done'), 'A 页面的流里看到这一轮结束', 30_000);
    assert.equal(streamA.status(), 200);
    assert.ok(seenA.some(e => e.type === 'user' && String(e.prompt).includes('FROM_A') && e.attachments?.[0]?.name === 'tone.wav'), '流里有用户消息，带着附件的名字');
    assert.ok(seenA.some(e => e.type === 'tool_result' && e.name === 'get_project'), '流里有工具过程');
    assert.ok(seenA.some(e => e.type === 'text' && String(e.delta).includes('FROM_A')), '流里有模型的话');
    streamA.close();

    // 2.3-3：A 的任务结束后，B 在同一个共有对话里后发的消息的任务按到达顺序开始
    const sentB = await b.agent(`/conversations/${shared}/messages`, { requestId: 'q-b', selectionSnapshot: { pageId: b.pageId }, prompt: script([{ say: 'FROM_B' }]) });
    assert.equal(sentB.status, 202, safeCode(sentB.body));
    const textOf = conversationId => rowsOf(conversationId).filter(row => kind(row) === 'text').map(row => String(row.event.delta)).join('');
    await waitFor(() => textOf(shared).includes('FROM_B'), 'second sender run speaks', 60_000);
    const messageB = f.messageOf(shared, 'q-b').messageId;
    await waitFor(() => f.grantOf(messageB)?.state === 'finished', 'B 的任务结清');
    const grantB = f.grantOf(messageB);
    assert.notEqual(grantB.accountId, grantA.accountId, '第二条是另一位成员发起的，凭他自己的授权跑');
    // 乙的任务跑完以后,乙查用量:两位成员各有各的行,总量是两条任务的和
    const usageB = await b.agent('/usage');
    assert.equal(usageB.status, 200, safeCode(usageB.body));
    assert.equal(usageB.body.members.length, 2);
    assert.ok(usageB.body.project.calls > usageA.body.project.calls);
    assert.equal(usageB.body.members.reduce((sum, row) => sum + row.calls, 0), usageB.body.project.calls);
    assert.ok(grantB.admittedAt >= stopA.at, `B 的任务领取 ${grantB.admittedAt} 不早于 A 那一代被关掉 ${stopA.at}`);
    assert.notEqual(f.generations.get(2).pid, f.generations.get(1).pid, '另一个进程');
    const rows = rowsOf(shared), firstDone = rows.findIndex(row => kind(row) === 'runner_done');
    const spokeB = rows.findIndex(row => kind(row) === 'text' && String(row.event.delta).includes('FROM_B'));
    assert.ok(firstDone >= 0 && firstDone < spokeB, '事件按到达顺序：A 的结束在 B 的话之前');

    // ---------- 2.3-5：停止 ----------
    const stopId = 'panel_stop', stopSeen = [];
    const sent = await a.agent(`/conversations/${stopId}/messages`, { requestId: 'panel-2', selectionSnapshot: { pageId: a.pageId },
      prompt: script([{ tool: 'get_project', input: {} }, { sleepMs: 20_000 }, { say: '停之后才会说的话。' }]) });
    assert.equal(sent.status, 202);
    const stopStream = await a.stream(stopId, stopSeen);
    const run = await waitFor(() => rowsOf(stopId).find(row => kind(row) === 'run'), '拿到 runId', 60_000);
    await waitFor(() => rowsOf(stopId).some(row => kind(row) === 'tool_result'), '任务已经在做了', 30_000);
    const stopMessage = f.messageOf(stopId, 'panel-2').messageId, epoch = f.headRecord().head.epoch, pid = f.generations.get(epoch).pid;
    const aborted = await a.agent(`/conversations/${stopId}/abort`, { runId: run.runId, requestId: 'panel-stop-1' });
    assert.equal(aborted.status, 200, JSON.stringify(aborted.body));
    // 接口回成功的时候：进程已经被关掉、文档服务已经结清、结果是「被中断」
    const stopped = f.grantOf(stopMessage), killed = f.stops.find(row => row.epoch === epoch);
    assert.equal(stopped.state, 'finished'); assert.equal(stopped.terminalOutcome.status, 'interrupted'); assert.equal(stopped.terminalOutcome.reason, 'stop');
    assert.ok(killed, '这一代进程被 root 关掉了'); assert.equal(killed.how, 'killed'); assert.equal(killed.pid, pid);
    assert.equal(f.generations.get(epoch).gateway.describe().childClosed, true);
    assert.equal(f.chain(epoch).terminal.fence.kind, 'stop');
    await waitFor(() => f.scheduler.describe()[0].phase === 'idle', '没有在跑的任务', 3000);
    assert.equal(f.conversation(stopId).currentRunId, null);
    assert.ok(!rowsOf(stopId).some(row => kind(row) === 'text' && String(row.event.delta).includes('停之后才会说的话')));
    assert.ok(!stopSeen.some(e => e.type === 'text' && String(e.delta).includes('停之后才会说的话')));
    stopStream.close();
    // 同一个请求号再问一次：原样回成功，不再做第二遍
    assert.equal((await a.agent(`/conversations/${stopId}/abort`, { runId: run.runId, requestId: 'panel-stop-1' })).status, 200);
    assert.equal(f.stops.filter(row => row.epoch === epoch).length, 1);

    // 停掉以后名额让出来：同一个对话里再发一条，照常做完
    const after = await a.agent(`/conversations/${stopId}/messages`, { requestId: 'panel-3', selectionSnapshot: { pageId: a.pageId }, prompt: script([{ say: '停止之后的下一条' }]) });
    assert.equal(after.status, 202);
    await waitFor(() => f.grantOf(f.messageOf(stopId, 'panel-3').messageId)?.state === 'finished', '停止之后的下一条结清');
    assert.equal(f.grantOf(f.messageOf(stopId, 'panel-3').messageId).terminalOutcome.status, 'done');

    const events = Object.fromEntries([...new Set(f.log.map(row => row.event))].filter(name => name.startsWith('slot.')).map(name => [name, f.log.filter(row => row.event === name).length]));
    t.diagnostic(`调度事件 ${JSON.stringify(events)}；共 ${f.generations.size} 代进程；停止那一代 pid ${pid} ${killed.how}（${killed.signal ?? killed.exitCode}）`);
  });
