// P1 镜头识别(云端 Agent 的 detect_shots / list_shots)。
// 底座:真的 doc 一侧运行权限(SQLite)、真的 run-resources / tool-jobs(SQLite) / project-assets(物理素材库) / 工作区;
// ffmpeg、ffprobe、Python 用替身脚本(fixtures/shots-stub.mjs)按同一份命令行与 JSONL 约定回话,让取消、超时、失败、孤儿进程不依赖真模型就能反复跑。
// 真 ffmpeg、真 TransNetV2、真视频的检出精度与恶意同名模块在 cloud-tools-p1-shots-real.test.mjs,整条链的探针在 scripts/probes/cloud-tools-p1-shots-probe.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { makeP1Fixture, loadTestKernel, tmpDir, projectId } from './cloud-tools-p1-fixture.mjs';
import { readShotsConfig, SHOTS_TOOL_NAMES, ShotsToolError, createShotsTools } from '../agent/service/perception/shots.mjs';

const stubPath = fileURLToPath(new URL('./fixtures/shots-stub.mjs', import.meta.url));
const plan = (obj = {}) => Buffer.from(JSON.stringify(obj));
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

/** 全替身的配置:ffmpeg / ffprobe 是 node 跑 shots-stub;Python 是否配、是否就绪可选 */
function stubConfig(t, { python = true, ready = true } = {}) {
  const models = tmpDir('pc-p1-models-');
  fs.writeFileSync(path.join(models, 'ready.txt'), ready ? 'yes' : 'no');
  t.after(() => fs.rmSync(models, { recursive: true, force: true }));
  return {
    ffmpeg: process.execPath, ffmpegArgs: [stubPath, 'ffmpeg'], ffprobe: process.execPath, ffprobeArgs: [stubPath, 'ffprobe'], ffmpegDir: path.dirname(process.execPath),
    ...(python ? { python: process.execPath, args: [stubPath, 'python'], modelsDir: models, pythonPath: 'X:\\fake-py' } : {}),
  };
}

const detect = (fx, mediaId, extra = {}, options) => fx.tools.call('detect_shots', { mediaId, ...extra }, fx.context, options);
const list = (fx, mediaId) => fx.tools.call('list_shots', { mediaId }, fx.context);

/** 轮询 list_shots 到不再 running;回 `{ result }` 或 `{ error }` */
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

const pidsOf = (fx, who) => JSON.parse(fs.readFileSync(path.join(fx.ws.dir(), `stub-pids-${who}.json`), 'utf8'));
const waitPids = (fx, who) => until(() => { try { return pidsOf(fx, who); } catch { return null; } }, 15000, `stub-pids-${who}`);
const ledger = (fx, jobId) => fx.jobs.get(fx.context, jobId);
const jobCount = (fx) => {
  const db = new DatabaseSync(fx.dbPath, { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) AS n FROM tool_jobs').get().n; } finally { db.close(); }
};
const workFiles = (fx) => fx.ws.list().map((f) => f.path).filter((p) => !p.startsWith('stub-'));

test('工具名与拆包表一致;配置读取只认绝对路径,模型档要 Python 与权重目录齐全', () => {
  assert.deepEqual([...SHOTS_TOOL_NAMES].sort(), ['detect_shots', 'list_shots']);
  assert.equal(readShotsConfig({}, { root: '/r' }), null, '没配 ffmpeg 就是没配');
  assert.match(readShotsConfig({ PROMPTCUT_FFMPEG: 'ffmpeg' }, { root: '/r' }).error, /绝对路径/);
  const dir = tmpDir('pc-p1-cfg-');
  try {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const ffmpeg = path.join(dir, `ffmpeg${ext}`);
    fs.writeFileSync(ffmpeg, '');
    assert.match(readShotsConfig({ PROMPTCUT_FFMPEG: ffmpeg }, { root: '/r' }).error, /ffprobe/, 'ffprobe 要在同一目录或单独指定');
    fs.writeFileSync(path.join(dir, `ffprobe${ext}`), '');
    const base = readShotsConfig({ PROMPTCUT_FFMPEG: ffmpeg }, { root: '/r' });
    assert.equal(base.python, undefined, '没配 Python:只有 scdet 档');
    assert.equal(base.ffprobe, path.join(dir, `ffprobe${ext}`));
    assert.match(readShotsConfig({ PROMPTCUT_FFMPEG: ffmpeg, PROMPTCUT_AGENT_SHOTS_PYTHON: 'python' }, { root: '/r' }).error, /绝对路径/);
    assert.match(readShotsConfig({ PROMPTCUT_FFMPEG: ffmpeg, PROMPTCUT_AGENT_SHOTS_PYTHON: process.execPath }, { root: '/r' }).error, /MODELS/);
    const full = readShotsConfig({ PROMPTCUT_FFMPEG: ffmpeg, PROMPTCUT_AGENT_SHOTS_PYTHON: process.execPath, PROMPTCUT_AGENT_SHOTS_MODELS: dir, PROMPTCUT_AGENT_SHOTS_PYLIBS: path.join(dir, 'libs') }, { root: '/r' });
    assert.equal(full.modelsDir, dir);
    assert.equal(full.pylibs, path.join(dir, 'libs'));
    assert.ok(full.pythonPath.includes('python'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('依赖没给齐,工厂直接拒绝(不静默降级)', () => {
  assert.throws(() => createShotsTools({}), (e) => e instanceof ShotsToolError && e.code === 'shots-unconfigured');
});

test('没注入内核函数(宿主没经 ssr-host 载入缝取来):工厂直接拒绝并说「没配置全」,不去直接 import src/', async (t) => {
  const fx = await makeP1Fixture(t, { config: null });
  const deps = { config: null, resources: fx.resources, assets: fx.assets, jobs: fx.jobs, workspace: async () => fx.ws, project: fx.project };
  assert.throws(() => createShotsTools(deps), (e) => e.code === 'shots-unconfigured' && /没配置全/.test(e.message));
  const k = await loadTestKernel();
  assert.throws(() => createShotsTools({ ...deps, kernel: { subjectForRange: k.subjectForRange, suggestPosition: k.suggestPosition } }), (e) => /没配置全.*rectForSafeSide/.test(e.message));
});

test('没配镜头识别的节点:detect_shots 如实说明并指向 see_frames,不起作业;list_shots 没检测过就是 null', async (t) => {
  const fx = await makeP1Fixture(t, { config: null });
  await fx.addMedia({ id: 'm1', bytes: plan(), extra: { duration: 10 } });
  const out = await detect(fx, 'm1');
  assert.equal(out.ok, false);
  assert.equal(out.cloudUnavailable, true);
  assert.match(out.error, /see_frames/);
  assert.equal(await list(fx, 'm1'), null, '没检测过就是 null,与桌面版一致');
  assert.equal(jobCount(fx), 0);
  assert.equal(fx.ws.list().length, 0, '什么都没落到工作区');
  const status = await fx.tools.status(fx.context);
  assert.equal(status.ready, false);
});

test('ffmpeg 没有(配了路径但起不来):两档都用不了,如实回「用不了」,不起一个注定失败的作业', async (t) => {
  const missing = path.join(tmpDir('pc-p1-noff-'), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  t.after(() => fs.rmSync(path.dirname(missing), { recursive: true, force: true }));
  const fx = await makeP1Fixture(t, { config: { ffmpeg: missing, ffprobe: missing, ffmpegDir: path.dirname(missing) } });
  await fx.addMedia({ id: 'm1', bytes: plan(), extra: { duration: 10 } });
  const out = await detect(fx, 'm1');
  assert.equal(out.cloudUnavailable, true);
  assert.match(out.error, /ffmpeg 起不来/);
  assert.match(out.error, /see_frames/);
  assert.doesNotMatch(out.error, /pc-p1-noff/, '节点路径不回给模型');
  assert.equal(jobCount(fx), 0);
  const status = await fx.tools.status(fx.context);
  assert.equal(status.ffmpeg, false);
  assert.equal(status.engine, null);
});

test('没配 Python:用 ffmpeg scdet 档,只有硬切;结果写进项目,list_shots 读得回来,说明为什么没用模型', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ duration: 10 }), extra: { duration: 10 } });
  const started = await detect(fx, 'm1');
  assert.equal(started.started, true);
  assert.equal(started.engine, 'scdet');
  assert.match(started.engineNote, /只认硬切/);
  assert.match(started.engineNote, /没有配置 TransNetV2/);
  assert.ok(started.jobId.startsWith('job_'));

  const { result, error } = await settle(fx, 'm1');
  assert.equal(error, undefined);
  assert.equal(result.running, false);
  assert.equal(result.engine, 'scdet');
  assert.match(result.engineNote, /scdet 兜底.*只认硬切/);
  assert.match(result.engineNote, /没有配置 TransNetV2/);
  assert.deepEqual(result.transitions.map((x) => [x.kind, x.start, x.end, x.time]), [['cut', 3, 3, 3], ['cut', 6.6, 6.6, 6.6]]);
  assert.deepEqual(result.shots.map((s) => [s.start, s.end, s.inTransition, s.outTransition]), [
    [0, 3, null, 'cut'], [3, 6.6, 'cut', 'cut'], [6.6, 10, 'cut', null],
  ]);
  assert.equal(result.shots[0].subject, null);
  assert.match(result.subjectHint, /还没做主体检测/);

  assert.equal(fx.commits.length, 1);
  assert.equal(fx.commits[0].engine, 'scdet');
  const row = await ledger(fx, started.jobId);
  assert.equal(row.state, 'done');
  assert.equal(row.progress, 1);
  assert.deepEqual(row.outputRefs, [{ kind: 'shots', id: 'm1' }]);
  assert.equal(row.senderAccountId, fx.context.senderAccountId);
  assert.deepEqual(workFiles(fx), ['shots/jobs.json'], '取来的素材删掉了,只剩作业索引');

  // 素材只读本地文件,不带服务自己的配置
  const calls = fx.readConfigCalls();
  const probe = calls.find((c) => c.who === 'ffprobe');
  const scd = calls.find((c) => c.who === 'ffmpeg' && c.argv.includes('-i'));
  for (const c of [probe, scd]) {
    const i = c.argv.indexOf('-protocol_whitelist');
    assert.ok(i >= 0 && c.argv[i + 1] === 'file', `${c.who} 输入前带 -protocol_whitelist file`);
    assert.equal(c.hasPromptcutEnv, false);
  }
  assert.ok(scd.argv.includes('scdet=threshold=10'), '阈值与桌面版一致');
  assert.equal(calls.some((c) => c.who === 'python'), false, '没配 Python 就没起过 Python');
});

test('Python 配了但依赖没装:scdet 兜底,点明缺 onnxruntime 与权重;status 如实', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { ready: false }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ duration: 10 }), extra: { duration: 10 } });
  const status = await fx.tools.status(fx.context);
  assert.equal(status.engine, 'scdet');
  assert.equal(status.model.ready, false);
  assert.match(status.model.reason, /onnxruntime 没装/);
  assert.match(status.model.reason, /transnetv2\.onnx/);
  assert.doesNotMatch(JSON.stringify(status), /pc-p1-models|fake-py/, '节点路径不回给模型');
  const started = await detect(fx, 'm1');
  assert.equal(started.engine, 'scdet');
  const { result } = await settle(fx, 'm1');
  assert.equal(result.engine, 'scdet');
  assert.match(result.engineNote, /onnxruntime 没装/);
  assert.equal(fx.readConfigCalls().filter((c) => c.who === 'python' && c.sub === 'detect').length, 0, '模型档没起过');
});

test('TransNetV2 档整条链:硬切和溶解都认,溶解带跨度;命令行带 --local-only 且不带 PROMPTCUT_ 环境;转场里没有 thumbs', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t) });
  await fx.addMedia({ id: 'm1', bytes: plan({ duration: 10 }), extra: { duration: 10 } });
  const status = await fx.tools.status(fx.context);
  assert.equal(status.engine, 'transnetv2');
  assert.equal(status.model.ready, true);
  const started = await detect(fx, 'm1');
  assert.equal(started.engine, 'transnetv2');
  assert.ok(started.etaSeconds >= 6);
  const { result } = await settle(fx, 'm1');
  assert.equal(result.engine, 'transnetv2');
  assert.match(result.engineNote, /硬切和溶解都认得/);
  assert.deepEqual(result.transitions.map((x) => x.kind), ['cut', 'dissolve']);
  assert.equal(result.transitions[1].start, 6);
  assert.equal(result.transitions[1].end, 7.04);
  assert.equal(result.transitions[0].startFrame, undefined, '只留项目里 ShotTransition 的字段');
  assert.equal('thumbs' in result.transitions[0], false);
  assert.equal(result.shots.length, 3);
  assert.equal(fx.commits.length, 1);
  assert.equal(fx.commits[0].engine, 'transnetv2');
  assert.equal((await ledger(fx, started.jobId)).state, 'done');

  const py = fx.readConfigCalls().find((c) => c.who === 'python' && c.sub === 'detect');
  assert.equal(py.opts['--local-only'], true);
  assert.ok(py.opts['--models-dir']);
  assert.equal(py.hasPromptcutEnv, false);
  assert.equal(py.argv[py.argv.indexOf('--fps') + 1], '25', 'fps 来自 ffprobe');
  assert.equal(fx.readConfigCalls().some((c) => c.who === 'ffmpeg' && c.argv.includes('-i')), false, '模型档不另跑 scdet');
  assert.deepEqual(workFiles(fx), ['shots/jobs.json']);
});

test('模型档中途出错(崩溃 / 报错事件 / 结果格式不对):退回 scdet 再跑,engine 是 scdet,fellBackFrom 与原因如实说,不假称模型识别', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t) });
  for (const [id, body, pattern] of [
    ['c1', { duration: 10, python: 'crash' }, /RuntimeError: boom/],
    ['c2', { duration: 10, python: 'errorevent', message: '镜头识别拓展未就绪' }, /拓展未就绪/],
    ['c3', { duration: 10, python: 'badresult' }, /格式不对/],
  ]) {
    await fx.addMedia({ id, bytes: plan(body), extra: { duration: 10 } });
    const started = await detect(fx, id);
    assert.equal(started.engine, 'transnetv2', '起作业时还不知道会出错');
    const { result, error } = await settle(fx, id);
    assert.equal(error, undefined, id);
    assert.equal(result.engine, 'scdet', id);
    assert.equal(result.fellBackFrom, 'transnetv2');
    assert.match(result.fallbackNote, pattern);
    assert.doesNotMatch(result.fallbackNote, /pc-run-authority|pc-p1-models|fake-py/, '路径被抹掉');
    assert.match(result.engineNote, /scdet 兜底/);
    assert.deepEqual(result.transitions.map((x) => x.kind), ['cut', 'cut'], '只有硬切');
  }
  assert.equal(fx.commits.length, 3);
  assert.deepEqual(fx.commits.map((c) => c.engine), ['scdet', 'scdet', 'scdet']);
});

test('模型档遇到太长的素材:改用 scdet 并说明原因(整段解成小帧放内存,会吃光)', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t), limits: { maxModelFrames: 100 } });
  await fx.addMedia({ id: 'm1', bytes: plan({ duration: 10 }), extra: { duration: 10 } });
  await detect(fx, 'm1');
  const { result } = await settle(fx, 'm1');
  assert.equal(result.engine, 'scdet');
  assert.match(result.engineNote, /素材太长/);
  assert.equal(fx.readConfigCalls().some((c) => c.who === 'python' && c.sub === 'detect'), false);
});

test('已有结果:默认复用,force 重测;重测期间 list_shots 说在跑并标出旧结果还在', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ duration: 10 }), extra: { duration: 10 } });
  await detect(fx, 'm1');
  await settle(fx, 'm1');
  const reused = await detect(fx, 'm1');
  assert.equal(reused.reused, true);
  assert.equal(reused.engine, 'scdet');
  assert.equal(reused.shots, 3);
  assert.equal(reused.transitions, 2);
  assert.equal(fx.commits.length, 1);

  const forced = await detect(fx, 'm1', { force: true });
  assert.equal(forced.started, true);
  await settle(fx, 'm1');
  assert.equal(fx.commits.length, 2);
});

test('重测在跑时 list_shots:running 为 true,带 stale 说明,不给旧镜头', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ ffmpeg: 'hang' }), extra: { duration: 10 } });
  // 项目里先有一批旧结果
  const old = { engine: 'scdet', createdAt: '2026-10-13T00:00:00.000Z', transitions: [], shots: [{ start: 0, end: 10, inTransition: null, outTransition: null }] };
  fx.projects.get(projectId).set('m1', { ...fx.projects.get(projectId).get('m1'), shots: old });
  const started = await detect(fx, 'm1', { force: true });
  await waitPids(fx, 'ffmpeg');
  const running = await list(fx, 'm1');
  assert.equal(running.running, true);
  assert.equal(running.stale, true);
  assert.equal(running.shots, undefined);
  assert.equal(typeof running.percent, 'number');
  await fx.tools.cancel(fx.context, started.jobId);
  await assert.rejects(list(fx, 'm1'), (e) => e.code === 'job-cancelled' && /更早成功的一批/.test(e.message));
});

test('错误 mediaId、参数不合法、图片、音频、别的项目的素材:都明确拒绝,不起作业', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t), extraProjects: ['sp_other'] });
  await fx.addMedia({ id: 'mine', bytes: plan(), extra: { duration: 10 } });
  await fx.addMedia({ id: 'theirs', bytes: plan(), forProject: 'sp_other', extra: { duration: 10 } });
  await fx.addMedia({ id: 'voice', name: 'v.wav', kind: 'audio', bytes: Buffer.from('RIFF'), extra: { duration: 2 } });
  await fx.addMedia({ id: 'pic', name: 'p.png', kind: 'image', bytes: Buffer.from('PNG'), extra: {} });

  await assert.rejects(detect(fx, 'nope'), code('media-not-found'));
  await assert.rejects(list(fx, 'nope'), code('media-not-found'));
  await assert.rejects(detect(fx, 'theirs'), code('media-not-found'), '别的项目的素材,哪怕 id 对得上也看不见');
  await assert.rejects(list(fx, 'theirs'), code('media-not-found'));
  await assert.rejects(fx.tools.call('detect_shots', {}, fx.context), code('bad-args'));
  await assert.rejects(fx.tools.call('detect_shots', { mediaId: '../../etc/passwd' }, fx.context), code('bad-args'));
  await assert.rejects(fx.tools.call('detect_shots', { mediaId: { $ne: 1 } }, fx.context), code('bad-args'));
  await assert.rejects(fx.tools.call('list_shots', {}, fx.context), code('bad-args'));
  await assert.rejects(detect(fx, 'voice'), (e) => e.code === 'media-kind' && /不是视频.*音频.*没有镜头可分/.test(e.message));
  await assert.rejects(detect(fx, 'pic'), (e) => e.code === 'media-kind' && /不是视频.*图片.*没有镜头可分/.test(e.message));
  await assert.rejects(fx.tools.call('nope_tool', {}, fx.context), code('unknown-tool'));
  await assert.rejects(fx.assets.openRead(fx.context, 'theirs'), /asset-missing|404/);
  assert.equal(jobCount(fx), 0, '以上每一个都没有登记作业');
  assert.equal(fx.readConfigCalls().some((c) => c.who === 'ffmpeg' && c.argv.includes('-i')), false);
});

test('素材还没进素材服务(pending):明确拒绝', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t) });
  await fx.addMedia({ id: 'm1', bytes: plan(), extra: { duration: 10, pending: true } });
  await assert.rejects(detect(fx, 'm1'), code('media-pending'));
  assert.equal(jobCount(fx), 0);
});

test('伪造的上下文被拒:参数里的 projectId 之类不起作用;换了 runId 的上下文不能用', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ duration: 10 }), extra: { duration: 10 } });
  await assert.rejects(fx.tools.call('detect_shots', { mediaId: 'm1' }, { ...fx.context, runId: 'forged_run' }), code('shots-forbidden'));
  await assert.rejects(fx.tools.call('list_shots', { mediaId: 'm1' }, { ...fx.context, runId: 'forged_run' }), code('shots-forbidden'));
  await assert.rejects(fx.tools.call('detect_shots', { mediaId: 'm1' }, { projectId: 'x' }), code('shots-forbidden'));
  const out = await detect(fx, 'm1', { projectId: 'sp_other', runGrantId: 'g', path: 'C:\\x', instanceId: 'i', engine: 'transnetv2' });
  assert.equal(out.started, true);
  assert.equal(out.engine, 'scdet', '模型不能指定引擎');
  await settle(fx, 'm1');
  assert.equal(fx.commits[0].projectId, projectId, '写的是上下文里的项目,不是参数里的');
});

test('只读成员:能查结果,detect_shots 在起任何东西之前被拒', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ duration: 10 }), extra: { duration: 10 } });
  fx.setReadOnly(true);
  assert.equal(await list(fx, 'm1'), null);
  await assert.rejects(detect(fx, 'm1'), (e) => e.code === 'shots-forbidden' && e.status === 403);
  assert.equal(fx.readConfigCalls().length, 0, '一个进程都没起过');
  assert.equal(jobCount(fx), 0);
  assert.equal(fx.commits.length, 0);
});

test('取消(scdet 档):进程树真被杀(含孙进程)、账本记 cancelled、不写项目、素材临时文件删净', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ ffmpeg: 'hang' }), extra: { duration: 10 } });
  const started = await detect(fx, 'm1');
  const pids = await waitPids(fx, 'ffmpeg');
  assert.equal(alive(pids.child) && alive(pids.grandchild), true, '取消前两层进程都在');
  assert.equal((await list(fx, 'm1')).running, true);

  const receipt = await fx.tools.cancel(fx.context, started.jobId);
  assert.equal(receipt.cancelled, true);
  assert.equal(alive(pids.child), false, '子进程已退出');
  assert.equal(alive(pids.grandchild), false, '它起的孙进程也被杀(整棵树)');
  assert.equal((await ledger(fx, started.jobId)).state, 'cancelled');
  assert.equal(fx.commits.length, 0);
  await assert.rejects(list(fx, 'm1'), (e) => e.code === 'job-cancelled' && /取消/.test(e.message));
  assert.deepEqual(workFiles(fx), ['shots/jobs.json']);
  assert.deepEqual(await fx.tools.cancel(fx.context, started.jobId), { cancelled: false, reason: 'not-running' });
});

test('取消(TransNetV2 档):Python 与它的孙进程都被杀,取消时不退回 scdet', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t) });
  await fx.addMedia({ id: 'm1', bytes: plan({ python: 'hang', duration: 10 }), extra: { duration: 10 } });
  const started = await detect(fx, 'm1');
  const pids = await waitPids(fx, 'python');
  const receipt = await fx.tools.cancel(fx.context, started.jobId);
  assert.equal(receipt.cancelled, true);
  assert.equal(alive(pids.child), false);
  assert.equal(alive(pids.grandchild), false);
  assert.equal((await ledger(fx, started.jobId)).state, 'cancelled');
  assert.equal(fx.readConfigCalls().some((c) => c.who === 'ffmpeg' && c.argv.includes('-i')), false, '取消不触发兜底');
  assert.equal(fx.commits.length, 0);
});

test('这一轮被停(栅栏取消):run-resources 杀进程树并给回执,作业记 cancelled,不写项目', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ ffmpeg: 'hang' }), extra: { duration: 10 } });
  const started = await detect(fx, 'm1');
  const pids = await waitPids(fx, 'ffmpeg');
  await fx.resources.abortForFence(fx.context, 'stop');
  await until(async () => (await ledger(fx, started.jobId)).state === 'cancelled', 15000, 'ledger cancelled');
  const receipt = await fx.resources.abortForFence(fx.context, 'stop');
  assert.equal(receipt.childrenOpen, 0, '登记的子进程 exit 与 close 都到了');
  assert.equal(alive(pids.child), false);
  assert.equal(alive(pids.grandchild), false);
  assert.equal(fx.commits.length, 0);
});

test('转私有后:权限收回,进程被杀,结果不写;账本不会变成 done', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ ffmpeg: 'hang' }), extra: { duration: 10 } });
  const started = await detect(fx, 'm1');
  const pids = await waitPids(fx, 'ffmpeg');
  fx.authority.privateFence();
  await assert.rejects(list(fx, 'm1'), code('shots-forbidden'), '失权后读不到');
  await fx.resources.abortForFence(fx.context, 'private');
  await until(() => !alive(pids.child) && !alive(pids.grandchild), 15000, 'children dead');
  assert.equal(fx.commits.length, 0);
  const db = new DatabaseSync(fx.dbPath, { readOnly: true });
  try { assert.notEqual(db.prepare('SELECT state FROM tool_jobs WHERE job_id=?').get(started.jobId).state, 'done'); } finally { db.close(); }
});

test('超时:到点杀进程树,作业 error 并点明超时和退路;模型档超时不退回 scdet;不写项目', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t), limits: { minDetectMs: 2500, perSecondMs: 1 } });
  await fx.addMedia({ id: 'm1', bytes: plan({ python: 'hang', duration: 10 }), extra: { duration: 10 } });
  const started = await detect(fx, 'm1');
  const pids = await waitPids(fx, 'python');
  const { error } = await settle(fx, 'm1');
  assert.equal(error.code, 'job-error');
  assert.match(error.message, /超时/);
  assert.match(error.message, /see_frames/, '退路');
  assert.equal(alive(pids.child), false);
  assert.equal(alive(pids.grandchild), false);
  const row = await ledger(fx, started.jobId);
  assert.equal(row.state, 'error');
  assert.equal(row.errorCode, 'SHOTS_TIMEOUT');
  assert.equal(fx.commits.length, 0);

  // scdet 档同样
  const fx2 = await makeP1Fixture(t, { config: stubConfig(t, { python: false }), limits: { minDetectMs: 400, perSecondMs: 1 } });
  await fx2.addMedia({ id: 'm1', bytes: plan({ ffmpeg: 'hang' }), extra: { duration: 10 } });
  await detect(fx2, 'm1');
  const p2 = await waitPids(fx2, 'ffmpeg');
  const r2 = await settle(fx2, 'm1');
  assert.match(r2.error.message, /超时/);
  assert.match(r2.error.message, /超过 0\.4 秒/, '不到 1 秒的时限不能写成「超过 0 秒」');
  assert.equal(alive(p2.child) || alive(p2.grandchild), false);
});

test('失败:坏文件(ffprobe 读不出)/ 没有视频轨 / scdet 报错,都变成明确的 error,带退路,不带节点或工作目录路径', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }) });
  for (const [id, bytes, pattern, errorCode] of [
    ['f1', plan({ probe: 'fail' }), /ffprobe 读不出.*文件可能损坏/, 'SHOTS_FAILED'],
    ['f2', Buffer.from('this is not a video at all'), /ffprobe 读不出/, 'SHOTS_FAILED'],
    ['f3', plan({ probe: 'novideo' }), /没有视频轨/, 'SHOTS_FAILED'],
    ['f4', plan({ ffmpeg: 'fail' }), /ffmpeg 退出码 1.*Invalid data/, 'SHOTS_FAILED'],
  ]) {
    await fx.addMedia({ id, bytes, extra: { duration: 10 } });
    const started = await detect(fx, id);
    const { error } = await settle(fx, id);
    assert.equal(error.code, 'job-error', id);
    assert.match(error.message, pattern, id);
    assert.match(error.message, /see_frames/, '退路');
    assert.doesNotMatch(error.message, /pc-run-authority|pc-p1-models|fake-py|shots[\\/]job_/, '路径被抹掉');
    assert.equal((await ledger(fx, started.jobId)).errorCode, errorCode);
  }
  assert.equal(fx.commits.length, 0);
  // 失败之后可以重试
  assert.equal((await detect(fx, 'f1', { force: true })).started, true);
  await settle(fx, 'f1');
});

test('检测期间素材被换掉:版本预期不符,结果丢弃(MEDIA_CHANGED),不写旧结果到新素材上', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ ffmpeg: 'slow', delayMs: 800, duration: 10 }), extra: { duration: 10 } });
  const started = await detect(fx, 'm1');
  await until(() => fx.readConfigCalls().some((c) => c.who === 'ffmpeg' && c.argv.includes('-i')), 10000, 'scdet started');
  const m = fx.projects.get(projectId).get('m1');
  fx.projects.get(projectId).set('m1', { ...m, hash: 'f'.repeat(64) }); // 重新导入:内容哈希变了
  const { error } = await settle(fx, 'm1');
  assert.equal(error.code, 'job-error');
  assert.match(error.message, /被换掉或重新导入/);
  assert.equal((await ledger(fx, started.jobId)).errorCode, 'MEDIA_CHANGED');
  assert.equal(fx.commits.length, 0);
});

test('共有已读任务:登录被撤(grant 变 retained)后作业照常做完并写项目——账本走检查点', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ duration: 10 }), extra: { duration: 10 } });
  fx.authority.provider.applyAccessEvent(fx.authority.exit());
  assert.equal((await fx.resources.authorize(fx.context, 'write')).grantState, 'retained');
  const started = await detect(fx, 'm1');
  const { result, error } = await settle(fx, 'm1');
  assert.equal(error, undefined);
  assert.equal(result.shots.length, 3);
  assert.equal(fx.commits.length, 1);
  assert.equal((await ledger(fx, started.jobId)).state, 'done');
});

test('同一素材同一时刻只一个作业:相同参数回 alreadyRunning;同一 requestId 的重试不开第二个;进程内作业数有上限', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }), limits: { maxRunning: 1 } });
  await fx.addMedia({ id: 'm1', bytes: plan({ ffmpeg: 'hang' }), extra: { duration: 10 } });
  await fx.addMedia({ id: 'm2', bytes: plan({ duration: 10 }), extra: { duration: 10 } });
  const first = await detect(fx, 'm1', {}, { requestId: 'req_idem_0001' });
  assert.equal(first.started, true);
  const same = await detect(fx, 'm1');
  assert.equal(same.alreadyRunning, true);
  assert.equal(same.jobId, first.jobId);
  await assert.rejects(detect(fx, 'm2'), code('shots-busy'));
  const retried = await detect(fx, 'm1', {}, { requestId: 'req_idem_0001' });
  assert.equal(retried.started, false);
  assert.equal(retried.jobId, first.jobId);
  await waitPids(fx, 'ffmpeg');
  await fx.tools.cancel(fx.context, first.jobId);
  assert.equal(jobCount(fx), 1);
});

test('并发的三个 detect_shots(同一素材):只有一个起作业', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ ffmpeg: 'hang' }), extra: { duration: 10 } });
  const results = await Promise.allSettled([detect(fx, 'm1'), detect(fx, 'm1'), detect(fx, 'm1')]);
  const started = results.filter((r) => r.status === 'fulfilled' && r.value.started === true);
  assert.equal(started.length, 1, '同一时刻只有一个真正起了作业');
  assert.equal(jobCount(fx), 1);
  await waitPids(fx, 'ffmpeg');
  await fx.tools.cancel(fx.context, started[0].value.jobId);
});

test('服务重启(graceful):close 杀进程树并等真关,作业记 interrupted;新实例查到的是「被中断」,不是找不到', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ ffmpeg: 'hang' }), extra: { duration: 10 } });
  const started = await detect(fx, 'm1');
  const pids = await waitPids(fx, 'ffmpeg');
  const before = fx.tools;
  const receipt = await before.close('restart');
  assert.equal(receipt.childrenClosed, true);
  assert.equal(receipt.workPending, 0);
  assert.equal(alive(pids.child) || alive(pids.grandchild), false);
  await assert.rejects(before.call('list_shots', { mediaId: 'm1' }, fx.context), code('shots-closing'));
  await fx.restart();
  assert.notEqual(fx.tools, before);
  assert.equal((await ledger(fx, started.jobId)).state, 'interrupted');
  await assert.rejects(list(fx, 'm1'), (e) => e.code === 'job-interrupted' && /重新调 detect_shots/.test(e.message));
  const again = await detect(fx, 'm1', { force: true });
  assert.equal(again.started, true, '中断之后可以重新开始');
  await waitPids(fx, 'ffmpeg');
  await fx.tools.cancel(fx.context, again.jobId);
});

test('服务崩溃重启(没来得及 close):账本里 running 的作业在重开时变 interrupted,list_shots 照样说「被中断」', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ duration: 10 }), extra: { duration: 10 } });
  const digest = 'a'.repeat(64);
  const { jobId } = await fx.jobs.start(fx.context, 'shots.detect', digest, 'req_crash_0001');
  await fx.jobs.update(fx.context, jobId, 0, { state: 'running', stage: 'detect', progress: 0.4 });
  fx.ws.write('shots/jobs.json', JSON.stringify([{ jobId, kind: 'detect', mediaId: 'm1', digest, engine: 'scdet', status: 'running', startedAt: 1 }]));
  await fx.jobs.close();
  await fx.restart();
  assert.equal((await ledger(fx, jobId)).state, 'interrupted');
  await assert.rejects(list(fx, 'm1'), (e) => e.code === 'job-interrupted' && /中断/.test(e.message));
  // 连账本都没有这条作业(比如账本文件被换过):也说被中断,不是找不到
  fx.ws.write('shots/jobs.json', JSON.stringify([{ jobId: 'job_gone', kind: 'detect', mediaId: 'm1', digest, engine: 'scdet', status: 'running', startedAt: 1 }]));
  await assert.rejects(list(fx, 'm1'), code('job-interrupted'));
});

test('list_shots 的格式与桌面版一致:每个镜头折进主体情况(建议位置/矩形),转场去掉缩略图,各种提示的分支都对', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t) });
  const shots = {
    engine: 'transnetv2', createdAt: '2026-10-13T00:00:00.000Z',
    transitions: [{ kind: 'cut', start: 3, end: 3, time: 3, confidence: 0.9, thumbs: ['a.jpg'] }],
    shots: [{ start: 0, end: 3, inTransition: null, outTransition: 'cut' }, { start: 3, end: 10, inTransition: 'cut', outTransition: null }],
  };
  const subjects = {
    engine: 'light', createdAt: '2026-10-13T00:00:00.000Z', prompt: '', width: 1280, height: 720, failedCount: 0,
    samples: [
      { t: 1, boxes: [{ label: 'face', x: 100.4, y: 80, w: 50, h: 60, conf: 0.912 }], safeSide: 'right', occupancy: { left: 0.5, right: 0.02, top: 0.1, bottom: 0.4 } },
      { t: 5, boxes: [], safeSide: 'top', occupancy: { left: 0.9, right: 0.9, top: 0.95, bottom: 0.9 } },
    ],
  };
  const at = (extra) => fx.projects.get(projectId).set('m1', { ...fx.projects.get(projectId).get('m1'), ...extra });
  await fx.addMedia({ id: 'm1', bytes: plan(), extra: { duration: 10, shots } });

  let out = await list(fx, 'm1');
  assert.equal(out.running, false);
  assert.equal(out.engine, 'transnetv2');
  assert.equal(out.transitions[0].thumbs, undefined);
  assert.equal(out.shots[0].subject, null);
  assert.match(out.subjectHint, /还没做主体检测/);

  at({ subjects });
  out = await list(fx, 'm1');
  assert.equal(out.shots[0].subject.safeSide, 'right');
  assert.equal(out.shots[0].subject.suggestedPosition, 'right');
  assert.deepEqual(out.shots[0].subject.suggestedRect, { x1: 1000, y1: 40, x2: 1880, y2: 1040 }, '舞台尺寸来自项目一侧的 getStage');
  assert.equal(out.shots[1].subject.suggestedPosition, null);
  assert.match(out.shots[1].subject.warning, /四个档位都被人物占住/);
  assert.equal(out.shots[1].subject.suggestedRect, null);
  assert.equal(out.subjectEngine, 'light');
  assert.match(out.subjectHint, /suggestedPosition 可以直接填进卡片/);

  // 整批采样全失败
  at({ subjects: { ...subjects, failedCount: 2, samples: subjects.samples.map((s) => ({ ...s, failed: true, reason: 'x' })) } });
  out = await list(fx, 'm1');
  assert.equal(out.shots.every((s) => s.subject === null), true);
  assert.match(out.subjectHint, /不是「画面里没有人」/);

  // 主体检测那一边:在跑(账本 running)、失败(索引里记着)、被中断(账本不认识)
  at({ subjects });
  const digest = 'b'.repeat(64);
  const sub = await fx.jobs.start(fx.context, 'subject.detect', digest, 'req_subj_000001');
  await fx.jobs.update(fx.context, sub.jobId, 0, { state: 'running', stage: 'detect', progress: 0.5 });
  fx.ws.write('subject/jobs.json', JSON.stringify([{ jobId: sub.jobId, kind: 'detect', mediaId: 'm1', engine: 'light', status: 'running' }]));
  out = await list(fx, 'm1');
  assert.match(out.subjectHint, /主体检测正在跑\(50%\).*上一批的结果/);
  fx.ws.write('subject/jobs.json', JSON.stringify([{ jobId: sub.jobId, kind: 'detect', mediaId: 'm1', engine: 'light', status: 'error', message: '主体检测超时' }]));
  await fx.jobs.update(fx.context, sub.jobId, 1, { state: 'error', errorCode: 'SUBJECT_TIMEOUT' });
  out = await list(fx, 'm1');
  assert.match(out.subjectHint, /上次主体检测失败:主体检测超时.*更早成功的那一批/);
  assert.match(out.subjectHint, /不要继续轮询本工具/);
  fx.ws.write('subject/jobs.json', JSON.stringify([{ jobId: 'job_gone', kind: 'detect', mediaId: 'm1', engine: 'light', status: 'running' }]));
  out = await list(fx, 'm1');
  assert.match(out.subjectHint, /上次主体检测失败:.*中断/);
});

test('close:关闭后不再接新活;回执说明子进程都已关', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t) });
  await fx.addMedia({ id: 'm1', bytes: plan(), extra: { duration: 10 } });
  const receipt = await fx.tools.close('shutdown');
  assert.deepEqual({ ...receipt, reason: undefined }, { childrenClosed: true, streamsClosed: true, workPending: 0, reason: undefined });
  await assert.rejects(detect(fx, 'm1'), code('shots-closing'));
});

test('素材超过取字节的上限:作业 error(不把大文件落进工作目录),临时文件删净,没起 ffprobe', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }), limits: { maxFetchBytes: 20 } });
  await fx.addMedia({ id: 'm1', bytes: plan({ pad: 'x'.repeat(200) }), extra: { duration: 10 } });
  const started = await detect(fx, 'm1');
  const { error } = await settle(fx, 'm1');
  assert.equal(error.code, 'job-error');
  assert.match(error.message, /太大/);
  assert.equal((await ledger(fx, started.jobId)).errorCode, 'MEDIA_FETCH_FAILED');
  assert.equal(fx.readConfigCalls().some((c) => c.who === 'ffprobe'), false);
  assert.deepEqual(workFiles(fx), ['shots/jobs.json']);
});

test('文档服务联系不上:fail closed,回 503 级的「上游不可用」,不起任何东西;恢复后可用', async (t) => {
  const fx = await makeP1Fixture(t, { config: stubConfig(t, { python: false }) });
  await fx.addMedia({ id: 'm1', bytes: plan({ duration: 10 }), extra: { duration: 10 } });
  fx.setUnavailable(true);
  for (const call of [() => detect(fx, 'm1'), () => list(fx, 'm1')]) {
    await assert.rejects(call(), (e) => e.code === 'authority-unavailable' && e.status === 503);
  }
  assert.equal(fx.readConfigCalls().length, 0, '没起任何进程');
  fx.setUnavailable(false);
  assert.equal((await detect(fx, 'm1')).started, true);
  await settle(fx, 'm1');
});
