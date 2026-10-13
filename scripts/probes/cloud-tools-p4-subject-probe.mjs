// P4 主体识别的探针:真 Python(onnxruntime / torch)、真权重、真 ffmpeg、真短视频,走云端实现的整条链。
//   node scripts/probes/cloud-tools-p4-subject-probe.mjs
// 底座同单测(server/test/cloud-tools-p4-fixture.mjs):真的 doc 一侧运行权限(SQLite)、run-resources、tool-jobs(SQLite)、
// 项目素材物理库与 project-assets、工作区;项目一侧是内存替身(G 包才接真的 doc)。没有 TLS 线路,也不起任何服务端口。
// 环境(都有缺省,按这台机器写的;换机器用环境变量):
//   PROMPTCUT_P4_PYTHON   装了 onnxruntime(与 torch + transformers,full 档才要)的解释器
//   PROMPTCUT_P4_PLAIN_PYTHON  一个没装 onnxruntime 的解释器(演示「没装依赖」)
//   PROMPTCUT_P4_MODELS   权重目录(yunet.onnx、rtdetr_r18vd.onnx、grounding-dino-tiny/)
//   PROMPTCUT_P4_SKIP_FULL=1  不跑 full 档(没有 torch 时)
// 输出每项检查一行 `PASS/FAIL`,最后一行是汇总;有 FAIL 退出码 1。临时素材放仓库 out/p4/(不入库)。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeP4Fixture } from '../../server/test/cloud-tools-p4-fixture.mjs';

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const PYTHON = process.env.PROMPTCUT_P4_PYTHON ?? path.join(home, 'anaconda3', 'envs', 'cuda_Vit', 'python.exe');
const PLAIN_PYTHON = process.env.PROMPTCUT_P4_PLAIN_PYTHON ?? path.join(home, 'anaconda3', 'python.exe');
const MODELS = process.env.PROMPTCUT_P4_MODELS ?? path.join(root, '..', '..', 'out', 'models');
const SKIP_FULL = process.env.PROMPTCUT_P4_SKIP_FULL === '1';
const outDir = path.join(root, 'out', 'p4');
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });

function findFfmpeg() {
  const exe = process.platform === 'win32' ? '.exe' : '';
  if (process.env.PROMPTCUT_FFMPEG) return process.env.PROMPTCUT_FFMPEG;
  const where = run(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']);
  const first = where.stdout?.split(/\r?\n/).find(Boolean);
  if (!first) throw new Error(`找不到 ffmpeg${exe}`);
  return first.trim();
}
const ffmpeg = findFfmpeg();

/** 正在跑的主体检测相关进程数(python 与它起的 ffmpeg 抽帧)。Windows 用 CIM;其它平台用 pgrep */
function liveProcesses() {
  if (process.platform === 'win32') {
    const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'promptcut_subject' -and $_.Name -match 'python|ffmpeg' }).Count"]);
    return Number(r.stdout.trim() || '0');
  }
  const r = run('pgrep', ['-fc', 'promptcut_subject']);
  return Number(r.stdout.trim() || '0');
}
const visibleWindows = () => {
  if (process.platform !== 'win32') return 0;
  const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "@(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'WindowsTerminal|OpenConsole|cmd|powershell|conhost|node|chrome|ffmpeg|python' }).Count"]);
  return Number(r.stdout.trim() || '0');
};

// ---- 造素材:一张公有领域的人像照片(matplotlib 自带的 grace_hopper.jpg)做成 4 秒短片;一段没有人的测试图案;一份坏文件
const photoCandidates = run(PYTHON, ['-c', "import matplotlib,os;print(os.path.join(os.path.dirname(matplotlib.__file__),'mpl-data','sample_data','grace_hopper.jpg'))"]);
const photo = photoCandidates.stdout.trim();
if (!photo || !fs.existsSync(photo)) { console.log('FAIL  找不到人像照片(需要装了 matplotlib 的解释器)'); process.exit(1); }
const personMp4 = path.join(outDir, 'person.mp4');
const sceneMp4 = path.join(outDir, 'scene.mp4');
const longMp4 = path.join(outDir, 'person-long.mp4');
const runFfmpeg = (args) => { const r = run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args]); if (r.status !== 0) throw new Error(`ffmpeg 失败:${r.stderr}`); };
runFfmpeg(['-loop', '1', '-i', photo, '-t', '4', '-r', '25', '-vf', 'scale=606:-2,format=yuv420p', personMp4]);
runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=4', '-pix_fmt', 'yuv420p', sceneMp4]);
runFfmpeg(['-loop', '1', '-i', photo, '-t', '120', '-r', '10', '-vf', 'scale=606:-2,format=yuv420p', '-g', '25', longMp4]);
const win0 = visibleWindows();

const baseConfig = (python, models) => ({ python, modelsDir: models, pythonPath: path.join(root, 'python'), ffmpegDir: path.dirname(ffmpeg) });
const detect = (fx, mediaId, extra = {}) => fx.tools.call('detect_subjects', { mediaId, ...extra }, fx.context);
const list = (fx, mediaId) => fx.tools.call('list_subjects', { mediaId }, fx.context);
async function settle(fx, mediaId, ms = 240000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const r = await list(fx, mediaId); if (!r?.running) return { result: r }; } catch (error) { return { error }; }
    if (Date.now() > end) throw new Error('作业一直没结束');
    await sleep(300);
  }
}

// ======================================================================= 1. 没装依赖 / 没有权重
{
  const empty = fs.mkdtempSync(path.join(outDir, 'models-empty-'));
  const fx = await makeP4Fixture(null, { config: baseConfig(PLAIN_PYTHON, MODELS) });
  try {
    await fx.addMedia({ id: 'p', bytes: fs.readFileSync(personMp4), extra: { duration: 4 } });
    const status = await fx.tools.call('subject_status', {}, fx.context);
    console.log('  没装 onnxruntime 的解释器 subject_status =', JSON.stringify({ ready: status.ready, engine: status.engine, light: status.detail?.light?.runtime }));
    check('没装依赖:subject_status 如实报 engine=null 与缺哪个包', status.engine === null && /onnxruntime/.test(JSON.stringify(status.detail?.light?.runtime ?? {})));
    const out = await detect(fx, 'p');
    console.log('  没装依赖 detect_subjects =', JSON.stringify(out).slice(0, 220));
    check('没装依赖:detect_subjects 回「用不了/没有兜底档」,不起作业', out.cloudUnavailable === true && /没有兜底档/.test(out.error));
  } finally { await fx.dispose(); }
  const fx2 = await makeP4Fixture(null, { config: baseConfig(PYTHON, empty) });
  try {
    await fx2.addMedia({ id: 'p', bytes: fs.readFileSync(personMp4), extra: { duration: 4 } });
    const status = await fx2.tools.call('subject_status', {}, fx2.context);
    console.log('  依赖在、权重目录是空的 subject_status =', JSON.stringify({ ready: status.ready, engine: status.engine, light: status.detail?.light?.models }));
    check('没有权重:engine=null,并说明哪几个权重不在', status.engine === null && status.detail.light.models.yunet.exists === false && status.detail.light.models.rtdetr.exists === false);
    const out = await detect(fx2, 'p');
    check('没有权重:detect_subjects 回「用不了」', out.cloudUnavailable === true);
  } finally { await fx2.dispose(); fs.rmSync(empty, { recursive: true, force: true }); }
}

// ======================================================================= 1b. 只有 light 的权重(full 缺 Grounding DINO):提示词不生效,如实说
{
  const lightOnly = fs.mkdtempSync(path.join(outDir, 'models-light-'));
  for (const name of ['yunet.onnx', 'rtdetr_r18vd.onnx']) {
    const from = path.join(MODELS, name);
    try { fs.linkSync(from, path.join(lightOnly, name)); } catch { fs.copyFileSync(from, path.join(lightOnly, name)); }
  }
  const fx = await makeP4Fixture(null, { config: baseConfig(PYTHON, lightOnly) });
  try {
    await fx.addMedia({ id: 'person', bytes: fs.readFileSync(personMp4), extra: { duration: 4 } });
    const status = await fx.tools.call('subject_status', {}, fx.context);
    console.log('  light 权重齐、DINO 缺 subject_status =', JSON.stringify({ engine: status.engine, full: status.detail?.full }));
    check('full 缺权重:engine=light,full.ready=false 并点名 dino 不在', status.engine === 'light' && status.detail.full.ready === false && status.detail.full.models.dino.exists === false);
    const started = await detect(fx, 'person', { times: [1, 2], prompt: 'cat . dog .' });
    check('带提示词也只能跑 light,detect 回的 engine 是 light', started.engine === 'light');
    const { result, error } = await settle(fx, 'person');
    console.log('  light + 提示词 =', JSON.stringify({ engine: result?.engine, prompt: result?.prompt, labels: [...new Set(result?.samples?.flatMap((s) => s.boxes.map((b) => b.label)))], note: result?.engineNote }));
    check('light 不假称提示词生效:label 只有 person/face,提示词原样回显,engineNote 说明', !error && result.engine === 'light' && result.prompt === 'cat . dog .'
      && result.samples.every((s) => s.boxes.every((b) => ['person', 'face'].includes(b.label))) && /提示词不生效/.test(result.engineNote));
    const again = await detect(fx, 'person', { prompt: 'cat . dog .' });
    check('同样的提示词再问:复用,并说明这台机器只有 light 所以没重测', again.reused === true && /只能跑 light/.test(again.engineNote ?? ''));
  } finally { await fx.dispose(); fs.rmSync(lightOnly, { recursive: true, force: true }); }
}

// ======================================================================= 1c. subject_install:受控安装,真 pip(不连网)
{
  const work = fs.mkdtempSync(path.join(outDir, 'install-'));
  const pylibs = path.join(work, 'libs');
  const okReq = path.join(work, 'empty.txt');
  const badReq = path.join(work, 'bad.txt');
  fs.writeFileSync(okReq, '# 空清单:真 pip 跑一遍,什么都不用装\n');
  fs.writeFileSync(badReq, 'onnxruntime==99.0\n');
  const models = fs.mkdtempSync(path.join(work, 'models-'));
  const withReq = (requirements) => ({ ...baseConfig(PLAIN_PYTHON, models), install: { pylibs, requirements } });
  let fx = await makeP4Fixture(null, { config: withReq(okReq) });
  try {
    const started = await fx.tools.call('subject_install', { tier: 'full', pip: '--index-url http://evil.example/' }, fx.context);
    check('subject_install 起受控作业(模型给的 tier / pip 参数不起作用)', started.started === true);
    let row;
    for (let i = 0; i < 400; i++) { row = await fx.jobs.get(fx.context, started.jobId); if (['done', 'error'].includes(row.state)) break; await sleep(150); }
    const status = await fx.tools.call('subject_status', {}, fx.context);
    console.log('  真 pip 空清单 =', JSON.stringify({ state: row.state, install: status.install, engine: status.engine }));
    check('真 pip:作业 done,subject_status 带 install 摘要;依赖其实没装,engine 仍是 null(不假称装好)', row.state === 'done' && status.install?.state === 'done' && status.engine === null);
  } finally { await fx.dispose(); }
  fx = await makeP4Fixture(null, { config: withReq(badReq) });
  try {
    const started = await fx.tools.call('subject_install', {}, fx.context);
    let row;
    for (let i = 0; i < 400; i++) { row = await fx.jobs.get(fx.context, started.jobId); if (['done', 'error'].includes(row.state)) break; await sleep(150); }
    const status = await fx.tools.call('subject_status', {}, fx.context);
    console.log('  真 pip 找不到包 =', JSON.stringify({ state: row.state, errorCode: row.errorCode, message: status.install?.message }));
    check('真 pip 失败:作业 error,原因是 pip 的话(没网/找不到),不带节点路径', row.state === 'error' && row.errorCode === 'SUBJECT_INSTALL_FAILED' && /pip|安装|requirement/i.test(status.install?.message ?? '') && !String(status.install?.message).includes(work));
  } finally { await fx.dispose(); fs.rmSync(work, { recursive: true, force: true }); }
}

// ======================================================================= 2. 真视频、真结果(light / full)
{
  const fx = await makeP4Fixture(null, { config: baseConfig(PYTHON, MODELS) });
  try {
    await fx.addMedia({ id: 'person', bytes: fs.readFileSync(personMp4), extra: { duration: 4, name: 'person.mp4' } });
    await fx.addMedia({ id: 'scene', bytes: fs.readFileSync(sceneMp4), extra: { duration: 4 } });
    const status = await fx.tools.call('subject_status', {}, fx.context);
    console.log('  subject_status =', JSON.stringify({ ready: status.ready, engine: status.engine, hint: status.hint }));
    check('真解释器真权重:subject_status 报就绪', status.ready === true && ['light', 'full'].includes(status.engine));
    check('status 不泄露节点路径', !JSON.stringify(status).includes(MODELS) && !JSON.stringify(status).includes(PYTHON));

    // light:没提示词,Python 侧优先 light
    const t0 = Date.now();
    const started = await detect(fx, 'person', { times: [0.5, 1.5, 2.5, 3.5] });
    check('detect_subjects 立即回 jobId', started.started === true && /^job_/.test(started.jobId), `${Date.now() - t0}ms`);
    const { result, error } = await settle(fx, 'person');
    check('light 作业跑完且无错', !error && result?.running === false, error?.message);
    if (result) {
      const first = result.samples[0];
      console.log('  light 结果 =', JSON.stringify({ engine: result.engine, width: result.width, height: result.height, failedCount: result.failedCount, first }).slice(0, 700));
      check('light:画面里有人 —— 4 个采样都检出至少一个 person 或 face 框', result.samples.every((s) => !s.failed && s.boxCount >= 1 && s.boxes.some((b) => ['person', 'face'].includes(b.label))));
      check('light:engine 记实际跑的一档,提示词不假称生效', result.engine === 'light' && /只认 person 和 face/.test(result.engineNote));
      check('light:给出建议位置或明说四侧被占', result.samples.every((s) => ['left', 'right', 'bottom', null].includes(s.suggestedPosition)));
      check('坐标是原始视频像素(落在画面内)', result.samples.every((s) => s.boxes.every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= result.width + 1 && b.y + b.h <= result.height + 1)));
    }
    const jobRow = await fx.jobs.get(fx.context, started.jobId);
    check('账本:作业 done、progress=1、有产物引用', jobRow.state === 'done' && jobRow.progress === 1 && jobRow.outputRefs[0]?.kind === 'subjects', JSON.stringify({ state: jobRow.state, progress: jobRow.progress, stage: jobRow.stage }));
    check('结果写进项目素材的当前版本(一次提交,带作业号)', fx.commits.length === 1 && fx.commits[0].jobId === started.jobId && fx.commits[0].engine === 'light');
    check('取来的素材临时文件删净', fx.ws.list().every((f) => f.path === 'subject/jobs.json'), JSON.stringify(fx.ws.list().map((f) => f.path)));

    // 没有人的图案:不是失败,是「没人」
    await detect(fx, 'scene', { times: [1, 2, 3] });
    const noOne = await settle(fx, 'scene');
    console.log('  无人素材结果 =', JSON.stringify(noOne.result?.samples?.map((s) => ({ t: s.t, n: s.boxCount, pos: s.suggestedPosition, occ: s.occupancy }))));
    check('无人素材:作业成功、没有人物框、三侧占用率近 0、不是 failed', !noOne.error && noOne.result.samples.every((s) => !s.failed && s.boxes.filter((b) => b.label === 'person').length === 0));

    // 超出时长的采样点:failed 标记,不假称没有人
    await detect(fx, 'person', { force: true, times: [1, 99] });
    const oob = await settle(fx, 'person');
    const bad = oob.result?.samples?.find((s) => s.t === 99);
    check('超出时长的采样点带 failed 标记与原因,failedCount=1', oob.result?.failedCount === 1 && bad?.failed === true && /失败/.test(bad.reason), bad?.reason?.slice(0, 80));

    // full:带提示词
    let fullRan = false;
    if (!SKIP_FULL && status.engine === 'full') {
      fullRan = true;
      const s2 = await detect(fx, 'person', { force: true, times: [1, 3], prompt: 'person . face . tie .' });
      check('full:detect 回的 engine 是 full', s2.engine === 'full', JSON.stringify({ engine: s2.engine, eta: s2.etaSeconds }));
      const full = await settle(fx, 'person');
      console.log('  full 结果 =', JSON.stringify({ engine: full.result?.engine, prompt: full.result?.prompt, labels: [...new Set(full.result?.samples?.flatMap((s) => s.boxes.map((b) => b.label)))], fellBackFrom: full.result?.fellBackFrom }));
      check('full:跑完,engine=full,提示词原样记下', !full.error && full.result.engine === 'full' && full.result.prompt === 'person . face . tie .', full.error?.message);
      check('full:框的 label 来自提示词里的名词', full.result.samples.some((s) => s.boxes.some((b) => ['person', 'face', 'tie'].includes(b.label))));
    } else console.log('  (跳过 full 档:SKIP_FULL 或节点只有 light)');

    // 错误 mediaId
    try { await detect(fx, 'no-such'); check('错误 mediaId 被拒', false); } catch (e) { check('错误 mediaId 被拒(media-not-found)', e.code === 'media-not-found', e.message); }

    // 坏文件:真 ffprobe 读不出来
    await fx.addMedia({ id: 'junk', name: 'junk.mp4', bytes: Buffer.from('this is not a video at all, just text'.repeat(40)), extra: { duration: 4 } });
    const sJunk = await detect(fx, 'junk', { times: [1] });
    const junk = await settle(fx, 'junk');
    console.log('  坏文件 =', junk.error?.code, junk.error?.message);
    check('坏文件:作业 error,原因来自 ffprobe,不带节点路径', junk.error?.code === 'job-error' && junk.error.message.length > 0 && !junk.error.message.includes(fx.dir));
    check('坏文件:账本记 error,没有写项目(提交数不变)', (await fx.jobs.get(fx.context, sJunk.jobId)).state === 'error' && fx.commits.length === 3 + (fullRan ? 1 : 0));
  } finally { await fx.dispose(); }
}

// ======================================================================= 3. 取消 / 超时 / 重启:真进程树
{
  const before = liveProcesses();
  const fx = await makeP4Fixture(null, { config: baseConfig(PYTHON, MODELS), limits: { minDetectMs: 4000, perFrameMs: 1 } });
  try {
    await fx.addMedia({ id: 'long', name: 'long.mp4', bytes: fs.readFileSync(longMp4), extra: { duration: 120 } });
    // 取消:120 秒的片子每 0.6 秒一个采样 = 200 个点,跑不完
    const times = Array.from({ length: 200 }, (_, i) => Number((i * 0.6).toFixed(2)));
    const started = await detect(fx, 'long', { times, prompt: SKIP_FULL ? undefined : 'person .' });
    let seen = 0;
    for (let i = 0; i < 100 && seen === 0; i++) { await sleep(150); seen = liveProcesses(); }
    const mid = await list(fx, 'long');
    console.log(`  取消前:python/ffmpeg 进程 ${seen} 个,list_subjects =`, JSON.stringify(mid));
    check('取消前:真有 Python 进程在跑,list_subjects 报 running', seen >= 1 && mid.running === true);
    const receipt = await fx.tools.cancel(fx.context, started.jobId);
    await sleep(500);
    const after = liveProcesses();
    console.log(`  取消后:python/ffmpeg 进程 ${after} 个(开始前 ${before} 个)`);
    check('取消:进程树真被杀(Python 与它的 ffmpeg 都没了)', receipt.cancelled === true && after <= before);
    check('取消:账本 cancelled,不写项目', (await fx.jobs.get(fx.context, started.jobId)).state === 'cancelled' && fx.commits.length === 0);

    // 超时:minDetectMs 4 秒,200 个点跑不完
    const s2 = await detect(fx, 'long', { times, force: true });
    const { error } = await settle(fx, 'long', 60000);
    await sleep(400);
    console.log('  超时 =', error?.message);
    check('超时:作业 error、原因写明超时、进程树已杀', error?.code === 'job-error' && /超时/.test(error.message) && liveProcesses() <= before);
    check('超时:账本 errorCode=SUBJECT_TIMEOUT,没写项目', (await fx.jobs.get(fx.context, s2.jobId)).errorCode === 'SUBJECT_TIMEOUT' && fx.commits.length === 0);

    // 服务重启:close 杀进程树;新实例看到「被中断」
    const s3 = await detect(fx, 'long', { times, force: true });
    for (let i = 0; i < 100 && liveProcesses() <= before; i++) await sleep(150);
    const closing = await fx.tools.close('restart');
    await sleep(300);
    console.log(`  重启:close 回执 ${JSON.stringify(closing)};残留进程 ${liveProcesses()} 个`);
    check('重启:close 等到子进程真关,无残留进程', closing.childrenClosed === true && closing.workPending === 0 && liveProcesses() <= before);
    await fx.restart();
    const row = await fx.jobs.get(fx.context, s3.jobId);
    let msg = '';
    try { await list(fx, 'long'); } catch (e) { msg = `${e.code}: ${e.message}`; }
    console.log('  重启后 list_subjects =', msg);
    check('重启后:账本 interrupted,list_subjects 说「被中断」而不是找不到', row.state === 'interrupted' && /job-interrupted/.test(msg));
  } finally { await fx.dispose(); }
}

const win1 = visibleWindows();
check('没有新冒出来的可见命令行窗口', win1 <= win0, `前 ${win0} 后 ${win1}`);
check('临时素材在 out/p4/(不入库)', fs.existsSync(personMp4));
const failed = results.filter((x) => !x).length;
console.log(`\n${failed === 0 ? 'ALL PASS' : `FAILED ${failed}`}  (${results.length - failed}/${results.length})`);
process.exit(failed === 0 ? 0 : 1);
