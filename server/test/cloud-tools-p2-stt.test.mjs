// P2(云端语音转写)单测:用假 Python 脚本把行为定死,其余(运行授权、作业表、素材库、工作区、进程树)都是真的。
// 真 Python + 真 faster-whisper + 真语音素材的验证见 cloud-tools-p2-stt-real.test.mjs 与 scripts/probes/cloud-tools-p2-stt-probe.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { p2Fixture, projectId, sha256, until, alive } from './cloud-tools-p2-fixture.mjs';
import { createSttTools, SttToolError, STT_ERROR_TEXT } from '../agent/service/perception/stt.mjs';

const bytes = (n = 5000) => crypto.randomBytes(n);
const rawJob = (f, jobId) => {
  const db = new DatabaseSync(f.jobsPath, { readOnly: true });
  try { return db.prepare('SELECT state, stage, progress, error_code, output_refs, revision, fence_revision FROM tool_jobs WHERE job_id=?').get(jobId); } finally { db.close(); }
};
const jobCount = (f) => {
  const db = new DatabaseSync(f.jobsPath, { readOnly: true });
  try { return db.prepare('SELECT count(*) AS n FROM tool_jobs').get().n; } finally { db.close(); }
};
const finished = (f, jobId, state = 'done') => until(() => rawJob(f, jobId)?.state === state, { what: `job ${jobId} ${state}` });
const transcribe = (f, args, context = f.context) => f.tools.call('transcribe_media', args, context);

test('factory refuses to start without its dependencies', () => {
  assert.throws(() => createSttTools({}), (e) => e instanceof SttToolError && e.code === 'stt-unconfigured' && e.status === 503);
});

test('unknown tool names and extra or unsafe arguments are refused; no child is started', async (t) => {
  const f = await p2Fixture(t);
  await assert.rejects(f.tools.call('transcribe_all', {}, f.context), { code: 'unknown-tool' });
  await assert.rejects(f.tools.call('stt_status', { engine: 'x' }, f.context), { code: 'bad-args' });
  await assert.rejects(f.tools.call('stt_install', { engine: 'faster-whisper', indexUrl: 'https://evil.example/simple' }, f.context), { code: 'bad-args' });
  await assert.rejects(f.tools.call('stt_install', { engine: 'faster-whisper', args: ['--upgrade'] }, f.context), { code: 'bad-args' });
  await assert.rejects(f.tools.call('stt_install', { engine: 'faster-whisper; rm -rf /' }, f.context), { code: 'bad-args' });
  await assert.rejects(f.tools.call('stt_install', { engine: 'torch' }, f.context), { code: 'bad-args' });
  await assert.rejects(transcribe(f, { mediaId: 'm', path: 'C:/secret/a.wav' }), { code: 'bad-args' });
  await assert.rejects(transcribe(f, { mediaId: '../../etc/passwd' }), { code: 'bad-args' });
  await assert.rejects(transcribe(f, { mediaId: 'media-a', model: 'huge-v9' }), { code: 'bad-args' });
  await assert.rejects(transcribe(f, { mediaId: 'media-a', language: 'zh; rm' }), { code: 'bad-args' });
  assert.equal(f.calls.spawns.length, 0);
});

test('forged context is rejected before anything runs', async (t) => {
  const f = await p2Fixture(t);
  await assert.rejects(f.tools.call('stt_status', {}, { ...f.context, runId: 'forged' }), { code: 'tool-context-untrusted' });
  await assert.rejects(transcribe(f, { mediaId: 'media-a' }, { ...f.context, senderAccountId: 'other' }), { code: 'tool-context-untrusted' });
  assert.equal(f.calls.spawns.length, 0);
});

test('stt_status reports environment without disk paths; a read-only member may ask; child env is rebuilt', async (t) => {
  process.env.AGENT_DELEGATION_TOKEN_TEST = 'must-not-leak';
  t.after(() => { delete process.env.AGENT_DELEGATION_TOKEN_TEST; });
  const f = await p2Fixture(t);
  f.flags.readOnly = true;
  const status = await f.tools.call('stt_status', {}, f.context);
  assert.equal(status.ok, true);
  assert.equal(status.engines['faster-whisper'].installed, true);
  assert.equal(status.engines['faster-whisper'].version, '1.2.1');
  assert.deepEqual(status.engines['faster-whisper'].availableModels, ['small']);
  assert.equal(status.engines['faster-whisper'].allowed, true);
  assert.equal(status.engines.whisper.allowed, false);
  assert.equal(status.ffmpeg, true);
  assert.equal(status.installRunning, false);
  assert.ok(!JSON.stringify(status).includes('secret'), 'no executable, pylibs, models or ffmpeg paths in the answer');
  const spawn = f.calls.spawns[0];
  assert.deepEqual(spawn.sub, ['status']);
  assert.deepEqual(spawn.args.slice(0, 3), ['-I', '-m', 'promptcut_stt']);
  assert.equal(spawn.cwd, f.ws.dir());
  assert.deepEqual(Object.keys(spawn.env).filter((k) => /^PROMPTCUT_/i.test(k)).sort(), ['PROMPTCUT_MODELS', 'PROMPTCUT_PYLIBS']);
  assert.equal(spawn.env.AGENT_DELEGATION_TOKEN_TEST, undefined);
  assert.ok(Object.entries(spawn.env).some(([k, v]) => k.toLowerCase() === 'path' && v.includes('ffmpeg-bin')), 'ffmpeg dir from node config is on the child PATH');
});

test('stt_status says so plainly when python is not configured or does not run', async (t) => {
  const none = await p2Fixture(t, { runtime: { pythonPath: undefined } });
  const missing = await none.tools.call('stt_status', {}, none.context);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'PYTHON_MISSING');
  assert.equal(missing.cloudUnavailable, true);
  const broken = await p2Fixture(t);
  broken.modes.status = 'broken';
  const answer = await broken.tools.call('stt_status', {}, broken.context);
  assert.equal(answer.code, 'STATUS_FAILED');
  assert.ok(!JSON.stringify(answer).includes('boom'));
});

test('transcribe_media without engine, weights or ffmpeg answers at once, with no job and no asset read', async (t) => {
  const f = await p2Fixture(t);
  await f.addMedia('media-a', bytes());
  f.modes.status = 'no-engine';
  const noEngine = await transcribe(f, { mediaId: 'media-a' });
  assert.equal(noEngine.ok, false);
  assert.equal(noEngine.code, 'ENGINE_NOT_INSTALLED');
  assert.equal(noEngine.canInstall, true);
  assert.equal(noEngine.error, STT_ERROR_TEXT.ENGINE_NOT_INSTALLED);
  f.modes.status = 'no-model';
  const noModel = await transcribe(f, { mediaId: 'media-a', model: 'small' });
  assert.equal(noModel.code, 'MODEL_NOT_INSTALLED');
  assert.deepEqual(noModel.availableModels, []);
  f.modes.status = 'no-ffmpeg';
  assert.equal((await transcribe(f, { mediaId: 'media-a' })).code, 'FFMPEG_MISSING');
  const other = await p2Fixture(t, { runtime: { pythonPath: undefined } });
  assert.equal((await transcribe(other, { mediaId: 'media-a' })).code, 'PYTHON_MISSING');
  assert.equal((await transcribe(f, { mediaId: 'media-a', engine: 'whisper' })).code, 'ENGINE_NOT_ALLOWED');
  assert.equal(f.calls.openRead, 0, 'media bytes are not requested while the environment is unusable');
  assert.equal(jobCount(f), 0);
  assert.ok(f.calls.spawns.every((s) => s.sub[0] === 'status'));
});

test('transcribe_media: real asset bytes reach the child, the transcript lands in the project, the job is done and the workspace is clean', async (t) => {
  const f = await p2Fixture(t);
  const payload = bytes();
  const hash = await f.addMedia('media-a', payload);
  const started = await transcribe(f, { mediaId: 'media-a', language: 'zh' });
  assert.equal(started.ok, true);
  assert.equal(started.started, true);
  await finished(f, started.jobId);
  const job = rawJob(f, started.jobId);
  assert.equal(job.progress, 1);
  assert.deepEqual(JSON.parse(job.output_refs), [{ kind: 'transcript', id: 'media-a' }]);
  const transcript = f.doc.media.get('media-a').transcript;
  assert.deepEqual(transcript.segments, [{ start: 0, end: 1.2, text: `sha:${sha256(payload).slice(0, 12)}` }, { start: 1.2, end: 2.5, text: '第二段' }]);
  assert.equal(transcript.engine, 'faster-whisper');
  assert.equal(transcript.model, 'small');
  assert.equal(transcript.language, 'zh');
  assert.match(transcript.createdAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(f.doc.commits.length, 1);
  assert.equal(f.doc.commits[0].assetHash, hash);
  assert.equal(f.doc.commits[0].projectId, projectId);
  const spawn = f.calls.spawns.find((s) => s.sub[0] === 'transcribe');
  assert.deepEqual(spawn.sub.filter((x) => x.startsWith('--')).sort(), ['--device', '--engine', '--input', '--language', '--model', '--offline']);
  assert.ok(!spawn.sub.includes('--out'));
  assert.equal(spawn.sub[spawn.sub.indexOf('--language') + 1], 'zh');
  assert.equal(path.dirname(path.dirname(spawn.sub[spawn.sub.indexOf('--input') + 1])), f.ws.dir());
  assert.deepEqual(f.wsFiles(), [], 'the fetched copy is removed once finished');
  await f.tools.close('test');
});

test('transcribe_media without language asks for auto-detection; the same request in one message is one job', async (t) => {
  const f = await p2Fixture(t);
  await f.addMedia('media-a', bytes());
  const first = await transcribe(f, { mediaId: 'media-a' });
  const again = await transcribe(f, { mediaId: 'media-a' });
  assert.equal(again.started, false);
  assert.equal(again.jobId, first.jobId);
  await finished(f, first.jobId);
  const done = await transcribe(f, { mediaId: 'media-a' });
  assert.equal(done.started, false);
  assert.equal(done.state, 'done');
  assert.equal(f.calls.spawns.filter((s) => s.sub[0] === 'transcribe').length, 1);
  const sub = f.calls.spawns.find((s) => s.sub[0] === 'transcribe').sub;
  assert.equal(sub[sub.indexOf('--language') + 1], 'auto');
  assert.equal(f.doc.media.get('media-a').transcript.language, 'zh', 'the language the engine detected is recorded');
});

test('a read-only member cannot install or transcribe: refused before any status probe, asset read, job or child', async (t) => {
  const f = await p2Fixture(t);
  await f.addMedia('media-a', bytes());
  f.flags.readOnly = true;
  await assert.rejects(transcribe(f, { mediaId: 'media-a' }), { code: 'run-access-denied' });
  await assert.rejects(f.tools.call('stt_install', { engine: 'faster-whisper' }, f.context), { code: 'run-access-denied' });
  assert.equal(f.calls.spawns.length, 0);
  assert.equal(f.calls.openRead, 0);
  assert.equal(jobCount(f), 0);
  assert.equal(f.doc.commits.length, 0);
});

test('a media id from another project, an image, and an oversized file are refused without a job', async (t) => {
  const f = await p2Fixture(t, { limits: { maxMediaBytes: 4000 } });
  await f.putMedia('another-project', 'media-b', bytes(100));
  await assert.rejects(transcribe(f, { mediaId: 'media-b' }), (e) => e.code === 'media-unavailable' && !/another-project/.test(e.message));
  await assert.rejects(transcribe(f, { mediaId: 'media-missing' }), { code: 'media-unavailable' });
  await f.addMedia('img', bytes(100), { kind: 'image', ext: 'png' });
  const image = await transcribe(f, { mediaId: 'img' });
  assert.equal(image.code, 'NO_AUDIO');
  await f.addMedia('big', bytes(4500));
  const big = await transcribe(f, { mediaId: 'big' });
  assert.equal(big.code, 'MEDIA_TOO_LARGE');
  assert.equal(jobCount(f), 0);
  assert.equal(f.calls.spawns.filter((s) => s.sub[0] === 'transcribe').length, 0);
  assert.deepEqual(f.wsFiles(), []);
});

test('failures are recorded as codes only, never the child message; a failed request can be sent again', async (t) => {
  const f = await p2Fixture(t);
  await f.addMedia('media-a', bytes());
  const cases = [['fail-generic', 'TRANSCRIBE_FAILED'], ['fail-model', 'MODEL_NOT_INSTALLED'], ['fail-noaudio', 'NO_AUDIO'], ['badsegs', 'TRANSCRIBE_FAILED']];
  const seen = new Set();
  for (const [mode, code] of cases) {
    f.modes.transcribe = mode;
    const started = await transcribe(f, { mediaId: 'media-a' });
    assert.equal(started.started, true, `${mode} starts a fresh job each time`);
    assert.ok(!seen.has(started.jobId));
    seen.add(started.jobId);
    await finished(f, started.jobId, 'error');
    assert.equal(rawJob(f, started.jobId).error_code, code);
    assert.ok(!JSON.stringify(rawJob(f, started.jobId)).includes('secret'));
  }
  assert.equal(f.doc.commits.length, 0);
  assert.deepEqual(f.wsFiles(), []);
  f.modes.transcribe = 'ok';
  const ok = await transcribe(f, { mediaId: 'media-a' });
  await finished(f, ok.jobId);
  assert.ok(!seen.has(ok.jobId));
  assert.equal(f.doc.commits.length, 1);
});

test('a silent file commits an empty transcript; too many segments are refused', async (t) => {
  const f = await p2Fixture(t, { limits: { maxSegments: 10 } });
  await f.addMedia('quiet', bytes());
  f.modes.transcribe = 'silent';
  const quiet = await transcribe(f, { mediaId: 'quiet' });
  await finished(f, quiet.jobId);
  assert.deepEqual(f.doc.media.get('quiet').transcript.segments, []);
  await f.addMedia('long', bytes());
  f.modes.transcribe = 'huge';
  const huge = await transcribe(f, { mediaId: 'long' });
  await finished(f, huge.jobId, 'error');
  assert.equal(rawJob(f, huge.jobId).error_code, 'TRANSCRIPT_TOO_LARGE');
  assert.equal(f.doc.media.get('long').transcript, null);
});

test('a media file replaced during transcription is not written over', async (t) => {
  const f = await p2Fixture(t);
  await f.addMedia('media-a', bytes());
  f.doc.mutateBeforeCommit = () => { f.doc.media.get('media-a').hash = 'f'.repeat(64); };
  const started = await transcribe(f, { mediaId: 'media-a' });
  await finished(f, started.jobId, 'error');
  assert.equal(rawJob(f, started.jobId).error_code, 'MEDIA_CHANGED');
  assert.equal(f.doc.media.get('media-a').transcript, null);
  assert.equal(f.doc.commits.length, 0);
});

test('timeout: the whole child tree is killed and the job ends as TIMEOUT', async (t) => {
  const f = await p2Fixture(t, { limits: { transcribeMs: 1500 } });
  await f.addMedia('media-a', bytes());
  f.modes.transcribe = 'slow';
  const started = await transcribe(f, { mediaId: 'media-a' });
  const pids = await until(() => f.pidsFile(), { what: 'child pids' });
  assert.ok(alive(pids.child) && alive(pids.grandchild));
  await finished(f, started.jobId, 'error');
  assert.equal(rawJob(f, started.jobId).error_code, 'TIMEOUT');
  await until(() => !alive(pids.child) && !alive(pids.grandchild), { what: 'process tree exit' });
  assert.equal(f.doc.commits.length, 0);
  assert.deepEqual(f.wsFiles(), []);
});

test('private/stop fence: the registered child tree really exits, the job is cancelled, nothing is written', async (t) => {
  const f = await p2Fixture(t);
  await f.addMedia('media-a', bytes());
  f.modes.transcribe = 'slow';
  const started = await transcribe(f, { mediaId: 'media-a' });
  const pids = await until(() => f.pidsFile(), { what: 'child pids' });
  assert.equal(rawJob(f, started.jobId).state, 'running');
  const fence = (await f.resources.authorize(f.context, 'read')).fenceRevision;
  f.authority.privateFence();                                   // 对话改成私有:当前授权收回
  await assert.rejects(f.resources.authorize(f.context, 'write'));
  f.cancel.fence = fence; f.cancel.window = true;              // 宿主取消路径用控制面事件里的旧栅栏核对
  await f.resources.abortForFence(f.context, 'private');
  await f.currentJobs.cancelForFence(f.context, fence);
  await until(() => !alive(pids.child) && !alive(pids.grandchild), { what: 'process tree exit' });
  const closed = await f.tools.close('fence');
  assert.equal(closed.childrenClosed, true);
  assert.equal(closed.workPending, 0);
  const job = rawJob(f, started.jobId);
  assert.equal(job.state, 'cancelled');
  assert.equal(job.error_code, 'FENCE_CANCELLED');
  assert.equal(f.doc.commits.length, 0);
  assert.deepEqual(f.wsFiles(), []);
  assert.equal(f.calls.spawns.filter((s) => s.sub[0] === 'transcribe').length, 1);
});

test('a revoked context cannot start a child any more (register fails closed)', async (t) => {
  const f = await p2Fixture(t);
  await f.addMedia('media-a', bytes());
  await f.resources.abortForFence(f.context, 'stop');
  await assert.rejects(f.tools.call('stt_status', {}, f.context), (e) => /^run-resource-/.test(e.code));
  await assert.rejects(transcribe(f, { mediaId: 'media-a' }), (e) => /^run-resource-/.test(e.code));
  assert.equal(f.calls.spawns.length, 0, 'no child is even started for a revoked run');
  assert.equal(jobCount(f), 0);
});

test('a run kept after the person signs out (retained) finishes and still writes the transcript', async (t) => {
  const f = await p2Fixture(t);
  await f.addMedia('media-a', bytes());
  f.modes.transcribe = 'delay';
  const started = await transcribe(f, { mediaId: 'media-a' });
  await until(() => rawJob(f, started.jobId).stage === 'transcribe', { what: 'transcribe stage' });
  const before = rawJob(f, started.jobId).fence_revision;
  f.authority.provider.applyAccessEvent(f.authority.exit());      // 登录退出:已读共有轮转成保留
  assert.equal((await f.resources.authorize(f.context, 'write')).grantState, 'retained');
  await finished(f, started.jobId);
  const job = rawJob(f, started.jobId);
  assert.ok(job.fence_revision > before, 'the job moved to the retained fence through its checkpoint');
  assert.equal(f.doc.commits.length, 1);
});

test('restart: closing the tools kills the child and leaves the job running; reopening marks it interrupted and the request can be sent again', async (t) => {
  const f = await p2Fixture(t);
  await f.addMedia('media-a', bytes());
  f.modes.transcribe = 'slow';
  const first = await transcribe(f, { mediaId: 'media-a' });
  const pids = await until(() => f.pidsFile(), { what: 'child pids' });
  const closed = await f.tools.close('restart');
  assert.deepEqual(closed, { childrenClosed: true, streamsClosed: true, workPending: 0 });
  await until(() => !alive(pids.child) && !alive(pids.grandchild), { what: 'process tree exit' });
  assert.equal(rawJob(f, first.jobId).state, 'running');
  await assert.rejects(f.tools.call('stt_status', {}, f.context), { code: 'stt-closed' });
  await f.reopenJobs();
  assert.equal(rawJob(f, first.jobId).state, 'interrupted');
  assert.equal(rawJob(f, first.jobId).error_code, 'INTERRUPTED_ON_RESTART');
  const next = f.openTools();
  f.modes.transcribe = 'ok';
  const again = await next.call('transcribe_media', { mediaId: 'media-a' }, f.context);
  assert.equal(again.started, true);
  assert.notEqual(again.jobId, first.jobId);
  await finished(f, again.jobId);
  assert.equal(f.doc.commits.length, 1);
});

test('transcriptions run one at a time on the node', async (t) => {
  const f = await p2Fixture(t);
  await f.addMedia('media-a', bytes());
  await f.addMedia('media-b', bytes());
  f.modes.transcribe = 'delay';
  const [a, b] = [await transcribe(f, { mediaId: 'media-a' }), await transcribe(f, { mediaId: 'media-b' })];
  await finished(f, a.jobId);
  await finished(f, b.jobId);
  assert.equal(f.calls.maxConcurrentTranscribe, 1);
  assert.equal(f.doc.commits.length, 2);
});

test('stt_install: fixed arguments only, locked requirements from the node config, one install at a time, job ends done', async (t) => {
  const f = await p2Fixture(t);
  f.modes.status = 'no-engine';
  f.modes.install = 'slow';
  const started = await f.tools.call('stt_install', { engine: 'faster-whisper' }, f.context);
  assert.equal(started.started, true);
  const second = await f.tools.call('stt_install', { engine: 'faster-whisper' }, f.context);
  assert.equal(second.alreadyRunning, true);
  assert.equal((await f.tools.call('stt_status', {}, f.context)).installRunning, true);
  const install = await until(() => f.calls.spawns.find((s) => s.sub[0] === 'install'), { what: 'install child' });
  assert.deepEqual(install.sub, ['install', '--engine', 'faster-whisper', '--requirements', f.requirements, '--index-url', 'https://index.example.test/simple']);
  assert.equal(install.env.PIP_NO_INPUT, '1');
  await f.tools.close('test');                                  // 慢安装被停掉,进程真的退出
  const pid = JSON.parse(fs.readFileSync(path.join(f.ws.dir(), 'install-pid.json'), 'utf8')).pid;
  await until(() => !alive(pid), { what: 'install child exit' });

  const g = await p2Fixture(t);
  g.modes.status = 'no-engine';
  const ok = await g.tools.call('stt_install', { engine: 'faster-whisper' }, g.context);
  await finished(g, ok.jobId);
  assert.equal((await g.tools.call('stt_status', {}, g.context)).installRunning, false);
  const sameAgain = await g.tools.call('stt_install', { engine: 'faster-whisper' }, g.context);
  assert.equal(sameAgain.started, false, 'the same install in one message is not started twice');
  assert.equal(sameAgain.jobId, ok.jobId);

  const h = await p2Fixture(t);
  h.modes.status = 'no-engine';
  h.modes.install = 'fail';
  const bad = await h.tools.call('stt_install', { engine: 'faster-whisper' }, h.context);
  assert.equal(bad.started, true);
  await finished(h, bad.jobId, 'error');
  assert.equal(rawJob(h, bad.jobId).error_code, 'INSTALL_FAILED');
});

test('stt_install says what is true: already installed, not allowed, not enabled on this node', async (t) => {
  const f = await p2Fixture(t);
  const already = await f.tools.call('stt_install', { engine: 'faster-whisper' }, f.context);
  assert.equal(already.alreadyInstalled, true);
  assert.equal(already.started, false);
  assert.equal((await f.tools.call('stt_install', { engine: 'whisper' }, f.context)).code, 'ENGINE_NOT_ALLOWED');
  assert.equal(jobCount(f), 0);
  const noLock = await p2Fixture(t, { runtime: { requirements: {} } });
  noLock.modes.status = 'no-engine';
  const refused = await noLock.tools.call('stt_install', { engine: 'faster-whisper' }, noLock.context);
  assert.equal(refused.code, 'INSTALL_NOT_ENABLED');
  assert.equal(refused.cloudUnavailable, true);
  const readonly = await p2Fixture(t);
  readonly.modes.status = 'readonly-pylibs';
  assert.equal((await readonly.tools.call('stt_status', {}, readonly.context)).engines['faster-whisper'].installableHere, false);
  const engineGone = await p2Fixture(t);
  engineGone.modes.status = 'no-engine';
  const before = engineGone.calls.spawns.length;
  assert.equal((await engineGone.tools.call('stt_status', {}, engineGone.context)).engines['faster-whisper'].installed, false);
  assert.equal(engineGone.calls.spawns.length, before + 1);
  assert.equal(jobCount(engineGone), 0);
});
