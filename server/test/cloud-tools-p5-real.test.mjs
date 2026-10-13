// P5 真实验证:一条真短片(Windows 自带的中文合成语音 + 三个硬切的场景,其中一个是人像照片)走完整条一键流程——
// 真 Python + faster-whisper small 转写、真 ffmpeg scdet 镜头识别、真 onnxruntime light 档主体识别、再生成字幕与卡片、提交到(替身)项目、发布预渲染任务(替身接缝)。
// 运行授权、作业账本、素材库、进程登记、工作区都是真的。依赖不全时整文件跳过并说明缺什么;要强制跑(缺依赖就失败)用 node scripts/probes/cloud-tools-p5-workflow-probe.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { makeP5Fixture, until, sleep } from './cloud-tools-p5-fixture.mjs';
import { realChainMissing, ensureChineseClip, makeRealProviders, liveProcesses, PLAIN_PYTHON } from './cloud-tools-p5-real-lib.mjs';

const missing = realChainMissing();
const verbose = process.env.P5_VERBOSE === '1';
const log = (...args) => { if (verbose) console.log('[p5]', ...args); };
const stageStatus = (status) => Object.fromEntries(status.stages.map((s) => [s.stage, s.status]));
const rawJobs = (f) => {
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try { return db.prepare('SELECT job_id, kind, state, stage, progress, error_code FROM tool_jobs ORDER BY created_at').all(); } finally { db.close(); }
};

async function realFixture(t, options = {}) {
  const clip = ensureChineseClip();
  const make = await makeRealProviders(options.providers ?? {});
  const f = await makeP5Fixture(t, { providers: 'real', realProviders: make, workflowLimits: { fastWaitMs: 2_000, pollMs: 250, progressMs: 500, ...options.workflowLimits } });
  await f.addMedia({ id: 'clip', name: 'zh-clip.mp4', kind: 'video', bytes: fs.readFileSync(clip.video), extra: { duration: clip.duration } });
  return { f, clip };
}

test('real short clip: speech → shots → subjects → captions and cards in the project → prerender publish, every stage reported', { skip: missing ?? false, timeout: 600_000 }, async (t) => {
  const before = liveProcesses();
  const { f, clip } = await realFixture(t);
  log('clip', JSON.stringify({ duration: clip.duration, cuts: clip.cuts }));
  const started = await f.call('auto_workflow', { mediaId: 'clip', maxCards: 12 }, f.context, { requestId: 'real-call-0001' });
  assert.equal(started.running, true, 'a real transcription takes longer than the quick-answer wait');
  assert.match(started.jobId, /^job_/);
  // 过程中状态说得清做到哪一阶段
  const seen = new Set();
  const final = await until(async () => {
    const s = await f.call('auto_workflow_status', { jobId: started.jobId });
    seen.add(`${s.stage}:${s.phase}`);
    return s.done ? s : null;
  }, { ms: 540_000, step: 400, what: 'real workflow to finish' });
  log('phases seen', [...seen].join(' | '));
  log('final', JSON.stringify({ ok: final.ok, state: final.state, error: final.error, stages: stageStatus(final) }));
  assert.equal(final.ok, true, final.error ?? '');
  assert.deepEqual(stageStatus(final), { transcribe: 'done', shots: 'done', subjects: 'done', compose: 'done', prerender: 'done' });
  assert.ok([...seen].some((x) => x.startsWith('transcribe')), 'the transcription stage was observable while running');

  // 文字稿:真转写出来的中文,有时间戳
  const media = await f.project.getMedia(f.context, 'clip');
  const text = media.transcript.segments.map((s) => s.text).join('');
  log('transcript', text);
  assert.ok(media.transcript.segments.length >= 1);
  assert.match(text, /用户|增长|留存|软件|素材/, `got: ${text}`);
  // 镜头:ffmpeg scdet 在已知切点上
  assert.equal(media.shots.engine, 'scdet');
  const starts = media.shots.shots.map((s) => s.start);
  log('shots', JSON.stringify(media.shots.shots.map((s) => [s.start, s.end])));
  assert.equal(media.shots.shots.length, 3);
  for (const [i, cut] of clip.cuts.entries()) assert.ok(Math.abs(starts[i + 1] - cut) <= 0.12, `cut ${i + 1}: ${starts[i + 1]} vs ${cut}`);
  // 主体:light 档在人像镜头里找到 person
  assert.equal(media.subjects.engine, 'light');
  const labels = media.subjects.samples.flatMap((s) => s.boxes.map((b) => b.label));
  log('subject labels', [...new Set(labels)].join(','), 'samples', media.subjects.samples.length);
  assert.ok(labels.includes('person'), 'a person was found in the portrait scene');

  // 项目里真的多了字幕和卡片:一次提交,字幕一张,卡片都来自文字稿的关键词
  const captions = f.state.cards.filter((c) => c.cardId === 'caption-track');
  const cards = f.state.cards.filter((c) => c.cardId !== 'caption-track');
  log('cards', JSON.stringify(cards.map((c) => [c.cardId, c.start.toFixed(2), c.end.toFixed(2)])), 'caption lines', captions[0]?.params.lines.split('\n').length);
  assert.equal(captions.length, 1);
  assert.ok(captions[0].params.lines.split('\n').length >= 1);
  assert.ok(cards.length >= 1, `at least one card was picked from: ${text}`);
  assert.equal(f.state.commits.filter((c) => c.what === 'edits').length, 1);
  assert.deepEqual(f.state.commits.map((c) => c.what), ['transcript', 'shots', 'subjects', 'edits'], 'commits happened in stage order');
  assert.equal(f.state.published.length, 1);
  assert.deepEqual(new Set(f.state.published[0].clipIds), new Set(f.state.cards.map((c) => c.clipId)));
  assert.equal(final.result.clips.length, cards.length);
  assert.equal(final.result.captionClipId, captions[0].clipId);
  // 账本:一键流程和三个真作业都 done
  const rows = rawJobs(f);
  assert.deepEqual(rows.map((r) => `${r.kind}:${r.state}`).sort(), ['shots.detect:done', 'stt.transcribe:done', 'subject.detect:done', 'workflow.auto:done']);
  // background_job_status 能按作业号查每一种真作业
  for (const row of rows) {
    const s = await f.call('background_job_status', { jobId: row.job_id });
    assert.deepEqual([s.kind, s.done, s.ok, s.progress], [row.kind, true, true, 1]);
  }
  await f.workflow.close('end');
  for (const p of Object.values(f.perception)) await p.close('end');
  assert.equal(liveProcesses(), before, 'no stray Python or ffmpeg left');
});

test('real chain, a dependency not ready: subjects cannot run (no onnxruntime in this Python) → the flow stops there, shots stay done, the project gets nothing', { skip: missing ?? false, timeout: 600_000 }, async (t) => {
  const { f } = await realFixture(t, { providers: { subjectPython: PLAIN_PYTHON } });
  const answer = await f.call('auto_workflow', { mediaId: 'clip' }, f.context, { requestId: 'real-call-0002' });
  const final = answer.running ? await until(async () => { const s = await f.call('auto_workflow_status', { jobId: answer.jobId }); return s.done ? s : null; }, { ms: 540_000, step: 400, what: 'flow to stop' }) : answer;
  log('stopped', final.error);
  assert.equal(final.ok, false);
  assert.deepEqual(stageStatus(final), { transcribe: 'done', shots: 'done', subjects: 'unavailable', compose: 'pending', prerender: 'pending' });
  assert.match(final.error, /主体识别/);
  assert.match(final.error, /没有兜底档|用不了|引擎/);
  assert.match(final.error, /后面的阶段\(生成字幕与卡片、发布预渲染任务\)没有做/);
  assert.equal(f.state.cards.length, 0);
  assert.equal(f.state.editAttempts, 0);
  assert.ok(!rawJobs(f).some((r) => r.kind === 'subject.detect'), 'no placeholder job for the stage that cannot run');
  assert.equal(rawJobs(f).find((r) => r.kind === 'workflow.auto').state, 'error');
  assert.equal(f.state.published.length, 0);
});

test('real chain, stopped mid-transcription (host path): the Python process is really gone, the flow never moves on, nothing is committed', { skip: missing ?? false, timeout: 600_000 }, async (t) => {
  const before = liveProcesses();
  const { f } = await realFixture(t);
  const answer = await f.call('auto_workflow', { mediaId: 'clip' }, f.context, { requestId: 'real-call-0003' });
  await until(async () => (await f.call('auto_workflow_status', { jobId: answer.jobId })).stage === 'transcribe' && liveProcesses() > before, { ms: 120_000, step: 100, what: 'transcription process up' });
  assert.ok(liveProcesses() > before, 'the Python process was running');
  const fence = (await f.resources.authorize(f.context, 'read')).fenceRevision;
  await f.authority.privateFence();
  const receipt = await f.resources.abortForFence(f.context, 'private');
  log('receipt', JSON.stringify(receipt));
  assert.equal(receipt.streamsOpen, 0);                       // 一键流程自己的运行资源已释放;Python 进程树要几百毫秒才退净,下面按进程数等
  f.cancel.window = true; f.cancel.fence = fence;
  await f.jobs.cancelForFence(f.context, fence);
  f.cancel.window = false;
  await until(() => liveProcesses() === before, { ms: 30_000, what: 'processes gone' });
  await sleep(1_000);
  const rows = rawJobs(f);
  log('rows', JSON.stringify(rows.map((r) => `${r.kind}:${r.state}`)));
  assert.equal(rows.find((r) => r.kind === 'workflow.auto').state, 'cancelled');
  assert.ok(!rows.some((r) => r.kind === 'shots.detect' || r.kind === 'subject.detect'), 'never moved on to the next stage');
  assert.equal(f.state.cards.length, 0);
  assert.equal(f.state.commits.length, 0, 'nothing committed at all');
});

test('real chain, the service shuts down mid-run, then comes back: "interrupted" at the right stage; a new call finishes the job', { skip: missing ?? false, timeout: 900_000 }, async (t) => {
  const before = liveProcesses();
  const { f } = await realFixture(t);
  const answer = await f.call('auto_workflow', { mediaId: 'clip' }, f.context, { requestId: 'real-call-0004' });
  await until(async () => (await f.call('auto_workflow_status', { jobId: answer.jobId })).stage === 'transcribe' && liveProcesses() > before, { ms: 120_000, step: 100, what: 'transcription process up' });
  // 宿主关闭顺序:先一键流程,再各感知包
  const receipt = await f.workflow.close('shutdown');
  assert.equal(receipt.workPending, 0);
  for (const p of Object.values(f.perception)) assert.equal((await p.close('shutdown')).childrenClosed, true);
  assert.equal(liveProcesses(), before, 'processes gone after close');
  await f.restart();
  const status = await f.call('auto_workflow_status', { jobId: answer.jobId });
  log('after restart', JSON.stringify({ state: status.state, stage: status.stage, stages: stageStatus(status), error: status.error }));
  assert.deepEqual([status.done, status.ok, status.state, status.stage], [true, false, 'interrupted', 'transcribe']);
  assert.equal(stageStatus(status).transcribe, 'interrupted');
  assert.match(status.error, /在「语音转写」阶段被中断了/);
  assert.equal(f.state.commits.length, 0);
  // 重新发起:接着做(这里没有做完的阶段可复用,从头来)
  const again = await f.call('auto_workflow', { mediaId: 'clip' }, f.context, { requestId: 'real-call-0005' });
  const final = await until(async () => { const s = await f.call('auto_workflow_status', { jobId: again.jobId }); return s.done ? s : null; }, { ms: 600_000, step: 400, what: 'second run to finish' });
  assert.equal(final.ok, true, final.error ?? '');
  assert.ok(f.state.cards.length >= 2);
  assert.deepEqual(f.state.commits.map((c) => c.what), ['transcript', 'shots', 'subjects', 'edits']);
  await f.workflow.close('end');
  for (const p of Object.values(f.perception)) await p.close('end');
  assert.equal(liveProcesses(), before);
});
