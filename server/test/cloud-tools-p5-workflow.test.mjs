// P5(后台作业状态与一键流程)单测:真的运行授权 / run-resources / tool-jobs(SQLite) / 工作区,三个感知提供方是「假」的(可控),
// 项目一侧是内存替身。真短片、真转写、真镜头识别、真主体识别整条走通在 cloud-tools-p5-real.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  WORKFLOW_TOOL_NAMES, WORKFLOW_STAGES, WORKFLOW_ERROR_TEXT, planAutoWorkflowEdits, createWorkflowTools,
} from '../agent/service/hosted-workflow.mjs';
import { STT_ERROR_TEXT } from '../agent/service/perception/stt.mjs';
import { makeP5Fixture, SCRIPT, SCRIPT_SEGMENTS, testKernel, until, sleep, projectId, conversationId } from './cloud-tools-p5-fixture.mjs';

const rawJobs = (f) => {
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try { return db.prepare('SELECT job_id, kind, state, stage, progress, error_code, output_refs FROM tool_jobs ORDER BY created_at').all(); } finally { db.close(); }
};
const stageStatus = (status) => Object.fromEntries(status.stages.map((s) => [s.stage, s.status]));
const SLOW = { fastWaitMs: 40 };
const msg = (promise) => promise.then(() => null, (e) => e);

/* ===================================================================== 配卡规则 */

test('plan: groups, cards and captions follow the desktop rules on a hand-checked script', () => {
  const plan = planAutoWorkflowEdits({
    transcript: SCRIPT, mediaId: 'm1', tracks: [{ clips: [{ mediaId: 'm1', start: 0, end: 30, mediaOffset: 0 }] }], maxCards: 12, getCard: testKernel.getCard,
  });
  assert.equal(plan.segments, 6);
  assert.equal(plan.groups, 3);
  assert.deepEqual(plan.cards.map((c) => c.cardId), ['odometer', 'term-card', 'step-timeline']);
  assert.deepEqual(plan.cards.map((c) => [c.start, c.duration]), [[0, 6.2], [8, 5.5], [15, 5.5]]);
  assert.deepEqual(plan.cards[0].params, { unit: '', label: '去年我们的用户增长了300%,这是一个翻倍的结果。', value: 300, kicker: 'DATA' });
  assert.deepEqual(plan.cards[1].params, { term: '所谓留存率,指的是用户回来的比例。', def: '所谓留存率,指的是用户回来的比例。', en: '' });
  assert.deepEqual(plan.cards[2].params, { steps: '第一步|打开软件|第二步|导入素材' });
  assert.equal(plan.skippedByPlan, 0);
  assert.equal(plan.caption.start, 0);
  assert.equal(plan.caption.duration, 20.5);
  assert.equal(plan.caption.params.showEn, 'false');
  assert.equal(plan.caption.params.lines.split('\n').length, 6);
  assert.equal(plan.caption.params.lines.split('\n')[0], '0.00|3.00|去年我们的用户增长了300%,|');
});

test('plan: a clip placed later on the timeline shifts the segments and drops what falls outside it', () => {
  const plan = planAutoWorkflowEdits({
    transcript: SCRIPT, mediaId: 'm1', tracks: [{ clips: [{ mediaId: 'other', start: 0, end: 5 }] }, { clips: [{ mediaId: 'm1', start: 10, end: 24, mediaOffset: 2 }] }],
    maxCards: 12, getCard: testKernel.getCard,
  });
  // 第一条片段是别的素材;m1 的片段在 10 秒起、素材内 2 秒处开始,到 24 秒结束 → 素材内 16 秒之后的内容落在片段外
  assert.ok(plan.caption.start >= 10);
  assert.ok(plan.caption.start + plan.caption.duration <= 24 + 1e-9);
  assert.ok(plan.cards.every((c) => c.start >= 10 && c.start + c.duration <= 24 + 1e-9));
  // 素材不在时间轴上:从 0 开始、不裁
  const bare = planAutoWorkflowEdits({ transcript: SCRIPT, mediaId: 'nope', tracks: [], maxCards: 12, getCard: testKernel.getCard });
  assert.equal(bare.segments, 6);
});

test('plan: maxCards caps the cards, unknown card definitions get empty params, an empty transcript gives nothing', () => {
  const capped = planAutoWorkflowEdits({ transcript: SCRIPT, mediaId: 'm1', maxCards: 1, getCard: testKernel.getCard });
  assert.equal(capped.cards.length, 1);
  assert.equal(capped.skippedByPlan, 2);
  const noDefs = planAutoWorkflowEdits({ transcript: SCRIPT, mediaId: 'm1', maxCards: 12, getCard: () => undefined });
  assert.deepEqual(noDefs.cards.map((c) => c.params), [{}, {}, {}]);
  const none = planAutoWorkflowEdits({ transcript: { segments: [] }, mediaId: 'm1', maxCards: 12, getCard: testKernel.getCard });
  assert.deepEqual([none.cards.length, none.caption, none.groups], [0, null, 0]);
});

test('plan: the rules are the desktop ones — every regular expression in the grouping and card-picking code matches src/mcp/tools/autoWorkflow.ts', () => {
  const regexes = (source, from, to) => {
    const body = source.slice(source.indexOf(from), source.indexOf(to));
    return [...body.matchAll(/\/(?![*/])((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+)\/([a-z]*)/g)]
      .map((m) => m[0]).filter((r) => !/^\/\s/.test(r) && r.length > 3);
  };
  const desktop = fs.readFileSync(fileURLToPath(new URL('../../src/mcp/tools/autoWorkflow.ts', import.meta.url)), 'utf8');
  const mine = fs.readFileSync(fileURLToPath(new URL('../agent/service/hosted-workflow.mjs', import.meta.url)), 'utf8');
  const a = regexes(desktop, '// 4. 分组', '// 7. 落卡');
  const b = regexes(mine, 'export function planAutoWorkflowEdits', 'const selected = [];').concat([]);
  const mineSelect = regexes(mine, 'function selectCard(text)', 'function paramsFor');
  const mineParams = regexes(mine, 'function paramsFor', 'export function planAutoWorkflowEdits');
  const mineGroup = regexes(mine, 'const groups = [];', 'const selected = [];');
  assert.ok(a.length >= 15, `found ${a.length} desktop regexes`);
  // 桌面版顺序:分组 → selectCard → paramsFor;云端:selectCard → paramsFor → 分组
  assert.deepEqual([...mineGroup, ...mineSelect, ...mineParams], a);
  assert.ok(b.length > 0);
  // 数字阈值也对得上:15 秒必断、5 秒后看标点/停顿、停顿 0.6 秒、尾巴小于 5 秒并进上一组、合并后不超过 18 秒
  for (const needle of ['groupDuration >= 15', 'groupDuration >= 5', 'gap >= 0.6', '> 15', 'last.end - last.start < 5', '<= 18']) {
    assert.ok(desktop.includes(needle), `desktop has ${needle}`);
    assert.ok(mine.includes(needle), `cloud has ${needle}`);
  }
});

/* ===================================================================== 配置与参数 */

test('factory: refuses to be built without its seams; handles exactly the three tools; never mentions spawn_agent', async (t) => {
  const f = await makeP5Fixture(t);
  assert.deepEqual([...f.workflow.handles].sort(), [...WORKFLOW_TOOL_NAMES].sort());
  assert.ok(!f.workflow.handles.has('spawn_agent'));
  const base = { resources: f.resources, jobs: f.jobs, workspace: f.wsOf, project: f.project, kernel: testKernel };
  for (const omit of ['resources', 'jobs', 'workspace', 'project', 'kernel']) {
    const bad = { ...base }; delete bad[omit];
    assert.throws(() => createWorkflowTools(bad), (e) => e.code === 'workflow-unconfigured', omit);
  }
  assert.throws(() => createWorkflowTools({ ...base, kernel: {} }), /getCard/);
  assert.throws(() => createWorkflowTools({ ...base, project: { getMedia() {} } }), (e) => e.code === 'workflow-unconfigured');
  await assert.rejects(f.workflow.call('spawn_agent', {}, f.context), (e) => e.code === 'unknown-tool');
});

test('arguments: media id, style and maxCards are checked; unknown arguments are refused; nothing is started', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  for (const args of [undefined, {}, { mediaId: 7 }, { mediaId: '../x' }, { mediaId: 'm1', maxCards: -1 }, { mediaId: 'm1', maxCards: 1.5 }, { mediaId: 'm1', maxCards: 'many' },
    { mediaId: 'm1', maxCards: 101 }, { mediaId: 'm1', style: 3 }, { mediaId: 'm1', projectId: 'other' }, { mediaId: 'm1', engine: 'whisper' }]) {
    const error = await msg(f.call('auto_workflow', args));
    assert.equal(error?.code, 'bad-args', JSON.stringify(args));
  }
  const missing = await msg(f.call('auto_workflow', { mediaId: 'nope' }));
  assert.equal(missing.code, 'media-not-found');
  await f.addMedia({ id: 'pic', name: 'a.png', kind: 'image' });
  assert.equal((await msg(f.call('auto_workflow', { mediaId: 'pic' }))).code, 'media-kind');
  assert.equal(rawJobs(f).length, 0, 'no job for any refused call');
  assert.equal(f.state.editAttempts, 0);
});

/* ===================================================================== 一整条走通(假感知) */

test('auto_workflow: all five stages run in order, the project really gains captions and cards, and the status matches stage by stage', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  const before = f.state.cards.length;
  const answer = await f.call('auto_workflow', { mediaId: 'm1', style: 'clean' }, f.context, { requestId: 'tool-call-0001' });
  assert.equal(answer.running, false);
  assert.match(answer.jobId, /^job_/);
  assert.equal(answer.mediaId, 'm1');
  assert.equal(answer.style, 'clean');
  assert.equal(answer.transcribed, true);
  assert.equal(answer.segments, 6);
  assert.equal(answer.groups, 3);
  assert.equal(answer.skipped, 0);
  assert.deepEqual(answer.clips.map((c) => c.cardId), ['odometer', 'term-card', 'step-timeline']);
  assert.ok(answer.clips.every((c) => /^clip_\d+$/.test(c.clipId) && c.end > c.start && c.text.length > 0));
  assert.match(answer.captionClipId, /^clip_\d+$/);
  assert.deepEqual(Object.keys(answer.stages ?? []).length, 5);

  // 项目里真的多了字幕和卡片:一次提交、带了期望版本
  assert.equal(f.state.cards.length - before, 4);
  assert.equal(f.state.cards.filter((c) => c.cardId === 'caption-track').length, 1);
  assert.deepEqual(f.state.cards.filter((c) => c.cardId !== 'caption-track').map((c) => c.cardId), ['odometer', 'term-card', 'step-timeline']);
  assert.equal(f.state.commits.filter((c) => c.what === 'edits').length, 1);
  assert.ok(f.state.duration >= 20.5);
  assert.equal(f.state.published.length, 1);
  assert.deepEqual(new Set(f.state.published[0].clipIds), new Set(f.state.cards.map((c) => c.clipId)));
  assert.equal(f.state.published[0].jobId, answer.jobId);
  // 各感知提供方各被调用一次,带的是宿主给的请求号派生出来的(每个阶段不同)
  const asked = [f.perception.stt, f.perception.shots, f.perception.subject].map((p) => p.ctl.calls);
  assert.deepEqual(asked.map((c) => c.length), [1, 1, 1]);
  assert.equal(new Set(asked.map((c) => c[0].requestId)).size, 3);
  assert.ok(asked.every((c) => c[0].args.mediaId === 'm1' && Object.keys(c[0].args).length === 1), 'only the media id is passed down');

  const status = await f.call('auto_workflow_status', { jobId: answer.jobId });
  assert.deepEqual([status.done, status.ok, status.state, status.phase, status.progress, status.error], [true, true, 'done', '已完成', 1, null]);
  assert.deepEqual(stageStatus(status), { transcribe: 'done', shots: 'done', subjects: 'done', compose: 'done', prerender: 'done' });
  assert.equal(status.complete, true);
  assert.deepEqual(status.result.clips.map((c) => c.cardId), answer.clips.map((c) => c.cardId));
  assert.ok(status.stages.find((s) => s.stage === 'transcribe').childJobId.startsWith('job_'));
  // 账本:一键流程和三个子作业都在,一键流程是 done、进度 1、产物引用里有阶段
  const rows = rawJobs(f);
  assert.deepEqual(rows.map((r) => r.kind).sort(), ['shots.detect', 'stt.transcribe', 'subject.detect', 'workflow.auto']);
  const wf = rows.find((r) => r.kind === 'workflow.auto');
  assert.deepEqual([wf.state, wf.stage, wf.progress], ['done', 'done', 1]);
  assert.ok(JSON.parse(wf.output_refs).some((r) => r.kind === 'stage' && r.id === 'compose'));
  // 这条素材现在没有占着:可以再发起
  const again = await f.call('auto_workflow', { mediaId: 'm1' }, f.context, { requestId: 'tool-call-0002' });
  assert.equal(again.running, false);
});

test('auto_workflow: a second run on the same media reuses what is already there and does not place the cards twice', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  const first = await f.call('auto_workflow', { mediaId: 'm1' }, f.context, { requestId: 'tool-call-0001' });
  const cardsAfterFirst = f.state.cards.length;
  const second = await f.call('auto_workflow', { mediaId: 'm1' }, f.context, { requestId: 'tool-call-0002' });
  assert.notEqual(second.jobId, first.jobId);
  const status = await f.call('auto_workflow_status', { jobId: second.jobId });
  assert.deepEqual(stageStatus(status), { transcribe: 'reused', shots: 'reused', subjects: 'reused', compose: 'reused', prerender: 'done' });
  assert.equal(second.transcribed, false);
  assert.equal(f.state.cards.length, cardsAfterFirst, 'no duplicates in the project');
  assert.equal(f.perception.stt.ctl.calls.length, 1, 'transcription was not asked for again');
  assert.equal(f.perception.shots.ctl.calls.length, 1);
  assert.equal(f.perception.subject.ctl.calls.length, 1);
});

test('auto_workflow: audio has no picture, so shots and subjects are skipped honestly (not marked done) and the rest runs', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'voice', name: 'voice.wav', kind: 'audio' });
  const answer = await f.call('auto_workflow', { mediaId: 'voice' });
  const status = await f.call('auto_workflow_status', { jobId: answer.jobId });
  assert.deepEqual(stageStatus(status), { transcribe: 'done', shots: 'skipped', subjects: 'skipped', compose: 'done', prerender: 'done' });
  assert.match(status.stages[1].reason, /不是视频/);
  assert.equal(f.perception.shots.ctl.calls.length + f.perception.subject.ctl.calls.length, 0);
  assert.equal(status.complete, true);
});

test('auto_workflow: maxCards 0 still lays the caption track; a transcript with nothing inside the clip commits nothing', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  const none = await f.call('auto_workflow', { mediaId: 'm1', maxCards: 0 });
  assert.deepEqual(none.clips, []);
  assert.equal(none.skipped, 3);
  assert.match(none.captionClipId, /^clip_/);
  assert.equal(f.state.cards.length, 1);

  const g = await makeP5Fixture(t);
  await g.addMedia({ id: 'm2' });
  g.state.tracks[0].clips[0] = { id: 'tl', mediaId: 'm2', start: 100, end: 110, mediaOffset: 500 };       // 片段在素材 500 秒之后:文字稿全落在外面
  const empty = await g.call('auto_workflow', { mediaId: 'm2' });
  assert.equal(empty.captionClipId, null);
  assert.deepEqual(empty.clips, []);
  assert.equal(g.state.editAttempts, 0, 'nothing to commit, so no commit');
  const status = await g.call('auto_workflow_status', { jobId: empty.jobId });
  assert.equal(status.stages.find((s) => s.stage === 'prerender').status, 'skipped');
});

test('auto_workflow: a long run answers with a job id after the wait and finishes in the background; asking again does not start a second one', async (t) => {
  const f = await makeP5Fixture(t, { workflowLimits: SLOW });
  await f.addMedia({ id: 'm1' });
  f.perception.stt.ctl.hold = true;
  const first = await f.call('auto_workflow', { mediaId: 'm1' }, f.context, { requestId: 'tool-call-0001' });
  assert.deepEqual([first.running, first.started], [true, true]);
  assert.equal(first.phase, '转写中');
  assert.match(first.hint, /auto_workflow_status/);
  const running = await f.call('auto_workflow_status', { jobId: first.jobId });
  assert.deepEqual([running.done, running.ok, running.state, running.phase], [false, false, 'running', '转写中']);
  assert.equal(running.stage, 'transcribe');
  assert.deepEqual(stageStatus(running), { transcribe: 'running', shots: 'pending', subjects: 'pending', compose: 'pending', prerender: 'pending' });
  assert.ok(running.progress > 0 && running.progress < 1);

  const dup = await f.call('auto_workflow', { mediaId: 'm1' }, f.context, { requestId: 'tool-call-0002' });
  assert.deepEqual([dup.jobId, dup.alreadyRunning, dup.started], [first.jobId, true, false]);
  const sameRequest = await f.call('auto_workflow', { mediaId: 'm1' }, f.context, { requestId: 'tool-call-0001' });
  assert.equal(sameRequest.jobId, first.jobId);
  assert.equal(rawJobs(f).filter((r) => r.kind === 'workflow.auto').length, 1);

  f.perception.stt.release();
  const done = await f.settle(first.jobId);
  assert.deepEqual([done.ok, done.state], [true, 'done']);
  assert.equal(done.result.clips.length, 3);
});

/* ===================================================================== 失败、没就绪、取消 */

test('a failed stage stops the flow there: later stages are not run, nothing half-committed, the failure is in the words of the package', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  f.perception.shots.ctl.failCode = 'SHOTS_FAILED';
  f.perception.shots.ctl.failMessage = '镜头识别没成功:ffmpeg 报了错。退路:用 see_frames 看真实画面。';
  const answer = await f.call('auto_workflow', { mediaId: 'm1' });
  assert.deepEqual([answer.ok, answer.running, answer.done, answer.state], [false, false, true, 'error']);
  assert.match(answer.error, /镜头识别/);
  assert.match(answer.error, /ffmpeg 报了错/);
  assert.match(answer.error, /后面的阶段\(主体识别、生成字幕与卡片、发布预渲染任务\)没有做/);
  assert.equal(answer.stages.find((s) => s.stage === 'shots').status, 'error');
  assert.equal(answer.stages.find((s) => s.stage === 'transcribe').status, 'done', 'what was done before stays done');
  for (const later of ['subjects', 'compose', 'prerender']) assert.equal(answer.stages.find((s) => s.stage === later).status, 'pending', later);
  assert.equal(f.perception.subject.ctl.calls.length, 0, 'the next stage was never asked for');
  assert.equal(f.state.editAttempts, 0);
  assert.equal(f.state.cards.length, 0, 'no half commit');
  assert.equal(f.state.published.length, 0);
  const wf = rawJobs(f).find((r) => r.kind === 'workflow.auto');
  assert.deepEqual([wf.state, wf.stage, wf.error_code], ['error', 'shots', 'STAGE_FAILED']);
  const status = await f.call('auto_workflow_status', { jobId: answer.jobId });
  assert.deepEqual([status.done, status.ok, status.result], [true, false, null]);
});

test('a stage whose capability is not ready on this node says so and stops there — no placeholder job, no pretending', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  f.perception.subject.ctl.unavailable = '这台云节点上主体识别的两档引擎都用不了(没有兜底档)。退回 see_frames。';
  const answer = await f.call('auto_workflow', { mediaId: 'm1' });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /主体识别/);
  assert.match(answer.error, /两档引擎都用不了/);
  assert.equal(answer.stages.find((s) => s.stage === 'subjects').status, 'unavailable');
  assert.equal(answer.stages.find((s) => s.stage === 'compose').status, 'pending');
  assert.equal(f.state.cards.length, 0);
  assert.ok(!rawJobs(f).some((r) => r.kind === 'subject.detect'), 'no job was created for the stage that cannot run');
  assert.equal(rawJobs(f).find((r) => r.kind === 'workflow.auto').state, 'error');
  assert.equal(rawJobs(f).find((r) => r.kind === 'workflow.auto').error_code, 'STAGE_UNAVAILABLE');
});

test('a perception package that is not wired on this node is "not available" for its stage (and only that stage)', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  const workflow = f.workflow;
  await workflow.close('test');
  const without = createWorkflowTools({ resources: f.resources, jobs: f.jobs, workspace: f.wsOf, project: f.project, kernel: testKernel,
    providers: { stt: f.perception.stt, shots: null, subject: f.perception.subject }, limits: { pollMs: 15, progressMs: 0, fastWaitMs: 10_000 } });
  t.after(() => without.close());
  const answer = await without.call('auto_workflow', { mediaId: 'm1' }, f.context);
  assert.equal(answer.ok, false);
  assert.equal(answer.stages.find((s) => s.stage === 'shots').status, 'unavailable');
  assert.match(answer.stages.find((s) => s.stage === 'shots').reason, /没有接上镜头识别/);
  assert.equal(answer.stages.find((s) => s.stage === 'transcribe').status, 'done');
  assert.equal(f.state.cards.length, 0);
});

test('optionalStages lets the host decide which unready stages may be left out; the leftover is reported as not done, never as done', async (t) => {
  const f = await makeP5Fixture(t, { optionalStages: ['subjects', 'prerender'] });
  await f.addMedia({ id: 'm1' });
  f.perception.subject.ctl.unavailable = '主体识别用不了';
  const answer = await f.call('auto_workflow', { mediaId: 'm1' });
  assert.equal(answer.running, false);
  assert.deepEqual(answer.notDone, ['主体识别']);
  assert.equal(answer.stages.find((s) => s.stage === 'subjects').status, 'unavailable');
  assert.equal(answer.stages.find((s) => s.stage === 'compose').status, 'done');
  assert.equal(f.state.cards.length, 4, 'the cards and captions were placed');
  const status = await f.call('auto_workflow_status', { jobId: answer.jobId });
  assert.deepEqual([status.ok, status.complete], [true, false]);
});

test('transcription that is not ready (engine missing) stops at the first stage with the package words', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  f.perception.stt.ctl.unavailable = STT_ERROR_TEXT.ENGINE_NOT_INSTALLED;
  const answer = await f.call('auto_workflow', { mediaId: 'm1' });
  assert.equal(answer.stages[0].status, 'unavailable');
  assert.match(answer.error, /语音转写/);
  assert.match(answer.error, /没有安装所选的语音识别引擎/);
  assert.equal(f.perception.shots.ctl.calls.length, 0);
});

test('a stage job that fails with a coded error is explained in the package words (transcription table)', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  f.perception.stt.ctl.failCode = 'MODEL_NOT_INSTALLED';
  const answer = await f.call('auto_workflow', { mediaId: 'm1' });
  assert.match(answer.error, new RegExp(STT_ERROR_TEXT.MODEL_NOT_INSTALLED.slice(0, 12)));
  assert.equal(answer.stages[0].status, 'error');
  assert.equal(answer.stages[0].childErrorCode, 'MODEL_NOT_INSTALLED');
});

test('the prerender stage: no seam / no render node is "not done" but not a failure; a publishing error after the commit says the commit is in', async (t) => {
  const none = await makeP5Fixture(t, { withPrerender: false });
  await none.addMedia({ id: 'm1' });
  const a = await none.call('auto_workflow', { mediaId: 'm1' });
  assert.equal(a.running, false);
  assert.deepEqual(a.notDone, ['发布预渲染任务']);
  const sa = await none.call('auto_workflow_status', { jobId: a.jobId });
  assert.deepEqual([sa.ok, sa.complete, sa.stages.at(-1).status], [true, false, 'unavailable']);
  assert.match(sa.stages.at(-1).reason, /没有接预渲染发布/);
  assert.equal(none.state.cards.length, 4);

  const quiet = await makeP5Fixture(t);
  await quiet.addMedia({ id: 'm1' });
  quiet.prerender.mode = 'not-published';
  const b = await quiet.call('auto_workflow', { mediaId: 'm1' });
  assert.deepEqual(b.notDone, ['发布预渲染任务']);
  assert.match((await quiet.call('auto_workflow_status', { jobId: b.jobId })).stages.at(-1).reason, /没有可用的渲染节点/);

  const broken = await makeP5Fixture(t);
  await broken.addMedia({ id: 'm1' });
  broken.prerender.mode = 'throw';
  const c = await broken.call('auto_workflow', { mediaId: 'm1' });
  assert.deepEqual([c.ok, c.committed], [false, true]);
  assert.match(c.error, /字幕和卡片已经写进项目,但发布预渲染任务没有成功/);
  assert.equal(broken.state.cards.length, 4);
  assert.equal((await broken.call('auto_workflow_status', { jobId: c.jobId })).stages.find((s) => s.stage === 'compose').status, 'done');
});

test('commit: the project moved on under us — re-read, re-plan and commit once; if it keeps moving, give up with no half commit', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  f.hooks.beforeApply = async () => { f.state.rev += 1; };                // 第一次提交前,别人改了项目
  const ok = await f.call('auto_workflow', { mediaId: 'm1' });
  assert.equal(ok.running, false);
  assert.equal(f.state.editAttempts, 2, 'rejected once, then committed against the new version');
  assert.equal(f.state.cards.length, 4);

  const g = await makeP5Fixture(t);
  await g.addMedia({ id: 'm1' });
  const shaky = g.project.applyEdits;
  g.project.applyEdits = async (ctx, input) => { g.state.rev += 1; return shaky(ctx, input); };      // 次次都被别人抢先
  const gaveUp = await g.call('auto_workflow', { mediaId: 'm1' });
  assert.equal(gaveUp.ok, false);
  assert.match(gaveUp.error, /一直被别人改动/);
  assert.equal(g.state.editAttempts, 3);
  assert.equal(g.state.cards.length, 0, 'no half commit');
  assert.equal(rawJobs(g).find((r) => r.kind === 'workflow.auto').error_code, 'PROJECT_CHANGED');
});

test('commit: a failing commit leaves the project untouched and the flow in error; the media being swapped is reported as such', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  f.hooks.failApply = Object.assign(new Error('disk full'), { code: 'storage' });
  const a = await f.call('auto_workflow', { mediaId: 'm1' });
  assert.equal(a.ok, false);
  assert.match(a.error, /没能写进项目\(没有半截提交\)/);
  assert.equal(f.state.cards.length, 0);
  assert.equal(a.stages.find((s) => s.stage === 'prerender').status, 'pending');
  assert.equal(f.state.published.length, 0);

  const g = await makeP5Fixture(t);
  await g.addMedia({ id: 'm1' });
  g.hooks.failApply = Object.assign(new Error('media-changed'), { code: 'media-changed' });
  const b = await g.call('auto_workflow', { mediaId: 'm1' });
  assert.match(b.error, /素材在这期间被换掉或删掉了/);
});

test('commit: cards the project cannot place are counted as skipped (same as the desktop flow)', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  const original = f.project.applyEdits;
  f.project.applyEdits = async (ctx, input) => {
    const result = await original(ctx, input);
    return { ...result, clips: result.clips.map((c, i) => (i === 1 ? null : c)) };
  };
  const answer = await f.call('auto_workflow', { mediaId: 'm1' });
  assert.deepEqual(answer.clips.map((c) => c.cardId), ['odometer', 'step-timeline']);
  assert.equal(answer.skipped, 1);
});

test('cancel in the middle of a stage: it stops, the next stage never starts, nothing is committed, the child is asked to stop', async (t) => {
  const f = await makeP5Fixture(t, { workflowLimits: SLOW });
  await f.addMedia({ id: 'm1' });
  f.perception.shots.ctl.hold = true;
  const first = await f.call('auto_workflow', { mediaId: 'm1' });
  await until(async () => (await f.call('auto_workflow_status', { jobId: first.jobId })).stage === 'shots', { what: 'shots stage' });
  const out = await f.workflow.cancel(f.context, first.jobId);
  assert.equal(out.cancelled, true);
  const status = await f.call('auto_workflow_status', { jobId: first.jobId });
  assert.deepEqual([status.done, status.ok, status.state], [true, false, 'cancelled']);
  assert.deepEqual(stageStatus(status), { transcribe: 'done', shots: 'cancelled', subjects: 'pending', compose: 'pending', prerender: 'pending' });
  assert.match(status.error, /「镜头识别」阶段被取消了/);
  assert.equal(f.perception.subject.ctl.calls.length, 0);
  assert.equal(f.state.editAttempts, 0);
  assert.equal(f.state.cards.length, 0);
  // 孩子作业也停了
  await until(() => rawJobs(f).find((r) => r.kind === 'shots.detect').state === 'cancelled', { what: 'child cancelled' });
  // 取消之后还能再发起,接着做(转写不重做)
  f.perception.shots.ctl.hold = false;
  const again = await f.call('auto_workflow', { mediaId: 'm1' });
  const finished = again.running ? await f.settle(again.jobId) : { ok: true };
  assert.equal(finished.ok, true);
  assert.equal(f.perception.stt.ctl.calls.length, 1);
  assert.equal(f.state.cards.length, 4);
});

test('the run is stopped (host path: abortForFence then cancelForFence): the stage stops, no next stage, no commit, the ledger says cancelled', async (t) => {
  const f = await makeP5Fixture(t, { workflowLimits: SLOW });
  await f.addMedia({ id: 'm1' });
  f.perception.shots.ctl.hold = true;
  const first = await f.call('auto_workflow', { mediaId: 'm1' });
  await until(async () => (await f.call('auto_workflow_status', { jobId: first.jobId })).stage === 'shots', { what: 'shots stage' });
  const wfBefore = rawJobs(f).find((r) => r.kind === 'workflow.auto');
  assert.equal(wfBefore.state, 'running');

  // 宿主:先杀登记的资源(一键流程登记成一个流资源),再按控制面事件里的旧栅栏取消账本
  const fence = (await f.resources.authorize(f.context, 'read')).fenceRevision;
  await f.authority.privateFence();
  const receipt = await f.resources.abortForFence(f.context, 'private');
  assert.equal(receipt.streamsOpen, 0, 'the workflow handle was released');
  f.cancel.window = true; f.cancel.fence = fence;
  await f.jobs.cancelForFence(f.context, fence);
  f.cancel.window = false;
  f.perception.shots.ctl.hold = false;
  await sleep(250);
  assert.equal(f.perception.subject.ctl.calls.length, 0, 'never moved on to the next stage');
  assert.equal(f.state.editAttempts, 0, 'never committed');
  assert.equal(f.state.cards.length, 0);
  const rows = rawJobs(f);
  assert.equal(rows.find((r) => r.kind === 'workflow.auto').state, 'cancelled');
  assert.ok(['cancelled', 'running'].includes(rows.find((r) => r.kind === 'shots.detect').state));
  assert.equal(f.state.published.length, 0);
  // 权限已经收回:再问状态被拒
  const error = await msg(f.call('auto_workflow_status', { jobId: first.jobId }));
  assert.equal(error.status, 403);
});

test('the grant is revoked without the host killing anything: the next ledger check notices and the flow stops quietly', async (t) => {
  const f = await makeP5Fixture(t, { workflowLimits: SLOW });
  await f.addMedia({ id: 'm1' });
  f.perception.stt.ctl.hold = true;
  const first = await f.call('auto_workflow', { mediaId: 'm1' });
  await until(() => rawJobs(f).some((r) => r.kind === 'stt.transcribe' && r.state === 'running'), { what: 'stt running' });
  await f.authority.privateFence();
  f.perception.stt.ctl.hold = false;
  await sleep(300);
  assert.equal(f.perception.shots.ctl.calls.length, 0);
  assert.equal(f.state.editAttempts, 0);
  assert.equal(f.state.cards.length, 0);
  assert.notEqual(rawJobs(f).find((r) => r.kind === 'workflow.auto').state, 'done');
  assert.ok(first.jobId);
});

/* ===================================================================== 关闭、重启 */

test('close() while a stage is running: the flow is "interrupted" at that stage; after reopening the status says which stage, and a new call picks up the finished work', async (t) => {
  const f = await makeP5Fixture(t, { workflowLimits: SLOW });
  await f.addMedia({ id: 'm1' });
  f.perception.shots.ctl.hold = true;
  const first = await f.call('auto_workflow', { mediaId: 'm1' });
  await until(async () => (await f.call('auto_workflow_status', { jobId: first.jobId })).stage === 'shots', { what: 'shots stage' });
  const receipt = await f.workflow.close('shutdown');
  assert.deepEqual(receipt, { childrenClosed: true, streamsClosed: true, workPending: 0 });
  assert.equal(rawJobs(f).find((r) => r.kind === 'workflow.auto').state, 'interrupted');
  assert.equal(f.state.editAttempts, 0);
  await assert.rejects(f.workflow.call('auto_workflow', { mediaId: 'm1' }, f.context), (e) => e.code === 'workflow-closed');

  await f.restart();
  f.perception.shots.ctl.hold = false;
  const status = await f.call('auto_workflow_status', { jobId: first.jobId });
  assert.deepEqual([status.done, status.ok, status.state, status.phase, status.stage], [true, false, 'interrupted', '被中断', 'shots']);
  assert.deepEqual(stageStatus(status), { transcribe: 'done', shots: 'interrupted', subjects: 'pending', compose: 'pending', prerender: 'pending' });
  assert.match(status.error, /在「镜头识别」阶段被中断了/);
  assert.match(status.error, /后面的阶段\(主体识别、生成字幕与卡片、发布预渲染任务\)没有做/);
  assert.match(status.hint, /已经做完的阶段/);
  const job = await f.call('background_job_status', { jobId: first.jobId });
  assert.deepEqual([job.kind, job.state, job.stage, job.done, job.ok], ['workflow.auto', 'interrupted', 'shots', true, false]);

  const again = await f.call('auto_workflow', { mediaId: 'm1' }, f.context, { requestId: 'tool-call-after' });
  const finished = again.running ? await f.settle(again.jobId) : again;
  assert.equal(finished.ok ?? true, true);
  assert.equal(finished.result?.transcribed ?? finished.transcribed, false, 'the transcript from before the restart is reused');
  assert.equal(f.state.commits.filter((c) => c.what === 'transcript').length, 1, 'transcribed once, not again after the restart');
  assert.equal(f.perception.stt.ctl.calls.length, 0, 'the new provider was never asked to transcribe');
  assert.equal(f.state.cards.length, 4);
});

test('a process that died while a flow was running: the reopened ledger says interrupted and the persisted stages say where', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  // 造一个「上一个进程留下」的现场:账本里跑到 subjects,索引里 transcribe、shots 做完、subjects 在跑
  const side = f.foreignJobs();
  const started = await side.start(f.context, 'workflow.auto', 'a'.repeat(64), 'dead-process-0001');
  await side.update(f.context, started.jobId, 0, { state: 'running', stage: 'subjects', progress: 0.6 });
  await side.close();
  fs.mkdirSync(f.ws.dir() + '/workflow', { recursive: true });
  fs.writeFileSync(f.ws.dir() + '/workflow/jobs.json', JSON.stringify([{ jobId: started.jobId, mediaId: 'm1', status: 'running', stages: {
    transcribe: { status: 'done' }, shots: { status: 'done' }, subjects: { status: 'running', childJobId: 'job_00000000-0000-0000-0000-000000000000' },
    compose: { status: 'pending' }, prerender: { status: 'pending' } } }]));
  await f.restart();
  const status = await f.call('auto_workflow_status', { jobId: started.jobId });
  assert.deepEqual([status.state, status.stage, status.phase], ['interrupted', 'subjects', '被中断']);
  assert.deepEqual(stageStatus(status), { transcribe: 'done', shots: 'done', subjects: 'interrupted', compose: 'pending', prerender: 'pending' });
  const job = await f.call('background_job_status', { jobId: started.jobId });
  assert.equal(job.errorCode, 'INTERRUPTED_ON_RESTART');
  assert.match(job.error, /重启时这个作业正在跑/);
});

/* ===================================================================== background_job_status */

test('background_job_status: every kind of package job is visible by job id, with the package words for failures', async (t) => {
  const f = await makeP5Fixture(t, { errorTexts: { 'track.': { TRACK_TIMEOUT: '这次追踪超过了时限,已被停掉。' } } });
  await f.addMedia({ id: 'm1' });
  f.perception.stt.ctl.failCode = 'FFMPEG_MISSING';
  f.perception.shots.ctl.failCode = 'SHOTS_TIMEOUT';
  f.perception.shots.ctl.failMessage = '镜头识别超时(超过 4 秒),已强制结束。素材可能太长。';
  const stt = await f.perception.stt.call('transcribe_media', { mediaId: 'm1' }, f.context, { requestId: 'a-request-0001' });
  const shots = await f.perception.shots.call('detect_shots', { mediaId: 'm1' }, f.context, { requestId: 'a-request-0002' });
  f.perception.subject.ctl.hold = true;
  const subject = await f.perception.subject.call('detect_subjects', { mediaId: 'm1' }, f.context, { requestId: 'a-request-0003' });
  const side = f.foreignJobs();
  const track = await side.start(f.context, 'track.points', 'b'.repeat(64), 'a-request-0004');
  await side.update(f.context, track.jobId, 0, { state: 'running', stage: 'track', progress: 0.3 });
  await side.update(f.context, track.jobId, 1, { state: 'error', errorCode: 'TRACK_TIMEOUT' });
  const install = await side.start(f.context, 'subject.install', 'c'.repeat(64), 'a-request-0005');
  await side.update(f.context, install.jobId, 0, { state: 'running', stage: 'install', progress: 0.5 });
  await side.close();
  await until(() => rawJobs(f).filter((r) => ['error'].includes(r.state)).length >= 3, { what: 'failures' });

  const s = await f.call('background_job_status', { jobId: stt.jobId });
  assert.deepEqual([s.kind, s.label, s.done, s.ok, s.state, s.errorCode], ['stt.transcribe', '语音转写', true, false, 'error', 'FFMPEG_MISSING']);
  assert.equal(s.error, STT_ERROR_TEXT.FFMPEG_MISSING);
  const h = await f.call('background_job_status', { jobId: shots.jobId });
  assert.deepEqual([h.kind, h.label, h.error], ['shots.detect', '镜头识别', '镜头识别超时(超过 4 秒),已强制结束。素材可能太长。']);
  const u = await f.call('background_job_status', { jobId: subject.jobId });
  assert.deepEqual([u.kind, u.done, u.ok, u.state], ['subject.detect', false, false, 'running']);
  assert.equal(u.error, undefined);
  assert.ok(u.progress > 0 && u.progress < 1);
  const k = await f.call('background_job_status', { jobId: track.jobId });
  assert.deepEqual([k.kind, k.label, k.error], ['track.points', '运动追踪', '这次追踪超过了时限,已被停掉。']);
  const i = await f.call('background_job_status', { jobId: install.jobId });
  assert.deepEqual([i.kind, i.label, i.done, i.state, i.stage], ['subject.install', '主体识别拓展安装', false, 'running', 'install']);
  f.perception.subject.release();
  await until(async () => (await f.call('background_job_status', { jobId: subject.jobId })).done, { what: 'subject done' });
  const done = await f.call('background_job_status', { jobId: subject.jobId });
  assert.deepEqual([done.done, done.ok, done.state, done.progress], [true, true, 'done', 1]);
  assert.deepEqual(done.outputRefs, [{ kind: 'subject', id: 'm1' }]);
});

test('background_job_status: an unknown error code still says something, and a queued job left by an earlier process is "interrupted"', async (t) => {
  let clock = 1_000_000;
  const f = await makeP5Fixture(t, { now: () => clock });
  const side = f.foreignJobs();
  const odd = await side.start(f.context, 'track.points', 'd'.repeat(64), 'a-request-0001');
  await side.update(f.context, odd.jobId, 0, { state: 'error', errorCode: 'WEIRD_CODE' });
  const stale = await side.start(f.context, 'stt.transcribe', 'e'.repeat(64), 'a-request-0002');       // 还在排队,进程就没了
  await side.close();
  const o = await f.call('background_job_status', { jobId: odd.jobId });
  assert.match(o.error, /WEIRD_CODE/);
  assert.equal((await f.call('background_job_status', { jobId: stale.jobId })).state, 'queued', 'same process: still queued');
  clock += 60_000;
  await f.restart();                                                                                        // 新进程起来了:排队的那个没人在做
  const r = await f.call('background_job_status', { jobId: stale.jobId });
  assert.deepEqual([r.state, r.done, r.ok, r.errorCode], ['interrupted', true, false, 'INTERRUPTED_ON_RESTART']);
  assert.match(r.error, /重启时这个作业正在跑/);
});

test('background_job_status / auto_workflow_status: another project\'s job, another conversation\'s job, a made-up job and a malformed id all get the same answer', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  const mine = await f.call('auto_workflow', { mediaId: 'm1' });
  const side = f.foreignJobs();
  const otherContext = (patch) => ({ ...f.context, ...patch });
  const foreignProject = await side.start(otherContext({ projectId: 'sp_other' }), 'workflow.auto', 'f'.repeat(64), 'foreign-0001');
  const foreignConversation = await side.start(otherContext({ conversationId: 'conversation_other' }), 'workflow.auto', 'f'.repeat(64), 'foreign-0002');
  await side.close();
  const answers = [];
  for (const jobId of [foreignProject.jobId, foreignConversation.jobId, 'job_00000000-0000-4000-8000-000000000000', 'nonsense', '', 12, null]) {
    for (const tool of ['background_job_status', 'auto_workflow_status']) {
      const error = await msg(f.call(tool, { jobId }));
      assert.equal(error?.code, 'job-not-found', `${tool} ${String(jobId)}`);
      answers.push(error.message);
    }
  }
  assert.equal(new Set(answers).size, 1, 'one single message for all of them');
  // 本对话本项目的一键流程作业号,用 background_job_status 看得见,用 auto_workflow_status 看得见;别种作业用 auto_workflow_status 看不见
  assert.equal((await f.call('background_job_status', { jobId: mine.jobId })).kind, 'workflow.auto');
  const stt = await f.perception.stt.call('transcribe_media', { mediaId: 'm1' }, f.context, { requestId: 'a-request-0001' });
  assert.equal((await msg(f.call('auto_workflow_status', { jobId: stt.jobId }))).code, 'job-not-found');
  assert.equal((await f.call('background_job_status', { jobId: stt.jobId })).kind, 'stt.transcribe');
  // 多余的参数不收
  assert.equal((await msg(f.call('background_job_status', { jobId: mine.jobId, projectId: 'sp_other' }))).code, 'bad-args');
});

/* ===================================================================== 授权 */

test('a read-only member can look at job status but cannot start the flow (and nothing is started)', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  const done = await f.call('auto_workflow', { mediaId: 'm1' });
  f.setReadOnly(true);
  const denied = await msg(f.call('auto_workflow', { mediaId: 'm1' }, f.context, { requestId: 'tool-call-ro' }));
  assert.deepEqual([denied.code, denied.status], ['workflow-forbidden', 403]);
  assert.match(denied.message, /没有改项目的权限/);
  assert.equal(rawJobs(f).filter((r) => r.kind === 'workflow.auto').length, 1);
  assert.equal((await f.call('auto_workflow_status', { jobId: done.jobId })).ok, true);
  assert.equal((await f.call('background_job_status', { jobId: done.jobId })).kind, 'workflow.auto');
  assert.equal((await msg(f.workflow.cancel(f.context, done.jobId)))?.status, 403);
});

test('a forged or incomplete context is refused by every tool, before anything happens', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  const forged = [
    { ...f.context, runId: 'run-forged' },
    { ...f.context, projectId: 'sp_other' },
    { ...f.context, senderAccountId: 'someone-else' },
    Object.fromEntries(Object.entries(f.context).filter(([k]) => k !== 'messageId')),
    { ...f.context, extra: 1 },
    null, 'context', undefined,
  ];
  for (const context of forged) {
    for (const [tool, args] of [['auto_workflow', { mediaId: 'm1' }], ['auto_workflow_status', { jobId: 'job_00000000-0000-4000-8000-000000000000' }], ['background_job_status', { jobId: 'job_00000000-0000-4000-8000-000000000000' }]]) {
      const error = await msg(f.workflow.call(tool, args, context));
      assert.equal(error?.status, 403, `${tool} ${JSON.stringify(context)?.slice(0, 40)}`);
    }
  }
  assert.equal(rawJobs(f).length, 0);
  assert.equal(f.perception.stt.ctl.calls.length, 0);
});

test('the document service cannot be reached: 503, nothing started; when it comes back, the tools work again', async (t) => {
  const f = await makeP5Fixture(t);
  await f.addMedia({ id: 'm1' });
  f.setUnavailable(true);
  for (const [tool, args] of [['auto_workflow', { mediaId: 'm1' }], ['auto_workflow_status', { jobId: 'job_00000000-0000-4000-8000-000000000000' }], ['background_job_status', { jobId: 'job_00000000-0000-4000-8000-000000000000' }]]) {
    const error = await msg(f.call(tool, args));
    assert.deepEqual([error?.code, error?.status], ['authority-unavailable', 503], tool);
  }
  assert.equal(rawJobs(f).length, 0);
  f.setUnavailable(false);
  assert.equal((await f.call('auto_workflow', { mediaId: 'm1' })).running, false);
});

test('a media id from another project is not found, and does not tell whether it exists there', async (t) => {
  const f = await makeP5Fixture(t, { extraProjects: ['sp_other'] });
  await f.addMedia({ id: 'theirs', forProject: 'sp_other' });
  const error = await msg(f.call('auto_workflow', { mediaId: 'theirs' }));
  assert.equal(error.code, 'media-not-found');
  assert.equal((await msg(f.call('auto_workflow', { mediaId: 'never-existed' }))).message, error.message);
  assert.equal(rawJobs(f).length, 0);
});

test('every workflow error code that reaches the model has words, and the stage/phase names are the documented ones', () => {
  for (const code of ['FENCE_CANCELLED', 'INTERRUPTED_ON_RESTART', 'SERVICE_CLOSING', 'STAGE_UNAVAILABLE', 'STAGE_FAILED', 'STAGE_TIMEOUT', 'PROJECT_CHANGED', 'COMMIT_FAILED', 'PUBLISH_FAILED', 'EMPTY_TRANSCRIPT']) {
    assert.ok(WORKFLOW_ERROR_TEXT[code].length > 5, code);
  }
  assert.deepEqual([...WORKFLOW_STAGES], ['transcribe', 'shots', 'subjects', 'compose', 'prerender']);
});
