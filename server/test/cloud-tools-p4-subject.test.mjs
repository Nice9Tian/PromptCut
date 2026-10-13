// P4 主体识别(云端 Agent 的 subject_status / subject_install / detect_subjects / list_subjects)。
// 底座:真的 doc 一侧运行权限(SQLite)、真的 run-resources / tool-jobs(SQLite) / project-assets(物理素材库) / 工作区;
// Python 用替身脚本(fixtures/subject-stub.mjs)按同一份命令行与 JSONL 约定回话,让取消、超时、失败、孤儿进程不依赖真模型就能反复跑。
// 真模型、真视频的整条链在 scripts/probes/cloud-tools-p4-subject-probe.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { makeP4Fixture, tmpDir, projectId } from './cloud-tools-p4-fixture.mjs';
import { readSubjectConfig, SUBJECT_TOOL_NAMES, SubjectToolError, createSubjectTools } from '../agent/service/perception/subject.mjs';

const stubPath = fileURLToPath(new URL('./fixtures/subject-stub.mjs', import.meta.url));
const plan = (obj) => Buffer.from(JSON.stringify(obj));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const code = (expected) => (error) => error?.code === expected;

async function until(fn, ms = 15000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`等不到:${label}`);
    await sleep(25);
  }
}

function stubConfig(t, { engine = 'light', install = null } = {}) {
  const models = tmpDir('pc-p4-models-');
  fs.writeFileSync(path.join(models, 'engine.txt'), engine);
  t.after(() => fs.rmSync(models, { recursive: true, force: true }));
  return { python: process.execPath, args: [stubPath], modelsDir: models, pythonPath: 'X:\\fake-py', ...(install ? { install } : {}) };
}

const detect = (fx, mediaId, extra = {}, options) => fx.tools.call('detect_subjects', { mediaId, ...extra }, fx.context, options);
const list = (fx, mediaId) => fx.tools.call('list_subjects', { mediaId }, fx.context);

/** 轮询 list_subjects 到不再 running;回 `{ result }` 或 `{ error }` */
async function settle(fx, mediaId, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const r = await list(fx, mediaId);
      if (!r?.running) return { result: r };
    } catch (error) { return { error }; }
    if (Date.now() > end) throw new Error('作业一直没结束');
    await sleep(40);
  }
}

const pidsOf = (fx) => JSON.parse(fs.readFileSync(path.join(fx.ws.dir(), 'stub-pids.json'), 'utf8'));
const waitPids = (fx) => until(() => { try { return pidsOf(fx); } catch { return null; } }, 15000, 'stub-pids');
const ledger = (fx, jobId) => fx.jobs.get(fx.context, jobId);

test('工具名与表里 P4 一行一致;配置读取只认绝对路径', () => {
  assert.deepEqual([...SUBJECT_TOOL_NAMES].sort(), ['detect_subjects', 'list_subjects', 'subject_install', 'subject_status']);
  assert.equal(readSubjectConfig({}, { root: '/r' }), null);
  assert.match(readSubjectConfig({ PROMPTCUT_AGENT_SUBJECT_PYTHON: 'python' }, { root: '/r' }).error, /绝对路径/);
  const models = tmpDir('pc-p4-cfg-');
  try {
    assert.match(readSubjectConfig({ PROMPTCUT_AGENT_SUBJECT_PYTHON: process.execPath }, { root: '/r' }).error, /MODELS/);
    const ok = readSubjectConfig({ PROMPTCUT_AGENT_SUBJECT_PYTHON: process.execPath, PROMPTCUT_AGENT_SUBJECT_MODELS: models }, { root: '/r' });
    assert.equal(ok.modelsDir, models);
    assert.equal(ok.install, undefined, '没给 PYLIBS 与 REQUIREMENTS 就不许装');
    assert.ok(ok.pythonPath.includes(`${path.sep}python`) || ok.pythonPath.includes('/python'));
  } finally { fs.rmSync(models, { recursive: true, force: true }); }
});

test('依赖没给齐,工厂直接拒绝(不静默降级)', () => {
  assert.throws(() => createSubjectTools({}), (e) => e instanceof SubjectToolError && e.code === 'subject-unconfigured');
});

test('没配主体识别的节点:四个工具如实说明,不起作业', async (t) => {
  const fx = await makeP4Fixture(t, { config: null });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'ok' }), extra: { duration: 6 } });
  const status = await fx.tools.call('subject_status', {}, fx.context);
  assert.equal(status.ready, false);
  assert.equal(status.engine, null);
  assert.match(status.reason, /没有配置主体识别/);
  assert.match(status.hint, /see_frames/);
  const out = await detect(fx, 'm1');
  assert.equal(out.ok, false);
  assert.equal(out.cloudUnavailable, true);
  assert.match(out.error, /see_frames/);
  const install = await fx.tools.call('subject_install', {}, fx.context);
  assert.equal(install.cloudUnavailable, true);
  assert.equal(await list(fx, 'm1'), null, '没检测过就是 null,与桌面版一致');
  assert.equal(fx.ws.list().length, 0, '什么都没落到工作区');
});

test('两档都用不了(engine 为 null):detect 不起注定失败的作业,账本里没有作业', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t, { engine: 'none' }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'ok' }), extra: { duration: 6 } });
  const status = await fx.tools.call('subject_status', {}, fx.context);
  assert.equal(status.ready, false);
  assert.equal(status.engine, null);
  assert.match(status.hint, /两档都用不了/);
  const out = await detect(fx, 'm1');
  assert.equal(out.cloudUnavailable, true);
  assert.match(out.error, /没有兜底档/);
  const db = new DatabaseSync(fx.dbPath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tool_jobs').get().n, 0); } finally { db.close(); }
});

test('light 档整条链:取字节→起进程→写项目;进度/终态在持久账本;临时文件删净;命令行带 --local-only 且不带 PROMPTCUT_ 环境', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t, { engine: 'light' }) });
  const added = await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'ok', duration: 6, delayMs: 20 }), extra: { duration: 6 } });
  const status = await fx.tools.call('subject_status', {}, fx.context);
  assert.equal(status.engine, 'light');
  assert.equal(status.ready, true);
  assert.doesNotMatch(JSON.stringify(status), /pc-p4-models|engine\.txt|fake-py/, '节点上的路径不回给模型');

  const started = await detect(fx, 'm1', { prompt: '  cat . dog .  ' });
  assert.equal(started.started, true);
  assert.equal(started.engine, 'light');
  assert.ok(started.jobId.startsWith('job_'));
  assert.equal(started.samples, 3, '没做过镜头识别:每 2 秒一点');
  assert.match(started.sampledFrom, /每 2 秒/);

  const { result, error } = await settle(fx, 'm1');
  assert.equal(error, undefined);
  assert.equal(result.running, false);
  assert.equal(result.engine, 'light');
  assert.equal(result.prompt, 'cat . dog .');
  assert.match(result.engineNote, /只认 person 和 face/, 'light 档不假称提示词生效');
  assert.equal(result.samples.length, 3);
  assert.equal(result.samples[0].suggestedPosition, 'right');
  assert.equal(result.samples[0].boxCount, 1);
  assert.equal(result.failedCount, 0);

  assert.equal(fx.commits.length, 1);
  assert.equal(fx.commits[0].mediaId, 'm1');
  const row = await ledger(fx, started.jobId);
  assert.equal(row.state, 'done');
  assert.equal(row.progress, 1);
  assert.deepEqual(row.outputRefs, [{ kind: 'subjects', id: 'm1' }]);
  assert.equal(row.senderAccountId, fx.context.senderAccountId);

  assert.deepEqual(fx.ws.list().map((f) => f.path).filter((p) => p !== 'stub-calls.jsonl'), ['subject/jobs.json'], '取来的素材删掉了,只剩作业索引(替身自己的调用记录除外)');
  const calls = fx.readConfigCalls().filter((c) => c.sub === 'detect');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts['--local-only'], true);
  assert.equal(calls[0].hasPromptcutEnv, false);
  assert.ok(calls[0].argv.includes('--prompt=cat . dog .'));
  assert.ok(calls[0].argv.some((a) => a.startsWith('--times=') || a === '--times'));
  assert.equal(added.size > 0, true);
});

test('抽帧失败的采样带 failed 标记写进项目;不假称「这一帧没有人」', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t) });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'ok', duration: 3, delayMs: 5 }), extra: { duration: 6 } });
  await detect(fx, 'm1', { times: [1, 2.5, 999] });
  const { result } = await settle(fx, 'm1');
  assert.equal(result.failedCount, 1);
  const bad = result.samples.find((s) => s.t === 999);
  assert.equal(bad.failed, true);
  assert.match(bad.reason, /超出时长/);
  assert.equal(bad.safeSide, undefined, '失败的采样不给 safeSide / 建议位置');
  assert.equal(bad.boxCount, 0);
  assert.match(result.hint, /不是「这一帧没有人」/);
});

test('full 缺权重中途退回 light:fellBackFrom 与原因原样记下;engine 记实际跑的一档', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t, { engine: 'full' }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'ok', duration: 6, fellBack: true, reportEngine: 'light' }), extra: { duration: 6 } });
  const started = await detect(fx, 'm1', { prompt: 'person . cat .' });
  assert.equal(started.engine, 'full');
  const { result } = await settle(fx, 'm1');
  assert.equal(result.engine, 'light');
  assert.equal(result.fellBackFrom, 'full');
  assert.match(result.fallbackNote, /prompt 没生效/);
  assert.doesNotMatch(result.fallbackNote, /pc-p4-models/, '模型目录路径被抹掉');
});

test('同一素材已有结果:默认复用,force 重测,换提示词重测,light 结果遇到 full 档+提示词重测', async (t) => {
  const config = stubConfig(t, { engine: 'light' });
  const fx = await makeP4Fixture(t, { config });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'ok', duration: 6, delayMs: 5 }), extra: { duration: 6 } });
  await detect(fx, 'm1');
  await settle(fx, 'm1');
  const reused = await detect(fx, 'm1');
  assert.equal(reused.reused, true);
  assert.equal(reused.engine, 'light');
  assert.equal(fx.commits.length, 1);
  const noAnswer = await detect(fx, 'm1', { prompt: 'that . thing .' });
  assert.equal(noAnswer.started, true, '换了提示词就重测');
  await settle(fx, 'm1');
  const again = await detect(fx, 'm1', { prompt: 'that . thing .' });
  assert.equal(again.reused, true);
  assert.match(again.engineNote, /light/, '这台机器只有 light,说清楚没有重测的原因');
  const forced = await detect(fx, 'm1', { force: true, prompt: 'that . thing .' });
  assert.equal(forced.started, true);
  await settle(fx, 'm1');
  fs.writeFileSync(path.join(config.modelsDir, 'engine.txt'), 'full');
  await fx.tools.call('subject_status', {}, fx.context);
  const stale = await detect(fx, 'm1', { prompt: 'that . thing .' });
  assert.equal(stale.staleEngine, true, 'light 的旧结果答不了提示词,机器现在有 full:重测');
  assert.equal(stale.engine, 'full');
  await settle(fx, 'm1');
  assert.equal(fx.commits.length, 4);
});

test('错误 mediaId、参数不合法、音频、别的项目的素材:都明确拒绝,不起作业', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t), extraProjects: ['sp_other'] });
  await fx.addMedia({ id: 'mine', bytes: plan({ mode: 'ok' }), extra: { duration: 6 } });
  await fx.addMedia({ id: 'theirs', bytes: plan({ mode: 'ok' }), forProject: 'sp_other', extra: { duration: 6 } });
  await fx.addMedia({ id: 'voice', name: 'v.wav', kind: 'audio', bytes: Buffer.from('RIFF'), extra: { duration: 2 } });

  await assert.rejects(detect(fx, 'nope'), code('media-not-found'));
  await assert.rejects(list(fx, 'nope'), code('media-not-found'));
  await assert.rejects(detect(fx, 'theirs'), code('media-not-found'), '别的项目的素材,哪怕 id 对得上也看不见');
  await assert.rejects(list(fx, 'theirs'), code('media-not-found'));
  await assert.rejects(fx.tools.call('detect_subjects', {}, fx.context), code('bad-args'));
  await assert.rejects(fx.tools.call('detect_subjects', { mediaId: '../../etc/passwd' }, fx.context), code('bad-args'));
  await assert.rejects(fx.tools.call('detect_subjects', { mediaId: { $ne: 1 } }, fx.context), code('bad-args'));
  await assert.rejects(detect(fx, 'voice'), code('media-kind'));
  await assert.rejects(detect(fx, 'mine', { times: new Array(201).fill(1) }), code('bad-args'));
  await assert.rejects(detect(fx, 'mine', { times: ['x', -1] }), code('bad-args'));
  await assert.rejects(fx.tools.call('nope_tool', {}, fx.context), code('unknown-tool'));
  // 直接让素材层去读别的项目的素材:登记在别处,这边的素材库里没有
  await assert.rejects(fx.assets.openRead(fx.context, 'theirs'), /asset-missing|404/);
  const db = new DatabaseSync(fx.dbPath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tool_jobs').get().n, 0, '以上每一个都没有登记作业'); } finally { db.close(); }
});

test('伪造的上下文被拒:参数里的 projectId 之类不起作用;换了 runGrantId 的上下文不能用', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t) });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'ok' }), extra: { duration: 6 } });
  await assert.rejects(fx.tools.call('detect_subjects', { mediaId: 'm1' }, { ...fx.context, runId: 'forged_run' }), code('subject-forbidden'));
  await assert.rejects(fx.tools.call('subject_status', {}, { projectId: 'x' }), code('subject-forbidden'));
  const out = await detect(fx, 'm1', { projectId: 'sp_other', runGrantId: 'g', path: 'C:\\x', instanceId: 'i', engine: 'full' });
  assert.equal(out.started, true);
  await settle(fx, 'm1');
  assert.equal(fx.commits[0].projectId, projectId, '写的是上下文里的项目,不是参数里的');
  assert.equal(fx.readConfigCalls().filter((c) => c.sub === 'detect').every((c) => !c.argv.includes('full')), true, '模型不能指定引擎档位');
});

test('只读成员:能查状态与结果,detect / install 在起任何东西之前被拒', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t, { engine: 'none', install: { pylibs: 'X:\\libs', requirements: 'X:\\req.txt' } }), readOnly: true });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'ok' }), extra: { duration: 6 } }).catch(() => {});
  fx.setReadOnly(false);
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'ok' }), extra: { duration: 6 } });
  fx.setReadOnly(true);
  const status = await fx.tools.call('subject_status', {}, fx.context);
  assert.equal(status.engine, null);
  assert.equal(await list(fx, 'm1'), null);
  await assert.rejects(detect(fx, 'm1'), code('subject-forbidden'));
  await assert.rejects(fx.tools.call('subject_install', {}, fx.context), code('subject-forbidden'));
  assert.equal(fx.readConfigCalls().every((c) => c.sub === 'status'), true, '只起过查状态的进程');
  assert.equal(fx.commits.length, 0);
});

test('取消:进程树真被杀(含它起的孙进程)、账本记 cancelled、不写项目、素材临时文件删净', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t) });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'hang' }), extra: { duration: 6 } });
  const started = await detect(fx, 'm1');
  const pids = await waitPids(fx);
  assert.equal(alive(pids.child) && alive(pids.grandchild), true, '取消前两层进程都在');
  const running = await list(fx, 'm1');
  assert.equal(running.running, true);

  const receipt = await fx.tools.cancel(fx.context, started.jobId);
  assert.equal(receipt.cancelled, true);
  assert.equal(alive(pids.child), false, '子进程已退出');
  assert.equal(alive(pids.grandchild), false, '它起的孙进程也被杀(整棵树)');
  assert.equal((await ledger(fx, started.jobId)).state, 'cancelled');
  assert.equal(fx.commits.length, 0);
  await assert.rejects(list(fx, 'm1'), code('job-cancelled'));
  assert.deepEqual(fx.ws.list().map((f) => f.path).filter((p) => p !== 'stub-pids.json' && p !== 'stub-calls.jsonl'), ['subject/jobs.json']);
  assert.deepEqual(await fx.tools.cancel(fx.context, started.jobId), { cancelled: false, reason: 'not-running' });
});

test('这一轮被停(栅栏取消):run-resources 杀进程树并给回执,作业记 cancelled,不写项目', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t) });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'hang' }), extra: { duration: 6 } });
  const started = await detect(fx, 'm1');
  const pids = await waitPids(fx);
  await fx.resources.abortForFence(fx.context, 'stop');
  await until(async () => (await ledger(fx, started.jobId)).state === 'cancelled', 15000, 'ledger cancelled');
  const receipt = await fx.resources.abortForFence(fx.context, 'stop');
  assert.equal(receipt.childrenOpen, 0, '登记的子进程 exit 与 close 都到了');
  assert.equal(alive(pids.child), false);
  assert.equal(alive(pids.grandchild), false);
  assert.equal(fx.commits.length, 0);
});

test('转私有后:权限收回,进程被杀,结果不写;账本留着等宿主的栅栏取消,不会变成 done', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t) });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'hang' }), extra: { duration: 6 } });
  const started = await detect(fx, 'm1');
  const pids = await waitPids(fx);
  fx.authority.privateFence();
  await assert.rejects(list(fx, 'm1'), code('subject-forbidden'), '失权后读不到');
  await fx.resources.abortForFence(fx.context, 'private');
  await until(() => !alive(pids.child) && !alive(pids.grandchild), 15000, 'children dead');
  assert.equal(fx.commits.length, 0);
  const db = new DatabaseSync(fx.dbPath, { readOnly: true });
  try { assert.notEqual(db.prepare('SELECT state FROM tool_jobs WHERE job_id=?').get(started.jobId).state, 'done'); } finally { db.close(); }
});

test('超时:到点杀进程树,作业 error,原因写明;不写项目', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t), limits: { minDetectMs: 2500, perFrameMs: 1 } });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'hang' }), extra: { duration: 6 } });
  const started = await detect(fx, 'm1');
  const pids = await waitPids(fx);
  const { error } = await settle(fx, 'm1');
  assert.equal(error.code, 'job-error');
  assert.match(error.message, /超时/);
  assert.equal(alive(pids.child), false);
  assert.equal(alive(pids.grandchild), false);
  const row = await ledger(fx, started.jobId);
  assert.equal(row.state, 'error');
  assert.equal(row.errorCode, 'SUBJECT_TIMEOUT');
  assert.equal(fx.commits.length, 0);
});

test('失败:Python 报错 / 崩溃 / 结果格式不对,都变成明确的 error,原因里不带节点或工作目录路径', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t) });
  for (const [id, body, pattern, errorCode] of [
    ['f1', { mode: 'fail', message: '主体检测拓展未就绪' }, /拓展未就绪/, 'SUBJECT_FAILED'],
    ['f2', { mode: 'crash' }, /RuntimeError: boom/, 'SUBJECT_FAILED'],
    ['f3', { mode: 'badresult' }, /格式不对/, 'SUBJECT_FAILED'],
  ]) {
    await fx.addMedia({ id, bytes: plan(body), extra: { duration: 6 } });
    const started = await detect(fx, id);
    const { error } = await settle(fx, id);
    assert.equal(error.code, 'job-error');
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /pc-run-authority|pc-p4-models|fake-py/, '路径被抹掉');
    assert.equal((await ledger(fx, started.jobId)).errorCode, errorCode);
  }
  assert.equal(fx.commits.length, 0);
  // 失败之后可以重试
  fx.projects.get(projectId).set('f1', { ...fx.projects.get(projectId).get('f1') });
  const retry = await detect(fx, 'f1', { force: true });
  assert.equal(retry.started, true);
  await settle(fx, 'f1');
});

test('检测期间素材被换掉:版本预期不符,结果丢弃(MEDIA_CHANGED),不写旧结果到新素材上', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t) });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'ok', duration: 6, delayMs: 250 }), extra: { duration: 6 } });
  const started = await detect(fx, 'm1', { times: [0, 1, 2, 3] });
  await until(() => fx.readConfigCalls().some((c) => c.sub === 'detect'), 10000, 'detect started');
  const m = fx.projects.get(projectId).get('m1');
  fx.projects.get(projectId).set('m1', { ...m, hash: 'f'.repeat(64) }); // 重新导入:内容哈希变了
  const { error } = await settle(fx, 'm1');
  assert.equal(error.code, 'job-error');
  assert.match(error.message, /被换掉或重新导入/);
  assert.equal((await ledger(fx, started.jobId)).errorCode, 'MEDIA_CHANGED');
  assert.equal(fx.commits.length, 0);
});

test('共有已读任务:登录被撤(grant 变 retained)后作业照常做完并写项目——账本走检查点,不卡在旧栅栏上', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t) });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'ok', duration: 6, delayMs: 200 }), extra: { duration: 6 } });
  const started = await detect(fx, 'm1', { times: [0, 1, 2, 3] });
  await until(() => fx.readConfigCalls().some((c) => c.sub === 'detect'), 10000, 'detect started');
  fx.authority.provider.applyAccessEvent(fx.authority.exit());
  assert.equal((await fx.resources.authorize(fx.context, 'write')).grantState, 'retained');
  const { result, error } = await settle(fx, 'm1');
  assert.equal(error, undefined);
  assert.equal(result.samples.length, 4);
  assert.equal(fx.commits.length, 1);
  assert.equal((await ledger(fx, started.jobId)).state, 'done');
});

test('同一素材同一时刻只一个作业:相同参数回 alreadyRunning,换参数回 busy;同一 requestId 的重试不开第二个', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t), limits: { maxRunning: 1 } });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'hang' }), extra: { duration: 6 } });
  await fx.addMedia({ id: 'm2', bytes: plan({ mode: 'ok' }), extra: { duration: 6 } });
  const first = await detect(fx, 'm1', {}, { requestId: 'req_idem_0001' });
  assert.equal(first.started, true);
  const same = await detect(fx, 'm1');
  assert.equal(same.alreadyRunning, true);
  assert.equal(same.jobId, first.jobId);
  await assert.rejects(detect(fx, 'm1', { prompt: 'cat .' }), code('subject-busy'));
  await assert.rejects(detect(fx, 'm2'), code('subject-busy'), '进程内同时在跑的作业数有上限');
  const retried = await detect(fx, 'm1', {}, { requestId: 'req_idem_0001' });
  assert.equal(retried.started, false);
  assert.equal(retried.jobId, first.jobId);
  await waitPids(fx);
  await fx.tools.cancel(fx.context, first.jobId);
});

test('服务重启(graceful):close 杀进程树并等真关,作业记 interrupted;新实例查到的是「被中断」,不是找不到', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t) });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'hang' }), extra: { duration: 6 } });
  const started = await detect(fx, 'm1');
  const pids = await waitPids(fx);
  const before = fx.tools;
  const receipt = await before.close('restart');
  assert.equal(receipt.childrenClosed, true);
  assert.equal(receipt.workPending, 0);
  assert.equal(alive(pids.child) || alive(pids.grandchild), false);
  await assert.rejects(before.call('subject_status', {}, fx.context), code('subject-closing'));
  // 重开账本与工具
  await fx.restart();
  assert.notEqual(fx.tools, before);
  const row = await ledger(fx, started.jobId);
  assert.equal(row.state, 'interrupted');
  await assert.rejects(list(fx, 'm1'), (e) => e.code === 'job-interrupted' && /重新调 detect_subjects/.test(e.message));
  const again = await detect(fx, 'm1', { force: true });
  assert.equal(again.started, true, '中断之后可以重新开始');
  await waitPids(fx);
  await fx.tools.cancel(fx.context, again.jobId);
});

test('服务崩溃重启(没来得及 close):账本里 running 的作业在重开时变 interrupted,list_subjects 照样说「被中断」', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t) });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'ok', duration: 6 }), extra: { duration: 6 } });
  // 模拟崩溃前的现场:账本里有一条 running 的作业,工作区索引里也记着,但没有任何 worker
  const digest = 'a'.repeat(64);
  const { jobId } = await fx.jobs.start(fx.context, 'subject.detect', digest, 'req_crash_0001');
  await fx.jobs.update(fx.context, jobId, 0, { state: 'running', stage: 'detect', progress: 0.4 });
  fx.ws.write('subject/jobs.json', JSON.stringify([{ jobId, kind: 'detect', mediaId: 'm1', digest, prompt: '', samples: 3, engine: 'light', status: 'running', startedAt: 1 }]));
  await fx.jobs.close();
  await fx.restart();
  assert.equal((await ledger(fx, jobId)).state, 'interrupted');
  await assert.rejects(list(fx, 'm1'), (e) => e.code === 'job-interrupted' && /中断/.test(e.message));
});

test('list_subjects 的格式与桌面版一致:建议位置来自 kernel,四侧全占时给 null 与 warning', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t) });
  const subjects = {
    engine: 'light', createdAt: '2026-10-13T00:00:00.000Z', prompt: '', width: 1280, height: 720, failedCount: 0,
    samples: [
      { t: 1, boxes: [{ label: 'face', x: 100.4, y: 80, w: 50, h: 60, conf: 0.912 }, { label: 'person', x: 90, y: 70, w: 300, h: 600, conf: 0.5 }], safeSide: 'right', occupancy: { left: 0.5, right: 0.02, top: 0.1, bottom: 0.4 } },
      { t: 2, boxes: [], safeSide: 'top', occupancy: { left: 0.9, right: 0.9, top: 0.95, bottom: 0.9 } },
    ],
  };
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'ok' }), extra: { duration: 6, subjects } });
  const out = await list(fx, 'm1');
  assert.equal(out.running, false);
  assert.equal(out.samples[0].suggestedPosition, 'right');
  assert.deepEqual(out.samples[0].boxes[0], { label: 'person', x: 90, y: 70, w: 300, h: 600, conf: 0.5 }, '按面积从大到小,取整');
  assert.equal(out.samples[1].suggestedPosition, null);
  assert.match(out.samples[1].warning, /四个档位都被人物占住/);
  assert.equal(out.width, 1280);
});

test('subject_install:没给受控安装配置→不装;给了→受控作业(只传锁定清单,不收模型参数)→engine 变 light;已经有就不再装', async (t) => {
  const reqDir = tmpDir('pc-p4-req-');
  t.after(() => fs.rmSync(reqDir, { recursive: true, force: true }));
  const req = path.join(reqDir, 'locked.txt');
  fs.writeFileSync(req, 'ok');
  const pylibs = path.join(reqDir, 'libs');
  const noInstall = await makeP4Fixture(t, { config: stubConfig(t, { engine: 'none' }) });
  const refused = await noInstall.tools.call('subject_install', { tier: 'full', pip: '--index-url http://evil' }, noInstall.context);
  assert.equal(refused.cloudUnavailable, true);
  assert.match(refused.error, /不能安装主体识别/);

  const cfg = stubConfig(t, { engine: 'none', install: { pylibs, requirements: req } });
  const fx = await makeP4Fixture(t, { config: cfg });
  const started = await fx.tools.call('subject_install', { tier: 'full', pip: '--index-url http://evil', packages: ['x'] }, fx.context);
  assert.equal(started.started, true);
  const dup = await fx.tools.call('subject_install', {}, fx.context);
  assert.equal(dup.alreadyRunning, true, '不要重复启动');
  await until(async () => (await ledger(fx, started.jobId)).state === 'done', 15000, 'install done');
  const calls = fx.readConfigCalls().filter((c) => c.sub === 'install');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv.slice(0, 4), ['--tier', 'light', '--requirements', req], '参数固定为 light 档加部署者的清单');
  assert.equal(calls[0].opts['--pylibs'], pylibs);
  assert.equal(calls[0].pipNoIndex, '1', '没有出网闸:pip 不连网');
  assert.equal(calls[0].hasPromptcutEnv, false);
  const status = await fx.tools.call('subject_status', {}, fx.context);
  assert.equal(status.engine, 'light');
  assert.equal(status.install.state, 'done');
  const already = await fx.tools.call('subject_install', {}, fx.context);
  assert.equal(already.alreadyInstalled, true);
});

test('subject_install:失败有原因;给了出网闸时 pip 只走它的代理并在作业结束后关掉;超时/关闭时进程树被杀', async (t) => {
  const reqDir = tmpDir('pc-p4-req-');
  t.after(() => fs.rmSync(reqDir, { recursive: true, force: true }));
  const bad = path.join(reqDir, 'bad.txt');
  fs.writeFileSync(bad, 'nonsense');
  const cfg = stubConfig(t, { engine: 'none', install: { pylibs: path.join(reqDir, 'libs'), requirements: bad } });
  const proxy = { started: 0, closed: 0 };
  const egress = { async startProxy() { proxy.started += 1; return { url: 'http://127.0.0.1:1', async close() { proxy.closed += 1; } }; } };
  const fx = await makeP4Fixture(t, { config: cfg });
  // 用带出网闸的工具实例(同一底座)
  const tools = createSubjectTools({ config: cfg, resources: fx.resources, assets: fx.assets, jobs: fx.jobs, workspace: async () => fx.ws, project: fx.project, egress });
  const started = await tools.call('subject_install', {}, fx.context);
  await until(async () => (await ledger(fx, started.jobId)).state === 'error', 15000, 'install error');
  const row = await ledger(fx, started.jobId);
  assert.equal(row.errorCode, 'SUBJECT_INSTALL_FAILED');
  const status = await tools.call('subject_status', {}, fx.context);
  assert.equal(status.install.state, 'error');
  assert.match(status.install.message, /pip 安装失败/);
  assert.doesNotMatch(status.install.message, /pc-p4-req/, '清单路径被抹掉');
  assert.deepEqual(proxy, { started: 1, closed: 1 });
  const call = fx.readConfigCalls().filter((c) => c.sub === 'install').at(-1);
  assert.equal(call.httpProxy, 'http://127.0.0.1:1');
  assert.equal(call.pipNoIndex, null);

  const hang = path.join(reqDir, 'hang.txt');
  fs.writeFileSync(hang, 'hang');
  const cfg2 = { ...cfg, install: { ...cfg.install, requirements: hang } };
  const tools2 = createSubjectTools({ config: cfg2, resources: fx.resources, assets: fx.assets, jobs: fx.jobs, workspace: async () => fx.ws, project: fx.project, limits: { installMs: 500 } });
  const s2 = await tools2.call('subject_install', {}, fx.context);
  await until(async () => (await ledger(fx, s2.jobId)).state === 'error', 15000, 'install timeout');
  assert.equal((await ledger(fx, s2.jobId)).errorCode, 'SUBJECT_TIMEOUT');
  const tools3 = createSubjectTools({ config: cfg2, resources: fx.resources, assets: fx.assets, jobs: fx.jobs, workspace: async () => fx.ws, project: fx.project });
  const s3 = await tools3.call('subject_install', {}, fx.context);
  await until(() => fx.readConfigCalls().filter((c) => c.sub === 'install').length >= 3, 10000, 'third install started');
  const receipt = await tools3.close('shutdown');
  assert.equal(receipt.childrenClosed, true);
  assert.equal((await ledger(fx, s3.jobId)).state, 'interrupted');
});

test('close:关闭后不再接新活;返回的回执说明子进程都已关', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t) });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'ok', duration: 6 }), extra: { duration: 6 } });
  const receipt = await fx.tools.close('shutdown');
  assert.deepEqual({ ...receipt, reason: undefined }, { childrenClosed: true, streamsClosed: true, workPending: 0, reason: undefined });
  await assert.rejects(detect(fx, 'm1'), code('subject-closing'));
});

test('并发的两个 detect_subjects(同一素材):只有一个起作业,另一个回 busy / alreadyRunning;并发的两个 install 同理', async (t) => {
  const reqDir = tmpDir('pc-p4-req-');
  t.after(() => fs.rmSync(reqDir, { recursive: true, force: true }));
  const req = path.join(reqDir, 'hang.txt');
  fs.writeFileSync(req, 'hang');
  const config = stubConfig(t, { engine: 'light', install: { pylibs: path.join(reqDir, 'libs'), requirements: req } });
  const fx = await makeP4Fixture(t, { config });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'hang' }), extra: { duration: 6 } });
  const results = await Promise.allSettled([detect(fx, 'm1', { prompt: 'a .' }), detect(fx, 'm1', { prompt: 'b .' }), detect(fx, 'm1', { prompt: 'a .' })]);
  const started = results.filter((r) => r.status === 'fulfilled' && r.value.started === true);
  assert.equal(started.length, 1, '同一时刻只有一个真正起了作业');
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'subject-busy').length >= 1, true);
  const db = new DatabaseSync(fx.dbPath, { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tool_jobs WHERE kind='subject.detect'").get().n, 1); } finally { db.close(); }
  await waitPids(fx);
  await fx.tools.cancel(fx.context, started[0].value.jobId);

  // 并发 install:占位让第二个看到「已经在跑」(此时 light 档已就绪,先把引擎文件改成 none 才会走到起作业这一步)
  fs.writeFileSync(path.join(config.modelsDir, 'engine.txt'), 'none');
  const [i1, i2] = await Promise.all([fx.tools.call('subject_install', {}, fx.context), fx.tools.call('subject_install', {}, fx.context)]);
  assert.equal([i1, i2].filter((r) => r.started === true).length, 1);
  assert.equal([i1, i2].filter((r) => r.alreadyRunning === true).length, 1);
});

test('素材超过取字节的上限:作业 error(不把大文件落进工作目录),临时文件删净', async (t) => {
  const fx = await makeP4Fixture(t, { config: stubConfig(t), limits: { maxFetchBytes: 20 } });
  await fx.addMedia({ id: 'm1', bytes: plan({ mode: 'ok', pad: 'x'.repeat(200) }), extra: { duration: 6 } });
  const started = await detect(fx, 'm1');
  const { error } = await settle(fx, 'm1');
  assert.equal(error.code, 'job-error');
  assert.match(error.message, /太大/);
  assert.equal((await ledger(fx, started.jobId)).errorCode, 'MEDIA_FETCH_FAILED');
  assert.equal(fx.readConfigCalls().filter((c) => c.sub === 'detect').length, 0, '没起 Python');
  assert.deepEqual(fx.ws.list().map((f) => f.path).filter((p) => p !== 'stub-calls.jsonl'), ['subject/jobs.json']);
});
