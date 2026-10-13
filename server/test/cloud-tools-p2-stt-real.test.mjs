// P2(云端语音转写)真实验证:真 Python + 真 faster-whisper(small 权重)+ 真 ffmpeg + 真语音素材,
// 走完整条链:项目素材库 → 工作区 → 离线子进程 → 文字稿 → 提交到(假的)项目。运行授权、作业表、素材库、进程登记都是真的。
// 依赖不全时整文件跳过并说明缺什么;要强制跑(缺依赖就失败)用 node scripts/probes/cloud-tools-p2-stt-probe.mjs。
// 依赖和素材准备见 server/test/cloud-tools-p2-real-lib.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { p2Fixture, until, alive } from './cloud-tools-p2-fixture.mjs';
import { PATHS, findPython, realDepsMissing, ensureMedia } from './cloud-tools-p2-real-lib.mjs';

const missing = realDepsMissing();
const verbose = process.env.P2_VERBOSE === '1';
const log = (...args) => { if (verbose) console.log('[p2]', ...args); };

async function realFixture(t, limits = {}, runtime = {}) {
  const f = await p2Fixture(t, {
    realPython: true,
    runtime: { pythonPath: findPython(), sourceRoot: PATHS.sourceRoot, pylibs: PATHS.pylibs, modelsDir: PATHS.models, requirements: {}, ...runtime },
    limits: { engines: ['faster-whisper', 'whisper'], progressMs: 300, transcribeMs: 5 * 60_000, ...limits },
  });
  return f;
}
const rawJob = (f, jobId) => {
  const db = new DatabaseSync(f.jobsPath, { readOnly: true });
  try { return db.prepare('SELECT state, stage, progress, error_code, output_refs FROM tool_jobs WHERE job_id=?').get(jobId); } finally { db.close(); }
};
const waitJob = (f, jobId, state) => until(() => rawJob(f, jobId)?.state === state, { ms: 180_000, step: 200, what: `job ${state}` });
const textOf = (f, id) => f.doc.media.get(id).transcript.segments.map((s) => s.text).join(' ');

test('real speech: Chinese wav and an English video transcribe through the whole chain', { skip: missing ?? false, timeout: 300_000 }, async (t) => {
  const media = ensureMedia();
  const f = await realFixture(t);
  await f.addMedia('zh', fs.readFileSync(media.chinese), { kind: 'audio', ext: 'wav' });
  await f.addMedia('en-video', fs.readFileSync(media.video), { kind: 'video', ext: 'mp4' });

  const status = await f.tools.call('stt_status', {}, f.context);
  log('stt_status', JSON.stringify(status));
  assert.equal(status.ok, true);
  assert.equal(status.engines['faster-whisper'].installed, true);
  assert.equal(status.engines.whisper.installed, false);
  assert.deepEqual(status.engines['faster-whisper'].availableModels, ['small']);
  assert.equal(status.ffmpeg, true);
  assert.ok(!JSON.stringify(status).includes(PATHS.out) && !JSON.stringify(status).includes('python.exe'), 'no disk path in the answer');

  const zh = await f.tools.call('transcribe_media', { mediaId: 'zh', language: 'zh' }, f.context);
  await waitJob(f, zh.jobId, 'done');
  const zhTranscript = f.doc.media.get('zh').transcript;
  log('zh transcript', JSON.stringify(zhTranscript));
  assert.ok(textOf(f, 'zh').includes('找不到素材'), `got: ${textOf(f, 'zh')}`);
  assert.ok(zhTranscript.segments.length >= 1);
  for (const s of zhTranscript.segments) assert.ok(s.start >= 0 && s.end >= s.start && s.end <= 1.6, JSON.stringify(s));

  const en = await f.tools.call('transcribe_media', { mediaId: 'en-video' }, f.context);   // 不给语言:自动检测
  await waitJob(f, en.jobId, 'done');
  const enTranscript = f.doc.media.get('en-video').transcript;
  log('en transcript', JSON.stringify(enTranscript));
  assert.match(textOf(f, 'en-video'), /quick\s+brown\s+fox/i, `got: ${textOf(f, 'en-video')}`);
  assert.equal(enTranscript.language, 'en');
  assert.ok(enTranscript.segments.every((s) => s.end <= 10.6 && s.start >= 0));
  assert.deepEqual(JSON.parse(rawJob(f, en.jobId).output_refs), [{ kind: 'transcript', id: 'en-video' }]);
  assert.deepEqual(f.wsFiles(), [], 'fetched copies are removed');
  await f.tools.close('test');
  assert.ok(f.calls.realChildren.every((c) => c.exitCode !== null || c.signalCode !== null), 'every child exited');
});

test('real environment answers: weights missing, engine missing, no audio track, image', { skip: missing ?? false, timeout: 120_000 }, async (t) => {
  const media = ensureMedia();
  const f = await realFixture(t);
  await f.addMedia('zh', fs.readFileSync(media.chinese), { kind: 'audio', ext: 'wav' });
  await f.addMedia('silent', fs.readFileSync(media.silentVideo), { kind: 'video', ext: 'mp4' });
  const noModel = await f.tools.call('transcribe_media', { mediaId: 'zh', model: 'medium' }, f.context);
  log('medium', JSON.stringify(noModel));
  assert.equal(noModel.code, 'MODEL_NOT_INSTALLED');
  assert.deepEqual(noModel.availableModels, ['small']);
  const noEngine = await f.tools.call('transcribe_media', { mediaId: 'zh', engine: 'whisper' }, f.context);
  log('whisper', JSON.stringify(noEngine));
  assert.equal(noEngine.code, 'ENGINE_NOT_INSTALLED');
  assert.equal(noEngine.canInstall, false);
  const install = await f.tools.call('stt_install', { engine: 'whisper' }, f.context);
  log('install whisper', JSON.stringify(install));
  assert.equal(install.code, 'INSTALL_NOT_ENABLED');
  const none = await f.tools.call('transcribe_media', { mediaId: 'silent', language: 'en' }, f.context);
  await waitJob(f, none.jobId, 'error');
  log('silent video job', JSON.stringify(rawJob(f, none.jobId)));
  assert.equal(rawJob(f, none.jobId).error_code, 'NO_AUDIO');
  assert.equal(f.doc.commits.length, 0);
  assert.equal(f.calls.openRead, 1, 'bytes were requested only for the file that could be tried');
});

test('real cancel: a fence while the engine is decoding really ends the child, the job is cancelled, nothing is written', { skip: missing ?? false, timeout: 300_000 }, async (t) => {
  const media = ensureMedia();
  const f = await realFixture(t);
  await f.addMedia('long', fs.readFileSync(media.long), { kind: 'audio', ext: 'wav' });
  const started = await f.tools.call('transcribe_media', { mediaId: 'long', language: 'en' }, f.context);
  await until(() => rawJob(f, started.jobId).progress > 0.15, { ms: 180_000, step: 100, what: 'decoding under way' });
  const python = f.calls.realChildren.filter((c) => c.spawnargs.includes('transcribe')).at(-1);
  log('cancelling while decoding; python pid', python.pid, 'progress', rawJob(f, started.jobId).progress);
  const fence = (await f.resources.authorize(f.context, 'read')).fenceRevision;
  f.authority.privateFence();
  f.cancel.fence = fence; f.cancel.window = true;
  const t0 = Date.now();
  await f.resources.abortForFence(f.context, 'private');
  await f.currentJobs.cancelForFence(f.context, fence);
  await until(() => !alive(python.pid), { ms: 20_000, what: 'python exit' });
  log('child gone after', Date.now() - t0, 'ms');
  const closed = await f.tools.close('fence');
  assert.deepEqual(closed, { childrenClosed: true, streamsClosed: true, workPending: 0 });
  assert.equal(rawJob(f, started.jobId).state, 'cancelled');
  assert.equal(f.doc.commits.length, 0);
  assert.equal(f.doc.media.get('long').transcript, null);
  assert.deepEqual(f.wsFiles(), []);
});

test('real timeout: the engine is stopped at the limit and the job ends as TIMEOUT', { skip: missing ?? false, timeout: 300_000 }, async (t) => {
  const media = ensureMedia();
  const f = await realFixture(t, { transcribeMs: 4_000 });
  await f.addMedia('long', fs.readFileSync(media.long), { kind: 'audio', ext: 'wav' });
  const started = await f.tools.call('transcribe_media', { mediaId: 'long', language: 'en' }, f.context);
  await waitJob(f, started.jobId, 'error');
  const python = f.calls.realChildren.filter((c) => c.spawnargs.includes('transcribe')).at(-1);
  log('timeout job', JSON.stringify(rawJob(f, started.jobId)), 'python pid', python.pid);
  assert.equal(rawJob(f, started.jobId).error_code, 'TIMEOUT');
  await until(() => !alive(python.pid), { ms: 20_000, what: 'python exit' });
  assert.equal(f.doc.commits.length, 0);
});

test('real install job: pip runs with the node-configured locked requirements file, not with anything from the model', { skip: process.env.P2_PIP !== '1' ? 'set P2_PIP=1 (needs network and pip)' : (missing ?? false), timeout: 300_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-p2-pip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, 'tiny-lock.txt');
  fs.writeFileSync(lock, 'idna==3.10\n');                    // 一个很小的纯 Python 包,只为证明 pip 真的按锁定文件装
  const libs = path.join(dir, 'libs');
  const f = await realFixture(t, {}, { pylibs: libs, requirements: { 'faster-whisper': lock } });
  const status = await f.tools.call('stt_status', {}, f.context);
  assert.equal(status.engines['faster-whisper'].installed, false, 'an empty library directory has no engine');
  assert.equal(status.engines['faster-whisper'].installableHere, true);
  await assert.rejects(f.tools.call('stt_install', { engine: 'faster-whisper', requirements: 'C:/evil.txt' }, f.context), { code: 'bad-args' });
  const started = await f.tools.call('stt_install', { engine: 'faster-whisper' }, f.context);
  assert.equal(started.started, true);
  await waitJob(f, started.jobId, 'done');
  log('install job', JSON.stringify(rawJob(f, started.jobId)));
  assert.ok(fs.existsSync(path.join(libs, 'idna')), 'the locked package landed in the node library directory');
  await f.tools.close('test');
  assert.ok(f.calls.realChildren.every((c) => c.exitCode !== null || c.signalCode !== null));
});
