import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { digestOf } from '../account/ledger.mjs';
import { startRunnerProcessFixture, until, toneWav, PNG_B64 } from './fixtures/account-runner-process.mjs';

// 真实的运行器放进任务进程：一条任务从领取、执行、结束到结清。
// 哪些是真的、哪些是受控的，写在夹具 fixtures/account-runner-process.mjs 的开头。
// 要设 PROMPTCUT_ACCOUNT_PROVIDER_ROOT 与 PROMPTCUT_PASSWORD_ORDER_MODULE（用 npm test 跑）。
const script = steps => `按脚本做。\n\`\`\`mock-script\n${JSON.stringify(steps)}\n\`\`\``;
const sealedRecord = file => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT record FROM worker_terminal WHERE id=1').get().record); } finally { db.close(); }
};
const safeCode = body => (/^[a-z0-9-]{1,80}$/.test(body?.code ?? '') ? body.code : 'unclassified');

test('真实运行器在任务进程里：带工具调用的任务做完并结清；跑的过程中看一次画面；第二条在第一代关掉之后才开始；从外面强制停',
  { timeout: 300_000 }, async t => {
    const f = await startRunnerProcessFixture();
    let actor;
    t.after(async () => {
      await actor?.close().catch(() => {});
      const result = await f.close();
      assert.equal(result.alive, 0, '收尾后不该还有活着的任务子进程');
      if (result.errors.length) throw new AggregateError(result.errors, 'runner fixture close');
    });
    actor = await f.connectActor(0);
    const conversationId = 'runner_conversation';
    const send = async (requestId, steps) => {
      const posted = await actor.agent(`/conversations/${conversationId}/messages`, { prompt: script(steps), requestId, selectionSnapshot: { pageId: actor.pageId } });
      assert.equal(posted.status, 202, `send ${requestId}: ${safeCode(posted.body)}`);
      return f.messageOf(conversationId, requestId).messageId;
    };
    const finished = id => f.grantOf(id)?.state === 'finished';
    const diagnose = () => JSON.stringify({ scheduler: f.scheduler.describe(), head: f.headRecord()?.head ?? null,
      log: f.log.filter(row => row.event !== 'slot.forced.pending').slice(-40).map(row => ({ ...row, at: undefined })),
      worker1: f.workerLog(1).slice(-15), worker2: f.workerLog(2).slice(-10), asset: f.assetOutput().slice(-1500),
      events: f.events(conversationId).map(row => [row.event.type, row.event.name ?? null, row.event.ok ?? null, row.event.code ?? null]) });
    const waitFinished = async (id, what) => { try { await until(() => finished(id), { what, timeoutMs: 90_000 }); } catch (error) { error.message += ` :: ${diagnose()}`; throw error; } };

    // 用户随消息带的一个附件：一段真的 WAV，放在这个对话的工作目录里（各代任务进程共用的数据目录）
    const wav = toneWav(), wavHash = createHash('sha256').update(wav).digest('hex');
    f.workspaceOf(conversationId).write('attachments/tone.wav', wav);

    // ---------- 第一条：读项目、改项目名、看一次画面、把附件导入项目素材库（写运行素材），然后说完 ----------
    const first = await send('runner_message_1', [
      { tool: 'get_project', input: {} },
      { tool: 'set_project_meta', input: { name: 'Runner process edit' } },
      { tool: 'see_frames', input: { source: 'timeline', t: 0 } },
      { tool: 'import_media', input: { url: 'work:attachments/tone.wav', name: 'tone.wav' } },
      { say: '第一条做完' }]);
    const second = await send('runner_message_2', [{ tool: 'get_project', input: {} }, { say: '第二条做完' }]);
    await f.scheduler.start();
    await waitFinished(first, '第一条结清');
    const g1 = f.grantOf(first), chain1 = f.chain(1), stop1 = f.stops.find(row => row.epoch === 1);
    assert.equal(g1.terminalOutcome.status, 'done');
    // 任务在另一个操作系统进程里跑，root 绑定的就是文档服务签给这一条的分配
    assert.notEqual(f.generations.get(1).pid, process.pid);
    assert.equal(chain1.assignment.target.runGrantId, g1.runGrantId);
    // 真实的工具在这个进程里跑了：三个工具都成功，项目真的被改了（文档服务的版本往前走了，名字换了）
    const rows1 = f.events(conversationId).filter(row => row.runGrantId === g1.runGrantId);
    assert.deepEqual(rows1.filter(row => row.event.type === 'tool_result').map(row => [row.event.name, row.event.ok]),
      [['get_project', true], ['set_project_meta', true], ['see_frames', true], ['import_media', true]],
      `${JSON.stringify(rows1.filter(row => row.event.type === 'tool_result').map(row => row.event.summary ?? null))} :: ${diagnose()}`);
    assert.equal(rows1.filter(row => row.event.type === 'text').map(row => row.event.delta).join(''), '第一条做完');
    const state = await actor.project();
    assert.equal(state.type, 'project.state'); assert.ok(state.rev > actor.opened.rev); assert.equal(state.project.name, 'Runner process edit');
    // 写运行素材：字节真的进了素材服务里这个项目的库（凭成员自己的票据另读一遍，逐字节相同），并登记进了项目
    const media = state.project.media.find(row => row.name === 'tone.wav');
    assert.ok(media, '导入的素材登记进了项目'); assert.equal(media.hash, wavHash); assert.equal(media.size, wav.length); assert.equal(media.kind, 'audio');
    const stored = await actor.asset(wavHash);
    assert.equal(stored.status, 200); assert.ok(stored.bytes.equals(wav), '素材服务里存的就是那段字节');
    assert.ok(Object.values(f.ledger().runAssetIntentsV1 ?? {}).some(row => row.purpose === 'import' && row.grantBinding.runGrantId === g1.runGrantId && row.resource.hash === wavHash),
      '文档服务给这条任务签过这次导入的素材访问');
    // 看画面：请求进了渲染服务的队列（落盘的那一种），带着这条任务的授权号；出图的工作进程收到的是这个项目这一版的内容
    const queued = f.log.filter(row => row.event === 'render.look.queued');
    assert.equal(queued.length, 1); assert.equal(queued[0].mode, 'poll'); assert.equal(queued[0].persisted, true);
    assert.equal(queued[0].projectId, f.projectId); assert.equal(queued[0].runGrant, g1.runGrantId.slice(0, 12));
    assert.deepEqual(f.lookCalls.map(call => [call.path, call.projectName, call.t, call.key]), [['/api/vision/snapshot', 'Runner process edit', 0, 'resident-key']],
      '交给出图工作进程的是这一版项目（含刚落地的改名）');
    const lookStatus = f.look.status();
    assert.deepEqual([lookStatus.served, lookStatus.failed, lookStatus.unauthorized, lookStatus.queue.queued], [1, 0, 0, 0]);
    assert.equal(JSON.stringify(rows1).includes(PNG_B64), false, '图片不进事件记录');
    // 结清凭的是 root 的关闭记录：正常关、任务进程自己收完才退
    const receipt1 = f.ledger().runFinishReceiptsV2[g1.finishReceiptId];
    assert.equal(chain1.closure.protocol, 'promptcut.agent-run-scope.closure.v1');
    assert.equal(chain1.terminal.protocol, 'promptcut.agent-run-scope.terminal.v1');
    assert.equal(chain1.intent.terminalDigest, digestOf(chain1.terminal));
    assert.equal(receipt1.complete, true); assert.equal(receipt1.resourceWitnessDigest, digestOf(chain1.closure));
    assert.equal(f.ledger().runControlsV2[receipt1.controlId].state, 'complete');
    assert.equal(stop1.how, 'graceful'); assert.equal(stop1.exitCode, 0); assert.equal(stop1.pid, f.generations.get(1).pid);
    // 收尾记录：终态事件是主服务确认过的最后一条，文档服务记下的结果与它一致
    const sealed1 = sealedRecord(f.generations.get(1).journalFile);
    assert.equal(sealed1.outcome.status, 'done'); assert.deepEqual(sealed1.drain, { state: 'local-drained', events: 'durable', dispatchesOpen: 0 });
    assert.deepEqual(receipt1.outcome, sealed1.outcome); assert.equal(sealed1.readReceiptId, g1.readReceiptId);
    assert.equal(chain1.terminal.finish.outcomeDigest, digestOf(sealed1.outcome));
    const last1 = rows1.at(-1);
    assert.equal(last1.event.type, 'runner_done'); assert.equal(last1.event.outcome, 'done'); assert.equal(last1.eventId, sealed1.outcome.eventId);

    // ---------- 第二条：在第一代被关掉、文档服务结清之后才领得到，用的是新的一代进程 ----------
    await waitFinished(second, '第二条结清');
    const g2 = f.grantOf(second), stop2 = f.stops.find(row => row.epoch === 2);
    assert.equal(g2.terminalOutcome.status, 'done');
    assert.ok(g2.admittedAt >= stop1.at, `第二条领取 ${g2.admittedAt} 不该早于第一代关闭 ${stop1.at}`);
    assert.equal(f.chain(2).assignment.target.runGrantId, g2.runGrantId);
    assert.notEqual(f.generations.get(2).pid, f.generations.get(1).pid);
    assert.equal(stop2.how, 'graceful');
    const all = f.events(conversationId);
    assert.ok(all.findIndex(row => row.runGrantId === g2.runGrantId) > all.indexOf(all.findLast(row => row.runGrantId === g1.runGrantId)), '第二条的事件排在第一条终态之后');

    // ---------- 读运行素材：另一条任务（又一代进程）把刚才导入的素材读回来量响度 ----------
    const reader = await send('runner_message_read', [{ tool: 'measure_audio', input: { mediaId: media.id } }, { say: '量完了' }]);
    await waitFinished(reader, '读素材的那一条结清');
    const gr = f.grantOf(reader), rowsR = f.events(conversationId).filter(row => row.runGrantId === gr.runGrantId);
    assert.equal(gr.terminalOutcome.status, 'done');
    assert.deepEqual(rowsR.filter(row => row.event.type === 'tool_result').map(row => [row.event.name, row.event.ok]), [['measure_audio', true]],
      `measure_audio: ${JSON.stringify(rowsR.filter(row => row.event.type === 'tool_result').map(row => row.event.summary ?? null))} :: ${diagnose()}`);
    const readIntent = Object.values(f.ledger().runAssetIntentsV1 ?? {}).find(row => row.purpose === 'openRead' && row.grantBinding.runGrantId === gr.runGrantId);
    assert.ok(readIntent, '文档服务给这条任务签过这次读取'); assert.equal(readIntent.resource.hash, wavHash);
    // 素材的租约都关了：任务进程每次请求用完就断开，素材服务看到连接关了向文档服务报关闭
    await until(() => Object.values(f.ledger().runAssetLeasesV1 ?? {}).every(row => row.state === 'closed'), { what: '运行素材的租约都关闭', timeoutMs: 20_000 });
    const leases = Object.values(f.ledger().runAssetLeasesV1 ?? {});
    assert.ok(leases.length >= 4, `导入（对账、传片、收尾）与读取各有租约：${leases.length}`);

    // ---------- 第三条：做到一半从外面强制停 ----------
    const third = await send('runner_message_3', [
      { tool: 'set_project_meta', input: { name: 'Before forced stop' } },
      { sleepMs: 60_000 },
      { tool: 'set_project_meta', input: { name: 'MUST NOT LAND' } },
      { say: '这句不该出现' }]);
    const fourth = await send('runner_message_4', [{ say: '第四条做完' }]);
    await until(() => f.events(conversationId).some(row => row.runGrantId === f.grantOf(third)?.runGrantId && row.event.type === 'tool_result'),
      { what: '第三条做完第一个工具', timeoutMs: 90_000 }).catch(error => { error.message += ` :: ${diagnose()}`; throw error; });
    const g3 = f.grantOf(third), pid3 = f.generations.get(4).pid;
    assert.equal(g3.state, 'active');
    // 用户按「停止」：经主服务的公开接口到文档服务。权限在文档服务提交围栏的那一刻就没了；
    // 接口要等 root 真的把进程关掉才回成功，没办完时回「还在办」，用同一个请求号再问。
    let stopReply = null;
    await until(async () => {
      stopReply = await actor.agent(`/conversations/${conversationId}/abort`, { runId: g3.runId, requestId: 'runner_stop_3' });
      return stopReply.status === 200;
    }, { what: '停止接口回成功', timeoutMs: 60_000, everyMs: 300 }).catch(error => { error.message += ` last=${stopReply?.status}/${safeCode(stopReply?.body)} :: ${diagnose()}`; throw error; });
    await waitFinished(third, '强制停止结清');
    const done3 = f.grantOf(third), chain3 = f.chain(4), stop3 = f.stops.find(row => row.epoch === 4);
    assert.equal(done3.terminalOutcome.status, 'interrupted'); assert.equal(done3.terminalOutcome.reason, 'stop');
    assert.equal(done3.finishReceiptId, undefined, '没做完的任务没有正常结束的回执');
    assert.equal(chain3.terminal.protocol, 'promptcut.agent-run-scope.forced-terminal.v1');
    assert.equal(chain3.terminal.fence.kind, 'stop');
    assert.equal(chain3.intent, null, '强制关不需要、也不补任务进程的意向');
    assert.equal(chain3.closure.protocol, 'promptcut.agent-run-scope.forced-closure.v1');
    assert.equal(stop3.how, 'killed'); assert.equal(stop3.pid, pid3);
    assert.equal(f.generations.get(4).gateway.describe().childClosed, true);
    const control3 = f.ledger().runControlsV2[chain3.terminal.fence.controlId];
    assert.equal(control3.state, 'complete'); assert.equal(control3.receipt.closures[g3.runGrantId], digestOf(chain3.closure));
    const rows3 = f.events(conversationId).filter(row => row.runGrantId === g3.runGrantId);
    assert.equal(rows3.some(row => row.event.type === 'runner_done'), false);
    assert.equal(rows3.some(row => row.event.type === 'text' && row.event.delta === '这句不该出现'), false);
    assert.equal(rows3.filter(row => row.event.type === 'tool_result').length, 1, '停止之后的那个工具没有执行');
    // 停止之前落地的修改保留，停止之后的没有落地
    assert.equal((await actor.project()).project.name, 'Before forced stop');

    // ---------- 第四条：强制关掉之后名额让出来，照常做完 ----------
    await waitFinished(fourth, '第四条结清');
    const g4 = f.grantOf(fourth);
    assert.equal(g4.terminalOutcome.status, 'done'); assert.ok(g4.admittedAt >= stop3.at);
    assert.equal(f.conversation(conversationId).currentRunId, null);
    assert.deepEqual(f.scheduler.describe().map(row => row.phase), ['idle']);
    t.diagnostic(`epoch1 pid ${stop1.pid} graceful@${stop1.at}; second admitted ${g2.admittedAt}; epoch4 pid ${pid3} ${stop3.how} (exit ${stop3.exitCode}/${stop3.signal}); look served ${lookStatus.served}`);
  });
