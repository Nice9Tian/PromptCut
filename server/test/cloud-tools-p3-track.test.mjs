/**
 * P3 包 · 云端 Agent 运动追踪四件套(track_status / track_install / track_points / get_track)。
 *
 * 真东西:ffmpeg 现造的视频、项目素材库的真字节与真哈希、F0 的 ToolJobs(真 SQLite)与 run-resources、
 * 工作区的受限子进程、真 Python 模板匹配。假的只有授权来源(受控桩)和素材服务的网络传输(进程内直连)。
 * 授权接真 run-authority 的那一份在 `cloud-tools-p3-authority.test.mjs`。
 *
 * 用例 P3-01～P3-07。Python 或 ffmpeg 不可用时整份 skip(不假绿)。
 * 跑:node --test server/test/cloud-tools-p3-track.test.mjs
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTrackResultStore, scrubPaths, TrackToolError } from '../agent/service/perception/track.mjs';
import { PYTHON_BOOTSTRAP, PYTHON_ISOLATED_FLAGS } from '../agent/service/perception/runner.mjs';
import {
  buildTrackEnv, contextOf, decodeGrayFrame, findTestRuntime, makeAccess, nccAt, pidAlive, PYTHON_PACKAGE_ROOT, untilTracked, waitFor, writeTrackVideo,
} from './cloud-tools-p3-kit.mjs';

const runtime = findTestRuntime();
const skip = runtime ? false : '没有可用的 Python(带 numpy)或 ffmpeg';
let shared = null;

before(async () => {
  if (!runtime) return;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-p3-video-'));
  const small = await writeTrackVideo(path.join(dir, 'small.mp4'), { ffmpeg: runtime.ffmpeg });
  // 够大够长,8 个点要追十几秒:取消、超时、关停三个用例要「还在跑」的作业
  const heavy = await writeTrackVideo(path.join(dir, 'heavy.mp4'), { ffmpeg: runtime.ffmpeg, width: 960, height: 540, frames: 240, x0: 100, y0: 100, vx: 2, vy: 1 });
  shared = { dir, small, heavy };
});
after(async () => { if (shared) await fsp.rm(shared.dir, { recursive: true, force: true }); });

const HEAVY_POINTS = (v) => Array.from({ length: 8 }, () => [0, v.truth[0][0], v.truth[0][1]]);
const asError = async (promise) => promise.then(() => null, (error) => error);
const deadChildren = (env) => env.spawns.every((s) => s.child.exitCode !== null || s.child.signalCode !== null);

async function started(env, ctx, mediaId, points, extra = {}) {
  const out = await env.tracks.call('track_points', { mediaId, points, ...extra }, ctx);
  assert.equal(out.ok, true);
  return out;
}

test('P3-01 真视频:状态如实、追出的轨迹对得上真值和真画面、作业与结果持久、子进程与临时文件收干净', { skip, timeout: 180_000 }, async (t) => {
  const env = await buildTrackEnv(t);
  const ctx = env.access.trust(contextOf());
  await env.addMedia('proj_a', 'm1', shared.small.file);

  // 状态:没权重 → 模板匹配兜底这一档 ready,BootsTAPIR 那一档不假称就绪;一个路径都不外露
  const status = await env.tracks.call('track_status', {}, ctx);
  assert.equal(status.ok, true);
  assert.equal(status.ready, false, 'ready 只说神经网络那一档');
  assert.equal(status.engine, 'template');
  assert.equal(status.model.exists, false);
  assert.equal(status.fallback.available, true);
  assert.equal(status.runtime.installed, true);
  const text = JSON.stringify(status);
  assert.ok(!text.includes(env.root) && !/[A-Za-z]:[\\/]/.test(text) && !text.includes('anaconda'), `状态里不该有路径:${text}`);

  const first = shared.small.truth[0];
  const kick = await started(env, ctx, 'm1', [[0, first[0], first[1]]]);
  assert.equal(kick.started, true);
  const { result: summary } = await untilTracked(env.tracks, ctx, 'm1');
  assert.equal(summary.engine, 'template');
  assert.equal(summary.frames, 60);
  assert.equal(summary.width, 320);
  assert.match(summary.engineNote, /模板匹配兜底/);
  assert.equal(summary.points[0].visibleFrames, 60);
  assert.ok(!('stale' in summary));

  // 轨迹对得上真值(逐帧,原始像素)
  const full = await env.tracks.call('get_track', { mediaId: 'm1', full: true }, ctx);
  const errors = full.points[0].xy.map((p, i) => Math.hypot(p[0] - shared.small.truth[i][0], p[1] - shared.small.truth[i][1]));
  assert.equal(errors.length, 60);
  assert.ok(Math.max(...errors) < 1.5, `最大误差 ${Math.max(...errors)} 像素`);
  assert.ok(full.points[0].visible.every(Boolean));

  // 对着真画面复核,不信追踪自己:从视频里解出第 0、30、59 帧,用第 0 帧的目标小块去跟轨迹给的位置比
  const frame0 = decodeGrayFrame(runtime.ffmpeg, shared.small.file, 0, 320, 200);
  const template = [];
  for (let y = -12; y <= 12; y += 1) for (let x = -12; x <= 12; x += 1) template.push(frame0[(first[1] + y) * 320 + first[0] + x]);
  for (const index of [0, 30, 59]) {
    const frame = decodeGrayFrame(runtime.ffmpeg, shared.small.file, index, 320, 200);
    const [x, y] = full.points[0].xy[index];
    assert.ok(nccAt(frame, 320, x, y, template, 25) > 0.85, `第 ${index} 帧轨迹位置上看不到目标`);
    const off = nccAt(frame, 320, x + 40, y, template, 25);
    assert.ok(off < 0.5, '换个位置就对不上了,说明复核是有分辨力的');
  }

  // 作业:done、进度满、产物引用;素材版本记在结果上
  const job = await env.jobs.get(ctx, kick.jobId);
  assert.equal(job.state, 'done');
  assert.equal(job.progress, 1);
  assert.deepEqual(job.outputRefs, [{ kind: 'track', id: kick.jobId }]);
  const read = await env.assets.openRead(ctx, 'm1');
  read.stream.destroy();
  await read.closed.catch(() => {});
  assert.equal(summary.mediaRev, read.mediaRev);

  // 临时文件和子进程都收了
  const ws = await env.workspace(ctx);
  assert.deepEqual(fs.readdirSync(path.join(ws.dir(), '.tmp')).filter((n) => n.startsWith('track-')), [], '素材副本用完即删');
  assert.ok(env.spawns.length >= 2);
  assert.ok(deadChildren(env));
  assert.ok(env.spawns.every((s) => !pidAlive(s.pid)));

  // 子进程的命令行:只有部署配置给的东西,没有模型给的字符串;环境变量不带服务自己的 PROMPTCUT_*
  const trackCall = env.spawns.find((s) => s.args.includes('track'));
  // 隔离模式起:包目录经引导代码递进去(不用 -m,也不靠 PYTHONPATH)
  assert.deepEqual(trackCall.args.slice(0, 10), [...PYTHON_ISOLATED_FLAGS, '-c', PYTHON_BOOTSTRAP, '1', PYTHON_PACKAGE_ROOT, 'promptcut_track']);
  assert.deepEqual(Object.keys(trackCall.options.env).filter((k) => /^PYTHON/i.test(k)), []);
  assert.ok(trackCall.args.includes('--max-frames'));

  // 同样的请求是幂等的;force 才开新作业
  const again = await env.tracks.call('track_points', { mediaId: 'm1', points: [[0, first[0], first[1]]] }, ctx);
  assert.equal(again.started, false);
  assert.equal(again.jobId, kick.jobId);
  assert.equal(env.spawns.filter((s) => s.args.includes('track')).length, 1, '幂等重试不再起 Python');

  // 重开提供者和结果表(模拟服务重启):轨迹还在,按项目 × 对话 × 素材读得到
  await env.tracks.close('restart');
  const reopened = env.openTracks();
  const again2 = await reopened.call('get_track', { mediaId: 'm1', full: true }, ctx);
  assert.deepEqual(again2.points, full.points);
  const forced = await reopened.call('track_points', { mediaId: 'm1', points: [[0, first[0], first[1]]], force: true }, ctx);
  assert.equal(forced.started, true);
  assert.notEqual(forced.jobId, kick.jobId);
  await untilTracked(reopened, ctx, 'm1');
  const latest = await reopened.readResult(ctx, { mediaId: 'm1' });
  assert.equal(latest.jobId, forced.jobId, '读到的是最近一次');
  await reopened.close('end');
  await env.close();
});

test('P3-02 失败各例:非视频、没有的素材、解不开的字节;报错不带服务器路径', { skip, timeout: 180_000 }, async (t) => {
  const env = await buildTrackEnv(t, { readProject: null });
  const ctx = env.access.trust(contextOf());
  await env.addMedia('proj_a', 'song', Buffer.from('not video, just a sound'), { kind: 'audio', ext: 'mp3' });
  await env.addMedia('proj_a', 'junk', Buffer.from('this is definitely not an mp4 file at all, but it is long enough to be read'), { kind: 'video', ext: 'mp4' });

  const wait = async (mediaId) => asError(untilTracked(env.tracks, ctx, mediaId, { timeoutMs: 60_000 }));

  // 音频素材:作业失败,原因明确
  await started(env, ctx, 'song', [[0, 10, 10]]);
  const notVideo = await wait('song');
  assert.ok(notVideo instanceof TrackToolError, String(notVideo));
  assert.equal(notVideo.code, 'TRACK_NOT_VIDEO');
  assert.equal(notVideo.errorCode, 'TRACK_NOT_VIDEO');

  // 项目里没有这个素材(素材服务 404)
  await started(env, ctx, 'ghost', [[0, 10, 10]]);
  const missing = await wait('ghost');
  assert.equal(missing.code, 'TRACK_MEDIA_MISSING');

  // 字节不是视频:Python 真的跑了、真的失败了,错误里不带路径
  const jobBefore = env.spawns.length;
  await started(env, ctx, 'junk', [[0, 10, 10]]);
  const junk = await wait('junk');
  assert.equal(junk.code, 'TRACK_FAILED');
  assert.ok(env.spawns.length > jobBefore, 'Python 确实起来过');
  assert.ok(!junk.message.includes(env.root) && !/[A-Za-z]:[\\/]/.test(junk.message), `报错里不该有路径:${junk.message}`);
  assert.equal(env.tracks.results.latestRun({ projectId: 'proj_a', conversationId: 'conv_a', kind: 'track', mediaId: 'junk' }) !== null, true);
  assert.equal(env.tracks.results.result((env.tracks.results.latestRun({ projectId: 'proj_a', conversationId: 'conv_a', kind: 'track', mediaId: 'junk' })).jobId), null, '失败的作业没有结果');

  // 状态失败的作业回到 get_track:error 形状(抛),read 路径同样拒绝
  const readError = await asError(env.tracks.readResult(ctx, { mediaId: 'junk' }));
  assert.equal(readError.code, 'TRACK_FAILED');
  assert.ok(deadChildren(env));
  await env.close();
});

test('P3-03 取消、超时、关停、崩溃重启:子进程真的退出,不留结果,作业状态如实', { skip, timeout: 240_000 }, async (t) => {
  const heavy = shared.heavy;
  const points = HEAVY_POINTS(heavy);

  await t.test('超时:作业被停、记 TRACK_TIMEOUT,子进程退出,没有结果', async (tt) => {
    const env = await buildTrackEnv(tt, { limits: { jobTimeoutMs: 1500 } });
    const ctx = env.access.trust(contextOf());
    await env.addMedia('proj_a', 'big', heavy.file);
    const kick = await started(env, ctx, 'big', points);
    const failure = await asError(untilTracked(env.tracks, ctx, 'big', { timeoutMs: 90_000 }));
    assert.equal(failure.code, 'TRACK_TIMEOUT');
    assert.match(failure.message, /超过了时限/);
    const python = env.spawns.find((s) => s.args.includes('track'));
    await waitFor(() => !pidAlive(python.pid), { what: 'Python 退出' });
    assert.equal(env.tracks.results.result(kick.jobId), null);
    assert.equal((await env.jobs.get(ctx, kick.jobId)).state, 'error');
    await env.close();
  });

  await t.test('取消(fence 变了):资源表杀掉子进程,作业记 RUN_CANCELLED,没有结果,临时文件删净', async (tt) => {
    const env = await buildTrackEnv(tt);
    const ctx = env.access.trust(contextOf());
    await env.addMedia('proj_a', 'big', heavy.file);
    const kick = await started(env, ctx, 'big', points);
    const python = await waitFor(() => env.spawns.find((s) => s.args.includes('track')), { what: '追踪子进程起来' });
    assert.ok(pidAlive(python.pid));
    await waitFor(async () => (await env.jobs.get(ctx, kick.jobId)).stage === 'track', { timeoutMs: 60_000, what: '作业进入追踪阶段(Python 已解完码、开始逐点追)' });
    const first = await env.resources.abortForFence(ctx, 'stop');
    assert.equal(first.reason, 'stop');
    const failure = await asError(untilTracked(env.tracks, ctx, 'big', { timeoutMs: 60_000 }));
    assert.equal(failure.errorCode, 'RUN_CANCELLED');
    assert.equal((await env.jobs.get(ctx, kick.jobId)).state, 'cancelled');
    assert.equal(pidAlive(python.pid), false, 'Python 进程已经退出');
    const receipt = await env.resources.abortForFence(ctx, 'stop');
    assert.equal(receipt.childrenOpen, 0, '资源表上再没有没 close 的子进程');
    assert.equal(receipt.streamsOpen, 0);
    assert.equal(env.tracks.results.result(kick.jobId), null, '取消后不留迟到的产物');
    const ws = await env.workspace(ctx);
    assert.deepEqual(fs.readdirSync(path.join(ws.dir(), '.tmp')).filter((n) => n.startsWith('track-')), []);
    // 被 fence 的任务再起追踪:登记资源就被拒,不会再起子进程
    const after = await asError(env.tracks.call('track_points', { mediaId: 'big', points: [[0, 1, 1]], force: true }, ctx));
    assert.equal(after, null, '起作业本身不碰资源表;作业随后失败');
    const second = await asError(untilTracked(env.tracks, ctx, 'big', { timeoutMs: 60_000 }));
    assert.equal(second.errorCode, 'RUN_CANCELLED');
    await env.close();
  });

  await t.test('关停:close() 杀掉子进程、等到 close 事件才回执,作业记 interrupted', async (tt) => {
    const env = await buildTrackEnv(tt);
    const ctx = env.access.trust(contextOf());
    await env.addMedia('proj_a', 'big', heavy.file);
    const kick = await started(env, ctx, 'big', points);
    const python = await waitFor(() => env.spawns.find((s) => s.args.includes('track')), { what: '追踪子进程起来' });
    const receipt = await env.tracks.close('shutdown');
    assert.equal(receipt.childrenClosed, true);
    assert.equal(receipt.workPending, 0);
    assert.equal(pidAlive(python.pid), false);
    const job = await env.jobs.get(ctx, kick.jobId);
    assert.equal(job.state, 'interrupted');
    assert.equal(job.errorCode, 'PROVIDER_CLOSED');
    const refused = await asError(env.tracks.call('get_track', { mediaId: 'big' }, ctx));
    assert.equal(refused.code, 'TRACK_CLOSED');
    await env.jobs.close();
    await env.resources.close();
    await env.assets.close();
  });

  await t.test('崩溃重启:作业表还停在 running 的,重开后是 interrupted;模型被告知用 force 重追', async (tt) => {
    const env = await buildTrackEnv(tt);
    const ctx = env.access.trust(contextOf());
    await env.addMedia('proj_a', 'big', heavy.file);
    const kick = await started(env, ctx, 'big', points);
    const python = await waitFor(() => env.spawns.find((s) => s.args.includes('track')), { what: '追踪子进程起来' });
    await waitFor(async () => (await env.jobs.get(ctx, kick.jobId)).state === 'running', { what: '作业 running' });
    // 先关作业库再关提供者:runner 收尾时写不进去,作业行原样停在 running,就像进程被直接杀了
    await env.jobs.close();
    await env.tracks.close('crash');
    assert.equal(pidAlive(python.pid), false);
    await env.resources.close();
    await env.assets.close();

    const { createToolJobs } = await import('../agent/service/tool-jobs.mjs');
    const jobs2 = createToolJobs({ databasePath: env.jobsPath, authorize: env.access.authorize, verifyFence: env.access.verifyFence });
    const tracks2 = (await import('../agent/service/perception/track.mjs')).createTrackTools({
      contextAccess: { authorize: env.access.authorize }, resources: env.resources, jobs: jobs2, assets: env.assets,
      workspace: env.workspace, databasePath: env.resultsPath, python: env.pythonConfig,
    });
    const job = await jobs2.get(ctx, kick.jobId);
    assert.equal(job.state, 'interrupted');
    assert.equal(job.errorCode, 'INTERRUPTED_ON_RESTART');
    const failure = await asError(tracks2.call('get_track', { mediaId: 'big' }, ctx));
    assert.equal(failure.errorCode, 'INTERRUPTED_ON_RESTART');
    assert.match(failure.message, /force:true/);
    await tracks2.close('end');
    await jobs2.close();
  });
});

test('P3-04 没装模型或依赖时的回应:每一种缺都说得清,没有「假就绪」', { skip, timeout: 240_000 }, async (t) => {
  await t.test('节点没配 Python:状态 engine 为 null,追踪与安装各回原因', async (tt) => {
    const env = await buildTrackEnv(tt, { python: null });
    const ctx = env.access.trust(contextOf());
    const status = await env.tracks.call('track_status', {}, ctx);
    assert.equal(status.ready, false);
    assert.equal(status.engine, null);
    assert.match(status.reason, /没有配置/);
    const err = await asError(env.tracks.call('track_points', { mediaId: 'm', points: [[0, 1, 1]] }, ctx));
    assert.equal(err.code, 'TRACK_UNCONFIGURED');
    const install = await env.tracks.call('track_install', {}, ctx);
    assert.equal(install.ok, false);
    assert.equal(install.cloudUnavailable, true);
    assert.equal(install.code, 'TRACK_INSTALL_DISABLED');
    assert.equal(env.spawns.length, 0, '什么进程都没起');
    await env.close();
  });

  await t.test('解释器路径不对:状态说解释器起不来,作业 TRACK_ENGINE_UNAVAILABLE', async (tt) => {
    const env = await buildTrackEnv(tt, { python: { executable: path.join(os.tmpdir(), 'pc-no-such-dir', 'python.exe'), packageRoot: path.join(os.tmpdir(), 'pc-no-such-dir') } });
    const ctx = env.access.trust(contextOf());
    const status = await env.tracks.call('track_status', {}, ctx);
    assert.equal(status.engine, null);
    assert.match(status.reason, /解释器启动失败/);
    await env.addMedia('proj_a', 'm1', shared.small.file);
    await started(env, ctx, 'm1', [[0, 60, 70]]);
    const failure = await asError(untilTracked(env.tracks, ctx, 'm1'));
    assert.equal(failure.code, 'TRACK_ENGINE_UNAVAILABLE');
    assert.match(failure.message, /解释器起不来/);
    await env.close();
  });

  await t.test('numpy 缺失(包路径前面放一个导入就报错的桩):两档都用不了,追踪作业说缺什么', async (tt) => {
    // numpy 是包自己 import 的基础依赖:桩要排在包路径前面(部署配置的 packageRoot 里靠前的一项),放进 --pylibs 来不及(包已经先 import 了真的)
    const stubRoot = path.join(os.tmpdir(), `pc-p3-nonumpy-${process.pid}`);
    fs.mkdirSync(path.join(stubRoot, 'numpy'), { recursive: true });
    fs.writeFileSync(path.join(stubRoot, 'numpy', '__init__.py'), "raise ImportError('numpy 没装(测试桩)')\n");
    tt.after(() => fs.rmSync(stubRoot, { recursive: true, force: true }));
    const base = await buildTrackEnv(tt);
    const env = await buildTrackEnv(tt, { python: { ...base.pythonConfig, packageRoot: `${stubRoot}${path.delimiter}${base.pythonConfig.packageRoot}` } });
    const ctx = env.access.trust(contextOf());
    const status = await env.tracks.call('track_status', {}, ctx);
    assert.equal(status.ready, false);
    assert.equal(status.engine, null);
    assert.match(status.reason, /numpy/);
    assert.ok(!status.reason.includes(stubRoot), '原因里不带路径');
    assert.match(status.hint, /联系托管方/);
    await env.addMedia('proj_a', 'm1', shared.small.file);
    await started(env, ctx, 'm1', [[0, 60, 70]]);
    const failure = await asError(untilTracked(env.tracks, ctx, 'm1'));
    assert.equal(failure.code, 'TRACK_ENGINE_UNAVAILABLE');
    assert.match(failure.message, /numpy/);
    assert.equal(env.tracks.results.result(failure.jobId), null);
    await env.close();
  });

  await t.test('权重文件在、依赖不全:状态只说 BootsTAPIR 档「就绪」是看权重在不在;真去追就如实失败,不假装成功', async (tt) => {
    const env = await buildTrackEnv(tt);
    fs.mkdirSync(path.join(env.root, 'models'), { recursive: true });
    fs.writeFileSync(path.join(env.root, 'models', 'bootstapir_v2.pt'), 'not a real weight file');
    const ctx = env.access.trust(contextOf());
    const status = await env.tracks.call('track_status', {}, ctx);
    assert.equal(status.model.exists, true);
    assert.equal(status.engine, 'bootstapir');
    assert.equal(status.ready, true);
    await env.addMedia('proj_a', 'm1', shared.small.file);
    await started(env, ctx, 'm1', [[0, 60, 70]]);
    const failure = await asError(untilTracked(env.tracks, ctx, 'm1', { timeoutMs: 90_000 }));
    assert.equal(failure.code, 'TRACK_FAILED', '权重是假的,追踪必须失败');
    assert.equal(env.tracks.results.result(failure.jobId), null);
    await env.close();
  });

  await t.test('安装:默认不开放;部署者开了才是受控的锁定清单,模型给的参数一个也进不了命令行', async (tt) => {
    const requirements = path.join(os.tmpdir(), `pc-p3-req-${process.pid}.txt`);
    fs.writeFileSync(requirements, '# 锁定清单(测试里是空的,不联网)\n');
    tt.after(() => fs.rmSync(requirements, { force: true }));
    const closedEnv = await buildTrackEnv(tt);
    const ctx = closedEnv.access.trust(contextOf());
    const refused = await closedEnv.tracks.call('track_install', { requirements: 'evil.txt', args: ['--index-url', 'http://evil.example'] }, ctx);
    assert.equal(refused.code, 'TRACK_INSTALL_DISABLED');
    assert.equal(closedEnv.spawns.length, 0);
    await closedEnv.close();

    const env = await buildTrackEnv(tt);
    const python = { ...env.pythonConfig, requirements };
    const ctx2 = env.access.trust(contextOf({ conversationId: 'conv_i' }));
    // 开了安装但节点没给出网闸、部署者也没声明节点层管着出网:不装,说明原因,不起进程
    const noGate = env.openTracks({ python, install: { enabled: true } });
    const ungated = await noGate.call('track_install', {}, ctx2);
    assert.equal(ungated.code, 'TRACK_INSTALL_NO_EGRESS');
    assert.equal(env.spawns.length, 0);
    // 给了出网闸:pip 子进程的代理指向闸起的回环代理,装完闸起的代理被关
    const proxyLog = [];
    const egress = { async startProxy() { proxyLog.push('start'); return { url: 'http://127.0.0.1:9', async close() { proxyLog.push('close'); } }; } };
    const tracks = env.openTracks({ python, install: { enabled: true }, egress });
    const out = await tracks.call('track_install', { requirements: 'evil.txt', args: ['--index-url', 'http://evil.example'], pip: 'x' }, ctx2);
    assert.equal(out.started, true);
    const duplicate = await tracks.call('track_install', {}, ctx2);
    assert.equal(duplicate.started, false, '不重复启动');
    const done = await waitFor(async () => {
      const s = await tracks.call('track_status', {}, ctx2);
      return s.install?.state === 'done' ? s : false;
    }, { timeoutMs: 120_000, what: '安装作业完成' });
    assert.equal(done.install.needsModel, true, '依赖装好了但权重还缺:如实说');
    assert.equal(done.engine, 'template');
    const argv = env.spawns.find((s) => s.args.includes('install')).args;
    assert.deepEqual(argv.filter((a) => a !== requirements && !a.startsWith(env.root) && a !== runtime.ffmpeg),
      [...PYTHON_ISOLATED_FLAGS, '-c', PYTHON_BOOTSTRAP, '1', PYTHON_PACKAGE_ROOT, 'promptcut_track', '--pylibs', '--models', '--ffmpeg', '--requirements', 'install']);
    assert.ok(!argv.some((a) => /evil|index-url/.test(a)));
    const installEnv = env.spawns.find((s) => s.args.includes('install')).options.env;
    assert.equal(installEnv.HTTPS_PROXY, 'http://127.0.0.1:9');
    assert.equal(installEnv.NO_PROXY, '');
    assert.deepEqual(proxyLog, ['start', 'close'], '出网闸的代理起一次、用完关');
    assert.ok(fs.existsSync(path.join(env.root, 'pylibs')), 'pip --target 的目录是部署配置给的那个');
    await tracks.close('end');
    await env.close();
  });
});

test('P3-05 授权与隔离:只读、撤权、伪造上下文、跨对话、跨项目、素材换版', { skip, timeout: 240_000 }, async (t) => {
  let mediaHash = null;
  const env = await buildTrackEnv(t, { readProject: async () => ({ media: [{ id: 'm1', kind: 'video', hash: mediaHash }] }) });
  const ctxA = env.access.trust(contextOf());
  const ctxOtherConversation = env.access.trust(contextOf({ conversationId: 'conv_b', runId: 'run_b', runGrantId: 'grant_b' }));
  const ctxOtherProject = env.access.trust(contextOf({ projectId: 'proj_c', runGrantId: 'grant_c' }));
  const media = await env.addMedia('proj_a', 'm1', shared.small.file);
  mediaHash = media.hash;
  await env.addMedia('proj_c', 'm9', shared.small.file);

  // 只读成员:读得到(没追过),起不了作业;撤权后读也不行
  env.access.state.writeAllowed = false;
  const readOnly = await asError(env.tracks.call('track_points', { mediaId: 'm1', points: [[0, 60, 70]] }, ctxA));
  assert.equal(readOnly.code, 'run-access-denied');
  assert.deepEqual(await env.tracks.call('get_track', { mediaId: 'm1' }, ctxA), { ok: true, found: false, mediaId: 'm1', hint: 'm1 还没追过,先调 track_points' });
  assert.equal((await env.tracks.call('track_status', {}, ctxA)).ok, true);
  env.access.state.writeAllowed = true;
  assert.equal(env.spawns.filter((s) => s.args.includes('track')).length, 0, '被拒的请求没有起 Python');

  // 伪造上下文(换了一个字段):四个工具都拒
  const forged = { ...ctxA, runId: 'run_forged' };
  for (const [tool, args] of [['track_status', {}], ['track_install', {}], ['track_points', { mediaId: 'm1', points: [[0, 1, 1]] }], ['get_track', { mediaId: 'm1' }]]) {
    const err = await asError(env.tracks.call(tool, args, forged));
    assert.equal(err?.code, 'tool-context-untrusted', tool);
  }

  // 在 A 项目 A 对话里追一次
  const kick = await started(env, ctxA, 'm1', [[0, shared.small.truth[0][0], shared.small.truth[0][1]]]);
  await untilTracked(env.tracks, ctxA, 'm1');

  // 同项目另一个对话:看不到(读不到状态,也读不到轨迹)
  assert.equal((await env.tracks.call('get_track', { mediaId: 'm1' }, ctxOtherConversation)).found, false);
  assert.equal((await asError(env.tracks.readResult(ctxOtherConversation, { mediaId: 'm1' }))).code, 'TRACK_NONE');
  // 另一个项目:看不到;它也追不了 A 项目的素材(素材库按项目分开)
  assert.equal((await env.tracks.call('get_track', { mediaId: 'm1' }, ctxOtherProject)).found, false);
  await started(env, ctxOtherProject, 'm1', [[0, 60, 70]]);
  const crossProject = await asError(untilTracked(env.tracks, ctxOtherProject, 'm1'));
  assert.equal(crossProject.code, 'TRACK_MEDIA_MISSING');
  // 作业表自己的隔离也在:别的对话拿不到 A 的作业
  const crossJob = await asError(env.jobs.get(ctxOtherConversation, kick.jobId));
  assert.equal(crossJob.code, 'job-not-found');
  // 结果表按范围取
  assert.equal(env.tracks.results.run(kick.jobId, 'proj_a', 'conv_b'), null);
  assert.equal(env.tracks.results.run(kick.jobId, 'proj_c', 'conv_a'), null);
  assert.ok(env.tracks.results.run(kick.jobId, 'proj_a', 'conv_a'));

  // 素材换版:项目里这段素材的哈希变了,get_track 标出过期,attach 的读口照样给出 mediaHash 让下游对账
  const fresh = await env.tracks.call('get_track', { mediaId: 'm1' }, ctxA);
  assert.equal('stale' in fresh, false);
  mediaHash = 'f'.repeat(64);
  const stale = await env.tracks.call('get_track', { mediaId: 'm1' }, ctxA);
  assert.equal(stale.stale, true);
  assert.match(stale.staleReason, /换过了/);
  assert.equal((await env.tracks.readResult(ctxA, { mediaId: 'm1' })).mediaHash, media.hash);

  // 撤权:读也拒,而且拒在碰作业表和结果之前
  env.access.state.readAllowed = false;
  assert.equal((await asError(env.tracks.call('get_track', { mediaId: 'm1' }, ctxA))).code, 'run-access-denied');
  assert.equal((await asError(env.tracks.readResult(ctxA, { mediaId: 'm1' }))).code, 'run-access-denied');
  env.access.state.readAllowed = true;
  await env.close();
});

test('P3-06 参数校验:坏点、过多、负数、缺 mediaId 在起任何进程之前就拒;多余的参数一概不看', { skip, timeout: 120_000 }, async (t) => {
  const env = await buildTrackEnv(t, { limits: { maxPoints: 3 }, readProject: async () => ({ media: [{ id: 'm1', kind: 'video' }, { id: 'aud', kind: 'audio', name: '旁白' }] }) });
  const ctx = env.access.trust(contextOf());
  const bad = async (args) => (await asError(env.tracks.call('track_points', args, ctx)));
  assert.equal((await bad({ points: [[0, 1, 1]] })).code, 'TRACK_BAD_ARGS');
  assert.equal((await bad({ mediaId: '../etc/passwd', points: [[0, 1, 1]] })).code, 'TRACK_BAD_ARGS');
  assert.equal((await bad({ mediaId: 'm1' })).code, 'TRACK_BAD_POINTS');
  assert.equal((await bad({ mediaId: 'm1', points: [] })).code, 'TRACK_BAD_POINTS');
  assert.equal((await bad({ mediaId: 'm1', points: [[0, 1]] })).code, 'TRACK_BAD_POINTS');
  assert.equal((await bad({ mediaId: 'm1', points: [[0, 1, '2']] })).code, 'TRACK_BAD_POINTS');
  assert.equal((await bad({ mediaId: 'm1', points: [[0, Infinity, 2]] })).code, 'TRACK_BAD_POINTS');
  assert.equal((await bad({ mediaId: 'm1', points: [[0, -1, 2]] })).code, 'TRACK_BAD_POINTS');
  assert.match((await bad({ mediaId: 'm1', points: [[0, 1, 1], [0, 2, 2], [0, 3, 3], [0, 4, 4]] })).message, /最多追 3 个点/);
  assert.equal((await bad({ mediaId: 'nope', points: [[0, 1, 1]] })).code, 'TRACK_MEDIA_NOT_FOUND');
  assert.equal((await bad({ mediaId: 'aud', points: [[0, 1, 1]] })).code, 'TRACK_NOT_VIDEO');
  assert.equal((await asError(env.tracks.call('get_track', {}, ctx))).code, 'TRACK_BAD_ARGS');
  assert.equal((await asError(env.tracks.call('detect_shots', {}, ctx))).code, 'TRACK_UNKNOWN_TOOL');
  assert.equal(env.spawns.length, 0, '以上全部在起进程之前就拒了');
  assert.equal(env.tracks.handles.has('track_points'), true);
  assert.deepEqual([...env.tracks.handles].sort(), ['get_track', 'track_install', 'track_points', 'track_status']);

  // 多余的参数(路径、解释器、命令)一概不看
  await env.addMedia('proj_a', 'm1', shared.small.file);
  await started(env, ctx, 'm1', [[0, shared.small.truth[0][0], shared.small.truth[0][1]]], { video: 'C:/Windows/win.ini', path: '/etc/passwd', python: 'evil.exe', args: ['--index-url', 'x'] });
  await untilTracked(env.tracks, ctx, 'm1');
  const call = env.spawns.find((s) => s.args.includes('track'));
  assert.ok(!call.args.some((a) => /win\.ini|passwd|evil|index-url/.test(a)));
  await env.close();
});

test('P3-07 结果表:换了一个路径只能读到自己写的;关闭后拒绝;范围外读不到', { skip: false }, async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-p3-store-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's', 'r.db');
  const store = createTrackResultStore({ databasePath: file });
  assert.equal(store.registerRun({ jobId: 'job_1', kind: 'track', projectId: 'p', conversationId: 'c', mediaId: 'm', pointCount: 1 }), true);
  assert.equal(store.registerRun({ jobId: 'job_1', kind: 'track', projectId: 'p', conversationId: 'c', mediaId: 'm', pointCount: 1 }), false, '重复登记是幂等的');
  store.saveResult('job_1', { width: 4, height: 4, frames: 2, points: [{ query: [0, 1, 1], xy: [[1, 1], [2, 2]], visible: [true, true] }] });
  assert.equal(store.result('job_1').frames, 2);
  assert.equal(store.latestRun({ projectId: 'p', conversationId: 'c', kind: 'track', mediaId: 'm' }).jobId, 'job_1');
  assert.equal(store.latestRun({ projectId: 'p', conversationId: 'other', kind: 'track', mediaId: 'm' }), null);
  store.dropResult('job_1');
  assert.equal(store.result('job_1'), null);
  store.close();
  assert.throws(() => store.result('job_1'), (e) => e.code === 'TRACK_CLOSED');
  assert.throws(() => createTrackResultStore({ databasePath: ':memory:' }), (e) => e.code === 'TRACK_UNCONFIGURED');
  // 报错里的服务器路径一律抹掉(Windows 盘符和 POSIX 路径)
  assert.equal(scrubPaths(String.raw`找不到视频文件：C:\Users\x\work\a.mp4 之后 see /home/u/work/a.mp4 now`), '找不到视频文件：<路径> 之后 see <路径> now');
  assert.equal(scrubPaths('no path here, just 1/2 and a/b'), 'no path here, just 1/2 and a/b');
  // 重开,数据还在
  const again = createTrackResultStore({ databasePath: file });
  assert.equal(again.run('job_1', 'p', 'c').mediaId, 'm');
  again.close();
});

test('P3-08 上一代进程留下的排队作业(登记了、没来得及起 runner 就崩了):读到的是中断,重试时记成 interrupted,force 重追', { skip, timeout: 120_000 }, async (t) => {
  const { createHash } = await import('node:crypto');
  const env = await buildTrackEnv(t);
  const ctx = env.access.trust(contextOf());
  await env.addMedia('proj_a', 'm1', shared.small.file);
  const points = [[0, 60, 70]];
  const digest = createHash('sha256').update(JSON.stringify({ mediaId: 'm1', points })).digest('hex');
  // 模拟崩溃:作业表和结果表都登记了,但没有 runner
  const orphan = await env.jobs.start(ctx, 'track.points', digest, `trk-${digest.slice(0, 32)}`);
  env.tracks.results.registerRun({ jobId: orphan.jobId, kind: 'track', projectId: ctx.projectId, conversationId: ctx.conversationId, mediaId: 'm1', pointCount: 1 });
  assert.equal(orphan.state, 'queued');

  const read = await asError(env.tracks.call('get_track', { mediaId: 'm1' }, ctx));
  assert.equal(read.errorCode, 'INTERRUPTED_ON_RESTART');
  assert.match(read.message, /force:true/);
  assert.equal((await env.jobs.get(ctx, orphan.jobId)).state, 'queued', '读不写作业表');
  assert.equal((await asError(env.tracks.readResult(ctx, { mediaId: 'm1' }))).errorCode, 'INTERRUPTED_ON_RESTART');

  const retry = await env.tracks.call('track_points', { mediaId: 'm1', points }, ctx);
  assert.equal(retry.started, false);
  assert.equal(retry.state, 'interrupted');
  assert.equal(retry.jobId, orphan.jobId);
  assert.equal((await env.jobs.get(ctx, orphan.jobId)).state, 'interrupted');
  assert.equal(env.spawns.length, 0, '没有为僵尸作业起 Python');

  const forced = await env.tracks.call('track_points', { mediaId: 'm1', points, force: true }, ctx);
  assert.equal(forced.started, true);
  await untilTracked(env.tracks, ctx, 'm1');
  assert.equal((await env.tracks.readResult(ctx, { mediaId: 'm1' })).jobId, forced.jobId);
  await env.close();
});
