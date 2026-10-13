// P1 镜头识别的探针:真 ffmpeg / ffprobe、真 Python(onnxruntime)、真 TransNetV2 权重、现造的有已知切点的视频,走云端实现的整条链。
//   node scripts/probes/cloud-tools-p1-shots-probe.mjs
// 底座同单测(server/test/cloud-tools-p1-fixture.mjs):真的 doc 一侧运行权限(SQLite)、run-resources、tool-jobs(SQLite)、
// 项目素材物理库与 project-assets、工作区;项目一侧是内存替身(G 包才接真的 doc)。没有 TLS 线路,也不起任何服务端口。
// 环境(都有缺省,按这台机器写的;换机器用环境变量):
//   PROMPTCUT_P1_PYTHON        装了 onnxruntime 与 numpy 的解释器
//   PROMPTCUT_P1_PLAIN_PYTHON  一个没装 onnxruntime 的解释器(演示「没装依赖」)
//   PROMPTCUT_P1_MODELS        权重目录(里面是 transnetv2.onnx)
//   PROMPTCUT_FFMPEG           ffmpeg 的绝对路径(缺省从 PATH 找)
// 输出每项检查一行 `PASS/FAIL`,最后一行是汇总;有 FAIL 退出码 1。临时素材放仓库 out/p1/(不入库)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeP1Fixture } from '../../server/test/cloud-tools-p1-fixture.mjs';

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const home = os.homedir();
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 300_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outDir = path.join(root, 'out', 'p1');
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
};

function findFfmpeg() {
  if (process.env.PROMPTCUT_FFMPEG && fs.existsSync(process.env.PROMPTCUT_FFMPEG)) return process.env.PROMPTCUT_FFMPEG;
  const where = run(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']);
  const first = where.stdout?.split(/\r?\n/).find(Boolean);
  if (!first) throw new Error('找不到 ffmpeg');
  return first.trim();
}
const ffmpeg = findFfmpeg();
const ext = path.extname(ffmpeg);
const ffprobe = path.join(path.dirname(ffmpeg), `ffprobe${ext}`);
const hasOnnx = (py) => py && fs.existsSync(py) && run(py, ['-I', '-c', 'import onnxruntime, numpy']).status === 0;
const PYTHON = [process.env.PROMPTCUT_P1_PYTHON, path.join(home, 'anaconda3', 'envs', 'cuda_Vit', 'python.exe')].filter(Boolean).find(hasOnnx);
const PLAIN = [process.env.PROMPTCUT_P1_PLAIN_PYTHON, path.join(home, 'anaconda3', 'python.exe')].filter(Boolean).find((p) => fs.existsSync(p) && !hasOnnx(p));
const MODELS = [process.env.PROMPTCUT_P1_MODELS, path.join(root, 'out', 'models'), path.join(root, '..', '..', 'out', 'models')].filter(Boolean).find((d) => fs.existsSync(path.join(d, 'transnetv2.onnx')));
if (!PYTHON || !MODELS) { console.log('FAIL  找不到装了 onnxruntime 的 Python 或 transnetv2.onnx 权重(用 PROMPTCUT_P1_PYTHON / PROMPTCUT_P1_MODELS 指定)'); process.exit(1); }
console.log(`  ffmpeg=${path.basename(ffmpeg)} python=${path.basename(path.dirname(PYTHON))} plain=${PLAIN ? 'yes' : 'no'} models=ok`);

const runFfmpeg = (args) => { const r = run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args]); if (r.status !== 0) throw new Error(`ffmpeg 失败:${r.stderr}`); };

/** 正在跑的镜头识别相关进程数(Python 与它起的 ffmpeg 解码、云端起的 ffmpeg scdet / ffprobe)。按命令行里的包名或「shots/job_」认 */
function liveProcesses() {
  if (process.platform === 'win32') {
    const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'promptcut_shots|shots[\\\\/]job_' -and $_.Name -match 'python|ffmpeg|ffprobe' }).Count"]);
    return Number(r.stdout.trim() || '0');
  }
  return Number(run('pgrep', ['-fc', 'promptcut_shots|shots/job_']).stdout.trim() || '0');
}
const visibleWindows = () => {
  if (process.platform !== 'win32') return 0;
  const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "@(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'WindowsTerminal|OpenConsole|cmd|powershell|conhost|node|chrome|ffmpeg|python' }).Count"]);
  return Number(r.stdout.trim() || '0');
};
const win0 = visibleWindows();

// ---- 造素材
// 三段不同画面的硬切:75 帧 / 90 帧 / 50 帧(25fps),切点在 3.0 秒与 6.6 秒
const cutsMp4 = path.join(outDir, 'cuts.mp4');
runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3', '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=25:duration=3.6',
  '-f', 'lavfi', '-i', 'rgbtestsrc=size=640x360:rate=25:duration=2', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]', '-map', '[v]',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', cutsMp4]);
const CUTS = [3.0, 6.6];
// 一次 1 秒交叉溶解:两段各 4 秒,第 3 秒起渐变到第 4 秒(总长 7 秒)
const dissolveMp4 = path.join(outDir, 'dissolve.mp4');
runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=4', '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=25:duration=4',
  '-filter_complex', '[0:v][1:v]xfade=transition=fade:duration=1:offset=3,format=yuv420p[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', dissolveMp4]);
// 一段 300 秒的 1080p 长片:取消/超时/重启时让进程来不及跑完
const longMp4 = path.join(outDir, 'long.mp4');
if (!fs.existsSync(longMp4)) runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25:duration=300', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-b:v', '3M', '-maxrate', '3M', '-bufsize', '6M', longMp4]);

const cfg = (python = PYTHON, models = MODELS) => ({
  ffmpeg, ffprobe, ffmpegDir: path.dirname(ffmpeg),
  ...(python ? { python, modelsDir: models, pythonPath: path.join(root, 'python') } : {}),
});
const detect = (fx, mediaId, extra = {}) => fx.tools.call('detect_shots', { mediaId, ...extra }, fx.context);
const list = (fx, mediaId) => fx.tools.call('list_shots', { mediaId }, fx.context);
async function settle(fx, mediaId, ms = 240000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const r = await list(fx, mediaId); if (!r?.running) return { result: r }; } catch (error) { return { error }; }
    if (Date.now() > end) throw new Error('作业一直没结束');
    await sleep(250);
  }
}
const maxErr = (found, truth) => (found.length === truth.length ? Math.max(...truth.map((t, i) => Math.abs(found[i] - t))) : Infinity);
const fmt = (arr) => JSON.stringify(arr.map((x) => Number(x.toFixed(3))));

// ======================================================================= 1. scdet 档(没配 Python):已知硬切
{
  const fx = await makeP1Fixture(null, { config: cfg(null) });
  try {
    await fx.addMedia({ id: 'cuts', name: 'cuts.mp4', bytes: fs.readFileSync(cutsMp4), extra: { duration: 8.6 } });
    const status = await fx.tools.status(fx.context);
    check('没配 Python:status 报 scdet 档', status.engine === 'scdet' && status.model.ready === false, JSON.stringify(status.model));
    const started = await detect(fx, 'cuts');
    check('detect_shots 立即回 jobId,engine=scdet,说明没配模型', started.started === true && started.engine === 'scdet' && /没有配置 TransNetV2/.test(started.engineNote));
    const { result, error } = await settle(fx, 'cuts');
    const found = result?.transitions?.map((x) => x.time) ?? [];
    const err = maxErr(found, CUTS);
    console.log(`  scdet 检出 ${fmt(found)},真值 ${fmt(CUTS)},最大误差 ${Number.isFinite(err) ? err.toFixed(3) : 'n/a'} 秒`);
    console.log('  list_shots =', JSON.stringify({ engine: result?.engine, shots: result?.shots?.map((s) => [s.start, s.end]), engineNote: result?.engineNote }));
    check('scdet 检出的硬切与真值对上(误差不超过一帧 0.04 秒)', !error && err <= 0.04, error?.message);
    check('3 个镜头、首尾对上素材时长', result?.shots?.length === 3 && Math.abs(result.shots.at(-1).end - 8.6) < 0.05);
    const row = await fx.jobs.get(fx.context, started.jobId);
    check('账本 done、progress=1、有产物引用', row.state === 'done' && row.progress === 1 && row.outputRefs?.[0]?.kind === 'shots', JSON.stringify({ state: row.state, stage: row.stage }));
    const stored = fx.projects.get(fx.context.projectId).get('cuts').shots;
    check('结果真的写进了(测试里的)项目素材,带作业号,一次提交', fx.commits.length === 1 && fx.commits[0].jobId === started.jobId && stored?.engine === 'scdet' && stored.shots.length === 3);
    check('取来的素材临时文件删净', fx.ws.list().every((f) => f.path === 'shots/jobs.json'), JSON.stringify(fx.ws.list().map((f) => f.path)));
    const reused = await detect(fx, 'cuts');
    check('再问一次:复用已有结果,不重测', reused.reused === true && fx.commits.length === 1);
  } finally { await fx.dispose(); }
}

// ======================================================================= 2. 没装依赖 / 权重不全 / ffmpeg 没有
{
  if (PLAIN) {
    const fx = await makeP1Fixture(null, { config: cfg(PLAIN) });
    try {
      await fx.addMedia({ id: 'cuts', name: 'cuts.mp4', bytes: fs.readFileSync(cutsMp4), extra: { duration: 8.6 } });
      const status = await fx.tools.status(fx.context);
      console.log('  没装 onnxruntime 的解释器 =', JSON.stringify({ engine: status.engine, runtime: status.model.detail?.runtime, reason: status.model.reason }));
      check('没装依赖:status 如实报 scdet,点名缺 onnxruntime', status.engine === 'scdet' && /onnxruntime 没装/.test(status.model.reason));
      const started = await detect(fx, 'cuts');
      const { result } = await settle(fx, 'cuts');
      check('没装依赖:detect_shots 照样用 scdet 跑完,list_shots 的说明里写明没用模型的原因', started.engine === 'scdet' && result?.engine === 'scdet' && /onnxruntime 没装/.test(result.engineNote) && maxErr(result.transitions.map((x) => x.time), CUTS) <= 0.04);
    } finally { await fx.dispose(); }
  } else console.log('  (跳过「没装依赖」:找不到不带 onnxruntime 的 Python)');
  const empty = fs.mkdtempSync(path.join(outDir, 'models-empty-'));
  {
    const fx = await makeP1Fixture(null, { config: cfg(PYTHON, empty) });
    try {
      const status = await fx.tools.status(fx.context);
      console.log('  依赖在、权重目录是空 =', JSON.stringify(status.model));
      check('权重不在:engine=scdet,点名 transnetv2.onnx,不假称模型识别', status.engine === 'scdet' && status.model.detail.runtime.installed === true && status.model.detail.model.exists === false && /transnetv2\.onnx/.test(status.model.reason));
    } finally { await fx.dispose(); fs.rmSync(empty, { recursive: true, force: true }); }
  }
  {
    const missing = path.join(outDir, `no-ffmpeg${ext}`);
    const fx = await makeP1Fixture(null, { config: { ffmpeg: missing, ffprobe: missing, ffmpegDir: outDir } });
    try {
      await fx.addMedia({ id: 'cuts', name: 'cuts.mp4', bytes: fs.readFileSync(cutsMp4), extra: { duration: 8.6 } });
      const out = await detect(fx, 'cuts');
      console.log('  ffmpeg 没有 =', JSON.stringify(out).slice(0, 200));
      check('ffmpeg 没有:detect_shots 回「用不了」并指向 see_frames,不起作业,不泄露路径', out.cloudUnavailable === true && /ffmpeg 起不来/.test(out.error) && /see_frames/.test(out.error) && !out.error.includes(outDir));
    } finally { await fx.dispose(); }
  }
}

// ======================================================================= 3. TransNetV2 档:硬切与溶解
{
  const fx = await makeP1Fixture(null, { config: cfg() });
  try {
    await fx.addMedia({ id: 'cuts', name: 'cuts.mp4', bytes: fs.readFileSync(cutsMp4), extra: { duration: 8.6 } });
    await fx.addMedia({ id: 'dis', name: 'dissolve.mp4', bytes: fs.readFileSync(dissolveMp4), extra: { duration: 7 } });
    const status = await fx.tools.status(fx.context);
    check('真解释器真权重:status 报 transnetv2 就绪', status.engine === 'transnetv2' && status.model.ready === true, JSON.stringify(status.model.detail));
    check('status 不泄露节点路径', !JSON.stringify(status).includes(MODELS) && !JSON.stringify(status).includes(PYTHON));
    const t0 = Date.now();
    const started = await detect(fx, 'cuts');
    check('detect_shots 立即回 jobId,engine=transnetv2', started.started === true && started.engine === 'transnetv2', `${Date.now() - t0}ms`);
    const { result, error } = await settle(fx, 'cuts');
    const found = result?.transitions?.map((x) => x.time) ?? [];
    const err = maxErr(found, CUTS);
    console.log(`  TransNetV2 检出 ${fmt(found)},真值 ${fmt(CUTS)},最大误差 ${Number.isFinite(err) ? err.toFixed(3) : 'n/a'} 秒`);
    check('TransNetV2 检出的硬切与真值对上(误差不超过两帧 0.08 秒)', !error && err <= 0.08 && result.engine === 'transnetv2' && result.fellBackFrom === undefined, error?.message);
    check('转场只有 ShotTransition 的字段,没有缩略图', result.transitions.every((x) => ['kind', 'start', 'end', 'time', 'confidence'].every((k) => k in x) && !('thumbs' in x) && !('startFrame' in x)));
    const row = await fx.jobs.get(fx.context, started.jobId);
    check('账本 done,提交带作业号,engine 记 transnetv2', row.state === 'done' && fx.commits.at(-1).engine === 'transnetv2' && fx.commits.at(-1).jobId === started.jobId);

    await detect(fx, 'dis');
    const dis = await settle(fx, 'dis');
    const d = dis.result?.transitions ?? [];
    console.log('  TransNetV2 溶解视频 =', JSON.stringify(d));
    check('TransNetV2 认得溶解:检出一个 dissolve,跨度大致是 3~4 秒', d.length === 1 && d[0].kind === 'dissolve' && d[0].start >= 2.7 && d[0].start <= 3.3 && d[0].end >= 3.7 && d[0].end <= 4.3);
  } finally { await fx.dispose(); }
  // 同一段溶解视频换 scdet 档:认不出(如实标注只认硬切)
  const fx2 = await makeP1Fixture(null, { config: cfg(null) });
  try {
    await fx2.addMedia({ id: 'dis', name: 'dissolve.mp4', bytes: fs.readFileSync(dissolveMp4), extra: { duration: 7 } });
    await detect(fx2, 'dis');
    const dis = await settle(fx2, 'dis');
    console.log('  scdet 溶解视频 =', JSON.stringify(dis.result?.transitions), '|', dis.result?.engineNote);
    check('scdet 档认不出溶解(检出 0 个),engineNote 明说只认硬切', dis.result?.transitions?.length === 0 && /只认硬切/.test(dis.result.engineNote));
  } finally { await fx2.dispose(); }
}

// ======================================================================= 4. 恶意同名模块
{
  const fx = await makeP1Fixture(null, { config: cfg() });
  try {
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-p1-evil-'));
    const marker = path.join(markerDir, 'imported.txt');
    const names = ['promptcut_shots', 'promptcut_stt', 'json', 'argparse', 'numpy', 'onnxruntime', 'subprocess', 'os'];
    for (const n of names) fs.writeFileSync(path.join(fx.ws.dir(), `${n}.py`), `with open(${JSON.stringify(marker)}, 'a', encoding='utf-8') as _f:\n    _f.write(${JSON.stringify(`${n}\n`)})\n`);
    await fx.addMedia({ id: 'cuts', name: 'cuts.mp4', bytes: fs.readFileSync(fs.existsSync(cutsMp4) ? cutsMp4 : cutsMp4), extra: { duration: 8.6 } });
    const status = await fx.tools.status(fx.context);
    await detect(fx, 'cuts');
    const { result } = await settle(fx, 'cuts');
    const imported = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean) : [];
    console.log(`  工作区根下的恶意模块 ${names.join(' ')};被导入的:${JSON.stringify(imported)}`);
    check('恶意同名模块(promptcut_shots.py、json.py 等)一个都没被导入', imported.length === 0);
    check('同时真 Python 照常查到状态、跑出模型档结果', status.engine === 'transnetv2' && result?.engine === 'transnetv2' && result.fellBackFrom === undefined);
    fs.rmSync(markerDir, { recursive: true, force: true });
  } finally { await fx.dispose(); }
}

// ======================================================================= 5. 取消 / 超时 / 重启:真进程树(含 Python 抽帧起的 ffmpeg 孙进程)
{
  const before = liveProcesses();
  const fx = await makeP1Fixture(null, { config: cfg(), limits: { minDetectMs: 4000, perSecondMs: 1 } });
  const scdetOnly = await makeP1Fixture(null, { config: cfg(null), limits: { minDetectMs: 4000, perSecondMs: 1 } });
  try {
    const bytes = fs.readFileSync(longMp4);
    await fx.addMedia({ id: 'long', name: 'long.mp4', bytes, extra: { duration: 300 } });
    await scdetOnly.addMedia({ id: 'long', name: 'long.mp4', bytes, extra: { duration: 300 } });
    const waitProcs = async (min = 1) => { let n = 0; for (let i = 0; i < 200 && n < min; i++) { await sleep(100); n = liveProcesses(); } return n; };

    // 5a. TransNetV2 档取消:Python + 它起的 ffmpeg 解码
    const started = await detect(fx, 'long');
    const seen = await waitProcs(2);
    const mid = await list(fx, 'long');
    console.log(`  TransNetV2 取消前:Python/ffmpeg 进程 ${seen} 个(开始前 ${before}),list_shots =`, JSON.stringify(mid));
    check('取消前:真有进程在跑(Python 加上它起的 ffmpeg 孙进程),list_shots 报 running', seen >= 2 && mid.running === true);
    const receipt = await fx.tools.cancel(fx.context, started.jobId);
    await sleep(500);
    const after = liveProcesses();
    console.log(`  取消后进程 ${after} 个`);
    check('TransNetV2 取消:整棵进程树真被杀(含 ffmpeg 孙进程),无残留', receipt.cancelled === true && after <= before);
    check('取消:账本 cancelled,不写项目,list_shots 说「已被取消」', (await fx.jobs.get(fx.context, started.jobId)).state === 'cancelled' && fx.commits.length === 0 && await list(fx, 'long').then(() => false, (e) => e.code === 'job-cancelled'));

    // 5b. scdet 档取消
    const s2 = await detect(scdetOnly, 'long');
    const seen2 = await waitProcs(1);
    const rec2 = await scdetOnly.tools.cancel(scdetOnly.context, s2.jobId);
    await sleep(500);
    console.log(`  scdet 取消前 ffmpeg 进程 ${seen2} 个,取消后 ${liveProcesses()} 个`);
    check('scdet 取消:真有 ffmpeg 在跑,取消后进程没了', seen2 >= 1 && rec2.cancelled === true && liveProcesses() <= before);

    // 5c. 超时(4 秒时限,300 秒的 1080p 片子跑不完):TransNetV2 档与 scdet 档
    const s3 = await detect(fx, 'long', { force: true });
    const r3 = await settle(fx, 'long', 60000);
    await sleep(400);
    console.log('  TransNetV2 超时 =', r3.error?.message?.slice(0, 120));
    check('TransNetV2 超时:作业 error、原因写明超时与退路、进程树已杀、不写项目', r3.error?.code === 'job-error' && /超时/.test(r3.error.message) && /see_frames/.test(r3.error.message) && liveProcesses() <= before && fx.commits.length === 0);
    check('超时:账本 errorCode=SHOTS_TIMEOUT', (await fx.jobs.get(fx.context, s3.jobId)).errorCode === 'SHOTS_TIMEOUT');
    const s4 = await detect(scdetOnly, 'long', { force: true });
    const r4 = await settle(scdetOnly, 'long', 60000);
    await sleep(400);
    check('scdet 超时:同样 error、进程没了', r4.error?.code === 'job-error' && /超时/.test(r4.error.message) && liveProcesses() <= before && (await scdetOnly.jobs.get(scdetOnly.context, s4.jobId)).errorCode === 'SHOTS_TIMEOUT');

    // 5d. 服务重启:close 杀进程树;新实例看到「被中断」
    const s5 = await detect(fx, 'long', { force: true });
    await waitProcs(1);
    const closing = await fx.tools.close('restart');
    await sleep(300);
    console.log(`  重启:close 回执 ${JSON.stringify(closing)};残留进程 ${liveProcesses()} 个`);
    check('重启:close 等到子进程真关,无残留进程', closing.childrenClosed === true && closing.workPending === 0 && liveProcesses() <= before);
    await fx.restart();
    const row = await fx.jobs.get(fx.context, s5.jobId);
    let msg = '';
    try { await list(fx, 'long'); } catch (e) { msg = `${e.code}: ${e.message}`; }
    console.log('  重启后 list_shots =', msg);
    check('重启后:账本 interrupted,list_shots 说「被中断」而不是找不到', row.state === 'interrupted' && /job-interrupted/.test(msg) && /重新调 detect_shots/.test(msg));
  } finally { await fx.dispose(); await scdetOnly.dispose(); }
}

// ======================================================================= 6. 坏文件 / 跨项目 / 只读 / 伪造上下文(真 ffprobe 的话)
{
  const fx = await makeP1Fixture(null, { config: cfg(null), extraProjects: ['sp_other'] });
  try {
    await fx.addMedia({ id: 'junk', name: 'junk.mp4', bytes: Buffer.from('this is not a video at all, just text'.repeat(40)), extra: { duration: 4 } });
    await fx.addMedia({ id: 'theirs', name: 'cuts.mp4', bytes: fs.readFileSync(cutsMp4), forProject: 'sp_other', extra: { duration: 8.6 } });
    await fx.addMedia({ id: 'mine', name: 'cuts.mp4', bytes: fs.readFileSync(cutsMp4), extra: { duration: 8.6 } });
    const sJunk = await detect(fx, 'junk');
    const junk = await settle(fx, 'junk');
    console.log('  坏文件 =', junk.error?.code, junk.error?.message?.slice(0, 160));
    check('坏文件:作业 error,原因来自 ffprobe,带退路,不带节点路径', junk.error?.code === 'job-error' && /ffprobe/.test(junk.error.message) && /see_frames/.test(junk.error.message) && !junk.error.message.includes(fx.dir));
    check('坏文件:账本 error,没写项目', (await fx.jobs.get(fx.context, sJunk.jobId)).state === 'error' && fx.commits.length === 0);
    check('跨项目:别的项目的素材,id 对得上也看不见', await detect(fx, 'theirs').then(() => false, (e) => e.code === 'media-not-found') && await list(fx, 'theirs').then(() => false, (e) => e.code === 'media-not-found'));
    check('伪造上下文:换了 runId 被拒', await fx.tools.call('detect_shots', { mediaId: 'mine' }, { ...fx.context, runId: 'forged' }).then(() => false, (e) => e.code === 'shots-forbidden'));
    const before = liveProcesses();
    fx.setReadOnly(true);
    check('只读成员:detect_shots 被拒,没起任何进程', await detect(fx, 'mine').then(() => false, (e) => e.code === 'shots-forbidden' && e.status === 403) && liveProcesses() <= before);
    check('只读成员:list_shots 能用', (await list(fx, 'mine')) === null);
  } finally { await fx.dispose(); }
}

const win1 = visibleWindows();
check('没有新冒出来的可见命令行窗口', win1 <= win0, `前 ${win0} 后 ${win1}`);
const failed = results.filter((x) => !x).length;
console.log(`\n${failed === 0 ? 'ALL PASS' : `FAILED ${failed}`}  (${results.length - failed}/${results.length})`);
process.exit(failed === 0 ? 0 : 1);
