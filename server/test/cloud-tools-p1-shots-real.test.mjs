// P1 镜头识别的真东西测试:真 ffmpeg / ffprobe、真 Python 包 promptcut_shots、真 TransNetV2 权重、现造的有已知硬切的视频。
// 底座同 cloud-tools-p1-shots.test.mjs(真的运行权限 / run-resources / tool-jobs / project-assets / 工作区,项目一侧是内存替身)。
// 没有 ffmpeg 时整份 skip;没有装了 onnxruntime 的 Python 或权重时,只 skip 模型档那几条(不假绿)。
// 环境变量(都有缺省,按这台机器写的;换机器用环境变量):
//   PROMPTCUT_P1_PYTHON   装了 onnxruntime 与 numpy 的解释器
//   PROMPTCUT_P1_PLAIN_PYTHON  一个没装 onnxruntime 的解释器(演示「没装依赖」)
//   PROMPTCUT_P1_MODELS   权重目录(里面是 transnetv2.onnx)
// 跑:npm test -- server/test/cloud-tools-p1-shots-real.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeP1Fixture, tmpDir } from './cloud-tools-p1-fixture.mjs';
import { freePort } from './free-ports.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = os.homedir();
const run = (cmd, args, opt = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, ...opt });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFfmpeg() {
  if (process.env.PROMPTCUT_FFMPEG && fs.existsSync(process.env.PROMPTCUT_FFMPEG)) return process.env.PROMPTCUT_FFMPEG;
  const r = run(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']);
  const first = r.stdout?.split(/\r?\n/).find(Boolean)?.trim();
  return first && fs.existsSync(first) ? first : null;
}
const ffmpeg = findFfmpeg();
const ext = path.extname(ffmpeg ?? '');
const ffprobe = ffmpeg ? path.join(path.dirname(ffmpeg), `ffprobe${ext}`) : null;
const skipAll = ffmpeg && fs.existsSync(ffprobe) ? false : '没有 ffmpeg / ffprobe';

const hasOnnx = (py) => py && fs.existsSync(py) && run(py, ['-I', '-c', 'import onnxruntime, numpy']).status === 0;
const pythonCandidates = [process.env.PROMPTCUT_P1_PYTHON, path.join(home, 'anaconda3', 'envs', 'cuda_Vit', 'python.exe'), 'python3'].filter(Boolean);
const python = pythonCandidates.find(hasOnnx) ?? null;
const plainCandidates = [process.env.PROMPTCUT_P1_PLAIN_PYTHON, path.join(home, 'anaconda3', 'python.exe'), 'python', 'python3'].filter(Boolean);
const plainPython = plainCandidates.find((p) => (p.includes(path.sep) ? fs.existsSync(p) : true) && run(p, ['-I', '-c', 'import sys']).status === 0 && !hasOnnx(p)) ?? null;
const modelsCandidates = [process.env.PROMPTCUT_P1_MODELS, path.join(ROOT, 'out', 'models'), path.join(ROOT, '..', '..', 'out', 'models')].filter(Boolean);
const models = modelsCandidates.find((d) => fs.existsSync(path.join(d, 'transnetv2.onnx'))) ?? null;
const skipModel = skipAll || (python && models ? false : '没有装了 onnxruntime 的 Python 或 transnetv2.onnx 权重');
const skipPlain = skipAll || (plainPython && models ? false : '没有不带 onnxruntime 的 Python');

/** 三段不同画面拼成一段:切点在 3.0 秒与 6.6 秒(按帧数算准:75 帧、90 帧、50 帧,25fps) */
const CUTS = [3.0, 6.6];
const DURATION = 8.6;
function makeCutsVideo(dir) {
  const out = path.join(dir, 'cuts.mp4');
  const r = run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3',
    '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=25:duration=3.6',
    '-f', 'lavfi', '-i', 'rgbtestsrc=size=640x360:rate=25:duration=2',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', out]);
  assert.equal(r.status, 0, r.stderr);
  return out;
}

const realConfig = ({ withPython = false, py = python, modelsDir = models } = {}) => ({
  ffmpeg, ffprobe, ffmpegDir: path.dirname(ffmpeg),
  ...(withPython ? { python: py, modelsDir, pythonPath: path.join(ROOT, 'python') } : {}),
});

async function settle(fx, mediaId, ms = 120_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const r = await fx.tools.call('list_shots', { mediaId }, fx.context); if (!r?.running) return { result: r }; } catch (error) { return { error }; }
    if (Date.now() > end) throw new Error('作业一直没结束');
    await sleep(100);
  }
}

/** 每个检出的切点配最近的真值,回最大误差(秒);个数对不上回 Infinity */
function maxError(found, truth) {
  if (found.length !== truth.length) return Infinity;
  return Math.max(...truth.map((t, i) => Math.abs(found[i] - t)));
}

test('真 ffmpeg scdet 档:现造三段画面的视频,检出的硬切与真值差不到一帧;结果写进项目,list_shots 读得回来', { skip: skipAll, timeout: 180_000 }, async (t) => {
  const work = tmpDir('pc-p1-real-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const video = makeCutsVideo(work);
  const fx = await makeP1Fixture(t, { config: realConfig() });
  await fx.addMedia({ id: 'cuts', name: 'cuts.mp4', bytes: fs.readFileSync(video), extra: { duration: DURATION } });
  const started = await fx.tools.call('detect_shots', { mediaId: 'cuts' }, fx.context);
  assert.equal(started.engine, 'scdet');
  const { result, error } = await settle(fx, 'cuts');
  assert.equal(error, undefined);
  assert.equal(result.engine, 'scdet');
  const found = result.transitions.map((x) => x.time);
  const err = maxError(found, CUTS);
  console.log(`  scdet 检出 ${JSON.stringify(found)},真值 ${JSON.stringify(CUTS)},最大误差 ${err.toFixed(3)} 秒`);
  assert.ok(err <= 0.04, `误差 ${err} 秒,超过一帧`);
  assert.deepEqual(result.transitions.map((x) => x.kind), ['cut', 'cut']);
  assert.equal(result.shots.length, 3);
  assert.ok(Math.abs(result.shots.at(-1).end - DURATION) < 0.05, '最后一个镜头收在片尾');
  // 项目里真的写进了
  assert.equal(fx.commits.length, 1);
  assert.equal(fx.projects.get(fx.context.projectId).get('cuts').shots.engine, 'scdet');
  assert.equal((await fx.jobs.get(fx.context, started.jobId)).state, 'done');
  assert.deepEqual(fx.ws.list().map((f) => f.path), ['shots/jobs.json'], '临时素材删净');
});

test('真 TransNetV2 档(真 Python、真权重):检出的硬切与真值对上', { skip: skipModel, timeout: 240_000 }, async (t) => {
  const work = tmpDir('pc-p1-real-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const video = makeCutsVideo(work);
  const fx = await makeP1Fixture(t, { config: realConfig({ withPython: true }) });
  await fx.addMedia({ id: 'cuts', name: 'cuts.mp4', bytes: fs.readFileSync(video), extra: { duration: DURATION } });
  const status = await fx.tools.status(fx.context);
  assert.equal(status.engine, 'transnetv2', JSON.stringify(status));
  assert.doesNotMatch(JSON.stringify(status), /anaconda|out[\\/]models/, '节点路径不回给模型');
  const started = await fx.tools.call('detect_shots', { mediaId: 'cuts' }, fx.context);
  assert.equal(started.engine, 'transnetv2');
  const { result, error } = await settle(fx, 'cuts');
  assert.equal(error, undefined);
  assert.equal(result.engine, 'transnetv2');
  assert.equal(result.fellBackFrom, undefined, '没有退档:是模型真跑出来的');
  const found = result.transitions.map((x) => x.time);
  const err = maxError(found, CUTS);
  console.log(`  TransNetV2 检出 ${JSON.stringify(found)},真值 ${JSON.stringify(CUTS)},最大误差 ${err.toFixed(3)} 秒`);
  assert.ok(err <= 0.08, `误差 ${err} 秒`);
  assert.equal(fx.commits.length, 1);
  assert.equal(fx.commits[0].engine, 'transnetv2');
  assert.equal((await fx.jobs.get(fx.context, started.jobId)).state, 'done');
});

test('没装依赖(真 Python,没有 onnxruntime):status 点名缺什么,detect_shots 退到 scdet 且如实说明,仍能检出硬切', { skip: skipPlain, timeout: 180_000 }, async (t) => {
  const work = tmpDir('pc-p1-real-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const video = makeCutsVideo(work);
  const fx = await makeP1Fixture(t, { config: realConfig({ withPython: true, py: plainPython }) });
  await fx.addMedia({ id: 'cuts', name: 'cuts.mp4', bytes: fs.readFileSync(video), extra: { duration: DURATION } });
  const status = await fx.tools.status(fx.context);
  assert.equal(status.engine, 'scdet');
  assert.equal(status.model.ready, false);
  assert.equal(status.model.detail.runtime.installed, false);
  assert.match(status.model.reason, /onnxruntime 没装/);
  const started = await fx.tools.call('detect_shots', { mediaId: 'cuts' }, fx.context);
  assert.equal(started.engine, 'scdet');
  assert.match(started.engineNote, /onnxruntime 没装/);
  const { result } = await settle(fx, 'cuts');
  assert.equal(result.engine, 'scdet');
  assert.match(result.engineNote, /onnxruntime 没装/);
  assert.ok(maxError(result.transitions.map((x) => x.time), CUTS) <= 0.04);
});

test('权重目录是空的(依赖在、权重不在):不假称模型识别,退到 scdet 并点名 transnetv2.onnx', { skip: skipModel, timeout: 180_000 }, async (t) => {
  const empty = tmpDir('pc-p1-nomodel-');
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const fx = await makeP1Fixture(t, { config: realConfig({ withPython: true, modelsDir: empty }) });
  const status = await fx.tools.status(fx.context);
  assert.equal(status.engine, 'scdet');
  assert.equal(status.model.detail.runtime.installed, true);
  assert.equal(status.model.detail.model.exists, false);
  assert.match(status.model.reason, /transnetv2\.onnx/);
  assert.doesNotMatch(status.model.reason, /onnxruntime 没装/);
});

/** 往对话工作区根下放恶意模块:被导入就往标记文件里写一行自己的名字 */
function plantEvil(t, workDir, names) {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-p1-evil-'));
  t.after(() => fs.rmSync(markerDir, { recursive: true, force: true }));
  const marker = path.join(markerDir, 'imported.txt');
  for (const name of names) {
    fs.writeFileSync(path.join(workDir, `${name}.py`),
      `with open(${JSON.stringify(marker)}, 'a', encoding='utf-8') as _f:\n    _f.write(${JSON.stringify(`${name}\n`)})\n`);
  }
  return { imported: () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean) : []) };
}

test('恶意同名模块:对话工作区根下的 promptcut_shots.py、json.py 等一个都不被导入,真 Python 照常查状态、跑检测', { skip: skipModel, timeout: 240_000 }, async (t) => {
  const work = tmpDir('pc-p1-real-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const video = makeCutsVideo(work);
  const fx = await makeP1Fixture(t, { config: realConfig({ withPython: true }) });
  const evil = plantEvil(t, fx.ws.dir(), ['promptcut_shots', 'promptcut_stt', 'json', 'argparse', 'numpy', 'onnxruntime', 'subprocess', 'os']);
  assert.ok(fs.existsSync(path.join(fx.ws.dir(), 'promptcut_shots.py')) && fs.existsSync(path.join(fx.ws.dir(), 'json.py')), '恶意文件确实放在工作区根下');
  await fx.addMedia({ id: 'cuts', name: 'cuts.mp4', bytes: fs.readFileSync(video), extra: { duration: DURATION } });
  const status = await fx.tools.status(fx.context);
  assert.equal(status.engine, 'transnetv2', `真包跑出了状态:${JSON.stringify(status)}`);
  assert.deepEqual(evil.imported(), [], `状态:恶意模块被导入了:${evil.imported().join('、')}`);
  await fx.tools.call('detect_shots', { mediaId: 'cuts' }, fx.context);
  const { result } = await settle(fx, 'cuts');
  assert.equal(result.engine, 'transnetv2');
  assert.equal(result.fellBackFrom, undefined);
  assert.deepEqual(evil.imported(), [], `检测:恶意模块被导入了:${evil.imported().join('、')}`);
});

test('真坏文件(文本冒充 mp4):真 ffprobe 的话变成明确的 error,带退路,路径被抹掉,不写项目', { skip: skipAll, timeout: 120_000 }, async (t) => {
  const fx = await makeP1Fixture(t, { config: realConfig() });
  await fx.addMedia({ id: 'bad', name: 'bad.mp4', bytes: Buffer.from('this is definitely not a video file\n'.repeat(50)), extra: { duration: 5 } });
  const started = await fx.tools.call('detect_shots', { mediaId: 'bad' }, fx.context);
  const { error } = await settle(fx, 'bad');
  assert.equal(error.code, 'job-error');
  assert.match(error.message, /ffprobe 读不出这个文件的视频信息/);
  assert.match(error.message, /see_frames/);
  assert.doesNotMatch(error.message, /pc-run-authority|shots[\\/]job_/);
  assert.equal((await fx.jobs.get(fx.context, started.jobId)).errorCode, 'SHOTS_FAILED');
  assert.equal(fx.commits.length, 0);
});

test('伪装成媒体的播放列表连不了网络:素材里写着 http 地址,真 ffprobe / ffmpeg 一次都没去连(对照:白名单放开 http 的 ffprobe 会连)', { skip: skipAll, timeout: 120_000 }, async (t) => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits += 1; res.statusCode = 404; res.end(); });
  const port = await freePort();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nhttp://127.0.0.1:${port}/seg0.ts\n#EXT-X-ENDLIST\n`;
  const work = tmpDir('pc-p1-m3u8-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const local = path.join(work, 'list.m3u8');
  fs.writeFileSync(local, playlist);
  // 对照:白名单放开到 http,ffprobe 会去连(证明这份播放列表真的会引来网络访问)
  await new Promise((resolve) => execFile(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,http,tcp,crypto,data', '-allowed_extensions', 'ALL', '-i', local],
    { windowsHide: true, timeout: 20_000 }, () => resolve()));
  const control = hits;
  assert.ok(control > 0, '对照组:白名单放开 http 的 ffprobe 去连了本地服务');
  hits = 0;

  const fx = await makeP1Fixture(t, { config: realConfig() });
  await fx.addMedia({ id: 'pl', name: 'list.m3u8', bytes: Buffer.from(playlist), extra: { duration: 2 } });
  await fx.tools.call('detect_shots', { mediaId: 'pl' }, fx.context);
  const { error } = await settle(fx, 'pl');
  assert.equal(error?.code, 'job-error');
  assert.equal(hits, 0, `云端实现带了 -protocol_whitelist file:本地服务一次都没被访问到(对照组访问了 ${control} 次)`);
});
